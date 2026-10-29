import * as THREE from 'three/webgpu';
import type { App } from '../app';
import { PLINTH_HEIGHT } from '../planet/placement';
import type { PlacedWork } from '../scenes/planetView';
import type { PlanetEntry } from '../scenes/world';
import { el } from '../ui/dom';
import type { PlanetScreen } from '../ui/planetScreen';
import { authorLine } from '../ui/workCard';
import { CharacterView, loadCharacter } from './character';
import { FollowCamera } from './followCamera';
import { CHAR_RADIUS, FOLLOW, NEAR_DISTANCE, WADE_DEPTH, WALK } from './params';
import { blendPose, easeInOutCubic, retangent, slerpDir, walkGround } from './sphere';
import { setObstacle, Walker, type Obstacle } from './walker';
import './walk.css';

// off：轨道镜头；enter：从轨道镜头过渡到跟随镜头（已经能走）；walk：漫游；exit：回轨道镜头的过渡
export type WalkPhase = 'off' | 'enter' | 'walk' | 'exit';

// 按键（KeyboardEvent.code，按键位置，不受键盘布局影响）→ 镜头坐标里的方向：x 往右，y 往前
const MOVE_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

const CLICK_SLOP = 5; // 按下到松开移动不超过这么多像素算点击，超过算拖动镜头（和星球页、编辑器一样）
const LABEL_LIFT = 0.4; // 标签在作品顶上多高（缩放前；和悬停标签的 topOf 一样）

const _wish = new THREE.Vector3();
const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _anchor = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _feetVel = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface Drag {
  id: number;
  x: number; // 按下的位置
  y: number;
  lastX: number;
  lastY: number;
  moved: boolean; // 超过 CLICK_SLOP，正在转镜头
}

// 漫游模式：翠宝落到星球上，WASD / 方向键相对镜头走，点地面（触屏点哪）自动走过去，拖动绕角色转镜头，
// 靠近作品时显示标签，按 E 或点标签打开作品卡；Esc 或 Done 回轨道镜头。
// 镜头由 CameraRig.drive 接管：角色和镜头都在 rig.update 里更新，同一帧后面的东西（标签、渲染）用的都是这一帧的镜头
export class WalkMode {
  phase: WalkPhase = 'off';
  readonly walker = new Walker();
  readonly cam = new FollowCamera();
  readonly character = new CharacterView();
  ready = false; // 角色模型加载、预编译好了
  triboo = false; // 用的是翠宝模型（否则是胶囊体占位）
  onStep: (() => void) | null = null; // 每帧走完、镜头摆好之后调：自查脚本记轨迹用
  onClick: ((x: number, y: number) => boolean) | null = null; // 点了画面先问它（fun/coupons：点到翠宝、券），返回 true 就不走过去
  onInteract: (() => void) | null = null; // 附近没有作品时按 E（fun/coupons：翠宝吐券）
  private readonly app: App;
  private readonly screen: PlanetScreen;
  private entry: PlanetEntry | null = null;
  private t = 0; // 过渡进行了多久
  private readonly fromPos = new THREE.Vector3(); // 过渡起点（星球本地坐标）
  private readonly fromQuat = new THREE.Quaternion();
  private readonly orbitPos = new THREE.Vector3(); // 进入前的轨道镜头：退出时回到这里
  private readonly orbitQuat = new THREE.Quaternion();
  private readonly pressed = new Set<string>();
  private inputX = 0; // 按键合起来的方向，按下、松开时算好，每帧不用遍历按键
  private inputY = 0;
  private drag: Drag | null = null;
  private dragging = false; // 正在拖动镜头：暂停自动转到身后
  private readonly obstacles: Obstacle[] = [];
  private readonly obstacleWorks: PlacedWork[] = [];
  private obstacleCount = 0;
  private placedSize = -1;
  private near: PlacedWork | null = null; // 显示标签、按 E 打开的那件作品
  private readonly label = el('div', { className: 'float-label walk-label' });
  private readonly hint = el('div', { className: 'walk-hint mono' });
  private labelHeight = 0;
  private labelX = NaN;
  private labelY = NaN;
  // 画布和顶栏的位置：进入时和窗口变化时量一次，每帧摆标签不调 getBoundingClientRect
  private readonly rect = { left: 0, top: 0, width: 1, height: 1 };
  private barBottom = 0;
  private loading: Promise<void> | null = null;
  private ground: (dir: THREE.Vector3) => number = () => 1;
  private floor: (dir: THREE.Vector3) => number = () => 1;
  private readonly drive = (dt: number): void => this.frame(dt);

  constructor(app: App, screen: PlanetScreen) {
    this.app = app;
    this.screen = screen;
    this.walker.ground = (dir) => this.ground(dir);
    this.label.hidden = true;
    this.hint.hidden = true;
    this.label.title = 'Open this work';
    this.label.addEventListener('click', () => { if (this.near) this.openCard(this.near); });
    app.root.append(this.label, this.hint);
    const canvas = app.world.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => { if (this.drag?.id === e.pointerId) this.endDrag(); });
    canvas.addEventListener('wheel', (e) => { if (this.active) this.cam.zoom(Math.exp(e.deltaY * 0.001)); }, { passive: true });
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    // 窗口失焦、标签页切走时收不到 keyup：当作全部松开，回来时角色不会自己一直走
    addEventListener('blur', () => this.releaseKeys());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseKeys(); });
    addEventListener('resize', () => this.measure());
    app.world.frameHooks.add(() => this.placeLabel());
  }

  // 可以走（进入过渡中已经能走）
  get active(): boolean {
    return this.phase === 'enter' || this.phase === 'walk';
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  get nearWork(): PlacedWork | null {
    return this.near;
  }

  // 进入前的轨道镜头位置（星球本地坐标）：退出时回到这里
  get orbitPosition(): THREE.Vector3 {
    return this.orbitPos;
  }

  // 当前的碰撞圆柱（自查脚本用）：作品和它的圆柱一一对应
  get colliders(): { works: readonly PlacedWork[]; obstacles: readonly Obstacle[]; count: number } {
    return { works: this.obstacleWorks, obstacles: this.obstacles, count: this.obstacleCount };
  }

  // 开页后在后台准备角色：加载模型，贴图逐帧上传、着色器后台编译。第一次点 Walk 时不卡
  preload(): Promise<void> {
    this.loading ??= loadCharacter(this.screen.view.library)
      .then(async ({ object, triboo }) => {
        this.triboo = triboo;
        // 角色投影（脚下有影子才站得住）；要在预编译之前设好
        object.traverse((o) => { o.castShadow = true; });
        this.character.setModel(object);
        // 预编译拆好的部件（翠宝的鞋分成了左右两个新网格）：第一次进漫游时不卡
        await this.app.world.stage.precompile(this.character.model);
        this.ready = true;
        // 模型还没好就进了漫游：好了马上出场
        if (this.active && this.entry) this.character.show(this.entry.planet.group);
      })
      .catch((err: unknown) => console.error(err));
    return this.loading;
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  // 从当前的轨道镜头平滑过渡到跟随镜头，角色出现在离镜头最近的地面上
  enter(): void {
    if (this.active) return;
    const world = this.app.world;
    const rig = world.rig;
    // 退出过渡途中又点了 Walk：从当前镜头转回来，轨道镜头的位置照旧记着
    if (this.phase === 'exit' && this.entry) {
      this.beginTransition('enter');
      this.character.show(this.entry.planet.group);
      this.showUi();
      return;
    }
    const entry = this.screen.view.planet;
    if (!entry || !this.screen.view.team || rig.flying) return;
    this.entry = entry;
    const camera = rig.camera;
    this.orbitPos.copy(camera.position).sub(entry.home);
    this.orbitQuat.copy(camera.quaternion);
    // 高度函数每次现取：星球外观改了（重建地形）也跟着变
    this.ground = (d) => walkGround(d, entry.planet.height, entry.planet.sea);
    this.floor = (d) => Math.max(entry.planet.height(d.x, d.y, d.z), entry.planet.sea) + FOLLOW.clearance;
    // 出生点：镜头正下方的地面；身体朝画面的上方（背对镜头，往地平线走）
    const dir = _pos.copy(this.orbitPos).normalize();
    const facing = _v.set(0, 1, 0).applyQuaternion(camera.quaternion);
    retangent(facing, dir, _wish.set(0, 0, -1).applyQuaternion(camera.quaternion));
    this.syncObstacles(true);
    this.walker.place(dir, facing, this.obstacles, this.obstacleCount);
    this.walker.distance = 0;
    this.character.resetGait(this.walker);
    this.cam.reset(this.walker, this.walker.facing);
    this.cam.update(0, this.walker, false, this.floor);
    this.beginTransition('enter');
    rig.controls.enabled = false;
    rig.drive = this.drive;
    if (this.ready) this.character.show(entry.planet.group);
    this.screen.setInteractive(false);
    this.measure();
    this.showUi();
    // 焦点留在 Walk 按钮上的话，空格会再点它一下
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  // 回到进入前的轨道镜头。instantly：不过渡，立刻回去（换页面、打开 Members / Museum、切到编辑时）
  exit(instantly = false): void {
    if (this.phase === 'off') return;
    this.releaseKeys();
    this.endDrag();
    this.walker.stop();
    this.near = null;
    this.label.hidden = true;
    this.hint.hidden = true;
    this.app.topbar.setWalking(false);
    this.app.world.setWalker(null); // 角色退场：生机层不再扬尘、踩草
    if (instantly) {
      this.finish();
      return;
    }
    if (this.phase === 'exit') return;
    this.beginTransition('exit');
    this.character.hide();
  }

  // 瞬移（自查脚本用）：放到 dir，身体和镜头都朝 heading
  teleport(dir: THREE.Vector3, heading: THREE.Vector3): void {
    if (!this.entry) return;
    this.syncObstacles(true);
    this.walker.place(dir, heading, this.obstacles, this.obstacleCount);
    this.character.resetGait(this.walker);
    this.cam.reset(this.walker, heading);
  }

  private showUi(): void {
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.textContent = touch
      ? 'Tap to walk · Drag to look · Tap a label to open'
      : 'WASD to walk · Click to go · Drag to look · E to open · Esc to finish';
    this.hint.hidden = false;
    this.app.topbar.setWalking(true);
  }

  private beginTransition(phase: 'enter' | 'exit'): void {
    const camera = this.app.world.rig.camera;
    this.fromPos.copy(camera.position).sub(this.entry!.home);
    this.fromQuat.copy(camera.quaternion);
    this.phase = phase;
    this.t = 0;
  }

  // 镜头回到进入前的位置，交还给 OrbitControls：它从镜头现在的位置接着算，和进入前一模一样
  private finish(): void {
    const rig = this.app.world.rig;
    if (this.entry) {
      rig.camera.position.copy(this.orbitPos).add(this.entry.home);
      rig.camera.quaternion.copy(this.orbitQuat);
      rig.camera.up.set(0, 1, 0);
      rig.camera.updateMatrixWorld();
    }
    rig.drive = null;
    rig.controls.enabled = true;
    this.character.hide(true);
    this.screen.setInteractive(true);
    this.phase = 'off';
    this.entry = null;
    this.app.world.setWalker(null);
  }

  // CameraRig 每帧调（替代 OrbitControls）：读输入 → 角色走一步 → 跟随镜头 → 角色动作 → 摆镜头
  private frame(dt: number): void {
    const entry = this.entry;
    if (!entry) return;
    this.syncObstacles(false);
    // 涉水：脚下的水深（地面最多比海面低 WADE_DEPTH），越深走得越慢
    const sea = entry.planet.sea;
    const depth = sea > 0 ? Math.max(0, sea - this.walker.radius) : 0;
    this.walker.speedScale = 1 - WALK.wadeSlow * Math.min(1, depth / WADE_DEPTH);
    _wish.set(0, 0, 0);
    if (this.phase !== 'exit') {
      if (this.inputX !== 0 || this.inputY !== 0) {
        this.walker.stop(); // 按了方向键就不再自动走
        // 镜头的右 = heading × up；斜着走不比直着快
        _v.crossVectors(this.cam.heading, this.cam.up);
        _wish.copy(this.cam.heading).multiplyScalar(this.inputY).addScaledVector(_v, this.inputX);
        _wish.multiplyScalar((WALK.speed * this.walker.speedScale) / _wish.length());
      } else {
        this.walker.autoWish(dt, _wish);
      }
    }
    this.walker.step(dt, _wish, this.obstacles, this.obstacleCount);
    this.cam.update(dt, this.walker, this.walker.hasTarget && !this.dragging, this.floor);
    this.character.depth = sea > 0 ? Math.max(0, sea - this.walker.radius) : 0;
    this.character.pose(this.walker, dt);
    // 生机层：脚底的世界坐标、世界坐标下的速度、着地（角色一直贴地走）。星球组没有旋转，本地 → 世界只差平移和缩放
    if (this.phase !== 'exit') {
      const scale = entry.planet.group.scale.x;
      this.walker.positionInto(_feet).multiplyScalar(scale).add(entry.home);
      _feetVel.copy(this.walker.velocity).multiplyScalar(scale);
      this.app.world.setWalker(_feet, _feetVel, true);
    }
    // 镜头的 up：漫游时是角色脚下的球面法线，轨道镜头是 +Y；过渡时两者之间走大圆插值。
    // 天空和云海（nature/atmosphere.ts）按 camera.up 找「水平面」，云海跟着角色转、始终在脚下
    let upK = 1;
    if (this.phase === 'walk') {
      _pos.copy(this.cam.position);
      _quat.copy(this.cam.quaternion);
    } else {
      this.t += dt;
      const k = easeInOutCubic(Math.min(1, this.t / FOLLOW.seconds));
      if (this.phase === 'enter') blendPose(this.fromPos, this.fromQuat, this.cam.position, this.cam.quaternion, k, _pos, _quat);
      else blendPose(this.fromPos, this.fromQuat, this.orbitPos, this.orbitQuat, k, _pos, _quat);
      upK = this.phase === 'enter' ? k : 1 - k;
      if (k >= 1) {
        if (this.phase === 'exit') {
          this.finish();
          return;
        }
        this.phase = 'walk';
      }
    }
    const camera = this.app.world.rig.camera;
    camera.position.copy(_pos).add(entry.home);
    camera.quaternion.copy(_quat);
    slerpDir(WORLD_UP, this.cam.up, upK, camera.up);
    this.onStep?.();
  }

  // 作品的碰撞圆柱：半径取展台和模型水平半径里大的那个（和编辑条的 workRect 一样）乘缩放，再加角色半径。
  // 作品列表只在进入、瞬移、数量变了时重新取（只在这时遍历 Map；漫游时编辑器关着，摆放不会变）；
  // 半径每帧从作品上读：模型加载完、展台变大，马上就挡得住
  private syncObstacles(force: boolean): void {
    const placed = this.screen.view.placed;
    if (force || placed.size !== this.placedSize) {
      this.placedSize = placed.size;
      let i = 0;
      for (const pw of placed.values()) {
        this.obstacleWorks[i] = pw;
        this.obstacles[i] ??= { center: new THREE.Vector3(), minAngle: 0, cosMin: 1 };
        i++;
      }
      this.obstacleCount = i;
      this.obstacleWorks.length = i;
      if (this.near && !this.obstacleWorks.includes(this.near)) this.near = null;
    }
    for (let i = 0; i < this.obstacleCount; i++) {
      const pw = this.obstacleWorks[i];
      const radius = Math.max(pw.plinth.scale.x, pw.model?.footprint ?? 0) * pw.placement.scale;
      setObstacle(this.obstacles[i], pw.root.position, (radius + CHAR_RADIUS) / pw.root.position.length());
    }
  }

  // 离角色最近、在 NEAR_DISTANCE（按作品缩放放大）以内的作品；正显示着的那件放宽 10%，站在边界上标签不闪
  private findNear(): PlacedWork | null {
    let best: PlacedWork | null = null;
    let bestDistance = Infinity;
    const dir = this.walker.dir;
    for (let i = 0; i < this.obstacleCount; i++) {
      const pw = this.obstacleWorks[i];
      const d = Math.acos(THREE.MathUtils.clamp(dir.dot(this.obstacles[i].center), -1, 1)) * this.walker.radius;
      const range = NEAR_DISTANCE * Math.max(1, pw.placement.scale) * (pw === this.near ? 1.1 : 1);
      if (d <= range && d < bestDistance) {
        best = pw;
        bestDistance = d;
      }
    }
    return best;
  }

  private openCard(pw: PlacedWork): void {
    const team = this.screen.view.team;
    if (team) this.screen.card.show(pw.work, team, pw.model?.failed ?? false);
  }

  // 每帧（镜头摆好之后）：最近的作品上方显示作品名和作者
  private placeLabel(): void {
    if (!this.active) return;
    const near = this.findNear();
    if (near !== this.near) {
      this.near = near;
      if (near) {
        const team = this.screen.view.team;
        this.label.replaceChildren(
          el('span', { className: 'display', textContent: near.work.title }),
          el('span', { className: 'wl-by', textContent: team ? authorLine(near.work, team) : '' }),
        );
        this.label.hidden = false;
        this.labelHeight = this.label.offsetHeight;
        this.labelX = NaN;
      }
    }
    if (!near) {
      this.showLabel(false);
      return;
    }
    const camera = this.app.world.rig.camera;
    near.root.localToWorld(_anchor.set(0, (PLINTH_HEIGHT + (near.model?.height ?? 1) + LABEL_LIFT) * near.placement.scale, 0)).project(camera);
    // 在镜头背后或画面外：先藏起来，作品还算「靠近」（按 E 照样打开）
    const inView = _anchor.z <= 1 && Math.abs(_anchor.x) <= 1 && Math.abs(_anchor.y) <= 1;
    this.showLabel(inView);
    if (!inView) return;
    const x = Math.round(this.rect.left + ((_anchor.x + 1) / 2) * this.rect.width);
    // 标签底边对准作品顶上；不压到顶栏下面
    const y = Math.round(Math.max(this.rect.top + ((1 - _anchor.y) / 2) * this.rect.height, this.barBottom + 8 + this.labelHeight));
    if (x === this.labelX && y === this.labelY) return;
    this.labelX = x;
    this.labelY = y;
    this.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }

  // 只在显示状态变了时写 DOM
  private showLabel(on: boolean): void {
    if (this.label.hidden === on) this.label.hidden = !on;
  }

  private measure(): void {
    const r = this.app.world.renderer.domElement.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = r.width || 1;
    this.rect.height = r.height || 1;
    const bar = this.app.root.querySelector('.topbar');
    this.barBottom = bar ? bar.getBoundingClientRect().bottom : 0;
    this.labelX = NaN;
  }

  // —— 输入 ——

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
    if (down && e.key === 'Escape') {
      // 作品卡开着时先关卡片，再按一次才退出漫游
      const card = this.app.root.querySelector<HTMLElement>('.work-card');
      if (card && !card.hidden) this.screen.card.hide();
      else this.exit();
      return;
    }
    if (down && e.code === 'KeyE') {
      if (this.near) this.openCard(this.near);
      else if (!e.repeat) this.onInteract?.();
      return;
    }
    if (!(e.code in MOVE_KEYS)) return;
    e.preventDefault(); // 方向键不滚动页面
    if (down) this.pressed.add(e.code);
    else this.pressed.delete(e.code);
    this.sumKeys();
  }

  private sumKeys(): void {
    let x = 0;
    let y = 0;
    for (const code of this.pressed) {
      x += MOVE_KEYS[code][0];
      y += MOVE_KEYS[code][1];
    }
    // W 和 ↑ 一起按不算两倍；W 和 S 一起按抵消
    this.inputX = Math.sign(x);
    this.inputY = Math.sign(y);
  }

  private releaseKeys(): void {
    this.pressed.clear();
    this.sumKeys();
  }

  private onDown(e: PointerEvent): void {
    // 只认主按钮（鼠标左键、触摸、笔尖）；第二根手指不管
    if (!this.active || e.button !== 0 || this.drag) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
    try {
      this.app.world.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件没有活动的指针：照样能拖，只是出了画布就收不到移动
    }
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP) {
      d.moved = true;
      this.dragging = true;
      this.app.world.renderer.domElement.style.cursor = 'grabbing';
    }
    if (d.moved) this.cam.orbit(e.clientX - d.lastX, e.clientY - d.lastY);
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.endDrag();
    if (!d.moved && this.active && !this.onClick?.(e.clientX, e.clientY)) this.walkTo(e.clientX, e.clientY);
  }

  private endDrag(): void {
    const d = this.drag;
    this.drag = null;
    this.dragging = false;
    const canvas = this.app.world.renderer.domElement;
    if (d?.moved) canvas.style.cursor = '';
    if (d && canvas.hasPointerCapture?.(d.id)) canvas.releasePointerCapture(d.id);
  }

  // 点了画面：点在作品上就走到它的展台边上，点在地面（或海面下的海底）上就走到那里；点在天上不动
  private walkTo(x: number, y: number): void {
    const entry = this.entry;
    if (!entry) return;
    const pw = this.screen.view.pick(x, y);
    if (pw) {
      const i = this.obstacleWorks.indexOf(pw);
      const reach = i >= 0 ? this.obstacles[i].minAngle * this.walker.radius : 0;
      this.walker.goTo(_v.copy(pw.root.position), reach + 0.15);
      return;
    }
    const hit = this.app.world.rayFrom(x, y).intersectObject(entry.planet.terrain, false)[0];
    if (hit) this.walker.goTo(_v.copy(hit.point).sub(entry.home));
  }
}

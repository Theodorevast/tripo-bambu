import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Placement, PlanetRecipe, Team, Work } from '../data/types';
import { footprintGroundRadius } from '../planet/footprint';
import { clampScale, faceYaw, PLINTH_HEIGHT, placementTransform, YAW_STEP } from '../planet/placement';
import { plinthRadius, type PlacedWork, type PlanetView } from '../scenes/planetView';
import { workFraming } from '../scenes/shots';
import { EditPanel, type ScreenRect } from '../ui/editPanel';
import type { PlanetScreen } from '../ui/planetScreen';
import { toast } from '../ui/toast';
import { checkDrop, listenForDrops } from './dropGlb';

const ghostMaterial = new THREE.MeshBasicNodeMaterial({ color: '#d9b77e', transparent: true, opacity: 0.45, depthWrite: false });

export const DRAG_THRESHOLD = 5; // 按下后移动超过这么多像素才算拖动：点选时手抖不会挪动作品

type Vec3 = [number, number, number];

// 作品正面（模型局部 +Z）在星球本地坐标里的方向；底座坐标系和 placementTransform 完全一样
export function forwardOf(dir: Vec3, yaw: number): THREE.Vector3 {
  const { quaternion } = placementTransform({ workId: '', dir, yaw, scale: 1 }, () => 1, 0);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
}

// 拖动（保留抓取偏移）：整个摆放绕球心转过「d0 → d1」这段最短弧。d0 是抓取点（光标下的地表方向），
// d1 是现在光标下的地表方向。作品方向 dir0 和正面 forward0 一起转，再在新底座里求 yaw：
// 朝向在世界里是连续的，经过 -Y 附近（底座坐标系在那里急转）也不会甩
export function dragPlacement(dir0: THREE.Vector3, forward0: THREE.Vector3, d0: THREE.Vector3, d1: THREE.Vector3): { dir: Vec3; yaw: number } {
  const q = new THREE.Quaternion().setFromUnitVectors(d0, d1);
  const dir = dir0.clone().applyQuaternion(q).normalize();
  const forward = forward0.clone().applyQuaternion(q);
  const d: Vec3 = [dir.x, dir.y, dir.z];
  return { dir: d, yaw: faceYaw(d, [forward.x, forward.y, forward.z]) };
}

// 一次按在作品上的按压：移动超过阈值才变成拖动
interface Press {
  pointerId: number;
  pw: PlacedWork;
  x: number; // 按下时的屏幕坐标
  y: number;
  startDir: Vec3; // 按下时的摆放：判断有没有真的改动、Esc 撤回
  startYaw: number;
  dir0: THREE.Vector3; // 同一个摆放的向量形式（星球本地坐标），拖动从它开始转
  forward0: THREE.Vector3;
  grab: THREE.Vector3 | null; // d0：按下处光标下的地表方向；按下时没打中地表，就用拖动后第一次打中的
  moving: boolean; // 已超过阈值，正在拖动
}

// 编辑模式：摆放、拖动、旋转、缩放、删除作品，改星球外观；每次修改都自动保存
export class Editor {
  active = false;
  private readonly app: App;
  private readonly screen: PlanetScreen;
  private readonly panel: EditPanel;
  private placing: Work | null = null;
  private ghost: THREE.Group | null = null;
  private ghostFootprint = 0; // 幽灵模型的水平半径：预览和摆上去的作品用同样的展台半径贴地
  private pickToken = 0; // 每次从作品栏挑作品加一：模型加载慢时，只有最近那次挑选的结果还算数
  private selected: PlacedWork | null = null;
  private press: Press | null = null;
  private dirty = false; // 滑块拖动中预览改了摆放，还没保存
  private tempCount = 0;
  // 这次页面里摆上星球的临时作品（tmp- 开头）：不进存档，离开星球再回来时照这里重新摆上，刷新页面才消失（spec 2.5）
  private readonly tempPlacements = new Map<string, Placement>();

  constructor(app: App, screen: PlanetScreen) {
    this.app = app;
    this.screen = screen;
    this.panel = new EditPanel(app.root, {
      pick: (w) => void this.pickFromTray(w),
      rotate: (deg, done) => this.withSelected((pw) => { pw.placement.yaw = THREE.MathUtils.degToRad(deg); }, done),
      scale: (v, done) => this.withSelected((pw) => { pw.placement.scale = clampScale(v); }, done),
      remove: () => this.removeSelected(),
      appearance: (patch) => this.setAppearance(patch),
      reroll: () => this.setAppearance({ seed: Math.floor(Math.random() * 1e9) }),
      reset: () => void this.resetDemo(),
    });
    const canvas = app.world.renderer.domElement;
    // 捕获阶段：赶在 OrbitControls 之前处理，点中作品时不让镜头跟着转
    canvas.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    // 按压的收尾：松手、浏览器取消指针、丢了指针捕获都算；窗口失焦时可能收不到 pointerup
    addEventListener('pointerup', (e) => this.onRelease(e));
    addEventListener('pointercancel', (e) => this.onRelease(e));
    addEventListener('lostpointercapture', (e) => this.onRelease(e));
    addEventListener('blur', () => this.endDrag());
    addEventListener('keydown', (e) => this.onKey(e));
    app.world.frameHooks.add(() => this.placeBar());
    listenForDrops({
      active: () => this.active,
      drop: (files) => void this.addTempWorks(files),
      hover: (on) => this.panel.setDropHover(on),
      inactiveDrop: () => toast("Open Edit on your team's planet to drop a GLB"),
    });
  }

  private get view(): PlanetView {
    return this.screen.view;
  }

  toggle(): void {
    if (this.active) this.deactivate();
    else this.activate();
  }

  activate(): void {
    const team = this.view.team;
    if (this.active || !team || team.id !== this.app.you.teamId) return;
    this.active = true;
    this.screen.setInteractive(false);
    this.app.topbar.setEditing(true);
    this.panel.show(team.planet);
    this.refreshTray();
  }

  deactivate(): void {
    // 拖到一半退出（Done、换页面、打开 Members / Museum）：先在当前位置松手并保存，这时 view.team 还在
    this.endDrag();
    if (this.dirty) this.save();
    if (this.active) {
      this.active = false;
      this.cancelPlacing();
      this.screen.setInteractive(true);
      this.app.topbar.setEditing(false);
    }
    // 不管之前是不是编辑状态都收干净：异步回来的选中不会把编辑条留在编辑模式外。
    // 没有选中时不调 select(null)：它会清掉星球页（非编辑状态）悬停作品的高亮
    if (this.selected) this.select(null);
    this.panel.hide();
  }

  // 拖进来的 GLB 变成临时作品：只在当前页面有效，不进存档、不进 Museum
  addTempWork(file: File): Promise<void> {
    return this.addTempWorks([file]);
  }

  // 一次拖进来的所有文件：每个 .glb 都加进作品栏，第一件直接进入摆放；不收的、读不了的跳过，最后一起提示。
  // 模型可能有几十 MB：加载前先提示。加载完时已经退出编辑（Done、换页面、打开 Members / Museum）就只放进作品栏，不进入摆放
  async addTempWorks(files: File[]): Promise<void> {
    const added: Work[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const check = checkDrop(file);
      if (!check.ok) {
        skipped.push(files.length > 1 ? `${file.name} (${check.reason})` : check.reason);
        continue;
      }
      const work: Work = { id: `tmp-${++this.tempCount}`, title: file.name.replace(/\.glb$/i, ''), authorId: this.app.you.memberId, file: URL.createObjectURL(file), thumb: '', tris: 0 };
      toast(`Loading ${work.title}…`);
      const model = await this.view.library.load(work);
      if (model.failed) {
        URL.revokeObjectURL(work.file);
        skipped.push(files.length > 1 ? `${work.title} (could not read it)` : 'Could not read that GLB');
        continue;
      }
      this.view.extraWorks.set(work.id, work);
      added.push(work);
    }
    const first = added[0];
    const what = added.length === 1 ? first.title : `${added.length} works`;
    const parts: string[] = [];
    if (first) parts.push(this.active ? `${what} added. Click the planet to place ${added.length === 1 ? 'it' : first.title}.` : `${what} ${added.length === 1 ? 'is' : 'are'} in your tray`);
    if (skipped.length) parts.push(first ? `Skipped ${skipped.join(', ')}` : skipped.join(' · '));
    if (parts.length) toast(parts.join(' · '));
    if (first && this.active) await this.pickFromTray(first);
  }

  // 回到自己团队的星球时把临时作品重新摆上：PlanetView.enter 只摆存档里的作品。
  // 走 view.place，每件作品各自加载，不管存档里那些作品的模型加载完没有
  restoreTempWorks(team: Team): void {
    if (team.id !== this.app.you.teamId || this.view.team?.id !== team.id) return;
    for (const p of this.tempPlacements.values()) void this.view.place(structuredClone(p));
  }

  // —— 作品栏 ——

  private allWorks(): Work[] {
    return [...(this.view.team?.works ?? []), ...this.view.extraWorks.values()];
  }

  private refreshTray(): void {
    this.panel.setTray(this.allWorks(), new Set(this.view.placed.keys()), this.placing?.id ?? null);
  }

  private async pickFromTray(work: Work): Promise<void> {
    if (!this.active) return; // 拖进来的 GLB 加载完时已经点了 Done：作品留在作品栏里，不再进入摆放
    const token = ++this.pickToken;
    const pw = this.view.placed.get(work.id);
    if (pw) {
      // 已经摆上去了：选中它，镜头转过去
      this.cancelPlacing();
      this.select(pw);
      const entry = this.view.planet;
      if (entry) {
        const dir = new THREE.Vector3(...pw.placement.dir).normalize();
        await this.app.world.rig.fly(workFraming(entry.home, dir), 0.8);
      }
      return;
    }
    this.select(null);
    this.cancelPlacing();
    this.placing = work;
    this.refreshTray();
    const model = await this.view.library.load(work);
    // 加载期间又挑了作品（包括同一件）、取消了摆放或退出了编辑：这次的结果作废，不然会多出一个没人管的幽灵
    if (token !== this.pickToken || this.placing !== work || !this.active) return;
    model.object.position.y = PLINTH_HEIGHT;
    model.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = ghostMaterial;
    });
    const ghost = new THREE.Group();
    ghost.add(model.object);
    ghost.visible = false;
    this.view.planet?.planet.works.add(ghost);
    this.ghost = ghost;
    this.ghostFootprint = model.footprint;
  }

  private cancelPlacing(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
    this.placing = null;
    if (this.active) this.refreshTray();
  }

  // —— 指针和键盘 ——

  // 鼠标下的地表方向（星球本地坐标的单位向量）；没打中星球返回 null
  private surfaceDir(e: PointerEvent): Vec3 | null {
    const entry = this.view.planet;
    if (!entry) return null;
    const hit = this.app.world.rayFrom(e.clientX, e.clientY).intersectObject(entry.planet.terrain, false)[0];
    if (!hit) return null;
    const v = entry.planet.group.worldToLocal(hit.point.clone()).normalize();
    return [v.x, v.y, v.z];
  }

  private towardCamera(): Vec3 {
    const entry = this.view.planet;
    if (!entry) return [0, 1, 0];
    const v = this.app.world.rig.camera.position.clone().sub(entry.home).normalize();
    return [v.x, v.y, v.z];
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    this.endDrag(); // 上一次按压没收尾（pointerup 丢了）：先当作松手
    if (this.placing) {
      const dir = this.surfaceDir(e);
      if (!dir) return;
      e.stopImmediatePropagation();
      void this.commitPlacement(this.placing, dir);
      return;
    }
    const pw = this.view.pick(e.clientX, e.clientY);
    this.select(pw);
    if (!pw) return;
    e.stopImmediatePropagation(); // OrbitControls 收不到这次按下，镜头不跟着转
    // 按下就抓住指针（OrbitControls 没机会抓了）：拖到编辑条、作品栏、外观面板、顶栏上面时，pointermove 照样送到画布
    try {
      this.app.world.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件没有活动的指针：照样能拖，只是出了画布就收不到移动
    }
    const dir: Vec3 = [...pw.placement.dir];
    const under = this.surfaceDir(e); // 按下处作品背后的地表；打不中（作品衬着星空）就等拖动后第一次打中地表时再记
    this.press = {
      pointerId: e.pointerId,
      pw,
      x: e.clientX,
      y: e.clientY,
      startDir: dir,
      startYaw: pw.placement.yaw,
      dir0: new THREE.Vector3(...dir).normalize(),
      forward0: forwardOf(dir, pw.placement.yaw),
      grab: under ? new THREE.Vector3(...under) : null,
      moving: false,
    };
  }

  private onMove(e: PointerEvent): void {
    if (!this.active) return;
    const press = this.press;
    if (press) {
      if (e.pointerId !== press.pointerId) return;
      if (!(e.buttons & 1)) {
        this.endDrag(); // 左键已经松开却没收到 pointerup（失焦等）：当作松手
        return;
      }
      if (!press.moving) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
        press.moving = true;
        this.view.pickUp(press.pw); // stage：作品提起来，花园先收起
        this.app.world.renderer.domElement.style.cursor = 'grabbing';
        this.panel.moveBar(null); // 拖动时藏起编辑条
      }
      const d1 = this.surfaceDir(e);
      if (!d1) return; // 光标下没有地表（在星空里）：作品先停着，等光标回到星球上
      const hit = new THREE.Vector3(...d1);
      if (!press.grab) {
        press.grab = hit; // 按下时没打中地表：第一次打中时记下抓取点，这一下不动
        return;
      }
      const next = dragPlacement(press.dir0, press.forward0, press.grab, hit);
      press.pw.placement.dir = next.dir;
      press.pw.placement.yaw = next.yaw;
      this.view.updateTransform(press.pw);
      return;
    }
    const entry = this.view.planet;
    if (!this.placing || !this.ghost || !entry) return;
    const dir = this.surfaceDir(e);
    this.ghost.visible = dir !== null;
    if (!dir) return;
    const { position, quaternion } = placementTransform({ workId: '', dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 }, entry.planet.height, entry.planet.sea);
    // 和 PlanetView.updateTransform 一样按展台底下最高的地面贴地，点下去时作品不会往上跳
    position.setLength(footprintGroundRadius(position.clone().normalize(), plinthRadius(this.ghostFootprint), entry.planet.height, entry.planet.sea));
    this.ghost.position.copy(position);
    this.ghost.quaternion.copy(quaternion);
    this.ghost.scale.setScalar(this.view.presentScale); // stage：预览和摆上去以后一样大（星球视图里作品按地标放大）
  }

  private onRelease(e: PointerEvent): void {
    if (this.press && e.pointerId === this.press.pointerId) this.endDrag();
  }

  // 结束按压：放开指针捕获、恢复光标。revert 撤回到按下时的摆放；否则摆放真的变了才保存（点选不写存档）
  private endDrag(revert = false): void {
    const press = this.press;
    if (!press) return;
    this.press = null;
    const canvas = this.app.world.renderer.domElement;
    canvas.style.cursor = '';
    if (canvas.hasPointerCapture(press.pointerId)) canvas.releasePointerCapture(press.pointerId);
    const p = press.pw.placement;
    if (revert) {
      p.dir = press.startDir;
      p.yaw = press.startYaw;
      this.view.updateTransform(press.pw);
    } else if (p.yaw !== press.startYaw || p.dir.some((v, i) => v !== press.startDir[i])) {
      this.save();
    }
    if (press.moving) this.view.putDown(press.pw); // stage：从悬着的高度落下，落地扬尘、花园在新位置长出来
  }

  private onKey(e: KeyboardEvent): void {
    // 编辑模式外、带 Ctrl / Cmd / Alt 的组合键（浏览器快捷键）、在输入框里时都不处理
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (e.key === 'q' || e.key === 'Q') this.withSelected((pw) => { pw.placement.yaw -= YAW_STEP; });
    else if (e.key === 'e' || e.key === 'E') this.withSelected((pw) => { pw.placement.yaw += YAW_STEP; });
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      this.endDrag(true); // 拖到一半按删除：先结束拖动再删
      this.removeSelected();
    } else if (e.key === 'Escape') {
      if (this.press) this.endDrag(true); // 拖到一半按 Esc：撤回这次拖动
      else if (this.placing) this.cancelPlacing();
      else this.select(null);
    }
  }

  // —— 修改 ——

  private async commitPlacement(work: Work, dir: Vec3): Promise<void> {
    const placement: Placement = { workId: work.id, dir, yaw: faceYaw(dir, this.towardCamera()), scale: 1 };
    this.cancelPlacing();
    // place() 在等模型之前就把展台记进 view.placed：先存，模型还没加载完就离开星球（路由不等模型）摆放也不会丢
    const placing = this.view.place(placement, { drop: true }); // stage：模型挂上时从半空落下、扬尘、花园长出来
    if (this.view.placed.has(work.id)) this.save();
    const pw = await placing;
    if (this.active) this.refreshTray();
    if (!pw) return;
    // 模型加载期间点了 Done：摆放已经存下了，但不再选中，编辑条不会在编辑模式外冒出来
    if (this.active) this.select(pw);
  }

  private select(pw: PlacedWork | null): void {
    this.selected = pw;
    this.view.setHighlight(pw);
    this.panel.showBar(pw);
    this.placeBar(); // 马上摆好编辑条，不等下一帧
  }

  // done = false：滑块拖动中的预览，只改画面，松手（change）时再保存
  private withSelected(change: (pw: PlacedWork) => void, done = true): void {
    const pw = this.selected;
    if (!pw) return;
    this.endDrag(); // 拖到一半按 Q / E：先在当前位置松手
    change(pw);
    pw.placement.yaw = Math.atan2(Math.sin(pw.placement.yaw), Math.cos(pw.placement.yaw)); // 收回 (-π, π]
    this.view.updateTransform(pw);
    this.panel.showBar(pw);
    if (done) this.save();
    else this.dirty = true;
  }

  private removeSelected(): void {
    const pw = this.selected;
    if (!pw) return;
    this.select(null);
    this.view.remove(pw.work.id);
    this.refreshTray();
    this.save();
  }

  private setAppearance(patch: Partial<Pick<PlanetRecipe, 'seed' | 'preset' | 'ring' | 'atmosphere'>>): void {
    const team = this.view.team;
    if (!team) return;
    const next: Team = { ...team, planet: { ...team.planet, ...patch, placements: this.savedPlacements() } };
    this.commit(next);
    this.view.refreshAll(); // 地形变了，作品重新贴地
    this.panel.syncAppearance(next.planet);
  }

  // 只保存正式作品的摆放；拖进来的临时作品（tmp- 开头）不进存档
  private savedPlacements(): Placement[] {
    return [...this.view.placed.values()].map((pw) => structuredClone(pw.placement)).filter((p) => !p.workId.startsWith('tmp-'));
  }

  private save(): void {
    this.dirty = false;
    this.rememberTemp();
    const team = this.view.team;
    if (team) this.commit({ ...team, planet: { ...team.planet, placements: this.savedPlacements() } });
  }

  // 临时作品的摆放只记在内存里：每次保存时照星球上的现状更新（摆上、拖动、旋转、缩放、删除都会走 save）
  private rememberTemp(): void {
    if (this.view.team?.id !== this.app.you.teamId) return;
    this.tempPlacements.clear();
    for (const pw of this.view.placed.values()) {
      if (pw.work.id.startsWith('tmp-')) this.tempPlacements.set(pw.work.id, structuredClone(pw.placement));
    }
  }

  private commit(team: Team): void {
    this.view.team = team;
    this.app.replaceTeam(team);
    void this.app.store.savePlanet(team.id, team.planet);
  }

  private async resetDemo(): Promise<void> {
    if (!confirm('Reset the demo? All local changes will be lost.')) return;
    await this.app.store.reset();
    location.reload();
  }

  // 编辑条每帧摆到选中作品旁边；拖动中、作品顶上转到星球背面时藏起来（和悬浮标签一样，pickFromTray 的飞行途中也照此处理）
  private placeBar(): void {
    const pw = this.selected;
    if (!this.active || !pw) return;
    if (this.press?.moving) {
      this.panel.moveBar(null);
      return;
    }
    pw.root.updateWorldMatrix(true, false); // 刚改过摆放（Q / E、滑块）时，世界矩阵要到渲染时才更新
    const hidden = this.view.occluded(this.app.world.rig.camera.position, this.view.topOf(pw));
    this.panel.moveBar(hidden ? null : this.workRect(pw));
  }

  // 作品在屏幕上的范围：从地面到模型顶、按展台和模型里较大的半径撑开的小盒子，8 个角投影后取包围盒；有角在镜头背后时返回 null
  private workRect(pw: PlacedWork): ScreenRect | null {
    const s = pw.placement.scale * pw.hero; // stage：算上地标放大
    const r = Math.max(pw.plinth.scale.x, pw.model?.footprint ?? 0) * s;
    const h = (PLINTH_HEIGHT + (pw.model?.height ?? 1)) * s;
    const rect: ScreenRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const corner = new THREE.Vector3();
    for (const y of [0, h]) {
      for (const x of [-r, r]) {
        for (const z of [-r, r]) {
          const at = this.app.world.toScreen(pw.root.localToWorld(corner.set(x, y, z)));
          if (!at) return null;
          rect.left = Math.min(rect.left, at.x);
          rect.right = Math.max(rect.right, at.x);
          rect.top = Math.min(rect.top, at.y);
          rect.bottom = Math.max(rect.bottom, at.y);
        }
      }
    }
    return rect;
  }
}

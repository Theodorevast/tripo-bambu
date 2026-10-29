import * as THREE from 'three/webgpu';
import type { App } from '../app';
import { drawCoupons, type CouponTicket } from '../data/coupons';
import type { Editor } from '../editor/editor';
import { mulberry32 } from '../planet/rng';
import { PRESETS } from '../planet/presets';
import { CHAR_HEIGHT } from '../play/params';
import type { WalkMode } from '../play/walkMode';
import { planetViewDir } from '../scenes/shots';
import { reducedMotion } from '../scenes/transition';
import { WEATHER, type PlanetEntry, type World } from '../scenes/world';
import type { PlanetScreen } from '../ui/planetScreen';
import { drawAtlas, fontsReady } from './couponsArt';
import { armOnFirstGesture, audioReady, play, prepareAudio } from './couponsAudio';
import { CouponCard } from './couponsCard';
import { CouponField, type CouponAnchor, type CouponGround, type PickupTarget } from './couponsField';
import { updateCouponLight } from './couponsFx';
import { COUPONS, couponCount, landingSpot, restPose, shakePose, spitPose, spitTimes, stepHover, type TribooPose } from './couponsMath';
import { chooseSpot, loadStandModel, logoGlow, TribooStand } from './couponsStand';

// 点翠宝吐优惠券（coupons）：把站桩的翠宝（couponsStand.ts）、漫游的翠宝（play/ 的角色）、地上的券（couponsField.ts）、
// 彩屑（couponsFx.ts）、卡片（couponsCard.ts）、声音（couponsAudio.ts）接起来。
// - 能点：星球视图里「你的星球」上站着的翠宝、漫游时的翠宝；悬停时手形光标、翠宝轻轻一缩；漫游时附近没有作品时按 E 也行
// - 吐券：（漫游时先转身对着镜头）蓄力 → 弹起时喷出 3–5 张券、一团彩屑、「啵」→ 回弹、开心地晃两下（couponsMath.ts）
// - 捡券：点一张券，它飞到镜头前，交给界面的卡片展开；没捡的过 10 秒淡出。吐完 3 秒内再点只摇头
// - 减弱动效：券不飞不翻，直接在翠宝身边淡入；翠宝只亮一下 logo
// 开场时（World 预热完以后）在后台准备：券面图集上传、三个网格的着色器编译、站桩翠宝的模型克隆和编译、卡片排一次版，第一次点不卡

type Who = 'stand' | 'walker';

interface Act {
  who: Who | null;
  mode: 'idle' | 'spit' | 'shake';
  t: number;
  turning: boolean; // 漫游：先转身对着镜头
  faceYaw: number; // 漫游：转多少（弧度，绕脚下的法线）
  launched: boolean;
  reduced: boolean;
}

const _o = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sphere = new THREE.Sphere();
const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();

declare global {
  interface Window {
    __coupons?: CouponsDebug;
  }
}

interface ScreenPos {
  x: number;
  y: number;
}

export interface CouponsDebug {
  state(): {
    ready: boolean;
    actor: Who | null;
    mode: Act['mode'];
    t: number;
    cooldown: number;
    hover: boolean;
    squash: number; // 悬停时「轻轻一缩」的弹簧（0..1）
    clock: number; // 游戏时间（秒，按每帧的 dt 累加：券的寿命按它算）
    cursor: string;
    stand: { shown: boolean; at: ScreenPos | null; scale: number };
    walker: { at: ScreenPos | null };
    coupons: Array<{ id: number; phase: string; kind: number; code: string; at: ScreenPos | null; opacity: number }>;
    card: { open: boolean; title: string | null; code: string | null };
    audio: boolean;
    counts: { spits: number; shakes: number; pickups: number };
  };
  poke(who?: Who): boolean;
  clear(): void;
}

export class Coupons {
  readonly field: CouponField;
  readonly stand = new TribooStand();
  readonly card: CouponCard;
  ready = false; // 券的网格、站桩翠宝都准备好了
  private readonly app: App;
  private readonly world: World;
  private readonly screen: PlanetScreen;
  private readonly walk: WalkMode;
  private readonly editor: Editor;
  private readonly atlasCanvas: HTMLCanvasElement;
  private readonly rand = mulberry32((Date.now() >>> 0) ^ 0x7ab1e);
  private readonly act: Act = { who: null, mode: 'idle', t: 0, turning: false, faceYaw: 0, launched: false, reduced: false };
  private readonly pose: TribooPose = restPose();
  private readonly hoverSpring: [number, number] = [0, 0];
  private hoverWho: Who | null = null;
  private hoverCoupon: number | null = null;
  private cursorOwned = false;
  private cooldownUntil = -Infinity;
  private clock = 0;
  private fxReady = false;
  private standModelReady = false;
  private standEntry: PlanetEntry | null = null;
  private spotDirty = true;
  private unlistenMask: (() => void) | null = null;
  private walkerLogo: ((k: number) => void) | null = null;
  private faceBlend = 1;
  private down: { x: number; y: number; id: number } | null = null;
  private picking: { id: number; x: number; y: number; width: number } | null = null;
  private readonly rect = { left: 0, top: 0, width: 1, height: 1 };
  private readonly counts = { spits: 0, shakes: 0, pickups: 0 };
  private readonly pickTarget: PickupTarget = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.5 };
  private readonly ground: CouponGround;
  private entry: PlanetEntry | null = null;

  constructor(app: App, screen: PlanetScreen, walk: WalkMode, editor: Editor) {
    this.app = app;
    this.world = app.world;
    this.screen = screen;
    this.walk = walk;
    this.editor = editor;
    this.atlasCanvas = document.createElement('canvas');
    drawAtlas(this.atlasCanvas);
    this.field = new CouponField(this.atlasCanvas, this.rand);
    this.field.onArrive = () => this.arrive();
    this.card = new CouponCard(app.root);
    this.card.onClose = () => { this.picking = null; };
    const self = this;
    this.ground = {
      home: new THREE.Vector3(),
      scale: 1,
      radius(dir: THREE.Vector3): number {
        const p = self.entry?.planet;
        return p ? Math.max(p.height(dir.x, dir.y, dir.z), p.sea) : 1;
      },
    };
    // 漫游：点画面先问这里（点到翠宝、券就不走过去），附近没有作品时按 E 让翠宝吐券
    walk.onClick = (x, y) => this.click(x, y);
    walk.onInteract = () => { if (this.walkerAvailable()) this.poke('walker'); };
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => this.setHover(null, null, -1, -1));
    canvas.addEventListener('pointerdown', (e) => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    addEventListener('resize', () => this.measure());
    this.measure();
    prepareAudio(); // 启动画面还盖着：先把 AudioContext 建好（suspended，不出声），第一次按下时只唤醒
    armOnFirstGesture();
    this.world.frameHooks.add((dt) => this.frame(dt));
    this.installDebug();
    void this.warm().catch((err: unknown) => console.error(err));
  }

  // —— 准备 ——

  private async warm(): Promise<void> {
    // 券面上的字要用 Nunito：等字体下好再画一遍图集、卡片排一次版
    await fontsReady();
    drawAtlas(this.atlasCanvas);
    this.field.tickets.atlas.needsUpdate = true;
    this.card.warm();
    await this.world.warm;
    // 图集只被着色器节点引用（不是材质的 map），Stager 找不到它：自己先传一次
    this.world.renderer.initTexture(this.field.tickets.atlas);
    this.field.showForCompile(true);
    try {
      await this.world.stage.precompile(this.field.group);
    } finally {
      this.field.showForCompile(false);
    }
    this.world.scene.add(this.field.group);
    this.fxReady = true;
    // 站桩翠宝：和漫游的角色同一个模型（克隆），投影、编译好了才上场
    const model = await loadStandModel(this.screen.view.library);
    await this.world.stage.precompile(model.object);
    this.stand.setModel(model);
    this.standModelReady = true;
    this.ready = true;
  }

  private measure(): void {
    const r = this.world.renderer.domElement.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = r.width || 1;
    this.rect.height = r.height || 1;
  }

  // —— 谁能点 ——

  // 现在能和翠宝、券互动：在星球上、不在编辑、不在转场和镜头飞行里、Museum 没盖着、卡片没开着
  private interactive(): boolean {
    const w = this.world;
    return this.fxReady && this.entry !== null && !this.editor.active && !w.director.busy && !w.paused && (!w.rig.flying || this.walk.active) && !this.card.open;
  }

  private walkerAvailable(): boolean {
    return this.walk.active && this.walk.ready && this.walk.character.root.visible && this.walk.character.root.parent !== null;
  }

  // 翠宝身体（球）的中心和半径（世界坐标）
  private bodyOf(who: Who, center: THREE.Vector3): number {
    if (who === 'stand') return this.stand.body(center);
    const entry = this.walk.planet!;
    const g = entry.planet.group;
    this.walk.walker.positionInto(center).multiplyScalar(g.scale.x).add(g.position).addScaledVector(this.walk.walker.dir, 0.6 * CHAR_HEIGHT * g.scale.x);
    return 0.42 * CHAR_HEIGHT * g.scale.x;
  }

  // 指针下面是哪个翠宝（被星球挡住的不算）
  private hitTriboo(x: number, y: number): Who | null {
    const ray = this.world.rayFrom(x, y).ray;
    const cam = this.world.rig.camera.position;
    for (const who of ['walker', 'stand'] as const) {
      if (who === 'stand' && !(this.stand.shown && this.standEntry === this.entry)) continue;
      if (who === 'walker' && !this.walkerAvailable()) continue;
      const r = this.bodyOf(who, _c);
      _sphere.set(_c, r);
      if (!ray.intersectSphere(_sphere, _hit)) continue;
      if (!this.occluded(cam, _c)) return who;
    }
    return null;
  }

  // 从 eye 看 p，中间隔着聚焦的星球（按最低可能的地形算）
  private occluded(eye: THREE.Vector3, p: THREE.Vector3): boolean {
    const entry = this.entry;
    if (!entry) return false;
    const planet = entry.planet;
    const R = planet.radius * planet.group.scale.x * (1 - PRESETS[planet.currentRecipe.preset].amp);
    _sphere.set(entry.home, R);
    _v.copy(p).sub(eye);
    const dist = _v.length();
    _ray.set(eye, _v.divideScalar(dist || 1));
    return _ray.intersectSphere(_sphere, _hit) !== null && _hit.distanceTo(eye) < dist;
  }

  private readonly visible = (p: THREE.Vector3): boolean => !this.occluded(this.world.rig.camera.position, p);

  // —— 输入 ——

  private onMove(e: PointerEvent): void {
    if (e.buttons !== 0 || !this.interactive()) {
      this.setHover(null, null, e.clientX, e.clientY);
      return;
    }
    const coupon = this.field.pick(e.clientX, e.clientY, this.world.rig.camera, this.rect, this.visible);
    const who = coupon === null ? this.hitTriboo(e.clientX, e.clientY) : null;
    this.setHover(who, coupon, e.clientX, e.clientY);
  }

  private setHover(who: Who | null, coupon: number | null, x: number, y: number): void {
    this.hoverWho = who;
    if (coupon !== this.hoverCoupon) {
      this.hoverCoupon = coupon;
      this.field.setHovered(coupon);
    }
    const canvas = this.world.renderer.domElement;
    if (who || coupon !== null) {
      if (canvas.style.cursor !== 'pointer') canvas.style.cursor = 'pointer';
      this.cursorOwned = true;
    } else if (this.cursorOwned) {
      this.cursorOwned = false;
      // 指针从翠宝直接移到作品上：星球页刚把光标设成手形，不要清掉
      const overWork = x >= 0 && !this.walk.active && this.screen.view.pick(x, y) !== null;
      if (!overWork && canvas.style.cursor === 'pointer') canvas.style.cursor = '';
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    // 漫游时由 WalkMode 转过来（walk.onClick），这里不重复处理
    if (!d || d.id !== e.pointerId || e.button !== 0 || this.walk.active) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    this.click(e.clientX, e.clientY);
  }

  // 点了画面：点到券就捡，点到翠宝就吐券（或者摇头）；返回 true 表示这一下归这里（漫游时就不走过去）
  click(x: number, y: number): boolean {
    if (!this.interactive() || this.picking) return false;
    const coupon = this.field.pick(x, y, this.world.rig.camera, this.rect, this.visible);
    if (coupon !== null) {
      this.pickUp(coupon);
      return true;
    }
    const who = this.hitTriboo(x, y);
    if (!who) return false;
    // 星球视图里翠宝前面正好有一件作品：让给作品（作品卡）
    if (who === 'stand' && !this.walk.active) {
      const pw = this.screen.view.pick(x, y);
      if (pw) {
        this.bodyOf('stand', _c);
        const cam = this.world.rig.camera.position;
        if (pw.root.getWorldPosition(_w).distanceTo(cam) < _c.distanceTo(cam)) return false;
      }
    }
    this.poke(who);
    return true;
  }

  // 戳一下翠宝：冷却中摇头，否则吐券。正在吐、正在摇头时不打断动作：吐完以后还在冷却里就接着摇一下头
  poke(who: Who): boolean {
    if (!this.interactive()) return false;
    if (this.act.mode !== 'idle') {
      if (this.act.mode === 'spit' && this.act.launched) this.pendingShake = who;
      return true;
    }
    if (this.clock < this.cooldownUntil) {
      this.shake(who);
      return true;
    }
    this.begin(who, 'spit', reducedMotion());
    this.counts.spits++;
    play('charge');
    return true;
  }

  private shake(who: Who): void {
    this.begin(who, 'shake', reducedMotion());
    this.counts.shakes++;
    play('nope', 0.97 + this.rand() * 0.06);
  }

  private pendingShake: Who | null = null;

  private begin(who: Who, mode: 'spit' | 'shake', reduced: boolean): void {
    if (this.act.who && this.act.who !== who) this.logo(this.act.who, 0);
    const a = this.act;
    a.who = who;
    a.mode = mode;
    a.t = 0;
    a.launched = false;
    a.reduced = reduced;
    a.turning = false;
    a.faceYaw = 0;
    this.faceBlend = 1;
    this.pendingShake = null;
    // 漫游：背对着镜头时先转过来（走着的时候不转）
    if (who === 'walker' && mode === 'spit' && !reduced) {
      const w = this.walk.walker;
      const entry = this.walk.planet!;
      const g = entry.planet.group;
      w.positionInto(_o).multiplyScalar(g.scale.x).add(g.position);
      _v.copy(this.world.rig.camera.position).sub(_o);
      _v.addScaledVector(w.dir, -_v.dot(w.dir));
      if (_v.lengthSq() > 1e-6) {
        _v.normalize();
        const angle = Math.atan2(_w.crossVectors(w.facing, _v).dot(w.dir), w.facing.dot(_v));
        if (Math.abs(angle) > 0.5 && w.speed < 0.4) {
          a.turning = true;
          a.faceYaw = angle;
        }
      }
    }
  }

  // 漫游的翠宝（或站桩的）这一下的脚下坐标系：吐的方向是它面朝的方向（转过身就是对着镜头）
  private anchor(who: Who, out: CouponAnchor): number {
    if (who === 'stand') {
      this.stand.frame(out.origin, out.up, out.fwd, out.right);
      return this.stand.scale;
    }
    const w = this.walk.walker;
    const g = this.walk.planet!.planet.group;
    w.positionInto(out.origin).multiplyScalar(g.scale.x).add(g.position);
    out.up.copy(w.dir);
    out.fwd.copy(w.facing);
    if (this.act.turning) out.fwd.applyAxisAngle(w.dir, this.act.faceYaw * this.faceBlend);
    out.right.crossVectors(out.up, out.fwd).normalize();
    return this.hero();
  }

  private readonly anchorTmp: CouponAnchor = { origin: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3() };

  // 吐：3–5 张券从嘴里（logo 上方）出来，一团彩屑，「啵」
  private launch(): void {
    const who = this.act.who!;
    const a = this.anchorTmp;
    const hero = this.anchor(who, a);
    const H = CHAR_HEIGHT * hero;
    _c.copy(a.origin).addScaledVector(a.up, (0.8 + this.pose.lift) * H * Math.max(1, this.pose.sy)).addScaledVector(a.fwd, 0.36 * H);
    const n = couponCount(this.rand);
    const tickets: CouponTicket[] = drawCoupons(this.rand, n);
    const spots = tickets.map((_, i) => landingSpot(i, n, this.rand));
    this.field.spawn(tickets, a, _c, hero, spots, this.act.reduced);
    if (!this.act.reduced) this.field.sparks.burst(_c, a.up, a.fwd, a.right, COUPONS.confetti, hero);
    play('pop', 0.95 + this.rand() * 0.1);
    play('sparkle', 0.98 + this.rand() * 0.06);
    this.cooldownUntil = this.clock + COUPONS.cooldown;
  }

  private pickUp(id: number): void {
    const ticket = this.field.ticketOf(id);
    if (!ticket) return;
    this.measure();
    const at = this.card.prepare(ticket);
    this.picking = { id, x: at.x, y: at.y, width: at.width };
    if (!this.field.pickUp(id, this.world.rig.camera.position)) {
      this.picking = null;
      this.card.hide();
      return;
    }
    this.counts.pickups++;
    this.setHover(null, null, -1, -1);
    play('pickup');
  }

  // 券飞到镜头前了：卡片接手
  private arrive(): void {
    this.card.show(reducedMotion());
  }

  // 飞向镜头的终点：卡片上那张券在画面上的位置和大小，换成镜头前 D 米处的一点（正对镜头）
  private readonly target = (out: PickupTarget): void => {
    const p = this.picking;
    const cam = this.world.rig.camera;
    const D = 1.4;
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const x = p ? ((p.x - this.rect.left) / this.rect.width) * 2 - 1 : 0;
    const y = p ? 1 - ((p.y - this.rect.top) / this.rect.height) * 2 : 0;
    out.pos.set(x * D * tanH * cam.aspect, y * D * tanH, -D).applyMatrix4(cam.matrixWorld);
    out.quat.copy(cam.quaternion);
    out.size = ((p?.width ?? COUPONS.cardPx) / this.rect.height) * 2 * D * tanH;
  };

  // —— 每帧 ——

  private hero(): number {
    return 1 + (this.screen.view.presentScale - 1) * COUPONS.boost;
  }

  private frame(dt: number): void {
    this.clock += dt;
    const world = this.world;
    const entry = this.screen.view.planet;
    const team = this.screen.view.team;
    // 离开星球（或换了一颗）：券、彩屑、卡片都收掉，站桩的翠宝立刻摘掉
    if (entry !== this.entry) {
      this.entry = entry;
      this.field.clear();
      this.card.hide();
      this.picking = null;
      this.cancelAct();
      if (this.standEntry && this.standEntry !== entry) this.leaveStand();
    }
    if (entry) {
      this.ground.home.copy(entry.home);
      this.ground.scale = entry.planet.group.scale.x;
    }
    // 站桩的翠宝：只在「你的星球」上、不在漫游、转场结束以后出场（从小长大），漫游时缩小退场
    const mine = team !== null && team.id === this.app.you.teamId;
    const want = this.standModelReady && entry !== null && mine && this.walk.phase === 'off' && !world.director.busy;
    if (want && entry) {
      if (this.standEntry !== entry) this.enterStand(entry);
      if (this.spotDirty) this.placeStand(entry);
      if (!this.stand.shown) this.showStand(entry);
    } else if (this.stand.shown) {
      this.stand.hide();
      if (this.act.who === 'stand') this.cancelAct();
    }
    const camera = world.rig.camera;
    // 吐券、摇头的时间线
    const a = this.act;
    if (a.mode !== 'idle') {
      a.t += dt;
      if (a.who === 'walker' && !this.walkerAvailable()) this.cancelAct();
      else if (a.who === 'stand' && !this.stand.shown) this.cancelAct();
    }
    if (a.mode === 'spit') {
      const T = spitTimes(a.turning);
      // 漫游中转身时又走起来了：转身很快收掉
      if (a.who === 'walker') this.faceBlend += ((this.walk.walker.speed > 0.4 ? 0 : 1) - this.faceBlend) * (1 - Math.exp(-12 * dt));
      if (!a.launched && a.t >= T.launch) {
        spitPose(a.t, a.turning, this.pose);
        a.launched = true;
        this.launch();
      }
      if (a.t >= T.done) {
        const who = a.who;
        this.cancelAct();
        // 吐的时候又点了：还在冷却里就摇一下头
        if (who && this.pendingShake === who && this.clock < this.cooldownUntil && this.interactive()) this.shake(who);
        this.pendingShake = null;
      }
    } else if (a.mode === 'shake' && a.t >= COUPONS.shakeSeconds) {
      this.cancelAct();
    }
    // 姿态：吐券 / 摇头 + 悬停时轻轻一缩
    const pose = this.pose;
    if (a.mode === 'spit') spitPose(a.t, a.turning, pose);
    else if (a.mode === 'shake') shakePose(a.t, pose);
    else restPose(pose);
    if (a.reduced) {
      // 减弱动效：不压扁、不蹦、不晃，只亮一下 logo（摇头也小一些）
      pose.sy = 1;
      pose.sxz = 1;
      pose.lift = 0;
      pose.roll = 0;
      pose.pitch = 0;
      pose.jitter = 0;
      pose.face = 0;
      pose.yaw *= 0.4;
    }
    const h = stepHover(this.hoverSpring, this.hoverWho && a.mode === 'idle' ? 1 : 0, dt);
    // 站桩的
    const standPose = a.who === 'stand' ? pose : this.restTmp;
    if (a.who !== 'stand') restPose(this.restTmp);
    this.applyHover(standPose, this.hoverWho === 'stand' || a.who === 'stand' ? h : 0);
    if (this.stand.root.visible && entry) {
      _v.copy(camera.position).sub(entry.home).divideScalar(entry.planet.group.scale.x || 1);
      this.stand.update(dt, this.hero(), _v, standPose, a.who !== 'stand' || a.mode === 'idle');
      this.logo('stand', a.who === 'stand' ? standPose.glow : 0);
    }
    // 漫游的：CharacterView.pose() 每帧摆好了，这里在它上面再叠一层（下一帧它会重新摆，不会越叠越多）
    if (this.walkerAvailable()) {
      const wp = a.who === 'walker' ? pose : this.restTmp;
      if (a.who !== 'walker') restPose(this.restTmp);
      this.applyHover(wp, this.hoverWho === 'walker' || a.who === 'walker' ? h : 0);
      this.poseWalker(wp);
      this.logo('walker', a.who === 'walker' ? wp.glow : 0);
    }
    // 券
    updateCouponLight(world.light.sunDir, world.light.evening, WEATHER.rain, this.clock);
    if (this.fxReady) this.field.update(dt, camera, entry ? this.ground : null, this.hero(), this.target, this.pickTarget);
  }

  private readonly restTmp: TribooPose = restPose();

  private applyHover(p: TribooPose, h: number): void {
    if (h === 0) return;
    const k = COUPONS.hoverSquash * h;
    p.sy *= 1 - k;
    p.sxz *= 1 + k * 0.5;
  }

  private poseWalker(p: TribooPose): void {
    if (p.sy === 1 && p.sxz === 1 && p.lift === 0 && p.roll === 0 && p.pitch === 0 && p.yaw === 0 && p.jitter === 0 && p.face === 0) return;
    const root = this.walk.character.root;
    const w = this.walk.walker;
    const s = root.scale.y;
    const faceYaw = this.act.who === 'walker' && this.act.turning ? this.act.faceYaw * p.face * this.faceBlend : 0;
    _e.set(p.pitch, p.yaw + faceYaw, p.roll, 'YZX');
    root.quaternion.multiply(_q.setFromEuler(_e));
    root.scale.x *= p.sxz;
    root.scale.y *= p.sy;
    root.scale.z *= p.sxz;
    _r.crossVectors(w.dir, w.facing);
    root.position.addScaledVector(w.dir, p.lift * CHAR_HEIGHT * s).addScaledVector(_r, p.jitter * CHAR_HEIGHT * s);
  }

  private logo(who: Who, k: number): void {
    if (who === 'stand') {
      this.stand.model?.logo(k * COUPONS.glow);
      return;
    }
    if (!this.walkerLogo && this.walk.ready) this.walkerLogo = logoGlow(this.walk.character.root);
    this.walkerLogo?.(k * COUPONS.glow);
  }

  private cancelAct(): void {
    if (this.act.who) this.logo(this.act.who, 0);
    this.act.mode = 'idle';
    this.act.who = null;
    this.act.t = 0;
    this.act.launched = false;
    this.act.turning = false;
  }

  // —— 站桩的翠宝：站哪 ——

  private enterStand(entry: PlanetEntry): void {
    this.leaveStand();
    this.standEntry = entry;
    this.spotDirty = true;
    this.unlistenMask = entry.planet.onMaskChange(() => { this.spotDirty = true; });
  }

  private leaveStand(): void {
    this.unlistenMask?.();
    this.unlistenMask = null;
    this.stand.hide(true);
    this.standEntry = null;
  }

  private readonly spot = new THREE.Vector3();

  // 落点：镜头正对的地方往作品那边一点（避开水、土路、小溪、作品）；作品挪了（编辑器）重新挑，挪远了就换个地方站
  private placeStand(entry: PlanetEntry): void {
    this.spotDirty = false;
    const planet = entry.planet;
    const view = planetViewDir();
    const upOnScreen = new THREE.Vector3(0, 1, 0).addScaledVector(view, -view.y).normalize();
    const works = planet.currentRecipe.placements.map((p) => new THREE.Vector3(...p.dir).normalize());
    const dir = chooseSpot({
      radius: planet.radius,
      sea: planet.sea,
      height: (x, y, z) => planet.height(x, y, z),
      exclude: (d) => planet.mask.exclude(d),
    }, view, upOnScreen, works);
    const moved = this.spot.angleTo(dir) * planet.radius > 1.5;
    this.spot.copy(dir);
    if (this.stand.shown && moved) this.stand.hide(true);
  }

  private showStand(entry: PlanetEntry): void {
    const view = planetViewDir();
    // 面朝镜头（星球视图的取景方向）
    this.stand.show(entry, this.spot, _f.copy(view).multiplyScalar(entry.planet.radius * 3));
  }

  // —— 自查脚本 ——

  private screenOf(p: THREE.Vector3): ScreenPos | null {
    const cam = this.world.rig.camera;
    _w.copy(p).project(cam);
    if (_w.z > 1 || Math.abs(_w.x) > 1 || Math.abs(_w.y) > 1) return null;
    return { x: this.rect.left + ((_w.x + 1) / 2) * this.rect.width, y: this.rect.top + ((1 - _w.y) / 2) * this.rect.height };
  }

  private installDebug(): void {
    window.__coupons = {
      state: () => {
        const standAt = this.stand.shown && this.standEntry ? (this.stand.body(_u), this.visible(_u) ? this.screenOf(_u) : null) : null;
        const walkerAt = this.walkerAvailable() ? (this.bodyOf('walker', _u), this.screenOf(_u)) : null;
        const shown = this.card.shown;
        return {
          ready: this.ready,
          actor: this.act.who,
          mode: this.act.mode,
          t: this.act.t,
          cooldown: Math.max(0, this.cooldownUntil - this.clock),
          hover: this.hoverWho !== null || this.hoverCoupon !== null,
          squash: this.hoverSpring[0],
          clock: this.clock,
          cursor: this.world.renderer.domElement.style.cursor,
          stand: { shown: this.stand.shown, at: standAt, scale: this.stand.scale },
          walker: { at: walkerAt },
          coupons: this.field.snapshot().map((c) => ({ id: c.id, phase: c.phase, kind: c.kind, code: c.code, at: this.visible(_u.set(...c.pos)) ? this.screenOf(_u) : null, opacity: c.opacity })),
          card: { open: this.card.open, title: shown ? this.card.layer.querySelector('.cc-title')?.textContent ?? null : null, code: shown?.code ?? null },
          audio: audioReady(),
          counts: { ...this.counts },
        };
      },
      poke: (who) => this.poke(who ?? (this.walkerAvailable() ? 'walker' : 'stand')),
      clear: () => this.field.clear(),
    };
  }
}

export function installCoupons(app: App, screen: PlanetScreen, walk: WalkMode, editor: Editor): Coupons {
  return new Coupons(app, screen, walk, editor);
}

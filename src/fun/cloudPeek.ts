import * as THREE from 'three/webgpu';
import { dot, instancedBufferAttribute, length, max, mix, normalize, smoothstep, sqrt, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { App } from '../app';
import { easeOutCubic, smooth, span } from '../scenes/ease';
import type { HomeTuneFolder } from '../scenes/homeTune';
import { reducedMotion } from '../scenes/transition';
import { cloudTriboo } from '../scenes/homeCloudTriboo';
import type { PlanetEntry, World } from '../scenes/world';
import { el } from '../ui/dom';
import type { CloudPeekState } from '../ui/home';
import { BALL_C, BALL_R, besideSpot, boxGap, clearance, footprint, GUIDE, GuideMemo, pointAt, type Box, type Disc } from './cloudPeekMath';
import type { Coupons } from './coupons';
import type { HomeTriboo } from './couponsHome';
import { COUPONS, restPose, shakePose, spitPose, spitTimes, stepHover, type TribooPose } from './couponsMath';
import { logoGlow } from './couponsStand';
import { HOME_TRIBOO } from './homeTribooMath';
import { findArms, type Arm } from './tribooRig';

// 首页云里探头的翠宝（H2）：每隔 20–40 秒（随机），在两颗星球之间的空隙里、旋臂之间的云海上冒出一只 3D 翠宝——
// - 冒出来：云面先鼓起来（几团小云从云海里拱起来），翠宝探出上半身（圆滚滚的身子和两只手），出来时从侧着转过来对着镜头，
//   往后仰一点看着镜头（镜头越往下看仰得越多，脸上的 V 才看得见）
// - 停 2–3 秒：左右看一看，挥一下手
// - 回去：沉回云里，小云合上、沉下去，外面散开一圈小云絮
// - 点它：蓄力、弹起来吐一张券（Coupons.spitHome：和右下角那只同一张券、同一个领券窗口、同一个冷却），冷却中点只摇头；
//   悬停时手形光标、身子轻轻一缩；键盘：露头的时候有一个看不见的按钮盖在它身上（同右下角那只）
// 位置每次按当时的镜头挑（左右转 360° 都行）：画面中间偏下，躲开星球、名牌、标题卡片、右下角的翠宝、左下角的徽章。
// 和别的东西错开：场上同一时间只有一只翠宝——冒头前右下角那只先整个缩到画面外，这只沉下去以后它再慢慢探回来；
// 指着星球或名牌、在拖、镜头还在动、在转场、造星窗口开着、领券窗口开着时不冒；
// 开场结束后至少等 8 秒；减弱动效时不冒。
// 悬停时带路（④，同一只、同一套动作）：指针（或键盘焦点）在一颗星球、它的名牌上停 0.6 秒，翠宝从那颗星球旁边的云里冒出来
// （站在左右两边，名牌在星球正下方那边不站；不压这颗星球、它的名牌，也不压别的），举起一只手指着它、点一下头；
// 指针一离开就沉回去。前 3 次一定带，之后同一颗星球 30 秒内不再带。带路的那只不接点击（点星球照样进星球）。
// 定时那只露着的时候指到星球上：它先沉下去，再从那颗星球旁边冒出来
// 开销：翠宝是开场探头那只（已经加载、编译好）的克隆，几何、材质共用，不编新的着色器，只在露头时显示；
// 身边的小云是一批朝向镜头的面片（14 片，一次绘制），开场时在后台编好，只在露头时显示

export const CLOUD_PEEK = {
  enabled: true, // 定时冒出来
  first: 8, // 开场结束以后至少等多久才第一次冒（秒）
  firstSpread: 6, // 再随机多等 0..这么久
  min: 20, // 之后每隔 min..max 秒冒一次（随机）
  max: 40,
  // 第二版 [v2-world]：动作放慢、显得从容（不回弹）：每一段长四到七成
  bulge: 0.7, // 云面先鼓起来（秒）
  rise: 0.95, // 探出上半身
  stay: 3.4, // 停多久：左右看、挥一下手
  sink: 0.8, // 沉回云里
  close: 1.05, // 小云合上、沉下去，一圈小云絮散开
  size: 0.13, // 身高占画面高度多少（手机上按 1.4 × 画面宽封顶；挑位置那一刻按离镜头多远换算成世界尺寸）
  out: 0.68, // 露出来多少（× 身高，从头顶往下）：身子整个出来，脚在云里
  look: 22, // 左右看多少度（第二版收一点：30 → 22）
  turn: 55, // 出来时从侧着转向镜头（度）（70 → 55）
  lean: 0.6, // 往后仰着看镜头：镜头俯视角的多少（最多 38°）
  puff: 1, // 小云的亮度
};

// wait：等右下角那只整个缩到画面外（场上同一时间只有一只翠宝），再让云面鼓起来
type Phase = 'idle' | 'wait' | 'bulge' | 'rise' | 'stay' | 'sink' | 'close';
const WAIT_MAX = 1.2; // 最多等多久（秒）：右下角那只缩不走（正在吐券之类）就这一次不冒了
const CLOUD_ROOM = 16; // 挑位置时离 P3 的云朵翠宝至少多留几像素
type Mode = 'timer' | 'guide';

interface Act {
  mode: 'spit' | 'shake';
  t: number;
  launched: boolean;
}

const COLLAR = 7; // 围在身边的小云（前面和两边：盖住身子和云面相交的那条线）
const RING = 7; // 合上时散开的一圈小云絮
const FLUFF = COLLAR + RING;
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _hop = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _ndc = new THREE.Vector2();
const _sphere = new THREE.Sphere();
const _hit = new THREE.Vector3();
const _disc = { x: 0, y: 0, r: 0 };
const _a = { x: 0, y: 0 };
const _b = { x: 0, y: 0 };
const hash = (k: number) => {
  const s = Math.sin(k * 12.9898 + 4.1) * 43758.5453;
  return s - Math.floor(s);
};

// 身边的小云：朝向镜头的软球（按一个球的法线打光：左上方亮、右下方暗），颜色跟着云海（atmosphere.cloudTone），一次绘制
class Fluff {
  readonly sprite: THREE.Sprite;
  private readonly pos = new THREE.InstancedBufferAttribute(new Float32Array(FLUFF * 3), 3);
  private readonly size = new THREE.InstancedBufferAttribute(new Float32Array(FLUFF), 1);
  private readonly alpha = new THREE.InstancedBufferAttribute(new Float32Array(FLUFF), 1);
  readonly lit = uniform(new THREE.Vector3(1.6, 1.4, 1.1));
  readonly shade = uniform(new THREE.Vector3(0.8, 0.62, 0.48));

  constructor() {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    m.positionNode = instancedBufferAttribute(this.pos);
    m.scaleNode = instancedBufferAttribute(this.size);
    const a = instancedBufferAttribute(this.alpha) as unknown as THREE.Node<'float'>;
    const p = uv().sub(0.5).mul(2);
    const d = length(p);
    const n = vec3(p.x, p.y, sqrt(max(0, d.mul(d).oneMinus())));
    const light = dot(n, normalize(vec3(-0.3, 0.75, 0.6)));
    const body = smoothstep(1.0, 0.72, d);
    m.colorNode = vec4(mix(this.shade, this.lit, smoothstep(-0.25, 0.85, light)), body.mul(a));
    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'cloud-peek-fluff';
    this.sprite.frustumCulled = false;
    this.sprite.count = FLUFF;
    this.sprite.renderOrder = -4; // 云海（-10）、星尘（-6）、暖光（-5）之后：盖得住云海；翠宝不透明，先画，挡在它后面的小云
    this.sprite.visible = false;
  }

  set(i: number, x: number, y: number, z: number, s: number, a: number): void {
    (this.pos.array as Float32Array).set([x, y, z], i * 3);
    (this.size.array as Float32Array)[i] = Math.max(0, s);
    (this.alpha.array as Float32Array)[i] = Math.max(0, Math.min(1, a));
  }

  commit(): void {
    this.pos.needsUpdate = true;
    this.size.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

export class CloudPeek {
  ready = false;
  private readonly app: App;
  private readonly world: World;
  private readonly coupons: Coupons;
  private readonly corner: HomeTriboo;
  private readonly root = new THREE.Group();
  private readonly fluff = new Fluff();
  private modelHeight = 1;
  private arms: Arm[] = [];
  private logo: ((k: number) => void) | null = null;
  private phase: Phase = 'idle';
  private mode: Mode = 'timer';
  private t = 0;
  private act: Act | null = null;
  private ours = false; // 领券窗口是这只吐的券开的（开着时照样演完再沉）
  private readonly pose: TribooPose = restPose();
  private readonly hoverSpring: [number, number] = [0, 0];
  private hovering = false;
  private cursorOwned = false;
  private down: { x: number; y: number } | null = null;
  private dragging = false;
  private still = 0; // 镜头多久没动了（秒）
  private readonly lastCam = new THREE.Vector3(1e9, 0, 0);
  private sinceOpening = -1; // 开场结束以后过了多久（-1：还没结束）
  private nextIn = Infinity;
  private homeFor = 0;
  private count = 0;
  private focused = false;
  private time = 0;
  private raise = 0;
  private readonly spot = new THREE.Vector3(); // 冒出来的地方（云面上）
  private readonly ball = new THREE.Vector3(); // 身子（球）的中心，世界坐标
  private H = 1; // 身高（世界单位）
  private planeY = 0; // 云面（云海圆盘）的高度：下面的东西被云海盖住
  private turnFrom = 1;
  private readonly box: Box & { valid: boolean } = { left: 0, top: 0, right: 0, bottom: 0, valid: false };
  private readonly body = { x: 0, y: 0, valid: false };
  private readonly button: HTMLButtonElement;
  private creatorNode: HTMLElement | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly discs: Disc[] = [];
  private readonly tags: Box[] = [];
  private readonly boxes: Box[] = [];
  private readonly cloudBox: Box = { left: 0, top: 0, right: 0, bottom: 0 }; // P3 的云朵翠宝在画面上占的地方
  // 悬停时带路
  private target: PlanetEntry | null = null; // 带路时指着的那颗星球
  private pointing: PlanetEntry | null = null; // 指针（或键盘焦点）在哪颗星球、哪张名牌上
  private pointFor = 0; // 在上面停了多久（秒）
  private pending: PlanetEntry | null = null; // 停够了、要带路的那颗（定时那只先沉下去）
  private readonly memo = new GuideMemo();
  private pointSide: 1 | -1 = 1; // 用哪只手指（+1：画面右边那只）
  private pointUp = Math.PI / 2; // 手举多高
  private pointTurn = 0; // 身子往星球那边转多少
  private bx = NaN; // 按钮上一次写的位置、大小
  private by = NaN;
  private bw = NaN;
  private bh = NaN;

  constructor(app: App, coupons: Coupons, corner: HomeTriboo) {
    this.app = app;
    this.world = app.world;
    this.coupons = coupons;
    this.corner = corner;
    this.root.name = 'cloud-peek-triboo';
    this.root.visible = false;
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this.setHover(this.hits(e.clientX, e.clientY)));
    canvas.addEventListener('pointerleave', () => this.setHover(false));
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.dragging = true;
      this.down = e.button === 0 && this.hits(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
    });
    addEventListener('pointerup', () => { this.dragging = false; });
    addEventListener('pointercancel', () => { this.dragging = false; });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (d && e.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && this.hits(e.clientX, e.clientY)) this.poke();
    });
    // 键盘：露头的时候盖在它身上的看不见的按钮（同右下角那只）；选中时一直露着，回车、空格吐券
    this.button = el('button', { className: 'home-triboo-key', type: 'button', textContent: 'Get a coupon from Triboo in the clouds' });
    this.button.style.borderRadius = '45%';
    this.button.hidden = true;
    this.button.addEventListener('click', () => this.poke());
    this.button.addEventListener('focus', () => { this.focused = true; });
    this.button.addEventListener('blur', () => { this.focused = false; });
    app.root.append(this.button);
    this.world.frameHooks.add((dt) => this.frame(dt));
    void this.load().catch((err: unknown) => console.warn('cloud Triboo unavailable', err));
  }

  // 开场探头的翠宝（scenes/peek.ts）准备好以后克隆一个（几何、材质共用：管线都是现成的）；身边的小云在后台编好。
  // 编译时要显示着（编译跳过看不见的东西），编完藏起来再挂进场景
  private async load(): Promise<void> {
    const mascot = await this.world.director.peek.ready;
    if (!mascot) return;
    const model = mascot.object.clone(true);
    model.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false; // 同右下角那只：包围球按缩放前算，不能让它被剔掉
    });
    this.root.add(model);
    // 腿和鞋一直在云里：这只克隆上不画（往后仰时鞋尖会翘出云面）。按每一块在模型里的高度认（GLB、替身都行）
    const height = mascot.height || 1;
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld).max.y < 0.34 * height) mesh.visible = false;
    });
    const warm = new THREE.Group();
    warm.add(this.root, this.fluff.sprite);
    this.root.visible = true;
    this.fluff.sprite.visible = true;
    try {
      await this.world.stage.precompile(warm);
    } finally {
      this.root.visible = false;
      this.fluff.sprite.visible = false;
    }
    this.world.scene.add(this.root, this.fluff.sprite);
    this.modelHeight = height;
    this.arms = findArms(model);
    this.logo = logoGlow(model);
    this.ready = true;
  }

  // 在场上（鼓起来、露着、沉下去、合上，哪一步都算）
  get active(): boolean {
    return this.phase !== 'idle';
  }

  // 首页、不在转场、造星窗口没开
  private home(): boolean {
    const w = this.world;
    if (w.focused || w.director.busy || w.rig.flying || w.paused || w.rig.drive) return false;
    if ((w.galaxy?.shapeState.t ?? -1) >= 0) return false; // 开场的星尘拼标志在放（同右下角那只）
    this.creatorNode ??= this.app.root.querySelector<HTMLElement>('section.creator');
    if (this.creatorNode && !this.creatorNode.hidden) return false;
    return !location.hash.startsWith('#/create');
  }

  // 现在能按时冒出来：没指着星球、名牌，没在拖，镜头停稳了，领券窗口没开，右下角那只没在演
  private allowed(): boolean {
    return this.world.hovered === null && this.pending === null && !this.dragging && this.still > 0.5 && !this.coupons.card.open && !this.corner.busy && this.homeFor > 1.5 && !reducedMotion();
  }

  // P3 的云朵翠宝聚到（或散到）这只露出来的地方了（离它不到 6 像素）：定时冒出来的那只让开，沉回去（带路的不让：指针还在星球上）
  private crowded(): boolean {
    if (!this.box.valid) return false;
    const r = cloudTriboo()?.screenRect(this.cloudBox);
    if (!r) return false;
    const g = boxGap(this.box, r);
    return g >= 0 ? g < 6 : true;
  }

  // ?tune 的 Peek now、自查脚本：马上冒出来（不管定时、开关、指没指着东西；位置照样躲开星球、名牌）。冒不出来返回 false
  peek(force = true): boolean {
    if (!this.ready || reducedMotion() || !this.home() || this.coupons.card.open) return false;
    if (this.phase !== 'idle') return true;
    return this.start('timer', () => this.choose(force));
  }

  // 指针（或键盘焦点）在哪颗星球、名牌上、停了多久；停够 GUIDE.delay 秒、这一次该带路（前几次一定带，之后同一颗隔一会儿）就排上
  private trackPointing(dt: number): void {
    const now = this.app.galaxyUi.pointing;
    if (now !== this.pointing) {
      this.pointing = now;
      this.pointFor = 0;
      this.pending = null;
      return;
    }
    if (!now) return;
    const before = this.pointFor;
    this.pointFor += dt;
    if (before >= GUIDE.delay || this.pointFor < GUIDE.delay) return;
    if (!GUIDE.on || reducedMotion() || this.dragging || this.coupons.card.open) return;
    if (this.mode === 'guide' && this.target === now && this.active) return;
    if (this.memo.wants(now.team.id, this.time)) this.pending = now;
  }

  // 带路：从这颗星球旁边冒出来。挑不到地方就算了（这一次不带）
  private guide(e: PlanetEntry): void {
    this.pending = null;
    // 开场还没演完（右下角那只在打招呼）时不带：场上同一时间只有一只翠宝
    if (!this.ready || reducedMotion() || !this.home() || !this.corner.opened || this.coupons.card.open || this.pointing !== e) return;
    this.target = e;
    if (this.start('guide', () => this.chooseBeside(e))) this.memo.note(e.team.id, this.time);
    else this.target = null;
  }

  private start(mode: Mode, pick: () => boolean): boolean {
    this.mode = mode; // 挑位置按这一种的大小
    if (!pick()) return false;
    this.phase = 'wait';
    this.t = 0;
    this.act = null;
    this.ours = false;
    this.turnFrom = Math.random() < 0.5 ? -1 : 1;
    this.raise = 0;
    if (mode === 'timer') this.count++;
    if (this.corner.tucked) this.toPhase('bulge');
    return true;
  }

  // 身高在画面上多少像素
  private screenHeight(): number {
    return CLOUD_PEEK.size * Math.min(innerHeight, innerWidth * 1.4);
  }

  // 画面上要躲开的东西：每颗星球的圆，显示着的名牌、标题卡片、徽章、右上角的登录条、右下角的翠宝
  private gather(): void {
    const w = this.world;
    const W = innerWidth;
    const Hp = innerHeight;
    w.rig.camera.updateMatrixWorld();
    const discs = this.discs;
    discs.length = 0;
    for (const e of w.planets.values()) {
      if (w.planetOnScreen(e, _disc)) discs.push({ x: _disc.x, y: _disc.y, r: _disc.r });
    }
    const boxes = this.boxes;
    boxes.length = 0;
    const nt = this.app.galaxyUi.tagRects(this.tags);
    for (let i = 0; i < nt; i++) boxes.push(this.tags[i]);
    for (const sel of ['.tb-title', '#app > .made-with', '.tb-who']) {
      const r = this.app.root.querySelector(sel)?.getBoundingClientRect();
      if (r && r.width > 0) boxes.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    boxes.push({ left: W - Math.max(150, W * 0.14), top: Hp - Math.max(230, Hp * 0.3), right: W, bottom: Hp }); // 右下角的翠宝
    // P3 的云朵翠宝（scenes/homeCloudTriboo.ts）：聚好时是它连手带脚那一圈；聚拢、散开的时候按云絮散到多远算。
    // 多留 CLOUD_ROOM 像素：它散开时还在变大，慢慢飘也会挪一点（露着的时候碰到它就沉回去，见 crowded）
    const cloud = cloudTriboo()?.screenRect(this.cloudBox);
    if (cloud) {
      cloud.left -= CLOUD_ROOM;
      cloud.top -= CLOUD_ROOM;
      cloud.right += CLOUD_ROOM;
      cloud.bottom += CLOUD_ROOM;
      boxes.push(cloud);
    }
  }

  // 画面上 (px, py) 这一点往云面上打一条线：打到了、不太远（地平线那边的云又小又雾）就返回那一点的俯视角正弦，否则 null
  private probe(px: number, py: number): number | null {
    const w = this.world;
    const cam = w.rig.camera;
    _ndc.set((px / innerWidth) * 2 - 1, 1 - (py / innerHeight) * 2);
    this.raycaster.setFromCamera(_ndc, cam);
    const ray = this.raycaster.ray;
    if (ray.direction.y > -0.08) return null;
    const t = (w.atmosphere.objects.sea.position.y - ray.origin.y) / ray.direction.y;
    if (!(t > 0) || t > cam.position.distanceTo(w.rig.controls.target) * 2.6) return null;
    return -ray.direction.y;
  }

  // 挑中了画面上的 (px, py)：往云面上打一条线得到冒出来的地方，再按离镜头多远定身高（在画面上 full 像素那么高）
  private settle(px: number, py: number, full: number): void {
    const cam = this.world.rig.camera;
    const planeY = this.world.atmosphere.objects.sea.position.y;
    _ndc.set((px / innerWidth) * 2 - 1, 1 - (py / innerHeight) * 2);
    this.raycaster.setFromCamera(_ndc, cam);
    const ray = this.raycaster.ray;
    this.spot.copy(ray.origin).addScaledVector(ray.direction, (planeY - ray.origin.y) / ray.direction.y);
    this.planeY = planeY;
    _v.copy(this.spot).applyMatrix4(cam.matrixWorldInverse);
    const depth = Math.max(1, -_v.z);
    this.H = (full / innerHeight) * 2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
  }

  // 定时冒出来挑位置：画面上一格一格试（中间偏下优先），每一格按这时的镜头算出露出来的那一块（身子、手、身边的小云）在画面上多大，
  // 不能压到星球、名牌、标题卡片、右下角的翠宝、左下角的徽章，离它们越远越好
  private choose(force: boolean): boolean {
    if (!this.world.atmosphere.objects.sea.visible) return false;
    this.gather();
    const W = innerWidth;
    const Hp = innerHeight;
    const full = this.screenHeight();
    const c = CLOUD_PEEK.out - (1 - BALL_C); // 球心在云面上多高（× 身高）
    const margin = force ? 4 : 12;
    const r: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    let best = -Infinity;
    let bx = 0;
    let by = 0;
    const N = 28;
    for (let gy = 0; gy <= N; gy++) {
      for (let gx = 0; gx <= N; gx++) {
        const px = W * (0.06 + (0.88 * gx) / N);
        const py = Hp * (0.28 + (0.68 * gy) / N); // 云面那一点在画面上的位置
        const sin = this.probe(px, py);
        if (sin === null) continue;
        footprint(px, py, full, c, sin, r);
        if (r.left < 8 || r.right > W - 8 || r.top < 8 || r.bottom > Hp - 6) continue;
        const clear = clearance(r, this.discs, this.boxes, margin);
        if (clear < 0) continue;
        const cy = (r.top + r.bottom) / 2;
        const score = -Math.hypot((px - W * 0.5) / W, (cy - Hp * 0.6) / Hp) + (0.15 * Math.min(clear, full * 0.9)) / full;
        if (score > best) {
          best = score;
          bx = px;
          by = py;
        }
      }
    }
    if (best === -Infinity) return false;
    this.settle(bx, by, full);
    return true;
  }

  // 带路挑位置：在这颗星球旁边（cloudPeekMath.besideSpot：左右两边、和星球差不多高，不往名牌那边站），不压它、它的名牌和别的
  private chooseBeside(e: PlanetEntry): boolean {
    const w = this.world;
    if (!w.atmosphere.objects.sea.visible) return false;
    this.gather();
    if (!w.planetOnScreen(e, _disc)) return false;
    const planet = { x: _disc.x, y: _disc.y, r: _disc.r };
    const full = this.screenHeight() * GUIDE.size;
    const c = CLOUD_PEEK.out - (1 - BALL_C);
    const spot = besideSpot(planet, full, c, this.discs, this.boxes, { w: innerWidth, h: innerHeight }, (px, py) => this.probe(px, py), 8);
    if (!spot) return false;
    this.settle(spot.x, spot.y, full);
    return true;
  }

  // 指针在它身上（身子那个球露在云面上面的部分）
  hits(x: number, y: number): boolean {
    if (!this.clickable()) return false;
    _sphere.set(this.ball, (BALL_R + 0.06) * this.H);
    const ray = this.world.rayFrom(x, y).ray;
    if (!ray.intersectSphere(_sphere, _hit)) return false;
    return _hit.y > this.planeY - 0.02 * this.H;
  }

  // 能点：探出来一大半、还没开始沉（带路的那种不接点击）
  private clickable(): boolean {
    if (!this.ready || this.mode === 'guide' || (this.coupons.card.open && !this.act)) return false;
    return (this.phase === 'rise' && this.t > CLOUD_PEEK.rise * 0.45) || this.phase === 'stay';
  }

  private setHover(on: boolean): void {
    this.hovering = on;
    const canvas = this.world.renderer.domElement;
    if (on) {
      if (canvas.style.cursor !== 'pointer') canvas.style.cursor = 'pointer';
      this.cursorOwned = true;
    } else if (this.cursorOwned) {
      this.cursorOwned = false;
      if (canvas.style.cursor === 'pointer' && !this.world.hovered) canvas.style.cursor = '';
    }
  }

  // 点了：冷却中摇头；否则蓄力、弹起来吐券。正在吐、正在摇头时不打断
  poke(): boolean {
    if (!this.clickable() || this.act) return false;
    if (this.phase === 'rise') {
      this.phase = 'stay';
      this.t = 0;
    }
    if (this.coupons.cooling) {
      this.act = { mode: 'shake', t: 0, launched: false };
      this.coupons.shakeHome();
      return true;
    }
    this.act = { mode: 'spit', t: 0, launched: false };
    this.coupons.chargeHome();
    return true;
  }

  // 吐：嘴在 logo 上方往前一点；券先往左上拱一下，再飞到画面中间（领券窗口上那张券的位置），同右下角那只
  private launch(): void {
    const H = this.H;
    const cam = this.world.rig.camera;
    _up.copy(UP).applyQuaternion(this.root.quaternion);
    _fwd.copy(Z).applyQuaternion(this.root.quaternion);
    _right.crossVectors(_up, _fwd).normalize();
    _mouth.copy(this.ball).addScaledVector(_up, (0.8 - BALL_C) * H * Math.max(1, this.pose.sy)).addScaledVector(_fwd, 0.36 * H);
    _q.copy(cam.quaternion).multiply(_q2.setFromAxisAngle(Z, 0.4));
    _hop.set(-0.5, 1, 0).applyQuaternion(cam.quaternion).multiplyScalar(H * 0.9);
    this.coupons.field.sparks.burst(_mouth, _up, _fwd, _right, COUPONS.confetti, H);
    this.ours = true;
    this.coupons.spitHome(_mouth, _q, HOME_TRIBOO.ticket * H, _hop, HOME_TRIBOO.flight, false);
  }

  private frame(dt: number): void {
    this.time += dt;
    const w = this.world;
    const home = this.home();
    this.homeFor = home ? this.homeFor + dt : 0;
    const cam = w.rig.camera.position;
    const moved = cam.distanceToSquared(this.lastCam) > (0.0006 * Math.max(1, cam.length())) ** 2;
    this.lastCam.copy(cam);
    this.still = moved ? 0 : this.still + dt;
    const p = CLOUD_PEEK;
    // 开场演完（右下角那只打完招呼）以后开始计时：第一次至少等 first 秒
    if (this.sinceOpening < 0) {
      if (home && this.corner.opened) {
        this.sinceOpening = 0;
        this.nextIn = p.first + Math.random() * p.firstSpread;
      }
    } else this.sinceOpening += dt;
    if (!this.ready) return;
    if (!home) {
      if (this.phase !== 'idle') this.reset();
      this.pointing = null;
      this.pending = null;
      return;
    }
    this.trackPointing(dt);
    // 要带路：没在场上就冒；定时那只（或上一颗星球的带路）已经沉下去、在合上了，就不等合完，直接到这颗星球旁边冒
    if (this.pending) {
      if (this.phase === 'close') this.finish();
      if (this.phase === 'idle') this.guide(this.pending);
    }
    if (this.phase === 'idle') {
      if (p.enabled && this.sinceOpening >= 0 && !reducedMotion()) {
        this.nextIn -= dt;
        if (this.nextIn <= 0 && this.allowed() && !this.start('timer', () => this.choose(false))) this.nextIn = 3; // 这会儿挑不到位置：过 3 秒再试
      }
      return;
    }
    this.step(dt);
  }

  // 立刻收掉（转场、离开首页、造星窗口打开）
  private reset(): void {
    this.act = null;
    this.logo?.(0);
    for (const a of this.arms) a.pivot.rotation.z = a.rest;
    this.finish();
  }

  private schedule(): void {
    const p = CLOUD_PEEK;
    this.nextIn = Math.max(1, p.min + Math.random() * Math.max(0, p.max - p.min));
  }

  private toPhase(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
    if (phase === 'bulge') {
      this.fluff.sprite.visible = true;
      this.place(0);
    }
    if (phase === 'rise') this.root.visible = true;
    if (phase === 'close') {
      this.root.visible = false;
      this.button.hidden = true;
      if (this.hovering) this.setHover(false);
    }
  }

  private step(dt: number): void {
    const p = CLOUD_PEEK;
    this.t += dt;
    const out = this.phase === 'bulge' || this.phase === 'rise' || this.phase === 'stay';
    // 别的东西开了领券窗口（右下角那只吐的）、开始指着星球或名牌（带路的：指针离开了那颗星球）：沉回去
    // （自己吐的券开的窗口照样演完）；还没冒头就直接不冒了
    const leave = this.mode === 'timer' ? this.world.hovered !== null || this.crowded() : this.pointing !== this.target;
    if (!this.act && ((this.coupons.card.open && !this.ours) || leave)) {
      if (this.phase === 'wait') {
        this.finish();
        return;
      }
      if (out) this.toPhase('sink');
    }
    const a = this.act;
    if (a) {
      a.t += dt;
      if (a.mode === 'spit') {
        const T = spitTimes(false);
        if (!a.launched && a.t >= T.launch) {
          a.launched = true;
          this.launch();
        }
        if (a.t >= T.done) {
          this.act = null;
          this.toPhase('sink'); // 吐完开心地晃两下，沉回云里（领券窗口在展开）
        }
      } else if (a.t >= COUPONS.shakeSeconds) this.act = null;
    }
    switch (this.phase) {
      case 'wait':
        if (this.corner.tucked) this.toPhase('bulge');
        else {
          if (this.t >= WAIT_MAX) this.finish();
          return;
        }
        break;
      case 'bulge':
        if (this.t >= p.bulge) this.toPhase('rise');
        break;
      case 'rise':
        if (this.t >= p.rise) this.toPhase('stay');
        break;
      case 'stay':
        // 键盘选中、指针指着它、正在吐 / 摇头时一直露着；带路的一直露到指针离开那颗星球
        if (this.mode === 'timer' && !this.act && !this.focused && !this.hovering && this.t >= p.stay) this.toPhase('sink');
        break;
      case 'sink':
        if (this.t >= p.sink) this.toPhase('close');
        break;
      case 'close':
        if (this.t >= p.close) {
          this.finish();
          return;
        }
        break;
      default:
        break;
    }
    this.place(dt);
  }

  // 演完了（或者还没冒头就不冒了）：藏起来，排下一次
  private finish(): void {
    this.phase = 'idle';
    this.root.visible = false;
    this.fluff.sprite.visible = false;
    this.button.hidden = true;
    this.box.valid = false;
    this.body.valid = false;
    if (this.hovering) this.setHover(false);
    this.schedule();
  }

  // 每帧：位置、朝向、姿态、手臂、身边的小云、盖在身上的按钮
  private place(dt: number): void {
    const p = CLOUD_PEEK;
    const H = this.H;
    const t = this.t;
    const hidden = -(BALL_R + 0.12); // 球心在云面下多深时整个藏住（× 身高）
    const shown = p.out - (1 - BALL_C);
    const guiding = this.mode === 'guide';
    let c = hidden;
    let turn = 0; // 还没转过来的部分 0..1
    let look = 0;
    let raise = 0;
    let wave = 0;
    let nod = 0;
    switch (this.phase) {
      case 'rise': {
        const u = Math.min(1, t / p.rise);
        c = hidden + (shown - hidden) * easeOutCubic(u); // 第二版：慢慢升上来、不冲过头（原来 easeOutBack 会弹一下）
        turn = 1 - easeOutCubic(Math.min(1, u / 0.9));
        if (guiding) raise = smooth(span(u, 0.55, 1)); // 快出来时就举手指着星球
        break;
      }
      case 'stay': {
        c = shown + Math.sin(this.time * 1.3) * 0.008; // 浮着轻轻起伏（第二版：慢一点、小一点）
        if (guiding) {
          // 一直指着星球，点一下头
          raise = 1;
          nod = Math.sin(Math.PI * span(t, 0.25, 1.1)); // 第二版：点头慢一点
        } else if (!this.act) {
          // 左右看一看（先往一边、再往另一边），然后挥一下手。第二版：看得慢一点（一来一回 2.2 秒），手慢慢举起来、慢慢挥（1 次 / 秒）
          const env = smooth(span(t, 0, 0.3)) * (1 - smooth(span(t, 1.85, 2.2)));
          look = THREE.MathUtils.degToRad(p.look) * Math.sin((t / 2.2) * Math.PI * 2) * env * this.turnFrom;
          raise = smooth(span(t, 2.0, 2.45)) * (1 - smooth(span(t, Math.max(2.6, p.stay - 0.55), Math.max(2.8, p.stay - 0.15))));
          wave = Math.sin((t - 2.0) * Math.PI * 2 * 1.0);
        }
        break;
      }
      case 'sink': {
        const u = Math.min(1, t / p.sink);
        c = shown + (hidden - shown) * smooth(u); // 第二版：慢慢沉下去（原来 easeInBack 会先往上提一下）
        if (guiding) raise = 1 - smooth(span(u, 0, 0.6));
        break;
      }
      default:
        break;
    }
    // 姿态：吐券 / 摇头 + 悬停时轻轻一缩（同右下角那只）
    const pose = this.pose;
    const a = this.act;
    if (a?.mode === 'spit') spitPose(a.t, false, pose);
    else if (a?.mode === 'shake') shakePose(a.t, pose);
    else restPose(pose);
    const h = stepHover(this.hoverSpring, this.hovering && !a ? 1 : 0, dt);
    if (h !== 0) {
      const k = COUPONS.hoverSquash * h;
      pose.sy *= 1 - k;
      pose.sxz *= 1 + k * 0.5;
    }
    this.logo?.(pose.glow * COUPONS.glow);
    // 朝向：每帧对着镜头（镜头转了也跟着转），出来时从侧着转过来，往后仰着看镜头，再叠上左右看、姿态
    const cam = this.world.rig.camera.position;
    const dx = cam.x - this.spot.x;
    const dz = cam.z - this.spot.z;
    const face = Math.atan2(dx, dz);
    const elev = Math.atan2(cam.y - this.planeY, Math.hypot(dx, dz));
    const lean = Math.min(THREE.MathUtils.degToRad(38), Math.max(0, elev - THREE.MathUtils.degToRad(10)) * p.lean);
    this.raise += (raise - this.raise) * (1 - Math.exp(-6 * dt)); // 第二版：手举得慢一点（10 → 6）
    // 带路：身子往星球那边转一点（跟着手举起来）
    const toward = guiding ? this.pointTurn * this.raise : 0;
    const yaw = face + turn * this.turnFrom * THREE.MathUtils.degToRad(p.turn) + look + toward;
    const root = this.root;
    _q.setFromAxisAngle(UP, yaw).multiply(_q2.setFromAxisAngle(X, -lean));
    _e.set(pose.pitch + nod * THREE.MathUtils.degToRad(GUIDE.nod), pose.yaw, pose.roll + look * 0.12, 'YZX');
    root.quaternion.copy(_q).multiply(_q2.setFromEuler(_e));
    const k = H / this.modelHeight;
    const b = Math.sin((this.time / 4.2) * Math.PI * 2) * 0.015; // 呼吸（第二版：慢一点、浅一点）
    root.scale.set(k * pose.sxz * (1 - b * 0.5), k * pose.sy * (1 + b), k * pose.sxz * (1 - b * 0.5));
    // 球心定在冒出来的地方正上方（仰、晃都绕着球心转，身子不往后倒出那个洞）
    this.ball.set(this.spot.x, this.planeY + (c + pose.lift) * H, this.spot.z);
    _v.set(0, BALL_C * this.modelHeight * root.scale.y, 0).applyQuaternion(root.quaternion);
    root.position.copy(this.ball).sub(_v);
    root.updateMatrixWorld(true);
    // 挥手：画面左边那只（模型的 -X），同右下角那只；带路：星球那边那只手指着星球
    if (guiding) this.aim();
    for (const arm of this.arms) {
      let up = 0;
      if (guiding) up = arm.side === this.pointSide ? this.raise * this.pointUp : 0;
      else if (arm.side === -1) up = this.raise * (2.8 + THREE.MathUtils.degToRad(15) * wave); // 往后仰着：举高一点才看得出在挥（第二版挥得小一点：22° → 15°）
      arm.pivot.rotation.z = arm.rest + arm.side * up;
    }
    this.placeFluff();
    this.measure();
  }

  // 带路：按画面上身子中心到星球中心的方向定用哪只手、举多高、身子往哪边转
  private aim(): void {
    const e = this.target;
    if (!e || !this.world.planetOnScreen(e, _disc)) return;
    _v.copy(this.ball).project(this.world.rig.camera);
    const x = ((_v.x + 1) / 2) * innerWidth;
    const y = ((1 - _v.y) / 2) * innerHeight;
    const a = pointAt(x, y, _disc.x, _disc.y);
    if (Math.abs(_disc.x - x) > 4) this.pointSide = a.side; // 正上方、正下方时不来回换手
    this.pointUp = a.up;
    this.pointTurn = a.turn;
  }

  // 身边的小云：鼓起来（从云海里拱起来，下半截被云海盖着）→ 往两边让开、围着身子 → 沉的时候往里收、盖住那个洞
  // → 合上：沉回云海里，外面散开一圈小云絮
  private placeFluff(): void {
    const p = CLOUD_PEEK;
    const H = this.H;
    const t = this.t;
    const tone = this.world.atmosphere.cloudTone;
    this.fluff.lit.value.copy(tone.lit).multiplyScalar(0.55).add(_v.set(0.8, 0.8, 0.8)).multiplyScalar(p.puff);
    this.fluff.shade.value.copy(tone.mid).multiplyScalar(0.72).add(_v.set(0.18, 0.16, 0.15)).multiplyScalar(p.puff);
    const cam = this.world.rig.camera.position;
    let fx = cam.x - this.spot.x;
    let fz = cam.z - this.spot.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = fz;
    const rz = -fx;
    let rr = 0.42; // 离中心多远（× 身高）
    let size = 0.34;
    let y = 0.03; // 小云中心在云面上多高
    let alpha = 1;
    switch (this.phase) {
      case 'bulge': {
        const u = Math.min(1, t / p.bulge);
        const e = easeOutCubic(u);
        rr = 0.1 + 0.06 * e;
        size = 0.26 + 0.12 * e;
        y = -0.2 + 0.24 * e;
        alpha = Math.min(1, u * 3);
        break;
      }
      case 'rise': {
        const u = Math.min(1, t / p.rise);
        rr = 0.16 + 0.26 * easeOutCubic(u);
        size = 0.38 - 0.04 * u;
        y = 0.04 - 0.01 * u;
        break;
      }
      case 'stay':
        size = 0.34 * (1 + 0.04 * Math.sin(this.time * 1.7));
        break;
      case 'sink': {
        const u = Math.min(1, t / p.sink);
        rr = 0.42 - 0.24 * smooth(u);
        size = 0.34 + 0.06 * u;
        y = 0.03 + 0.04 * Math.sin(Math.PI * u);
        break;
      }
      case 'close': {
        const u = Math.min(1, t / p.close);
        rr = 0.18 - 0.08 * u;
        size = 0.4 - 0.1 * u;
        y = 0.03 - 0.3 * smooth(span(u, 0.15, 1));
        alpha = 1 - smooth(span(u, 0.6, 1));
        break;
      }
      default:
        break;
    }
    for (let i = 0; i < COLLAR; i++) {
      const th = -2.0 + (4.0 * i) / (COLLAR - 1) + (hash(i) - 0.5) * 0.3;
      const ddx = fx * Math.cos(th) + rx * Math.sin(th);
      const ddz = fz * Math.cos(th) + rz * Math.sin(th);
      const r = rr * (0.85 + 0.3 * hash(i + 7)) * H;
      const s = size * (0.78 + 0.44 * hash(i + 11)) * H;
      this.fluff.set(i, this.spot.x + ddx * r, this.planeY + (y + (hash(i + 3) - 0.5) * 0.05) * H, this.spot.z + ddz * r, s, alpha);
    }
    // 合上时外面散开的一圈小云絮
    const u = this.phase === 'close' ? Math.min(1, t / p.close) : -1;
    for (let i = 0; i < RING; i++) {
      const j = COLLAR + i;
      if (u < 0) {
        this.fluff.set(j, this.spot.x, this.planeY, this.spot.z, 0, 0);
        continue;
      }
      const th = (i / RING) * Math.PI * 2 + 0.3 + (hash(j) - 0.5) * 0.5;
      const r = (0.3 + 0.9 * easeOutCubic(u)) * H * (0.85 + 0.3 * hash(j + 5));
      const s = 0.2 * H * (1 - 0.45 * u) * (0.8 + 0.4 * hash(j + 9));
      this.fluff.set(j, this.spot.x + Math.cos(th) * r, this.planeY + (0.03 + 0.06 * u) * H, this.spot.z + Math.sin(th) * r, s, 0.85 * Math.min(1, u * 5) * (1 - u) ** 1.2);
    }
    this.fluff.commit();
  }

  // 露出来那一块在画面上（CSS 像素）：身子那个球、两只手，云面下面的不算。键盘按钮盖在上面、自查脚本点它
  private measure(): void {
    const cam = this.world.rig.camera;
    const W = innerWidth;
    const Hp = innerHeight;
    const proj = (v: THREE.Vector3, out: { x: number; y: number }): boolean => {
      _v.copy(v).project(cam);
      if (_v.z > 1) return false;
      out.x = ((_v.x + 1) / 2) * W;
      out.y = ((1 - _v.y) / 2) * Hp;
      return true;
    };
    const H = this.H;
    const R = BALL_R * H * this.pose.sxz;
    const hAbove = this.ball.y - this.planeY;
    let vis = this.root.visible && hAbove > -R * 0.5 && proj(this.ball, _a);
    if (vis) {
      _v.copy(this.ball).applyMatrix4(cam.matrixWorldInverse);
      const S = Hp / 2 / (Math.max(1, -_v.z) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)); // 球心那么远的地方，1 个世界单位多少像素
      const rp = R * S;
      // 最下面露出来的一点：云面切过球的那个圈朝镜头的那一点（球整个出来了就是球的下沿）
      let bottom = _a.y + rp;
      if (hAbove < R) {
        const rho = Math.sqrt(Math.max(0, R * R - hAbove * hAbove));
        const dx = cam.position.x - this.ball.x;
        const dz = cam.position.z - this.ball.z;
        const l = Math.hypot(dx, dz) || 1;
        _c.set(this.ball.x + (dx / l) * rho, this.planeY, this.ball.z + (dz / l) * rho);
        if (proj(_c, _b)) bottom = Math.min(bottom, _b.y);
      }
      this.box.left = _a.x - rp * 1.3;
      this.box.right = _a.x + rp * 1.3;
      this.box.top = _a.y - rp - this.raise * 0.28 * H * S;
      this.box.bottom = Math.max(_a.y - rp * 0.4, bottom);
      vis = this.box.bottom > this.box.top + 4;
      this.body.x = _a.x;
      this.body.y = (Math.max(this.box.top, _a.y - rp) + this.box.bottom) / 2;
    }
    this.box.valid = vis;
    this.body.valid = vis;
    // 键盘的按钮：能点的时候盖在露出来的那一块上
    const can = vis && this.clickable();
    if (this.button.hidden === can) this.button.hidden = !can;
    if (can) {
      const x = Math.round(this.box.left);
      const y = Math.round(this.box.top);
      const bw = Math.max(1, Math.round(this.box.right - this.box.left));
      const bh = Math.max(1, Math.round(this.box.bottom - this.box.top));
      if (x !== this.bx || y !== this.by || bw !== this.bw || bh !== this.bh) {
        this.bx = x;
        this.by = y;
        this.bw = bw;
        this.bh = bh;
        const s = this.button.style;
        s.transform = `translate3d(${x}px, ${y}px, 0)`;
        s.width = `${bw}px`;
        s.height = `${bh}px`;
      }
    }
  }

  // 自查脚本用
  debug(): CloudPeekState {
    const can = this.clickable() && this.body.valid;
    return {
      ready: this.ready,
      phase: this.phase,
      active: this.phase !== 'idle',
      at: can ? { x: this.body.x, y: this.body.y } : null,
      rect: this.box.valid ? { left: this.box.left, top: this.box.top, right: this.box.right, bottom: this.box.bottom } : null,
      hover: this.hovering,
      act: this.act?.mode ?? null,
      nextIn: Number.isFinite(this.nextIn) ? this.nextIn : -1,
      since: this.sinceOpening,
      count: this.count,
      guides: this.memo.count,
      mode: this.mode,
      guideFor: this.mode === 'guide' && this.phase !== 'idle' ? this.target?.team.id ?? null : null,
    };
  }
}

// ?tune → Home → Cloud peek
export function addCloudPeekTune(folder: HomeTuneFolder, cloud: CloudPeek): void {
  const f = folder.addFolder({ title: 'Cloud peek', expanded: false });
  f.addBinding(CLOUD_PEEK, 'enabled', { label: 'pop up now and then' });
  const list: Array<[keyof typeof CLOUD_PEEK & string, number, number, number, string]> = [
    ['min', 3, 120, 1, 'every min s'],
    ['max', 3, 180, 1, 'every max s'],
    ['first', 0, 60, 0.5, 'first after opening s'],
    ['stay', 0.5, 8, 0.05, 'stay s'],
    ['size', 0.05, 0.3, 0.005, 'size (of screen height)'],
    ['out', 0.4, 0.9, 0.01, 'shows above clouds'],
    ['lean', 0, 1, 0.01, 'lean back to camera'],
    ['puff', 0.5, 1.6, 0.01, 'cloud puffs brightness'],
    ['bulge', 0.1, 1.5, 0.01, 'clouds bulge s'],
    ['rise', 0.2, 1.5, 0.01, 'pop out s'],
    ['sink', 0.2, 1.5, 0.01, 'sink s'],
    ['close', 0.2, 1.5, 0.01, 'clouds close s'],
    ['look', 0, 60, 0.5, 'look around°'],
    ['turn', 0, 120, 1, 'turn to camera°'],
  ];
  for (const [key, min, max, step, label] of list) f.addBinding(CLOUD_PEEK, key, { min, max, step, label });
  f.addButton({ title: 'Peek now' }).on('click', () => { cloud.peek(true); });
  // 悬停时带路（④）
  f.addBinding(GUIDE, 'on', { label: 'Hover guide' });
  const guide: Array<[keyof typeof GUIDE & string, number, number, number, string]> = [
    ['delay', 0.1, 3, 0.05, 'guide after hovering s'],
    ['free', 0, 10, 1, 'always guide first n'],
    ['again', 0, 120, 1, 'same planet again after s'],
    ['size', 0.5, 1.4, 0.01, 'guide size'],
    ['nod', 0, 30, 0.5, 'nod°'],
  ];
  for (const [key, min, max, step, label] of guide) f.addBinding(GUIDE, key, { min, max, step, label });
}

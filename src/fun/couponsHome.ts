import * as THREE from 'three/webgpu';
import type { App } from '../app';
import { addHomeTuneExtra, type HomeTuneFolder } from '../scenes/homeTune';
import { reducedMotion } from '../scenes/transition';
import type { World } from '../scenes/world';
import { el } from '../ui/dom';
import type { HomeDebug } from '../ui/home';
import type { Coupons } from './coupons';
import { addCloudPeekTune, CloudPeek } from './cloudPeek';
import { CLAIM_URL } from './couponsCard';
import { COUPONS, restPose, shakePose, spitPose, spitTimes, stepHover, type TribooPose } from './couponsMath';
import { logoGlow } from './couponsStand';
import { greetPose, HOME_TRIBOO, leanFor, nextPeek, peekPose, placeTriboo, stepOut, type Placement } from './homeTribooMath';
import { findArms, type Arm } from './tribooRig';

// 首页右下角躲着的翠宝（H2）：和星球页站桩的同一个 3D 翠宝（开场探头 scenes/peek.ts 加载、编译好的那一份，克隆一个：
// 几何、材质共用，不用再编着色器）。它挂在主场景里、每帧按镜头摆在画面右下角（多几次绘制，不加渲染通道）。
// - 平时：露出一小半，隔一会儿探出头左右看一眼再缩回去；指针靠近时探出更多、挥手；悬停在它身上光标变成手形、身子轻轻一缩
// - 点它：先探出来，蓄力、弹起来，从嘴里吐一张券（couponsMath 的 spitPose，和星球页同一套手感），券飞到画面中间展开成领券窗口
//   （Coupons.spitHome：同一张券、同一张卡片、同一个冷却；冷却中再点只摇头）
// - 开场：飞行落定后在右边缘探出来挥两下手（代替原来从星球后面探头：App.start 照旧调 director.peekIntro，这里接过去）
// - 转场、星球视图里缩到边外；减弱动效时不探头、不挥手、不蹦，点了只亮一下 logo，领券窗口淡入
// - 键盘：一个看不见的按钮（Tab 能选到，回车吐券），选中时翠宝探出来

type Phase = 'away' | 'idle' | 'peek' | 'near' | 'greet' | 'spit' | 'shake';

interface Act {
  mode: 'spit' | 'shake';
  t: number;
  launched: boolean;
  reduced: boolean;
}

const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _hop = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sphere = new THREE.Sphere();

export class HomeTriboo {
  ready = false; // 模型准备好了（克隆、编译好）
  // 云里探头的翠宝正在露头（cloudPeek.ts）：这只就不自己探头（场上同一时间只有一只在演）
  quiet: (() => boolean) | null = null;
  private readonly world: World;
  private readonly coupons: Coupons;
  private readonly root = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private modelHeight = 1;
  private arms: Arm[] = [];
  private logo: ((k: number) => void) | null = null;
  private readonly out: [number, number] = [HOME_TRIBOO.away, 0]; // 露出多少的弹簧
  private readonly hoverSpring: [number, number] = [0, 0];
  private readonly place: Placement = placeTriboo(HOME_TRIBOO.away, 0, 1.6, 40, HOME_TRIBOO.size);
  private readonly pose: TribooPose = restPose();
  private act: Act | null = null;
  private greetT = -1; // 开场打招呼进行到哪（秒；< 0 没在打招呼）
  private greetPending = false; // 开场要打招呼，但模型还没好
  private peekT = -1;
  private peekIn = nextPeek(Math.random());
  private waveT = 0;
  private raise = 0;
  private started = false; // 开过场了：打过招呼，或者直接从星球页回到首页
  private homeFor = 0;
  private time = 0;
  private hovering = false;
  private near = false;
  private focused = false; // 键盘选中了看不见的按钮
  private cursorOwned = false;
  private down: { x: number; y: number } | null = null;
  private readonly pointer = { x: -1e4, y: -1e4, inside: false };
  private readonly screen = { x: 0, y: 0, r: 0, visible: false }; // 身体在画面上（CSS 像素）：露出来那一块的中心、半径
  private readonly button: HTMLButtonElement;

  constructor(app: App, coupons: Coupons) {
    this.world = app.world;
    this.coupons = coupons;
    this.root.name = 'home-triboo';
    this.root.visible = false;
    const world = this.world;
    const canvas = world.renderer.domElement;
    addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => { this.pointer.inside = false; });
    canvas.addEventListener('pointermove', (e) => this.setHover(this.hits(e.clientX, e.clientY)));
    canvas.addEventListener('pointerleave', () => this.setHover(false));
    canvas.addEventListener('pointerdown', (e) => {
      this.down = e.button === 0 && this.hits(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (d && e.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && this.hits(e.clientX, e.clientY)) this.poke();
    });
    // 键盘：看不见的按钮（选中时翠宝探出来，回车、空格吐券）
    this.button = el('button', { className: 'home-triboo-key', type: 'button', textContent: 'Get a coupon from Triboo' });
    this.button.addEventListener('click', () => this.poke());
    this.button.addEventListener('focus', () => { this.focused = true; });
    this.button.addEventListener('blur', () => { this.focused = false; });
    app.root.append(this.button);
    // 星球不接指在翠宝身上的那一下（悬停、点击）
    app.galaxyUi.blocker = (x, y) => this.hits(x, y);
    // 券飞过来、领券窗口开着的时候名牌收起来（不盖在券上）
    app.galaxyUi.hush = () => coupons.card.open;
    // 开场探头改到这里：App.start 在开场飞行落定后调 director.peekIntro，翠宝从右边缘探出来打招呼
    world.director.peekIntro = () => this.greet();
    world.frameHooks.add((dt) => this.frame(dt));
    void this.load().catch((err: unknown) => console.warn('home Triboo unavailable', err));
  }

  // 开场探头的翠宝（scenes/peek.ts）加载、编译好以后：克隆一个，再在后台编译一遍（WebGL2 上先画一次），挂进场景
  private async load(): Promise<void> {
    const mascot = await this.world.director.peek.ready;
    if (!mascot) return;
    const model = mascot.object.clone(true);
    model.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false; // 一半在画面外：包围球按缩放前算，不能让它被剔掉
    });
    this.root.add(model);
    await this.world.stage.precompile(this.root);
    this.model = model;
    this.modelHeight = mascot.height || 1;
    this.arms = findArms(model);
    this.logo = logoGlow(model);
    this.world.scene.add(this.root);
    this.ready = true;
  }

  // 开场打招呼（App.start → director.peekIntro）：没准备好就等准备好了再打；减弱动效时直接出来，不探不挥
  greet(): boolean {
    this.started = true;
    if (reducedMotion()) return false;
    if (!this.ready) {
      this.greetPending = true;
      return true;
    }
    this.greetT = 0;
    this.peekT = -1;
    return true;
  }

  // 在首页、开过场、露出来了、领券窗口没开着：能点
  private interactive(): boolean {
    return this.ready && this.home() && this.started && this.out[0] > 0.12 && !this.coupons.card.open;
  }

  private home(): boolean {
    const w = this.world;
    return !w.focused && !w.director.busy && !w.rig.flying && !w.paused && !w.rig.drive;
  }

  // 指针在翠宝身上（身体那个球，被画面右边缘切掉的部分不算）
  hits(x: number, y: number): boolean {
    if (!this.interactive() || x >= innerWidth) return false;
    this.bodyCenter(_c);
    _sphere.set(_c, this.place.bodyR * 1.08);
    return this.world.rayFrom(x, y).ray.intersectsSphere(_sphere);
  }

  // 身体中心（世界坐标）
  private bodyCenter(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0.62 * this.modelHeight, 0).applyMatrix4(this.root.matrixWorld);
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

  // 点了：冷却中摇头；否则（先探出来一点）蓄力、弹起来吐券。正在吐、正在摇头时不打断
  poke(): boolean {
    if (!this.interactive() || this.act) return false;
    const reduced = reducedMotion();
    this.greetT = -1;
    this.greetPending = false;
    this.peekT = -1;
    if (this.coupons.cooling) {
      this.act = { mode: 'shake', t: 0, launched: false, reduced };
      this.coupons.shakeHome();
      return true;
    }
    // 缩着的时候先往外探 0.14 秒再蓄力：吐的时候整个身子都在画面里
    this.act = { mode: 'spit', t: this.out[0] < 0.6 && !reduced ? -0.14 : 0, launched: false, reduced };
    this.coupons.chargeHome();
    return true;
  }

  // 吐：嘴在 logo 上方往前一点（同 coupons.launch）；券先往左上拱一下，再飞到画面中间（领券窗口上那张券的位置）
  private launch(reduced: boolean): void {
    const H = this.place.height;
    const cam = this.world.rig.camera;
    _up.copy(Y).applyQuaternion(this.root.quaternion);
    _fwd.copy(Z).applyQuaternion(this.root.quaternion);
    _right.crossVectors(_up, _fwd).normalize();
    _mouth.copy(this.root.position).addScaledVector(_up, (0.8 + this.pose.lift) * H * Math.max(1, this.pose.sy)).addScaledVector(_fwd, 0.36 * H);
    _q.copy(cam.quaternion).multiply(_q2.setFromAxisAngle(Z, 0.4));
    _hop.set(-0.5, 1, 0).applyQuaternion(cam.quaternion).multiplyScalar(H * 0.9);
    if (!reduced) this.coupons.field.sparks.burst(_mouth, _up, _fwd, _right, COUPONS.confetti, H);
    this.coupons.spitHome(_mouth, _q, HOME_TRIBOO.ticket * H, _hop, HOME_TRIBOO.flight, reduced);
  }

  private frame(dt: number): void {
    this.time += dt;
    const p = HOME_TRIBOO;
    const home = this.home();
    this.homeFor = home ? this.homeFor + dt : 0;
    if (home && this.homeFor > 0.5) this.started = true; // 直接打开星球页、再回首页：不打招呼，直接出来
    if (!home) {
      this.act = null;
      this.greetT = -1;
      this.peekT = -1;
      if (this.hovering) this.setHover(false);
    }
    if (!this.ready || !this.model) return;
    if (this.greetPending && home) {
      this.greetPending = false;
      this.greetT = 0;
    }
    const reduced = reducedMotion();
    // 吐券、摇头的时间线
    const a = this.act;
    if (a) {
      a.t += dt;
      if (a.mode === 'spit') {
        const T = spitTimes(false);
        if (!a.launched && a.t >= T.launch) {
          a.launched = true;
          this.launch(a.reduced);
        }
        if (a.t >= T.done) this.act = null;
      } else if (a.t >= COUPONS.shakeSeconds) this.act = null;
    }
    if (this.greetT >= 0) {
      this.greetT += dt;
      if (this.greetT >= p.greetHold) this.greetT = -1;
    }
    // 指针靠近（露出来那一块的中心）：探出更多、挥手；键盘选中也一样
    const s = this.screen;
    this.near = home && this.started && !reduced && !this.coupons.card.open
      && (this.focused || (this.pointer.inside && s.visible && Math.hypot(this.pointer.x - s.x, this.pointer.y - s.y) < p.reach));
    // 偶尔探头：只在没事干的时候
    const idle = home && this.started && !this.act && this.greetT < 0 && !this.near && !reduced && !this.quiet?.();
    if (this.peekT >= 0) {
      this.peekT += dt;
      if (this.peekT >= p.peekHold || !idle) this.peekT = -1;
    } else if (idle) {
      this.peekIn -= dt;
      if (this.peekIn <= 0) {
        this.peekT = 0;
        this.peekIn = nextPeek(Math.random());
      }
    }
    // 要露出多少、往哪看、举不举手
    let target = p.away;
    let look = 0;
    let raise = 0;
    let wave = 0;
    if (home && this.started) {
      if (this.act) target = this.act.reduced ? p.hide : p.act;
      else if (this.greetT >= 0) {
        const g = greetPose(this.greetT);
        target = g.out;
        raise = g.raise;
        wave = g.wave;
      } else if (this.near) {
        target = p.near;
        raise = 1;
      } else if (this.peekT >= 0) {
        const k = peekPose(this.peekT);
        target = k.out;
        look = k.look;
      } else target = p.hide;
    }
    let out: number;
    if (reduced) {
      // 减弱动效：不滑、不弹，直接在该在的地方
      this.out[0] = target;
      this.out[1] = 0;
      out = target;
    } else out = stepOut(this.out, target, dt);
    this.raise += (raise - this.raise) * (1 - Math.exp(-10 * dt));
    if (this.raise > 0.01) this.waveT += dt;
    else this.waveT = 0;
    if (this.near) wave = Math.sin(this.waveT * Math.PI * 2 * p.waveHz);
    // 姿态：吐券 / 摇头 + 悬停时轻轻一缩（同星球页）
    const pose = this.pose;
    if (a?.mode === 'spit') spitPose(Math.max(0, a.t), false, pose);
    else if (a?.mode === 'shake') shakePose(a.t, pose);
    else restPose(pose);
    if (a?.reduced) {
      pose.sy = 1;
      pose.sxz = 1;
      pose.lift = 0;
      pose.roll = 0;
      pose.pitch = 0;
      pose.jitter = 0;
      pose.yaw *= 0.4;
    }
    const h = stepHover(this.hoverSpring, this.hovering && !a ? 1 : 0, dt);
    if (h !== 0) {
      const k = COUPONS.hoverSquash * h;
      pose.sy *= 1 - k;
      pose.sxz *= 1 + k * 0.5;
    }
    this.logo?.(pose.glow * COUPONS.glow);
    this.placeModel(out, look, pose);
    // 挥手：画面里面那只（模型的 -X，面朝镜头时在画面左边）
    for (const arm of this.arms) {
      const up = arm.side === -1 ? this.raise * (2.25 + THREE.MathUtils.degToRad(p.swing) * wave) : 0;
      arm.pivot.rotation.z = arm.rest + arm.side * up;
    }
    if (this.hovering && !this.interactive()) this.setHover(false);
  }

  // 每帧按镜头摆：脚底藏在画面底边下面、身子从右边缘探进来，往画面里歪、正面转向画面中间
  private placeModel(out: number, look: number, pose: TribooPose): void {
    const p = HOME_TRIBOO;
    const cam = this.world.rig.camera;
    const size = this.world.homeShape === 'tall' ? p.sizeTall : p.size;
    const leanDeg = leanFor(out);
    const pl = placeTriboo(out, leanDeg, cam.aspect, cam.fov, size, p, this.place);
    const root = this.root;
    root.visible = out > -0.02;
    this.screen.visible = false;
    if (!root.visible) return;
    const H = pl.height;
    // 镜头坐标里：先往画面里歪（绕视线），再转身（绕身子的上方），再叠姿态（同站桩：YZX）
    _q.setFromAxisAngle(Z, THREE.MathUtils.degToRad(leanDeg));
    _q.multiply(_q2.setFromAxisAngle(Y, THREE.MathUtils.degToRad(-p.turn + look * p.look)));
    _e.set(pose.pitch, pose.yaw, pose.roll, 'YZX');
    _q.multiply(_q2.setFromEuler(_e));
    _up.copy(Y).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _p.set(pl.x, pl.y, pl.z).addScaledVector(_up, pose.lift * H).addScaledVector(_right, pose.jitter * H);
    root.position.copy(_p).applyMatrix4(cam.matrixWorld);
    root.quaternion.copy(cam.quaternion).multiply(_q);
    const k = H / this.modelHeight;
    const b = Math.sin((this.time / 3.4) * Math.PI * 2) * 0.02; // 呼吸
    root.scale.set(k * pose.sxz * (1 - b * 0.5), k * pose.sy * (1 + b), k * pose.sxz * (1 - b * 0.5));
    root.updateMatrixWorld(true);
    // 露出来那一块在画面上（CSS 像素）：自查脚本点它、判断指针靠不靠近
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const W = innerWidth;
    const Hpx = innerHeight;
    const cx = W / 2 + (pl.bodyX / (p.depth * tanH * cam.aspect)) * (W / 2);
    const cy = Hpx / 2 - (pl.bodyY / (p.depth * tanH)) * (Hpx / 2);
    const r = (pl.bodyR / (p.depth * tanH)) * (Hpx / 2);
    const left = Math.max(0, cx - r);
    const right = Math.min(W, cx + r);
    this.screen.visible = right - left > 8;
    this.screen.x = (left + right) / 2;
    this.screen.y = cy;
    this.screen.r = r;
    // 键盘的按钮跟着露出来的那一块（看不见，选中时有描边）
    const btn = this.button.style;
    btn.transform = `translate3d(${Math.round(left)}px, ${Math.round(cy - r)}px, 0)`;
    btn.width = `${Math.max(0, Math.round(right - left))}px`;
    btn.height = `${Math.round(r * 2)}px`;
  }

  // 自查脚本用
  debug(): NonNullable<ReturnType<HomeDebug['state']>['triboo']> {
    const home = this.home();
    const a = this.act;
    const phase: Phase = !home || !this.started ? 'away' : a ? a.mode : this.greetT >= 0 ? 'greet' : this.near ? 'near' : this.peekT >= 0 ? 'peek' : 'idle';
    const s = this.screen;
    return {
      ready: this.ready,
      shown: this.root.visible && s.visible,
      at: this.root.visible && s.visible && this.interactive() ? { x: Math.min(s.x, innerWidth - 12), y: s.y } : null,
      phase,
      hover: this.hovering,
      cooldown: this.coupons.cooldownLeft(),
    };
  }

  // 正在演点什么（打招呼、探头、靠近挥手、吐券、摇头）：云里的那只就先不冒出来
  get busy(): boolean {
    return this.greetT >= 0 || this.greetPending || this.peekT >= 0 || this.near || this.act !== null || this.hovering;
  }

  get greeting(): boolean {
    return this.greetT >= 0 || this.greetPending;
  }

  // 开场演完了（打过招呼，或者直接从星球页回到首页）：云里的那只从这时开始计时
  get opened(): boolean {
    return this.started && !this.greeting;
  }
}

// ?tune → Home → Triboo
function addTribooTune(folder: HomeTuneFolder): void {
  const f = folder.addFolder({ title: 'Triboo (right edge)', expanded: false });
  const list: Array<[keyof typeof HOME_TRIBOO, number, number, number, string]> = [
    ['size', 0.1, 0.6, 0.005, 'size (wide)'],
    ['sizeTall', 0.1, 0.5, 0.005, 'size (phone)'],
    ['feet', -1.6, 0, 0.01, 'feet (screen y)'],
    ['hide', -0.2, 1, 0.01, 'shows when hiding'],
    ['peek', 0, 1, 0.01, 'shows when peeking'],
    ['near', 0, 1.2, 0.01, 'shows when pointer near'],
    ['act', 0, 1.2, 0.01, 'shows when spitting'],
    ['greet', 0, 1.2, 0.01, 'shows when saying hi'],
    ['lean', 0, 45, 0.5, 'lean in°'],
    ['turn', 0, 70, 0.5, 'turn to center°'],
    ['reach', 50, 700, 5, 'pointer near px'],
    ['peekMin', 1, 30, 0.5, 'peek every min s'],
    ['peekMax', 1, 40, 0.5, 'peek every max s'],
    ['peekHold', 0.4, 5, 0.05, 'peek hold s'],
    ['look', 0, 45, 0.5, 'look around°'],
    ['waveHz', 0.3, 4, 0.05, 'wave speed'],
    ['swing', 0, 70, 0.5, 'wave swing°'],
    ['greetHold', 0.5, 6, 0.05, 'say hi s'],
    ['flight', 0.2, 2, 0.01, 'coupon flight s'],
    ['ticket', 0.05, 1, 0.01, 'coupon size at mouth'],
    ['spring', 10, 300, 1, 'slide spring'],
    ['damping', 1, 40, 0.5, 'slide damping'],
  ];
  for (const [key, min, max, step, label] of list) f.addBinding(HOME_TRIBOO, key, { min, max, step, label });
}

// main.ts 调一次（Coupons 之后）：首页右下角的翠宝；window.__home 里接上翠宝、开场、领券窗口的状态
export function installHomeTriboo(app: App, coupons: Coupons, debug: HomeDebug): HomeTriboo {
  const triboo = new HomeTriboo(app, coupons);
  debug.triboo = () => triboo.debug();
  debug.intro = () => triboo.greeting;
  debug.card = () => {
    const card = coupons.card;
    const shown = card.shown;
    return {
      open: card.open,
      shown: shown !== null,
      title: shown ? card.layer.querySelector('.cc-title')?.textContent ?? null : null,
      claim: card.mode === 'claim' ? CLAIM_URL : null,
    };
  };
  addHomeTuneExtra(addTribooTune);
  // 云里探头的那只（cloudPeek.ts）：星球不接指在它身上的那一下；它露头时右下角这只不探头
  const cloud = new CloudPeek(app, coupons, triboo);
  app.galaxyUi.blocker = (x, y) => triboo.hits(x, y) || cloud.hits(x, y);
  triboo.quiet = () => cloud.active;
  debug.cloud = () => cloud.debug();
  debug.peekCloud = () => cloud.peek(true);
  addHomeTuneExtra((f) => addCloudPeekTune(f, cloud));
  return triboo;
}


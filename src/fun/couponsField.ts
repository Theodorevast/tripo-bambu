import * as THREE from 'three/webgpu';
import type { CouponTicket } from '../data/coupons';
import { COUPONS, couponScale, flightAcross, flightArc, flipAngle, flutterWeight, lifeOpacity, pickupProgress } from './couponsMath';
import { CAPACITY, GlowDiscs, Sparks, TicketMesh } from './couponsFx';
import { smooth, span } from '../scenes/ease';

// 地上的券（coupons）：对象池（CAPACITY 个槽，开场建好），每张券在槽里走一遍
//   wait（排队等着从嘴里出来）→ fly（抛物线、翻转、快落地时左右飘）→ rest（浮在草上方，慢慢转、微微发光、偶尔闪一颗小星星）
//   → fade（没捡、到时间了：淡出）；或者 rest / fly 中被点了 → pickup（先往上一跳，再转着飞到镜头前）→ held（停在镜头前，等界面的卡片接手）
// 减弱动效时：appear（直接在落点淡入，不飞不翻）。
// 位置都是世界坐标（聚焦的星球不动）；落点贴地按星球的高度函数现算，镜头拉远、地标放大变了时重新贴地。每帧不新建对象

export type CouponPhase = 'free' | 'wait' | 'fly' | 'appear' | 'rest' | 'fade' | 'pickup' | 'held';

export interface CouponGround {
  home: THREE.Vector3; // 星球中心（世界坐标）
  scale: number; // 星球组的缩放
  radius(dir: THREE.Vector3): number; // 这个方向上地面（有海时不低于海面）离中心多远（星球本地）
}

export interface CouponAnchor {
  origin: THREE.Vector3; // 翠宝脚底（世界坐标）
  up: THREE.Vector3;
  fwd: THREE.Vector3; // 吐的方向（面朝）
  right: THREE.Vector3;
}

interface Slot {
  index: number;
  id: number;
  phase: CouponPhase;
  ticket: CouponTicket;
  t: number; // 进这个阶段以后多久了（wait：还要等多久）
  T: number; // 飞多久（pickup：飞向镜头用多久）
  origin: THREE.Vector3;
  up: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  start: THREE.Vector3; // 出口（嘴，世界坐标）
  lx: number; // 落点（翠宝脚下的坐标，原大时的米）
  lz: number;
  spawnHero: number; // 吐出来时的放大倍数：抛物线高度、飘的幅度按它
  hero: number; // 落点按哪个放大倍数贴的地
  land: THREE.Vector3; // 落点（含浮起的高度，世界坐标）
  ground: THREE.Vector3; // 落点正下方的地面
  normal: THREE.Vector3; // 那里的「上」
  yaw0: number; // 刚飞出去时绕「上」转了多少（之后转回正对前方）
  spinDir: number;
  phase0: number; // 飘动、发光的相位
  flips: number;
  restYaw: number; // 落地以后慢慢转到哪了
  nextTwinkle: number;
  highlight: number;
  hovered: boolean;
  pos: THREE.Vector3; // 这一帧的位置、朝向、大小（世界坐标；拾取、飞向镜头、卡片接手都用它）
  quat: THREE.Quaternion;
  size: number;
  opacity: number;
  from: THREE.Vector3; // pickup：从哪飞起
  fromQuat: THREE.Quaternion;
  fromSize: number;
  fromDist: number; // pickup：起飞时离镜头多远
  hop: THREE.Vector3;
  reduced: boolean;
}

export interface PickupTarget {
  pos: THREE.Vector3; // 镜头前的终点（世界坐标）
  quat: THREE.Quaternion; // 正对镜头
  size: number; // 那时的长边（米）
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _ndc = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class CouponField {
  readonly tickets: TicketMesh;
  readonly glows: GlowDiscs;
  readonly sparks: Sparks;
  readonly group = new THREE.Group();
  onArrive: ((id: number) => void) | null = null; // pickup 飞到镜头前了（卡片接手）
  private readonly slots: Slot[] = [];
  private nextId = 1;
  private clock = 0;
  private rand: () => number;

  // sceneDepth：场景缓冲的深度（券画在不调色的那一层时按它裁掉被挡住的部分，couponsFx.ts）
  constructor(atlas: HTMLCanvasElement, rand: () => number, sceneDepth: THREE.DepthTexture | null = null) {
    this.rand = rand;
    this.tickets = new TicketMesh(atlas, sceneDepth);
    this.glows = new GlowDiscs();
    this.sparks = new Sparks();
    this.group.name = 'coupons';
    this.group.add(this.glows.mesh, this.tickets.mesh, this.sparks.mesh);
    for (let i = 0; i < CAPACITY; i++) {
      this.slots.push({
        index: i, id: 0, phase: 'free', ticket: { kind: 0, code: '' }, t: 0, T: 1,
        origin: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), fwd: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0),
        start: new THREE.Vector3(), lx: 0, lz: 0, spawnHero: 1, hero: -1,
        land: new THREE.Vector3(), ground: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
        yaw0: 0, spinDir: 1, phase0: 0, flips: 2, restYaw: 0, nextTwinkle: 0, highlight: 0, hovered: false,
        pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0, opacity: 0,
        from: new THREE.Vector3(), fromQuat: new THREE.Quaternion(), fromSize: 0, fromDist: 1, hop: new THREE.Vector3(), reduced: false,
      });
    }
    this.syncVisible();
  }

  // 有券在场（飞、浮、淡出、被捡）
  get busy(): boolean {
    return this.slots.some((s) => s.phase !== 'free');
  }

  // 一次吐出几张：anchor 是翠宝脚下的坐标系，mouth 是出口（世界坐标），hero 是放大倍数。reduced：减弱动效（在落点淡入）
  spawn(tickets: CouponTicket[], anchor: CouponAnchor, mouth: THREE.Vector3, hero: number, spots: Array<{ x: number; z: number }>, reduced: boolean): number[] {
    const ids: number[] = [];
    tickets.forEach((ticket, i) => {
      const s = this.take();
      s.id = this.nextId++;
      s.ticket = ticket;
      s.reduced = reduced;
      s.phase = 'wait';
      s.t = i * (reduced ? 0.08 : COUPONS.stagger);
      s.T = COUPONS.flight * (0.88 + this.rand() * 0.24);
      s.origin.copy(anchor.origin);
      s.up.copy(anchor.up);
      s.fwd.copy(anchor.fwd);
      s.right.copy(anchor.right);
      s.start.copy(mouth);
      s.lx = spots[i].x;
      s.lz = spots[i].z;
      s.spawnHero = hero;
      s.hero = -1;
      s.yaw0 = Math.atan2(s.lx, s.lz) + (this.rand() - 0.5) * 1.2;
      s.spinDir = this.rand() < 0.5 ? -1 : 1;
      s.phase0 = this.rand() * Math.PI * 2;
      s.flips = COUPONS.flips + (this.rand() < 0.4 ? 1 : 0);
      s.restYaw = 0;
      s.nextTwinkle = 0.6 + this.rand() * 1.2;
      s.highlight = 0;
      s.hovered = false;
      s.opacity = 0;
      s.size = 0;
      ids.push(s.id);
    });
    this.syncVisible();
    return ids;
  }

  // 拿一个空槽；满了就收走最早落地的那张
  private take(): Slot {
    const free = this.slots.find((s) => s.phase === 'free');
    if (free) return free;
    let oldest: Slot | null = null;
    for (const s of this.slots) {
      if ((s.phase === 'rest' || s.phase === 'fade') && (!oldest || s.t > oldest.t)) oldest = s;
    }
    const s = oldest ?? this.slots[0];
    this.release(s);
    return s;
  }

  private release(s: Slot): void {
    s.phase = 'free';
    s.id = 0;
    s.hovered = false;
    this.tickets.hide(s.index);
    this.glows.hide(s.index);
  }

  clear(): void {
    for (const s of this.slots) this.release(s);
    this.sparks.clear();
    this.syncVisible();
  }

  find(id: number): Slot | null {
    return this.slots.find((s) => s.id === id && s.phase !== 'free') ?? null;
  }

  ticketOf(id: number): CouponTicket | null {
    return this.find(id)?.ticket ?? null;
  }

  // 被点了：从现在的位置飞向镜头（减弱动效时就地淡出）。camPos：镜头位置（飞的时候离镜头的距离按等比缩短）
  pickUp(id: number, camPos: THREE.Vector3): boolean {
    const s = this.find(id);
    if (!s || (s.phase !== 'rest' && s.phase !== 'fly' && s.phase !== 'appear')) return false;
    s.fromDist = s.pos.distanceTo(camPos);
    s.from.copy(s.pos);
    s.fromQuat.copy(s.quat);
    s.fromSize = s.size;
    s.hop.copy(s.normal.lengthSq() > 0 ? s.normal : s.up).multiplyScalar(0.55 * Math.max(1, s.spawnHero) * COUPONS.size);
    s.phase = 'pickup';
    s.t = 0;
    s.T = COUPONS.pickup;
    s.hovered = false;
    return true;
  }

  // 首页（H2，fun/couponsHome.ts）：一张券从翠宝嘴里出来，不落地，直接（先往 hop 那边拱一下）飞到镜头前、交给领券窗口。
  // from：嘴（世界坐标）；quat：刚出来时的朝向；size：刚出来时的长边；seconds：飞多久。走的是捡券那一段（pickup → held → onArrive）
  launchTo(ticket: CouponTicket, from: THREE.Vector3, quat: THREE.Quaternion, size: number, hop: THREE.Vector3, camPos: THREE.Vector3, seconds: number): number {
    const s = this.take();
    s.id = this.nextId++;
    s.ticket = ticket;
    s.reduced = false;
    s.phase = 'pickup';
    s.t = 0;
    s.T = Math.max(0.15, seconds);
    s.spawnHero = 1;
    s.hero = -1;
    s.pos.copy(from);
    s.from.copy(from);
    s.quat.copy(quat);
    s.fromQuat.copy(quat);
    s.size = size;
    s.fromSize = size;
    s.fromDist = from.distanceTo(camPos);
    s.hop.copy(hop);
    s.normal.set(0, 0, 0);
    s.phase0 = this.rand() * Math.PI * 2;
    s.highlight = 0;
    s.hovered = false;
    s.opacity = 1;
    this.syncVisible();
    return s.id;
  }

  // 卡片接手以后：停在镜头前的那张淡掉、收回池子
  drop(id: number): void {
    const s = this.find(id);
    if (s) this.release(s);
    this.syncVisible();
  }

  setHovered(id: number | null): void {
    for (const s of this.slots) s.hovered = s.id !== 0 && s.id === id;
  }

  // 屏幕上离 (x, y) 最近、在 radius 像素以内的券（能捡的：飞着的、浮着的）。visible(pos) 判断是不是被星球挡住
  pick(x: number, y: number, camera: THREE.Camera, rect: { left: number; top: number; width: number; height: number }, visible: (p: THREE.Vector3) => boolean): number | null {
    let best: Slot | null = null;
    let bestD = Infinity;
    const halfH = rect.height / 2;
    const proj = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5]; // 1 / tan(fov / 2)
    for (const s of this.slots) {
      if (s.phase !== 'rest' && s.phase !== 'fly' && s.phase !== 'appear') continue;
      if (s.phase === 'fly' && s.t < s.T * 0.2) continue;
      _ndc.copy(s.pos).project(camera);
      if (_ndc.z > 1) continue;
      const sx = rect.left + ((_ndc.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - _ndc.y) / 2) * rect.height;
      const dist = _a.copy(s.pos).applyMatrix4(camera.matrixWorldInverse).z;
      const px = dist < 0 ? ((s.size / 2) * proj * halfH) / -dist : 0;
      const r = Math.max(26, px * 0.85);
      const d = Math.hypot(x - sx, y - sy);
      if (d < r && d < bestD && visible(s.pos)) {
        bestD = d;
        best = s;
      }
    }
    return best ? best.id : null;
  }

  // 每帧：heroIn 是这一帧跟着作品地标的放大倍数，target(id) 给出飞向镜头的终点。
  // 按距离放大（F2）：每张券实际的放大倍数不小于「长边在画面上有 COUPONS.minScreen 个画面高」要的倍数，
  // 按翠宝脚下（同一次吐出的几张共用）离镜头多远算，落点、浮起的高度、大小一起按它放大（couponScale）
  update(dt: number, camera: THREE.Camera, ground: CouponGround | null, heroIn: number, target: (out: PickupTarget) => void, pickTarget: PickupTarget): void {
    this.clock += dt;
    const cam = camera as THREE.PerspectiveCamera;
    const tanH = cam.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) : 0;
    for (const s of this.slots) {
      if (s.phase === 'free') continue;
      if (!ground && s.phase !== 'pickup' && s.phase !== 'held') {
        this.release(s);
        continue;
      }
      const hero = couponScale(heroIn, s.origin.distanceTo(camera.position), tanH);
      if (ground && (s.hero < 0 || Math.abs(hero - s.hero) > 0.003 * hero)) this.reground(s, ground, hero);
      s.highlight += ((s.hovered ? 1 : 0) - s.highlight) * (1 - Math.exp(-14 * dt));
      switch (s.phase) {
        case 'wait':
          s.t -= dt;
          if (s.t <= 0) {
            s.phase = s.reduced ? 'appear' : 'fly';
            s.t = -s.t;
          }
          break;
        case 'fly':
          s.t += dt;
          if (s.t >= s.T) {
            s.phase = 'rest';
            s.t -= s.T;
          }
          break;
        case 'appear':
          s.t += dt;
          if (s.t >= 0.35) {
            s.phase = 'rest';
            s.t = 0;
          }
          break;
        case 'rest':
          s.t += dt;
          if (s.t >= COUPONS.life) s.phase = 'fade';
          break;
        case 'fade':
          s.t += dt;
          break;
        case 'pickup':
          s.t += dt;
          break;
        case 'held':
          s.t += dt;
          break;
      }
      this.pose(s, hero, target, pickTarget, camera.position);
      if ((s.phase === 'fade' && s.opacity <= 0.001) || (s.phase === 'held' && s.t > 0.2)) {
        this.release(s);
        continue;
      }
      if (s.phase === 'pickup' && s.t >= (s.reduced ? 0.25 : s.T)) {
        s.phase = 'held';
        s.t = 0;
        this.onArrive?.(s.id);
      }
      this.write(s, hero);
      // 浮着的券偶尔闪一颗小星星（减弱动效时不闪）
      if (s.phase === 'rest' && !s.reduced) {
        s.nextTwinkle -= dt;
        if (s.nextTwinkle <= 0) {
          s.nextTwinkle = 0.9 + this.rand() * 1.4;
          _d.copy(s.pos).addScaledVector(s.normal, (this.rand() - 0.2) * 0.2 * hero);
          this.sparks.twinkle(_d, s.normal, hero);
        }
      }
    }
    this.tickets.commit();
    this.glows.commit();
    this.sparks.update(dt, camera);
    this.syncVisible();
  }

  // 落点贴地：脚下坐标里的 (lx, lz) × 放大倍数 → 投到球面上，地面 + 浮起的高度
  private reground(s: Slot, g: CouponGround, hero: number): void {
    s.hero = hero;
    _a.copy(s.origin).addScaledVector(s.right, s.lx * hero).addScaledVector(s.fwd, s.lz * hero).sub(g.home);
    const dir = _a.normalize();
    const r = g.radius(dir) * g.scale;
    s.normal.copy(dir);
    s.ground.copy(g.home).addScaledVector(dir, r);
    s.land.copy(s.ground).addScaledVector(dir, COUPONS.hover * hero);
  }

  private pose(s: Slot, hero: number, target: (out: PickupTarget) => void, pickTarget: PickupTarget, camPos: THREE.Vector3): void {
    const size = COUPONS.size * hero;
    // 脚下坐标系的朝向（+Y 上，+Z 前）
    _a.crossVectors(s.up, s.fwd).normalize();
    _m.makeBasis(_a, s.up, s.fwd);
    _q.setFromRotationMatrix(_m);
    switch (s.phase) {
      case 'wait':
        s.opacity = 0;
        s.size = 0;
        s.pos.copy(s.start);
        break;
      case 'fly': {
        const u = Math.min(1, s.t / s.T);
        const H = s.spawnHero;
        const across = flightAcross(u);
        s.pos.copy(s.start).lerp(s.land, across).addScaledVector(s.up, COUPONS.arc * H * flightArc(u));
        // 快落地时左右飘（垂直于飞的方向）、像落叶一样晃
        const w = flutterWeight(u);
        const wave = Math.sin(s.t * Math.PI * 2 * 1.6 + s.phase0);
        _b.copy(s.land).sub(s.start);
        _c.crossVectors(s.up, _b);
        if (_c.lengthSq() > 1e-8) s.pos.addScaledVector(_c.normalize(), COUPONS.flutter * H * wave * w);
        const yaw = s.yaw0 * (1 - smooth(span(u, 0.1, 0.9)));
        const roll = 0.55 * Math.cos(s.t * Math.PI * 2 * 1.6 + s.phase0) * w;
        const flip = flipAngle(u, s.flips);
        _e.set(flip, yaw, roll, 'YZX');
        s.quat.copy(_q).multiply(_q2.setFromEuler(_e));
        s.size = size * Math.min(1, 0.35 + u * 4);
        s.opacity = Math.min(1, u * 8);
        break;
      }
      case 'appear':
      case 'rest':
      case 'fade': {
        const since = s.phase === 'appear' ? 1 : s.t + (s.reduced ? 1 : 0); // 减弱动效：淡入时已经正对镜头，接着浮就不再转一下
        // 浮着：上下轻轻起伏（刚落地时从 0 渐强，不跳）
        const env = smooth(span(since, 0, 0.8));
        s.pos.copy(s.land).addScaledVector(s.normal, COUPONS.bob * hero * Math.sin(since * Math.PI * 2 * 0.45 + s.phase0) * env);
        // 慢慢转：正对镜头（长边保持水平），绕地面的法线左右来回转（转速从 0 渐渐加上来）。
        // 星球视图里镜头从斜上方看，立着的券会只剩一条边；正对镜头时远看也认得出是一张券
        s.restYaw = s.spinDir * (COUPONS.spin / 0.9) * Math.sin(0.9 * (since - 0.6 * (1 - Math.exp(-since / 0.6))));
        _c.copy(camPos).sub(s.pos).normalize();
        _b.crossVectors(s.normal, _c);
        if (_b.lengthSq() < 1e-6) _b.copy(s.right);
        else _b.normalize();
        _a.crossVectors(_c, _b);
        _m.makeBasis(_b, _a, _c);
        _q2.setFromRotationMatrix(_m);
        _q3.setFromAxisAngle(s.normal, s.restYaw);
        _q2.premultiply(_q3);
        // 刚落地时从落下来的朝向转过去
        s.quat.copy(_q).slerp(_q2, smooth(span(since, 0, 0.6)));
        s.size = size;
        s.opacity = s.phase === 'appear' ? smooth(Math.min(1, s.t / 0.35)) : s.phase === 'fade' ? lifeOpacity(COUPONS.life + s.t) : 1;
        if (s.phase === 'fade') s.size = size * (0.7 + 0.3 * s.opacity);
        break;
      }
      case 'pickup': {
        target(pickTarget);
        if (s.reduced) {
          s.opacity = 1 - smooth(Math.min(1, s.t / 0.25));
          break;
        }
        const u = Math.min(1, s.t / s.T);
        const e = pickupProgress(u, s.fromDist, pickTarget.pos.distanceTo(camPos));
        // 二次贝塞尔：起点 → 起点上方 → 镜头前
        _b.copy(s.from).add(s.hop);
        const iu = 1 - e;
        s.pos.copy(s.from).multiplyScalar(iu * iu).addScaledVector(_b, 2 * iu * e).addScaledVector(pickTarget.pos, e * e);
        // 飞过去：从原来的朝向转到正对镜头，路上左右轻轻摆几下、越摆越小（不整圈转：转到侧面时只剩一条边，正在变大的时候看不清）
        s.quat.copy(s.fromQuat).slerp(pickTarget.quat, e).multiply(_q2.setFromAxisAngle(Y, 0.45 * Math.sin(u * Math.PI * 3) * (1 - u)));
        s.size = s.fromSize + (pickTarget.size - s.fromSize) * e;
        s.opacity = 1;
        break;
      }
      case 'held':
        // 卡片上的券已经叠在它上面了：跟着镜头停在原处，很快淡掉、收回池子
        target(pickTarget);
        s.pos.copy(pickTarget.pos);
        s.quat.copy(pickTarget.quat);
        s.size = pickTarget.size;
        s.opacity = 1 - smooth(span(s.t, 0.04, 0.18));
        break;
    }
  }

  private write(s: Slot, hero: number): void {
    const i = s.index;
    if (s.phase === 'wait' || s.opacity <= 0.001) {
      this.tickets.hide(i);
      this.glows.hide(i);
      return;
    }
    const grounded = s.phase === 'rest' || s.phase === 'appear' || s.phase === 'fade';
    const flying = s.phase === 'fly';
    const u = flying ? Math.min(1, s.t / s.T) : 1;
    const glow = grounded ? smooth(span(s.phase === 'rest' ? s.t : 1, 0, 0.6)) * s.opacity : s.phase === 'pickup' || s.phase === 'held' ? 0.6 : 0;
    const flutter = flying ? 0.035 * flutterWeight(u) * Math.max(1, s.spawnHero) : grounded ? 0.006 * hero : 0;
    const wavePhase = this.clock * (flying ? 11 : 2.2) + s.phase0;
    this.tickets.set(i, s.pos, s.quat, s.size, s.opacity, glow, flutter, wavePhase, s.ticket.kind, s.highlight, 1, s.phase0);
    // 脚下的暖光：落地前一点开始亮
    const glowK = grounded ? s.opacity : flying ? smooth(span(u, 0.6, 1)) : 0;
    if (glowK > 0.001) this.glows.set(i, s.ground, s.normal, 0.42 * hero * (1 + 0.25 * s.highlight), 0.32 * glowK * (1 + 0.6 * s.highlight));
    else this.glows.hide(i);
  }

  private syncVisible(): void {
    let any = false;
    let grounded = false;
    for (const s of this.slots) {
      if (s.phase === 'free' || s.phase === 'wait') continue;
      any = true;
      if (s.phase !== 'pickup' && s.phase !== 'held') grounded = true;
    }
    this.tickets.mesh.visible = any;
    this.glows.mesh.visible = grounded;
  }

  // 预编译用：全部显示（编译时跳过不可见的）
  showForCompile(on: boolean): void {
    this.tickets.mesh.visible = on;
    this.glows.mesh.visible = on;
    this.sparks.showForCompile(on);
    if (!on) this.syncVisible();
  }

  // 自查脚本用：每张券现在的阶段、种类、世界坐标
  snapshot(): Array<{ id: number; phase: CouponPhase; kind: number; code: string; pos: [number, number, number]; opacity: number; size: number }> {
    return this.slots.filter((s) => s.phase !== 'free').map((s) => ({ id: s.id, phase: s.phase, kind: s.ticket.kind, code: s.ticket.code, pos: [s.pos.x, s.pos.y, s.pos.z], opacity: s.opacity, size: s.size }));
  }
}

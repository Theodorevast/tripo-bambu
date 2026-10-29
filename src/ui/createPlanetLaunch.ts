import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Team } from '../data/types';
import { PlanetObject } from '../planet/planetObject';
import type { PlanetEntry, World } from '../scenes/world';
import { BURST, BurstFx, rumble, Shake, whoosh } from './createPlanetBurst';
import { reducedMotion } from './motion';

// 「Launch」以后的 3D 部分（P3）：星球从云里冲出来。五段（时长在 ?tune → Create，表在 createPlanetBurst.ts 的 BURST）：
// 1. 对准落点：窗口收起，镜头转到看得清落点的角度（略往下看），落点下面的云面也在画面里
// 2. 蓄力：落点下面的云鼓起来、发光、打旋（漩涡），低沉的隆隆声，镜头轻轻抖
// 3. 冲出来：星球从云里高速冲上来（竖着拉长、转着），拖着云尾巴和星尘；云面上炸开一圈冲击环、四周的云被推开；
//    镜头震一下（trauma²，不是随机乱抖），配一声「呼——」（Web Audio 现场合成；点 Launch 那一下算用户交互）
// 4. 落定：冲过头一点再回弹到位，压扁一下再弹回；名牌弹出来（首页的名牌，悬停样子），周围飘几颗星星彩纸
// 5. 收尾：停一拍让大家看清楚，然后回首页、停在新星球上（默认），或者照常穿云进这颗星球（BURST.after = 1）
// 落点只从首页的版式拿（H2 的 addPlanet / setYou 给的 entry.home，是活的：版式重排时跟着变），这里不改版式。
// - 先接管镜头（rig.drive，停在原地）再 App.addTeam：首页加星球时自己会把镜头飞到新的取景，接管着就不飞
// - 星球的位置在镜头接管的回调里摆（World 的首页系数之前）；竖着拉长 / 压扁、多转的角度在 frameHooks 里乘上去（首页的系数之后），
//   下一帧开头先除掉：首页的大小系数（homeBase × 悬停 × 回弹）照常起作用
// - 云海不写深度：沉在云下面的星球，它的半透明部件会透过云海画出来，冲出云面之前藏起来
// 减弱动效：一层云色的幕淡入、星球在幕后面到位、幕淡出（不飞、不冲、不抖）

const _v = new THREE.Vector3();

const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export function easeOutBack(t: number, c1: number): number {
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

// 等主画面走过 seconds 秒（World 的 dt：跟着转场调试的时间流速、逐帧录屏走；标签页在后台时不走）
export function worldDelay(world: World, seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let t = 0;
    const hook = (dt: number) => {
      t += dt;
      if (t < seconds) return;
      world.frameHooks.delete(hook);
      resolve();
    };
    world.frameHooks.add(hook);
  });
}

// 云海平均的云顶高度（世界 y）：星球在云海上投影子的那一层（atmosphere.seaTop）
export function cloudTopY(world: World): number {
  return world.atmosphere.seaTop;
}

// —— Launch 之前先备好新星球的着色器 ——
// 新星球的大部分着色器和星系里同一种预设的星球一样（开场就编好了），只有大气外壳、小浮岛的着色器里写死了种子、团队色，
// 是这颗星球独有的：Launch 时才编、才第一次画，WebGL2（ANGLE）上那一帧要停 30–70 ms。
// 所以样子定下来以后（进第三步时），在主画面的渲染器里按同样的配方、颜色建一颗「替身」，在后台编好、先画一次（GatedStager.precompile）。
// 管线按着色器代码共用（WebGL2 的 getRenderCacheKey 是空的，WebGPU 的只看渲染状态）：Launch 时真的那颗星球直接用现成的管线。
// 替身不挂进场景；真的星球画上以后才放掉（放早了管线的引用数归零，跟着被删）
export interface TwinLook {
  preset: PlanetObject['currentRecipe']['preset'];
  seed: number;
  ring: boolean;
  color: string;
}

export class LaunchWarmer {
  private readonly world: World;
  private twin: { key: string; planet: PlanetObject; ready: Promise<void> } | null = null;
  private readonly spent: PlanetObject[] = []; // 样子又改了、换下来的替身：Launch 以后一起放掉
  readonly stats = { builds: 0, warmMs: [] as number[] };
  private readyKey: string | null = null; // 哪个样子的替身已经备好了

  constructor(world: World) {
    this.world = world;
  }

  warm(look: TwinLook): Promise<void> {
    const key = [look.preset, look.seed, look.ring ? 1 : 0, look.color].join('|');
    if (this.twin?.key === key) return this.twin.ready;
    if (this.twin) this.spent.push(this.twin.planet);
    const planet = new PlanetObject({ seed: look.seed, preset: look.preset, ring: look.ring, atmosphere: true, placements: [] }, look.color, false);
    // 云海上的影子平时第一帧才建（updatePlanetLook）：先建出来，一起编（藏着的东西 compileAsync 会跳过，编的时候都显示出来）
    planet.look.placeShadow(null, this.world.light.sunDir);
    const hidden: THREE.Object3D[] = [];
    planet.group.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    const t0 = performance.now();
    this.stats.builds++;
    const ready = this.world.stage.precompile(planet.group).catch((err: unknown) => console.warn('twin precompile failed', err)).then(() => {
      for (const o of hidden) o.visible = false;
      this.stats.warmMs.push(Math.round(performance.now() - t0));
      this.readyKey = key;
    });
    this.twin = { key, planet, ready };
    return ready;
  }

  // 现在这个样子的替身已经备好（自查脚本、Launch 前看）
  get ready(): boolean {
    return this.twin !== null && this.readyKey === this.twin.key;
  }

  // 真的星球已经画上了：替身一颗一颗放掉（只放它自己的几何、材质；和星系里别的星球共用的不动）
  release(): void {
    const all = [...this.spent, ...(this.twin ? [this.twin.planet] : [])];
    this.spent.length = 0;
    this.twin = null;
    const keep = new Set<unknown>();
    for (const e of this.world.planets.values()) {
      e.planet.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        keep.add(mesh.geometry);
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) keep.add(m);
      });
    }
    const next = () => {
      const p = all.shift();
      if (!p) return;
      disposeOwn(p, keep);
      setTimeout(next, 100);
    };
    next();
  }
}

// 放掉一颗不再用的星球自己的东西：远看部件（从全局列表摘掉）、地表、水面……keep 里的（别的星球也在用的）不动
export function disposeOwn(planet: PlanetObject, keep: Set<unknown>): void {
  const meshes: THREE.Mesh[] = [];
  planet.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  planet.look.dispose();
  for (const mesh of meshes) {
    if (mesh.geometry && !keep.has(mesh.geometry)) mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m && !keep.has(m)) m.dispose();
  }
}

// —— 冲出来 ——
export interface LaunchState {
  phase: 'wait' | 'aim' | 'charge' | 'burst' | 'settle' | 'hold' | 'home' | 'enter';
  t: number;
}

// 加星球、星球从云里冲出来、落定，然后回首页停在它上面（或者照常进这颗星球，BURST.after）。
// 返回的 Promise 在收尾开始时 resolve。fx：开窗口时预编译好的特效；hold：等它 resolve 了镜头才开始动（窗口收起的动画）
export async function riseIntoGalaxy(app: App, team: Team, fx: BurstFx | null, state: LaunchState, hold: Promise<unknown> = Promise.resolve()): Promise<void> {
  const world = app.world;
  app.galaxyUi.setEnabled(false);
  // 先把镜头停在原地（接管）：首页加星球时看到镜头被接管，就不自己飞到新的取景
  const rig = world.rig;
  rig.controls.enabled = false; // 接管期间手动转动不累积，交还时镜头不跳
  rig.drive = () => {};
  const show = !reducedMotion() && fx !== null;
  // 有冲出来的演出时：先不成为「你的星球」，蓄力时才让（原来的你的星球那时滑开，把中间空出来，是演出的一部分）
  app.addTeam(team, !show);
  const entry = world.planets.get(team.id);
  const release = () => {
    rig.drive = null;
    rig.controls.enabled = true;
  };
  if (!show || !entry || !fx) {
    if (!show && entry && app.you.teamId !== team.id) app.claimYou(team.id);
    // 减弱动效：云色的幕淡入，星球在幕后面编好、到位，镜头直接跳到收尾的取景，幕淡出
    const veil = fadeVeil();
    await veil.cover();
    if (entry) await world.stage.precompile(entry.planet.group).catch(() => {});
    await hold;
    release();
    if (BURST.after >= 0.5) {
      state.phase = 'enter';
      app.navigate({ view: 'planet', teamId: team.id }, { replace: true });
    } else {
      state.phase = 'home';
      rig.jump(world.homeFraming());
      app.navigate({ view: 'galaxy' }, { replace: true });
    }
    await veil.uncover();
    return;
  }
  await new Promise<void>((resolve) => new BurstShow(app, entry, fx, state, hold, () => app.claimYou(team.id), resolve).start());
  if (BURST.after >= 0.5) {
    state.phase = 'enter';
    app.navigate({ view: 'planet', teamId: team.id }, { replace: true });
  } else {
    // 回首页：镜头从近景慢慢退回首页的取景，新星球在正中（你的星球），名牌照常弹出来
    state.phase = 'home';
    void rig.fly(world.homeFraming(), 1.5);
    app.navigate({ view: 'galaxy' }, { replace: true });
  }
}

// ?tune → Create → Replay：「你的星球」在首页上再冲出来一次（调手感用；不改数据）。不在首页、正在转场时不放
export async function replayBurst(app: App, fx: BurstFx, state: LaunchState): Promise<boolean> {
  const world = app.world;
  const entry = world.planets.get(app.you.teamId);
  if (!entry || world.focused || world.director.busy || world.rig.drive || world.rig.flying || reducedMotion()) return false;
  await fx.prepare(world);
  app.galaxyUi.setEnabled(false);
  world.rig.controls.enabled = false;
  await new Promise<void>((resolve) => new BurstShow(app, entry, fx, state, Promise.resolve(), null, resolve).start());
  state.phase = 'home';
  await world.rig.fly(world.homeFraming(), 1.5);
  return true;
}

// 减弱动效用的幕：一层云色的 DOM，淡入、淡出
function fadeVeil(): { cover(): Promise<void>; uncover(): Promise<void> } {
  const el = document.createElement('div');
  el.className = 'cp-veil';
  document.querySelector('#app')?.append(el);
  const run = (from: number, to: number, ms: number) => new Promise<void>((resolve) => {
    const a = el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
    a.finished.then(() => resolve(), () => resolve());
  });
  return {
    cover: () => run(0, 1, 260),
    uncover: () => run(1, 0, 420).then(() => el.remove()),
  };
}

class BurstShow {
  private readonly app: App;
  private readonly world: World;
  private readonly entry: PlanetEntry;
  private readonly fx: BurstFx;
  private readonly state: LaunchState;
  private readonly done: () => void;
  private claim: (() => void) | null; // 蓄力开始时调：新星球成为你的星球，原来的那颗滑开（Replay 时没有）
  private readonly shake = new Shake();
  private readonly fromPos = new THREE.Vector3();
  private readonly fromAim = new THREE.Vector3();
  private readonly landing = new THREE.Vector3(); // 落点：首页版式给的位置（你的星球的那一格）
  private readonly emerge = new THREE.Vector3(); // 云顶上、落点正下方：星球从这里冲出来
  private readonly chargePos = new THREE.Vector3(); // 蓄力时的机位：落点和下面的云面都在画面里，周围看得到一部分星系
  private readonly chargeAim = new THREE.Vector3();
  private readonly endPos = new THREE.Vector3(); // 落定时的机位：落点在画面中间略偏下
  private readonly endAim = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly want = new THREE.Vector3(); // 这一帧星球该在哪（frameHooks 里摆：首页的 glide 之后）
  private readonly hiddenParts: THREE.Object3D[] = [];
  private readonly squash = new THREE.Vector3(1, 1, 1); // 这一帧要乘上的拉长 / 压扁
  private readonly applied = new THREE.Vector3(1, 1, 1); // 上一帧乘上去的（下一帧开头先除掉）
  private spin = 0; // 这一帧多转的角度
  private R: number; // 星球在首页里看起来多大（半径 × 落点那一格的大小）：机位、冲多高、特效都按它
  private readonly top: number;
  private holding = true;
  private planned = false;
  private t = 0;
  private chargeAt = -1; // 蓄力开始的时刻（镜头对准、星球编好以后）
  private burstAt = -1; // 冲出来的时刻（蓄满、原来的你的星球也让开以后）
  private compiled = false;
  private revealed = false;
  private settled = false;
  private readonly post = () => this.afterHome();

  constructor(app: App, entry: PlanetEntry, fx: BurstFx, state: LaunchState, hold: Promise<unknown>, claim: (() => void) | null, done: () => void) {
    this.app = app;
    this.world = app.world;
    this.entry = entry;
    this.fx = fx;
    this.state = state;
    this.claim = claim;
    this.done = done;
    this.R = entry.planet.radius;
    this.top = cloudTopY(this.world);
    void hold.then(() => { this.holding = false; }, () => { this.holding = false; });
    entry.planet.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.transparent && o.visible) this.hiddenParts.push(o);
    });
  }

  start(): void {
    this.state.phase = 'wait';
    this.want.set(this.entry.home.x, this.top - (BURST.sink + 2) * this.R, this.entry.home.z);
    this.world.rig.drive = (dt) => this.step(dt);
    this.world.frameHooks.add(this.post);
    void this.world.stage.precompile(this.entry.planet.group).catch(() => {}).then(() => { this.compiled = true; });
  }

  // 落点：还没让（claim 还在）时是现在「你的星球」那一格（版式里你的位置不跟着是哪个团队变），让了以后是新星球自己的那一格。
  // 都是首页版式给的（World.slotOf），这里不算位置
  private landingSpot(out: THREE.Vector3): THREE.Vector3 {
    const world = this.world;
    const owner = this.claim ? world.planets.get(this.app.you.teamId) ?? this.entry : this.entry;
    const slot = world.slotOf(owner);
    return slot ? out.set(...slot.pos) : out.copy(owner.home);
  }

  // 机位按落点现算：从现在看过来的水平方向，往下看 BURST.elevation 度
  private plan(): void {
    const cam = this.world.rig.camera;
    const R = this.R;
    this.fromPos.copy(cam.position);
    const reach = Math.max(1, cam.position.distanceTo(this.world.rig.controls.target));
    this.fromAim.copy(cam.getWorldDirection(_v)).multiplyScalar(reach).add(cam.position);
    this.landingSpot(this.landing);
    const owner = this.world.planets.get(this.app.you.teamId) ?? this.entry;
    this.R = this.entry.planet.radius * (this.world.slotOf(owner)?.scale ?? 1);
    this.side.copy(cam.position).sub(this.landing).setY(0);
    if (this.side.lengthSq() < 1e-6) this.side.set(0, 0, 1);
    this.side.normalize();
    this.aimAt(this.landing);
    this.fx.begin(this.world, this.emerge, R);
    this.planned = true;
  }

  // 按落点定机位（落点挪了也调：只改蓄力以后的机位、特效的位置）
  private aimAt(landing: THREE.Vector3): void {
    const R = this.R;
    const el = THREE.MathUtils.degToRad(BURST.elevation);
    const D = BURST.distance * R;
    this.emerge.set(landing.x, this.top, landing.z);
    // 蓄力：看落点和云面之间（偏落点）——云面上的漩涡、落点、原来在那儿的你的星球都在画面里
    this.chargeAim.copy(this.emerge).lerp(landing, 0.55);
    this.chargePos.copy(this.chargeAim).addScaledVector(this.side, D * Math.cos(el));
    this.chargePos.y += D * Math.sin(el);
    // 落定：看落点上面一点（落点在画面中间略偏下），稍微推近
    this.endAim.copy(landing);
    this.endAim.y += 0.45 * R;
    this.endPos.copy(this.endAim).addScaledVector(this.side, D * 0.9 * Math.cos(el));
    this.endPos.y = this.endAim.y + D * 0.9 * Math.sin(el);
  }

  // 首页的版式不在挪了（原来的你的星球让开了）：除了新星球自己，每颗都到了自己那一格
  private layoutSettled(): boolean {
    const eps = (0.03 * this.R) ** 2;
    for (const e of this.world.planets.values()) {
      if (e === this.entry) continue;
      const slot = this.world.slotOf(e);
      if (slot && e.home.distanceToSquared(_v.set(...slot.pos)) > eps) return false;
    }
    return true;
  }

  private step(dt: number): void {
    const R = this.R;
    const cam = this.world.rig.camera;
    this.squash.set(1, 1, 1);
    this.spin = 0;
    if (this.holding) return; // 窗口还在收：镜头不动，星球藏在云下面
    if (!this.planned) this.plan();
    this.t += dt;
    const A = BURST.aim;
    const C = BURST.charge;
    const B = BURST.burst;
    const S = BURST.settle;
    const startY = this.top - BURST.sink * R;
    // 蓄力开始：镜头对准了、星球也编好了。这时让出你的位置：原来的你的星球滑开
    if (this.chargeAt < 0 && this.compiled && this.t >= A) {
      this.chargeAt = this.t;
      if (this.claim) {
        this.claim();
        this.claim = null;
        // 让了以后落点按新星球自己那一格（一般就是原来那一格；版式不一样时特效、机位跟过去）
        const spot = this.landingSpot(_v);
        if (spot.distanceToSquared(this.landing) > (0.05 * R) ** 2) {
          this.landing.copy(spot);
          this.aimAt(this.landing);
          this.fx.moveTo(this.emerge);
        }
      }
      rumble(Math.max(C, 0.9) + 0.1);
    }
    // 冲出来：蓄满了，原来的你的星球也让开了
    if (this.burstAt < 0 && this.chargeAt >= 0 && this.t - this.chargeAt >= C && this.layoutSettled()) this.burstAt = this.t;
    let y = startY;
    if (this.burstAt < 0) {
      const kc = this.chargeAt >= 0 ? Math.min(1, (this.t - this.chargeAt) / C) : 0;
      this.state.phase = this.chargeAt < 0 ? (this.t < A ? 'aim' : 'wait') : 'charge';
      this.fx.setCharge(kc);
      this.shake.floor(0.32 * kc);
    } else {
      const tb = this.t - this.burstAt;
      if (this.state.phase === 'charge' || this.state.phase === 'aim' || this.state.phase === 'wait') {
        this.fx.setCharge(0);
        this.fx.blast();
        whoosh();
        this.shake.add(0.85);
      }
      const L = this.landing;
      const top = L.y + BURST.overshoot * R;
      if (tb < B) {
        // 冲上来：一开始最快（缓出），竖着拉长，转着
        const k = tb / B;
        y = startY + (top - startY) * easeOutCubic(k);
        const st = BURST.stretch * (1 - k * 0.6);
        this.squash.set(1 / Math.sqrt(1 + st), 1 + st, 1 / Math.sqrt(1 + st));
        this.spin = BURST.spin * (1 - easeOutCubic(k) * 0.35);
        this.state.phase = 'burst';
        // 云尾巴、星尘
        if (y > this.top - R) {
          _v.set(L.x, y - R * 0.95, L.z);
          this.fx.tail(_v);
          this.fx.tail(_v);
          _v.set(L.x, y, L.z);
          this.fx.dust(_v, R, 2);
        }
      } else {
        // 落定：从冲过头的高度回落到位（阻尼弹簧），落到底时压扁一下再弹回
        const u = tb - B;
        const o = Math.exp(-5.2 * u) * Math.cos(9.5 * u);
        y = L.y + BURST.overshoot * R * o;
        const sq = BURST.squash * Math.exp(-5.5 * u) * Math.sin(14 * u + 0.4);
        this.squash.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
        this.spin = BURST.spin * 0.65 * Math.exp(-6 * u);
        if (!this.settled) {
          this.settled = true;
          this.fx.confetti(L, R);
          // 名牌弹出来：首页的名牌（开着、悬停这一颗：它的名牌放大弹出来，星球慢慢转）
          this.app.galaxyUi.setEnabled(true);
          this.world.setHover(this.entry);
        }
        this.state.phase = u < S ? 'settle' : 'hold';
        if (u >= S + BURST.hold && !this.fx.busy) {
          this.finish();
          return;
        }
      }
    }
    this.want.set(this.landing.x, y, this.landing.z);
    // 冲出云面：半透明的部件放出来，大气光晕慢慢加回来
    if (!this.revealed && y > this.top) {
      this.revealed = true;
      for (const o of this.hiddenParts) o.visible = true;
    }
    if (this.revealed) this.entry.planet.setHaloStrength(Math.min(1, (y - this.top) / (1.5 * R)));
    // —— 镜头 ——
    const ka = Math.min(1, this.t / A);
    const ea = easeInOutCubic(ka);
    cam.position.lerpVectors(this.fromPos, this.chargePos, ea);
    this.aim.lerpVectors(this.fromAim, this.chargeAim, ea);
    if (this.burstAt >= 0) {
      // 冲出来以后：视线跟着星球往上，机位慢慢推到落定的位置
      const tb = this.t - this.burstAt;
      const kf = smooth(Math.min(1, tb / (B + 0.35)));
      cam.position.lerp(this.endPos, smooth(Math.min(1, tb / (B + S))));
      _v.set(this.landing.x, Math.max(y, this.top) + 0.45 * R, this.landing.z);
      this.aim.lerp(_v, kf);
      this.aim.lerp(this.endAim, smooth(Math.min(1, Math.max(0, tb - B) / S)));
    }
    cam.lookAt(this.aim);
    this.shake.apply(cam, dt, BURST.shake);
    this.fx.tick(dt, cam);
    this.state.t = this.t;
  }

  // 首页的系数、版式的挪动（stepHome、stepGlide）之后：摆好这一帧的位置，乘上拉长 / 压扁、多转的角度；
  // 下一帧开头先除掉（首页的系数照常除、乘）
  private afterHome(): void {
    const g = this.entry.planet.group;
    g.scale.divide(this.applied);
    g.position.copy(this.want);
    if (!this.revealed) {
      for (const o of this.hiddenParts) o.visible = false;
      this.entry.planet.setHaloStrength(0);
    }
    this.applied.copy(this.squash);
    g.scale.multiply(this.applied);
    if (this.spin !== 0) g.rotation.y += this.spin;
  }

  private finish(): void {
    const rig = this.world.rig;
    this.world.frameHooks.delete(this.post);
    const g = this.entry.planet.group;
    g.scale.divide(this.applied);
    this.applied.set(1, 1, 1);
    g.position.copy(this.entry.home);
    for (const o of this.hiddenParts) o.visible = true;
    this.entry.planet.setHaloStrength(1);
    this.fx.stop();
    rig.drive = null;
    rig.controls.enabled = true;
    // 交还镜头：环绕中心放在现在看的那一点、不限远近，update 时镜头不动；之后飞回首页（或穿云进星球）从这里起飞
    const cam = rig.camera;
    rig.jump({ target: this.aim.clone(), position: cam.position.clone(), minDistance: 0, maxDistance: Infinity, autoRotate: false, fov: cam.fov });
    this.done();
  }
}

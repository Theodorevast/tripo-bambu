import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Team } from '../data/types';
import { blendPalette, clonePalette, PRESETS, RAIN_MIX, RAIN_PALETTE } from '../nature/atmosphere';
import { PlanetObject } from '../planet/planetObject';
import type { PlanetEntry, World } from '../scenes/world';
import { reducedMotion } from './motion';

// 「Launch」以后的 3D 部分（P3）：新星球从云海里升起来、飞进星系里它的位置（首页版式给的「你的星球」那一格），
// 镜头跟过去，最后照常穿云进这颗星球。
// - 先接管镜头（rig.drive，停在原地）再 App.addTeam：首页加星球时自己会把镜头飞到新的取景，接管着就不飞，镜头归这里管。
//   addTeam → World.addPlanet 马上登记、在后台编着色器（编好才挂进场景、版式重排时别的星球慢慢挪开），新星球成了「你的星球」
// - 星球的位置每帧在这里摆（镜头接管的回调里，World 的首页系数之前）：先沉在云海下面，升起来时沿一条弧线从旁边、稍后面
//   飞进自己那一格，冲过头一点再落回。大小、朝向归首页（H2 的 PlanetMotion：放大、转、回弹），这里只借它的公开接口：
//   冒出来以后 setHover（慢慢转、放大一点），快到位时 pressPlanet 按下、到位松开（回弹一下）
// - 云海不写深度：沉在云下面的星球，它的半透明部件（大气外壳、云层、水面）会透过云海画出来，所以露头之前藏起来，
//   中心出了云顶再放出来，大气光晕从 0 慢慢加回来
// - 冒出来的那一刻，云顶上一圈云团往外翻开（CloudBurst：朝向镜头的软边面片，颜色取当前天空预设的云色；开窗口时就预编译好）
// - 最后交还 OrbitControls、摆在同一个位置，App 照常导航进星球（director 的穿云转场从这里起飞）
// 减弱动效：不飞、不升，编好以后星球直接在位置上，导航进星球时转场自己换成淡入淡出

export const LAUNCH = {
  approach: 1.35, // 镜头从星系全景飘到新位置
  rise: 1.85, // 从云里飞到位置上
  settle: 0.45, // 到位以后停一下再进星球
  distance: 6.2, // 镜头离新位置几个半径（到位时）
  elevation: 0.3, // 镜头在新位置上方多高（弧度）
  sink: 1.35, // 起点：星球中心在云顶以下几个半径
  side: 1.6, // 起点在新位置旁边多远（× 半径，横着）
  back: 0.9, // 起点在新位置后面多远（× 半径，离镜头远的那边）
  overshoot: 1.15, // 到位时冲过头的强度（easeOutBack）
  puffs: 14,
};

type V3 = THREE.Vector3;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export function easeOutBack(t: number, c1: number): number {
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

// 二次贝塞尔：u 可以超过 1（冲过头时沿终点的切线往前走一点）
export function bezier(out: V3, a: V3, c: V3, b: V3, u: number): V3 {
  const k = 1 - u;
  return out.set(k * k * a.x + 2 * u * k * c.x + u * u * b.x, k * k * a.y + 2 * u * k * c.y + u * u * b.y, k * k * a.z + 2 * u * k * c.z + u * u * b.z);
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

// —— 冒出来时翻开的一圈云团 ——
// 每团一个面片，各自一份材质（克隆：着色器一样，编译一次；各自的不透明度是 uniform）。每帧转到正对镜头
export class CloudBurst {
  readonly group = new THREE.Group();
  private readonly puffs: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; a: number; r0: number; r1: number; y0: number; y1: number; s0: number; s1: number; life: number; delay: number }> = [];
  private t = -1;
  private readonly texture: THREE.Texture;

  constructor(count = LAUNCH.puffs) {
    this.group.name = 'create-cloud-burst';
    this.texture = puffTexture();
    const geo = new THREE.PlaneGeometry(1, 1);
    const base = new THREE.MeshBasicNodeMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: false });
    base.name = 'create-puff';
    for (let i = 0; i < count; i++) {
      const mat = base.clone();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -7; // 云海（-10）、云上的影子（-8）之后
      this.group.add(mesh);
      const j = Math.sin(i * 12.9898) * 43758.5453;
      const rnd = j - Math.floor(j);
      this.puffs.push({
        mesh, mat,
        a: (i / count) * Math.PI * 2 + rnd * 0.4,
        r0: 0.7 + 0.25 * rnd, r1: 1.45 + 0.6 * ((rnd * 7.3) % 1),
        y0: -0.08, y1: 0.22 + 0.35 * ((rnd * 3.1) % 1),
        s0: 0.42 + 0.2 * rnd, s1: 0.75 + 0.35 * ((rnd * 5.7) % 1),
        life: 1.25 + 0.5 * ((rnd * 9.1) % 1),
        delay: 0.12 * ((rnd * 2.3) % 1),
      });
    }
    this.group.visible = false;
  }

  // 开窗口时调：挂进主场景前在后台编好（GatedStager.precompile），Launch 时第一次画不卡
  prepare(world: World): Promise<void> {
    this.group.visible = true;
    return world.stage.precompile(this.group).finally(() => { this.group.visible = false; });
  }

  // 在 at（云顶上、星球冒出来的地方）翻开；R：星球半径
  play(world: World, at: V3, R: number): void {
    const atm = world.atmosphere;
    const pal = clonePalette(PRESETS[atm.preset]);
    blendPalette(pal, PRESETS[atm.preset], RAIN_PALETTE, atm.rain * RAIN_MIX);
    this.puffs.forEach((p, i) => {
      // 亮面和中间调之间：一团团深浅不一，和云海的颜色接得上
      p.mat.color.copy(pal.cloudMid).lerp(pal.cloudLit, 0.55 + 0.35 * ((i * 0.37) % 1)).multiplyScalar(0.82);
      p.mesh.scale.setScalar(0.001);
    });
    this.group.position.copy(at);
    this.group.scale.setScalar(R);
    this.group.visible = true;
    if (!this.group.parent) world.scene.add(this.group);
    this.t = 0;
  }

  get playing(): boolean {
    return this.t >= 0;
  }

  // 每帧：往外翻、往上飘、慢慢变大，最后淡掉；camera 用来转到正对镜头
  tick(dt: number, camera: THREE.Camera): void {
    if (this.t < 0) return;
    this.t += dt;
    let alive = false;
    camera.getWorldQuaternion(_q);
    for (const p of this.puffs) {
      const k = Math.max(0, Math.min(1, (this.t - p.delay) / p.life));
      if (k < 1) alive = true;
      const e = easeOutCubic(k);
      const r = p.r0 + (p.r1 - p.r0) * e;
      p.mesh.position.set(Math.cos(p.a) * r, p.y0 + (p.y1 - p.y0) * e, Math.sin(p.a) * r);
      p.mesh.scale.setScalar(Math.max(0.001, p.s0 + (p.s1 - p.s0) * e));
      p.mesh.quaternion.copy(_q);
      p.mat.opacity = k <= 0 ? 0 : Math.min(1, k / 0.08) * (1 - smooth(Math.max(0, (k - 0.45) / 0.55))) * 0.95;
    }
    if (!alive) this.stop();
  }

  stop(): void {
    this.t = -1;
    this.group.visible = false;
    this.group.removeFromParent();
  }
}

// 一团软边的积云：几个重叠的圆，边缘柔和（画在小画布上，当贴图用）
function puffTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const blob = (x: number, y: number, r: number, a: number) => {
      const grad = g.createRadialGradient(x, y, r * 0.15, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.75})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    blob(64, 72, 46, 0.9);
    blob(42, 66, 30, 0.85);
    blob(86, 64, 32, 0.85);
    blob(62, 48, 30, 0.8);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// —— 升起来 ——
export interface LaunchState {
  phase: 'wait' | 'approach' | 'rise' | 'settle' | 'enter';
  t: number;
}

// 加星球、星球冒出来、镜头跟过去，然后导航进这颗星球。返回的 Promise 在导航发出去时 resolve（进星球的转场由 App 照常排队处理）。
// burst：开窗口时预编译好的云团（没有就不翻云）；hold：等它 resolve 了镜头才开始飘（窗口收起的动画）
export async function riseIntoGalaxy(app: App, team: Team, burst: CloudBurst | null, state: LaunchState, hold: Promise<unknown> = Promise.resolve()): Promise<void> {
  const world = app.world;
  app.galaxyUi.setEnabled(false);
  const enter = () => {
    state.phase = 'enter';
    app.navigate({ view: 'planet', teamId: team.id }, { replace: true });
  };
  if (reducedMotion()) {
    app.addTeam(team);
    const entry = world.planets.get(team.id);
    // 编好就在位置上（addPlanet 编好时挂上；这里排在它后面，resolve 时已经挂好了）
    if (entry) await world.stage.precompile(entry.planet.group).catch(() => {});
    await hold;
    enter();
    return;
  }
  const rig = world.rig;
  rig.controls.enabled = false; // 接管期间手动转动不累积，交还时镜头不跳
  rig.drive = () => {}; // 先停在原地：首页加星球时看到镜头被接管，就不自己飞到新的取景
  app.addTeam(team);
  const entry = world.planets.get(team.id);
  if (!entry) {
    rig.drive = null;
    rig.controls.enabled = true;
    enter();
    return;
  }
  await new Promise<void>((resolve) => new RiseShow(world, entry, burst, state, hold, resolve).start());
  enter();
}

class RiseShow {
  private readonly world: World;
  private readonly entry: PlanetEntry;
  private readonly burst: CloudBurst | null;
  private readonly state: LaunchState;
  private readonly done: () => void;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromAim = new THREE.Vector3();
  private readonly start0 = new THREE.Vector3(); // 起点（云下面）
  private readonly ctrl = new THREE.Vector3(); // 弧线的控制点（起点上方，往新位置偏一点）
  private readonly emerge = new THREE.Vector3(); // 云顶上、星球冒出来的那一点
  private readonly shotFar = new THREE.Vector3(); // 冒出来的时候镜头在哪（远一点、高一点）
  private readonly shotNear = new THREE.Vector3(); // 到位时
  private readonly aim = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly hiddenParts: THREE.Object3D[] = [];
  private readonly R: number;
  private readonly top: number; // 云顶高度
  private holding = true;
  private t = 0;
  private riseT = -1; // 开始升的时刻（编好、镜头飘过一大半以后）
  private compiled = false;
  private revealed = false;
  private burstFired = false;
  private pressed = false;
  private released = false;

  constructor(world: World, entry: PlanetEntry, burst: CloudBurst | null, state: LaunchState, hold: Promise<unknown>, done: () => void) {
    this.world = world;
    this.entry = entry;
    this.burst = burst;
    this.state = state;
    this.done = done;
    this.R = entry.planet.radius;
    this.top = cloudTopY(world);
    void hold.then(() => { this.holding = false; }, () => { this.holding = false; });
    // 冒出来之前：半透明的部件透过云海会露出来，先藏起来
    entry.planet.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.transparent && o.visible) this.hiddenParts.push(o);
    });
  }

  start(): void {
    this.state.phase = 'wait';
    this.world.rig.drive = (dt) => this.step(dt);
    // 着色器编好、星球挂进场景（addPlanet 的 precompile 先排着，这一次排在它后面）
    void this.world.stage.precompile(this.entry.planet.group).catch(() => {}).then(() => { this.compiled = true; });
  }

  // 机位、弧线按新位置（首页版式给的那一格，entry.home 是活的：版式重排时跟着变）现算
  private plan(): void {
    const cam = this.world.rig.camera;
    const home = this.entry.home;
    const R = this.R;
    this.fromPos.copy(cam.position);
    const reach = Math.max(1, cam.position.distanceTo(this.world.rig.controls.target));
    this.fromAim.copy(cam.getWorldDirection(_v)).multiplyScalar(reach).add(cam.position);
    // 朝镜头的水平方向（side）、横着的方向（lateral）：起点在新位置旁边、稍后面，弧线从那里飞进来
    const side = new THREE.Vector3().copy(cam.position).sub(home).setY(0);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    const lateral = new THREE.Vector3().crossVectors(side, new THREE.Vector3(0, 1, 0)).normalize();
    this.start0.copy(home).addScaledVector(lateral, LAUNCH.side * R).addScaledVector(side, -LAUNCH.back * R);
    this.start0.y = this.top - LAUNCH.sink * R;
    this.emerge.set(this.start0.x, this.top, this.start0.z);
    this.ctrl.copy(this.start0).lerp(home, 0.2);
    this.ctrl.y = home.y + 1.1 * R;
    const D = LAUNCH.distance * R;
    const el = LAUNCH.elevation;
    this.shotNear.copy(home).addScaledVector(side, D * Math.cos(el));
    this.shotNear.y = home.y + D * Math.sin(el);
    // 冒出来时的机位：看着冒出来的那一点，离得远一点、高一点
    const mid = new THREE.Vector3().copy(home).lerp(this.emerge, 0.5);
    this.shotFar.copy(mid).addScaledVector(side, D * 1.3 * Math.cos(el + 0.18));
    this.shotFar.y = mid.y + D * 1.3 * Math.sin(el + 0.18);
  }

  private step(dt: number): void {
    const R = this.R;
    const cam = this.world.rig.camera;
    if (this.holding) {
      this.placePlanet(this.entry.home.x, this.top - LAUNCH.sink * R - 2 * R, this.entry.home.z);
      return; // 窗口还在收：镜头不动
    }
    if (this.t === 0) this.plan();
    this.t += dt;
    const home = this.entry.home;
    // 星球：编好、镜头飘过一大半以后开始升；之前一直沉在云下面
    if (this.riseT < 0) {
      this.placePlanet(this.start0.x, this.start0.y, this.start0.z);
      if (this.compiled && this.t >= LAUNCH.approach * 0.72) this.riseT = this.t;
    }
    let kr = 0;
    if (this.riseT >= 0) {
      kr = Math.min(1, (this.t - this.riseT) / LAUNCH.rise);
      bezier(this.pos, this.start0, this.ctrl, home, easeOutBack(kr, LAUNCH.overshoot));
      this.placePlanet(this.pos.x, this.pos.y, this.pos.z);
      const y = this.pos.y;
      this.state.phase = kr < 1 ? 'rise' : 'settle';
      // 冒头：星球顶快到云顶时翻开一圈云
      if (!this.burstFired && y + R > this.top - 0.15 * R) {
        this.burstFired = true;
        this.burst?.play(this.world, this.emerge, R);
      }
      // 中心出了云顶：半透明的部件放出来，大气光晕慢慢加回来；星球开始慢慢转、放大一点（首页的悬停动作）
      if (!this.revealed && y > this.top) {
        this.revealed = true;
        for (const o of this.hiddenParts) o.visible = true;
        this.world.setHover(this.entry);
      }
      if (this.revealed) this.entry.planet.setHaloStrength(Math.min(1, (y - this.top) / (1.2 * R)));
      // 快到位：按下去（缩一点）；到位松开：回弹一下（首页的按下、回弹）
      if (!this.pressed && kr > 0.62) {
        this.pressed = true;
        this.world.pressPlanet(this.entry, true);
      }
      if (this.pressed && !this.released && kr >= 0.97) {
        this.released = true;
        this.world.pressPlanet(null, false);
      }
    } else {
      this.state.phase = this.compiled ? 'approach' : 'wait';
    }
    // —— 镜头 ——
    // 位置：先从全景飘到远一点的机位（带一点向上的弧），星球冒出来以后推近到新位置前面
    const ka = Math.min(1, this.t / LAUNCH.approach);
    cam.position.lerpVectors(this.fromPos, this.shotFar, easeInOutCubic(ka));
    cam.position.y += Math.sin(Math.PI * ka) * R * 0.5;
    if (kr > 0) cam.position.lerp(this.shotNear, smooth(Math.min(1, kr * 1.15)));
    // 视线：先看冒出来的那一点，升起来以后跟着星球（略往上一点：星球在画面中间偏下、上面留出天空）
    this.aim.lerpVectors(this.fromAim, this.emerge, easeInOutCubic(ka));
    if (kr > 0) {
      const g = this.entry.planet.group.position;
      _v.set(g.x, Math.max(g.y, this.top) + 0.12 * R, g.z);
      this.aim.lerp(_v, smooth(Math.min(1, kr * 2.4)));
    }
    cam.lookAt(this.aim);
    this.burst?.tick(dt, cam);
    this.state.t = this.t;
    // 到位、停一下、云团也散完：结束
    if (kr >= 1 && this.t - this.riseT >= LAUNCH.rise + LAUNCH.settle && !this.burst?.playing) this.finish();
  }

  private placePlanet(x: number, y: number, z: number): void {
    this.entry.planet.group.position.set(x, y, z);
    if (!this.revealed) {
      for (const o of this.hiddenParts) o.visible = false;
      this.entry.planet.setHaloStrength(0);
    }
  }

  private finish(): void {
    const rig = this.world.rig;
    this.entry.planet.group.position.copy(this.entry.home);
    for (const o of this.hiddenParts) o.visible = true;
    this.entry.planet.setHaloStrength(1);
    this.world.pressPlanet(null, false);
    this.burst?.stop();
    // 交还镜头：OrbitControls 的环绕中心放在现在看的那一点、不限远近，update 时镜头不动；之后的穿云转场从这里起飞。
    // 悬停留着（还在慢慢转），进星球时 World.focus 自己清掉
    rig.drive = null;
    rig.controls.enabled = true;
    const cam = rig.camera;
    rig.jump({ target: this.aim.clone(), position: cam.position.clone(), minDistance: 0, maxDistance: Infinity, autoRotate: false, fov: cam.fov });
    this.done();
  }
}

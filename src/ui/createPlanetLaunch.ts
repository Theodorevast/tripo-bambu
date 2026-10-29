import * as THREE from 'three/webgpu';
import type { App } from '../app';
import { blendPalette, clonePalette, PRESETS, RAIN_MIX, RAIN_PALETTE } from '../nature/atmosphere';
import type { PlanetEntry, World } from '../scenes/world';
import { reducedMotion } from './motion';

// 「Launch」以后的 3D 部分（P3）：新星球从云海里升起来、飞进星系里它的位置，镜头跟过去，最后照常穿云进这颗星球。
// - 星球：App.addTeam → World.addPlanet 已经登记好、在后台编着色器（编好才挂进场景）。这里等它编好，
//   挂上的那一刻起每帧摆它的位置：先沉在云海下面，升起来时冲过头一点再落回、转着慢下来、从 0.9 倍长到原大小
// - 云海不写深度：沉在云下面的星球，它的半透明部件（大气外壳、云层、水面、云上的影子）会透过云海画出来，所以露头之前藏起来，
//   中心出了云顶再放出来，大气光晕从 0 慢慢加回来
// - 冒出来的那一刻，云顶上一圈云团往外翻开（CloudBurst：朝向镜头的软边面片，颜色取当前天空预设的云色；材质开窗口时就预编译好）
// - 镜头：rig.drive 接管（同漫游的跟随镜头），先从星系全景飘到新位置斜上方，再跟着星球往上看；最后交还 OrbitControls、
//   摆在同一个位置，App 照常导航进星球（director 的穿云转场从这里起飞）
// 减弱动效：不飞、不升，编好以后星球直接在位置上，导航进星球时转场自己换成淡入淡出

export const LAUNCH = {
  approach: 1.35, // 镜头从星系全景飘到新位置
  rise: 1.75, // 从云里升到位置上
  settle: 0.4, // 停一下再进星球
  distance: 6.2, // 镜头离新位置几个半径（升到位时）
  elevation: 0.3, // 镜头在新位置上方多高（弧度）
  sink: 1.35, // 起点：星球中心在云顶以下几个半径
  overshoot: 1.3, // 升到位时冲过头的强度（easeOutBack）
  spin: 2.4, // 升起来时转过的角度（弧度），落定时转回 0（星球视图按「不转」取景）
  puffs: 14,
};

type V3 = THREE.Vector3;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

const smooth = (t: number) => t * t * (3 - 2 * t);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
function easeOutBack(t: number, c1: number): number {
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

// 云海平均的云顶高度（世界 y）：和 nature/planetLook.ts 给星球在云上投影子用的同一个算法（云面圆盘在最高的云顶上面）
export function cloudTopY(world: World): number {
  const sea = world.atmosphere.objects.sea;
  const R = world.planets.values().next().value?.planet.radius ?? 30;
  return sea.position.y - R * (0.45 + 0.4 * world.atmosphere.params.seaThickness) - 0.5;
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
  phase: 'wait' | 'approach' | 'rise' | 'settle' | 'enter' | 'done';
  t: number;
}

// 星球冒出来、镜头跟过去，然后导航进这颗星球。返回的 Promise 在导航发出去时 resolve（进星球的转场由 App 照常排队处理）。
// burst：开窗口时预编译好的云团（没有就不翻云）
export async function riseIntoGalaxy(app: App, teamId: string, burst: CloudBurst | null, state: LaunchState = { phase: 'wait', t: 0 }): Promise<void> {
  const world = app.world;
  const entry = world.planets.get(teamId);
  if (!entry) return;
  app.galaxyUi.setEnabled(false);
  const enter = () => {
    state.phase = 'enter';
    app.navigate({ view: 'planet', teamId }, { replace: true });
  };
  if (reducedMotion()) {
    // 编好就在位置上（addPlanet 编好时挂上；这里排在它后面，resolve 时已经挂好了）
    await world.stage.precompile(entry.planet.group).catch(() => {});
    enter();
    return;
  }
  await new Promise<void>((resolve) => {
    const show = new RiseShow(world, entry, burst, state, resolve);
    show.start();
  });
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
  private readonly shotFar = new THREE.Vector3(); // 升起来之前镜头在哪（离得远一点、高一点）
  private readonly shotNear = new THREE.Vector3(); // 升到位时
  private readonly emerge = new THREE.Vector3(); // 云顶上、星球冒出来的那一点
  private readonly aim = new THREE.Vector3();
  private readonly home = new THREE.Vector3();
  private readonly hiddenParts: THREE.Object3D[] = [];
  private readonly R: number;
  private readonly top: number; // 云顶高度
  private readonly startY: number;
  private t = 0;
  private riseT = -1; // 开始升的时刻（编好、镜头飘到一半以后）
  private compiled = false;
  private revealed = false;
  private burstFired = false;

  constructor(world: World, entry: PlanetEntry, burst: CloudBurst | null, state: LaunchState, done: () => void) {
    this.world = world;
    this.entry = entry;
    this.burst = burst;
    this.state = state;
    this.done = done;
    this.R = entry.planet.radius;
    this.home.copy(entry.home);
    this.top = cloudTopY(world);
    this.startY = this.top - LAUNCH.sink * this.R;
    this.emerge.set(this.home.x, this.top, this.home.z);
    const cam = world.rig.camera;
    this.fromPos.copy(cam.position);
    const reach = Math.max(1, cam.position.distanceTo(world.rig.controls.target));
    this.fromAim.copy(cam.getWorldDirection(_v)).multiplyScalar(reach).add(cam.position);
    // 镜头从现在看过来的那个水平方向，停在新位置的斜上方
    const side = new THREE.Vector3().copy(cam.position).sub(this.home).setY(0);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    const D = LAUNCH.distance * this.R;
    const el = LAUNCH.elevation;
    this.shotNear.copy(this.home).addScaledVector(side, D * Math.cos(el));
    this.shotNear.y += D * Math.sin(el);
    this.shotFar.copy(this.home).addScaledVector(side, D * 1.25 * Math.cos(el + 0.12));
    this.shotFar.y += D * 1.25 * Math.sin(el + 0.12);
    // 冒出来之前：半透明的部件透过云海会露出来，先藏起来
    entry.planet.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.transparent && o.visible) this.hiddenParts.push(o);
    });
  }

  start(): void {
    const rig = this.world.rig;
    rig.controls.enabled = false; // 接管期间手动转动不累积，交还时镜头不跳
    rig.drive = (dt) => this.step(dt);
    this.state.phase = 'approach';
    // 着色器编好、星球挂进场景（addPlanet 的 precompile 先排着，这一次排在它后面）
    void this.world.stage.precompile(this.entry.planet.group).catch(() => {}).then(() => { this.compiled = true; });
  }

  private step(dt: number): void {
    this.t += dt;
    const cam = this.world.rig.camera;
    const planet = this.entry.planet;
    const R = this.R;
    // 星球：挂进场景以后、升起来之前一直沉在云下面
    if (this.riseT < 0) {
      this.placePlanet(this.startY, LAUNCH.spin, 0.9);
      // 镜头飘过一大半、星球也编好了：开始升
      if (this.compiled && this.t >= LAUNCH.approach * 0.75) this.riseT = this.t;
    }
    // —— 镜头 ——
    const ka = Math.min(1, this.t / LAUNCH.approach);
    const ea = easeInOutCubic(ka);
    let kr = 0;
    if (this.riseT >= 0) {
      kr = Math.min(1, (this.t - this.riseT) / LAUNCH.rise);
      const y = this.startY + (this.home.y - this.startY) * easeOutBack(kr, LAUNCH.overshoot);
      const s = 0.9 + 0.1 * easeOutCubic(Math.min(1, kr * 1.4));
      this.placePlanet(y, LAUNCH.spin * (1 - easeOutCubic(kr)), s);
      this.state.phase = kr < 1 ? 'rise' : 'settle';
      // 冒头：星球顶快到云顶时翻开一圈云
      if (!this.burstFired && y + R > this.top - 0.15 * R) {
        this.burstFired = true;
        this.burst?.play(this.world, this.emerge, R);
      }
      // 中心出了云顶：半透明的部件放出来，大气光晕慢慢加回来
      if (!this.revealed && y > this.top) {
        this.revealed = true;
        for (const o of this.hiddenParts) o.visible = true;
      }
      if (this.revealed) planet.setHaloStrength(Math.min(1, (y - this.top) / (1.2 * R)));
    } else {
      this.state.phase = this.compiled ? 'approach' : 'wait';
    }
    // 位置：先从全景飘到远一点的机位（带一点弧线），升起来时推近、略抬高
    cam.position.lerpVectors(this.fromPos, this.shotFar, ea);
    cam.position.y += Math.sin(Math.PI * ka) * R * 0.6;
    if (kr > 0) cam.position.lerp(this.shotNear, smooth(kr));
    // 视线：先看冒出来的那一点，升起来以后跟着星球（略往上一点，星球在画面中间偏下、上面留出天空）
    const planetY = planet.group.parent ? planet.group.position.y : this.startY;
    const follow = kr > 0 ? smooth(Math.min(1, kr * 2.2)) : 0;
    this.aim.lerpVectors(this.fromAim, this.emerge, ea);
    if (follow > 0) this.aim.lerp(_v.set(this.home.x, Math.max(planetY, this.top) + 0.15 * R, this.home.z), follow);
    cam.lookAt(this.aim);
    this.burst?.tick(dt, cam);
    this.state.t = this.t;
    // 升到位、停一下：结束
    if (kr >= 1 && this.t - this.riseT >= LAUNCH.rise + LAUNCH.settle && !this.burst?.playing) this.finish();
  }

  private placePlanet(y: number, spin: number, scale: number): void {
    const g = this.entry.planet.group;
    g.position.set(this.home.x, y, this.home.z);
    g.rotation.y = spin;
    g.scale.setScalar(scale);
    if (!this.revealed) {
      for (const o of this.hiddenParts) o.visible = false;
      this.entry.planet.setHaloStrength(0);
    }
  }

  private finish(): void {
    const rig = this.world.rig;
    const g = this.entry.planet.group;
    g.position.copy(this.home);
    g.rotation.y = 0;
    g.scale.setScalar(1);
    for (const o of this.hiddenParts) o.visible = true;
    this.entry.planet.setHaloStrength(1);
    this.burst?.stop();
    // 交还镜头：OrbitControls 的环绕中心放在现在看的那一点、不限远近，update 时镜头不动；之后的穿云转场从这里起飞
    rig.drive = null;
    rig.controls.enabled = true;
    const cam = rig.camera;
    rig.jump({ target: this.aim.clone(), position: cam.position.clone(), minDistance: 0, maxDistance: Infinity, autoRotate: false, fov: cam.fov });
    this.done();
  }
}

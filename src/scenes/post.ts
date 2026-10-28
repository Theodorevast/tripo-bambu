import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  dot,
  exp,
  float,
  getViewPosition,
  interleavedGradientNoise,
  length,
  max,
  mix,
  renderOutput,
  screenCoordinate,
  smoothstep,
  texture,
  time,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { gradeDisplay, gradeLinear, valueNoise } from '../style/grade';
import type { PlanetObject } from '../planet/planetObject';
import type { World } from './world';

// 主画面的后处理（绘本感的统一画面）：场景先画进一张离屏缓冲（半浮点、和画布一样的多采样、带深度），再用一个全屏三角形一次做完：
// 1. 接触阴影：作品和翠宝脚下一圈柔和的暗（按深度还原世界坐标，离「脚下那块地」近的像素压暗、偏冷紫）。草、地面、石头一起暗，
//    东西不再像浮在草上。只压作品底部贴地的一小截，作品本身的贴图不动
// 2. 日落光束：太阳低、在画面里或附近时，天空亮处（深度是远平面的像素）沿着朝太阳的方向径向累积，在四分之一分辨率下做两遍，
//    叠回去时是柔和的光（不影响清晰度）。白天、太阳在背后时整段跳过
// 3. 调色（style/grade.ts）：线性空间的白平衡和饱和度 → 色调映射（AgX，曝光归 atmosphere）→ 显示空间的 S 曲线、分离色调、黑位、暗角、抖动
// 不缩小、不模糊画面：场景缓冲和画布一样大，按像素中心原样取（最近邻），没有 FXAA、没有全屏泛光，作品的贴图保持清楚。
//
// 预编译：three 自己画画布时也是先画进一张中间缓冲（半浮点、同样的多采样、24 位深度）再做色调映射。场景缓冲用一模一样的格式，
// 所以场景里东西的管线和原来是同一份；平时渲染器的「当前渲染目标」一直设成场景缓冲（只在画最后一步时临时换成画布），
// 开场预热、新模型上场时的 compileAsync 都直接按场景缓冲编译，渲染对象、管线和真正画的时候完全一致，不会在出帧时同步编译。
// 场景这一遍自己画（不用 PassNode）：PassNode 那一遍嵌套在全屏三角形的 render() 里面，three 按嵌套深度区分渲染上下文，
// 后台预编译（深度 0）就对不上了
//
// 地址带 ?look=0：整个后处理关掉，回到 renderer.render 直接画（对比、低画质档）

const query = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
export const DEBUG_VIEWS = ['off', 'contact', 'rays', 'mask', 'sky', 'world'] as const;
export type DebugView = (typeof DEBUG_VIEWS)[number];

export const POST = {
  enabled: query.get('look') !== '0',
  // 自查用的中间结果（?lookdebug=contact / rays / mask / sky，或 ?tune → Look → debug）：接触阴影的浓淡、光束、发光的天空、天空的范围
  debug: (DEBUG_VIEWS as readonly string[]).includes(query.get('lookdebug') ?? '') ? (query.get('lookdebug') as DebugView) : 'off',
};

// 接触阴影（?tune → Look）
export const CONTACT = {
  strength: 0.7, // 最暗处压暗多少（0..1）
  hole: 0.45, // 中间这么大一块（× 半径）不压：那里是作品、翠宝的脚和鞋，只暗它们周围的地面和草
  spread: 1.3, // 半径 = 作品占地半径 × spread
  height: 0.18, // 作品往上压多高：× 半径（至少 0.12 米）。低一点：展台顶面基本不压
  walker: 0.5, // 翠宝脚下那一圈的半径（米）
  walkerHeight: 0.45, // 翠宝那一圈往上压多高（米）：整根草从根到尖都暗一点，不只是贴地的一截
  color: '#5b5470', // 压暗时乘的颜色（偏冷紫，不是黑）
};

// 日落光束（?tune → Look）：从太阳放射出来的一条条柔和的光（插画里的画法：条纹按太阳周围的角度用噪声排开，慢慢飘），
// 再乘上「这里朝太阳那条路有没有被挡住」：翠宝、作品、草尖、太阳前面的云都会在光里切出影子
export const RAYS = {
  sunset: 0.55, // 日落时的强度
  day: 0, // 白天的强度（默认没有）
  reach: 0.75, // 光束从太阳往外伸多远（画面高度的倍数，按指数衰减）
  beams: 5, // 条纹的密度（一圈大约 2π × beams / 2 条）
  contrast: 0.7, // 条纹的明暗差（0 是一片均匀的光晕，1 是条纹之间全暗）
  open: 0.35, // 天空多亮才算「透光」（线性亮度，曝光之前）：比它暗的云会挡光
  decay: 0.96, // 判断遮挡时每一步的权重衰减（越小越只看近处的遮挡）
  tint: '#ffb779', // 光的颜色
  air: 25, // 近处的东西前面空气少：物体上的光束按「1 − e^(−距离 / air)」变淡（米），天空上是满的
  airFloor: 0.35, // 再近也留这么多
};

// 阳光的冷暖（?tune → Look）：按星球的大形状（球面法线）和太阳方向，迎光的一面偏暖、略亮，背光的一面偏冷、略暗，
// 远看一眼就知道太阳在哪边（绘本里的「冷暖对比」）。贴地漫游时看到的只是一小块地，按镜头离地高度淡掉
export const WASH = {
  strength: 0.8, // 远看时的强度（0 关）
  warm: '#fff0d4', // 迎光那一面偏的颜色（很淡的暖色：乘得太暖草会发黄发褐）
  lit: 1.15, // 迎光那一面的亮度
  cool: '#9fb4ff', // 背光那一面：颜色往这个色相偏（先去掉一半饱和度再染，草的暗面偏青紫而不是发脏）
  shade: 0.8, // 背光那一面的亮度
  from: 0.05, // 法线和太阳方向的夹角余弦：从这里开始变暖（比真实的明暗交界线往太阳那边挪：正对太阳的星球远看也分得出两边）
  to: 0.95, // 到这里全暖
  near: 0.3, // 镜头离地面低于 near × 半径：没有
  far: 1.0, // 高于 far × 半径：满强度
};

const MAX_CONTACTS = 16;
const MAX_PLANETS = 24;
const RAY_STEPS = 32;
const SKY_DEPTH = 0.99999; // 深度 ≥ 这个是没画东西的地方：天空、云海（云海和远处积云不写深度）
const LUMA = vec3(0.2126, 0.7152, 0.0722);

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// 叠在调色之前的一层（线性颜色进、线性颜色出），例如转场的云层：addOverlay 以后重建最后一步的着色器
export type Overlay = (rgb: V3, uv: V2, aspect: F, invSize: V2) => V3;

const linear = (hex: string, out: THREE.Vector3): THREE.Vector3 => {
  const c = new THREE.Color(hex);
  return out.set(c.r, c.g, c.b);
};

const _box = new THREE.Box3();
const _tmp = new THREE.Box3();
const _inv = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _sun = new THREE.Vector3();

// 一件作品在它自己的坐标里（+Y 是地面法线）占地多大：所有可见网格的几何包围盒，取水平方向最远的那一边
function footprintOf(root: THREE.Object3D): number {
  _inv.copy(root.matrixWorld).invert();
  _box.makeEmpty();
  root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    _tmp.copy(g.boundingBox!).applyMatrix4(_rel.multiplyMatrices(_inv, mesh.matrixWorld));
    _box.union(_tmp);
  });
  if (_box.isEmpty()) return 0;
  return Math.max(-_box.min.x, _box.max.x, -_box.min.z, _box.max.z, 0);
}

export class MainPost {
  readonly target: THREE.RenderTarget; // 场景缓冲：线性 HDR 颜色 + 深度
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private on = POST.enabled;
  // 日落光束：四分之一分辨率的两张缓冲（发光的天空 → 径向累积）
  private readonly maskTarget: THREE.RenderTarget;
  private readonly raysTarget: THREE.RenderTarget;
  private readonly maskQuad: THREE.QuadMesh;
  private readonly raysQuad: THREE.QuadMesh;
  private readonly finalMaterial = new THREE.NodeMaterial();
  private readonly finalQuad: THREE.QuadMesh;
  private readonly overlays: Overlay[] = [];
  // uniform
  private readonly invSize = uniform(new THREE.Vector2(1, 1));
  private readonly aspect = uniform(1);
  private readonly projectionInverse = uniform(new THREE.Matrix4());
  private readonly cameraWorld = uniform(new THREE.Matrix4());
  private readonly contacts = Array.from({ length: MAX_CONTACTS }, () => ({ a: new THREE.Vector4(), b: new THREE.Vector4() })); // 中心（世界坐标）、半径；地面法线、往上压多高
  private readonly contactA = uniformArray(this.contacts.map((c) => c.a), 'vec4');
  private readonly contactB = uniformArray(this.contacts.map((c) => c.b), 'vec4');
  private readonly contactCount = uniform(0, 'int');
  private readonly contactStrength = uniform(CONTACT.strength);
  private readonly contactColor = uniform(new THREE.Vector3());
  private readonly contactHole = uniform(CONTACT.hole);
  private readonly planetList = Array.from({ length: MAX_PLANETS }, () => new THREE.Vector4()); // 星球中心（世界坐标）、半径
  private readonly planetArray = uniformArray(this.planetList, 'vec4');
  private readonly planetCount = uniform(0, 'int');
  private readonly sunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly washStrength = uniform(0);
  private readonly washWarm = uniform(new THREE.Vector3(1, 1, 1));
  private readonly washCool = uniform(new THREE.Vector3(1, 1, 1));
  private readonly washShade = uniform(WASH.shade);
  private readonly washLit = uniform(WASH.lit);
  private readonly washFrom = uniform(WASH.from);
  private readonly washTo = uniform(WASH.to);
  private readonly sunUv = uniform(new THREE.Vector2(0.5, 0.5));
  private readonly rayStrength = uniform(0);
  private readonly rayReach = uniform(RAYS.reach);
  private readonly rayBeams = uniform(RAYS.beams);
  private readonly rayContrast = uniform(RAYS.contrast);
  private readonly rayOpen = uniform(RAYS.open);
  private readonly rayDecay = uniform(RAYS.decay);
  private readonly rayTint = uniform(new THREE.Vector3());
  private readonly rayAir = uniform(RAYS.air);
  private readonly rayAirFloor = uniform(RAYS.airFloor);
  private readonly debugView = uniform(0, 'int');
  private toneMapping: THREE.ToneMapping;
  private colorSpace: string;
  private readonly size = new THREE.Vector2();
  private readonly footprints = new WeakMap<THREE.Object3D, { r: number; t: number }>();
  private clock = 0;
  private raysOn = false;
  // 转场的云层（director 的 veil，挂在场景里的全屏网格）盖着画面时：接触阴影、光束、冷暖都淡掉（它们按云层后面的深度算，
  // 会透过云印出来）。0.15 秒内淡出淡入，云层边缘露出来的那一圈画面不会一下子跳
  private unveiled = 1;
  private last = 0;
  private readonly ndc = new THREE.Vector3();

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.toneMapping = renderer.toneMapping;
    this.colorSpace = renderer.outputColorSpace;
    // 和 three 自己的中间缓冲（Renderer._getFrameBufferTarget）同样的格式：半浮点 RGBA、工作色彩空间、同样的采样数和深度格式
    const stencil = renderer.stencil;
    const depthTexture = new THREE.DepthTexture(1, 1, stencil ? THREE.UnsignedInt248Type : THREE.UnsignedIntType);
    depthTexture.format = stencil ? THREE.DepthStencilFormat : THREE.DepthFormat;
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.ColorManagement.workingColorSpace as THREE.ColorSpace,
      depthBuffer: renderer.depth,
      stencilBuffer: stencil,
      samples: renderer.samples,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter, // 按像素中心原样取，不做任何过滤
      magFilter: THREE.NearestFilter,
      depthTexture,
    });
    this.target.texture.name = 'scene-color';
    // 只要一个通道（透光程度、光束亮度）：半浮点单通道，四分之一分辨率下不到 1 MB，取样都在缓存里
    const quarter = { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.maskTarget = new THREE.RenderTarget(1, 1, quarter);
    this.raysTarget = new THREE.RenderTarget(1, 1, quarter);
    this.maskQuad = new THREE.QuadMesh(this.buildMask());
    this.raysQuad = new THREE.QuadMesh(this.buildRays());
    this.finalMaterial.name = 'MainPost';
    this.finalQuad = new THREE.QuadMesh(this.finalMaterial);
    this.finalQuad.name = 'Main post';
    this.build();
    this.apply();
    if (this.on) renderer.setRenderTarget(this.target);
  }

  get enabled(): boolean {
    return this.on;
  }

  // ?tune 的总开关：关掉时回到 renderer.render 直接画（新的渲染上下文要现建渲染对象，管线是同一份）
  set enabled(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    POST.enabled = v;
    this.renderer.setRenderTarget(v ? this.target : null);
  }

  // CONTACT / RAYS 表 → uniform（?tune 改了表以后调）
  apply(): void {
    this.contactStrength.value = CONTACT.strength;
    linear(CONTACT.color, this.contactColor.value);
    this.contactHole.value = CONTACT.hole;
    linear(WASH.warm, this.washWarm.value);
    linear(WASH.cool, this.washCool.value);
    this.washShade.value = WASH.shade;
    this.washLit.value = WASH.lit;
    this.washFrom.value = WASH.from;
    this.washTo.value = WASH.to;
    this.rayReach.value = RAYS.reach;
    this.rayBeams.value = RAYS.beams;
    this.rayContrast.value = RAYS.contrast;
    this.rayOpen.value = RAYS.open;
    this.rayDecay.value = RAYS.decay;
    linear(RAYS.tint, this.rayTint.value);
    this.rayAir.value = RAYS.air;
    this.rayAirFloor.value = RAYS.airFloor;
    this.debugView.value = DEBUG_VIEWS.indexOf(POST.debug);
  }

  // 加一层叠加（转场的云层等）：重建最后一步。开场预热之前加，第一帧就不用同步编译
  addOverlay(overlay: Overlay): void {
    this.overlays.push(overlay);
    this.build();
  }

  // 每帧调一次，代替 renderer.render(scene, camera)
  render(world: World): void {
    const r = this.renderer;
    if (!this.on) {
      r.render(this.scene, this.camera);
      return;
    }
    if (r.toneMapping !== this.toneMapping || r.outputColorSpace !== this.colorSpace) {
      this.toneMapping = r.toneMapping;
      this.colorSpace = r.outputColorSpace;
      this.build();
    }
    this.resize();
    const saved = r.getRenderTarget();
    try {
      // 1. 场景 → 场景缓冲
      r.setRenderTarget(this.target);
      r.render(this.scene, this.camera);
      this.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
      this.cameraWorld.value.copy(this.camera.matrixWorld);
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      const veil = world.director.veil.visible ? 0 : 1;
      this.unveiled = veil > this.unveiled ? Math.min(1, this.unveiled + dt / 0.15) : Math.max(veil, this.unveiled - dt / 0.15);
      this.gatherContacts(world);
      this.gatherPlanets(world);
      // 2. 日落光束（只在要画的时候）
      this.aimRays(world);
      if (this.raysOn) {
        r.setRenderTarget(this.maskTarget);
        this.maskQuad.render(r);
        r.setRenderTarget(this.raysTarget);
        this.raysQuad.render(r);
      }
      // 3. 最后一步 → 画布
      this.drawFinal();
    } finally {
      r.setRenderTarget(saved);
    }
  }

  // 开场时（还没开始出帧）编好后处理自己的几步。光束那两步画到自己的缓冲里，compileAsync 按缓冲的格式编；
  // 最后一步画到画布：画布那一遍的采样数是渲染器在画的那一刻才定的（全屏三角形不多采样），compileAsync 拿不准，
  // 所以先在后台编着色器（WebGL2 的程序就在这一步编好），再实际画一次（WebGPU 在这里建管线；这时画布还没露出来）
  async compile(): Promise<void> {
    if (!this.on) return;
    const r = this.renderer;
    const saved = r.getRenderTarget();
    try {
      this.resize();
      for (const [quad, target] of [[this.maskQuad, this.maskTarget], [this.raysQuad, this.raysTarget]] as const) {
        r.setRenderTarget(target);
        await r.compileAsync(quad, quad.camera);
      }
      r.setRenderTarget(null);
      await this.withCanvasState(() => r.compileAsync(this.finalQuad, this.finalQuad.camera));
      this.drawFinal();
    } finally {
      r.setRenderTarget(saved);
    }
  }

  // 兼容旧接口：场景缓冲就是渲染器平时的渲染目标，按它编译不用再切换
  compileFor(start: () => Promise<void>): Promise<void> {
    return start();
  }

  dispose(): void {
    if (this.renderer.getRenderTarget() === this.target) this.renderer.setRenderTarget(null);
    this.target.dispose();
    this.maskTarget.dispose();
    this.raysTarget.dispose();
    for (const q of [this.maskQuad, this.raysQuad, this.finalQuad]) (q.material as THREE.Material).dispose();
  }

  private resize(): void {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
      const qw = Math.max(1, Math.round(w / 4));
      const qh = Math.max(1, Math.round(h / 4));
      this.maskTarget.setSize(qw, qh);
      this.raysTarget.setSize(qw, qh);
    }
    this.invSize.value.set(1 / w, 1 / h);
    this.aspect.value = w / h;
  }

  // 画最后一步时关掉渲染器自己的输出变换（色调映射、sRGB 在着色器里做），画完换回来
  private withCanvasState<T>(fn: () => T): T {
    const r = this.renderer;
    const toneMapping = r.toneMapping;
    const colorSpace = r.outputColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    const restore = () => {
      r.toneMapping = toneMapping;
      r.outputColorSpace = colorSpace;
    };
    let out: T;
    try {
      out = fn();
    } catch (err) {
      restore();
      throw err;
    }
    // 返回 Promise 时（compileAsync）等它完成再换回来：编译分几步在后台做，每一步都读这些状态
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  }

  private drawFinal(): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    this.withCanvasState(() => this.finalQuad.render(r));
  }

  // 接触阴影：聚焦星球上的作品（works 组的每个孩子）和翠宝（星球组里名叫 walker 的孩子）。
  // 星球只平移、缩放，不旋转：世界坐标 = 星球位置 + 缩放 × 本地坐标，地面法线就是本地坐标的方向
  private gatherContacts(world: World): void {
    const planet: PlanetObject | null = world.focused?.planet ?? null;
    let n = 0;
    const s = CONTACT.strength > 0 && this.unveiled > 0 ? 1 : 0;
    if (planet && s > 0) {
      this.clock += 1;
      const group = planet.group;
      const scale = group.scale.x;
      const add = (local: THREE.Vector3, radius: number, top: number) => {
        if (n >= MAX_CONTACTS || radius <= 0.01) return;
        _n.copy(local).normalize();
        _p.copy(local).multiplyScalar(scale).add(group.position);
        this.contacts[n].a.set(_p.x, _p.y, _p.z, radius * scale);
        this.contacts[n].b.set(_n.x, _n.y, _n.z, top * scale);
        n++;
      };
      for (const root of planet.works.children) {
        if (!root.visible) continue;
        let f = this.footprints.get(root);
        // 占地大小半秒量一次（模型加载完、缩放、换展台都会变）；同一帧里不量太多件
        if (!f || (this.clock - f.t > 30 && n < 4)) {
          f = { r: footprintOf(root), t: this.clock };
          this.footprints.set(root, f);
        }
        add(root.position, f.r * CONTACT.spread, Math.max(f.r * CONTACT.spread * CONTACT.height, 0.12));
      }
      for (const child of group.children) {
        if (child.name === 'walker' && child.visible) add(child.position, CONTACT.walker * child.scale.x, CONTACT.walkerHeight * child.scale.x);
      }
    }
    this.contactCount.value = n;
    this.contactStrength.value = CONTACT.strength * this.unveiled;
  }

  // 阳光的冷暖：所有星球的中心和半径（星球只平移、缩放），太阳方向；强度按镜头离聚焦星球地面的高度（星系视图里满强度）
  private gatherPlanets(world: World): void {
    let n = 0;
    for (const e of world.planets.values()) {
      if (n >= MAX_PLANETS) break;
      const g = e.planet.group;
      this.planetList[n++].set(g.position.x, g.position.y, g.position.z, e.planet.radius * g.scale.x);
    }
    this.planetCount.value = n;
    this.sunDir.value.copy(world.light.sunDir);
    let k = 1;
    const f = world.focused;
    if (f) {
      const R = f.planet.radius * f.planet.group.scale.x;
      const above = this.camera.position.distanceTo(f.planet.group.position) - R;
      k = THREE.MathUtils.smoothstep(above, WASH.near * R, WASH.far * R);
    }
    this.washStrength.value = WASH.strength * k * this.unveiled;
  }

  // 日落光束：太阳在画面上的位置和强度。强度 = 预设（白天 / 日落按傍晚系数插值）× 太阳离画面多近
  private aimRays(world: World): void {
    const evening = THREE.MathUtils.clamp(world.light.evening / 0.6, 0, 1); // 0.6 = 日落预设的傍晚系数（world.ts 的 EVENING_AT_SUNSET）
    const base = THREE.MathUtils.lerp(RAYS.day, RAYS.sunset, evening);
    let k = 0;
    if (base > 0.001) {
      _sun.copy(world.light.sunDir).multiplyScalar(1000).add(this.camera.position);
      this.ndc.copy(_sun).project(this.camera);
      const facing = _sun.sub(this.camera.position).normalize().dot(this.camera.getWorldDirection(_p));
      if (facing > 0) {
        this.sunUv.value.set(this.ndc.x * 0.5 + 0.5, 0.5 - this.ndc.y * 0.5);
        // 太阳出了画面以后再走 0.6 个画面宽，光束淡完
        const out = Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y)) - 1;
        k = (1 - THREE.MathUtils.smoothstep(out, 0, 1.2)) * THREE.MathUtils.smoothstep(facing, 0.05, 0.3);
      }
    }
    this.rayStrength.value = base * k * this.unveiled;
    this.raysOn = base * k > 0.001;
  }

  // 透光的地方（四分之一分辨率）：取 4 个全分辨率的点（最近邻），深度是远平面（天空、云海）而且够亮的算透光，
  // 物体（星球、草、作品、翠宝）和太阳前面暗下来的云挡光
  private buildMask(): THREE.NodeMaterial {
    const color = texture(this.target.texture);
    const depth = texture(this.target.depthTexture!);
    const m = new THREE.NodeMaterial();
    m.name = 'MainPost rays mask';
    m.fragmentNode = Fn(() => {
      const st = uv();
      const sum = float(0).toVar();
      for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const p = st.add(this.invSize.mul(vec2(ox, oy)));
        const sky = depth.sample(p).r.greaterThanEqual(SKY_DEPTH).select(float(1), float(0));
        sum.addAssign(smoothstep(this.rayOpen.mul(0.5), this.rayOpen, dot(color.sample(p).rgb, LUMA)).mul(sky));
      }
      return vec4(sum.mul(0.25), 0, 0, 1);
    })();
    return m;
  }

  // 光束（四分之一分辨率）：
  // - 透光程度：从这个像素朝太阳走 RAY_STEPS 步取透光图，近处的权重大（起点按像素错开一点，看不出台阶）；
  // - 条纹：按这个像素在太阳周围的方向取两层值噪声（方向是单位向量，噪声坐标绕一个圆，没有接缝），随时间慢慢飘；
  // - 离太阳越远越淡（指数衰减），紧挨着日轮的一小圈也淡掉（那里本来就亮）
  private buildRays(): THREE.NodeMaterial {
    const mask = texture(this.maskTarget.texture);
    const m = new THREE.NodeMaterial();
    m.name = 'MainPost rays';
    m.fragmentNode = Fn(() => {
      const st = uv();
      const step = this.sunUv.sub(st).div(RAY_STEPS).toVar();
      const p = st.add(step.mul(interleavedGradientNoise(screenCoordinate.xy))).toVar();
      const acc = float(0).toVar();
      const fall = float(1).toVar();
      const total = float(0).toVar();
      Loop(RAY_STEPS, () => {
        acc.addAssign(mask.sample(p).r.mul(fall));
        total.addAssign(fall);
        fall.mulAssign(this.rayDecay);
        p.addAssign(step);
      });
      const open = acc.div(total);
      const rel = st.sub(this.sunUv).mul(vec2(this.aspect, 1));
      const dist = length(rel);
      const dir = rel.div(max(dist, 1e-4));
      const drift = vec2(time.mul(0.031), time.mul(-0.017));
      const n = valueNoise(dir.mul(this.rayBeams).add(drift)).mul(0.65).add(valueNoise(dir.mul(this.rayBeams.mul(2.3)).sub(drift).add(7.1)).mul(0.35));
      const beams = mix(float(1).sub(this.rayContrast), float(1), smoothstep(0.32, 0.72, n));
      const reach = exp(dist.div(this.rayReach).negate()).mul(smoothstep(0.01, 0.07, dist));
      return vec4(open.mul(beams).mul(reach), 0, 0, 1);
    })();
    return m;
  }

  // 最后一步：接触阴影 → 光束 → 线性调色 → 叠加层 → 色调映射和 sRGB → 显示空间调色
  private build(): void {
    const color = texture(this.target.texture);
    const depth = texture(this.target.depthTexture!);
    const rays = texture(this.raysTarget.texture);
    const mask = texture(this.maskTarget.texture);
    const node = Fn(() => {
      const st = uv();
      const c = color.sample(st).rgb.toVar();
      const d = depth.sample(st).r;
      const occ = float(0).toVar();
      const sky = d.greaterThanEqual(SKY_DEPTH);
      const view = getViewPosition(st, d, this.projectionInverse).toVar();
      const world = this.cameraWorld.mul(vec4(view, 1)).xyz.toVar();
      // 阳光的冷暖：这个像素在哪颗星球的地面上（离中心不到 1.1 个半径：地形、作品；外面一圈大气光晕、光环不算），
      // 按那颗星球的球面法线和太阳方向：迎光一面乘暖色，背光一面先去掉一半饱和度、染成偏青紫的颜色、压暗一点
      If(this.washStrength.greaterThan(0.001).and(sky.not()), () => {
        const lit = float(0).toVar();
        const on = float(0).toVar();
        Loop({ start: 0, end: this.planetCount, type: 'int', condition: '<' }, ({ i }) => {
          const p = this.planetArray.element(i) as unknown as THREE.Node<'vec4'>;
          const rel = world.sub(p.xyz);
          const r = length(rel);
          If(r.lessThan(p.w.mul(1.1)), () => {
            lit.assign(smoothstep(this.washFrom, this.washTo, dot(rel.div(r), this.sunDir)));
            on.assign(float(1).sub(smoothstep(p.w.mul(1.075), p.w.mul(1.1), r)));
          });
        });
        If(on.greaterThan(0), () => {
          const l = dot(c, LUMA);
          const shade = mix(c, this.washCool.mul(l).div(dot(this.washCool, LUMA)), 0.5).mul(this.washShade);
          const sunny = c.mul(this.washWarm).mul(this.washLit.div(dot(this.washWarm, LUMA)));
          const washed = mix(shade, sunny, lit);
          c.assign(mix(c, washed, on.mul(this.washStrength)));
        });
      });
      If(this.contactCount.greaterThan(0).and(sky.not()), () => {
        Loop({ start: 0, end: this.contactCount, type: 'int', condition: '<' }, ({ i }) => {
          const a = this.contactA.element(i) as unknown as THREE.Node<'vec4'>;
          const b = this.contactB.element(i) as unknown as THREE.Node<'vec4'>;
          const rel = world.sub(a.xyz);
          const h = dot(rel, b.xyz);
          const rho = length(rel.sub(b.xyz.mul(h)));
          const top = b.w;
          // 一圈：中间 hole 以内不压，往外很快到最暗，再慢慢淡到半径处
          const inner = a.w.mul(this.contactHole);
          const ring = smoothstep(inner, inner.add(a.w.mul(0.2)), rho).mul(float(1).sub(smoothstep(inner.add(a.w.mul(0.2)), a.w, rho)));
          // 贴地最暗，往上按平方变淡（草根暗、草尖亮，像环境光遮蔽）；地面以下一点也算（坡地、草根）
          const up = float(1).sub(h.div(top)).clamp(0, 1);
          const k = ring.mul(up.mul(up)).mul(smoothstep(top.mul(-0.5), 0, h));
          occ.assign(max(occ, k));
        });
        c.assign(mix(c, c.mul(this.contactColor), occ.mul(this.contactStrength)));
      });
      If(this.rayStrength.greaterThan(0.001), () => {
        const air = sky.select(float(1), mix(this.rayAirFloor, float(1), float(1).sub(exp(view.z.div(this.rayAir)))));
        c.addAssign(this.rayTint.mul(rays.sample(st).r.mul(this.rayStrength).mul(air)));
      });
      let rgb: V3 = gradeLinear(c);
      for (const overlay of this.overlays) rgb = overlay(rgb, st, this.aspect, this.invSize);
      const out = renderOutput(vec4(rgb, 1), this.toneMapping, this.colorSpace);
      const graded = vec4(gradeDisplay(out.rgb, st, screenCoordinate.xy), 1).toVar();
      // 自查用的中间结果
      If(this.debugView.equal(1), () => {
        graded.assign(vec4(vec3(float(1).sub(occ.mul(this.contactStrength))), 1));
      });
      If(this.debugView.equal(2), () => {
        graded.assign(vec4(this.rayTint.mul(rays.sample(st).r), 1));
      });
      If(this.debugView.equal(3), () => {
        graded.assign(vec4(vec3(mask.sample(st).r), 1));
      });
      If(this.debugView.equal(5), () => {
        graded.assign(vec4(world.mul(0.5).fract(), 1));
      });
      If(this.debugView.equal(4), () => {
        graded.assign(vec4(vec3(d.greaterThanEqual(SKY_DEPTH).select(float(1), float(0))), 1));
      });
      return graded;
    });
    this.finalMaterial.fragmentNode = node();
    this.finalMaterial.needsUpdate = true;
  }
}

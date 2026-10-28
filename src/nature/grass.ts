import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  cameraPosition,
  cos,
  cross,
  dot,
  faceDirection,
  float,
  floor,
  hash,
  instanceIndex,
  int,
  ivec2,
  length,
  luminance,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  texture,
  texture3D,
  textureLoad,
  uint,
  uniform,
  varyingProperty,
  vec3,
} from 'three/tsl';

// 草和野花：独立模块，只在镜头附近画。
//
// 做法（细节见 .superpowers/sdd/2026-10-27-community-planets/task-N1-report.md）：
// - 星球表面按「等角立方体球」切成约 3 m 见方的瓦片，瓦片编号是星球上固定的（和镜头无关）。
// - 每根草由「瓦片编号 + 序号」哈希出位置、高矮、宽窄、朝向，全在 GPU 顶点着色器里算，所以镜头怎么动，同一根草永远长在同一个地方，不会跳格。
// - 每块瓦片在 CPU 上算一次 9×9 的地面网格（height(dir) 得到地面半径、exclude(dir) 和海面得到不长草的遮罩），存进一张数组贴图；草根在网格里双线性插值贴地。
// - 每帧在 CPU 上从镜头脚下的瓦片向外广度优先找出半径内、视锥内的瓦片，按最近距离分到 4 档（每块画 4096 / 1024 / 256 / 64 根），每档一个实例化绘制。
// - 远处变稀用「名次」淡出：瓦片里第 j 根草的名次是 j / 4096，密度 φ(距离) 小于名次的草缩成 0，介于中间的按比例变矮，所以镜头移动时草是慢慢长出来、慢慢缩回去的，没有突然出现的边界。
//
// 风和光的思路参考了 Bruno Simon 的 folio-2025（MIT 许可，https://github.com/brunosimon/folio-2025）：
// Wind.js 的「两层滚动噪声相加、乘风向和强度、时间按 dt × 频率 × 强度累加」，MeshDefaultMaterial.js 的「明暗交界 smoothstep、阴影是底色乘一个偏蓝紫的阴影色」。
// 这里是按星球（径向朝上、风投影到切平面）重写的，没有照抄代码。

type N<T extends string> = THREE.Node<T>;

// —— 对外接口 ——

export interface GrassPlanet {
  radius: number; // 星球基础半径（单位：米）
  center: THREE.Vector3; // 星球中心（世界坐标）
  height(dir: THREE.Vector3): number; // 单位方向 → 地面半径（已含起伏）。传进来的向量会被复用，不要留着它
  sea: number | null; // 海面半径，没有海就是 null；水下不长草
}

// 风：世界坐标位置 + 时间（秒）→ 世界坐标下的风向量（长度约 0..1.5，1 是明显的风）。在顶点着色器里调用，返回 TSL 节点。
// 草只用它在切平面上的分量（星球上「上」是径向）
export type GrassWind = (posWorld: N<'vec3'>, timeSec: N<'float'>) => N<'vec3'>;

// 踩草：一张贴图（亮 = 被压倒）和「单位方向 → 贴图 UV」的 TSL 函数。
// bendDir 可选：从采样值解出压倒的方向（世界坐标切向量）；不给就用亮度的梯度，草朝远离踩痕中心的方向倒
export interface GrassTrample {
  texture: THREE.Texture;
  uvOf(dir: N<'vec3'>): N<'vec2'>;
  bendDir?(sample: N<'vec4'>, dir: N<'vec3'>): N<'vec3'>;
}

export interface GrassOptions {
  renderer: THREE.WebGPURenderer;
  planet: GrassPlanet;
  exclude?(dir: THREE.Vector3): number; // 0..1，1 表示这里不长草（路、展台、作品脚下）
  density?: number; // 0..1，画质档位
  wind?: GrassWind; // 不给就用模块自己的风
  trample?: GrassTrample; // 不给就不踩草
}

// 可以实时调的参数：update() 每帧读一次
export interface GrassSettings {
  radius: number; // 草画到多远（米，到镜头的距离），最后 45% 慢慢变稀变矮
  fullRadius: number; // 这个距离以内是满密度（米）
  height: number; // 草高倍数（1 = 0.15–0.45 m）
  width: number; // 叶宽倍数
  windStrength: number; // 0..1.5
  windSpeed: number; // 风浪推进速度倍数
  windDir: THREE.Vector3; // 风向（世界坐标，会投影到每处的切平面）
  flowers: number; // 野花密度 0..1
  flowerRadius: number; // 花画到多远（米）
  translucency: number; // 逆光透光强度
  dryness: number; // 枯黄色斑的多少 0..1
  colors: { root: string; lush: string; fresh: string; dry: string; tip: string; shadow: string };
}

export interface GrassStats {
  tiles: number; // 本帧画了几块瓦片（草）
  bands: number[]; // 每档几块
  instances: number; // 草的实例数（包括在着色器里因为名次淡出缩成 0 的）
  flowerInstances: number;
  triangles: number; // 草 + 花的三角形数（按实例数 × 每实例三角形）
  drawCalls: number; // 实际发出的绘制调用（实例数为 0 的档不画）
  cachedTiles: number; // 已算好地面网格的瓦片
  generated: number; // 本帧新算的瓦片
}

// inspect() 的一项：绘制列表里的一块瓦片（band = -1 表示花的列表）
export interface GrassListEntry {
  band: number;
  tile: number;
  slot: number;
  frame: number[]; // P0、Ex、Ey（星球局部坐标，瓦片固定的）
  scale: number; // 密度倍数（面积 × 淡入）
}

export interface GrassField {
  object: THREE.Object3D;
  update(camera: THREE.Camera, timeSec: number): void;
  setDensity(n: number): void;
  dispose(): void;
  // 以下是接口之外加的
  setSun(dir: THREE.Vector3, color?: THREE.ColorRepresentation, intensity?: number): void; // dir 指向太阳（世界坐标）
  refresh(near?: THREE.Vector3, radius?: number): void; // exclude 或地形变了：地面网格原地重算（由近到远，重算前照旧画）；给了 near 就只重算它周围 radius（默认 3）米
  readonly settings: GrassSettings;
  readonly stats: GrassStats;
  windAt: GrassWind; // 实际在用的风（外面传进来的，或者模块自己的）
  groundTint(posWorld: N<'vec3'>): N<'vec3'>; // 这里的草从远处看是什么颜色：给地面着色器用，草淡出的地方地面接得上
  inspect(): GrassListEntry[]; // 调试用（测试、自查）：本帧各档画了哪些瓦片。会新建数组，不要每帧调
}

// —— 常量 ——

export const BLADES_PER_TILE = 8192; // 满密度时每块瓦片的草
export const BAND_SIZES = [8192, 2048, 512, 128]; // 各档每块瓦片画几根（第 j 根在哪一档都是同一根）
const BAND_SEGMENTS = [3, 3, 2, 1]; // 各档每根草分几节（远处的草只有一个三角形）
export const FLOWERS_PER_TILE = 128;
const TILE_TARGET = 2.9; // 瓦片目标边长（米）
export const GRID = 9; // 每块瓦片的地面网格：9×9 个点
const TARGET_DENSITY = 780; // 密度 1 时近处每平方米的草
const SLOTS_PER_LAYER = 4; // 每层数组贴图放 2×2 块瓦片的网格（WebGPU 默认最多 256 层）
const SINK = 0.03; // 草根往地下埋 3 cm，地面网格是折线插值，不让草根悬空
const HEIGHT_MIN = 0.15;
const HEIGHT_MAX = 0.45;
const WIDTH_MIN = 0.009;
const WIDTH_MAX = 0.021;
const MAX_BEND = 1.45; // 草尖最多偏离竖直方向约 83°
const BIRTH_FADE = 0.6; // 新算好的瓦片用 0.6 秒按名次长出来
const GEN_BUDGET_MS = 3; // 每帧最多花多少毫秒算新瓦片（第一帧不限）
const SUN_RESPONSE = 0.62; // 草对太阳的响应：setSun 传进来的是灯的颜色 × 强度，和标准材质朝阳面的亮度大致对上

export function defaultSettings(): GrassSettings {
  return {
    radius: 32,
    fullRadius: 6,
    height: 1,
    width: 1,
    windStrength: 0.55,
    windSpeed: 1,
    windDir: new THREE.Vector3(1, 0, 0.35).normalize(),
    flowers: 0.6,
    flowerRadius: 26,
    translucency: 1,
    dryness: 0.35,
    colors: { root: '#1e2d12', lush: '#3a6a20', fresh: '#6f9a2c', dry: '#a39350', tip: '#c9d46e', shadow: '#5f6aa8' },
  };
}

// CPU 和着色器共用的密度曲线：满密度半径以内是 1，往外按 (d0/d)² 降，最后 45% 再平滑降到 0
export function densityAt(d: number, fullRadius: number, radius: number): number {
  const near = Math.min(1, (fullRadius / Math.max(d, 1e-3)) ** 2);
  const t = THREE.MathUtils.clamp((d - radius * 0.55) / (radius * 0.45), 0, 1);
  return near * (1 - t * t * (3 - 2 * t));
}

// 一块瓦片要画几根才够：给最近距离处的密度，返回档位（0..3），一根都不用画时返回 -1
// 最大那块瓦片的面积（m²）：(弧长)²，留 2% 余量
export function tileAreaM2(radius: number, n = SphereTiles.sizeFor(radius)): number {
  return ((radius * Math.PI) / 2 / n) ** 2 * 1.02;
}

// 密度 1 时每块瓦片满密度的根数要乘的系数：让近处每平方米约 TARGET_DENSITY 根（不同星球半径的瓦片大小不同）
export function densityScaleFor(radius: number): number {
  return Math.min(1, (TARGET_DENSITY * tileAreaM2(radius)) / BLADES_PER_TILE);
}

export function bandFor(needed: number): number {
  if (needed < 0.5) return -1;
  if (needed > BAND_SIZES[1]) return 0;
  if (needed > BAND_SIZES[2]) return 1;
  if (needed > BAND_SIZES[3]) return 2;
  return 3;
}

// —— 星球上的瓦片：等角立方体球 ——
// 6 个面，每个面 n×n 块。面上一点 (a, b) ∈ [-1, 1]²（等角坐标）→ 方向 normalize(axis + tan(aπ/4)·U + tan(bπ/4)·V)。
// 瓦片在「面平面」上是个矩形，所以瓦片里的点可以写成 normalize(P0 + u·Ex + v·Ey)，u、v ∈ [0, 1]，着色器里一次归一化就够
const FACES: ReadonlyArray<{ axis: number[]; u: number[]; v: number[] }> = [
  { axis: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { axis: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { axis: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { axis: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { axis: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { axis: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]; // 每个面 U × V = axis（朝外），着色器里 cross(Ex, Ey) 就是朝外的法线方向

export class SphereTiles {
  readonly n: number; // 每个面每边几块
  readonly count: number;
  readonly center: Float32Array; // 瓦片中心方向（单位向量）
  readonly frame: Float32Array; // P0、Ex、Ey，每块 9 个数
  readonly spread: Float32Array; // 中心方向到四个角的最大夹角（弧度）
  readonly area: Float32Array; // 相对面积，最大的那块是 1
  readonly neighbors: Int32Array; // 每块 4 个邻居（跨面的按方向查）

  constructor(n: number) {
    this.n = n;
    this.count = 6 * n * n;
    this.center = new Float32Array(this.count * 3);
    this.frame = new Float32Array(this.count * 9);
    this.spread = new Float32Array(this.count);
    this.area = new Float32Array(this.count);
    this.neighbors = new Int32Array(this.count * 4);
    const ta = (k: number) => Math.tan(((-1 + (2 * k) / n) * Math.PI) / 4); // 第 k 条格线在面平面上的坐标
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const r = new THREE.Vector3();
    let maxArea = 0;
    for (let f = 0; f < 6; f++) {
      const { axis, u, v } = FACES[f];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const t = (f * n + j) * n + i;
          const x0 = ta(i);
          const x1 = ta(i + 1);
          const y0 = ta(j);
          const y1 = ta(j + 1);
          const o = t * 9;
          for (let k = 0; k < 3; k++) {
            this.frame[o + k] = axis[k] + x0 * u[k] + y0 * v[k];
            this.frame[o + 3 + k] = (x1 - x0) * u[k];
            this.frame[o + 6 + k] = (y1 - y0) * v[k];
          }
          this.dirAt(t, 0.5, 0.5, c);
          c.toArray(this.center, t * 3);
          let spread = 0;
          for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) spread = Math.max(spread, c.angleTo(this.dirAt(t, cu, cv, p)));
          this.spread[t] = spread;
          // 面积：四个角构成的两个三角形（弦长近似，瓦片很小时足够准）
          this.dirAt(t, 0, 0, p);
          this.dirAt(t, 1, 0, q).sub(p);
          this.dirAt(t, 0, 1, r).sub(p);
          const a1 = q.clone().cross(r).length() / 2;
          this.dirAt(t, 1, 1, r);
          this.dirAt(t, 1, 0, q);
          const s1 = q.clone().sub(r);
          this.dirAt(t, 0, 1, q).sub(r);
          const area = a1 + s1.cross(q).length() / 2;
          this.area[t] = area;
          maxArea = Math.max(maxArea, area);
        }
      }
    }
    for (let t = 0; t < this.count; t++) this.area[t] /= maxArea;
    // 邻居：面内直接加减；出了面就用延伸的等角坐标算出方向，再查它落在哪块
    const d = new THREE.Vector3();
    for (let f = 0; f < 6; f++) {
      const { axis, u, v } = FACES[f];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const t = (f * n + j) * n + i;
          const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (let s = 0; s < 4; s++) {
            const ii = i + steps[s][0];
            const jj = j + steps[s][1];
            if (ii >= 0 && ii < n && jj >= 0 && jj < n) {
              this.neighbors[t * 4 + s] = (f * n + jj) * n + ii;
              continue;
            }
            const x = Math.tan(((-1 + (2 * (ii + 0.5)) / n) * Math.PI) / 4);
            const y = Math.tan(((-1 + (2 * (jj + 0.5)) / n) * Math.PI) / 4);
            d.set(axis[0] + x * u[0] + y * v[0], axis[1] + x * u[1] + y * v[1], axis[2] + x * u[2] + y * v[2]);
            this.neighbors[t * 4 + s] = this.tileOf(d.x, d.y, d.z);
          }
        }
      }
    }
  }

  // 每个面每边几块：瓦片边长尽量接近 TILE_TARGET
  static sizeFor(radius: number): number {
    return Math.max(1, Math.round((radius * Math.PI) / 2 / TILE_TARGET));
  }

  // 方向（不必归一化）落在哪块瓦片
  tileOf(x: number, y: number, z: number): number {
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    let f: number;
    if (ax >= ay && ax >= az) f = x >= 0 ? 0 : 1;
    else if (ay >= az) f = y >= 0 ? 2 : 3;
    else f = z >= 0 ? 4 : 5;
    const { axis, u, v } = FACES[f];
    const da = x * axis[0] + y * axis[1] + z * axis[2];
    const a = (Math.atan((x * u[0] + y * u[1] + z * u[2]) / da) * 4) / Math.PI;
    const b = (Math.atan((x * v[0] + y * v[1] + z * v[2]) / da) * 4) / Math.PI;
    const n = this.n;
    const i = Math.min(n - 1, Math.max(0, Math.floor(((a + 1) / 2) * n)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(((b + 1) / 2) * n)));
    return (f * n + j) * n + i;
  }

  // 瓦片里参数 (u, v) 处的方向，写进 out
  dirAt(tile: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    const o = tile * 9;
    const fr = this.frame;
    return out.set(fr[o] + u * fr[o + 3] + v * fr[o + 6], fr[o + 1] + u * fr[o + 4] + v * fr[o + 7], fr[o + 2] + u * fr[o + 5] + v * fr[o + 8]).normalize();
  }
}

// —— 噪声体积贴图：4 个通道各是一层可平铺的梯度噪声，顶点着色器里一次采样拿到 4 个互不相关的噪声 ——
// 风、色斑、草高的起伏都从这里取，比在着色器里现算 3D 噪声便宜得多
const NOISE_SIZE = 32;
let noiseVolume: THREE.Data3DTexture | null = null;
let noiseUsers = 0;

export function buildNoiseVolume(): THREE.Data3DTexture {
  const S = NOISE_SIZE;
  const data = new Uint8Array(S * S * S * 4);
  const cellsPerChannel = [4, 4, 4, 2]; // 每个噪声格 8 个以上的纹素，三线性插值看不出折痕
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let ch = 0; ch < 4; ch++) {
    const C = cellsPerChannel[ch];
    const grads = new Float32Array(C * C * C * 3);
    for (let i = 0; i < C * C * C; i++) {
      const z = rnd() * 2 - 1;
      const phi = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      grads[i * 3] = Math.cos(phi) * s;
      grads[i * 3 + 1] = Math.sin(phi) * s;
      grads[i * 3 + 2] = z;
    }
    const g = (ix: number, iy: number, iz: number, fx: number, fy: number, fz: number) => {
      const k = ((((iz % C) + C) % C) * C + (((iy % C) + C) % C)) * C + (((ix % C) + C) % C);
      return grads[k * 3] * fx + grads[k * 3 + 1] * fy + grads[k * 3 + 2] * fz;
    };
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    for (let z = 0; z < S; z++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const px = (x / S) * C;
          const py = (y / S) * C;
          const pz = (z / S) * C;
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          const iz = Math.floor(pz);
          const fx = px - ix;
          const fy = py - iy;
          const fz = pz - iz;
          const u = fade(fx);
          const v = fade(fy);
          const w = fade(fz);
          const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
          const n = lerp(
            lerp(lerp(g(ix, iy, iz, fx, fy, fz), g(ix + 1, iy, iz, fx - 1, fy, fz), u), lerp(g(ix, iy + 1, iz, fx, fy - 1, fz), g(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u), v),
            lerp(lerp(g(ix, iy, iz + 1, fx, fy, fz - 1), g(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u), lerp(g(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), g(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u), v),
            w,
          );
          // 梯度噪声大致在 ±0.7 以内：映射到 0..1，几乎不会被截断
          data[((z * S + y) * S + x) * 4 + ch] = Math.round(THREE.MathUtils.clamp(n * 0.7 + 0.5, 0, 1) * 255);
        }
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, S, S, S);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function acquireNoise(): THREE.Data3DTexture {
  noiseVolume ??= buildNoiseVolume();
  noiseUsers++;
  return noiseVolume;
}

function releaseNoise(): void {
  noiseUsers--;
  if (noiseUsers <= 0 && noiseVolume) {
    noiseVolume.dispose();
    noiseVolume = null;
    noiseUsers = 0;
  }
}

// —— 几何：草叶和花 ——

// 一根草：每节两侧各一个顶点，尖上一个。position = (side, t, 0)：side 是 -1/0/1，t 是从根到尖 0..1
function bladeGeometry(segments: number): THREE.InstancedBufferGeometry {
  const levels = segments === 3 ? [0, 0.38, 0.72] : segments === 2 ? [0, 0.52] : [0];
  const pos: number[] = [];
  for (const t of levels) pos.push(-1, t, 0, 1, t, 0);
  pos.push(0, 1, 0);
  const index: number[] = [];
  for (let k = 0; k < segments - 1; k++) {
    const a = 2 * k;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const last = 2 * (segments - 1);
  index.push(last, last + 1, 2 * segments);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.instanceCount = 0;
  return geo;
}

// 一朵花：茎（一个四边形）+ 花头两个四边形（雏菊、毛茛只用第一个，平放；薰衣草两个竖着十字交叉）。
// position = (x, y, part)：part 0 是茎（x = ±1，y = 0/1），1、2 是花头（x、y ∈ ±1）
function flowerGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  for (const part of [0, 1, 2]) {
    if (part === 0) pos.push(-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0);
    else pos.push(-1, -1, part, 1, -1, part, -1, 1, part, 1, 1, part);
  }
  const index: number[] = [];
  for (let q = 0; q < 3; q++) {
    const a = q * 4;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.instanceCount = 0;
  return geo;
}

// —— 主体 ——

export function createGrassField(opts: GrassOptions): GrassField {
  const { planet } = opts;
  const settings = defaultSettings();
  const tiles = new SphereTiles(SphereTiles.sizeFor(planet.radius));
  const tileCount = tiles.count;
  // 每块瓦片的实际面积（m²）：最大那块是 (弧长)²；密度 1 时每平方米 TARGET_DENSITY 根
  const maxTileM2 = tileAreaM2(planet.radius, tiles.n);
  const densityScale = densityScaleFor(planet.radius);
  let density = THREE.MathUtils.clamp(opts.density ?? 1, 0.05, 1);

  // 槽位：最多同时缓存多少块瓦片的地面网格。按最远半径 60 m 的球冠估算，留余量，封顶 1024
  const capArea = 2 * Math.PI * planet.radius ** 2 * (1 - Math.cos(Math.min(Math.PI, 66 / planet.radius)));
  const SLOTS = Math.min(1024, Math.max(64, Math.ceil(((capArea / (maxTileM2 * 0.8)) * 1.3) / SLOTS_PER_LAYER) * SLOTS_PER_LAYER));
  const LAYERS = SLOTS / SLOTS_PER_LAYER;
  const AW = GRID * 2; // 每层 2×2 块瓦片

  // 地面网格：RG = (地面半径, 不长草的遮罩)。每块瓦片一个 9×9 的小块；只上传改过的层
  const atlasData = new Float32Array(AW * AW * LAYERS * 2);
  const atlas = new THREE.DataArrayTexture(atlasData, AW, AW, LAYERS);
  atlas.format = THREE.RGFormat;
  atlas.type = THREE.FloatType;
  atlas.minFilter = atlas.magFilter = THREE.NearestFilter;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;

  const slotOfTile = new Int32Array(tileCount).fill(-1);
  const tileOfSlot = new Int32Array(SLOTS).fill(-1);
  const slotSeen = new Int32Array(SLOTS).fill(-1); // 最近一次在预取范围里的帧号
  const slotBirth = new Float32Array(SLOTS);
  const slotRmin = new Float32Array(SLOTS);
  const slotRmax = new Float32Array(SLOTS);
  const stale = new Uint8Array(SLOTS); // refresh() 标记过、要原地重算的槽位（重算前照旧用老数据，不会整片消失）
  const visit = new Int32Array(tileCount).fill(-1);
  const queue = new Int32Array(tileCount);

  // 每档的绘制列表：每块瓦片 3 个 RGBA 浮点：(P0, 槽位)、(Ex, 瓦片编号)、(Ey, 密度倍数)
  const MAX_LIST = SLOTS;
  const makeList = () => {
    const data = new Float32Array(MAX_LIST * 3 * 4);
    const tex = new THREE.DataTexture(data, MAX_LIST, 3, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return { data, tex, len: 0, dirty: false };
  };
  const lists = BAND_SIZES.map(makeList);
  const flowerList = makeList();

  const noise = acquireNoise();

  // —— uniform ——
  const sunDir = new THREE.Vector3(0.2, 0.25, -1).normalize();
  const U = {
    time: uniform(0),
    windTime: uniform(0),
    gust: uniform(1),
    cam: uniform(new THREE.Vector3()), // 镜头（星球局部坐标）
    center: uniform(new THREE.Vector3()),
    density: uniform(density),
    fullRadius: uniform(settings.fullRadius),
    radius: uniform(settings.radius),
    flowerRadius: uniform(settings.flowerRadius),
    flowers: uniform(settings.flowers),
    pixelAngle: uniform(0.0005),
    sea: uniform(planet.sea ?? -1),
    heightScale: uniform(1),
    widthScale: uniform(1),
    windDir: uniform(new THREE.Vector3()),
    windStrength: uniform(settings.windStrength),
    translucency: uniform(1),
    dryness: uniform(settings.dryness),
    sunDir: uniform(sunDir.clone()),
    sunColor: uniform(new THREE.Color(1, 0.86, 0.66).multiplyScalar(2.2)),
    root: uniform(new THREE.Color()),
    lush: uniform(new THREE.Color()),
    fresh: uniform(new THREE.Color()),
    dry: uniform(new THREE.Color()),
    tip: uniform(new THREE.Color()),
    shadow: uniform(new THREE.Color()),
  };

  // —— 风 ——
  // 默认的风：两层顺着风向滚动的噪声相加（大的慢、小的快），乘一个缓慢的阵风包络（CPU 上算好的 U.gust）。
  // 时间是 windTime：按 dt × 速度 ×（0.4 + 强度）累加，风越大草浪推进越快
  const defaultWind: GrassWind = (posWorld) => {
    const q = posWorld.sub(U.center);
    const drift = U.windDir.mul(U.windTime);
    const n1 = texture3D(noise, q.mul(1 / 22).sub(drift.mul(1 / 22))).r.sub(0.5);
    const n2 = texture3D(noise, q.mul(1 / 60).sub(drift.mul(0.35 / 60))).g.sub(0.5);
    const gustField = n1.mul(1.3).add(n2.mul(1.6)).add(0.55).max(0);
    return U.windDir.mul(gustField.mul(U.windStrength).mul(U.gust));
  };
  const windAt: GrassWind = opts.wind ?? defaultWind;

  // 地面颜色：草从远处看的颜色，色斑和草叶共用一个噪声
  const patchColor = (q: N<'vec3'>) => {
    const patch = texture3D(noise, q.mul(1 / 75)).toVar();
    const hue = smoothstep(0.3, 0.72, patch.r);
    const dry = smoothstep(0.5, 0.78, patch.g).mul(U.dryness);
    return { patch, body: mix(mix(U.lush, U.fresh, hue), U.dry, dry) };
  };
  const groundTint = (posWorld: N<'vec3'>): N<'vec3'> => {
    const { body } = patchColor(posWorld.sub(U.center));
    return mix(body, U.tip, 0.25).mul(0.85);
  };

  // —— 着色器公用部分：从绘制列表和地面网格取出一根草（或一朵花）的根 ——
  const vN = varyingProperty('vec3', 'gN');
  const vUp = varyingProperty('vec3', 'gUp');
  const vPos = varyingProperty('vec3', 'gPos');
  const vAlbedo = varyingProperty('vec3', 'gAlbedo');
  const vT = varyingProperty('float', 'gT');
  const vUV = varyingProperty('vec3', 'gUV'); // 花：花头上的坐标 + 部位

  interface Root {
    dir: N<'vec3'>;
    radius: N<'float'>;
    mask: N<'float'>;
    normal: N<'vec3'>;
    scale: N<'float'>; // 瓦片的密度倍数（面积 × 淡入）
    seed: N<'uint'>;
  }

  // listTex 第 entry 项是哪块瓦片；index 是瓦片里的第几根（决定名次和哈希）
  const rootOf = (listTex: THREE.DataTexture, entry: N<'int'>, index: N<'uint'>, perTile: number, salt: number): Root => {
    const r0 = textureLoad(listTex, ivec2(entry, int(0))).toVar();
    const r1 = textureLoad(listTex, ivec2(entry, int(1))).toVar();
    const r2 = textureLoad(listTex, ivec2(entry, int(2))).toVar();
    const slot = int(r0.w).toVar();
    const seed = uint(r1.w).mul(uint(perTile)).add(index).mul(uint(16)).add(uint(salt)).toVar();
    const u = hash(seed).toVar();
    const v = hash(seed.add(uint(1))).toVar();
    const p = r0.xyz.add(r1.xyz.mul(u)).add(r2.xyz.mul(v)).toVar();
    const dir = normalize(p).toVar();
    // 地面网格双线性插值：同时得到半径对 u、v 的偏导，用来算地形法线
    const layer = slot.shiftRight(int(2));
    const qx = slot.bitAnd(int(1)).mul(int(GRID));
    const qy = slot.shiftRight(int(1)).bitAnd(int(1)).mul(int(GRID));
    const gx = u.mul(GRID - 1);
    const gy = v.mul(GRID - 1);
    const ix = int(min(floor(gx), GRID - 2)).toVar();
    const iy = int(min(floor(gy), GRID - 2)).toVar();
    const fx = gx.sub(float(ix)).toVar();
    const fy = gy.sub(float(iy)).toVar();
    const x0 = qx.add(ix);
    const y0 = qy.add(iy);
    const s00 = textureLoad(atlas, ivec2(x0, y0)).depth(layer).toVar();
    const s10 = textureLoad(atlas, ivec2(x0.add(int(1)), y0)).depth(layer).toVar();
    const s01 = textureLoad(atlas, ivec2(x0, y0.add(int(1)))).depth(layer).toVar();
    const s11 = textureLoad(atlas, ivec2(x0.add(int(1)), y0.add(int(1)))).depth(layer).toVar();
    const top = mix(s00.xy, s10.xy, fx);
    const bottom = mix(s01.xy, s11.xy, fx);
    const g = mix(top, bottom, fy).toVar();
    const drdu = mix(s10.x.sub(s00.x), s11.x.sub(s01.x), fy).mul(GRID - 1);
    const drdv = mix(s01.x.sub(s00.x), s11.x.sub(s10.x), fx).mul(GRID - 1);
    // S(u, v) = dir · r：∂S/∂u = (Ex - dir (dir·Ex)) / |P| · r + dir · ∂r/∂u
    const invLen = float(1).div(length(p));
    const ex = r1.xyz;
    const ey = r2.xyz;
    const su = ex.sub(dir.mul(dot(dir, ex))).mul(invLen).mul(g.x).add(dir.mul(drdu));
    const sv = ey.sub(dir.mul(dot(dir, ey))).mul(invLen).mul(g.x).add(dir.mul(drdv));
    const normal = normalize(cross(su, sv)).toVar();
    return { dir, radius: g.x, mask: g.y, normal, scale: r2.w, seed };
  };

  // 名次淡出：密度 φ 小于名次的缩成 0，名次在 [0.7φ, φ] 之间的按比例变矮
  const rankScale = (phi: N<'float'>, rank: N<'float'>) => saturate(phi.sub(rank).div(phi.mul(0.3).add(1e-5)));
  const densityNode = (d: N<'float'>, full: N<'float'>, radius: N<'float'>) => {
    const near = min(float(1), full.div(max(d, 1e-3)).pow(2));
    return near.mul(float(1).sub(smoothstep(radius.mul(0.55), radius, d)));
  };
  // 切平面的一组基（世界固定的，不随镜头变）
  const tangentBasis = (up: N<'vec3'>) => {
    const ref = select(abs(up.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
    const e1 = normalize(cross(up, ref)).toVar();
    const e2 = cross(up, e1).toVar();
    return { e1, e2 };
  };

  const trample = opts.trample;
  // 踩草：返回 (压倒方向 × 强度)，切向量
  const trampleBend = (dir: N<'vec3'>, e1: N<'vec3'>, e2: N<'vec3'>, facing: N<'vec3'>): { push: N<'vec3'>; amount: N<'float'> } | null => {
    if (!trample) return null;
    const sample = texture(trample.texture, trample.uvOf(dir)).toVar();
    const amount = saturate(sample.r).toVar();
    let push: N<'vec3'>;
    if (trample.bendDir) push = trample.bendDir(sample, dir);
    else {
      // 亮度梯度：在切平面上偏 15 cm 各采一次，草朝变暗的方向（远离踩痕中心）倒
      const eps = 0.15 / planet.radius;
      const a1 = texture(trample.texture, trample.uvOf(normalize(dir.add(e1.mul(eps))))).r;
      const a2 = texture(trample.texture, trample.uvOf(normalize(dir.add(e2.mul(eps))))).r;
      const grad = e1.mul(a1.sub(amount)).add(e2.mul(a2.sub(amount)));
      push = normalize(grad.negate().add(facing.mul(0.02)));
    }
    return { push, amount };
  };

  // —— 草叶材质（每档一个） ——
  const makeBladeMaterial = (band: number): THREE.MeshBasicNodeMaterial => {
    const per = BAND_SIZES[band];
    const shift = Math.round(Math.log2(per));
    const listTex = lists[band].tex;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    m.lights = false;

    m.positionNode = Fn(() => {
      const entry = int(instanceIndex.shiftRight(uint(shift)));
      const j = instanceIndex.bitAnd(uint(per - 1));
      const root = rootOf(listTex, entry, j, BLADES_PER_TILE, 0);
      const base = root.dir.mul(root.radius.sub(SINK)).toVar();
      const dist = length(base.sub(U.cam)).toVar();
      const rank = float(j).add(0.5).div(BLADES_PER_TILE);
      const phi = U.density.mul(densityNode(dist, U.fullRadius, U.radius)).mul(root.scale);
      const sea = smoothstep(U.sea.add(0.04), U.sea.add(0.2), root.radius);
      const scale = rankScale(phi, rank).mul(float(1).sub(smoothstep(0.3, 0.55, root.mask))).mul(sea).toVar();
      const out = base.toVar();

      If(scale.greaterThan(0.002), () => {
        const s = (k: number) => hash(root.seed.add(uint(k)));
        const t = positionGeometry.y;
        const side = positionGeometry.x;
        // 朝上：径向，稍微跟一点地形法线（坡上的草不会完全垂直于坡面，也不会完全不理坡面）
        const up = normalize(mix(root.dir, root.normal, 0.3)).toVar();
        const { e1, e2 } = tangentBasis(up);
        const ang = s(2).mul(Math.PI * 2);
        const facing = e1.mul(cos(ang)).add(e2.mul(sin(ang))).toVar();
        const across = cross(up, facing).toVar();
        // 色斑、草高起伏：大片的高矮（几十米）× 一丛一丛的高矮（不到 1 m）
        const q = base;
        const { patch, body } = patchColor(q);
        const tuft = texture3D(noise, q.mul(1 / 3.2)).r;
        const tall = mix(0.72, 1.28, patch.b).mul(mix(0.55, 1.3, smoothstep(0.25, 0.75, tuft)));
        // 约 4% 是细长的草茎，高出草面一截（参考图里零星戳出来的那些）
        const stalk = s(10).lessThan(0.04);
        const h = mix(HEIGHT_MIN, HEIGHT_MAX, pow(s(3), 1.3)).mul(tall).mul(select(stalk, float(1.7), float(1))).mul(U.heightScale).toVar();
        const hRel = h.div(HEIGHT_MAX);
        // 远处加宽（补偿变稀），而且不细于约 0.9 个像素
        const widen = min(max(dist.div(U.fullRadius), 1), 2.2);
        const w = max(mix(WIDTH_MIN, WIDTH_MAX, s(4)).mul(select(stalk, float(0.55), float(1))).mul(U.widthScale).mul(widen), dist.mul(U.pixelAngle).mul(0.9)).toVar();
        // 弯曲：自身的倾斜 + 风（投影到切平面）+ 小抖动 + 踩草
        const lean = mix(0.1, 0.62, s(5)).mul(select(stalk, float(0.4), float(1)));
        const wind = windAt(base.add(U.center), U.time).toVar();
        const windT = wind.sub(up.mul(dot(wind, up))).toVar();
        const flutter = sin(U.windTime.mul(mix(5.0, 9.0, s(6))).add(s(7).mul(Math.PI * 2))).mul(0.07).mul(length(windT).add(0.2));
        const bend = facing.mul(lean).add(windT.mul(mix(0.7, 1.5, hRel))).add(across.mul(flutter)).toVar();
        const height = h.mul(scale).toVar();
        const tb = trampleBend(root.dir, e1, e2, facing);
        if (tb) {
          bend.addAssign(tb.push.mul(tb.amount.mul(2.2)));
          height.mulAssign(float(1).sub(tb.amount.mul(0.35)));
        }
        const theta = min(max(length(bend), 0.02), MAX_BEND).toVar();
        const bdir = normalize(bend.add(facing.mul(1e-4))).toVar();
        // 中心线是一段圆弧：总长 = 草高，草尖偏离竖直 θ（根部竖直，越往上弯得越多）
        const th = theta.mul(t);
        const along = height.mul(sin(th)).div(theta);
        const outward = height.mul(float(1).sub(cos(th))).div(theta);
        const halfW = w.mul(scale.mul(0.5).add(0.5)).mul(0.5).mul(pow(float(1).sub(t), 0.55));
        out.assign(base.add(up.mul(along)).add(bdir.mul(outward)).add(across.mul(side.mul(halfW))));
        // 法线：叶面法线，左右两半各往外偏一点，像有弧度的叶片
        const tangent = up.mul(cos(th)).add(bdir.mul(sin(th)));
        const n0 = normalize(cross(across, tangent));
        vN.assign(normalize(n0.add(across.mul(side.mul(0.45)))));
        vUp.assign(up);
        vPos.assign(out.add(U.center));
        vT.assign(t);
        // 颜色：根暗、中段是色斑决定的草色、尖亮偏暖；每根草明暗和色相有一点随机
        // 每根草：明暗 0.7–1.2 倍，色相往嫩绿或深绿偏一点，少数偏黄（老叶）
        const vary = mix(0.7, 1.2, s(8));
        const hueShift = s(9);
        const bodyC = mix(mix(body, U.lush, saturate(float(0.5).sub(hueShift)).mul(0.8)), mix(U.fresh, U.dry, 0.35), saturate(hueShift.sub(0.6)).mul(1.1)).mul(vary);
        const tipC = mix(bodyC, U.tip, 0.45);
        vAlbedo.assign(mix(mix(U.root, bodyC, smoothstep(0.0, 0.45, t)), tipC, smoothstep(0.45, 1.0, t)));
      });
      return out;
    })();

    m.colorNode = Fn(() => {
      const n = normalize(vN).mul(faceDirection);
      const up = normalize(vUp);
      const nl = normalize(mix(n, up, 0.55)); // 法线往上偏：草和地面受光接近，不会一根一根地亮暗跳
      const l = U.sunDir;
      const ndl = dot(nl, l);
      // 明暗交界：smoothstep 得到「在阴影里」的程度；根部被周围的草挡住
      const core = smoothstep(0.32, -0.12, ndl);
      const deep = float(1).sub(smoothstep(0.0, 0.8, vT)).mul(0.9);
      const shade = max(core, deep);
      // 受光 = 底色 ×（太阳 + 一点天光）；阴影 = 底色 × 偏蓝紫的阴影色（暖光冷影，不是变黑）
      const lit = vAlbedo.mul(U.sunColor.mul(SUN_RESPONSE).add(U.shadow.mul(0.25)));
      const shadowed = vAlbedo.mul(U.shadow);
      const col = mix(lit, shadowed, shade).toVar();
      // 根部有一点地面反弹上来的绿光
      col.addAssign(U.lush.mul(0.12).mul(float(1).sub(vT).pow(2)));
      // 逆光：看向太阳时草尖透光发亮（叶子薄，透过来的光带着叶色，偏黄绿）
      const toCam = normalize(cameraPosition.sub(vPos));
      const back = pow(saturate(dot(toCam.negate(), l)), 4);
      const thin = pow(smoothstep(0.3, 1.0, vT), 1.5);
      const glow = mix(vAlbedo, U.tip, 0.6).mul(U.sunColor).mul(back.mul(1.9).add(saturate(ndl.negate()).mul(0.2)));
      col.addAssign(glow.mul(thin).mul(U.translucency));
      // 叶面的蜡质反光：迎着太阳的叶子上有一道亮光（不在阴影里时才有）
      const refl = l.negate().sub(n.mul(dot(l.negate(), n).mul(2)));
      const spec = pow(saturate(dot(refl, toCam)), 18).mul(0.35).mul(float(1).sub(shade)).mul(smoothstep(0.2, 0.7, vT));
      col.addAssign(U.sunColor.mul(spec).mul(mix(vec3(1), vAlbedo.mul(3), 0.5)));
      // 远处去饱和一点，作空气透视
      const d = length(cameraPosition.sub(vPos));
      const fade = smoothstep(U.fullRadius.mul(1.5), U.radius, d).mul(0.3);
      return mix(col, vec3(luminance(col)), fade);
    })();
    return m;
  };

  // —— 花的材质 ——
  const makeFlowerMaterial = (): THREE.MeshBasicNodeMaterial => {
    const per = FLOWERS_PER_TILE;
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    m.lights = false;
    const vKind = varyingProperty('float', 'fKind');
    m.positionNode = Fn(() => {
      const entry = int(instanceIndex.div(uint(per)));
      const j = instanceIndex.sub(uint(entry).mul(uint(per)));
      const root = rootOf(flowerList.tex, entry, j, per, 7);
      const base = root.dir.mul(root.radius.sub(SINK)).toVar();
      const dist = length(base.sub(U.cam)).toVar();
      const q = base;
      const s = (k: number) => hash(root.seed.add(uint(k)));
      // 成片：一层低频噪声决定这里是不是花片，另一层决定花片以什么为主（雏菊或薰衣草），毛茛零星混在两种花片里；片外只有很少几朵
      const p = texture3D(noise, q.mul(1 / 30).add(vec3(0.37, 0.11, 0.73))).toVar();
      const patchy = smoothstep(0.47, 0.66, p.r);
      const daisyLed = smoothstep(0.35, 0.65, p.g);
      const pDaisy = mix(0.15, 0.7, daisyLed);
      const pButter = mix(0.35, 0.2, daisyLed);
      const pick = s(11);
      const kind = select(pick.lessThan(pDaisy), float(0), select(pick.lessThan(pDaisy.add(pButter)), float(1), float(2))).toVar();
      const accept = U.flowers.mul(patchy.mul(0.9).add(0.035)).mul(root.scale);
      const fade = float(1).sub(smoothstep(U.flowerRadius.mul(0.6), U.flowerRadius, dist));
      const sea = smoothstep(U.sea.add(0.04), U.sea.add(0.2), root.radius);
      const scale = rankScale(accept.mul(fade), s(1)).mul(float(1).sub(smoothstep(0.25, 0.5, root.mask))).mul(sea).toVar();
      const out = base.toVar();
      If(scale.greaterThan(0.01), () => {
        const part = positionGeometry.z;
        const gx = positionGeometry.x;
        const gy = positionGeometry.y;
        const up = normalize(mix(root.dir, root.normal, 0.2)).toVar();
        const { e1, e2 } = tangentBasis(up);
        const ang = s(2).mul(Math.PI * 2);
        const facing = e1.mul(cos(ang)).add(e2.mul(sin(ang))).toVar();
        const across = cross(up, facing).toVar();
        // 花比草高一点，这样能从草里露出来
        const stemH = mix(0.24, 0.5, s(3)).mul(U.heightScale).mul(scale).toVar();
        const wind = windAt(base.add(U.center), U.time);
        const windT = wind.sub(up.mul(dot(wind, up)));
        const bend = facing.mul(mix(0.05, 0.25, s(4))).add(windT.mul(0.9)).toVar();
        const theta = min(max(length(bend), 0.02), 1.1).toVar();
        const bdir = normalize(bend.add(facing.mul(1e-4))).toVar();
        const arc = (t: N<'float'>) => up.mul(stemH.mul(sin(theta.mul(t))).div(theta)).add(bdir.mul(stemH.mul(float(1).sub(cos(theta.mul(t)))).div(theta)));
        const top = base.add(arc(float(1))).toVar();
        const stemDir = up.mul(cos(theta)).add(bdir.mul(sin(theta))).toVar();
        const pixel = dist.mul(U.pixelAngle);
        // 茎
        const stemW = max(float(0.0035), pixel.mul(0.7));
        const stemPos = base.add(arc(gy)).add(across.mul(gx.mul(stemW).mul(0.5)));
        // 花头：雏菊、毛茛是朝上（稍微朝外歪）的圆盘；薰衣草是沿茎的长穗，两片十字交叉
        const isSpike = kind.greaterThan(1.5);
        const discR = select(kind.lessThan(0.5), mix(0.03, 0.045, s(5)), mix(0.017, 0.025, s(5))).mul(scale.mul(0.4).add(0.6));
        const discR2 = max(discR, pixel.mul(1.2));
        // 花盘朝太阳歪（向日性）再加一点随机，低角度看过去不会全是一条线
        const sunT = U.sunDir.sub(up.mul(dot(U.sunDir, up)));
        const tiltDir = sunT.mul(0.9).add(facing.mul(mix(0.1, 0.55, s(6))));
        const hn = normalize(stemDir.add(tiltDir)).toVar();
        const hb = tangentBasis(hn);
        const discPos = top.add(hb.e1.mul(gx.mul(discR2))).add(hb.e2.mul(gy.mul(discR2))).add(hn.mul(0.004));
        const spikeLen = mix(0.08, 0.15, s(7)).mul(scale);
        const spikeW = max(mix(0.014, 0.02, s(8)), pixel.mul(1.2));
        const crossAxis = select(part.greaterThan(1.5), facing, across);
        // 穗子比茎更直：往径向上方掰回来一些，不会被风吹成横躺的一串
        const spikeDir = normalize(mix(stemDir, up, 0.6)).toVar();
        const spikePos = top.add(spikeDir.mul(gy.add(1).mul(0.5).mul(spikeLen))).add(crossAxis.mul(gx.mul(spikeW)));
        const headPos = select(isSpike, spikePos, select(part.lessThan(1.5), discPos, top));
        out.assign(select(part.lessThan(0.5), stemPos, headPos));
        vN.assign(select(part.lessThan(0.5).or(isSpike), normalize(cross(across, stemDir)), hn));
        vUp.assign(up);
        vPos.assign(out.add(U.center));
        vT.assign(select(part.lessThan(0.5), gy, float(1)));
        vUV.assign(vec3(gx, gy, part));
        vKind.assign(kind);
        vAlbedo.assign(mix(U.root, mix(U.lush, U.fresh, 0.3), gy.mul(0.8)));
      });
      return out;
    })();

    m.colorNode = Fn(() => {
      const uv = vUV.xy;
      const part = vUV.z;
      const r = length(uv);
      const a = uv.y.atan(uv.x);
      const kind = vKind;
      const white = vec3(0.92, 0.9, 0.84);
      const yellow = vec3(0.98, 0.72, 0.08);
      const centre = vec3(0.95, 0.62, 0.05);
      const lilac = vec3(0.36, 0.22, 0.72);
      // 雏菊：13 片花瓣，花心黄；毛茛：5 片圆花瓣；薰衣草：一串小花苞
      const daisyEdge = mix(0.55, 1.0, pow(abs(cos(a.mul(6.5))), 0.5));
      const butterEdge = mix(0.68, 1.0, pow(abs(cos(a.mul(2.5))), 0.7));
      const along = uv.y.mul(0.5).add(0.5);
      const bud = abs(along.mul(11).add(uv.x.mul(0.6)).fract().sub(0.5)).mul(2); // 一串错开的小花苞
      const spikeW = mix(0.8, 0.3, along).mul(float(1).sub(bud.pow(3).mul(0.3)));
      const keep = select(
        part.lessThan(0.5),
        float(1),
        select(kind.lessThan(0.5), daisyEdge.sub(r), select(kind.lessThan(1.5), butterEdge.sub(r), spikeW.sub(abs(uv.x)))),
      );
      keep.lessThan(0).discard();
      const petal = select(kind.lessThan(0.5), select(r.lessThan(0.28), centre, white.mul(mix(0.85, 1.0, r))), select(kind.lessThan(1.5), select(r.lessThan(0.25), centre.mul(0.8), yellow), lilac.mul(mix(0.75, 1.1, bud))));
      const base = select(part.lessThan(0.5), vAlbedo, petal).toVar();
      const n = normalize(vN).mul(faceDirection);
      const up = normalize(vUp);
      const nl = normalize(mix(n, up, 0.4));
      const l = U.sunDir;
      const ndl = dot(nl, l);
      const core = smoothstep(0.3, -0.15, ndl);
      const deep = select(part.lessThan(0.5), float(1).sub(smoothstep(0.0, 0.8, vT)).mul(0.85), float(0));
      const col = mix(base.mul(U.sunColor), base.mul(U.shadow), max(core, deep)).toVar();
      const toCam = normalize(cameraPosition.sub(vPos));
      const back = pow(saturate(dot(toCam.negate(), l)), 3);
      col.addAssign(base.mul(U.sunColor).mul(back.mul(0.9)).mul(U.translucency).mul(select(part.lessThan(0.5), float(0.3), float(1))));
      return col;
    })();
    return m;
  };

  // —— 网格 ——
  const object = new THREE.Group();
  object.name = 'grass';
  const bandMeshes = BAND_SIZES.map((_, b) => {
    const mesh = new THREE.Mesh(bladeGeometry(BAND_SEGMENTS[b]), makeBladeMaterial(b));
    mesh.name = `grass-band-${b}`;
    mesh.frustumCulled = false; // 位置全在着色器里算，几何体自己的包围球没有意义；视锥剔除在 CPU 上按瓦片做
    mesh.renderOrder = b; // 近的档先画，后面被挡住的片元能早一点被深度测试丢掉
    object.add(mesh);
    return mesh;
  });
  const flowerMesh = new THREE.Mesh(flowerGeometry(), makeFlowerMaterial());
  flowerMesh.name = 'grass-flowers';
  flowerMesh.frustumCulled = false;
  object.add(flowerMesh);
  const trianglesPerBlade = BAND_SEGMENTS.map((s) => 2 * s - 1);

  const stats: GrassStats = { tiles: 0, bands: [0, 0, 0, 0], instances: 0, flowerInstances: 0, triangles: 0, drawCalls: 0, cachedTiles: 0, generated: 0 };

  // —— 每帧 ——
  const tmpDir = new THREE.Vector3();
  const camWorld = new THREE.Vector3();
  const camLocal = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const bufferSize = new THREE.Vector2();
  let frame = 0;
  let lastTime = -1;
  let clock = 0; // 单调时钟（秒）：瓦片淡入用，不受外面传进来的时间回退影响
  let windTime = 0;
  let maxRelief = planet.radius * 0.05; // 地形起伏的估计，算过的瓦片越多越准
  let reliefKnown = false;

  // 给槽位找主人：先用空的，再用最久没在范围里的
  const takeSlot = (): number => {
    let best = -1;
    let bestSeen = Infinity;
    for (let s = 0; s < SLOTS; s++) {
      if (tileOfSlot[s] < 0) return s;
      if (slotSeen[s] < bestSeen && slotSeen[s] < frame) {
        bestSeen = slotSeen[s];
        best = s;
      }
    }
    return best;
  };

  // 算一块瓦片的地面网格，写进它的槽位（数组贴图里那一层的一个角）
  const fill = (slot: number, tile: number) => {
    const layer = slot >> 2;
    const qx = (slot & 1) * GRID;
    const qy = ((slot >> 1) & 1) * GRID;
    let rMin = Infinity;
    let rMax = -Infinity;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        tiles.dirAt(tile, gx / (GRID - 1), gy / (GRID - 1), tmpDir);
        const r = planet.height(tmpDir);
        let mask = 0;
        if (opts.exclude) {
          tiles.dirAt(tile, gx / (GRID - 1), gy / (GRID - 1), tmpDir);
          mask = THREE.MathUtils.clamp(opts.exclude(tmpDir), 0, 1);
        }
        const k = ((layer * AW + qy + gy) * AW + qx + gx) * 2;
        atlasData[k] = r;
        atlasData[k + 1] = mask;
        rMin = Math.min(rMin, r);
        rMax = Math.max(rMax, r);
      }
    }
    slotRmin[slot] = rMin;
    slotRmax[slot] = rMax;
    stale[slot] = 0;
    const relief = Math.max(Math.abs(rMax - planet.radius), Math.abs(rMin - planet.radius));
    maxRelief = reliefKnown ? Math.max(maxRelief, relief) : relief;
    reliefKnown = true;
    atlas.addLayerUpdate(layer);
    atlas.needsUpdate = true;
  };

  // 新进来的瓦片：找个槽位，算地面网格
  const generate = (tile: number): boolean => {
    const slot = takeSlot();
    if (slot < 0) return false;
    const old = tileOfSlot[slot];
    if (old >= 0) slotOfTile[old] = -1;
    tileOfSlot[slot] = tile;
    slotOfTile[tile] = slot;
    slotSeen[slot] = frame;
    // 第一帧算的瓦片直接长满（没有可以「跳出来」的东西）；之后进来的瓦片用 BIRTH_FADE 秒按名次长出来
    slotBirth[slot] = frame === 1 ? clock - BIRTH_FADE : clock;
    fill(slot, tile);
    return true;
  };

  // 写绘制列表的一项（热路径：不建闭包、不建对象）。值没变就不标记上传
  const writeEntry = (list: (typeof lists)[number], entry: number, slot: number, tile: number) => {
    // 瓦片的密度倍数：面积（让每平方米的草一样多）× 新瓦片的淡入
    const scale = tiles.area[tile] * Math.min(1, (clock - slotBirth[slot]) / BIRTH_FADE);
    const d = list.data;
    const fr = tiles.frame;
    const o = tile * 9;
    const row = MAX_LIST * 4;
    const i0 = entry * 4;
    let changed = false;
    for (let r = 0; r < 3; r++) {
      const k = r * row + i0;
      const a = fr[o + r * 3];
      const b = fr[o + r * 3 + 1];
      const c = fr[o + r * 3 + 2];
      const w = r === 0 ? slot : r === 1 ? tile : scale;
      if (d[k] !== a || d[k + 1] !== b || d[k + 2] !== c || d[k + 3] !== w) {
        d[k] = a;
        d[k + 1] = b;
        d[k + 2] = c;
        d[k + 3] = w;
        changed = true;
      }
    }
    if (changed) list.dirty = true;
  };

  // 颜色字符串变了才重新解析（不每帧拼字符串）
  const colorsSeen = { root: '', lush: '', fresh: '', dry: '', tip: '', shadow: '' };
  const syncColor = (key: keyof typeof colorsSeen) => {
    const v = settings.colors[key];
    if (v !== colorsSeen[key]) {
      colorsSeen[key] = v;
      U[key].value.set(v);
    }
  };
  const applySettings = () => {
    U.fullRadius.value = settings.fullRadius;
    U.radius.value = settings.radius;
    U.flowerRadius.value = settings.flowerRadius;
    U.flowers.value = settings.flowers;
    U.heightScale.value = settings.height;
    U.widthScale.value = settings.width;
    U.windStrength.value = settings.windStrength;
    U.translucency.value = settings.translucency;
    U.dryness.value = settings.dryness;
    U.windDir.value.copy(settings.windDir).normalize();
    U.sea.value = planet.sea ?? -1;
    syncColor('root');
    syncColor('lush');
    syncColor('fresh');
    syncColor('dry');
    syncColor('tip');
    syncColor('shadow');
  };

  const clearLists = () => {
    for (const mesh of bandMeshes) (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    (flowerMesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    stats.tiles = stats.instances = stats.flowerInstances = stats.triangles = stats.drawCalls = 0;
    stats.bands.fill(0);
  };

  // 视锥的 6 个平面 (nx, ny, nz, d)，每帧从 THREE.Frustum 抄一次；逐块测试只读这个数组，不往 Vector3 里写（V8 里写 Vector3 的字段会装箱分配）
  const planes = new Float64Array(24);

  function update(camera: THREE.Camera, timeSec: number): void {
    frame++;
    const dt = lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, timeSec - lastTime));
    lastTime = timeSec;
    clock += dt;
    applySettings();
    windTime += dt * settings.windSpeed * (0.4 + settings.windStrength);
    U.time.value = timeSec;
    U.windTime.value = windTime;
    // 阵风包络：两个很慢的正弦相乘，整片草地一阵紧一阵松
    U.gust.value = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(clock * 0.31)) * (0.6 + 0.4 * Math.sin(clock * 0.17 + 2.1));
    U.density.value = density * densityScale;
    object.position.copy(planet.center);
    U.center.value.copy(planet.center);

    camera.updateMatrixWorld();
    camWorld.setFromMatrixPosition(camera.matrixWorld);
    camLocal.copy(camWorld).sub(planet.center);
    U.cam.value.copy(camLocal);
    const lx = camLocal.x;
    const ly = camLocal.y;
    const lz = camLocal.z;
    const camDist = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (camDist < 1e-6) {
      clearLists();
      return;
    }
    const ux = lx / camDist;
    const uy = ly / camDist;
    const uz = lz / camDist;
    // 每像素对应的视角：远处的草不细于约 1 个像素
    opts.renderer.getDrawingBufferSize(bufferSize);
    const persp = camera as THREE.PerspectiveCamera;
    const fov = persp.isPerspectiveCamera ? (persp.getEffectiveFOV() * Math.PI) / 180 : 1;
    U.pixelAngle.value = fov / Math.max(1, bufferSize.y);

    const radius = settings.radius;
    const flowerRadius = settings.flowerRadius;
    const fullRadius = settings.fullRadius;
    const prefetch = radius + 8;
    const groundR = planet.radius;
    if (camDist - (groundR + maxRelief) > prefetch) {
      clearLists();
      return;
    }
    // 球冠：星球上到镜头距离不超过 prefetch 的点（地形起伏留余量）
    const capCos = (groundR * groundR + camDist * camDist - prefetch * prefetch) / (2 * groundR * camDist);
    const capAngle = Math.acos(Math.min(1, Math.max(-1, capCos))) + maxRelief / groundR;

    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
    // 平面换到星球局部坐标：n·(p + center) + d = n·p + (d + n·center)
    const pcx = planet.center.x;
    const pcy = planet.center.y;
    const pcz = planet.center.z;
    for (let i = 0; i < 6; i++) {
      const p = frustum.planes[i];
      planes[i * 4] = p.normal.x;
      planes[i * 4 + 1] = p.normal.y;
      planes[i * 4 + 2] = p.normal.z;
      planes[i * 4 + 3] = p.constant + p.normal.x * pcx + p.normal.y * pcy + p.normal.z * pcz;
    }

    for (let b = 0; b < lists.length; b++) lists[b].len = 0;
    flowerList.len = 0;
    stats.generated = 0;
    const genStart = performance.now();
    const firstFrame = frame === 1;
    const flowerOn = settings.flowers > 0;
    // 最高的草：最高 0.45 m × 大片起伏 1.28 × 一丛 1.3 × 草茎 1.7 ≈ 1.27 m（倒向一侧时伸出去也不超过这个长度）
    const bladeReach = HEIGHT_MAX * 1.28 * 1.3 * 1.7 * settings.height + 0.05;
    const fullDensity = density * densityScale * BLADES_PER_TILE;

    // 从镜头脚下的瓦片开始广度优先，大致由近到远
    const start = tiles.tileOf(ux, uy, uz);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visit[start] = frame;
    const tc = tiles.center;
    while (head < tail) {
      const t = queue[head++];
      const cx = tc[t * 3];
      const cy = tc[t * 3 + 1];
      const cz = tc[t * 3 + 2];
      const ang = Math.acos(Math.min(1, Math.max(-1, cx * ux + cy * uy + cz * uz)));
      if (ang - tiles.spread[t] > capAngle && t !== start) continue;
      for (let k = 0; k < 4; k++) {
        const nb = tiles.neighbors[t * 4 + k];
        if (visit[nb] !== frame) {
          visit[nb] = frame;
          queue[tail++] = nb;
        }
      }
      let slot = slotOfTile[t];
      if (slot < 0) {
        if (!firstFrame && performance.now() - genStart > GEN_BUDGET_MS) continue;
        if (!generate(t)) continue;
        stats.generated++;
        slot = slotOfTile[t];
      } else if (stale[slot] && (firstFrame || performance.now() - genStart <= GEN_BUDGET_MS)) {
        // refresh() 之后：原地重算，不换槽位、不重新淡入
        fill(slot, t);
        stats.generated++;
      }
      slotSeen[slot] = frame;
      // 瓦片到镜头的最近距离（偏小，保证名次淡出的那几根也画到）
      const rMin = slotRmin[slot];
      const rMax = slotRmax[slot];
      const rMid = (rMin + rMax) / 2;
      const slack = tiles.spread[t] * rMax + (rMax - rMin) / 2 + 0.1;
      const dx = cx * rMid - lx;
      const dy = cy * rMid - ly;
      const dz = cz * rMid - lz;
      const dNear = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - slack);
      if (dNear >= radius && (!flowerOn || dNear >= flowerRadius)) continue;
      // 视锥：包围球（瓦片 + 起伏 + 草高）在某个平面外侧就跳过
      const sx = cx * rMid;
      const sy = cy * rMid;
      const sz = cz * rMid;
      const sr = slack + bladeReach;
      let inside = true;
      for (let i = 0; i < 24; i += 4) {
        if (planes[i] * sx + planes[i + 1] * sy + planes[i + 2] * sz + planes[i + 3] < -sr) {
          inside = false;
          break;
        }
      }
      if (!inside) continue;
      // 和 densityAt() 同一条曲线（这里内联，不让浮点数跨函数传递）
      const nearD = Math.max(dNear, 1e-3);
      const near = Math.min(1, (fullRadius / nearD) * (fullRadius / nearD));
      const ft = Math.min(1, Math.max(0, (dNear - radius * 0.55) / (radius * 0.45)));
      const birth = Math.min(1, (clock - slotBirth[slot]) / BIRTH_FADE);
      const needed = fullDensity * near * (1 - ft * ft * (3 - 2 * ft)) * tiles.area[t] * birth;
      const band = bandFor(needed);
      if (band >= 0 && lists[band].len < MAX_LIST) writeEntry(lists[band], lists[band].len++, slot, t);
      if (flowerOn && dNear < flowerRadius && flowerList.len < MAX_LIST) writeEntry(flowerList, flowerList.len++, slot, t);
    }

    // 实例数、上传改过的列表
    stats.tiles = 0;
    stats.instances = 0;
    stats.triangles = 0;
    stats.drawCalls = 0;
    for (let b = 0; b < lists.length; b++) {
      const l = lists[b];
      if (l.dirty) {
        l.tex.needsUpdate = true;
        l.dirty = false;
      }
      const n = l.len * BAND_SIZES[b];
      (bandMeshes[b].geometry as THREE.InstancedBufferGeometry).instanceCount = n;
      stats.bands[b] = l.len;
      stats.tiles += l.len;
      stats.instances += n;
      stats.triangles += n * trianglesPerBlade[b];
      if (n > 0) stats.drawCalls++;
    }
    if (flowerList.dirty) {
      flowerList.tex.needsUpdate = true;
      flowerList.dirty = false;
    }
    const fn = flowerOn ? flowerList.len * FLOWERS_PER_TILE : 0;
    (flowerMesh.geometry as THREE.InstancedBufferGeometry).instanceCount = fn;
    stats.flowerInstances = fn;
    stats.triangles += fn * 6;
    if (fn > 0) stats.drawCalls++;
    let cached = 0;
    for (let s = 0; s < SLOTS; s++) if (tileOfSlot[s] >= 0) cached++;
    stats.cachedTiles = cached;
  }

  function setSun(dir: THREE.Vector3, color?: THREE.ColorRepresentation, intensity?: number): void {
    U.sunDir.value.copy(dir).normalize();
    if (color !== undefined) U.sunColor.value.set(color);
    if (intensity !== undefined) U.sunColor.value.multiplyScalar(intensity);
  }

  function inspect(): GrassListEntry[] {
    const out: GrassListEntry[] = [];
    const read = (list: (typeof lists)[number], band: number) => {
      const row = MAX_LIST * 4;
      for (let e = 0; e < list.len; e++) {
        const d = list.data;
        const i = e * 4;
        out.push({
          band,
          tile: d[row + i + 3],
          slot: d[i + 3],
          frame: [d[i], d[i + 1], d[i + 2], d[row + i], d[row + i + 1], d[row + i + 2], d[2 * row + i], d[2 * row + i + 1], d[2 * row + i + 2]],
          scale: d[2 * row + i + 3],
        });
      }
    };
    lists.forEach(read);
    read(flowerList, -1);
    return out;
  }

  // 地面网格要重算（exclude 变了、地形改了）：标记为过期，之后几帧由近到远原地重算，重算前照旧画老的。
  // 给了 near（世界坐标里的一个点，比如刚摆下作品的位置）就只标记它周围 radius 米以内的瓦片
  function refresh(near?: THREE.Vector3, radius = 3): void {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let cosMax = -2;
    if (near) {
      dx = near.x - planet.center.x;
      dy = near.y - planet.center.y;
      dz = near.z - planet.center.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      cosMax = Math.cos(radius / planet.radius);
    }
    const tc = tiles.center;
    for (let s = 0; s < SLOTS; s++) {
      const t = tileOfSlot[s];
      if (t < 0) continue;
      if (near) {
        const c = tc[t * 3] * dx + tc[t * 3 + 1] * dy + tc[t * 3 + 2] * dz;
        if (Math.acos(Math.min(1, c)) - tiles.spread[t] > Math.acos(cosMax)) continue;
      }
      stale[s] = 1;
    }
  }

  function dispose(): void {
    object.removeFromParent();
    for (const mesh of [...bandMeshes, flowerMesh]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    atlas.dispose();
    for (const l of lists) l.tex.dispose();
    flowerList.tex.dispose();
    releaseNoise();
  }

  return {
    object,
    update,
    setDensity: (n: number) => {
      density = THREE.MathUtils.clamp(n, 0.05, 1);
    },
    dispose,
    setSun,
    refresh,
    settings,
    stats,
    windAt,
    groundTint,
    inspect,
  };
}

import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, cos, cross, dot, exp, float, floor, fract, length, max, min, mix, normalize, positionGeometry, positionWorld, pow,
  saturate, select, sin, smoothstep, sqrt, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { mulberry32, type Rng } from '../planet/rng';
import { setWind, WIND, windAt, windClock, windNode } from './wind';

// 「生机」层：脚步扬尘、踩踏图、蝴蝶、飘落的花瓣和绒毛、萤火虫（白天是花粉光点）、雨丝和水花。风场在 wind.ts，和草模块共用。
//
// 做法总览（细节见各段注释）：
// - 星球上「上」一律是径向 normalize(p − 星球中心)；雨往球心落；落地、踩踏都用到球心的距离判断，不拍俯视的渲染目标。
// - 粒子全在 GPU 上算，不用 compute：WebGPU 和 WebGL2 走同一套顶点着色器，只有一条路径。
//   - 雨丝、花瓣、绒毛、萤火虫是「无状态」的：位置是 (实例的随机数, 时间, 镜头) 的函数，CPU 每帧只写几个 uniform。
//   - 尘土和水花是「CPU 发射、GPU 演化」：落脚 / 落雨时 CPU 往环形缓冲里写一条（出生位置、出生时间、初速度），
//     之后整个寿命都在顶点着色器里按年龄算，CPU 不逐粒更新。水花的落点用真实地面高度。
//   - 蝴蝶有行为（找花、停落、受惊飞走），十来只的行为在 CPU 上用预分配的数组算，每帧上传 12×8 个浮点；扇翅、姿态在顶点着色器里。
// - 踩踏图：一张八面体映射的 RGBA8 渲染目标覆盖整颗星球。角色走过时用 MAX 混合盖章，固定频率用减法混合整体减 1/255，
//   所以只有一张贴图、对外的 texture 对象永远不变，不用乒乓。
// - 热路径（update、setWalker、setWeather）不新建对象。
//
// 借鉴（MIT，均按思路改写，没有照抄代码）：
// - Bruno Simon folio-2025（https://github.com/brunosimon/folio-2025）：RainLines.js 的无 compute 雨丝、Leaves.js 的「离地越高翻得越厉害」。
// - three.js 示例 webgpu_particles_soft：粒子淡入淡出的曲线、贴地处软化硬边的思路（这里用到地面的距离代替场景深度）。

// ---------- 接口 ----------

export interface LifePlanet {
  radius: number; // 星球基础半径（米）
  center: THREE.Vector3; // 星球中心（世界坐标）
  height(dir: THREE.Vector3): number; // 单位方向 → 地面半径（含起伏）
  sea: number | null; // 海面半径，没有海是 null
  // 以下可选，集成时有就传：
  bare?(dir: THREE.Vector3): number; // 0..1，1 = 裸土（土路）：脚下扬起黄土，否则是草屑。可以直接用草模块的 exclude
  flowerNear?(pos: THREE.Vector3, radius: number, out: THREE.Vector3): boolean; // 附近一朵花的花冠（世界坐标）写进 out；蝴蝶停落用，没有就停在草尖上
}

export type LifeEffect = 'dust' | 'trample' | 'butterflies' | 'petals' | 'fireflies' | 'rain' | 'splashes';
export const LIFE_EFFECTS: readonly LifeEffect[] = ['dust', 'trample', 'butterflies', 'petals', 'fireflies', 'rain', 'splashes'];
export type LifeQuality = 'high' | 'low';

export interface LifeWeather {
  rain: number; // 0..1
  wind: number; // 0..1
  sunDir?: THREE.Vector3; // 指向太阳的单位向量（世界坐标）
  evening?: number; // 0 白天，0.5 黄昏，1 入夜；大于 0.5 出萤火虫
}

export interface LifeOptions {
  quality?: LifeQuality; // 档位：踩踏图分辨率在创建时定，其余可以随时 setQuality
  seed?: number;
}

export interface LifeStats {
  backend: string;
  drawCalls: number; // 这一帧画了几个网格（不含踩踏图的离屏 pass）
  instances: Record<LifeEffect, number>;
  trampleSize: number;
  tramplePasses: number; // 累计的踩踏图离屏 pass 次数
  cpuMs: number; // 上一次 update() 的 CPU 耗时
  // 以下给自查脚本用
  dustAlive: number; // 正在播放的尘土粒子
  splashesAlive: number; // 正在播放的水花
  butterflyModes: [number, number, number, number]; // 游荡、飞向花、停着、受惊逃开 各几只
  startles: number; // 累计受惊次数
  fireflies: number; // 萤火虫亮度系数 0..1
  pollen: number; // 花粉光点系数 0..1
}

export interface Life {
  update(dtSec: number, camera: THREE.Camera): void;
  setWalker(pos: THREE.Vector3 | null, velocity: THREE.Vector3, grounded: boolean): void; // 角色脚底的位置（世界坐标）
  setWeather(w: LifeWeather): void;
  // 给草模块读的踩踏图：R = 被踩的程度（0..1，约 20 秒恢复），G = 刚踩过（约 1.5 秒消退）。
  // uvOf(dir) 是星球本地单位方向 → 贴图坐标；着色器里用 trampleUV(dir)，两者一致
  trample: { texture: THREE.Texture; uvOf(dir: THREE.Vector3, out?: THREE.Vector2): THREE.Vector2 } | null;
  dispose(): void;
  // ---- 以下是接口之外加的 ----
  readonly rain: number; // 平滑后的雨量（雨是慢慢下大、慢慢停的）
  onRain(cb: (rain: number) => void): () => void; // 雨量变化时回调（给天空 / 光照模块调冷调暗），订阅时先回调一次；返回取消订阅
  readonly influence: THREE.UniformNode<'vec4', THREE.Vector4>; // 角色的「影响球」：xyz = 脚底（世界坐标），w = 半径（没有角色时 0）。草被分开、花瓣被扬开用
  setEnabled(effect: LifeEffect, on: boolean): void;
  isEnabled(effect: LifeEffect): boolean;
  setQuality(q: LifeQuality): void;
  setPlanet(planet: LifePlanet): void; // 换星球：踩踏图清空（贴图对象不变，分辨率按创建时的半径），蝴蝶搬到新星球
  stats(): LifeStats;
  readonly debug: { trampleTarget: THREE.RenderTarget; butterflies: Float32Array }; // 自查脚本用：读回踩踏图、蝴蝶位置（世界坐标 xyz × N）
}

// ---------- 八面体映射（踩踏图的坐标） ----------
// 单位球 → [0,1]²：上半球（y ≥ 0）是中间的菱形，下半球折到四个角上。没有极点奇异，面积畸变不到 2 倍。
// 星球半径 30 米、512² 时一个像素约 0.21 米

export function octEncode(dir: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
  const l = Math.abs(dir.x) + Math.abs(dir.y) + Math.abs(dir.z) || 1;
  let x = dir.x / l;
  let z = dir.z / l;
  if (dir.y < 0) {
    const fx = (1 - Math.abs(z)) * (x >= 0 ? 1 : -1);
    const fz = (1 - Math.abs(x)) * (z >= 0 ? 1 : -1);
    x = fx;
    z = fz;
  }
  return out.set(x * 0.5 + 0.5, z * 0.5 + 0.5);
}

export function octDecode(uvIn: THREE.Vector2, out: THREE.Vector3): THREE.Vector3 {
  const fx = uvIn.x * 2 - 1;
  const fz = uvIn.y * 2 - 1;
  const y = 1 - Math.abs(fx) - Math.abs(fz);
  const t = Math.max(-y, 0);
  return out.set(fx - (fx >= 0 ? t : -t), y, fz - (fz >= 0 ? t : -t)).normalize();
}

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// TSL：星球本地单位方向 → 踩踏图坐标（和 octEncode 一致）。草模块：texture(life.trample.texture, trampleUV(dir)).r
export function trampleUV(dir: V3): V2 {
  const n = dir.div(abs(dir.x).add(abs(dir.y)).add(abs(dir.z)));
  const sx = select(n.x.greaterThanEqual(0), float(1), float(-1));
  const sz = select(n.z.greaterThanEqual(0), float(1), float(-1));
  const folded = vec2(float(1).sub(abs(n.z)).mul(sx), float(1).sub(abs(n.x)).mul(sz));
  return select(n.y.lessThan(0), folded, vec2(n.x, n.z)).mul(0.5).add(0.5);
}

function octDecodeNode(p: V2): V3 {
  const f = p.mul(2).sub(1);
  const y = float(1).sub(abs(f.x)).sub(abs(f.y));
  const t = max(y.negate(), 0);
  const x = f.x.sub(select(f.x.greaterThanEqual(0), t, t.negate()));
  const z = f.y.sub(select(f.y.greaterThanEqual(0), t, t.negate()));
  return normalize(vec3(x, y, z));
}

// ---------- 纯逻辑（不碰 GPU，可单测） ----------

// 脚步节拍：按走过的路程数步，左右脚交替。停下（或离地）时不出步；重新起步后走 0.4 步长就落第一步
export class FootstepTracker {
  foot = 1; // 1 = 左脚，-1 = 右脚（刚落地的那只）
  stride: number;
  minSpeed: number;
  private acc: number;
  constructor(stride = 0.45, minSpeed = 0.35) {
    this.stride = stride;
    this.minSpeed = minSpeed;
    this.acc = stride * 0.6;
  }

  // 这一帧落了几步
  advance(speed: number, dt: number, grounded: boolean): number {
    if (!grounded || speed < this.minSpeed) {
      this.acc = this.stride * 0.6;
      return 0;
    }
    this.acc += speed * dt;
    let n = 0;
    while (this.acc >= this.stride) {
      this.acc -= this.stride;
      this.foot = -this.foot;
      n++;
    }
    return n;
  }
}

export interface ButterflyEnv {
  center: THREE.Vector3;
  ground(dir: THREE.Vector3): number; // 地面半径
  flowerNear?(pos: THREE.Vector3, radius: number, out: THREE.Vector3): boolean;
}

export const BUTTERFLY = {
  startle: 1.7, // 角色离它这么近（米，再加上角色速度 × 0.3 秒）就受惊飞走
  minAlt: 0.15, // 飞行时离地至少这么高
  grassTop: 0.3, // 没有花时停在这么高（草尖）
  roam: 26, // 离场中心超过这么远就换到镜头附近的新地方（离开视野的蝴蝶不会一直丢在身后）
};
export const B_WANDER = 0;
export const B_APPROACH = 1;
export const B_REST = 2;
export const B_FLEE = 3;

const _bp = new THREE.Vector3();
const _bv = new THREE.Vector3();
const _bf = new THREE.Vector3();
const _bu = new THREE.Vector3();
const _bh = new THREE.Vector3();
const _bd = new THREE.Vector3();
const _bt = new THREE.Vector3();
const _bdes = new THREE.Vector3();
const _bdir = new THREE.Vector3();

// 去掉 v 沿单位法线 n 的分量（写回 v）
function flattenTo(v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
  return v.addScaledVector(n, -v.dot(n));
}

// 和 n 垂直的任意单位向量（写进 out）
function tangentOf(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(n.x) < 0.9) out.set(1, 0, 0);
  else out.set(0, 1, 0);
  return flattenTo(out, n).normalize();
}

// 一群蝴蝶的行为。状态全在类型化数组里（世界坐标），update() 不新建对象
export class ButterflySim {
  readonly n: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly fwd: Float32Array;
  readonly home: Float32Array; // 常待的地方（地面上的点）
  readonly target: Float32Array; // 要落的花 / 受惊时逃开的方向
  readonly mode: Uint8Array;
  readonly timer: Float32Array;
  startles = 0; // 累计受惊次数
  readonly phase: Float32Array; // 扇翅相位（弧度）
  readonly rest: Float32Array; // 0 飞，1 停着（平滑过渡）
  readonly seed: Float32Array;
  placed = false;
  private readonly rng: Rng;

  constructor(n: number, seed = 7) {
    this.n = n;
    this.rng = mulberry32(seed);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.fwd = new Float32Array(n * 3);
    this.home = new Float32Array(n * 3);
    this.target = new Float32Array(n * 3);
    this.mode = new Uint8Array(n);
    this.timer = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.rest = new Float32Array(n);
    this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.seed[i] = this.rng();
      this.phase[i] = this.rng() * Math.PI * 2;
    }
  }

  // 把第 i 只放到 around（地面附近的世界坐标）周围 rMin..rMax 米的随机位置，离地 0.4–0.9 米
  placeOne(i: number, env: ButterflyEnv, around: THREE.Vector3, rMin: number, rMax: number): void {
    _bu.copy(around).sub(env.center).normalize();
    tangentOf(_bu, _bt);
    _bd.crossVectors(_bu, _bt);
    const a = this.rng() * Math.PI * 2;
    const r = rMin + (rMax - rMin) * Math.sqrt(this.rng());
    const R = Math.max(1, around.distanceTo(env.center));
    // 在切平面里走 r 米再贴回球面
    _bdir.copy(_bu).multiplyScalar(R).addScaledVector(_bt, Math.cos(a) * r).addScaledVector(_bd, Math.sin(a) * r).normalize();
    const g = env.ground(_bdir);
    _bp.copy(env.center).addScaledVector(_bdir, g);
    _bp.toArray(this.home, i * 3);
    _bp.addScaledVector(_bdir, 0.4 + 0.5 * this.rng());
    _bp.toArray(this.pos, i * 3);
    tangentOf(_bdir, _bf).applyAxisAngle(_bdir, this.rng() * Math.PI * 2);
    _bf.toArray(this.fwd, i * 3);
    this.vel.fill(0, i * 3, i * 3 + 3);
    this.mode[i] = B_WANDER;
    this.timer[i] = 3 + this.rng() * 8;
    this.rest[i] = 0;
  }

  scatter(env: ButterflyEnv, around: THREE.Vector3, radius: number): void {
    for (let i = 0; i < this.n; i++) this.placeOne(i, env, around, 1.5, radius);
    this.placed = true;
  }

  // count：只更新前 count 只（档位）。t：秒（只用来驱动平滑的随机游走）。field：场中心（离它太远的蝴蝶换地方）
  update(dt: number, t: number, env: ButterflyEnv, walker: THREE.Vector3 | null, walkerSpeed: number, field: THREE.Vector3 | null, count = this.n): void {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const o = i * 3;
      if (field && _bp.fromArray(this.pos, o).distanceTo(field) > BUTTERFLY.roam) this.placeOne(i, env, field, 9, 16);
      _bp.fromArray(this.pos, o);
      _bv.fromArray(this.vel, o);
      _bf.fromArray(this.fwd, o);
      _bu.copy(_bp).sub(env.center);
      const r = _bu.length();
      _bu.divideScalar(r || 1);
      const alt = r - env.ground(_bu);
      const s = this.seed[i];
      let m = this.mode[i];
      let tm = this.timer[i] - dt;
      let accel = 3;

      // 受惊：角色靠近就飞走；还在追就接着逃
      if (walker) {
        const d = _bp.distanceTo(walker);
        if (d < BUTTERFLY.startle + walkerSpeed * 0.3) {
          if (m !== B_FLEE) {
            tm = 1.3 + rng() * 0.8;
            this.startles++;
          }
          else tm = Math.max(tm, 0.8);
          m = B_FLEE;
          _bd.copy(_bp).sub(walker);
          flattenTo(_bd, _bu);
          if (_bd.lengthSq() < 1e-8) tangentOf(_bu, _bd);
          _bd.normalize().toArray(this.target, o);
        }
      }

      if (m === B_WANDER) {
        // 平滑的随机游走：朝向在切平面里按两条正弦叠加的角速度转
        _bh.copy(_bf);
        flattenTo(_bh, _bu);
        if (_bh.lengthSq() < 1e-8) tangentOf(_bu, _bh);
        _bh.normalize();
        const turn = 1.4 * Math.sin(t * 0.83 + s * 17) + 0.8 * Math.sin(t * 2.1 + s * 31);
        _bh.applyAxisAngle(_bu, turn * dt);
        // 离家远了往回拐
        _bd.fromArray(this.home, o).sub(_bp);
        flattenTo(_bd, _bu);
        const dh = _bd.length();
        if (dh > 3) {
          const k = 1 - Math.exp(-1.8 * THREE.MathUtils.smoothstep(dh, 3, 7) * dt);
          _bh.lerp(_bd.divideScalar(dh), k).normalize();
        }
        const speed = 0.9 + 0.35 * Math.sin(t * 0.5 + s * 5);
        const want = 0.6 + 0.3 * Math.sin(t * 0.7 + s * 11) + 0.12 * Math.sin(t * 2.7 + s * 3);
        const vz = THREE.MathUtils.clamp((want - alt) * 2, -0.8, 0.8);
        _bdes.copy(_bh).multiplyScalar(speed).addScaledVector(_bu, vz);
        _bf.copy(_bh);
        accel = 2.5;
        if (tm <= 0) {
          // 找个地方落：附近有花就落花上，没有就落在前方的草尖上
          if (!env.flowerNear || !env.flowerNear(_bp, 5, _bt)) {
            _bt.copy(_bp).addScaledVector(_bh, 1.2).sub(env.center).normalize();
            const g = env.ground(_bt);
            _bt.multiplyScalar(g + BUTTERFLY.grassTop).add(env.center);
          }
          _bt.toArray(this.target, o);
          m = B_APPROACH;
          tm = 7;
        }
      } else if (m === B_APPROACH) {
        _bd.fromArray(this.target, o).sub(_bp);
        const d = _bd.length();
        if (d < 0.03) {
          m = B_REST;
          tm = 2.5 + rng() * 4;
          _bp.fromArray(this.target, o);
          _bv.set(0, 0, 0);
          _bdes.set(0, 0, 0);
        } else {
          _bdes.copy(_bd).multiplyScalar(Math.min(1.2, d * 1.8 + 0.12) / d);
          if (d > 0.5) _bdes.addScaledVector(_bu, 0.25);
          accel = 4;
          if (tm <= 0) {
            m = B_WANDER;
            tm = 4 + rng() * 6;
          }
        }
      } else if (m === B_REST) {
        _bv.set(0, 0, 0);
        _bdes.set(0, 0, 0);
        if (tm <= 0) {
          m = B_WANDER;
          tm = 5 + rng() * 8;
          _bv.copy(_bu).multiplyScalar(0.7);
        }
      } else {
        // 逃：沿「角色 → 蝴蝶」的方向斜着往上飞
        _bd.fromArray(this.target, o);
        flattenTo(_bd, _bu);
        if (_bd.lengthSq() < 1e-8) tangentOf(_bu, _bd);
        _bd.normalize();
        _bdes.copy(_bd).multiplyScalar(2.6).addScaledVector(_bu, alt < 2.2 ? 1.3 : 0.15);
        accel = 5;
        if (tm <= 0) {
          m = B_WANDER;
          tm = 4 + rng() * 6;
          // 在逃到的地方住下，不马上飞回去
          _bt.copy(_bu).multiplyScalar(r - alt).add(env.center);
          _bt.toArray(this.home, o);
        }
      }

      if (m !== B_REST) {
        _bv.lerp(_bdes, 1 - Math.exp(-accel * dt));
        _bp.addScaledVector(_bv, dt);
        // 不钻进地里（飞向花时允许低于最低飞行高度）
        _bu.copy(_bp).sub(env.center);
        const r2 = _bu.length();
        _bu.divideScalar(r2 || 1);
        const floorR = env.ground(_bu) + (m === B_APPROACH ? 0.02 : BUTTERFLY.minAlt);
        if (r2 < floorR) {
          _bp.copy(_bu).multiplyScalar(floorR).add(env.center);
          const vn = _bv.dot(_bu);
          if (vn < 0) _bv.addScaledVector(_bu, -vn);
        }
        // 机头朝水平速度
        _bh.copy(_bv);
        flattenTo(_bh, _bu);
        const hs = _bh.length();
        if (hs > 0.05) _bf.lerp(_bh.divideScalar(hs), 1 - Math.exp(-8 * dt));
      }
      flattenTo(_bf, _bu);
      if (_bf.lengthSq() < 1e-8) tangentOf(_bu, _bf);
      _bf.normalize();

      const freq = m === B_REST ? 0 : m === B_FLEE ? 13 : 8.5 + 1.5 * Math.sin(s * 7);
      this.phase[i] = (this.phase[i] + Math.PI * 2 * freq * dt) % (Math.PI * 2000);
      this.rest[i] += ((m === B_REST ? 1 : 0) - this.rest[i]) * (1 - Math.exp(-6 * dt));
      this.mode[i] = m;
      this.timer[i] = tm;
      _bp.toArray(this.pos, o);
      _bv.toArray(this.vel, o);
      _bf.toArray(this.fwd, o);
    }
  }
}

// ---------- GPU 小工具 ----------

// 公用的 uniform：每帧 update() 写一次，所有效果的材质共用
function makeUniforms() {
  return {
    time: uniform(0), // 生机层自己的时钟（秒）：CPU 写出生时间、GPU 算年龄用同一个钟
    center: uniform(new THREE.Vector3()), // 星球中心
    cam: uniform(new THREE.Vector3()), // 镜头位置
    camRight: uniform(new THREE.Vector3(1, 0, 0)), // 镜头的右、上（世界坐标）：面向镜头的面片用
    camUp: uniform(new THREE.Vector3(0, 1, 0)),
    field: uniform(new THREE.Vector3()), // 场中心：镜头前方几米处的地面点。雨丝、花瓣、绒毛、萤火虫围着它
    groundR: uniform(30), // 场中心的地面半径（雨、飘落物、萤火虫的高度从这里量）
    pxAngle: uniform(0.001), // 1 米外一个像素有多大（米）：雨丝不细于 1 像素
    sunDir: uniform(new THREE.Vector3(0.4, 0.5, 0.75).normalize()),
    sunCol: uniform(new THREE.Vector3(1, 0.94, 0.84)), // 太阳光颜色 × 强度（rgb 存在 xyz 里）
    ambCol: uniform(new THREE.Vector3(0.55, 0.62, 0.72)), // 环境光颜色
    rainAmt: uniform(0),
    rainTime: uniform(0), // 雨的进度时钟：按「下落速度 / 雨柱高度」累加
    rainWind: uniform(new THREE.Vector3()), // 场中心的风（世界坐标，米/秒）：雨丝按高度往上风方向斜
    rainLen: uniform(0.4), // 雨丝长度（米）
    windMean: uniform(new THREE.Vector3()), // 平稳的平均风（不含阵风）：飘落物在空中的漂移
    fireAmt: uniform(0), // 萤火虫（傍晚）
    pollenAmt: uniform(0), // 花粉光点（白天）
    influence: uniform(new THREE.Vector4()), // 角色的影响球：xyz 脚底，w 半径
  };
}
type Uniforms = ReturnType<typeof makeUniforms>;

// 实例化面片：每个实例 parts 个四边形，顶点 position = (角 x, 角 y, 第几片)，角在 [-1, 1]
function quadGeometry(instances: number, parts = 1): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let p = 0; p < parts; p++) {
    const b = p * 4;
    pos.push(-1, -1, p, 1, -1, p, 1, 1, p, -1, 1, p);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = instances;
  return g;
}

// 每个实例 4 个 [0,1) 随机数（静态）
function randAttribute(n: number, rng: Rng): THREE.InstancedBufferAttribute {
  const a = new Float32Array(n * 4);
  for (let i = 0; i < a.length; i++) a[i] = rng();
  return new THREE.InstancedBufferAttribute(a, 4);
}

// 每帧会改的实例数据（vec4，避免 vec3 被补齐成 vec4 时每次上传都新建数组）
function dynAttribute(n: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

// 按 floor 取模（WGSL 的 % 对负数是截断取余，不能直接用）
function wrap3(v: V3, s: number): V3 {
  return v.sub(floor(v.div(s)).mul(s));
}

function maxAbs3(v: V3): F {
  return max(abs(v.x), max(abs(v.y), abs(v.z)));
}

// 单位法线 n 的一组切向基（Duff et al. 2017 的无分支写法）。在 n.z 过 0 处朝向会翻一下，只给朝向无所谓的东西用
function basisOf(n: V3): { t1: V3; t2: V3 } {
  const sg = select(n.z.greaterThanEqual(0), float(1), float(-1));
  const a = float(-1).div(sg.add(n.z));
  const b = n.x.mul(n.y).mul(a);
  return {
    t1: vec3(float(1).add(sg.mul(n.x).mul(n.x).mul(a)), sg.mul(b), sg.negate().mul(n.x)),
    t2: vec3(b, sg.add(n.y.mul(n.y).mul(a)), n.y.negate()),
  };
}

// 镜头附近的「地表场」：每个实例在边长 s 的周期格子里有一个固定的世界坐标 base，在以场中心为中心的盒子里取模，
// 再沿球心方向投影回地面。格点是世界坐标，所以镜头移动时它们不跟着走；出盒子时从对面进来，盒子边缘一圈淡出，看不到跳变
function surfaceField(U: Uniforms, base01: V3, s: number): { dir: V3; edge: F } {
  const rel = wrap3(base01.mul(s).sub(U.field).add(s / 2), s).sub(s / 2);
  const edge = float(1).sub(smoothstep(s * 0.34, s * 0.5, maxAbs3(rel)));
  const dir = normalize(U.field.add(rel).sub(U.center));
  return { dir, edge };
}

// 被角色的影响球推开：球内的点沿「脚底 → 点」方向推到球边上（平滑），返回位移
function pushAway(U: Uniforms, p: V3, k: number): V3 {
  const d = p.sub(U.influence.xyz);
  const len = max(length(d), 0.001);
  const amt = max(U.influence.w.sub(len), 0).mul(k);
  return d.div(len).mul(amt);
}

// 轴角旋转（Rodrigues），axis 是单位向量
function rotateAxis(v: V3, axis: V3, angle: F): V3 {
  const c = cos(angle);
  const s = sin(angle);
  return v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v).mul(float(1).sub(c))));
}

// 简单受光：环境光 + 太阳。n 为空时按「半受光」算（粒子没有法线）。wrapK：包裹光，越大背光面越亮
function lit(U: Uniforms, albedo: V3, n: V3 | null, wrapK = 0.4): V3 {
  const diff = n ? saturate(dot(n, U.sunDir).add(wrapK).div(1 + wrapK)) : float(0.65);
  return albedo.mul(U.ambCol.add(U.sunCol.mul(diff)));
}

// 薄片的透光：太阳在薄片后面、正对镜头时发亮（逆光）
function backlight(U: Uniforms, worldPos: V3): F {
  const view = normalize(worldPos.sub(U.cam));
  return pow(saturate(dot(view, U.sunDir)), 4);
}

function makeMesh(name: string, geometry: THREE.InstancedBufferGeometry, material: THREE.Material, order: number): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material> {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false; // 顶点在着色器里算，包围球不代表实际位置
  mesh.renderOrder = order; // 画在不透明物体、天空和云海之后
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function transparentMaterial(blending: THREE.Blending = THREE.NormalBlending): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending });
}

const alive01 = (age: F, life: F | number): F => select(age.greaterThanEqual(0).and(age.lessThan(life)), float(1), float(0));

// ---------- 尘土：CPU 发射、GPU 演化 ----------

const DUST_SLOTS = 160;

function makeDust(U: Uniforms) {
  const g = quadGeometry(DUST_SLOTS);
  const a = dynAttribute(DUST_SLOTS); // 出生位置（地面点）xyz，出生时间
  const b = dynAttribute(DUST_SLOTS); // 初速度 xyz，随机数
  const c = dynAttribute(DUST_SLOTS); // 颜色 rgb，种类（0 尘团，1 碎屑）
  const d = dynAttribute(DUST_SLOTS); // 寿命，初始大小，最终大小，不透明度
  for (let i = 0; i < DUST_SLOTS; i++) a.array[i * 4 + 3] = -1e4;
  g.setAttribute('aA', a);
  g.setAttribute('aB', b);
  g.setAttribute('aC', c);
  g.setAttribute('aD', d);
  const A = attribute<'vec4'>('aA', 'vec4');
  const B = attribute<'vec4'>('aB', 'vec4');
  const C = attribute<'vec4'>('aC', 'vec4');
  const D = attribute<'vec4'>('aD', 'vec4');

  const age = U.time.sub(A.w);
  const k = saturate(age.div(D.x));
  const alive = alive01(age, D.x);
  const fleck = C.w.greaterThan(0.5);
  const up = normalize(A.xyz.sub(U.center));
  const drag = select(fleck, float(1.2), float(3.5));
  const disp = B.xyz.mul(float(1).sub(exp(drag.negate().mul(age))).div(drag));
  // 尘团慢慢上浮、被风带走一点；碎屑抛出去再落回地面（不低于出生的地面）
  const raw = A.xyz.add(disp).add(windNode(A.xyz).mul(age.mul(select(fleck, float(0.12), float(0.35)))));
  const h0 = dot(raw.sub(A.xyz), up);
  const lift = select(fleck, age.mul(age).mul(-4.2), age.mul(0.18));
  const h = max(h0.add(lift), select(fleck, float(0.01), float(-1)));
  const centerPos = raw.add(up.mul(h.sub(h0)));
  const grow = float(1).sub(pow(float(1).sub(k), 2));
  const size = mix(D.y, D.z, grow).mul(alive);
  const rot = B.w.mul(6.283).add(age.mul(select(fleck, float(9), float(0.6))));
  const corner = positionGeometry.xy.mul(vec2(1, select(fleck, float(0.45), float(1))));
  const cr = cos(rot);
  const sr = sin(rot);
  const rc = vec2(corner.x.mul(cr).sub(corner.y.mul(sr)), corner.x.mul(sr).add(corner.y.mul(cr)));
  const m = transparentMaterial();
  m.positionNode = centerPos.add(U.camRight.mul(rc.x.mul(size))).add(U.camUp.mul(rc.y.mul(size)));

  const r = length(positionGeometry.xy);
  const ang = atan(positionGeometry.y, positionGeometry.x);
  const puff = pow(float(1).sub(smoothstep(0.3, 1, r.mul(sin(ang.mul(3).add(B.w.mul(30))).mul(0.12).add(1)))), 1.5);
  const chip = float(1).sub(smoothstep(0.7, 1, r));
  const shape = select(fleck, chip, puff);
  // 淡入淡出（同 webgpu_particles_soft 的思路：开头 8% 淡入，之后按 (1−k)^1.6 淡出）
  const fade = smoothstep(0, 0.08, k).mul(pow(float(1).sub(k), 1.6));
  // 软粒子：面片插进地面的那一截淡掉，不出现硬边（只对尘团）。用到地面的距离代替场景深度，不需要深度贴图
  const groundR0 = length(A.xyz.sub(U.center));
  const soft = select(fleck, float(1), smoothstep(-0.02, 0.14, length(positionWorld.sub(U.center)).sub(groundR0)));
  m.colorNode = lit(U, C.xyz, null);
  m.opacityNode = shape.mul(fade).mul(D.w).mul(soft);
  const mesh = makeMesh('life.dust', g, m, 10);

  let head = 0;
  // 正在播放的粒子数（统计用，不在热路径）
  const aliveCount = (time: number): number => {
    let n = 0;
    for (let i = 0; i < DUST_SLOTS; i++) {
      const age = time - a.array[i * 4 + 3];
      if (age >= 0 && age < d.array[i * 4]) n++;
    }
    return n;
  };
  // 发射一粒；pos 是出生点（世界坐标）
  function emit(t: number, pos: THREE.Vector3, vel: THREE.Vector3, col: THREE.Color, kind: number, life: number, s0: number, s1: number, opacity: number, rnd: number): void {
    const i = head;
    head = (head + 1) % DUST_SLOTS;
    a.setXYZW(i, pos.x, pos.y, pos.z, t);
    b.setXYZW(i, vel.x, vel.y, vel.z, rnd);
    c.setXYZW(i, col.r, col.g, col.b, kind);
    d.setXYZW(i, life, s0, s1, opacity);
    a.needsUpdate = b.needsUpdate = c.needsUpdate = d.needsUpdate = true;
  }
  return { mesh, emit, aliveCount, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 水花：CPU 发射（贴着真实地面），GPU 演化 ----------

const SPLASH_SLOTS = 320;
const SPLASH_LIFE = 0.42;

function makeSplashes(U: Uniforms, rng: Rng) {
  const g = quadGeometry(SPLASH_SLOTS, 4); // 第 0 片是地上扩散的一圈，1–3 片是溅起的水珠
  const a = dynAttribute(SPLASH_SLOTS); // 落点 xyz，出生时间
  for (let i = 0; i < SPLASH_SLOTS; i++) a.array[i * 4 + 3] = -1e4;
  g.setAttribute('aS', a);
  g.setAttribute('aRand', randAttribute(SPLASH_SLOTS, rng));
  const S = attribute<'vec4'>('aS', 'vec4');
  const R = attribute<'vec4'>('aRand', 'vec4');
  const part = positionGeometry.z;
  const age = U.time.sub(S.w);
  const k = saturate(age.div(SPLASH_LIFE));
  const alive = alive01(age, SPLASH_LIFE);
  const up = normalize(S.xyz.sub(U.center));
  const { t1, t2 } = basisOf(up);
  const c = positionGeometry.xy;
  const ringR = mix(0.015, 0.075, float(1).sub(pow(float(1).sub(k), 2))).mul(R.w.mul(0.6).add(0.7)).mul(alive);
  const ringPos = S.xyz.add(up.mul(0.012)).add(t1.mul(c.x.mul(ringR))).add(t2.mul(c.y.mul(ringR)));
  const ang = R.x.mul(6.283).add(part.mul(2.094));
  const hd = t1.mul(cos(ang)).add(t2.mul(sin(ang)));
  const v0 = hd.mul(R.y.mul(0.35).add(0.3)).add(up.mul(R.z.mul(0.6).add(0.9)));
  const dropC = S.xyz.add(v0.mul(age)).sub(up.mul(age.mul(age).mul(4.9)));
  const dropS = float(0.011).mul(alive);
  const dropPos = dropC.add(U.camRight.mul(c.x.mul(dropS))).add(U.camUp.mul(c.y.mul(dropS)));
  const isRing = part.lessThan(0.5);
  const m = transparentMaterial();
  m.positionNode = select(isRing, ringPos, dropPos);
  const r = length(c);
  const ring = smoothstep(0.55, 0.82, r).mul(float(1).sub(smoothstep(0.82, 1, r)));
  const drop = float(1).sub(smoothstep(0.4, 1, r));
  m.colorNode = lit(U, vec3(0.86, 0.9, 0.97), null).mul(1.15);
  m.opacityNode = select(isRing, ring.mul(0.28), drop.mul(0.85)).mul(float(1).sub(k)).mul(U.rainAmt.mul(0.5).add(0.5));
  const mesh = makeMesh('life.splashes', g, m, 11);

  let head = 0;
  function emit(t: number, pos: THREE.Vector3): void {
    a.setXYZW(head, pos.x, pos.y, pos.z, t);
    head = (head + 1) % SPLASH_SLOTS;
    a.needsUpdate = true;
  }
  const aliveCount = (time: number): number => {
    let n = 0;
    for (let i = 0; i < SPLASH_SLOTS; i++) {
      const age = time - a.array[i * 4 + 3];
      if (age >= 0 && age < SPLASH_LIFE) n++;
    }
    return n;
  };
  return { mesh, emit, aliveCount, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 雨丝：无状态 ----------
// 做法参考 Bruno Simon folio-2025 的 RainLines.js（MIT）：静态面片，全部动画在 positionNode 里；
// 水平位置绕镜头取模，高度按 fract(时间 + 随机数) 从上往下落、在地面处截断（落地时雨丝变短，不穿到地下），按高度往上风方向斜。
// 改动：星球上「下」是径向（每根雨丝都朝球心落），水平取模换成世界坐标格点 + 径向投影（surfaceField）；
// 雨量用实例数控制（少画的实例连顶点着色器都不跑）；宽度按像素保底、变粗的部分按比例变淡（远处不闪）

const RAIN_BOX = 18; // 水平方向的盒子边长（米），以场中心为中心
const RAIN_TOP = 8; // 雨柱高度（米）：低机位往上看也够了
const RAIN_FALL = 8.5; // 下落速度（米/秒）
const RAIN_MAX: Record<LifeQuality, number> = { high: 7000, low: 3000 };

function makeRain(U: Uniforms, rng: Rng) {
  const n = RAIN_MAX.high;
  const g = quadGeometry(n);
  g.setAttribute('aRand', randAttribute(n, rng));
  const R = attribute<'vec4'>('aRand', 'vec4');
  const { dir, edge } = surfaceField(U, R.xyz, RAIN_BOX);
  const L = U.rainLen;
  const span = L.add(RAIN_TOP);
  // 进度 0 → 1：雨丝尾端从 RAIN_TOP + L 落到 0。每根速度略有不同
  const progress = fract(U.rainTime.mul(R.w.mul(0.3).add(0.85)).add(R.w.mul(17.3)));
  const yTail = span.mul(float(1).sub(progress));
  const yHead = yTail.sub(L);
  const along = positionGeometry.y.mul(0.5).add(0.5); // 0 = 雨滴头（下端），1 = 拖尾
  const y = mix(yHead, yTail, along).clamp(0, RAIN_TOP);
  // 斜度：这一点的风投影到当地切平面，越高的地方往上风方向偏得越多（落下来时顺风走）
  const up = dir;
  const wt = U.rainWind.sub(up.mul(dot(U.rainWind, up)));
  const lean = wt.mul(0.06);
  const p = U.center.add(up.mul(U.groundR.add(y))).sub(lean.mul(y));
  const axis = normalize(up.add(lean.negate()));
  const toCam = U.cam.sub(p);
  const dist = max(length(toCam), 0.05);
  const side = normalize(cross(axis, toCam.div(dist)).add(vec3(0, 1e-5, 0)));
  const wWorld = float(0.0045);
  const w = max(wWorld, dist.mul(U.pxAngle).mul(0.75)); // 不细于 1.5 像素
  const m = transparentMaterial();
  m.positionNode = p.add(side.mul(w.mul(positionGeometry.x)));
  const near = smoothstep(0.8, 2.4, dist);
  const vis = varying(wWorld.div(w).mul(near).mul(edge).mul(U.rainAmt));
  const across = pow(float(1).sub(abs(positionGeometry.x)), 1.5);
  const profile = smoothstep(0, 0.08, along).mul(float(1).sub(along.mul(0.75)));
  m.colorNode = U.ambCol.mul(1.35).add(U.sunCol.mul(0.35)).mul(vec3(0.85, 0.9, 0.98));
  m.opacityNode = across.mul(profile).mul(vis).mul(0.6);
  const mesh = makeMesh('life.rain', g, m, 15);
  return { mesh, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 飘落的花瓣 ----------
// 每片花瓣一个循环：在场里一个随机位置从高处落下 → 落地躺一会儿 → 淡出，下一轮换个位置（循环序号决定位置，淡出时换，看不到跳变）。
// 空中按平稳的平均风漂移（落地后不再漂），叠一点阵风和摆动；翻滚幅度随离地高度变小，落地时自然躺平
// （「离地越高翻得越厉害」借鉴 Bruno Simon folio-2025 的 Leaves.js，MIT）

const PETAL_BOX = 18;
const PETAL_TOP = 4.5; // 从这么高落下
const PETAL_REST = 0.25; // 一轮里躺在地上的比例
const PETAL_MAX: Record<LifeQuality, number> = { high: 72, low: 32 };
const FLUFF_MAX: Record<LifeQuality, number> = { high: 64, low: 28 };

function makePetals(U: Uniforms, rng: Rng) {
  const n = PETAL_MAX.high;
  const g = quadGeometry(n);
  g.setAttribute('aRand', randAttribute(n, rng));
  g.setAttribute('aRand2', randAttribute(n, rng));
  const R = attribute<'vec4'>('aRand', 'vec4');
  const Q = attribute<'vec4'>('aRand2', 'vec4');
  const fall = Q.x.mul(0.18).add(0.16); // 米/秒
  const period = float(PETAL_TOP / (1 - PETAL_REST)).div(fall);
  const cyc = U.time.div(period).add(Q.y);
  const p = fract(cyc);
  const round = floor(cyc);
  // 每一轮换一个位置：随机数加上循环序号乘一组无理数（低差异序列）
  const base = fract(R.xyz.add(vec3(0.618034, 0.381966, 0.754878).mul(round)));
  const { dir, edge } = surfaceField(U, base, PETAL_BOX);
  const flight = min(p, 1 - PETAL_REST).div(1 - PETAL_REST); // 0..1 空中，之后停在 1
  const alt = float(PETAL_TOP).mul(float(1).sub(flight)).add(0.03);
  const airTime = flight.mul(period).mul(1 - PETAL_REST);
  const t = U.time;
  const up = dir;
  const meanT = U.windMean.sub(up.mul(dot(U.windMean, up)));
  const airK = smoothstep(0, 0.3, alt.sub(0.03));
  const wob = vec3(sin(t.mul(Q.z.mul(0.8).add(0.7)).add(R.x.mul(40))), sin(t.mul(Q.w.mul(0.9).add(0.6)).add(R.y.mul(40))), sin(t.mul(0.75).add(R.z.mul(40)))).mul(0.25);
  let centerPos = U.center.add(up.mul(U.groundR.add(alt))).add(meanT.mul(airTime.mul(R.w.mul(0.5).add(0.6)))).add(wob.mul(airK));
  centerPos = centerPos.add(pushAway(U, centerPos, 0.9).mul(airK));
  const dist = length(centerPos.sub(U.cam));
  const restFade = float(1).sub(smoothstep(0.88, 1, p));
  const fade = edge.mul(smoothstep(0, 0.05, p)).mul(restFade).mul(float(1).sub(smoothstep(9, 13, dist)));
  // 翻滚：绕随机轴转，角度 ∝ 离地高度（封顶 1.2 米）；高度为 0 时躺平在切平面上
  const axis = normalize(vec3(R.x.sub(0.5), R.y.sub(0.5), R.z.sub(0.5)).add(vec3(0.01, 0, 0)));
  const tumble = min(alt.sub(0.03), 1.2).div(1.2);
  const ang = sin(t.mul(Q.z.mul(1.5).add(1.1)).add(Q.w.mul(6.283))).mul(2.4).add(t.mul(Q.w.sub(0.5).mul(3))).mul(tumble);
  const { t1, t2 } = basisOf(up);
  const size = float(0.04).mul(Q.y.mul(0.5).add(0.75)).mul(fade);
  const local = t1.mul(positionGeometry.x.mul(0.62)).add(t2.mul(positionGeometry.y)).mul(size);
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  m.alphaToCoverage = true;
  m.positionNode = centerPos.add(rotateAxis(local, axis, ang));
  const normal = varying(rotateAxis(up, axis, ang));
  // 花瓣形状：下端尖、上端圆
  const c = positionGeometry.xy;
  const yy = c.y.mul(0.5).add(0.5);
  const halfW = sqrt(saturate(yy.mul(float(1).sub(yy)).mul(4))).mul(yy.mul(0.4).add(0.6));
  const inside = float(1).sub(smoothstep(halfW.mul(0.85), halfW, abs(c.x)));
  // 颜色：奶白、淡粉、浅黄，花瓣根部略深
  const pick = R.w;
  const baseCol = select(pick.lessThan(0.45), vec3(0.98, 0.96, 0.9), select(pick.lessThan(0.75), vec3(1, 0.8, 0.86), vec3(1, 0.9, 0.55)));
  const albedo = baseCol.mul(mix(0.82, 1, yy));
  const n2 = normal.mul(select(dot(normal, U.cam.sub(positionWorld)).greaterThan(0), float(1), float(-1)));
  m.colorNode = lit(U, albedo, n2, 0.6).add(albedo.mul(U.sunCol).mul(backlight(U, positionWorld).mul(0.8)));
  m.opacityNode = inside;
  const mesh = makeMesh('life.petals', g, m, 12);
  return { mesh, dispose: () => { g.dispose(); m.dispose(); } };
}

// 蒲公英绒毛：很轻，多数慢慢下沉、少数被托着上升；不落地，一轮结束时在空中淡出
function makeFluff(U: Uniforms, rng: Rng) {
  const n = FLUFF_MAX.high;
  const g = quadGeometry(n);
  g.setAttribute('aRand', randAttribute(n, rng));
  g.setAttribute('aRand2', randAttribute(n, rng));
  const R = attribute<'vec4'>('aRand', 'vec4');
  const Q = attribute<'vec4'>('aRand2', 'vec4');
  const period = Q.x.mul(10).add(14); // 一轮 14–24 秒
  const cyc = U.time.div(period).add(Q.y);
  const p = fract(cyc);
  const round = floor(cyc);
  const base = fract(R.xyz.add(vec3(0.381966, 0.754878, 0.618034).mul(round)));
  const { dir, edge } = surfaceField(U, base, PETAL_BOX);
  const climb = Q.z.mul(0.35).sub(0.22); // 米/秒，多数为负
  const alt = max(R.w.mul(2.6).add(0.4).add(climb.mul(p).mul(period)), 0.2);
  const t = U.time;
  const up = dir;
  const meanT = U.windMean.sub(up.mul(dot(U.windMean, up)));
  const wob = vec3(sin(t.mul(0.53).add(R.x.mul(30))), sin(t.mul(0.61).add(R.y.mul(30))), sin(t.mul(0.47).add(R.z.mul(30)))).mul(0.4);
  let centerPos = U.center.add(up.mul(U.groundR.add(alt))).add(meanT.mul(p.mul(period).mul(Q.w.mul(0.4).add(0.8)))).add(wob);
  centerPos = centerPos.add(pushAway(U, centerPos, 1.2));
  const dist = length(centerPos.sub(U.cam));
  const fade = edge.mul(smoothstep(0, 0.08, p)).mul(float(1).sub(smoothstep(0.85, 1, p))).mul(float(1).sub(smoothstep(8, 12, dist)));
  const size = float(0.042).mul(Q.z.mul(0.5).add(0.75));
  const m = transparentMaterial();
  m.positionNode = centerPos.add(U.camRight.mul(positionGeometry.x.mul(size))).add(U.camUp.mul(positionGeometry.y.mul(size)));
  // 冠毛：一圈细丝 + 中心一点
  const c = positionGeometry.xy;
  const r = length(c);
  const a = atan(c.y, c.x).add(t.mul(Q.w.sub(0.5))).add(R.x.mul(6.283));
  const rays = pow(abs(cos(a.mul(5))), 6).mul(smoothstep(1, 0.5, r)).mul(smoothstep(0.1, 0.3, r));
  const disc = float(1).sub(smoothstep(0.55, 1, r)).mul(0.35);
  const core = float(1).sub(smoothstep(0.08, 0.22, r));
  const glow = backlight(U, positionWorld);
  m.colorNode = lit(U, vec3(0.97, 0.96, 0.92), null).add(U.sunCol.mul(glow.mul(1.6)));
  m.opacityNode = saturate(max(rays.mul(0.7), max(disc, core))).mul(varying(fade)).mul(glow.mul(0.5).add(0.7));
  const mesh = makeMesh('life.fluff', g, m, 13);
  return { mesh, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 萤火虫（傍晚）/ 花粉光点（白天）：无状态，叠加混合 ----------
// 同一批实例：傍晚是会呼吸明灭的暖黄绿色光点（HDR，有 bloom 时会晕开）；白天其中七成是很淡的金色花粉，逆光时才看得清

const FIRE_BOX = 24;
const FIRE_MAX: Record<LifeQuality, number> = { high: 120, low: 56 };

function makeFireflies(U: Uniforms, rng: Rng) {
  const n = FIRE_MAX.high;
  const g = quadGeometry(n);
  g.setAttribute('aRand', randAttribute(n, rng));
  g.setAttribute('aRand2', randAttribute(n, rng));
  const R = attribute<'vec4'>('aRand', 'vec4');
  const Q = attribute<'vec4'>('aRand2', 'vec4');
  const { dir, edge } = surfaceField(U, R.xyz, FIRE_BOX);
  const t = U.time;
  const alt = R.w.mul(1.5).add(0.3).add(sin(t.mul(Q.x.mul(0.5).add(0.4)).add(Q.y.mul(20))).mul(0.25));
  const wob = vec3(sin(t.mul(Q.z.mul(0.4).add(0.25)).add(R.x.mul(50))), sin(t.mul(Q.w.mul(0.4).add(0.2)).add(R.y.mul(50))), sin(t.mul(0.33).add(R.z.mul(50)))).mul(0.7);
  let centerPos = U.center.add(dir.mul(U.groundR.add(alt))).add(wob);
  centerPos = centerPos.add(pushAway(U, centerPos, 0.8));
  const dist = length(centerPos.sub(U.cam));
  // 呼吸式的明灭：慢的正弦起伏，亮的时候再带一点快闪
  const breathe = smoothstep(0.25, 1, sin(t.mul(Q.x.mul(1.2).add(0.8)).add(Q.w.mul(30))).mul(0.5).add(0.5));
  const flicker = sin(t.mul(17).add(Q.z.mul(40))).mul(0.12).add(0.88);
  const level = breathe.mul(flicker).mul(0.92).add(0.08);
  const near = edge.mul(float(1).sub(smoothstep(14, 20, dist)));
  const pollen = select(Q.w.lessThan(0.7), float(1), float(0)).mul(U.pollenAmt);
  const fire = U.fireAmt;
  const size = mix(float(0.07), float(0.2).mul(Q.y.mul(0.4).add(0.8)), fire).mul(select(fire.add(pollen).greaterThan(0.001), float(1), float(0)));
  const m = transparentMaterial(THREE.AdditiveBlending);
  m.positionNode = centerPos.add(U.camRight.mul(positionGeometry.x.mul(size))).add(U.camUp.mul(positionGeometry.y.mul(size)));
  const r2 = dot(positionGeometry.xy, positionGeometry.xy);
  const glow = exp(r2.mul(-26)).add(exp(r2.mul(-5)).mul(0.22));
  const fireCol = vec3(1, 0.9, 0.42).mul(3.2).mul(level).mul(fire);
  const pollenCol = U.sunCol.mul(backlight(U, positionWorld).mul(2.2).add(0.25)).mul(vec3(1, 0.9, 0.7)).mul(pollen).mul(float(1).sub(fire));
  m.colorNode = fireCol.add(pollenCol);
  m.opacityNode = glow.mul(varying(near));
  m.fog = false; // 自己发光，雾不压它
  const mesh = makeMesh('life.fireflies', g, m, 14);
  return { mesh, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 蝴蝶：CPU 行为 + 实例化翅膀 ----------

const BUTTERFLY_MAX: Record<LifeQuality, number> = { high: 12, low: 6 };

function makeButterflies(U: Uniforms, rng: Rng, n: number) {
  const g = quadGeometry(n, 3); // 左翅、右翅、身体
  const a = dynAttribute(n); // 位置 xyz，扇翅相位
  const b = dynAttribute(n); // 朝向 xyz，停落程度
  g.setAttribute('aP', a);
  g.setAttribute('aF', b);
  g.setAttribute('aRand', randAttribute(n, rng));
  const P = attribute<'vec4'>('aP', 'vec4');
  const Fw = attribute<'vec4'>('aF', 'vec4');
  const R = attribute<'vec4'>('aRand', 'vec4');
  const part = positionGeometry.z;
  const isBody = part.greaterThan(1.5);
  const sideSign = select(part.lessThan(0.5), float(-1), float(1));
  const up = normalize(P.xyz.sub(U.center));
  const f = normalize(Fw.xyz.sub(up.mul(dot(Fw.xyz, up))));
  const rgt = cross(f, up);
  const rest = Fw.w;
  // 翅膀角度：飞的时候上下扇，停着时慢慢开合（大半时间合着）
  const flyAng = mix(-0.35, 1.2, sin(P.w).mul(0.5).add(0.5));
  const restAng = mix(1.35, 0.35, smoothstep(0.35, 1, sin(U.time.mul(R.x.mul(0.8).add(1)).add(R.y.mul(20))).mul(0.5).add(0.5)));
  const ang = mix(flyAng, restAng, rest);
  const size = R.z.mul(0.035).add(0.06); // 半翼展 6–9.5 厘米（风格化，比真蝴蝶略大，远处看得见）
  // 身体随扇翅上下起伏一点
  const bob = up.mul(sin(P.w.add(1.2)).mul(0.012).mul(float(1).sub(rest)));
  const c = positionGeometry.xy;
  const span = c.x.mul(0.5).add(0.5); // 0 = 翅根，1 = 翅尖
  const wingDir = rgt.mul(sideSign.mul(cos(ang))).add(up.mul(sin(ang)));
  const wingPos = P.xyz.add(bob).add(f.mul(c.y.mul(0.75).mul(size))).add(wingDir.mul(span.mul(size)));
  const bodyPos = P.xyz.add(bob).add(f.mul(c.y.mul(size).mul(0.42))).add(up.mul(c.x.mul(0.0045)));
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  m.alphaToCoverage = true;
  m.positionNode = select(isBody, bodyPos, wingPos);
  // 翅膀轮廓：前翅一个大椭圆、后翅一个小椭圆
  const fore = length(vec2(span.sub(0.55).div(0.47), c.y.sub(0.38).div(0.62)));
  const hind = length(vec2(span.sub(0.42).div(0.36), c.y.add(0.42).div(0.5)));
  const wingMask = float(1).sub(smoothstep(0.92, 1, min(fore, hind)));
  const bodyMask = float(1).sub(smoothstep(0.7, 1, abs(c.x)));
  // 配色：奶白、柠檬黄、天蓝、杏橙；翅缘深一圈，前翅一个小斑
  const pick = R.w;
  const baseCol = select(pick.lessThan(0.35), vec3(0.97, 0.95, 0.88), select(pick.lessThan(0.6), vec3(1, 0.86, 0.32), select(pick.lessThan(0.8), vec3(0.55, 0.74, 1), vec3(1, 0.6, 0.28))));
  const rim = smoothstep(0.7, 0.95, min(fore, hind));
  const spot = float(1).sub(smoothstep(0.08, 0.13, length(vec2(span.sub(0.72), c.y.sub(0.5)))));
  const wingCol = mix(baseCol, baseCol.mul(0.35), max(rim.mul(0.85), spot.mul(0.9)));
  const wingN = normalize(cross(f, wingDir));
  const wn = wingN.mul(select(dot(wingN, U.cam.sub(positionWorld)).greaterThan(0), float(1), float(-1)));
  const wingLit = lit(U, wingCol, wn, 0.5).add(wingCol.mul(U.sunCol).mul(backlight(U, positionWorld).mul(0.9)));
  m.colorNode = select(isBody, vec3(0.12, 0.1, 0.09), wingLit);
  m.opacityNode = select(isBody, bodyMask, wingMask);
  const mesh = makeMesh('life.butterflies', g, m, 5);
  return { mesh, a, b, dispose: () => { g.dispose(); m.dispose(); } };
}

// ---------- 踩踏图 ----------
// 一张 RGBA8 的渲染目标，八面体映射覆盖整颗星球。
// - 盖章：全屏 pass，每个像素解出自己对应的球面方向，算到「上一帧脚底 → 这一帧脚底」这段线段的距离，MAX 混合写进去。
//   用的是到球心的方向和三维距离，不在贴图空间里画圆，所以八面体的折缝两边也是连续的。
// - 恢复：固定频率的全屏 pass 用反向减法混合整体减一点。R 通道每次正好减 1/255，255 次恢复完，
//   所以恢复时长 = 255 × 间隔；8 位精度刚好够，不需要浮点渲染目标。
// 只有一张贴图，对外的 texture 对象始终不变（草模块拿一次就行）

export const TRAMPLE_RECOVER = 20; // R 通道从 1 恢复到 0 的秒数
export const TRAMPLE_FRESH = 1.5; // G 通道（刚踩过）消退的秒数
export const TRAMPLE_RADIUS = 0.38; // 踩倒的半宽（米）

function makeTrample(renderer: THREE.WebGPURenderer, size: number) {
  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    generateMipmaps: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
  });
  rt.texture.name = 'life.trample';
  const uA = uniform(new THREE.Vector3()); // 线段起点、终点（星球本地坐标）
  const uB = uniform(new THREE.Vector3());
  const uR = uniform(30); // 脚下地面半径：像素方向乘它得到球面上的点
  const uStrength = uniform(1);
  const stamp = new THREE.NodeMaterial();
  const p = octDecodeNode(uv()).mul(uR);
  const ab = uB.sub(uA);
  const tt = saturate(dot(p.sub(uA), ab).div(max(dot(ab, ab), 1e-6)));
  const dist = length(p.sub(uA.add(ab.mul(tt))));
  const v = float(1).sub(smoothstep(TRAMPLE_RADIUS * 0.45, TRAMPLE_RADIUS, dist)).mul(uStrength);
  stamp.fragmentNode = vec4(v, v, 0, 0);
  const uDecay = uniform(new THREE.Vector2());
  const decay = new THREE.NodeMaterial();
  decay.fragmentNode = vec4(uDecay.x, uDecay.y, 0, 0);
  const setup = (mat: THREE.NodeMaterial, eq: THREE.BlendingEquation) => {
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = eq;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneFactor;
    mat.depthTest = false;
    mat.depthWrite = false;
  };
  setup(stamp, THREE.MaxEquation);
  setup(decay, THREE.ReverseSubtractEquation);
  const stampQuad = new THREE.QuadMesh(stamp);
  const decayQuad = new THREE.QuadMesh(decay);
  const prevClear = new THREE.Color();

  function pass(fn: () => void): void {
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    fn();
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
  }

  function clear(): void {
    pass(() => {
      renderer.getClearColor(prevClear);
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(prevClear, alpha);
    });
  }
  clear();

  const step = TRAMPLE_RECOVER / 255; // 每隔这么久 R 减 1/255
  let acc = 0;
  let passes = 0;
  return {
    rt,
    // 推进恢复：攒够一个间隔就做一次减法 pass（卡顿时一次减几格）
    decay(dt: number): void {
      acc += dt;
      if (acc < step) return;
      const k = Math.min(Math.floor(acc / step), 255);
      acc -= k * step;
      uDecay.value.set(k / 255, Math.min(1, (k * step) / TRAMPLE_FRESH));
      pass(() => decayQuad.render(renderer));
      passes++;
    },
    // 从 a 到 b（星球本地坐标）盖一道
    stamp(a: THREE.Vector3, b: THREE.Vector3, groundR: number, strength: number): void {
      uA.value.copy(a);
      uB.value.copy(b);
      uR.value = groundR;
      uStrength.value = strength;
      pass(() => stampQuad.render(renderer));
      passes++;
    },
    clear,
    get passes() {
      return passes;
    },
    dispose(): void {
      rt.dispose();
      stamp.dispose();
      decay.dispose();
    },
  };
}

// ---------- 光的配色（只影响生机层自己的粒子；场景的光交给天空模块） ----------

const SUN_DAY = new THREE.Color(1, 0.94, 0.84);
const SUN_DUSK = new THREE.Color(1, 0.58, 0.32);
const AMB_DAY = new THREE.Color(0.55, 0.62, 0.72);
const AMB_DUSK = new THREE.Color(0.38, 0.32, 0.46);
const AMB_NIGHT = new THREE.Color(0.1, 0.12, 0.2);
const AMB_RAIN = new THREE.Color(0.4, 0.45, 0.52);

const COL_DIRT = new THREE.Color(0.8, 0.68, 0.5);
const COL_POLLEN = new THREE.Color(0.74, 0.78, 0.6);
const COL_GRASS_A = new THREE.Color(0.32, 0.52, 0.16);
const COL_GRASS_B = new THREE.Color(0.58, 0.68, 0.26);
const COL_CRUMB = new THREE.Color(0.46, 0.36, 0.26);

const INFLUENCE_RADIUS = 1.3;

// 踩踏图边长：一个像素约 0.2 米（高档）/ 0.4 米（低档），取 2 的幂，256–1024。半径 30 → 512²，60 → 1024²，15 → 256²
export function trampleSizeFor(radius: number, quality: LifeQuality): number {
  const want = radius * (quality === 'high' ? 16 : 8);
  return THREE.MathUtils.clamp(2 ** Math.ceil(Math.log2(Math.max(1, want))), 256, 1024);
}

// ---------- createLife ----------

export function createLife(scene: THREE.Scene, renderer: THREE.WebGPURenderer, planet: LifePlanet, opts: LifeOptions = {}): Life {
  let quality: LifeQuality = opts.quality ?? 'high';
  const seed = opts.seed ?? 20261027;
  const rng = mulberry32(seed);
  const U = makeUniforms();
  U.center.value.copy(planet.center);
  const root = new THREE.Group();
  root.name = 'life';
  root.matrixAutoUpdate = false;
  scene.add(root);

  const dust = makeDust(U);
  const splashes = makeSplashes(U, rng);
  const rain = makeRain(U, rng);
  const petals = makePetals(U, rng);
  const fluff = makeFluff(U, rng);
  const fireflies = makeFireflies(U, rng);
  const sim = new ButterflySim(BUTTERFLY_MAX.high, seed + 1);
  const butterflies = makeButterflies(U, rng, BUTTERFLY_MAX.high);
  const trampleSize = trampleSizeFor(planet.radius, quality);
  const trample = makeTrample(renderer, trampleSize);
  const meshes = [butterflies.mesh, dust.mesh, splashes.mesh, petals.mesh, fluff.mesh, fireflies.mesh, rain.mesh];
  root.add(...meshes);

  const enabled: Record<LifeEffect, boolean> = { dust: true, trample: true, butterflies: true, petals: true, fireflies: true, rain: true, splashes: true };
  const counts: Record<LifeEffect, number> = { dust: 0, trample: 0, butterflies: 0, petals: 0, fireflies: 0, rain: 0, splashes: 0 };

  // 角色
  const walker = { has: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), grounded: false, wasGrounded: false, air: 0 };
  const lastStamp = new THREE.Vector3();
  let hasLastStamp = false;
  let sinceStamp = 0;
  const steps = new FootstepTracker();

  // 天气（目标值和平滑后的当前值）
  const weather = { rain: 0, wind: 0.35, evening: 0, rainNow: 0, windNow: 0.35, eveningNow: 0 };
  const sunDir = new THREE.Vector3().copy(U.sunDir.value);
  const listeners = new Set<(rain: number) => void>();
  let notifiedRain = -1;
  let splashAcc = 0;
  let cpuMs = 0;

  // 地面半径：有海时不低于海面（水花落在海面上）
  const groundOf = (dir: THREE.Vector3): number => {
    const h = planet.height(dir);
    return planet.sea !== null ? Math.max(h, planet.sea) : h;
  };
  const env: ButterflyEnv = { center: planet.center, ground: groundOf };
  if (planet.flowerNear) env.flowerNear = (pos, r, out) => planet.flowerNear!(pos, r, out);

  // 临时变量（热路径不新建对象）
  const _cam = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _upv = new THREE.Vector3();
  const _back = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _w = new THREE.Vector3();
  const _t1 = new THREE.Vector3();
  const _t2 = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _col = new THREE.Color();
  const _size = new THREE.Vector2();
  const _localA = new THREE.Vector3();
  const _localB = new THREE.Vector3();
  const _sp = new THREE.Vector3();
  const _sr = new THREE.Vector3();
  const _sf = new THREE.Vector3();

  // 一步：脚边扬起几团土或草屑。side：+1 左脚、-1 右脚；big：落地时的一圈
  function footstep(side: number, speed: number, big: boolean): void {
    const t = U.time.value;
    _upv.copy(walker.pos).sub(planet.center).normalize();
    _sf.copy(walker.vel).addScaledVector(_upv, -walker.vel.dot(_upv));
    if (_sf.lengthSq() < 1e-6) tangentOf(_upv, _sf);
    _sf.normalize();
    _sr.crossVectors(_sf, _upv);
    // 脚的位置：身体两侧 9 厘米，贴回地面
    _sp.copy(walker.pos).addScaledVector(_sr, -side * 0.09).sub(planet.center);
    _dir.copy(_sp).normalize();
    const bare = planet.bare ? THREE.MathUtils.clamp(planet.bare(_dir), 0, 1) : 0;
    _sp.copy(_dir).multiplyScalar(groundOf(_dir)).add(planet.center);
    const s = THREE.MathUtils.clamp(speed / 2.2, 0.5, 1.6) * (big ? 1.5 : 1);
    const puffs = big ? 6 : bare > 0.5 ? 3 : 1;
    const flecks = big ? 2 : bare > 0.5 ? 1 : 3;
    _col.copy(COL_POLLEN).lerp(COL_DIRT, bare);
    for (let i = 0; i < puffs; i++) {
      const a = big ? (i / puffs) * Math.PI * 2 : (rng() - 0.5) * 2.2 + Math.PI;
      _v.copy(_sf).multiplyScalar(Math.cos(a)).addScaledVector(_sr, Math.sin(a)).multiplyScalar((0.35 + rng() * 0.35) * s);
      if (!big) _v.addScaledVector(_sf, -speed * 0.12);
      _v.addScaledVector(_upv, 0.15 + rng() * 0.25);
      _w.copy(_sp).addScaledVector(_upv, 0.03);
      // 土路上是一团团黄土；草地上只有一小团很淡的花粉灰，主要是草屑
      const dirt = bare > 0.5 || big;
      const op = (dirt ? 0.5 : 0.16) * (0.8 + rng() * 0.4);
      const s1 = (dirt ? 0.26 + rng() * 0.16 : 0.14 + rng() * 0.08) * s;
      dust.emit(t, _w, _v, _col, 0, 0.55 + rng() * 0.35, 0.06 * s, s1, op, rng());
    }
    for (let i = 0; i < flecks; i++) {
      const a = (rng() - 0.5) * 2.6 + Math.PI;
      _v.copy(_sf).multiplyScalar(Math.cos(a) * 0.5).addScaledVector(_sr, Math.sin(a) * 0.5).multiplyScalar(s);
      _v.addScaledVector(_upv, 0.9 + rng() * 0.6);
      if (bare > 0.5) _col.copy(COL_CRUMB);
      else _col.copy(COL_GRASS_A).lerp(COL_GRASS_B, rng());
      _w.copy(_sp).addScaledVector(_upv, 0.05);
      dust.emit(t, _w, _v, _col, 1, 0.45 + rng() * 0.2, 0.022, 0.026, 0.95, rng());
    }
  }

  function updateLight(): void {
    const e = weather.eveningNow;
    const r = weather.rainNow;
    // 太阳在当地地平线以下时没有直射光
    const sunUp = THREE.MathUtils.smoothstep(sunDir.dot(_camUp), -0.12, 0.12);
    const night = THREE.MathUtils.smoothstep(e, 0.75, 1);
    _col.copy(SUN_DAY).lerp(SUN_DUSK, THREE.MathUtils.smoothstep(e, 0.2, 0.75)).multiplyScalar((1 - 0.65 * r) * (1 - 0.85 * night) * sunUp * 0.85);
    U.sunCol.value.set(_col.r, _col.g, _col.b);
    if (e < 0.6) _col.copy(AMB_DAY).lerp(AMB_DUSK, e / 0.6);
    else _col.copy(AMB_DUSK).lerp(AMB_NIGHT, (e - 0.6) / 0.4);
    _col.lerp(AMB_RAIN, r * 0.5).multiplyScalar(1 - 0.25 * r);
    U.ambCol.value.set(_col.r, _col.g, _col.b);
    U.sunDir.value.copy(sunDir);
  }

  function update(dtIn: number, camera: THREE.Camera): void {
    const t0 = performance.now();
    const dt = THREE.MathUtils.clamp(dtIn, 0, 0.1);
    U.time.value += dt;
    const t = U.time.value;

    // 镜头
    camera.updateMatrixWorld();
    const me = camera.matrixWorld.elements;
    _cam.set(me[12], me[13], me[14]);
    _right.set(me[0], me[1], me[2]).normalize();
    _upv.set(me[4], me[5], me[6]).normalize();
    _back.set(me[8], me[9], me[10]).normalize();
    U.cam.value.copy(_cam);
    U.camRight.value.copy(_right);
    U.camUp.value.copy(_upv);
    renderer.getDrawingBufferSize(_size);
    const persp = camera as THREE.PerspectiveCamera;
    const fov = persp.isPerspectiveCamera ? persp.getEffectiveFOV() : 50;
    U.pxAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(1, _size.y);

    // 场中心：镜头前方 4 米处的地面点（镜头看向的那一片）
    _camUp.copy(_cam).sub(planet.center);
    const camR = _camUp.length();
    _camUp.divideScalar(camR || 1);
    _fwd.copy(_back).negate().addScaledVector(_camUp, _back.dot(_camUp));
    if (_fwd.lengthSq() < 1e-6) tangentOf(_camUp, _fwd);
    _fwd.normalize();
    _dir.copy(_cam).sub(planet.center).addScaledVector(_fwd, 4).normalize();
    const fieldR = groundOf(_dir);
    U.field.value.copy(_dir).multiplyScalar(fieldR).add(planet.center);
    U.groundR.value = fieldR;
    U.center.value.copy(planet.center);
    const camAlt = camR - groundOf(_camUp); // 镜头离地多高：太高（俯瞰整颗星球）时雨淡出
    const nearGround = 1 - THREE.MathUtils.smoothstep(camAlt, 10, 18);

    // 天气平滑：雨慢慢下大（约 4 秒）、风和傍晚约 2 秒
    weather.rainNow += (weather.rain - weather.rainNow) * (1 - Math.exp(-0.8 * dt));
    if (Math.abs(weather.rain - weather.rainNow) < 0.002) weather.rainNow = weather.rain;
    weather.windNow += (weather.wind - weather.windNow) * (1 - Math.exp(-1.5 * dt));
    weather.eveningNow += (weather.evening - weather.eveningNow) * (1 - Math.exp(-1.5 * dt));
    if (Math.abs(weather.rainNow - notifiedRain) > 0.002 || (weather.rainNow === weather.rain && notifiedRain !== weather.rain)) {
      notifiedRain = weather.rainNow;
      for (const cb of listeners) cb(notifiedRain);
    }
    setWind({ strength: weather.windNow, center: planet.center });
    updateLight();
    const wt = windClock();

    // 影响球（草被分开、花瓣被扬开）
    if (walker.has) U.influence.value.set(walker.pos.x, walker.pos.y, walker.pos.z, INFLUENCE_RADIUS);
    else U.influence.value.w = 0;

    // 平均风（不含阵风，平滑）：飘落物在空中按它漂。方向在场中心的切平面里
    _w.copy(WIND.direction).addScaledVector(_camUp, -WIND.direction.dot(_camUp)).multiplyScalar(WIND.speed * WIND.strength * 0.75);
    U.windMean.value.lerp(_w, 1 - Math.exp(-0.5 * dt));
    petals.mesh.visible = enabled.petals;
    fluff.mesh.visible = enabled.petals;
    petals.mesh.geometry.instanceCount = PETAL_MAX[quality];
    fluff.mesh.geometry.instanceCount = FLUFF_MAX[quality];
    counts.petals = enabled.petals ? PETAL_MAX[quality] + FLUFF_MAX[quality] : 0;

    // 萤火虫：傍晚大于 0.5 才出来；白天是淡淡的花粉
    const fire = THREE.MathUtils.smoothstep(weather.eveningNow, 0.5, 0.8) * (1 - 0.7 * weather.rainNow);
    const pollen = (1 - THREE.MathUtils.smoothstep(weather.eveningNow, 0.35, 0.6)) * (1 - weather.rainNow);
    U.fireAmt.value = fire;
    U.pollenAmt.value = pollen;
    fireflies.mesh.visible = enabled.fireflies && fire + pollen > 0.001;
    fireflies.mesh.geometry.instanceCount = FIRE_MAX[quality];
    counts.fireflies = fireflies.mesh.visible ? FIRE_MAX[quality] : 0;

    // 雨：进度时钟按下落速度推进；雨量小时少画几根；镜头离地太高时淡出
    const rr = weather.rainNow * nearGround;
    U.rainAmt.value = rr;
    U.rainLen.value = 0.32 + 0.22 * weather.rainNow;
    U.rainTime.value += (dt * RAIN_FALL) / (RAIN_TOP + U.rainLen.value);
    if (U.rainTime.value > 4000) U.rainTime.value -= 4000; // 防止 float32 精度变差（这一帧全部雨丝换位置，雨里看不出来）
    windAt(U.field.value, wt, _w);
    U.rainWind.value.copy(_w);
    const rainN = Math.ceil(RAIN_MAX[quality] * Math.min(1, rr * 1.25));
    rain.mesh.visible = enabled.rain && rr > 0.003 && rainN > 0;
    rain.mesh.geometry.instanceCount = Math.max(1, rainN);
    counts.rain = rain.mesh.visible ? rainN : 0;

    // 水花：按雨量在镜头前方的地面上随机落点（真实地面高度），只在出生时 CPU 写一次
    splashes.mesh.visible = enabled.splashes && rr > 0.003;
    counts.splashes = splashes.mesh.visible ? SPLASH_SLOTS : 0;
    if (splashes.mesh.visible) {
      splashAcc += rr * (quality === 'high' ? 260 : 120) * dt;
      _t2.crossVectors(_camUp, _fwd);
      let guard = 0;
      while (splashAcc >= 1 && guard++ < 40) {
        splashAcc -= 1;
        // 镜头前方 ±80° 的扇形环里按面积均匀取点，1.2–10 米
        const ang = (rng() - 0.5) * 2.8;
        const rad = Math.sqrt(1.44 + rng() * (100 - 1.44));
        _t1.copy(_fwd).multiplyScalar(Math.cos(ang)).addScaledVector(_t2, Math.sin(ang));
        _dir.copy(_camUp).multiplyScalar(fieldR).addScaledVector(_t1, rad).normalize();
        _p.copy(_dir).multiplyScalar(groundOf(_dir)).add(planet.center);
        splashes.emit(t, _p);
      }
      if (splashAcc > 40) splashAcc = 0;
    } else splashAcc = 0;

    // 脚步和落地（离地超过 0.25 秒再落地，扬起一圈）
    const speed = walker.has ? walker.vel.length() : 0;
    const landed = walker.has && walker.grounded && !walker.wasGrounded && walker.air > 0.25;
    if (walker.has && !walker.grounded) walker.air += dt;
    else if (walker.grounded) walker.air = 0;
    walker.wasGrounded = walker.grounded;
    if (walker.has && enabled.dust) {
      const n = steps.advance(speed, dt, walker.grounded);
      for (let i = 0; i < n; i++) footstep(steps.foot, speed, false);
      if (landed) footstep(1, Math.max(speed, 1.5), true);
    } else steps.advance(0, dt, false);
    dust.mesh.visible = enabled.dust;
    counts.dust = enabled.dust ? DUST_SLOTS : 0;

    // 踩踏图：站在地上就盖章（走动时每帧；站着不动时每 0.5 秒补一次），恢复按固定间隔
    if (enabled.trample) {
      trample.decay(dt);
      sinceStamp += dt;
      if (walker.has && walker.grounded) {
        _localB.copy(walker.pos).sub(planet.center);
        _localA.copy(hasLastStamp ? lastStamp : _localB);
        // 一帧挪了 2 米以上是传送（换星球、重生），不把两点连起来
        if (_localA.distanceToSquared(_localB) > 4) _localA.copy(_localB);
        const moved = _localA.distanceToSquared(_localB) > 1e-4;
        if (moved || sinceStamp > 0.5) {
          trample.stamp(_localA, _localB, _localB.length(), 1);
          lastStamp.copy(_localB);
          hasLastStamp = true;
          sinceStamp = 0;
        }
      } else hasLastStamp = false;
    }

    // 蝴蝶
    const bn = BUTTERFLY_MAX[quality];
    butterflies.mesh.visible = enabled.butterflies;
    butterflies.mesh.geometry.instanceCount = bn;
    counts.butterflies = enabled.butterflies ? bn : 0;
    if (enabled.butterflies) {
      if (!sim.placed) sim.scatter(env, walker.has ? walker.pos : U.field.value, 9);
      sim.update(dt, t, env, walker.has ? walker.pos : null, speed, U.field.value, bn);
      const pa = butterflies.a.array as Float32Array;
      const fa = butterflies.b.array as Float32Array;
      for (let i = 0; i < bn; i++) {
        pa[i * 4] = sim.pos[i * 3];
        pa[i * 4 + 1] = sim.pos[i * 3 + 1];
        pa[i * 4 + 2] = sim.pos[i * 3 + 2];
        pa[i * 4 + 3] = sim.phase[i];
        fa[i * 4] = sim.fwd[i * 3];
        fa[i * 4 + 1] = sim.fwd[i * 3 + 1];
        fa[i * 4 + 2] = sim.fwd[i * 3 + 2];
        fa[i * 4 + 3] = sim.rest[i];
      }
      butterflies.a.needsUpdate = true;
      butterflies.b.needsUpdate = true;
    }
    cpuMs = performance.now() - t0;
  }

  function setWalker(pos: THREE.Vector3 | null, velocity: THREE.Vector3, grounded: boolean): void {
    if (pos === null) {
      walker.has = false;
      walker.air = 0;
      walker.wasGrounded = false;
      return;
    }
    if (!walker.has) walker.wasGrounded = grounded; // 刚出现不算「落地」
    walker.has = true;
    walker.pos.copy(pos);
    walker.vel.copy(velocity);
    walker.grounded = grounded;
  }

  function setWeather(w: LifeWeather): void {
    weather.rain = THREE.MathUtils.clamp(w.rain, 0, 1);
    weather.wind = THREE.MathUtils.clamp(w.wind, 0, 1);
    if (w.evening !== undefined) weather.evening = THREE.MathUtils.clamp(w.evening, 0, 1);
    if (w.sunDir) sunDir.copy(w.sunDir).normalize();
  }

  function modes(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < BUTTERFLY_MAX[quality]; i++) out[sim.mode[i]]++;
    return out;
  }

  return {
    update,
    setWalker,
    setWeather,
    trample: {
      texture: trample.rt.texture,
      uvOf: (dir: THREE.Vector3, out: THREE.Vector2 = new THREE.Vector2()) => octEncode(dir, out),
    },
    get rain() {
      return weather.rainNow;
    },
    onRain(cb) {
      listeners.add(cb);
      cb(weather.rainNow);
      return () => {
        listeners.delete(cb);
      };
    },
    influence: U.influence,
    setEnabled(effect, on) {
      enabled[effect] = on;
      if (effect === 'trample' && !on) {
        trample.clear();
        hasLastStamp = false;
      }
    },
    isEnabled: (effect) => enabled[effect],
    setQuality(q) {
      quality = q;
    },
    setPlanet(p) {
      planet = p;
      env.center = p.center;
      env.flowerNear = p.flowerNear ? (pos, r, out) => p.flowerNear!(pos, r, out) : undefined;
      U.center.value.copy(p.center);
      trample.clear();
      hasLastStamp = false;
      sim.placed = false;
    },
    stats() {
      let drawCalls = 0;
      for (let i = 0; i < meshes.length; i++) if (meshes[i].visible) drawCalls++;
      counts.trample = enabled.trample ? 1 : 0;
      return {
        backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2',
        drawCalls,
        instances: { ...counts },
        trampleSize,
        tramplePasses: trample.passes,
        cpuMs,
        dustAlive: dust.aliveCount(U.time.value),
        splashesAlive: splashes.aliveCount(U.time.value),
        butterflyModes: modes(),
        startles: sim.startles,
        fireflies: U.fireAmt.value,
        pollen: U.pollenAmt.value,
      };
    },
    debug: { trampleTarget: trample.rt, butterflies: sim.pos },
    dispose() {
      scene.remove(root);
      for (const d of [dust, splashes, rain, petals, fluff, fireflies, butterflies, trample]) d.dispose();
      listeners.clear();
    },
  };
}

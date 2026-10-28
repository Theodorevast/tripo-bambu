import * as THREE from 'three/webgpu';
import { cross, dot, float, max, normalize, saturate, sin, texture, uniform, vec2, vec3 } from 'three/tsl';

// 全局风场：草、飘落物、尘土、雨丝共用同一个风。
// 同一套公式写了两份：windAt() 是纯 JS（CPU 上要风的地方用：飘落物的整体漂移、雨丝的斜度、尘土的初速度），
// windNode() 是 TSL（着色器里逐顶点算：草的摆动、花瓣的打旋）。两份逐项对应，改一处要同时改另一处。
//
// 做法参考 Bruno Simon folio-2025 的 Wind.js（MIT，https://github.com/brunosimon/folio-2025）：
// 一张噪声贴图按两种尺度采样两次、沿风向滚动，相加得到一阵一阵的阵风；风的时钟按「风越大走得越快」累加，草浪推进得也越快。
// 改动：星球上没有统一的「水平面」，盛行风方向按位置投影到当地切平面（往球心是下）；噪声坐标用顺风 / 横风两个方向的投影；
// 加一个缓慢的时间包络和横向小湍流；噪声贴图在 CPU 上生成，同一份数据 CPU 也能双线性采样，所以 JS 版和 TSL 版算出来一样。
// 球面上连续的切向场一定有零点（毛球定理）：零点在 direction 穿过星球的两处，那里的风平滑减弱到 0，不会突然转向。

export interface WindParams {
  strength: number; // 0..1：0 无风，1 大风
  speed: number; // strength = 1 时的平均风速（米/秒）
  direction: THREE.Vector3; // 盛行风方向（世界坐标，单位向量）
  center: THREE.Vector3; // 星球中心：风贴着这个球的切平面吹
}

export const WIND: Readonly<WindParams> = {
  strength: 0.35,
  speed: 6,
  direction: new THREE.Vector3(0.94, 0, 0.34).normalize(),
  center: new THREE.Vector3(),
};

// ---------- 噪声贴图：128² 可平铺的 Perlin（两个八度），R、G 两个通道互不相关 ----------

export const WIND_NOISE_SIZE = 128;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 周期为 period 个格子的 2D Perlin 噪声，约 [-0.7, 0.7]
function perlinPeriodic(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash2(((ix % period) + period) % period, ((iy % period) + period) % period, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(fx);
  const v = fade(fy);
  const n00 = g(xi, yi, fx, fy);
  const n10 = g(xi + 1, yi, fx - 1, fy);
  const n01 = g(xi, yi + 1, fx, fy - 1);
  const n11 = g(xi + 1, yi + 1, fx - 1, fy - 1);
  return (n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v;
}

function bakeNoise(): Uint8Array {
  const n = WIND_NOISE_SIZE;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let c = 0; c < 2; c++) {
        const u = (x / n) * 6;
        const v = (y / n) * 6;
        const f = perlinPeriodic(u, v, 6, 11 + c * 7) * 0.8 + perlinPeriodic(u * 2, v * 2, 12, 23 + c * 7) * 0.2;
        data[(y * n + x) * 4 + c] = Math.round(THREE.MathUtils.clamp(f * 0.85 + 0.5, 0, 1) * 255);
      }
      data[(y * n + x) * 4 + 3] = 255;
    }
  }
  return data;
}

const noiseData = bakeNoise();
export const windNoiseTexture = new THREE.DataTexture(noiseData, WIND_NOISE_SIZE, WIND_NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
windNoiseTexture.wrapS = windNoiseTexture.wrapT = THREE.RepeatWrapping;
windNoiseTexture.magFilter = windNoiseTexture.minFilter = THREE.LinearFilter;
windNoiseTexture.generateMipmaps = false;
windNoiseTexture.name = 'wind.noise';
windNoiseTexture.needsUpdate = true;

// CPU 上的双线性采样，和 GPU 的 LinearFilter + RepeatWrapping 一样（像素中心在 (i + 0.5) / N）
export function sampleWindNoise(u: number, v: number, channel: 0 | 1): number {
  const n = WIND_NOISE_SIZE;
  const x = u * n - 0.5;
  const y = v * n - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = ((x0 % n) + n) % n;
  const ya = ((y0 % n) + n) % n;
  const xb = (xa + 1) % n;
  const yb = (ya + 1) % n;
  const at = (xx: number, yy: number) => noiseData[(yy * n + xx) * 4 + channel] / 255;
  const top = at(xa, ya) + (at(xb, ya) - at(xa, ya)) * fx;
  const bottom = at(xa, yb) + (at(xb, yb) - at(xa, yb)) * fx;
  return top + (bottom - top) * fy;
}

// ---------- 风的时钟 ----------
// 「风的时间」按 (0.4 + 1.2 × strength) 倍速累加：风大时草浪推进得快，改风力时不会跳。
// 谁要用都调 windClock()：它按上次调用以来的真实时间补上这一段，同一时刻多次调用结果一样，
// 所以不需要有人每帧去推进它，草、生机、演示页各自调用也不会打架。GPU 端的 windTime 每次渲染前取一次
let clockReal = -1;
let clockWind = 0;

export function windRate(strength = WIND.strength): number {
  return 0.4 + 1.2 * strength;
}

export function windClock(nowSec = performance.now() / 1000): number {
  if (clockReal < 0) clockReal = nowSec;
  const dt = nowSec - clockReal;
  if (dt > 0) {
    // 标签页在后台很久再回来：最多补 1 秒，草浪不会一下子跑出去很远（反正那段时间没人看见）
    clockWind += Math.min(dt, 1) * windRate();
    clockReal = nowSec;
  }
  return clockWind;
}

export const windTime = uniform(0).onRenderUpdate(() => windClock());

// ---------- 参数和 uniform ----------

const side = new THREE.Vector3(); // 和 direction 垂直的单位向量：横风坐标用

export const windUniforms = {
  strength: uniform(WIND.strength),
  speed: uniform(WIND.speed),
  direction: uniform(WIND.direction.clone()),
  side: uniform(new THREE.Vector3()),
  center: uniform(WIND.center.clone()),
};

function syncSide(): void {
  const d = WIND.direction;
  // 横风方向：direction × 世界 Y；风正好朝上下吹时退回 direction × 世界 X
  side.set(-d.z, 0, d.x);
  if (side.lengthSq() < 1e-6) side.set(0, d.z, -d.y);
  side.normalize();
  windUniforms.side.value.copy(side);
}
syncSide();

// 改风：只改传进来的字段。可以每帧调用（不新建对象）。改强度前先把时钟按旧的倍速推进到现在
export function setWind(p: Partial<WindParams>): void {
  const w = WIND as WindParams;
  if (p.strength !== undefined) {
    windClock();
    w.strength = THREE.MathUtils.clamp(p.strength, 0, 1);
  }
  if (p.speed !== undefined) w.speed = Math.max(0, p.speed);
  if (p.direction !== undefined) {
    w.direction.copy(p.direction);
    if (w.direction.lengthSq() < 1e-12) w.direction.set(1, 0, 0);
    w.direction.normalize();
  }
  if (p.center !== undefined) w.center.copy(p.center);
  windUniforms.strength.value = w.strength;
  windUniforms.speed.value = w.speed;
  windUniforms.direction.value.copy(w.direction);
  windUniforms.center.value.copy(w.center);
  syncSide();
}

// ---------- 风场公式 ----------
// 两层噪声：A 层大（一块 40 米平铺一次，团块约 6 米）、慢；B 层小（16 米一块，团块约 2.7 米）、稍快。都沿顺风方向推进。
// 推进速度是「每单位风时间多少米」：风力 0.35 时风时间约 0.8 倍速，草浪约 2 米/秒；风力 1 时 1.6 倍速
const A_SCALE = 1 / 40;
const A_SPEED = 2.2;
const B_SCALE = 1 / 16;
const B_SPEED = 3.2;
const POLE_SOFT = 0.35; // 投影后切向分量 |d| 小于这个值（约 20°）的地方风平滑减弱

function gustOf(nA: number, nB: number, t: number): number {
  const g = THREE.MathUtils.clamp((nA - 0.5) * 1.8 + (nB - 0.5) * 0.9 + 0.5, 0, 1);
  const env = 0.75 + 0.25 * Math.sin(0.21 * t + 0.7 * Math.sin(0.083 * t));
  return g * env;
}

const _q = new THREE.Vector3();
const _up = new THREE.Vector3();
const _base = new THREE.Vector3();
const _cross = new THREE.Vector3();

// 风速向量（世界坐标，米/秒，和地面相切），写进 out。pos 是世界坐标，t 是风的时间（windClock()）
export function windAt(pos: THREE.Vector3, t: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const D = WIND.direction;
  _q.copy(pos).sub(WIND.center);
  const r = _q.length();
  if (r < 1e-9 || WIND.strength <= 0) return out.set(0, 0, 0);
  _up.copy(_q).divideScalar(r);
  _base.copy(D).addScaledVector(_up, -D.dot(_up));
  _base.divideScalar(Math.max(_base.length(), POLE_SOFT));
  const s = _q.dot(D);
  const c = _q.dot(side);
  const nA = sampleWindNoise((s - t * A_SPEED) * A_SCALE, c * A_SCALE, 0);
  const nB = sampleWindNoise((s - t * B_SPEED) * B_SCALE, (c + 3.7) * B_SCALE, 1);
  const amp = WIND.speed * WIND.strength;
  const mag = amp * (0.35 + 1.1 * gustOf(nA, nB, t));
  // 横向小湍流：切平面里和主风垂直的方向
  _cross.crossVectors(_up, _base);
  const turb = amp * 0.5 * (nB - 0.5);
  return out.copy(_base).multiplyScalar(mag).addScaledVector(_cross, turb);
}

// 阵风系数 0..1（乘了 strength，不含平均风）：草尖亮度之类只想要「这会儿风大不大」的地方用
export function gustAt(pos: THREE.Vector3, t: number): number {
  _q.copy(pos).sub(WIND.center);
  const s = _q.dot(WIND.direction);
  const c = _q.dot(side);
  const nA = sampleWindNoise((s - t * A_SPEED) * A_SCALE, c * A_SCALE, 0);
  const nB = sampleWindNoise((s - t * B_SPEED) * B_SCALE, (c + 3.7) * B_SCALE, 1);
  return gustOf(nA, nB, t) * WIND.strength;
}

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

function noisesNode(q: V3, t: F): { nA: F; nB: F; s: F; c: F } {
  const s = dot(q, windUniforms.direction);
  const c = dot(q, windUniforms.side);
  const nA = texture(windNoiseTexture, vec2(s.sub(t.mul(A_SPEED)), c).mul(A_SCALE)).r;
  const nB = texture(windNoiseTexture, vec2(s.sub(t.mul(B_SPEED)), c.add(3.7)).mul(B_SCALE)).g;
  return { nA, nB, s, c };
}

function gustNodeOf(nA: F, nB: F, t: F): F {
  const g = saturate(nA.sub(0.5).mul(1.8).add(nB.sub(0.5).mul(0.9)).add(0.5));
  const env = sin(t.mul(0.21).add(sin(t.mul(0.083)).mul(0.7))).mul(0.25).add(0.75);
  return g.mul(env);
}

// TSL 版的 windAt：pos 是世界坐标（vec3 节点），返回风速向量（米/秒，世界坐标，和地面相切）。
// 草：草尖偏移 ≈ windNode(叶根世界坐标) × 刚度 × 高度²（根不动、尖动得最多）；花瓣：位置加上 windNode × 时间系数
export function windNode(pos: V3, t: F = windTime): V3 {
  const u = windUniforms;
  const q = pos.sub(u.center);
  const up = normalize(q);
  const d = u.direction.sub(up.mul(dot(u.direction, up)));
  const base = d.div(max(d.length(), float(POLE_SOFT)));
  const { nA, nB } = noisesNode(q, t);
  const amp = u.speed.mul(u.strength);
  const mag = amp.mul(gustNodeOf(nA, nB, t).mul(1.1).add(0.35));
  const turb = amp.mul(0.5).mul(nB.sub(0.5));
  return vec3(base.mul(mag).add(cross(up, base).mul(turb)));
}

// TSL 版的 gustAt：0..1
export function windGustNode(pos: V3, t: F = windTime): F {
  const { nA, nB } = noisesNode(pos.sub(windUniforms.center), t);
  return gustNodeOf(nA, nB, t).mul(windUniforms.strength);
}

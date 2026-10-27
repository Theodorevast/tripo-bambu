// 星云噪声：MaterialX 的 3D Perlin 噪声，three 的 TSL 函数 mx_fractal_noise_float 用的就是它。
// 这里在 CPU 上逐步照搬（同一个格点哈希、同一组梯度、同一种插值），算出来的值和 GPU 上逐像素算的一样，
// 差别只在 float32 和 float64 的精度（约 1e-6）

export type NoiseFn = (x: number, y: number, z: number) => number;

const HASH_SEED = (0xdeadbeef + (3 << 2) + 13) | 0; // mx_hash_int 三个参数时的初值
const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

// 格点哈希：Bob Jenkins 的 bjfinal（同 mx_hash_int(x, y, z)），全部按 32 位整数算
function hash3(x: number, y: number, z: number): number {
  let a = (HASH_SEED + x) | 0;
  let b = (HASH_SEED + y) | 0;
  let c = (HASH_SEED + z) | 0;
  c ^= b; c = (c - rotl(b, 14)) | 0;
  a ^= c; a = (a - rotl(c, 11)) | 0;
  b ^= a; b = (b - rotl(a, 25)) | 0;
  c ^= b; c = (c - rotl(b, 16)) | 0;
  a ^= c; a = (a - rotl(c, 4)) | 0;
  b ^= a; b = (b - rotl(a, 14)) | 0;
  c ^= b; c = (c - rotl(b, 24)) | 0;
  return c;
}

// 哈希的低 4 位 h 选 12 个梯度方向之一，和格点到采样点的偏移做点积（同 mx_gradient_float）
function grad(h: number, x: number, y: number, z: number): number {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

// grad 对 (x, y, z) 是线性的：先算好 16 个编号各自的梯度向量，逐像素只做点积，没有随哈希乱跳、猜不准的分支
const GX = new Float64Array(16);
const GY = new Float64Array(16);
const GZ = new Float64Array(16);
for (let h = 0; h < 16; h++) {
  GX[h] = grad(h, 1, 0, 0);
  GY[h] = grad(h, 0, 1, 0);
  GZ[h] = grad(h, 0, 0, 1);
}
const dot = (h: number, x: number, y: number, z: number) => GX[h] * x + GY[h] * y + GZ[h] * z;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

// 一个八度用到的格点：采样点都落在 [lo, hi]³ 里（方向是单位向量），所以先把这个立方体里每个格点的梯度编号
// （哈希的低 4 位）算好，逐像素只查表，不用每次算 8 个哈希
interface Lattice {
  min: number; // 立方体最小角的格点坐标
  n: number; // 每条边的格点数
  h: Uint8Array; // 每个格点的梯度编号
}

function lattice(lo: number, hi: number): Lattice {
  const min = Math.floor(lo) - 1; // 两边各多留一格，防浮点误差越界
  const n = Math.floor(hi) + 3 - min;
  const h = new Uint8Array(n * n * n);
  for (let i = 0, o = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++, o++) h[o] = hash3(min + i, min + j, min + k) & 15;
    }
  }
  return { min, n, h };
}

// 3D Perlin 噪声（同 mx_perlin_noise_float）
function perlin(l: Lattice, px: number, py: number, pz: number): number {
  const X = Math.floor(px);
  const Y = Math.floor(py);
  const Z = Math.floor(pz);
  const fx = px - X;
  const fy = py - Y;
  const fz = pz - Z;
  const fx1 = fx - 1;
  const fy1 = fy - 1;
  const fz1 = fz - 1;
  const { h, n, min } = l;
  const dx = n * n;
  const dy = n;
  const o = ((X - min) * n + (Y - min)) * n + (Z - min);
  // 8 个角：v0 = (X, Y, Z)、v1 = (X+1, Y, Z)、v2 = (X, Y+1, Z) …… v7 = (X+1, Y+1, Z+1)；每个角是 梯度 · (采样点 − 格点)
  const v0 = dot(h[o], fx, fy, fz);
  const v1 = dot(h[o + dx], fx1, fy, fz);
  const v2 = dot(h[o + dy], fx, fy1, fz);
  const v3 = dot(h[o + dx + dy], fx1, fy1, fz);
  const v4 = dot(h[o + 1], fx, fy, fz1);
  const v5 = dot(h[o + dx + 1], fx1, fy, fz1);
  const v6 = dot(h[o + dy + 1], fx, fy1, fz1);
  const v7 = dot(h[o + dx + dy + 1], fx1, fy1, fz1);
  const s = fade(fx);
  const t = fade(fy);
  const r = fade(fz);
  const s1 = 1 - s;
  const t1 = 1 - t;
  const r1 = 1 - r;
  // 三线性插值（同 mx_trilerp），再乘 mx_gradient_scale3d 的 0.982
  return 0.982 * (r1 * (t1 * (v0 * s1 + v1 * s) + t * (v2 * s1 + v3 * s)) + r * (t1 * (v4 * s1 + v5 * s) + t * (v6 * s1 + v7 * s)));
}

// 一层分形噪声：mx_fractal_noise_float(dir × scale + offset, octaves)（lacunarity 2、diminish 0.5、amplitude 1）；dir 是单位向量
export function noiseLayer(scale: number, offset: number, octaves: number): NoiseFn {
  const levels: Lattice[] = [];
  for (let o = 0, f = 1; o < octaves; o++, f *= 2) levels.push(lattice((offset - scale) * f, (offset + scale) * f));
  return (x, y, z) => {
    let px = x * scale + offset;
    let py = y * scale + offset;
    let pz = z * scale + offset;
    let sum = 0;
    let amp = 1;
    for (let o = 0; o < levels.length; o++) {
      sum += amp * perlin(levels[o], px, py, pz);
      amp *= 0.5;
      px *= 2;
      py *= 2;
      pz *= 2;
    }
    return sum;
  };
}

const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

// 烘焙星云贴图：等距柱状投影，每个像素 2 字节，R = 大片的紫色星云（n1），G = 零星的暗红（n2），都映射到 0–1。
// 第 j 行第 i 列存像素中心方向上的噪声；像素中心 → 方向是 three 的 equirectUV 的反函数，天空球用
// equirectUV(方向) 采样时正好查回这个像素。噪声按 3D 方向算，所以经度 0°/360° 两边接得上，两极也不会捏成放射状
export function bakeNebula(width: number, height: number): Uint8Array {
  const n1 = noiseLayer(2.2, 0, 4);
  const n2 = noiseLayer(3.1, 7.3, 3);
  const cosLon = new Float64Array(width);
  const sinLon = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    const lon = ((i + 0.5) / width - 0.5) * Math.PI * 2;
    cosLon[i] = Math.cos(lon);
    sinLon[i] = Math.sin(lon);
  }
  const data = new Uint8Array(width * height * 2);
  for (let j = 0, k = 0; j < height; j++) {
    const lat = ((j + 0.5) / height - 0.5) * Math.PI;
    const y = Math.sin(lat);
    const r = Math.cos(lat);
    for (let i = 0; i < width; i++, k += 2) {
      const x = r * cosLon[i];
      const z = r * sinLon[i];
      data[k] = toByte(n1(x, y, z) * 0.5 + 0.5);
      data[k + 1] = toByte(n2(x, y, z) * 0.5 + 0.5);
    }
  }
  return data;
}

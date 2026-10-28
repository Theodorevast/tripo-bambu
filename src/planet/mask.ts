import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import type { Placement } from '../data/types';
import { hashString, mulberry32 } from './rng';

// 星球遮罩：一张等距柱状投影的贴图（星球本地方向 → 像素），两个通道：
//   R = 土路（1 在路中间，向两边平滑降到 0），G = 作品空地（展台和作品脚下一圈露土，往外降到 0）。
// 地表着色器按它画土路和空地；草（nature/grass.ts）按 exclude(dir) 避开路、展台、作品；石头也按它避开。
// 像素 ↔ 方向和 three 的 equirectUV 互为反函数（同 scenes/nebula.ts）：第 j 行第 i 列是
// 纬度 ((j + 0.5) / H − 0.5)·π、经度 ((i + 0.5) / W − 0.5)·2π 的方向，x = cos 纬 cos 经，y = sin 纬，z = cos 纬 sin 经

export const MASK_W = 1024;
export const MASK_H = 512;

export const PATH = {
  width: 1.3, // 土路宽（米）
  soft: 0.45, // 路边从土过渡到草的宽度（米）
  ahead: 1.5, // 路从作品前面经过：离展台边这么远（米）
  wiggle: 0.9, // 路左右弯的幅度（米）
  tail: 6, // 两头再往外延伸多远（米）：像一条一直走下去的小路，不在最后一件作品前戛然而止
};

export const CLEARING = {
  margin: 0.55, // 空地比展台宽这么多（米）
  soft: 0.5,
};

// 一件作品在遮罩里的样子：方向、朝向（作品正面在切平面里的方向）、展台半径（米，已乘缩放）
export interface MaskWork {
  dir: THREE.Vector3;
  front: THREE.Vector3;
  radius: number;
}

const toByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// 方向 → 像素坐标（浮点，像素中心在 .5）
function toPixel(d: THREE.Vector3): [number, number] {
  const u = Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5;
  const v = Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5;
  return [u * MASK_W - 0.5, v * MASK_H - 0.5];
}

// 一件作品都没有的星球（星系里大多数）共用一张 1×1 的空遮罩：不为它们各占 1 MB 显存
const EMPTY = new THREE.DataTexture(new Uint8Array(2), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
EMPTY.needsUpdate = true;

const cosLat = new Float64Array(MASK_H);
const sinLat = new Float64Array(MASK_H);
const cosLon = new Float64Array(MASK_W);
const sinLon = new Float64Array(MASK_W);
for (let j = 0; j < MASK_H; j++) {
  const lat = ((j + 0.5) / MASK_H - 0.5) * Math.PI;
  cosLat[j] = Math.cos(lat);
  sinLat[j] = Math.sin(lat);
}
for (let i = 0; i < MASK_W; i++) {
  const lon = ((i + 0.5) / MASK_W - 0.5) * Math.PI * 2;
  cosLon[i] = Math.cos(lon);
  sinLon[i] = Math.sin(lon);
}

export class PlanetMask {
  data: Uint8Array | null = null; // 第一次有作品时才分配
  texture: THREE.DataTexture = EMPTY;
  // 着色器里采样遮罩用的节点：之后换成真的贴图只改它的 value，材质不用重建
  readonly node = texture(EMPTY);
  path: THREE.Vector3[] = []; // 土路中线（单位方向），按顺序

  private allocate(): Uint8Array {
    if (this.data) return this.data;
    this.data = new Uint8Array(MASK_W * MASK_H * 2);
    const tex = new THREE.DataTexture(this.data, MASK_W, MASK_H, THREE.RGFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping; // 经度 0° 和 360° 接上
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // 不用 mipmap：equirectUV 的 atan2 在接缝处跳变，导数暴涨会选到最小一级，接缝上多出一条线（同星云）。遮罩在画面上总是被放大
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.name = 'planet-mask';
    this.texture = tex;
    this.node.value = tex;
    return this.data;
  }

  // 按作品重画遮罩。radius：星球半径（米）；seed：路怎么弯（同一颗星球每次一样）
  rebuild(works: MaskWork[], radius: number, seed: number): void {
    this.path = buildPath(works, radius, seed);
    if (works.length === 0 && !this.data) return;
    this.allocate().fill(0);
    // 土路：沿中线每隔约 1/4 像素撒一个圆，取最大值。像素到中线的距离用到最近采样点的距离近似（误差不超过采样间隔的一半）
    const half = PATH.width / 2;
    const reach = half + PATH.soft;
    for (const p of densify(this.path, (0.25 * Math.PI) / MASK_H)) this.splat(p, reach / radius, 0, (a) => 1 - smooth(half - PATH.soft * 0.5, reach, a * radius));
    for (const w of works) {
      const r0 = w.radius + CLEARING.margin;
      const r1 = r0 + CLEARING.soft;
      this.splat(w.dir, r1 / radius, 1, (a) => 1 - smooth(r0 - CLEARING.soft * 0.4, r1, a * radius));
    }
    this.texture.needsUpdate = true;
  }

  // 在方向 c 周围球心角 maxAngle 以内的像素上，通道 ch 取 max(原值, value(到 c 的球心角))
  private splat(c: THREE.Vector3, maxAngle: number, ch: 0 | 1, value: (angle: number) => number): void {
    const [pi, pj] = toPixel(c);
    const dj = Math.ceil((maxAngle / Math.PI) * MASK_H) + 1;
    const j0 = Math.max(0, Math.floor(pj) - dj);
    const j1 = Math.min(MASK_H - 1, Math.ceil(pj) + dj);
    const cosMax = Math.cos(maxAngle);
    const data = this.data!;
    for (let j = j0; j <= j1; j++) {
      const cl = cosLat[j];
      // 这一行上经度方向要扫多宽：靠近两极时一行很短，整行都扫
      const di = cl * MASK_W < 4 ? MASK_W : Math.min(MASK_W, Math.ceil(((maxAngle / Math.max(cl, 1e-3)) / (2 * Math.PI)) * MASK_W) + 2);
      const iStart = di >= MASK_W ? 0 : Math.floor(pi) - di;
      const iEnd = di >= MASK_W ? MASK_W - 1 : Math.ceil(pi) + di;
      for (let ii = iStart; ii <= iEnd; ii++) {
        const i = ((ii % MASK_W) + MASK_W) % MASK_W;
        const x = cl * cosLon[i];
        const z = cl * sinLon[i];
        const dot = x * c.x + sinLat[j] * c.y + z * c.z;
        if (dot < cosMax) continue;
        const v = toByte(value(Math.acos(Math.min(1, dot))));
        const k = (j * MASK_W + i) * 2 + ch;
        if (v > data[k]) data[k] = v;
      }
    }
  }

  // CPU 上按方向取遮罩（双线性），0..1；给草和石头的摆放用
  sample(d: THREE.Vector3, ch: 0 | 1): number {
    const data = this.data;
    if (!data) return 0;
    const [x, y] = toPixel(d);
    const j0 = Math.max(0, Math.min(MASK_H - 1, Math.floor(y)));
    const j1 = Math.min(MASK_H - 1, j0 + 1);
    const fy = Math.min(1, Math.max(0, y - j0));
    const i0f = Math.floor(x);
    const fx = x - i0f;
    const i0 = ((i0f % MASK_W) + MASK_W) % MASK_W;
    const i1 = (i0 + 1) % MASK_W;
    const at = (i: number, j: number) => data[(j * MASK_W + i) * 2 + ch];
    const top = at(i0, j0) * (1 - fx) + at(i1, j0) * fx;
    const bottom = at(i0, j1) * (1 - fx) + at(i1, j1) * fx;
    return (top * (1 - fy) + bottom * fy) / 255;
  }

  // 草要避开的程度（0..1，1 = 一根也不长）：土路、作品空地。路边留一点稀疏的草，空地里干干净净
  exclude(d: THREE.Vector3): number {
    const path = smooth(0.25, 0.75, this.sample(d, 0));
    const clear = smooth(0.15, 0.55, this.sample(d, 1));
    return Math.max(path, clear, this.extraExclude ? this.extraExclude(d) : 0);
  }

  // 别的东西也要草和石头让开（water 角色加的接入口：nature/waterStream.ts 的小溪），0..1，和土路、空地取最大
  extraExclude: ((d: THREE.Vector3) => number) | null = null;

  dispose(): void {
    if (this.texture !== EMPTY) this.texture.dispose();
  }
}

// 土路中线：按作品绕它们中心的角度排成一串，从每件作品正面前方经过（像参观的人沿路看过去），
// 两头各再延伸一段；中间用平滑曲线连起来，再加一点左右弯（噪声），返回一串单位方向
export function buildPath(works: MaskWork[], radius: number, seed: number): THREE.Vector3[] {
  if (works.length === 0) return [];
  const rng = mulberry32(hashString(`path-${seed}`));
  const center = new THREE.Vector3();
  for (const w of works) center.add(w.dir);
  if (center.lengthSq() < 1e-8) center.copy(works[0].dir);
  center.normalize();
  // 中心处的切平面基底，用来给作品按角度排序
  const ref = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const e1 = ref.clone().addScaledVector(center, -ref.dot(center)).normalize();
  const e2 = new THREE.Vector3().crossVectors(center, e1);
  const stops = works.map((w) => {
    // 作品正面前方：沿正面方向走「展台半径 + ahead」
    const a = (w.radius + PATH.ahead) / radius;
    const p = w.dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(w.front, Math.sin(a)).normalize();
    const rel = w.dir.clone().sub(center);
    return { p, angle: Math.atan2(rel.dot(e2), rel.dot(e1)) };
  });
  stops.sort((s, t) => s.angle - t.angle);
  // 首尾间隔最大的那一处断开：路是一串，不是一圈
  let cut = 0;
  let widest = -Infinity;
  for (let k = 0; k < stops.length; k++) {
    const next = stops[(k + 1) % stops.length];
    const gap = k === stops.length - 1 ? next.angle + Math.PI * 2 - stops[k].angle : next.angle - stops[k].angle;
    if (gap > widest) {
      widest = gap;
      cut = k + 1;
    }
  }
  const ordered = [...stops.slice(cut), ...stops.slice(0, cut)].map((s) => s.p);
  // 两头延伸：沿首尾两段的方向再走 tail 米（只有一件作品时沿 e1 两边各走一段）
  const extend = (from: THREE.Vector3, toward: THREE.Vector3 | null, sign: number): THREE.Vector3 => {
    const t = toward ? from.clone().sub(toward) : e1.clone().multiplyScalar(sign);
    t.addScaledVector(from, -t.dot(from));
    if (t.lengthSq() < 1e-12) t.copy(e1);
    t.normalize();
    const a = PATH.tail / radius;
    return from.clone().multiplyScalar(Math.cos(a)).addScaledVector(t, Math.sin(a)).normalize();
  };
  const first = extend(ordered[0], ordered[1] ?? null, -1);
  const last = extend(ordered[ordered.length - 1], ordered[ordered.length - 2] ?? null, 1);
  const pts = [first, ...ordered, last];
  // Catmull-Rom 在方向空间里插值（点挨得近，插完再归一化就够了），每段按长度细分
  const out: THREE.Vector3[] = [];
  const phase = rng() * 100;
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)];
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p3 = pts[Math.min(pts.length - 1, k + 2)];
    const steps = Math.max(4, Math.ceil((p1.angleTo(p2) * radius) / 0.5));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push(catmull(p0, p1, p2, p3, t).normalize());
    }
  }
  out.push(pts[pts.length - 1].clone());
  // 左右弯：沿路的切向法线方向挪一点，幅度按路程上的两层正弦叠加（不同星球不同相位）
  let travelled = 0;
  const bent = out.map((p, k) => {
    if (k > 0) travelled += out[k - 1].angleTo(p) * radius;
    const prev = out[Math.max(0, k - 1)];
    const next = out[Math.min(out.length - 1, k + 1)];
    const along = next.clone().sub(prev);
    const side = new THREE.Vector3().crossVectors(p, along);
    if (side.lengthSq() < 1e-14) return p.clone();
    side.normalize();
    // 两头和作品附近弯得少：首尾 tail 那一段渐弱
    const off = (Math.sin(travelled * 0.37 + phase) * 0.65 + Math.sin(travelled * 0.91 + phase * 1.7) * 0.35) * PATH.wiggle;
    return p.clone().addScaledVector(side, off / radius).normalize();
  });
  return bent;
}

function catmull(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number): THREE.Vector3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const out = new THREE.Vector3();
  out.addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t);
  out.addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1);
  out.addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t);
  out.addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
  return out;
}

// 折线按最大球心角 step 加密（撒圆用）
function densify(line: THREE.Vector3[], step: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let k = 0; k < line.length - 1; k++) {
    const a = line[k];
    const b = line[k + 1];
    const n = Math.max(1, Math.ceil(a.angleTo(b) / step));
    for (let s = 0; s < n; s++) out.push(a.clone().lerp(b, s / n).normalize());
  }
  if (line.length) out.push(line[line.length - 1].clone());
  return out;
}

// 摆放 → 遮罩里的作品：方向、正面方向（模型 +Z 转到星球上）、展台半径
export function maskWorks(placements: Placement[], plinthRadiusOf: (p: Placement) => number): MaskWork[] {
  const up = new THREE.Vector3(0, 1, 0);
  return placements.map((p) => {
    const dir = new THREE.Vector3(...p.dir).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, p.yaw));
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return { dir, front, radius: plinthRadiusOf(p) * p.scale };
  });
}

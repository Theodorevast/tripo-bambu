import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute, dot, float, length, max, mix, modelWorldMatrix, normalize, positionLocal, positionWorld, renderGroup, texture, uniform, uv, vec3, vec4,
} from 'three/tsl';
import { DECOR_CENTER } from '../planet/decor';
import { mulberry32 } from '../planet/rng';
import { valueNoise3 } from '../planet/tslNoise';
import { roundRockGeometry } from './decorRocks';
import { windNode } from './wind';

// 作品四周「长出来」的小花园用的零件（stage 角色）：栅栏、花、叶丛、灌木、石头、长椅、路牌。全是代码生成的圆润造型，
// 像手办、桌游里的小配件：没有尖角，粗粗胖胖的，颜色烘进顶点（根部压暗、顶上提亮，就是绘本里那种上色）。
//
// 每种零件一个实例化网格（Gardens 管），所有零件共用一份材质、一份着色器：
// - color（顶点）：烘好的底色和明暗；paint（顶点）：x = 这一处吃不吃实例的色调（花瓣吃、花心不吃），y = 柔软度（0 根部 … 1 顶上，风吹、被翠宝碰到时弯）
// - aTint（每个实例）：rgb 色调（这一丛花什么颜色、这道栅栏刷什么漆），w = 这一件弯多少（米 / 单位风力）
// 路牌的字是另一份材质（SignAtlas 的贴图），每个实例按 aRect 取图集里自己那一格

export type PieceId = 'post' | 'rail' | 'daisy' | 'bell' | 'pom' | 'tuft' | 'bush' | 'pebble' | 'slab' | 'bench' | 'signpost' | 'signface';
export const PIECE_IDS: readonly PieceId[] = ['post', 'rail', 'daisy', 'bell', 'pom', 'tuft', 'bush', 'pebble', 'slab', 'bench', 'signpost', 'signface'];

export interface GardenPiece {
  id: PieceId;
  geometry: THREE.BufferGeometry;
  castShadow: boolean; // 小花小草不投影（阴影那一遍省一点）
}

// —— 配色（sRGB）——
export const PALETTE = {
  flowers: ['#fbf6ec', '#F2B705', '#f3a3b8', '#ef8f72', '#b9a3e8', '#a6cdf2'],
  fences: ['#b9854e', '#efe6d4', '#a9bb8c', '#c99173'],
  benches: ['#a8733f', '#e9dcc3', '#9db083'],
  sign: '#c6935a',
  stone: '#a3927a',
};

const c = (hex: string) => new THREE.Color(hex);
const STEM = c('#4d7a2a');
const LEAF_DARK = c('#365a1e');
const LEAF = c('#5c8c30');
const LEAF_LIGHT = c('#8fb64a');
const BUSH_DARK = c('#1d3a0f');
const BUSH_MID = c('#3b6a1b');
const BUSH_LIGHT = c('#7cab2f');
const BLOSSOM = c('#fff1e2');
const CENTER = c('#F2B705');
const WHITE = c('#ffffff');

type ColorFn = (p: THREE.Vector3, n: THREE.Vector3) => THREE.Color;
type NumFn = (p: THREE.Vector3) => number;

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// 一块子几何：去掉 uv、合并成带索引的、按最终位置上色、写 paint
function part(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, color: ColorFn | THREE.Color, tint: number, flex: NumFn | number): THREE.BufferGeometry {
  let g = geo;
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (g.getAttribute('uv1')) g.deleteAttribute('uv1');
  if (!g.index) g = mergeVertices(g, 1e-6);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (m) g.applyMatrix4(m);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const pnt = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    _n.fromBufferAttribute(nrm, i);
    const k = typeof color === 'function' ? color(_p, _n) : color;
    col[i * 3] = k.r;
    col[i * 3 + 1] = k.g;
    col[i * 3 + 2] = k.b;
    pnt[i * 2] = tint;
    pnt[i * 2 + 1] = typeof flex === 'function' ? flex(_p) : flex;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('paint', new THREE.Float32BufferAttribute(pnt, 2));
  return g;
}

const mat = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('decorKit: 合并几何失败（属性不一致）');
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// 高度渐变的灰（根部暗，像接触阴影）：上色交给实例色调
const aoGrey = (y0: number, y1: number, lo = 0.62) => (p: THREE.Vector3) => new THREE.Color().setScalar(lo + (1 - lo) * smooth(y0, y1, p.y));

// —— 零件 ——

// 栅栏柱：粗圆柱 + 圆球顶（玩具栅栏），高 0.42 米
function postGeometry(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.036, 0.042, 0.38, 10, 2, true), mat(0, 0.15), aoGrey(-0.03, 0.16), 1, 0),
    part(new THREE.SphereGeometry(0.052, 12, 8), mat(0, 0.37), (p) => new THREE.Color().setScalar(0.9 + 0.1 * smooth(0.34, 0.42, p.y)), 1, 0),
  ]);
}

// 横杆：长 1（实例按两根柱子的距离拉长 x），圆角方条
function railGeometry(): THREE.BufferGeometry {
  return merge([part(new RoundedBoxGeometry(1, 0.05, 0.032, 2, 0.014), null, (p) => new THREE.Color().setScalar(p.y < 0 ? 0.86 : 1), 1, 0)]);
}

// 茎：细圆柱，往一边弯一点
function stem(h: number, bend: number, r = 0.009): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.8, r, h, 5, 4, true);
  g.translate(0, h / 2, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + bend * (pos.getY(i) / h) ** 2);
  return part(g, null, (p) => STEM.clone().multiplyScalar(0.7 + 0.3 * smooth(0, h, p.y)), 0, (p) => smooth(0, h, p.y));
}

// 茎上的小叶子
function stemLeaves(h: number, flexAt: number): THREE.BufferGeometry[] {
  return [
    part(new THREE.SphereGeometry(1, 6, 4), mat(0.03, h * 0.3, 0, 0, 0.4, 0.5, 0.034, 0.006, 0.013), LEAF, 0, flexAt * 0.3),
    part(new THREE.SphereGeometry(1, 6, 4), mat(-0.026, h * 0.5, 0.01, 0, -0.5, -0.45, 0.03, 0.006, 0.012), LEAF, 0, flexAt * 0.5),
  ];
}

// 雏菊：7 片圆圆的花瓣（吃色调）+ 翠宝黄的花心（不吃）
function daisyGeometry(): THREE.BufferGeometry {
  const h = 0.27;
  const bend = 0.012;
  const parts = [stem(h, bend), ...stemLeaves(h, 1)];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const m = new THREE.Matrix4().makeTranslation(bend, h + 0.004, 0)
      .multiply(new THREE.Matrix4().makeRotationY(a))
      .multiply(new THREE.Matrix4().makeRotationZ(0.22))
      .multiply(mat(0.034, 0, 0, 0, 0, 0, 0.034, 0.008, 0.016));
    parts.push(part(new THREE.SphereGeometry(1, 6, 3), m, WHITE, 1, 1));
  }
  parts.push(part(new THREE.SphereGeometry(0.019, 8, 4), mat(bend, h + 0.009, 0, 0, 0, 0, 1, 0.65, 1), CENTER, 0, 1));
  return merge(parts);
}

// 铃铛花（像郁金香）：杯形的花冠
function bellGeometry(): THREE.BufferGeometry {
  const h = 0.3;
  const bend = -0.016;
  const cup: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    cup.push(new THREE.Vector2(0.01 + 0.036 * Math.sin(t * Math.PI * 0.62) + 0.008 * t, t * 0.066));
  }
  const lathe = new THREE.LatheGeometry(cup, 9);
  return merge([
    stem(h, bend),
    ...stemLeaves(h, 1),
    part(lathe, mat(bend, h - 0.008), (p) => new THREE.Color().setScalar(0.8 + 0.2 * smooth(h, h + 0.06, p.y)), 1, 1),
  ]);
}

// 绒球花：一颗圆球（像葱花、三叶草的花）
function pomGeometry(): THREE.BufferGeometry {
  const h = 0.25;
  const bend = 0.01;
  return merge([
    stem(h, bend),
    ...stemLeaves(h, 1),
    part(new THREE.IcosahedronGeometry(0.042, 1), mat(bend, h + 0.03), (p) => new THREE.Color().setScalar(0.84 + 0.16 * smooth(h, h + 0.05, p.y)), 1, 1),
  ]);
}

// 叶丛：7 片胖叶子围成一圈，往外张开，叶尖亮
function tuftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rng = mulberry32(5);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rng() * 0.4;
    const len = 0.085 + rng() * 0.035;
    const m = new THREE.Matrix4().makeRotationY(a)
      .multiply(new THREE.Matrix4().makeRotationZ(0.62 + rng() * 0.25))
      .multiply(mat(len * 0.9, 0, 0, 0, 0, 0, len, 0.016, 0.036));
    parts.push(part(new THREE.SphereGeometry(1, 6, 4), m, (p) => LEAF_DARK.clone().lerp(LEAF_LIGHT, smooth(0.0, 0.1, Math.hypot(p.x, p.z) + p.y * 0.6)), 0.45, (p) => smooth(0, 0.12, Math.hypot(p.x, p.z))));
  }
  return merge(parts);
}

// 灌木：几团圆球挤在一起，法线往整丛的中心方向偏（整丛像一个软软的大球那样受光，Bruno Simon Foliage.js 的做法）；
// 底下暗、顶上亮，表面点几朵小白花。高约 0.55 米、宽约 0.9 米
function bushGeometry(): THREE.BufferGeometry {
  const rng = mulberry32(31);
  const blobs: Array<[number, number, number, number]> = [[0, 0.25, 0, 0.3]];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rng() * 0.5;
    blobs.push([Math.cos(a) * 0.24, 0.17 + rng() * 0.06, Math.sin(a) * 0.24, 0.19 + rng() * 0.06]);
  }
  const center = new THREE.Vector3(0, 0.12, 0);
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.translate(x, y, z);
    // 法线往整丛中心偏 60%
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(center).normalize();
      n.fromBufferAttribute(nrm, i).lerp(v, 0.6).normalize();
      nrm.setXYZ(i, n.x, n.y, n.z);
    }
    parts.push(part(g, null, (p) => {
      const t = smooth(0.0, 0.5, p.y);
      return t < 0.5 ? BUSH_DARK.clone().lerp(BUSH_MID, t * 2) : BUSH_MID.clone().lerp(BUSH_LIGHT, (t - 0.5) * 2);
    }, 0.5, (p) => 0.4 * smooth(0.05, 0.55, p.y)));
  }
  // 小白花：贴在上半部的表面上
  for (let k = 0; k < 16; k++) {
    const b = blobs[Math.floor(rng() * blobs.length)];
    const dir = new THREE.Vector3(rng() - 0.5, 0.4 + rng() * 0.6, rng() - 0.5).normalize();
    const at = new THREE.Vector3(b[0], b[1], b[2]).addScaledVector(dir, b[3] * 0.98);
    parts.push(part(new THREE.IcosahedronGeometry(0.03, 1), mat(at.x, at.y, at.z), BLOSSOM, 0, 0.4));
  }
  return merge(parts);
}

// 石头：圆卵石（零星的、靠着灌木的）和扁石板（作品前面通往土路的踏脚石）。归一化：最大水平半径 1
function stoneGeometry(style: 'round' | 'slab', seed: number): THREE.BufferGeometry {
  const g = roundRockGeometry(seed, style, 2);
  return merge([part(g, null, (p, n) => new THREE.Color().setScalar(0.72 + 0.28 * smooth(-0.3, 0.9, n.y) * (0.75 + 0.25 * smooth(0, 0.4, p.y))), 1, 0)]);
}

// 长椅：两块座板、两条靠背、四条腿，全是圆角木条。宽 0.84 米、座高 0.31 米（给 1 米高的翠宝坐）。正面朝 +Z
function benchGeometry(): THREE.BufferGeometry {
  const wood = (lo: number) => (p: THREE.Vector3) => new THREE.Color().setScalar(lo + (1 - lo) * smooth(0, 0.3, p.y));
  const parts = [
    part(new RoundedBoxGeometry(0.84, 0.036, 0.12, 2, 0.014), mat(0, 0.31, 0.05), wood(0.8), 1, 0),
    part(new RoundedBoxGeometry(0.84, 0.036, 0.12, 2, 0.014), mat(0, 0.31, -0.08), wood(0.8), 1, 0),
    part(new RoundedBoxGeometry(0.84, 0.06, 0.03, 2, 0.012), mat(0, 0.44, -0.15, -0.2), wood(0.9), 1, 0),
    part(new RoundedBoxGeometry(0.84, 0.06, 0.03, 2, 0.012), mat(0, 0.56, -0.175, -0.2), wood(0.9), 1, 0),
  ];
  for (const x of [-0.34, 0.34]) {
    parts.push(part(new RoundedBoxGeometry(0.05, 0.31, 0.05, 1, 0.014), mat(x, 0.155, 0.08), wood(0.55), 1, 0));
    parts.push(part(new RoundedBoxGeometry(0.05, 0.6, 0.045, 1, 0.014), mat(x, 0.29, -0.13, -0.2), wood(0.55), 1, 0));
  }
  return merge(parts);
}

// 路牌：一根柱子（圆球顶）+ 一块圆角木牌。木牌正面（+Z）贴字由 signface 零件负责，位置要和 SIGN_FACE 对上
export const SIGN_FACE = { y: 0.6, z: 0.056, w: 0.44, h: 0.15 };
function signpostGeometry(): THREE.BufferGeometry {
  return merge([
    part(new THREE.CylinderGeometry(0.03, 0.036, 0.74, 10, 2, true), mat(0, 0.33), aoGrey(-0.04, 0.2), 1, 0),
    part(new THREE.SphereGeometry(0.042, 12, 8), mat(0, 0.71), WHITE, 1, 0),
    part(new RoundedBoxGeometry(0.48, 0.19, 0.04, 2, 0.016), mat(0, SIGN_FACE.y, 0.034), (p) => new THREE.Color().setScalar(0.85 + 0.15 * smooth(0.5, 0.7, p.y)), 1, 0),
  ]);
}

// 路牌的字：木牌正面的一张面片（uv 0..1，实例的 aRect 把它映射到图集里自己那一格）
function signfaceGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(SIGN_FACE.w, SIGN_FACE.h);
  g.translate(0, SIGN_FACE.y, SIGN_FACE.z);
  return g;
}

let pieces: GardenPiece[] | null = null;

export function gardenPieces(): GardenPiece[] {
  if (pieces) return pieces;
  const defs: Array<[PieceId, () => THREE.BufferGeometry, boolean]> = [
    ['post', postGeometry, true],
    ['rail', railGeometry, true],
    ['daisy', daisyGeometry, false],
    ['bell', bellGeometry, false],
    ['pom', pomGeometry, false],
    ['tuft', tuftGeometry, false],
    ['bush', bushGeometry, true],
    ['pebble', () => stoneGeometry('round', 97), true],
    ['slab', () => stoneGeometry('slab', 41), true],
    ['bench', benchGeometry, true],
    ['signpost', signpostGeometry, true],
    ['signface', signfaceGeometry, false],
  ];
  pieces = defs.map(([id, make, castShadow]) => ({ id, geometry: make(), castShadow }));
  return pieces;
}

// —— 材质 ——

// 风和碰撞的强度（?tune 可以改；uniform，不重编着色器）
export const GARDEN_LOOK = {
  sway: 1, // 风吹花草的倍数
  push: 1, // 翠宝走过时花草被推开的倍数
};
const SWAY = uniform(GARDEN_LOOK.sway).setGroup(renderGroup).onRenderUpdate(() => GARDEN_LOOK.sway);
const PUSH = uniform(GARDEN_LOOK.push).setGroup(renderGroup).onRenderUpdate(() => GARDEN_LOOK.push);

type V4U = THREE.Node<'vec4'>;
let material: THREE.MeshStandardNodeMaterial | null = null;

// 所有零件（除了路牌的字）共用。influence：生机层的「影响球」（翠宝脚底 xyz、半径 w），没有就不推开
export function gardenMaterial(influence?: V4U): THREE.MeshStandardNodeMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.74, metalness: 0 });
  m.name = 'garden-painted';
  const C = attribute<'vec3'>('color', 'vec3');
  const P = attribute<'vec2'>('paint', 'vec2');
  const T = attribute<'vec4'>('aTint', 'vec4');
  // 手绘感：两层很淡的斑（亮度 ±8%、往暖色偏一点），按世界坐标取：同一种零件摆在不同地方，斑也不一样
  const n1 = valueNoise3(positionWorld.mul(3.3));
  const n2 = valueNoise3(positionWorld.mul(9.7).add(5.1));
  const base = C.mul(mix(vec3(1, 1, 1), T.xyz, P.x));
  m.colorNode = base.mul(float(0.92).add(n1.mul(0.12)).add(n2.mul(0.05))).mul(mix(vec3(1, 1, 1), vec3(1.05, 1.0, 0.93), n1.mul(0.6)));
  // 风和碰撞：越靠上（柔软度 P.y）弯得越多，按实例的 aTint.w 定幅度。这里的 positionLocal 已经乘过实例矩阵（花园网格挂在星球下面，只有平移）
  const flex = P.y.mul(P.y).mul(T.w);
  const wp = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  let offset = windNode(wp).mul(flex.mul(SWAY));
  if (influence) {
    const up = normalize(wp.sub(DECOR_CENTER));
    const d = wp.sub(influence.xyz);
    const flat = d.sub(up.mul(dot(d, up)));
    const len = max(length(flat), 0.001);
    const amt = max(influence.w.sub(len), 0);
    offset = offset.add(flat.div(len).mul(amt.mul(flex).mul(PUSH).mul(6)));
  }
  m.positionNode = positionLocal.add(offset);
  material = m;
  return m;
}

// 路牌的字：图集贴图（不透明，木牌的底色也画在里面），每个实例按 aRect（u0, v0, du, dv）取自己那一格
export function signMaterial(atlas: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  m.name = 'garden-sign';
  const R = attribute<'vec4'>('aRect', 'vec4');
  m.colorNode = texture(atlas, uv().mul(R.zw).add(R.xy)).rgb;
  return m;
}

// —— 路牌图集：一张 1024² 的画布，2 列 × 8 行，每格 512 × 128 画一块写着作者名的木牌 ——

export const SIGN_SLOTS = 16;
const SLOT_W = 512;
const SLOT_H = 128;

export class SignAtlas {
  readonly texture: THREE.Texture;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly labels: Array<string | null> = new Array(SIGN_SLOTS).fill(null);
  private fontReady = false;

  constructor() {
    const doc = typeof document === 'undefined' ? null : document;
    this.canvas = doc ? doc.createElement('canvas') : null;
    if (this.canvas) {
      this.canvas.width = SLOT_W * 2;
      this.canvas.height = SLOT_H * 8;
      this.texture = new THREE.CanvasTexture(this.canvas);
    } else {
      this.texture = new THREE.DataTexture(new Uint8Array([200, 150, 90, 255]), 1, 1); // 单元测试（node）里没有画布
    }
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.name = 'garden-signs';
    // 字体（Nunito，顶栏用的那套）加载好再画；没加载好之前先画一遍（系统圆体顶上）
    void (doc?.fonts?.load('800 60px Nunito').then(() => {
      this.fontReady = true;
      this.redrawAll();
    }, () => {}) ?? Promise.resolve());
  }

  // 第 k 格在贴图里的范围（u0, v0, du, dv；贴图上下翻转过：v = 1 是画布顶端）
  rect(k: number): [number, number, number, number] {
    const col = k % 2;
    const row = Math.floor(k / 2);
    return [col * 0.5, 1 - (row + 1) / 8, 0.5, 1 / 8];
  }

  // 拿一格写 text（已经有同样的字就复用那一格）；满了返回 -1
  claim(text: string): number {
    const have = this.labels.indexOf(text);
    if (have >= 0) return have;
    const free = this.labels.indexOf(null);
    if (free < 0) return -1;
    this.labels[free] = text;
    this.draw(free);
    return free;
  }

  // 换星球：全部清空
  reset(): void {
    this.labels.fill(null);
  }

  private redrawAll(): void {
    this.labels.forEach((t, k) => { if (t !== null) this.draw(k); });
  }

  private draw(k: number): void {
    // 单元测试的假 DOM 里画布没有 getContext：不画
    const ctx = typeof this.canvas?.getContext === 'function' ? this.canvas.getContext('2d') : null;
    const text = this.labels[k];
    if (!ctx || text === null) return;
    const x0 = (k % 2) * SLOT_W;
    const y0 = Math.floor(k / 2) * SLOT_H;
    const rng = mulberry32(k * 977 + text.length * 31 + 7);
    ctx.save();
    ctx.translate(x0, y0);
    ctx.clearRect(0, 0, SLOT_W, SLOT_H);
    // 木牌：暖色木头，几道深一点的木纹，四边压暗一圈（像刷漆时边上积了色）
    const g = ctx.createLinearGradient(0, 0, 0, SLOT_H);
    g.addColorStop(0, '#dcb07a');
    g.addColorStop(1, '#c69561');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SLOT_W, SLOT_H);
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#8a5a30';
    for (let i = 0; i < 6; i++) {
      ctx.lineWidth = 1.5 + rng() * 2.5;
      const y = 12 + rng() * (SLOT_H - 24);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(SLOT_W * 0.3, y + (rng() - 0.5) * 14, SLOT_W * 0.7, y + (rng() - 0.5) * 14, SLOT_W, y + (rng() - 0.5) * 8);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#9b6a3c';
    ctx.strokeRect(0, 0, SLOT_W, SLOT_H);
    ctx.globalAlpha = 1;
    // 字：深棕色，每个字母随手歪一点、上下错一点，像用刷子写的
    const size = Math.min(64, Math.floor(((SLOT_W - 70) / Math.max(4, text.length)) * 1.7));
    ctx.font = `800 ${size}px ${this.fontReady ? 'Nunito' : 'ui-rounded, system-ui'}, sans-serif`;
    ctx.textBaseline = 'middle';
    const widths = [...text].map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = (SLOT_W - total) / 2;
    ctx.fillStyle = '#4a2e18';
    [...text].forEach((ch, i) => {
      ctx.save();
      ctx.translate(x + widths[i] / 2, SLOT_H / 2 + 4 + (rng() - 0.5) * 5);
      ctx.rotate((rng() - 0.5) * 0.09);
      ctx.fillText(ch, -widths[i] / 2, 0);
      ctx.restore();
      x += widths[i];
    });
    // 翠宝黄的小圆点：名字左边一颗
    ctx.fillStyle = '#F2B705';
    ctx.beginPath();
    ctx.arc((SLOT_W - total) / 2 - 22, SLOT_H / 2 + 3, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}

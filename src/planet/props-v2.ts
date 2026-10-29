import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, color, float, instancedBufferAttribute, mix, positionGeometry, positionLocal, renderGroup, select, sin, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { mulberry32, type Rng } from './rng';
import { valueNoise3 } from './tslNoise';

// 第二版 [v2-world] 的「轻中古」点缀：星球上零零星星的几样石头小东西——灯柱（灯头是暖色的自发光，不加光源）、立石、一座小石拱门、
// 一座带圆顶的矮石塔（小天文台）。不要城堡、不要旗子和纹章。
// - 低模：每样一两百个三角面，颜色烘进顶点；石头的纹理在着色器里按噪声算
// - 一次绘制：四样东西合进一份几何（每个顶点记着自己是哪一样），一个实例化网格；每个实例记着自己是哪一样，
//   顶点着色器把不是这一样的顶点都收到一点上（三角形面积为 0，不出片元）。主画面一次、投影一次，一颗星球合计 2 次绘制
// - 位置按星球的种子定（同一颗星球每次一样）；避开作品（和作品四周的花园）、土路、水；灯柱沿着土路两边隔一段立一根
// 网格常驻（换星球只重写实例数据，不重新生成着色器）；开场预热时编译好（worldV2.ts）

export const PROPS = {
  on: 1, // 0 = 不要
  density: 1, // 数量倍数
  lamps: 1, // 灯柱的数量倍数（沿土路）
  glow: 2.4, // 灯头自发光的强度（HDR：后期的泛光会让它带一点光晕）
  scale: 0.95, // 整体大小（作品是主角，这些是点缀：克制一点）
  arch: 1, // 石拱门（0 = 不要）
  tower: 1, // 带圆顶的矮石塔（0 = 不要）
  stones: 1, // 立石（0 = 不要）
};

export type PropKind = 'lamp' | 'menhir' | 'arch' | 'tower';
export const PROP_KINDS: readonly PropKind[] = ['lamp', 'menhir', 'arch', 'tower'];
export const PROPS_CAPACITY = 64;

// 颜色（sRGB）：石头是 Stone 一带（SHADES：一块块深浅不一，再按星球的石头色染一点，实例颜色），铁件是深的石板灰，灯是暖的烛光色，圆顶是 Slate，边上一圈古金
const STONE_DARK = new THREE.Color('#6f6c67');
const STONE_LIGHT = new THREE.Color('#a19c93');
const IRON = new THREE.Color('#3b404d'); // 铸铁：深的石板蓝灰（太黑了月光下看不出形状）
const LAMP = new THREE.Color('#ffb45a'); // 暖的烛光（自发光太亮会被色调映射压成白色：颜色饱和一点、强度收着）
const DOME = new THREE.Color('#5d667c');
const GILT = new THREE.Color('#a8894f');
const DOOR = new THREE.Color('#2a2622');
const MOSS = new THREE.Color('#56614c'); // 根部一圈苔藓（Moss 往暗里一点）
const LICHEN = new THREE.Color('#a7ab8a'); // 朝上的面上零星的地衣

// 一块子几何：去掉 uv，按最终位置上色；mat = (自发光, 金属度)。法线：几何自带的（圆角、圆柱的平滑法线）照旧用，没有才按面算
function part(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color), glow = 0, metal = 0): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (m) g.applyMatrix4(m);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const c = new Float32Array(pos.count * 3);
  const mat = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    const k = typeof col === 'function' ? col(v, n) : col;
    c.set([k.r, k.g, k.b], i * 3);
    mat.set([glow, metal], i * 2);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('mat', new THREE.BufferAttribute(mat, 2));
  return g;
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// 顶点色的斑驳：一个固定种子的单纯形噪声（石块的深浅、苔藓的边缘不规则）
const NOISE = new SimplexNoise({ random: mulberry32(4242) });
const nz = (p: THREE.Vector3, f: number, o = 0) => NOISE.noise3d(p.x * f + o, p.y * f + o * 0.7, p.z * f - o * 0.3);

// 石头的上色：base 是这一块石头的底色（一块一块深浅不一），按噪声斑驳；根部压暗、长一圈苔藓（不规则的边），朝上的面亮一点、带一点地衣
function stone(base: THREE.Color, mossTo = 0.32) {
  return (p: THREE.Vector3, n: THREE.Vector3) => {
    const c = base.clone().multiplyScalar(1 + nz(p, 3.1) * 0.1 + nz(p, 9.7, 3) * 0.06);
    const ground = THREE.MathUtils.smoothstep(p.y, -0.05, 0.35);
    c.lerp(STONE_DARK, (1 - ground) * 0.35);
    // 苔藓：根部一圈，边缘按噪声起伏
    const edge = mossTo + nz(p, 4.3, 7) * 0.12;
    const moss = 1 - THREE.MathUtils.smoothstep(p.y, edge - 0.12, edge + 0.04);
    c.lerp(MOSS, moss * 0.85);
    // 朝上的面：天光照着，亮一点、零星的浅色地衣
    if (n.y > 0.6) c.lerp(LICHEN, THREE.MathUtils.smoothstep(nz(p, 6.1, 11), 0.35, 0.8) * 0.45);
    return c;
  };
}

// 一块圆角的石块（倒角、带一点歪）：w、h、d 是大小，r 是倒角半径
function block(w: number, h: number, d: number, r: number, m: THREE.Matrix4, base: THREE.Color, mossTo?: number): THREE.BufferGeometry {
  return part(new RoundedBoxGeometry(w, h, d, 1, r), m, stone(base, mossTo));
}

// 每一块石头的底色：在 Stone 附近按一个固定的表变一点（像一块块不同的石料）
const SHADES = ['#8f8b84', '#999389', '#857f78', '#a09a90', '#8a857f', '#948e86'].map((h) => new THREE.Color(h));
const shade = (i: number) => SHADES[((i % SHADES.length) + SHADES.length) % SHADES.length];

// 灯柱（铸铁）：两层八角的铁底座、往上收细的灯杆（中间一道箍）、柱头，挂一盏四面玻璃的方灯笼（暖光），
// 上面一个四棱的灯罩和一颗古金的顶珠。高约 2.2 米
function lampGeometry(): THREE.BufferGeometry {
  const iron = (p: THREE.Vector3) => IRON.clone().multiplyScalar(1 + nz(p, 7.3) * 0.08);
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.17, 0.2, 0.09, 8), M(0, 0.03), iron, 0, 0.55),
    part(new THREE.CylinderGeometry(0.11, 0.15, 0.16, 8), M(0, 0.15), iron, 0, 0.55),
    part(new THREE.CylinderGeometry(0.075, 0.11, 0.06, 8), M(0, 0.26), iron, 0, 0.55),
    part(new THREE.CylinderGeometry(0.034, 0.052, 1.5, 8), M(0, 1.04), iron, 0, 0.55),
    part(new THREE.TorusGeometry(0.052, 0.016, 5, 10), M(0, 0.7, 0, Math.PI / 2), iron, 0, 0.55),
    part(new THREE.CylinderGeometry(0.075, 0.04, 0.09, 8), M(0, 1.82), iron, 0, 0.55),
    // 灯笼：底下一圈铁框，四面发光的玻璃（方的，转 45°），上面一圈铁框
    part(new THREE.CylinderGeometry(0.11, 0.11, 0.025, 4), M(0, 1.88, 0, 0, Math.PI / 4), iron, 0, 0.55),
    part(new THREE.CylinderGeometry(0.115, 0.085, 0.27, 4), M(0, 2.02, 0, 0, Math.PI / 4), LAMP, 1, 0),
    part(new THREE.CylinderGeometry(0.135, 0.135, 0.03, 4), M(0, 2.165, 0, 0, Math.PI / 4), iron, 0, 0.55),
    part(new THREE.ConeGeometry(0.17, 0.15, 4), M(0, 2.255, 0, 0, Math.PI / 4), iron, 0, 0.55),
    part(new THREE.SphereGeometry(0.03, 8, 6), M(0, 2.35), GILT, 0, 0.75),
  ])!;
}

// 立石：一块又高又扁的整石（细分的球按噪声起伏、上窄下宽、顶上斜着磨圆），平滑法线；根部长苔藓。高约 1.8 米（实例再缩放）
function menhirGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 3);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-6);
  ico.dispose();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + 1) / 2; // 0 底 .. 1 顶
    const bump = 1 + nz(v, 1.6, 2) * 0.1 + nz(v, 4.1, 5) * 0.035;
    const taper = 1 - 0.32 * t * t;
    v.set(v.x * 0.34 * taper * bump, v.y * 0.92 * bump, v.z * 0.2 * taper * bump);
    v.x += 0.05 * t * t; // 顶上往一边歪一点
    if (v.y < -0.75) v.y = -0.75 + (v.y + 0.75) * 0.25; // 底面压平，坐在地里
    pos.setXYZ(i, v.x, v.y + 0.82, v.z);
  }
  geo.computeVertexNormals();
  return part(geo, null, stone(shade(1), 0.38));
}

// 小石拱门：两根干砌的石柱（一层层圆角的石块，大小、深浅不一，柱脚一块宽一点的基石），上面一道半圆的拱（七块楔形的拱石，
// 中间的拱心石大一点、往外凸一点），石块之间留一道细缝。宽约 1.9 米、高约 2.4 米
function archGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const span = 0.68; // 拱的内半径
  const thick = 0.3; // 拱石的厚度（径向）
  const depth = 0.34;
  const pillarH = 1.36;
  let id = 0;
  for (const s of [-1, 1]) {
    const x = s * (span + thick / 2);
    parts.push(block(0.46, 0.16, 0.46, 0.04, M(x, 0.02), shade(id++), 0.5));
    // 三层石块：高矮不一、左右错一点
    const rows = [0.42, 0.36, 0.38];
    let y = 0.1;
    rows.forEach((h, k) => {
      const w = 0.34 + ((k + (s > 0 ? 1 : 0)) % 2) * 0.03;
      parts.push(block(w, h - 0.02, depth, 0.035, M(x + ((k % 2) - 0.5) * 0.02, y + h / 2), shade(id++), 0.5));
      y += h;
    });
  }
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI;
    const a1 = ((i + 1) / n) * Math.PI;
    const am = (a0 + a1) / 2;
    const key = i === (n - 1) / 2;
    const r = span + thick / 2;
    const len = r * (a1 - a0) - 0.025; // 留一道缝
    const t = key ? thick + 0.06 : thick;
    parts.push(block(len, t, key ? depth + 0.04 : depth, 0.03, M(Math.cos(am) * (r + (key ? 0.03 : 0)), pillarH + 0.08 + Math.sin(am) * (r + (key ? 0.03 : 0)), 0, 0, 0, am - Math.PI / 2), shade(id++)));
  }
  return mergeGeometries(parts)!;
}

// 矮石塔（小天文台）：圆的石塔身（一层层的石砌：顶点色按高度分层、每层深浅不一），根部一圈苔藓；
// 顶上一圈出挑的石檐、一道古金的细边，石板蓝的圆顶上四道古金的肋、一道深色的观测缝；
// 塔身一扇小拱窗透着暖光，底下一扇深色的木门。高约 2.9 米、半径约 0.62 米
function towerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const courses = (p: THREE.Vector3, nn: THREE.Vector3) => {
    const row = Math.floor((p.y + 0.1) / 0.24);
    const col = Math.floor((Math.atan2(p.z, p.x) / (Math.PI * 2) + 1) * (8 + (row % 2) * 0.5) + row * 0.5);
    const base = shade(row * 3 + col);
    return stone(base, 0.36)(p, nn);
  };
  parts.push(part(new THREE.CylinderGeometry(0.6, 0.66, 2.0, 16, 8), M(0, 0.95), courses));
  parts.push(part(new THREE.CylinderGeometry(0.74, 0.74, 0.12, 16), M(0, 2.0), stone(STONE_LIGHT, -1)));
  parts.push(part(new THREE.CylinderGeometry(0.69, 0.69, 0.04, 16), M(0, 2.08), GILT, 0, 0.75));
  parts.push(part(new THREE.SphereGeometry(0.64, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 2.09), (p) => DOME.clone().multiplyScalar(0.92 + 0.12 * THREE.MathUtils.smoothstep(p.y, 2.1, 2.7))));
  for (let k = 0; k < 4; k++) {
    // 圆顶上的古金肋：沿经线的细弧（用很窄的圆环的一段）
    parts.push(part(new THREE.TorusGeometry(0.645, 0.012, 4, 16, Math.PI / 2), M(0, 2.09, 0, 0, (k * Math.PI) / 2 + Math.PI / 4, Math.PI / 2), GILT, 0, 0.75));
  }
  parts.push(part(new THREE.BoxGeometry(0.11, 0.04, 0.66), M(0, 2.09 + 0.33, 0.28, -0.72), DOOR));
  // 小拱窗（暖光）：一块竖的发光板加一个半圆顶，外面一圈石框
  parts.push(part(new THREE.BoxGeometry(0.2, 0.3, 0.08), M(0, 1.36, 0.6), STONE_LIGHT));
  parts.push(part(new THREE.BoxGeometry(0.13, 0.22, 0.06), M(0, 1.34, 0.635), LAMP, 0.9, 0));
  parts.push(part(new THREE.CylinderGeometry(0.065, 0.065, 0.06, 10, 1, false, 0, Math.PI), M(0, 1.45, 0.635, Math.PI / 2, 0, Math.PI / 2), LAMP, 0.9, 0));
  // 门：深色的木门，上面一道拱
  parts.push(part(new THREE.BoxGeometry(0.34, 0.56, 0.06), M(0, 0.22, 0.66), DOOR));
  parts.push(part(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 12, 1, false, 0, Math.PI), M(0, 0.5, 0.66, Math.PI / 2, 0, Math.PI / 2), DOOR));
  return mergeGeometries(parts)!;
}

// 四样东西合成一份几何，每个顶点记着自己是第几样（kind）
let unionGeo: THREE.BufferGeometry | null = null;
function unionGeometry(): THREE.BufferGeometry {
  if (unionGeo) return unionGeo;
  const list = [lampGeometry(), menhirGeometry(), archGeometry(), towerGeometry()];
  const tagged = list.map((g, k) => {
    const n = g.getAttribute('position').count;
    g.setAttribute('kind', new THREE.BufferAttribute(new Float32Array(n).fill(k), 1));
    return g;
  });
  unionGeo = mergeGeometries(tagged)!;
  unionGeo.computeBoundingSphere();
  for (const g of tagged) g.dispose();
  return unionGeo;
}

// 每样东西多高（米，缩放前）：给摆放时判断坡度、留空用
const FOOT: Record<PropKind, number> = { lamp: 0.35, menhir: 0.45, arch: 1.2, tower: 1.0 };

const GLOW = uniform(PROPS.glow).setGroup(renderGroup);

export function applyProps(): void {
  GLOW.value = PROPS.glow;
}

let material: THREE.MeshStandardNodeMaterial | null = null;

// 材质：顶点色 × 实例颜色（石头按星球的石头色染一点）× 石头的纹理（细斑、大块深浅）；自发光的灯头轻轻地、慢慢地明暗（不是闪）
function propsMaterial(kindAttr: THREE.InstancedBufferAttribute): THREE.MeshStandardNodeMaterial {
  if (material) return material;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.name = 'props-v2';
  const own = attribute<'float'>('kind', 'float');
  const want = instancedBufferAttribute(kindAttr) as unknown as THREE.Node<'float'>;
  // 不是这个实例那一样的顶点：收到原点（三角形面积为 0）。positionLocal 这里已经乘过实例矩阵
  m.positionNode = select(own.sub(want).abs().lessThan(0.5), positionLocal, vec3(0, 0, 0));
  const C = attribute<'vec3'>('color', 'vec3');
  const MAT = attribute<'vec2'>('mat', 'vec2');
  const p = positionGeometry;
  const speck = valueNoise3(p.mul(23).add(3.7));
  const big = valueNoise3(p.mul(2.6).add(9.1));
  const stoneTex = speck.sub(0.5).mul(0.16).add(big.sub(0.5).mul(0.2)).add(1);
  const isStone = float(1).sub(MAT.x).mul(float(1).sub(MAT.y));
  m.colorNode = C.mul(mix(float(1), stoneTex, isStone));
  m.metalnessNode = MAT.y;
  m.roughnessNode = mix(float(0.92), float(0.45), MAT.y);
  // 灯：烛光一样慢慢地呼吸（±6%），按位置错开相位
  const breathe = sin(time.mul(1.7).add(positionLocal.x.mul(0.7)).add(positionLocal.z.mul(0.3))).mul(0.06).add(1);
  m.emissiveNode = color(LAMP).mul(MAT.x.mul(GLOW).mul(breathe)).mul(smoothstep(0.0, 0.2, MAT.x));
  material = m;
  return m;
}

// 摆一颗星球的点缀要知道的（星球本地坐标）
export interface PropsPlanet {
  radius: number;
  seed: number;
  height: (dir: THREE.Vector3) => number;
  sea: number; // 海面半径（没有水是 0）
  exclude: (dir: THREE.Vector3) => number; // 0..1：> 0.02 的地方不放（土路、作品空地、作品四周的花园）
  path: THREE.Vector3[]; // 土路中线（单位方向）
  pathWidth: number; // 土路宽（米）
  stage: THREE.Vector3; // 星球视图里朝着镜头的方向（多放在这一面，看得见）
  rockColor: THREE.Color; // 星球的石头色（按它给石头染一点）
}

export interface PropItem {
  kind: PropKind;
  dir: THREE.Vector3;
  yaw: number;
  size: number;
}

function tangentBasis(n: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const t = new THREE.Vector3(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
  return [t, new THREE.Vector3().crossVectors(n, t)];
}

// 在 c 周围（球心角 a 以内）随机一个方向
function around(rng: Rng, c: THREE.Vector3, a: number): THREE.Vector3 {
  const [t, b] = tangentBasis(c);
  const ang = Math.sqrt(rng()) * a;
  const phi = rng() * Math.PI * 2;
  return c.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t, Math.sin(ang) * Math.cos(phi)).addScaledVector(b, Math.sin(ang) * Math.sin(phi)).normalize();
}

// 摆放（纯函数，按种子）：灯柱沿土路两边隔 11–17 米一根；立石一两小簇（两三块）；拱门一座、石塔一座。
// 每样都要：脚下一圈（按占地半径取 7 个点）不压路、不压作品和花园、不在水里、不太陡，离别的点缀至少几米
export function propItems(planet: PropsPlanet): PropItem[] {
  const rng = mulberry32((planet.seed * 2246822519 + 3266489917) >>> 0);
  const R = planet.radius;
  const items: PropItem[] = [];
  const s = PROPS.scale;
  // verge：允许脚下压到路边一点（灯柱立在路肩上：遮罩在路边是渐变的，离路中线 1.4 米处还有一点值）
  const clear = (dir: THREE.Vector3, foot: number, verge = 0.02): boolean => {
    const [t, b] = tangentBasis(dir);
    const h0 = planet.height(dir);
    if (planet.sea > 0 && h0 < planet.sea + 0.25) return false;
    if (planet.exclude(dir) > verge) return false;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const d = dir.clone().addScaledVector(t, (Math.cos(a) * foot) / R).addScaledVector(b, (Math.sin(a) * foot) / R).normalize();
      if (planet.exclude(d) > verge) return false;
      const h = planet.height(d);
      if (planet.sea > 0 && h < planet.sea + 0.1) return false;
      if (Math.abs(h - h0) > foot * 0.45) return false; // 太陡
    }
    return true;
  };
  const apart = (dir: THREE.Vector3, gap: number) => items.every((it) => it.dir.angleTo(dir) * R > gap);
  // —— 灯柱：沿土路，左右交替，离路边 0.6 米 ——
  const path = planet.path;
  const half = planet.pathWidth / 2;
  let next = 4 + rng() * 6;
  let walked = 0;
  let side = rng() < 0.5 ? -1 : 1;
  const maxLamps = Math.round(5 * PROPS.lamps * PROPS.density);
  for (let k = 1; k < path.length && items.length < maxLamps; k++) {
    const a = path[k - 1];
    const b = path[k];
    const len = a.angleTo(b) * R;
    if (len < 1e-6) continue;
    const across = new THREE.Vector3().crossVectors(a, new THREE.Vector3().subVectors(b, a));
    if (across.lengthSq() < 1e-14) continue;
    across.normalize();
    while (walked + len >= next && items.length < maxLamps) {
      const t = (next - walked) / len;
      const base = a.clone().lerp(b, t).normalize();
      const dir = base.clone().addScaledVector(across, (side * (half + 0.75 * s)) / R).normalize();
      if (clear(dir, FOOT.lamp * s, 0.45) && apart(dir, 6)) {
        items.push({ kind: 'lamp', dir, yaw: rng() * Math.PI * 2, size: s * (0.95 + rng() * 0.1) });
        side = -side;
      }
      next += 11 + rng() * 6;
    }
    walked += len;
  }
  // —— 拱门、石塔、立石：多放在星球视图朝着镜头的那一面（看得见），找不到合适的地方就这次不放 ——
  const want: Array<[PropKind, number]> = [['tower', PROPS.tower > 0 ? 1 : 0], ['arch', PROPS.arch > 0 ? 1 : 0], ['menhir', PROPS.stones > 0 ? Math.max(0, Math.round(2 * PROPS.density)) : 0]];
  for (const [kind, count] of want) {
    for (let n = 0; n < count; n++) {
      for (let tries = 0; tries < 60; tries++) {
        // 多放在星球视图朝着镜头的那一面，但不在正中间（那里是作品的舞台）：离舞台中心 0.35–0.95 弧度的一圈
        const dir = around(rng, planet.stage, tries < 40 ? 0.95 : 1.6);
        if (tries < 40 && dir.angleTo(planet.stage) < 0.35) continue;
        const size = kind === 'menhir' ? s * (0.9 + rng() * 0.45) : s * (0.95 + rng() * 0.1);
        if (!clear(dir, FOOT[kind] * size) || !apart(dir, kind === 'menhir' ? 7 : 9)) continue;
        // 拱门大致朝着镜头（从星球视图看得出是一道拱），别的随便转
        const yaw = kind === 'arch' ? archYaw(dir, planet.stage) + (rng() - 0.5) * 0.5 : rng() * Math.PI * 2;
        items.push({ kind, dir, yaw, size });
        if (kind === 'menhir') {
          // 一小簇：旁边再立一两块矮一点的
          const extra = 1 + (rng() < 0.5 ? 1 : 0);
          for (let j = 0; j < extra; j++) {
            for (let t2 = 0; t2 < 8; t2++) {
              const d2 = around(rng, dir, (1.6 * s) / R);
              const sz = size * (0.55 + rng() * 0.3);
              if (d2.angleTo(dir) * R < 0.9 * s || !clear(d2, FOOT.menhir * sz)) continue;
              if (!items.every((it) => it.dir.angleTo(d2) * R > 0.8 * s)) continue;
              items.push({ kind, dir: d2, yaw: rng() * Math.PI * 2, size: sz });
              break;
            }
          }
        }
        break;
      }
    }
  }
  if (PROPS.density < 1) return items.filter((_, i) => mulberry32(i * 977 + 13)() < PROPS.density);
  return items;
}

// 让拱门的正面（局部 +Z）朝着 toward 在切平面上的投影
function archYaw(dir: THREE.Vector3, toward: THREE.Vector3): number {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const want = toward.clone().addScaledVector(dir, -toward.dot(dir));
  if (want.lengthSq() < 1e-8) return 0;
  want.normalize();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(new THREE.Vector3().crossVectors(fwd, want).dot(dir), fwd.dot(want));
}

// 一颗星球上的点缀：一个实例化网格，一直留着、换星球时只重写实例数据
export class PropsField {
  readonly group = new THREE.Group();
  readonly mesh: THREE.InstancedMesh;
  private readonly kinds: THREE.InstancedBufferAttribute;
  items: PropItem[] = [];

  constructor() {
    this.group.name = 'props-v2';
    this.kinds = new THREE.InstancedBufferAttribute(new Float32Array(PROPS_CAPACITY), 1);
    this.kinds.setUsage(THREE.DynamicDrawUsage);
    const geo = unionGeometry();
    this.mesh = new THREE.InstancedMesh(geo, propsMaterial(this.kinds), PROPS_CAPACITY);
    this.mesh.name = 'props-v2';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // 实例散在整颗星球上
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // 先建好实例颜色：着色器里有没有实例颜色要一开始就定
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  // 预编译用：先画 1 个（编译时数量 0 的网格会被跳过）
  showOneEach(on: boolean): void {
    this.mesh.count = on ? 1 : this.items.length;
  }

  // 按星球重摆
  fill(planet: PropsPlanet): PropItem[] {
    const items = PROPS.on > 0 ? propItems(planet).slice(0, PROPS_CAPACITY) : [];
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yawQ = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    // 石头的染色：星球石头色的色相，亮度归一，和白色对半混（不同星球的石头略有冷暖，但都还是石头色）
    const tint = planet.rockColor.clone();
    const l = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b;
    tint.multiplyScalar(1 / Math.max(1e-3, l)).lerp(new THREE.Color(1, 1, 1), 0.55);
    const col = new THREE.Color();
    items.forEach((it, i) => {
      const h = planet.height(it.dir);
      pos.copy(it.dir).multiplyScalar(h - 0.06 * it.size); // 往地里埋一点（坡上不悬空）
      q.setFromUnitVectors(up, it.dir);
      q.multiply(yawQ.setFromAxisAngle(up, it.yaw));
      scl.setScalar(it.size);
      this.mesh.setMatrixAt(i, m.compose(pos, q, scl));
      this.kinds.setX(i, PROP_KINDS.indexOf(it.kind));
      const k = 0.92 + ((i * 0.618) % 1) * 0.16;
      this.mesh.setColorAt(i, col.copy(tint).multiplyScalar(k));
    });
    this.items = items;
    this.mesh.count = items.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.kinds.needsUpdate = true;
    this.mesh.visible = items.length > 0;
    return items;
  }

  stats(): { instances: number; drawCalls: number; triangles: number } {
    const g = this.mesh.geometry;
    const tris = g.getAttribute('position').count / 3;
    const n = this.mesh.count;
    // 每个实例的顶点着色器跑一遍整份几何（四样合在一起），出片元的只有自己那一样
    return { instances: n, drawCalls: n > 0 ? 1 : 0, triangles: n * tris };
  }
}

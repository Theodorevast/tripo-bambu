import * as THREE from 'three/webgpu';
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
  scale: 1.1, // 整体大小（作品是主角，这些是点缀：比真实尺寸大一点点，星球视图里看得出来）
};

export type PropKind = 'lamp' | 'menhir' | 'arch' | 'tower';
export const PROP_KINDS: readonly PropKind[] = ['lamp', 'menhir', 'arch', 'tower'];
export const PROPS_CAPACITY = 64;

// 颜色（sRGB）：石头是 Stone（按星球的石头色再染一点，实例颜色），铁件是深的石板灰，灯是暖的烛光色，圆顶是 Slate，边上一圈古金
const STONE = new THREE.Color('#8f8b84');
const STONE_DARK = new THREE.Color('#6f6c67');
const STONE_LIGHT = new THREE.Color('#a19c93');
const IRON = new THREE.Color('#2c2e35');
const LAMP = new THREE.Color('#ffb45a'); // 暖的烛光（自发光太亮会被色调映射压成白色：颜色饱和一点、强度收着）
const DOME = new THREE.Color('#5d667c');
const GILT = new THREE.Color('#a8894f');
const DOOR = new THREE.Color('#2a2622');

// 一块子几何：去掉 uv，按最终位置上色；mat = (自发光, 金属度)
function part(geo: THREE.BufferGeometry, m: THREE.Matrix4 | null, col: THREE.Color | ((p: THREE.Vector3) => THREE.Color), glow = 0, metal = 0): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  if (m) g.applyMatrix4(m);
  g.computeVertexNormals();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const c = new Float32Array(pos.count * 3);
  const mat = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = typeof col === 'function' ? col(v) : col;
    c.set([k.r, k.g, k.b], i * 3);
    mat.set([glow, metal], i * 2);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('mat', new THREE.BufferAttribute(mat, 2));
  return g;
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// 石头从下往上：根部压暗（像接触阴影、沾了土），顶上亮一点
const stoneShade = (y0: number, y1: number, base = STONE) => (p: THREE.Vector3) => base.clone().lerp(STONE_DARK, 1 - THREE.MathUtils.smoothstep(p.y, y0, y1)).lerp(STONE_LIGHT, THREE.MathUtils.smoothstep(p.y, y1 * 0.7, y1) * 0.35);

// 每个顶点按位置抖一点（石头不是规整的方块）：确定的哈希，同一个位置抖得一样（共用的顶点不裂开）
function jitter(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const h = (x: number, y: number, z: number, k: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.3 + k * 51.9) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const q = [Math.round(v.x * 1000), Math.round(v.y * 1000), Math.round(v.z * 1000)];
    pos.setXYZ(i, v.x + h(q[0], q[1], q[2], 1) * amount, v.y + h(q[0], q[1], q[2], 2) * amount * 0.6, v.z + h(q[0], q[1], q[2], 3) * amount);
  }
  return g;
}

// 灯柱：八角的石头小底座、细铁杆、挂着一盏六角的灯笼（暖光），尖顶。高约 2.1 米
function lampGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    part(new THREE.CylinderGeometry(0.15, 0.19, 0.22, 8), M(0, 0.06), stoneShade(-0.05, 0.17)),
    part(new THREE.CylinderGeometry(0.032, 0.042, 1.72, 6), M(0, 1.03), IRON, 0, 0.5),
    part(new THREE.CylinderGeometry(0.06, 0.05, 0.05, 6), M(0, 1.88), IRON, 0, 0.5),
    // 灯笼：上下两片铁框夹着发光的玻璃
    part(new THREE.CylinderGeometry(0.11, 0.085, 0.26, 6), M(0, 2.02), LAMP, 1, 0),
    part(new THREE.ConeGeometry(0.16, 0.15, 6), M(0, 2.225), IRON, 0, 0.5),
    part(new THREE.SphereGeometry(0.03, 6, 4), M(0, 2.32), GILT, 0, 0.7),
  ])!;
}

// 立石：上窄下宽、微微歪着的一块长石头，高约 1.8 米（实例再按大小缩放）
function menhirGeometry(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(0.6, 1.85, 0.38, 2, 4, 2);
  const pos = box.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + 0.925) / 1.85; // 0 底 .. 1 顶
    const taper = 1 - 0.38 * t;
    pos.setXYZ(i, v.x * taper + 0.06 * t * t, v.y + 0.925 - 0.12, v.z * (1 - 0.2 * t));
  }
  const g = jitter(mergeVertices(box.deleteAttribute('uv').deleteAttribute('normal'), 1e-4), 0.05, 7);
  return part(g, null, stoneShade(-0.1, 1.7));
}

// 小石拱门：两根方石柱，上面一道半圆的拱（九块楔形的拱石，中间的拱心石大一点）。宽约 1.9 米、高约 2.4 米
function archGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const span = 0.72; // 拱的半径（柱子内侧到中心）
  const pillarH = 1.45;
  for (const s of [-1, 1]) {
    parts.push(part(jitter(new THREE.BoxGeometry(0.34, pillarH, 0.36, 1, 3, 1), 0.02, s + 3), M(s * (span + 0.17), pillarH / 2 - 0.1), stoneShade(-0.1, 2.3)));
    // 柱脚、柱头：宽一点的一层
    parts.push(part(new THREE.BoxGeometry(0.42, 0.12, 0.44), M(s * (span + 0.17), -0.04), stoneShade(-0.1, 2.3)));
    parts.push(part(new THREE.BoxGeometry(0.42, 0.1, 0.44), M(s * (span + 0.17), pillarH - 0.1), stoneShade(-0.1, 2.3)));
  }
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI;
    const a1 = ((i + 1) / n) * Math.PI;
    const am = (a0 + a1) / 2;
    const key = i === (n - 1) / 2;
    const len = (span + 0.17) * (a1 - a0) * 0.96;
    const block = new THREE.BoxGeometry(len, key ? 0.42 : 0.34, key ? 0.4 : 0.36);
    const r = span + 0.17;
    parts.push(part(jitter(block, 0.012, i), M(Math.cos(am) * r, pillarH - 0.05 + Math.sin(am) * r, 0, 0, 0, am - Math.PI / 2), stoneShade(-0.1, 2.3)));
  }
  return mergeGeometries(parts)!;
}

// 矮石塔（小天文台）：圆的石塔身，顶上一圈出挑的石檐，一个石板蓝的圆顶（底边一圈古金），圆顶上一道开缝；
// 塔身一扇窄窗透着暖光、一扇深色的木门。高约 3 米、半径约 0.75 米
function towerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const shade = stoneShade(-0.1, 2.4);
  parts.push(part(jitter(new THREE.CylinderGeometry(0.72, 0.8, 2.2, 12, 3), 0.02, 11), M(0, 1.0), shade));
  parts.push(part(new THREE.CylinderGeometry(0.86, 0.86, 0.14, 12), M(0, 2.16), STONE_LIGHT));
  parts.push(part(new THREE.CylinderGeometry(0.8, 0.8, 0.05, 12), M(0, 2.255), GILT, 0, 0.7));
  parts.push(part(new THREE.SphereGeometry(0.76, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M(0, 2.27), DOME));
  // 圆顶上的观测缝：一条深色的窄带
  parts.push(part(new THREE.BoxGeometry(0.12, 0.05, 0.78), M(0, 2.27 + 0.4, 0.33, -0.62), DOOR));
  // 窄窗（暖光）、门
  parts.push(part(new THREE.BoxGeometry(0.16, 0.34, 0.06), M(0, 1.45, 0.76), LAMP, 0.85, 0));
  parts.push(part(new THREE.BoxGeometry(0.34, 0.62, 0.06), M(0, 0.25, 0.79), DOOR));
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
  const maxLamps = Math.round(6 * PROPS.lamps * PROPS.density);
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
  const want: Array<[PropKind, number]> = [['tower', 1], ['arch', 1], ['menhir', Math.max(0, Math.round(2 * PROPS.density))]];
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

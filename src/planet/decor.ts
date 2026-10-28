import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { dot, float, mix, normalize, normalWorld, positionLocal, positionWorld, renderGroup, smoothstep, uniform } from 'three/tsl';
import { perturbNormal, RIM } from './ground';
import { mulberry32, type Rng } from './rng';
import { valueNoise3 } from './tslNoise';

// 点缀素材：岩石（以后还有苔石、树苗……）。默认用代码生成的圆润岩石；以后换成 Tripo 生成的 GLB 时，
// 用 decorKitFromGlb(url) 读进来，其余代码不用改：GLB 里名字以 rock 开头的网格当岩石（每个网格一种形状），
// 自带的材质原样用。每种形状一个 InstancedMesh（scatterDecor），一颗星球几百块石头只要几次绘制调用

export interface DecorPiece {
  name: string;
  geometry: THREE.BufferGeometry; // 归一化：最大水平半径 1，底面在 y = 0（略往下凸，埋进地里）
  material: THREE.Material;
}

export interface DecorKit {
  rocks: DecorPiece[]; // 岩石：一簇一簇、大小不一
  pebbles: DecorPiece[]; // 小石子：路边、作品空地四周、草里零星的（面数少）
}

// 可调参数（?tune）
export const DECOR = {
  rocks: 1, // 石头数量倍数
  rim: 2.6, // 「外沿」（赤道附近一圈，星球视图里草地圆台的边缘）石头多几倍
  big: 0.12, // 大石头的比例
  moss: 0.55, // 石头顶上的苔藓多少
  rimWall: 1, // 外沿那一圈大石头（planet 角色：星球视图里草地圆台的边）的数量倍数，0 = 没有
};

// 石头材质：所有形状共用一份着色器。颜色 = 实例颜色（按星球的 rock 色加深浅）× 噪声斑；朝上的面长苔藓（按星球中心算「上」）；
// 再叠一层细节凹凸
// 共享的 uniform 放进 renderGroup（集成时改的）；苔藓色按 AgX 重调（原来的 × 1.6 在 AgX 下是一片亮黄绿，和草地对不上）
export const DECOR_CENTER = uniform(new THREE.Vector3()).setGroup(renderGroup); // 聚焦星球的中心（世界坐标）
const MOSS = uniform(new THREE.Color('#33441a')).setGroup(renderGroup);
const MOSS_AMOUNT = uniform(DECOR.moss).setGroup(renderGroup);

export function applyDecor(): void {
  MOSS_AMOUNT.value = DECOR.moss;
}

let rockMaterial: THREE.MeshStandardNodeMaterial | null = null;

// 实例化网格的容量：three 的 InstanceNode 在「数量 × 64 字节」放得进一个 uniform 块时（WebGPU 1024 个以内）把矩阵做成
// 定长的 uniform 数组，数组长度写进着色器：每种数量各编一份着色器（进星球时 9 组石头各编一次，卡 0.1–0.4 秒）。
// 容量统一取 1100：超过上限，一律走实例属性，所有石头共用一份着色器；实际画的个数用 mesh.count
export const DECOR_CAPACITY = 1100;

export function decorInstances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, DECOR_CAPACITY));
  mesh.count = count;
  return mesh;
}

export function sharedRockMaterial(): THREE.MeshStandardNodeMaterial {
  if (rockMaterial) return rockMaterial;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.name = 'decor-rock';
  const p = positionLocal;
  const spots = valueNoise3(p.mul(2.7)).mul(0.65).add(valueNoise3(p.mul(9.1).add(5.2)).mul(0.35));
  const up = normalize(positionWorld.sub(DECOR_CENTER));
  const facing = dot(normalize(normalWorld), up);
  const moss = smoothstep(0.45, 0.85, facing).mul(smoothstep(0.35, 0.65, spots.add(MOSS_AMOUNT.sub(0.5)))).mul(float(0.9));
  m.colorNode = mix(spots.mul(0.4).add(0.78), MOSS.mul(1.6), moss);
  m.roughnessNode = mix(float(0.9), float(0.97), moss);
  m.normalNode = perturbNormal(valueNoise3(p.mul(6.5)).mul(0.012).add(spots.mul(0.02)));
  rockMaterial = m;
  return m;
}

// 一块圆润的石头：二十面体细分球，按 3D 噪声起伏，压扁、底面压平，平滑法线
export function rockGeometry(seed: number, detail = 3): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const noise = new SimplexNoise({ random: rng });
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-6);
  ico.dispose();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const sx = 0.8 + rng() * 0.45;
  const sz = 0.8 + rng() * 0.45;
  const sy = 0.45 + rng() * 0.3;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = noise.noise3d(v.x * 1.3, v.y * 1.3, v.z * 1.3) * 0.22 + noise.noise3d(v.x * 3.1, v.y * 3.1, v.z * 3.1) * 0.07;
    v.multiplyScalar(1 + n);
    v.set(v.x * sx, v.y * sy, v.z * sz);
    // 底面压平：y < -0.15·sy 的部分往上收，石头坐在地上，不是滚圆的球
    if (v.y < -0.15 * sy) v.y = -0.15 * sy + (v.y + 0.15 * sy) * 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  // 归一化：最大水平半径 1，底面落在 y = 0 往下一点（实例摆放时再按大小埋进去）
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const r = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) || 1;
  geo.translate(0, -box.min.y, 0);
  geo.scale(1 / r, 1 / r, 1 / r);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

let procedural: DecorKit | null = null;

// 默认的点缀素材：5 种形状的石头（细分 3：每块 1280 个三角面）、4 种小石子（细分 1：每颗 80 个三角面）
export function proceduralDecorKit(): DecorKit {
  if (procedural) return procedural;
  const material = sharedRockMaterial();
  procedural = {
    rocks: [11, 23, 37, 41, 59].map((seed, i) => ({ name: `rock-${i}`, geometry: rockGeometry(seed, 3), material })),
    pebbles: [71, 83, 97, 101].map((seed, i) => ({ name: `pebble-${i}`, geometry: rockGeometry(seed, 1), material })),
  };
  return procedural;
}

// 从 GLB 读点缀素材（以后换 Tripo 生成的模型）：名字以 rock 开头的网格当岩石、pebble 开头的当小石子（没有就用岩石缩小），
// 几何按上面的约定归一化，材质原样用
export async function decorKitFromGlb(url: string): Promise<DecorKit> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  const rocks: DecorPiece[] = [];
  const pebbles: DecorPiece[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !/^(rock|pebble)/i.test(mesh.name)) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const c = box.getCenter(new THREE.Vector3());
    geometry.translate(-c.x, -box.min.y, -c.z);
    const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 || 1;
    geometry.scale(1 / r, 1 / r, 1 / r);
    geometry.computeBoundingSphere();
    (/^pebble/i.test(mesh.name) ? pebbles : rocks).push({ name: mesh.name, geometry, material: mesh.material as THREE.Material });
  });
  if (rocks.length === 0) throw new Error(`${url} 里没有名字以 rock 开头的网格`);
  return { rocks, pebbles: pebbles.length ? pebbles : rocks };
}

// 摆石头要知道的星球信息（星球本地坐标）
export interface DecorPlanet {
  radius: number;
  height: (dir: THREE.Vector3) => number;
  sea: number;
  exclude: (dir: THREE.Vector3) => number; // 0..1，> 0.05 的地方不放（土路、作品空地）
  rockColor: THREE.Color;
  seed: number;
  path?: THREE.Vector3[]; // 土路中线（单位方向）：路边撒一些小石子
  pathWidth?: number; // 土路宽（米）
  clearings?: Array<{ dir: THREE.Vector3; radius: number }>; // 作品空地（米）：展台周围一圈小石子
}

export interface DecorStats {
  instances: number;
  drawCalls: number;
  triangles: number;
}

// 随机方向（球面均匀）
function randomDir(rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  const u = rng() * 2 - 1;
  const phi = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return out.set(Math.cos(phi) * r, u, Math.sin(phi) * r);
}

// 在 c 周围球心角 a 以内随机取一个方向
function around(rng: Rng, c: THREE.Vector3, a: number, out: THREE.Vector3): THREE.Vector3 {
  const t = new THREE.Vector3(Math.abs(c.y) < 0.9 ? 0 : 1, Math.abs(c.y) < 0.9 ? 1 : 0, 0).cross(c).normalize();
  const b = new THREE.Vector3().crossVectors(c, t);
  const ang = Math.sqrt(rng()) * a;
  const phi = rng() * Math.PI * 2;
  return out.copy(c).multiplyScalar(Math.cos(ang)).addScaledVector(t, Math.sin(ang) * Math.cos(phi)).addScaledVector(b, Math.sin(ang) * Math.sin(phi)).normalize();
}

// 在星球上撒石头：一簇一簇的（一块大的带几块小的），赤道附近一圈（星球视图里圆台的外沿）多一些；避开土路、作品空地和水；
// 路边、作品空地四周再撒小石子。返回每一块的方向、大小、用哪种形状（星球本地坐标）
export function decorItems(kit: DecorKit, planet: DecorPlanet): Array<{ dir: THREE.Vector3; size: number; kind: 0 | 1; piece: number }> {
  const rng = mulberry32((planet.seed * 2654435761) >>> 0);
  const R = planet.radius;
  const area = 4 * Math.PI * R * R;
  const clusters = Math.round((area / 200) * DECOR.rocks);
  // kind：0 岩石（kit.rocks），1 小石子（kit.pebbles）
  type Item = { dir: THREE.Vector3; size: number; kind: 0 | 1; piece: number };
  const items: Item[] = [];
  const d = new THREE.Vector3();
  const ok = (dir: THREE.Vector3, size: number, allowPath = false) => {
    if (!allowPath && planet.exclude(dir) > 0.05) return false;
    const h = planet.height(dir);
    return !(planet.sea > 0 && h < planet.sea + size * 0.2);
  };
  const rock = (dir: THREE.Vector3, size: number) => items.push({ dir, size, kind: 0, piece: Math.floor(rng() * kit.rocks.length) });
  const pebble = (dir: THREE.Vector3, size: number) => items.push({ dir, size, kind: 1, piece: Math.floor(rng() * kit.pebbles.length) });
  for (let c = 0; c < clusters; c++) {
    randomDir(rng, d);
    // 赤道附近（|y| 小）多放：在这一圈以外的簇按 1 / rim 的概率保留
    const rimBand = 1 - THREE.MathUtils.smoothstep(Math.abs(d.y), 0.18, 0.42);
    if (rng() > rimBand + (1 - rimBand) / DECOR.rim) continue;
    const big = rng() < DECOR.big + rimBand * 0.15;
    const lead = big ? 0.9 + rng() * 1.3 : 0.32 + rng() * 0.5;
    const center = d.clone();
    if (!ok(center, lead)) continue;
    rock(center, lead);
    const n = Math.floor(rng() * (big ? 6 : 3));
    for (let k = 0; k < n; k++) {
      const dir = around(rng, center, (lead * 2.2 + 0.6) / R, new THREE.Vector3());
      const size = lead * (0.18 + rng() * 0.4);
      if (!ok(dir, size)) continue;
      if (size < 0.18) pebble(dir, size);
      else rock(dir, size);
    }
  }
  // 外沿（planet 角色）：沿赤道附近那一圈石头地（ground.ts 的 RIM）摆一圈半埋的大石头，大的带几块小的，
  // 星球视图里草地圆台的边上是一圈圆润的石头，和云海接上（像小王子 B-612 设定图的外沿），不是一个光滑的球面沉进云里
  const rimN = Math.round(((2 * Math.PI * R) / 2.4) * DECOR.rimWall);
  for (let k = 0; k < rimN; k++) {
    const lon = ((k + rng() * 0.8) / rimN) * Math.PI * 2;
    const s = RIM.center + (rng() * 2 - 1) * RIM.half * 0.85;
    const cl = Math.sqrt(1 - s * s);
    const dir = new THREE.Vector3(Math.cos(lon) * cl, s, Math.sin(lon) * cl);
    if (rng() < 0.18) continue; // 留几个缺口
    const lead = 0.85 + rng() ** 1.5 * 1.7;
    if (!ok(dir, lead)) continue;
    rock(dir, lead);
    const n = 1 + Math.floor(rng() * 3);
    for (let j = 0; j < n; j++) {
      const d2 = around(rng, dir, (lead * 1.6 + 0.5) / R, new THREE.Vector3());
      const size = lead * (0.25 + rng() * 0.35);
      if (!ok(d2, size)) continue;
      if (size < 0.18) pebble(d2, size);
      else rock(d2, size);
    }
  }
  // 草里零星的小石子
  const scattered = Math.round((area / 40) * DECOR.rocks);
  for (let k = 0; k < scattered; k++) {
    const dir = randomDir(rng, new THREE.Vector3());
    const size = 0.07 + rng() * 0.13;
    if (ok(dir, size)) pebble(dir, size);
  }
  // 路边：沿土路中线每隔约 0.35 米，一半的机会在路的左边或右边沿上放一颗；路面上偶尔一颗很小的
  const path = planet.path ?? [];
  const half = (planet.pathWidth ?? 1.3) / 2;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const len = a.angleTo(b) * R;
    const along = new THREE.Vector3().subVectors(b, a);
    const side = new THREE.Vector3().crossVectors(a, along);
    if (side.lengthSq() < 1e-14) continue;
    side.normalize();
    for (let t = 0; t < len; t += 0.35) {
      const base = a.clone().lerp(b, t / Math.max(len, 1e-6)).normalize();
      if (rng() < 0.55 * DECOR.rocks) {
        const off = (rng() < 0.5 ? -1 : 1) * (half + (rng() - 0.35) * 0.4);
        const dir = base.clone().addScaledVector(side, off / R).normalize();
        const size = 0.05 + rng() ** 2 * 0.16;
        if (ok(dir, size, true)) pebble(dir, size);
      }
      if (rng() < 0.12 * DECOR.rocks) {
        const dir = base.clone().addScaledVector(side, ((rng() - 0.5) * half * 1.4) / R).normalize();
        const size = 0.03 + rng() * 0.04;
        if (ok(dir, size, true)) pebble(dir, size);
      }
    }
  }
  // 作品空地边上一圈：几颗大小不一的石子，像有人把石板四周收拾过
  for (const c of planet.clearings ?? []) {
    const n = 7 + Math.floor(rng() * 6);
    const t1 = new THREE.Vector3(Math.abs(c.dir.y) < 0.9 ? 0 : 1, Math.abs(c.dir.y) < 0.9 ? 1 : 0, 0).cross(c.dir).normalize();
    const t2 = new THREE.Vector3().crossVectors(c.dir, t1);
    for (let k = 0; k < n; k++) {
      const phi = (k / n) * Math.PI * 2 + rng() * 0.5;
      const r = (c.radius + 0.1 + rng() * 0.45) / R;
      const dir = c.dir.clone().addScaledVector(t1, Math.cos(phi) * r).addScaledVector(t2, Math.sin(phi) * r).normalize();
      const size = 0.06 + rng() ** 2 * 0.2;
      if (ok(dir, size, true)) pebble(dir, size);
    }
  }
  return items;
}

export type DecorItem = ReturnType<typeof decorItems>[number];

// 一颗星球上的石头：每种形状一个实例化网格，一直留着、换星球时只重写实例数据。
// three 给每个实例化网格单独生成一遍着色器节点（缓存键里有网格的 uuid）：每次进星球都新建网格的话，第一帧要卡 0.1–0.4 秒。
// 开场时 World.warmUp 把这些网格编译好，以后进星球不再生成
export class DecorField {
  readonly group = new THREE.Group();
  stats: DecorStats = { instances: 0, drawCalls: 0, triangles: 0 };
  private readonly meshes: Array<{ mesh: THREE.InstancedMesh; kind: 0 | 1; pi: number; tris: number }>;

  constructor(kit: DecorKit) {
    this.group.name = 'decor-rocks';
    const pieces = [...kit.rocks.map((piece, pi) => ({ piece, kind: 0 as const, pi })), ...kit.pebbles.map((piece, pi) => ({ piece, kind: 1 as const, pi }))];
    this.meshes = pieces.map(({ piece, kind, pi }) => {
      const mesh = decorInstances(piece.geometry, piece.material, 0);
      mesh.name = piece.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.setColorAt(0, new THREE.Color(1, 1, 1)); // 先建好颜色属性：着色器里有没有实例颜色要一开始就定
      this.group.add(mesh);
      const g = piece.geometry;
      return { mesh, kind, pi, tris: g.index ? g.index.count / 3 : g.getAttribute('position').count / 3 };
    });
  }

  // 预编译用：每个网格先画 1 个（编译时 count 为 0 的网格会被跳过）
  showOneEach(on: boolean): void {
    for (const { mesh } of this.meshes) mesh.count = on ? 1 : 0;
  }

  // 按星球重摆
  fill(kit: DecorKit, planet: DecorPlanet): DecorStats {
    const items = decorItems(kit, planet);
    const rng = mulberry32((planet.seed * 40503 + 17) >>> 0);
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tilt = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let triangles = 0;
    let drawCalls = 0;
    let instances = 0;
    for (const { mesh, kind, pi, tris } of this.meshes) {
      const mine = items.filter((it) => it.kind === kind && it.piece === pi).slice(0, DECOR_CAPACITY);
      mine.forEach((it, i) => {
        const h = planet.height(it.dir);
        // 埋进地里约 30%：石头像从地里长出来，坡上也不悬空
        p.copy(it.dir).multiplyScalar(h - it.size * 0.3);
        q.setFromUnitVectors(up, it.dir);
        tilt.setFromEuler(e.set((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5));
        q.multiply(tilt);
        s.set(it.size, it.size * (0.8 + rng() * 0.5), it.size);
        mesh.setMatrixAt(i, m.compose(p, q, s));
        mesh.setColorAt(i, col.copy(planet.rockColor).multiplyScalar(0.8 + rng() * 0.35));
      });
      mesh.count = mine.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.visible = mine.length > 0;
      instances += mine.length;
      if (mine.length > 0) {
        triangles += tris * mine.length;
        drawCalls++;
      }
    }
    this.stats = { instances, drawCalls, triangles };
    return this.stats;
  }

  dispose(): void {
    for (const { mesh } of this.meshes) mesh.dispose();
    this.group.removeFromParent();
  }
}

// 一次性撒一组（测试和换素材时用）：新建一个 DecorField 填好返回
export function scatterDecor(kit: DecorKit, planet: DecorPlanet): { group: THREE.Group; stats: DecorStats } {
  const field = new DecorField(kit);
  const stats = field.fill(kit, planet);
  return { group: field.group, stats };
}

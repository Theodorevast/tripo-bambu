import * as THREE from 'three/webgpu';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { dot, float, mix, normalize, normalWorld, positionLocal, positionWorld, smoothstep, uniform } from 'three/tsl';
import { perturbNormal } from './ground';
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
  rocks: DecorPiece[];
}

// 可调参数（?tune）
export const DECOR = {
  rocks: 1, // 石头数量倍数
  rim: 2.6, // 「外沿」（赤道附近一圈，星球视图里草地圆台的边缘）石头多几倍
  big: 0.12, // 大石头的比例
  moss: 0.55, // 石头顶上的苔藓多少
};

// 石头材质：所有形状共用一份着色器。颜色 = 实例颜色（按星球的 rock 色加深浅）× 噪声斑；朝上的面长苔藓（按星球中心算「上」）；
// 再叠一层细节凹凸
export const DECOR_CENTER = uniform(new THREE.Vector3()); // 聚焦星球的中心（世界坐标）
const MOSS = uniform(new THREE.Color('#58763a'));
const MOSS_AMOUNT = uniform(DECOR.moss);

export function applyDecor(): void {
  MOSS_AMOUNT.value = DECOR.moss;
}

let rockMaterial: THREE.MeshStandardNodeMaterial | null = null;

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

// 默认的点缀素材：5 种形状的石头（细分 3：每块 1280 个三角面）
export function proceduralDecorKit(): DecorKit {
  if (procedural) return procedural;
  const material = sharedRockMaterial();
  procedural = { rocks: [11, 23, 37, 41, 59].map((seed, i) => ({ name: `rock-${i}`, geometry: rockGeometry(seed, 3), material })) };
  return procedural;
}

// 从 GLB 读点缀素材（以后换 Tripo 生成的模型）：名字以 rock 开头的网格当岩石，几何按上面的约定归一化，材质原样用
export async function decorKitFromGlb(url: string): Promise<DecorKit> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  const rocks: DecorPiece[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !/^rock/i.test(mesh.name)) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const c = box.getCenter(new THREE.Vector3());
    geometry.translate(-c.x, -box.min.y, -c.z);
    const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 || 1;
    geometry.scale(1 / r, 1 / r, 1 / r);
    geometry.computeBoundingSphere();
    rocks.push({ name: mesh.name, geometry, material: mesh.material as THREE.Material });
  });
  if (rocks.length === 0) throw new Error(`${url} 里没有名字以 rock 开头的网格`);
  return { rocks };
}

// 摆石头要知道的星球信息（星球本地坐标）
export interface DecorPlanet {
  radius: number;
  height: (dir: THREE.Vector3) => number;
  sea: number;
  exclude: (dir: THREE.Vector3) => number; // 0..1，> 0.05 的地方不放（土路、作品空地）
  rockColor: THREE.Color;
  seed: number;
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

// 在星球上撒石头：一簇一簇的（一块大的带几块小的），赤道附近一圈（星球视图里圆台的外沿）多一些；避开土路、作品空地和水。
// 返回一个组（星球本地坐标，挂到 planet.decor 上），每种形状一个 InstancedMesh
export function scatterDecor(kit: DecorKit, planet: DecorPlanet): { group: THREE.Group; stats: DecorStats } {
  const rng = mulberry32((planet.seed * 2654435761) >>> 0);
  const R = planet.radius;
  const area = 4 * Math.PI * R * R;
  const clusters = Math.round((area / 260) * DECOR.rocks);
  type Item = { dir: THREE.Vector3; size: number; piece: number };
  const items: Item[] = [];
  const d = new THREE.Vector3();
  const ok = (dir: THREE.Vector3, size: number) => {
    if (planet.exclude(dir) > 0.05) return false;
    const h = planet.height(dir);
    return !(planet.sea > 0 && h < planet.sea + size * 0.2);
  };
  for (let c = 0; c < clusters; c++) {
    randomDir(rng, d);
    // 赤道附近（|y| 小）多放：在这一圈以外的簇按 1 / rim 的概率保留
    const rimBand = 1 - THREE.MathUtils.smoothstep(Math.abs(d.y), 0.18, 0.42);
    if (rng() > rimBand + (1 - rimBand) / DECOR.rim) continue;
    const big = rng() < DECOR.big + rimBand * 0.15;
    const lead = big ? 0.9 + rng() * 1.3 : 0.32 + rng() * 0.5;
    const center = d.clone();
    if (!ok(center, lead)) continue;
    items.push({ dir: center, size: lead, piece: Math.floor(rng() * kit.rocks.length) });
    const n = Math.floor(rng() * (big ? 6 : 3));
    for (let k = 0; k < n; k++) {
      const dir = around(rng, center, (lead * 2.2 + 0.6) / R, new THREE.Vector3());
      const size = lead * (0.18 + rng() * 0.4);
      if (ok(dir, size)) items.push({ dir, size, piece: Math.floor(rng() * kit.rocks.length) });
    }
  }
  // 零散的小石子
  const pebbles = Math.round((area / 40) * DECOR.rocks);
  for (let k = 0; k < pebbles; k++) {
    const dir = randomDir(rng, new THREE.Vector3());
    const size = 0.08 + rng() * 0.14;
    if (ok(dir, size)) items.push({ dir, size, piece: Math.floor(rng() * kit.rocks.length) });
  }
  const group = new THREE.Group();
  group.name = 'decor-rocks';
  const up = new THREE.Vector3(0, 1, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  let triangles = 0;
  let drawCalls = 0;
  kit.rocks.forEach((piece, pi) => {
    const mine = items.filter((it) => it.piece === pi);
    if (mine.length === 0) return;
    const mesh = new THREE.InstancedMesh(piece.geometry, piece.material, mine.length);
    mesh.name = piece.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mine.forEach((it, i) => {
      const h = planet.height(it.dir);
      // 埋进地里约 30%：石头像从地里长出来，坡上也不悬空
      p.copy(it.dir).multiplyScalar(h - it.size * 0.3);
      q.setFromUnitVectors(up, it.dir);
      tilt.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.5, rng() * Math.PI * 2, (rng() - 0.5) * 0.5));
      q.multiply(tilt);
      s.set(it.size, it.size * (0.8 + rng() * 0.5), it.size);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      mesh.setColorAt(i, col.copy(planet.rockColor).multiplyScalar(0.8 + rng() * 0.35));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    triangles += (piece.geometry.index ? piece.geometry.index.count / 3 : piece.geometry.getAttribute('position').count / 3) * mine.length;
    drawCalls++;
  });
  return { group, stats: { instances: items.length, drawCalls, triangles } };
}

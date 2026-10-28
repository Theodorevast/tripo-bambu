import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlanetRecipe } from '../data/types';
import { makeHeightFn, type HeightFn } from './noise';
import { PLANET_RADIUS } from './presets';

export const LOD_LOW = 10; // 星系里：20 × 11² = 2420 个三角面
export const LOD_HIGH = 31; // 聚焦时（半径 30）：20 × 32² = 20480 个三角面，边长约 1 米

// 聚焦时的细分按半径放大：半径 30 以上边长保持约 1 米（地平线不出棱角，小土包也采得到）
export function focusDetail(radius = PLANET_RADIUS): number {
  return Math.round(LOD_HIGH * Math.max(1, radius / 30));
}

const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

// 平滑法线：在切平面里沿两个方向各挪一小步取高度，两条边叉乘（和网格无关，接缝两边一样）
export function terrainNormal(height: HeightFn, dir: THREE.Vector3, out: THREE.Vector3, step = 0.002): THREE.Vector3 {
  _d.copy(dir);
  if (Math.abs(_d.y) < 0.9) _t.set(0, 1, 0);
  else _t.set(1, 0, 0);
  _t.cross(_d).normalize();
  _b.crossVectors(_d, _t);
  _p0.copy(_d).multiplyScalar(height(_d.x, _d.y, _d.z));
  _p1.copy(_d).addScaledVector(_t, step).normalize();
  _p1.multiplyScalar(height(_p1.x, _p1.y, _p1.z));
  _p2.copy(_d).addScaledVector(_b, step).normalize();
  _p2.multiplyScalar(height(_p2.x, _p2.y, _p2.z));
  _p1.sub(_p0);
  _p2.sub(_p0);
  return out.crossVectors(_p1, _p2).normalize();
}

// 带索引的单位二十面体细分球（合并了重复顶点），每个细分等级只算一次：所有星球共用这份模板，
// 建地形时只按高度把顶点推出去（mergeVertices 要按位置哈希，聚焦时每次都做一遍要十几毫秒）
const unitSpheres = new Map<number, { positions: Float32Array; index: Uint32Array | Uint16Array }>();

function unitSphere(detail: number): { positions: Float32Array; index: Uint32Array | Uint16Array } {
  let s = unitSpheres.get(detail);
  if (!s) {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    const geo = mergeVertices(ico, 1e-6);
    ico.dispose();
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const positions = new Float32Array(pos.array.length);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      positions.set([x / l, y / l, z / l], i * 3);
    }
    s = { positions, index: geo.index!.array as Uint32Array | Uint16Array };
    geo.dispose();
    unitSpheres.set(detail, s);
  }
  return s;
}

// 配方 → 地表网格（纯函数，不碰 GPU）。顶点沿单位球的方向推到地面高度（每个顶点只算一次高度），
// 法线按共用顶点的网格算（平滑的缓坡，不是低多边形的面法线）。颜色、土路、苔藓都在地表着色器里按噪声和遮罩算
export function buildTerrainGeometry(recipe: PlanetRecipe, detail: number): THREE.BufferGeometry {
  const height = makeHeightFn(recipe.seed, recipe.preset);
  const { positions: unit, index } = unitSphere(detail);
  const positions = new Float32Array(unit.length);
  for (let i = 0; i < unit.length; i += 3) {
    const x = unit[i];
    const y = unit[i + 1];
    const z = unit[i + 2];
    const r = height(x, y, z);
    positions[i] = x * r;
    positions[i + 1] = y * r;
    positions[i + 2] = z * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// 三角面数（带索引的网格）
export function triangleCount(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.getAttribute('position').count / 3;
}

// 开场预热时调：先把聚焦用的细分球模板建好（合并顶点要几十毫秒），第一次进星球时不再算
export function prewarmTerrain(): void {
  unitSphere(LOD_LOW);
  unitSphere(focusDetail());
}

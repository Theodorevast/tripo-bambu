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

// 配方 → 地表网格（纯函数，不碰 GPU）。先把二十面体细分球的重复顶点合并成带索引的网格，每个顶点只算一次高度，
// 法线按高度函数算（平滑的缓坡，不是低多边形的面法线）。颜色、土路、苔藓都在地表着色器里按噪声和遮罩算
export function buildTerrainGeometry(recipe: PlanetRecipe, detail: number): THREE.BufferGeometry {
  const height = makeHeightFn(recipe.seed, recipe.preset);
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-6);
  ico.dispose();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const dir = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const r = height(dir.x, dir.y, dir.z);
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r);
    terrainNormal(height, dir, n);
    normals[i * 3] = n.x;
    normals[i * 3 + 1] = n.y;
    normals[i * 3 + 2] = n.z;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
}

// 三角面数（带索引的网格）
export function triangleCount(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.getAttribute('position').count / 3;
}

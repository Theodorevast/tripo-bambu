import * as THREE from 'three/webgpu';
import type { PlanetRecipe } from '../data/types';
import { makeHeightFn, normalizedHeight } from './noise';
import { BASE_RADIUS, PRESETS } from './presets';

export const LOD_LOW = 10; // 星系里：20 × 11² = 2420 个三角面
export const LOD_HIGH = 31; // 聚焦时：20 × 32² = 20480 个三角面

// 配方 → 地表网格（纯函数，不碰 GPU）。IcosahedronGeometry 是非索引几何：
// 每个三角面有自己的 3 个顶点，所以可以每面一种颜色，computeVertexNormals 得到的也是面法线
export function buildTerrainGeometry(recipe: PlanetRecipe, detail: number): THREE.BufferGeometry {
  const height = makeHeightFn(recipe.seed, recipe.preset);
  const bands = PRESETS[recipe.preset].bands.map(([limit, hex]) => ({ limit, color: new THREE.Color(hex) }));
  const geo = new THREE.IcosahedronGeometry(BASE_RADIUS, detail);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    v.multiplyScalar(height(v.x, v.y, v.z));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) {
    a.fromBufferAttribute(pos, f);
    b.fromBufferAttribute(pos, f + 1);
    c.fromBufferAttribute(pos, f + 2);
    const t = normalizedHeight((a.length() + b.length() + c.length()) / 3, recipe.preset);
    const { color } = bands.find((band) => t <= band.limit) ?? bands[bands.length - 1];
    for (let k = 0; k < 3; k++) colors.set([color.r, color.g, color.b], (f + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

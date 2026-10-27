import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, length, modelPosition, normalize, positionLocal, positionWorld, pow, saturate, sin, smoothstep } from 'three/tsl';
import type { PresetId } from '../data/types';
import { PRESETS } from './presets';

// 世界坐标下：从星球中心指向片元的方向、从片元指向镜头的方向
const sphereNormal = () => normalize(positionWorld.sub(modelPosition));
const toCamera = () => normalize(cameraPosition.sub(positionWorld));

// 地表：顶点色（每面一色）+ 边缘一圈大气色微光。微光按球面法线算，不受低多边形面片朝向影响
export function surfaceMaterial(preset: PresetId, rim: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  if (rim) {
    const f = pow(float(1).sub(saturate(dot(sphereNormal(), toCamera()))), 3);
    m.emissiveNode = color(PRESETS[preset].atmosphere).mul(f).mul(0.35);
  }
  return m;
}

export function waterMaterial(preset: PresetId): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color: PRESETS[preset].water, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.88 });
}

// 大气：背面渲染的外壳，叠加混合。外壳背面上 d 从外缘的 0 增加到星球边缘附近的约 0.5，
// 所以光晕贴着星球边缘最亮，往外淡出
export function atmosphereMaterial(preset: PresetId): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const d = dot(sphereNormal(), toCamera()).mul(-1);
  m.colorNode = color(PRESETS[preset].atmosphere);
  m.opacityNode = pow(smoothstep(0, 0.5, d), 1.6).mul(0.9);
  return m;
}

// 光环：RingGeometry 在 XY 平面；按到中心的距离画几十道深浅不一的环带，内外缘淡出
export function ringMaterial(preset: PresetId, inner: number, outer: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const t = length(positionLocal.xy).sub(inner).div(outer - inner);
  const bands = sin(t.mul(38)).mul(0.5).add(0.5).mul(0.35).add(0.45);
  const edge = smoothstep(0, 0.08, t).mul(float(1).sub(smoothstep(0.85, 1, t)));
  m.colorNode = color(PRESETS[preset].ring);
  m.opacityNode = bands.mul(edge).mul(0.75);
  return m;
}

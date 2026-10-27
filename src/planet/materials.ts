import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, length, modelPosition, normalize, positionLocal, positionWorld, pow, saturate, sin, smoothstep, sqrt } from 'three/tsl';
import type { PresetId } from '../data/types';
import { BASE_RADIUS, PRESETS } from './presets';

// 世界坐标下：从星球中心指向片元的方向、从片元指向镜头的方向
const sphereNormal = () => normalize(positionWorld.sub(modelPosition));
const toCamera = () => normalize(cameraPosition.sub(positionWorld));

// 地表：顶点色（每面一色）+ 边缘一圈很淡的大气色微光，和外壳光晕在星球轮廓处接上。
// 微光按球面法线算，不受低多边形面片朝向影响；4 次方让它只集中在最外一圈，不把陆地洗白
export function surfaceMaterial(preset: PresetId, rim: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  if (rim) {
    const f = pow(float(1).sub(saturate(dot(sphereNormal(), toCamera()))), 4);
    m.emissiveNode = color(PRESETS[preset].atmosphere).mul(f).mul(0.18);
  }
  return m;
}

export function waterMaterial(preset: PresetId): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color: PRESETS[preset].water, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.88 });
}

// 大气：背面渲染的薄外壳，叠加混合。d 是视线和外壳法线夹角的余弦，r 是外壳半径（本地单位），
// 这条视线离球心最近的距离就是 b = r·√(1 − d²)。t 把 b 换算到「基础半径 → 外壳边缘」的 0..1：
// t = 0 贴着星球轮廓，光晕最亮；t = 1 是外壳边缘，(1 − t)^2.5 在这里平滑地降到 0，
// 所以没有硬边，也没有一圈亮度不变的色带。外壳半径必须大于基础半径
export function atmosphereMaterial(preset: PresetId): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const d = dot(sphereNormal(), toCamera()).mul(-1);
  const r = length(positionLocal);
  const b = r.mul(sqrt(saturate(float(1).sub(d.mul(d)))));
  const t = saturate(b.sub(BASE_RADIUS).div(r.sub(BASE_RADIUS)));
  m.colorNode = color(PRESETS[preset].atmosphere);
  m.opacityNode = pow(float(1).sub(t), 2.5).mul(0.5);
  return m;
}

// 光环：RingGeometry 在 XY 平面；按到中心的距离画约 6 道深浅交替的环带（sin(t·38) 在 t 的 0..1 上约 6 个周期），内外缘淡出
export function ringMaterial(preset: PresetId, inner: number, outer: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const t = length(positionLocal.xy).sub(inner).div(outer - inner);
  const bands = sin(t.mul(38)).mul(0.5).add(0.5).mul(0.35).add(0.45);
  const edge = smoothstep(0, 0.08, t).mul(float(1).sub(smoothstep(0.85, 1, t)));
  m.colorNode = color(PRESETS[preset].ring);
  m.opacityNode = bands.mul(edge).mul(0.75);
  return m;
}

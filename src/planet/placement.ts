import * as THREE from 'three/webgpu';
import type { Placement } from '../data/types';
import type { HeightFn } from './noise';

export const WORK_SIZE = 2.6; // 所有作品统一的最长边（spec 4.3 的 2.0 可调；小王子式近景里 2.6 才压得住星球）
export const PLINTH_HEIGHT = 0.18; // 展台露出地面的高度
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const YAW_STEP = Math.PI / 12; // 15°

const UP = new THREE.Vector3(0, 1, 0);

// 展示方向：从星球中心指向到达镜头。镜头几乎和星球中心一样高、稍微偏右：
// 星系是扁平的圆盘，镜头一往下看，作品背后的天空就会排满邻居星球；平视时作品背后只有星空
export const SHOWCASE_POLE: [number, number, number] = (() => {
  const az = THREE.MathUtils.degToRad(8); // 从 +Z 往 +X 偏 8°，主光（lights.ts，右上前方）更多照在作品正面
  const el = THREE.MathUtils.degToRad(-2);
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
})();

// 到达镜头的屏幕上方：世界 +Y 去掉沿展示方向的分量（OrbitControls 让镜头的 up 保持 +Y，不会侧倾）
export const SHOWCASE_UP: [number, number, number] = (() => {
  const pole = new THREE.Vector3(...SHOWCASE_POLE);
  const v = UP.clone().addScaledVector(pole, -UP.dot(pole)).normalize();
  return [v.x, v.y, v.z];
})();

// 作品落点的地面半径：有海时不低于海平面（作品立在漂浮的展台上）
export function groundRadius(dir: THREE.Vector3, height: HeightFn, sea: number): number {
  return Math.max(height(dir.x, dir.y, dir.z), sea);
}

// 作品根节点的位置和朝向：先把模型的「上」对准球面法线，再绕法线转 yaw
export function placementTransform(p: Placement, height: HeightFn, sea: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const dir = new THREE.Vector3(...p.dir).normalize();
  const position = dir.clone().multiplyScalar(groundRadius(dir, height, sea));
  const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(dir, p.yaw));
  return { position, quaternion };
}

// 求 yaw，让模型正面（局部 +Z）朝向 toward 在切平面上的投影
export function faceYaw(dir: [number, number, number], toward: [number, number, number]): number {
  const n = new THREE.Vector3(...dir).normalize();
  const t = new THREE.Vector3(...toward);
  const want = t.addScaledVector(n, -t.dot(n));
  if (want.lengthSq() < 1e-10) return 0;
  want.normalize();
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, n));
  return Math.atan2(new THREE.Vector3().crossVectors(forward, want).dot(n), forward.dot(want));
}

// 最长边缩放到 size；offset 让模型水平居中、底部落在 y=0（先缩放再平移）
export function fitToSize(box: THREE.Box3, size = WORK_SIZE): { scale: number; offset: THREE.Vector3 } {
  const dim = box.getSize(new THREE.Vector3());
  const scale = size / (Math.max(dim.x, dim.y, dim.z) || 1);
  const center = box.getCenter(new THREE.Vector3());
  return { scale, offset: new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale) };
}

export function clampScale(s: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}

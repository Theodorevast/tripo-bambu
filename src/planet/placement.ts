import * as THREE from 'three/webgpu';
import type { Placement } from '../data/types';
import type { HeightFn } from './noise';

export const WORK_SIZE = 2.0; // 所有作品统一的最长边
export const PLINTH_HEIGHT = 0.18; // 展台露出地面的高度
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const YAW_STEP = Math.PI / 12; // 15°

// 展示方向：镜头飞到星球时从这个方向看过去，初始作品也围着它摆
export const SHOWCASE_POLE: [number, number, number] = (() => {
  const v = new THREE.Vector3(0, 0.45, 1).normalize();
  return [v.x, v.y, v.z];
})();

const UP = new THREE.Vector3(0, 1, 0);

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

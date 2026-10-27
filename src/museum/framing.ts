import * as THREE from 'three/webgpu';

// 归一化后的模型（最长边 2.0）包围球半径不超过 √3 ≈ 1.73，按 1.75 留一点余量
const FIT_RADIUS = 1.75;

// 让这个球完整出现在画面里的镜头距离：竖直、水平两个半视角取小的（竖屏时水平方向更窄）
export function fitDistance(camera: THREE.PerspectiveCamera): number {
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  return FIT_RADIUS / Math.sin(Math.min(vertical, horizontal));
}

// 斜上方 3/4 视角看向模型中部；距离按 camera.aspect 算，宽高比变了要重新取景
export function frameModel(camera: THREE.PerspectiveCamera, height: number): void {
  const dist = fitDistance(camera);
  camera.position.set(dist * 0.55, height * 0.5 + dist * 0.28, dist * 0.8);
  camera.lookAt(0, height * 0.5, 0);
}

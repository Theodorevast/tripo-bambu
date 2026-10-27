import * as THREE from 'three/webgpu';

// 归一化后的模型（最长边 2.0，包围球半径不超过 √3 ≈ 1.73）完整出现在画面里：斜上方 3/4 视角
export function frameModel(camera: THREE.PerspectiveCamera, height: number): void {
  const dist = 1.75 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(dist * 0.55, height * 0.5 + dist * 0.28, dist * 0.8);
  camera.lookAt(0, height * 0.5, 0);
}

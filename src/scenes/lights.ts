import * as THREE from 'three/webgpu';

// 摄影棚式布光：暖色主光 + 冷色天光补光 + 背后的轮廓光，让各种风格的作品都好看
export function addStudioLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2420, 0.9));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(40, 60, 80);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.1);
  rim.position.set(-60, 20, -80);
  scene.add(rim);
}

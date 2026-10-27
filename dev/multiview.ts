import * as THREE from 'three/webgpu';
import { MultiView } from '../src/museum/multiview';

// 三个格子各画一个纯色方块：红、绿、蓝。检查脚本按格子中心取色
const colors: Record<string, number> = { a: 0xff0000, b: 0x00ff00, c: 0x0000ff };
const mv = await MultiView.create(document.querySelector<HTMLCanvasElement>('#mv')!);
for (const [id, hex] of Object.entries(colors)) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshBasicNodeMaterial({ color: hex })));
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0, 4);
  mv.add({ element: document.getElementById(id)!, scene, camera });
}
mv.renderer.setAnimationLoop(() => mv.render(1 / 60));
window.__mv = { backend: mv.backendName };

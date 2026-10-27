import * as THREE from 'three/webgpu';
import { hashString, mulberry32 } from '../planet/rng';

const makers: Array<() => THREE.BufferGeometry> = [
  () => new THREE.BoxGeometry(1, 1, 1),
  () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  () => new THREE.ConeGeometry(0.55, 1, 24),
  () => new THREE.SphereGeometry(0.55, 24, 16),
  () => new THREE.TorusKnotGeometry(0.32, 0.11, 96, 12),
];

// 占位作品（GLB 到之前用）：按作品 id 确定性地叠 2–4 块几何体，颜色在暖灰到黄铜之间
export function placeholderModel(id: string): THREE.Group {
  const rng = mulberry32(hashString(id));
  const material = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color().setHSL(0.05 + rng() * 0.5, 0.32, 0.56), roughness: 0.5, metalness: 0.1 });
  const group = new THREE.Group();
  let y = 0;
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(makers[Math.floor(rng() * makers.length)](), material);
    const s = 0.5 + rng() * 0.8;
    mesh.scale.setScalar(s);
    mesh.position.y = y + s * 0.5;
    mesh.rotation.y = rng() * Math.PI;
    y += s * 0.85;
    group.add(mesh);
  }
  return group;
}

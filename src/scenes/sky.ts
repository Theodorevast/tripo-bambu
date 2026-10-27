import * as THREE from 'three/webgpu';
import { color, mix, mx_fractal_noise_float, normalize, positionLocal, smoothstep } from 'three/tsl';
import { mulberry32 } from '../planet/rng';

// 天空：大号背面球画星云渐变 + 2500 颗星星。WebGPU 的 Points 只能画 1 像素，所以星星用实例化小球
export function createSky(): THREE.Group {
  const sky = new THREE.Group();
  const dir = normalize(positionLocal);
  const n1 = mx_fractal_noise_float(dir.mul(2.2), 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const n2 = mx_fractal_noise_float(dir.mul(3.1).add(7.3), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
  const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  domeMat.colorNode = mix(mix(color('#07080d'), color('#1b1530'), smoothstep(0.45, 0.85, n1)), color('#2a1c24'), smoothstep(0.62, 0.95, n2));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), domeMat);
  dome.renderOrder = -1;
  sky.add(dome);

  const count = 2500;
  const rng = mulberry32(99);
  const stars = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicNodeMaterial(), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rng() * 2 - 1;
    const phi = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    p.set(Math.cos(phi) * r, u, Math.sin(phi) * r).multiplyScalar(3000);
    s.setScalar(1.5 + rng() ** 4 * 5);
    stars.setMatrixAt(i, m.compose(p, q, s));
    stars.setColorAt(i, c.setHSL(0.58 + rng() * 0.12, 0.25, 0.7 + rng() * 0.3));
  }
  stars.frustumCulled = false;
  sky.add(stars);
  return sky;
}

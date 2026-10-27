import * as THREE from 'three/webgpu';
import { color, equirectUV, mix, normalize, positionLocal, smoothstep, texture } from 'three/tsl';
import { mulberry32 } from '../planet/rng';
import { bakeNebula } from './nebula';

// 星云贴图的尺寸：等距柱状投影，宽 = 2 × 高。星云很柔和，512 × 256 和逐像素算的结果只差 1/255，
// 加大到 1024 × 512 也一样，只是烘焙时间变成 4 倍
const NEBULA_W = 512;
const NEBULA_H = 256;

// 天空：大号背面球画星云渐变 + 2500 颗星星。WebGPU 的 Points 只能画 1 像素，所以星星用实例化小球
// 星云是静态的：启动时在 CPU 上烘焙成一张贴图（nebula.ts，噪声和 TSL 的 mx_fractal_noise_float 相同），
// 每帧每像素只采样一次，不用现算 7 个八度的噪声
export function createSky(): THREE.Group {
  const sky = new THREE.Group();
  const nebula = new THREE.DataTexture(bakeNebula(NEBULA_W, NEBULA_H), NEBULA_W, NEBULA_H, THREE.RGFormat, THREE.UnsignedByteType);
  nebula.wrapS = THREE.RepeatWrapping; // 经度 0° 和 360° 是同一条线：插值跨过接缝时取另一边的像素
  nebula.magFilter = THREE.LinearFilter;
  nebula.minFilter = THREE.LinearFilter; // 画面上贴图总是被放大，不用 mipmap
  nebula.needsUpdate = true;
  const n = texture(nebula, equirectUV(normalize(positionLocal))); // R = 大片紫色星云，G = 零星的暗红
  const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
  domeMat.colorNode = mix(mix(color('#07080d'), color('#1b1530'), smoothstep(0.45, 0.85, n.r)), color('#2a1c24'), smoothstep(0.62, 0.95, n.g));
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

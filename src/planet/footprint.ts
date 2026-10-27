import * as THREE from 'three/webgpu';
import type { HeightFn } from './noise';
import { groundRadius } from './placement';
import { BASE_RADIUS } from './presets';

// 展台底下最高的地面半径：中心和展台边缘一圈 samples 个均匀分布的方向，取 groundRadius 的最大值。
// 作品按它贴地，上坡一侧就不会埋住展台顶面；下坡一侧靠展台往地下延伸的部分补上（spec 2.2：展台不悬空）。
// dir：星球本地坐标里的单位向量；radius：展台顶面半径，按基础半径换算成球心角 radius / BASE_RADIUS
export function footprintGroundRadius(dir: THREE.Vector3, radius: number, height: HeightFn, sea: number, samples = 8): number {
  let best = groundRadius(dir, height, sea);
  // 切平面上的一对正交基 u、v：辅助向量只要不和 dir 平行就行，靠近两极时换一个
  const helper = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(dir, helper).normalize();
  const v = new THREE.Vector3().crossVectors(dir, u);
  const angle = radius / BASE_RADIUS;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p = new THREE.Vector3();
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    // dir 朝 (u cos t + v sin t) 方向转过 angle，结果仍是单位向量
    p.copy(dir).multiplyScalar(cos).addScaledVector(u, sin * Math.cos(t)).addScaledVector(v, sin * Math.sin(t));
    best = Math.max(best, groundRadius(p, height, sea));
  }
  return best;
}

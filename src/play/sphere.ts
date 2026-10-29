import * as THREE from 'three/webgpu';
import type { HeightFn } from '../planet/noise';
import { WADE_DEPTH } from './params';

// 球面上走路用的纯数学（星球本地坐标：原点是星球中心）。
// 每帧都要跑的函数一律写进传进来的向量、用模块里的临时变量，不新建对象；输入和输出是同一个对象也没关系

const _cross = new THREE.Vector3(); // spin、signedAngle 用
const _s0 = new THREE.Vector3(); // slerpDir 用
const _s1 = new THREE.Vector3();
const _p0 = new THREE.Vector3(); // blendPose 用
const _p1 = new THREE.Vector3();
const _q = new THREE.Quaternion();

// 帧率无关的指数逼近：这一帧走完剩下差距的多少（rate 是每秒的速率）
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// 进入、退出漫游时的镜头过渡：每帧最多往前推进 TRANSITION_MAX_STEP 秒（游戏里常见的做法：偶尔掉一帧时镜头不会一下子跳过去）。
// 过渡 FOLLOW.seconds = 1.2 秒、按 easeInOutCubic（最陡处斜率 3）走：一帧最多转「两头的朝向差 × 3 / 1.2 × 步长」。
// 进入漫游时两头差约 74°（check-walk 实测 60 帧时最多 3.08°/帧）：步长 1/40 秒最多 4.6°，朝向差到 96° 都在 6° 以内
// （check-walk 的上限是 6°；1/30 秒时实测的过渡会到 6.2°，所以取 1/40）。
// 只管过渡这一段：走路、跟随镜头照旧按真实的 dt
export const TRANSITION_MAX_STEP = 1 / 40;

export function transitionAdvance(t: number, dt: number): number {
  return t + Math.min(Math.max(0, dt), TRANSITION_MAX_STEP);
}

// 去掉 v 沿单位法线 n 的分量，只留切平面里的部分（写回 v）
export function flatten(v: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
  return v.addScaledVector(n, -v.dot(n));
}

// 和单位向量 n 垂直的一个单位向量：别的切向都退化时兜底（写进 out）
export function anyTangent(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(n.x) < 0.9) out.set(1, 0, 0);
  else out.set(0, 1, 0);
  return flatten(out, n).normalize();
}

// 把 v 压回 n 的切平面并归一化；退化（几乎和 n 平行）时改用 fallback 压平后的方向，再不行就随便取一个切向（写回 v）
export function retangent(v: THREE.Vector3, n: THREE.Vector3, fallback?: THREE.Vector3): THREE.Vector3 {
  flatten(v, n);
  if (v.lengthSq() > 1e-12) return v.normalize();
  if (fallback) {
    flatten(v.copy(fallback), n);
    if (v.lengthSq() > 1e-12) return v.normalize();
  }
  return anyTangent(n, v);
}

// 沿大圆走：单位向量 dir 朝切向单位向量 t 转过 angle 弧度（写回 dir）
export function advance(dir: THREE.Vector3, t: THREE.Vector3, angle: number): THREE.Vector3 {
  return dir.multiplyScalar(Math.cos(angle)).addScaledVector(t, Math.sin(angle)).normalize();
}

// 切向量 v 绕单位法线 n 转 angle 弧度（右手定则；v 要和 n 垂直，写回 v）
export function spin(v: THREE.Vector3, n: THREE.Vector3, angle: number): THREE.Vector3 {
  _cross.crossVectors(n, v);
  return v.multiplyScalar(Math.cos(angle)).addScaledVector(_cross, Math.sin(angle));
}

// 切向单位向量 f 转到 target 绕 n 的有向夹角，(-π, π]
export function signedAngle(f: THREE.Vector3, target: THREE.Vector3, n: THREE.Vector3): number {
  return Math.atan2(_cross.crossVectors(f, target).dot(n), f.dot(target));
}

// 朝向 f 绕 n 朝 target 转过两者夹角的 k 倍（k = 1 正好转到；写回 f）
export function turnToward(f: THREE.Vector3, target: THREE.Vector3, n: THREE.Vector3, k: number): THREE.Vector3 {
  return spin(f, n, signedAngle(f, target, n) * k);
}

// 两个单位向量之间走大圆插值（写进 out）。几乎反向时大圆不唯一，绕一条和 a 垂直的轴转
export function slerpDir(a: THREE.Vector3, b: THREE.Vector3, k: number, out: THREE.Vector3): THREE.Vector3 {
  _s0.copy(a);
  _s1.copy(b);
  const d = THREE.MathUtils.clamp(_s0.dot(_s1), -1, 1);
  if (d > 0.999999) return out.copy(_s0).lerp(_s1, k).normalize();
  // 从 a 指向 b 的切向
  _s1.addScaledVector(_s0, -d);
  if (_s1.lengthSq() < 1e-12) anyTangent(_s0, _s1);
  else _s1.normalize();
  const angle = Math.acos(d) * k;
  return out.copy(_s0).multiplyScalar(Math.cos(angle)).addScaledVector(_s1, Math.sin(angle));
}

// 镜头在两个姿态之间过渡：位置绕星球中心（原点）走大圆、远近线性插值，中途不会穿过星球；朝向做四元数球面插值。
// 写进 outPos、outQuat
export function blendPose(
  fromPos: THREE.Vector3, fromQuat: THREE.Quaternion, toPos: THREE.Vector3, toQuat: THREE.Quaternion, k: number,
  outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  const r0 = fromPos.length();
  const r1 = toPos.length();
  _p0.copy(fromPos).divideScalar(r0 || 1);
  _p1.copy(toPos).divideScalar(r1 || 1);
  slerpDir(_p0, _p1, k, outPos).multiplyScalar(r0 + (r1 - r0) * k);
  _q.copy(fromQuat).slerp(toQuat, k);
  outQuat.copy(_q);
}

// 角色站的地面半径：星球的高度函数（spec 4.2）。有海时海底最多比海面低 WADE_DEPTH：
// 浅水里涉水，海再深脚下也像踩着一层看不见的浅滩，漂在海上的展台和被海隔开的陆地都走得到
export function walkGround(dir: THREE.Vector3, height: HeightFn, sea: number, wade = WADE_DEPTH): number {
  const h = height(dir.x, dir.y, dir.z);
  return sea > 0 ? Math.max(h, sea - wade) : h;
}

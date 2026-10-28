import * as THREE from 'three/webgpu';
import { FOLLOW, WALK } from './params';
import { damp, retangent, spin, turnToward } from './sphere';
import type { Walker } from './walker';

const _goal = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _back = new THREE.Vector3();
const _m = new THREE.Matrix4();

// 跟随镜头（星球本地坐标）：在角色后上方，「上」是角色脚下的球面法线。
// 镜头的水平朝向 heading 每帧跟着角色位置的转动一起转（平行移动）：沿大圆一直往前走，镜头一直在身后，
// 翻过两极、走到星球背面都是连续的，不会翻转；注视点按指数逼近追角色，镜头不是硬绑在角色身上
export class FollowCamera {
  readonly up = new THREE.Vector3(0, 1, 0); // 角色的 dir
  readonly heading = new THREE.Vector3(0, 0, 1); // 镜头的水平朝向（up 的切平面里）：WASD 的「前」
  pitch = FOLLOW.pitch;
  distance = FOLLOW.distance;
  readonly focus = new THREE.Vector3(); // 注视点：角色胸口，有一点滞后
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly right = new THREE.Vector3(); // 镜头的右、上（世界方向和星球本地一样：星球只平移、不旋转）
  readonly screenUp = new THREE.Vector3(0, 1, 0);
  private lift = 0; // 地形高过镜头时沿径向抬起的量

  // 立刻放到角色身后：水平朝向取 heading 在切平面上的投影（进入漫游、瞬移时用）
  reset(walker: Walker, heading: THREE.Vector3): void {
    this.up.copy(walker.dir);
    retangent(this.heading.copy(heading), this.up, walker.facing);
    walker.positionInto(this.focus).addScaledVector(this.up, FOLLOW.focus);
    this.lift = 0;
  }

  // 拖动：dx 绕角色转（往右拖，镜头往左绕，像抓着地面转，和轨道镜头的手感一样），dy 改俯角（往下拖，镜头抬高）
  orbit(dx: number, dy: number): void {
    spin(this.heading, this.up, dx * FOLLOW.dragYaw);
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * FOLLOW.dragPitch, FOLLOW.minPitch, FOLLOW.maxPitch);
  }

  zoom(factor: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, FOLLOW.minDistance, FOLLOW.maxDistance);
  }

  // 每帧，角色走完这一帧之后调。autoTurn：点地面自动走时，镜头慢慢转到角色身后。
  // floor(dir)：那个方向上镜头不能低于的半径（地面或海面再加一点余量）
  update(dt: number, walker: Walker, autoTurn: boolean, floor: (dir: THREE.Vector3) => number): void {
    this.heading.applyQuaternion(walker.turned);
    this.up.copy(walker.dir);
    retangent(this.heading, this.up, this.screenUp);
    const speed = walker.speed;
    if (autoTurn && speed > 0.3) turnToward(this.heading, walker.facing, this.up, damp(FOLLOW.autoTurn * Math.min(1, speed / WALK.speed), dt));
    walker.positionInto(_goal).addScaledVector(this.up, FOLLOW.focus);
    this.focus.lerp(_goal, damp(FOLLOW.follow, dt));
    // 从注视点往后 distance·cos(pitch)、往上 distance·sin(pitch)
    const back = Math.cos(this.pitch) * this.distance;
    const rise = Math.sin(this.pitch) * this.distance;
    this.position.copy(this.focus).addScaledVector(this.heading, -back).addScaledVector(this.up, rise);
    // 镜头低于地面（身后是山坡）或海面时沿径向抬起来：上升立刻跟上，回落慢慢来，不跟着起伏的地面颠
    const r = this.position.length();
    const need = Math.max(0, floor(_dir.copy(this.position).divideScalar(r)) - r);
    this.lift = need > this.lift ? need : this.lift + (need - this.lift) * damp(FOLLOW.lift, dt);
    this.position.multiplyScalar((r + this.lift) / r);
    this.aim();
  }

  // 看着注视点上方一点。右方向取 heading × up 再和视线正交化：它和角色一起连续地转，
  // 不像 lookAt 那样依赖一个固定的「世界上方」，看的方向接近上方时也不会翻
  private aim(): void {
    _fwd.copy(this.focus).addScaledVector(this.up, FOLLOW.aim).sub(this.position).normalize();
    _right.crossVectors(this.heading, this.up);
    _right.addScaledVector(_fwd, -_right.dot(_fwd)).normalize();
    _camUp.crossVectors(_right, _fwd);
    _back.copy(_fwd).negate();
    this.quaternion.setFromRotationMatrix(_m.makeBasis(_right, _camUp, _back));
    this.right.copy(_right);
    this.screenUp.copy(_camUp);
  }
}

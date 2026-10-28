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
const _j0 = new THREE.Vector3();
const _j1 = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

// 镜头的手感（GDC「Juicing Your Cameras」、Daniel Holden 的弹簧）：注视点用临界阻尼弹簧追角色（起步、停下都顺，没有过冲）；
// 镜头离角色的距离也用一个弹簧：滚轮缩放不跳，走起来往后让一点（角色跑在画面里不显得挤），停下慢慢回来；
// 站着时有很轻的「呼吸」晃动；撞上作品时按「创伤值」的平方抖一下，很快衰减。晃动、抖动都只转镜头、不挪位置
export const FEEL = {
  spring: 9, // 注视点弹簧的角频率（1/秒）：越大追得越紧
  zoomSpring: 4, // 距离弹簧的角频率（1/秒）：缩放、往后让的快慢
  pullBack: 0.1, // 全速走的时候镜头往后让多少（× 距离）
  breathe: 0.0022, // 呼吸晃动的幅度（弧度，约 0.13°）
  bump: 0.55, // 一次正面撞上加多少创伤值（0..1；按撞上时的速度打折）
  decay: 1.6, // 创伤值每秒衰减多少
  shake: 0.014, // 创伤值为 1 时抖动的最大角度（弧度，约 0.8°）
};

// 临界阻尼弹簧（精确解，和帧率无关）：x、v 朝 goal 走一帧 dt，写回 x、v
function springTo(x: THREE.Vector3, v: THREE.Vector3, goal: THREE.Vector3, omega: number, dt: number): void {
  const e = Math.exp(-omega * dt);
  _j0.copy(x).sub(goal);
  _j1.copy(v).addScaledVector(_j0, omega);
  x.copy(_j0).addScaledVector(_j1, dt).multiplyScalar(e).add(goal);
  v.addScaledVector(_j1, -omega * dt).multiplyScalar(e);
}

// 几个不成整数比的正弦叠起来：很便宜的平滑「噪声」，输出约 -1..1
const wobble = (t: number, a: number, b: number, c: number) => Math.sin(t * a) * 0.5 + Math.sin(t * b + 1.3) * 0.3 + Math.sin(t * c + 2.1) * 0.2;

// 跟随镜头（星球本地坐标）：在角色后上方，「上」是角色脚下的球面法线。
// 镜头的水平朝向 heading 每帧跟着角色位置的转动一起转（平行移动）：沿大圆一直往前走，镜头一直在身后，
// 翻过两极、走到星球背面都是连续的，不会翻转；注视点用弹簧追角色，镜头不是硬绑在角色身上
export class FollowCamera {
  readonly up = new THREE.Vector3(0, 1, 0); // 角色的 dir
  readonly heading = new THREE.Vector3(0, 0, 1); // 镜头的水平朝向（up 的切平面里）：WASD 的「前」
  pitch = FOLLOW.pitch;
  distance = FOLLOW.distance; // 想要的距离（滚轮改它）；实际的距离 dist 用弹簧追它
  readonly focus = new THREE.Vector3(); // 注视点：角色胸口，有一点滞后
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly right = new THREE.Vector3(); // 镜头的右、上（世界方向和星球本地一样：星球只平移、不旋转）
  readonly screenUp = new THREE.Vector3(0, 1, 0);
  trauma = 0; // 创伤值 0..1：撞上作品时加，抖动按它的平方
  private readonly focusVel = new THREE.Vector3();
  private dist = FOLLOW.distance;
  private distVel = 0;
  // ?tune 改了 FOLLOW 的距离、俯角：下一帧就用新值（记下上次看到的值，只在表变了的时候覆盖，拖动、滚轮改的照旧）
  private seenDistance = FOLLOW.distance;
  private seenPitch = FOLLOW.pitch;
  private lift = 0; // 地形高过镜头时沿径向抬起的量
  private time = 0;
  private wasBumped = false;

  // 立刻放到角色身后：水平朝向取 heading 在切平面上的投影（进入漫游、瞬移时用）
  reset(walker: Walker, heading: THREE.Vector3): void {
    this.up.copy(walker.dir);
    retangent(this.heading.copy(heading), this.up, walker.facing);
    walker.positionInto(this.focus).addScaledVector(this.up, FOLLOW.focus);
    this.focusVel.set(0, 0, 0);
    this.syncTable();
    this.dist = this.distance;
    this.distVel = 0;
    this.lift = 0;
    this.trauma = 0;
    this.wasBumped = false;
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
  // floor(dir)：那个方向上镜头不能低于的半径（地面或水面再加一点余量）
  update(dt: number, walker: Walker, autoTurn: boolean, floor: (dir: THREE.Vector3) => number): void {
    this.time += dt;
    this.syncTable();
    this.heading.applyQuaternion(walker.turned);
    this.focusVel.applyQuaternion(walker.turned);
    this.up.copy(walker.dir);
    retangent(this.heading, this.up, this.screenUp);
    const speed = walker.speed;
    if (autoTurn && speed > 0.3) turnToward(this.heading, walker.facing, this.up, damp(FOLLOW.autoTurn * Math.min(1, speed / WALK.speed), dt));
    walker.positionInto(_goal).addScaledVector(this.up, FOLLOW.focus);
    springTo(this.focus, this.focusVel, _goal, FEEL.spring, dt);
    // 撞上作品的那一下（这一帧碰到、上一帧没碰到）：按撞上前的速度加创伤值
    if (walker.bumped && !this.wasBumped) this.trauma = Math.min(1, this.trauma + FEEL.bump * Math.min(1, walker.impact / WALK.speed));
    this.wasBumped = walker.bumped;
    this.trauma = Math.max(0, this.trauma - FEEL.decay * dt);
    // 距离：想要的距离，走得越快往后让得越多；临界阻尼弹簧追过去（精确解，和帧率无关）
    const goal = this.distance * (1 + FEEL.pullBack * Math.min(1, speed / WALK.speed));
    const e = Math.exp(-FEEL.zoomSpring * dt);
    const j0 = this.dist - goal;
    const j1 = this.distVel + j0 * FEEL.zoomSpring;
    this.dist = goal + (j0 + j1 * dt) * e;
    this.distVel = (this.distVel - j1 * FEEL.zoomSpring * dt) * e;
    const d = this.dist;
    // 从注视点往后 d·cos(pitch)、往上 d·sin(pitch)，再往右偏一点（越肩）；偏完把这段距离拉回 d
    const back = Math.cos(this.pitch) * d;
    const rise = Math.sin(this.pitch) * d;
    _right.crossVectors(this.heading, this.up);
    _goal.copy(this.heading).multiplyScalar(-back).addScaledVector(this.up, rise).addScaledVector(_right, FOLLOW.shoulder);
    _goal.multiplyScalar(d / _goal.length());
    this.position.copy(this.focus).add(_goal);
    // 镜头低于地面（身后是山坡）或水面时沿径向抬起来：上升立刻跟上，回落慢慢来，不跟着起伏的地面颠
    const r = this.position.length();
    const need = Math.max(0, floor(_dir.copy(this.position).divideScalar(r)) - r);
    this.lift = need > this.lift ? need : this.lift + (need - this.lift) * damp(FOLLOW.lift, dt);
    this.position.multiplyScalar((r + this.lift) / r);
    this.aim();
  }

  // FOLLOW 表（?tune）变了：用新的距离、俯角
  private syncTable(): void {
    if (FOLLOW.distance !== this.seenDistance) this.distance = this.seenDistance = FOLLOW.distance;
    if (FOLLOW.pitch !== this.seenPitch) this.pitch = this.seenPitch = FOLLOW.pitch;
  }

  // 看着注视点上方一点。右方向取 heading × up 再和视线正交化：它和角色一起连续地转，
  // 不像 lookAt 那样依赖一个固定的「世界上方」，看的方向接近上方时也不会翻。
  // 最后叠上呼吸和抖动（绕镜头自己的轴转一点点）
  private aim(): void {
    _right.crossVectors(this.heading, this.up);
    // 越肩：看的点也往右挪（比镜头挪得少），视线和前进方向差不多平行，角色落在画面中间偏左
    _fwd.copy(this.focus).addScaledVector(this.up, FOLLOW.aim).addScaledVector(_right, FOLLOW.shoulder * 0.6).sub(this.position).normalize();
    _right.addScaledVector(_fwd, -_right.dot(_fwd)).normalize();
    _camUp.crossVectors(_right, _fwd);
    _back.copy(_fwd).negate();
    this.quaternion.setFromRotationMatrix(_m.makeBasis(_right, _camUp, _back));
    this.right.copy(_right);
    this.screenUp.copy(_camUp);
    const t = this.time;
    const shake = this.trauma * this.trauma * FEEL.shake;
    const pitch = wobble(t, 1.07, 1.73, 2.9) * FEEL.breathe + wobble(t, 23.1, 37.7, 51.3) * shake;
    const yaw = wobble(t + 4.1, 0.83, 1.41, 2.3) * FEEL.breathe + wobble(t + 2.7, 19.3, 31.1, 47.9) * shake;
    const roll = wobble(t + 7.3, 17.9, 29.3, 43.7) * shake * 0.5;
    if (pitch !== 0 || yaw !== 0 || roll !== 0) this.quaternion.multiply(_q.setFromEuler(_e.set(pitch, yaw, roll)));
  }
}

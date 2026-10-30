import * as THREE from 'three/webgpu';
import { WALK } from './params';
import { advance, anyTangent, damp, flatten, retangent, turnToward } from './sphere';

// 角色在球面上的移动：位置是星球本地坐标里的单位方向 dir，离球心 radius（贴地）。
// 重力指向球心，所以「上」就是 dir；速度、朝向都是 dir 切平面里的向量，走一步就跟着位置一起转（平行移动），
// 不用经纬度，走过两极也不会突然转向

// 作品和展台的碰撞体：沿法线竖着的圆柱，在球面上就是一个圆盘。角色中心离作品中心的球心角不能小于 minAngle。
// 角色不是圆的（翠宝两侧的手臂比身体宽，params.ts 的 CHAR_SIDE）：圆柱在角色正侧面时再多挡 side，正前、正后不加，
// 中间按夹角正弦的平方过渡（和椭圆的支撑距离差不到 5 毫米）
export interface Obstacle {
  readonly center: THREE.Vector3; // 单位向量：作品在球面上的方向
  minAngle: number; // （作品半径 + 角色半径）/ 作品所在的地面半径
  cosMin: number; // cos(minAngle)：比较点积，不用每次算反余弦
  side: number; // 圆柱在角色正侧面时多挡的球心角：（CHAR_SIDE − CHAR_RADIUS）/ 地面半径；0 = 角色当圆的
  cosOuter: number; // cos(minAngle + side)：比它还远的，侧面也碰不到，直接跳过
}

export function newObstacle(): Obstacle {
  return { center: new THREE.Vector3(), minAngle: 0, cosMin: 1, side: 0, cosOuter: 1 };
}

export function setObstacle(o: Obstacle, center: THREE.Vector3, minAngle: number, side = 0): void {
  o.center.copy(center).normalize();
  o.minAngle = minAngle;
  o.cosMin = Math.cos(minAngle);
  o.side = side;
  o.cosOuter = Math.cos(minAngle + side);
}

const _t = new THREE.Vector3();
const _u = new THREE.Vector3();

// 在不在某个圆柱里面（留一点余量：刚被推到边上的不算）
export function inside(dir: THREE.Vector3, obstacles: readonly Obstacle[], count = obstacles.length): boolean {
  for (let i = 0; i < count; i++) if (dir.dot(obstacles[i].center) > obstacles[i].cosMin + 1e-9) return true;
  return false;
}

// 把单位向量 dir 推出所有圆柱：沿「作品中心 → 角色」的大圆推到圆柱边上；速度里朝圆柱里面的分量去掉，
// 剩下沿圆柱边的分量，角色就贴着圆柱滑过去。几个圆柱挤在一起时推几轮；还出不来就退回 fallback（上一帧的位置）、速度清零。
// facing：角色的朝向（切向单位向量）；给了才算圆柱的 side（侧着贴过去时按手臂挡）。
// 返回这一帧有没有碰到圆柱
export function collide(dir: THREE.Vector3, velocity: THREE.Vector3, obstacles: readonly Obstacle[], count: number, fallback: THREE.Vector3, facing: THREE.Vector3 | null = null): boolean {
  let hit = false;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
      const o = obstacles[i];
      const d = dir.dot(o.center);
      const wide = facing !== null && o.side > 0;
      if (d <= (wide ? o.cosOuter : o.cosMin) + 1e-9) continue;
      // 作品中心指向角色的切向；正好站在作品中心上（出生点）时随便取一个方向推出去
      _t.copy(dir).addScaledVector(o.center, -d);
      if (_t.lengthSq() < 1e-14) anyTangent(o.center, _t);
      else _t.normalize();
      let a = o.minAngle;
      if (wide) {
        // facing 和「作品 → 角色」这条线的夹角余弦：±1 是作品在正前、正后，0 是在正侧面
        // （_t 在作品中心的切平面里，除以 d 换到角色脚下的切平面）
        const k = facing.dot(_t) / d;
        a += o.side * Math.max(0, 1 - k * k);
        if (d <= Math.cos(a) + 1e-9) continue;
      }
      a += 1e-7;
      const c = Math.cos(a);
      const s = Math.sin(a);
      dir.copy(o.center).multiplyScalar(c).addScaledVector(_t, s);
      // 推出去以后，圆柱边上朝外的切向
      _u.copy(_t).multiplyScalar(c).addScaledVector(o.center, -s);
      const vn = velocity.dot(_u);
      if (vn < 0) velocity.addScaledVector(_u, -vn);
      moved = true;
      hit = true;
    }
    if (!moved) return hit;
  }
  if (inside(dir, obstacles, count) && !inside(fallback, obstacles, count)) {
    dir.copy(fallback);
    velocity.set(0, 0, 0);
  }
  return hit;
}

const _start = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _move = new THREE.Vector3();
const _step = new THREE.Quaternion();

export class Walker {
  readonly dir = new THREE.Vector3(0, 1, 0); // 单位向量：角色在球面上的方向（也是角色的「上」）
  radius = 1; // 脚下的地面半径
  readonly velocity = new THREE.Vector3(); // 切平面里，单位：每秒
  readonly facing = new THREE.Vector3(0, 0, 1); // 切平面里的单位向量：身体正面
  readonly turned = new THREE.Quaternion(); // 这一帧位置的转动：跟随镜头的朝向跟着转同一下
  distance = 0; // 累计走过的路程：走路动作的相位跟着它
  bumped = false; // 这一帧碰到了圆柱
  impact = 0; // 碰到时撞上之前的速度（米/秒）：跟随镜头按它抖一下
  ground: (dir: THREE.Vector3) => number = () => 1;
  speedScale = 1; // 走路速度的倍数（涉水时 walkMode 调小）：自动走也按它
  // 点地面 / 作品后自动走过去
  readonly target = new THREE.Vector3();
  hasTarget = false;
  private stopAt = 0; // 离目标还剩这么远（球面上的路程）就算到了：点作品时停在展台边上
  private best = Infinity;
  private stalled = 0;

  // 脚底的位置（星球本地坐标），写进 out
  positionInto(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.dir).multiplyScalar(this.radius);
  }

  get speed(): number {
    return this.velocity.length();
  }

  // 放到 dir（站上地面、推出圆柱），身体朝 facing 在切平面上的投影；速度清零、不自动走
  place(dir: THREE.Vector3, facing: THREE.Vector3, obstacles: readonly Obstacle[] = [], count = obstacles.length): void {
    this.dir.copy(dir).normalize();
    this.velocity.set(0, 0, 0);
    retangent(this.facing.copy(facing), this.dir); // 先定朝向：推出圆柱时侧面按手臂算
    collide(this.dir, this.velocity, obstacles, count, this.dir, this.facing);
    this.radius = this.ground(this.dir);
    retangent(this.facing, this.dir);
    this.turned.identity();
    this.hasTarget = false;
  }

  // 自动走到 target（单位向量）；stopAt：还剩这么远就停
  goTo(target: THREE.Vector3, stopAt = 0): void {
    this.target.copy(target).normalize();
    this.stopAt = stopAt;
    this.hasTarget = true;
    this.best = Infinity;
    this.stalled = 0;
  }

  stop(): void {
    this.hasTarget = false;
  }

  // 自动走的目标速度写进 out：朝目标，离终点近了按距离减速。到了、或者 0.6 秒没再靠近（被作品挡住）就停下，返回 false
  autoWish(dt: number, out: THREE.Vector3): boolean {
    if (!this.hasTarget) return false;
    const d = this.dir.dot(this.target);
    _t.copy(this.target).addScaledVector(this.dir, -d);
    const left = Math.atan2(_t.length(), d) * this.radius - this.stopAt;
    if (left <= 0.05) {
      this.hasTarget = false;
      return false;
    }
    if (left < this.best - 0.02) {
      this.best = left;
      this.stalled = 0;
    } else if ((this.stalled += dt) > 0.6) {
      this.hasTarget = false;
      return false;
    }
    retangent(_t, this.dir, this.facing);
    out.copy(_t).multiplyScalar(Math.min(WALK.speed * this.speedScale, left * WALK.arrive));
    return true;
  }

  // 走一帧。wish：想要的速度（dir 切平面里，单位：每秒）。
  // 速度按指数逼近 wish，位移按这条速度曲线精确积分，同样的输入下 30、60、144 帧走出来的路一样
  step(dt: number, wish: THREE.Vector3, obstacles: readonly Obstacle[], count = obstacles.length): void {
    const e = Math.exp(-WALK.accel * dt);
    // v(t) = wish + (v0 − wish)·e^(−k t)，0..dt 上积分得到这一帧的位移
    _move.copy(this.velocity).sub(wish).multiplyScalar((1 - e) / WALK.accel).addScaledVector(wish, dt);
    this.velocity.sub(wish).multiplyScalar(e).add(wish);
    _start.copy(this.dir);
    const len = _move.length();
    if (len > 1e-9) advance(this.dir, _move.divideScalar(len), len / Math.max(this.radius, 1e-6));
    // 速度、朝向跟着位置转到新的切平面，再处理碰撞（推出去以后再转一次）
    _mid.copy(this.dir);
    this.turned.setFromUnitVectors(_start, _mid);
    this.velocity.applyQuaternion(this.turned);
    this.facing.applyQuaternion(this.turned);
    const before = this.velocity.length();
    this.bumped = collide(this.dir, this.velocity, obstacles, count, _start, this.facing);
    this.impact = this.bumped ? before : 0;
    if (this.bumped) {
      _step.setFromUnitVectors(_mid, this.dir);
      this.velocity.applyQuaternion(_step);
      this.facing.applyQuaternion(_step);
      this.turned.premultiply(_step);
    }
    flatten(this.velocity, this.dir);
    retangent(this.facing, this.dir);
    this.radius = this.ground(this.dir);
    this.distance += _start.distanceTo(this.dir) * this.radius;
    // 转身：朝移动方向指数逼近（太慢时不转，停下时保持最后的朝向）
    const speed = this.velocity.length();
    if (speed > 0.05) turnToward(this.facing, _move.copy(this.velocity).divideScalar(speed), this.dir, damp(WALK.turn, dt));
  }
}

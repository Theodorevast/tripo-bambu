import * as THREE from 'three/webgpu';
import { WADE_DEPTH, WALK, WALK_ANIM } from './params';
import { damp, signedAngle, spin } from './sphere';
import type { Walker } from './walker';

// 走路的步态（纯数学，不碰场景图；character.ts 把结果摆到翠宝的各个部件上）。坐标都是星球本地坐标，和 Walker 一样。
//
// 一个周期两步：相位 phase 0..1，左脚在 0 落地、右脚在 0.5 落地。相位跟着走过的路程走（每走 2 × 步长一个周期），
// 原地转身时按转过的角度走，停下、转身后脚没回到站姿时至少按 settleCadence 的步频走，直到两只脚都踩回站姿。
// 每只脚分「着地」和「迈步」两段：着地时脚在星球上的位置记成一个固定点（anchor），身体怎么走它都不动，所以不会打滑；
// 迈步时从起脚的点沿一条弧线走到落点。落点按「落地那一刻身体会在哪」预测（现在的速度、转身的角速度），
// 再往前放半段着地的路程：接下来着地的这段身体从脚的正上方前面走到后面，左右对称。
// 身体的颠、压扁、重心左右移、肩胯反向转、手臂摆都按相位算（和脚步同一个钟），幅度跟着「正在迈步」的包络淡入淡出；
// 前倾、侧倾、下沉跟着加速度走，用欠阻尼弹簧（精确解，和帧率无关），起步、刹车、停下都自然带出一点预备和回弹

export interface FootState {
  readonly side: 1 | -1; // +1 左脚（模型 +X），-1 右脚
  planted: boolean;
  readonly anchor: THREE.Vector3; // 着地：脚踩的点；迈步：起脚的点
  readonly anchorFwd: THREE.Vector3; // 着地时脚尖朝向（切向单位向量）；迈步时是起脚那一刻的朝向
  readonly target: THREE.Vector3; // 迈步的落点
  readonly targetFwd: THREE.Vector3;
  readonly pos: THREE.Vector3; // 输出：这一帧脚（脚底转轴）的位置，含抬脚高度
  readonly fwd: THREE.Vector3; // 输出：脚尖朝向
  lift: number; // 输出：离地多高（米）
  pitch: number; // 输出：脚尖往上翘（弧度，负的是脚尖朝下）
  swing: number; // 迈步进度 0..1（着地时 0）
  pLift: number; // 起脚时这只脚的周期相位
  height: number; // 这一步抬多高
  stride: number; // 这一步水平走多远
  skip: boolean; // 这个周期不用迈（站着、脚已经在站姿上）
}

function makeFoot(side: 1 | -1): FootState {
  return {
    side, planted: true,
    anchor: new THREE.Vector3(), anchorFwd: new THREE.Vector3(0, 0, 1), target: new THREE.Vector3(), targetFwd: new THREE.Vector3(0, 0, 1),
    pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1),
    lift: 0, pitch: 0, swing: 0, pLift: 0, height: 0, stride: 0, skip: false,
  };
}

// 欠阻尼（或临界）弹簧：x 朝 target 走 dt（目标在这一帧里不变时是精确解，和帧率无关）
export interface Spring {
  x: number;
  v: number;
}

export function springStep(s: Spring, target: number, omega: number, zeta: number, dt: number): void {
  const y = s.x - target;
  const z = Math.min(zeta, 0.999);
  const wd = omega * Math.sqrt(1 - z * z);
  const e = Math.exp(-z * omega * dt);
  const c = Math.cos(wd * dt);
  const sn = Math.sin(wd * dt);
  const a = y;
  const b = (s.v + z * omega * y) / wd;
  s.x = target + e * (a * c + b * sn);
  s.v = e * ((b * wd - z * omega * a) * c - (a * wd + z * omega * b) * sn);
}

const TAU = Math.PI * 2;
const frac = (x: number) => x - Math.floor(x);
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

const _x = new THREE.Vector3();
const _f = new THREE.Vector3();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Gait {
  readonly feet: readonly [FootState, FootState] = [makeFoot(1), makeFoot(-1)];
  // 脚的站姿（角色本地坐标：x 往左，z 往前，脚底转轴的位置），character.ts 按模型设
  readonly rest: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.1, 0, 0), new THREE.Vector3(-0.1, 0, 0)];
  toe = 0.25; // 脚尖、脚跟离脚底转轴多远：脚尖朝下、翘起时抬高一点，不插进地里
  heel = 0.1;
  phase = 0;
  resting = true; // 两只脚都踩在站姿上，相位停着
  // 输出：身体
  amp = 0; // 迈步的包络 0..1：颠、摆的幅度跟着它
  walk = 0; // 走路的分量 0..1（跟着速度平滑过渡）：呼吸、站着晃手淡出
  bob = 0; // 往上颠（米）
  squash = 0; // 竖着伸缩的比例（正的拉长）
  shift = 0; // 重心往左移（米）
  pitch = 0; // 前倾（弧度）
  roll = 0; // 往左歪（弧度：头往左）
  twist = 0; // 肩膀转（弧度，绕上方向，右手定则）
  hipTwist = 0;
  readonly arm: [number, number] = [0, 0]; // 手臂往前摆（弧度），[左, 右]
  readonly hand: [number, number] = [0, 0]; // 手相对手臂再往前甩
  readonly armOut: [number, number] = [0, 0]; // 手臂往外张
  breath = 0; // 呼吸：竖着伸缩的比例
  wade = 0; // 涉水 0..1
  speed = 0;
  private time = 0;
  private readonly lean: Spring = { x: 0, v: 0 };
  private readonly tilt: Spring = { x: 0, v: 0 };
  private readonly sink: Spring = { x: 0, v: 0 };
  private readonly lastPos = new THREE.Vector3();
  private readonly lastVel = new THREE.Vector3();
  private readonly lastFacing = new THREE.Vector3(0, 0, 1);
  private lastDistance = 0;
  private omega = 0; // 转身的角速度（弧度/秒，平滑过）
  private primed = false;

  // 两只脚立刻站回站姿（进入漫游、瞬移时）
  reset(w: Walker): void {
    w.positionInto(this.lastPos);
    this.lastVel.copy(w.velocity);
    this.lastFacing.copy(w.facing);
    this.lastDistance = w.distance;
    this.omega = 0;
    for (const f of this.feet) {
      this.restPoint(w, f, w.facing, f.anchor);
      f.anchorFwd.copy(w.facing);
      f.planted = true;
      f.swing = 0;
      f.lift = 0;
      f.pitch = 0;
      f.skip = false;
      f.pos.copy(f.anchor);
      f.fwd.copy(w.facing);
    }
    this.resting = true;
    this.amp = 0;
    this.lean.x = this.lean.v = 0;
    this.tilt.x = this.tilt.v = 0;
    this.sink.x = this.sink.v = 0;
    this.primed = true;
    this.body(0, 0, 0, 0, 0, 1);
  }

  // 每帧（Walker.step 之后）。depth：脚下的水深（米）；motion：身体、手臂动作的幅度倍数（减少动态效果时变小，脚步照走）
  update(w: Walker, dt: number, depth = 0, motion = 1): void {
    if (!this.primed) this.reset(w);
    w.positionInto(_p);
    // 瞬移（或者换了星球）：一帧挪得比走路可能的远得多，脚直接站回去
    if (_p.distanceTo(this.lastPos) > 0.5 + WALK.speed * 4 * Math.max(dt, 1 / 30)) this.reset(w);
    this.lastPos.copy(_p);
    if (dt <= 0) return;
    const A = WALK_ANIM;
    this.time += dt;
    const up = w.dir;
    const facing = w.facing;
    _x.crossVectors(up, facing); // 角色的左
    // 速度、加速度（上一帧的速度先跟着位置转到这一帧的切平面）、转身的角速度
    const speed = w.speed;
    this.speed = speed;
    this.lastVel.applyQuaternion(w.turned);
    _a.copy(w.velocity).sub(this.lastVel).divideScalar(dt);
    this.lastVel.copy(w.velocity);
    this.lastFacing.applyQuaternion(w.turned);
    const turn = signedAngle(this.lastFacing, facing, up) / dt;
    this.lastFacing.copy(facing);
    this.omega += (clamp(turn, -20, 20) - this.omega) * damp(30, dt);
    const along = _a.dot(facing);
    const side = _a.dot(_x);
    const speedK = clamp(speed / WALK.speed, 0, 1);
    this.walk += (speedK - this.walk) * damp(8, dt);
    this.wade += (clamp(depth / WADE_DEPTH, 0, 1) - this.wade) * damp(5, dt);
    // 步长、着地占比、相位速度
    const stride = clamp(A.stepBase + A.stepPerSpeed * speed, A.stepMin, A.stepMax) * (1 + A.wadeStride * this.wade);
    const duty = A.dutySlow + (A.dutyFast - A.dutySlow) * speedK;
    const moved = clamp(w.distance - this.lastDistance, 0, 1);
    this.lastDistance = w.distance;
    let rate = moved / dt / (2 * stride) + Math.abs(this.omega) / (2 * A.turnStep);
    const swinging = !this.feet[0].planted || !this.feet[1].planted;
    const settle = swinging || this.maxError(w) > A.settleError;
    if (speed > 0.12) rate = Math.max(rate, A.minCadence / 2);
    if (settle) rate = Math.max(rate, A.settleCadence / 2);
    rate = Math.min(rate, A.maxCadence / 2);
    if (rate < 1e-4 && !settle) {
      this.resting = true;
      rate = 0;
    } else if (this.resting) {
      // 从站着起步：先迈落在后面的那只脚，相位拨到它起脚的那一刻（身体的摆动这时幅度为 0，拨相位看不出来）
      this.resting = false;
      if (this.amp < 0.1) {
        const first = this.firstFoot(w);
        this.phase = frac(duty - (first === 0 ? 0 : 0.5));
      }
    }
    const step = Math.min(rate * dt, 0.2);
    const reach = rate > 0 ? duty / (2 * rate) : 0; // 落地以后再走半段着地时间：落点往前放这么远（按速度）
    const prev = this.phase;
    this.phase = frac(prev + step);
    // 每只脚
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const off = i === 0 ? 0 : 0.5;
      const p0 = frac(prev + off);
      const wrapped = p0 + step >= 1;
      const p = frac(p0 + step);
      if (!f.planted) {
        if (wrapped || f.swing >= 1) {
          // 落地：落点就是脚现在的位置
          f.planted = true;
          f.anchor.copy(f.target);
          f.anchorFwd.copy(f.targetFwd);
          f.swing = 0;
          f.skip = false;
        } else {
          f.swing = clamp((p - f.pLift) / Math.max(1e-3, 1 - f.pLift), 0, 1);
          if (f.swing < A.lockAt) this.predict(w, f, (1 - p) / Math.max(rate, 1e-3), reach, speed);
        }
      } else if (wrapped) {
        f.skip = false;
      }
      if (f.planted && !f.skip && p >= duty && (p0 < duty || !wrapped)) {
        // 起脚：看看要不要迈（站着、脚已经在站姿上就不迈）
        this.predict(w, f, (1 - p) / Math.max(rate, 1e-3), reach, speed);
        const need = f.anchor.distanceTo(f.target) + A.yawLever * Math.abs(signedAngle(f.anchorFwd, f.targetFwd, up));
        if (need < A.settleError * 0.6 && speed < 0.12) {
          f.skip = true;
        } else {
          f.planted = false;
          f.pLift = p;
          f.swing = 0;
          f.stride = Math.min(f.anchor.distanceTo(f.target), 1);
          f.height = (A.lift + A.liftPerStep * f.stride) * (1 + A.wadeLift * this.wade) * (0.7 + 0.3 * motion);
        }
      }
      this.placeFoot(w, f, motion);
    }
    // 包络：有脚在迈步时按这一步的长度淡入，没在迈就淡出
    let target = 0;
    for (const f of this.feet) if (!f.planted) target = Math.max(target, clamp(f.stride / (A.stepBase + A.stepPerSpeed * WALK.speed), 0.3, 1));
    this.amp += (target - this.amp) * damp(target > this.amp ? 10 : 5, dt);
    // 加速度带出来的前倾、侧倾、下沉（弹簧）
    const leanTarget = clamp(A.leanSpeed * (w.velocity.dot(facing) / WALK.speed) + A.leanAccel * along + A.wadeLean * this.wade, -A.leanMax, A.leanMax);
    const tiltTarget = clamp(A.leanTurn * side, -A.leanMax, A.leanMax);
    const sinkTarget = -A.sink * Math.min(1, Math.hypot(along, side) / A.accelRef);
    springStep(this.lean, leanTarget, A.leanSpring, A.leanDamping, dt);
    springStep(this.tilt, tiltTarget, A.leanSpring, A.leanDamping, dt);
    springStep(this.sink, sinkTarget, A.leanSpring, A.leanDamping, dt);
    this.body(this.lean.x, this.tilt.x, this.sink.x, speedK, duty, motion);
  }

  // 身体、手臂（按相位）
  private body(lean: number, tilt: number, sink: number, speedK: number, duty: number, motion: number): void {
    const A = WALK_ANIM;
    const amp = this.amp * motion;
    const ph = this.phase;
    // 一步的进度：0 = 某只脚刚落地。最低点在落地后一点点（压扁），两脚交错时最高（拉长）
    const sigma = frac(2 * ph);
    const b = -Math.cos(TAU * (sigma - A.bobDelay));
    const k = 0.45 + 0.55 * speedK;
    this.bob = amp * A.bob * k * b + sink * motion;
    this.squash = amp * A.squash * k * b + (sink / Math.max(A.sink, 1e-6)) * A.squash * 0.8 * motion;
    // 重心移到着地的那只脚（左脚着地在 0..duty，中点 duty/2）
    const s = Math.sin(TAU * (ph - duty / 2 + 0.25 - A.shiftDelay));
    this.shift = amp * A.shift * s;
    this.roll = (amp * A.roll * s + tilt) * motion;
    this.pitch = lean * motion;
    // 肩膀和胯反着转：左腿在前（相位 0）时右肩在前、左胯在前
    const c = Math.cos(TAU * (ph - A.armDelay));
    this.twist = amp * A.twist * c;
    this.hipTwist = -amp * A.hipTwist * Math.cos(TAU * ph);
    // 手臂：和同侧的腿反着摆，晚一点；手再晚一点
    const swing = amp * A.armSwing * (0.5 + 0.5 * speedK);
    const armL = -c * swing;
    const handL = -Math.cos(TAU * (ph - A.armDelay - A.handDelay)) * swing;
    // 站着：手臂轻轻晃（两边不同步）；走起来淡出
    const idle = (1 - this.walk) * A.idleSway * motion;
    const t = this.time / Math.max(A.idleSeconds, 0.1);
    const swayL = Math.sin(TAU * t) * idle;
    const swayR = Math.sin(TAU * t + 2.1) * idle;
    this.arm[0] = armL + swayL - lean * 0.6 * motion;
    this.arm[1] = -armL + swayR - lean * 0.6 * motion;
    this.hand[0] = (handL - armL) * A.handFollow + swayL * 0.5;
    this.hand[1] = (-handL + armL) * A.handFollow + swayR * 0.5;
    const out = (A.armOut * speedK * this.amp + A.wadeArms * this.wade) * (0.4 + 0.6 * motion);
    this.armOut[0] = out + Math.max(0, swayL) * 0.3;
    this.armOut[1] = out + Math.max(0, swayR) * 0.3;
    this.breath = Math.sin((this.time / Math.max(A.breathSeconds, 0.1)) * TAU) * A.breath * (1 - this.walk) * (0.5 + 0.5 * motion);
  }

  // 落点：落地那一刻身体在哪（现在的位置 + 速度 × 剩下的时间，朝向按角速度转过去），站姿的位置，再往前放 reach 秒的路程；贴到地面上
  private predict(w: Walker, f: FootState, remaining: number, reach: number, speed: number): void {
    const tau = Math.min(remaining, 0.6);
    _f.copy(w.facing);
    spin(_f, w.dir, clamp(this.omega * tau, -1.2, 1.2));
    f.targetFwd.copy(_f);
    _q.crossVectors(w.dir, _f);
    const rest = this.rest[f.side === 1 ? 0 : 1];
    w.positionInto(f.target).addScaledVector(_q, rest.x).addScaledVector(_f, rest.z);
    if (speed > 1e-4) f.target.addScaledVector(w.velocity, tau + reach);
    const r = f.target.length();
    _n.copy(f.target).divideScalar(r);
    f.target.copy(_n).multiplyScalar(w.ground(_n));
  }

  // 脚的站姿在星球上的位置（面朝 facing）写进 out
  private restPoint(w: Walker, f: FootState, facing: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _q.crossVectors(w.dir, facing);
    const rest = this.rest[f.side === 1 ? 0 : 1];
    w.positionInto(out).addScaledVector(_q, rest.x).addScaledVector(facing, rest.z);
    const r = out.length();
    _n.copy(out).divideScalar(r);
    return out.copy(_n).multiplyScalar(w.ground(_n));
  }

  // 两只脚离站姿最远的那只差多少（位置 + 朝向折算）
  private maxError(w: Walker): number {
    let worst = 0;
    for (const f of this.feet) {
      if (!f.planted) continue;
      _q.crossVectors(w.dir, w.facing);
      const rest = this.rest[f.side === 1 ? 0 : 1];
      w.positionInto(_v).addScaledVector(_q, rest.x).addScaledVector(w.facing, rest.z);
      // 只比切向的距离（地面高低不算）
      _v.sub(f.anchor);
      _v.addScaledVector(w.dir, -_v.dot(w.dir));
      const e = _v.length() + WALK_ANIM.yawLever * Math.abs(signedAngle(f.anchorFwd, w.facing, w.dir));
      if (e > worst) worst = e;
    }
    return worst;
  }

  // 起步时先迈哪只：离站姿差得多的那只（往前走时就是落在后面的那只）
  private firstFoot(w: Walker): 0 | 1 {
    _q.crossVectors(w.dir, w.facing);
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      w.positionInto(_v).sub(f.anchor);
      const behind = _v.dot(w.velocity); // 越大越落在后面
      const score = behind + this.rest[i].x * Math.sign(-this.omega) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best as 0 | 1;
  }

  // 这一帧脚的位置、朝向、高度、脚尖角度
  private placeFoot(w: Walker, f: FootState, motion: number): void {
    const A = WALK_ANIM;
    if (f.planted) {
      f.pos.copy(f.anchor);
      f.fwd.copy(f.anchorFwd);
      f.lift = 0;
      f.pitch = 0;
      return;
    }
    const t = f.swing;
    const e = smoothstep(t);
    f.pos.copy(f.anchor).lerp(f.target, e);
    // 朝向：从起脚的朝向转到落点的朝向
    _n.copy(f.pos).normalize();
    f.fwd.copy(f.anchorFwd).addScaledVector(_n, -f.anchorFwd.dot(_n)).normalize();
    _v.copy(f.targetFwd).addScaledVector(_n, -f.targetFwd.dot(_n)).normalize();
    spin(f.fwd, _n, signedAngle(f.fwd, _v, _n) * e);
    // 脚尖：前半段朝下（脚跟先抬），后半段翘起（脚跟先着地）
    const pitch = -Math.sin(TAU * t) * A.footPitch * Math.min(1, f.stride / 0.25) * (0.6 + 0.4 * motion);
    const clear = pitch < 0 ? this.toe * Math.sin(-pitch) : this.heel * Math.sin(pitch);
    f.pitch = pitch;
    f.lift = Math.max(f.height * Math.sin(Math.PI * t), clear + 0.005 * Math.sin(Math.PI * t));
    f.pos.addScaledVector(_n, f.lift);
    void w;
  }
}

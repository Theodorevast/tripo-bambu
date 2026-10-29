import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { FOLLOW } from '../src/play/params';
import { blendPose, easeInOutCubic, TRANSITION_MAX_STEP, transitionAdvance } from '../src/play/sphere';

// 进入、退出漫游的镜头过渡（第二版 [v2-world]）：每帧最多推进 TRANSITION_MAX_STEP 秒，偶尔掉一帧（dt 0.1 秒）时镜头一帧也转不过 6°
// （check-walk 的「进入过渡平滑」上限）。和 walkMode.ts 走同一条路：transitionAdvance → easeInOutCubic → blendPose

const LIMIT = (6 * Math.PI) / 180;

// 从 fromQuat 过渡到 toQuat，每帧 dt：返回一帧里转得最多的角度（弧度）和走了几帧
function simulate(dt: number, toQuat: THREE.Quaternion, advance: (t: number, dt: number) => number): { maxTurn: number; frames: number } {
  const fromPos = new THREE.Vector3(10, 60, 75);
  const toPos = new THREE.Vector3(0.4, 31.5, 2.2);
  const fromQuat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const prev = fromQuat.clone();
  let t = 0;
  let maxTurn = 0;
  let frames = 0;
  while (t < FOLLOW.seconds && frames < 10000) {
    t = advance(t, dt);
    const k = easeInOutCubic(Math.min(1, t / FOLLOW.seconds));
    blendPose(fromPos, fromQuat, toPos, toQuat, k, pos, quat);
    maxTurn = Math.max(maxTurn, prev.angleTo(quat));
    prev.copy(quat);
    frames++;
  }
  return { maxTurn, frames };
}

// 进入漫游时轨道镜头和跟随镜头的朝向差约 74°（check-walk 实测 60 帧时最多 3.08°/帧 ÷ easeInOutCubic 最陡处的 3 / 1.2 秒）：取 90° 当上限
const worst = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), THREE.MathUtils.degToRad(90));

describe('进入、退出漫游的镜头过渡', () => {
  it('dt 0.1 秒（掉帧）：每帧转角不超过 6°', () => {
    const r = simulate(0.1, worst, transitionAdvance);
    expect(r.maxTurn).toBeLessThan(LIMIT);
    // 过渡照样走完（只是这几帧推进得慢一点）
    const frames = Math.round(FOLLOW.seconds / TRANSITION_MAX_STEP); // 浮点累加可能差一帧
    expect(r.frames).toBeGreaterThanOrEqual(frames);
    expect(r.frames).toBeLessThanOrEqual(frames + 1);
  });

  it('不限步长的话，同样的 0.1 秒一帧会转过 6°（这个限制是有用的）', () => {
    const r = simulate(0.1, worst, (t, dt) => t + dt);
    expect(r.maxTurn).toBeGreaterThan(LIMIT);
  });

  it('正常的 60 帧：每帧照真实的 dt 推进，不受影响', () => {
    expect(transitionAdvance(0.5, 1 / 60)).toBeCloseTo(0.5 + 1 / 60, 12);
    expect(transitionAdvance(0.5, 0.1)).toBeCloseTo(0.5 + TRANSITION_MAX_STEP, 12);
    expect(transitionAdvance(0.5, -0.01)).toBe(0.5);
    const r = simulate(1 / 60, worst, transitionAdvance);
    expect(r.maxTurn).toBeLessThan(LIMIT);
  });
});

import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { drawCoupons } from '../src/data/coupons';
import { mulberry32 } from '../src/planet/rng';
import { CouponField, type PickupTarget } from '../src/fun/couponsField';
import { BODY_R, BODY_Y, greetPose, HOME_TRIBOO, leanFor, nextPeek, peekPose, placeTriboo, stepOut } from '../src/fun/homeTribooMath';

const tanH = Math.tan(THREE.MathUtils.degToRad(40) / 2);
const halfH = HOME_TRIBOO.depth * tanH;

describe('首页右下角的翠宝：摆在哪', () => {
  it('露出多少按身体宽度算：0 刚好全藏在右边缘外，0.5 露出一半，1 整个身子进了画面', () => {
    const aspect = 1.6;
    const halfW = halfH * aspect;
    for (const [out, left, right] of [[0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1]] as const) {
      const p = placeTriboo(out, 0, aspect, 40, HOME_TRIBOO.size);
      const inside = halfW - (p.bodyX - p.bodyR); // 身体在画面里的宽度
      expect(inside / (2 * p.bodyR)).toBeCloseTo(out, 9);
      void left;
      void right;
    }
  });

  it('大小按画面高度的比例：身高 = size × 画面高；脚藏在底边下面（feet < -1）', () => {
    const p = placeTriboo(HOME_TRIBOO.hide, 0, 1.6, 40, 0.3);
    expect(p.height / (2 * halfH)).toBeCloseTo(0.3, 9);
    expect(p.bodyR).toBeCloseTo(BODY_R * p.height, 9);
    expect(p.y / halfH).toBeCloseTo(HOME_TRIBOO.feet, 9);
    expect(HOME_TRIBOO.feet).toBeLessThan(-1);
    expect(p.z).toBe(-HOME_TRIBOO.depth);
  });

  it('往画面里歪：身体中心不动（露出的多少不变），脚往右挪', () => {
    const a = placeTriboo(0.5, 0, 1.6, 40, 0.3);
    const b = placeTriboo(0.5, 20, 1.6, 40, 0.3);
    expect(b.bodyX).toBeCloseTo(a.bodyX, 9);
    expect(b.x - a.x).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(20)) * BODY_Y * a.height, 9);
    expect(b.bodyY).toBeLessThan(a.bodyY);
  });

  it('探得越出越歪；平时、探头、靠近、吐券一个比一个露得多', () => {
    expect(leanFor(HOME_TRIBOO.hide)).toBeLessThan(leanFor(HOME_TRIBOO.near));
    expect(leanFor(HOME_TRIBOO.act)).toBeCloseTo(HOME_TRIBOO.lean, 9);
    const p = HOME_TRIBOO;
    expect(p.away).toBeLessThan(0);
    expect(p.hide).toBeLessThan(p.peek);
    expect(p.peek).toBeLessThan(p.near);
    expect(p.near).toBeLessThan(p.act);
  });
});

describe('首页右下角的翠宝：动作', () => {
  it('开场打招呼：从平时的位置探出来、举手挥几下、再缩回平时的位置', () => {
    const p = HOME_TRIBOO;
    expect(greetPose(0).out).toBe(p.hide);
    expect(greetPose(p.greetHold).out).toBe(p.hide);
    const mid = greetPose(p.greetHold / 2);
    expect(mid.out).toBeCloseTo(p.greet, 9);
    expect(mid.raise).toBeCloseTo(1, 6);
    let maxOut = 0;
    const waves = new Set<number>();
    for (let t = 0; t < p.greetHold; t += 1 / 60) {
      const g = greetPose(t);
      maxOut = Math.max(maxOut, g.out);
      if (g.raise > 0.9) waves.add(Math.sign(g.wave));
    }
    expect(maxOut).toBeGreaterThanOrEqual(p.greet); // 探出来时轻轻冲过头
    expect(waves.has(1) && waves.has(-1)).toBe(true); // 左右挥
  });

  it('偶尔探头：探出去、左右看一眼、缩回来；下一次在 peekMin..peekMax 秒以后', () => {
    const p = HOME_TRIBOO;
    expect(peekPose(0).out).toBe(p.hide);
    expect(peekPose(p.peekHold).out).toBe(p.hide);
    expect(peekPose(p.peekHold / 2).out).toBeCloseTo(p.peek, 6);
    const looks = Array.from({ length: 90 }, (_, i) => peekPose((i / 90) * p.peekHold).look);
    expect(Math.max(...looks)).toBeGreaterThan(0.5);
    expect(Math.min(...looks)).toBeLessThan(-0.5);
    expect(nextPeek(0)).toBe(p.peekMin);
    expect(nextPeek(1)).toBe(p.peekMax);
  });

  it('露出多少的弹簧：到得了目标，冲过头不多；卡了一大帧也不会弹飞', () => {
    const s: [number, number] = [HOME_TRIBOO.away, 0];
    let peak = -Infinity;
    for (let i = 0; i < 120; i++) peak = Math.max(peak, stepOut(s, HOME_TRIBOO.near, 1 / 60));
    expect(s[0]).toBeCloseTo(HOME_TRIBOO.near, 3);
    expect(peak - HOME_TRIBOO.near).toBeLessThan(0.15);
    const t: [number, number] = [0, 0];
    stepOut(t, 1, 0.5);
    expect(Math.abs(t[0])).toBeLessThan(2);
  });
});

describe('首页吐的券：不落地，直接飞到镜头前交给领券窗口', () => {
  it('从嘴里飞出去，离镜头越来越近，按给的时长飞到目标点（星系视图里没有地面也照飞）', () => {
    const field = new CouponField({ width: 512, height: 1536 } as unknown as HTMLCanvasElement, mulberry32(3));
    const camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 6000);
    camera.position.set(0, 50, 300);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const arrived: number[] = [];
    field.onArrive = (id) => arrived.push(id);
    const target = (out: PickupTarget) => {
      out.pos.set(0, 0.1, -1.4).applyMatrix4(camera.matrixWorld);
      out.quat.copy(camera.quaternion);
      out.size = 0.4;
    };
    const pt: PickupTarget = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0 };
    const mouth = new THREE.Vector3(6, -3, -14).applyMatrix4(camera.matrixWorld);
    const hop = new THREE.Vector3(-0.5, 1, 0).applyQuaternion(camera.quaternion);
    const [ticket] = drawCoupons(mulberry32(5), 1);
    const id = field.launchTo(ticket, mouth, camera.quaternion, 0.8, hop, camera.position, 0.6);
    expect(field.snapshot()[0].phase).toBe('pickup');
    const dists: number[] = [];
    let t = 0;
    while (arrived.length === 0 && t < 2) {
      field.update(1 / 60, camera, null, 1, target, pt);
      t += 1 / 60;
      const c = field.snapshot().find((x) => x.id === id);
      if (c?.phase === 'pickup') dists.push(new THREE.Vector3(...c.pos).distanceTo(camera.position));
    }
    expect(arrived).toEqual([id]);
    expect(t).toBeGreaterThan(0.58);
    expect(t).toBeLessThan(0.64);
    expect(dists.every((d, i) => i === 0 || d <= dists[i - 1] + 1e-6)).toBe(true);
    // 卡片接手以后很快收回池子
    for (let i = 0; i < 20; i++) field.update(1 / 60, camera, null, 1, target, pt);
    expect(field.snapshot()).toHaveLength(0);
  });
});

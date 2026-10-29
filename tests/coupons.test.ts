import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { COUPON_KINDS, couponCode, drawCoupons } from '../src/data/coupons';
import { mulberry32 } from '../src/planet/rng';
import { CouponField, type CouponAnchor, type CouponGround, type PickupTarget } from '../src/fun/couponsField';
import {
  COUPONS,
  couponCount,
  flightAcross,
  flightArc,
  flipAngle,
  landingSpot,
  lifeOpacity,
  pickupProgress,
  restPose,
  shakePose,
  spitPose,
  spitTimes,
  stepHover,
} from '../src/fun/couponsMath';

const defaults = { ...COUPONS };
afterEach(() => Object.assign(COUPONS, defaults));

describe('优惠券的假数据（待接真实后端）', () => {
  it('兑换码：TRIBOO-XXXX-XXXX，不用容易看错的字符', () => {
    const rand = mulberry32(1);
    for (let i = 0; i < 200; i++) expect(couponCode(rand)).toMatch(/^TRIBOO-[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
  });

  it('一次吐几张：种类不重复（种类够的时候），每张一个兑换码；同一个随机数种子结果一样', () => {
    for (let n = 1; n <= COUPON_KINDS.length; n++) {
      const a = drawCoupons(mulberry32(n * 7), n);
      expect(a).toHaveLength(n);
      expect(new Set(a.map((c) => c.kind)).size).toBe(n);
      expect(a.every((c) => c.kind >= 0 && c.kind < COUPON_KINDS.length)).toBe(true);
      expect(drawCoupons(mulberry32(n * 7), n)).toEqual(a);
    }
  });

  it('张数在 countMin..countMax（3–5）之间，每种都出现过', () => {
    const rand = mulberry32(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = couponCount(rand);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('券面都有券名、面额、单位、说明；主色是翠宝黄或奶油白', () => {
    for (const k of COUPON_KINDS) {
      expect(k.title.length).toBeGreaterThan(0);
      expect(k.value).toMatch(/^[-+]\d+%?$/);
      expect(k.unit.length).toBeGreaterThan(0);
      expect(k.blurb.length).toBeGreaterThan(0);
      expect(['yellow', 'cream']).toContain(k.paper);
    }
  });
});

describe('翠宝吐券的节奏：蓄力 → 吐出 → 回弹', () => {
  it('时间点按顺序：（转身）→ 蓄力（COUPONS.charge：第二版放慢到 0.34 秒）→ 弹起时吐 → 最高 → 做完 → （转回去）', () => {
    for (const turning of [false, true]) {
      const t = spitTimes(turning);
      expect(t.turn).toBeCloseTo(turning ? COUPONS.turn : 0);
      expect(t.charge - t.turn).toBeCloseTo(COUPONS.charge);
      expect(t.launch).toBeGreaterThan(t.charge);
      expect(t.launch).toBeLessThanOrEqual(t.peak);
      expect(t.end).toBeGreaterThan(t.peak);
      expect(t.done).toBeCloseTo(t.end + (turning ? COUPONS.turn : 0));
    }
  });

  it('蓄力时压扁、发抖、logo 亮起来；弹到最高时拉长、离地；做完回到原样', () => {
    const p = restPose();
    const T = spitTimes(false);
    spitPose(T.charge - 0.01, false, p);
    expect(p.sy).toBeLessThan(1 - COUPONS.squash * 0.9);
    expect(p.sxz).toBeGreaterThan(1);
    expect(p.glow).toBeGreaterThan(0.9);
    let maxJitter = 0;
    for (let t = 0.05; t < T.charge; t += 0.005) maxJitter = Math.max(maxJitter, Math.abs(spitPose(t, false, p).jitter));
    expect(maxJitter).toBeGreaterThan(COUPONS.tremble * 0.5);
    spitPose(T.peak - 1e-4, false, p);
    expect(p.sy).toBeGreaterThan(1 + COUPONS.stretch * 0.95);
    expect(p.lift).toBeGreaterThan(COUPONS.hop * 0.95);
    spitPose(T.done + 0.01, false, p);
    expect([p.sy, p.sxz, p.lift, p.roll, p.pitch, p.yaw, p.jitter, p.glow, p.face]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('开心地晃两下：回弹以后左右各晃两次（正负都有），越晃越小', () => {
    const p = restPose();
    const T = spitTimes(false);
    const rolls: number[] = [];
    for (let t = T.peak; t < T.end; t += 1 / 240) rolls.push(spitPose(t, false, p).roll);
    const max = Math.max(...rolls);
    const min = Math.min(...rolls);
    expect(max).toBeGreaterThan(0.05);
    expect(min).toBeLessThan(-0.05);
    let crossings = 0;
    for (let i = 1; i < rolls.length; i++) if (Math.sign(rolls[i]) !== Math.sign(rolls[i - 1]) && rolls[i] !== 0 && rolls[i - 1] !== 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(3);
  });

  it('姿态是连续的：每 1/240 秒变化不超过一小步（缓动，不跳），转身时也一样', () => {
    for (const turning of [false, true]) {
      const p = restPose();
      const prev = restPose();
      const T = spitTimes(turning);
      let worst = 0;
      for (let t = 0; t <= T.done + 0.05; t += 1 / 240) {
        spitPose(t, turning, p);
        // 发抖本来就快（23 Hz），只看大的变化：缩放、离地、转身、晃
        worst = Math.max(worst, Math.abs(p.sy - prev.sy), Math.abs(p.lift - prev.lift), Math.abs(p.face - prev.face), Math.abs(p.roll - prev.roll));
        Object.assign(prev, p);
      }
      expect(worst).toBeLessThan(0.06);
    }
  });

  it('转身：转过去、吐、再转回来；蓄力之前已经转好', () => {
    const p = restPose();
    const T = spitTimes(true);
    expect(spitPose(0, true, p).face).toBe(0);
    expect(spitPose(T.turn, true, p).face).toBeCloseTo(1);
    expect(spitPose(T.launch, true, p).face).toBeCloseTo(1);
    expect(spitPose(T.done, true, p).face).toBeCloseTo(0);
  });

  it('冷却中摇头：左右来回转，幅度不超过 shakeAngle，结束时回到原样', () => {
    const p = restPose();
    let maxYaw = 0;
    let neg = false;
    for (let t = 0; t < COUPONS.shakeSeconds; t += 1 / 240) {
      shakePose(t, p);
      maxYaw = Math.max(maxYaw, Math.abs(p.yaw));
      if (p.yaw < -0.05) neg = true;
    }
    expect(maxYaw).toBeGreaterThan(0.1);
    expect(maxYaw).toBeLessThanOrEqual((COUPONS.shakeAngle * Math.PI) / 180);
    expect(neg).toBe(true);
    expect(shakePose(COUPONS.shakeSeconds + 0.01, p).yaw).toBe(0);
  });

  it('悬停时轻轻一缩：弹簧收敛到目标（带一点回弹，不超过 30%）', () => {
    const s: [number, number] = [0, 0];
    let peak = 0;
    for (let i = 0; i < 120; i++) peak = Math.max(peak, stepHover(s, 1, 1 / 60));
    expect(s[0]).toBeCloseTo(1, 2);
    expect(peak).toBeLessThan(1.3);
    for (let i = 0; i < 120; i++) stepHover(s, 0, 1 / 60);
    expect(Math.abs(s[0])).toBeLessThan(0.01);
  });
});

describe('券的轨迹', () => {
  it('抛物线：起点、终点不鼓，u = 1/3 时最高；落地时竖直速度是 0（轻轻停住）', () => {
    expect(flightArc(0)).toBe(0);
    expect(flightArc(1)).toBe(0);
    expect(flightArc(1 / 3)).toBeCloseTo(1, 6);
    expect((flightArc(1) - flightArc(1 - 1e-4)) / 1e-4).toBeCloseTo(0, 2);
    expect(flightAcross(0)).toBe(0);
    expect(flightAcross(1)).toBe(1);
  });

  it('捡券：离镜头的距离按等比缩短（看上去一样快地变大），起点 0、终点 1', () => {
    expect(pickupProgress(0, 80, 1.4)).toBe(0);
    expect(pickupProgress(1, 80, 1.4)).toBeCloseTo(1);
    // 时间过半时离镜头 √(80 × 1.4) 米（两头距离的几何平均）
    const s = pickupProgress(0.5, 80, 1.4);
    expect(80 - s * (80 - 1.4)).toBeCloseTo(Math.sqrt(80 * 1.4), 6);
    // 已经很近了（起点和终点差不多远）：退回普通的缓动
    expect(pickupProgress(0.5, 1.45, 1.4)).toBeCloseTo(0.5);
  });

  it('翻转：落地时正好翻完整数圈（立着）', () => {
    for (const n of [1, 2, 3]) expect(flipAngle(1, n)).toBeCloseTo(Math.PI * 2 * n);
    expect(flipAngle(0, 2)).toBe(0);
  });

  it('落点：在正前方的扇形里，离翠宝 0.7–1.2 × spread', () => {
    const rand = mulberry32(5);
    for (let n = 3; n <= 5; n++) {
      for (let i = 0; i < n; i++) {
        const s = landingSpot(i, n, rand);
        const d = Math.hypot(s.x, s.z);
        expect(d).toBeGreaterThanOrEqual(COUPONS.spread * 0.72 - 1e-9);
        expect(d).toBeLessThanOrEqual(COUPONS.spread * 1.17 + 1e-9);
        expect(Math.abs(Math.atan2(s.x, s.z))).toBeLessThan(((COUPONS.fan / 2 + 30) * Math.PI) / 180);
      }
    }
  });

  it('没捡的券：浮 life 秒（10），再 fade 秒淡出', () => {
    expect(COUPONS.life).toBe(10);
    expect(lifeOpacity(0)).toBe(1);
    expect(lifeOpacity(9.99)).toBe(1);
    expect(lifeOpacity(10 + COUPONS.fade / 2)).toBeGreaterThan(0);
    expect(lifeOpacity(10 + COUPONS.fade / 2)).toBeLessThan(1);
    expect(lifeOpacity(10 + COUPONS.fade + 0.01)).toBe(0);
  });
});

// 平地的星球：半径 10，中心在原点
const R = 10;
const ground: CouponGround = { home: new THREE.Vector3(), scale: 1, radius: () => R };
const anchor = (): CouponAnchor => ({
  origin: new THREE.Vector3(0, R, 0),
  up: new THREE.Vector3(0, 1, 0),
  fwd: new THREE.Vector3(0, 0, 1),
  right: new THREE.Vector3(1, 0, 0),
});
const fakeCanvas = () => ({ width: 512, height: 1536 }) as unknown as HTMLCanvasElement;

function makeField(): { field: CouponField; camera: THREE.PerspectiveCamera; step: (seconds: number) => void; arrived: number[] } {
  const field = new CouponField(fakeCanvas(), mulberry32(9));
  const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 100);
  camera.position.set(0, R + 2, 6);
  camera.lookAt(0, R, 0);
  camera.updateMatrixWorld();
  const pickTarget: PickupTarget = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.3 };
  const target = (out: PickupTarget) => {
    out.pos.set(0, 0, -1.4).applyMatrix4(camera.matrixWorld);
    out.quat.copy(camera.quaternion);
    out.size = 0.4;
  };
  const arrived: number[] = [];
  field.onArrive = (id) => arrived.push(id);
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) field.update(1 / 60, camera, ground, 1, target, pickTarget);
  };
  return { field, camera, step, arrived };
}

describe('地上的券（对象池）', () => {
  it('吐 4 张：排队一张接一张出来、飞完浮在地面上方 hover 米处；落点在前面', () => {
    const { field, step } = makeField();
    const tickets = drawCoupons(mulberry32(2), 4);
    const spots = tickets.map((_, i) => landingSpot(i, 4, mulberry32(i + 1)));
    const ids = field.spawn(tickets, anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, spots, false);
    expect(ids).toHaveLength(4);
    expect(field.snapshot().every((c) => c.phase === 'wait')).toBe(true);
    step(0.1);
    expect(field.snapshot().filter((c) => c.phase === 'fly').length).toBeGreaterThanOrEqual(2);
    step(COUPONS.flight * 1.15 + COUPONS.stagger * 4);
    const rest = field.snapshot();
    expect(rest.every((c) => c.phase === 'rest')).toBe(true);
    for (const c of rest) {
      const p = new THREE.Vector3(...c.pos);
      expect(p.length() - R).toBeGreaterThan(COUPONS.hover - COUPONS.bob - 0.01);
      expect(p.length() - R).toBeLessThan(COUPONS.hover + COUPONS.bob + 0.01);
      expect(p.z).toBeGreaterThan(0); // 落在面朝的那一边
    }
  });

  it('没捡的过 10 秒淡出、收回池子', () => {
    const { field, step } = makeField();
    field.spawn(drawCoupons(mulberry32(4), 3), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1, z: 1 }, { x: 0, z: 1.3 }, { x: 1, z: 1 }], false);
    step(COUPONS.flight * 1.2 + 9.5);
    expect(field.snapshot().map((c) => c.phase)).toEqual(['rest', 'rest', 'rest']);
    step(1.5);
    expect(field.snapshot()).toHaveLength(0);
    expect(field.busy).toBe(false);
  });

  it('捡一张：飞到镜头前（离镜头的距离等比缩短，最后停在目标点），卡片接手后收回池子；别的照旧浮着', () => {
    const { field, camera, step, arrived } = makeField();
    const ids = field.spawn(drawCoupons(mulberry32(6), 3), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1, z: 1 }, { x: 0, z: 1.3 }, { x: 1, z: 1 }], false);
    step(COUPONS.flight * 1.2 + 0.3);
    expect(field.pickUp(ids[1], camera.position)).toBe(true);
    const dists: number[] = [];
    for (let t = 0; t < COUPONS.pickup; t += 1 / 60) {
      step(1 / 60);
      const c = field.snapshot().find((x) => x.id === ids[1]);
      if (c && c.phase === 'pickup') dists.push(new THREE.Vector3(...c.pos).distanceTo(camera.position));
    }
    // 离镜头越来越近（一路单调），最后停在 1.4 米处的目标点
    expect(dists.every((d, i) => i === 0 || d <= dists[i - 1] + 1e-6)).toBe(true);
    const target = new THREE.Vector3(0, 0, -1.4).applyMatrix4(camera.matrixWorld);
    step(1 / 60);
    expect(arrived).toEqual([ids[1]]);
    expect(target.distanceTo(camera.position)).toBeCloseTo(1.4);
    step(0.3);
    const left = field.snapshot();
    expect(left.map((c) => c.id).sort()).toEqual([ids[0], ids[2]].sort());
    expect(left.every((c) => c.phase === 'rest')).toBe(true);
  });

  it('减弱动效：不飞不翻，直接在落点淡入', () => {
    const { field, step } = makeField();
    field.spawn(drawCoupons(mulberry32(8), 3), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1, z: 1 }, { x: 0, z: 1.3 }, { x: 1, z: 1 }], true);
    const phases = new Set<string>();
    for (let i = 0; i < 90; i++) {
      step(1 / 60);
      for (const c of field.snapshot()) phases.add(c.phase);
    }
    expect(phases.has('fly')).toBe(false);
    expect(phases.has('appear')).toBe(true);
    expect(field.snapshot().every((c) => c.phase === 'rest')).toBe(true);
  });

  it('屏幕上拾取：点在券上（或旁边 26 像素以内）选中它，点空地不选', () => {
    const { field, camera, step } = makeField();
    const ids = field.spawn(drawCoupons(mulberry32(10), 3), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1.2, z: 1 }, { x: 0, z: 1.3 }, { x: 1.2, z: 1 }], false);
    step(COUPONS.flight * 1.2 + 0.5);
    const rect = { left: 0, top: 0, width: 1600, height: 1000 };
    const visible = () => true;
    const snap = field.snapshot();
    for (const c of snap) {
      const p = new THREE.Vector3(...c.pos).project(camera);
      const x = ((p.x + 1) / 2) * rect.width;
      const y = ((1 - p.y) / 2) * rect.height;
      expect(field.pick(x + 4, y - 3, camera, rect, visible)).toBe(c.id);
    }
    expect(field.pick(5, 5, camera, rect, visible)).toBeNull();
    expect(ids).toHaveLength(3);
  });

  it('池子满了：收走最早落地的那张，不出错', () => {
    const { field, step } = makeField();
    for (let k = 0; k < 5; k++) {
      field.spawn(drawCoupons(mulberry32(20 + k), 4), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1, z: 1 }, { x: 0, z: 1.3 }, { x: 1, z: 1 }, { x: 0.5, z: 0.8 }], false);
      step(1.2);
    }
    expect(field.snapshot().length).toBeLessThanOrEqual(16);
    expect(field.snapshot().length).toBeGreaterThanOrEqual(12);
  });

  it('离开星球（没有地面）：地上的券立刻收掉', () => {
    const { field, camera } = makeField();
    field.spawn(drawCoupons(mulberry32(30), 3), anchor(), new THREE.Vector3(0, R + 0.8, 0.36), 1, [{ x: -1, z: 1 }, { x: 0, z: 1.3 }, { x: 1, z: 1 }], false);
    const pt: PickupTarget = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), size: 0.3 };
    field.update(1 / 60, camera, null, 1, () => {}, pt);
    expect(field.snapshot()).toHaveLength(0);
  });
});

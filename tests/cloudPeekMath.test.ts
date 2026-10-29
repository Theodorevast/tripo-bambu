import { describe, expect, it } from 'vitest';
import { besideSpot, boxGap, clearance, discGap, footprint, GuideMemo, pointAt, type Box } from '../src/fun/cloudPeekMath';

const box = (): Box => ({ left: 0, top: 0, right: 0, bottom: 0 });

describe('云里的翠宝：露出来那一块在画面上', () => {
  it('左右对称；大半在冒出来那一点上面，小云在下面一截', () => {
    const r = footprint(500, 400, 100, 0.31, 0.7, box());
    expect(r.right - 500).toBeCloseTo(500 - r.left, 6);
    expect(400 - r.top).toBeGreaterThan(r.bottom - 400);
    expect(r.bottom).toBeGreaterThan(400);
  });

  it('镜头越往下看（俯视角越大），球心压得越扁、前面的小云露得越多', () => {
    const low = footprint(0, 0, 100, 0.31, 0.4, box());
    const high = footprint(0, 0, 100, 0.31, 0.95, box());
    expect(-high.top).toBeLessThan(-low.top);
    expect(high.bottom).toBeGreaterThan(low.bottom);
  });

  it('离星球、名牌多远：压到了是 -1，近于 margin 也是 -1', () => {
    const r: Box = { left: 100, top: 100, right: 200, bottom: 200 };
    expect(discGap(r, { x: 150, y: 150, r: 10 })).toBeLessThan(0);
    expect(discGap(r, { x: 250, y: 150, r: 20 })).toBeCloseTo(30, 6);
    expect(boxGap(r, { left: 150, top: 150, right: 260, bottom: 260 })).toBe(-1);
    expect(boxGap(r, { left: 230, top: 100, right: 260, bottom: 120 })).toBeCloseTo(30, 6);
    expect(clearance(r, [{ x: 250, y: 150, r: 20 }], [], 10)).toBeCloseTo(30, 6);
    expect(clearance(r, [{ x: 250, y: 150, r: 20 }], [], 40)).toBe(-1);
    expect(clearance(r, [], [{ left: 150, top: 150, right: 260, bottom: 260 }], 0)).toBe(-1);
  });
});

describe('悬停带路：站在星球旁边', () => {
  const view = { w: 1440, h: 900 };
  const probe = () => 0.7;
  const planet = { x: 720, y: 420, r: 60 };
  const tag: Box = { left: 640, top: 490, right: 800, bottom: 520 }; // 名牌在星球正下方

  it('不压着这颗星球和它的名牌，站在左右两边（不往名牌那边站），离星球不远', () => {
    const full = 100;
    const spot = besideSpot(planet, full, 0.31, [planet], [tag], view, probe, 10)!;
    expect(spot).not.toBeNull();
    const r = footprint(spot.x, spot.y, full, 0.31, 0.7, box());
    expect(discGap(r, planet)).toBeGreaterThanOrEqual(10);
    expect(boxGap(r, tag)).toBeGreaterThanOrEqual(10);
    expect(discGap(r, planet)).toBeLessThan(full);
    const cy = (r.top + r.bottom) / 2;
    expect(cy).toBeLessThan(planet.y + planet.r); // 不在名牌那一截
    expect(Math.abs(spot.x - planet.x)).toBeGreaterThan(planet.r); // 在左边或右边
  });

  it('星球靠着画面右边：站到左边去；两边都被别的星球占着：往上面找，找不到就是 null', () => {
    const edge = { x: 1440 - 70, y: 420, r: 60 };
    const spot = besideSpot(edge, 100, 0.31, [edge], [], view, probe, 10)!;
    expect(spot.x).toBeLessThan(edge.x);
    const crowd = [planet, { x: 560, y: 420, r: 90 }, { x: 880, y: 420, r: 90 }, { x: 720, y: 280, r: 90 }, { x: 560, y: 260, r: 90 }, { x: 880, y: 260, r: 90 }, { x: 560, y: 580, r: 90 }, { x: 880, y: 580, r: 90 }, { x: 720, y: 600, r: 90 }];
    expect(besideSpot(planet, 100, 0.31, crowd, [tag], view, probe, 10)).toBeNull();
  });

  it('画面上打不到云面的地方不站', () => {
    expect(besideSpot(planet, 100, 0.31, [planet], [tag], view, () => null, 10)).toBeNull();
  });
});

describe('悬停带路：举手指着星球', () => {
  it('星球在右上方：用画面右边那只手，举过平举；身子往右转一点', () => {
    const p = pointAt(500, 500, 700, 350);
    expect(p.side).toBe(1);
    expect(p.up).toBeGreaterThan(Math.PI / 2);
    expect(p.turn).toBeGreaterThan(0);
  });

  it('星球在左边、差不多一样高：用左边那只手平举；手举多高有上下限', () => {
    const p = pointAt(500, 500, 300, 505);
    expect(p.side).toBe(-1);
    expect(p.up).toBeCloseTo(Math.PI / 2, 1);
    expect(p.turn).toBeLessThan(0);
    expect(pointAt(500, 500, 501, 0).up).toBeLessThanOrEqual(2.85);
    expect(pointAt(500, 500, 900, 900).up).toBeGreaterThanOrEqual(1.15);
  });
});

describe('悬停带路：带不带', () => {
  it('前 3 次一定带（同一颗也带）；之后同一颗星球 30 秒内不再带，别的星球照样带', () => {
    const m = new GuideMemo();
    const p = { free: 3, again: 30 };
    for (let i = 0; i < 3; i++) {
      expect(m.wants('a', i, p)).toBe(true);
      m.note('a', i);
    }
    expect(m.wants('a', 10, p)).toBe(false);
    expect(m.wants('b', 10, p)).toBe(true);
    expect(m.wants('a', 2 + 30, p)).toBe(true);
    expect(m.count).toBe(3);
  });
});

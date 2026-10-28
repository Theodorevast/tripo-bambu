import { describe, expect, it } from 'vitest';
import { galaxyPositions, galaxyScale } from '../src/scenes/layout';
import { LAYOUT_RADIUS, PLANET_RADIUS } from '../src/planet/presets';

describe('galaxyPositions', () => {
  it('结果确定；16 颗星球两两间距不小于 5 个星球半径（半径 10 时 50：带光环的星球外径 21.5，不会重叠）', () => {
    const a = galaxyPositions(16);
    expect(galaxyPositions(16)).toEqual(a);
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        expect(Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1], a[i][2] - a[j][2])).toBeGreaterThanOrEqual(5 * PLANET_RADIUS);
      }
    }
  });
  it('整个星系在水平半径 16.2 个星球半径以内（半径 10 时 162），星系镜头能看全', () => {
    for (const [x, , z] of galaxyPositions(16)) expect(Math.hypot(x, z)).toBeLessThan(16.2 * PLANET_RADIUS);
  });
  it('星系按星球半径整体放大：半径 60 的布局正好是半径 10 的 6 倍', () => {
    const small = galaxyPositions(8, LAYOUT_RADIUS);
    const big = galaxyPositions(8, 60);
    expect(galaxyScale(60)).toBe(6);
    big.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(small[i][k] * 6, 9)));
  });
});

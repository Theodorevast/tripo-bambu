import { describe, expect, it } from 'vitest';
import { galaxyPositions } from '../src/scenes/layout';

describe('galaxyPositions', () => {
  it('结果确定；16 颗星球两两间距不小于 50（带光环的星球外径 21.5，不会重叠）', () => {
    const a = galaxyPositions(16);
    expect(galaxyPositions(16)).toEqual(a);
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        expect(Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1], a[i][2] - a[j][2])).toBeGreaterThanOrEqual(50);
      }
    }
  });
  it('整个星系在水平半径 160 以内，星系镜头能看全', () => {
    for (const [x, , z] of galaxyPositions(16)) expect(Math.hypot(x, z)).toBeLessThan(160);
  });
});

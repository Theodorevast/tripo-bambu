import { describe, expect, it } from 'vitest';
import { galaxyNeedsRebuild, KEEP_TURN, KEEP_TURN_STRETCHED, keepGalaxy, type GalaxyBuild } from '../src/scenes/galaxyExtent';

// 首页星尘什么时候重撒（v2-ui）：外沿扩大超过 extra·R/2、缩小超过 extra·R/4 才重撒；版式转得少（< KEEP_TURN）跟着转、不重撒
const R = 30;
const extra = 1.6; // homeGalaxy.ts 的 HOME_DUST.extra

describe('galaxyNeedsRebuild', () => {
  it('还没撒过：要撒', () => {
    expect(galaxyNeedsRebuild(-1, 300, R, extra)).toBe(true);
  });

  it('外沿没变、小于阈值地变大或变小：不重撒（造星以后多一颗，Launch 那一帧不重算、不重传）', () => {
    expect(galaxyNeedsRebuild(300, 300, R, extra)).toBe(false);
    expect(galaxyNeedsRebuild(300, 300 + (extra * R) / 2 - 0.1, R, extra)).toBe(false);
    expect(galaxyNeedsRebuild(300, 300 - (extra * R) / 4 + 0.1, R, extra)).toBe(false);
  });

  it('变大超过 extra·R/2：重撒（新星球快出了星尘的范围）', () => {
    expect(galaxyNeedsRebuild(300, 300 + (extra * R) / 2 + 0.1, R, extra)).toBe(true);
  });

  it('变小超过 extra·R/4：重撒（缩小的阈值更紧，臂不会伸出去一大截空着的）', () => {
    expect(galaxyNeedsRebuild(300, 300 - (extra * R) / 4 - 0.1, R, extra)).toBe(true);
  });
});

describe('keepGalaxy', () => {
  const built: GalaxyBuild = { maxR: 300, stretch: 1, rotation: 0.4, params: 'p' };
  it('外沿只变了一点点，版式转了（造星时实测 6°）：沿用（整片跟着转）', () => {
    expect(keepGalaxy(built, { ...built, maxR: 310, rotation: 0.4 - (6.4 * Math.PI) / 180 }, R, extra)).toBe(true);
    expect(keepGalaxy(built, { ...built, maxR: 310, rotation: 0.4 + KEEP_TURN * 0.9 }, R, extra)).toBe(true);
  });
  it('手机竖屏（拉长过）只容许转一点点', () => {
    const tall: GalaxyBuild = { ...built, stretch: 1.4 };
    expect(keepGalaxy(tall, { ...tall, rotation: 0.4 + KEEP_TURN_STRETCHED * 0.9 }, R, extra)).toBe(true);
    expect(keepGalaxy(tall, { ...tall, rotation: 0.4 - (6.4 * Math.PI) / 180 }, R, extra)).toBe(false);
  });
  it('还没撒过、横竖屏变了、参数变了、转得多、外沿变得多：重撒', () => {
    expect(keepGalaxy(null, built, R, extra)).toBe(false);
    expect(keepGalaxy(built, { ...built, stretch: 1.4 }, R, extra)).toBe(false);
    expect(keepGalaxy(built, { ...built, params: 'q' }, R, extra)).toBe(false);
    expect(keepGalaxy(built, { ...built, rotation: 0.4 - KEEP_TURN * 1.1 }, R, extra)).toBe(false);
    expect(keepGalaxy(built, { ...built, maxR: 300 + extra * R }, R, extra)).toBe(false);
  });
});

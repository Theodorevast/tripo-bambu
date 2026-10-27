import { describe, expect, it } from 'vitest';
import { placeBeside, type ScreenRect } from '../src/ui/editPanel';

// 1440×900 的编辑模式：顶栏底边约 91、作品栏顶边约 715、外观面板右边 224，各留 8px
const area: ScreenRect = { left: 232, top: 99, right: 1432, bottom: 707 };
const bar = { width: 260, height: 193 };

const rectOf = (p: { x: number; y: number }): ScreenRect => ({ left: p.x, top: p.y, right: p.x + bar.width, bottom: p.y + bar.height });
const overlaps = (a: ScreenRect, b: ScreenRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (r: ScreenRect, a: ScreenRect) => r.left >= a.left && r.right <= a.right && r.top >= a.top && r.bottom <= a.bottom;

describe('placeBeside', () => {
  it('右边放得下就放右边，竖直方向和作品居中', () => {
    const work = { left: 300, top: 300, right: 420, bottom: 460 };
    const p = placeBeside(work, bar, area);
    expect(p.x).toBe(420 + 16);
    expect(p.y).toBeCloseTo(380 - 193 / 2, 9);
    expect(overlaps(rectOf(p), work)).toBe(false);
  });

  it('右边放不下就放左边', () => {
    const work = { left: 1200, top: 400, right: 1300, bottom: 520 };
    const p = placeBeside(work, bar, area);
    expect(p.x).toBe(1200 - 16 - 260);
    expect(overlaps(rectOf(p), work)).toBe(false);
    expect(inside(rectOf(p), area)).toBe(true);
  });

  it('作品贴着顶栏时编辑条夹到顶栏下面，贴着作品栏时夹到作品栏上面', () => {
    expect(placeBeside({ left: 600, top: 40, right: 700, bottom: 120 }, bar, area).y).toBe(area.top);
    expect(placeBeside({ left: 600, top: 640, right: 700, bottom: 760 }, bar, area).y).toBe(area.bottom - bar.height);
  });

  it('作品比两边的空间都宽：放空得多的一边，整条仍在区域里', () => {
    const p = placeBeside({ left: 300, top: 300, right: 1300, bottom: 400 }, bar, area);
    expect(inside(rectOf(p), area)).toBe(true);
    expect(p.x).toBe(area.right - bar.width); // 右边空 132、左边空 68：靠右
  });

  it('区域比编辑条还小时贴着区域左上边', () => {
    const tiny: ScreenRect = { left: 8, top: 99, right: 200, bottom: 150 };
    const p = placeBeside({ left: 50, top: 100, right: 80, bottom: 140 }, bar, tiny);
    expect(p).toEqual({ x: 8, y: 99 });
  });

  it('不管作品在哪，编辑条都在区域里、不压住作品（区域放得下时）', () => {
    for (let x = 240; x < 1420; x += 37) {
      for (let y = 0; y < 900; y += 41) {
        const work = { left: x, top: y, right: x + 60, bottom: y + 120 };
        const r = rectOf(placeBeside(work, bar, area));
        expect(inside(r, area)).toBe(true);
        const visible = { left: work.left, right: work.right, top: Math.max(work.top, area.top), bottom: Math.min(work.bottom, area.bottom) };
        if (visible.top < visible.bottom) expect(overlaps(r, visible)).toBe(false);
      }
    }
  });
});

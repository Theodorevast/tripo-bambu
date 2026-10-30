import { describe, expect, it } from 'vitest';
import { approach, cursorMode, smoothDamp, spring } from '../src/ui/cursorMath';

describe('cursorMode', () => {
  it('看光标计算值最后的关键字', () => {
    expect(cursorMode('image-set(url("http://x/v1-pointer.png") 1dppx, url("http://x/v1-pointer@2x.png") 2dppx) 4 3, pointer')).toBe('pointer');
    expect(cursorMode('image-set(url("a.png") 1dppx) 16 16, grabbing')).toBe('grabbing');
    expect(cursorMode('image-set(url("a.png") 1dppx) 16 16, grab')).toBe('grab');
    expect(cursorMode('pointer')).toBe('pointer');
    expect(cursorMode('text')).toBe('text');
    expect(cursorMode('url("a.png") 4 3, text')).toBe('text');
    expect(cursorMode('image-set(url("a.png") 1dppx) 4 3, default')).toBe('default');
    expect(cursorMode('auto')).toBe('default');
    // 文件名里带 text、pointer 不算
    expect(cursorMode('url("text.png") 1 1, auto')).toBe('default');
  });
});

describe('smoothDamp', () => {
  it('追上目标、不过冲；帧率不同结果接近', () => {
    const run = (dt: number) => {
      const s = new Float64Array(2);
      let max = 0;
      for (let t = 0; t < 0.6; t += dt) {
        smoothDamp(s, 0, 100, 0.07, dt);
        max = Math.max(max, s[0]);
      }
      return { x: s[0], v: s[1], max };
    };
    const a = run(1 / 60);
    const b = run(1 / 144);
    expect(a.x).toBeCloseTo(100, 1);
    expect(a.max).toBeLessThanOrEqual(100.0001);
    expect(b.max).toBeLessThanOrEqual(100.0001);
    expect(Math.abs(a.v)).toBeLessThan(1);
    // 0.1 秒时两种帧率走过的距离差不多
    const at = (dt: number) => {
      const s = new Float64Array(2);
      for (let t = 0; t < 0.1 - 1e-9; t += dt) smoothDamp(s, 0, 100, 0.07, dt);
      return s[0];
    };
    expect(Math.abs(at(1 / 60) - at(1 / 120))).toBeLessThan(3);
  });
});

describe('spring', () => {
  it('阻尼比 < 1 弹一下，= 1 不弹；卡一帧（dt 大）也不发散', () => {
    const peak = (zeta: number, dt: number) => {
      const s = new Float64Array([0.62, 0]);
      let max = 0;
      for (let t = 0; t < 1; t += dt) {
        spring(s, 0, 1, 30, zeta, dt);
        max = Math.max(max, s[0]);
      }
      return { max, end: s[0] };
    };
    expect(peak(0.55, 1 / 60).max).toBeGreaterThan(1.02);
    expect(peak(1, 1 / 60).max).toBeLessThanOrEqual(1.0001);
    const slow = peak(0.55, 0.05);
    expect(slow.end).toBeCloseTo(1, 2);
  });
});

describe('approach', () => {
  it('tau 秒走掉 63%', () => {
    expect(approach(0, 1, 0.1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 5);
    expect(approach(1, 1, 0.1, 0.016)).toBe(1);
  });
});

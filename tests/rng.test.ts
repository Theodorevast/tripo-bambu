import { describe, expect, it } from 'vitest';
import { hashString, mulberry32 } from '../src/planet/rng';

describe('mulberry32', () => {
  it('同一个种子产生同一串数', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it('不同种子产生不同的数', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
  it('结果落在 [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('种子 42 的前 3 个数钉死（回归保护：算法一变，所有星球的地形都跟着变）', () => {
    const r = mulberry32(42);
    expect([r(), r(), r()]).toEqual([2581720956, 1925393290, 3661312704].map((n) => n / 2 ** 32));
  });
});

describe('hashString', () => {
  it('稳定，且能区分不同字符串', () => {
    expect(hashString('nebula')).toBe(hashString('nebula'));
    expect(hashString('nebula')).not.toBe(hashString('nebulb'));
  });
  it('32 位 FNV-1a 的已知答案', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('foobar')).toBe(0xbf9cf968);
  });
});

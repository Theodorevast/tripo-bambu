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
});

describe('hashString', () => {
  it('稳定，且能区分不同字符串', () => {
    expect(hashString('nebula')).toBe(hashString('nebula'));
    expect(hashString('nebula')).not.toBe(hashString('nebulb'));
  });
});

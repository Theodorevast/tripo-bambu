import { describe, expect, it } from 'vitest';
import { COUPONS, couponScale } from '../src/fun/couponsMath';

// F2：星球全景里券只有约 25 像素。按距离放大：长边在画面上至少有 COUPONS.minScreen 个画面高
const tanH = Math.tan((45 / 2) * (Math.PI / 180)); // 星球视图的竖直视角 45°
const H = 900; // 画面高（CSS 像素）
const longPx = (scale: number, dist: number) => ((COUPONS.size * scale) / (2 * dist * tanH)) * H;

describe('券按距离放大（couponScale）', () => {
  it('星球全景（翠宝离镜头约 58 米、地标放大 2.44 倍）：原来约 25 像素，现在放大到长边约 58 像素', () => {
    expect(longPx(2.44, 58)).toBeLessThan(26);
    const k = couponScale(2.44, 58, tanH);
    expect(k).toBeGreaterThan(2.44 * 2);
    expect(longPx(k, 58)).toBeCloseTo(COUPONS.minScreen * H, 6);
  });

  it('贴近看（漫游，离镜头几米）：不放大，就是跟着作品的倍数', () => {
    expect(couponScale(1, 6, tanH)).toBe(1);
    expect(couponScale(1.3, 10, tanH)).toBe(1.3);
  });

  it('越远放得越大（画面上的大小不再往下掉），近处连续地接上原来的倍数', () => {
    let last = 0;
    for (let d = 1; d <= 200; d += 1) {
      const k = couponScale(1, d, tanH);
      expect(k).toBeGreaterThanOrEqual(last);
      expect(longPx(k, d)).toBeGreaterThanOrEqual(COUPONS.minScreen * H - 1e-6);
      last = k;
    }
  });

  it('minScreen = 0 时关掉：只按地标放大', () => {
    expect(couponScale(2.44, 58, tanH, { ...COUPONS, minScreen: 0 })).toBe(2.44);
  });
});

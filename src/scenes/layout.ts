import { LAYOUT_RADIUS, PLANET_RADIUS } from '../planet/presets';

// 星系布局：Vogel 螺旋（黄金角）。按星球半径 10 时间距 34：16 颗星球的最小间距约 56，外径约 138。
// 星球放大以后整个星系按同样的比例放大（radius / 10）：星球之间的空隙和星球的比例不变，星系镜头也按这个比例拉远（shots.ts）。
// 不选「星系里把星球缩小显示」：那样每颗星球在星系和近景里是两个尺寸，作品、草、石头都要跟着缩放，转场时还得插值
export const GALAXY_SPACING = 34;

// 星系按星球半径放大的倍数
export function galaxyScale(radius = PLANET_RADIUS): number {
  return radius / LAYOUT_RADIUS;
}

export function galaxyPositions(n: number, radius = PLANET_RADIUS): Array<[number, number, number]> {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const k = galaxyScale(radius);
  return Array.from({ length: n }, (_, i) => {
    const r = GALAXY_SPACING * Math.sqrt(i + 1.5);
    const a = i * golden;
    return [Math.cos(a) * r * k, Math.sin(i * 1.7) * 9 * k, Math.sin(a) * r * k];
  });
}

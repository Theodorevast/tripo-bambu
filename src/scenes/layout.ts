// 星系布局：Vogel 螺旋（黄金角）。间距 34 时 16 颗星球的最小间距约 56，外径约 138
export const GALAXY_SPACING = 34;

export function galaxyPositions(n: number): Array<[number, number, number]> {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const r = GALAXY_SPACING * Math.sqrt(i + 1.5);
    const a = i * golden;
    return [Math.cos(a) * r, Math.sin(i * 1.7) * 9, Math.sin(a) * r];
  });
}

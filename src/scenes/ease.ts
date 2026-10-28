// 转场用的缓动工具（纯函数，不碰 three）：镜头表里的缓动曲线都写成 CSS 的 cubic-bezier 四个数，
// 设计稿、浏览器调试工具里的曲线可以直接抄过来

export interface Bezier {
  x1: number;
  y1: number; // 小于 0：起步前先往回收一点（预备动作）
  x2: number;
  y2: number; // 大于 1：冲过头再落回（落地的回弹）
}

// CSS cubic-bezier(x1, y1, x2, y2)：t（时间进度 0..1）→ 进度。先按 x 反解出曲线参数（牛顿迭代，不收敛时二分），再求 y。
// x1、x2 夹到 0..1（和 CSS 一样，保证 x 单调）；t = 0、1 时精确返回 0、1，镜头落地时正好在终点
export function cubicBezier(b: Bezier): (t: number) => number {
  const x1 = Math.min(1, Math.max(0, b.x1));
  const x2 = Math.min(1, Math.max(0, b.x2));
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * b.y1;
  const by = 3 * (b.y2 - b.y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x: number) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// 把 [a, b] 这一段时间映射成 0..1（之前是 0，之后是 1）
export function span(t: number, a: number, b: number): number {
  return b > a ? clamp01((t - a) / (b - a)) : t >= b ? 1 : 0;
}

export const smooth = (x: number): number => x * x * (3 - 2 * x);
export const easeInQuad = (x: number): number => x * x;
export const easeOutCubic = (x: number): number => 1 - (1 - x) ** 3;
export const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// 鼓包：t = 0 和 1 时是 0，t = peak 时是 1，两边都平滑（sin² 形状）。FOV 冲击、甩镜侧倾都用它
export function bump(t: number, peak: number): number {
  if (t <= 0 || t >= 1) return 0;
  const p = Math.min(0.999, Math.max(0.001, peak));
  const s = t < p ? t / p : 1 - (t - p) / (1 - p);
  return Math.sin((s * Math.PI) / 2) ** 2;
}

// 带回弹的缓出（和作品上场的 easeOutBack 同一种）：t = 0 → 0，t = 1 → 1，中途略超过 1 再落回
export function easeOutBack(t: number, c1 = 1.4): number {
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

// 带预备动作的缓入：先往反方向退一点，再加速（easeInBack）
export function easeInBack(t: number, c1 = 1.4): number {
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
}

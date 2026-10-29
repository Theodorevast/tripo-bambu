// 云里探头的翠宝（cloudPeek.ts）不碰场景的那部分：露出来那一块在画面上多大、离星球名牌多远、
// 悬停带路时站在星球哪一边、手怎么指、带不带路（前几次一定带，之后同一颗星球隔一会儿才再带）

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Disc {
  x: number;
  y: number;
  r: number;
}

// 翠宝的身形（× 身高，脚底 = 0）：一个圆滚滚的身子（球），两只手在球的两边，脚在下面
export const BALL_C = 0.63; // 球心高度
export const BALL_R = 0.37; // 球的半径

// 悬停时带路（④）
export const GUIDE = {
  on: true, // 开关（?tune 的 Hover guide）
  delay: 0.6, // 指针在星球、名牌上停多久才冒出来（秒）
  free: 3, // 前几次一定带路
  again: 30, // 之后同一颗星球多久之内不再带（秒）
  size: 0.85, // 身高（× 定时冒出来那只）
  nod: 12, // 点一下头（度）
};

// 露出来那一块在画面上（CSS 像素）：(px, py) 是冒出来的地方（云面上那一点）在画面上的位置，full 是身高在画面上多少像素，
// c 是球心在云面上多高（× 身高），sin 是从镜头看那一点的俯视角的正弦。
// 球往后仰着，球心按俯视角压扁一点；举起来的手在球顶上；前面和两边的小云在那一点下面一截
export function footprint(px: number, py: number, full: number, c: number, sin: number, out: Box): Box {
  const cos = Math.sqrt(Math.max(0, 1 - sin * sin));
  out.left = px - 0.62 * full;
  out.right = px + 0.62 * full;
  out.top = py - (c * cos + BALL_R + 0.16) * full;
  out.bottom = py + (0.42 * sin + 0.2) * full;
  return out;
}

// 方框到圆的距离（像素，压到了是负的）
export function discGap(r: Box, d: Disc): number {
  const cx = Math.min(Math.max(d.x, r.left), r.right);
  const cy = Math.min(Math.max(d.y, r.top), r.bottom);
  return Math.hypot(d.x - cx, d.y - cy) - d.r;
}

// 两个方框的距离（像素，叠在一起是 -1）
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(b.left - a.right, a.left - b.right, 0);
  const dy = Math.max(b.top - a.bottom, a.top - b.bottom, 0);
  return dx > 0 || dy > 0 ? Math.hypot(dx, dy) : -1;
}

// 离最近的障碍物（星球的圆、名牌等方框）多远；有一个近于 margin 就返回 -1
export function clearance(r: Box, discs: readonly Disc[], boxes: readonly Box[], margin: number): number {
  let clear = Infinity;
  for (const d of discs) {
    const g = discGap(r, d);
    if (g < margin) return -1;
    clear = Math.min(clear, g);
  }
  for (const b of boxes) {
    const g = boxGap(r, b);
    if (g < margin) return -1;
    clear = Math.min(clear, g);
  }
  return clear;
}

// 悬停带路：在星球旁边挑一个地方。星球的名牌在它正下方，所以站在左右两边、和星球差不多高（宁可高一点，不往下站），
// 离星球越近越好，但不压着它、它的名牌和别的星球、名牌（discs、boxes 里都有）。
// probe(px, py)：画面上这一点打到云面上时的俯视角正弦（打不到、太远时 null）。找不到返回 null
export function besideSpot(
  planet: Disc,
  full: number,
  c: number,
  discs: readonly Disc[],
  boxes: readonly Box[],
  view: { w: number; h: number },
  probe: (px: number, py: number) => number | null,
  margin = 10,
): { x: number; y: number } | null {
  const r: Box = { left: 0, top: 0, right: 0, bottom: 0 };
  const reach = planet.r + full * 2.2;
  const step = Math.max(5, full / 8);
  let best = -Infinity;
  let bx = 0;
  let by = 0;
  for (let py = planet.y - planet.r - full * 0.2; py <= planet.y + planet.r + full * 1.6; py += step) {
    for (let px = planet.x - reach; px <= planet.x + reach; px += step) {
      const sin = probe(px, py);
      if (sin === null) continue;
      footprint(px, py, full, c, sin, r);
      if (r.left < 8 || r.right > view.w - 8 || r.top < 8 || r.bottom > view.h - 6) continue;
      const clear = clearance(r, discs, boxes, margin);
      if (clear < 0) continue;
      const gap = discGap(r, planet);
      if (gap > full * 1.1 + 24) continue; // 太远：不算在它旁边
      const cy = (r.top + r.bottom) / 2;
      const below = Math.max(0, cy - planet.y) / (planet.r + full); // 往下站（名牌那边）扣得多
      const above = Math.max(0, planet.y - cy) / (planet.r + full);
      const score = -gap / full - below * 1.6 - above * 0.5 + (0.15 * Math.min(clear, full)) / full;
      if (score > best) {
        best = score;
        bx = px;
        by = py;
      }
    }
  }
  return best === -Infinity ? null : { x: bx, y: by };
}

// 指着星球：从翠宝身子中心到星球中心（画面上，y 朝下）→ 用哪只手（+1：模型的 +X 那只，面朝镜头时在画面右边）、
// 手从垂着往上转多少（弧度：π/2 是平举）、身子往那边转多少（弧度，正的转向画面右边）
export function pointAt(fromX: number, fromY: number, toX: number, toY: number): { side: 1 | -1; up: number; turn: number } {
  const dx = toX - fromX;
  const side: 1 | -1 = dx >= 0 ? 1 : -1;
  const above = Math.atan2(fromY - toY, Math.max(1, Math.abs(dx)));
  const up = Math.min(2.85, Math.max(1.15, Math.PI / 2 + above));
  return { side, up, turn: side * 0.32 };
}

// 带不带路：前 free 次一定带；之后同一颗星球 again 秒之内不再带
export class GuideMemo {
  private shown = 0;
  private readonly last = new Map<string, number>();

  wants(id: string, now: number, p: { free: number; again: number } = GUIDE): boolean {
    if (this.shown < p.free) return true;
    const t = this.last.get(id);
    return t === undefined || now - t >= p.again;
  }

  note(id: string, now: number): void {
    this.shown++;
    this.last.set(id, now);
  }

  get count(): number {
    return this.shown;
  }
}

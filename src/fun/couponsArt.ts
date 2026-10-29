import { COUPON_KINDS, type CouponKind } from '../data/coupons';
import { mulberry32 } from '../planet/rng';

// 券面（canvas 画的，不用外部图片）：带小锯齿边的纸票，翠宝黄配奶油白，左上角小翠宝和 Tripo 字样，中间大大的面额，
// 右边一截票根（虚线撕口、上下两个半圆缺口）。3D 的券用一张图集（每种券一行，最后一行是背面），
// 卡片上的大券用同一个函数按卡片的像素画一张，飞到镜头前交给界面时两边看起来是同一张。

export const TICKET_W = 512; // 图集里一格的大小（像素）
export const TICKET_H = 256;
export const ATLAS_ROWS = COUPON_KINDS.length + 1; // 最后一行是背面
export const BACK_ROW = COUPON_KINDS.length;

export const YELLOW = '#f2b705'; // 翠宝黄
export const CREAM = '#fbf3df';
export const INK = '#2b2233';
const FONT = "'Nunito', ui-rounded, system-ui, sans-serif";

type Ctx = CanvasRenderingContext2D;

// 券的外形（x, y, w, h 是整格，s 是缩放：格宽 512 时 = 1）：圆角矩形，左右两头一排小锯齿，票根撕口上下各一个半圆缺口。
// mirror：背面（从背后看，票根在左边）
function ticketPath(ctx: Ctx, x: number, y: number, w: number, h: number, s: number, mirror: boolean): void {
  const pad = 10 * s;
  const l = x + pad;
  const r = x + w - pad;
  const t = y + pad;
  const b = y + h - pad;
  const tooth = 9 * s; // 锯齿的深度
  const teeth = 9; // 一边几个齿
  const notch = 15 * s;
  const stub = stubX(x, w, s, mirror);
  const corner = 10 * s;
  ctx.beginPath();
  // 上边：左上角 → 缺口 → 右上角
  ctx.moveTo(l + tooth + corner, t);
  ctx.lineTo(stub - notch, t);
  ctx.arc(stub, t, notch, Math.PI, 0, true);
  ctx.lineTo(r - tooth - corner, t);
  ctx.quadraticCurveTo(r - tooth, t, r - tooth, t + corner);
  // 右边：锯齿
  const step = (b - t - 2 * corner) / teeth;
  for (let i = 0; i < teeth; i++) {
    const y0 = t + corner + i * step;
    ctx.lineTo(r, y0 + step / 2);
    ctx.lineTo(r - tooth, y0 + step);
  }
  ctx.quadraticCurveTo(r - tooth, b, r - tooth - corner, b);
  // 下边：右下角 → 缺口 → 左下角
  ctx.lineTo(stub + notch, b);
  ctx.arc(stub, b, notch, 0, Math.PI, true);
  ctx.lineTo(l + tooth + corner, b);
  ctx.quadraticCurveTo(l + tooth, b, l + tooth, b - corner);
  // 左边：锯齿
  for (let i = 0; i < teeth; i++) {
    const y0 = b - corner - i * step;
    ctx.lineTo(l, y0 - step / 2);
    ctx.lineTo(l + tooth, y0 - step);
  }
  ctx.quadraticCurveTo(l + tooth, t, l + tooth + corner, t);
  ctx.closePath();
}

// 票根撕口的 x：正面在右边四分之一处，背面镜像
function stubX(x: number, w: number, s: number, mirror: boolean): number {
  const at = w - 122 * s;
  return mirror ? x + w - at : x + at;
}

// 小翠宝（和「Made with Tripo」徽章、3D 翠宝胸前同一套线段）：黑色圆球、白色 V、翠宝黄的 T。cx, cy 圆心，r 半径
export function drawMark(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(r, r);
  ctx.fillStyle = '#14191b';
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#f4f1ea';
  ctx.lineWidth = 0.17;
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.3);
  ctx.lineTo(-0.03, 0.4);
  ctx.lineTo(0.44, -0.1);
  ctx.stroke();
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.36);
  ctx.lineTo(0.46, -0.36);
  ctx.moveTo(0.05, -0.36);
  ctx.lineTo(-0.12, -0.05);
  ctx.stroke();
  ctx.restore();
}

// 四角的小星星（票根上、背面的花纹）
function sparkle(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.32;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// 纸的质感：一层淡淡的斑点 + 四周稍暗（固定的随机数，每次画出来一样）
function paperGrain(ctx: Ctx, x: number, y: number, w: number, h: number, s: number, seed: number): void {
  const rand = mulberry32(seed);
  ctx.save();
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(90, 60, 20, 0.07)' : 'rgba(255, 255, 255, 0.12)';
    const r = (0.6 + rand() * 1.4) * s;
    ctx.beginPath();
    ctx.arc(x + rand() * w, y + rand() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(x + w * 0.45, y + h * 0.45, h * 0.2, x + w / 2, y + h / 2, w * 0.62);
  g.addColorStop(0, 'rgba(255, 250, 235, 0.10)');
  g.addColorStop(1, 'rgba(110, 70, 20, 0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// 一张券的正面，画进 (x, y, w, h) 这一格（宽高比 2:1）
export function drawTicket(ctx: Ctx, kind: CouponKind, x: number, y: number, w: number, h: number): void {
  const s = w / TICKET_W;
  const main = kind.paper === 'yellow' ? YELLOW : CREAM;
  const side = kind.paper === 'yellow' ? CREAM : YELLOW;
  const stub = stubX(x, w, s, false);
  ctx.save();
  ticketPath(ctx, x, y, w, h, s, false);
  ctx.clip();
  ctx.fillStyle = main;
  ctx.fillRect(x, y, stub - x, h);
  ctx.fillStyle = side;
  ctx.fillRect(stub, y, x + w - stub, h);
  paperGrain(ctx, x, y, w, h, s, 7 + kind.id.length * 13);
  // 内圈的细线（印刷的边框）
  ctx.strokeStyle = 'rgba(70, 45, 15, 0.28)';
  ctx.lineWidth = 2 * s;
  ctx.setLineDash([]);
  roundRect(ctx, x + 34 * s, y + 24 * s, stub - x - 46 * s, h - 48 * s, 12 * s);
  ctx.stroke();
  // 撕口的虚线
  ctx.strokeStyle = 'rgba(70, 45, 15, 0.5)';
  ctx.lineWidth = 3 * s;
  ctx.setLineDash([7 * s, 7 * s]);
  ctx.beginPath();
  ctx.moveTo(stub, y + 30 * s);
  ctx.lineTo(stub, y + h - 30 * s);
  ctx.stroke();
  ctx.setLineDash([]);
  // 左上：小翠宝 + Tripo
  drawMark(ctx, x + 66 * s, y + 58 * s, 17 * s);
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${30 * s}px ${FONT}`;
  ctx.fillText('Tripo', x + 92 * s, y + 69 * s);
  ctx.font = `800 ${15 * s}px ${FONT}`;
  ctx.globalAlpha = 0.62;
  ctx.textAlign = 'right';
  ctx.fillText('COUPON', stub - 24 * s, y + 66 * s);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
  // 面额：大字 + 单位
  ctx.font = `800 ${86 * s}px ${FONT}`;
  const vx = x + 50 * s;
  const vy = y + 168 * s;
  ctx.fillText(kind.value, vx, vy);
  const vw = ctx.measureText(kind.value).width;
  ctx.font = `800 ${22 * s}px ${FONT}`;
  ctx.fillText(kind.unit.toUpperCase(), vx + vw + 10 * s, vy - 8 * s);
  // 券名
  ctx.font = `700 ${19 * s}px ${FONT}`;
  ctx.globalAlpha = 0.78;
  ctx.fillText(kind.title, x + 52 * s, y + 210 * s);
  ctx.globalAlpha = 1;
  // 票根：一颗星星 + 竖着的 TRIBOO
  const sx = (stub + x + w - 10 * s) / 2;
  sparkle(ctx, sx, y + 70 * s, 20 * s, kind.paper === 'yellow' ? YELLOW : CREAM);
  ctx.save();
  ctx.translate(sx + 6 * s, y + 160 * s);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `800 ${17 * s}px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.globalAlpha = 0.7;
  ctx.textAlign = 'center';
  ctx.fillText('TRIBOO', 0, 0);
  ctx.restore();
  ctx.restore();
}

// 背面：奶油色的纸，斜着排的小翠宝花纹，中间 Tripo；外形是正面的镜像（从背后看票根在左边）
export function drawBack(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const s = w / TICKET_W;
  ctx.save();
  ticketPath(ctx, x, y, w, h, s, true);
  ctx.clip();
  ctx.fillStyle = '#f6ecd4';
  ctx.fillRect(x, y, w, h);
  paperGrain(ctx, x, y, w, h, s, 99);
  ctx.globalAlpha = 0.16;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      const cx = x + (col + (row % 2) * 0.5) * 70 * s + 20 * s;
      const cy = y + 34 * s + row * 62 * s;
      if ((row + col) % 2 === 0) drawMark(ctx, cx, cy, 11 * s);
      else sparkle(ctx, cx, cy, 10 * s, '#c98f00');
    }
  }
  ctx.globalAlpha = 1;
  const stub = stubX(x, w, s, true);
  ctx.strokeStyle = 'rgba(70, 45, 15, 0.45)';
  ctx.lineWidth = 3 * s;
  ctx.setLineDash([7 * s, 7 * s]);
  ctx.beginPath();
  ctx.moveTo(stub, y + 30 * s);
  ctx.lineTo(stub, y + h - 30 * s);
  ctx.stroke();
  ctx.setLineDash([]);
  // 中间一块奶油底，压着字
  const cx = (stub + x + w) / 2;
  ctx.fillStyle = 'rgba(251, 243, 223, 0.9)';
  roundRect(ctx, cx - 120 * s, y + 92 * s, 240 * s, 72 * s, 36 * s);
  ctx.fill();
  drawMark(ctx, cx - 70 * s, y + 128 * s, 20 * s);
  ctx.fillStyle = INK;
  ctx.font = `800 ${36 * s}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Tripo', cx - 42 * s, y + 130 * s);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 3D 用的图集：每种券一行（行号 = COUPON_KINDS 的下标），最后一行是背面
export function drawAtlas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  canvas.width = TICKET_W;
  canvas.height = TICKET_H * ATLAS_ROWS;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  COUPON_KINDS.forEach((kind, i) => drawTicket(ctx, kind, 0, i * TICKET_H, TICKET_W, TICKET_H));
  drawBack(ctx, 0, BACK_ROW * TICKET_H, TICKET_W, TICKET_H);
  return canvas;
}

// 卡片上的大券：按显示大小 × 像素比画（不糊）
export function drawCardTicket(canvas: HTMLCanvasElement, kind: CouponKind, cssWidth: number, dpr: number): void {
  const w = Math.round(cssWidth * dpr);
  const h = Math.round(w / 2);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  drawTicket(ctx, kind, 0, 0, w, h);
}

// 画字之前等 Nunito 下好（canvas 不会等字体：没下好就用后备字体画了）。最多等 ms 毫秒
export async function fontsReady(ms = 2500): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const load = Promise.all([document.fonts.load(`800 40px ${FONT}`), document.fonts.load(`700 20px ${FONT}`)]).then(() => {});
  await Promise.race([load, new Promise<void>((r) => setTimeout(r, ms))]).catch(() => {});
}

import { COUPON_KINDS, type CouponKind } from '../data/coupons';
import { mulberry32 } from '../planet/rng';

// 券面（canvas 画的，不用外部图片）。第二版（v2-ui）：一张烫金卡片——深色的底（两种：Indigo、Dusk violet 轮着用），
// 两道香槟金细线的边框、四角的小星，左上角小翠宝（黑色圆身子描一圈细金边）和 Tripo 字样，中间金色渐变的大面额（Cinzel），
// 下面 Cormorant 斜体的券名；右边一截用金色点线隔开：一个小小的天体仪环、竖着的 TRIBOO。不再是带锯齿的卡通票根。
// 3D 的券用一张图集（每种券一行，最后一行是背面），卡片上的大券用同一个函数按卡片的像素画一张，
// 飞到镜头前交给界面时两边看起来是同一张（形状靠透明度：圆角外面是透明的，3D 那边按 alpha 裁）。

export const TICKET_W = 512; // 图集里一格的大小（像素）
export const TICKET_H = 256;
export const ATLAS_ROWS = COUPON_KINDS.length + 1; // 最后一行是背面
export const BACK_ROW = COUPON_KINDS.length;

export const YELLOW = '#f2b705'; // Tripo 黄：只用在小翠宝的 T 上
export const GOLD = '#d8c08e'; // 香槟金：细线、星、面额
export const GOLD_DEEP = '#a8894f';
export const STAR = '#f6f1e7'; // 最亮的字
export const CREAM = STAR; // 第一版的名字（奶油白），留着
export const INK = '#0f1530'; // 第一版的名字（券面上的深色字）：第二版是 Midnight
const CAPS = "'Cinzel', 'Cormorant Garamond', Georgia, serif";
const SERIF = "'Cormorant Garamond', Georgia, serif";
const SANS = "'Inter', system-ui, sans-serif";

type Ctx = CanvasRenderingContext2D;

// 券的外形（x, y, w, h 是整格，s 是缩放：格宽 512 时 = 1）：四周留 10 的边，圆角 14
function cardPath(ctx: Ctx, x: number, y: number, w: number, h: number, s: number): void {
  const pad = 10 * s;
  roundRect(ctx, x + pad, y + pad, w - 2 * pad, h - 2 * pad, 14 * s);
}

// 票根的分隔线的 x：正面在右边，背面（从背后看）镜像到左边
function stubX(x: number, w: number, s: number, mirror: boolean): number {
  const at = w - 122 * s;
  return mirror ? x + w - at : x + at;
}

// 小翠宝（和「Made with Tripo」徽章、3D 翠宝胸前同一套线段）：黑色圆球、白色 V、Tripo 黄的 T，外面一圈细金边（深色底上看得出圆）。
// cx, cy 圆心，r 半径
export function drawMark(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(r, r);
  ctx.fillStyle = '#14191b';
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(216, 192, 142, 0.8)';
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  ctx.arc(0, 0, 1.04, 0, Math.PI * 2);
  ctx.stroke();
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

// 四角小星（四个尖、细腰）
function sparkle(ctx: Ctx, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.22;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// 深色卡面的质感：很淡的浅色斑点（像胶片颗粒），右上角一团很淡的暖光（像烫金反光）。固定的随机数，每次画出来一样
function surface(ctx: Ctx, x: number, y: number, w: number, h: number, s: number, seed: number): void {
  const rand = mulberry32(seed);
  ctx.save();
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = rand() < 0.7 ? 'rgba(246, 241, 231, 0.05)' : 'rgba(216, 192, 142, 0.08)';
    const r = (0.4 + rand() * 1.1) * s;
    ctx.beginPath();
    ctx.arc(x + rand() * w, y + rand() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(x + w * 0.78, y + h * 0.12, 0, x + w * 0.78, y + h * 0.12, w * 0.55);
  g.addColorStop(0, 'rgba(230, 194, 166, 0.16)');
  g.addColorStop(1, 'rgba(230, 194, 166, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// 两道细金线的边框，四角的小星压在内框的角上
function frame(ctx: Ctx, x: number, y: number, w: number, h: number, s: number): void {
  const pad = 10 * s;
  const l = x + pad;
  const t = y + pad;
  const iw = w - 2 * pad;
  const ih = h - 2 * pad;
  ctx.save();
  ctx.strokeStyle = GOLD;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 2 * s;
  roundRect(ctx, l + 9 * s, t + 9 * s, iw - 18 * s, ih - 18 * s, 8 * s);
  ctx.stroke();
  ctx.globalAlpha = 0.38;
  ctx.lineWidth = 1.2 * s;
  roundRect(ctx, l + 16 * s, t + 16 * s, iw - 32 * s, ih - 32 * s, 4 * s);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (const [cx, cy] of [[l + 16 * s, t + 16 * s], [l + iw - 16 * s, t + 16 * s], [l + 16 * s, t + ih - 16 * s], [l + iw - 16 * s, t + ih - 16 * s]]) sparkle(ctx, cx, cy, 6 * s, GOLD);
  ctx.restore();
}

// 金色的点线（票根的分隔）
function dottedLine(ctx: Ctx, x: number, y0: number, y1: number, s: number): void {
  ctx.save();
  ctx.strokeStyle = GOLD;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2.2 * s;
  ctx.lineCap = 'round';
  ctx.setLineDash([0.1, 7 * s]);
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.restore();
}

// 小小的天体仪环：一圈细线、一圈刻度、中间一颗星（票根上）
function orrery(ctx: Ctx, cx: number, cy: number, r: number, s: number): void {
  ctx.save();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.4 * s;
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1 * s;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r0 = r * (i % 6 === 0 ? 0.7 : 0.82);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r * 0.94, cy + Math.sin(a) * r * 0.94);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 1.35, r * 0.42, -0.35, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  sparkle(ctx, cx, cy, r * 0.42, GOLD);
  ctx.restore();
}

// 字距（Chrome 99+ 的 ctx.letterSpacing；不认的浏览器照常画，只是没有字距）
function spacing(ctx: Ctx, px: number): void {
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

// 一张券的正面，画进 (x, y, w, h) 这一格（宽高比 2:1）
export function drawTicket(ctx: Ctx, kind: CouponKind, x: number, y: number, w: number, h: number): void {
  const s = w / TICKET_W;
  const deep = kind.paper === 'yellow'; // 第一版的黄券 → Indigo 底，奶油券 → Dusk violet 底
  const stub = stubX(x, w, s, false);
  ctx.save();
  cardPath(ctx, x, y, w, h, s);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  if (deep) {
    g.addColorStop(0, '#29336e');
    g.addColorStop(0.55, '#1b2348');
    g.addColorStop(1, '#111733');
  } else {
    g.addColorStop(0, '#47427a');
    g.addColorStop(0.55, '#322f5e');
    g.addColorStop(1, '#1e1d42');
  }
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  surface(ctx, x, y, w, h, s, 7 + kind.id.length * 13);
  frame(ctx, x, y, w, h, s);
  dottedLine(ctx, stub, y + 40 * s, y + h - 40 * s, s);
  // 左上：小翠宝 + Tripo；主区右上角：COUPON
  drawMark(ctx, x + 68 * s, y + 64 * s, 15 * s);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = STAR;
  ctx.font = `600 ${25 * s}px ${SANS}`;
  spacing(ctx, 0);
  ctx.fillText('Tripo', x + 92 * s, y + 73 * s);
  ctx.font = `500 ${11.5 * s}px ${SANS}`;
  spacing(ctx, 3 * s);
  ctx.fillStyle = GOLD;
  ctx.textAlign = 'right';
  ctx.fillText('COUPON', stub - 30 * s, y + 70 * s);
  ctx.textAlign = 'left';
  // 面额：金色渐变的大字（Cinzel）+ 单位（Inter 小号大写）；太长时缩小，不压到票根
  const vx = x + 52 * s;
  const vy = y + 168 * s;
  const unit = kind.unit.toUpperCase();
  ctx.font = `500 ${15 * s}px ${SANS}`;
  spacing(ctx, 3 * s);
  const uw = ctx.measureText(unit).width;
  let size = 74;
  spacing(ctx, 0);
  for (; size > 40; size -= 4) {
    ctx.font = `600 ${size * s}px ${CAPS}`;
    if (vx + ctx.measureText(kind.value).width + 12 * s + uw < stub - 22 * s) break;
  }
  const vw = ctx.measureText(kind.value).width;
  const foil = ctx.createLinearGradient(0, vy - size * 0.8 * s, 0, vy + 4 * s);
  foil.addColorStop(0, '#f8ecc8');
  foil.addColorStop(0.5, GOLD);
  foil.addColorStop(1, GOLD_DEEP);
  ctx.fillStyle = foil;
  ctx.fillText(kind.value, vx, vy);
  ctx.font = `500 ${15 * s}px ${SANS}`;
  spacing(ctx, 3 * s);
  ctx.fillStyle = GOLD;
  ctx.fillText(unit, vx + vw + 12 * s, vy - 9 * s);
  // 券名：Cormorant 斜体
  spacing(ctx, 0);
  ctx.font = `italic 500 ${23 * s}px ${SERIF}`;
  ctx.fillStyle = STAR;
  ctx.globalAlpha = 0.82;
  ctx.fillText(kind.title, x + 54 * s, y + 208 * s);
  ctx.globalAlpha = 1;
  // 票根：小天体仪 + 竖着的 TRIBOO
  const sx = (stub + x + w - 10 * s) / 2;
  orrery(ctx, sx, y + 76 * s, 19 * s, s);
  ctx.save();
  ctx.translate(sx + 5 * s, y + 168 * s);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `600 ${13 * s}px ${CAPS}`;
  spacing(ctx, 4 * s);
  ctx.fillStyle = GOLD;
  ctx.textAlign = 'center';
  ctx.fillText('TRIBOO', 0, 0);
  ctx.restore();
  spacing(ctx, 0);
  ctx.restore();
}

// 背面：更深的 Midnight 底，一片淡淡的星座（星点和细线），两道细金线的边框；中间一块细线框的小牌子写 Tripo。
// 从背后看票根在左边（分隔线镜像）
export function drawBack(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const s = w / TICKET_W;
  ctx.save();
  cardPath(ctx, x, y, w, h, s);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, '#1d2450');
  g.addColorStop(1, '#0d1230');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  surface(ctx, x, y, w, h, s, 99);
  // 星座：几组星点，用细线连起来
  const rand = mulberry32(404);
  ctx.strokeStyle = GOLD;
  ctx.fillStyle = STAR;
  for (let c = 0; c < 5; c++) {
    const cx = x + (60 + c * 92 + rand() * 30) * s;
    const cy = y + (60 + rand() * 140) * s;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) pts.push([cx + (rand() - 0.5) * 80 * s, cy + (rand() - 0.5) * 70 * s]);
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    for (const [px, py] of pts) {
      ctx.beginPath();
      ctx.arc(px, py, (1 + rand() * 1.2) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  frame(ctx, x, y, w, h, s);
  dottedLine(ctx, stubX(x, w, s, true), y + 40 * s, y + h - 40 * s, s);
  // 中间的小牌子：深色底、细金线框，小翠宝 + Tripo
  const cx = x + w / 2 + 40 * s;
  ctx.fillStyle = 'rgba(13, 18, 48, 0.9)';
  roundRect(ctx, cx - 112 * s, y + 96 * s, 224 * s, 64 * s, 6 * s);
  ctx.fill();
  ctx.strokeStyle = GOLD;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.4 * s;
  ctx.stroke();
  ctx.globalAlpha = 1;
  drawMark(ctx, cx - 62 * s, y + 128 * s, 18 * s);
  ctx.fillStyle = STAR;
  ctx.font = `600 ${32 * s}px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('Tripo', cx - 36 * s, y + 130 * s);
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

// 卡片上的大券：按显示大小 × 像素比画（不糊）。券的影子直接画在 canvas 里（不用 CSS 的 drop-shadow 滤镜：卡片出现那一帧不用现算模糊）
export function drawCardTicket(canvas: HTMLCanvasElement, kind: CouponKind, cssWidth: number, dpr: number): void {
  const w = Math.round(cssWidth * dpr);
  const h = Math.round(w / 2);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.shadowColor = 'rgba(4, 6, 18, 0.5)';
  ctx.shadowBlur = 8 * dpr;
  ctx.shadowOffsetY = 4 * dpr;
  cardPath(ctx, 0, 0, w, h, w / TICKET_W);
  ctx.fillStyle = '#141a3a';
  ctx.fill();
  ctx.restore();
  drawTicket(ctx, kind, 0, 0, w, h);
}

// 画字之前等字体下好（canvas 不会等字体：没下好就用后备字体画了）：Cinzel（面额、TRIBOO）、Inter（Tripo、COUPON、单位）、
// Cormorant 斜体（券名）。启动画面一开始就在预加载这几种（ui/boot.ts），到这里一般早就到了。最多等 ms 毫秒
export async function fontsReady(ms = 2500): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const load = Promise.all([
    document.fonts.load(`600 40px ${CAPS}`),
    document.fonts.load(`500 20px ${SANS}`),
    document.fonts.load(`italic 500 20px ${SERIF}`),
  ]).then(() => {});
  await Promise.race([load, new Promise<void>((r) => setTimeout(r, ms))]).catch(() => {});
}

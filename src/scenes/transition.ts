import { VEIL_U } from '../style/veil';
import { bump, clamp01, cubicBezier, easeInQuad, easeOutCubic, smooth, span } from './ease';
import type { TransitionShot } from './shots';

// 转场的编排：分镜表（shots.ts）里的一行 → 每一帧的云层参数（写进 VEIL_U）和镜头怎么飞（Move）。
// 这里只有算数，不碰场景：director.ts 每帧调 Timeline.step，到点触发事件（全遮住时换场景、作品开始弹出来）

// 一次转场的镜头怎么飞（director.ts 的 MoveFlight 按它逐帧摆镜头）
export interface Move {
  seconds: number;
  ease?: (t: number) => number; // 时间进度 → 位置进度（视角也按它过渡）；默认 easeInOutCubic
  look?: (t: number) => number; // 时间进度 → 视线（看向哪里）的进度；不给就和位置一样
  fovKick?: (t: number) => number; // 视角额外加多少度（FOV 冲击：起点终点都要是 0）
  arc?: number; // 路径中点往上（世界 +Y）拱多高（世界单位）：沿弧线跳过去
  roll?: (t: number) => number; // 绕视线侧倾（弧度；起点终点都要是 0）
}

export type TransitionKind = 'enter' | 'hop' | 'leave' | 'fade';

// 系统设置了「减少动态效果」
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Vec2 = [number, number];
type Vec4 = [number, number, number, number];

export interface VeilFrame {
  on: boolean;
  band: boolean;
  center: Vec2;
  dir: Vec2;
  front: Vec4;
  back: Vec4;
  flash: Vec2;
  fade: number;
}

export interface VeilContext {
  aspect: number; // 画面宽高比
  centerIn: Vec2; // iris 合拢时围着的中心（画面坐标：高 = 1、原点在画面中心、y 朝上）
  centerOut: Vec2; // 散开时从哪里散
  dir: Vec2; // band 移动的方向（单位向量）
  spin: number; // 云团排布的转角（每次转场随机一个，云不会每次一模一样）
}

// 和 style/veil.ts 里的常数一一对应：两层各几个云团、band 的云团大小
const FRONT_PUFFS = 16;
const BACK_PUFFS = 12;
const BAND_SIZE = 0.16;
const MARGIN = 0.04; // 再往外让一点：柔边、边缘的抖动、云团鼓动（±3.5%）都算进去
const FULL = -0.08; // iris 洞的半径小于这个：整个画面都是云
const RING = 0.55; // 全遮住时近的那层不合死：一圈奶油色的云团框在画面四周，中间是远的那层（偏天空色），画面不是一整块平的颜色
const OFF = 9; // 远远在画面外

// 点到画面最远的那个角有多远
function farCorner(c: Vec2, aspect: number): number {
  const hx = aspect / 2;
  return Math.max(Math.hypot(hx - c[0], 0.5 - c[1]), Math.hypot(hx + c[0], 0.5 - c[1]), Math.hypot(hx - c[0], 0.5 + c[1]), Math.hypot(hx + c[0], 0.5 + c[1]));
}

// iris 洞要多大，一圈云团才完全在画面外（veil.ts：弦长 = (洞 + 0.06) × 角距 × 大小，云团半径最大 0.88 个弦长、
// 圆心最多往里错 0.15 个半径，朝洞里的小云团再多鼓出 0.17 个半径，再算上 3.5% 的鼓动）
export function irisClearRadius(corner: number, count: number, size: number): number {
  const a = Math.min(0.85, 1.32 * 0.88 * 1.035 * ((Math.PI * 2) / count) * size);
  return (corner + MARGIN + 0.06 * a) / (1 - a);
}

// band 沿 dir 方向的画面半宽（画面矩形投影到 dir 上）
function bandHalf(dir: Vec2, aspect: number): number {
  return (Math.abs(dir[0]) * aspect) / 2 + Math.abs(dir[1]) / 2;
}

// 一层 iris：c 合拢进度、o 散开进度（0..1），closed：合拢到多小
function irisLayer(c: number, o: number, ctx: VeilContext, count: number, size: number, spin: number, closed: number): Vec4 {
  if (o > 0) {
    // 散开：穿过云层，云团越飞越近（变大一点），洞从中心张开到画面外
    const grown = size * (1 + 0.4 * o);
    const r = closed + (irisClearRadius(farCorner(ctx.centerOut, ctx.aspect), count, grown) - closed) * smooth(o);
    return [r, 0, grown, spin];
  }
  // 合拢：从画面外收到中心。先快后慢（缓出）：画面外那一段一闪而过，进了画面才慢下来
  const start = irisClearRadius(farCorner(ctx.centerIn, ctx.aspect), count, size);
  return [start + (closed - start) * easeOutCubic(c), 0, size, spin];
}

// 一层 band：前沿从进来的那一侧（-dir）扫到另一侧，全遮住；散开时后沿跟着扫过去
function bandLayer(c: number, o: number, ctx: VeilContext, size: number, phase: number): Vec4 {
  const half = bandHalf(ctx.dir, ctx.aspect);
  const reach = 1.2 * BAND_SIZE * size + MARGIN;
  const lead = -half - reach + (2 * half + reach + MARGIN) * smooth(c);
  const trail = o > 0 ? -half - MARGIN + (2 * half + reach + MARGIN) * easeInQuad(o) : -OFF;
  return [o > 0 ? OFF : lead, trail, size, phase];
}

// 第 t（0..1）时刻的云层参数
export function veilFrame(kind: TransitionKind, shot: TransitionShot, t: number, ctx: VeilContext): VeilFrame {
  const seconds = Math.max(0.001, shot.seconds);
  const none: VeilFrame = { on: false, band: false, center: [0, 0], dir: ctx.dir, front: [OFF, -OFF, 1, 0], back: [OFF, -OFF, 1, 0], flash: [0, 0], fade: 0 };
  if (kind === 'fade') {
    const fade = t < shot.cloudFull ? smooth(span(t, 0, shot.cloudFull)) : 1 - smooth(span(t, shot.cloudOut, 1));
    return { ...none, on: fade > 0.001, fade };
  }
  const c = span(t, shot.cloudIn, shot.cloudFull);
  const o = span(t, shot.cloudOut, shot.cloudGone);
  const band = kind === 'hop';
  const size = Math.max(0.2, shot.cloudSize);
  let front: Vec4;
  let back: Vec4;
  let gone: boolean;
  if (band) {
    // 云带：远的一层（偏天空色）先扫过来把画面盖满，近的一层（奶油色）跟在后面扫过它；散开时近的先走、远的后走
    const cBack = clamp01(c * 1.6);
    const oBack = clamp01((o - 0.14) / 0.86);
    front = bandLayer(c, o, ctx, size, ctx.spin);
    back = bandLayer(cBack, oBack, ctx, size * 1.25, ctx.spin * 1.7 + 0.37);
    gone = o >= 1 && oBack >= 1;
  } else {
    // 一圈云：远的一层先合拢、把画面全遮住，近的一层跟着合拢到只剩一个小洞（一圈奶油色的云团围着远的那层）；
    // 散开时远的那层先张开（从近的那圈云中间看出去），近的那圈再往外散
    const cBack = clamp01(c * 1.3);
    const oBack = clamp01(o * 1.3);
    const oFront = clamp01((o - 0.1) / 0.9);
    const spin = ctx.spin + 0.35 * t; // 整圈云慢慢转一点，像被卷进去
    front = irisLayer(c, oFront, ctx, FRONT_PUFFS, size, spin, RING);
    back = irisLayer(cBack, oBack, ctx, BACK_PUFFS, size, -spin * 0.8 + 1.3, FULL);
    gone = oFront >= 1;
  }
  // 翠宝黄光带：flashMs 内从左下扫到右上，淡入淡出
  let flash: Vec2 = [0, 0];
  if (shot.flashAt >= 0 && shot.flashMs > 0) {
    const u = (t * seconds - shot.flashAt * seconds) / (shot.flashMs / 1000);
    if (u >= 0 && u <= 1) flash = [-1.15 + 2.3 * u, 0.92 * Math.sqrt(Math.sin(Math.PI * u))];
  }
  const visible = c > 0 && !gone;
  return {
    on: visible || flash[1] > 0,
    band,
    center: o > 0 ? ctx.centerOut : ctx.centerIn,
    dir: ctx.dir,
    front,
    back,
    flash,
    fade: 0,
  };
}

export function writeVeil(f: VeilFrame): void {
  VEIL_U.on.value = f.on ? 1 : 0;
  VEIL_U.band.value = f.band ? 1 : 0;
  VEIL_U.center.value.set(f.center[0], f.center[1]);
  VEIL_U.dir.value.set(f.dir[0], f.dir[1]);
  VEIL_U.front.value.set(...f.front);
  VEIL_U.back.value.set(...f.back);
  VEIL_U.flash.value.set(f.flash[0], f.flash[1]);
  VEIL_U.fade.value = f.fade;
}

export function clearVeil(): void {
  VEIL_U.on.value = 0;
  VEIL_U.fade.value = 0;
  VEIL_U.flash.value.set(0, 0);
}

// 分镜表的一行 → 镜头怎么飞。distance：起点到终点多远（抬升量按它算）；turn：甩镜往哪边（+1 右、-1 左，侧倾跟着它）。
// leave 的镜头在全遮住时才起飞，飞剩下的那段时间
export function moveFor(kind: TransitionKind, shot: TransitionShot, distance: number, turn = 1): Move {
  const ease = cubicBezier(shot.ease);
  const lookEase = cubicBezier(shot.look);
  const lookSpan = Math.min(1, Math.max(0.05, shot.lookSpan));
  const seconds = kind === 'leave' ? shot.seconds * (1 - shot.cloudFull) : shot.seconds;
  const move: Move = { seconds, ease, look: (t) => lookEase(Math.min(1, t / lookSpan)) };
  if (shot.fovPunch) move.fovKick = (t) => shot.fovPunch * bump(t, shot.fovPeak);
  if (shot.arc) move.arc = shot.arc * distance;
  if (shot.bank) move.roll = (t) => -turn * ((shot.bank * Math.PI) / 180) * bump(t, shot.fovPeak);
  return move;
}

// 一条时间线：按每帧的 dt 走（标签页在后台时停住），到点触发事件（按时刻先后，同一帧里过了几个点就依次触发），
// 每帧把进度交给 frame 画云层。走完 seconds 后 done resolve
export class Timeline {
  elapsed = 0;
  readonly seconds: number;
  readonly done: Promise<void>;
  private finish!: () => void;
  private readonly frame: (t: number) => void;
  private readonly events: Array<{ at: number; fn: () => void }> = [];

  constructor(seconds: number, frame: (t: number) => void) {
    this.seconds = seconds;
    this.frame = frame;
    this.done = new Promise((resolve) => (this.finish = resolve));
  }

  // at：占时长的比例（0..1）
  at(at: number, fn: () => void): this {
    this.events.push({ at: at * this.seconds, fn });
    this.events.sort((a, b) => a.at - b.at);
    return this;
  }

  // 返回 false 表示走完了
  step(dt: number): boolean {
    this.elapsed += dt;
    while (this.events.length && this.events[0].at <= this.elapsed) this.events.shift()!.fn();
    const t = this.seconds > 0 ? Math.min(1, this.elapsed / this.seconds) : 1;
    this.frame(t);
    if (t < 1) return true;
    this.finish();
    return false;
  }

  // 立刻触发还没到点的事件、走到终点（比如画面不再更新时）
  flush(): void {
    while (this.events.length) this.events.shift()!.fn();
    this.frame(1);
    this.finish();
  }
}

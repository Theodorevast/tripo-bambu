// 界面动效的公用工具（Members、Museum、查看器、调参面板共用）
// 规则：只动 transform 和 opacity，不碰尺寸、位置这些要重新排版的属性，3D 画面不受影响；
// 减弱动效（prefers-reduced-motion: reduce）时一律改成淡入淡出。
// 测试跑在 node 的假 DOM 里，没有 animate、matchMedia、requestAnimationFrame：这里全部判空，调用方照常调用

// 第二版（v2-ui）：慢、柔、不回弹。三个名字都还在（调用的地方不用改），全部换成同一条柔和的缓动，
// 不过冲；时长由各处自己给（300–700 ms）。第一版的弹簧曲线留在 SPRING_V1 里备查，不再使用
export const SOFT = 'cubic-bezier(0.22, 0.8, 0.24, 1)';
const CURVES = { bounce: SOFT, spring: SOFT, settle: SOFT } as const;
// 第一版的弹簧曲线（CSS linear()，阻尼振子采样，按停稳的时间归一化）：
// bounce 过冲约 23%（小按钮、贴纸、勾号弹出来），spring 约 13%（卡片进场、面板），settle 约 5%（大块的面、查看器放大）
export const SPRING_V1 = {
  bounce: 'linear(0, 0.024 1.5%, 0.090 3.0%, 0.192 4.6%, 0.319 6.2%, 0.462 7.8%, 0.610 9.5%, 0.756 11.2%, 0.890 13.0%, 1.007 14.8%, 1.101 16.6%, 1.170 18.4%, 1.213 20.3%, 1.232 22.3%, 1.230 24.2%, 1.209 26.2%, 1.176 28.3%, 1.135 30.3%, 1.091 32.4%, 1.049 34.6%, 1.012 36.8%, 0.982 39.0%, 0.961 41.3%, 0.949 43.5%, 0.945 45.9%, 0.948 48.2%, 0.956 50.6%, 0.967 53.1%, 0.979 55.5%, 0.991 58.0%, 1.000 60.6%, 1.007 63.2%, 1.011 65.8%, 1.013 68.4%, 1.012 71.1%, 1.010 73.9%, 1.007 76.6%, 1.004 79.4%, 1.001 82.2%, 0.999 85.1%, 0.998 88.0%, 0.997 91.0%, 0.997 93.9%, 0.998 96.9%, 1)',
  spring: 'linear(0, 0.015 1.5%, 0.059 3.0%, 0.125 4.6%, 0.209 6.2%, 0.306 7.8%, 0.411 9.5%, 0.519 11.2%, 0.625 13.0%, 0.727 14.8%, 0.819 16.6%, 0.901 18.4%, 0.971 20.3%, 1.028 22.3%, 1.071 24.2%, 1.100 26.2%, 1.118 28.3%, 1.126 30.3%, 1.125 32.4%, 1.116 34.6%, 1.103 36.8%, 1.087 39.0%, 1.069 41.3%, 1.051 43.5%, 1.034 45.9%, 1.019 48.2%, 1.007 50.6%, 0.997 53.1%, 0.990 55.5%, 0.986 58.0%, 0.984 60.6%, 0.984 63.2%, 0.985 65.8%, 0.988 68.4%, 0.990 71.1%, 0.993 73.9%, 0.995 76.6%, 0.998 79.4%, 0.999 82.2%, 1.001 85.1%, 1.002 88.0%, 1.002 91.0%, 1.002 93.9%, 1.002 96.9%, 1)',
  settle: 'linear(0, 0.010 1.5%, 0.038 3.0%, 0.081 4.6%, 0.137 6.2%, 0.202 7.8%, 0.274 9.5%, 0.350 11.2%, 0.428 13.0%, 0.505 14.8%, 0.581 16.6%, 0.653 18.4%, 0.720 20.3%, 0.782 22.3%, 0.836 24.2%, 0.884 26.2%, 0.925 28.3%, 0.960 30.3%, 0.987 32.4%, 1.009 34.6%, 1.024 36.8%, 1.035 39.0%, 1.042 41.3%, 1.045 43.5%, 1.046 45.9%, 1.044 48.2%, 1.041 50.6%, 1.036 53.1%, 1.031 55.5%, 1.026 58.0%, 1.021 60.6%, 1.017 63.2%, 1.012 65.8%, 1.009 68.4%, 1.005 71.1%, 1.003 73.9%, 1.001 76.6%, 1.000 79.4%, 0.999 82.2%, 0.998 85.1%, 0.998 88.0%, 0.998 91.0%, 0.998 93.9%, 0.998 96.9%, 1)',
} as const;
// 不认 linear() 的浏览器（很老的版本）：第二版的曲线本来就是 cubic-bezier，一样
const FALLBACK = CURVES;

export const EASE_OUT = SOFT;
export const EASE_IN = 'cubic-bezier(0.5, 0, 0.75, 0)';

export type Curve = keyof typeof CURVES;

let linearOk: boolean | null = null;
export function curve(name: Curve): string {
  linearOk ??= typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('transition-timing-function', 'linear(0, 1)');
  return linearOk ? CURVES[name] : FALLBACK[name];
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 有鼠标、能悬停的设备才做跟着指针的倾斜（触屏上没有悬停）
export function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
}

// el.animate 的安全版：假 DOM 里没有就返回 null
export function animate(el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (!el || typeof (el as Element).animate !== 'function') return null;
  return el.animate(frames, opts);
}

export function finished(list: Array<Animation | null>): Promise<void> {
  return Promise.all(list.map((a) => a?.finished.catch(() => undefined))).then(() => undefined);
}

// 在 requestAnimationFrame 里做（没有时直接做）
export function nextFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else fn();
}

export function setVar(el: HTMLElement, name: string, value: string): void {
  el.style.setProperty?.(name, value);
}

// 显示 / 收起一个元素：进场、退场各一组动画，收起的动画放完才设 hidden。
// 收起途中又要显示（比如来回点得很快）：取消退场，直接重新进场；显示途中收起同理
export class Presence {
  readonly el: HTMLElement;
  private anims: Animation[] = [];
  private token = 0;
  private leaving = false;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  // 正在显示（包括进场途中）；退场途中算已经收起
  get shown(): boolean {
    return !this.el.hidden && !this.leaving;
  }

  show(enter: () => Array<Animation | null>): void {
    this.stop();
    this.leaving = false;
    this.el.hidden = false;
    this.anims = enter().filter((a): a is Animation => !!a);
  }

  hide(exit: () => Array<Animation | null>): Promise<void> {
    if (this.el.hidden) return Promise.resolve();
    this.stop();
    const token = this.token;
    this.leaving = true;
    const list = exit().filter((a): a is Animation => !!a);
    this.anims = list;
    const done = (): void => {
      if (token !== this.token) return;
      this.el.hidden = true;
      this.leaving = false;
      this.stop();
    };
    if (list.length === 0) {
      done();
      return Promise.resolve();
    }
    return finished(list).then(done);
  }

  private stop(): void {
    this.token++;
    for (const a of this.anims) a.cancel();
    this.anims = [];
  }
}

// —— 共用元素过渡：从哪里「放大」出来 ——
// Museum 卡片、成员卡背面的作品小图被点开时记下它在屏幕上的位置；查看器打开时取走，从那里放大出来。
// 路由是异步的（改地址 → hashchange → 排队），所以中间隔着一点时间；超过 2 秒的不算（多半是别的操作）
let origin: { rect: DOMRect; at: number } | null = null;

export function setLaunchOrigin(el: Element): void {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) origin = { rect, at: performance.now() };
}

export function takeLaunchOrigin(): DOMRect | null {
  const o = origin;
  origin = null;
  return o && performance.now() - o.at < 2000 ? o.rect : null;
}

// 把 el 从 from 这个框（屏幕坐标）变到它现在的位置：返回动画；from 和现在差不多大、或者拿不到尺寸时返回 null
export function flipFrom(el: HTMLElement, from: DOMRect, opts: KeyframeAnimationOptions, reverse = false): Animation | null {
  const to = el.getBoundingClientRect();
  if (!to.width || !to.height) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const start = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  const frames: Keyframe[] = [{ transform: start, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }];
  return animate(el, reverse ? frames.reverse() : frames, opts);
}

// 屏幕里能看到这个框的大部分
export function onScreen(rect: DOMRect): boolean {
  if (rect.width < 4 || rect.height < 4) return false;
  const w = typeof innerWidth === 'number' ? innerWidth : 0;
  const h = typeof innerHeight === 'number' ? innerHeight : 0;
  return rect.bottom > 40 && rect.top < h - 40 && rect.right > 40 && rect.left < w - 40;
}

// —— 悬停倾斜 ——
// 指针在卡片上移动：layer 朝指针方向轻轻倾斜（--rx、--ry），高光跟着指针（--sx、--sy，像素）；离开时 CSS 用弹簧弹回。
// 读写都放在同一帧里做，一帧最多一次。触屏、减弱动效时不做（CSS 里那几个变量保持 0）
export function bindTilt(target: HTMLElement, layer: HTMLElement, max = 7): void {
  if (!finePointer()) return;
  let frame = 0;
  let px = 0;
  let py = 0;
  const apply = (): void => {
    frame = 0;
    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const u = Math.min(1, Math.max(0, (px - r.left) / r.width));
    const v = Math.min(1, Math.max(0, (py - r.top) / r.height));
    setVar(layer, '--rx', `${((0.5 - v) * 2 * max).toFixed(2)}deg`);
    setVar(layer, '--ry', `${((u - 0.5) * 2 * max).toFixed(2)}deg`);
    setVar(layer, '--sx', `${(u * r.width).toFixed(0)}px`);
    setVar(layer, '--sy', `${(v * r.height).toFixed(0)}px`);
  };
  target.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reducedMotion()) return;
    px = e.clientX;
    py = e.clientY;
    layer.dataset.tilt = 'on';
    if (!frame) frame = requestAnimationFrame(apply);
  });
  target.addEventListener('pointerleave', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    delete layer.dataset.tilt;
    setVar(layer, '--rx', '0deg');
    setVar(layer, '--ry', '0deg');
  });
}

// —— 焦点 ——
// 打开页面时记下原来的焦点，关掉时还回去（元素还在页面上、看得见才还）
export function activeElement(): HTMLElement | null {
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null | undefined) : null;
  return a && a !== document.body ? a : null;
}

export function focusQuietly(el: HTMLElement | null | undefined): void {
  if (el && typeof el.focus === 'function' && el.isConnected !== false) el.focus({ preventScroll: true });
}

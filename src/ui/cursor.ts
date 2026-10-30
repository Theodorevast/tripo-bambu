import './cursor.css';
import { approach, cursorMode, smoothDamp, spring, type CursorMode } from './cursorMath';

// 鼠标光标。指针本身是 CSS 的图（cursor.css：系统画的硬件光标，零延迟、高分屏清楚）；这里管两件事：
// 1. 跟随层：一个小圈用弹簧跟在指针后面（像 GSAP quickTo 做的跟随圈，这里自己写临界阻尼弹簧），快速移动时身后掉几颗小点。
//    指着能点的东西时圈张开，按下去缩一下；按住拖动时收紧，顺着拖的方向拉长一点（第一版），或者像转盘一样慢慢转（第二版，不要挤压拉伸）。
//    纯装饰：不接鼠标，只改 transform / opacity。每帧不新建对象：数都放在 Float64Array 里，函数只传下标；
//    写 DOM 用 Typed OM，值对象建好后只改数（没有 Typed OM 的浏览器退回拼字符串）。
//    指针停下、动画收住就停掉 rAF；指针移出窗口、标签页切走时藏起来；减弱动效时不要跟随层，光标图照旧
// 2. 在 3D 画布上按住拖动（转镜头、转星球）时，在 <html> 上标 data-cursor-drag：光标换成「拖着」那张（cursor.css）
// 指针下面是哪种光标，直接读那个元素光标计算值最后的关键字（cursor.css 里每张图都带着后备关键字）：
// 不用另外列一份「哪些东西能点」，画布上 JS 换的光标（星球、作品、翠宝）也自动跟上
// 只在 (hover: hover) and (pointer: fine) 下才有跟随层；触屏、粗指针不变

export interface CursorFx {
  setEnabled(on: boolean): void; // 测性能时 A/B 用：关掉跟随层（光标图、拖动时的光标照旧）
  setTiming(on: boolean): void; // 测性能用：每帧记一下跟随层自己花的时间（平时不记，省两次 performance.now）
  state(): { active: boolean; running: boolean; mode: CursorMode; dragging: boolean; away: boolean; frames: number; busyMs: number };
}

// 手感的几个数：cursor.css 里的 --cursor-*（第二版在 theme-v2.css 里改），装的时候读一次
interface Feel {
  follow: number;
  pop: number;
  stretch: number;
  spin: number;
  motes: number;
  moteGap: number;
  moteSpeed: number;
  moteLife: number;
  moteDrift: number;
}

function readFeel(): Feel {
  const cs = getComputedStyle(document.documentElement);
  const n = (name: string, fallback: number): number => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    follow: n('--cursor-follow', 0.07),
    pop: n('--cursor-pop', 0.55),
    stretch: n('--cursor-stretch', 0.42),
    spin: n('--cursor-spin', 0),
    motes: Math.max(0, Math.min(24, Math.round(n('--cursor-motes', 5)))),
    moteGap: Math.max(4, n('--cursor-mote-gap', 26)),
    moteSpeed: n('--cursor-mote-speed', 420),
    moteLife: Math.max(0.05, n('--cursor-mote-life', 0.32)),
    moteDrift: n('--cursor-mote-drift', 0),
  };
}

const TYPED_OM = typeof CSSTransformValue === 'function' && typeof CSS !== 'undefined' && typeof CSS.px === 'function' && 'attributeStyleMap' in HTMLElement.prototype;

// 一个元素的写入口：先把这一帧的值填进 cur，再 commit()（不带参数）。没变的值不写。
// 每个值存成整数，乘一个固定的单位（x、y 1/20 px，转角 0.1°，缩放、不透明度 1/1000）：
// 整数交给 Typed OM 是小整数（Smi），不像小数那样每写一次就在堆上装箱一个数；单位乘法由 CSS 的 calc() 做
const UNITS = [20, 20, 10, 1000, 1000, 1000];
class Sink {
  readonly cur = new Int32Array(6); // x、y、转角、横向缩放、纵向缩放、不透明度（都已经乘过 UNITS）
  private readonly last = new Int32Array(6).fill(-0x7fffffff);
  private readonly el: HTMLElement;
  private readonly n: CSSUnitValue[] = [];
  private readonly tf: CSSTransformValue | null = null;
  private readonly op: CSSMathProduct | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    if (TYPED_OM) {
      const n = (this.n = [CSS.number(0), CSS.number(0), CSS.number(0), CSS.number(1000), CSS.number(1000), CSS.number(0)]);
      const mul = (v: CSSUnitValue, unit: CSSUnitValue): CSSMathProduct => new CSSMathProduct(v, unit);
      this.tf = new CSSTransformValue([
        new CSSTranslate(mul(n[0], CSS.px(1 / 20)), mul(n[1], CSS.px(1 / 20))),
        new CSSRotate(mul(n[2], CSS.deg(0.1))),
        new CSSScale(mul(n[3], CSS.number(0.001)), mul(n[4], CSS.number(0.001))),
      ]);
      this.op = mul(n[5], CSS.number(0.001));
    }
  }

  commit(): void {
    const c = this.cur;
    const l = this.last;
    const tf = this.tf;
    if (tf && this.op) {
      const n = this.n;
      let moved = false;
      for (let i = 0; i < 5; i++) {
        if (c[i] === l[i]) continue;
        n[i].value = c[i];
        l[i] = c[i];
        moved = true;
      }
      if (moved) this.el.attributeStyleMap.set('transform', tf);
      if (c[5] !== l[5]) {
        n[5].value = c[5];
        l[5] = c[5];
        this.el.attributeStyleMap.set('opacity', this.op);
      }
    } else {
      if (c[0] !== l[0] || c[1] !== l[1] || c[2] !== l[2] || c[3] !== l[3] || c[4] !== l[4]) {
        this.el.style.transform = `translate(${c[0] / UNITS[0]}px, ${c[1] / UNITS[1]}px) rotate(${c[2] / UNITS[2]}deg) scale(${c[3] / UNITS[3]}, ${c[4] / UNITS[4]})`;
        for (let i = 0; i < 5; i++) l[i] = c[i];
      }
      if (c[5] !== l[5]) {
        this.el.style.opacity = String(c[5] / UNITS[5]);
        l[5] = c[5];
      }
    }
  }

  hide(): void {
    this.cur[5] = 0;
    this.commit();
  }
}

// 状态数组里的位置
const X = 0; // 小圈的位置、速度
const VX = 1;
const Y = 2;
const VY = 3;
const SCALE = 4; // 缩放、缩放的速度
const ALPHA = 6;
const STRETCH = 7;
const ANGLE = 8; // 速度方向（度）
const SPIN = 9; // 第二版转盘的转角（度）
const ACC = 10; // 离上一颗小点走了多远
const PX = 11; // 指针
const PY = 12;
const LAST = 13; // 上一帧的时间戳
const BUSY = 14; // 累计花在这里的毫秒数（setTiming 开着时才记）
const DT = 15; // 这一帧的秒数
const T_SCALE = 16; // 这一帧的目标：缩放、不透明度、拉长量，淡入淡出的快慢
const T_ALPHA = 17;
const T_STRETCH = 18;
const ALPHA_TAU = 19;
const FOLLOW = 20; // 手感：追随时间、缩放弹簧的阻尼比和角频率、拉长量的快慢
const POP = 21;
const OMEGA = 22;
const STRETCH_TAU = 23;
const T0 = 24; // 这一帧开始的时间（测性能）

class Follower {
  readonly box = document.createElement('div');
  over: Element | null = null; // 指针下面的元素
  modeDirty = false;
  mode: CursorMode = 'default';
  down = false;
  dragging = false;
  away = true; // 指针不在窗口里 / 标签页切走了：藏起来
  off = false; // 停用（减弱动效、测性能时关掉）
  running = false;
  timing = false;
  frames = 0;
  readonly s = new Float64Array(25);
  private readonly feel = readFeel();
  private readonly ring: Sink;
  private readonly motes: Sink[] = [];
  // 小点：起点、漂移、年龄、寿命、大小（年龄 ≥ 寿命 = 没在用）
  private readonly mx: Float32Array;
  private readonly my: Float32Array;
  private readonly mdx: Float32Array;
  private readonly mdy: Float32Array;
  private readonly mage: Float32Array;
  private readonly mlife: Float32Array;
  private readonly msize: Float32Array;
  private next = 0; // 下一颗用哪个槽（最旧的那颗）
  private live = 0;

  constructor() {
    const box = this.box;
    box.className = 'cursor-fx';
    box.setAttribute('aria-hidden', 'true');
    box.dataset.mode = 'default';
    const ring = document.createElement('div');
    ring.className = 'cursor-fx-ring';
    box.append(ring);
    this.ring = new Sink(ring);
    const n = this.feel.motes;
    for (let i = 0; i < n; i++) {
      const m = document.createElement('div');
      m.className = i % 3 === 2 ? 'cursor-fx-mote is-star' : 'cursor-fx-mote';
      box.append(m);
      this.motes.push(new Sink(m));
    }
    this.mx = new Float32Array(n);
    this.my = new Float32Array(n);
    this.mdx = new Float32Array(n);
    this.mdy = new Float32Array(n);
    this.mage = new Float32Array(n).fill(1);
    this.mlife = new Float32Array(n);
    this.msize = new Float32Array(n);
    document.body.append(box);
    // 先按最大的尺寸写一次（不透明度 0）：图层按这个尺寸栅格化，之后缩小不糊
    const c = this.ring.cur;
    c[0] = -2000; // -100px（单位见 UNITS）
    c[1] = -2000;
    c[3] = 1000;
    c[4] = 1000;
    this.ring.commit();
    const s = this.s;
    s[SCALE] = 0.62;
    s[LAST] = -1;
    s[FOLLOW] = this.feel.follow;
    s[POP] = this.feel.pop;
    s[OMEGA] = 30;
    s[STRETCH_TAU] = 0.05;
  }

  move(x: number, y: number): void {
    const s = this.s;
    s[PX] = x;
    s[PY] = y;
    if (this.away) {
      // 刚移进窗口：从指针这里出现，不从上次的位置飞过来
      this.away = false;
      s[X] = x;
      s[Y] = y;
      s[VX] = 0;
      s[VY] = 0;
    }
    this.wake();
  }

  hover(el: Element | null): void {
    this.over = el;
    this.modeDirty = true;
    this.wake();
  }

  // 指针移出窗口：淡掉
  leave(): void {
    this.away = true;
    this.wake();
  }

  // 标签页切走、停用：马上藏起来
  hideNow(): void {
    this.away = true;
    this.s[ALPHA] = 0;
    this.ring.hide();
    for (let i = 0; i < this.motes.length; i++) {
      this.mage[i] = this.mlife[i];
      this.motes[i].hide();
    }
    this.live = 0;
  }

  wake(): void {
    if (this.running || this.off) return;
    this.running = true;
    this.s[LAST] = -1;
    requestAnimationFrame(this.tick);
  }

  private readMode(): void {
    this.modeDirty = false;
    const el = this.over;
    const m = el?.isConnected ? cursorMode(getComputedStyle(el).cursor) : 'default';
    if (m !== this.mode) {
      this.mode = m;
      this.box.dataset.mode = m;
    }
  }

  private readonly tick = (t: number): void => {
    if (this.off) {
      this.running = false;
      return;
    }
    const s = this.s;
    const f = this.feel;
    if (this.timing) s[T0] = performance.now();
    s[DT] = s[LAST] < 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (t - s[LAST]) / 1000));
    s[LAST] = t;
    if (this.modeDirty) this.readMode();
    smoothDamp(s, X, PX, FOLLOW, DT);
    smoothDamp(s, Y, PY, FOLLOW, DT);
    const speed = Math.sqrt(s[VX] * s[VX] + s[VY] * s[VY]);
    // 现在该多大、多亮：拖着收紧；按下去缩一下；指着能点的张开；平时只在移动时露出来，越快越清楚，停下就淡掉
    const drag = this.dragging || this.mode === 'grabbing';
    const point = this.mode === 'pointer';
    if (this.away || this.mode === 'text') {
      s[T_SCALE] = 0.62;
      s[T_ALPHA] = 0;
    } else if (drag) {
      s[T_SCALE] = 0.5;
      s[T_ALPHA] = 0.8;
    } else if (this.down) {
      s[T_SCALE] = point ? 0.8 : 0.42;
      s[T_ALPHA] = point ? 0.8 : 0.55;
    } else if (point) {
      s[T_SCALE] = 1;
      s[T_ALPHA] = 0.8;
    } else {
      s[T_SCALE] = 0.62;
      s[T_ALPHA] = 0.55 * Math.min(1, speed / 900);
    }
    spring(s, SCALE, T_SCALE, OMEGA, POP, DT);
    s[ALPHA_TAU] = s[T_ALPHA] > s[ALPHA] ? 0.05 : 0.14;
    approach(s, ALPHA, T_ALPHA, ALPHA_TAU, DT);
    if (s[T_ALPHA] === 0 && s[ALPHA] < 0.01) s[ALPHA] = 0; // 已经看不见了：直接归零（小点还在飘时圈不再拖着一点点亮）
    // 顺着速度方向拉长（拖动时多一些），或者（第二版）走多远转多少
    s[T_STRETCH] = f.stretch * Math.min(1, speed / 1600) * (drag ? 1 : 0.35);
    approach(s, STRETCH, T_STRETCH, STRETCH_TAU, DT);
    if (speed > 40) s[ANGLE] = Math.atan2(s[VY], s[VX]) * (180 / Math.PI);
    s[SPIN] = (s[SPIN] + f.spin * speed * s[DT] * (drag ? 1 : 0.2)) % 360;
    // 小点：小圈快过 moteSpeed 时，每走 moteGap px 在它身后放一颗（用最旧的那个槽）。
    // 直接写在这里、不另开函数：放小点的帧不多，单独的函数一直到不了优化，里面的小数运算会一个个装箱
    if (this.motes.length > 0 && speed > f.moteSpeed && !this.away && this.mode !== 'text') {
      s[ACC] += speed * s[DT];
      if (s[ACC] >= f.moteGap) {
        s[ACC] = 0;
        const i = this.next;
        this.next = (i + 1) % this.motes.length;
        if (this.mage[i] >= this.mlife[i]) this.live++;
        this.mx[i] = s[X];
        this.my[i] = s[Y];
        this.mdx[i] = (Math.random() - 0.5) * f.moteDrift;
        this.mdy[i] = -(0.3 + 0.7 * Math.random()) * f.moteDrift; // 往上飘一点（星尘）
        this.mage[i] = 0;
        this.mlife[i] = f.moteLife * (0.8 + 0.4 * Math.random());
        this.msize[i] = 0.65 + 0.35 * Math.random();
      }
    }
    if (this.live > 0) this.stepMotes();
    const settled = this.live === 0 && speed < 1 && Math.abs(s[X] - s[PX]) < 0.05 && Math.abs(s[Y] - s[PY]) < 0.05
      && Math.abs(s[SCALE] - s[T_SCALE]) < 0.002 && Math.abs(s[SCALE + 1]) < 0.01 && Math.abs(s[ALPHA] - s[T_ALPHA]) < 0.01 && s[STRETCH] < 0.002;
    if (settled) {
      // 收住了：对齐到终点，停掉 rAF（下一次指针动、状态变时再叫醒）
      s[X] = s[PX];
      s[Y] = s[PY];
      s[VX] = 0;
      s[VY] = 0;
      s[SCALE] = s[T_SCALE];
      s[SCALE + 1] = 0;
      s[ALPHA] = s[T_ALPHA];
      s[STRETCH] = 0;
      this.running = false;
    } else requestAnimationFrame(this.tick);
    // 写进去（整数，单位见 UNITS：位置 1/20 px、转角 0.1°、缩放和不透明度 1/1000）：收尾时几乎不动的帧就不写 DOM
    const c = this.ring.cur;
    const k = 1 + s[STRETCH];
    c[0] = Math.round(s[X] * 20);
    c[1] = Math.round(s[Y] * 20);
    c[2] = f.stretch > 0 ? (s[STRETCH] > 0.002 ? Math.round(s[ANGLE] * 10) : c[2]) : Math.round(s[SPIN] * 10);
    c[3] = Math.round(s[SCALE] * k * 1000);
    c[4] = Math.round((s[SCALE] / k) * 1000);
    c[5] = Math.round(Math.max(0, s[ALPHA]) * 1000);
    this.ring.commit();
    this.frames++;
    if (this.timing) s[BUSY] += performance.now() - s[T0];
  };

  private stepMotes(): void {
    const dt = this.s[DT];
    for (let i = 0; i < this.motes.length; i++) {
      const life = this.mlife[i];
      if (this.mage[i] >= life) continue;
      const age = this.mage[i] + dt;
      this.mage[i] = age;
      const m = this.motes[i];
      if (age >= life) {
        m.hide();
        this.live--;
        continue;
      }
      const u = age / life;
      const e = 1 - (1 - u) * (1 - u);
      const size = this.msize[i] * (1 - 0.5 * u);
      const c = m.cur;
      c[0] = Math.round((this.mx[i] + this.mdx[i] * e) * 20);
      c[1] = Math.round((this.my[i] + this.mdy[i] * e) * 20);
      c[3] = Math.round(size * 1000);
      c[4] = c[3];
      // 一出来很快亮起，然后慢慢淡掉
      c[5] = Math.round(0.75 * Math.min(1, u * 6) * (1 - u) * (1 - u) * 1000);
      m.commit();
    }
  }
}

// main.ts 调一次
export function installCursor(): CursorFx {
  const root = document.documentElement;
  const stage = document.querySelector<HTMLCanvasElement>('#stage');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true;
  let built: Follower | null = null; // 第一次需要时才建（触屏上从来不建）
  let fx: Follower | null = null; // 正在用的跟随层；停用时为 null
  let down = false;
  let dragging = false;
  let onStage = false;
  let downX = 0;
  let downY = 0;

  const sync = (): void => {
    const want = enabled && fine.matches && !reduce.matches;
    if (want && !fx) {
      fx = built ??= new Follower();
      fx.off = false;
    } else if (!want && fx) {
      fx.off = true;
      fx.hideNow();
      fx = null;
    }
  };
  sync();
  fine.addEventListener('change', sync);
  reduce.addEventListener('change', sync);

  const endDrag = (): void => {
    if (!down) return;
    down = false;
    dragging = false;
    root.removeAttribute('data-cursor-drag');
    if (fx) {
      fx.down = false;
      fx.dragging = false;
      fx.modeDirty = true; // :active 的光标（查看器画布的 grabbing）跟着变回来
      fx.wake();
    }
  };
  const opts = { capture: true, passive: true };
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    down = true;
    dragging = false;
    downX = e.clientX;
    downY = e.clientY;
    onStage = e.target === stage;
    if (fx) {
      fx.down = true;
      fx.modeDirty = true;
      fx.move(e.clientX, e.clientY);
    }
  }, opts);
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      fx?.hideNow();
      return;
    }
    if (down && (e.buttons & 1) === 0) endDrag(); // 在窗口外面松开、没收到 pointerup
    if (down && !dragging && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) {
      dragging = true;
      if (onStage) root.setAttribute('data-cursor-drag', '');
      if (fx) {
        fx.dragging = true;
        fx.modeDirty = true;
      }
    }
    fx?.move(e.clientX, e.clientY);
  }, opts);
  addEventListener('pointerup', endDrag, opts);
  addEventListener('pointercancel', endDrag, opts);
  addEventListener('blur', endDrag);
  addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'touch') fx?.hover(e.target instanceof Element ? e.target : null);
  }, opts);
  // 指针移出窗口（relatedTarget 为空）：淡掉；标签页切走：马上藏起来
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) fx?.leave();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) fx?.hideNow();
  });
  // 画布的光标是 JS 改行内样式换的（指到星球、作品、翠宝上）：光标真的变了才重新读（星系页每次 pointermove 都会重写一遍同样的值）
  if (stage) {
    let inline = stage.style.cursor;
    new MutationObserver(() => {
      const c = stage.style.cursor;
      if (c === inline) return;
      inline = c;
      if (fx && fx.over === stage) {
        fx.modeDirty = true;
        fx.wake();
      }
    }).observe(stage, { attributes: true, attributeFilter: ['style'] });
  }

  const api: CursorFx = {
    setEnabled(on) {
      enabled = on;
      sync();
    },
    setTiming(on) {
      if (built) built.timing = on;
    },
    state: () => ({
      active: !!fx,
      running: !!fx?.running,
      mode: built?.mode ?? 'default',
      dragging,
      away: built?.away ?? true,
      frames: built?.frames ?? 0,
      busyMs: built?.s[BUSY] ?? 0,
    }),
  };
  window.__cursorFx = api;
  return api;
}

import './cursor.css';
import { approach, cursorMode, smoothDamp, spring, type CursorMode } from './cursorMath';

// 鼠标光标。指针本身是 CSS 的图（cursor.css：系统画的硬件光标，零延迟、高分屏清楚）；这里管两件事：
// 1. 跟随层：一个小圈用弹簧跟在指针后面（像 GSAP quickTo 做的跟随圈，这里自己写临界阻尼弹簧），快速移动时身后掉几颗小点。
//    指着能点的东西时圈张开，按下去缩一下；按住拖动时收紧，顺着拖的方向拉长一点（第一版），或者像转盘一样慢慢转（第二版，不要挤压拉伸）。
//    纯装饰：不接鼠标，只改 transform / opacity；每帧不新建对象（Typed OM 的值对象建好后只改数；没有 Typed OM 的浏览器退回拼字符串）。
//    指针停下、动画收住就停掉 rAF；指针移出窗口、标签页切走时藏起来；减弱动效时不要跟随层，光标图照旧
// 2. 在 3D 画布上按住拖动（转镜头、转星球）时，在 <html> 上标 data-cursor-drag：光标换成「拖着」那张（cursor.css）
// 指针下面是哪种光标，直接读那个元素光标计算值最后的关键字（cursor.css 里每张图都带着后备关键字）：
// 不用另外列一份「哪些东西能点」，画布上 JS 换的光标（星球、作品、翠宝）也自动跟上
// 只在 (hover: hover) and (pointer: fine) 下才有跟随层；触屏、粗指针不变

export interface CursorFx {
  setEnabled(on: boolean): void; // 测性能时 A/B 用：关掉跟随层（光标图、拖动时的光标照旧）
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

// 一个元素的写入口：位置、转角、缩放、不透明度
class Sink {
  private readonly el: HTMLElement;
  private readonly v: CSSUnitValue[] = []; // x、y、转角、横向缩放、纵向缩放、不透明度
  private readonly tf: CSSTransformValue | null = null;
  private opacity = -1;

  constructor(el: HTMLElement) {
    this.el = el;
    if (TYPED_OM) {
      this.v = [CSS.px(0), CSS.px(0), CSS.deg(0), CSS.number(1), CSS.number(1), CSS.number(0)];
      this.tf = new CSSTransformValue([new CSSTranslate(this.v[0], this.v[1]), new CSSRotate(this.v[2]), new CSSScale(this.v[3], this.v[4])]);
    }
  }

  write(x: number, y: number, deg: number, sx: number, sy: number, opacity: number): void {
    const tf = this.tf;
    if (tf) {
      const v = this.v;
      v[0].value = x;
      v[1].value = y;
      v[2].value = deg;
      v[3].value = sx;
      v[4].value = sy;
      this.el.attributeStyleMap.set('transform', tf);
      if (opacity !== this.opacity) {
        v[5].value = opacity;
        this.el.attributeStyleMap.set('opacity', v[5]);
      }
    } else {
      this.el.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg) scale(${sx}, ${sy})`;
      if (opacity !== this.opacity) this.el.style.opacity = String(opacity);
    }
    this.opacity = opacity;
  }

  hide(): void {
    if (this.opacity === 0) return;
    if (this.tf) {
      this.v[5].value = 0;
      this.el.attributeStyleMap.set('opacity', this.v[5]);
    } else this.el.style.opacity = '0';
    this.opacity = 0;
  }
}

// 不透明度留三位小数：没变就不写
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// 状态数组里的位置（每帧要改的数都放在 Float64Array 里，不在对象上新建数字）
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
const BUSY = 14; // 累计花在这里的毫秒数（测性能用）

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
  frames = 0;
  readonly s = new Float64Array(16);
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
    this.ring.write(-100, -100, 0, 1, 1, 0);
    this.s[SCALE] = 0.62;
    this.s[LAST] = -1;
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
    const t0 = performance.now();
    const s = this.s;
    const f = this.feel;
    const dt = s[LAST] < 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (t - s[LAST]) / 1000));
    s[LAST] = t;
    if (this.modeDirty) this.readMode();
    smoothDamp(s, X, s[PX], f.follow, dt);
    smoothDamp(s, Y, s[PY], f.follow, dt);
    const speed = Math.hypot(s[VX], s[VY]);
    // 现在该多大、多亮：拖着收紧；按下去缩一下；指着能点的张开；平时只在移动时露出来，越快越清楚，停下就淡掉
    const drag = this.dragging || this.mode === 'grabbing';
    const point = this.mode === 'pointer';
    let scale: number;
    let alpha: number;
    if (this.away || this.mode === 'text') {
      scale = 0.62;
      alpha = 0;
    } else if (drag) {
      scale = 0.5;
      alpha = 0.8;
    } else if (this.down) {
      scale = point ? 0.8 : 0.42;
      alpha = point ? 0.8 : 0.55;
    } else if (point) {
      scale = 1;
      alpha = 0.8;
    } else {
      scale = 0.62;
      alpha = 0.55 * Math.min(1, speed / 900);
    }
    spring(s, SCALE, scale, 30, f.pop, dt);
    s[ALPHA] = approach(s[ALPHA], alpha, alpha > s[ALPHA] ? 0.05 : 0.14, dt);
    // 顺着速度方向拉长（拖动时多一些），或者（第二版）走多远转多少
    s[STRETCH] = approach(s[STRETCH], f.stretch * Math.min(1, speed / 1600) * (drag ? 1 : 0.35), 0.05, dt);
    if (speed > 40) s[ANGLE] = Math.atan2(s[VY], s[VX]) * (180 / Math.PI);
    s[SPIN] = (s[SPIN] + f.spin * speed * dt * (drag ? 1 : 0.2)) % 360;
    const k = 1 + s[STRETCH];
    const rot = f.stretch > 0 ? s[ANGLE] : s[SPIN];
    this.ring.write(s[X], s[Y], rot, s[SCALE] * k, s[SCALE] / k, round3(Math.max(0, s[ALPHA])));
    // 小点：小圈快过 moteSpeed 时，每走 moteGap px 在它身后放一颗
    if (this.motes.length > 0 && speed > f.moteSpeed && !this.away && this.mode !== 'text') {
      s[ACC] += speed * dt;
      if (s[ACC] >= f.moteGap) {
        s[ACC] = 0;
        this.spawn();
      }
    }
    if (this.live > 0) this.stepMotes(dt);
    const settled = this.live === 0 && speed < 1 && Math.abs(s[X] - s[PX]) < 0.05 && Math.abs(s[Y] - s[PY]) < 0.05
      && Math.abs(s[SCALE] - scale) < 0.002 && Math.abs(s[SCALE + 1]) < 0.01 && Math.abs(s[ALPHA] - alpha) < 0.01 && s[STRETCH] < 0.002;
    if (settled) {
      // 收住了：对齐到终点，停掉 rAF（下一次指针动、状态变时再叫醒）
      s[X] = s[PX];
      s[Y] = s[PY];
      s[VX] = 0;
      s[VY] = 0;
      s[SCALE] = scale;
      s[SCALE + 1] = 0;
      s[ALPHA] = alpha;
      s[STRETCH] = 0;
      this.ring.write(s[X], s[Y], rot, scale, scale, round3(alpha));
      this.running = false;
    } else requestAnimationFrame(this.tick);
    this.frames++;
    s[BUSY] += performance.now() - t0;
  };

  private spawn(): void {
    const i = this.next;
    this.next = (i + 1) % this.motes.length;
    if (this.mage[i] >= this.mlife[i]) this.live++;
    const s = this.s;
    const drift = this.feel.moteDrift;
    this.mx[i] = s[X];
    this.my[i] = s[Y];
    this.mdx[i] = (Math.random() - 0.5) * drift;
    this.mdy[i] = -(0.3 + 0.7 * Math.random()) * drift; // 往上飘一点（星尘）
    this.mage[i] = 0;
    this.mlife[i] = this.feel.moteLife * (0.8 + 0.4 * Math.random());
    this.msize[i] = 0.65 + 0.35 * Math.random();
  }

  private stepMotes(dt: number): void {
    for (let i = 0; i < this.motes.length; i++) {
      const life = this.mlife[i];
      if (this.mage[i] >= life) continue;
      const age = this.mage[i] + dt;
      this.mage[i] = age;
      if (age >= life) {
        this.motes[i].hide();
        this.live--;
        continue;
      }
      const u = age / life;
      const e = 1 - (1 - u) * (1 - u);
      const size = this.msize[i] * (1 - 0.5 * u);
      // 一出来很快亮起，然后慢慢淡掉
      this.motes[i].write(this.mx[i] + this.mdx[i] * e, this.my[i] + this.mdy[i] * e, 0, size, size, round3(0.75 * Math.min(1, u * 6) * (1 - u) * (1 - u)));
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
    if (down && !dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) {
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
  // 画布的光标是 JS 改行内样式换的（指到星球、作品、翠宝上）：样式一变就重新读
  if (stage) {
    new MutationObserver(() => {
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
    state: () => ({
      active: !!fx,
      running: !!fx?.running,
      mode: built?.mode ?? 'default',
      away: built?.away ?? true,
      dragging,
      frames: built?.frames ?? 0,
      busyMs: built?.s[BUSY] ?? 0,
    }),
  };
  window.__cursorFx = api;
  return api;
}

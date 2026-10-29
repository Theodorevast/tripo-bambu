import { Pane } from 'tweakpane';
import { el } from './dom';
import { icon, iconSvg, type IconName } from './icons';
import { animate, curve, EASE_IN, EASE_OUT, finished, reducedMotion } from './motion';
import { friendlyLabel } from './tuneLabels';
import './tune.css';

// 调参面板的外壳：浮在右边的一本小手账。头部能拖、能收成一个小按钮；左边一列贴纸标签，每个顶层分组一页；底部复制参数。
// 各模块照旧往「面板」上 addFolder：这里的 root 收到顶层 addFolder 时新开一页（每页一个 Tweakpane），返回那一页，
// 模块接着往里加参数、子分组，和以前完全一样（tune.ts、postTune.ts、water.ts……都不用知道外壳的事）。
// 位置、收起没有、停在哪一页记在 localStorage 里，刷新后还原。手机竖屏上是贴底的半屏抽屉，标签横排，不能拖

export interface TuneEvents {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
export interface TuneFolder extends TuneEvents {
  addFolder(params: { title: string; expanded?: boolean }): TuneFolder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): TuneEvents;
  addButton(params: { title: string }): TuneEvents;
}

interface Group {
  icon: IconName;
  color: string;
}

// 每组一个图标和颜色（颜色也用在这一页的滑块、开关、抽屉上）；没登记的新分组用小星星
const GROUPS: Record<string, Group> = {
  Planet: { icon: 'planet', color: '#e9875f' },
  Water: { icon: 'drop', color: '#3aa9c8' },
  'Works & gardens': { icon: 'flower', color: '#e7799f' },
  Grass: { icon: 'grass', color: '#62b357' },
  'Sky & light': { icon: 'sun', color: '#4b9fe0' },
  Look: { icon: 'palette', color: '#9a80dc' },
  Life: { icon: 'leaf', color: '#8cb43a' },
  Transitions: { icon: 'cloud', color: '#ef9550' },
  Coupons: { icon: 'ticket', color: '#dc5d6c' },
  Camera: { icon: 'camera', color: '#5f80d6' },
  'Museum & viewer': { icon: 'frame', color: '#c4895a' },
  Performance: { icon: 'gauge', color: '#dda000' },
};
const OTHER: Group = { icon: 'sparkle', color: '#a58ab0' };

interface Page {
  title: string;
  group: Group;
  tab: HTMLButtonElement;
  page: HTMLDivElement;
  pane: TuneFolder;
}

interface Saved {
  collapsed?: boolean;
  x?: number;
  y?: number;
  tab?: string;
}

const STORE_KEY = 'community-planets:tune';
const COMPACT = '(max-width: 640px)';

// 每一层分组都包一层：addBinding 时把标签换成人话（没写 label 的用参数名，见 tuneLabels.ts）；addFolder 建出来的子分组同样包上。
// 其余方法原样转给 Tweakpane（this 绑回原对象）
function friendly(real: TuneFolder): TuneFolder {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'addFolder') return (params: { title: string; expanded?: boolean }) => friendly(target.addFolder(params));
      if (prop === 'addBinding') {
        return (obj: object, key: string, params?: Record<string, unknown>) =>
          target.addBinding(obj as Record<string, unknown>, key, { ...params, label: friendlyLabel(String(params?.label ?? key)) });
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function readSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Saved) : {};
  } catch {
    return {};
  }
}

export class TuneShell {
  // 交给各模块的「面板」：顶层 addFolder = 新开一页
  readonly root: TuneFolder;
  private readonly node = el('div', { className: 'tune-pane' });
  private readonly card = el('section', { className: 'tune-card' });
  private readonly fab = el('button', { className: 'tune-fab', type: 'button' });
  private readonly head = el('header', { className: 'tune-head' });
  private readonly sub = el('span', {});
  private readonly rail = el('nav', { className: 'tune-rail' });
  private readonly plate = el('i', { className: 'tune-plate' });
  private readonly tip = el('div', { className: 'tune-tip' });
  private readonly body = el('div', { className: 'tune-body' });
  private readonly copyButton = el('button', { className: 'tune-copy', type: 'button' });
  private readonly copyIcon = el('span', { className: 'tune-copy-icon' });
  private readonly copyLabel = el('span', { className: 'tune-copy-label', textContent: 'Copy parameters' });
  private readonly status = el('span', { className: 'tune-sr' });
  private readonly pages: Page[] = [];
  private readonly onCopy: () => Promise<boolean>;
  private readonly saved: Saved;
  private current = -1;
  private collapsed: boolean;
  private autoTucked = false; // Members / Museum 打开时自动收起的（关掉后自动展开；手动操作过就不算）
  private x: number;
  private y: number;
  private toggling: Animation[] = [];
  private copyTimer = 0;
  private misc: TuneFolder | null = null;

  constructor(onCopy: () => Promise<boolean>) {
    this.onCopy = onCopy;
    this.saved = readSaved();
    this.collapsed = this.saved.collapsed ?? matchMedia(COMPACT).matches; // 手机上第一次打开默认收起，不挡画面
    this.x = Number.isFinite(this.saved.x) ? this.saved.x! : 0;
    this.y = Number.isFinite(this.saved.y) ? this.saved.y! : 0;

    const badge = icon('sliders', 'tune-badge');
    const min = el('button', { className: 'tune-min', type: 'button', title: 'Tuck away', onclick: () => this.setCollapsed(true) }, icon('minus'));
    min.setAttribute('aria-label', 'Tuck the tuning panel away');
    this.sub.className = 'tune-sub';
    const grip = icon('grip', 'tune-grip');
    grip.title = 'Drag to move · double-click to dock';
    this.head.append(grip, badge, el('div', { className: 'tune-titles' }, el('b', { className: 'tune-title', textContent: 'Tune' }), this.sub), min);
    this.rail.setAttribute('role', 'tablist');
    this.rail.setAttribute('aria-label', 'Parameter groups');
    this.rail.append(this.plate);
    this.rail.addEventListener('keydown', (e) => this.onRailKey(e));
    this.rail.addEventListener('scroll', () => this.hideTip());
    this.copyIcon.innerHTML = iconSvg('clipboard');
    this.copyButton.append(this.copyIcon, this.copyLabel);
    this.copyButton.addEventListener('click', () => void this.copy());
    this.status.setAttribute('role', 'status');
    this.card.setAttribute('aria-label', 'Tuning panel');
    this.card.append(this.head, el('div', { className: 'tune-main' }, this.rail, this.body, this.tip), el('footer', { className: 'tune-foot' }, this.copyButton, this.status));
    this.fab.append(icon('sliders'));
    this.fab.title = 'Tune';
    this.fab.setAttribute('aria-label', 'Open the tuning panel');
    this.node.append(this.card, this.fab);
    document.body.append(this.node);

    this.card.hidden = this.collapsed;
    this.fab.hidden = !this.collapsed;
    this.applyPosition();
    this.clamp(false); // 上次拖到的位置在这个窗口里可能出界了
    this.bindDrag(this.head, null);
    this.bindDrag(this.fab, () => this.setCollapsed(false));
    this.head.addEventListener('dblclick', (e) => {
      if ((e.target as Element).closest('button')) return;
      this.x = 0;
      this.y = 0;
      this.applyPosition();
      this.updateSide();
      this.save();
    });
    addEventListener('resize', () => this.clamp(false));
    matchMedia(COMPACT).addEventListener('change', () => this.movePlate(false));
    this.watchSheets();
    // 第一次出现：面板（或小按钮）弹出来
    if (!reducedMotion()) {
      const target = this.collapsed ? this.fab : this.card;
      animate(target, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'none' }], { duration: 640, easing: curve('spring'), delay: 150, fill: 'backwards' });
    }

    this.root = {
      addFolder: ({ title }) => this.addPage(title),
      // 顶层直接加参数、按钮（现在没有模块这么做）：放进「More」这一页
      addBinding: (target, key, params) => this.more().addBinding(target, key, params),
      addButton: (params) => this.more().addButton(params),
      on: (event, handler) => {
        for (const p of this.pages) p.pane.on(event, handler);
        return this.root;
      },
    };
  }

  // —— 分页 ——

  private addPage(title: string): TuneFolder {
    const group = GROUPS[title] ?? OTHER;
    const index = this.pages.length;
    const tab = el('button', { className: 'tune-tab', type: 'button', id: `tune-tab-${index}` }, icon(group.icon), el('span', { className: 'tune-sr', textContent: title }));
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', `tune-page-${index}`);
    tab.tabIndex = -1;
    tab.style.setProperty('--tc', group.color);
    tab.addEventListener('click', () => this.select(index, true));
    tab.addEventListener('pointerenter', () => this.showTip(index));
    tab.addEventListener('pointerleave', () => this.hideTip());
    tab.addEventListener('focus', () => { if (tab.matches(':focus-visible')) this.showTip(index); });
    tab.addEventListener('blur', () => this.hideTip());
    const page = el('div', { className: 'tune-page', id: `tune-page-${index}` });
    page.setAttribute('role', 'tabpanel');
    page.setAttribute('aria-labelledby', tab.id);
    page.style.setProperty('--c', group.color);
    page.hidden = true;
    this.rail.append(tab);
    this.body.append(page);
    const pane = friendly(new Pane({ container: page }) as unknown as TuneFolder);
    this.pages.push({ title, group, tab, page, pane });
    // 第一页先选上；上次停在哪一页，那一页加进来时换过去（都不播动画）
    if (this.current < 0 || title === this.saved.tab) this.select(index, false);
    return pane;
  }

  private more(): TuneFolder {
    this.misc ??= this.addPage('More');
    return this.misc;
  }

  private select(index: number, animated: boolean): void {
    const next = this.pages[index];
    if (!next || index === this.current) return;
    const prev = this.pages[this.current];
    const dir = index > this.current ? 1 : -1;
    this.current = index;
    for (const p of this.pages) {
      const on = p === next;
      p.tab.setAttribute('aria-selected', String(on));
      p.tab.tabIndex = on ? 0 : -1;
    }
    this.card.style.setProperty('--c', next.group.color);
    this.sub.replaceChildren(el('span', { textContent: next.title }));
    if (prev) prev.page.hidden = true;
    next.page.hidden = false;
    this.body.scrollTop = 0;
    this.movePlate(animated);
    if (!animated) return;
    this.save();
    if (reducedMotion()) {
      animate(next.page, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      return;
    }
    // 新的一页从切换的方向滑进来；标签上的图标蹦一下；头部的组名换上来
    animate(next.page, [{ opacity: 0, transform: `translateY(${dir * 16}px)` }, { opacity: 1, transform: 'none' }], { duration: 460, easing: curve('spring') });
    animate(next.tab.querySelector('.icon'), [{ transform: 'scale(0.7) rotate(-14deg)' }, { transform: 'scale(1.06)' }], { duration: 560, easing: curve('bounce') });
    animate(this.sub, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE_OUT });
  }

  // 白色小板滑到选中的标签下面（竖排上下滑，手机上横排左右滑）
  private movePlate(animated: boolean): void {
    const tab = this.pages[this.current]?.tab;
    if (!tab) return;
    if (animated) delete this.plate.dataset.still;
    else this.plate.dataset.still = '';
    this.plate.style.transform = matchMedia(COMPACT).matches ? `translateX(${tab.offsetLeft}px)` : `translateY(${tab.offsetTop}px)`;
    if (!animated) requestAnimationFrame(() => delete this.plate.dataset.still);
    // 选中的标签滚进视野里（标签多、屏幕矮时）
    tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private onRailKey(e: KeyboardEvent): void {
    const n = this.pages.length;
    const moves: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    let to = -1;
    if (e.key in moves) to = (this.current + moves[e.key] + n) % n;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    this.select(to, true);
    this.pages[to].tab.focus();
  }

  private showTip(index: number): void {
    const tab = this.pages[index]?.tab;
    if (!tab || matchMedia(COMPACT).matches) return;
    this.tip.textContent = this.pages[index].title;
    this.tip.style.top = `${tab.offsetTop - this.rail.scrollTop + tab.offsetHeight / 2}px`;
    this.tip.dataset.on = '';
  }

  private hideTip(): void {
    delete this.tip.dataset.on;
  }

  // —— 收起 / 展开 ——

  // Members / Museum / 查看器打开时，面板自动收成小按钮，不盖住页面右边；这些都关掉后，如果是自动收起的就再展开。
  // 页面开着时手动展开（或收起），以手动为准
  private watchSheets(): void {
    const app = document.querySelector('#app');
    if (!app) return;
    // 只在「有页面开着」这件事变了的时候动（#app 里别的元素也常切 hidden，比如悬浮标签）
    let wasOpen = false;
    const update = (): void => {
      const open = !!app.querySelector(':scope > .sheet:not([hidden]), :scope > .viewer:not([hidden])');
      if (open === wasOpen) return;
      wasOpen = open;
      if (open && !this.collapsed) {
        this.autoTucked = true; // 先标上：setCollapsed 里存档时就知道这次是自动的
        this.setCollapsed(true, false);
      } else if (!open && this.autoTucked) {
        this.autoTucked = false;
        this.setCollapsed(false, false);
      }
    };
    new MutationObserver(update).observe(app, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    update();
  }

  // byUser：点了收起按钮或小按钮（焦点跟过去、记下这个选择）；自动收起 / 展开时不动焦点
  private setCollapsed(on: boolean, byUser = true): void {
    if (byUser) this.autoTucked = false;
    if (on === this.collapsed) return;
    this.collapsed = on;
    this.save();
    this.hideTip();
    for (const a of this.toggling) a.cancel();
    this.toggling = [];
    const reduce = reducedMotion();
    const show = on ? this.fab : this.card;
    const hide = on ? this.card : this.fab;
    show.hidden = false;
    const grow = reduce
      ? animate(show, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 })
      : animate(show, on
        ? [{ opacity: 0, transform: 'scale(0.2) rotate(-80deg)' }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0, transform: 'scale(0.18)' }, { opacity: 1, transform: 'none' }], { duration: on ? 620 : 600, easing: curve(on ? 'bounce' : 'spring'), delay: on ? 90 : 0, fill: 'backwards' });
    const shrink = animate(hide, reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: on ? 'scale(0.2)' : 'scale(0.4)' }], { duration: on ? 230 : 150, easing: EASE_IN, fill: 'forwards' });
    this.toggling = [grow, shrink].filter((a): a is Animation => !!a);
    void finished([shrink]).then(() => {
      if (this.collapsed !== on) return;
      hide.hidden = true;
      shrink?.cancel();
    });
    if (!on) {
      this.movePlate(false);
      this.clamp(true); // 小按钮可能被拖到了边上：展开后整块面板尽量都在屏幕里
    }
    if (byUser) (on ? this.fab : this.copyButton).focus({ preventScroll: true });
  }

  // —— 拖动 ——
  // 按住头部（或收起后的小按钮）拖：位置用 translate（只动 transform），跟手不过渡；松手后夹回屏幕里、记下来。
  // 小按钮上没拖动（移动不到 4px）就算点击：展开
  private bindDrag(handle: HTMLElement, onTap: (() => void) | null): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (handle === this.head && (e.target as Element).closest('button')) return;
      const compact = matchMedia(COMPACT).matches;
      if (compact && !onTap) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const x0 = this.x;
      const y0 = this.y;
      let moved = false;
      let ended = false;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (compact || (!moved && Math.hypot(dx, dy) < 4)) return;
        if (!moved) {
          moved = true;
          this.node.dataset.drag = 'on';
          this.hideTip();
        }
        this.x = x0 + dx;
        this.y = y0 + dy;
        this.applyPosition();
      };
      const end = (ev: Event): void => {
        if (ended) return;
        ended = true;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        handle.removeEventListener('lostpointercapture', end);
        if (moved) {
          delete this.node.dataset.drag;
          this.clamp(false);
          this.save();
        } else if (onTap && ev.type === 'pointerup') onTap();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
    });
    // 键盘：小按钮回车、空格展开（button 自带）；拖动只给指针
    if (onTap) handle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(); } });
  }

  // 只改 translate，不读布局（拖动时每次移动都调）
  private applyPosition(): void {
    this.node.style.translate = `${Math.round(this.x)}px ${Math.round(this.y)}px`;
  }

  // 面板靠左时，标签的名字从右边冒出来（松手、夹回屏幕后算一次）
  private updateSide(): void {
    if (this.node.getBoundingClientRect().left < 150) this.node.dataset.side = 'right';
    else delete this.node.dataset.side;
  }

  // 夹回屏幕里：至少露出 64px 宽、头部不出上下边。whole：尽量整块都在屏幕里（展开时）
  private clamp(whole: boolean): void {
    if (matchMedia(COMPACT).matches) return;
    const box = (this.collapsed ? this.fab : this.card).getBoundingClientRect();
    if (!box.width) return;
    const keep = whole ? box.width : 64;
    const baseL = box.left - this.x;
    const baseT = box.top - this.y;
    const minX = 8 - baseL - (box.width - keep);
    const maxX = innerWidth - 8 - baseL - keep;
    const minY = 8 - baseT;
    const maxY = innerHeight - (whole ? Math.min(box.height, innerHeight - 16) : 56) - 8 - baseT;
    const x = Math.min(Math.max(this.x, minX), Math.max(minX, maxX));
    const y = Math.min(Math.max(this.y, minY), Math.max(minY, maxY));
    if (x !== this.x || y !== this.y) {
      this.x = x;
      this.y = y;
      this.applyPosition();
      this.save();
    }
    this.updateSide();
  }

  private save(): void {
    // 自动收起的不算数：记的是用户自己的选择
    const data: Saved = { collapsed: this.collapsed && !this.autoTucked, x: Math.round(this.x), y: Math.round(this.y), tab: this.pages[this.current]?.title };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      // 存不了（隐私模式等）就算了，下次按默认来
    }
  }

  // —— 复制参数：按钮压一下 → 绿底打勾、撒一把彩纸；失败时珊瑚红、左右摇两下 ——

  private async copy(): Promise<void> {
    if (this.copyButton.dataset.busy) return;
    this.copyButton.dataset.busy = '';
    const reduce = reducedMotion();
    if (!reduce) animate(this.copyButton, [{ transform: 'none' }, { transform: 'scale(0.93, 0.88)', offset: 0.3 }, { transform: 'scale(1.03, 1.06)', offset: 0.65 }, { transform: 'none' }], { duration: 460, easing: EASE_OUT });
    const ok = await this.onCopy();
    clearTimeout(this.copyTimer);
    this.copyButton.dataset.state = ok ? 'copied' : 'failed';
    this.copyIcon.innerHTML = iconSvg(ok ? 'check' : 'close');
    this.copyLabel.textContent = ok ? 'Copied!' : 'Saved to the console';
    this.status.textContent = ok ? 'Parameters copied to the clipboard' : 'Could not copy. The parameters are in the browser console.';
    if (!reduce) {
      animate(this.copyIcon, [{ transform: 'scale(0) rotate(-60deg)' }, { transform: 'none' }], { duration: 620, easing: curve('bounce') });
      animate(this.copyLabel, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
      if (ok) this.confetti();
      else animate(this.copyButton, [{ transform: 'none' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }], { duration: 480, easing: 'ease-out' });
    }
    this.copyTimer = window.setTimeout(() => {
      delete this.copyButton.dataset.state;
      delete this.copyButton.dataset.busy;
      this.copyIcon.innerHTML = iconSvg('clipboard');
      this.copyLabel.textContent = 'Copy parameters';
      if (!reducedMotion()) animate(this.copyLabel, [{ opacity: 0 }, { opacity: 1 }], { duration: 240 });
    }, ok ? 1800 : 2600);
  }

  private confetti(): void {
    const colors = ['#f2b705', '#74c05f', '#4b9fe0', '#e9875f', '#e7799f', '#9a80dc'];
    const n = 16;
    for (let i = 0; i < n; i++) {
      const bit = el('i', { className: 'tune-bit' });
      bit.style.background = colors[i % colors.length];
      this.copyButton.append(bit);
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const d = 34 + Math.random() * 30;
      const dx = Math.cos(a) * d * 2.2;
      const dy = Math.sin(a) * d - 16;
      const r = (Math.random() - 0.5) * 540;
      const anim = animate(bit, [
        { transform: 'translate(0, 0) scale(0.3)', opacity: 1 },
        { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${(r * 0.6).toFixed(0)}deg) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${(dx * 1.12).toFixed(1)}px, ${(dy + 26).toFixed(1)}px) rotate(${r.toFixed(0)}deg) scale(0.7)`, opacity: 0 },
      ], { duration: 820 + Math.random() * 240, easing: 'cubic-bezier(0.2, 0.75, 0.35, 1)' });
      void finished([anim]).then(() => bit.remove());
    }
  }
}

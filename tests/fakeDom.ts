import { vi } from 'vitest';

// 测试用的极简浏览器：vitest 跑在 node 里，没有 document、location。
// 只做 App、PlanetScreen 和它们建的界面（顶栏、星系标签、作品卡）用到的那几样

type Listener = (e: unknown) => void;

export class FakeElement {
  hidden = false;
  textContent = '';
  className = '';
  offsetHeight = 24;
  readonly tagName: string;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classList = new Set<string>();
  children: unknown[] = [];
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: unknown[]): void {
    this.children = nodes;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  getBoundingClientRect(): FakeElement['rect'] {
    return this.rect;
  }

  // 只认 .class 选择器，按深度优先找第一个
  querySelector(selector: string): FakeElement | null {
    const cls = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.className.split(/\s+/).includes(cls)) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }

  // 给监听者派发一个事件（只带测试关心的字段）
  dispatch(type: string, init: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this, ...init });
  }

  // 子树里所有文字，断言界面内容用
  text(): string {
    return [this.textContent, ...this.children.map((c) => (c instanceof FakeElement ? c.text() : String(c)))].join(' ').trim();
  }
}

// document.createElement 交出 FakeElement；toast 找 #app 时找不到，提示条就不挂（测试里 toast 一般 mock 掉）
export function installFakeDom(): void {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag), querySelector: () => null });
}

// 地址栏：和浏览器一样，改 hash 后 hashchange 晚一步派发（排一个任务）；hash 没变不派发
export class FakeLocation {
  readonly pushed: string[] = []; // 新加的历史记录
  readonly replaced: string[] = []; // location.replace 换掉的
  private current: string;
  private readonly listeners: Array<() => void> = [];

  constructor(hash: string) {
    this.current = hash;
  }

  get hash(): string {
    return this.current;
  }

  set hash(value: string) {
    const next = value && !value.startsWith('#') ? `#${value}` : value;
    if (next === this.current) return;
    this.current = next;
    this.pushed.push(next);
    this.later();
  }

  replace(url: string): void {
    this.current = url.slice(url.indexOf('#'));
    this.replaced.push(this.current);
    this.later();
  }

  // 地址已经变了、hashchange 还在路上：测排队竞态用，之后手动 fire()
  setSilently(hash: string): void {
    this.current = hash;
  }

  fire(): void {
    for (const fn of [...this.listeners]) fn();
  }

  // 装成全局的 location、addEventListener('hashchange')、window
  install(): void {
    vi.stubGlobal('location', this);
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => { if (type === 'hashchange') this.listeners.push(fn); });
    vi.stubGlobal('removeEventListener', () => {});
    vi.stubGlobal('window', {});
  }

  private later(): void {
    setTimeout(() => this.fire(), 0);
  }
}

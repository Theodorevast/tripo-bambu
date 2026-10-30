import { tripoMark } from './badge';
import { el } from './dom';
import { icon } from './icons';
import { animate, curve, EASE_IN, reducedMotion } from './motion';

// Tripo 生成完成（或失败）时右下角弹出的提示：一张小纸卡，写着作品名和一句话，右边一个按钮（View / Details），点它打开结果。
// 和底部的 toast（纯文字、不接鼠标）不同，这张能点、能用 Tab 走到；鼠标停在上面或焦点在里面时不自动收起。
// 读屏：role=status，出来时念一遍
export interface NoticeOptions {
  tone: 'done' | 'failed';
  title: string;
  text: string;
  action: string;
  onAction(): void;
  ms?: number; // 多久后自动收起（默认 12 秒）
}

export class GenNotice {
  private readonly node = el('div', { className: 'ga-notice' });
  private timer = 0;
  private holding = false;
  private left = 0; // 还剩多少毫秒（停在上面时暂停）
  private since = 0;

  constructor(root: HTMLElement) {
    this.node.hidden = true;
    this.node.setAttribute('role', 'status');
    this.node.setAttribute('aria-live', 'polite');
    const hold = (on: boolean) => () => {
      this.holding = on;
      if (on) this.pause();
      else this.resume();
    };
    this.node.addEventListener('pointerenter', hold(true));
    this.node.addEventListener('pointerleave', hold(false));
    this.node.addEventListener('focusin', hold(true));
    this.node.addEventListener('focusout', (e) => { if (!this.node.contains(e.relatedTarget as Node | null)) hold(false)(); });
    root.append(this.node);
  }

  get shown(): boolean {
    return !this.node.hidden;
  }

  show(o: NoticeOptions): void {
    const go = el('button', { className: 'primary ga-notice-go', type: 'button' }, o.action, icon('arrow'));
    go.addEventListener('click', () => {
      this.hide();
      o.onAction();
    });
    const close = el('button', { className: 'ga-notice-x', type: 'button', title: 'Dismiss' }, icon('close'));
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => this.hide());
    const badge = o.tone === 'done' ? tripoMark('ga-notice-mark') : el('span', { className: 'ga-notice-alert' }, icon('alert'));
    this.node.dataset.tone = o.tone;
    this.node.replaceChildren(badge, el('div', { className: 'ga-notice-text' }, el('b', { textContent: o.text }), el('span', { textContent: o.title })), go, close);
    const wasHidden = this.node.hidden;
    this.node.hidden = false;
    if (wasHidden || !reducedMotion()) {
      animate(this.node, reducedMotion()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(24px) scale(0.9) rotate(2deg)' }, { opacity: 1, transform: 'none' }], { duration: reducedMotion() ? 200 : 560, easing: reducedMotion() ? 'ease-out' : curve('spring') });
    }
    this.left = o.ms ?? 12000;
    if (!this.holding) this.resume();
  }

  hide(): void {
    clearTimeout(this.timer);
    if (this.node.hidden) return;
    const a = animate(this.node, [{ opacity: 1 }, { opacity: 0, transform: reducedMotion() ? 'none' : 'translateY(14px)' }], { duration: 180, easing: EASE_IN });
    if (!a) {
      this.node.hidden = true;
      return;
    }
    void a.finished.then(() => { this.node.hidden = true; }, () => { this.node.hidden = true; });
  }

  private pause(): void {
    clearTimeout(this.timer);
    this.left = Math.max(1500, this.left - (performance.now() - this.since));
  }

  private resume(): void {
    clearTimeout(this.timer);
    if (this.node.hidden) return;
    this.since = performance.now();
    this.timer = window.setTimeout(() => this.hide(), this.left);
  }
}

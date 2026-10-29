import './coupons.css';
import { COUPON_KINDS, COUPONS_LIVE, type CouponTicket } from '../data/coupons';
import { el } from '../ui/dom';
import { TRIPO_URL } from '../ui/badge';
import { cobrandLockup } from '../ui/cobrand';
import { drawCardTicket } from './couponsArt';
import { play } from './couponsAudio';

// 捡到的券展开成的卡片（coupons）：共享元素过渡——3D 的券飞到镜头前，正好停在卡片上那张券的位置、一样大，
// 这时卡片上的券（同一个函数画的 canvas）叠上来接手，3D 的那张淡掉；接着券下面的纸像折着的一样往下翻开，露出
// 券名、面额、说明、兑换码和「Copy code」、「Use on Tripo」。关掉时纸先往上折回去，券再缩没。
// 减弱动效时只淡入淡出。卡片的样式先自己写（coupons.css，暖白纸面，和「Made with Tripo」徽章一套），界面统一时再并过去。
// 两种用法（prepare 的 mode）：星球上捡到的券（code：兑换码、Copy code、Use on Tripo）；
// 首页右边的翠宝吐的券（claim，H2）：领券窗口——券名、面额、一句说明、一个大的「Claim on Tripo」（新标签页打开 tripo3d.ai）

export type CardMode = 'code' | 'claim';
export const CLAIM_URL = 'https://www.tripo3d.ai';

const TICKET_CSS_WIDTH = 360;
const pixelRatio = () => Math.min(3, Math.max(1, devicePixelRatio || 1));

export class CouponCard {
  readonly layer: HTMLDivElement;
  onClose: (() => void) | null = null;
  private readonly card: HTMLElement;
  private readonly ticket: HTMLDivElement; // 放券的那一格（canvas 每种券一张，开场画好，换券时只换 canvas）
  private readonly ticketCanvases: HTMLCanvasElement[] = [];
  private canvasDpr = 0;
  private readonly fold: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly value: HTMLParagraphElement;
  private readonly blurb: HTMLParagraphElement;
  private readonly code: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly status: HTMLSpanElement;
  private readonly backdrop: HTMLDivElement;
  private readonly codeRow: HTMLDivElement;
  private readonly sample: HTMLParagraphElement;
  private readonly use: HTMLAnchorElement;
  private readonly claim: HTMLAnchorElement; // 首页领券窗口的大按钮（链接，不是 window.open）
  private readonly claimNote: HTMLParagraphElement;
  private readonly cobrand: HTMLDivElement; // 领券窗口顶上的联名小标志（Tripo × MakerWorld）
  private modeNow: CardMode = 'code';
  private current: CouponTicket | null = null;
  private state: 'closed' | 'pending' | 'open' | 'closing' = 'closed';
  private revert = 0;

  constructor(root: HTMLElement) {
    this.backdrop = el('div', { className: 'cc-backdrop' });
    this.backdrop.addEventListener('click', () => this.hide());
    this.ticket = el('div', { className: 'cc-ticket' });
    this.ticket.setAttribute('aria-hidden', 'true');
    this.title = el('h2', { className: 'cc-title', id: 'coupon-card-title' });
    this.value = el('p', { className: 'cc-value' });
    this.blurb = el('p', { className: 'cc-blurb' });
    this.code = el('code', { className: 'cc-code' });
    this.copyButton = el('button', { className: 'cc-copy', type: 'button', textContent: 'Copy code' });
    this.copyButton.addEventListener('click', () => void this.copy());
    const sample = el('p', { className: 'cc-sample', textContent: 'Sample code · live coupons are on their way' });
    sample.hidden = COUPONS_LIVE;
    this.sample = sample;
    const use = el('a', { className: 'cc-use', href: TRIPO_URL, target: '_blank', rel: 'noopener noreferrer', textContent: 'Use on Tripo' });
    use.append(el('span', { className: 'cc-arrow', textContent: ' ↗' }));
    use.setAttribute('aria-label', 'Use on Tripo (opens tripo3d.ai in a new tab)');
    this.use = use;
    // 领券（首页）：一个大的黄色按钮，就是一个 <a target="_blank" rel="noopener">，点了以后窗口留着（用户回来还能看到券）
    this.claim = el('a', { className: 'cc-use cc-claim', href: CLAIM_URL, target: '_blank', rel: 'noopener', textContent: 'Claim on Tripo' });
    this.claim.append(el('span', { className: 'cc-arrow', textContent: ' ↗' }));
    this.claim.setAttribute('aria-label', 'Claim on Tripo (opens tripo3d.ai in a new tab)');
    this.claim.addEventListener('click', () => play('tick'));
    this.claimNote = el('p', { className: 'cc-sample cc-claim-note', textContent: 'Sample coupon · live coupons are on their way' });
    this.status = el('span', { className: 'cc-status' });
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.codeRow = el('div', { className: 'cc-code-row' }, this.code, this.copyButton);
    this.cobrand = el('div', { className: 'cc-cobrand' }, cobrandLockup('sm'));
    this.fold = el('div', { className: 'cc-fold' },
      this.cobrand, this.title, this.value, this.blurb,
      this.codeRow,
      sample, use, this.claim, this.claimNote, this.status);
    const close = el('button', { className: 'cc-close', type: 'button', textContent: '×' });
    close.setAttribute('aria-label', 'Close coupon');
    close.addEventListener('click', () => this.hide());
    this.card = el('section', { className: 'coupon-card' }, this.ticket, this.fold, close);
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'coupon-card-title');
    this.layer = el('div', { className: 'coupon-layer' }, this.backdrop, this.card);
    this.layer.hidden = true;
    root.append(this.layer);
    // Esc 先关卡片（捕获阶段、拦下来：漫游的 Esc 是退出漫游，不能一下子两件事都做）
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.state !== 'open') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.hide();
    }, true);
  }

  get open(): boolean {
    return this.state === 'open' || this.state === 'pending';
  }

  get shown(): CouponTicket | null {
    return this.state === 'open' ? this.current : null;
  }

  // 开场时把每种券都画好、两种用法各排一次版（第一次捡券、第一次在首页领券时不在那一帧里做）
  warm(): void {
    this.drawTickets();
    this.layer.hidden = false;
    this.layer.classList.add('cc-measure');
    for (const mode of ['claim', 'code'] as const) {
      this.fill({ kind: 0, code: 'TRIBOO-0000-0000' }, mode);
      void this.card.offsetHeight;
    }
    this.layer.classList.remove('cc-measure');
    this.layer.hidden = true;
  }

  get mode(): CardMode {
    return this.modeNow;
  }

  // 3D 的券起飞时调：填好内容、排好版（看不见），返回卡片上那张券的中心和宽度（CSS 像素），3D 的券就往那里飞
  prepare(ticket: CouponTicket, mode: CardMode = 'code'): { x: number; y: number; width: number } {
    this.fill(ticket, mode);
    this.state = 'pending';
    this.layer.hidden = false;
    this.layer.classList.add('cc-measure');
    const r = this.ticket.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width };
  }

  // 3D 的券到了：卡片上的券叠上来，纸往下翻开
  show(reduced: boolean): void {
    if (this.state !== 'pending') return;
    this.state = 'open';
    this.layer.classList.remove('cc-measure');
    this.layer.hidden = false;
    const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
    if (reduced) {
      this.card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      this.backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    } else {
      this.backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
      this.ticket.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 1 }], { duration: 300, easing: 'linear' });
      this.ticket.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06) rotate(-1.5deg)', offset: 0.45 }, { transform: 'scale(1)' }],
        { duration: 420, easing: ease, delay: 60 },
      );
      this.fold.animate(
        [
          { transform: 'perspective(900px) rotateX(-96deg)', opacity: 0 },
          { transform: 'perspective(900px) rotateX(-96deg)', opacity: 1, offset: 0.02 },
          { transform: 'perspective(900px) rotateX(8deg)', opacity: 1, offset: 0.72 },
          { transform: 'perspective(900px) rotateX(0deg)', opacity: 1 },
        ],
        { duration: 560, easing: 'cubic-bezier(0.3, 0.9, 0.35, 1)', delay: 170, fill: 'backwards' },
      );
    }
    (this.modeNow === 'claim' ? this.claim : this.copyButton).focus({ preventScroll: true });
  }

  hide(): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    const wasOpen = this.state === 'open';
    this.state = 'closing';
    clearTimeout(this.revert);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const done = () => {
      if (this.state !== 'closing') return;
      this.state = 'closed';
      this.layer.hidden = true;
      this.layer.classList.remove('cc-measure');
      this.onClose?.();
    };
    if (!wasOpen) {
      done();
      return;
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.then(done, done);
      this.backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      return;
    }
    this.fold.animate([{ transform: 'perspective(900px) rotateX(0deg)', opacity: 1 }, { transform: 'perspective(900px) rotateX(-96deg)', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
    this.ticket.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.04)', opacity: 1, offset: 0.3 }, { transform: 'scale(0.55) translateY(30px)', opacity: 0 }], { duration: 260, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', delay: 110, fill: 'forwards' });
    this.backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', delay: 60, fill: 'forwards' }).finished.then(done, done);
  }

  // 收起来以后清掉动画留下的样式（fill: forwards）
  private resetAnimations(): void {
    for (const node of [this.card, this.ticket, this.fold, this.backdrop]) for (const a of node.getAnimations()) a.cancel();
  }

  private drawTickets(): void {
    const dpr = pixelRatio();
    COUPON_KINDS.forEach((kind, i) => {
      const canvas = (this.ticketCanvases[i] ??= document.createElement('canvas'));
      drawCardTicket(canvas, kind, TICKET_CSS_WIDTH, dpr);
    });
    this.canvasDpr = dpr;
  }

  private fill(ticket: CouponTicket, mode: CardMode = 'code'): void {
    this.resetAnimations();
    this.current = ticket;
    this.modeNow = mode;
    const claim = mode === 'claim';
    this.card.dataset.mode = mode;
    this.codeRow.hidden = claim;
    this.sample.hidden = claim || COUPONS_LIVE;
    this.use.hidden = claim;
    this.claim.hidden = !claim;
    this.claimNote.hidden = !claim || COUPONS_LIVE;
    this.cobrand.hidden = !claim;
    const kind = COUPON_KINDS[ticket.kind] ?? COUPON_KINDS[0];
    if (this.canvasDpr !== pixelRatio()) this.drawTickets(); // 窗口拖到另一块屏幕上了
    const canvas = this.ticketCanvases[ticket.kind] ?? this.ticketCanvases[0];
    if (this.ticket.firstChild !== canvas) this.ticket.replaceChildren(canvas);
    this.title.textContent = kind.title;
    this.value.replaceChildren(el('b', { textContent: kind.value }), ` ${kind.unit}`);
    this.blurb.textContent = kind.blurb;
    this.code.textContent = ticket.code;
    this.copyButton.textContent = 'Copy code';
    this.copyButton.classList.remove('done');
    this.status.textContent = '';
  }

  // 复制兑换码：成功时按钮变成「Copied!」（打个勾、弹一下、叮一声），1.8 秒后变回来；剪贴板不让写时选中兑换码，提示按 Ctrl+C
  private async copy(): Promise<void> {
    const code = this.current?.code;
    if (!code) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      ok = this.legacyCopy();
    }
    clearTimeout(this.revert);
    if (ok) {
      this.copyButton.textContent = 'Copied!';
      this.copyButton.classList.add('done');
      this.status.textContent = 'Code copied to clipboard';
      this.copyButton.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      this.code.animate([{ backgroundColor: '#fff3c4' }, { backgroundColor: '#ffffff' }], { duration: 700, easing: 'ease-out' });
      play('tick');
    } else {
      this.selectCode();
      this.copyButton.textContent = 'Press Ctrl+C';
      this.status.textContent = 'Could not copy automatically. The code is selected, press Ctrl+C to copy it.';
    }
    this.revert = window.setTimeout(() => {
      this.copyButton.textContent = 'Copy code';
      this.copyButton.classList.remove('done');
    }, 1800);
  }

  private selectCode(): void {
    const range = document.createRange();
    range.selectNodeContents(this.code);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // 没有异步剪贴板（不是安全上下文）时的老办法：选中再 execCommand('copy')
  private legacyCopy(): boolean {
    try {
      this.selectCode();
      const ok = document.execCommand('copy');
      getSelection()?.removeAllRanges();
      return ok;
    } catch {
      return false;
    }
  }
}

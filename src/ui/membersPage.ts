import type { Sheet } from '../app';
import { thumbUrl } from '../assets/models';
import type { Member, Team, Work } from '../data/types';
import { el, initials } from './dom';
import { icon } from './icons';
import { activeElement, animate, bindTilt, curve, EASE_IN, EASE_OUT, focusQuietly, Presence, reducedMotion, setLaunchOrigin } from './motion';
import { inkOn, plural, sheetHead } from './sheet';

// 这一次打开建出来的几块（进场、退场动画要用）
interface Parts {
  panel: HTMLElement;
  head: HTMLElement;
  top: HTMLElement;
  bottom: HTMLElement;
  cards: HTMLElement[];
}

// Members：盖在星球上的一卷「成员卷轴」（3D 世界照常在后面跑，这一页不暂停它）。
// 打开：卷轴从上往下展开，成员卡一张张弹进来。卡片：鼠标在上面移动时朝鼠标倾斜、抬起；
// 点一下（或回车、空格）翻到背面——介绍、作品数、作品小图（点小图进 Museum 的查看器，从小图那里放大出来）。
// 关掉：卡片先收，卷轴往上卷回去，放完才藏起来（脚本等的 .sheet.members 的 hidden 也是这时才变）。
// 减弱动效时只淡入淡出，翻面改成两面交叉淡入淡出。Esc 关；打开时焦点进面板，关掉时还给原来的按钮
export class MembersPage implements Sheet {
  private readonly node = el('section', { className: 'sheet members' });
  private readonly presence = new Presence(this.node);
  private readonly youId: string;
  private readonly onClose: () => void;
  private readonly onWork: (workId: string) => void;
  private parts: Parts | null = null;
  private listening = false;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, youId: string, onClose: () => void, onWork: (workId: string) => void) {
    this.youId = youId;
    this.onClose = onClose;
    this.onWork = onWork;
    this.node.hidden = true;
    this.node.setAttribute('aria-label', 'Members');
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); }); // 点背景关闭
    root.append(this.node);
  }

  open(team: Team): void {
    const cards = team.members.map((m) => this.card(team, m));
    const head = sheetHead(team, 'Members', `${plural(team.members.length, 'member', 'members')} · founded ${plural(team.foundedDaysAgo, 'day', 'days')} ago`, () => this.onClose());
    const panel = el('div', { className: 'sheet-panel scroll-paper', tabIndex: -1 }, head, el('ul', { className: 'member-list' }, ...cards));
    const top = el('i', { className: 'scroll-rod top' });
    const bottom = el('i', { className: 'scroll-rod bottom' });
    this.parts = { panel, head, top, bottom, cards };
    this.node.replaceChildren(el('div', { className: 'sheet-scroll' }, top, panel, bottom));
    if (!this.presence.shown) this.returnFocus = activeElement();
    if (!this.listening) {
      addEventListener('keydown', this.onKey);
      this.listening = true;
    }
    const parts = this.parts;
    this.presence.show(() => this.enter(parts));
    focusQuietly(panel);
  }

  close(): void {
    if (this.listening) {
      removeEventListener('keydown', this.onKey);
      this.listening = false;
    }
    if (this.node.hidden) return;
    // 焦点在这一页里（比如按 Esc 关的）：还给打开前的按钮；已经去了别处（点了顶栏别的按钮）就不动
    const a = activeElement();
    const back = a && this.node.contains?.(a) ? this.returnFocus : null;
    this.returnFocus = null;
    const parts = this.parts;
    void this.presence.hide(() => this.exit(parts));
    if (back) focusQuietly(back);
  }

  // —— 进场：背景淡入 → 上面的轴落下来 → 纸往下展开（下面的轴跟着纸的下边走）→ 标题、成员卡依次弹进来 ——
  private enter(p: Parts): Array<Animation | null> {
    const list: Array<Animation | null> = [animate(this.node, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' })];
    if (reducedMotion()) {
      list.push(animate(p.panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', fill: 'backwards' }));
      return list;
    }
    const h = p.panel.offsetHeight || 600;
    const unroll: KeyframeAnimationOptions = { duration: 640, delay: 90, easing: curve('settle'), fill: 'backwards' };
    list.push(
      animate(p.top, [{ opacity: 0, transform: 'translateY(-46px) scaleX(0.7)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: curve('bounce'), fill: 'backwards' }),
      animate(p.panel, [{ transform: 'scaleY(0.03)' }, { transform: 'none' }], unroll),
      animate(p.bottom, [{ transform: `translateY(${-h}px)` }, { transform: 'none' }], unroll),
      animate(p.head, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 300, easing: EASE_OUT, fill: 'backwards' }),
    );
    p.cards.forEach((c, i) => {
      const tilt = i % 2 ? 5 : -5;
      list.push(animate(c, [
        { opacity: 0, transform: `translateY(30px) scale(0.82) rotate(${tilt}deg)` },
        { opacity: 1, transform: 'none' },
      ], { duration: 640, delay: 380 + i * 60, easing: curve('spring'), fill: 'backwards' }));
    });
    return list;
  }

  // —— 退场：卡片一起收小、纸往上卷回去、轴和背景淡掉（比进场快）——
  private exit(p: Parts | null): Array<Animation | null> {
    const reduce = reducedMotion();
    const fadeAll = animate(this.node, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 200 : 380, delay: reduce ? 0 : 60, easing: 'ease-in', fill: 'forwards' });
    if (reduce || !p) return [fadeAll];
    const h = p.panel.offsetHeight || 600;
    const roll: KeyframeAnimationOptions = { duration: 300, delay: 90, easing: EASE_IN, fill: 'forwards' };
    return [
      fadeAll,
      ...p.cards.map((c) => animate(c, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9) translateY(-10px)' }], { duration: 150, easing: EASE_IN, fill: 'forwards' })),
      animate(p.panel, [{ transform: 'none' }, { transform: 'scaleY(0.03)' }], roll),
      animate(p.bottom, [{ transform: 'none' }, { transform: `translateY(${-h}px)` }], roll),
      animate(p.top, [{ transform: 'none' }, { transform: 'translateY(-30px) scaleX(0.8)' }], { duration: 220, delay: 330, easing: EASE_IN, fill: 'forwards' }),
    ];
  }

  // —— 一张成员卡：正面（头像、名字、标签、作品数）和背面（介绍、作品）——
  private card(team: Team, m: Member): HTMLLIElement {
    const works = team.works.filter((w) => w.authorId === m.id);
    const you = m.id === this.youId;
    const tags = [m.role === 'captain' ? tag('captain', 'crown', 'Captain') : tag('builder', 'pencil', 'Builder')];
    if (you) tags.push(tag('you', 'star', 'You'));

    // 正面整张都是一个按钮（盖在上面、透明），点它翻面
    const hit = el('button', { className: 'mcard-hit', type: 'button' });
    hit.setAttribute('aria-label', `${m.displayName}: flip to see the card back`);
    hit.setAttribute('aria-expanded', 'false');
    const front = el('div', { className: 'mcard-face mcard-front' },
      el('div', { className: 'mcard-band' }),
      avatar(m, team),
      el('div', { className: 'mcard-name display', textContent: m.displayName }),
      el('div', { className: 'mcard-handle', textContent: `@${m.handle}` }),
      el('div', { className: 'mcard-tags' }, ...tags),
      el('div', { className: 'mcard-foot' }, el('span', { className: 'mcard-count' }, icon('cube'), plural(works.length, 'work', 'works')), icon('flip', 'mcard-flip-hint')),
      hit,
    );

    const flipBack = el('button', { className: 'mcard-flipback', type: 'button', title: 'Flip back' }, icon('flip'));
    flipBack.setAttribute('aria-label', 'Flip the card back');
    const back = el('div', { className: 'mcard-face mcard-back' },
      el('div', { className: 'mcard-back-head' },
        avatar(m, team, 'small'),
        el('div', { className: 'mcard-back-who' }, el('b', { className: 'display', textContent: m.displayName }), el('span', { textContent: `@${m.handle}` })),
        flipBack,
      ),
      el('p', { className: 'mcard-intro', textContent: intro(m, team, you) }),
      el('div', { className: 'mcard-stat' }, el('b', { textContent: String(works.length) }), el('span', { textContent: works.length === 1 ? 'work in the Museum' : 'works in the Museum' })),
      works.length
        ? el('ul', { className: 'mcard-works' }, ...works.map((w) => el('li', {}, this.thumb(w, team))))
        : el('p', { className: 'mcard-empty', textContent: 'Nothing here yet. Still sketching!' }),
    );
    back.inert = true;

    const inner = el('div', { className: 'mcard', dataset: { flipped: 'false' } }, front, back);
    const layer = el('div', { className: 'mcard-tilt' }, inner);
    const li = el('li', { className: 'member' }, layer);
    li.style.setProperty?.('--team', team.color);
    li.style.setProperty?.('--team-ink', inkOn(team.color));
    const flip = (on: boolean): void => {
      inner.dataset.flipped = String(on);
      front.inert = on;
      back.inert = !on;
      hit.setAttribute('aria-expanded', String(on));
      focusQuietly(on ? flipBack : hit);
      // 翻面时整张卡轻轻一压一弹（叠加在倾斜上）；减弱动效时 CSS 只做两面交叉淡入淡出
      if (!reducedMotion()) animate(layer, [{ transform: 'none' }, { transform: 'scale(0.95)', offset: 0.25 }, { transform: 'scale(1.03)', offset: 0.6 }, { transform: 'none' }], { duration: 560, easing: EASE_OUT, composite: 'add' });
    };
    hit.addEventListener('click', () => flip(true));
    flipBack.addEventListener('click', () => flip(false));
    bindTilt(li, layer, 8);
    return li;
  }

  // 背面的作品：小图（没有图时团队色块 + 缩写）+ 作品名。点开时记下小图的位置，查看器从这里放大出来
  private thumb(w: Work, team: Team): HTMLButtonElement {
    const pic = el('span', { className: 'thumb-pic' });
    if (w.thumb) pic.append(el('img', { src: thumbUrl(w.thumb), alt: '', loading: 'lazy' }));
    else {
      pic.textContent = initials(w.title);
      pic.style.background = team.color;
      pic.style.color = inkOn(team.color);
    }
    const b = el('button', { className: 'thumb', type: 'button', title: `Open ${w.title} in the Museum` }, pic, el('span', { className: 'thumb-title', textContent: w.title }), icon('arrow', 'thumb-go'));
    b.addEventListener('click', () => {
      setLaunchOrigin(pic);
      this.onWork(w.id);
    });
    return b;
  }
}

function tag(kind: string, glyph: 'crown' | 'pencil' | 'star', text: string): HTMLSpanElement {
  return el('span', { className: `tag ${kind}` }, icon(glyph), text);
}

function avatar(m: Member, team: Team, size = ''): HTMLElement {
  const a = el('div', { className: `avatar${size ? ` ${size}` : ''}`, textContent: initials(m.displayName) });
  a.style.background = team.color;
  a.style.color = inkOn(team.color);
  return a;
}

// 背面的一句介绍（数据里没有个人简介：按角色写一句）
function intro(m: Member, team: Team, you: boolean): string {
  const line = m.role === 'captain' ? `Captain of ${team.name}. Keeps the crew on course.` : `Builds with ${team.name}, one piece at a time.`;
  return you ? `That's you! ${line}` : line;
}

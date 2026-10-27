import type { Team, Work } from '../data/types';
import { el, formatTris } from './dom';

// 右侧作品卡：编号和面数、作品名、作者和团队、简介、去博物馆
export class WorkCard {
  private readonly node = el('aside', { className: 'work-card' });
  private readonly onMuseum: (workId: string) => void;

  constructor(root: HTMLElement, onMuseum: (workId: string) => void) {
    this.onMuseum = onMuseum;
    this.node.hidden = true;
    root.append(this.node);
  }

  show(work: Work, team: Team, failed: boolean): void {
    const author = team.members.find((m) => m.id === work.authorId);
    const index = team.works.findIndex((w) => w.id === work.id) + 1; // 0 = 临时作品
    const children: Node[] = [
      el('button', { className: 'wc-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.hide() }),
      el('div', { className: 'mono', textContent: index > 0 ? `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` : 'Temporary · not saved' }),
      el('h2', { className: 'display', textContent: work.title }),
      el('div', { className: 'wc-by', textContent: `by @${author?.handle ?? 'unknown'} · ${team.name}` }),
    ];
    if (failed) children.push(el('div', { className: 'wc-warn', textContent: 'Model failed to load' }));
    if (work.description) children.push(el('p', { className: 'wc-desc', textContent: work.description }));
    if (index > 0) children.push(el('button', { className: 'primary', textContent: 'View in Museum →', onclick: () => this.onMuseum(work.id) }));
    this.node.replaceChildren(...children);
    this.node.hidden = false;
  }

  hide(): void {
    this.node.hidden = true;
  }
}

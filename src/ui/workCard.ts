import type { Team, Work } from '../data/types';
import { el, formatTris } from './dom';

// 作品在团队作品里的序号，从 1 开始；0 = 不在里面（拖进来的临时作品）
function workIndex(work: Work, team: Team): number {
  return team.works.findIndex((w) => w.id === work.id) + 1;
}

// 编号和面数：No. 001 · 12,840 tris；临时作品显示 Temporary · not saved
export function workNumber(work: Work, team: Team): string {
  const index = workIndex(work, team);
  return index > 0 ? `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` : 'Temporary · not saved';
}

// 作者：by @handle（成员里找不到时 @unknown）
export function authorLine(work: Work, team: Team): string {
  return `by @${team.members.find((m) => m.id === work.authorId)?.handle ?? 'unknown'}`;
}

// 模型加载失败的提示（作品卡、大图查看器、Museum 卡片共用）
export function failedNote(): HTMLElement {
  return el('div', { className: 'wc-warn', textContent: 'Model failed to load' });
}

// 作品卡和大图查看器共用的信息块：编号和面数、作品名、作者和团队、加载失败提示、简介
export function workInfo(work: Work, team: Team, failed: boolean): HTMLElement[] {
  const nodes: HTMLElement[] = [
    el('div', { className: 'mono', textContent: workNumber(work, team) }),
    el('h2', { className: 'display', textContent: work.title }),
    el('div', { className: 'wc-by', textContent: `${authorLine(work, team)} · ${team.name}` }),
  ];
  if (failed) nodes.push(failedNote());
  if (work.description) nodes.push(el('p', { className: 'wc-desc', textContent: work.description }));
  return nodes;
}

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
    this.node.replaceChildren(
      el('button', { className: 'wc-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.hide() }),
      ...workInfo(work, team, failed),
    );
    // 临时作品不在博物馆里，没有这个按钮
    if (workIndex(work, team) > 0) this.node.append(el('button', { className: 'primary', textContent: 'View in Museum →', onclick: () => this.onMuseum(work.id) }));
    this.node.hidden = false;
  }

  hide(): void {
    this.node.hidden = true;
  }
}

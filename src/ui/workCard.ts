import type { Team, Work } from '../data/types';
import { tripoMark } from './badge';
import { el, formatTris } from './dom';
import { icon } from './icons';

// 作品在团队作品里的序号，从 1 开始；0 = 不在里面（拖进来的临时作品）
function workIndex(work: Work, team: Team): number {
  return team.works.findIndex((w) => w.id === work.id) + 1;
}

// 编号和面数：No. 001 · 12,840 tris；临时作品显示 Temporary · not saved
export function workNumber(work: Work, team: Team): string {
  const index = workIndex(work, team);
  return index > 0 ? `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` : 'Temporary · not saved';
}

// 作者：by @handle（成员里找不到时用作品自己记的 handle——用户把作品加到了别的团队的星球上；都没有时 @unknown）
export function authorLine(work: Work, team: Team): string {
  return `by @${team.members.find((m) => m.id === work.authorId)?.handle ?? work.authorHandle ?? 'unknown'}`;
}

// 模型加载失败的提示（作品卡、大图查看器、Museum 卡片共用）
export function failedNote(): HTMLElement {
  return el('div', { className: 'wc-warn', textContent: 'Model failed to load' });
}

// 用 Tripo 生成的作品：一张「Made with Tripo」小贴纸（小翠宝标志），文字生成的再加上提示词；别的作品返回 null
const MADE_FROM: Record<string, string> = { image: 'from a picture', multiview: 'from four views' };
export function tripoNote(work: Work, className = 'tripo-note'): HTMLElement | null {
  if (work.source !== 'tripo') return null;
  const tag = el('span', { className: 'tripo-tag' }, tripoMark('tripo-mark'), 'Made with Tripo');
  const node = el('div', { className }, tag);
  if (work.prompt) node.append(el('q', { className: 'tripo-prompt', textContent: work.prompt }));
  else if (work.mode && MADE_FROM[work.mode]) node.append(el('span', { className: 'tripo-from', textContent: MADE_FROM[work.mode] }));
  return node;
}

// 作品卡和大图查看器共用的信息块：编号和面数、作品名、作者和团队、Tripo 生成的标记和提示词、加载失败提示、简介
export function workInfo(work: Work, team: Team, failed: boolean): HTMLElement[] {
  const nodes: HTMLElement[] = [
    el('div', { className: 'mono', textContent: workNumber(work, team) }),
    el('h2', { className: 'display', textContent: work.title }),
    el('div', { className: 'wc-by', textContent: `${authorLine(work, team)} · ${team.name}` }),
  ];
  const note = tripoNote(work);
  if (note) nodes.push(note);
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

  // 每次 show 都重新建内容，CSS 的弹出动画（styles.css 的 card-pop）跟着重放：换一件作品时卡片也会轻轻弹一下
  show(work: Work, team: Team, failed: boolean): void {
    this.node.replaceChildren(
      el('button', { className: 'wc-close', type: 'button', ariaLabel: 'Close', onclick: () => this.hide() }, icon('close')),
      ...workInfo(work, team, failed),
    );
    // 临时作品不在博物馆里，没有这个按钮
    if (workIndex(work, team) > 0) this.node.append(el('button', { className: 'primary wc-go', type: 'button', onclick: () => this.onMuseum(work.id) }, 'View in Museum', icon('arrow')));
    this.node.hidden = false;
    delete this.node.dataset.pop;
    void this.node.offsetWidth; // 已经开着时换内容：去掉再加回 data-pop，让弹出动画重新开始
    this.node.dataset.pop = '';
  }

  hide(): void {
    this.node.hidden = true;
  }
}

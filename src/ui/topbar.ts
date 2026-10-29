import type { Team } from '../data/types';
import { el } from './dom';
import { icon } from './icons';

export interface TopbarActions {
  back(): void;
  members(): void;
  museum(): void;
  walk(): void;
  edit(): void;
}

// 顶栏：左边标题，中间是星球页的按钮，右边是演示身份。
// 首页（星系视图，H2）的标题是一块大一点的纸片：「Community Planets」、一句说明、「Visit your planet」按钮（翠宝黄）
export class Topbar {
  // 「Visit your planet」（main.ts 接上：先让你的星球弹一下再穿云）；没接上时按钮藏起来
  onVisit: (() => void) | null = null;
  onVisitHover: ((on: boolean) => void) | null = null; // 指着按钮时，你的星球跟着放大、名牌弹出来
  private readonly title = el('div', { className: 'tb-title' });
  private readonly visitButton: HTMLButtonElement;
  private readonly actions = el('nav', { className: 'tb-actions' });
  private readonly editButton: HTMLButtonElement;
  private readonly walkButton: HTMLButtonElement;

  constructor(root: HTMLElement, youHandle: string, act: TopbarActions) {
    this.editButton = el('button', { className: 'primary', textContent: 'Edit', onclick: () => act.edit() });
    this.walkButton = el('button', { className: 'walk', textContent: 'Walk', onclick: () => act.walk() });
    this.actions.append(
      el('button', { textContent: '← Galaxy', onclick: () => act.back() }),
      el('button', { textContent: 'Members', onclick: () => act.members() }),
      el('button', { textContent: 'Museum', onclick: () => act.museum() }),
      this.walkButton,
      this.editButton,
    );
    this.actions.hidden = true; // 按钮组只在星球页显示（showTeam）
    this.visitButton = el('button', { className: 'primary tb-visit', type: 'button', onclick: () => this.onVisit?.() }, 'Visit your planet', icon('arrow', 'tb-visit-arrow'));
    this.visitButton.addEventListener('pointerenter', () => this.onVisitHover?.(true));
    this.visitButton.addEventListener('pointerleave', () => this.onVisitHover?.(false));
    this.visitButton.addEventListener('focus', () => this.onVisitHover?.(true));
    this.visitButton.addEventListener('blur', () => this.onVisitHover?.(false));
    const who = el('div', { className: 'tb-who mono' }, `Signed in as @${youHandle} · `, el('span', { className: 'you-tag', textContent: 'You' }));
    root.append(el('header', { className: 'topbar' }, this.title, this.actions, who));
  }

  // 首页：标题、一句说明、「Visit your planet」。团队数、作品数不再显示（原来那行灰色小字），参数留着（App 照旧传）
  showGalaxy(_teamCount: number, _workCount: number): void {
    this.visitButton.hidden = !this.onVisit;
    this.title.replaceChildren(
      el('h1', { className: 'display tb-name', textContent: 'Community Planets' }),
      el('p', { className: 'tb-tagline', textContent: 'Build a planet with friends. Decorate it with your 3D works.' }),
      this.visitButton,
    );
    this.title.dataset.home = ''; // 首页的大纸片（styles.css 的 .tb-title[data-home]）
    this.actions.hidden = true;
  }

  // main.ts 接上 onVisit 以后调一次：首页正显示着时把按钮露出来
  refreshVisit(): void {
    this.visitButton.hidden = !this.onVisit;
  }

  showTeam(team: Team, isYours: boolean): void {
    delete this.title.dataset.home;
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: team.name }),
      el('div', { className: 'tb-motto', textContent: team.motto }),
    );
    this.actions.hidden = false;
    this.editButton.hidden = !isYours;
    this.setEditing(false);
    this.setWalking(false);
  }

  setEditing(on: boolean): void {
    this.editButton.textContent = on ? 'Done' : 'Edit';
    this.editButton.setAttribute('aria-pressed', String(on));
  }

  // 漫游中 Walk 变成 Done（任何星球都能走，不只是自己的）
  setWalking(on: boolean): void {
    this.walkButton.textContent = on ? 'Done' : 'Walk';
    this.walkButton.setAttribute('aria-pressed', String(on));
  }
}

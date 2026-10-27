import type { Team } from '../data/types';
import { el } from './dom';

export interface TopbarActions {
  back(): void;
  members(): void;
  museum(): void;
  edit(): void;
}

// 顶栏：左边标题，中间是星球页的按钮，右边是演示身份
export class Topbar {
  private readonly title = el('div', { className: 'tb-title' });
  private readonly actions = el('nav', { className: 'tb-actions' });
  private readonly editButton: HTMLButtonElement;

  constructor(root: HTMLElement, youHandle: string, act: TopbarActions) {
    this.editButton = el('button', { className: 'primary', textContent: 'Edit', onclick: () => act.edit() });
    this.actions.append(
      el('button', { textContent: '← Galaxy', onclick: () => act.back() }),
      el('button', { textContent: 'Members', onclick: () => act.members() }),
      el('button', { textContent: 'Museum', onclick: () => act.museum() }),
      this.editButton,
    );
    this.actions.hidden = true; // 按钮组只在星球页显示（showTeam）
    const who = el('div', { className: 'tb-who mono' }, `Signed in as @${youHandle} · `, el('span', { className: 'you-tag', textContent: 'You' }));
    root.append(el('header', { className: 'topbar' }, this.title, this.actions, who));
  }

  showGalaxy(teamCount: number, workCount: number): void {
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: 'Community Planets' }),
      el('div', { className: 'mono', textContent: `${teamCount} teams · ${workCount} works · one sky` }),
    );
    this.actions.hidden = true;
  }

  showTeam(team: Team, isYours: boolean): void {
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: team.name }),
      el('div', { className: 'tb-motto', textContent: team.motto }),
    );
    this.actions.hidden = false;
    this.editButton.hidden = !isYours;
    this.setEditing(false);
  }

  setEditing(on: boolean): void {
    this.editButton.textContent = on ? 'Done' : 'Edit';
    this.editButton.setAttribute('aria-pressed', String(on));
  }
}

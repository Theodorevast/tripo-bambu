import type { Team } from '../data/types';
import { el } from './dom';
import { cobrandHeader } from './cobrand';
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
  onCreate: (() => void) | null = null; // 「Create a planet」（ui/home.ts 接上：建星球的流程，或者去 #/create）
  private readonly title = el('div', { className: 'tb-title' });
  private readonly visitButton: HTMLButtonElement;
  private readonly createButton: HTMLButtonElement;
  // 标题卡片右上角的「Tune」小按钮：打开、关上右边的调参面板（ui/tuneToggle.ts 接上以后才露出来）。首页、星球页的卡片上都有
  private readonly tuneButton: HTMLButtonElement;
  private onTune: (() => void) | null = null;
  private readonly ctas: HTMLDivElement;
  private readonly cobrand = cobrandHeader(); // 联名（Tripo × MakerWorld，GBN）：首页标题上面
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
    this.createButton = el('button', { className: 'tb-create', type: 'button', onclick: () => this.onCreate?.() }, icon('sparkle', 'tb-create-icon'), 'Create a planet');
    this.ctas = el('div', { className: 'tb-ctas' }, this.visitButton, this.createButton);
    this.tuneButton = el('button', { className: 'tb-tune', type: 'button', title: 'Tune', onclick: () => this.onTune?.() }, icon('sliders'));
    this.tuneButton.setAttribute('aria-label', 'Tune');
    this.tuneButton.setAttribute('aria-pressed', 'false');
    this.tuneButton.hidden = true;
    const who = el('div', { className: 'tb-who mono' }, `Signed in as @${youHandle} · `, el('span', { className: 'you-tag', textContent: 'You' }));
    root.append(el('header', { className: 'topbar' }, this.title, this.actions, who));
  }

  // 首页：标题、一句说明、「Visit your planet」（主按钮）和「Create a planet」（次按钮）。
  // 团队数、作品数不再显示（原来那行灰色小字），参数留着（App 照旧传）
  showGalaxy(_teamCount: number, _workCount: number): void {
    this.refreshVisit();
    this.title.replaceChildren(
      this.cobrand,
      el('h1', { className: 'display tb-name', textContent: 'Community Planets' }),
      el('p', { className: 'tb-tagline', textContent: 'Build a planet with friends. Decorate it with your 3D works.' }),
      this.ctas,
      this.tuneButton,
    );
    this.title.dataset.home = ''; // 首页的大纸片（styles.css 的 .tb-title[data-home]）
    this.actions.hidden = true;
  }

  // main.ts 接上 onVisit 以后调一次：首页正显示着时把按钮露出来
  refreshVisit(): void {
    this.visitButton.hidden = !this.onVisit;
    this.createButton.hidden = !this.onCreate;
  }

  // _isYours：演示里每颗星球都能编辑（H2），参数留着，以后接上真实的权限再用
  showTeam(team: Team, _isYours: boolean): void {
    delete this.title.dataset.home;
    this.title.replaceChildren(
      el('div', { className: 'display tb-name', textContent: team.name }),
      el('div', { className: 'tb-motto', textContent: team.motto }),
      this.tuneButton,
    );
    this.actions.hidden = false;
    this.editButton.hidden = false;
    this.setEditing(false);
    this.setWalking(false);
  }

  // 「Tune」按钮接上点击（ui/tuneToggle.ts），露出来
  enableTune(handler: () => void): void {
    this.onTune = handler;
    this.tuneButton.hidden = false;
  }

  // 调参面板开着没有：按钮按下去（aria-pressed）
  setTuneOpen(on: boolean): void {
    this.tuneButton.setAttribute('aria-pressed', String(on));
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

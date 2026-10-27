import type { Sheet } from '../app';
import { thumbUrl } from '../assets/models';
import type { Member, Team } from '../data/types';
import { el, initials } from './dom';

// Members：盖在星球上的面板，每个成员一行：头像、名字、角色、作品缩略图
export class MembersPage implements Sheet {
  private readonly node = el('section', { className: 'sheet members' });
  private readonly youId: string;
  private readonly onClose: () => void;
  private readonly onWork: (workId: string) => void;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, youId: string, onClose: () => void, onWork: (workId: string) => void) {
    this.youId = youId;
    this.onClose = onClose;
    this.onWork = onWork;
    this.node.hidden = true;
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); }); // 点背景关闭
    root.append(this.node);
  }

  open(team: Team): void {
    this.node.replaceChildren(el('div', { className: 'sheet-panel' },
      el('header', { className: 'sheet-head' },
        el('div', {},
          el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} days ago` }),
          el('h1', { className: 'display', textContent: `${team.name} — Members` }),
        ),
        el('button', { className: 'sheet-close', textContent: 'Close', onclick: () => this.onClose() }),
      ),
      el('ul', { className: 'member-list' }, ...team.members.map((m) => this.row(team, m))),
    ));
    if (this.node.hidden) addEventListener('keydown', this.onKey);
    this.node.hidden = false;
  }

  close(): void {
    if (this.node.hidden) return;
    this.node.hidden = true;
    removeEventListener('keydown', this.onKey);
  }

  private row(team: Team, m: Member): HTMLLIElement {
    const works = team.works.filter((w) => w.authorId === m.id);
    const avatar = el('div', { className: 'avatar', textContent: initials(m.displayName) });
    avatar.style.background = team.color;
    const tags = [el('span', { className: `tag ${m.role}`, textContent: m.role === 'captain' ? 'Captain' : 'Builder' })];
    if (m.id === this.youId) tags.push(el('span', { className: 'tag you', textContent: 'You' }));
    return el('li', { className: 'member' },
      avatar,
      el('div', { className: 'member-main' },
        el('div', { className: 'member-name' }, el('span', { className: 'display', textContent: m.displayName }), ...tags),
        el('div', { className: 'mono', textContent: `@${m.handle} · ${works.length} ${works.length === 1 ? 'work' : 'works'}` }),
      ),
      el('div', { className: 'member-works' }, ...works.map((w) => {
        const b = el('button', { className: 'thumb', title: w.title, onclick: () => this.onWork(w.id) });
        if (w.thumb) b.append(el('img', { src: thumbUrl(w.thumb), alt: w.title, loading: 'lazy' }));
        else {
          b.textContent = initials(w.title);
          b.style.background = team.color;
        }
        return b;
      })),
    );
  }
}

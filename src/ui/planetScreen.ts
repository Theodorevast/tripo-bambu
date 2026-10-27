import type { PlanetLayer } from '../app';
import type { Team } from '../data/types';
import { PlanetView, type PlacedWork } from '../scenes/planetView';
import type { World } from '../scenes/world';
import { el } from './dom';
import { WorkCard } from './workCard';

// 星球页（非编辑状态）：悬停作品显示名字，点击弹出作品卡；建设中的星球显示提示
export class PlanetScreen implements PlanetLayer {
  readonly view: PlanetView;
  readonly card: WorkCard;
  private readonly world: World;
  private readonly root: HTMLElement;
  private readonly label = el('div', { className: 'float-label' });
  private readonly note = el('div', { className: 'center-note' });
  private hovered: PlacedWork | null = null;
  private down: { x: number; y: number } | null = null;
  private active = false;
  private interactive = true;

  constructor(world: World, root: HTMLElement, onMuseum: (teamId: string, workId: string) => void) {
    this.world = world;
    this.root = root;
    this.view = new PlanetView(world);
    this.card = new WorkCard(root, (workId) => { if (this.view.team) onMuseum(this.view.team.id, workId); });
    this.label.hidden = true;
    this.note.hidden = true;
    root.append(this.label, this.note);
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (this.active && this.interactive && !world.rig.flying) this.setHovered(this.view.pick(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    world.frameHooks.add(() => this.placeLabel());
  }

  async enter(team: Team): Promise<void> {
    this.active = true;
    if (team.status === 'under-construction') {
      this.note.replaceChildren(
        el('div', { className: 'display', textContent: `${team.name} is still building` }),
        el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} ${team.foundedDaysAgo === 1 ? 'day' : 'days'} ago` }),
      );
      this.note.hidden = false;
    }
    await this.view.enter(team);
  }

  leave(): void {
    this.active = false;
    this.setHovered(null);
    this.card.hide();
    this.note.hidden = true;
    this.view.leave();
  }

  // 编辑模式下关掉悬停和作品卡
  setInteractive(on: boolean): void {
    this.interactive = on;
    if (!on) {
      this.setHovered(null);
      this.card.hide();
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.down;
    this.down = null;
    if (!this.active || !this.interactive || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const pw = this.view.pick(e.clientX, e.clientY);
    if (pw && this.view.team) this.card.show(pw.work, this.view.team, pw.model?.failed ?? false);
    else this.card.hide();
  }

  private setHovered(pw: PlacedWork | null): void {
    if (pw === this.hovered) return;
    this.hovered = pw;
    this.view.setHighlight(pw);
    this.world.renderer.domElement.style.cursor = pw ? 'pointer' : '';
    this.label.hidden = !pw;
    if (pw) this.label.replaceChildren(el('span', { className: 'display', textContent: pw.work.title }));
  }

  private placeLabel(): void {
    if (!this.hovered) return;
    const top = this.view.topOf(this.hovered);
    // 作品转到星球背面（自动旋转、阻尼）时，指针没动也把标签藏起来
    const at = this.view.occluded(this.world.rig.camera.position, top) ? null : this.world.toScreen(top);
    this.label.hidden = !at;
    if (!at) return;
    // 标签以底边中点对准作品顶上；不压到顶栏：标签顶边至少在顶栏底边下面 8px（顶栏高度从 DOM 读）
    const bar = this.root.querySelector('.topbar');
    const minY = (bar ? bar.getBoundingClientRect().bottom : 0) + 8 + this.label.offsetHeight;
    this.label.style.transform = `translate(${at.x}px, ${Math.max(at.y, minY)}px) translate(-50%, -100%)`;
  }
}

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
  private readonly label = el('div', { className: 'float-label' });
  private readonly note = el('div', { className: 'center-note' });
  private hovered: PlacedWork | null = null;
  private down: { x: number; y: number } | null = null;
  private active = false;
  private interactive = true;

  constructor(world: World, root: HTMLElement, onMuseum: (teamId: string, workId: string) => void) {
    this.world = world;
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
        el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} days ago` }),
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
    const at = this.world.toScreen(this.view.topOf(this.hovered));
    this.label.hidden = !at;
    if (at) this.label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
  }
}

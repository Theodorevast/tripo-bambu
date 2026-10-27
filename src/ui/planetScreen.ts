import type { PlanetLayer } from '../app';
import type { Team } from '../data/types';
import { PlanetView, type PlacedWork } from '../scenes/planetView';
import type { World } from '../scenes/world';
import { el } from './dom';
import { WorkCard } from './workCard';

// 星球页（非编辑状态）：悬停作品显示名字，点击弹出作品卡；建设中的星球显示提示。
// enter() 不等模型（路由是串行的，等了就会卡住 Back、Members 这些操作）：展台马上摆好，模型在后台加载。
// 给脚本的就绪信号：这次进入的模型全部挂好后，#app 加 data-planet-ready="<teamId>"；离开星球、换团队时去掉
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
  private visit = 0; // 每次 enter / leave 加一：模型加载完时对不上号（已经离开或换了团队），就不设就绪信号

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
    // 指针离开画布（移到顶栏、作品卡上，或者移出窗口）：清掉悬停，高亮、标签和手形光标都不留
    canvas.addEventListener('pointerleave', () => this.setHovered(null));
    // 只认主按钮：鼠标左键，触摸和笔尖按下时也是 0；右键、中键点作品不弹作品卡
    canvas.addEventListener('pointerdown', (e) => { this.down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    world.frameHooks.add(() => this.placeLabel());
  }

  enter(team: Team): void {
    const visit = ++this.visit;
    this.active = true;
    delete this.root.dataset.planetReady;
    if (team.status === 'under-construction') {
      this.note.replaceChildren(
        el('div', { className: 'display', textContent: `${team.name} is still building` }),
        el('div', { className: 'mono', textContent: `${team.members.length} members · founded ${team.foundedDaysAgo} ${team.foundedDaysAgo === 1 ? 'day' : 'days'} ago` }),
      );
      this.note.hidden = false;
    }
    this.view.enter(team);
    this.view.loaded.then(
      () => { if (visit === this.visit) this.root.dataset.planetReady = team.id; },
      (err: unknown) => console.error(err),
    );
  }

  leave(): void {
    this.visit++;
    this.active = false;
    delete this.root.dataset.planetReady;
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
    if (e.button !== 0 || !this.active || !this.interactive || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
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
    // 作品转到星球背面（自动旋转、阻尼）时，指针没动也把整个悬停清掉：高亮和手形光标不留在空地上
    if (this.view.occluded(this.world.rig.camera.position, top)) {
      this.setHovered(null);
      return;
    }
    // 锚点（作品顶上）在画面外（镜头拉近、转动后作品出了画面）或在镜头背后：不显示标签，悬停本身留着
    const at = this.world.toScreen(top);
    const r = this.world.renderer.domElement.getBoundingClientRect();
    if (!at || at.x < r.left || at.x > r.right || at.y < r.top || at.y > r.bottom) {
      this.label.hidden = true;
      return;
    }
    this.label.hidden = false;
    // 标签以底边中点对准作品顶上；不压到顶栏：标签顶边至少在顶栏底边下面 8px（顶栏高度从 DOM 读；标签先显示出来，offsetHeight 才有值）
    const bar = this.root.querySelector('.topbar');
    const minY = (bar ? bar.getBoundingClientRect().bottom : 0) + 8 + this.label.offsetHeight;
    this.label.style.transform = `translate(${at.x}px, ${Math.max(at.y, minY)}px) translate(-50%, -100%)`;
  }
}

import * as THREE from 'three/webgpu';
import type { Sheet } from '../app';
import { ModelLibrary, thumbUrl } from '../assets/models';
import type { Team, Work } from '../data/types';
import { frameModel } from '../museum/framing';
import { MultiView } from '../museum/multiview';
import { Viewer } from '../museum/viewer';
import type { Route } from '../router';
import { addStudioLights } from '../scenes/lights';
import type { World } from '../scenes/world';
import { el, formatTris } from './dom';
import { toast } from './toast';

// Task 2 的检查不通过时改成 false：卡片改用静态缩略图，查看器不受影响
export const LIVE_CARD_PREVIEWS = true;

interface Card {
  node: HTMLElement;
  preview: HTMLElement;
  work: Work;
}

// Museum：团队作品网格，每张卡片里一个慢慢自转的模型；点开进入大图查看器
export class MuseumPage implements Sheet {
  private readonly node = el('section', { className: 'sheet museum' });
  private readonly canvas = el('canvas', { className: 'museum-canvas' });
  private readonly library = new ModelLibrary(); // 卡片预览的渲染器专用
  private readonly viewer: Viewer;
  private readonly world: World;
  private readonly onClose: () => void;
  private readonly onSelect: (workId: string | null) => void;
  private multiview: MultiView | null = null;
  private teamId: string | null = null;
  private token = 0;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !this.viewer.isOpen) this.onClose(); };

  constructor(root: HTMLElement, world: World, onClose: () => void, onSelect: (workId: string | null) => void) {
    this.world = world;
    this.onClose = onClose;
    this.onSelect = onSelect;
    this.node.hidden = true;
    this.canvas.hidden = true;
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); });
    // 预览 canvas 在最上层：查看器打开时要藏起来，否则卡片会画到查看器上面
    this.viewer = new Viewer(root, () => this.onSelect(null), (open) => {
      this.canvas.hidden = open || !LIVE_CARD_PREVIEWS || this.teamId === null;
    });
    root.append(this.node, this.canvas);
  }

  async open(team: Team, route: Route): Promise<void> {
    if (this.teamId !== team.id) await this.renderGrid(team);
    const workId = route.view === 'museum' ? route.workId : undefined;
    if (!workId) {
      this.viewer.close();
      return;
    }
    const work = team.works.find((w) => w.id === workId);
    if (work) await this.viewer.open(work, team);
    else {
      toast('That work is not in this museum');
      this.onSelect(null);
    }
  }

  close(): void {
    if (this.teamId === null) return;
    this.token++;
    this.teamId = null;
    this.node.hidden = true;
    this.canvas.hidden = true;
    this.viewer.close();
    this.multiview?.clearViews();
    this.multiview?.renderer.setAnimationLoop(null);
    this.world.paused = false;
    removeEventListener('keydown', this.onKey);
  }

  private async renderGrid(team: Team): Promise<void> {
    const token = ++this.token;
    this.teamId = team.id;
    this.world.paused = true; // 主画面被盖住了，停掉省 GPU
    addEventListener('keydown', this.onKey);
    const cards = team.works.map((w, i) => this.card(team, w, i));
    this.node.replaceChildren(el('div', { className: 'sheet-panel wide' },
      el('header', { className: 'sheet-head' },
        el('div', {},
          el('div', { className: 'mono', textContent: `${team.works.length} works · ${team.name}` }),
          el('h1', { className: 'display', textContent: 'Museum' }),
        ),
        el('button', { className: 'sheet-close', textContent: 'Close', onclick: () => this.onClose() }),
      ),
      cards.length ? el('div', { className: 'museum-grid' }, ...cards.map((c) => c.node)) : el('p', { className: 'empty display', textContent: 'No works yet' }),
    ));
    this.node.hidden = false;
    if (!LIVE_CARD_PREVIEWS || cards.length === 0) return;
    this.multiview ??= await MultiView.create(this.canvas);
    if (token !== this.token) return;
    const mv = this.multiview;
    mv.clearViews();
    this.canvas.hidden = this.viewer.isOpen;
    mv.renderer.setAnimationLoop(() => mv.render(1 / 60));
    await Promise.all(cards.map(async (c) => {
      const model = await this.library.load(c.work);
      if (token !== this.token) return;
      const scene = new THREE.Scene();
      addStudioLights(scene);
      scene.add(model.object);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      frameModel(camera, model.height);
      c.preview.classList.add('ready');
      mv.add({ element: c.preview, scene, camera, tick: (dt) => { model.object.rotation.y += dt * 0.5; } });
    }));
  }

  private card(team: Team, work: Work, i: number): Card {
    const author = team.members.find((m) => m.id === work.authorId);
    const preview = el('div', { className: 'mc-preview' });
    if (!LIVE_CARD_PREVIEWS) {
      preview.classList.add('ready');
      if (work.thumb) preview.append(el('img', { src: thumbUrl(work.thumb), alt: work.title }));
    }
    const node = el('article', {
      className: 'museum-card',
      tabIndex: 0,
      onclick: () => this.onSelect(work.id),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.onSelect(work.id); },
    },
      preview,
      el('div', { className: 'mc-title display', textContent: work.title }),
      el('div', { className: 'mc-by', textContent: `by @${author?.handle ?? 'unknown'}` }),
      el('div', { className: 'mono', textContent: `No. ${String(i + 1).padStart(3, '0')} · ${formatTris(work.tris)}` }),
    );
    node.setAttribute('role', 'button');
    return { node, preview, work };
  }
}

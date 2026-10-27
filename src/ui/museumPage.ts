import * as THREE from 'three/webgpu';
import type { Sheet } from '../app';
import { ModelLibrary, thumbUrl } from '../assets/models';
import type { Team, Work } from '../data/types';
import { isCurrentRoute } from '../lib/currentRoute';
import { frameModel } from '../museum/framing';
import { MultiView } from '../museum/multiview';
import { Viewer } from '../museum/viewer';
import { toHash, type Route } from '../router';
import { addStudioLights } from '../scenes/lights';
import type { World } from '../scenes/world';
import { el } from './dom';
import { toast } from './toast';
import { authorLine, failedNote, workNumber } from './workCard';

// Task 2 的检查不通过时改成 false：卡片改用静态缩略图，查看器不受影响
export const LIVE_CARD_PREVIEWS = true;

interface Card {
  node: HTMLElement;
  preview: HTMLElement;
  work: Work;
}

// Museum：团队作品网格，每张卡片里一个慢慢自转的模型；点开进入大图查看器
// open() 不等任何模型（路由是串行的，等了就会卡住 Esc、返回这些操作）：网格和查看器面板马上出来，模型在后台加载
// 给脚本的就绪信号：每张卡片的模型挂好后 .mc-preview 加 ready 类；全部挂好后 section.museum 加 data-ready="true"；
// 查看器的模型画出第一帧后 .viewer-stage 加 ready 类
export class MuseumPage implements Sheet {
  private readonly node = el('section', { className: 'sheet museum' });
  private readonly canvas = el('canvas', { className: 'museum-canvas' });
  private readonly library = new ModelLibrary(); // 卡片预览的渲染器专用
  private readonly viewer: Viewer;
  private readonly world: World;
  private readonly onClose: () => void;
  private readonly onSelect: (workId: string | null) => void;
  private multiview: MultiView | null = null;
  private multiviewReady: Promise<MultiView> | null = null;
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

  open(team: Team, route: Route): void {
    if (this.teamId !== team.id) this.renderGrid(team);
    const workId = route.view === 'museum' ? route.workId : undefined;
    const work = workId ? team.works.find((w) => w.id === workId) : undefined;
    if (work) {
      this.viewer.open(work, team);
      return;
    }
    this.viewer.close();
    if (workId) {
      // 地址里的作品不存在：网格已经显示着，只把地址就地改成网格的（不加历史记录，后退不会又回到坏地址）。
      // 地址栏已经换成别的了（排队期间用户又去了别处，比如 Members）就不改，免得把那条新记录改成 Museum 的地址
      toast('That work is not in this museum');
      if (isCurrentRoute(route)) history.replaceState(history.state, '', toHash({ view: 'museum', teamId: team.id }));
    }
  }

  close(): void {
    if (this.teamId === null) return;
    this.token++;
    this.teamId = null;
    this.node.hidden = true;
    delete this.node.dataset.ready;
    this.canvas.hidden = true;
    this.viewer.close();
    this.multiview?.clearViews();
    this.multiview?.renderer.setAnimationLoop(null);
    this.world.paused = false;
    removeEventListener('keydown', this.onKey);
  }

  private renderGrid(team: Team): void {
    const token = ++this.token;
    this.teamId = team.id;
    this.world.paused = true; // 主画面被盖住了，停掉省 GPU
    addEventListener('keydown', this.onKey);
    const cards = team.works.map((w) => this.card(team, w));
    const count = team.works.length;
    this.node.replaceChildren(el('div', { className: 'sheet-panel wide' },
      el('header', { className: 'sheet-head' },
        el('div', {},
          el('div', { className: 'mono', textContent: `${count} ${count === 1 ? 'work' : 'works'} · ${team.name}` }),
          el('h1', { className: 'display', textContent: 'Museum' }),
        ),
        el('button', { className: 'sheet-close', textContent: 'Close', onclick: () => this.onClose() }),
      ),
      cards.length ? el('div', { className: 'museum-grid' }, ...cards.map((c) => c.node)) : el('p', { className: 'empty display', textContent: 'No works yet' }),
    ));
    delete this.node.dataset.ready;
    this.node.hidden = false;
    this.startPreviews(cards, token).then(
      () => { if (token === this.token) this.node.dataset.ready = 'true'; },
      (err: unknown) => console.error(err),
    );
  }

  // 卡片预览：共用一个 canvas，每张卡片一个视口；模型各自加载，好一个挂一个
  private async startPreviews(cards: Card[], token: number): Promise<void> {
    if (!LIVE_CARD_PREVIEWS || cards.length === 0) return;
    // 存 Promise 而不是结果：两次打开挨得很近时也只建一个渲染器
    this.multiviewReady ??= MultiView.create(this.canvas).then((mv) => (this.multiview = mv));
    const mv = await this.multiviewReady;
    if (token !== this.token) return;
    mv.clearViews();
    this.canvas.hidden = this.viewer.isOpen;
    let last = -1;
    mv.renderer.setAnimationLoop((t) => {
      // 按真实帧间隔转，刷新率高的屏幕上也是每秒 0.5 弧度；切回标签页时最多补 0.1 秒
      const dt = last < 0 ? 0 : Math.min((t - last) / 1000, 0.1);
      last = t;
      mv.render(dt);
    });
    await Promise.all(cards.map(async (c) => {
      const model = await this.library.load(c.work);
      if (token !== this.token) return;
      const scene = new THREE.Scene();
      addStudioLights(scene);
      scene.add(model.object);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      frameModel(camera, model.height);
      if (model.failed) c.node.append(failedNote());
      c.preview.classList.add('ready');
      mv.add({ element: c.preview, scene, camera, tick: (dt) => { model.object.rotation.y += dt * 0.5; } });
    }));
  }

  private card(team: Team, work: Work): Card {
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
      el('div', { className: 'mc-by', textContent: authorLine(work, team) }),
      el('div', { className: 'mono', textContent: workNumber(work, team) }),
    );
    node.setAttribute('role', 'button');
    return { node, preview, work };
  }
}

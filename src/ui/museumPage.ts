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
import { activeElement, animate, bindTilt, curve, EASE_IN, EASE_OUT, finished, focusQuietly, Presence, reducedMotion, setLaunchOrigin } from './motion';
import { plural, sheetHead } from './sheet';
import { toast } from './toast';
import { authorLine, failedNote, tripoNote, workNumber } from './workCard';

// Task 2 的检查不通过时改成 false：卡片改用静态缩略图，查看器不受影响
export const LIVE_CARD_PREVIEWS = true;

interface Card {
  node: HTMLElement;
  preview: HTMLElement;
  work: Work;
  hovered: boolean;
}

// 这一次打开建出来的几块（进场、退场动画要用）
interface Parts {
  panel: HTMLElement;
  head: HTMLElement;
  cards: HTMLElement[];
}

// 悬停时作品转快一点、稍微放大；离开时慢慢回到平时的速度
const SPIN_IDLE = 0.45;
const SPIN_HOVER = 2.1;

// 作品第一次出现在卡片里时慢慢长出来：0 → 1，先快后慢、不过冲（0.7 秒停稳）。第二版不再用带过冲的阻尼弹簧
function pop(t: number): number {
  if (t >= 0.7) return 1;
  const k = 1 - t / 0.7;
  return 1 - k * k * k;
}

// Museum：团队作品挂在一块「展板」上，每张卡片里一个慢慢自转的模型；点开进入大图查看器
// open() 不等任何模型（路由是串行的，等了就会卡住 Esc、返回这些操作）：网格和查看器面板马上出来，模型在后台加载
// 给脚本的就绪信号：每张卡片的模型挂好后 .mc-preview 加 ready 类；全部挂好后 section.museum 加 data-ready="true"；
// 查看器的模型画出第一帧后 .viewer-stage 加 ready 类
// 动效（U1）：展板从上面荡下来，卡片一张张弹进来；模型到了在卡片里蹦出来；悬停时卡片朝鼠标倾斜、抬起，模型转快；
// 按下回弹；点开时卡片放大成查看器（共用元素过渡），关掉时缩回卡片。关掉 Museum：展板往上收走、淡掉，放完才藏起来。
// 减弱动效时只淡入淡出。打开时主画面停画（被盖住了，省 GPU），关掉时恢复
export class MuseumPage implements Sheet {
  private readonly node = el('section', { className: 'sheet museum' });
  private readonly presence = new Presence(this.node);
  private readonly canvas = el('canvas', { className: 'museum-canvas' });
  private readonly library = new ModelLibrary(); // 卡片预览的渲染器专用
  private readonly viewer: Viewer;
  private readonly world: World;
  private readonly onClose: () => void;
  private readonly onSelect: (workId: string | null) => void;
  private readonly cards = new Map<string, Card>();
  private multiview: MultiView | null = null;
  private multiviewReady: Promise<MultiView> | null = null;
  private teamId: string | null = null;
  private token = 0;
  private parts: Parts | null = null;
  private previewing = false; // 卡片预览的渲染循环该不该跑（Museum 开着、预览已经开始）
  private watchingVisibility = false;
  private canvasFade: Animation | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !this.viewer.isOpen) this.onClose(); };

  constructor(root: HTMLElement, world: World, onClose: () => void, onSelect: (workId: string | null) => void) {
    this.world = world;
    this.onClose = onClose;
    this.onSelect = onSelect;
    this.node.hidden = true;
    this.node.setAttribute('aria-label', 'Museum');
    this.canvas.hidden = true;
    this.node.addEventListener('click', (e) => { if (e.target === this.node) this.onClose(); });
    // 预览 canvas 在最上层：查看器打开后藏起来（被整屏盖住了，不用再画）。打开时晚一点再藏：舞台从卡片放大、背景淡入的这一下，
    // 别的卡片里的模型还在，不会先空掉
    this.viewer = new Viewer(root, () => this.onSelect(null), (open) => {
      clearTimeout(this.hideTimer);
      if (open && !this.canvas.hidden && !reducedMotion()) this.hideTimer = setTimeout(() => { if (this.viewer.isOpen) this.canvas.hidden = true; }, 320);
      else this.canvas.hidden = open || !LIVE_CARD_PREVIEWS || this.teamId === null;
    }, (workId) => this.cards.get(workId)?.preview ?? null);
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
    const showing = !this.canvas.hidden; // 卡片预览这时看得见（查看器没开着）：下面让它淡掉
    this.token++;
    this.teamId = null;
    delete this.node.dataset.ready;
    this.viewer.close();
    this.previewing = false;
    this.multiview?.clearViews();
    this.multiview?.renderer.setAnimationLoop(null);
    this.world.paused = false;
    removeEventListener('keydown', this.onKey);
    // 焦点在 Museum 里（Esc 关的）：还给打开前的按钮
    const a = activeElement();
    const back = a && this.node.contains?.(a) ? this.returnFocus : null;
    this.returnFocus = null;
    // 预览画布（停在最后一帧）先很快淡掉，卡片和展板再收走
    this.canvasFade?.cancel();
    clearTimeout(this.hideTimer);
    const fade = showing && !reducedMotion() ? animate(this.canvas, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' }) : null;
    this.canvasFade = fade;
    if (fade) {
      this.canvas.hidden = false; // viewer.close() 刚把它藏了（teamId 已经清掉）：淡完再藏
      void finished([fade]).then(() => {
        if (this.canvasFade !== fade) return;
        this.canvas.hidden = true;
        fade.cancel();
        this.canvasFade = null;
      });
    } else this.canvas.hidden = true;
    const parts = this.parts;
    void this.presence.hide(() => this.exit(parts));
    if (back) focusQuietly(back);
  }

  private renderGrid(team: Team): void {
    const token = ++this.token;
    this.teamId = team.id;
    this.world.paused = true; // 主画面被盖住了，停掉省 GPU
    addEventListener('keydown', this.onKey);
    this.canvasFade?.cancel();
    this.canvasFade = null;
    this.cards.clear();
    const cards = team.works.map((w, i) => this.card(team, w, i));
    for (const c of cards) this.cards.set(c.work.id, c);
    const head = sheetHead(team, 'Museum', cards.length ? `${plural(cards.length, 'work', 'works')} on display` : 'The halls are still empty', () => this.onClose());
    const grid = cards.length
      ? el('div', { className: 'museum-grid' }, ...cards.map((c) => c.node))
      : el('div', { className: 'museum-empty' }, el('i', { className: 'empty-plinth' }), el('p', { className: 'empty display', textContent: 'No works yet' }));
    const panel = el('div', { className: 'sheet-panel wide', tabIndex: -1 }, head, grid);
    this.parts = { panel, head, cards: cards.map((c) => c.node) };
    this.node.replaceChildren(panel);
    delete this.node.dataset.ready;
    if (!this.presence.shown) this.returnFocus = activeElement();
    const parts = this.parts;
    this.presence.show(() => this.enter(parts));
    focusQuietly(panel);
    this.startPreviews(cards, token).then(
      () => { if (token === this.token) this.node.dataset.ready = 'true'; },
      (err: unknown) => console.error(err),
    );
  }

  // —— 进场：背景淡入，展板从上面荡下来（像挂在绳子上），标题、卡片依次弹进来 ——
  private enter(p: Parts): Array<Animation | null> {
    const list: Array<Animation | null> = [animate(this.node, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' })];
    if (reducedMotion()) {
      list.push(animate(p.panel, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', fill: 'backwards' }));
      return list;
    }
    list.push(
      animate(p.panel, [
        { opacity: 0, transform: 'translateY(-22px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 720, easing: curve('spring'), fill: 'backwards' }),
      animate(p.head, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 220, easing: EASE_OUT, fill: 'backwards' }),
    );
    p.cards.forEach((c, i) => {
      list.push(animate(c, [
        { opacity: 0, transform: 'translateY(20px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 700, delay: 300 + i * 70, easing: curve('spring'), fill: 'backwards' }));
    });
    return list;
  }

  // —— 退场：卡片一起收小，展板往上提走、淡掉 ——
  private exit(p: Parts | null): Array<Animation | null> {
    const reduce = reducedMotion();
    const fadeAll = animate(this.node, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 200 : 340, delay: reduce ? 0 : 40, easing: 'ease-in', fill: 'forwards' });
    if (reduce || !p) return [fadeAll];
    return [
      fadeAll,
      ...p.cards.map((c) => animate(c, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 160, easing: EASE_IN, fill: 'forwards' })),
      animate(p.panel, [{ transform: 'none' }, { transform: 'translateY(-18px)' }], { duration: 320, delay: 40, easing: EASE_IN, fill: 'forwards' }),
    ];
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
    this.previewing = true;
    this.watchVisibility();
    this.runPreviews(mv);
    // 卡片一张张上：着色器在后台编译好、贴图和几何传好再加进网格。一次只编译一张，不挤在同一帧里
    let queue: Promise<unknown> = Promise.resolve();
    await Promise.all(cards.map(async (c) => {
      const model = await this.library.load(c.work);
      if (token !== this.token) return;
      const scene = new THREE.Scene();
      addStudioLights(scene);
      scene.add(model.object);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      frameModel(camera, model.height);
      const compiled = queue.then(() => (token === this.token ? mv.compile(scene, camera) : undefined));
      queue = compiled.catch(() => {});
      await compiled;
      if (token !== this.token) return;
      // 卡片自己的入场（一张张弹进来，第二排以后的晚好几百毫秒）放完了才画：3D 预览画在盖在最上层的画布上，不跟着卡片的透明度，
      // 模型先到（缓存里有）时会先浮在还没出来的卡片位置上（上传、生成的作品多了以后第二排很常见）
      await finished(c.node.getAnimations?.() ?? []);
      if (token !== this.token) return;
      if (model.failed) c.node.querySelector('.mc-plate')?.append(failedNote());
      c.preview.classList.add('ready');
      // 自转：平时慢慢转，悬停时转快、放大一点点；第一次出现时从 0 蹦到原来的大小（缩放乘在模型原有的缩放上）
      const base = model.object.scale.clone();
      let age = reducedMotion() ? 1 : 0;
      let spin = SPIN_IDLE;
      let lift = 0;
      mv.add({
        element: c.preview,
        scene,
        camera,
        tick: (dt) => {
          age += dt;
          const k = 1 - Math.exp(-dt * 5);
          spin += ((c.hovered ? SPIN_HOVER : SPIN_IDLE) - spin) * k;
          lift += ((c.hovered ? 1 : 0) - lift) * k;
          model.object.rotation.y += dt * spin;
          model.object.scale.copy(base).multiplyScalar(pop(age) * (1 + 0.06 * lift));
        },
      });
    }));
  }

  // 卡片预览的渲染循环：按真实帧间隔转，刷新率高的屏幕上也是同样的速度；每次开始时第一帧的 dt 是 0，
  // 切回标签页时不补后台那段时间
  private runPreviews(mv: MultiView): void {
    let last = -1;
    mv.renderer.setAnimationLoop((t) => {
      const dt = last < 0 ? 0 : Math.min((t - last) / 1000, 0.1);
      last = t;
      mv.render(dt);
    });
  }

  // 标签页切到后台：停掉卡片预览的循环；回来时 Museum 还开着就重新开始
  private watchVisibility(): void {
    if (this.watchingVisibility) return;
    this.watchingVisibility = true;
    document.addEventListener('visibilitychange', () => {
      const mv = this.multiview;
      if (!mv || !this.previewing) return;
      if (document.hidden) mv.renderer.setAnimationLoop(null);
      else this.runPreviews(mv);
    });
  }

  // 一张展品卡：画框（里面是 3D 预览）+ 下面的小展签（作品名、作者、编号）
  private card(team: Team, work: Work, i: number): Card {
    const preview = el('div', { className: 'mc-preview' });
    if (!LIVE_CARD_PREVIEWS) {
      preview.classList.add('ready');
      if (work.thumb) preview.append(el('img', { src: thumbUrl(work.thumb), alt: work.title }));
    }
    const plate = el('div', { className: 'mc-plate' },
      el('div', { className: 'mc-title display', textContent: work.title }),
      el('div', { className: 'mc-by', textContent: authorLine(work, team) }),
    );
    // 用 Tripo 生成的作品：展签上加「Made with Tripo」贴纸和提示词（文字生成的）
    const note = tripoNote(work, 'tripo-note mc-tripo');
    if (note) plate.append(note);
    plate.append(el('div', { className: 'mono', textContent: workNumber(work, team) }));
    const layer = el('div', { className: 'mc-tilt' }, el('div', { className: 'mc-frame' }, preview, el('i', { className: 'mc-shine' })), plate);
    const select = (): void => {
      setLaunchOrigin(preview);
      this.onSelect(work.id);
    };
    const node = el('article', {
      className: 'museum-card',
      tabIndex: 0,
      onclick: select,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        // 键盘也有「按下去」的感觉：先压一下再打开
        if (!reducedMotion()) animate(layer, [{ transform: 'none' }, { transform: 'scale(0.985)', offset: 0.4 }, { transform: 'none' }], { duration: 320, easing: EASE_OUT, composite: 'add' });
        select();
      },
    }, layer);
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `${work.title}, ${authorLine(work, team)}${work.source === 'tripo' ? ', made with Tripo' : ''}. Open in the viewer`);
    node.style.setProperty?.('--i', String(i));
    const card: Card = { node, preview, work, hovered: false };
    const hover = (on: boolean) => () => { card.hovered = on; };
    node.addEventListener('pointerenter', hover(true));
    node.addEventListener('pointerleave', hover(false));
    node.addEventListener('focus', hover(true));
    node.addEventListener('blur', hover(false));
    bindTilt(node, layer, 7);
    return card;
  }
}

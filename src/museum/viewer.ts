import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelLibrary } from '../assets/models';
import type { Team, Work } from '../data/types';
import { addStudioLights } from '../scenes/lights';
import { useLook } from '../scenes/look';
import { compileUnculled } from '../scenes/stager';
import { el } from '../ui/dom';
import { icon } from '../ui/icons';
import { activeElement, animate, curve, EASE_IN, EASE_OUT, flipFrom, focusQuietly, onScreen, Presence, reducedMotion, takeLaunchOrigin } from '../ui/motion';
import { workInfo } from '../ui/workCard';
import { fitDistance, frameModel } from './framing';

// 大图查看器：独立的 canvas 和渲染器（不依赖分区渲染），拖动 360° 旋转、滚轮缩放
// open() 不等模型：信息面板立刻换好，模型在后台加载（不占住路由队列）；
// 模型画出第一帧之前舞台显示 Loading，.viewer-stage 加上 ready 类之后才露出画布（脚本也等这个类）
// 动效（U1，第二版改成柔和的缓动、不歪不弹）：从被点的卡片（或成员卡背面的小图）放大成舞台——共用元素过渡，只动 transform；信息卡从右边滑进来，关闭按钮淡入；
// 模型准备好时从舞台上「蹦」出来。关掉时舞台缩回 Museum 里那张卡片（卡片不在屏幕上就原地缩小淡出），放完才藏起来、拿掉模型。
// 减弱动效时只淡入淡出
export class Viewer {
  isOpen = false;
  private readonly node = el('div', { className: 'viewer' });
  private readonly presence = new Presence(this.node);
  private readonly backdrop = el('div', { className: 'viewer-backdrop' });
  private readonly stage = el('div', { className: 'viewer-stage' });
  private readonly canvas = el('canvas');
  private readonly info = el('div', { className: 'viewer-info' });
  private readonly closeButton = el('button', { className: 'viewer-close', type: 'button', title: 'Close (Esc)' }, icon('close'));
  private readonly library = new ModelLibrary();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly size = new THREE.Vector2();
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private controls: OrbitControls | null = null;
  private current: THREE.Object3D | null = null;
  private token = 0; // 每次 open / close 加一：晚到的模型对不上号就丢掉
  private workId: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private readonly onClose: () => void;
  private readonly onToggle: (open: boolean) => void;
  private readonly returnTo: (workId: string) => HTMLElement | null;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  // returnTo：关掉时舞台缩回哪个元素（Museum 里这件作品的卡片预览）；没有就原地缩小淡出
  constructor(root: HTMLElement, onClose: () => void, onToggle: (open: boolean) => void, returnTo: (workId: string) => HTMLElement | null = () => null) {
    this.onClose = onClose;
    this.onToggle = onToggle;
    this.returnTo = returnTo;
    // 不设 scene.background：色调映射会把背景色一起压暗，舞台底色改由 CSS 给，画布是透明的
    addStudioLights(this.scene);
    this.closeButton.setAttribute('aria-label', 'Close');
    this.closeButton.addEventListener('click', () => this.onClose());
    this.stage.append(
      el('div', { className: 'viewer-spot' }),
      this.canvas,
      el('div', { className: 'viewer-loading' }, el('span', { className: 'dots' }, el('i'), el('i'), el('i')), el('span', { textContent: 'Unpacking…' })),
    );
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-modal', 'true');
    this.node.setAttribute('aria-label', 'Work viewer');
    this.node.append(this.backdrop, this.stage, this.info, this.closeButton);
    this.node.hidden = true;
    root.append(this.node);
  }

  open(work: Work, team: Team): void {
    const token = ++this.token;
    this.workId = work.id;
    this.node.setAttribute('aria-label', work.title);
    this.showInfo(work, team, false);
    this.removeModel();
    if (!this.isOpen) {
      this.isOpen = true;
      this.returnFocus = activeElement();
      const from = takeLaunchOrigin();
      this.presence.show(() => this.enter(from));
      this.onToggle(true);
      addEventListener('keydown', this.onKey);
      focusQuietly(this.closeButton);
    }
    this.load(work, team, token).catch((err: unknown) => console.error(err));
  }

  close(): void {
    if (!this.isOpen) return;
    const token = ++this.token;
    this.isOpen = false;
    const target = this.workId ? this.returnTo(this.workId) : null;
    const back = this.returnFocus;
    this.returnFocus = null;
    removeEventListener('keydown', this.onKey);
    this.onToggle(false);
    // 退场放完：拿掉模型、停掉循环（这期间又打开了就不动）
    void this.presence.hide(() => this.exit(target)).then(() => {
      if (token !== this.token) return;
      this.removeModel();
      void this.rendererReady?.then((r) => { if (token === this.token) r.setAnimationLoop(null); });
    });
    focusQuietly(target?.closest<HTMLElement>('[tabindex]') ?? back);
  }

  // —— 进场 ——
  private enter(from: DOMRect | null): Array<Animation | null> {
    const list: Array<Animation | null> = [animate(this.backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out', fill: 'backwards' })];
    if (reducedMotion()) {
      for (const n of [this.stage, this.info, this.closeButton]) list.push(animate(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', fill: 'backwards' }));
      return list;
    }
    // 共用元素：舞台从卡片的位置、大小放大到全屏的舞台；没有来处（直接打开地址）时从中间轻轻放大
    const grow = from ? flipFrom(this.stage, from, { duration: 640, easing: curve('settle'), fill: 'backwards' }) : null;
    list.push(
      grow ?? animate(this.stage, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 560, easing: curve('spring'), fill: 'backwards' }),
      animate(this.info, [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: 640, delay: 140, easing: curve('spring'), fill: 'backwards' }),
      animate(this.closeButton, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 280, easing: curve('settle'), fill: 'backwards' }),
    );
    return list;
  }

  // —— 退场：舞台缩回卡片（卡片看得见时），最后一段淡掉，露出卡片里转着的模型 ——
  private exit(target: HTMLElement | null): Array<Animation | null> {
    const reduce = reducedMotion();
    const list: Array<Animation | null> = [
      animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 200 : 360, easing: 'ease-in', fill: 'forwards' }),
      animate(this.canvas, [{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 200 : 140, easing: 'ease-in', fill: 'forwards' }),
    ];
    const outs: Array<[HTMLElement, Keyframe[], number]> = reduce
      ? [[this.stage, [{ opacity: 1 }, { opacity: 0 }], 200], [this.info, [{ opacity: 1 }, { opacity: 0 }], 200], [this.closeButton, [{ opacity: 1 }, { opacity: 0 }], 160]]
      : [[this.info, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(40px)' }], 220], [this.closeButton, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.9)' }], 200]];
    for (const [n, frames, duration] of outs) list.push(animate(n, frames, { duration, easing: EASE_IN, fill: 'forwards' }));
    if (reduce) return list;
    const to = target?.getBoundingClientRect();
    if (to && onScreen(to)) {
      const from = this.stage.getBoundingClientRect();
      const t = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
      list.push(animate(this.stage, [
        { transform: 'none', opacity: 1, transformOrigin: '0 0' },
        { transform: t, opacity: 1, transformOrigin: '0 0', offset: 0.78 },
        { transform: t, opacity: 0, transformOrigin: '0 0' },
      ], { duration: 520, easing: EASE_OUT, fill: 'forwards' }));
    } else {
      list.push(animate(this.stage, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.92)' }], { duration: 260, easing: EASE_IN, fill: 'forwards' }));
    }
    return list;
  }

  private showInfo(work: Work, team: Team, failed: boolean): void {
    this.info.replaceChildren(
      ...workInfo(work, team, failed),
      el('div', { className: 'viewer-hints' },
        el('span', { className: 'hint' }, icon('orbit'), 'Drag to spin'),
        el('span', { className: 'hint' }, icon('mouse'), 'Scroll or pinch to zoom'),
        el('span', { className: 'hint' }, el('kbd', { textContent: 'Esc' }), 'to close'),
      ),
    );
  }

  // 拿掉上一件作品、回到 Loading：重新打开时不会先闪出上一件作品的最后一帧
  private removeModel(): void {
    this.stage.classList.remove('ready');
    if (this.current) this.scene.remove(this.current);
    this.current = null;
  }

  private async load(work: Work, team: Team, token: number): Promise<void> {
    this.rendererReady ??= this.createRenderer();
    const renderer = await this.rendererReady;
    const model = await this.library.load(work);
    if (token !== this.token) return;
    // 挂上场景之前在后台编译好着色器、传好贴图和几何：第一帧不在主线程上同步编译（这期间舞台显示 Loading）
    frameModel(this.camera, model.height);
    await compileUnculled(renderer, model.object, this.camera, this.scene);
    if (token !== this.token) return;
    if (model.failed) this.showInfo(work, team, true);
    this.current = model.object;
    this.scene.add(model.object);
    const controls = this.controls!;
    controls.target.set(0, model.height * 0.5, 0);
    controls.update();
    this.frame(renderer); // 先画好一帧再露出画布
    this.stage.classList.add('ready');
    renderer.setAnimationLoop(() => this.frame(renderer));
  }

  private async createRenderer(): Promise<THREE.WebGPURenderer> {
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true });
    await renderer.init();
    renderer.setClearColor(0x000000, 0);
    useLook(renderer);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    // 标签页切到后台：停掉查看器的循环；回来时还开着、模型也在，就接着画（OrbitControls 的阻尼按帧算，没有时间差要补）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) renderer.setAnimationLoop(null);
      else if (this.isOpen && this.current) renderer.setAnimationLoop(() => this.frame(renderer));
    });
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 14;
    return renderer;
  }

  private frame(renderer: THREE.WebGPURenderer): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    renderer.getSize(this.size);
    if (this.size.x !== w || this.size.y !== h) {
      renderer.setSize(w, h, false);
      this.setAspect(w / h);
    }
    this.controls!.update();
    renderer.render(this.scene, this.camera);
  }

  // 宽高比变了重新取景：保持用户转到的方向和缩放比例，镜头距离按新的取景距离等比调整（竖屏时模型也不被裁掉）
  private setAspect(aspect: number): void {
    const controls = this.controls!;
    const before = fitDistance(this.camera);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const fit = fitDistance(this.camera);
    controls.maxDistance = Math.max(14, fit * 2);
    this.camera.position.sub(controls.target).multiplyScalar(fit / before).add(controls.target);
  }
}

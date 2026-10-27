import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelLibrary } from '../assets/models';
import type { Team, Work } from '../data/types';
import { addStudioLights } from '../scenes/lights';
import { el } from '../ui/dom';
import { workInfo } from '../ui/workCard';
import { fitDistance, frameModel } from './framing';

// 大图查看器：独立的 canvas 和渲染器（不依赖分区渲染），拖动 360° 旋转、滚轮缩放
// open() 不等模型：信息面板立刻换好，模型在后台加载（不占住路由队列）；
// 模型画出第一帧之前舞台显示 Loading，.viewer-stage 加上 ready 类之后才露出画布（脚本也等这个类）
export class Viewer {
  isOpen = false;
  private readonly node = el('div', { className: 'viewer' });
  private readonly stage = el('div', { className: 'viewer-stage' });
  private readonly canvas = el('canvas');
  private readonly info = el('div', { className: 'viewer-info' });
  private readonly library = new ModelLibrary();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly size = new THREE.Vector2();
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private controls: OrbitControls | null = null;
  private current: THREE.Object3D | null = null;
  private token = 0; // 每次 open / close 加一：晚到的模型对不上号就丢掉
  private readonly onClose: () => void;
  private readonly onToggle: (open: boolean) => void;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, onClose: () => void, onToggle: (open: boolean) => void) {
    this.onClose = onClose;
    this.onToggle = onToggle;
    // 不设 scene.background：色调映射会把背景色一起压暗，舞台底色改由 CSS 给，画布是透明的
    addStudioLights(this.scene);
    this.stage.append(this.canvas);
    this.node.append(
      this.stage,
      this.info,
      el('button', { className: 'viewer-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.onClose() }),
    );
    this.node.hidden = true;
    root.append(this.node);
  }

  open(work: Work, team: Team): void {
    const token = ++this.token;
    this.showInfo(work, team, false);
    this.removeModel();
    if (!this.isOpen) {
      this.isOpen = true;
      this.node.hidden = false;
      this.onToggle(true);
      addEventListener('keydown', this.onKey);
    }
    this.load(work, team, token).catch((err: unknown) => console.error(err));
  }

  close(): void {
    if (!this.isOpen) return;
    this.token++;
    this.isOpen = false;
    this.node.hidden = true;
    this.removeModel();
    void this.rendererReady?.then((r) => r.setAnimationLoop(null));
    removeEventListener('keydown', this.onKey);
    this.onToggle(false);
  }

  private showInfo(work: Work, team: Team, failed: boolean): void {
    this.info.replaceChildren(
      ...workInfo(work, team, failed),
      el('div', { className: 'mono hint', textContent: 'Drag to rotate · scroll to zoom · Esc to close' }),
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
    if (model.failed) this.showInfo(work, team, true);
    this.current = model.object;
    this.scene.add(model.object);
    frameModel(this.camera, model.height);
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
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
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

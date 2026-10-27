import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelLibrary } from '../assets/models';
import type { Team, Work } from '../data/types';
import { addStudioLights } from '../scenes/lights';
import { el, formatTris } from '../ui/dom';
import { frameModel } from './framing';

// 大图查看器：独立的 canvas 和渲染器（不依赖分区渲染），拖动 360° 旋转、滚轮缩放
export class Viewer {
  isOpen = false;
  private readonly node = el('div', { className: 'viewer' });
  private readonly canvas = el('canvas');
  private readonly info = el('div', { className: 'viewer-info' });
  private readonly library = new ModelLibrary();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly size = new THREE.Vector2();
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private controls: OrbitControls | null = null;
  private current: THREE.Object3D | null = null;
  private readonly onClose: () => void;
  private readonly onToggle: (open: boolean) => void;
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.onClose(); };

  constructor(root: HTMLElement, onClose: () => void, onToggle: (open: boolean) => void) {
    this.onClose = onClose;
    this.onToggle = onToggle;
    this.scene.background = new THREE.Color('#14151c');
    addStudioLights(this.scene);
    this.node.append(
      el('div', { className: 'viewer-stage' }, this.canvas),
      this.info,
      el('button', { className: 'viewer-close', textContent: '×', ariaLabel: 'Close', onclick: () => this.onClose() }),
    );
    this.node.hidden = true;
    root.append(this.node);
  }

  async open(work: Work, team: Team): Promise<void> {
    const author = team.members.find((m) => m.id === work.authorId);
    const index = team.works.findIndex((w) => w.id === work.id) + 1;
    this.info.replaceChildren(
      el('div', { className: 'mono', textContent: `No. ${String(index).padStart(3, '0')} · ${formatTris(work.tris)}` }),
      el('h2', { className: 'display', textContent: work.title }),
      el('div', { className: 'wc-by', textContent: `by @${author?.handle ?? 'unknown'} · ${team.name}` }),
      ...(work.description ? [el('p', { className: 'wc-desc', textContent: work.description })] : []),
      el('div', { className: 'mono hint', textContent: 'Drag to rotate · scroll to zoom · Esc to close' }),
    );
    if (!this.isOpen) {
      this.isOpen = true;
      this.node.hidden = false;
      this.onToggle(true);
      addEventListener('keydown', this.onKey);
    }
    this.rendererReady ??= this.createRenderer();
    const renderer = await this.rendererReady;
    const model = await this.library.load(work);
    if (!this.isOpen) return;
    if (this.current) this.scene.remove(this.current);
    this.current = model.object;
    this.scene.add(model.object);
    frameModel(this.camera, model.height);
    this.controls!.target.set(0, model.height * 0.5, 0);
    this.controls!.update();
    renderer.setAnimationLoop(() => this.frame(renderer));
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.node.hidden = true;
    void this.rendererReady?.then((r) => r.setAnimationLoop(null));
    removeEventListener('keydown', this.onKey);
    this.onToggle(false);
  }

  private async createRenderer(): Promise<THREE.WebGPURenderer> {
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true });
    await renderer.init();
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
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls!.update();
    renderer.render(this.scene, this.camera);
  }
}

import * as THREE from 'three/webgpu';
import { useLook } from '../scenes/look';
import { compileUnculled } from '../scenes/stager';

// 一个 canvas 画多个小视口，每个视口跟着页面上一个元素走（scissor）
// WebGPU 的 render() 在 autoClear 打开时会清空整张画布（scissor 管不住 loadOp clear），
// 所以这里关掉 autoClear，每帧开头手动清一次；setScissor / setViewport 用左上角原点、CSS 像素
export interface View {
  element: HTMLElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  tick?: (dt: number) => void;
}

const size = new THREE.Vector2();

export class MultiView {
  readonly renderer: THREE.WebGPURenderer;
  private readonly views = new Set<View>();

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
  }

  static async create(canvas: HTMLCanvasElement): Promise<MultiView> {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    await renderer.init();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    useLook(renderer);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    return new MultiView(renderer);
  }

  get backendName(): 'webgpu' | 'webgl2' {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  add(view: View): () => void {
    this.views.add(view);
    return () => this.views.delete(view);
  }

  clearViews(): void {
    this.views.clear();
  }

  // 在后台编译一个视口的场景（compileUnculled）。先把绘图缓冲定成画布现在的尺寸再编：
  // 渲染器刚建好时绘图缓冲是 canvas 默认的 300×150，要等第一次 render() 才改成画布的尺寸。compileAsync 分好几帧做完，
  // 中途改尺寸的话，three 会重建画到画布时用的中间缓冲（多采样颜色 + 深度），换上一张新的深度贴图；
  // 正在编的管线还指着旧的那张（已经销毁），WebGPU 建管线时读不到深度格式（depthStencil.format 是 undefined），控制台报错。
  // 画布藏着（尺寸 0）时定不了，照常编
  compile(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    this.fit();
    return compileUnculled(this.renderer, scene, camera, scene);
  }

  // 每帧调用一次：同步画布尺寸 → 整张清空 → 逐个视口渲染（不在屏幕里的跳过）
  render(dt: number): void {
    if (!this.fit()) return;
    const r = this.renderer;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    r.setScissorTest(false);
    r.clear();
    r.setScissorTest(true);
    for (const v of this.views) {
      const rect = v.element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= h || rect.left >= w) continue;
      v.tick?.(dt);
      v.camera.aspect = rect.width / rect.height;
      v.camera.updateProjectionMatrix();
      // 视口可以伸出画布（投影不变形），scissor 必须夹在画布里
      const x0 = Math.max(0, rect.left);
      const y0 = Math.max(0, rect.top);
      const x1 = Math.min(w, rect.right);
      const y1 = Math.min(h, rect.bottom);
      r.setViewport(rect.left, rect.top, rect.width, rect.height);
      r.setScissor(x0, y0, x1 - x0, y1 - y0);
      r.render(v.scene, v.camera);
    }
  }

  // 绘图缓冲跟上画布的 CSS 尺寸。canvas 被隐藏时尺寸是 0，不能 setSize(0, 0)：不动，返回 false
  private fit(): boolean {
    const r = this.renderer;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    if (w === 0 || h === 0) return false;
    r.getSize(size);
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
    return true;
  }
}

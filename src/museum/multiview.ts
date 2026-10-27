import * as THREE from 'three/webgpu';
import { useLook } from '../scenes/look';

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

  // 每帧调用一次：同步画布尺寸 → 整张清空 → 逐个视口渲染（不在屏幕里的跳过）
  render(dt: number): void {
    const r = this.renderer;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    if (w === 0 || h === 0) return; // canvas 被隐藏时尺寸是 0，不能 setSize(0, 0)
    r.getSize(size);
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
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
}

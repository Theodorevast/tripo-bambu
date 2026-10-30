import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { normalizeModel, type LoadedModel } from '../assets/models';
import { fitDistance, frameModel } from '../museum/framing';
import { addStudioLights } from '../scenes/lights';
import { useLook } from '../scenes/look';
import { compileUnculled } from '../scenes/stager';

// 上传、生成窗口里的模型预览（拖动 360° 旋转、滚轮缩放、慢慢自转），和缩略图（离屏渲染一张 256×256 的透明背景 WebP）。
// 和 Museum 的大图查看器（museum/viewer.ts）一样：自己的画布和渲染器、摄影棚灯光、色调映射，模型挂上之前先在后台编译好着色器。
// 主画面照常跑，不停。窗口关掉（或预览藏起来）时停掉循环，模型从 GPU 上拿掉。
// 缩略图不依赖窗口：生成任务在后台完成时也要截，所以另开一个不挂在页面上的画布（thumbnailer()），截完就拿掉模型

const THUMB_SIZE = 256;
const THUMB_TURN = -Math.PI / 6; // 缩略图的角度：和 prep-models 截的种子作品一样（dev/thumb.ts）
const SPIN = 0.35; // 预览没人拖时每秒自转多少弧度

// 解析 GLB（主线程只建对象，meshopt 解码在 ModelLibrary 开的 Worker 里），归一化（最长边 = WORK_SIZE，底在 y = 0）
async function parseGlb(data: ArrayBuffer): Promise<LoadedModel> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, '');
  return normalizeModel(gltf.scene);
}

// 拿掉一个模型：几何、材质、贴图都释放（预览换了好几件也不攒着 GPU 内存）
function disposeObject(root: THREE.Object3D): void {
  root.removeFromParent();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!m) continue;
      for (const v of Object.values(m)) if ((v as THREE.Texture | null)?.isTexture) (v as THREE.Texture).dispose();
      m.dispose();
    }
  });
}

export class ModelStage {
  readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly size = new THREE.Vector2();
  private readonly interactive: boolean;
  private rendererReady: Promise<THREE.WebGPURenderer> | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private controls: OrbitControls | null = null;
  private model: LoadedModel | null = null;
  private token = 0;
  private running = false;
  private visible = true;
  private last = -1;
  private idle = 0; // 多久没人拖了（秒）：拖完停一会儿再接着自转

  // interactive = false：只截缩略图（不挂在页面上，没有 OrbitControls）
  constructor(canvas: HTMLCanvasElement, interactive = true) {
    this.canvas = canvas;
    this.interactive = interactive;
    addStudioLights(this.scene);
  }

  get hasModel(): boolean {
    return this.model !== null;
  }

  // 换上一件模型（GLB 的字节）。编译好、画好第一帧才返回；期间又换了别的（或 clear）就丢掉这一件，返回 null
  async show(glb: ArrayBuffer | Uint8Array | Blob): Promise<LoadedModel | null> {
    const token = ++this.token;
    const data = glb instanceof Blob ? await glb.arrayBuffer() : glb instanceof Uint8Array ? glb.slice().buffer : glb;
    const renderer = await this.ensureRenderer();
    const model = await parseGlb(data);
    if (token !== this.token) {
      disposeObject(model.object);
      return null;
    }
    frameModel(this.camera, model.height);
    await compileUnculled(renderer, model.object, this.camera, this.scene);
    if (token !== this.token) {
      disposeObject(model.object);
      return null;
    }
    this.dropModel();
    this.model = model;
    this.scene.add(model.object);
    this.idle = 0;
    if (this.controls) {
      this.controls.target.set(0, model.height * 0.5, 0);
      this.controls.update();
    }
    if (this.interactive) {
      this.frame(0);
      this.loop();
    }
    return model;
  }

  // 拿掉模型（换下一件之前、窗口关掉时）
  clear(): void {
    this.token++;
    this.dropModel();
    this.stopLoop();
  }

  // 预览看不看得见（窗口关了、换了标签页）：看不见时停掉循环
  setVisible(on: boolean): void {
    this.visible = on;
    if (on) this.loop();
    else this.stopLoop();
  }

  // 截一张缩略图：固定的 3/4 角度、透明背景、256×256 WebP。没有模型或截不出来时返回 null
  async capture(size = THUMB_SIZE): Promise<Blob | null> {
    const model = this.model;
    const renderer = this.renderer;
    if (!model || !renderer) return null;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    frameModel(cam, model.height);
    const turn = model.object.rotation.y;
    const ratio = renderer.getPixelRatio();
    renderer.getSize(this.size);
    const restore = { w: this.size.x, h: this.size.y };
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    try {
      // 改尺寸、画、拷出来、改回去在同一个任务里做完：画布上只会留下改回去以后的那一帧
      model.object.rotation.y = THUMB_TURN;
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      renderer.render(this.scene, cam);
      out.getContext('2d')?.drawImage(renderer.domElement, 0, 0, size, size);
    } finally {
      model.object.rotation.y = turn;
      renderer.setPixelRatio(ratio);
      if (restore.w > 0 && restore.h > 0) renderer.setSize(restore.w, restore.h, false);
      if (this.running) this.frame(0);
    }
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/webp', 0.85));
  }

  private dropModel(): void {
    if (this.model) disposeObject(this.model.object);
    this.model = null;
  }

  private ensureRenderer(): Promise<THREE.WebGPURenderer> {
    this.rendererReady ??= (async () => {
      const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true });
      await renderer.init();
      renderer.setClearColor(0x000000, 0);
      useLook(renderer);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      if (!this.interactive) renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
      if (this.interactive) {
        const controls = new OrbitControls(this.camera, this.canvas);
        controls.enableDamping = true;
        controls.enablePan = false;
        controls.minDistance = 2.5;
        controls.maxDistance = 14;
        controls.addEventListener('start', () => { this.idle = -Infinity; });
        controls.addEventListener('end', () => { this.idle = 0; });
        this.controls = controls;
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.stopLoop();
          else this.loop();
        });
      }
      this.renderer = renderer;
      return renderer;
    })();
    return this.rendererReady;
  }

  private loop(): void {
    const renderer = this.renderer;
    if (!this.interactive || !renderer || !this.model || !this.visible || this.running || (typeof document !== 'undefined' && document.hidden)) return;
    this.running = true;
    this.last = -1;
    renderer.setAnimationLoop((t) => {
      const dt = this.last < 0 ? 0 : Math.min((t - this.last) / 1000, 0.1);
      this.last = t;
      this.frame(dt);
    });
  }

  private stopLoop(): void {
    if (!this.running) return;
    this.running = false;
    this.renderer?.setAnimationLoop(null);
  }

  private frame(dt: number): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    renderer.getSize(this.size);
    if (this.size.x !== w || this.size.y !== h) {
      renderer.setSize(w, h, false);
      this.setAspect(w / h);
    }
    // 没人拖时慢慢自转（拖完停 1.5 秒再接着转）；减弱动效时不自转
    if (this.model && dt > 0 && !reduced()) {
      this.idle += dt;
      if (this.idle > 1.5) this.model.object.rotation.y += dt * SPIN * Math.min(1, (this.idle - 1.5) / 0.8);
    }
    this.controls?.update();
    renderer.render(this.scene, this.camera);
  }

  // 宽高比变了重新取景（同查看器）：保持转到的方向和缩放比例，竖屏时模型也不被裁掉
  private setAspect(aspect: number): void {
    const before = fitDistance(this.camera);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const fit = fitDistance(this.camera);
    const target = this.controls?.target ?? new THREE.Vector3(0, (this.model?.height ?? 1) * 0.5, 0);
    if (this.controls) this.controls.maxDistance = Math.max(14, fit * 2);
    this.camera.position.sub(target).multiplyScalar(fit / before).add(target);
  }
}

function reduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 截缩略图用的舞台：不挂在页面上，整个页面一个，第一次用时才建渲染器。一次只截一张（排队）
let thumbStage: ModelStage | null = null;
let thumbQueue: Promise<unknown> = Promise.resolve();

export function thumbnailOf(glb: ArrayBuffer | Uint8Array | Blob): Promise<Blob | null> {
  const run = thumbQueue.then(async () => {
    thumbStage ??= new ModelStage(document.createElement('canvas'), false);
    try {
      const model = await thumbStage.show(glb);
      return model ? await thumbStage.capture() : null;
    } finally {
      thumbStage.clear();
    }
  });
  thumbQueue = run.catch(() => {});
  return run.catch((err: unknown) => {
    console.warn('thumbnail failed', err);
    return null;
  });
}

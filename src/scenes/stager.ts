import * as THREE from 'three/webgpu';
import { modelTextures } from '../assets/models';
import { compileShadowExact, compileSides } from './shadowWarm';

// 新模型上场。实测（30 万面的真实模型，进入星球时 4 件一起到）卡在挂上场景后的第一帧：
// WebGL2 在这一帧里同步链接着色器、上传贴图，一帧 100–200 ms；WebGPU 主线程只忙 60 ms，但 GPU 进程同步建管线，画面停约 200 ms。
// 这里分三步，每一步都不让某一帧卡住：
// 1. 贴图逐帧上传：每帧最多一张（2048² 一张在 WebGL2 上约 20 ms）
// 2. renderer.compileAsync 预编译最终外观和淡入用的半透明外观：着色器在后台编译
//    （WebGPU 用 createRenderPipelineAsync，WebGL2 用 KHR_parallel_shader_compile），几何也在这一步上传
// 3. 排队挂上：每帧最多放行一个；挂上后约 0.35 秒缩放（带一点回弹）加淡入，结束时换回原材质（预编译过，不卡）

export const APPEAR_SECONDS = 0.35;
const APPEAR_FROM = 0.6; // 起始缩放：从展台上「长」出来，而不是从一个点冒出来
const BACK = 1.4; // easeOutBack 的回弹强度：常见的 1.70158 过冲约 10%，1.4 约 7%

// 缓出带回弹：t = 0 → 0，t = 1 → 1，中途略超过 1 再落回
export function easeOutBack(t: number, c1 = BACK): number {
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

export interface Entrance {
  start(): void; // 已经挂上场景：开始缩放加淡入
  cancel(): void; // 不挂了：换回原材质，扔掉淡入用的材质
}

// PlanetView 用到的部分（单元测试里换成立刻放行的假实现）
export interface Stage {
  // object 还没挂上场景：把它的贴图、几何、着色器都准备好
  precompile(object: THREE.Object3D): Promise<void>;
  // 准备好、轮到它挂上（每帧最多一个）时 resolve；alive() 变成 false（离开星球、作品被删）就提前收手，返回 null
  prepare(object: THREE.Object3D, alive?: () => boolean): Promise<Entrance | null>;
}

// 一个网格淡入期间换成的材质：原材质的克隆，打开 transparent。克隆和原材质各有一份渲染对象和管线，
// 淡入结束换回原材质时用的是预编译好的那份；要是直接改原材质的 transparent，three 会扔掉原来那份管线、换回来时再同步编译一次
interface Swap {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  fades: THREE.Material[];
  opacity: number[]; // 原材质的不透明度：淡入的终点
}

function makeSwaps(object: THREE.Object3D): Swap[] {
  const swaps: Swap[] = [];
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    const fades = list.map((m) => {
      const fade = m.clone();
      fade.transparent = true;
      fade.opacity = 0;
      // 一遍画完（F2）：本来双面的材质打开 transparent 以后，three r186 会拆成背面、正面两遍画（side 临时改），预编译编到的是双面那一份，
      // 淡入第一帧在出帧时同步建两条管线。淡入只有 0.35 秒，和淡完以后的不透明原材质一样一遍画完就行；投影那一遍照样拆，由 shadowWarm.ts 备两份替身
      fade.forceSinglePass = true;
      return fade;
    });
    swaps.push({ mesh, original, fades, opacity: list.map((m) => m.opacity) });
  });
  return swaps;
}

// 预编译 object（scene 是它所在或要挂进去的场景：灯光按那个场景算）。object 要么还没挂上场景，要么这期间不渲染
// （World.warmUp）：compileAsync 照样做视锥剔除，不在镜头里的会被跳过，这里临时关掉剔除，编译完再恢复
export async function compileUnculled(renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<void> {
  const culled: THREE.Object3D[] = [];
  object.traverse((o) => {
    if (!o.frustumCulled) return;
    culled.push(o);
    o.frustumCulled = false;
  });
  try {
    await renderer.compileAsync(object, camera, scene);
  } finally {
    for (const o of culled) o.frustumCulled = true;
  }
}

// 投影那一遍的预编译在 shadowWarm.ts（compileShadowExact）：按 three r186 真正画阴影时的状态编

function wear(swaps: Swap[]): void {
  for (const s of swaps) s.mesh.material = Array.isArray(s.original) ? s.fades : s.fades[0];
}

function restore(swaps: Swap[]): void {
  for (const s of swaps) {
    s.mesh.material = s.original;
    for (const fade of s.fades) fade.dispose();
  }
}

export class Stager implements Stage {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private waiters: Array<() => void> = []; // 等下一帧的
  private readonly slots: Array<() => void> = []; // 等挂上的：每帧放行一个
  private readonly playing = new Set<(dt: number) => boolean>(); // 正在缩放淡入的；返回 false 表示播完了
  private queue: Promise<unknown> = Promise.resolve();
  private readonly uploaded = new WeakSet<THREE.Texture>();
  // 投影的光（太阳）：准备新模型时连阴影那一遍的管线也在后台编好（World 设）
  shadowLight: (() => THREE.DirectionalLight | null) | null = null;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
  }

  // 每帧调一次（World.frame，渲染之前）：推进缩放淡入，放行等下一帧的，再放行一个等挂上的
  tick(dt: number): void {
    for (const step of this.playing) if (!step(dt)) this.playing.delete(step);
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
    this.slots.shift()?.();
  }

  precompile(object: THREE.Object3D): Promise<void> {
    return this.serial(async () => {
      await this.compile(object, () => true);
    });
  }

  prepare(object: THREE.Object3D, alive: () => boolean = () => true): Promise<Entrance | null> {
    return this.serial(async () => {
      if (!(await this.compile(object, alive))) return null;
      // 淡入用的半透明材质也先编译好（贴图、几何和原材质共用，上一步已经上传）
      const swaps = makeSwaps(object);
      wear(swaps);
      if (!(await this.compile(object, alive))) {
        restore(swaps);
        return null;
      }
      await new Promise<void>((resolve) => this.slots.push(resolve));
      if (!alive()) {
        restore(swaps);
        return null;
      }
      return {
        start: () => this.play(object, swaps),
        cancel: () => restore(swaps),
      };
    });
  }

  // 一个接一个准备：同时到的几个模型，贴图上传和编译不挤在同一帧里
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  // 贴图每帧传一张，再在后台编译
  private async compile(object: THREE.Object3D, alive: () => boolean): Promise<boolean> {
    for (const texture of modelTextures(object)) {
      if (this.uploaded.has(texture)) continue;
      await this.nextFrame();
      if (!alive()) return false;
      this.renderer.initTexture(texture);
      this.uploaded.add(texture);
    }
    // 主画面那一遍：模型自己「半透明 + 双面」的材质（头发片那种）按背面、正面各编一遍（shadowWarm.ts 的 compileSides）；淡入用的克隆一遍画完，不拆
    await compileSides(this.renderer, object, this.camera, this.scene);
    // 投影那一遍按 three r186 真正画的时候的状态预编译（shadowWarm.ts）；按排队时的状态编（原来的 compileShadow，已删）管线对不上，第一次画还要现建
    await compileShadowExact(this.renderer, object, this.shadowLight?.() ?? null, this.scene);
    return alive();
  }

  private play(object: THREE.Object3D, swaps: Swap[]): void {
    let t = 0;
    object.scale.setScalar(APPEAR_FROM);
    this.playing.add((dt) => {
      t = Math.min(1, t + dt / APPEAR_SECONDS);
      object.scale.setScalar(APPEAR_FROM + (1 - APPEAR_FROM) * easeOutBack(t));
      const a = 1 - (1 - t) ** 3;
      for (const s of swaps) s.fades.forEach((m, i) => { m.opacity = s.opacity[i] * a; });
      if (t < 1) return true;
      object.scale.setScalar(1);
      restore(swaps);
      return false;
    });
  }
}

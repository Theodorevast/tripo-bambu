import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Work } from '../data/types';
import { fitToSize } from '../planet/placement';
import { placeholderModel } from './placeholder';
import { assetUrl, hasAsset } from './versions';

export interface LoadedModel {
  object: THREE.Group; // 已归一化：最长边 = WORK_SIZE，水平居中，底部在 y=0
  height: number; // 归一化后的高度
  footprint: number; // 归一化后的水平半径
  failed: boolean;
}

const EXTERNAL = /^(blob:|https?:|data:)/;

// blob:（拖进来的 GLB）和完整网址原样用，其余拼到 public/models/ 下（带内容指纹，assets/versions.ts）
export function modelUrl(file: string): string {
  return EXTERNAL.test(file) ? file : assetUrl(`models/${file}`);
}

// 星球视图用的轻量模型（public/models/lod/，scripts/lib/lod.mjs 出的：只减面，贴图原样）：有就用它，
// 没有（本来就不重的模型、用户作品、完整网址）用原文件。地址带 ?lod=0 时一律用原文件（对比、排查用）
const LOD_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lod') === '0';
export function lodUrl(file: string): string {
  return LOD_OFF || EXTERNAL.test(file) || !hasAsset(`models/lod/${file}`) ? modelUrl(file) : assetUrl(`models/lod/${file}`);
}

// 用户作品的缩略图是 blob:（IndexedDB 里的图片注册成的地址），和完整网址一样原样用
export function thumbUrl(file: string): string {
  return EXTERNAL.test(file) ? file : assetUrl(`thumbs/${file}`);
}

// 贴图的各向异性过滤：斜着看的表面（侧面、顶面、地面）不糊。三个渲染器（主画面、Museum 卡片、查看器）共用一个值：
// World.create 在主渲染器初始化后设成 min(16, 它支持的最大值)；设之前是 1，等于不开（three 的默认）
let anisotropy = 1;

export function setModelAnisotropy(value: number): void {
  anisotropy = Math.max(1, Math.floor(value));
}

// 模型里所有材质用到的贴图（去重；材质可以是数组）
export function modelTextures(root: THREE.Object3D): THREE.Texture[] {
  const found = new Set<THREE.Texture>();
  root.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) if ((value as THREE.Texture | null)?.isTexture) found.add(value as THREE.Texture);
    }
  });
  return [...found];
}

export function applyAnisotropy(root: THREE.Object3D, value: number): void {
  for (const texture of modelTextures(root)) texture.anisotropy = value;
}

// 作品里不透明的材质一律双面画：Tripo 生成的模型常常不封口、有些面绕向是反的（示例扶手椅 3% 的边是开口），
// 单面画时从开口、反面看过去是一个个洞，直接漏出背景。投影照旧：PCF 下单面材质投影用背面，这里写明 BackSide，
// 阴影和预热的投影管线都不变。半透明的不动：three r186 画「半透明 + 双面」要拆两遍（见 scenes/shadowWarm.ts）
export function applyDoubleSided(root: THREE.Object3D): void {
  root.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (m.transparent || m.side !== THREE.FrontSide) continue;
      m.side = THREE.DoubleSide;
      m.shadowSide ??= THREE.BackSide;
    }
  });
}

// meshopt 解码放进 Worker（GLTFLoader 有 decodeGltfBufferAsync 就走它），解压几何不占主线程。整个页面开一次，node 里跑测试时没有 Worker
let decoderWorkers = false;
function startDecoderWorkers(): void {
  if (decoderWorkers || typeof Worker === 'undefined') return;
  decoderWorkers = true;
  MeshoptDecoder.useWorkers(2);
}

// 下载的优先级（数小的先）：现在就要用的 > 指着星球时的预取 > 首页空闲时的预取
export const NOW = 0;
export const HOVER = 1;
export const IDLE = 2;

interface Job {
  priority: number;
  seq: number; // 同一优先级里先来先下
  state: 'waiting' | 'running' | 'done';
  bytes: Promise<ArrayBuffer>;
  start: () => void;
}

// 主画面的下载队列：现在要用的（NOW）一次只下一件，按来的先后；预取（HOVER、IDLE）只在没有别的下载时才下，也是一次一件。
// 慢网上（国内连 Cloudflare 实测约 0.3 MB/s）几件一起下载时带宽平分，每件都要等到快结束才到齐，作品一起很晚才出场；
// 一件一件下，最先要的几秒就能上场，总时间差不多。预取正在下的时候来了 NOW：NOW 不等它，两个一起下（预取最多占一路）
export class Downloads {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;
  private readonly load: (url: string, priority: number) => Promise<ArrayBuffer>;

  constructor(load: (url: string, priority: number) => Promise<ArrayBuffer> = fetchBytes) {
    this.load = load;
  }

  // 拿到这个地址的字节（排队下载；已经在下、下好了就用那一份）。priority 比原来的急就提前
  get(url: string, priority: number): Promise<ArrayBuffer> {
    const had = this.jobs.get(url);
    if (had) {
      if (priority < had.priority) {
        had.priority = priority;
        had.seq = this.seq++; // 提成急件以后排在已经在等的急件后面
        this.pump();
      }
      return had.bytes;
    }
    const job = { priority, seq: this.seq++, state: 'waiting' } as Job;
    job.bytes = new Promise<ArrayBuffer>((resolve, reject) => {
      job.start = () => {
        job.state = 'running';
        this.load(url, job.priority)
          .then(resolve, reject)
          .finally(() => {
            job.state = 'done';
            this.pump();
          });
      };
    });
    this.jobs.set(url, job);
    job.bytes.catch(() => { if (this.jobs.get(url) === job) this.jobs.delete(url); }); // 失败了下次重新下
    this.pump();
    return job.bytes;
  }

  // 还在排队的话按 priority 提前；不在队列里（下完交出去了、从来没排过）什么都不做
  bump(url: string, priority: number): void {
    if (this.jobs.has(url)) this.get(url, priority).catch(() => {});
  }

  // 字节交给解析以后就不留了（解析出来的模型在 ModelLibrary 的缓存里）；还没下完的不动
  release(url: string): void {
    if (this.jobs.get(url)?.state === 'done') this.jobs.delete(url);
  }

  private pump(): void {
    for (;;) {
      let next: Job | null = null;
      let running = 0;
      let urgentRunning = false;
      for (const j of this.jobs.values()) {
        if (j.state === 'running') {
          running++;
          urgentRunning ||= j.priority === NOW;
        } else if (j.state === 'waiting' && (!next || j.priority < next.priority || (j.priority === next.priority && j.seq < next.seq))) {
          next = j;
        }
      }
      // 没有在下的就开下一件；急件只等急件，不等预取
      if (!next || !(running === 0 || (next.priority === NOW && !urgentRunning))) return;
      next.start();
    }
  }
}

// 低优先级提示：预取不和页面要用的东西抢（浏览器、HTTP/2、HTTP/3 都按它排）
async function fetchBytes(url: string, priority: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { priority: priority === NOW ? 'high' : 'low' } as RequestInit);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.arrayBuffer();
}

export interface LibraryOptions {
  // 主画面用（F2）：解析一次只解析一件；下载也排队（Downloads：一次一件，按优先级）。
  // 几件同时解析时，建对象、拷贝贴图数据、meshopt 的结果回来这些主线程上的活挤在同几帧里，进星球、跳星球的转场开头掉到 33–50 ms
  oneAtATime?: boolean;
  lod?: boolean; // 用星球视图的轻量模型（lodUrl）：主画面、Museum 的卡片预览；大图查看器用原文件
}

// 每个渲染器用自己的实例：GPU 资源不跨渲染器共享。
// GLB 整块读（不走 FileLoader 把数据一块一块交给 JS 的流）
export class ModelLibrary {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly cache = new Map<string, Promise<THREE.Object3D>>();
  private parsing: Promise<unknown> = Promise.resolve();
  private readonly downloads: Downloads | null;
  private readonly lod: boolean;
  private readonly warmed = new Set<string>(); // warmFull 下过的原文件（在 HTTP 缓存里了）

  constructor(opts: LibraryOptions = {}) {
    this.downloads = opts.oneAtATime ? new Downloads() : null;
    this.lod = opts.lod ?? false;
    startDecoderWorkers();
  }

  // 这个库给这件作品用的地址：星球视图用 LOD（有的话），其余用原文件
  urlOf(file: string): string {
    return this.lod ? lodUrl(file) : modelUrl(file);
  }

  // 只下载、解析进缓存，不给克隆（指着星球、名牌时先准备它的作品）；失败了也不报，真正要用时再报
  preload(work: Pick<Work, 'file'>): void {
    if (work.file) this.fetch(this.urlOf(work.file), HOVER).catch(() => {});
  }

  // 只下载、不解析（首页空闲时预取「你的星球」的作品，主线程上不做事；main.ts）。字节留着，进星球时直接解析。
  // 没有下载队列的库（Museum、查看器）不做
  prefetch(work: Pick<Work, 'file'>): void {
    if (!work.file || !this.downloads || EXTERNAL.test(work.file)) return;
    const url = this.urlOf(work.file);
    if (!this.cache.has(url)) this.downloads.get(url, IDLE).catch(() => {});
  }

  // 预热原文件，给大图查看器（它有自己的库，不排队）：主画面用的是 LOD 时，在队列里按预取的优先级下载原文件，字节不留，
  // 留在浏览器的 HTTP 缓存里（public/_headers 让它一年内不用再问），点开查看器时直接从缓存读。点了作品、打开 Museum 时调
  warmFull(work: Pick<Work, 'file'>): void {
    if (!work.file || !this.downloads || EXTERNAL.test(work.file)) return;
    const url = modelUrl(work.file);
    if (url === this.urlOf(work.file) || this.cache.has(url) || this.warmed.has(url)) return;
    this.warmed.add(url);
    this.downloads.get(url, IDLE).then(() => this.downloads?.release(url), () => this.warmed.delete(url));
  }

  async load(work: Pick<Work, 'id' | 'file'>): Promise<LoadedModel> {
    if (!work.file) return normalize(placeholderModel(work.id), false);
    try {
      return normalize(cloneSkinned(await this.fetch(this.urlOf(work.file), NOW)), false);
    } catch (err) {
      console.warn(`model failed: ${work.file}`, err);
      return normalize(failedModel(), true);
    }
  }

  private fetch(url: string, priority: number): Promise<THREE.Object3D> {
    let p = this.cache.get(url);
    if (p) {
      this.downloads?.bump(url, priority); // 还在排队下载的话，按这次的优先级提前
      return p;
    }
    // 各向异性要在第一次上传贴图之前设好（WebGL2 在上传时设采样参数，WebGPU 按它建采样器）
    p = (this.downloads ? this.loadOneAtATime(url, priority) : this.loader.loadAsync(url)).then((gltf) => {
      applyAnisotropy(gltf.scene, anisotropy);
      applyDoubleSided(gltf.scene);
      return gltf.scene;
    });
    this.cache.set(url, p);
    p.catch(() => this.cache.delete(url));
    return p;
  }

  // 下载排队（本机的 blob:、data: 不排），解析也排队：前一件解析完才开始下一件
  private async loadOneAtATime(url: string, priority: number): Promise<{ scene: THREE.Group }> {
    let data: ArrayBuffer;
    if (/^(blob:|data:)/.test(url) || !this.downloads) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
      data = await res.arrayBuffer();
    } else {
      data = await this.downloads.get(url, priority);
      this.downloads.release(url);
    }
    const run = this.parsing.then(() => this.loader.parseAsync(data, THREE.LoaderUtils.extractUrlBase(url)));
    this.parsing = run.catch(() => {});
    return run;
  }
}

// 上传、生成窗口的预览（works/modelStage.ts）自己解析 GLB，归一化和这里一样
export function normalizeModel(source: THREE.Object3D): LoadedModel {
  applyAnisotropy(source, anisotropy);
  applyDoubleSided(source);
  return normalize(source, false);
}

// 套两层：inner 负责缩放和居中，外层留给调用方随便摆
function normalize(source: THREE.Object3D, failed: boolean): LoadedModel {
  const inner = new THREE.Group();
  inner.add(source);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const { scale, offset } = fitToSize(box);
  inner.scale.setScalar(scale);
  inner.position.copy(offset);
  const object = new THREE.Group();
  object.add(inner);
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(scale);
  return { object, height: size.y, footprint: Math.hypot(size.x, size.z) / 2, failed };
}

// 加载失败时显示的灰色方块
function failedModel(): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: '#6f6a61', roughness: 0.8 }));
  mesh.position.y = 0.5;
  return mesh;
}

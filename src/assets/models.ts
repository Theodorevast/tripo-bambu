import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Work } from '../data/types';
import { fitToSize } from '../planet/placement';
import { placeholderModel } from './placeholder';

export interface LoadedModel {
  object: THREE.Group; // 已归一化：最长边 = WORK_SIZE，水平居中，底部在 y=0
  height: number; // 归一化后的高度
  footprint: number; // 归一化后的水平半径
  failed: boolean;
}

// blob:（拖进来的 GLB）和完整网址原样用，其余拼到 public/models/ 下
export function modelUrl(file: string): string {
  return /^(blob:|https?:|data:)/.test(file) ? file : `${import.meta.env.BASE_URL}models/${file}`;
}

// 用户作品的缩略图是 blob:（IndexedDB 里的图片注册成的地址），和完整网址一样原样用
export function thumbUrl(file: string): string {
  return /^(blob:|https?:|data:)/.test(file) ? file : `${import.meta.env.BASE_URL}thumbs/${file}`;
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

// 每个渲染器用自己的实例：GPU 资源不跨渲染器共享。
// oneAtATime（主画面用，F2）：GLB 照常同时下载（整块读，不走 FileLoader 把数据一块一块交给 JS 的流），解析一次只解析一件。
// 几件同时解析时，建对象、拷贝贴图数据、meshopt 的结果回来这些主线程上的活挤在同几帧里，进星球、跳星球的转场开头掉到 33–50 ms
export class ModelLibrary {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly cache = new Map<string, Promise<THREE.Object3D>>();
  private parsing: Promise<unknown> = Promise.resolve();
  private readonly oneAtATime: boolean;

  constructor(oneAtATime = false) {
    this.oneAtATime = oneAtATime;
    startDecoderWorkers();
  }

  // 只下载、解析进缓存，不给克隆（指着星球、名牌时先准备它的作品）；失败了也不报，真正要用时再报
  preload(work: Pick<Work, 'file'>): void {
    if (work.file) this.fetch(modelUrl(work.file)).catch(() => {});
  }

  async load(work: Pick<Work, 'id' | 'file'>): Promise<LoadedModel> {
    if (!work.file) return normalize(placeholderModel(work.id), false);
    try {
      return normalize(cloneSkinned(await this.fetch(modelUrl(work.file))), false);
    } catch (err) {
      console.warn(`model failed: ${work.file}`, err);
      return normalize(failedModel(), true);
    }
  }

  private fetch(url: string): Promise<THREE.Object3D> {
    let p = this.cache.get(url);
    if (!p) {
      // 各向异性要在第一次上传贴图之前设好（WebGL2 在上传时设采样参数，WebGPU 按它建采样器）
      p = (this.oneAtATime ? this.loadOneAtATime(url) : this.loader.loadAsync(url)).then((gltf) => {
        applyAnisotropy(gltf.scene, anisotropy);
        applyDoubleSided(gltf.scene);
        return gltf.scene;
      });
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return p;
  }

  // 下载照常（几件同时下载），解析排队：前一件解析完才开始下一件
  private async loadOneAtATime(url: string): Promise<{ scene: THREE.Group }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    const data = await res.arrayBuffer();
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

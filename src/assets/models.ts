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

export function thumbUrl(file: string): string {
  return `${import.meta.env.BASE_URL}thumbs/${file}`;
}

// 每个渲染器用自己的实例：GPU 资源不跨渲染器共享
export class ModelLibrary {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly cache = new Map<string, Promise<THREE.Object3D>>();

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
      p = this.loader.loadAsync(url).then((gltf) => gltf.scene);
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return p;
  }
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

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { Placement, PlanetRecipe, PresetId } from '../data/types';
import { buildTerrainGeometry, LOD_LOW } from './generate';
import { groundMaterial } from './ground';
import { maskWorks, PlanetMask } from './mask';
import { ringMaterial, waterMaterial } from './materials';
import { makeHeightFn, seaRadius, type HeightFn } from './noise';
import { MAX_PLINTH_RADIUS } from './placement';
import { PLANET_RADIUS, PRESETS } from './presets';
import { PlanetLookParts } from '../nature/planetLook';

// 一颗星球的 3D 对象：地表（两档细分）、小水塘、大气、光环；works 组挂作品，decor 组挂石头等点缀（聚焦时才有），重建时都保留。
// mask 是星球遮罩（土路、作品空地）：地表着色器画路，草和石头按它避开
export class PlanetObject {
  readonly group = new THREE.Group();
  readonly works = new THREE.Group();
  readonly decor = new THREE.Group();
  readonly mask = new PlanetMask();
  readonly look = new PlanetLookParts(); // 远看的样子：大气光晕、云层（nature/planetLook.ts；镜头近了自己藏起来）
  terrain!: THREE.Mesh;
  height!: HeightFn;
  sea = 0;
  radius = PLANET_RADIUS; // 这颗星球按哪个半径建的（滑块拖动后 rebuildForRadius 更新）
  private recipe!: PlanetRecipe;
  private detail = LOD_LOW;
  private terrainPreset: PresetId | null = null; // 地表材质按哪个预设建的
  private parts: THREE.Object3D[] = [];
  private ring: THREE.Mesh | null = null;
  private readonly ringStrengthNode = uniform(1); // 每次重建光环都用同一个 uniform，强度跨重建保留
  private readonly haloStrengthNode = uniform(1); // 大气光晕的浓淡：同上（星球视图里聚焦的那颗压淡）
  private readonly maskListeners = new Set<() => void>();

  constructor(recipe: PlanetRecipe) {
    this.decor.name = 'decor';
    this.group.add(this.works, this.decor, this.look.group);
    this.setRecipe(recipe);
  }

  get currentRecipe(): PlanetRecipe {
    return this.recipe;
  }

  get ringStrength(): number {
    return this.ringStrengthNode.value;
  }

  get haloStrength(): number {
    return this.haloStrengthNode.value;
  }

  // 大气光晕浓淡（0..1，1 是原样）：星球视图里聚焦的那颗压淡（和云海、高度雾叠在一起会多出一圈白光），回星系恢复
  setHaloStrength(k: number): void {
    this.haloStrengthNode.value = THREE.MathUtils.clamp(k, 0, 1);
  }

  // 遮罩重画了（摆放变了、半径变了）：草、石头跟着重新摆
  onMaskChange(fn: () => void): () => void {
    this.maskListeners.add(fn);
    return () => this.maskListeners.delete(fn);
  }

  // 光环浓淡（0..1，1 是原样）：星球视图里把聚焦星球的光环压淡，回星系再恢复。强度为 0 时干脆不画
  setRingStrength(k: number): void {
    this.ringStrengthNode.value = THREE.MathUtils.clamp(k, 0, 1);
    if (this.ring) this.ring.visible = this.ringStrengthNode.value > 0;
  }

  // 外观字段（种子、预设、光环、大气）变化才重建地形；摆放变了只重画遮罩（土路跟着作品走），作品本身由 PlanetView 处理
  setRecipe(recipe: PlanetRecipe): void {
    const prev = this.recipe;
    this.recipe = recipe;
    if (prev && prev.seed === recipe.seed && prev.preset === recipe.preset && prev.ring === recipe.ring && prev.atmosphere === recipe.atmosphere) {
      if (!samePlacements(prev.placements, recipe.placements)) this.rebuildMask();
      return;
    }
    this.rebuild();
  }

  setDetail(detail: number): void {
    if (detail === this.detail) return;
    this.detail = detail;
    this.rebuildTerrain();
  }

  // 星球半径变了（?tune 滑块）：地形、水面、大气、光环、遮罩全部按新半径重建
  rebuildForRadius(): void {
    this.rebuild();
  }

  private rebuild(): void {
    for (const p of this.parts) {
      this.group.remove(p);
      disposeTree(p);
    }
    this.parts = [];
    this.ring = null;
    this.radius = PLANET_RADIUS;
    const { preset } = this.recipe;
    const R = this.radius;
    this.height = makeHeightFn(this.recipe.seed, preset);
    this.sea = seaRadius(preset);
    this.rebuildMask(false);
    this.rebuildTerrain();
    if (this.sea > 0) this.addPart(new THREE.Mesh(new THREE.IcosahedronGeometry(this.sea, 24), waterMaterial(preset)));
    // 大气光晕、云层：远看的部件（外壳贴着最高的地形外面一点）
    this.look.build({ radius: R, top: R * (1 + PRESETS[preset].amp * 0.75), seed: this.recipe.seed, tint: PRESETS[preset].atmosphere, atmosphere: this.recipe.atmosphere, haloStrength: this.haloStrengthNode });
    if (this.recipe.ring) {
      const inner = R * 1.45;
      const outer = R * 2.15;
      const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128, 1), ringMaterial(preset, inner, outer, this.ringStrengthNode));
      ring.name = 'ring';
      ring.rotation.set(-Math.PI / 2 + 0.38, 0, 0.22); // 放到赤道面再稍微倾斜
      ring.visible = this.ringStrengthNode.value > 0;
      this.ring = ring;
      this.addPart(ring);
    }
    this.notifyMask();
  }

  private rebuildMask(notify = true): void {
    this.mask.rebuild(maskWorks(this.recipe.placements, () => MAX_PLINTH_RADIUS), PLANET_RADIUS, this.recipe.seed);
    if (notify) this.notifyMask();
  }

  private notifyMask(): void {
    for (const fn of this.maskListeners) fn();
  }

  // 只换细分（聚焦、离开）时留着原来的网格和材质，只换几何：材质换新的话第一次画要重新生成整个地表着色器（实测 100–200 ms）。
  // 预设变了才换材质
  private rebuildTerrain(): void {
    const geometry = buildTerrainGeometry(this.recipe, this.detail);
    const preset = this.recipe.preset;
    if (this.terrain && this.terrainPreset === preset) {
      this.terrain.geometry.dispose();
      this.terrain.geometry = geometry;
      return;
    }
    if (this.terrain) {
      this.group.remove(this.terrain);
      disposeTree(this.terrain);
    }
    this.terrain = new THREE.Mesh(geometry, groundMaterial(preset, this.mask.node, this.look.cloudOffset));
    this.terrainPreset = preset;
    this.terrain.name = 'terrain';
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  private addPart(o: THREE.Object3D): void {
    this.parts.push(o);
    this.group.add(o);
  }
}

function samePlacements(a: Placement[], b: Placement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.workId === b[i].workId && p.yaw === b[i].yaw && p.scale === b[i].scale && p.dir.every((v, k) => v === b[i].dir[k]));
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

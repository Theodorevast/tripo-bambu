import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { PlanetRecipe } from '../data/types';
import { buildTerrainGeometry, LOD_LOW } from './generate';
import { atmosphereMaterial, ringMaterial, surfaceMaterial, waterMaterial } from './materials';
import { makeHeightFn, seaRadius, type HeightFn } from './noise';
import { BASE_RADIUS, PRESETS } from './presets';

// 一颗星球的 3D 对象：地表（两档细分）、海洋、大气、光环；works 组挂作品，重建时保留
export class PlanetObject {
  readonly group = new THREE.Group();
  readonly works = new THREE.Group();
  terrain!: THREE.Mesh;
  height!: HeightFn;
  sea = 0;
  private recipe!: PlanetRecipe;
  private detail = LOD_LOW;
  private parts: THREE.Object3D[] = [];
  private ring: THREE.Mesh | null = null;
  private readonly ringStrengthNode = uniform(1); // 每次重建光环都用同一个 uniform，强度跨重建保留

  constructor(recipe: PlanetRecipe) {
    this.group.add(this.works);
    this.setRecipe(recipe);
  }

  get currentRecipe(): PlanetRecipe {
    return this.recipe;
  }

  get ringStrength(): number {
    return this.ringStrengthNode.value;
  }

  // 光环浓淡（0..1，1 是原样）：星球视图里把聚焦星球的光环压淡，回星系再恢复。强度为 0 时干脆不画
  setRingStrength(k: number): void {
    this.ringStrengthNode.value = THREE.MathUtils.clamp(k, 0, 1);
    if (this.ring) this.ring.visible = this.ringStrengthNode.value > 0;
  }

  // 只有外观字段（种子、预设、光环、大气）变化才重建；摆放变化由 PlanetView 处理
  setRecipe(recipe: PlanetRecipe): void {
    const prev = this.recipe;
    this.recipe = recipe;
    if (prev && prev.seed === recipe.seed && prev.preset === recipe.preset && prev.ring === recipe.ring && prev.atmosphere === recipe.atmosphere) return;
    this.rebuild();
  }

  setDetail(detail: number): void {
    if (detail === this.detail) return;
    this.detail = detail;
    this.rebuildTerrain();
  }

  private rebuild(): void {
    for (const p of this.parts) {
      this.group.remove(p);
      disposeTree(p);
    }
    this.parts = [];
    this.ring = null;
    const { preset } = this.recipe;
    this.height = makeHeightFn(this.recipe.seed, preset);
    this.sea = seaRadius(preset);
    this.rebuildTerrain();
    if (this.sea > 0) this.addPart(new THREE.Mesh(new THREE.IcosahedronGeometry(this.sea, 12), waterMaterial(preset)));
    if (this.recipe.atmosphere) {
      const r = BASE_RADIUS * (1 + PRESETS[preset].amp) * 1.05; // 薄外壳：比最高的地形再高 5%，光晕只占轮廓外窄窄一圈
      this.addPart(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 8), atmosphereMaterial(preset)));
    }
    if (this.recipe.ring) {
      const inner = BASE_RADIUS * 1.45;
      const outer = BASE_RADIUS * 2.15;
      const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128, 1), ringMaterial(preset, inner, outer, this.ringStrengthNode));
      ring.name = 'ring';
      ring.rotation.set(-Math.PI / 2 + 0.38, 0, 0.22); // 放到赤道面再稍微倾斜
      ring.visible = this.ringStrengthNode.value > 0;
      this.ring = ring;
      this.addPart(ring);
    }
  }

  private rebuildTerrain(): void {
    if (this.terrain) {
      this.group.remove(this.terrain);
      disposeTree(this.terrain);
    }
    this.terrain = new THREE.Mesh(buildTerrainGeometry(this.recipe, this.detail), surfaceMaterial(this.recipe.preset, this.recipe.atmosphere));
    this.terrain.name = 'terrain';
    this.group.add(this.terrain);
  }

  private addPart(o: THREE.Object3D): void {
    this.parts.push(o);
    this.group.add(o);
  }
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

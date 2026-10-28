import * as THREE from 'three/webgpu';
import { createGrassField, type GrassField } from '../nature/grass';
import { DECOR_CENTER, proceduralDecorKit, scatterDecor, type DecorKit, type DecorStats } from '../planet/decor';
import { CLEARING, PATH } from '../planet/mask';
import { MAX_PLINTH_RADIUS } from '../planet/placement';
import { PRESETS } from '../planet/presets';
import type { PlanetEntry } from './world';

// 聚焦星球的「地表点缀」：草和花（nature/grass.ts）、石头（planet/decor.ts）。只给聚焦的那一颗星球做：
// 星系里十几颗星球都铺草的话，看不见也要占显存和绘制调用。
// 星球遮罩（土路、作品空地）变了、半径变了就重新摆；草量可调（?tune）

export const DRESSING = {
  grass: 1, // 草量倍数，传给 createGrassField 的 density
};

export interface DressingHost {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  precompile(object: THREE.Object3D): Promise<void>; // 后台编译好再挂上，不在那一帧卡住
}

export class Dressing {
  kit: DecorKit = proceduralDecorKit();
  grass: GrassField | null = null;
  rocks: DecorStats = { instances: 0, drawCalls: 0, triangles: 0 };
  private entry: PlanetEntry | null = null;
  private rockGroup: THREE.Group | null = null;
  private unlisten: (() => void) | null = null;
  private token = 0;
  private readonly host: DressingHost;
  private readonly start = performance.now();

  constructor(host: DressingHost) {
    this.host = host;
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  // 换素材（以后换成 Tripo 生成的 GLB：decorKitFromGlb）
  setKit(kit: DecorKit): void {
    this.kit = kit;
    this.rebuildRocks();
  }

  enter(entry: PlanetEntry): void {
    if (this.entry === entry) return;
    this.leave();
    this.entry = entry;
    this.unlisten = entry.planet.onMaskChange(() => this.rebuild());
    this.rebuild();
  }

  leave(): void {
    this.token++;
    this.unlisten?.();
    this.unlisten = null;
    this.disposeGrass();
    this.rockGroup?.removeFromParent();
    this.rockGroup = null;
    this.entry = null;
  }

  // 遮罩、半径变了：石头和草都重新摆
  rebuild(): void {
    this.rebuildRocks();
    this.rebuildGrass();
  }

  setGrassDensity(n: number): void {
    DRESSING.grass = n;
    this.grass?.setDensity(n);
  }

  update(camera: THREE.Camera): void {
    this.grass?.update(camera, (performance.now() - this.start) / 1000);
  }

  private rebuildRocks(): void {
    const entry = this.entry;
    this.rockGroup?.removeFromParent();
    this.rockGroup = null;
    if (!entry) return;
    const planet = entry.planet;
    const recipe = planet.currentRecipe;
    DECOR_CENTER.value.copy(entry.home);
    const { group, stats } = scatterDecor(this.kit, {
      radius: planet.radius,
      height: (d) => planet.height(d.x, d.y, d.z),
      sea: planet.sea,
      exclude: (d) => planet.mask.exclude(d),
      rockColor: new THREE.Color(PRESETS[recipe.preset].ground.rock),
      seed: recipe.seed,
      path: planet.mask.path,
      pathWidth: PATH.width,
      clearings: recipe.placements.map((p) => ({ dir: new THREE.Vector3(...p.dir).normalize(), radius: (MAX_PLINTH_RADIUS + CLEARING.margin) * p.scale })),
    });
    this.rocks = stats;
    this.rockGroup = group;
    planet.decor.add(group);
  }

  private rebuildGrass(): void {
    const entry = this.entry;
    this.disposeGrass();
    if (!entry) return;
    const token = ++this.token;
    const planet = entry.planet;
    const grass = createGrassField({
      renderer: this.host.renderer,
      planet: { radius: planet.radius, center: entry.home.clone(), height: (d) => planet.height(d.x, d.y, d.z), sea: planet.sea },
      exclude: (d) => planet.mask.exclude(d),
      density: DRESSING.grass,
    });
    this.grass = grass;
    // 草的着色器在后台编译好再挂上：进星球时不在某一帧同步编译
    this.host.precompile(grass.object).then(
      () => { if (token === this.token && this.grass === grass) this.host.scene.add(grass.object); },
      (err: unknown) => console.error(err),
    );
  }

  private disposeGrass(): void {
    if (!this.grass) return;
    this.grass.object.removeFromParent();
    this.grass.dispose();
    this.grass = null;
  }
}

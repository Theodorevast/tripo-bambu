import * as THREE from 'three/webgpu';
import { renderGroup, uniform } from 'three/tsl';
import { createGrassField, type GrassField, type GrassPlanet } from '../nature/grass';
import { trampleUV, type Life } from '../nature/life';
import { windNode } from '../nature/wind';
import { DECOR_CENTER, DecorField, type DecorKit, type DecorStats } from '../planet/decor';
import { painterlyRockKit } from '../nature/decorRocks';
import { GRASS_GROUND, setGroundGrass } from '../planet/ground';
import { PATH } from '../planet/mask';
import { PLANET_RADIUS, PRESETS } from '../planet/presets';
import { gardenRockClearance } from './planetView';
import type { PlanetEntry } from './world';

// 聚焦星球的「地表点缀」：草和花（nature/grass.ts）、石头（planet/decor.ts）。只给聚焦的那一颗星球做：
// 星系里十几颗星球都铺草的话，看不见也要占显存和绘制调用。
// 网格都常驻、换星球只换数据：石头（DecorField）换星球只重写实例数据；草只有一片（GrassField），换星球时 setPlanet，
// 不重新生成着色器（每次新建网格和材质，第一帧都要重新生成着色器节点，进星球时会卡）。星球半径变了（?tune）草才重建。
// 星球遮罩（土路、作品空地）变了：石头重摆，草的地面网格原地重算（refresh）。
// 草的风和踩踏来自生机层（nature/life.ts、wind.ts）：风是全局风场 windNode，踩踏是 life 的踩踏图 + 角色的影响球

export const DRESSING = {
  grass: 1, // 草量倍数，传给 createGrassField 的 density
};

// 草的外观（?tune → Grass）。颜色不在这里：按星球预设取（presets.ts 的 ground，地表和草叶共用一组），这里是形状、风、光
export const GRASS = {
  height: 1, // 草高倍数
  width: 1, // 叶宽倍数
  flowers: 0.6, // 野花密度
  translucency: 1, // 逆光透光
  radius: 32, // 草画到多远（米）
  fullRadius: 6, // 满密度半径（米）
  flowerRadius: 26,
  wind: 0.2, // 风场（wind.ts 的风速，米/秒）→ 草的弯曲（弧度）的倍数
  sun: 0.35, // 太阳（atmosphere 的光颜色 × 强度）→ 草叶受光的倍数：草叶是风格化受光，和 PBR 的地面亮度对齐用
  sunDusk: 0.65, // 日落时受光再乘这个（按 evening 插值）：日落的橙色太阳光把草照成一片橙黄，参考图 F9 的草是暗的橄榄绿
  shadowDay: '#6e7896', // 背光、草丛深处的颜色（天光）：白天偏蓝灰
  shadowDusk: '#8a8aac', // 日落：偏冷的蓝紫天光（暖色太阳 + 冷色天光，草保持橄榄绿，不被照成一片橙黄）
};

// 风场 → 草的弯曲：一个 uniform，?tune 拖动时不用重建草
const windGain = uniform(GRASS.wind).setGroup(renderGroup);

export interface DressingHost {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  life: Life; // 风、踩踏图、影响球
  precompile(object: THREE.Object3D): Promise<void>; // 后台编译好再挂上，不在那一帧卡住
}

// 太阳和天色（World 每帧从 atmosphere 取来传进 update）
export interface DressingLight {
  sunDir: THREE.Vector3; // 指向太阳（世界坐标）
  sunColor: THREE.Color;
  sunIntensity: number;
  evening: number; // 0 白天 … 0.6 日落（草的背光色往紫里偏）
}

const _shadow = new THREE.Color();
const _dusk = new THREE.Color();

export class Dressing {
  kit: DecorKit = painterlyRockKit(); // stage 角色：圆润、手绘上色的石头（nature/decorRocks.ts）
  field: DecorField = new DecorField(this.kit);
  grass: GrassField | null = null;
  rocks: DecorStats = { instances: 0, drawCalls: 0, triangles: 0 };
  private entry: PlanetEntry | null = null;
  private unlisten: (() => void) | null = null;
  private grassReady = false; // 草的着色器编译好了（编好之前不挂上场景）
  private readonly host: DressingHost;
  private readonly start = performance.now();
  private shadowEvening = -1; // 上次算背光色时的 evening（× 1000 取整）和两头的颜色：变了才重算
  private shadowDay = '';
  private shadowDusk = '';

  constructor(host: DressingHost) {
    this.host = host;
  }

  get planet(): PlanetEntry | null {
    return this.entry;
  }

  // 换素材（以后换成 assets 生成的 GLB：decorKitFromGlb）。新网格在后台编译好再摆
  setKit(kit: DecorKit): void {
    this.kit = kit;
    this.field.dispose();
    this.field = new DecorField(kit);
    this.field.showOneEach(true);
    this.host.precompile(this.field.group).then(() => {
      this.field.showOneEach(false);
      this.rebuildRocks();
    }, (err: unknown) => console.error(err));
  }

  // 开场（World.warmUp）调：草场按当前半径先建好，挂进场景和别的东西一起预编译；编完摘下来，进星球时只换星球
  prepareGrass(): THREE.Object3D {
    this.ensureGrass(null);
    return this.grass!.object;
  }

  enter(entry: PlanetEntry): void {
    if (this.entry === entry) return;
    this.leave();
    this.entry = entry;
    this.unlisten = entry.planet.onMaskChange(() => this.maskChanged());
    this.rebuildRocks();
    this.bindGrass();
  }

  leave(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.grass?.object.removeFromParent();
    this.field.group.removeFromParent();
    this.entry = null;
    setGroundGrass(0, GRASS.fullRadius, GRASS.radius);
  }

  // 半径变了（?tune）、石头参数变了：石头重摆；草按新半径重建（半径没变就只是换一次星球数据）
  rebuild(): void {
    this.rebuildRocks();
    this.bindGrass();
  }

  setGrassDensity(n: number): void {
    DRESSING.grass = n;
    this.grass?.setDensity(n);
  }

  // ?tune 改了 GRASS：形状、颜色下一帧 update 照表同步；风的倍数是 uniform，这里写进去
  applyGrass(): void {
    windGain.value = GRASS.wind;
  }

  update(camera: THREE.Camera, light: DressingLight): void {
    const grass = this.grass;
    const entry = this.entry;
    if (!grass) return;
    const shown = entry !== null && this.grassReady && DRESSING.grass > 0.001;
    if (entry && this.grassReady && grass.object.parent !== this.host.scene) this.host.scene.add(grass.object);
    // 草的形状、颜色：每帧照表和星球预设同步（颜色字符串没变时草模块不重新解析）
    const s = grass.settings;
    s.height = GRASS.height;
    s.width = GRASS.width;
    s.flowers = GRASS.flowers;
    s.translucency = GRASS.translucency;
    s.radius = GRASS.radius;
    s.fullRadius = GRASS.fullRadius;
    s.flowerRadius = GRASS.flowerRadius;
    s.dryness = GRASS_GROUND.dryness;
    if (entry) {
      const pal = PRESETS[entry.planet.currentRecipe.preset].ground;
      const c = s.colors;
      c.root = pal.root;
      c.lush = pal.grass;
      c.fresh = pal.fresh;
      c.dry = pal.dry;
      c.tip = pal.tip;
    }
    // 背光色：白天偏蓝灰，日落往紫里偏（按 evening 插值；只在变了时才拼颜色字符串，平时不分配）
    const ev = Math.round(light.evening * 1000);
    if (ev !== this.shadowEvening || GRASS.shadowDay !== this.shadowDay || GRASS.shadowDusk !== this.shadowDusk) {
      this.shadowEvening = ev;
      this.shadowDay = GRASS.shadowDay;
      this.shadowDusk = GRASS.shadowDusk;
      _shadow.set(GRASS.shadowDay).lerp(_dusk.set(GRASS.shadowDusk), THREE.MathUtils.clamp(light.evening / 0.6, 0, 1));
      s.colors.shadow = `#${_shadow.getHexString()}`;
    }
    const dusk = THREE.MathUtils.clamp(light.evening / 0.6, 0, 1);
    grass.setSun(light.sunDir, light.sunColor, light.sunIntensity * GRASS.sun * (1 + (GRASS.sunDusk - 1) * dusk));
    grass.update(camera, (performance.now() - this.start) / 1000);
    setGroundGrass(shown ? 1 : 0, GRASS.fullRadius, GRASS.radius);
  }

  private maskChanged(): void {
    this.rebuildRocks();
    // 土路按所有作品的位置重新连（摆放、删除一件作品，路可能在别处也挪了）：整片草的地面网格都标记过期，
    // 由近到远在每帧的预算里原地重算，重算前照旧画（不会整片消失）
    this.grass?.refresh();
  }

  private rebuildRocks(): void {
    const entry = this.entry;
    if (!entry) return;
    const planet = entry.planet;
    const recipe = planet.currentRecipe;
    DECOR_CENTER.value.copy(entry.home);
    const gardens = recipe.placements.map((p) => ({ dir: new THREE.Vector3(...p.dir).normalize(), cos: Math.cos(gardenRockClearance(p.scale) / planet.radius) }));
    this.rocks = this.field.fill(this.kit, {
      radius: planet.radius,
      height: (d) => planet.height(d.x, d.y, d.z),
      sea: planet.sea,
      // stage：作品四周的花园（星球视图里会放大）范围里不放石头
      exclude: (d) => (gardens.some((g) => d.dot(g.dir) > g.cos) ? 1 : planet.mask.exclude(d)),
      rockColor: new THREE.Color(PRESETS[recipe.preset].ground.rock),
      seed: recipe.seed,
      path: planet.mask.path,
      pathWidth: PATH.width,
      clearings: [], // stage：作品空地四周的小石子换成花园自己的石头
    });
    if (this.field.group.parent !== planet.decor) planet.decor.add(this.field.group);
  }

  // 草的星球数据：高度、海面每次现取（编辑器改了外观、重建地形也跟着变）；中心引用 entry.home（半径滑块拖动时原地改它）
  private grassPlanet(entry: PlanetEntry): GrassPlanet {
    const planet = entry.planet;
    return {
      radius: planet.radius,
      center: entry.home,
      height: (d) => planet.height(d.x, d.y, d.z),
      get sea() {
        return planet.sea;
      },
    };
  }

  // 草场：没有、或者半径变了才新建（新建要重新编译着色器，后台编译好才挂上）；否则只换星球
  private ensureGrass(entry: PlanetEntry | null): void {
    if (this.grass && Math.abs(this.grass.radius - PLANET_RADIUS) > 1e-6) {
      this.grass.object.removeFromParent();
      this.grass.dispose();
      this.grass = null;
      this.grassReady = false;
    }
    if (this.grass) return;
    const life = this.host.life;
    // 还没有星球（开场预编译）：放一颗不存在的星球占位，进星球时 setPlanet 换掉
    const planet: GrassPlanet = entry
      ? this.grassPlanet(entry)
      : { radius: PLANET_RADIUS, center: new THREE.Vector3(0, -1e5, 0), height: () => PLANET_RADIUS, sea: null };
    const grass = createGrassField({
      renderer: this.host.renderer,
      planet,
      exclude: entry ? (d) => entry.planet.mask.exclude(d) : undefined,
      density: DRESSING.grass,
      // 生机层的全局风场（米/秒，和地面相切）→ 草的弯曲（弧度）
      wind: (pos) => windNode(pos).mul(windGain),
      // 踩踏图：星球本地方向 → 八面体贴图坐标（和 life.trample.uvOf 一致）
      trample: life.trample ? { texture: life.trample.texture, uvOf: (dir) => trampleUV(dir) } : undefined,
      influence: life.influence,
    });
    this.grass = grass;
    this.grassReady = false;
    this.host.precompile(grass.object).then(
      () => { if (this.grass === grass) this.grassReady = true; },
      (err: unknown) => console.error(err),
    );
  }

  private bindGrass(): void {
    const entry = this.entry;
    if (!entry) return;
    const fresh = this.grass === null || Math.abs(this.grass.radius - PLANET_RADIUS) > 1e-6;
    this.ensureGrass(entry);
    if (!fresh) this.grass!.setPlanet(this.grassPlanet(entry), (d) => entry.planet.mask.exclude(d));
  }
}

import * as THREE from 'three/webgpu';
import { setLampPools, STAGE_VIEW_DIR } from '../planet/ground';
import { PATH } from '../planet/mask';
import { PRESETS } from '../planet/presets';
import { PropsField, type PropsPlanet } from '../planet/props-v2';
import { gardenRockClearance } from './planetView';
import { compileShadowExact } from './shadowWarm';
import type { PlanetEntry, World } from './world';

// 第二版 [v2-world]：把中古点缀（planet/props-v2.ts）接到聚焦的星球上，不改 Dressing、World：
// - 开场：网格先挂在场景里（先画 1 个、放在很远的地方），World.warmUp 一起编主画面那一遍；预热完再按真正画阴影时的状态编投影那一遍（shadowWarm.ts），
//   然后摘下来。进星球时不再生成着色器
// - 每帧看 Dressing 现在铺的是哪颗星球（转场的云层全遮住时它才换）：换了就按那颗星球重摆，挂到它的 decor 组下；
//   那颗星球的遮罩变了（作品挪了、土路改道）也重摆
// - 和石头一样避开作品四周的花园（星球视图里花园会放大）
// - 漫游时挡路：每次重摆一起算好挡路的圆柱（PropsField.blockers），main.ts 把 PropsField 交给 WalkMode.blockers

export function installPropsV2(world: World): PropsField {
  const field = new PropsField();
  // 预热：放在很远的地方先画 1 个
  field.showOneEach(true);
  field.group.position.set(0, -1e5, 0);
  world.scene.add(field.group);
  let ready = false;
  void world.warm
    .then(async () => {
      await compileShadowExact(world.renderer, field.group, world.stage.shadowLight?.() ?? null, world.scene);
    })
    .catch((err: unknown) => console.error(err))
    .finally(() => {
      field.group.removeFromParent();
      field.group.position.set(0, 0, 0);
      field.showOneEach(false);
      ready = true;
      bound = null; // 预热期间已经进了星球的话，下一帧照常摆上
    });
  let bound: PlanetEntry | null = null;
  let unlisten: (() => void) | null = null;
  const fill = (e: PlanetEntry) => {
    const planet = e.planet;
    const recipe = planet.currentRecipe;
    const gardens = recipe.placements.map((p) => ({ dir: new THREE.Vector3(...p.dir).normalize(), cos: Math.cos(gardenRockClearance(p.scale) / planet.radius) }));
    const info: PropsPlanet = {
      radius: planet.radius,
      seed: recipe.seed,
      height: (d) => planet.height(d.x, d.y, d.z),
      sea: planet.sea,
      exclude: (d) => (gardens.some((g) => d.dot(g.dir) > g.cos) ? 1 : planet.mask.exclude(d)),
      path: planet.mask.path,
      pathWidth: PATH.width,
      stage: new THREE.Vector3(...STAGE_VIEW_DIR),
      rockColor: new THREE.Color(PRESETS[recipe.preset].ground.rock),
    };
    const items = field.fill(info, planet); // 挡路的圆柱一起算好（漫游时 walkMode 按 owner 认星球）
    if (field.group.parent !== planet.decor) planet.decor.add(field.group);
    // 灯柱脚下的暖光（ground.ts 的 LAMP_POOLS）：灯柱底座的位置（星球本地坐标）
    setLampPools(items.filter((it) => it.kind === 'lamp').map((it) => ({ pos: it.dir.clone().multiplyScalar(planet.height(it.dir.x, it.dir.y, it.dir.z)), k: 1 })));
  };
  world.frameHooks.add(() => {
    if (!ready) return;
    const e = world.dressing.planet;
    if (e === bound) return;
    unlisten?.();
    unlisten = null;
    bound = e;
    if (!e) {
      field.group.removeFromParent();
      field.release();
      setLampPools([]);
      return;
    }
    fill(e);
    unlisten = e.planet.onMaskChange(() => fill(e));
  });
  refill = () => { if (bound) fill(bound); };
  installed = field;
  return field;
}

let installed: PropsField | null = null;
let refill: () => void = () => {};

// ?tune 改了数量、开关：当前星球重摆
export function refillPropsV2(): void {
  refill();
}

export function propsV2(): PropsField | null {
  return installed;
}

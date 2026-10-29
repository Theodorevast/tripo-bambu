import type * as THREE from 'three/webgpu';
import { GARDEN_V2 } from '../nature/decorGarden';
import { applyLampPools, LAMP_POOL } from '../planet/ground';
import { applyProps, PROPS, type PropsField } from '../planet/props-v2';
import type { TuneFolder } from '../ui/tuneShell';
import { installPropsV2, refillPropsV2 } from './propsV2Install';
import { PlanetView } from './planetView';
import { ARMILLARY, Armillary } from './homeArmillary';
import { cloudTriboo } from './homeCloudTriboo';
import { CONSTELLATION, HomeConstellation } from './homeConstellation';
import { updateFineLines } from './fineLines';
import { reducedMotion } from './transition';
import type { PlanetEntry, World } from './world';

// 第二版 [v2-world] 的首页 3D 点缀，装在一起（main.ts 在开场预热之前调一次 installWorldV2，跟场景里别的东西一起编译）：
// - 天体仪环：你的星球周围两三圈细金环（homeArmillary.ts）
// - 星座线：同一条旋臂上相邻的星球之间一条淡淡的细金线，两头各一颗小星；指着星球时它的线亮一点（homeConstellation.ts）
// - 中古点缀：聚焦的星球上零星的灯柱、立石、石拱门、小石塔（planet/props-v2.ts，接在 propsV2Install.ts）
// - 细线的像素宽度：每帧按主镜头换算一次（fineLines.ts）
// 「?tune → World v2」一组调这些参数（addWorldV2Tune，tune.ts 调）

export interface WorldV2 {
  armillary: Armillary;
  constellation: HomeConstellation;
  props: PropsField;
}

let installed: WorldV2 | null = null;

export function worldV2(): WorldV2 | null {
  return installed;
}

// 首页上「你的星球」（槽位是 you 的那颗）
function youEntry(world: World): PlanetEntry | null {
  for (const e of world.planets.values()) if (world.slotOf(e)?.tier === 'you') return e;
  return null;
}

type DebugBag = Record<string, unknown>;
const debugBag = (): DebugBag => {
  const w = window as unknown as { __v2world?: DebugBag };
  w.__v2world ??= {};
  return w.__v2world;
};

export function installWorldV2(world: World): WorldV2 {
  const armillary = new Armillary();
  const constellation = new HomeConstellation();
  const props = installPropsV2(world);
  world.scene.add(armillary.group, constellation.lines.mesh);
  armillary.showForCompile(); // 预热时显示着（compileAsync 跳过不显示的），透明度是 0
  let warmed = false;
  void world.warm.then(() => { warmed = true; });
  const you = { pos: null as unknown as THREE.Vector3, size: 1 };
  world.frameHooks.add((dt) => {
    updateFineLines(world.rig.camera, innerHeight);
    if (!warmed) return;
    const home = !world.focused;
    const e = youEntry(world);
    if (e) {
      you.pos = e.home;
      you.size = e.planet.radius * e.planet.group.scale.x;
    }
    armillary.update(dt, home, e ? you : null, reducedMotion());
    constellation.update(dt, world, home);
  });
  installed = { armillary, constellation, props };
  // 自查、截图脚本用：星座翠宝马上出现（不等周期）、天体仪环和星座线的状态
  Object.assign(debugBag(), {
    armillary,
    constellation,
    props: () => props.items.map((it) => ({ kind: it.kind, dir: it.dir.toArray(), size: it.size })),
    propsStats: () => props.stats(),
    showConstellation: () => cloudTriboo()?.replay(),
    constellationState: () => cloudTriboo()?.state ?? null,
  });
  return installed;
}

// ?tune → World v2（tune.ts 调一次）
export function addWorldV2Tune(pane: TuneFolder): void {
  const root = pane.addFolder({ title: 'World v2' });
  const ring = root.addFolder({ title: 'Armillary rings (home)', expanded: true });
  ring.addBinding(ARMILLARY, 'on', { label: 'show', min: 0, max: 1, step: 1 });
  ring.addBinding(ARMILLARY, 'rings', { label: 'rings', min: 1, max: 3, step: 1 });
  ring.addBinding(ARMILLARY, 'radius', { label: 'inner radius ×R', min: 1.05, max: 2.4, step: 0.01 });
  ring.addBinding(ARMILLARY, 'spacing', { label: 'ring spacing ×R', min: 0, max: 0.5, step: 0.01 });
  ring.addBinding(ARMILLARY, 'tilt', { label: 'tilt ×', min: 0, max: 2, step: 0.01 });
  ring.addBinding(ARMILLARY, 'speed', { label: 'spin speed ×', min: 0, max: 5, step: 0.05 });
  ring.addBinding(ARMILLARY, 'ticks', { label: 'tick marks', min: 0, max: 1, step: 0.05 });
  ring.addBinding(ARMILLARY, 'width', { label: 'line width (px)', min: 0.5, max: 3, step: 0.05 });
  ring.addBinding(ARMILLARY, 'brightness', { min: 0.1, max: 3, step: 0.01 });
  ring.on('change', () => installed?.armillary.build());
  const lines = root.addFolder({ title: 'Constellation lines (home)', expanded: true });
  lines.addBinding(CONSTELLATION, 'on', { label: 'show', min: 0, max: 1, step: 1 });
  lines.addBinding(CONSTELLATION, 'alpha', { label: 'line opacity', min: 0, max: 1, step: 0.01 });
  lines.addBinding(CONSTELLATION, 'hover', { label: 'hovered opacity', min: 0, max: 1, step: 0.01 });
  lines.addBinding(CONSTELLATION, 'building', { label: 'to building ×', min: 0, max: 1, step: 0.01 });
  lines.addBinding(CONSTELLATION, 'width', { label: 'line width (px)', min: 0.5, max: 3, step: 0.05 });
  lines.addBinding(CONSTELLATION, 'margin', { label: 'gap from planet ×R', min: 1, max: 2, step: 0.01 });
  lines.addBinding(CONSTELLATION, 'stars', { label: 'end stars ×', min: 0, max: 3, step: 0.05 });
  lines.addBinding(CONSTELLATION, 'fromYou', { label: 'link from your planet', min: 0, max: 1, step: 1 });
  lines.on('change', () => installed?.constellation.refresh());
  const props = root.addFolder({ title: 'Medieval accents (planet)', expanded: true });
  props.addBinding(PROPS, 'on', { label: 'show', min: 0, max: 1, step: 1 });
  props.addBinding(PROPS, 'density', { label: 'density ×', min: 0, max: 2, step: 0.05 });
  props.addBinding(PROPS, 'lamps', { label: 'lamp posts ×', min: 0, max: 2, step: 0.05 });
  props.addBinding(PROPS, 'scale', { label: 'size ×', min: 0.6, max: 2, step: 0.01 });
  props.addBinding(PROPS, 'arch', { label: 'stone arch', min: 0, max: 1, step: 1 });
  props.addBinding(PROPS, 'tower', { label: 'domed tower', min: 0, max: 1, step: 1 });
  props.addBinding(PROPS, 'stones', { label: 'standing stones', min: 0, max: 1, step: 1 });
  props.addBinding(PROPS, 'glow', { label: 'lamp glow', min: 0, max: 8, step: 0.05 }).on('change', () => applyProps());
  props.addBinding(LAMP_POOL, 'radius', { label: 'lamp light pool (m)', min: 0.5, max: 6, step: 0.1 }).on('change', () => applyLampPools());
  props.addBinding(LAMP_POOL, 'strength', { label: 'lamp light pool', min: 0, max: 2, step: 0.01 }).on('change', () => applyLampPools());
  props.addBinding(LAMP_POOL, 'color', { label: 'lamp light colour' }).on('change', () => applyLampPools());
  props.on('change', () => refillPropsV2());
  const garden = root.addFolder({ title: 'Gardens', expanded: false });
  garden.addBinding(GARDEN_V2, 'flags', { label: 'team pennants' });
  garden.addBinding(GARDEN_V2, 'muted', { label: 'muted team colours' });
  garden.on('change', () => PlanetView.active?.applyStage());
}

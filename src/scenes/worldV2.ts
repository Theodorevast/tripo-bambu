import type * as THREE from 'three/webgpu';
import type { TuneFolder } from '../ui/tuneShell';
import { ARMILLARY, Armillary } from './homeArmillary';
import { updateFineLines } from './fineLines';
import { reducedMotion } from './transition';
import type { PlanetEntry, World } from './world';

// 第二版 [v2-world] 的首页 3D 点缀，装在一起（main.ts 在开场预热之前调一次 installWorldV2，跟场景里别的东西一起编译）：
// - 天体仪环：你的星球周围两三圈细金环（homeArmillary.ts）
// - 细线的像素宽度：每帧按主镜头换算一次（fineLines.ts）
// 「?tune → World v2」一组调这些参数（addWorldV2Tune，tune.ts 调）

export interface WorldV2 {
  armillary: Armillary;
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

export function installWorldV2(world: World): WorldV2 {
  const armillary = new Armillary();
  world.scene.add(armillary.group);
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
  });
  installed = { armillary };
  // 自查、截图脚本用
  (window as unknown as { __v2world?: Record<string, unknown> }).__v2world = { ...((window as unknown as { __v2world?: Record<string, unknown> }).__v2world ?? {}), armillary };
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
}

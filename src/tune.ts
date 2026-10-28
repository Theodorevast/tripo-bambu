import { Pane } from 'tweakpane';
import { FOLLOW, WALK } from './play/params';
import { applyDecor, DECOR } from './planet/decor';
import { applyGround, applyGroundPalette, GROUND } from './planet/ground';
import { PLANET_RADIUS, PLANET_RADIUS_MAX, PLANET_RADIUS_MIN, PRESETS, setPlanetRadius } from './planet/presets';
import { DRESSING } from './scenes/dressing';
import { applyLights, LIGHTS } from './scenes/lights';
import { applyLook, LOOK, TONE_MAPPINGS } from './scenes/look';
import { SHOTS } from './scenes/shots';
import type { World } from './scenes/world';
import { toast } from './ui/toast';

// 实时调参面板：地址带 ?tune 时由 main.ts 动态加载（Tweakpane 打成单独的包，平时不下载）。
// 改的是这些表：星球半径（planet/presets.ts）、天空预设、草量和石头（scenes/dressing.ts、planet/decor.ts）、
// 地表着色器（planet/ground.ts）、镜头表（scenes/shots.ts）、漫游镜头和走路（play/params.ts）、色调映射（scenes/look.ts）、
// Museum 和查看器的摄影棚灯（scenes/lights.ts）。改动立刻生效，不用刷新。
// 「Copy parameters」把这些表的 JSON 复制到剪贴板：用户调好发给我们，写回代码里的默认值

// 用到的那部分 Tweakpane 接口。Tweakpane 4 的类型声明引用 @tweakpane/core（没装），这里自己写，类型检查不依赖它
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
}

// 面板上直接拖的「星球」参数：半径滑块拖动时实时重建（拖动中每次变化都建一遍，松手不用再等）
const PLANET = { radius: PLANET_RADIUS, sky: 'day' as 'day' | 'sunset' };

// 复制出去的 JSON：数字保留 3 位小数，滑块拖出来的浮点尾巴不带上
export function tuneJson(): string {
  const ground = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, p.ground]));
  return JSON.stringify(
    { planetRadius: PLANET_RADIUS, sky: PLANET.sky, dressing: DRESSING, decor: DECOR, ground: GROUND, palette: ground, shots: SHOTS, follow: FOLLOW, walk: WALK, look: LOOK, lights: LIGHTS },
    (_key, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v),
    2,
  );
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Parameters copied');
  } catch {
    // 剪贴板不让写（不是安全上下文、页面没有焦点）：打印到控制台
    console.log(text);
    toast('Could not copy. The parameters are in the browser console.');
  }
}

export function installTune(world: World): void {
  const container = document.createElement('div');
  container.className = 'tune-pane';
  // 压在顶栏、Members / Museum、查看器上面（它们的 z-index 最高 20），顶栏下面靠右
  Object.assign(container.style, { position: 'fixed', top: '76px', right: '12px', width: '300px', maxHeight: 'calc(100vh - 88px)', overflowY: 'auto', zIndex: '30' });
  document.body.append(container);
  const pane = new Pane({ title: 'Tune', container }) as unknown as Folder;

  const planet = pane.addFolder({ title: 'Planet' });
  PLANET.radius = PLANET_RADIUS;
  PLANET.sky = world.skyPreset;
  planet.addBinding(PLANET, 'radius', { label: 'PLANET_RADIUS', min: PLANET_RADIUS_MIN, max: PLANET_RADIUS_MAX, step: 1 }).on('change', () => setPlanetRadius(PLANET.radius));
  planet.addBinding(PLANET, 'sky', { label: 'sky preset', options: { Day: 'day', Sunset: 'sunset' } }).on('change', () => world.setSkyPreset(PLANET.sky));
  planet.addBinding(DRESSING, 'grass', { label: 'grass density', min: 0, max: 3, step: 0.05 }).on('change', () => world.dressing.setGrassDensity(DRESSING.grass));
  planet.addBinding(DECOR, 'rocks', { label: 'rocks', min: 0, max: 4, step: 0.05 }).on('change', () => world.dressing.rebuild());
  planet.addBinding(DECOR, 'rim', { label: 'rocks at rim ×', min: 1, max: 8, step: 0.1 }).on('change', () => world.dressing.rebuild());
  planet.addBinding(DECOR, 'big', { label: 'big rocks', min: 0, max: 0.6, step: 0.01 }).on('change', () => world.dressing.rebuild());
  planet.addBinding(DECOR, 'moss', { label: 'moss on rocks', min: 0, max: 1, step: 0.01 }).on('change', () => applyDecor());

  const ground = pane.addFolder({ title: 'Ground shader', expanded: false });
  ground.addBinding(GROUND, 'patch', { label: 'dry patch freq', min: 0.01, max: 0.2, step: 0.001 });
  ground.addBinding(GROUND, 'moss', { label: 'moss threshold', min: 0.3, max: 0.9, step: 0.005 });
  ground.addBinding(GROUND, 'soil', { label: 'soil threshold', min: 0.4, max: 1, step: 0.005 });
  ground.addBinding(GROUND, 'clump', { label: 'clump freq', min: 0.3, max: 5, step: 0.05 });
  ground.addBinding(GROUND, 'grain', { label: 'grain freq', min: 1, max: 20, step: 0.1 });
  ground.addBinding(GROUND, 'bump', { label: 'bump (m)', min: 0, max: 0.2, step: 0.001 });
  ground.addBinding(GROUND, 'pathEdge', { label: 'path edge wobble', min: 0, max: 1, step: 0.01 });
  ground.on('change', () => applyGround());
  // 地面颜色：每个预设一组（Verdant 是「你的星球」）
  for (const [id, p] of Object.entries(PRESETS)) {
    const f = ground.addFolder({ title: `Colors · ${p.label}`, expanded: id === 'verdant' });
    for (const key of Object.keys(p.ground) as Array<keyof typeof p.ground>) f.addBinding(p.ground, key);
    f.on('change', () => applyGroundPalette());
  }

  const galaxy = pane.addFolder({ title: 'Galaxy camera', expanded: false });
  galaxy.addBinding(SHOTS.galaxy, 'distance', { min: 80, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'elevation', { label: 'elevation°', min: 0, max: 89, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'lift', { min: -150, max: 100, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'minDistance', { label: 'min distance', min: 10, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'maxDistance', { label: 'max distance', min: 50, max: 2000, step: 1 });
  galaxy.on('change', () => world.applyShots());

  const planetCam = pane.addFolder({ title: 'Planet camera (× radius)' });
  planetCam.addBinding(SHOTS.planet, 'distance', { label: 'distance ×R', min: 1.1, max: 6, step: 0.01 });
  planetCam.addBinding(SHOTS.planet, 'elevation', { label: 'elevation°', min: 0, max: 89, step: 0.5 });
  planetCam.addBinding(SHOTS.planet, 'lift', { label: 'lift ×R', min: -1, max: 1, step: 0.005 });
  planetCam.addBinding(SHOTS.planet, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  planetCam.addBinding(SHOTS.planet, 'minDistance', { label: 'min distance ×R', min: 1.05, max: 4, step: 0.01 });
  planetCam.addBinding(SHOTS.planet, 'maxDistance', { label: 'max distance ×R', min: 1.5, max: 10, step: 0.05 });
  planetCam.addBinding(SHOTS.planet, 'minElevation', { label: 'min elevation°', min: -30, max: 60, step: 0.5 });
  planetCam.addBinding(SHOTS.planet, 'maxElevation', { label: 'max elevation°', min: 30, max: 89, step: 0.5 });
  planetCam.on('change', () => world.applyShots());

  const walk = pane.addFolder({ title: 'Walk camera', expanded: false });
  walk.addBinding(FOLLOW, 'distance', { label: 'distance (m)', min: FOLLOW.minDistance, max: FOLLOW.maxDistance, step: 0.05 });
  walk.addBinding(FOLLOW, 'pitch', { label: 'pitch (rad)', min: FOLLOW.minPitch, max: FOLLOW.maxPitch, step: 0.005 });
  walk.addBinding(FOLLOW, 'aim', { label: 'aim above (m)', min: 0, max: 2, step: 0.01 });
  walk.addBinding(FOLLOW, 'focus', { label: 'focus height (m)', min: 0.2, max: 1.5, step: 0.01 });
  walk.addBinding(WALK, 'speed', { label: 'walk speed (m/s)', min: 0.5, max: 8, step: 0.05 });

  const look = pane.addFolder({ title: 'Tone mapping' });
  look.addBinding(LOOK, 'toneMapping', { label: 'mode', options: Object.fromEntries(Object.keys(TONE_MAPPINGS).map((k) => [k, k])) });
  look.addBinding(LOOK, 'exposure', { min: 0, max: 3, step: 0.01 });
  look.on('change', () => applyLook());

  const lights = pane.addFolder({ title: 'Studio lights (Museum, viewer)', expanded: false });
  lights.addBinding(LIGHTS.sky, 'intensity', { label: 'sky', min: 0, max: 5, step: 0.05 });
  for (const [name, shot] of [['key', LIGHTS.key], ['rim', LIGHTS.rim]] as const) {
    lights.addBinding(shot, 'intensity', { label: name, min: 0, max: 10, step: 0.05 });
    lights.addBinding(shot, 'azimuth', { label: `${name} azimuth°`, min: -180, max: 180, step: 0.1 });
    lights.addBinding(shot, 'elevation', { label: `${name} elevation°`, min: -90, max: 90, step: 0.1 });
  }
  lights.on('change', () => applyLights());

  // 只读：实际帧间隔（主循环的 dt，最多记 100 ms）、主画面的像素比（像素预算）、草和石头的实例数
  const stats = { frame: 0, pixelRatio: world.renderer.getPixelRatio(), canvas: '', rocks: '', calls: 0, triangles: 0 };
  world.frameHooks.add((dt) => {
    stats.frame = dt * 1000;
    stats.pixelRatio = world.renderer.getPixelRatio();
    stats.canvas = `${world.renderer.domElement.width} × ${world.renderer.domElement.height}`;
    const r = world.dressing.rocks;
    stats.rocks = `${r.instances} in ${r.drawCalls} draws`;
  });
  // 绘制统计要在画完以后读（renderer.info 在每帧开始时清零）
  world.renderHooks.add(() => {
    stats.calls = world.renderer.info.render.drawCalls;
    stats.triangles = world.renderer.info.render.triangles;
  });
  const perf = pane.addFolder({ title: 'Performance', expanded: false });
  perf.addBinding(stats, 'frame', { label: 'frame ms', readonly: true, view: 'graph', min: 0, max: 50 });
  perf.addBinding(stats, 'pixelRatio', { label: 'pixel ratio', readonly: true, format: (v: number) => v.toFixed(2) });
  perf.addBinding(stats, 'canvas', { label: 'canvas px', readonly: true });
  perf.addBinding(stats, 'calls', { label: 'draw calls', readonly: true, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'triangles', { label: 'triangles', readonly: true, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'rocks', { label: 'rocks', readonly: true });

  pane.addButton({ title: 'Copy parameters' }).on('click', () => void copy(tuneJson()));
}

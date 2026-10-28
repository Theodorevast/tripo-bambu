import { Pane } from 'tweakpane';
import { FOLLOW, WALK } from './play/params';
import { applyDecor, DECOR } from './planet/decor';
import { applyGround, applyGroundPalette, GRASS_GROUND, GROUND } from './planet/ground';
import { PLANET_RADIUS, PLANET_RADIUS_MAX, PLANET_RADIUS_MIN, PRESETS, setPlanetRadius } from './planet/presets';
import { DRESSING, GRASS } from './scenes/dressing';
import { applyLights, LIGHTS } from './scenes/lights';
import { applyLook, LOOK, TONE_MAPPINGS } from './scenes/look';
import { SHOTS } from './scenes/shots';
import { SKY, WEATHER, type World } from './scenes/world';
import { LIFE_EFFECTS, type LifeEffect, type LifeQuality } from './nature/life';
import { toast } from './ui/toast';

// 实时调参面板：地址带 ?tune 时由 main.ts 动态加载（Tweakpane 打成单独的包，平时不下载）。改动立刻生效，不用刷新。
// 分组（I1 整理）：
// - Planet：星球半径、石头、地表着色器、每个预设的地面配色（草叶的颜色也从这里取）
// - Grass：草量、形状、风和太阳的响应、背光色，以及地面和草的衔接
// - Sky & light：天空预设、曝光（atmosphere.params.exposure：主画面的色调映射和曝光归 atmosphere）、太阳、雾、云海
// - Life：雨、风、傍晚系数、档位、各效果开关
// - Camera：星系、星球、漫游三套镜头
// - Museum & viewer：Museum 卡片和查看器的色调映射、摄影棚灯（主画面不用它们）
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
const PLANET_TUNE = { radius: PLANET_RADIUS, sky: 'day' as 'day' | 'sunset' };
// 生机层：傍晚系数（auto = 跟着天空预设）、档位、效果开关
const life = { eveningAuto: true, evening: 0, quality: 'high' as LifeQuality };
const effects = Object.fromEntries(LIFE_EFFECTS.map((k) => [k, true])) as Record<LifeEffect, boolean>;

// 复制出去的 JSON：数字保留 3 位小数，滑块拖出来的浮点尾巴不带上
export function tuneJson(world?: World): string {
  const ground = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, p.ground]));
  const sky = world ? { preset: world.skyPreset, ...world.atmosphere.params } : { preset: PLANET_TUNE.sky };
  return JSON.stringify(
    {
      planetRadius: PLANET_RADIUS,
      sky,
      dressing: DRESSING,
      grass: GRASS,
      grassGround: GRASS_GROUND,
      decor: DECOR,
      ground: GROUND,
      palette: ground,
      weather: WEATHER,
      skyGame: SKY,
      shots: SHOTS,
      follow: FOLLOW,
      walk: WALK,
      museumLook: LOOK,
      museumLights: LIGHTS,
    },
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

  // —— Planet ——
  const planetFolder = pane.addFolder({ title: 'Planet' });
  PLANET_TUNE.radius = PLANET_RADIUS;
  planetFolder.addBinding(PLANET_TUNE, 'radius', { label: 'PLANET_RADIUS', min: PLANET_RADIUS_MIN, max: PLANET_RADIUS_MAX, step: 1 }).on('change', () => setPlanetRadius(PLANET_TUNE.radius));
  planetFolder.addBinding(DECOR, 'rocks', { label: 'rocks', min: 0, max: 4, step: 0.05 }).on('change', () => world.dressing.rebuild());
  planetFolder.addBinding(DECOR, 'rim', { label: 'rocks at rim ×', min: 1, max: 8, step: 0.1 }).on('change', () => world.dressing.rebuild());
  planetFolder.addBinding(DECOR, 'big', { label: 'big rocks', min: 0, max: 0.6, step: 0.01 }).on('change', () => world.dressing.rebuild());
  planetFolder.addBinding(DECOR, 'moss', { label: 'moss on rocks', min: 0, max: 1, step: 0.01 }).on('change', () => applyDecor());
  const groundShader = planetFolder.addFolder({ title: 'Ground shader', expanded: false });
  groundShader.addBinding(GROUND, 'patch', { label: 'dry patch freq', min: 0.01, max: 0.2, step: 0.001 });
  groundShader.addBinding(GROUND, 'moss', { label: 'moss threshold', min: 0.3, max: 0.9, step: 0.005 });
  groundShader.addBinding(GROUND, 'soil', { label: 'soil threshold', min: 0.4, max: 1, step: 0.005 });
  groundShader.addBinding(GROUND, 'clump', { label: 'clump freq', min: 0.3, max: 5, step: 0.05 });
  groundShader.addBinding(GROUND, 'grain', { label: 'grain freq', min: 1, max: 20, step: 0.1 });
  groundShader.addBinding(GROUND, 'bump', { label: 'bump (m)', min: 0, max: 0.2, step: 0.001 });
  groundShader.addBinding(GROUND, 'pathEdge', { label: 'path edge wobble', min: 0, max: 1, step: 0.01 });
  groundShader.on('change', () => applyGround());
  // 地面和草叶的颜色：每个预设一组（Verdant 是「你的星球」）。grass / fresh / dry / tip / root 也是草叶的颜色
  for (const [id, p] of Object.entries(PRESETS)) {
    const f = planetFolder.addFolder({ title: `Colors · ${p.label}`, expanded: false });
    for (const key of Object.keys(p.ground) as Array<keyof typeof p.ground>) f.addBinding(p.ground, key);
    f.on('change', () => applyGroundPalette());
    void id;
  }

  // —— Grass ——
  const grass = pane.addFolder({ title: 'Grass', expanded: false });
  grass.addBinding(DRESSING, 'grass', { label: 'density', min: 0, max: 1, step: 0.05 }).on('change', () => world.dressing.setGrassDensity(DRESSING.grass));
  grass.addBinding(GRASS, 'height', { min: 0.3, max: 2, step: 0.01 });
  grass.addBinding(GRASS, 'width', { min: 0.3, max: 2.5, step: 0.01 });
  grass.addBinding(GRASS, 'flowers', { min: 0, max: 1, step: 0.01 });
  grass.addBinding(GRASS, 'radius', { label: 'radius (m)', min: 8, max: 60, step: 1 });
  grass.addBinding(GRASS, 'fullRadius', { label: 'full density (m)', min: 2, max: 20, step: 0.5 });
  grass.addBinding(GRASS, 'wind', { label: 'wind response', min: 0, max: 0.6, step: 0.005 });
  grass.addBinding(GRASS, 'sun', { label: 'sun response', min: 0, max: 1.5, step: 0.01 });
  grass.addBinding(GRASS, 'sunDusk', { label: 'sun at dusk ×', min: 0, max: 1.5, step: 0.01 });
  grass.addBinding(GRASS, 'translucency', { label: 'backlight', min: 0, max: 3, step: 0.05 });
  grass.addBinding(GRASS, 'shadowDay', { label: 'shadow (day)' });
  grass.addBinding(GRASS, 'shadowDusk', { label: 'shadow (dusk)' });
  grass.addBinding(GRASS_GROUND, 'dryness', { min: 0, max: 1, step: 0.01 }).on('change', () => applyGround());
  grass.addBinding(GRASS_GROUND, 'tint', { label: 'far ground ×', min: 0.1, max: 1.5, step: 0.01 }).on('change', () => applyGround());
  grass.on('change', () => world.dressing.applyGrass());

  // —— Sky & light ——（色调映射 AgX，曝光 = 预设 × exposure）
  const sky = pane.addFolder({ title: 'Sky & light' });
  PLANET_TUNE.sky = world.skyPreset;
  const ap = world.atmosphere.params;
  sky.addBinding(PLANET_TUNE, 'sky', { label: 'preset', options: { Day: 'day', Sunset: 'sunset' } }).on('change', () => world.setSkyPreset(PLANET_TUNE.sky));
  sky.addBinding(ap, 'exposure', { min: 0.2, max: 3, step: 0.01 });
  sky.addBinding(ap, 'sunElevation', { label: 'sun elevation°', min: -5, max: 70, step: 0.5 });
  sky.addBinding(ap, 'sunAzimuth', { label: 'sun azimuth°', min: -180, max: 180, step: 1 });
  sky.addBinding(ap, 'fog', { min: 0, max: 4, step: 0.01 });
  sky.addBinding(SKY, 'galaxySeaDrop', { label: 'galaxy sea drop ×R', min: 0, max: 8, step: 0.05 }).on('change', () => world.applySky());
  sky.addBinding(SKY, 'galaxyFog', { label: 'galaxy fog ×', min: 0, max: 2, step: 0.01 }).on('change', () => world.applySky());
  const sea = sky.addFolder({ title: 'Sea of clouds', expanded: false });
  sea.addBinding(ap, 'seaHeight', { label: 'height ×R', min: -1.5, max: 0.5, step: 0.01 });
  sea.addBinding(ap, 'seaThickness', { label: 'thickness ×R', min: 0.05, max: 2, step: 0.01 });
  sea.addBinding(ap, 'cloudScale', { label: 'cloud size', min: 0.2, max: 4, step: 0.01 });
  sea.addBinding(ap, 'cloudSpeed', { label: 'drift speed', min: 0, max: 6, step: 0.05 });
  sea.addBinding(ap, 'cloudSteps', { label: 'march steps', min: 4, max: 64, step: 1 });
  sea.addBinding(ap, 'farClouds', { label: 'far cumulus' });

  // —— Life ——
  const lf = pane.addFolder({ title: 'Life', expanded: false });
  lf.addBinding(WEATHER, 'rain', { min: 0, max: 1, step: 0.01 });
  lf.addBinding(WEATHER, 'wind', { min: 0, max: 1, step: 0.01 });
  const syncEvening = () => { WEATHER.evening = life.eveningAuto ? null : life.evening; };
  lf.addBinding(life, 'eveningAuto', { label: 'evening = sky' }).on('change', syncEvening);
  lf.addBinding(life, 'evening', { min: 0, max: 1, step: 0.01 }).on('change', () => { life.eveningAuto = false; syncEvening(); });
  lf.addBinding(life, 'quality', { options: { High: 'high', Low: 'low' } }).on('change', () => world.life.setQuality(life.quality));
  const fx = lf.addFolder({ title: 'Effects', expanded: false });
  for (const k of LIFE_EFFECTS) fx.addBinding(effects, k).on('change', () => world.life.setEnabled(k, effects[k]));

  // —— Camera ——
  const cam = pane.addFolder({ title: 'Camera', expanded: false });
  const galaxy = cam.addFolder({ title: 'Galaxy', expanded: false });
  galaxy.addBinding(SHOTS.galaxy, 'distance', { min: 80, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'elevation', { label: 'elevation°', min: 0, max: 89, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'lift', { min: -150, max: 100, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'minDistance', { label: 'min distance', min: 10, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'maxDistance', { label: 'max distance', min: 50, max: 2000, step: 1 });
  galaxy.on('change', () => world.applyShots());
  const planetCam = cam.addFolder({ title: 'Planet (× radius)' });
  planetCam.addBinding(SHOTS.planet, 'distance', { label: 'distance ×R', min: 1.1, max: 6, step: 0.01 });
  planetCam.addBinding(SHOTS.planet, 'elevation', { label: 'elevation°', min: 0, max: 89, step: 0.5 });
  planetCam.addBinding(SHOTS.planet, 'lift', { label: 'lift ×R', min: -1, max: 1, step: 0.005 });
  planetCam.addBinding(SHOTS.planet, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  planetCam.addBinding(SHOTS.planet, 'minDistance', { label: 'min distance ×R', min: 1.05, max: 4, step: 0.01 });
  planetCam.addBinding(SHOTS.planet, 'maxDistance', { label: 'max distance ×R', min: 1.5, max: 10, step: 0.05 });
  planetCam.addBinding(SHOTS.planet, 'minElevation', { label: 'min elevation°', min: -30, max: 60, step: 0.5 });
  planetCam.addBinding(SHOTS.planet, 'maxElevation', { label: 'max elevation°', min: 30, max: 89, step: 0.5 });
  planetCam.on('change', () => world.applyShots());
  const walk = cam.addFolder({ title: 'Walk', expanded: false });
  walk.addBinding(FOLLOW, 'distance', { label: 'distance (m)', min: FOLLOW.minDistance, max: FOLLOW.maxDistance, step: 0.05 });
  walk.addBinding(FOLLOW, 'pitch', { label: 'pitch (rad)', min: FOLLOW.minPitch, max: FOLLOW.maxPitch, step: 0.005 });
  walk.addBinding(FOLLOW, 'aim', { label: 'aim above (m)', min: 0, max: 2, step: 0.01 });
  walk.addBinding(FOLLOW, 'shoulder', { label: 'shoulder (m)', min: -1.2, max: 1.2, step: 0.01 });
  walk.addBinding(FOLLOW, 'focus', { label: 'focus height (m)', min: 0.2, max: 1.5, step: 0.01 });
  walk.addBinding(WALK, 'speed', { label: 'walk speed (m/s)', min: 0.5, max: 8, step: 0.05 });

  // —— Museum & viewer（它们有自己的渲染器和摄影棚灯，主画面不受影响）——
  const museum = pane.addFolder({ title: 'Museum & viewer', expanded: false });
  museum.addBinding(LOOK, 'toneMapping', { label: 'tone mapping', options: Object.fromEntries(Object.keys(TONE_MAPPINGS).map((k) => [k, k])) }).on('change', () => applyLook());
  museum.addBinding(LOOK, 'exposure', { min: 0, max: 3, step: 0.01 }).on('change', () => applyLook());
  museum.addBinding(LIGHTS.sky, 'intensity', { label: 'sky light', min: 0, max: 5, step: 0.05 }).on('change', () => applyLights());
  for (const [name, shot] of [['key', LIGHTS.key], ['rim', LIGHTS.rim]] as const) {
    museum.addBinding(shot, 'intensity', { label: name, min: 0, max: 10, step: 0.05 }).on('change', () => applyLights());
    museum.addBinding(shot, 'azimuth', { label: `${name} azimuth°`, min: -180, max: 180, step: 0.1 }).on('change', () => applyLights());
    museum.addBinding(shot, 'elevation', { label: `${name} elevation°`, min: -90, max: 90, step: 0.1 }).on('change', () => applyLights());
  }

  // —— Performance（只读）：实际帧间隔（主循环的 dt，最多记 100 ms）、像素比、绘制统计、草、石头、生机层 ——
  const stats = { frame: 0, pixelRatio: world.renderer.getPixelRatio(), canvas: '', rocks: '', grass: '', life: '', calls: 0, triangles: 0 };
  world.frameHooks.add((dt) => {
    stats.frame = dt * 1000;
    stats.pixelRatio = world.renderer.getPixelRatio();
    stats.canvas = `${world.renderer.domElement.width} × ${world.renderer.domElement.height}`;
    const r = world.dressing.rocks;
    stats.rocks = `${r.instances} in ${r.drawCalls} draws`;
    const g = world.dressing.grass?.stats;
    stats.grass = g ? `${g.instances + g.flowerInstances} in ${g.drawCalls} draws` : '-';
  });
  // 绘制统计要在画完以后读（renderer.info 在每帧开始时清零）
  world.renderHooks.add(() => {
    stats.calls = world.renderer.info.render.drawCalls;
    stats.triangles = world.renderer.info.render.triangles;
  });
  setInterval(() => {
    const s = world.life.stats();
    stats.life = `${s.drawCalls} draws · ${s.cpuMs.toFixed(2)} ms cpu`;
  }, 500);
  const perf = pane.addFolder({ title: 'Performance', expanded: false });
  perf.addBinding(stats, 'frame', { label: 'frame ms', readonly: true, view: 'graph', min: 0, max: 50 });
  perf.addBinding(stats, 'pixelRatio', { label: 'pixel ratio', readonly: true, format: (v: number) => v.toFixed(2) });
  perf.addBinding(stats, 'canvas', { label: 'canvas px', readonly: true });
  perf.addBinding(stats, 'calls', { label: 'draw calls', readonly: true, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'triangles', { label: 'triangles', readonly: true, format: (v: number) => v.toFixed(0) });
  perf.addBinding(stats, 'grass', { label: 'grass', readonly: true });
  perf.addBinding(stats, 'rocks', { label: 'rocks', readonly: true });
  perf.addBinding(stats, 'life', { label: 'life', readonly: true });

  pane.addButton({ title: 'Copy parameters' }).on('click', () => void copy(tuneJson(world)));
}

import { NIGHT_SKY } from '../nature/nightSky';
import { applyGrade, GRADE } from '../style/grade';
import { applyVeilNight, VEIL_NIGHT } from '../style/veilNight';
import type { World } from './world';

// ?tune 的「Night sky」组（v2-sky）：星星、银河、月亮、云海的颜色和银边、空气里的星屑、夜里的补光、颗粒、暗角、泛光、转场的金线。
// 表（NIGHT_SKY、VEIL_NIGHT）每帧都读，拖滑块立刻生效；暗角是调色表 GRADE 里的那两项（改了调 applyGrade）。
// tune.ts 只调 addNightSkyTune、把 SKY_TUNE 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
}

export const SKY_TUNE = { nightSky: NIGHT_SKY, transitionGlint: VEIL_NIGHT };

type Key = keyof typeof NIGHT_SKY & string;
const range = (min: number, max: number, step: number) => ({ min, max, step });

export function addNightSkyTune(pane: Folder, world: World): void {
  const root = pane.addFolder({ title: 'Night sky', expanded: false });
  const bind = (f: Folder, key: Key, label: string, opts: Record<string, unknown> = {}) => f.addBinding(NIGHT_SKY, key, { label, ...opts });
  // 天空预设：和 Sky & light 里的是同一个（这里放一份，调夜空时不用来回切）
  const preset = { sky: world.skyPreset };
  root.addBinding(preset, 'sky', { label: 'preset', options: { 'Blue hour': 'blue', Moonlit: 'moon', Day: 'day', Sunset: 'sunset' } }).on('change', () => world.setSkyPreset(preset.sky));

  const stars = root.addFolder({ title: 'Stars' });
  bind(stars, 'density', 'density', range(0, 3, 0.01));
  bind(stars, 'stars', 'brightness', range(0, 4, 0.01));
  bind(stars, 'starSize', 'size', range(0.3, 3, 0.01));
  bind(stars, 'twinkle', 'twinkle', range(0, 1, 0.01));
  bind(stars, 'twinkleSpeed', 'twinkle speed', range(0, 4, 0.01));
  bind(stars, 'spikes', 'cross spikes', range(0, 3, 0.01));
  bind(stars, 'homeStars', 'home brightness ×', range(0, 6, 0.05));

  const milky = root.addFolder({ title: 'Milky Way', expanded: false });
  bind(milky, 'milkyWay', 'strength', range(0, 3, 0.01));
  bind(milky, 'milkyWidth', 'width', range(0.02, 0.6, 0.005));
  bind(milky, 'milkyPurple', 'purple');
  bind(milky, 'milkyGold', 'gold');
  bind(milky, 'milkyFrom', 'home from (NDC)', { x: range(-1.5, 1.5, 0.01), y: range(-1.5, 1.5, 0.01) });
  bind(milky, 'milkyTo', 'home to (NDC)', { x: range(-1.5, 1.5, 0.01), y: range(-1.5, 1.5, 0.01) });
  bind(milky, 'milkyTilt', 'planet tilt°', range(0, 90, 0.5));
  bind(milky, 'milkyTurn', 'planet turn°', range(-180, 180, 1));

  const moon = root.addFolder({ title: 'Moon', expanded: false });
  bind(moon, 'moonWide', 'home position (wide)', { x: range(-1, 1, 0.01), y: range(-1, 1, 0.01) });
  bind(moon, 'moonTall', 'home position (tall)', { x: range(-1, 1, 0.01), y: range(-1, 1, 0.01) });
  bind(moon, 'moonAzimuth', 'planet azimuth°', range(-180, 360, 1));
  bind(moon, 'moonElevation', 'planet elevation°', range(-10, 80, 0.5));
  bind(moon, 'moonSize', 'size', range(0.3, 3, 0.01));
  bind(moon, 'moonTilt', 'crescent facing°', range(-180, 180, 1));
  bind(moon, 'moonGlow', 'halo', range(0, 3, 0.01));
  bind(moon, 'moonColor', 'disc color');
  bind(moon, 'moonHaloColor', 'halo color');

  const clouds = root.addFolder({ title: 'Sea of clouds', expanded: false });
  bind(clouds, 'homeLit', 'home lit');
  bind(clouds, 'homeMid', 'home mid');
  bind(clouds, 'homeShade', 'home shade');
  bind(clouds, 'homeDeep', 'home deep');
  bind(clouds, 'homeMix', 'home color mix', range(0, 1, 0.01));
  bind(clouds, 'silver', 'silver edge');
  bind(clouds, 'silverK', 'silver strength', range(0, 3, 0.01));
  bind(clouds, 'silverPow', 'silver tightness', range(0.5, 8, 0.05));
  bind(clouds, 'homeGaps', 'home gaps', range(0, 1, 0.01));
  bind(clouds, 'homeThin', 'home thin', range(0, 1, 0.01));
  bind(clouds, 'planetGaps', 'planet gaps', range(0, 1, 0.01));
  bind(clouds, 'gapLo', 'gap from', range(0, 1, 0.01));
  bind(clouds, 'gapHi', 'gap to', range(0, 1, 0.01));
  bind(clouds, 'scatter', 'moon glow in clouds', range(0, 4, 0.01));
  bind(clouds, 'clear', 'clear around moon', range(0, 1, 0.01));
  bind(clouds, 'clearSize', 'clear size × moon', range(1.2, 6, 0.05));

  const dust = root.addFolder({ title: 'Stardust in the air', expanded: false });
  bind(dust, 'dust', 'amount', range(0, 3, 0.01));
  bind(dust, 'dustSize', 'size (px)', range(0.3, 5, 0.05));
  bind(dust, 'dustDrift', 'drift', range(0, 6, 0.05));
  bind(dust, 'dustTwinkle', 'twinkle', range(0, 1, 0.01));

  const light = root.addFolder({ title: 'Night light', expanded: false });
  bind(light, 'ambient', 'cool fill');
  bind(light, 'ambientK', 'cool fill ×', range(0, 4, 0.01));
  bind(light, 'backFill', 'back fill');
  bind(light, 'backFillK', 'back fill ×', range(0, 4, 0.01));
  bind(light, 'planetKey', 'planet key ×', range(0.5, 4, 0.01));
  bind(light, 'planetEnv', 'planet sky fill ×', range(0.5, 4, 0.01));
  bind(light, 'planetExposure', 'planet exposure ×', range(0.5, 3, 0.01));
  bind(light, 'fogStart', 'fog starts at ×R', range(0, 10, 0.05));
  bind(light, 'heightFog', 'height fog ×', range(0, 1.5, 0.01));
  bind(light, 'fireflies', 'evening (fireflies)', range(0, 1, 0.01));

  const post = root.addFolder({ title: 'Grain, vignette, bloom', expanded: false });
  bind(post, 'grain', 'grain', range(0, 0.15, 0.001));
  bind(post, 'grainSize', 'grain size (px)', range(0.5, 4, 0.05));
  bind(post, 'grainFps', 'grain fps', range(1, 60, 1));
  post.addBinding(GRADE, 'vignette', { label: 'vignette', min: 0, max: 1, step: 0.01 }).on('change', () => applyGrade());
  post.addBinding(GRADE, 'vignetteTint', { label: 'vignette tint' }).on('change', () => applyGrade());
  bind(post, 'bloom', 'bloom', range(0, 3, 0.01));
  bind(post, 'bloomThreshold', 'bloom threshold', range(0, 6, 0.01));
  bind(post, 'bloomKnee', 'bloom knee', range(0.01, 3, 0.01));
  bind(post, 'bloomRadius', 'bloom radius', range(0.25, 1, 0.01));

  const veil = root.addFolder({ title: 'Transition', expanded: false });
  veil.addBinding(VEIL_NIGHT, 'silver', { label: 'cloud silver edge', min: 0, max: 3, step: 0.01 });
  veil.addBinding(VEIL_NIGHT, 'line', { label: 'gold line' });
  veil.addBinding(VEIL_NIGHT, 'lineGlow', { label: 'line brightness', min: 0, max: 8, step: 0.05 });
  veil.addBinding(VEIL_NIGHT, 'width', { label: 'line width (px)', min: 0.3, max: 6, step: 0.05 });
  veil.addBinding(VEIL_NIGHT, 'halo', { label: 'line halo', min: 0.001, max: 0.1, step: 0.001 });
  veil.addBinding(VEIL_NIGHT, 'dust', { label: 'stardust', min: 0, max: 3, step: 0.01 });
  veil.addBinding(VEIL_NIGHT, 'trail', { label: 'stardust trail', min: 0.01, max: 0.8, step: 0.005 });
  veil.on('change', () => applyVeilNight());
}

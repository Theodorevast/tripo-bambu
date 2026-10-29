import { CALM } from '../nature/atmosphere';
import { HOME_DUST } from './homeGalaxy';
import { HOME_FIT, HOME_SPIRAL } from './homeLayout';
import { HOME_MOTION } from './homeMotion';
import { SHOTS } from './shots';
import { SKY, type World } from './world';

// ?tune 的「Home」组（H2，首页 = 星系视图）：螺旋星系（臂绕几圈、张开多少、间距、大小和淡怎么往外变、星尘多少）、镜头（仰角、视角、
// 安全区、能转多少、慢慢自转）、云海放安静多少、星球悬停 / 回弹的手感；翠宝那一块由 fun/couponsHome.ts 自己加（extra）。
// tune.ts 只调 addHomeTune、把 HOME_TUNE 放进「Copy parameters」的 JSON

interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
export interface HomeTuneFolder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): HomeTuneFolder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
}

type Slider<T> = [keyof T & string, number, number, number, string?];

function sliders<T extends object>(folder: HomeTuneFolder, target: T, list: Array<Slider<T>>): void {
  for (const [key, min, max, step, label] of list) folder.addBinding(target, key, { min, max, step, ...(label ? { label } : {}) });
}

export const HOME_TUNE = { spiral: HOME_SPIRAL, dust: HOME_DUST, fit: HOME_FIT, camera: SHOTS.galaxy, calm: CALM, motion: HOME_MOTION };

// 别的模块往「Home」里加的（翠宝、名牌……）：installHome 时登记，面板打开时一起建
const extras: Array<(folder: HomeTuneFolder) => void> = [];
export function addHomeTuneExtra(fn: (folder: HomeTuneFolder) => void): void {
  extras.push(fn);
}

export function addHomeTune(pane: HomeTuneFolder, world: World): void {
  const home = pane.addFolder({ title: 'Home' });
  const apply = () => world.applyHome();
  const spiral = home.addFolder({ title: 'Spiral galaxy', expanded: true });
  sliders(spiral, HOME_SPIRAL, [
    ['turns', 0.2, 2, 0.01, 'arm turns'],
    ['outer', 1.5, 10, 0.05, 'arm opening (outer / inner)'],
    ['inner', 1.5, 6, 0.05, 'first planet from center ×R'],
    ['gap', 0.1, 2, 0.01, 'spacing along arm'],
    ['ringGap', 0, 4, 0.05, 'built ↔ building gap ×R'],
    ['spread', 0, 1.5, 0.01, 'random spread ×R'],
    ['bob', 0, 1.5, 0.01, 'random up / down ×R'],
    ['youScale', 0.8, 2.4, 0.01, 'your planet size'],
    ['builtScale', 0.4, 1.6, 0.01, 'built size'],
    ['builtFalloff', 0, 0.8, 0.01, 'built size falloff'],
    ['buildingScale', 0.2, 1.2, 0.01, 'building size'],
    ['buildingFalloff', 0, 0.8, 0.01, 'building size falloff'],
    ['buildingDim', 0, 0.8, 0.01, 'building faded'],
    ['dimFalloff', 0, 0.8, 0.01, 'fade falloff'],
    ['tallStretch', 1, 2.5, 0.01, 'phone: stretch toward camera'],
  ]);
  spiral.on('change', apply);
  const dust = home.addFolder({ title: 'Stardust & wisps', expanded: false });
  sliders(dust, HOME_DUST, [
    ['density', 0, 2.5, 0.01, 'stardust density'],
    ['size', 0.2, 3, 0.01, 'stardust size'],
    ['glow', 0, 3, 0.01, 'stardust brightness'],
    ['width', 0.2, 3, 0.01, 'arm width'],
    ['wisps', 0, 3, 0.01, 'cloud wisps'],
    ['extra', 0, 6, 0.05, 'arm past outermost planet ×R'],
    ['halo', 0, 2, 0.01, 'glow around your planet'],
  ]);
  dust.on('change', apply);
  for (const [title, fit] of [['Camera · wide screen', HOME_FIT.wide], ['Camera · phone', HOME_FIT.tall]] as const) {
    const f = home.addFolder({ title, expanded: false });
    sliders(f, fit, [
      ['elevation', 10, 85, 0.5, 'elevation°'],
      ['fov', 20, 70, 0.5, 'fov°'],
      ['left', -1, 0, 0.01, 'safe left'],
      ['right', 0, 1, 0.01, 'safe right'],
      ['top', -0.5, 1, 0.01, 'safe top'],
      ['bottom', -1, 0.5, 0.01, 'safe bottom'],
      ['tagPx', 0, 120, 1, 'name tag room px'],
    ]);
    f.on('change', apply);
  }
  const drag = home.addFolder({ title: 'Camera · drag & zoom', expanded: false });
  sliders(drag, SHOTS.galaxy, [
    ['orbit', 0, 180, 0.5, 'turn left / right° (180 = free)'],
    ['tilt', 0, 60, 0.5, 'tilt up / down°'],
    ['minElevation', 5, 60, 0.5, 'lowest elevation°'],
    ['maxElevation', 30, 89, 0.5, 'highest elevation°'],
    ['zoomIn', 0.3, 1, 0.01, 'zoom in ×'],
    ['zoomOut', 1, 3, 0.01, 'zoom out ×'],
    ['spin', 0, 2, 0.01, 'slow spin (turns / min)'],
  ]);
  drag.on('change', apply);
  const sea = home.addFolder({ title: 'Calm cloud sea', expanded: false });
  sea.addBinding(SKY, 'galaxyCalm', { label: 'calm', min: 0, max: 1, step: 0.01 }).on('change', () => world.applySky());
  sea.addBinding(SKY, 'galaxySeaDrop', { label: 'sea drop ×R', min: 0, max: 10, step: 0.05 }).on('change', () => world.applySky());
  sliders(sea, CALM, [
    ['thickness', 0, 1, 0.01, 'flatter'],
    ['scale', 0, 4, 0.01, 'bigger clouds'],
    ['blur', 0, 6, 0.05, 'softer texture'],
    ['soft', 0, 1, 0.01, 'less contrast'],
    ['haze', 0, 4, 0.05, 'more haze'],
    ['streaks', 0, 1, 0.01, 'sky streaks off'],
    ['puffs', 0, 1, 0.01, 'far cumulus off'],
    ['steps', 0, 0.8, 0.01, 'fewer march steps'],
    ['cream', 0, 1, 0.01, 'warm cream'],
    ['dim', 0, 0.5, 0.01, 'darker (dust glows)'],
  ]);
  const motion = home.addFolder({ title: 'Planet hover & press', expanded: false });
  sliders(motion, HOME_MOTION, [
    ['hoverScale', 0, 0.3, 0.005, 'hover grow'],
    ['hoverRate', 1, 30, 0.5, 'hover speed'],
    ['spin', 0, 2, 0.01, 'hover spin rad/s'],
    ['spinRate', 0.2, 10, 0.1, 'spin ease'],
    ['settle', 2, 30, 0.5, 'spin back (enter)'],
    ['press', 0, 0.25, 0.005, 'press squash'],
    ['pressK', 50, 1500, 10, 'bounce spring'],
    ['pressC', 2, 60, 0.5, 'bounce damping'],
    ['delay', 0, 0.5, 0.01, 'bounce before enter s'],
  ]);
  for (const fn of extras) fn(home);
}

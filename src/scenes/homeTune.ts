import { CALM } from '../nature/atmosphere';
import { HOME_FIT, HOME_LAYOUT, type HomeRows } from './homeLayout';
import { HOME_MOTION } from './homeMotion';
import { SHOTS } from './shots';
import { SKY, type World } from './world';

// ?tune 的「Home」组（H2，首页 = 星系视图）：版式（每排几颗、间距、阶梯、后排的大小和淡）、镜头（仰角、视角、安全区、
// 能拖多少）、云海放安静多少、星球悬停 / 回弹的手感；翠宝那一块由 fun/couponsHome.ts 自己加（extra）。
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

export const HOME_TUNE = { layout: HOME_LAYOUT, fit: HOME_FIT, camera: SHOTS.galaxy, calm: CALM, motion: HOME_MOTION };

// 别的模块往「Home」里加的（翠宝、名牌……）：installHome 时登记，面板打开时一起建
const extras: Array<(folder: HomeTuneFolder) => void> = [];
export function addHomeTuneExtra(fn: (folder: HomeTuneFolder) => void): void {
  extras.push(fn);
}

function rowsFolder(parent: HomeTuneFolder, title: string, rows: HomeRows, apply: () => void): void {
  const f = parent.addFolder({ title, expanded: false });
  f.addBinding(rows, 'youAlone', { label: 'your planet up front' });
  sliders(f, rows, [
    ['youForward', -2, 6, 0.05, 'your planet forward ×R'],
    ['youDown', -3, 6, 0.05, 'your planet down ×R'],
    ['youScale', 0.8, 1.6, 0.01, 'your planet size'],
    ['peek', 0, 3, 0.05, 'planet behind yours up ×R'],
    ['frontMax', 1, 8, 1, 'built per row'],
    ['gap', 0.2, 3, 0.01, 'gap ×R'],
    ['rowBack', 0, 8, 0.05, 'next row back ×R'],
    ['rowUp', 0, 6, 0.05, 'next row up ×R'],
    ['backMax', 1, 10, 1, 'building per row'],
    ['backGap', 0.2, 4, 0.01, 'building gap ×R'],
    ['backDepth', 0, 14, 0.05, 'building back ×R'],
    ['backUp', -2, 8, 0.05, 'building up ×R'],
    ['backRowBack', 0, 8, 0.05, 'building next row back'],
    ['backRowUp', 0, 6, 0.05, 'building next row up'],
    ['arc', 0, 4, 0.01, 'arc (ends back) ×R'],
    ['arcY', 0, 3, 0.01, 'smile (ends down) ×R'],
    ['wobble', 0, 1, 0.01, 'hand-made wobble ×R'],
  ]);
  f.on('change', apply);
}

export function addHomeTune(pane: HomeTuneFolder, world: World): void {
  const home = pane.addFolder({ title: 'Home' });
  const apply = () => world.applyHome();
  const layout = home.addFolder({ title: 'Layout', expanded: true });
  sliders(layout, HOME_LAYOUT, [
    ['backScale', 0.3, 1, 0.01, 'building planets size'],
    ['backDim', 0, 0.9, 0.01, 'building planets faded'],
  ]);
  layout.on('change', apply);
  rowsFolder(home, 'Rows · wide screen', HOME_LAYOUT.wide, apply);
  rowsFolder(home, 'Rows · phone', HOME_LAYOUT.tall, apply);
  for (const [title, fit] of [['Camera · wide screen', HOME_FIT.wide], ['Camera · phone', HOME_FIT.tall]] as const) {
    const f = home.addFolder({ title, expanded: false });
    sliders(f, fit, [
      ['elevation', 0, 60, 0.5, 'elevation°'],
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
    ['orbit', 0, 60, 0.5, 'turn left / right°'],
    ['tilt', 0, 30, 0.5, 'tilt up / down°'],
    ['zoomIn', 0.4, 1, 0.01, 'zoom in ×'],
    ['zoomOut', 1, 2, 0.01, 'zoom out ×'],
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

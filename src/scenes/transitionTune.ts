import { toHash } from '../router';
import { toast } from '../ui/toast';
import type { Bezier } from './ease';
import { INTRO, PEEK, TRANSITIONS, type TransitionShot } from './shots';
import type { World } from './world';

// ?tune 的「Transitions」组（motion 角色，T2 的分镜表）：每个转场的时长、缓动曲线（镜头、视线各一条）、FOV 冲击、抬升、侧倾、
// 云层的四个时刻、云团大小、翠宝黄的光、作品弹出；开场飞行和翠宝探头；三个演示按钮。改了下一次转场就用新值。
// tune.ts 只调 addTransitionTune、把 TRANSITION_TUNE 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
}

export const TRANSITION_TUNE = { transitions: TRANSITIONS, intro: INTRO, peek: PEEK };

type Slider<T> = [keyof T & string, number, number, number, string?];

function sliders<T extends object>(folder: Folder, target: T, list: Array<Slider<T>>): void {
  for (const [key, min, max, step, label] of list) folder.addBinding(target, key, { min, max, step, ...(label ? { label } : {}) });
}

// 缓动曲线：CSS cubic-bezier 的四个数（x 在 0..1；y 可以出界：y1 < 0 是预备动作，y2 > 1 是冲过头）
function bezier(folder: Folder, title: string, curve: Bezier): void {
  const f = folder.addFolder({ title, expanded: false });
  sliders(f, curve, [['x1', 0, 1, 0.01], ['y1', -0.6, 1.6, 0.01], ['x2', 0, 1, 0.01], ['y2', -0.6, 1.6, 0.01]]);
}

// 分镜表的一行：时长、缓动、FOV 冲击、抬升、云层的四个时刻、光、作品弹出（时刻都是占时长的比例）
function transitionShot(folder: Folder, title: string, shot: TransitionShot): void {
  const f = folder.addFolder({ title, expanded: false });
  sliders(f, shot, [['seconds', 0.2, 4, 0.01, 'seconds']]);
  bezier(f, 'ease (camera)', shot.ease);
  bezier(f, 'ease (look)', shot.look);
  sliders(f, shot, [
    ['lookSpan', 0.05, 1, 0.01, 'look done at'],
    ['fovPunch', -20, 30, 0.5, 'FOV punch°'],
    ['fovPeak', 0.02, 0.98, 0.01, 'FOV peak at'],
    ['arc', -0.5, 1, 0.01, 'arc lift'],
    ['bank', -20, 20, 0.5, 'bank°'],
    ['cloudIn', 0, 1, 0.01, 'clouds in'],
    ['cloudFull', 0, 1, 0.01, 'clouds full'],
    ['cloudOut', 0, 1, 0.01, 'clouds out'],
    ['cloudGone', 0, 1, 0.01, 'clouds gone'],
    ['cloudSize', 0.3, 2, 0.01, 'cloud size'],
    ['flashAt', -1, 1, 0.01, 'glint at (<0 off)'],
    ['flashMs', 0, 300, 5, 'glint ms'],
    ['popAt', 0, 1, 0.01, 'works pop at'],
    ['stagger', 0, 0.3, 0.005, 'pop stagger s'],
  ]);
}

export function addTransitionTune(pane: Folder, world: World): void {
  const trans = pane.addFolder({ title: 'Transitions', expanded: false });
  transitionShot(trans, 'Galaxy → planet (cloud punch)', TRANSITIONS.enter);
  transitionShot(trans, 'Planet → planet (hop)', TRANSITIONS.hop);
  transitionShot(trans, 'Planet → galaxy', TRANSITIONS.leave);
  transitionShot(trans, 'Reduced motion (fade)', TRANSITIONS.fade);
  const intro = trans.addFolder({ title: 'Intro & Triboo peek', expanded: false });
  sliders(intro, INTRO, [['seconds', 0.5, 6, 0.05, 'intro seconds'], ['distance', 1, 5, 0.05, 'intro from ×']]);
  sliders(intro, PEEK, [
    ['delay', 0, 2, 0.01, 'peek delay s'],
    ['rise', 0.1, 2, 0.01, 'rise s'],
    ['wave', 0.2, 3, 0.01, 'wave s'],
    ['waves', 1, 6, 1, 'waves'],
    ['duck', 0.1, 2, 0.01, 'duck s'],
    ['size', 0.04, 0.3, 0.005, 'size (of screen)'],
    ['lean', -30, 30, 0.5, 'lean°'],
    ['swing', 0, 60, 1, 'wave swing°'],
  ]);
  // 演一遍：在星系里是「穿云」进下一颗星球，在星球上是跳到下一颗（hop）；回星系；重放探头（只在星系全景里）
  const teamIds = () => [...world.planets.keys()];
  trans.addButton({ title: 'Play: next planet' }).on('click', () => {
    const ids = teamIds();
    const now = world.focused?.team.id;
    const next = ids[(Math.max(-1, ids.indexOf(now ?? '')) + 1) % ids.length];
    if (next) location.hash = toHash({ view: 'planet', teamId: next });
  });
  trans.addButton({ title: 'Play: back to galaxy' }).on('click', () => {
    location.hash = toHash({ view: 'galaxy' });
  });
  trans.addButton({ title: 'Play: Triboo peek' }).on('click', () => {
    if (!world.director.peekIntro()) toast('Go to the galaxy view first (and turn off reduced motion)');
  });
}

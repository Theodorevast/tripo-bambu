import { WALK, WALK_ANIM } from './params';

// ?tune 的「Walk animation」组：翠宝走路动画的幅度和节奏（params.ts 的 WALK_ANIM），拖滑块下一帧就生效。
// tune.ts 只调 addWalkAnimTune、把 WALK_ANIM 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
}

type Key = keyof typeof WALK_ANIM & string;
type Slider = [Key, number, number, number, string];

function sliders(folder: Folder, list: Slider[]): void {
  for (const [key, min, max, step, label] of list) folder.addBinding(WALK_ANIM, key, { min, max, step, label });
}

export function addWalkAnimTune(pane: Folder): void {
  const f = pane.addFolder({ title: 'Walk animation', expanded: false });
  const steps = f.addFolder({ title: 'Steps', expanded: true });
  sliders(steps, [
    ['stepBase', 0.05, 0.5, 0.005, 'step at rest (m)'],
    ['stepPerSpeed', 0, 0.3, 0.005, 'step per m/s'],
    ['stepMax', 0.2, 1, 0.01, 'step max (m)'],
    ['dutySlow', 0.5, 0.8, 0.005, 'foot down, slow'],
    ['dutyFast', 0.4, 0.7, 0.005, 'foot down, fast'],
    ['minCadence', 1, 6, 0.05, 'min steps / s'],
    ['maxCadence', 3, 12, 0.1, 'max steps / s'],
    ['settleCadence', 1, 8, 0.05, 'settle steps / s'],
    ['settleError', 0.01, 0.12, 0.001, 'settle when off (m)'],
    ['turnStep', 0.2, 1.5, 0.01, 'turn per step (rad)'],
    ['lift', 0, 0.15, 0.001, 'foot lift (m)'],
    ['liftPerStep', 0, 0.4, 0.005, 'lift per step length'],
    ['footPitch', 0, 0.8, 0.01, 'heel-toe roll (rad)'],
  ]);
  const body = f.addFolder({ title: 'Body', expanded: false });
  sliders(body, [
    ['bob', 0, 0.1, 0.001, 'bounce (m)'],
    ['bobDelay', 0, 0.3, 0.005, 'lowest after landing'],
    ['squash', 0, 0.15, 0.001, 'squash & stretch'],
    ['shift', 0, 0.08, 0.001, 'weight shift (m)'],
    ['roll', 0, 0.2, 0.002, 'side tilt (rad)'],
    ['twist', 0, 0.4, 0.005, 'shoulder twist (rad)'],
    ['hipTwist', 0, 0.4, 0.005, 'hip twist (rad)'],
    ['leanSpeed', 0, 0.3, 0.002, 'lean at full speed'],
    ['leanAccel', 0, 0.03, 0.0005, 'lean per m/s²'],
    ['leanTurn', 0, 0.05, 0.0005, 'lean into turns'],
    ['tiltMax', 0, 0.4, 0.005, 'turn lean max (rad)'],
    ['sink', 0, 0.1, 0.001, 'sink on start / stop (m)'],
    ['leanSpring', 3, 30, 0.1, 'lean spring (1/s)'],
    ['leanDamping', 0.1, 1, 0.01, 'lean damping'],
  ]);
  const arms = f.addFolder({ title: 'Arms', expanded: false });
  sliders(arms, [
    ['armSwing', 0, 1.2, 0.01, 'arm swing (rad)'],
    ['armDelay', 0, 0.25, 0.005, 'arm lag (cycle)'],
    ['handDelay', 0, 0.25, 0.005, 'hand lag (cycle)'],
    ['handFollow', 0, 1.5, 0.01, 'hand follow'],
    ['armOut', 0, 0.4, 0.005, 'arms out at speed'],
    ['idleSway', 0, 0.2, 0.002, 'idle sway (rad)'],
    ['idleSeconds', 0.5, 6, 0.05, 'idle sway s'],
    ['breath', 0, 0.06, 0.001, 'breath'],
    ['breathSeconds', 1, 8, 0.05, 'breath s'],
  ]);
  const water = f.addFolder({ title: 'Wading & accessibility', expanded: false });
  water.addBinding(WALK, 'wadeSlow', { min: 0, max: 0.6, step: 0.01, label: 'slower in water' });
  sliders(water, [
    ['wadeStride', 0, 0.5, 0.01, 'longer steps in water'],
    ['wadeLift', 0, 3, 0.05, 'higher feet in water ×'],
    ['wadeArms', 0, 0.8, 0.01, 'arms up in water (rad)'],
    ['wadeLean', 0, 0.3, 0.005, 'lean in water (rad)'],
    ['reduced', 0, 1, 0.01, 'reduced motion ×'],
  ]);
}

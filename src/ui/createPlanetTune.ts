import { BURST } from './createPlanetBurst';

// ?tune → Create（P3）：「星球从云里冲出来」每一段的时长和手感。改了下一次 Launch（或 Replay）就用新值。
// Replay：让「你的星球」在首页上再冲出来一次（每个浏览器只能建一颗星球，调手感时不用重建；ui/createPlanet.ts 接上）
interface TuneEvents {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface TuneFolder extends TuneEvents {
  addFolder(params: { title: string; expanded?: boolean }): TuneFolder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): TuneEvents;
  addButton?(params: { title: string }): TuneEvents;
}

let replay: (() => void) | null = null;

// createPlanet.ts 装上：首页上重放一次（不在首页、正在转场时不放）
export function setBurstReplay(fn: (() => void) | null): void {
  replay = fn;
}

export function tuneCreate(pane: TuneFolder): void {
  const f = pane.addFolder({ title: 'Create', expanded: false });
  const beats = f.addFolder({ title: 'Burst beats (s)' });
  beats.addBinding(BURST, 'aim', { label: '1 aim at spot', min: 0.3, max: 3, step: 0.05 });
  beats.addBinding(BURST, 'charge', { label: '2 charge up', min: 0.1, max: 2, step: 0.05 });
  beats.addBinding(BURST, 'burst', { label: '3 burst out', min: 0.15, max: 1.5, step: 0.05 });
  beats.addBinding(BURST, 'settle', { label: '4 settle', min: 0.2, max: 2, step: 0.05 });
  beats.addBinding(BURST, 'hold', { label: '5 hold', min: 0, max: 3, step: 0.05 });
  beats.addBinding(BURST, 'after', { label: 'then', options: { 'back to galaxy': 0, 'enter planet': 1 } });
  const feel = f.addFolder({ title: 'Feel', expanded: false });
  feel.addBinding(BURST, 'distance', { label: 'camera distance ×R', min: 4, max: 16, step: 0.1 });
  feel.addBinding(BURST, 'elevation', { label: 'look down°', min: 5, max: 60, step: 1 });
  feel.addBinding(BURST, 'sink', { label: 'start depth ×R', min: 0.5, max: 4, step: 0.05 });
  feel.addBinding(BURST, 'overshoot', { label: 'overshoot ×R', min: 0, max: 2, step: 0.05 });
  feel.addBinding(BURST, 'stretch', { label: 'stretch', min: 0, max: 0.8, step: 0.01 });
  feel.addBinding(BURST, 'squash', { label: 'squash', min: 0, max: 0.5, step: 0.01 });
  feel.addBinding(BURST, 'spin', { label: 'spin (rad)', min: 0, max: 8, step: 0.1 });
  feel.addBinding(BURST, 'shake', { label: 'camera jolt', min: 0, max: 3, step: 0.05 });
  feel.addBinding(BURST, 'glow', { label: 'cloud glow', min: 0, max: 3, step: 0.05 });
  feel.addBinding(BURST, 'volume', { label: 'sound', min: 0, max: 2, step: 0.05 });
  f.addButton?.({ title: 'Replay burst' }).on('click', () => replay?.());
}

// 「Copy parameters」里带上这张表
export function createTuneParams(): Record<string, unknown> {
  return { burst: { ...BURST } };
}

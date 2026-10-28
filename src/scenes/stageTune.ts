import { GARDEN_LOOK } from '../nature/decorKit';
import { PlanetView, STAGE } from './planetView';

// ?tune 的「Works & gardens」组（stage 角色的参数）：星球视图里作品放大多少、什么高度开始放大、间距、花园开关、
// 落下的高度、慢动作、花草被风吹 / 被翠宝推开的幅度；最后一行是花园的实时统计。
// tune.ts 只调 addStageTune、把 STAGE_TUNE 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
}

export const STAGE_TUNE = { stage: STAGE, garden: GARDEN_LOOK };

export function addStageTune(pane: Folder): void {
  const f = pane.addFolder({ title: 'Works & gardens', expanded: false });
  const apply = () => PlanetView.active?.applyStage();
  f.addBinding(STAGE, 'overview', { label: 'overview scale ×', min: 1, max: 3.5, step: 0.05 });
  f.addBinding(STAGE, 'max', { label: 'max scale ×', min: 1, max: 4, step: 0.05 }).on('change', apply);
  f.addBinding(STAGE, 'near', { label: 'true size below ×R', min: 0, max: 1, step: 0.01 });
  f.addBinding(STAGE, 'far', { label: 'full scale above ×R', min: 0.3, max: 3, step: 0.01 });
  f.addBinding(STAGE, 'pathIntrude', { label: 'plinth into path (m)', min: -1, max: 1.5, step: 0.05 }).on('change', apply);
  f.addBinding(STAGE, 'gardens').on('change', apply);
  f.addBinding(STAGE, 'drop', { label: 'drop height (m)', min: 0, max: 2.5, step: 0.05 });
  f.addBinding(STAGE, 'slowmo', { label: 'slow motion ×', min: 0.05, max: 1, step: 0.05 });
  f.addBinding(GARDEN_LOOK, 'sway', { label: 'wind sway ×', min: 0, max: 3, step: 0.05 });
  f.addBinding(GARDEN_LOOK, 'push', { label: 'push by Triboo ×', min: 0, max: 3, step: 0.05 });
  const stats = { garden: '-' };
  setInterval(() => {
    const s = PlanetView.active?.gardenStats();
    stats.garden = s ? `${s.items} items · ${s.drawCalls} draws · ${Math.round(s.triangles / 1000)}k tris` : '-';
  }, 500);
  f.addBinding(stats, 'garden', { label: 'gardens', readonly: true });
}

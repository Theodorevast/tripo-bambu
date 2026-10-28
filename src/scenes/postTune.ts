import { FEEL } from '../play/followCamera';
import { applyGrade, GRADE } from '../style/grade';
import { CONTACT, DEBUG_VIEWS, POST, RAYS, WASH } from './post';
import type { World } from './world';

// ?tune 的「Look」组（look 角色的参数）：后处理开关、调色、接触阴影、日落光束、漫游镜头的手感。
// tune.ts 只调 addLookTune、把 LOOK_TUNE 放进「Copy parameters」的 JSON

// 用到的那部分 Tweakpane 接口（和 tune.ts 里的一样，自己写，类型检查不依赖 @tweakpane/core）
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
}

export const LOOK_TUNE = { grade: GRADE, wash: WASH, contact: CONTACT, rays: RAYS, followFeel: FEEL };

export function addLookTune(pane: Folder, world: World): void {
  const look = pane.addFolder({ title: 'Look', expanded: false });
  const state = { post: world.post.enabled };
  look.addBinding(state, 'post', { label: 'post (?look=0)' }).on('change', () => { world.post.enabled = state.post; });
  look.addBinding(POST, 'debug', { label: 'debug view', options: Object.fromEntries(DEBUG_VIEWS.map((k) => [k, k])) }).on('change', () => world.post.apply());

  const grade = look.addFolder({ title: 'Color grade', expanded: false });
  grade.addBinding(GRADE, 'warmth', { min: -1, max: 1, step: 0.01 });
  grade.addBinding(GRADE, 'tint', { min: -1, max: 1, step: 0.01 });
  grade.addBinding(GRADE, 'saturation', { min: 0, max: 2, step: 0.01 });
  grade.addBinding(GRADE, 'vibrance', { min: -1, max: 1.5, step: 0.01 });
  grade.addBinding(GRADE, 'contrast', { label: 'soft contrast', min: 0, max: 1, step: 0.01 });
  grade.addBinding(GRADE, 'mids', { label: 'brighten mids', min: -0.3, max: 0.3, step: 0.005 });
  grade.addBinding(GRADE, 'lift', { label: 'black lift', min: 0, max: 0.1, step: 0.001 });
  grade.addBinding(GRADE, 'shadowTint', { label: 'shadow tint' });
  grade.addBinding(GRADE, 'shadows', { label: 'shadow tint ×', min: 0, max: 0.5, step: 0.005 });
  grade.addBinding(GRADE, 'highlightTint', { label: 'highlight tint' });
  grade.addBinding(GRADE, 'highlights', { label: 'highlight tint ×', min: 0, max: 0.5, step: 0.005 });
  grade.addBinding(GRADE, 'vignette', { min: 0, max: 1, step: 0.01 });
  grade.addBinding(GRADE, 'vignetteTint', { label: 'vignette tint' });
  grade.addBinding(GRADE, 'paper', { label: 'paper grain', min: 0, max: 0.15, step: 0.005 });
  grade.addBinding(GRADE, 'dither', { min: 0, max: 2, step: 0.1 });
  grade.on('change', () => applyGrade());

  const wash = look.addFolder({ title: 'Sun warm / shade cool', expanded: false });
  wash.addBinding(WASH, 'strength', { min: 0, max: 1.5, step: 0.01 });
  wash.addBinding(WASH, 'warm', { label: 'lit tint' });
  wash.addBinding(WASH, 'lit', { label: 'lit brightness', min: 0.5, max: 2, step: 0.01 });
  wash.addBinding(WASH, 'cool', { label: 'shade hue' });
  wash.addBinding(WASH, 'shade', { label: 'shade brightness', min: 0.3, max: 1.2, step: 0.01 });
  wash.addBinding(WASH, 'from', { label: 'warm from (cos)', min: -1, max: 1, step: 0.01 });
  wash.addBinding(WASH, 'to', { label: 'warm to (cos)', min: -1, max: 1, step: 0.01 });
  wash.addBinding(WASH, 'near', { label: 'fade below ×R', min: 0, max: 2, step: 0.01 });
  wash.addBinding(WASH, 'far', { label: 'full above ×R', min: 0, max: 3, step: 0.01 });
  wash.on('change', () => world.post.apply());

  const contact = look.addFolder({ title: 'Contact shadows', expanded: false });
  contact.addBinding(CONTACT, 'strength', { min: 0, max: 1, step: 0.01 });
  contact.addBinding(CONTACT, 'spread', { label: 'radius × footprint', min: 0.5, max: 3, step: 0.01 });
  contact.addBinding(CONTACT, 'height', { label: 'height × radius', min: 0.05, max: 1.5, step: 0.01 });
  contact.addBinding(CONTACT, 'walker', { label: 'walker radius (m)', min: 0.1, max: 1.5, step: 0.01 });
  contact.addBinding(CONTACT, 'walkerHeight', { label: 'walker height (m)', min: 0.05, max: 1.5, step: 0.01 });
  contact.addBinding(CONTACT, 'color');
  contact.on('change', () => world.post.apply());

  const rays = look.addFolder({ title: 'Sunset rays', expanded: false });
  rays.addBinding(RAYS, 'sunset', { min: 0, max: 2, step: 0.01 });
  rays.addBinding(RAYS, 'day', { min: 0, max: 2, step: 0.01 });
  rays.addBinding(RAYS, 'reach', { label: 'reach × height', min: 0.1, max: 3, step: 0.01 });
  rays.addBinding(RAYS, 'beams', { label: 'beam density', min: 1, max: 20, step: 0.1 });
  rays.addBinding(RAYS, 'contrast', { label: 'beam contrast', min: 0, max: 1, step: 0.01 });
  rays.addBinding(RAYS, 'open', { label: 'open sky ≥', min: 0, max: 2, step: 0.01 });
  rays.addBinding(RAYS, 'decay', { label: 'occlusion decay', min: 0.8, max: 1, step: 0.001 });
  rays.addBinding(RAYS, 'air', { label: 'air depth (m)', min: 1, max: 200, step: 1 });
  rays.addBinding(RAYS, 'airFloor', { label: 'air floor', min: 0, max: 1, step: 0.01 });
  rays.addBinding(RAYS, 'tint');
  rays.on('change', () => world.post.apply());

  const feel = look.addFolder({ title: 'Walk camera feel', expanded: false });
  for (const key of Object.keys(FEEL) as (keyof typeof FEEL)[]) feel.addBinding(FEEL, key);
}

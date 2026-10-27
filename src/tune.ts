import { Pane } from 'tweakpane';
import { applyLights, LIGHTS } from './scenes/lights';
import { applyLook, LOOK, TONE_MAPPINGS } from './scenes/look';
import { SHOTS } from './scenes/shots';
import type { World } from './scenes/world';
import { toast } from './ui/toast';

// 实时调参面板：地址带 ?tune 时由 main.ts 动态加载（Tweakpane 打成单独的包，平时不下载）。
// 改的是三张表：镜头表（scenes/shots.ts）、色调映射和曝光（scenes/look.ts）、灯光表（scenes/lights.ts），改动立刻生效，不用刷新。
// 「Copy parameters」把三张表的 JSON 复制到剪贴板：用户调好发给我们，写回代码里的默认值

// 用到的那部分 Tweakpane 接口。Tweakpane 4 的类型声明引用 @tweakpane/core（没装），这里自己写，类型检查不依赖它
interface Events {
  on(event: 'change' | 'click', handler: () => void): unknown;
}
interface Folder extends Events {
  addFolder(params: { title: string; expanded?: boolean }): Folder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): Events;
  addButton(params: { title: string }): Events;
}

// 复制出去的 JSON：数字保留 3 位小数，滑块拖出来的浮点尾巴不带上
export function tuneJson(): string {
  return JSON.stringify({ shots: SHOTS, look: LOOK, lights: LIGHTS }, (_key, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 2);
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

  const galaxy = pane.addFolder({ title: 'Galaxy camera' });
  galaxy.addBinding(SHOTS.galaxy, 'distance', { min: 80, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'elevation', { label: 'elevation°', min: 0, max: 89, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'lift', { min: -150, max: 100, step: 0.5 });
  galaxy.addBinding(SHOTS.galaxy, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'minDistance', { label: 'min distance', min: 10, max: 900, step: 1 });
  galaxy.addBinding(SHOTS.galaxy, 'maxDistance', { label: 'max distance', min: 50, max: 2000, step: 1 });
  galaxy.on('change', () => world.applyShots());

  const planet = pane.addFolder({ title: 'Planet camera' });
  planet.addBinding(SHOTS.planet, 'distance', { min: 11, max: 80, step: 0.1 });
  planet.addBinding(SHOTS.planet, 'lift', { min: -20, max: 30, step: 0.1 });
  planet.addBinding(SHOTS.planet, 'fov', { label: 'fov°', min: 10, max: 100, step: 1 });
  planet.addBinding(SHOTS.planet, 'minDistance', { label: 'min distance', min: 11, max: 80, step: 0.5 });
  planet.addBinding(SHOTS.planet, 'maxDistance', { label: 'max distance', min: 15, max: 300, step: 1 });
  planet.on('change', () => world.applyShots());

  const look = pane.addFolder({ title: 'Tone mapping' });
  look.addBinding(LOOK, 'toneMapping', { label: 'mode', options: Object.fromEntries(Object.keys(TONE_MAPPINGS).map((k) => [k, k])) });
  look.addBinding(LOOK, 'exposure', { min: 0, max: 3, step: 0.01 });
  look.on('change', () => applyLook());

  const lights = pane.addFolder({ title: 'Lights' });
  lights.addBinding(LIGHTS.sky, 'intensity', { label: 'sky', min: 0, max: 5, step: 0.05 });
  for (const [name, shot] of [['key', LIGHTS.key], ['rim', LIGHTS.rim]] as const) {
    lights.addBinding(shot, 'intensity', { label: name, min: 0, max: 10, step: 0.05 });
    lights.addBinding(shot, 'azimuth', { label: `${name} azimuth°`, min: -180, max: 180, step: 0.1 });
    lights.addBinding(shot, 'elevation', { label: `${name} elevation°`, min: -90, max: 90, step: 0.1 });
  }
  lights.on('change', () => applyLights());

  // 只读：实际帧间隔（主循环的 dt，最多记 100 ms）和主画面的像素比（像素预算）
  const stats = { frame: 0, pixelRatio: world.renderer.getPixelRatio(), canvas: '' };
  world.frameHooks.add((dt) => {
    stats.frame = dt * 1000;
    stats.pixelRatio = world.renderer.getPixelRatio();
    stats.canvas = `${world.renderer.domElement.width} × ${world.renderer.domElement.height}`;
  });
  const perf = pane.addFolder({ title: 'Performance', expanded: false });
  perf.addBinding(stats, 'frame', { label: 'frame ms', readonly: true, view: 'graph', min: 0, max: 50 });
  perf.addBinding(stats, 'pixelRatio', { label: 'pixel ratio', readonly: true, format: (v: number) => v.toFixed(2) });
  perf.addBinding(stats, 'canvas', { label: 'canvas px', readonly: true });

  pane.addButton({ title: 'Copy parameters' }).on('click', () => void copy(tuneJson()));
}

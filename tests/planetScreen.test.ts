import * as THREE from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModel } from '../src/assets/models';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { PlanetScreen } from '../src/ui/planetScreen';
import type { World } from '../src/scenes/world';
import { FakeElement, installFakeDom } from './fakeDom';

const makeTeam = (id: string): Team => ({
  id, name: id.toUpperCase(), motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'm', handle: 'm', displayName: 'M', role: 'captain' }],
  works: [
    { id: `${id}-1`, title: 'One', authorId: 'm', file: '', thumb: '', tris: 10 },
    { id: `${id}-2`, title: 'Two', authorId: 'm', file: '', thumb: '', tris: 10 },
  ],
  planet: {
    seed: 3, preset: 'desert', ring: false, atmosphere: false,
    placements: [
      { workId: `${id}-1`, dir: [0, 1, 0], yaw: 0, scale: 1 },
      { workId: `${id}-2`, dir: [1, 0, 0], yaw: 0, scale: 1 },
    ],
  },
});
const teamA = makeTeam('a');
const teamB = makeTeam('b');

// 1440×900 的画布，顶栏底边在 80px；标签高 24px（FakeElement 默认）
function setup() {
  const canvas = new FakeElement('canvas');
  canvas.rect = { left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900 };
  const root = new FakeElement('div');
  const topbar = new FakeElement('header');
  topbar.className = 'topbar';
  topbar.rect = { left: 0, top: 0, right: 1440, bottom: 80, width: 1440, height: 80 };
  root.append(topbar);
  const frameHooks = new Set<(dt: number) => void>();
  const planets = new Map([teamA, teamB].map((t) => [t.id, { team: t, planet: new PlanetObject(t.planet), hit: new THREE.Mesh(), home: new THREE.Vector3() }]));
  const toScreen = vi.fn((): { x: number; y: number } | null => ({ x: 700, y: 400 }));
  const world = {
    renderer: { domElement: canvas },
    rig: { flying: false, camera: { position: new THREE.Vector3(0, 0, 30) } },
    frameHooks,
    planets,
    toScreen,
    // 新模型立刻放行（真实页面里 Stager 要等贴图上传、着色器编译，再排到某一帧才挂上）
    stage: { precompile: async () => {}, prepare: async () => ({ start() {}, cancel() {} }) },
  } as unknown as World;
  const screen = new PlanetScreen(world, root as unknown as HTMLElement, () => {});
  const label = root.querySelector('.float-label')!;
  const frame = () => { for (const hook of frameHooks) hook(1 / 60); };
  return { screen, canvas, root, label, toScreen, frame };
}

// 模型加载由测试手动放行
function slowModels(screen: PlanetScreen) {
  const waiting: Array<{ id: string; resolve: (m: LoadedModel) => void }> = [];
  vi.spyOn(screen.view.library, 'load').mockImplementation((work) => new Promise((resolve) => waiting.push({ id: work.id, resolve })));
  const release = (prefix: string) => {
    for (const w of waiting.filter((x) => x.id.startsWith(prefix))) {
      waiting.splice(waiting.indexOf(w), 1);
      w.resolve({ object: new THREE.Group(), height: 2, footprint: 0.6, failed: false });
    }
  };
  return { waiting, release };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const highlight = (screen: PlanetScreen, id: string) => (screen.view.placed.get(id)!.plinth.material as THREE.MeshStandardNodeMaterial).emissiveIntensity;

// 进入团队 a，指针停在作品 a-1 上
async function hovering() {
  const s = setup();
  s.screen.enter(teamA);
  await settle();
  const pw = s.screen.view.placed.get('a-1')!;
  vi.spyOn(s.screen.view, 'pick').mockReturnValue(pw);
  vi.spyOn(s.screen.view, 'occluded').mockReturnValue(false);
  s.canvas.dispatch('pointermove', { clientX: 700, clientY: 400, button: -1 });
  s.frame();
  return s;
}

beforeEach(() => installFakeDom());
afterEach(() => vi.unstubAllGlobals());

describe('PlanetScreen：进入星球不等模型，给脚本一个「模型都挂好了」的信号', () => {
  it('enter 不等模型就返回，展台已经摆好；模型都挂好后 #app 上 data-planet-ready = 团队 id，离开时去掉', async () => {
    const { screen, root } = setup();
    const models = slowModels(screen);
    let returned = false;
    void Promise.resolve(screen.enter(teamA)).then(() => { returned = true; });
    await settle();
    expect(returned).toBe(true);
    expect(screen.view.placed.size).toBe(2);
    expect(root.dataset.planetReady).toBeUndefined();
    models.release('a');
    await settle();
    expect(root.dataset.planetReady).toBe('a');
    screen.leave();
    expect(root.dataset.planetReady).toBeUndefined();
  });

  it('没有作品的星球：进入后马上就绪', async () => {
    const { screen, root } = setup();
    screen.enter({ ...teamA, status: 'under-construction', works: [], planet: { ...teamA.planet, placements: [] } });
    await settle();
    expect(root.dataset.planetReady).toBe('a');
  });

  it('模型没加载完就离开、换团队、又回来：迟到的结果不设就绪信号，只认当前这次进入', async () => {
    const { screen, root } = setup();
    const models = slowModels(screen);
    screen.enter(teamA);
    screen.leave();
    screen.enter(teamB);
    models.release('a');
    await settle();
    expect(root.dataset.planetReady).toBeUndefined();
    models.release('b');
    await settle();
    expect(root.dataset.planetReady).toBe('b');
    screen.leave();
    screen.enter(teamA); // a 的第一次加载已经放行过；这是第二次进入，新的加载还没放行
    await settle();
    expect(root.dataset.planetReady).toBeUndefined();
    models.release('a');
    await settle();
    expect(root.dataset.planetReady).toBe('a');
  });
});

describe('PlanetScreen：悬停和标签', () => {
  it('悬停作品：高亮、标签、手形光标', async () => {
    const { screen, canvas, label } = await hovering();
    expect(canvas.style.cursor).toBe('pointer');
    expect(label.hidden).toBe(false);
    expect(highlight(screen, 'a-1')).toBe(0.6);
  });

  it('指针离开画布（移到顶栏、移出窗口）：高亮、标签、手形光标都清掉', async () => {
    const { screen, canvas, label } = await hovering();
    canvas.dispatch('pointerleave');
    expect(canvas.style.cursor).toBe('');
    expect(label.hidden).toBe(true);
    expect(highlight(screen, 'a-1')).toBe(0);
  });

  it('悬停的作品转到星球背后：整个悬停一起清掉（不只是藏标签）', async () => {
    const { screen, canvas, label, frame } = await hovering();
    vi.mocked(screen.view.occluded).mockReturnValue(true);
    frame();
    expect(label.hidden).toBe(true);
    expect(canvas.style.cursor).toBe('');
    expect(highlight(screen, 'a-1')).toBe(0);
  });

  it('作品移出画面（锚点在视口外）：藏起标签，悬停本身还在', async () => {
    const { canvas, label, toScreen, frame } = await hovering();
    for (const at of [{ x: 700, y: -40 }, { x: -10, y: 400 }, { x: 1500, y: 400 }, { x: 700, y: 950 }]) {
      toScreen.mockReturnValue(at);
      frame();
      expect(label.hidden).toBe(true);
    }
    expect(canvas.style.cursor).toBe('pointer');
    toScreen.mockReturnValue(null); // 在镜头背后
    frame();
    expect(label.hidden).toBe(true);
  });

  it('作品还在画面里：标签照旧夹在顶栏下面，不在顶栏底下时贴着作品', async () => {
    const { label, toScreen, frame } = await hovering();
    toScreen.mockReturnValue({ x: 700, y: -40 });
    frame();
    toScreen.mockReturnValue({ x: 700, y: 30 });
    frame();
    expect(label.hidden).toBe(false);
    expect(label.style.transform).toBe('translate(700px, 112px) translate(-50%, -100%)'); // 80 + 8 + 24
    toScreen.mockReturnValue({ x: 700, y: 400 });
    frame();
    expect(label.style.transform).toBe('translate(700px, 400px) translate(-50%, -100%)');
  });
});

describe('PlanetScreen：点击作品', () => {
  const click = (canvas: FakeElement, init: Record<string, unknown>) => {
    canvas.dispatch('pointerdown', { clientX: 700, clientY: 400, ...init });
    canvas.dispatch('pointerup', { clientX: 700, clientY: 400, ...init });
  };

  it('只认主按钮：右键、中键点作品不弹作品卡；左键、触摸、笔照常', async () => {
    const { screen, canvas } = await hovering();
    const show = vi.spyOn(screen.card, 'show');
    click(canvas, { button: 2, pointerType: 'mouse' });
    click(canvas, { button: 1, pointerType: 'mouse' });
    expect(show).not.toHaveBeenCalled();
    click(canvas, { button: 0, pointerType: 'mouse' });
    click(canvas, { button: 0, pointerType: 'touch' });
    click(canvas, { button: 0, pointerType: 'pen' });
    expect(show).toHaveBeenCalledTimes(3);
    expect(show.mock.calls[0][0].id).toBe('a-1');
  });

  it('左键按下、右键松开（或反过来）不算点击', async () => {
    const { screen, canvas } = await hovering();
    const show = vi.spyOn(screen.card, 'show');
    canvas.dispatch('pointerdown', { clientX: 700, clientY: 400, button: 0 });
    canvas.dispatch('pointerup', { clientX: 700, clientY: 400, button: 2 });
    canvas.dispatch('pointerdown', { clientX: 700, clientY: 400, button: 2 });
    canvas.dispatch('pointerup', { clientX: 700, clientY: 400, button: 0 });
    expect(show).not.toHaveBeenCalled();
  });
});

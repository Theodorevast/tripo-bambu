import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '../src/data/types';
import type { PlanetStore } from '../src/data/store';
import type { World } from '../src/scenes/world';
import { FakeElement, FakeLocation, installFakeDom } from './fakeDom';

vi.mock('../src/ui/toast', () => ({ toast: vi.fn() }));
const { toast } = await import('../src/ui/toast');
const { App } = await import('../src/app');

const team = (id: string): Team => ({
  id, name: id.toUpperCase(), motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'm', handle: 'm', displayName: 'M', role: 'captain' }],
  works: [],
  planet: { seed: 1, preset: 'desert', ring: false, atmosphere: false, placements: [] },
});
const teams = ['a', 'b', 'c'].map(team);

// 假的 3D 世界：镜头飞行（focus / unfocus）记下来，测试调 land() 才落地
function fakeWorld() {
  const flights: string[] = [];
  let landing: Array<() => void> = [];
  const fly = (name: string) => {
    flights.push(name);
    return new Promise<void>((resolve) => landing.push(resolve));
  };
  const world = {
    renderer: { domElement: new FakeElement('canvas') },
    rig: { flying: false },
    frameHooks: new Set(),
    planets: new Map(),
    setTeams: () => {},
    setHover: () => {},
    pickPlanet: () => null,
    intro: () => Promise.resolve(),
    focus: (id: string) => fly(`focus ${id}`),
    unfocus: () => fly('unfocus'),
  } as unknown as World;
  const land = () => {
    const now = landing;
    landing = [];
    for (const resolve of now) resolve();
  };
  return { world, flights, land };
}

// 等排队的回调、hashchange（setTimeout 派发）都跑完
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(hash: string) {
  const location = new FakeLocation(hash);
  location.install();
  const { world, flights, land } = fakeWorld();
  const app = new App(world, new FakeElement('div') as unknown as HTMLElement, {} as PlanetStore, { teamId: 'a', memberId: 'm' }, teams);
  const entered: string[] = [];
  app.planetLayer = { enter: (t) => { entered.push(t.id); }, leave: () => {} };
  const members = { open: vi.fn(), close: vi.fn() };
  const museum = { open: vi.fn(), close: vi.fn() };
  app.members = members;
  app.museum = museum;
  return { app, location, flights, land, entered, members, museum };
}

beforeEach(() => {
  installFakeDom();
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App 路由队列', () => {
  it('一次切换（飞行）进行中连来几个跳转：当前这次结束后只执行最新的那个，中间的跳过', async () => {
    const { app, location, flights, land, entered } = setup('#/');
    await app.start();
    location.hash = '#/t/a';
    await settle();
    expect(flights).toEqual(['focus a']);
    location.hash = '#/t/b';
    await settle();
    location.hash = '#/t/c';
    await settle();
    expect(flights).toEqual(['focus a']); // a 还在飞，b、c 排着
    land();
    await settle();
    expect(flights).toEqual(['focus a', 'focus c']); // b 被跳过
    land();
    await settle();
    expect(entered).toEqual(['a', 'c']);
  });

  it('空闲时的跳转立即执行；一次接一次（每次都等上一次落地）时每次都执行', async () => {
    const { app, location, flights, land } = setup('#/');
    await app.start();
    for (const id of ['a', 'b']) {
      location.hash = `#/t/${id}`;
      await settle();
      land();
      await settle();
    }
    location.hash = '#/';
    await settle();
    land();
    await settle();
    expect(flights).toEqual(['focus a', 'focus b', 'unfocus']);
  });

  it('进入星球不等 planetLayer.enter（模型在后台加载）：飞行落地路由就处理完，Back 立即开始', async () => {
    const { app, location, flights, land } = setup('#/');
    await app.start();
    app.planetLayer = { enter: () => new Promise<void>(() => {}), leave: () => {} }; // 模型永远加载不完
    location.hash = '#/t/a';
    await settle();
    land();
    await settle();
    location.hash = '#/';
    await settle();
    expect(flights).toEqual(['focus a', 'unfocus']);
  });

  it('未知团队：提示，并用 replace 回到星系（不加历史记录）', async () => {
    const { app, location } = setup('#/t/nope');
    await app.start();
    await settle();
    expect(toast).toHaveBeenCalledWith('That team does not exist');
    expect(location.hash).toBe('#/');
    expect(location.replaced).toEqual(['#/']);
    expect(location.pushed).toEqual([]);
  });

  it('轮到未知团队执行时地址栏已经换了（新跳转的 hashchange 还没到）：照样提示，但不把新地址改回星系', async () => {
    const { app, location, land, members } = setup('#/t/a');
    const started = app.start(); // 正飞向 a
    location.hash = '#/t/nope';
    await settle(); // nope 排上了
    location.setSilently('#/t/a/members'); // 用户又点了 Members：地址已经变了，hashchange 还在路上
    land();
    await started;
    await settle();
    expect(toast).toHaveBeenCalledWith('That team does not exist');
    expect(location.replaced).toEqual([]);
    expect(location.hash).toBe('#/t/a/members');
    location.fire(); // Members 的 hashchange 到了
    await settle();
    expect(members.open).toHaveBeenCalledWith(teams[0], { view: 'members', teamId: 'a' });
    expect(location.hash).toBe('#/t/a/members');
  });

  it('navigate 的 replace 选项：换掉当前这条历史记录，不加新的', async () => {
    const { app, location, land } = setup('#/t/a');
    const started = app.start();
    await settle();
    land();
    await started;
    app.navigate({ view: 'planet', teamId: 'b' });
    expect(location.pushed).toEqual(['#/t/b']);
    app.navigate({ view: 'galaxy' }, { replace: true });
    expect(location.replaced).toEqual(['#/']);
    expect(location.pushed).toEqual(['#/t/b']);
  });

  it('某次切换出错：提示一下，之后的跳转照常执行', async () => {
    const { app, location, land, entered } = setup('#/');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.start();
    app.planetLayer = { enter: (t) => { if (t.id === 'a') throw new Error('boom'); entered.push(t.id); }, leave: () => {} };
    location.hash = '#/t/a';
    await settle();
    land();
    await settle();
    expect(toast).toHaveBeenCalledWith('Something went wrong. Please try again.');
    expect(error).toHaveBeenCalled();
    location.hash = '#/t/b';
    await settle();
    land();
    await settle();
    expect(entered).toEqual(['b']);
    error.mockRestore();
  });

  it('routing：有跳转在处理时为 true，处理完为 false', async () => {
    const { app, location, land } = setup('#/');
    await app.start();
    expect(app.routing).toBe(false);
    location.hash = '#/t/a';
    await settle();
    expect(app.routing).toBe(true);
    land();
    await settle();
    expect(app.routing).toBe(false);
  });
});

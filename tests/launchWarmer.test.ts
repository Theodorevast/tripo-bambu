import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStore, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed, Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import type { World } from '../src/scenes/world';
import { LaunchWarmer, teamFitsTwin, twinKey, type TwinLook } from '../src/ui/createPlanetLaunch';

// 造星 Launch 直接接手第三步预热好的替身（v2-ui）：配方完全一致才用、状态还原、从 LaunchWarmer 摘掉；没被接手的照旧 release() 时放掉

const look: TwinLook = { preset: 'verdant', seed: 42, ring: true, color: '#5f8f8c' };
const recipe = (extra: Partial<PlanetRecipe> = {}): PlanetRecipe => ({ seed: 42, preset: 'verdant', ring: true, atmosphere: true, placements: [], ...extra });
const team = (extra: Partial<Team> = {}, planet: Partial<PlanetRecipe> = {}): Team => ({
  id: 'quiet-comets', name: 'Quiet Comets', motto: '', color: look.color, status: 'active', foundedDaysAgo: 0,
  members: [], works: [], planet: recipe(planet), createdByYou: true, ...extra,
});

function fakeWorld(pending = false) {
  let finish: () => void = () => {};
  const precompile = vi.fn((_g: THREE.Object3D) => (pending ? new Promise<void>((r) => { finish = r; }) : Promise.resolve()));
  const world = { stage: { precompile }, light: { sunDir: new THREE.Vector3(0.3, 1, 0.2).normalize() }, planets: new Map() } as unknown as World;
  return { world, precompile, finish: () => finish() };
}

afterEach(() => vi.useRealTimers());

describe('teamFitsTwin：会影响着色器的输入都一样才算同一颗', () => {
  const key = twinKey(look);
  it('预设、种子、环、团队色、建好的、有大气、没有摆放：用替身', () => {
    expect(teamFitsTwin(team(), key)).toBe(true);
  });
  it('有一项对不上就不用', () => {
    expect(teamFitsTwin(team({}, { preset: 'desert' }), key)).toBe(false);
    expect(teamFitsTwin(team({}, { seed: 43 }), key)).toBe(false);
    expect(teamFitsTwin(team({}, { ring: false }), key)).toBe(false);
    expect(teamFitsTwin(team({ color: '#d6b35e' }), key)).toBe(false);
    expect(teamFitsTwin(team({ status: 'under-construction' }), key)).toBe(false);
    expect(teamFitsTwin(team({}, { atmosphere: false }), key)).toBe(false);
    expect(teamFitsTwin(team({}, { placements: [{ workId: 'w', dir: [0, 1, 0], yaw: 0, scale: 1 }] }), key)).toBe(false);
  });
});

describe('LaunchWarmer.take', () => {
  it('配方一致、已经编好：交出编过的那一颗，状态还原，从 warmer 摘掉（再要就没有了）', async () => {
    const { world, precompile } = fakeWorld();
    const w = new LaunchWarmer(world);
    await w.warm(look);
    expect(w.ready).toBe(true);
    const compiled = precompile.mock.calls[0][0];
    // 预热时被摆在别处、藏起来过：交出去时一点都不能带过来
    const parent = new THREE.Group();
    parent.add(compiled);
    compiled.position.set(5, 6, 7);
    compiled.scale.setScalar(0.3);
    compiled.rotation.set(0.4, 0.5, 0.6);
    compiled.visible = false;
    compiled.layers.set(3);
    const planet = w.take(team());
    expect(planet).toBeInstanceOf(PlanetObject);
    expect(planet!.group).toBe(compiled);
    expect(planet!.group.parent).toBeNull();
    expect(planet!.group.position.toArray()).toEqual([0, 0, 0]);
    expect(planet!.group.scale.toArray()).toEqual([1, 1, 1]);
    expect(planet!.group.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(planet!.group.visible).toBe(true);
    expect(planet!.group.layers.mask).toBe(new THREE.Layers().mask);
    expect(w.ready).toBe(false);
    expect(w.take(team())).toBeNull();
  });

  it('配方对不上：不交，替身留着', async () => {
    const { world } = fakeWorld();
    const w = new LaunchWarmer(world);
    await w.warm(look);
    expect(w.take(team({ color: '#b9868f' }))).toBeNull();
    expect(w.ready).toBe(true);
    expect(w.take(team())).toBeInstanceOf(PlanetObject);
  });

  it('还没编好：不交（照旧新建）', async () => {
    const { world, finish } = fakeWorld(true);
    const w = new LaunchWarmer(world);
    const ready = w.warm(look);
    expect(w.take(team())).toBeNull();
    finish();
    await ready;
    expect(w.take(team())).toBeInstanceOf(PlanetObject);
  });

  it('release：被接手的那颗不放（归 World 管）；没被接手的放掉，而且只放一次', async () => {
    vi.useFakeTimers();
    const { world } = fakeWorld();
    const w = new LaunchWarmer(world);
    await w.warm(look);
    const taken = w.take(team())!;
    const takenDispose = vi.spyOn(taken.look, 'dispose');
    await w.warm({ ...look, seed: 7 }); // 又备了一颗（比如 Launch 以后又开了一次窗口）
    const spare = w.take(team({}, { seed: 8 })); // 对不上，不交
    expect(spare).toBeNull();
    const disposes = vi.spyOn(Object.getPrototypeOf(taken.look) as { dispose(): void }, 'dispose'); // 所有替身的远看部件
    w.release();
    w.release(); // 再放一次：什么都不剩
    await vi.advanceTimersByTimeAsync(1000);
    expect(takenDispose).not.toHaveBeenCalled();
    expect(disposes).toHaveBeenCalledTimes(1);
    disposes.mockRestore();
  });
});

describe('Reset demo 以后：建出来的团队删干净了（重新载入后不在了）', () => {
  function memStorage(): StorageLike {
    const data = new Map<string, string>();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
  }
  const seed: Seed = {
    you: { teamId: 'a', memberId: 'you' },
    teams: [{ id: 'a', name: 'A', motto: '', color: '#ffffff', status: 'active', foundedDaysAgo: 3, members: [], works: [], planet: recipe({ seed: 1 }) }],
  };
  it('createTeam → reset → 新开一个 store（等于刷新页面）：只剩种子里的团队', async () => {
    const storage = memStorage();
    const store = new LocalStore(seed, storage);
    await store.createTeam(team());
    expect((await store.listTeams()).map((t) => t.id)).toEqual(['a', 'quiet-comets']);
    await store.reset();
    const reloaded = new LocalStore(seed, storage);
    expect((await reloaded.listTeams()).map((t) => t.id)).toEqual(['a']);
    expect(await reloaded.createdTeam()).toBeUndefined();
  });
});

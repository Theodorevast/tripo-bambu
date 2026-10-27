import { describe, expect, it } from 'vitest';
import { LocalStore, STORAGE_KEY, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed } from '../src/data/types';

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const planetA: PlanetRecipe = { seed: 1, preset: 'verdant', ring: false, atmosphere: true, placements: [] };
const seed: Seed = {
  you: { teamId: 'a', memberId: 'you' },
  teams: [
    { id: 'a', name: 'A', motto: '', color: '#ffffff', status: 'active', foundedDaysAgo: 3, members: [], works: [], planet: planetA },
    { id: 'b', name: 'B', motto: '', color: '#000000', status: 'under-construction', foundedDaysAgo: 1, members: [], works: [], planet: { seed: 2, preset: 'desert', ring: true, atmosphere: false, placements: [] } },
  ],
};

describe('LocalStore', () => {
  it('没有修改时返回 seed 里的数据', async () => {
    const s = new LocalStore(seed, memStorage());
    expect((await s.listTeams()).map((t) => t.id)).toEqual(['a', 'b']);
    expect((await s.getTeam('b'))?.planet.preset).toBe('desert');
    expect(await s.getTeam('zzz')).toBeUndefined();
  });
  it('保存的星球配方写进存储，新实例也读得到', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).savePlanet('a', { ...planetA, preset: 'coral' });
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('coral');
  });
  it('返回的是副本，改它不影响存储', async () => {
    const s = new LocalStore(seed, memStorage());
    const t = await s.getTeam('a');
    t!.planet.preset = 'glacier';
    expect((await s.getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('reset 清掉所有修改', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('a', { ...planetA, ring: true });
    await s.reset();
    expect((await s.getTeam('a'))?.planet.ring).toBe(false);
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });
  it('存储里是坏数据时忽略它', async () => {
    const storage = memStorage();
    storage.data.set(STORAGE_KEY, '{not json');
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('存储抛错时退回内存，照常工作', async () => {
    const fail = () => { throw new Error('denied'); };
    const s = new LocalStore(seed, { getItem: fail, setItem: fail, removeItem: fail });
    await s.savePlanet('a', { ...planetA, preset: 'volcanic' });
    expect((await s.getTeam('a'))?.planet.preset).toBe('volcanic');
    await s.reset();
    expect((await s.getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('没有存储（null）时只存在内存里', async () => {
    const s = new LocalStore(seed, null);
    await s.savePlanet('b', { ...seed.teams[1].planet, ring: false });
    expect((await s.getTeam('b'))?.planet.ring).toBe(false);
  });
});

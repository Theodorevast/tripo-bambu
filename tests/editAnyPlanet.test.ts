import { describe, expect, it } from 'vitest';
import { LocalStore, STORAGE_KEY, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed, Team } from '../src/data/types';

// 演示里每颗星球都能编辑（H2）：别人的星球、建设中的星球改了也各自存进本地存档；Reset demo 一次全清掉
const memStorage = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const recipe = (seed: number): PlanetRecipe => ({ seed, preset: 'verdant', ring: false, atmosphere: true, placements: [] });
const team = (id: string, status: Team['status']): Team => ({ id, name: id, motto: '', color: '#888888', status, foundedDaysAgo: 1, members: [], works: [], planet: recipe(id.length) });
const seed: Seed = { teams: [team('you', 'active'), team('other', 'active'), team('building', 'under-construction')], you: { teamId: 'you', memberId: 'm' } };

describe('每颗星球都能编辑：存档和 Reset demo', () => {
  it('三颗星球（你的、别人的、建设中的）各改各的，刷新后都还在；Reset demo 一次全清掉', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('you', { ...recipe(3), preset: 'coral' });
    await s.savePlanet('other', { ...recipe(5), ring: true });
    await s.savePlanet('building', { ...recipe(8), preset: 'glacier' });
    const again = new LocalStore(seed, storage);
    expect((await again.getTeam('you'))?.planet.preset).toBe('coral');
    expect((await again.getTeam('other'))?.planet.ring).toBe(true);
    expect((await again.getTeam('building'))?.planet.preset).toBe('glacier');
    await again.reset();
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    const fresh = new LocalStore(seed, storage);
    for (const t of seed.teams) expect((await fresh.getTeam(t.id))?.planet).toEqual(t.planet);
  });
});

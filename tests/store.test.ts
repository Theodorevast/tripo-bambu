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
  it('团队 id 叫 constructor、toString、__proto__ 时读的是种子里的配方，不会读到 Object.prototype 上；__proto__ 的修改也存得住', async () => {
    const ids = ['constructor', 'toString', '__proto__'];
    const odd: Seed = { ...seed, teams: ids.map((id, k) => ({ ...seed.teams[0], id, planet: { ...planetA, seed: 10 + k } })) };
    const storage = memStorage();
    const s = new LocalStore(odd, storage);
    for (const [k, id] of ids.entries()) expect((await s.getTeam(id))?.planet).toEqual({ ...planetA, seed: 10 + k });
    await s.savePlanet('__proto__', { ...planetA, preset: 'coral' });
    expect((await new LocalStore(odd, storage).getTeam('__proto__'))?.planet.preset).toBe('coral');
  });
  it('写入失败（配额满）之后 reset 照样删掉存储里的旧值，刷新后回到初始数据', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).savePlanet('a', { ...planetA, preset: 'coral' }); // 之前写进去过一次
    const removed: string[] = [];
    const full: StorageLike = {
      getItem: (k) => storage.getItem(k),
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: (k) => { removed.push(k); storage.removeItem(k); },
    };
    const s = new LocalStore(seed, full);
    await s.savePlanet('a', { ...planetA, preset: 'glacier' });
    await s.reset();
    expect(removed).toEqual([STORAGE_KEY]);
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('verdant');
  });
  it('存的值带当前种子的指纹：{ seed: 指纹, planets: { 团队 id: 配方 } }', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).savePlanet('a', { ...planetA, preset: 'coral' });
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    expect(Object.keys(stored)).toEqual(['seed', 'planets']);
    expect(stored.seed).toMatch(/^[0-9a-z]+$/);
    expect(stored.planets).toEqual({ a: { ...planetA, preset: 'coral' } });
  });
  it('重新部署换了种子：旧的覆盖数据作废并从存储里删掉，新作品照常出现；种子不变时照常读到', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).savePlanet('a', { ...planetA, preset: 'coral' });
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('coral');
    const work = { id: 'w-new', title: 'New', authorId: 'm-x', file: 'w-new.glb', thumb: 'w-new.webp', tris: 1 };
    const placement = { workId: 'w-new', dir: [0, 1, 0] as [number, number, number], yaw: 0, scale: 1 };
    const redeployed: Seed = { ...seed, teams: [{ ...seed.teams[0], works: [work], planet: { ...planetA, placements: [placement] } }, seed.teams[1]] };
    expect((await new LocalStore(redeployed, storage).getTeam('a'))?.planet).toEqual(redeployed.teams[0].planet);
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });
  it('存储里形状不对的配方丢掉（那个团队用种子里的），合格的保留；只留 types.ts 里有的字段', async () => {
    const storage = memStorage();
    const good: PlanetRecipe = { ...planetA, preset: 'coral' };
    await new LocalStore(seed, storage).savePlanet('a', good);
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    const p = { workId: 'w', dir: [0, 1, 0], yaw: 0.5, scale: 1.5 };
    const valid = { seed: 9, preset: 'glacier', ring: false, atmosphere: true, placements: [p] };
    const readB = async (recipe: unknown) => {
      stored.planets.b = recipe;
      storage.data.set(STORAGE_KEY, JSON.stringify(stored));
      const s = new LocalStore(seed, storage);
      expect((await s.getTeam('a'))?.planet).toEqual(good);
      return (await s.getTeam('b'))?.planet;
    };
    const bad: unknown[] = [
      { ...valid, preset: 'lava' }, { ...valid, preset: 'toString' }, { ...valid, seed: '9' }, { ...valid, seed: null }, // NaN、Infinity 存成 JSON 就是 null
      { ...valid, ring: 'yes' }, { ...valid, atmosphere: 1 }, { ...valid, placements: {} }, { ...valid, placements: undefined },
      { ...valid, placements: [null] }, { ...valid, placements: [{ ...p, workId: 5 }] }, { ...valid, placements: [{ ...p, dir: [0, 1] }] },
      { ...valid, placements: [{ ...p, dir: [0, 1, 0, 0] }] }, { ...valid, placements: [{ ...p, dir: [0, '1', 0] }] },
      { ...valid, placements: [{ ...p, dir: [0, null, 0] }] }, { ...valid, placements: [{ ...p, yaw: '0' }] },
      { ...valid, placements: [{ ...p, scale: null }] }, { ...valid, placements: [p, { ...p, yaw: undefined }] }, 'coral', [], null,
    ];
    for (const recipe of bad) expect(await readB(recipe), JSON.stringify(recipe)).toEqual(seed.teams[1].planet);
    expect(await readB({ ...valid, extra: 1, placements: [{ ...p, extra: 2 }] })).toEqual(valid);
  });
  it('没有指纹的旧格式（直接是 { 团队 id: 配方 }）当作没有覆盖数据，并删掉', async () => {
    const storage = memStorage();
    storage.data.set(STORAGE_KEY, JSON.stringify({ a: { ...planetA, preset: 'coral' } }));
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('verdant');
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });
});

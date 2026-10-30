import { describe, expect, it, vi } from 'vitest';
import { LocalStore, STORAGE_KEY, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed, Team } from '../src/data/types';
import { MemoryUserWorksStore, newUserWorkId, toUserWork, type UserWork } from '../src/works/userWorks';
import { mergeUserWorks, PlanetStoreWithUserWorks, UserWorksRegistry, workFromRecord } from '../src/works/userWorksTeams';

// 用户作品的存储层（内存实现）、注册成页面上的 Work、并进团队、Reset demo 一起清掉

const glb = (n = 4) => new Blob([new Uint8Array(n)], { type: 'model/gltf-binary' });
const thumb = () => new Blob([new Uint8Array(2)], { type: 'image/webp' });
const record = (over: Partial<UserWork> = {}): UserWork => ({
  id: 'u-1', title: 'Mushroom House', author: 'you', authorHandle: 'orbit_ollie', source: 'upload',
  createdAt: 1000, triangles: 1200, bytes: 4, teamId: 'a', glb: glb(), thumb: thumb(), ...over,
});

describe('MemoryUserWorksStore', () => {
  it('add / list / remove：按 createdAt 排；同 id 再 add 是整条覆盖；remove 不存在的 id 什么也不做', async () => {
    const s = new MemoryUserWorksStore();
    expect(s.persistent).toBe(false);
    expect(await s.add(record({ id: 'u-2', createdAt: 2000 }))).toEqual({ saved: false });
    await s.add(record({ id: 'u-1', createdAt: 1000 }));
    expect((await s.list()).map((w) => w.id)).toEqual(['u-1', 'u-2']);
    await s.add(record({ id: 'u-2', createdAt: 2000, title: 'Renamed' }));
    expect((await s.list()).map((w) => w.title)).toEqual(['Mushroom House', 'Renamed']);
    await s.remove('u-1');
    await s.remove('u-nope');
    expect((await s.list()).map((w) => w.id)).toEqual(['u-2']);
  });

  it('onChange：增、删、清空以后收到最新的完整列表；取消订阅后不再收到', async () => {
    const s = new MemoryUserWorksStore();
    const seen: string[][] = [];
    const off = s.onChange((ws) => seen.push(ws.map((w) => w.id)));
    await s.add(record({ id: 'u-1' }));
    await s.add(record({ id: 'u-2', createdAt: 2000 }));
    await s.remove('u-1');
    await s.clear();
    off();
    await s.add(record({ id: 'u-3' }));
    expect(seen).toEqual([['u-1'], ['u-1', 'u-2'], ['u-2'], []]);
  });

  it('返回的是副本：改列表里的对象不影响存储', async () => {
    const s = new MemoryUserWorksStore();
    await s.add(record());
    (await s.list())[0].title = 'Hacked';
    expect((await s.list())[0].title).toBe('Mushroom House');
  });

  it('不合格的记录不收：id 不是 u- 开头、来源不认识、没有 GLB', async () => {
    const s = new MemoryUserWorksStore();
    await expect(s.add(record({ id: 'tmp-1' }))).rejects.toThrow();
    await expect(s.add({ ...record(), source: 'magic' } as unknown as UserWork)).rejects.toThrow();
    await expect(s.add({ ...record(), glb: 'nope' } as unknown as UserWork)).rejects.toThrow();
    expect(await s.list()).toEqual([]);
  });
});

describe('toUserWork：读回来的记录逐个字段核对', () => {
  it('只留认识的字段；可选字段类型不对就丢掉；缩略图可以没有', () => {
    const w = toUserWork({ ...record({ source: 'tripo', mode: 'text', prompt: 'a tiny robot' }), extra: 1, thumb: undefined });
    expect(w).not.toBeNull();
    expect(Object.keys(w!).sort()).toEqual(['author', 'authorHandle', 'bytes', 'createdAt', 'glb', 'id', 'mode', 'prompt', 'source', 'teamId', 'thumb', 'title', 'triangles']);
    expect(w!.thumb).toBeNull();
    expect(toUserWork({ ...record(), mode: 'sculpt' })?.mode).toBeUndefined();
    for (const bad of [null, [], 'x', { ...record(), triangles: -1 }, { ...record(), createdAt: Number.NaN }, { ...record(), teamId: '' }]) expect(toUserWork(bad)).toBeNull();
  });

  it('newUserWorkId：u- 开头，只有小写字母、数字和 -', () => {
    const id = newUserWorkId(1_700_000_000_000, () => 0.5);
    expect(id).toMatch(/^u-[a-z0-9]+-[a-z0-9]{6}$/);
    expect(toUserWork(record({ id }))).not.toBeNull();
  });
});

const planet = (seed: number): PlanetRecipe => ({ seed, preset: 'verdant', ring: false, atmosphere: true, placements: [] });
const seedWork = { id: 'w-1', title: 'Seed Work', authorId: 'm-1', file: 'w-1.glb', thumb: 'w-1.webp', tris: 10 };
const team = (id: string, works = [seedWork]): Team => ({ id, name: id, motto: '', color: '#888888', status: 'active', foundedDaysAgo: 1, members: [{ id: 'm-1', handle: 'one', displayName: 'One', role: 'captain' }], works, planet: planet(id.length) });
const seed: Seed = { teams: [team('a'), team('b', [])], you: { teamId: 'a', memberId: 'you' } };

function urls() {
  let n = 0;
  const live = new Set<string>();
  return {
    live,
    create: (_b: Blob) => { const u = `blob:test/${++n}`; live.add(u); return u; },
    revoke: (u: string) => { live.delete(u); },
  };
}

describe('UserWorksRegistry：记录注册成 blob URL、并进团队', () => {
  it('workFromRecord：file、thumb 是注册的地址，tris 是三角面数，来源、提示词、作者 handle 跟着带上', () => {
    const w = workFromRecord(record({ source: 'tripo', mode: 'text', prompt: 'a lantern' }), 'blob:g', 'blob:t');
    expect(w).toEqual({ id: 'u-1', title: 'Mushroom House', authorId: 'you', file: 'blob:g', thumb: 'blob:t', tris: 1200, source: 'tripo', prompt: 'a lantern', mode: 'text', authorHandle: 'orbit_ollie' });
  });

  it('load 以后每个团队的作品后面接上归它的用户作品（按 createdAt）；别的团队不受影响；不改传进来的团队', async () => {
    const store = new MemoryUserWorksStore();
    await store.add(record({ id: 'u-late', createdAt: 3000 }));
    await store.add(record({ id: 'u-early', createdAt: 1000, thumb: null }));
    await store.add(record({ id: 'u-b', teamId: 'b' }));
    const u = urls();
    const reg = new UserWorksRegistry(store, u);
    await reg.load();
    const teams = seed.teams.map((t) => structuredClone(t));
    const merged = reg.merge(teams);
    expect(merged[0].works.map((w) => w.id)).toEqual(['w-1', 'u-early', 'u-late']);
    expect(merged[1].works.map((w) => w.id)).toEqual(['u-b']);
    expect(teams[0].works).toHaveLength(1);
    expect(merged[0].works[1].thumb).toBe(''); // 没有缩略图：空字符串（界面用缩写色块）
    expect(u.live.size).toBe(5); // 3 个 GLB + 2 张缩略图
  });

  it('mergeUserWorks：id 已经在团队里的不重复加', () => {
    const w = workFromRecord(record({ id: 'u-1' }), 'blob:g', '');
    const merged = mergeUserWorks([team('a', [seedWork, w])], () => [w]);
    expect(merged[0].works.map((x) => x.id)).toEqual(['w-1', 'u-1']);
  });

  it('add 写进存储再注册；rename 存储里覆盖、地址不变；remove 收回地址', async () => {
    const u = urls();
    const store = new MemoryUserWorksStore();
    const reg = new UserWorksRegistry(store, u);
    const { work, saved } = await reg.add(record());
    expect(saved).toBe(false);
    expect(reg.worksFor('a').map((w) => w.id)).toEqual(['u-1']);
    const renamed = await reg.rename('u-1', 'Toadstool Inn');
    expect(renamed?.title).toBe('Toadstool Inn');
    expect(renamed?.file).toBe(work.file);
    expect((await store.list())[0].title).toBe('Toadstool Inn');
    await reg.remove('u-1');
    expect(reg.has('u-1')).toBe(false);
    expect(u.live.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('存储读不出来时当作没有用户作品，页面照常启动', async () => {
    const store = new MemoryUserWorksStore();
    vi.spyOn(store, 'list').mockRejectedValue(new Error('broken db'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new UserWorksRegistry(store, urls());
    await reg.load();
    expect(reg.worksFor('a')).toEqual([]);
  });
});

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('PlanetStoreWithUserWorks：读团队时并进用户作品，Reset demo 一起清掉', () => {
  it('摆了用户作品的配方照常存进 LocalStore；用户作品增减不让存档作废（种子指纹只看种子作品）', async () => {
    const storage = memStorage();
    const userStore = new MemoryUserWorksStore();
    const reg = new UserWorksRegistry(userStore, urls());
    await reg.add(record({ id: 'u-1' }));
    const s = new PlanetStoreWithUserWorks(new LocalStore(seed, storage), reg);
    const placement = { workId: 'u-1', dir: [0, 1, 0] as [number, number, number], yaw: 0, scale: 1 };
    await s.savePlanet('a', { ...planet(1), placements: [placement] });
    await reg.add(record({ id: 'u-2', createdAt: 2000 })); // 再加一件：不影响已经存下的摆放
    const again = new PlanetStoreWithUserWorks(new LocalStore(seed, storage), reg);
    const a = await again.getTeam('a');
    expect(a?.planet.placements).toEqual([placement]);
    expect(a?.works.map((w) => w.id)).toEqual(['w-1', 'u-1', 'u-2']);
    expect((await again.listTeams()).map((t) => t.works.length)).toEqual([3, 0]);
  });

  it('reset：清掉配方存档、用户作品和挂上的其他本地数据；一处失败不挡别处', async () => {
    const storage = memStorage();
    const userStore = new MemoryUserWorksStore();
    const reg = new UserWorksRegistry(userStore, urls());
    await reg.add(record());
    const s = new PlanetStoreWithUserWorks(new LocalStore(seed, storage), reg);
    await s.savePlanet('a', { ...planet(1), ring: true });
    const order: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.onReset(() => { order.push('broken'); throw new Error('nope'); });
    s.onReset(() => { order.push('jobs'); });
    await s.reset();
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    expect(await userStore.list()).toEqual([]);
    expect(reg.worksFor('a')).toEqual([]);
    expect(order).toEqual(['broken', 'jobs']);
  });

  it('新建的团队（Create a planet）也并进用户作品', async () => {
    const reg = new UserWorksRegistry(new MemoryUserWorksStore(), urls());
    const s = new PlanetStoreWithUserWorks(new LocalStore(seed, memStorage()), reg);
    const mine = { ...team('pebble-party', []), createdByYou: true };
    const { team: created } = await s.createTeam(mine);
    expect(created.works).toEqual([]);
    await reg.add(record({ id: 'u-9', teamId: 'pebble-party' }));
    expect((await s.createdTeam())?.works.map((w) => w.id)).toEqual(['u-9']);
  });
});

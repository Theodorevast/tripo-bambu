import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore, STORAGE_KEY, type PlanetStore, type StorageLike } from '../src/data/store';
import type { PlanetRecipe, Seed, Team } from '../src/data/types';
import { parseRoute, toHash } from '../src/router';
import type { World } from '../src/scenes/world';
import { buildTeam, charCount, checkFriend, checkMotto, checkName, DEFAULT_MOTTO, handleFor, inviteCode, inviteLink, LIMITS, newDraft, teamIdFor, TEAM_COLORS } from '../src/ui/createPlanetModel';
import { FakeElement, FakeLocation, installFakeDom } from './fakeDom';

vi.mock('../src/ui/toast', () => ({ toast: vi.fn() }));
const { App } = await import('../src/app');

// 固定的随机数：草稿、邀请码每次一样
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const captain = { memberId: 'you', handle: 'orbit_ollie', displayName: 'Ollie Park' };

describe('造星的数据：名字、口号、好友的检查', () => {
  it('团队名 2–24 个字、要有字母或数字、不能和已有的重名（不分大小写、多余空格不算）', () => {
    const taken = ['Lumen Guild', 'Moss & Mesh'];
    expect(checkName('', taken).ok).toBe(false);
    expect(checkName('   ', taken).ok).toBe(false);
    expect(checkName('A', taken).ok).toBe(false);
    expect(checkName('Ab', taken).ok).toBe(true);
    expect(checkName('x'.repeat(LIMITS.nameMax), taken).ok).toBe(true);
    expect(checkName('x'.repeat(LIMITS.nameMax + 1), taken).ok).toBe(false);
    expect(checkName('!!!', taken).ok).toBe(false);
    expect(checkName('  lumen   guild ', taken)).toEqual({ ok: false, message: 'Another team already flies under that name.' });
    expect(checkName('星星工坊', taken).ok).toBe(true); // 中文也算字
    expect(checkName('Star Sprouts', taken).message).toMatch(/^12\/24/);
  });

  it('字数按字算：表情、中文都算一个', () => {
    expect(charCount('🌱🌱')).toBe(2);
    expect(charCount('星星')).toBe(2);
  });

  it('口号可以不填，最多 60 个字', () => {
    expect(checkMotto('').ok).toBe(true);
    expect(checkMotto('y'.repeat(LIMITS.mottoMax)).ok).toBe(true);
    expect(checkMotto('y'.repeat(LIMITS.mottoMax + 1)).ok).toBe(false);
  });

  it('好友昵称：不空、不超长、不重复（不分大小写、带不带 @）、不是你自己、最多 5 个', () => {
    expect(checkFriend('', [], 'orbit_ollie').ok).toBe(false);
    expect(checkFriend('pixel', [], 'orbit_ollie').ok).toBe(true);
    expect(checkFriend('@Pixel', ['pixel'], 'orbit_ollie').ok).toBe(false);
    expect(checkFriend('Orbit_Ollie', [], 'orbit_ollie').ok).toBe(false);
    expect(checkFriend('z'.repeat(LIMITS.friendMax + 1), [], 'orbit_ollie').ok).toBe(false);
    expect(checkFriend('six', ['a', 'b', 'c', 'd', 'e'], 'orbit_ollie').ok).toBe(false);
  });
});

describe('造星的数据：团队 id、邀请链接、拼成团队', () => {
  it('团队名变成地址里的 id：小写、连字符；去掉重音；& 读作 and；拼不出来时用 planet；重了加序号', () => {
    expect(teamIdFor('Star Sprouts!', [])).toBe('star-sprouts');
    expect(teamIdFor('  Café   Côte ', [])).toBe('cafe-cote');
    expect(teamIdFor('Moss & Mesh', [])).toBe('moss-and-mesh');
    expect(teamIdFor('星星工坊', [])).toBe('planet');
    expect(teamIdFor('Moss & Mesh', ['moss-and-mesh', 'moss-and-mesh-2'])).toBe('moss-and-mesh-3');
    expect(teamIdFor('x'.repeat(60), []).length).toBeLessThanOrEqual(32);
  });

  it('好友的 handle：小写、空格换下划线；拼不出来时按序号', () => {
    expect(handleFor('Pixel Pete', 0)).toBe('pixel_pete');
    expect(handleFor('@Nova', 1)).toBe('nova');
    expect(handleFor('小明', 2)).toBe('friend_3');
  });

  it('邀请码 6 个字、不含 0 O 1 I L；邀请链接打开后路由到这颗星球', () => {
    const code = inviteCode(seq(0.1, 0.5, 0.9, 0.3, 0.7, 0.2));
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    const link = inviteLink('https://example.test/app/', 'star-sprouts', code);
    expect(link).toBe(`https://example.test/app/?invite=${code}#/t/star-sprouts`);
    expect(parseRoute(link.slice(link.indexOf('#')))).toEqual({ view: 'planet', teamId: 'star-sprouts' });
  });

  it('新草稿：样子、颜色、地形随机；名字空着；默认带石头带', () => {
    const d = newDraft(seq(0.99, 0.0, 0.5));
    expect(d.preset).toBe('coral');
    expect(d.color).toBe(TEAM_COLORS[0].hex);
    expect(d.name).toBe('');
    expect(d.ring).toBe(true);
    expect(Number.isInteger(d.seed)).toBe(true);
  });

  it('拼成团队：你是队长、好友是建设者，没有作品，归你；口号空着时用默认的一句', () => {
    const d = { ...newDraft(seq(0.3)), name: '  Star   Sprouts ', motto: '', friends: ['Pixel Pete', '@nova'] };
    const t = buildTeam(d, 'star-sprouts', captain);
    expect(t).toMatchObject({ id: 'star-sprouts', name: 'Star Sprouts', motto: DEFAULT_MOTTO, status: 'active', works: [], createdByYou: true, color: d.color });
    expect(t.members.map((m) => [m.id, m.handle, m.displayName, m.role])).toEqual([
      ['you', 'orbit_ollie', 'Ollie Park', 'captain'],
      ['m-star-sprouts-1', 'pixel_pete', 'Pixel Pete', 'builder'],
      ['m-star-sprouts-2', 'nova', 'nova', 'builder'],
    ]);
    expect(t.planet).toEqual({ seed: d.seed, preset: d.preset, ring: true, atmosphere: true, placements: [] });
  });
});

describe('路由：#/create', () => {
  it('解析、生成；多一段的不认', () => {
    expect(parseRoute('#/create')).toEqual({ view: 'create' });
    expect(parseRoute('#/create/')).toEqual({ view: 'create' });
    expect(toHash({ view: 'create' })).toBe('#/create');
    expect(parseRoute('#/create/x')).toEqual({ view: 'galaxy' });
  });
});

// —— 存储 ——
function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}
const planetA: PlanetRecipe = { seed: 1, preset: 'verdant', ring: false, atmosphere: true, placements: [] };
const seed: Seed = {
  you: { teamId: 'a', memberId: 'you' },
  teams: [{ id: 'a', name: 'A', motto: '', color: '#ffffff', status: 'active', foundedDaysAgo: 3, members: [], works: [], planet: planetA }],
};
const mine = (): Team => buildTeam({ ...newDraft(seq(0.4)), name: 'Star Sprouts', friends: ['pixel'] }, 'star-sprouts', captain);

describe('LocalStore：新建的团队', () => {
  it('createTeam 写进存储，排在种子团队后面；刷新（新实例）后还在，归你', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    const { team, saved } = await s.createTeam(mine());
    expect(saved).toBe(true);
    expect(team.createdByYou).toBe(true);
    const again = new LocalStore(seed, storage);
    expect((await again.listTeams()).map((t) => t.id)).toEqual(['a', 'star-sprouts']);
    expect(await again.getTeam('star-sprouts')).toEqual({ ...mine(), foundedDaysAgo: 0 });
    expect((await again.createdTeam())?.id).toBe('star-sprouts');
  });

  it('每个浏览器只能建一个；id 和种子里的团队重了也不行', async () => {
    const s = new LocalStore(seed, memStorage());
    await expect(s.createTeam({ ...mine(), id: 'a' })).rejects.toThrow();
    await s.createTeam(mine());
    await expect(s.createTeam({ ...mine(), id: 'other' })).rejects.toThrow();
  });

  it('没有新建的团队时存的格式不变（只有 seed、planets）；有了才多一个 created', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('a', { ...planetA, preset: 'coral' });
    expect(Object.keys(JSON.parse(storage.data.get(STORAGE_KEY)!))).toEqual(['seed', 'planets']);
    await s.createTeam(mine());
    expect(Object.keys(JSON.parse(storage.data.get(STORAGE_KEY)!))).toEqual(['seed', 'planets', 'created']);
    expect((await new LocalStore(seed, storage).getTeam('a'))?.planet.preset).toBe('coral');
  });

  it('编辑新建的星球：配方存在团队自己身上，刷新后还在', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.createTeam(mine());
    const p = { workId: 'w', dir: [0, 1, 0] as [number, number, number], yaw: 0.5, scale: 1.2 };
    await s.savePlanet('star-sprouts', { ...mine().planet, preset: 'glacier', placements: [p] });
    const back = await new LocalStore(seed, storage).getTeam('star-sprouts');
    expect(back?.planet.preset).toBe('glacier');
    expect(back?.planet.placements).toEqual([p]);
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!).planets).toEqual({});
  });

  it('Reset demo：新建的团队也删掉，存储清空', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.createTeam(mine());
    await s.reset();
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    expect(await s.createdTeam()).toBeUndefined();
    expect((await new LocalStore(seed, storage).listTeams()).map((t) => t.id)).toEqual(['a']);
    await s.createTeam(mine()); // 删了以后可以再建
  });

  it('重新部署换了种子：旧配方作废，新建的团队留着（存储按新指纹重写）；id 和新种子里的团队撞了才不要', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('a', { ...planetA, preset: 'coral' });
    await s.createTeam(mine());
    const redeployed: Seed = { ...seed, teams: [{ ...seed.teams[0], planet: { ...planetA, seed: 2 } }] };
    const r = new LocalStore(redeployed, storage);
    expect((await r.getTeam('a'))?.planet).toEqual(redeployed.teams[0].planet);
    expect((await r.listTeams()).map((t) => t.id)).toEqual(['a', 'star-sprouts']);
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    expect(stored.planets).toEqual({});
    expect(stored.created.team.id).toBe('star-sprouts');
    const clash: Seed = { ...seed, teams: [...seed.teams, { ...seed.teams[0], id: 'star-sprouts' }] };
    expect((await new LocalStore(clash, storage).createdTeam())).toBeUndefined();
  });

  it('建好几天了按建好的时刻现算', async () => {
    const storage = memStorage();
    await new LocalStore(seed, storage).createTeam(mine());
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    stored.created.at -= 3.5 * 86_400_000;
    storage.data.set(STORAGE_KEY, JSON.stringify(stored));
    expect((await new LocalStore(seed, storage).createdTeam())?.foundedDaysAgo).toBe(3);
  });

  it('存储里新建的团队形状不对就不要（种子团队的修改照常读到）', async () => {
    const storage = memStorage();
    const s = new LocalStore(seed, storage);
    await s.savePlanet('a', { ...planetA, preset: 'coral' });
    await s.createTeam(mine());
    const stored = JSON.parse(storage.data.get(STORAGE_KEY)!);
    const good = stored.created.team;
    const bad: unknown[] = [
      { ...good, id: 'Bad Id' }, { ...good, id: '' }, { ...good, name: '   ' }, { ...good, color: 'pink' }, { ...good, status: 'done' },
      { ...good, members: [{ id: 'x', handle: 'x', displayName: 'X', role: 'boss' }] }, { ...good, members: 'you' },
      { ...good, works: [{ id: 'w', title: 'W', authorId: 'you', file: 'blob:x', thumb: '', tris: 1 }] }, { ...good, planet: { ...good.planet, preset: 'lava' } },
    ];
    for (const team of bad) {
      storage.data.set(STORAGE_KEY, JSON.stringify({ ...stored, created: { team, at: stored.created.at } }));
      const r = new LocalStore(seed, storage);
      expect(await r.createdTeam(), JSON.stringify(team)).toBeUndefined();
      expect((await r.getTeam('a'))?.planet.preset).toBe('coral');
    }
    storage.data.set(STORAGE_KEY, JSON.stringify({ ...stored, created: { team: { ...good, extra: 1 }, at: stored.created.at } }));
    expect(await new LocalStore(seed, storage).createdTeam()).toEqual({ ...mine(), foundedDaysAgo: 0 });
  });

  it('没有存储（隐私模式）：照样建，只在内存里，saved 是 false', async () => {
    const s = new LocalStore(seed, null);
    const { saved } = await s.createTeam(mine());
    expect(saved).toBe(false);
    expect((await s.listTeams()).length).toBe(2);
  });
});

// —— App：#/create 打开造星窗口，新团队加入 ——
function fakeWorld() {
  const added: string[] = [];
  const yours: Array<[string | null, boolean]> = [];
  const world = {
    renderer: { domElement: new FakeElement('canvas') },
    rig: { flying: false },
    frameHooks: new Set(),
    planets: new Map(),
    setTeams: () => {},
    setHover: () => {},
    pickPlanet: () => null,
    intro: () => Promise.resolve(),
    director: { peekIntro: () => false },
    focus: () => Promise.resolve(null),
    unfocus: () => Promise.resolve(),
    addPlanet: (t: Team) => { added.push(t.id); },
    setYou: (id: string | null, glide = false) => { yours.push([id, glide]); },
  } as unknown as World;
  return { world, added, yours };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const team = (id: string, extra: Partial<Team> = {}): Team => ({
  id, name: id.toUpperCase(), motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'you', handle: 'orbit_ollie', displayName: 'Ollie', role: 'builder' }], works: [], planet: planetA, ...extra,
});

describe('App：#/create 和新团队加入', () => {
  beforeEach(() => installFakeDom());
  afterEach(() => vi.unstubAllGlobals());

  function setup(hash: string, teams = [team('a'), team('b')]) {
    const location = new FakeLocation(hash);
    location.install();
    const { world, added, yours } = fakeWorld();
    const app = new App(world, new FakeElement('div') as unknown as HTMLElement, {} as PlanetStore, { teamId: 'a', memberId: 'you' }, teams);
    const log: string[] = [];
    app.creator = { open: () => log.push('open'), close: () => log.push('close') };
    app.planetLayer = { enter: () => {}, leave: () => {} };
    return { app, location, world, added, yours, log };
  }

  it('#/create 打开窗口；去别的地址时关掉', async () => {
    const { app, location, log } = setup('#/create');
    await app.start();
    expect(log.at(-1)).toBe('open');
    location.hash = '#/';
    await settle();
    expect(log.at(-1)).toBe('close');
    location.hash = '#/create';
    await settle();
    expect(log.at(-1)).toBe('open');
    location.hash = '#/t/b';
    await settle();
    expect(log.at(-1)).toBe('close');
  });

  it('addTeam：记进团队列表、星系里加星球；你建的团队成了你的团队（首页的「你的星球」慢慢挪过去）；同一个团队不加两次', async () => {
    const { app, added, yours } = setup('#/');
    await app.start();
    const t = team('star', { createdByYou: true });
    app.addTeam(t);
    app.addTeam(t);
    expect(app.teams.map((x) => x.id)).toEqual(['a', 'b', 'star']);
    expect(added).toEqual(['star']);
    expect(app.you.teamId).toBe('star');
    expect(yours).toEqual([['star', true]]);
    app.addTeam(team('other'));
    expect(app.you.teamId).toBe('star'); // 别人的团队加进来不改你的星球
  });

  it('开页时团队列表里有你建的团队：它就是你的团队', () => {
    const { app } = setup('#/', [team('a'), team('star', { createdByYou: true })]);
    expect(app.you).toEqual({ teamId: 'star', memberId: 'you' });
  });
});

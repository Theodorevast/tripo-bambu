import type { PlanetStore } from '../data/store';
import type { PlanetRecipe, Team, Work } from '../data/types';
import type { UserWork, UserWorksStore } from './userWorks';

// 用户作品（存储层 userWorks.ts 里的记录）和页面数据之间的一层：
// - 启动时把每条记录的 GLB、缩略图注册成 blob URL，变成页面认识的 Work（file、thumb 是 blob: 地址，ModelLibrary、缩略图照常用）
// - 把作品并进它所属团队的 works（排在种子作品后面）：作品栏、Museum、Members、星系名牌上的作品数都直接看得到
// - Reset demo 时一起清掉
// 星球配方（摆放）还是由 LocalStore 存：摆了用户作品的配方里 workId 是 u- 开头的 id，刷新后作品先注册好、再加载星球，摆放照常找得到。
// 种子指纹只看种子里的作品，用户作品增减不会让存档作废

interface Entry {
  record: UserWork;
  work: Work;
  urls: string[]; // 这条记录注册的 blob URL
}

// 记录 → 页面上的 Work。glbUrl / thumbUrl 是注册好的 blob URL
export function workFromRecord(r: UserWork, glbUrl: string, thumbUrl: string): Work {
  const work: Work = { id: r.id, title: r.title, authorId: r.author, file: glbUrl, thumb: thumbUrl, tris: r.triangles, source: r.source };
  if (r.prompt) work.prompt = r.prompt;
  if (r.mode) work.mode = r.mode;
  if (r.authorHandle) work.authorHandle = r.authorHandle;
  return work;
}

// 团队列表并进用户作品：每个团队的 works 后面接上归它的用户作品（按 createdAt）；id 已经在里面的不重复加。不改传进来的对象
export function mergeUserWorks(teams: Team[], byTeam: (teamId: string) => Work[]): Team[] {
  return teams.map((t) => {
    const extra = byTeam(t.id).filter((w) => !t.works.some((x) => x.id === w.id));
    return extra.length ? { ...t, works: [...t.works, ...extra] } : t;
  });
}

export class UserWorksRegistry {
  readonly store: UserWorksStore;
  private readonly entries = new Map<string, Entry>();
  private readonly createUrl: (blob: Blob) => string;
  private readonly revokeUrl: (url: string) => void;

  constructor(store: UserWorksStore, urls: { create?: (blob: Blob) => string; revoke?: (url: string) => void } = {}) {
    this.store = store;
    this.createUrl = urls.create ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = urls.revoke ?? ((u) => URL.revokeObjectURL(u));
  }

  // 启动时调一次：读出全部记录、注册 blob URL。读失败（库坏了）时当作没有，页面照常启动
  async load(): Promise<void> {
    let records: UserWork[] = [];
    try {
      records = await this.store.list();
    } catch (err) {
      console.warn('user works: could not read them', err);
    }
    for (const r of records) this.register(r);
  }

  get persistent(): boolean {
    return this.store.persistent;
  }

  // 归这个团队的用户作品（按 createdAt）
  worksFor(teamId: string): Work[] {
    return [...this.entries.values()].filter((e) => e.record.teamId === teamId).sort((a, b) => a.record.createdAt - b.record.createdAt).map((e) => e.work);
  }

  record(workId: string): UserWork | undefined {
    return this.entries.get(workId)?.record;
  }

  work(workId: string): Work | undefined {
    return this.entries.get(workId)?.work;
  }

  has(workId: string): boolean {
    return this.entries.has(workId);
  }

  merge(teams: Team[]): Team[] {
    return mergeUserWorks(teams, (id) => this.worksFor(id));
  }

  // 新增一件：先写进存储（写不进去时抛错，调用方提示），再注册。saved = false：只在内存里（隐私模式）
  async add(record: UserWork): Promise<{ work: Work; saved: boolean }> {
    const { saved } = await this.store.add(record);
    return { work: this.register(record), saved };
  }

  // 改名：存储里整条覆盖，页面上的 Work 换个名字（blob URL 不变，已经加载的模型照常用）
  async rename(workId: string, title: string): Promise<Work | undefined> {
    const e = this.entries.get(workId);
    if (!e || e.record.title === title) return e?.work;
    const record = { ...e.record, title };
    await this.store.add(record);
    e.record = record;
    e.work = { ...e.work, title };
    return e.work;
  }

  async remove(workId: string): Promise<void> {
    await this.store.remove(workId);
    const e = this.entries.get(workId);
    if (!e) return;
    this.entries.delete(workId);
    for (const u of e.urls) this.revokeUrl(u);
  }

  // Reset demo：清空存储和已注册的地址（之后页面会刷新）
  async clear(): Promise<void> {
    try {
      await this.store.clear();
    } finally {
      for (const e of this.entries.values()) for (const u of e.urls) this.revokeUrl(u);
      this.entries.clear();
    }
  }

  // 注册一条记录（同 id 已经注册过：换成新的记录，旧地址收回）
  private register(r: UserWork): Work {
    const old = this.entries.get(r.id);
    if (old) for (const u of old.urls) this.revokeUrl(u);
    const glbUrl = this.createUrl(r.glb);
    const thumbUrl = r.thumb ? this.createUrl(r.thumb) : '';
    const work = workFromRecord(r, glbUrl, thumbUrl);
    this.entries.set(r.id, { record: r, work, urls: thumbUrl ? [glbUrl, thumbUrl] : [glbUrl] });
    return work;
  }
}

// PlanetStore 的一层包装：读团队时并进用户作品，Reset demo 时一起清掉用户作品（和生成任务等别的本地数据，见 onReset）。
// 写配方、建团队照旧交给原来的存储（LocalStore）
export class PlanetStoreWithUserWorks implements PlanetStore {
  private readonly base: PlanetStore;
  private readonly registry: UserWorksRegistry;
  private readonly resetHooks: Array<() => void | Promise<void>> = [];

  constructor(base: PlanetStore, registry: UserWorksRegistry) {
    this.base = base;
    this.registry = registry;
  }

  // Reset demo 时还要清的东西（比如 Tripo 生成任务的列表）
  onReset(hook: () => void | Promise<void>): void {
    this.resetHooks.push(hook);
  }

  async listTeams(): Promise<Team[]> {
    return this.registry.merge(await this.base.listTeams());
  }

  async getTeam(id: string): Promise<Team | undefined> {
    const t = await this.base.getTeam(id);
    return t && this.registry.merge([t])[0];
  }

  savePlanet(teamId: string, planet: PlanetRecipe): Promise<void> {
    return this.base.savePlanet(teamId, planet);
  }

  async createTeam(team: Team): Promise<{ team: Team; saved: boolean }> {
    const r = await this.base.createTeam(team);
    return { ...r, team: this.registry.merge([r.team])[0] };
  }

  async createdTeam(): Promise<Team | undefined> {
    const t = await this.base.createdTeam();
    return t && this.registry.merge([t])[0];
  }

  // 先清原来的存档；用户作品、别的本地数据各清各的，一处失败不挡别处（之后页面会刷新）
  async reset(): Promise<void> {
    await this.base.reset();
    for (const task of [() => this.registry.clear(), ...this.resetHooks]) {
      try {
        await task();
      } catch (err) {
        console.warn('reset: could not clear local data', err);
      }
    }
  }
}

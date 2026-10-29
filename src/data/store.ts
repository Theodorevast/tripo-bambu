import { PRESETS } from '../planet/presets';
import { hashString } from '../planet/rng';
import type { Member, Placement, PlanetRecipe, PresetId, Seed, Team, Work } from './types';

// 以后换真后端（Supabase、Cloudflare D1 等）只需另写一个实现
export interface PlanetStore {
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  savePlanet(teamId: string, planet: PlanetRecipe): Promise<void>;
  reset(): Promise<void>;
  // 「Create a planet」新建的团队（P3）：每个浏览器只能建一个，已经建过、或者 id 和别的团队重了就抛错。
  // saved：写进存储了没有（隐私模式、配额满时只在内存里，刷新就没了）
  createTeam(team: Team): Promise<{ team: Team; saved: boolean }>;
  // 这个浏览器建的那个团队；没有是 undefined
  createdTeam(): Promise<Team | undefined>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STORAGE_KEY = 'gbn:v1:planets';

// 种子指纹：每个团队的 id、星球配方、作品 id 列表。重新部署换了 seed.json，指纹就变
function seedFingerprint(seed: Seed): string {
  return hashString(JSON.stringify(seed.teams.map((t) => [t.id, t.planet, t.works.map((w) => w.id)]))).toString(36);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPreset = (v: unknown): v is PresetId => typeof v === 'string' && Object.hasOwn(PRESETS, v);

// 存储里的配方可能来自旧版本或被手改过：每个字段都对上 types.ts 的 PlanetRecipe、Placement 才收，只留认识的字段；
// 有一个摆放不对就整个配方不要（那个团队用种子里的），免得作品悄悄从星球上少掉
function toRecipe(v: unknown): PlanetRecipe | null {
  if (!isRecord(v)) return null;
  const { seed, preset, ring, atmosphere, placements } = v;
  if (!isNumber(seed) || !isPreset(preset) || typeof ring !== 'boolean' || typeof atmosphere !== 'boolean' || !Array.isArray(placements)) return null;
  const ps = placements.map(toPlacement);
  return ps.every((p): p is Placement => p !== null) ? { seed, preset, ring, atmosphere, placements: ps } : null;
}

function toPlacement(v: unknown): Placement | null {
  if (!isRecord(v)) return null;
  const { workId, dir, yaw, scale } = v;
  if (typeof workId !== 'string' || !Array.isArray(dir) || dir.length !== 3 || !dir.every(isNumber) || !isNumber(yaw) || !isNumber(scale)) return null;
  return { workId, dir: [dir[0], dir[1], dir[2]], yaw, scale };
}

// —— 新建的团队（P3）：整个团队都存在本地，读回来时同样逐个字段核对，只留认识的字段；有一处不对就整个不要 ——
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const DAY_MS = 86_400_000;

function toMember(v: unknown): Member | null {
  if (!isRecord(v)) return null;
  const { id, handle, displayName, role } = v;
  if (!isText(id, 80) || !id || !isText(handle, 40) || !isText(displayName, 60) || (role !== 'captain' && role !== 'builder')) return null;
  return { id, handle, displayName, role };
}

function toWork(v: unknown): Work | null {
  if (!isRecord(v)) return null;
  const { id, title, authorId, file, thumb, tris, description } = v;
  if (!isText(id, 120) || !id || !isText(title, 200) || !isText(authorId, 80) || !isText(file, 2000) || !isText(thumb, 2000) || !isNumber(tris)) return null;
  // 拖进来的临时作品（blob:）只在那一次页面里有效，不会存下来
  if (file.startsWith('blob:')) return null;
  return { id, title, authorId, file, thumb, tris, ...(typeof description === 'string' ? { description } : {}) };
}

// 存储里的 { team, at }：at 是建好的时刻（毫秒），读出来时按它算 foundedDaysAgo
function toCreated(v: unknown): { team: Team; at: number } | null {
  if (!isRecord(v) || !isRecord(v.team) || !isNumber(v.at)) return null;
  const { id, name, motto, color, status, members, works, planet } = v.team;
  if (!isText(id, 80) || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !isText(name, 60) || !name.trim() || !isText(motto, 200) || !isHex(color)) return null;
  if ((status !== 'active' && status !== 'under-construction') || !Array.isArray(members) || !Array.isArray(works)) return null;
  const ms = members.map(toMember);
  const ws = works.map(toWork);
  const recipe = toRecipe(planet);
  if (!recipe || !ms.every((m): m is Member => m !== null) || !ws.every((w): w is Work => w !== null)) return null;
  const team: Team = { id, name, motto, color, status, foundedDaysAgo: 0, members: ms, works: ws, planet: recipe, createdByYou: true };
  return { team, at: v.at };
}

// seed.json + 本地修改（只存改过的星球配方）。读不了存储（隐私模式）时只用内存；写不进去（配额满）时这次的修改留在内存里。
// 存的值是 { seed: 种子指纹, planets: { 团队 id: 配方 } }：换了种子以后，旧配方会盖住新作品，所以作废。
// 用「Create a planet」建了团队以后多一个 created: { team, at }（整个团队；P3）
export class LocalStore implements PlanetStore {
  private readonly seed: Seed;
  private readonly fingerprint: string;
  private storage: StorageLike | null; // null：没有存储，或者读的时候就抛错（存储不可用），之后不再碰它
  private readonly overrides = new Map<string, PlanetRecipe>(); // 用 Map：团队 id 叫 constructor、__proto__ 时不会碰到 Object.prototype
  // 这个浏览器用「Create a planet」建的团队（P3）和建好的时刻。存在同一个值的 created 里；没有新建的团队时存的格式和以前一模一样
  private created: { team: Team; at: number } | null = null;

  constructor(seed: Seed, storage: StorageLike | null) {
    this.seed = seed;
    this.fingerprint = seedFingerprint(seed);
    this.storage = storage;
    this.readStored();
  }

  // 新建的团队排在种子里的团队后面（星系版式按顺序排：它在最后一个位置）
  async listTeams(): Promise<Team[]> {
    const teams = this.seed.teams.map((t) => this.withOverride(t));
    if (this.created) teams.push(this.createdCopy(this.created));
    return teams;
  }

  async getTeam(id: string): Promise<Team | undefined> {
    if (this.created?.team.id === id) return this.createdCopy(this.created);
    const t = this.seed.teams.find((x) => x.id === id);
    return t && this.withOverride(t);
  }

  async savePlanet(teamId: string, planet: PlanetRecipe): Promise<void> {
    // 新建的团队整个存在 created 里，配方跟着它走（换了种子也不丢）；种子里的团队照旧只存改过的配方
    if (this.created?.team.id === teamId) this.created.team.planet = structuredClone(planet);
    else this.overrides.set(teamId, structuredClone(planet));
    // 写不进去（配额满）：存储里还是上一次写进去的值，下次保存再试；reset 时照样删掉它
    this.write();
  }

  async createTeam(team: Team): Promise<{ team: Team; saved: boolean }> {
    if (this.created) throw new Error('This browser already has a planet of its own');
    if (this.seed.teams.some((t) => t.id === team.id)) throw new Error(`Team id "${team.id}" is taken`);
    this.created = { team: { ...structuredClone(team), createdByYou: true }, at: Date.now() };
    const saved = this.write();
    return { team: this.createdCopy(this.created), saved };
  }

  async createdTeam(): Promise<Team | undefined> {
    return this.created ? this.createdCopy(this.created) : undefined;
  }

  async reset(): Promise<void> {
    this.overrides.clear();
    this.created = null;
    this.removeStored();
  }

  // 写进存储：{ seed: 指纹, planets: { 团队 id: 配方 } }，有新建的团队时再加一个 created。写成了返回 true
  private write(): boolean {
    if (!this.storage) return false;
    const value: Record<string, unknown> = { seed: this.fingerprint, planets: Object.fromEntries(this.overrides) };
    if (this.created) value.created = this.created;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  // 给出去的是副本；建好几天了按建好的时刻现算
  private createdCopy(c: { team: Team; at: number }): Team {
    return { ...structuredClone(c.team), foundedDaysAgo: Math.max(0, Math.floor((Date.now() - c.at) / DAY_MS)) };
  }

  private removeStored(): void {
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // 删不掉也只能这样：内存里已经清空
    }
  }

  private withOverride(t: Team): Team {
    const copy = structuredClone(t);
    const o = this.overrides.get(t.id);
    if (o) copy.planet = structuredClone(o);
    return copy;
  }

  // 读存储里的修改：不是当前种子写的（指纹不同、没有指纹的旧格式、坏数据）就当没有，并删掉；形状不对的配方丢掉。
  // 新建的团队（created）不跟着种子作废：重新部署以后它照样在（id 和新种子里的团队撞了才不要），存储按新指纹重写、只留它
  private readStored(): void {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      this.storage = null; // 读都读不了：存储不可用，之后只用内存
      return;
    }
    if (raw === null) return;
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    const created = isRecord(stored) ? toCreated(stored.created) : null;
    this.created = created && !this.seed.teams.some((t) => t.id === created.team.id) ? created : null;
    if (!isRecord(stored) || stored.seed !== this.fingerprint || !isRecord(stored.planets)) {
      if (this.created) this.write();
      else this.removeStored();
      return;
    }
    for (const [teamId, value] of Object.entries(stored.planets)) {
      const recipe = toRecipe(value);
      if (recipe) this.overrides.set(teamId, recipe);
    }
  }
}

// 浏览器里取 localStorage；某些隐私设置下访问它本身就会抛错
export function browserStorage(): StorageLike | null {
  try {
    const s = window.localStorage;
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}

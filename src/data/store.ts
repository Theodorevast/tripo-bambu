import { PRESETS } from '../planet/presets';
import { hashString } from '../planet/rng';
import type { Placement, PlanetRecipe, PresetId, Seed, Team } from './types';

// 以后换真后端（Supabase、Cloudflare D1 等）只需另写一个实现
export interface PlanetStore {
  listTeams(): Promise<Team[]>;
  getTeam(id: string): Promise<Team | undefined>;
  savePlanet(teamId: string, planet: PlanetRecipe): Promise<void>;
  reset(): Promise<void>;
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

// seed.json + 本地修改（只存改过的星球配方）。读不了存储（隐私模式）时只用内存；写不进去（配额满）时这次的修改留在内存里。
// 存的值是 { seed: 种子指纹, planets: { 团队 id: 配方 } }：换了种子以后，旧配方会盖住新作品，所以作废
export class LocalStore implements PlanetStore {
  private readonly seed: Seed;
  private readonly fingerprint: string;
  private storage: StorageLike | null; // null：没有存储，或者读的时候就抛错（存储不可用），之后不再碰它
  private readonly overrides: Map<string, PlanetRecipe>; // 用 Map：团队 id 叫 constructor、__proto__ 时不会碰到 Object.prototype

  constructor(seed: Seed, storage: StorageLike | null) {
    this.seed = seed;
    this.fingerprint = seedFingerprint(seed);
    this.storage = storage;
    this.overrides = this.readOverrides();
  }

  async listTeams(): Promise<Team[]> {
    return this.seed.teams.map((t) => this.withOverride(t));
  }

  async getTeam(id: string): Promise<Team | undefined> {
    const t = this.seed.teams.find((x) => x.id === id);
    return t && this.withOverride(t);
  }

  async savePlanet(teamId: string, planet: PlanetRecipe): Promise<void> {
    this.overrides.set(teamId, structuredClone(planet));
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ seed: this.fingerprint, planets: Object.fromEntries(this.overrides) }));
    } catch {
      // 配额满：存储里还是上一次写进去的值，下次保存再试；reset 时照样删掉它
    }
  }

  async reset(): Promise<void> {
    this.overrides.clear();
    this.removeStored();
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

  // 读存储里的修改：不是当前种子写的（指纹不同、没有指纹的旧格式、坏数据）就当没有，并删掉；形状不对的配方丢掉
  private readOverrides(): Map<string, PlanetRecipe> {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch {
      this.storage = null; // 读都读不了：存储不可用，之后只用内存
      return new Map();
    }
    if (raw === null) return new Map();
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
    if (!isRecord(stored) || stored.seed !== this.fingerprint || !isRecord(stored.planets)) {
      this.removeStored();
      return new Map();
    }
    const overrides = new Map<string, PlanetRecipe>();
    for (const [teamId, value] of Object.entries(stored.planets)) {
      const recipe = toRecipe(value);
      if (recipe) overrides.set(teamId, recipe);
    }
    return overrides;
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

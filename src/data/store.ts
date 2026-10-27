import type { PlanetRecipe, Seed, Team } from './types';

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

// seed.json + 本地修改（只存改过的星球配方）。存储报错（隐私模式、配额满）时退回内存
export class LocalStore implements PlanetStore {
  private readonly seed: Seed;
  private storage: StorageLike | null;
  private overrides: Record<string, PlanetRecipe>;

  constructor(seed: Seed, storage: StorageLike | null) {
    this.seed = seed;
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
    this.overrides[teamId] = structuredClone(planet);
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
    } catch {
      this.storage = null;
    }
  }

  async reset(): Promise<void> {
    this.overrides = {};
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      this.storage = null;
    }
  }

  private withOverride(t: Team): Team {
    const copy = structuredClone(t);
    const o = this.overrides[t.id];
    if (o) copy.planet = structuredClone(o);
    return copy;
  }

  private readOverrides(): Record<string, PlanetRecipe> {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PlanetRecipe>) : {};
    } catch {
      return {};
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

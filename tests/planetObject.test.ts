import { describe, expect, it } from 'vitest';
import type { PlanetRecipe } from '../src/data/types';
import { LOD_HIGH } from '../src/planet/generate';
import { PlanetObject } from '../src/planet/planetObject';

const base: PlanetRecipe = { seed: 7, preset: 'verdant', ring: true, atmosphere: true, placements: [] };

describe('PlanetObject', () => {
  it('只改摆放时不重建地表', () => {
    const p = new PlanetObject(base);
    const terrain = p.terrain;
    p.setRecipe({ ...base, placements: [{ workId: 'w', dir: [0, 1, 0], yaw: 0, scale: 1 }] });
    expect(p.terrain).toBe(terrain);
  });
  it('换预设会重建地表；没有海的预设 sea 为 0', () => {
    const p = new PlanetObject(base);
    const terrain = p.terrain;
    expect(p.sea).toBeGreaterThan(0);
    p.setRecipe({ ...base, preset: 'desert' });
    expect(p.terrain).not.toBe(terrain);
    expect(p.sea).toBe(0);
  });
  it('setDetail 切换细分；换配方后细分保持不变；作品组一直在', () => {
    const p = new PlanetObject(base);
    p.setDetail(LOD_HIGH);
    expect(p.terrain.geometry.getAttribute('position').count / 3).toBe(20480);
    p.setRecipe({ ...base, seed: 8 });
    expect(p.terrain.geometry.getAttribute('position').count / 3).toBe(20480);
    expect(p.works.parent).toBe(p.group);
  });
});

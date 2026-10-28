import { describe, expect, it } from 'vitest';
import type { PlanetRecipe } from '../src/data/types';
import { LOD_HIGH, triangleCount } from '../src/planet/generate';
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
  it('setRingStrength 调光环浓淡：夹在 0–1；重建光环后保留；强度为 0 时光环不画', () => {
    const p = new PlanetObject(base);
    expect(p.ringStrength).toBe(1);
    p.setRingStrength(0.25);
    expect(p.ringStrength).toBe(0.25);
    p.setRecipe({ ...base, seed: 9 }); // 换种子会重建光环
    expect(p.ringStrength).toBe(0.25);
    const ring = p.group.getObjectByName('ring')!;
    expect(ring.visible).toBe(true);
    p.setRingStrength(-1);
    expect(p.ringStrength).toBe(0);
    expect(ring.visible).toBe(false);
    p.setRingStrength(3);
    expect(p.ringStrength).toBe(1);
    expect(ring.visible).toBe(true);
  });
  it('没有光环时也能调；之后打开光环，新光环用当前强度', () => {
    const p = new PlanetObject({ ...base, ring: false });
    p.setRingStrength(0);
    expect(p.group.getObjectByName('ring')).toBeUndefined();
    p.setRecipe({ ...base, ring: true });
    expect(p.ringStrength).toBe(0);
    expect(p.group.getObjectByName('ring')!.visible).toBe(false);
  });
  it('setDetail 切换细分；换配方后细分保持不变；作品组一直在', () => {
    const p = new PlanetObject(base);
    p.setDetail(LOD_HIGH);
    expect(triangleCount(p.terrain.geometry)).toBe(20480);
    p.setRecipe({ ...base, seed: 8 });
    expect(triangleCount(p.terrain.geometry)).toBe(20480);
    expect(p.works.parent).toBe(p.group);
  });
});

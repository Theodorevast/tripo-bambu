import { describe, expect, it } from 'vitest';
import type { PlanetRecipe, PresetId } from '../src/data/types';
import { buildTerrainGeometry, LOD_HIGH, LOD_LOW } from '../src/planet/generate';
import { makeHeightFn, normalizedHeight, seaRadius } from '../src/planet/noise';
import { BASE_RADIUS, PRESET_IDS, PRESETS } from '../src/planet/presets';

const recipe = (seed: number, preset: PresetId = 'verdant'): PlanetRecipe => ({ seed, preset, ring: false, atmosphere: true, placements: [] });

// 斐波那契球面点：确定性地铺满球面
function sphere(i: number, n: number): [number, number, number] {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(phi) * r, y, Math.sin(phi) * r];
}

describe('makeHeightFn', () => {
  it('高度落在预设给定的范围内', () => {
    for (const id of PRESET_IDS) {
      const h = makeHeightFn(123, id);
      const amp = PRESETS[id].amp;
      for (let i = 0; i < 500; i++) {
        const [x, y, z] = sphere(i, 500);
        const r = h(x, y, z);
        expect(r).toBeGreaterThanOrEqual(BASE_RADIUS * (1 - amp) - 1e-9);
        expect(r).toBeLessThanOrEqual(BASE_RADIUS * (1 + amp) + 1e-9);
      }
    }
  });
  it('同一个种子、同一个方向，高度一样', () => {
    expect(makeHeightFn(5, 'desert')(0.6, 0.8, 0)).toBe(makeHeightFn(5, 'desert')(0.6, 0.8, 0));
  });
});

describe('buildTerrainGeometry', () => {
  it('同一份配方生成完全一样的顶点，换种子就不一样', () => {
    const a = Array.from(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').array);
    const b = Array.from(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').array);
    const c = Array.from(buildTerrainGeometry(recipe(2), LOD_LOW).getAttribute('position').array);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
  it('三角面数量：低细分 2420，高细分 20480', () => {
    expect(buildTerrainGeometry(recipe(1), LOD_LOW).getAttribute('position').count / 3).toBe(2420);
    expect(buildTerrainGeometry(recipe(1), LOD_HIGH).getAttribute('position').count / 3).toBe(20480);
  });
  it('每个三角面的三个顶点颜色相同（低多边形）', () => {
    const col = buildTerrainGeometry(recipe(3, 'coral'), LOD_LOW).getAttribute('color');
    for (let f = 0; f < col.count; f += 3) {
      expect(col.getX(f + 1)).toBe(col.getX(f));
      expect(col.getX(f + 2)).toBe(col.getX(f));
    }
  });
});

describe('seaRadius / normalizedHeight', () => {
  it('没有海的预设返回 0；有海的落在起伏范围内', () => {
    expect(seaRadius('desert')).toBe(0);
    const s = seaRadius('verdant');
    expect(s).toBeGreaterThan(BASE_RADIUS * (1 - PRESETS.verdant.amp));
    expect(s).toBeLessThan(BASE_RADIUS * (1 + PRESETS.verdant.amp));
  });
  it('normalizedHeight 把半径换算回 [-1, 1]', () => {
    expect(normalizedHeight(BASE_RADIUS, 'verdant')).toBeCloseTo(0);
    expect(normalizedHeight(BASE_RADIUS * (1 + PRESETS.verdant.amp), 'verdant')).toBeCloseTo(1);
  });
});

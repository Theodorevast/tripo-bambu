import { describe, expect, it } from 'vitest';
import type { PlanetRecipe, PresetId } from '../src/data/types';
import { buildTerrainGeometry, LOD_HIGH, LOD_LOW, triangleCount } from '../src/planet/generate';
import { makeHeightFn, normalizedHeight, seaRadius } from '../src/planet/noise';
import { PLANET_RADIUS, PRESET_IDS, PRESETS } from '../src/planet/presets';

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
        expect(r).toBeGreaterThanOrEqual(PLANET_RADIUS * (1 - amp) - 1e-9);
        expect(r).toBeLessThanOrEqual(PLANET_RADIUS * (1 + amp) + 1e-9);
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
    expect(triangleCount(buildTerrainGeometry(recipe(1), LOD_LOW))).toBe(2420);
    expect(triangleCount(buildTerrainGeometry(recipe(1), LOD_HIGH))).toBe(20480);
  });
  it('顶点共用（带索引）、法线平滑：每个顶点的法线是单位向量，和那里的球面法线夹角不大（缓坡）', () => {
    const geo = buildTerrainGeometry(recipe(3, 'coral'), LOD_HIGH);
    expect(geo.index).not.toBeNull();
    expect(geo.getAttribute('color')).toBeUndefined(); // 颜色在地表着色器里算，不再按面分色带
    const pos = geo.getAttribute('position');
    const nor = geo.getAttribute('normal');
    for (let i = 0; i < pos.count; i += 7) {
      const len = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      const dot = (pos.getX(i) * nor.getX(i) + pos.getY(i) * nor.getY(i) + pos.getZ(i) * nor.getZ(i)) / len;
      expect(Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i))).toBeCloseTo(1, 5);
      expect(dot).toBeGreaterThan(Math.cos((35 * Math.PI) / 180));
    }
  });
});

describe('seaRadius / normalizedHeight', () => {
  it('没有海的预设返回 0；有海的落在起伏范围内', () => {
    expect(seaRadius('desert')).toBe(0);
    const s = seaRadius('verdant');
    expect(s).toBeGreaterThan(PLANET_RADIUS * (1 - PRESETS.verdant.amp));
    expect(s).toBeLessThan(PLANET_RADIUS * (1 + PRESETS.verdant.amp));
  });
  it('normalizedHeight 把半径换算回 [-1, 1]', () => {
    expect(normalizedHeight(PLANET_RADIUS, 'verdant')).toBeCloseTo(0);
    expect(normalizedHeight(PLANET_RADIUS * (1 + PRESETS.verdant.amp), 'verdant')).toBeCloseTo(1);
  });
});

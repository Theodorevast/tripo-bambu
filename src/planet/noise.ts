import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import type { PresetId } from '../data/types';
import { PLANET_RADIUS, PRESETS } from './presets';
import { mulberry32 } from './rng';

// 输入单位向量，返回该方向上地面到球心的距离
export type HeightFn = (x: number, y: number, z: number) => number;

// fBm：4 层 simplex 噪声叠加，归一化后夹到 [-1, 1]。半径每次调用时现读 PLANET_RADIUS：滑块拖动后高度跟着变
export function makeHeightFn(seed: number, preset: PresetId): HeightFn {
  const p = PRESETS[preset];
  const noise = new SimplexNoise({ random: mulberry32(seed) });
  return (x, y, z) => {
    let sum = 0;
    let amp = 1;
    let freq = p.freq;
    let norm = 0;
    for (let o = 0; o < 4; o++) {
      sum += amp * noise.noise3d(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    const n = Math.max(-1, Math.min(1, sum / norm));
    return PLANET_RADIUS * (1 + p.amp * n);
  };
}

// 水面半径；没有水时返回 0
export function seaRadius(preset: PresetId): number {
  const p = PRESETS[preset];
  return p.sea === null ? 0 : PLANET_RADIUS * (1 + p.amp * p.sea);
}

// 半径换算回 [-1, 1]
export function normalizedHeight(r: number, preset: PresetId): number {
  return (r / PLANET_RADIUS - 1) / PRESETS[preset].amp;
}

import { describe, expect, it } from 'vitest';
import { buildNoiseVolume } from '../src/nature/grass';

describe('noise volume', () => {
  it('is smooth between neighbouring texels', () => {
    const t = buildNoiseVolume();
    const d = t.image.data as Uint8Array;
    const S = 32;
    let maxStep = 0;
    let sum = 0;
    let n = 0;
    let mn = 255;
    let mx = 0;
    for (let ch = 0; ch < 4; ch++)
      for (let z = 0; z < S; z++)
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            const a = d[((z * S + y) * S + x) * 4 + ch];
            const b = d[((z * S + y) * S + ((x + 1) % S)) * 4 + ch];
            maxStep = Math.max(maxStep, Math.abs(a - b));
            sum += Math.abs(a - b);
            n++;
            mn = Math.min(mn, a);
            mx = Math.max(mx, a);
          }
    console.log('format', t.format, 'type', t.type, 'min', t.minFilter, 'mag', t.magFilter, 'maxStep', maxStep, 'meanStep', (sum / n).toFixed(2), 'range', mn, mx);
    expect(maxStep).toBeLessThan(60);
  });
});

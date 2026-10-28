import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { gustAt, sampleWindNoise, setWind, WIND, windAt, windClock, windRate, WIND_NOISE_SIZE } from '../src/nature/wind';

const center = new THREE.Vector3(5, -2, 3);

function onSphere(theta: number, phi: number, r = 30): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)).multiplyScalar(r).add(center);
}

describe('wind field', () => {
  afterEach(() => setWind({ strength: 0.35, speed: 6, direction: new THREE.Vector3(0.94, 0, 0.34), center: new THREE.Vector3() }));

  it('blows along the ground: the wind vector is tangent to the planet everywhere', () => {
    setWind({ strength: 0.8, center });
    const out = new THREE.Vector3();
    for (let i = 0; i < 200; i++) {
      const p = onSphere(Math.acos(1 - 2 * ((i * 0.618) % 1)), i * 2.4);
      windAt(p, i * 0.37, out);
      const up = p.clone().sub(center).normalize();
      expect(Math.abs(out.dot(up))).toBeLessThan(1e-9 + out.length() * 1e-9);
    }
  });

  it('is calm without wind and scales with strength', () => {
    const p = onSphere(1.2, 0.3);
    setWind({ strength: 0, center });
    expect(windAt(p, 3).length()).toBe(0);
    setWind({ strength: 0.25, center });
    const weak = windAt(p, 3).length();
    setWind({ strength: 1, center });
    const strong = windAt(p, 3).length();
    expect(weak).toBeGreaterThan(0);
    expect(strong / weak).toBeCloseTo(4, 5);
  });

  it('mostly follows the prevailing direction and stays in a sane speed range', () => {
    setWind({ strength: 1, center, direction: new THREE.Vector3(1, 0, 0) });
    let along = 0;
    let max = 0;
    const out = new THREE.Vector3();
    for (let i = 0; i < 100; i++) {
      // 赤道带（风向的「两极」在 ±X，这里取离它们远的地方）
      const p = onSphere(Math.PI / 2 + (i % 7) * 0.05, Math.PI / 2 + (i % 5) * 0.1);
      windAt(p, i * 0.5, out);
      along += out.x;
      max = Math.max(max, out.length());
    }
    expect(along / 100).toBeGreaterThan(2);
    expect(max).toBeLessThan(WIND.speed * 2);
  });

  it('gusts: the speed at one spot changes over time, smoothly', () => {
    setWind({ strength: 0.6, center });
    const p = onSphere(1.0, 1.0);
    const out = new THREE.Vector3();
    let lo = Infinity;
    let hi = -Infinity;
    let prev = windAt(p, 0, out).length();
    let maxJump = 0;
    for (let t = 0.02; t < 60; t += 0.02) {
      const s = windAt(p, t, out).length();
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
      maxJump = Math.max(maxJump, Math.abs(s - prev));
      prev = s;
    }
    expect(hi - lo).toBeGreaterThan(0.5);
    expect(maxJump).toBeLessThan(0.15); // 20 ms 一步，没有跳变
    expect(gustAt(p, 1)).toBeGreaterThanOrEqual(0);
    expect(gustAt(p, 1)).toBeLessThanOrEqual(1);
  });

  it('fades out smoothly at the two points where the wind direction pierces the planet (no flip)', () => {
    setWind({ strength: 1, center, direction: new THREE.Vector3(0, 1, 0) });
    const pole = onSphere(0, 0);
    expect(windAt(pole, 2).length()).toBeLessThan(1e-6);
    const near = windAt(onSphere(0.05, 0), 2).length();
    const far = windAt(onSphere(1.2, 0), 2).length();
    expect(near).toBeLessThan(far);
  });

  it('noise sampler wraps like a repeating texture and interpolates between texel centres', () => {
    const n = WIND_NOISE_SIZE;
    for (const [u, v] of [[0.13, 0.77], [0.5, 0.5], [0.999, 0.001]]) {
      expect(sampleWindNoise(u + 3, v - 2, 0)).toBeCloseTo(sampleWindNoise(u, v, 0), 6);
    }
    // 两个像素中心之间的中点 = 两个像素的平均
    const a = sampleWindNoise(10.5 / n, 20.5 / n, 1);
    const b = sampleWindNoise(11.5 / n, 20.5 / n, 1);
    expect(sampleWindNoise(11 / n, 20.5 / n, 1)).toBeCloseTo((a + b) / 2, 6);
  });

  it('wind clock runs faster in stronger wind and never jumps when strength changes', () => {
    setWind({ strength: 0 });
    const t0 = windClock(1e6);
    const t1 = windClock(1e6 + 1);
    expect(t1 - t0).toBeCloseTo(windRate(0), 6);
    setWind({ strength: 1 });
    const t2 = windClock(1e6 + 2);
    expect(t2 - t1).toBeCloseTo(windRate(1), 6);
    expect(windClock(1e6 + 2)).toBe(t2); // 同一时刻多次调用不变
  });
});

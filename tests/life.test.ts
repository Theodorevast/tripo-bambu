import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { B_FLEE, B_REST, BUTTERFLY, ButterflySim, FootstepTracker, octDecode, octEncode, trampleSizeFor, type ButterflyEnv } from '../src/nature/life';

describe('trample map coordinates (octahedral)', () => {
  it('round-trips every direction on the sphere', () => {
    const d = new THREE.Vector3();
    const back = new THREE.Vector3();
    const uv = new THREE.Vector2();
    for (let i = 0; i < 2000; i++) {
      // 斐波那契球面上的点，覆盖两个半球和折缝附近
      const y = 1 - (2 * (i + 0.5)) / 2000;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.399963;
      d.set(Math.cos(a) * r, y, Math.sin(a) * r);
      octEncode(d, uv);
      expect(uv.x).toBeGreaterThanOrEqual(0);
      expect(uv.x).toBeLessThanOrEqual(1);
      expect(uv.y).toBeGreaterThanOrEqual(0);
      expect(uv.y).toBeLessThanOrEqual(1);
      octDecode(uv, back);
      expect(back.distanceTo(d)).toBeLessThan(1e-9);
    }
  });

  it('is continuous: nearby directions land on nearby texels (away from the lower-hemisphere fold)', () => {
    const a = new THREE.Vector3(0.3, 0.8, -0.2).normalize();
    const b = a.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.01);
    const ua = octEncode(a, new THREE.Vector2());
    const ub = octEncode(b, new THREE.Vector2());
    expect(ua.distanceTo(ub)).toBeLessThan(0.02);
  });

  it('map size follows the planet radius (about 0.2 m texels on the high tier), power of two, 256–1024', () => {
    expect(trampleSizeFor(30, 'high')).toBe(512);
    expect(trampleSizeFor(60, 'high')).toBe(1024);
    expect(trampleSizeFor(15, 'high')).toBe(256);
    expect(trampleSizeFor(30, 'low')).toBe(256);
    expect(trampleSizeFor(200, 'high')).toBe(1024);
  });

  it('a 512² map gives about 0.2 m texels on a 30 m planet', () => {
    // 北极附近沿经线走 1 米，贴图坐标走过的像素数
    const d0 = new THREE.Vector3(0, 1, 0);
    const d1 = new THREE.Vector3(0, Math.cos(1 / 30), Math.sin(1 / 30));
    const px = octEncode(d0, new THREE.Vector2()).distanceTo(octEncode(d1, new THREE.Vector2())) * 512;
    expect(1 / px).toBeGreaterThan(0.1);
    expect(1 / px).toBeLessThan(0.35);
  });
});

describe('footsteps', () => {
  it('alternates feet by distance walked and stops when standing still', () => {
    const f = new FootstepTracker(0.45, 0.35);
    let steps = 0;
    const feet: number[] = [];
    for (let i = 0; i < 120; i++) {
      const n = f.advance(1.8, 1 / 60, true);
      for (let k = 0; k < n; k++) feet.push(f.foot);
      steps += n;
    }
    // 2 秒 × 1.8 米/秒 = 3.6 米，0.45 米一步，起步只差 0.4 步：约 8 步
    expect(steps).toBeGreaterThanOrEqual(7);
    expect(steps).toBeLessThanOrEqual(9);
    for (let i = 1; i < feet.length; i++) expect(feet[i]).toBe(-feet[i - 1]);
    // 停下：不再出步
    for (let i = 0; i < 120; i++) expect(f.advance(0.1, 1 / 60, true)).toBe(0);
    // 离地：不出步
    for (let i = 0; i < 60; i++) expect(f.advance(2, 1 / 60, false)).toBe(0);
  });

  it('first step comes soon after starting to walk, independent of frame rate', () => {
    const count = (fps: number) => {
      const f = new FootstepTracker();
      let n = 0;
      for (let i = 0; i < fps; i++) n += f.advance(2, 1 / fps, true);
      return n;
    };
    expect(count(30)).toBe(count(144));
  });
});

describe('butterflies', () => {
  const env: ButterflyEnv = { center: new THREE.Vector3(), ground: () => 30 };

  it('stay near the ground: never below the minimum flight height, never far above', () => {
    const sim = new ButterflySim(12, 3);
    sim.scatter(env, new THREE.Vector3(0, 30, 0), 8);
    const p = new THREE.Vector3();
    for (let f = 0; f < 60 * 40; f++) {
      sim.update(1 / 60, f / 60, env, null, 0, new THREE.Vector3(0, 30, 0));
      for (let i = 0; i < sim.n; i++) {
        const alt = p.fromArray(sim.pos, i * 3).length() - 30;
        if (sim.mode[i] !== B_REST) expect(alt).toBeGreaterThanOrEqual(0.0199);
        expect(alt).toBeLessThan(4);
      }
    }
  });

  it('land now and then (on grass tips when there are no flowers) and rest with wings', () => {
    const sim = new ButterflySim(10, 4);
    sim.scatter(env, new THREE.Vector3(0, 30, 0), 8);
    let rested = 0;
    for (let f = 0; f < 60 * 60; f++) {
      sim.update(1 / 60, f / 60, env, null, 0, null);
      for (let i = 0; i < sim.n; i++) if (sim.mode[i] === B_REST) rested++;
    }
    expect(rested).toBeGreaterThan(60 * 10); // 一分钟里所有蝴蝶加起来至少停了 10 秒
  });

  it('land on a flower when one is nearby', () => {
    const flower = new THREE.Vector3(0, 30.3, 0.5);
    const withFlower: ButterflyEnv = { ...env, flowerNear: (_p, _r, out) => (out.copy(flower), true) };
    const sim = new ButterflySim(4, 5);
    sim.scatter(withFlower, new THREE.Vector3(0, 30, 0), 2);
    let onFlower = false;
    const p = new THREE.Vector3();
    for (let f = 0; f < 60 * 40 && !onFlower; f++) {
      sim.update(1 / 60, f / 60, withFlower, null, 0, null);
      for (let i = 0; i < sim.n; i++) if (sim.mode[i] === B_REST && p.fromArray(sim.pos, i * 3).distanceTo(flower) < 0.05) onFlower = true;
    }
    expect(onFlower).toBe(true);
  });

  it('fly away when the walker comes close, and end up farther away', () => {
    const sim = new ButterflySim(1, 6);
    sim.scatter(env, new THREE.Vector3(0, 30, 0), 2);
    const b = new THREE.Vector3().fromArray(sim.pos, 0);
    // 角色站到蝴蝶正下方旁边
    const walker = b.clone().setLength(30).add(new THREE.Vector3(0.4, 0, 0.4)).setLength(30);
    sim.update(1 / 60, 0, env, walker, 1.5, null);
    expect(sim.mode[0]).toBe(B_FLEE);
    for (let f = 0; f < 90; f++) sim.update(1 / 60, f / 60, env, walker, 1.5, null);
    const after = new THREE.Vector3().fromArray(sim.pos, 0);
    expect(after.distanceTo(walker)).toBeGreaterThan(BUTTERFLY.startle);
  });
});

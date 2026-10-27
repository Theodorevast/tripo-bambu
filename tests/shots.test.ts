import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { SHOWCASE_POLE } from '../src/planet/placement';
import { galaxyFraming, planetFraming, SHOTS } from '../src/scenes/shots';

const defaults = structuredClone(SHOTS);
afterEach(() => {
  Object.assign(SHOTS.galaxy, defaults.galaxy);
  Object.assign(SHOTS.planet, defaults.planet);
});

describe('镜头表：默认值和收进表之前的取景一样', () => {
  it('星系全景：离中心 270、仰角 30°、画面中心压低 25，按 1.6 的宽高比调', () => {
    const f = galaxyFraming(1.6);
    const old = new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)).multiplyScalar(270);
    expect(f.position.distanceTo(old)).toBeLessThan(1e-9);
    expect(f.target.length()).toBe(0);
    expect([f.lift, f.fov, f.minDistance, f.maxDistance, f.autoRotate]).toEqual([-25, 45, 140, 500, true]);
  });

  it('更窄的窗口按比例拉远（距离和远近限制一起乘）', () => {
    const f = galaxyFraming(1);
    expect(f.position.length()).toBeCloseTo(270 * 1.6, 9);
    expect([f.minDistance, f.maxDistance]).toEqual([140 * 1.6, 500 * 1.6]);
  });

  it('星球近景：沿展示方向离星球中心 24、抬头 8.5，绕星球中心转', () => {
    const home = new THREE.Vector3(40, -12, 25);
    const f = planetFraming(home);
    const old = home.clone().addScaledVector(new THREE.Vector3(...SHOWCASE_POLE), 24);
    expect(f.position.distanceTo(old)).toBeLessThan(1e-9);
    expect(f.target.equals(home)).toBe(true);
    expect([f.lift, f.fov, f.minDistance, f.maxDistance, f.autoRotate]).toEqual([8.5, 45, 15, 70, false]);
  });

  it('改了表（?tune 面板）下一次取景就用新值', () => {
    SHOTS.galaxy.distance = 300;
    SHOTS.galaxy.elevation = 45;
    SHOTS.galaxy.fov = 50;
    SHOTS.planet.lift = 4;
    const g = galaxyFraming(1.6);
    expect(g.position.length()).toBeCloseTo(300, 9);
    expect(g.position.y / g.position.length()).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g.fov).toBe(50);
    expect(planetFraming(new THREE.Vector3()).lift).toBe(4);
  });
});

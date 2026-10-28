import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { SHOWCASE_POLE } from '../src/planet/placement';
import { PLANET_RADIUS } from '../src/planet/presets';
import { galaxyScale } from '../src/scenes/layout';
import { galaxyFraming, planetFraming, planetViewDir, SHOTS, workFraming } from '../src/scenes/shots';

const defaults = structuredClone(SHOTS);
afterEach(() => {
  Object.assign(SHOTS.galaxy, defaults.galaxy);
  Object.assign(SHOTS.planet, defaults.planet);
});

describe('镜头表：距离都按星球半径换算', () => {
  it('星系全景：半径 10 时离中心 270、仰角 30°、画面中心压低 25，按 1.6 的宽高比调；星球变大，距离和抬头按 radius / 10 放大', () => {
    for (const radius of [10, 30, 60]) {
      const k = galaxyScale(radius);
      const f = galaxyFraming(1.6, SHOTS.galaxy, radius);
      const old = new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)).multiplyScalar(270 * k);
      expect(f.position.distanceTo(old)).toBeLessThan(1e-9);
      expect(f.target.length()).toBe(0);
      expect([f.lift, f.fov, f.minDistance, f.maxDistance, f.autoRotate]).toEqual([-25 * k, 45, 140 * k, 500 * k, true]);
    }
  });

  it('更窄的窗口按比例拉远（距离和远近限制一起乘）', () => {
    const k = galaxyScale(PLANET_RADIUS);
    const f = galaxyFraming(1);
    expect(f.position.length()).toBeCloseTo(270 * 1.6 * k, 9);
    expect(f.minDistance).toBeCloseTo(140 * 1.6 * k, 9);
    expect(f.maxDistance).toBeCloseTo(500 * 1.6 * k, 9);
  });

  it('星球视图：沿展示方向的方位角、从斜上方 26° 看，离星球中心 2.6 个半径；抬头、远近限制都按半径；镜头不压到水平面 8° 以下', () => {
    const home = new THREE.Vector3(40, -12, 25);
    for (const radius of [15, 30, 60]) {
      const f = planetFraming(home, SHOTS.planet, radius);
      const offset = f.position.clone().sub(home);
      expect(offset.length()).toBeCloseTo(2.6 * radius, 9);
      const dir = offset.normalize();
      expect(THREE.MathUtils.radToDeg(Math.asin(dir.y))).toBeCloseTo(26, 9);
      // 和展示方向在同一个方位角上
      const pole = new THREE.Vector3(...SHOWCASE_POLE);
      expect(Math.atan2(dir.x, dir.z)).toBeCloseTo(Math.atan2(pole.x, pole.z), 9);
      expect(f.target.equals(home)).toBe(true);
      expect(f.lift).toBeCloseTo(0.3 * radius, 9);
      expect([f.minDistance, f.maxDistance]).toEqual([1.35 * radius, 4 * radius]);
      expect(f.maxPolar).toBeCloseTo(THREE.MathUtils.degToRad(82), 9);
      expect(f.autoRotate).toBe(false);
    }
  });

  it('改了表（?tune 面板）下一次取景就用新值', () => {
    SHOTS.galaxy.distance = 300;
    SHOTS.galaxy.elevation = 45;
    SHOTS.galaxy.fov = 50;
    SHOTS.planet.lift = 0.2;
    SHOTS.planet.elevation = 50;
    const g = galaxyFraming(1.6, SHOTS.galaxy, 10);
    expect(g.position.length()).toBeCloseTo(300, 9);
    expect(g.position.y / g.position.length()).toBeCloseTo(Math.SQRT1_2, 9);
    expect(g.fov).toBe(50);
    expect(planetFraming(new THREE.Vector3(), SHOTS.planet, 30).lift).toBeCloseTo(6, 9);
    expect(planetViewDir().y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(50)), 9);
  });

  it('编辑器飞到作品正上方：离星球中心 1.6 个半径，沿作品方向', () => {
    const home = new THREE.Vector3(5, 6, 7);
    const dir = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
    const f = workFraming(home, dir, SHOTS.planet, 30);
    expect(f.position.clone().sub(home).normalize().distanceTo(dir)).toBeLessThan(1e-9);
    expect(f.position.distanceTo(home)).toBeCloseTo(48, 9);
  });
});

import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { SHOWCASE_POLE } from '../src/planet/placement';
import { homeFraming, planetFraming, planetViewDir, SHOTS, workFraming } from '../src/scenes/shots';

const defaults = structuredClone(SHOTS);
afterEach(() => {
  Object.assign(SHOTS.galaxy, defaults.galaxy);
  Object.assign(SHOTS.planet, defaults.planet);
});

describe('镜头表：距离都按星球半径换算', () => {
  it('首页：镜头放在 fitHomeCamera 给的位置，不自转；远近只让拉一点，上下只让转 tilt 度（星球视图的取景不受影响）', () => {
    const cam = { target: new THREE.Vector3(3, -2, 1), position: new THREE.Vector3(3, 40, 300), distance: Math.hypot(42, 299), fov: 40 };
    const f = homeFraming(cam);
    expect(f.target.equals(cam.target)).toBe(true);
    expect(f.position.equals(cam.position)).toBe(true);
    expect(f.target).not.toBe(cam.target); // 给副本
    expect([f.fov, f.autoRotate]).toEqual([40, false]);
    expect(f.minDistance).toBeCloseTo(cam.distance * SHOTS.galaxy.zoomIn, 9);
    expect(f.maxDistance).toBeCloseTo(cam.distance * SHOTS.galaxy.zoomOut, 9);
    const polar = Math.acos(42 / cam.distance);
    const tilt = THREE.MathUtils.degToRad(SHOTS.galaxy.tilt);
    expect(f.minPolar).toBeCloseTo(polar - tilt, 9);
    expect(f.maxPolar).toBeCloseTo(polar + tilt, 9);
  });

  it('星球视图：沿展示方向的方位角、按镜头表的仰角和距离（× 半径）；抬头、远近限制都按半径；镜头不压到水平面 8° 以下', () => {
    const home = new THREE.Vector3(40, -12, 25);
    for (const radius of [15, 30, 60]) {
      const f = planetFraming(home, SHOTS.planet, radius);
      const offset = f.position.clone().sub(home);
      expect(offset.length()).toBeCloseTo(SHOTS.planet.distance * radius, 9);
      const dir = offset.normalize();
      expect(THREE.MathUtils.radToDeg(Math.asin(dir.y))).toBeCloseTo(SHOTS.planet.elevation, 9);
      // 和展示方向在同一个方位角上
      const pole = new THREE.Vector3(...SHOWCASE_POLE);
      expect(Math.atan2(dir.x, dir.z)).toBeCloseTo(Math.atan2(pole.x, pole.z), 9);
      expect(f.target.equals(home)).toBe(true);
      expect(f.lift).toBeCloseTo(SHOTS.planet.lift * radius, 9);
      expect([f.minDistance, f.maxDistance]).toEqual([1.35 * radius, 4 * radius]);
      expect(f.maxPolar).toBeCloseTo(THREE.MathUtils.degToRad(82), 9);
      expect(f.autoRotate).toBe(false);
    }
  });

  it('改了表（?tune 面板）下一次取景就用新值', () => {
    SHOTS.galaxy.zoomIn = 0.5;
    SHOTS.planet.lift = 0.2;
    SHOTS.planet.elevation = 50;
    const g = homeFraming({ target: new THREE.Vector3(), position: new THREE.Vector3(0, 0, 100), distance: 100, fov: 40 });
    expect(g.minDistance).toBeCloseTo(50, 9);
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

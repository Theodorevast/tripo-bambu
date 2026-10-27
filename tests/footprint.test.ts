import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { footprintGroundRadius } from '../src/planet/footprint';
import { makeHeightFn, type HeightFn } from '../src/planet/noise';
import { groundRadius } from '../src/planet/placement';
import { BASE_RADIUS } from '../src/planet/presets';

const flat: HeightFn = () => 10; // 平地：处处半径 10
// 含两极：dir 是 (0, ±1, 0) 时切平面的基底也不能退化
const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, 1], [0.3, -0.5, 0.81]].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize());

describe('footprintGroundRadius', () => {
  it('平地上就是地面半径', () => {
    for (const dir of dirs) expect(footprintGroundRadius(dir, 1, flat, 0)).toBe(10);
  });

  it('凸起只罩住边缘一圈里的一个采样点，也取到凸起的高度', () => {
    for (const dir of dirs) {
      // 先记下实际采样的方向：边缘一圈 8 个，都是单位向量，离中心的球心角 = radius / BASE_RADIUS
      const seen: THREE.Vector3[] = [];
      footprintGroundRadius(dir, 1, (x, y, z) => { seen.push(new THREE.Vector3(x, y, z)); return 10; }, 0);
      const ring = seen.filter((v) => v.angleTo(dir) > 1e-6);
      expect(ring).toHaveLength(8);
      for (const v of ring) {
        expect(v.length()).toBeCloseTo(1, 9);
        expect(v.angleTo(dir)).toBeCloseTo(1 / BASE_RADIUS, 6);
      }
      // 只有其中一个采样点周围 0.02 弧度以内是 11，别处都是 10
      const peak = ring[3];
      expect(seen.filter((v) => v.angleTo(peak) < 0.02)).toHaveLength(1);
      const bump: HeightFn = (x, y, z) => (new THREE.Vector3(x, y, z).angleTo(peak) < 0.02 ? 11 : 10);
      expect(footprintGroundRadius(dir, 1, bump, 0)).toBe(11);
    }
  });

  it('不低于中心的地面半径，两极也一样', () => {
    const height = makeHeightFn(3, 'volcanic');
    for (const dir of dirs) {
      expect(footprintGroundRadius(dir, 2, height, 0)).toBeGreaterThanOrEqual(groundRadius(dir, height, 0));
    }
  });

  it('有海时不低于海平面', () => {
    expect(footprintGroundRadius(new THREE.Vector3(0, 1, 0), 1, flat, 10.5)).toBe(10.5);
  });
});

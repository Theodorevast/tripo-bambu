import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { clampScale, faceYaw, fitToSize, groundRadius, placementTransform, SHOWCASE_POLE, SHOWCASE_UP, WORK_SIZE } from '../src/planet/placement';

const flat = () => 10; // 平地：处处半径 10
const dirs: Array<[number, number, number]> = [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.3, -0.5, 0.81]];

describe('placementTransform', () => {
  it('位置在地表上，模型的「上」对准法线', () => {
    for (const dir of dirs) {
      const { position, quaternion } = placementTransform({ workId: 'w', dir, yaw: 0.7, scale: 1 }, flat, 0);
      const n = new THREE.Vector3(...dir).normalize();
      expect(position.length()).toBeCloseTo(10, 6);
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).distanceTo(n)).toBeLessThan(1e-6);
    }
  });
  it('yaw 只绕法线转，不改变「上」', () => {
    const a = placementTransform({ workId: 'w', dir: [0, 0, 1], yaw: 0, scale: 1 }, flat, 0).quaternion;
    const b = placementTransform({ workId: 'w', dir: [0, 0, 1], yaw: Math.PI / 2, scale: 1 }, flat, 0).quaternion;
    const fa = new THREE.Vector3(1, 0, 0).applyQuaternion(a);
    const fb = new THREE.Vector3(1, 0, 0).applyQuaternion(b);
    expect(Math.abs(fa.dot(fb))).toBeLessThan(1e-6);
  });
  it('有海时落点不低于海平面', () => {
    expect(groundRadius(new THREE.Vector3(0, 1, 0), () => 9.5, 9.8)).toBe(9.8);
    expect(groundRadius(new THREE.Vector3(0, 1, 0), () => 10.2, 9.8)).toBe(10.2);
  });
});

describe('faceYaw', () => {
  it('转完以后模型正面（+Z）朝向目标方向在切平面上的投影', () => {
    for (const dir of dirs) {
      const toward: [number, number, number] = [0.2, 0.9, 0.4];
      const { quaternion } = placementTransform({ workId: 'w', dir, yaw: faceYaw(dir, toward), scale: 1 }, flat, 0);
      const n = new THREE.Vector3(...dir).normalize();
      const t = new THREE.Vector3(...toward);
      const want = t.addScaledVector(n, -t.dot(n)).normalize();
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).distanceTo(want)).toBeLessThan(1e-6);
    }
  });
  it('目标和法线平行时返回 0', () => {
    expect(faceYaw([0, 1, 0], [0, 3, 0])).toBe(0);
  });
  it('SHOWCASE_POLE 是单位向量', () => {
    expect(Math.hypot(...SHOWCASE_POLE)).toBeCloseTo(1, 9);
  });
  it('到达镜头几乎平视星球：展示方向和水平面的夹角不到 10°（往下看时作品背后会排满星系盘里的邻居）', () => {
    expect(Math.abs(SHOWCASE_POLE[1])).toBeLessThan(Math.sin(THREE.MathUtils.degToRad(10)));
  });
  it('SHOWCASE_UP 是单位向量，和展示方向垂直，朝上', () => {
    const up = new THREE.Vector3(...SHOWCASE_UP);
    expect(up.length()).toBeCloseTo(1, 9);
    expect(up.dot(new THREE.Vector3(...SHOWCASE_POLE))).toBeCloseTo(0, 9);
    expect(up.y).toBeGreaterThan(0.9);
  });
});

describe('fitToSize', () => {
  it('最长边缩放到 WORK_SIZE，水平居中，底部贴 y=0', () => {
    const box = new THREE.Box3(new THREE.Vector3(2, -1, 4), new THREE.Vector3(6, 1, 5)); // 4 × 2 × 1
    const { scale, offset } = fitToSize(box);
    expect(scale).toBeCloseTo(WORK_SIZE / 4);
    const min = box.min.clone().multiplyScalar(scale).add(offset);
    const max = box.max.clone().multiplyScalar(scale).add(offset);
    expect(min.y).toBeCloseTo(0);
    expect((min.x + max.x) / 2).toBeCloseTo(0);
    expect((min.z + max.z) / 2).toBeCloseTo(0);
    expect(max.x - min.x).toBeCloseTo(WORK_SIZE);
  });
  it('clampScale 限制在 0.5–2', () => {
    expect(clampScale(0.1)).toBe(0.5);
    expect(clampScale(3)).toBe(2);
    expect(clampScale(1.2)).toBe(1.2);
  });
});

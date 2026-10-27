import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { fitDistance, frameModel } from '../src/museum/framing';
import { WORK_SIZE } from '../src/planet/placement';

// 最坏情况（边长 WORK_SIZE 的立方体，底部在 y=0）的 8 个角都要落在画面里
function expectCubeInFrame(aspect: number): void {
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.05, 100);
  const h = WORK_SIZE / 2;
  frameModel(camera, WORK_SIZE);
  camera.updateMatrixWorld();
  for (const x of [-h, h]) {
    for (const y of [0, WORK_SIZE]) {
      for (const z of [-h, h]) {
        const p = new THREE.Vector3(x, y, z).project(camera);
        expect(Math.abs(p.x)).toBeLessThan(0.95);
        expect(Math.abs(p.y)).toBeLessThan(0.95);
      }
    }
  }
}

describe('frameModel', () => {
  it('最坏情况（边长 WORK_SIZE 的立方体）完整落在方形画面里', () => {
    expectCubeInFrame(1);
  });

  it('竖屏画面（宽高比 0.6）按水平视角取景，最坏情况也完整落在画面里', () => {
    expectCubeInFrame(0.6);
  });

  it('横屏画面的镜头距离和方形一样（竖直视角更窄，按竖直取景）', () => {
    const square = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    const wide = new THREE.PerspectiveCamera(30, 1.8, 0.05, 100);
    expect(fitDistance(wide)).toBeCloseTo(fitDistance(square), 10);
  });
});

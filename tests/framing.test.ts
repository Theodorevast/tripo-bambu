import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { frameModel } from '../src/museum/framing';

describe('frameModel', () => {
  it('最坏情况（最长边 2 的立方体，2×2×2）完整落在方形画面里', () => {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
    frameModel(camera, 2);
    camera.updateMatrixWorld();
    for (const x of [-1, 1]) {
      for (const y of [0, 2]) {
        for (const z of [-1, 1]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          expect(Math.abs(p.x)).toBeLessThan(0.95);
          expect(Math.abs(p.y)).toBeLessThan(0.95);
        }
      }
    }
  });
});

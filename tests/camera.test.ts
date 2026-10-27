import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CameraRig, type Framing } from '../src/scenes/camera';

// OrbitControls 只要能挂事件监听的元素
const fakeCanvas = () => {
  const noop = () => {};
  const doc = { addEventListener: noop, removeEventListener: noop };
  return { addEventListener: noop, removeEventListener: noop, getRootNode: () => doc, ownerDocument: doc, style: {} } as unknown as HTMLElement;
};

const framing = (z: number, fov?: number): Framing => ({ target: new THREE.Vector3(), position: new THREE.Vector3(0, 0, z), minDistance: 1, maxDistance: 1000, autoRotate: false, fov });

describe('CameraRig：飞行按帧的 dt 走，不按墙上时间', () => {
  it('停帧（标签页在后台）多久都不影响：回来后从停下的地方接着飞', async () => {
    const rig = new CameraRig(fakeCanvas());
    rig.jump(framing(100));
    let landed = false;
    void rig.fly(framing(50), 1).then(() => { landed = true; });
    rig.update(0.5);
    const mid = rig.camera.position.z;
    expect(mid).toBeCloseTo(75, 6); // easeInOutCubic(0.5) = 0.5
    // 停帧期间没有 update；回来的第一帧 dt 很小，镜头只前进一帧的量（按墙上时间算的话会直接跳到终点）
    rig.update(1 / 60);
    const t = 0.5 + 1 / 60;
    const ease = 1 - (-2 * t + 2) ** 3 / 2;
    expect(rig.camera.position.z).toBeCloseTo(100 - 50 * ease, 6);
    rig.update(0.5);
    await Promise.resolve();
    expect(rig.camera.position.z).toBeCloseTo(50, 6);
    expect(landed).toBe(true);
    expect(rig.flying).toBe(false);
  });

  it('视角跟着飞行过渡；没写 fov 的取景保持当前视角', () => {
    const rig = new CameraRig(fakeCanvas());
    rig.jump(framing(100, 45));
    void rig.fly(framing(50, 65), 1);
    rig.update(0.5);
    expect(rig.camera.fov).toBeCloseTo(55, 6);
    rig.update(0.5);
    expect(rig.camera.fov).toBe(65);
    rig.jump(framing(80));
    expect(rig.camera.fov).toBe(65);
  });

  it('reframe：飞行中换终点，不在飞时直接跳过去', () => {
    const rig = new CameraRig(fakeCanvas());
    rig.jump(framing(100));
    void rig.fly(framing(50), 1);
    rig.update(0.5);
    rig.reframe(framing(20));
    rig.update(0.5);
    expect(rig.camera.position.z).toBeCloseTo(20, 6);
    rig.reframe(framing(30, 40));
    expect(rig.camera.position.z).toBeCloseTo(30, 6);
    expect(rig.camera.fov).toBe(40);
  });
});

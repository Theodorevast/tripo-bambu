import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { addStudioLights, applyLights, LIGHTS, lightDirection, StudioLights } from '../src/scenes/lights';
import { applyLook, LOOK, useLook } from '../src/scenes/look';

const lightDefaults = structuredClone(LIGHTS);
afterEach(() => {
  LOOK.toneMapping = 'Neutral';
  LOOK.exposure = 1;
  for (const k of ['sky', 'key', 'rim'] as const) Object.assign(LIGHTS[k], lightDefaults[k]);
});

describe('灯光表', () => {
  it('默认方向就是原来的灯位：主光 (40, 60, 80)、轮廓光 (-60, 20, -80)', () => {
    const key = lightDirection(LIGHTS.key.azimuth, LIGHTS.key.elevation);
    const rim = lightDirection(LIGHTS.rim.azimuth, LIGHTS.rim.elevation);
    expect(key.distanceTo(new THREE.Vector3(40, 60, 80).normalize())).toBeLessThan(1e-5);
    expect(rim.distanceTo(new THREE.Vector3(-60, 20, -80).normalize())).toBeLessThan(1e-5);
    expect([LIGHTS.sky.intensity, LIGHTS.key.intensity, LIGHTS.rim.intensity]).toEqual([0.9, 2.4, 1.1]);
  });

  it('addStudioLights 按表摆灯；改表后 applyLights 让已有场景的灯立刻跟着变', () => {
    const scene = new THREE.Scene();
    const rig = addStudioLights(scene);
    expect(rig.parent).toBe(scene);
    expect(rig.key.intensity).toBe(2.4);
    expect(rig.key.position.clone().normalize().distanceTo(new THREE.Vector3(40, 60, 80).normalize())).toBeLessThan(1e-5);
    LIGHTS.key.intensity = 3;
    LIGHTS.key.azimuth = 90;
    LIGHTS.key.elevation = 0;
    LIGHTS.sky.intensity = 0.5;
    applyLights();
    expect(rig.key.intensity).toBe(3);
    expect(rig.key.position.clone().normalize().distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(rig.sky.intensity).toBe(0.5);
  });

  it('一组灯：半球光 + 两盏平行光', () => {
    const rig = new StudioLights();
    expect(rig.children.map((c) => c.type)).toEqual(['HemisphereLight', 'DirectionalLight', 'DirectionalLight']);
  });
});

describe('色调映射和曝光', () => {
  it('useLook 按 LOOK 设好渲染器；改了 LOOK 后 applyLook 更新所有登记过的渲染器', () => {
    const a = { toneMapping: 0, toneMappingExposure: 0 } as unknown as THREE.WebGPURenderer;
    const b = { toneMapping: 0, toneMappingExposure: 0 } as unknown as THREE.WebGPURenderer;
    useLook(a);
    useLook(b);
    expect(a.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(a.toneMappingExposure).toBe(1);
    LOOK.toneMapping = 'AgX';
    LOOK.exposure = 1.4;
    applyLook();
    for (const r of [a, b]) {
      expect(r.toneMapping).toBe(THREE.AgXToneMapping);
      expect(r.toneMappingExposure).toBe(1.4);
    }
  });
});

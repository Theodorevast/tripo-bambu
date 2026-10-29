import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createAtmosphere, seaCeiling } from '../src/nature/atmosphere';
import { NEIGHBOR_REACH, NEIGHBOR_SCALE, sunkInSea } from '../src/scenes/world';

// F2：星球视图里沉进云海的邻居要藏起来（日落时天上的鬼影圈）。
// 云海圆盘以下、离聚焦星球远的地方云海不透明，可是不写深度：被盖住的邻居深度还在，后处理的冷暖按它把云染出一个圈
const R = 30;
const UP = new THREE.Vector3(0, 1, 0);
const params = { seaHeight: -0.18, seaThickness: 0.8 }; // atmosphere 的默认值

describe('云海圆盘的高度（seaCeiling）', () => {
  it('默认参数：云底 + 厚度 + 堆云 + 0.5 米 = 0.59 R + 0.5（星球半径 30 时 18.2 米）', () => {
    expect(seaCeiling(params, R)).toBeCloseTo(0.59 * R + 0.5, 9);
    expect(seaCeiling(params, R, 3)).toBeCloseTo(0.59 * R + 0.5 - 3 * R, 9); // 星系视图压下去 3 个半径
  });

  it('就是 createAtmosphere 摆云海圆盘的高度（聚焦星球、星系视图压低后都对得上）', () => {
    const renderer = {
      initialized: false,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(2880, 1800),
    } as unknown as THREE.WebGPURenderer;
    const atmo = createAtmosphere(new THREE.Scene(), renderer, { planetRadius: R });
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 6000);
    for (const [home, drop] of [[new THREE.Vector3(120, 9, -40), 0], [new THREE.Vector3(0, 0, 0), 3]] as const) {
      atmo.setPlanet(home, R, { seaDrop: drop });
      // 星球视图的镜头：离中心 2.8 个半径、仰角 30°（「上」是世界 +Y）
      cam.position.copy(home).add(new THREE.Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)).multiplyScalar(2.8 * R));
      cam.updateMatrixWorld();
      for (let i = 0; i < 120; i++) atmo.update(1 / 60, cam);
      const h = atmo.objects.sea.position.clone().sub(home).dot(atmo.up);
      expect(h).toBeCloseTo(seaCeiling(atmo.params, R, drop), 6);
    }
    atmo.dispose();
  });
});

describe('邻居沉没没沉（sunkInSea）', () => {
  const ceiling = seaCeiling(params, R);
  const rel = (h: number) => new THREE.Vector3(150, h, -90);
  const bottomAt = (h: number) => h - NEIGHBOR_REACH * R * NEIGHBOR_SCALE;

  it('日落样张里的鬼影圈（kiln-collective，中心低于圆盘 25 米）：沉了', () => {
    expect(sunkInSea(rel(-6.9), UP, R, ceiling, false)).toBe(true);
  });

  it('中心高出圆盘、下半截在圆盘以下（tidepool-atelier，样张右上角被切掉一截）：也算沉了，被盖住的那半截一样留下鬼影', () => {
    expect(21.6).toBeGreaterThan(ceiling);
    expect(bottomAt(21.6)).toBeLessThan(ceiling);
    expect(sunkInSea(rel(21.6), UP, R, ceiling, false)).toBe(true);
  });

  it('整颗浮在圆盘以上：照常画', () => {
    expect(sunkInSea(rel(40), UP, R, ceiling, false)).toBe(false);
  });

  it('藏起来以后要高出圆盘一点才露出来：「上」轻轻晃动时不来回闪', () => {
    const h = ceiling + NEIGHBOR_REACH * R * NEIGHBOR_SCALE + 0.2; // 最低处只比圆盘高 0.2 米
    expect(sunkInSea(rel(h), UP, R, ceiling, false)).toBe(false);
    expect(sunkInSea(rel(h), UP, R, ceiling, true)).toBe(true);
    expect(sunkInSea(rel(h + 1), UP, R, ceiling, true)).toBe(false);
  });

  it('沿「上」量：轨道镜头压低、漫游时「上」斜了，同一颗邻居会沉下去', () => {
    const tilted = new THREE.Vector3(0.3, 1, 0).normalize(); // 往 +X 斜约 17°
    const far = new THREE.Vector3(-200, 45, 0); // 在 −X 那一边
    expect(sunkInSea(far, UP, R, ceiling, false)).toBe(false);
    expect(sunkInSea(far, tilted, R, ceiling, false)).toBe(true);
  });
});

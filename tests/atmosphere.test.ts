import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  AtmosphereFrame,
  FRAME,
  PRESETS,
  TRANSITION_SECONDS,
  bakeCloudNoise,
  blendPalette,
  clonePalette,
  createAtmosphere,
  ease,
  layoutPuffs,
  sunDirection,
  targetUp,
} from '../src/nature/atmosphere';

const R = 30;
const ORIGIN = new THREE.Vector3();
const deg = (rad: number) => THREE.MathUtils.radToDeg(rad);
const angle = (a: THREE.Vector3, b: THREE.Vector3) => deg(a.angleTo(b));
// 镜头相对「上」的仰角（度）
const elevation = (cam: THREE.Vector3, up: THREE.Vector3) => 90 - angle(cam.clone().normalize(), up);

describe('预设', () => {
  it('两套预设的字段一致，颜色和数值都是有限值；日落的太阳更低、更暖', () => {
    expect(Object.keys(PRESETS.sunset).sort()).toEqual(Object.keys(PRESETS.day).sort());
    for (const p of [PRESETS.day, PRESETS.sunset]) {
      for (const v of Object.values(p)) {
        if (v instanceof THREE.Color) expect([v.r, v.g, v.b].every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
        else expect(Number.isFinite(v)).toBe(true);
      }
    }
    expect(PRESETS.sunset.sunElevation).toBeLessThan(PRESETS.day.sunElevation);
    expect(PRESETS.day.sunElevation).toBeLessThan(35); // 低角度
    const warmth = (c: THREE.Color) => c.r / c.b;
    expect(warmth(PRESETS.sunset.sunLight)).toBeGreaterThan(warmth(PRESETS.day.sunLight));
    expect(warmth(PRESETS.day.sunLight)).toBeGreaterThan(1); // 白天的太阳也偏暖
    // 白天：天顶偏蓝，地平线比天顶亮（淡蓝 → 奶白）
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(PRESETS.day.zenith.b).toBeGreaterThan(PRESETS.day.zenith.r);
    expect(lum(PRESETS.day.horizon)).toBeGreaterThan(lum(PRESETS.day.zenith));
  });

  it('blendPalette 在线性空间插值：k = 0 是起点，k = 1 是终点，中间是平均', () => {
    const out = clonePalette(PRESETS.day);
    blendPalette(out, PRESETS.day, PRESETS.sunset, 0);
    expect(out.zenith.equals(PRESETS.day.zenith)).toBe(true);
    blendPalette(out, PRESETS.day, PRESETS.sunset, 1);
    expect(out.zenith.equals(PRESETS.sunset.zenith)).toBe(true);
    expect(out.sunIntensity).toBe(PRESETS.sunset.sunIntensity);
    blendPalette(out, PRESETS.day, PRESETS.sunset, 0.5);
    expect(out.cloudLit.r).toBeCloseTo((PRESETS.day.cloudLit.r + PRESETS.sunset.cloudLit.r) / 2, 6);
    expect(out.exposure).toBeCloseTo((PRESETS.day.exposure + PRESETS.sunset.exposure) / 2, 6);
    // 插值不改动预设本身
    expect(PRESETS.day.zenith.equals(clonePalette(PRESETS.day).zenith)).toBe(true);
  });

  it('过渡曲线两端平缓、单调', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 6);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(ease(0.02)).toBeLessThan(0.001); // 起步很慢，不会一下子跳
  });
});

describe('太阳方向', () => {
  it('方位角从 +Z 转向 +X，高度角往 +Y 抬', () => {
    const v = new THREE.Vector3();
    expect(sunDirection(v, 0, 0).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-9);
    expect(sunDirection(v, 90, 0).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(sunDirection(v, 0, 90).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-9);
    expect(sunDirection(v, 35, 22).length()).toBeCloseTo(1, 9);
  });
});

describe('「上」方向', () => {
  const up = new THREE.Vector3();
  const hint = new THREE.Vector3(0, 1, 0);

  it('轨道视角、镜头在星球上方：就是世界 +Y', () => {
    const cam = new THREE.Vector3(0, 1, 1).normalize().multiplyScalar(4 * R);
    expect(angle(targetUp(up, cam, ORIGIN, R, hint), new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6);
  });

  it('轨道视角、镜头转到赤道或星球下方：「上」倾斜，镜头仰角保持在下限，仍在云海上方', () => {
    for (const elev of [10, 0, -45, -89.9, -90]) {
      const e = THREE.MathUtils.degToRad(elev);
      const cam = new THREE.Vector3(Math.cos(e), Math.sin(e), 0.3).normalize().multiplyScalar(4 * R);
      targetUp(up, cam, ORIGIN, R, hint);
      expect(up.length()).toBeCloseTo(1, 9);
      expect(elevation(cam, up)).toBeCloseTo(FRAME.orbitMinElevation, 4);
    }
  });

  it('贴地视角：就是镜头所在位置的球面法线（径向朝上），在星球哪一面都一样', () => {
    for (const dir of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-0.3, -0.7, 0.6)]) {
      const cam = dir.clone().normalize().multiplyScalar(R + 1.6);
      targetUp(up, cam, ORIGIN, R, hint);
      expect(angle(up, cam.clone().normalize())).toBeLessThan(1e-4);
    }
  });

  it('离地越高越接近轨道视角：中间高度连续过渡，没有跳变', () => {
    const dir = new THREE.Vector3(1, 0.05, 0).normalize();
    let prev: THREE.Vector3 | null = null;
    for (let alt = 0.05 * R; alt < 1.2 * R; alt += 0.01 * R) {
      targetUp(up, dir.clone().multiplyScalar(R + alt), ORIGIN, R, hint);
      if (prev) expect(angle(up, prev)).toBeLessThan(3);
      prev = up.clone();
    }
  });
});

describe('标架（平行移动）', () => {
  it('贴地走一圈，翻过南北两极：「上」和太阳方向逐帧连续，太阳相对「上」的高度角不变', () => {
    const frame = new AtmosphereFrame();
    const sunLocal = sunDirection(new THREE.Vector3(), 35, 22);
    const sun = new THREE.Vector3();
    let prevUp: THREE.Vector3 | null = null;
    let prevSun: THREE.Vector3 | null = null;
    // 沿一条经过两极的大圆走（绕 X 轴转），每帧 1/60 秒、转 0.5°
    for (let i = 0; i <= 720; i++) {
      const a = THREE.MathUtils.degToRad(i * 0.5);
      const cam = new THREE.Vector3(0.1, Math.cos(a), Math.sin(a)).normalize().multiplyScalar(R + 1.6);
      frame.update(1 / 60, cam, ORIGIN, R);
      sun.copy(sunLocal).applyQuaternion(frame.q);
      if (prevUp && prevSun) {
        expect(angle(frame.up, prevUp)).toBeLessThan(1.5);
        expect(angle(sun, prevSun)).toBeLessThan(1.5);
      }
      if (i > 120) expect(90 - angle(sun, frame.up)).toBeCloseTo(22, 3);
      prevUp = frame.up.clone();
      prevSun = sun.clone();
    }
  });

  it('回到轨道视角后，绕「上」的扭转会慢慢回正，太阳回到设定的方位', () => {
    const frame = new AtmosphereFrame();
    // 先贴地绕赤道附近走一大段（会积累绕竖轴的扭转），再升到轨道视角停几秒
    for (let i = 0; i <= 400; i++) {
      const a = THREE.MathUtils.degToRad(i * 0.9);
      frame.update(1 / 60, new THREE.Vector3(Math.cos(a), 0.4, Math.sin(a)).normalize().multiplyScalar(R + 1.5), ORIGIN, R);
    }
    const orbit = new THREE.Vector3(0, 1, 1.4).normalize().multiplyScalar(4 * R);
    for (let i = 0; i < 60 * 12; i++) frame.update(1 / 60, orbit, ORIGIN, R);
    expect(angle(frame.up, new THREE.Vector3(0, 1, 0))).toBeLessThan(0.05);
    const sunLocal = sunDirection(new THREE.Vector3(), 35, 22);
    expect(angle(sunLocal.clone().applyQuaternion(frame.q), sunLocal)).toBeLessThan(0.5);
  });
});

describe('噪声贴图', () => {
  const N = 64;
  const data = bakeCloudNoise(N, 3);
  const at = (x: number, y: number, c: number) => data[(((y + N) % N) * N + ((x + N) % N)) * 4 + c];

  it('尺寸对，四个通道都铺满 0..255 的大部分范围', () => {
    expect(data.length).toBe(N * N * 4);
    for (let c = 0; c < 4; c++) {
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < N * N; i++) {
        lo = Math.min(lo, data[i * 4 + c]);
        hi = Math.max(hi, data[i * 4 + c]);
      }
      expect(lo).toBeLessThan(40);
      expect(hi).toBeGreaterThan(215);
    }
  });

  it('可平铺：跨过贴图边缘的相邻像素差，和贴图内部相邻像素差是一个量级', () => {
    for (let c = 0; c < 4; c++) {
      let inner = 0;
      let seam = 0;
      for (let y = 0; y < N; y++) {
        inner += Math.abs(at(N / 2, y, c) - at(N / 2 - 1, y, c));
        seam += Math.abs(at(0, y, c) - at(N - 1, y, c));
      }
      for (let x = 0; x < N; x++) seam += Math.abs(at(x, 0, c) - at(x, N - 1, c)) / 2;
      expect(seam / N).toBeLessThan(Math.max(6, (inner / N) * 3));
    }
  });

  it('同一个种子结果相同', () => {
    expect(bakeCloudNoise(32, 9)).toEqual(bakeCloudNoise(32, 9));
  });
});

describe('远处积云的布局', () => {
  it('几簇积云围着星球一圈，平底在云海顶面上方，离星球远', () => {
    const puffs = layoutPuffs();
    expect(puffs.length).toBeGreaterThan(30);
    expect(puffs.length).toBeLessThan(200);
    for (const p of puffs) {
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(15);
      expect(p.base).toBeGreaterThan(0);
      expect(p.top).toBeGreaterThan(p.base);
      expect(p.r).toBeGreaterThan(0);
    }
    // 方位角大致铺满一圈
    const az = puffs.map((p) => Math.atan2(p.x, p.z)).sort((a, b) => a - b);
    let maxGap = az[0] + Math.PI * 2 - az[az.length - 1];
    for (let i = 1; i < az.length; i++) maxGap = Math.max(maxGap, az[i] - az[i - 1]);
    expect(deg(maxGap)).toBeLessThan(90);
  });
});

describe('createAtmosphere', () => {
  // 只用到渲染器的这几项（没初始化的渲染器不会去烘环境贴图）
  const fakeRenderer = () =>
    ({
      initialized: false,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(2880, 1800),
    }) as unknown as THREE.WebGPURenderer;

  it('按接口返回主光、太阳方向；物体都加进场景，设好雾；dispose 全部拿走', () => {
    const scene = new THREE.Scene();
    const renderer = fakeRenderer();
    const atmo = createAtmosphere(scene, renderer, { planetRadius: R });
    expect(atmo.sun).toBeInstanceOf(THREE.DirectionalLight);
    expect(atmo.sunDir).toBeInstanceOf(THREE.Vector3);
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    for (const o of Object.values(atmo.objects)) expect(o.parent).toBe(scene);
    expect(atmo.sun.parent).toBe(scene);
    expect((scene as unknown as { fogNode: unknown }).fogNode).toBeTruthy();
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 6000);
    cam.position.set(0, 2 * R, 3 * R);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    atmo.update(1 / 60, cam);
    expect(atmo.sunDir.length()).toBeCloseTo(1, 6);
    // 主光从太阳方向照向星球中心，暖色
    const toLight = atmo.sun.position.clone().sub(atmo.sun.target.position).normalize();
    expect(toLight.distanceTo(atmo.sunDir)).toBeLessThan(1e-6);
    expect(atmo.sun.color.r).toBeGreaterThan(atmo.sun.color.b);
    expect(90 - angle(atmo.sunDir, atmo.up)).toBeCloseTo(PRESETS.day.sunElevation, 3);
    expect(renderer.toneMappingExposure).toBeCloseTo(PRESETS.day.exposure, 6);
    atmo.dispose();
    for (const o of Object.values(atmo.objects)) expect(o.parent).toBeNull();
    expect(atmo.sun.parent).toBeNull();
    expect((scene as unknown as { fogNode: unknown }).fogNode ?? null).toBeNull();
  });

  it('切预设约 2 秒平滑过渡：太阳高度、曝光逐帧变化，到时间正好到位', () => {
    const scene = new THREE.Scene();
    const renderer = fakeRenderer();
    const atmo = createAtmosphere(scene, renderer, { planetRadius: R, preset: 'day' });
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 6000);
    cam.position.set(0, 3 * R, 2 * R);
    cam.updateMatrixWorld();
    atmo.update(1 / 60, cam);
    atmo.setPreset('sunset');
    expect(atmo.preset).toBe('sunset');
    const els: number[] = [];
    for (let t = 0; t < TRANSITION_SECONDS - 1e-6; t += 1 / 60) {
      atmo.update(1 / 60, cam);
      els.push(atmo.params.sunElevation);
    }
    // 过渡中：单调下降，每帧变化不大（没有跳变），中途在两者之间
    for (let i = 1; i < els.length; i++) {
      expect(els[i]).toBeLessThanOrEqual(els[i - 1] + 1e-9);
      expect(els[i - 1] - els[i]).toBeLessThan(0.5);
    }
    const mid = els[Math.floor(els.length / 2)];
    expect(mid).toBeLessThan(PRESETS.day.sunElevation - 2);
    expect(mid).toBeGreaterThan(PRESETS.sunset.sunElevation + 2);
    atmo.update(1 / 60, cam);
    expect(atmo.params.sunElevation).toBeCloseTo(PRESETS.sunset.sunElevation, 6);
    expect(renderer.toneMappingExposure).toBeCloseTo(PRESETS.sunset.exposure, 6);
    expect(atmo.sun.intensity).toBeCloseTo(PRESETS.sunset.sunIntensity, 6);
    atmo.dispose();
  });

  it('setPlanet：云海和主光跟着新星球走（约 1 秒），隐藏后不画天空和云海、雾也撤掉', () => {
    const scene = new THREE.Scene();
    const atmo = createAtmosphere(scene, fakeRenderer(), { planetRadius: R });
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 6000);
    cam.position.set(0, 3 * R, 2 * R);
    cam.updateMatrixWorld();
    atmo.update(1 / 60, cam);
    const home = new THREE.Vector3(500, 20, -300);
    atmo.setPlanet(home, 40);
    cam.position.copy(home).add(new THREE.Vector3(0, 120, 80));
    cam.updateMatrixWorld();
    for (let i = 0; i < 90; i++) atmo.update(1 / 60, cam);
    expect(atmo.sun.target.position.distanceTo(home)).toBeLessThan(1);
    // 云海圆盘在镜头正下方、星球中心以下
    const sea = atmo.objects.sea;
    expect(sea.position.y).toBeLessThan(home.y + 40);
    expect(Math.hypot(sea.position.x - cam.position.x, sea.position.z - cam.position.z)).toBeLessThan(1);
    expect(sea.visible).toBe(true);
    atmo.visible = false;
    atmo.update(1 / 60, cam);
    expect(atmo.objects.sky.visible || atmo.objects.sea.visible || atmo.objects.clouds.visible).toBe(false);
    expect((scene as unknown as { fogNode: unknown }).fogNode ?? null).toBeNull();
    atmo.visible = true;
    atmo.update(1 / 60, cam);
    expect(atmo.objects.sea.visible).toBe(true);
    atmo.dispose();
  });
});

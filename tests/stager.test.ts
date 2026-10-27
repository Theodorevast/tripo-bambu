import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { APPEAR_SECONDS, easeOutBack, Stager } from '../src/scenes/stager';

// 假渲染器：只记下调用顺序（真的要 WebGPU / WebGL2）。compileAsync 时顺便记下每个网格当时的视锥剔除开关
function fakeRenderer() {
  const calls: string[] = [];
  const culledWhileCompiling: boolean[] = [];
  const renderer = {
    initTexture: vi.fn((t: THREE.Texture) => { calls.push(`upload ${t.name}`); }),
    compileAsync: vi.fn(async (object: THREE.Object3D) => {
      object.traverse((o) => { if ((o as THREE.Mesh).isMesh) culledWhileCompiling.push(o.frustumCulled); });
      calls.push('compile');
    }),
  };
  return { renderer: renderer as unknown as THREE.WebGPURenderer, calls, culledWhileCompiling, spies: renderer };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// 推进 n 帧：每帧 tick 一次，再等排队的 Promise 回调跑完
async function frames(stager: Stager, n: number, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    stager.tick(dt);
    await flush();
  }
}

const tex = (name: string) => Object.assign(new THREE.Texture(), { name });

function makeModel(...maps: THREE.Texture[]) {
  const material = new THREE.MeshStandardMaterial({ map: maps[0] ?? null, normalMap: maps[1] ?? null });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  const object = new THREE.Group();
  object.add(mesh);
  return { object, mesh, material };
}

function setup() {
  const f = fakeRenderer();
  const stager = new Stager(f.renderer, new THREE.Scene(), new THREE.PerspectiveCamera());
  return { ...f, stager };
}

describe('Stager：新模型先准备好再挂上', () => {
  it('贴图每帧最多传一张，传完再编译（最终外观和淡入用的半透明外观各一次）；编译时关掉视锥剔除，编完恢复', async () => {
    const { stager, calls, culledWhileCompiling } = setup();
    const m = makeModel(tex('a'), tex('b'));
    let entrance: unknown = undefined;
    void stager.prepare(m.object).then((e) => { entrance = e; });
    await flush();
    expect(calls).toEqual([]);
    await frames(stager, 1);
    expect(calls).toEqual(['upload a']);
    await frames(stager, 1);
    expect(calls).toEqual(['upload a', 'upload b', 'compile', 'compile']);
    expect(culledWhileCompiling).toEqual([false, false]);
    expect(m.mesh.frustumCulled).toBe(true);
    expect(entrance).toBeUndefined(); // 还没轮到它挂上
    await frames(stager, 1);
    expect(entrance).not.toBeNull();
    expect(entrance).toBeDefined();
  });

  it('同一张贴图只传一次：第二个用到它的模型不再等帧上传', async () => {
    const { stager, calls } = setup();
    const shared = tex('shared');
    void stager.prepare(makeModel(shared).object);
    await frames(stager, 3);
    void stager.prepare(makeModel(shared).object);
    await frames(stager, 2);
    expect(calls.filter((c) => c.startsWith('upload'))).toEqual(['upload shared']);
  });

  it('同时到的几个模型排队准备，每帧最多放行一个挂上', async () => {
    const { stager } = setup();
    const got: string[] = [];
    void stager.prepare(makeModel().object).then(() => got.push('first'));
    void stager.prepare(makeModel().object).then(() => got.push('second'));
    await flush();
    await frames(stager, 1);
    expect(got).toEqual(['first']);
    await frames(stager, 1);
    expect(got).toEqual(['first', 'second']);
  });

  it('准备期间不要了（alive() 变成 false）：返回 null，不编译，材质原样', async () => {
    const { stager, spies } = setup();
    const m = makeModel(tex('a'), tex('b'));
    let alive = true;
    let result: unknown = 'pending';
    void stager.prepare(m.object, () => alive).then((e) => { result = e; });
    await frames(stager, 1);
    alive = false;
    await frames(stager, 2);
    expect(result).toBeNull();
    expect(spies.compileAsync).not.toHaveBeenCalled();
    expect(m.mesh.material).toBe(m.material);
  });

  it('挂上后缩放加淡入：期间用半透明的克隆材质、略微过冲；结束时换回原材质、克隆被释放，缩放回到 1', async () => {
    const { stager } = setup();
    const m = makeModel(tex('a'));
    const pending = stager.prepare(m.object);
    await frames(stager, 3);
    const entrance = await pending;
    expect(entrance).not.toBeNull();
    const fade = m.mesh.material as THREE.MeshStandardMaterial;
    expect(fade).not.toBe(m.material);
    expect(fade.transparent).toBe(true);
    expect(fade.map).toBe(m.material.map); // 贴图共用，不再上传一份
    expect(m.material.transparent).toBe(false); // 原材质不动：它那份管线一直留着
    const disposed = vi.fn();
    fade.addEventListener('dispose', disposed);
    entrance!.start();
    let maxScale = 0;
    let lastOpacity = -1;
    const steps = Math.ceil(APPEAR_SECONDS / (1 / 60)) + 1;
    for (let i = 0; i < steps; i++) {
      stager.tick(1 / 60);
      maxScale = Math.max(maxScale, m.object.scale.x);
      if (m.mesh.material === fade) {
        expect(fade.opacity).toBeGreaterThanOrEqual(lastOpacity);
        lastOpacity = fade.opacity;
      }
    }
    expect(maxScale).toBeGreaterThan(1);
    expect(maxScale).toBeLessThan(1.1);
    expect(m.mesh.material).toBe(m.material);
    expect(m.object.scale.x).toBe(1);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('准备好了但不挂（cancel）：换回原材质，释放克隆', async () => {
    const { stager } = setup();
    const m = makeModel();
    const pending = stager.prepare(m.object);
    await flush(); // 没有贴图：不等帧，编译完就排上队
    await frames(stager, 1);
    const entrance = await pending;
    const fade = m.mesh.material as THREE.Material;
    const disposed = vi.fn();
    fade.addEventListener('dispose', disposed);
    entrance!.cancel();
    expect(m.mesh.material).toBe(m.material);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('材质数组：每个材质各有一份淡入克隆，结束时整组换回', async () => {
    const { stager } = setup();
    const mats = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ opacity: 0.5, transparent: true })];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mats);
    const object = new THREE.Group().add(mesh);
    const pending = stager.prepare(object);
    await flush();
    await frames(stager, 1);
    const entrance = await pending;
    expect(Array.isArray(mesh.material)).toBe(true);
    expect((mesh.material as THREE.Material[]).every((m, i) => m !== mats[i] && m.transparent)).toBe(true);
    entrance!.start();
    stager.tick(APPEAR_SECONDS / 2);
    expect((mesh.material as THREE.Material[])[1].opacity).toBeLessThanOrEqual(0.5); // 淡入的终点是原来的不透明度
    stager.tick(APPEAR_SECONDS);
    expect(mesh.material).toBe(mats);
  });
});

describe('easeOutBack', () => {
  it('从 0 到 1，中途略超过 1', () => {
    expect(easeOutBack(0)).toBeCloseTo(0, 12);
    expect(easeOutBack(1)).toBe(1);
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => easeOutBack(i / 100)));
    expect(peak).toBeGreaterThan(1.03);
    expect(peak).toBeLessThan(1.1);
  });
});

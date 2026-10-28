import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { GatedStager } from '../src/scenes/gatedStager';

// 不用真的渲染器：没有贴图的物体不上传贴图，compileAsync 换成立刻完成的假实现（没有投影的光，不编阴影那一遍）
const fakeRenderer = { compileAsync: () => Promise.resolve(), initTexture: () => {} } as unknown as THREE.WebGPURenderer;
const stager = () => new GatedStager(fakeRenderer, new THREE.Scene(), new THREE.PerspectiveCamera());
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
async function frames(s: GatedStager, n: number, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    s.tick(dt);
    await flush();
  }
}

describe('GatedStager：转场里作品先排着，云散开时依次弹出来', () => {
  it('不转场时准备好就出场', async () => {
    const s = stager();
    let got: unknown = null;
    void s.prepare(new THREE.Group()).then((e) => { got = e; });
    await frames(s, 4);
    expect(got).not.toBeNull();
  });

  it('hold 期间准备好的都排着；release 后按顺序、每件隔 stagger 秒出场', async () => {
    const s = stager();
    s.hold();
    const order: number[] = [];
    const at: number[] = [];
    let clock = 0;
    for (let i = 0; i < 3; i++) void s.prepare(new THREE.Group()).then(() => { order.push(i); at.push(clock); });
    for (let i = 0; i < 30; i++) {
      clock += 1 / 60;
      s.tick(1 / 60);
      await flush();
    }
    expect(order).toEqual([]);
    expect(s.queued).toBe(3);
    s.release(0.06);
    const start = clock;
    for (let i = 0; i < 30; i++) {
      clock += 1 / 60;
      s.tick(1 / 60);
      await flush();
    }
    expect(order).toEqual([0, 1, 2]);
    expect(s.holding).toBe(false);
    // 每件隔 60 ms 左右（按帧对齐：差不超过一帧），整体按 60 ms 一件排（不会每次都被帧对齐拖长）
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    for (const g of gaps) expect(Math.abs(g - 0.06)).toBeLessThanOrEqual(1 / 60 + 1e-9);
    expect(Math.abs(at[2] - at[0] - 0.12)).toBeLessThanOrEqual(1 / 60 + 1e-9);
    expect(at[0] - start).toBeLessThanOrEqual(1 / 60 + 1e-9);
    expect(s.releases.length).toBe(3);
  });

  it('排着的时候离开了星球（alive 变成 false）：不出场，交回 null', async () => {
    const s = stager();
    s.hold();
    let alive = true;
    let got: unknown = 'pending';
    void s.prepare(new THREE.Group(), () => alive).then((e) => { got = e; });
    await frames(s, 5);
    alive = false;
    s.release(0.06);
    await frames(s, 5);
    expect(got).toBeNull();
  });
});

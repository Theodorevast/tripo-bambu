import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_FACES, has3D, preloadFonts, settleWithin, stepStates } from '../src/ui/boot';

describe('stepStates', () => {
  it('还没开始：三步都没到', () => {
    expect(stepStates(null)).toEqual(['todo', 'todo', 'todo']);
  });

  it('按阶段推进：之前的完成、当前的进行中、之后的没到', () => {
    expect(stepStates('sky')).toEqual(['now', 'todo', 'todo']);
    expect(stepStates('warm')).toEqual(['done', 'now', 'todo']);
    expect(stepStates('land')).toEqual(['done', 'done', 'now']);
  });
});

describe('settleWithin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('时限内完成：返回 true', async () => {
    await expect(settleWithin(Promise.resolve('x'), 1000)).resolves.toBe(true);
  });

  it('时限内被拒绝：也算完成，不抛', async () => {
    await expect(settleWithin(Promise.reject(new Error('no font')), 1000)).resolves.toBe(true);
  });

  it('超时：到点返回 false，不再等它', async () => {
    vi.useFakeTimers();
    const result = settleWithin(new Promise(() => {}), 300);
    await vi.advanceTimersByTimeAsync(299);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });
});

describe('preloadFonts', () => {
  it('第二版界面的每种字体各要一次（Cinzel、Cormorant Garamond 正体和斜体、Inter）', async () => {
    const load = vi.fn(() => Promise.resolve([]));
    await expect(preloadFonts({ load })).resolves.toBe(true);
    expect(load.mock.calls.map((c: unknown[]) => c[0])).toEqual([...FONT_FACES]);
    // 和 ui/fonts-v2.css 的 @font-face 一致：三套可变字重，Cormorant 的斜体是单独一个文件
    expect(FONT_FACES).toEqual(['600 1em Cinzel', "500 1em 'Cormorant Garamond'", "italic 500 1em 'Cormorant Garamond'", '500 1em Inter']);
  });

  it('有字重加载失败：返回 false，不抛', async () => {
    const load = vi.fn((font: string) => (font.includes('Inter') ? Promise.reject(new Error('offline')) : Promise.resolve([])));
    await expect(preloadFonts({ load })).resolves.toBe(false);
  });

  it('没有 FontFaceSet（很旧的浏览器）：直接返回 false', async () => {
    await expect(preloadFonts(undefined)).resolves.toBe(false);
  });
});

describe('has3D', () => {
  it('拿得到 WebGPU 适配器：不再试 WebGL2', async () => {
    const webgl2 = vi.fn(() => false);
    await expect(has3D({ requestAdapter: () => Promise.resolve({}) }, webgl2)).resolves.toBe(true);
    expect(webgl2).not.toHaveBeenCalled();
  });

  it('没有 WebGPU（navigator.gpu 不存在或适配器是 null），WebGL2 能用', async () => {
    await expect(has3D(undefined, () => true)).resolves.toBe(true);
    await expect(has3D({ requestAdapter: () => Promise.resolve(null) }, () => true)).resolves.toBe(true);
  });

  it('两个都没有：不支持', async () => {
    await expect(has3D(undefined, () => false)).resolves.toBe(false);
    await expect(has3D({ requestAdapter: () => Promise.resolve(null) }, () => false)).resolves.toBe(false);
  });

  it('requestAdapter 抛错、WebGL2 探测抛错：都当作没有', async () => {
    const broken = { requestAdapter: () => Promise.reject(new Error('blocked')) };
    await expect(has3D(broken, () => true)).resolves.toBe(true);
    await expect(has3D(broken, () => { throw new Error('no canvas'); })).resolves.toBe(false);
  });
});

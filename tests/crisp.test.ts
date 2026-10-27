import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { applyAnisotropy, modelTextures } from '../src/assets/models';
import { budgetPixelRatio, MAX_RENDER_PIXELS } from '../src/scenes/world';

describe('像素预算：pixelRatio = min(devicePixelRatio, 2, max(1, √(上限 / (宽 × 高))))', () => {
  it('上限是 4K（3840×2160）', () => {
    expect(MAX_RENDER_PIXELS).toBe(3840 * 2160);
  });
  it('1440×900、1920×1080 的 2 倍屏按原生清晰度画（模型不能糊）', () => {
    expect(budgetPixelRatio(1440, 900, 2)).toBe(2);
    expect(budgetPixelRatio(1920, 1080, 2)).toBe(2);
  });
  it('超大窗口的 2 倍屏才降，渲染像素不超过上限', () => {
    const pr = budgetPixelRatio(2560, 1440, 2);
    expect(pr).toBeLessThan(2);
    expect(2560 * 1440 * pr * pr).toBeCloseTo(MAX_RENDER_PIXELS, 3);
  });
  it('1 倍屏、手机竖屏（390×844、3 倍）只受 2 倍封顶', () => {
    expect(budgetPixelRatio(1440, 900, 1)).toBe(1);
    expect(budgetPixelRatio(1920, 1080, 1)).toBe(1);
    expect(budgetPixelRatio(390, 844, 3)).toBe(2);
  });
  it('再大的窗口也不低于 1 倍（不比原生分辨率糊）', () => {
    expect(budgetPixelRatio(2560, 1440, 1)).toBe(1);
    expect(budgetPixelRatio(7680, 4320, 2)).toBe(1);
  });
  it('尺寸为 0（窗口最小化）时不出 NaN / Infinity', () => {
    expect(budgetPixelRatio(0, 0, 2)).toBe(2);
  });
});

describe('模型贴图的各向异性过滤', () => {
  it('所有材质的所有贴图槽（包括材质数组）都设上；同一张贴图只算一次', () => {
    const shared = new THREE.Texture();
    const a = new THREE.MeshStandardMaterial({ map: shared, normalMap: new THREE.Texture(), roughnessMap: new THREE.Texture() });
    const b = new THREE.MeshPhysicalMaterial({ map: shared, clearcoatMap: new THREE.Texture() });
    const c = new THREE.MeshStandardMaterial({ emissiveMap: new THREE.Texture() });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), a), new THREE.Mesh(new THREE.BoxGeometry(), [b, c]));
    const textures = modelTextures(root);
    expect(textures).toHaveLength(5);
    applyAnisotropy(root, 16);
    expect(textures.every((t) => t.anisotropy === 16)).toBe(true);
  });
  it('没有贴图的模型（占位体、加载失败的灰方块）什么都不做', () => {
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()));
    expect(modelTextures(root)).toEqual([]);
    expect(() => applyAnisotropy(root, 16)).not.toThrow();
  });
});

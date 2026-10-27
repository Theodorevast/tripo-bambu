import { describe, expect, it } from 'vitest';
import { bakeNebula, noiseLayer } from '../src/scenes/nebula';

// 参照值：在浏览器里把 TSL 的 mx_fractal_noise_float(dir × 2.2, 4) 和 mx_fractal_noise_float(dir × 3.1 + 7.3, 3)
// （再 × 0.5 + 0.5）渲染到 1×1 的 float 渲染目标，读回来的结果（WebGPU，float32）
const GPU_REF = [
  { dir: [0, 1, 0], n1: 0.392844, n2: 0.427319 },
  { dir: [0, -1, 0], n1: 0.454742, n2: 0.226579 },
  { dir: [-1, 0, 0], n1: 0.600313, n2: 0.386052 },
  { dir: [0, 0, 1], n1: 0.566619, n2: 0.364746 },
  { dir: [0.3, -0.5, 0.81], n1: 0.45731, n2: 0.627415 },
  { dir: [-0.62, 0.41, -0.67], n1: 0.5545, n2: 0.402937 },
  { dir: [0.9, 0.1, -0.42], n1: 0.721972, n2: 0.449445 },
];

const unit = (d: number[]) => {
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l] as const;
};
// three 的 equirectUV（src/nodes/utils/EquirectUV.js）：方向 → 贴图坐标，天空球采样贴图时用的就是它
const equirectUV = (x: number, y: number, z: number) => [Math.atan2(z, x) / (Math.PI * 2) + 0.5, Math.asin(y) / Math.PI + 0.5];
const toByte = (n: number) => Math.round(Math.min(1, Math.max(0, n * 0.5 + 0.5)) * 255);

describe('星云噪声', () => {
  it('和 GPU 上的 mx_fractal_noise_float 结果一致', () => {
    const n1 = noiseLayer(2.2, 0, 4);
    const n2 = noiseLayer(3.1, 7.3, 3);
    for (const r of GPU_REF) {
      const [x, y, z] = unit(r.dir);
      expect(n1(x, y, z) * 0.5 + 0.5).toBeCloseTo(r.n1, 5);
      expect(n2(x, y, z) * 0.5 + 0.5).toBeCloseTo(r.n2, 5);
    }
  });
});

describe('星云贴图', () => {
  const W = 256;
  const H = 128;
  const data = bakeNebula(W, H);
  const at = (i: number, j: number, c: number) => data[(j * W + i) * 2 + c];

  it('每个像素存的是 equirectUV 查到它的那个方向上的两层噪声', () => {
    expect(data.length).toBe(W * H * 2);
    const n1 = noiseLayer(2.2, 0, 4);
    const n2 = noiseLayer(3.1, 7.3, 3);
    for (const [i, j] of [[0, 0], [W - 1, H - 1], [17, 90], [200, 31], [W / 2, H / 2]]) {
      // 像素中心的经纬度 → 方向
      const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      const [x, y, z] = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      const [u, v] = equirectUV(x, y, z);
      expect(u).toBeCloseTo((i + 0.5) / W, 9);
      expect(v).toBeCloseTo((j + 0.5) / H, 9);
      expect(at(i, j, 0)).toBe(toByte(n1(x, y, z)));
      expect(at(i, j, 1)).toBe(toByte(n2(x, y, z)));
    }
  });

  it('左右边缘接得上：最右一列和最左一列的差不比相邻两列大', () => {
    let seam = 0;
    let inner = 0;
    for (let j = 0; j < H; j++) {
      for (let c = 0; c < 2; c++) {
        seam = Math.max(seam, Math.abs(at(W - 1, j, c) - at(0, j, c)));
        for (let i = 0; i + 1 < W; i++) inner = Math.max(inner, Math.abs(at(i + 1, j, c) - at(i, j, c)));
      }
    }
    expect(seam).toBeLessThanOrEqual(inner);
  });

  it('两极不会捏成放射状：最上、最下一行绕极点一整圈的变化，比别处上下相邻两行的差还小', () => {
    // 最上一行是离极点半个像素高的一小圈；如果噪声是按贴图坐标（而不是 3D 方向）算的，这一圈会和赤道一圈一样起伏很大
    let step = 0;
    for (let j = 0; j + 1 < H; j++) {
      for (let i = 0; i < W; i++) step = Math.max(step, Math.abs(at(i, j + 1, 0) - at(i, j, 0)), Math.abs(at(i, j + 1, 1) - at(i, j, 1)));
    }
    for (const j of [0, H - 1]) {
      for (let c = 0; c < 2; c++) {
        const row = Array.from({ length: W }, (_, i) => at(i, j, c));
        expect(Math.max(...row) - Math.min(...row)).toBeLessThan(step);
      }
    }
  });
});

import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import type { PresetId } from '../data/types';
import { PLANET_RADIUS, PRESETS } from './presets';
import { mulberry32 } from './rng';

// 输入单位向量，返回该方向上地面到球心的距离
export type HeightFn = (x: number, y: number, z: number) => number;

// 地形（planet 角色，按《14-星球视觉效果》的配方）：大陆 = 先扭曲坐标（domain warping）再取 fBm，海岸线才弯得自然；
// 「舞台」那一片（作品摆的地方）一定是平缓的陆地；海岸往外逐渐交给大陆噪声，海湾、半岛、小岛都在舞台以外。
// 归一化高度 n ∈ [-1, 1]：n = 海面 + 海岸曲线(大陆值) + 草甸起伏；半径 = R·(1 + amp·n)。
// 没有水的预设（沙漠、火山）也按同样的大陆形状起伏，低处是盆地（地表着色器画成干湖、灰原），不放水面

// 舞台中心（星球本地方向）：星球视图的镜头从斜上方、展示方向看过来（shots.ts），种子数据里的作品都在这一片
export const STAGE_DIR: [number, number, number] = (() => {
  const v = [0.07, 0.83, 0.55];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

// 可调参数（改了要重建地形：拖半径滑块或刷新页面）
export const TERRAIN = {
  stageInner: 40, // 舞台中心多大一片（球心角，度）完全托成陆地
  stageOuter: 82, // 到这个角度大陆噪声完全接管
  stageLift: 1.1, // 舞台托高多少（加在大陆值上）
  warp: 0.3, // domain warping 的强度（扭曲会把局部空间压缩好几倍，岸边跟着变陡：0.3 以内坡度还平缓）
  warpDetail: 0.3, // 扭曲场里细的那一层占多少
  coast: 0.6, // 海岸的陡度：大陆值每变 1，高度变多少（归一化高度）。小一点浅滩宽、坡缓
  hills: 0.28, // 草甸起伏占「海面以上」的比例
};

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// 过海面时斜率连续的海岸曲线：x = 0 处斜率 k，往两边按 tanh 慢慢饱和到 +top、−bottom
function coastCurve(x: number, k: number, top: number, bottom: number): number {
  return x > 0 ? top * Math.tanh((k * x) / top) : bottom * Math.tanh((k * x) / bottom);
}

// 预设的「海面」：有水的预设就是水面；没有水的预设取一个假想的低地线，按它分出盆地和高地
export function shapeSea(preset: PresetId): number {
  const p = PRESETS[preset];
  return p.sea ?? p.basin;
}

// 半径每次调用时现读 PLANET_RADIUS：滑块拖动后高度跟着变
export function makeHeightFn(seed: number, preset: PresetId): HeightFn {
  const p = PRESETS[preset];
  const noise = new SimplexNoise({ random: mulberry32(seed) });
  const n3 = (x: number, y: number, z: number) => noise.noise3d(x, y, z);
  const sea = shapeSea(preset);
  const up = 1 - sea; // 海面以上的余量
  const down = 1 + sea; // 海面以下的余量
  const top = up * 0.62;
  const bottom = down * 0.8;
  const [sx, sy, sz] = STAGE_DIR;
  const cosIn = Math.cos((TERRAIN.stageInner * Math.PI) / 180);
  const cosOut = Math.cos((TERRAIN.stageOuter * Math.PI) / 180);
  const cf = p.continentFreq;
  const wd = TERRAIN.warpDetail;
  const warp = TERRAIN.warp / (1 + wd);
  const k = TERRAIN.coast;
  const hillAmp = up * TERRAIN.hills;
  const hf = p.freq;
  const ponds = p.sea === null ? [] : stagePonds(seed);
  return (x, y, z) => {
    // 扭曲坐标：三个分量各一组两层噪声（第二层的权重 wd）
    const qx = x * cf;
    const qy = y * cf;
    const qz = z * cf;
    const wx = n3(qx + 5.2, qy + 1.3, qz + 9.1) + n3(qx * 2.1 + 3.7, qy * 2.1 + 8.8, qz * 2.1 + 0.4) * wd;
    const wy = n3(qx + 1.7, qy + 9.2, qz + 4.1) + n3(qx * 2.1 + 6.1, qy * 2.1 + 2.3, qz * 2.1 + 7.9) * wd;
    const wz = n3(qx + 8.3, qy + 2.8, qz + 6.6) + n3(qx * 2.1 + 9.4, qy * 2.1 + 5.5, qz * 2.1 + 1.2) * wd;
    // 大陆：扭曲后的三层 fBm（-1..1）。不要更细的层：岸边的坡度 = coast × 大陆值的梯度，细层会把岸边拉成陡坎
    const ax = qx + warp * wx;
    const ay = qy + warp * wy;
    const az = qz + warp * wz;
    const c = (n3(ax, ay, az) + n3(ax * 2.03 + 11.3, ay * 2.03 + 4.7, az * 2.03 + 2.9) * 0.5
      + n3(ax * 4.11 + 7.1, ay * 4.11 + 13.4, az * 4.11 + 5.3) * 0.22) / 1.72;
    // 舞台托成陆地
    const stage = smooth(cosOut, cosIn, x * sx + y * sy + z * sz);
    const land = c + p.land + TERRAIN.stageLift * stage;
    // 草甸起伏：三层，陆地上（含舞台）全幅，海底收一半
    const h = (n3(x * hf + 31.7, y * hf + 3.1, z * hf + 17.3) + n3(x * hf * 2.07 + 2.2, y * hf * 2.07 + 23.9, z * hf * 2.07 + 8.4) * 0.5
      + n3(x * hf * 4.3 + 19.5, y * hf * 4.3 + 12.6, z * hf * 4.3 + 27.1) * 0.25) / 1.75;
    const wet = smooth(0.05, -0.25, land);
    let n = sea + coastCurve(land, k, top, bottom) + h * hillAmp * (1 - 0.5 * wet);
    // 舞台上的小水塘：碗形往下挖到海面以下 depth，边缘按噪声抖成不规则的形状
    for (const pd of ponds) {
      const cos = x * pd.x + y * pd.y + z * pd.z;
      if (cos < pd.cosReach) continue;
      // 塘坐在一片宽而浅的洼地里（半径的 2.3 倍）：岸是缓坡，不是从草地直接掉进碗里
      const ao = (Math.acos(Math.min(1, cos)) * PLANET_RADIUS) / (pd.radius * 2.3);
      if (ao < 1 && n > sea + 0.08) n += (sea + 0.08 - n) * 0.85 * (0.5 + 0.5 * Math.cos(Math.PI * ao));
      // 几个错开的碗叠在一起（1 − Π(1 − w)，处处光滑），塘是肾形、葫芦形；碗的半径再按噪声伸缩一点，岸线有小弯
      const wob = 1 + 0.12 * n3(x * 12 + pd.ox, y * 12 + pd.oy, z * 12 + pd.oz);
      let dry = 1;
      for (const lb of pd.lobes) {
        const a = (Math.acos(Math.min(1, x * lb.x + y * lb.y + z * lb.z)) * PLANET_RADIUS) / (lb.radius * wob);
        if (a < 1) dry *= 0.5 - 0.5 * Math.cos(Math.PI * a);
      }
      n += (sea - pd.depth - n) * (1 - dry);
    }
    return PLANET_RADIUS * (1 + p.amp * Math.max(-1, Math.min(1, n)));
  };
}

// 水塘：舞台前面（作品那一排的下方、朝着星球视图的镜头）一个，一半的星球在舞台后面再有一个小的。
// 每个塘是 2–3 个错开的碗（lobes，半径按米算）
export interface PondLobe {
  x: number;
  y: number;
  z: number;
  radius: number; // 米（边缘噪声会把它放大到最多 1.2 倍）
}

export interface Pond {
  x: number; // 中心方向
  y: number;
  z: number;
  lobes: PondLobe[];
  radius: number; // 米：外面那片浅洼地按它的 2.3 倍
  depth: number; // 塘底比海面低多少（归一化高度）
  cosReach: number; // 粗筛：和中心的夹角余弦小于它的方向一定不在塘里
  ox: number;
  oy: number;
  oz: number;
}

export function stagePonds(seed: number): Pond[] {
  const rng = mulberry32((seed ^ 0x51ed27) >>> 0);
  const [sx, sy, sz] = STAGE_DIR;
  // 舞台中心的切平面：down 指向更低的纬度（朝镜头的前方），side 是左右
  let dx = -sx * sy;
  let dy = 1 - sy * sy;
  let dz = -sz * sy;
  const dl = Math.hypot(dx, dy, dz);
  dx = -dx / dl;
  dy = -dy / dl;
  dz = -dz / dl;
  const side = [sy * dz - sz * dy, sz * dx - sx * dz, sx * dy - sy * dx];
  const at = (alongDeg: number, sideDeg: number, radius: number, depth: number): Pond => {
    const a = (alongDeg * Math.PI) / 180;
    const b = (sideDeg * Math.PI) / 180;
    let x = sx * Math.cos(a) + dx * Math.sin(a);
    let y = sy * Math.cos(a) + dy * Math.sin(a);
    let z = sz * Math.cos(a) + dz * Math.sin(a);
    x = x * Math.cos(b) + side[0] * Math.sin(b);
    y = y * Math.cos(b) + side[1] * Math.sin(b);
    z = z * Math.cos(b) + side[2] * Math.sin(b);
    const l = Math.hypot(x, y, z);
    x /= l;
    y /= l;
    z /= l;
    // 中心处的切平面基底：错开的碗沿随机方向挪（按半径 30 时的米数换成球心角；换半径时塘的形状跟着等比缩放，够用）
    const t1 = Math.abs(y) < 0.9 ? [z, 0, -x] : [0, -z, y];
    const t1l = Math.hypot(t1[0], t1[1], t1[2]);
    const e1 = [t1[0] / t1l, t1[1] / t1l, t1[2] / t1l];
    const e2 = [y * e1[2] - z * e1[1], z * e1[0] - x * e1[2], x * e1[1] - y * e1[0]];
    const lobe = (off: number, phi: number, r: number): PondLobe => {
      const ang = (off * radius) / 30;
      const tx = e1[0] * Math.cos(phi) + e2[0] * Math.sin(phi);
      const ty = e1[1] * Math.cos(phi) + e2[1] * Math.sin(phi);
      const tz = e1[2] * Math.cos(phi) + e2[2] * Math.sin(phi);
      const lx = x * Math.cos(ang) + tx * Math.sin(ang);
      const ly = y * Math.cos(ang) + ty * Math.sin(ang);
      const lz = z * Math.cos(ang) + tz * Math.sin(ang);
      return { x: lx, y: ly, z: lz, radius: r * radius };
    };
    const phi = rng() * Math.PI * 2;
    const lobes = [lobe(0, 0, 0.9), lobe(0.62, phi, 0.7)];
    if (rng() < 0.6) lobes.push(lobe(0.55, phi + 2 + rng() * 1.5, 0.6));
    // 粗筛按最小的星球半径算（半径 15 时同样的米数对应的球心角最大）
    return { x, y, z, lobes, radius, depth, cosReach: Math.cos((radius * 2.4) / 15), ox: rng() * 50, oy: rng() * 50, oz: rng() * 50 };
  };
  const ponds = [at(25 + rng() * 8, (rng() - 0.5) * 36, 4.5 + rng() * 2, 0.22)];
  if (rng() < 0.55) ponds.push(at(-(24 + rng() * 10), (rng() - 0.5) * 50, 3.2 + rng() * 1.8, 0.2));
  return ponds;
}

// 水面半径；没有水时返回 0
export function seaRadius(preset: PresetId): number {
  const p = PRESETS[preset];
  return p.sea === null ? 0 : PLANET_RADIUS * (1 + p.amp * p.sea);
}

// 半径换算回 [-1, 1]
export function normalizedHeight(r: number, preset: PresetId): number {
  return (r / PLANET_RADIUS - 1) / PRESETS[preset].amp;
}

import * as THREE from 'three/webgpu';
import { abs, dot, exp, float, floor, Fn, fract, If, max, mix, pow, renderGroup, saturate, sin, smoothstep, sqrt, step, time, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { applyGrade, GRADE, type Grade } from '../style/grade';
import type { Palette } from './atmosphere';

// 第二版的夜空（v2-sky）：轻宇宙 · 轻中古。全在着色器里程序化生成，不用贴图（银河、月面的斑借 atmosphere 烘好的那张噪声贴图）。
// - 满天细星：三层 3D 格子（细的密、亮的稀），每格最多一颗，按方向和格子里的星点算距离；大小、亮度、冷暖各不相同，轻轻闪；
//   最亮的那一层带一点十字星芒（贴着画面的横竖方向，像镜头里的星）。星点比一个像素还小时按「总亮度不变」摊开，镜头转动时不闪烁
// - 一条很淡的银河：沿一个大圆的光带，噪声调宽窄和明暗，中间一道暗的尘带，颜色在紫和金之间
// - 月亮：一弯月牙（月相可调）+ 柔和的光晕。首页的月亮钉在画面的一个位置（不挡星系，镜头怎么转都在那里），星球页是世界里的一个方向
// - 云海的月光：上缘朝月亮那一侧的银边、月亮附近被照亮的一圈；首页的云缝里透出下面的星空（星系浮在夜空里，云海只是舞台）
// - 两套夜里的光照预设：蓝调时刻（blue）、月夜（moon），和第一版的白天、日落放在同一张 PRESETS 表里（atmosphere.ts）
// 参数都在 NIGHT_SKY 这一张表里（?tune → Night sky 直接改它，每帧读，立刻生效）。后期（颗粒、暗角、泛光）的参数也在这里（scenes/postGlow.ts 读）

// ---------------------------------------------------------------------------------------------
// 参数表

export const NIGHT_SKY = {
  // —— 星星 ——
  stars: 1, // 亮度倍数
  density: 1, // 多少（× 默认）
  starSize: 1, // 大小倍数
  twinkle: 0.45, // 闪烁的幅度（0 不闪，1 闪到全暗）
  twinkleSpeed: 1, // 闪烁快慢
  spikes: 0.8, // 最亮几颗的十字星芒（0 没有）
  homeStars: 2.2, // 首页的星星再亮多少倍（云缝里透出来，隔着一层薄云）
  // —— 银河 ——
  milkyWay: 0.5, // 浓淡（0 没有）
  milkyWidth: 0.16, // 宽窄（方向余弦）
  milkyTilt: 62, // 星球页：光带所在大圆的法线离竖直方向多少度
  milkyTurn: 35, // 星球页：法线的方位角（度）
  milkyHome: [-1.05, 0.55, 1.05, -0.35] as [number, number, number, number], // 首页：光带在画面上从哪一点到哪一点（NDC，大圆在画面上是直线）
  milkyPurple: '#6a5a9c', // 光带的紫（显示色）
  milkyGold: '#c9a970', // 光带中间偏金的地方
  // —— 月亮 ——
  moonSize: 1, // 视半径倍数（默认约 1.1°）
  moonGlow: 1, // 光晕浓淡
  moonColor: '#f6f1e7', // 月面（Starlight）
  moonHaloColor: '#a9b2de', // 光晕（冷的月光）
  moonTilt: -30, // 月牙的亮边朝哪边（度：0 朝右，90 朝上）
  moonWide: [0.8, 0.57] as [number, number], // 首页（宽屏）：月亮在画面上的位置（NDC，−1..1）
  moonTall: [-0.7, 0.45] as [number, number], // 首页（手机竖屏）：标题卡片下面靠左，那里没有星球
  moonAzimuth: 160, // 星球页：月亮的方位角（度，从 +Z 转向 +X；镜头从展示方向看过去时在画面右上方）
  moonElevation: 21, // 星球页：高度角（度）
  // —— 云海 ——
  homeLit: '#726f9b', // 首页云（月光下）：受光面
  homeMid: '#504d79', // 中间调
  homeShade: '#3f3d69', // 背光
  homeDeep: '#312f5a', // 缝隙
  homeMix: 0.9, // 首页的云往这套颜色靠多少（夜里；白天照旧是暖奶油）
  silver: '#e4e6ff', // 上缘的月光银边（显示色）
  silverK: 1, // 银边浓淡
  silverPow: 3, // 银边多窄（越大越贴着边）
  homeGaps: 0.8, // 首页：云缝里透出星空的程度（0 不透）
  homeThin: 0.22, // 首页：整层云再薄这么多（星星隔着薄云也透得出来）
  planetGaps: 0.12, // 星球页
  gapLo: 0.06, // 云的高度（0 缝底 … 1 云顶）低于这个是全透
  gapHi: 0.6, // 高于这个是不透
  scatter: 1, // 月亮附近的云被照亮
  clear: 0.92, // 月亮那一块云变薄（月亮从云后面透出来）
  clearSize: 2.4, // 变薄的范围（× 月亮半径）
  // —— 光 ——
  ambient: '#1e2546', // 夜里额外的冷色补光（加在环境光上：作品的暗面不发黑）
  ambientK: 1,
  fireflies: 0.8, // 夜里给生机层的「傍晚系数」（≥ 0.5 有萤火虫）
  // —— 后期（scenes/postGlow.ts）——
  grain: 0.03, // 胶片颗粒（0 关）
  grainSize: 1.25, // 颗粒大小（像素）
  grainFps: 24, // 颗粒每秒换几次（像胶片；不是每帧都换，不闪）
  bloom: 0.4, // 泛光浓淡（0 关）
  bloomThreshold: 1.25, // 多亮才泛光（线性、曝光前）
  bloomKnee: 0.8, // 阈值附近的软过渡
  bloomRadius: 1, // 泛光的范围倍数
};

export type NightSkyParams = typeof NIGHT_SKY;

// 第二版的调色（覆盖 style/grade.ts 的 GRADE：第一版的默认值留在那边，方便以后合第一版的更新）：
// 整体偏冷、饱和度收一点（不要糖果色），暗部带一点紫、黑位抬成很深的靛紫，亮部偏暖（香槟金），暗角压成深靛蓝。?tune → Look → Color grade 照旧能调
export const NIGHT_GRADE: Partial<Grade> = {
  warmth: -0.07,
  tint: 0.03,
  saturation: 0.9,
  vibrance: 0,
  contrast: 0.12,
  mids: 0.03,
  lift: 0.022,
  shadowTint: '#3f3a7a',
  shadows: 0.12,
  highlightTint: '#ffd8a6',
  highlights: 0.15,
  vignette: 0.3,
  vignetteTint: '#221e48',
};
Object.assign(GRADE, NIGHT_GRADE);
applyGrade();

// ---------------------------------------------------------------------------------------------
// 显示色 → 线性、曝光前的值：把 three 的 AgX 反过来算（和 atmosphere 的 PRESETS 同一个做法，那边是离线算好写死的，
// 这里现算：?tune 里拾色器给的是「想在画面上看到的颜色」）。不含调色那一段（style/grade.ts），所以只是大致对得上

const m3 = (a: number[], b: number[], c: number[]) => (v: number[]) => [a[0] * v[0] + b[0] * v[1] + c[0] * v[2], a[1] * v[0] + b[1] * v[1] + c[1] * v[2], a[2] * v[0] + b[2] * v[1] + c[2] * v[2]];
const toRec = m3([0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.088], [0.0433, 0.0113, 0.8956]);
const fromRec = m3([1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]);
const inset = m3([0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]);
const outset = m3([1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const contrast = (x: number) => {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};
const srgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// three r186 的 agxToneMapping（ToneMappingFunctions.js）原样搬过来，再转 sRGB
function agxDisplay(c: number[], exposure: number): number[] {
  let v = toRec(c.map((x) => x * exposure));
  v = inset(v).map((x) => clamp((Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393), 0, 1));
  v = outset(v.map(contrast)).map((x) => Math.pow(Math.max(0, x), 2.2));
  return fromRec(v).map((x) => srgb(clamp(x, 0, 1)));
}

const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const _disp = new THREE.Color();

// 牛顿迭代（对 log 值求导，数值雅可比），几十步收敛到 1e-5
export function displayToLinear(hex: string, exposure: number, out = new THREE.Color()): THREE.Color {
  _disp.setStyle(hex, THREE.LinearSRGBColorSpace); // 按原样取 0..1 的分量
  const t = [_disp.r, _disp.g, _disp.b];
  let c = t.map((x) => Math.pow(x, 2.2) * 0.6 + 0.01);
  for (let it = 0; it < 120; it++) {
    const d = agxDisplay(c, exposure);
    const err = d.map((x, i) => x - t[i]);
    if (Math.max(...err.map(Math.abs)) < 2e-5) break;
    const J: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const cc = [...c];
      cc[j] *= 1.001;
      const dd = agxDisplay(cc, exposure);
      J.push(dd.map((x, i) => (x - d[i]) / Math.log(1.001)));
    }
    const A = [[J[0][0], J[1][0], J[2][0]], [J[0][1], J[1][1], J[2][1]], [J[0][2], J[1][2], J[2][2]]];
    const D = det3(A);
    if (Math.abs(D) < 1e-14) break;
    const step3 = [0, 1, 2].map((k) => {
      const m = A.map((r) => [...r]);
      for (let i = 0; i < 3; i++) m[i][k] = -err[i];
      return det3(m) / D;
    });
    c = c.map((x, i) => x * Math.exp(clamp(step3[i], -1, 1)));
  }
  return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}

// ---------------------------------------------------------------------------------------------
// 两套夜里的预设（atmosphere.ts 的 PRESETS 里引用）。天空、云的颜色按显示色写（色板里的名字），换算成线性、曝光前的值；
// 光的颜色、强度直接写线性值

const NIGHT_EXPOSURE = 1.5;
const sky = (hex: string, exposure = NIGHT_EXPOSURE) => displayToLinear(hex, exposure);
const lin = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

// 蓝调时刻：太阳刚落下去，地平线还留一点余晖（Haze rose → Peach），往上 Dusk violet → Indigo → 天顶 Midnight。
// 环境光偏冷，主光是柔和的淡紫白（不硬、不暖）；云是冷灰紫，受光面带一点银
export const BLUE_HOUR: Palette = {
  zenith: sky('#10162f'),
  upper: sky('#2c2d5a'),
  horizon: sky('#5d5582'),
  horizonSun: sky('#b48f97'),
  gradUpper: 0.2,
  gradZenith: 0.72,
  glow: sky('#d9ae96').multiplyScalar(0.55),
  glowStrength: 0.55,
  streaks: 0.12,
  sunDisc: lin(0, 0, 0),
  sunLight: lin(0.8, 0.76, 1),
  sunIntensity: 3.9,
  cloudLit: sky('#8f8cb4'),
  cloudMid: sky('#68658f'),
  cloudShade: sky('#4d4b77'),
  cloudDeep: sky('#3a3862'),
  ground: lin(0.035, 0.04, 0.075),
  envIntensity: 1.7,
  envBelow: 0.6,
  fogDensity: 0.00045,
  exposure: NIGHT_EXPOSURE,
  sunElevation: 14,
  sunAzimuth: 35,
  night: 1,
  stars: 0.75,
  moon: 0.85,
  moonPhase: 0.17,
};

// 月夜：天更深（Midnight → Indigo，地平线是 Dusk violet、Mauve），月亮是主光：冷的蓝白，高一点；星星更多更亮，月亮是一轮凸月
export const MOONLIT: Palette = {
  zenith: sky('#0b1027', 1.55),
  upper: sky('#1b2348', 1.55),
  horizon: sky('#3a3866', 1.55),
  horizonSun: sky('#6f6488', 1.55),
  gradUpper: 0.24,
  gradZenith: 0.75,
  glow: sky('#9aa3cc', 1.55).multiplyScalar(0.4),
  glowStrength: 0.35,
  streaks: 0.08,
  sunDisc: lin(0, 0, 0),
  sunLight: lin(0.7, 0.82, 1),
  sunIntensity: 4.3,
  cloudLit: sky('#949cc2', 1.55),
  cloudMid: sky('#656c94', 1.55),
  cloudShade: sky('#484f77', 1.55),
  cloudDeep: sky('#30365a', 1.55),
  ground: lin(0.025, 0.035, 0.065),
  envIntensity: 1.6,
  envBelow: 0.55,
  fogDensity: 0.0004,
  exposure: 1.55,
  sunElevation: 34,
  sunAzimuth: 28,
  night: 1,
  stars: 1.3,
  moon: 1,
  moonPhase: 0.4,
};

// ---------------------------------------------------------------------------------------------
// uniform（都放 renderGroup：每次 render 刷新一次，和 atmosphere 的一样）

const v3 = () => uniform(new THREE.Vector3()).setGroup(renderGroup);
export const NIGHT_U = {
  night: uniform(0).setGroup(renderGroup), // 0 白天、日落 … 1 夜里（预设之间缓动）
  stars: uniform(1).setGroup(renderGroup), // 星星的亮度（预设 × 表 × 首页）
  density: uniform(1).setGroup(renderGroup),
  size: uniform(1).setGroup(renderGroup),
  twinkle: uniform(0.4).setGroup(renderGroup),
  twinkleSpeed: uniform(1).setGroup(renderGroup),
  spikes: uniform(0.8).setGroup(renderGroup),
  pixel: uniform(0.0005).setGroup(renderGroup), // 一个像素的张角（弧度）
  starCool: v3(),
  starWarm: v3(),
  bandN: v3(), // 银河所在大圆的法线
  bandU: v3(),
  bandV: v3(),
  bandWidth: uniform(0.16).setGroup(renderGroup),
  bandK: uniform(0.5).setGroup(renderGroup),
  bandPurple: v3(),
  bandGold: v3(),
  moon: v3(), // 月亮方向（世界）
  moonX: v3(), // 月面上的横、竖方向（贴着画面）
  moonY: v3(),
  moonLight: v3(), // 照亮月面的方向（月面的本地坐标：x 右、y 上、z 朝镜头）：月相
  moonRadius: uniform(0.019).setGroup(renderGroup),
  moonK: uniform(1).setGroup(renderGroup),
  moonGlowK: uniform(1).setGroup(renderGroup),
  moonColor: v3(),
  moonHalo: v3(),
  rim: v3(), // 云的银边朝哪边亮（月亮的方位、抬高一些：月亮在云层下面时也是照着云顶的边）
  silver: v3(),
  silverPow: uniform(3).setGroup(renderGroup),
  scatter: uniform(1).setGroup(renderGroup),
  gaps: uniform(0).setGroup(renderGroup),
  thin: uniform(0).setGroup(renderGroup),
  gapLo: uniform(0.06).setGroup(renderGroup),
  gapHi: uniform(0.6).setGroup(renderGroup),
  clear: uniform(0).setGroup(renderGroup),
  clearCos: uniform(0.995).setGroup(renderGroup), // 变薄的外沿
  clearCosIn: uniform(0.999).setGroup(renderGroup), // 里面完全变薄
  ambient: v3(), // 加在环境光上的冷色补光（已经乘了夜的系数）
};

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type Noise = THREE.TextureNode;

const LUMA = vec3(0.2126, 0.7152, 0.0722);

// Dave Hoskins 的 hash43：格子坐标 → 4 个 0..1 的随机数（不用 sin，大坐标下也稳定）
function hash43(p: V3): V4 {
  const a = fract(vec4(p.x, p.y, p.z, p.x).mul(vec4(0.1031, 0.103, 0.0973, 0.1099)));
  const b = a.add(dot(a, vec4(a.w, a.z, a.x, a.y).add(33.33)));
  return fract(vec4(b.x, b.x, b.y, b.z).add(vec4(b.y, b.z, b.z, b.w)).mul(vec4(b.z, b.y, b.w, b.x)));
}

interface StarLayer {
  scale: number; // 每单位半径几个格子（格子越小星越密）
  offset: [number, number, number]; // 各层的格子错开
  density: number; // 有星的格子的比例
  size: number; // 星点的大小（弧度，高斯的 σ）
  gain: number; // 亮度
  power: number; // 亮度分布：越大越是少数几颗特别亮
  spikes: boolean; // 带十字星芒
}

// 细的密、中的少、亮的最少；亮度是 HDR（最亮的几颗过了泛光的阈值，后期给一点光晕）
const LAYERS: StarLayer[] = [
  { scale: 210, offset: [0.37, 11.1, 5.3], density: 0.5, size: 0.00018, gain: 1.6, power: 3, spikes: false },
  { scale: 70, offset: [7.7, 3.1, 19.9], density: 0.38, size: 0.00028, gain: 2.6, power: 4, spikes: false },
  { scale: 24, offset: [13.3, 27.7, 2.9], density: 0.3, size: 0.0004, gain: 7, power: 5, spikes: true },
];

// 一层星：方向 d（单位向量）放大到半径 scale 的球上，落在哪个格子就看那个格子里的星点。
// 星点离视线的横向距离给亮度（高斯），离球面的径向距离给「在不在」（不在球面附近的星点不出现：天然的疏密）；
// 星点在格子中间 0.22..0.78 的范围里，最大的光斑（含星芒的尾巴）也不出格子，没有被格子边切掉的半颗星
function starLayer(d: V3, L: StarLayer, boost: F, camRight: V3, camUp: V3): V3 {
  const p = d.mul(L.scale).add(vec3(...L.offset));
  const cell = floor(p);
  const h = hash43(cell);
  const g = fract(vec4(h.w, h.z, h.y, h.x).mul(vec4(37.53, 61.17, 23.91, 47.33)).add(0.31)); // 第二组随机数（亮度、闪烁、冷暖）
  const o = cell.add(vec3(h.x, h.y, h.z).mul(0.56).add(0.22)).sub(p);
  const along = dot(o, d);
  const t = o.sub(d.mul(along));
  const t2 = dot(t, t);
  const pix = NIGHT_U.pixel.mul(L.scale); // 一个像素在这一层里多少个格子
  const size = NIGHT_U.size.mul(L.size * L.scale);
  // 比一个像素小的星：σ 至少 0.7 个像素，亮度按面积压回去（总亮度不变），转动镜头时不会一闪一闪
  const sig = max(size, pix.mul(0.7));
  const core = exp(t2.div(sig.mul(sig)).negate()).mul(size.mul(size).div(sig.mul(sig)));
  const present = smoothstep(0.17, 0.09, abs(along)).mul(step(h.w, NIGHT_U.density.mul(L.density).mul(boost)));
  const bright = pow(g.x, float(L.power)).mul(L.gain).add(L.gain * 0.06);
  const tw = float(1).sub(NIGHT_U.twinkle.mul(sin(time.mul(NIGHT_U.twinkleSpeed).mul(g.y.mul(1.6).add(0.7))).add(g.z.mul(6.283)).mul(0.5).add(0.5)).mul(g.x.mul(0.5).add(0.5)));
  let shape: F = core;
  if (L.spikes) {
    // 十字星芒：贴着画面的横竖方向，长度按像素算；只有这一层里最亮的那些有
    const tx = dot(t, camRight).div(pix);
    const ty = dot(t, camUp).div(pix);
    const arm = (a: F, b: F) => exp(abs(a).div(3.2).negate()).mul(exp(b.mul(b).div(0.3).negate()));
    shape = core.add(arm(tx, ty).add(arm(ty, tx)).mul(NIGHT_U.spikes).mul(smoothstep(0.72, 0.98, g.x)).mul(0.07));
  }
  const color = mix(NIGHT_U.starCool, NIGHT_U.starWarm, smoothstep(0.25, 0.95, g.w));
  return color.mul(shape.mul(present).mul(bright).mul(tw));
}

// 银河：大圆 bandN 附近的一条光带。宽窄、明暗按噪声起伏，中间一道暗的尘带；返回颜色和浓度（浓的地方细星多一些）
function milkyWay(d: V3, noise: Noise): { color: V3; mask: F } {
  const y = dot(d, NIGHT_U.bandN);
  const uv: V2 = vec2(dot(d, NIGHT_U.bandU), dot(d, NIGHT_U.bandV));
  const n1 = noise.sample(uv.mul(0.9).add(vec2(0.13, 0.71))).b;
  const n2 = noise.sample(uv.mul(2.7).add(vec2(0.57, 0.29))).a;
  const w = NIGHT_U.bandWidth.mul(n1.mul(0.8).add(0.55));
  const q = y.div(w);
  const core = exp(q.mul(q).negate());
  const inner = exp(q.mul(q).mul(5).negate());
  const lanes = float(1).sub(smoothstep(0.48, 0.76, n2).mul(inner).mul(0.65));
  const mask = core.mul(n1.mul(0.7).add(0.3)).mul(lanes);
  const color = mix(NIGHT_U.bandPurple, NIGHT_U.bandGold, smoothstep(0.35, 0.85, n2).mul(inner.mul(0.75).add(0.25)));
  return { color: color.mul(mask).mul(NIGHT_U.bandK), mask };
}

// 月亮：一个小球（月面坐标 x、y 贴着画面，z 朝镜头），按月相的光照方向切出月牙，暗的那边留一点地照；
// 月面上借噪声贴图点几块淡淡的斑；外面三层高斯的光晕（θ² ≈ 2(1 − cos θ)）
function moonDisc(d: V3, noise: Noise): { color: V3; mask: F } {
  const R = NIGHT_U.moonRadius;
  const c = dot(d, NIGHT_U.moon);
  const x = dot(d, NIGHT_U.moonX).div(R);
  const y = dot(d, NIGHT_U.moonY).div(R);
  const r2 = x.mul(x).add(y.mul(y));
  const front = step(0, c); // 背面的方向投影到月面上也会落在圆里
  const aa = NIGHT_U.pixel.div(R).mul(1.4);
  const inside = smoothstep(float(1), float(1).sub(aa), sqrt(r2)).mul(front);
  const z = sqrt(max(float(1).sub(r2), 0));
  const lit = smoothstep(-0.05, 0.14, dot(vec3(x, y, z), NIGHT_U.moonLight));
  const spots = noise.sample(vec2(x, y).mul(0.22).add(vec2(0.41, 0.77))).b;
  const surface = float(1).sub(smoothstep(0.42, 0.78, spots).mul(0.2)).mul(z.mul(0.22).add(0.78));
  const disc = NIGHT_U.moonColor.mul(lit.mul(surface).add(0.004)).mul(inside); // 暗的那边只留一点点地照（AgX 的暗部抬得很高，多了就是一块灰盘）
  const th2 = max(float(1).sub(c), 0).mul(2).div(R.mul(R));
  const halo = exp(th2.div(5).negate()).mul(0.45).add(exp(th2.div(49).negate()).mul(0.2)).add(exp(th2.div(900).negate()).mul(0.07));
  const glow = NIGHT_U.moonHalo.mul(halo.mul(NIGHT_U.moonGlowK).mul(front).mul(float(1).sub(inside)));
  return { color: disc.add(glow).mul(NIGHT_U.moonK), mask: inside };
}

// 天空球上叠加的夜空（线性、曝光前，加在天空颜色上）：星星 + 银河 + 月亮。白天、日落（night = 0）整段跳过。
// e：方向和「上」的点积；skyLum：这个方向上天空本来的亮度（余晖亮的地方星星淡）
export function nightLayer(dir: V3, e: F, skyLum: F, camRight: V3, camUp: V3, noise: Noise): V3 {
  return Fn(() => {
    const out = vec3(0).toVar();
    If(NIGHT_U.night.greaterThan(0.001), () => {
      const vis = smoothstep(0.0, 0.13, abs(e)).mul(float(1).sub(smoothstep(0.05, 0.5, skyLum))).toVar();
      const band = milkyWay(dir, noise);
      const moon = moonDisc(dir, noise);
      const boost = float(1).add(band.mask.mul(1.3)).toVar();
      const stars = vec3(0).toVar();
      for (const L of LAYERS) stars.addAssign(starLayer(dir, L, L.scale > 100 ? boost : float(1), camRight, camUp));
      const sum = stars.mul(NIGHT_U.stars).mul(float(1).sub(moon.mask)).add(band.color).mul(vis).add(moon.color);
      out.assign(sum.mul(NIGHT_U.night));
    });
    return out;
  })();
}

// 地平线以下的夜空（首页的云缝里透出来的那一片）：从地平线的雾色往下过渡到 Dusk violet、Indigo，最深处是 Midnight
export function underSky(e: F, hz: V3, upper: V3, zenith: V3): V3 {
  const d = e.negate();
  return mix(mix(hz, upper, smoothstep(0.0, 0.3, d)), zenith, smoothstep(0.2, 0.85, d));
}

// 云海的月光（加在云的颜色上，空气透视之前）：上缘朝月亮那一侧的银边（掠射角大、法线朝 rim 方向、在云顶那一截），
// 加上月亮附近的云被照亮的一圈。n：云面法线；dir：视线；k：云的相对高度（0 缝底 … 1 云顶）
export function seaMoonlight(n: V3, dir: V3, k: F): V3 {
  const facing = saturate(dot(n, NIGHT_U.rim).mul(0.6).add(0.4));
  const fres = pow(float(1).sub(saturate(dot(n, dir.negate()))), NIGHT_U.silverPow);
  const silver = NIGHT_U.silver.mul(fres.mul(facing.mul(facing)).mul(smoothstep(0.3, 0.9, k)));
  const c = saturate(dot(dir, NIGHT_U.moon));
  const scatter = NIGHT_U.moonHalo.mul(pow(c, 90).mul(0.35).add(pow(c, 10).mul(0.12)).mul(NIGHT_U.scatter).mul(NIGHT_U.moonK));
  return silver.add(scatter).mul(NIGHT_U.night);
}

// 云海的不透明度再乘的系数：缝里（k 低）透出下面的星空，月亮那一块变薄（月亮从云后面透出来）。白天是 1
export function seaNightAlpha(k: F, dir: V3): F {
  const gap = float(1).sub(smoothstep(NIGHT_U.gapLo, NIGHT_U.gapHi, k)).mul(NIGHT_U.gaps);
  const clear = smoothstep(NIGHT_U.clearCos, NIGHT_U.clearCosIn, dot(dir, NIGHT_U.moon)).mul(NIGHT_U.clear);
  return float(1).sub(max(max(gap, clear), NIGHT_U.thin).mul(NIGHT_U.night));
}

// 天空在这个方向上的亮度（给 nightLayer 的 skyLum）
export const skyLuma = (c: V3): F => dot(c, LUMA);

// ---------------------------------------------------------------------------------------------
// 每帧（atmosphere.update 里调）：表 → uniform，月亮、银河的方向

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _home = new THREE.Vector3();
const _planet = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _upCam = new THREE.Vector3();
const _n = new THREE.Vector3();
const _np = new THREE.Vector3();
const _c = new THREE.Color();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();

// 首页云的四个颜色（线性），表里的显示色变了才重算
const homeCloud = { lit: new THREE.Vector3(), mid: new THREE.Vector3(), shade: new THREE.Vector3(), deep: new THREE.Vector3() };
const silverBase = new THREE.Vector3();
const ambientBase = new THREE.Vector3();
let colorKey = '';

function setColor(u: { value: THREE.Vector3 }, hex: string, k = 1, exposure = NIGHT_EXPOSURE): void {
  displayToLinear(hex, exposure, _c);
  u.value.set(_c.r * k, _c.g * k, _c.b * k);
}

// 表里的颜色 → uniform（换算要几十步牛顿迭代：只在表改了时做）
function applyColors(): void {
  const s = NIGHT_SKY;
  const key = [s.moonColor, s.moonHaloColor, s.milkyPurple, s.milkyGold, s.silver, s.ambient, s.homeLit, s.homeMid, s.homeShade, s.homeDeep].join();
  if (key === colorKey) return;
  colorKey = key;
  // 星星的冷暖：Starlight 两边各偏一点（亮度在着色器里另乘）
  NIGHT_U.starCool.value.set(0.78, 0.86, 1.15);
  NIGHT_U.starWarm.value.set(1.15, 0.98, 0.78);
  setColor(NIGHT_U.moonColor, s.moonColor, 0.75);
  setColor(NIGHT_U.moonHalo, s.moonHaloColor, 0.55);
  setColor(NIGHT_U.bandPurple, s.milkyPurple, 0.35);
  setColor(NIGHT_U.bandGold, s.milkyGold, 0.3);
  setColor({ value: silverBase }, s.silver, 0.32);
  setColor({ value: ambientBase }, s.ambient);
  for (const k of ['lit', 'mid', 'shade', 'deep'] as const) {
    const hex = { lit: s.homeLit, mid: s.homeMid, shade: s.homeShade, deep: s.homeDeep }[k];
    displayToLinear(hex, NIGHT_EXPOSURE, _c);
    homeCloud[k].set(_c.r, _c.g, _c.b);
  }
}

// 首页的云在夜里往这套颜色靠（atmosphere 的 CALM_CREAM 是白天那套）
export function homeNightCloud(which: 'lit' | 'mid' | 'shade' | 'deep'): THREE.Vector3 {
  applyColors();
  return homeCloud[which];
}

// 方位角、高度角（度）→ 单位方向（和 atmosphere 的 sunDirection 同一个约定：方位角从 +Z 转向 +X）
function direction(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// 画面上的一点（NDC）→ 世界里的方向
function screenDir(out: THREE.Vector3, camera: THREE.Camera, x: number, y: number): THREE.Vector3 {
  return out.set(x, y, 0.5).unproject(camera).sub(_camPos).normalize();
}

export interface NightFrameInput {
  camera: THREE.Camera;
  frameQ: THREE.Quaternion; // atmosphere 的标架（「上」跟着镜头转）
  up: THREE.Vector3;
  look: Palette; // 现在用的配色（含预设过渡、雨）
  calm: number; // 0 星球页 … 1 首页
  pixelAngle: number; // 一个像素的张角（弧度）
}

export function updateNightSky(f: NightFrameInput): void {
  applyColors();
  const s = NIGHT_SKY;
  const U = NIGHT_U;
  const night = THREE.MathUtils.clamp(f.look.night, 0, 1);
  const calm = THREE.MathUtils.clamp(f.calm, 0, 1);
  U.night.value = night;
  U.stars.value = Math.max(0, f.look.stars * s.stars * (1 + (s.homeStars - 1) * calm));
  U.density.value = Math.max(0, s.density);
  U.size.value = Math.max(0.05, s.starSize);
  U.twinkle.value = THREE.MathUtils.clamp(s.twinkle, 0, 1);
  U.twinkleSpeed.value = Math.max(0, s.twinkleSpeed) * 1.3;
  U.spikes.value = Math.max(0, s.spikes);
  U.pixel.value = f.pixelAngle;
  U.bandWidth.value = Math.max(0.01, s.milkyWidth);
  U.bandK.value = Math.max(0, s.milkyWay);
  U.moonRadius.value = 0.019 * Math.max(0.1, s.moonSize);
  U.moonK.value = Math.max(0, f.look.moon);
  U.moonGlowK.value = Math.max(0, s.moonGlow);
  U.silverPow.value = Math.max(0.5, s.silverPow);
  U.scatter.value = Math.max(0, s.scatter);
  U.gaps.value = THREE.MathUtils.clamp(s.planetGaps + (s.homeGaps - s.planetGaps) * calm, 0, 1);
  U.thin.value = THREE.MathUtils.clamp(s.homeThin, 0, 1) * calm;
  U.gapLo.value = s.gapLo;
  U.gapHi.value = Math.max(s.gapLo + 0.01, s.gapHi);
  U.clear.value = THREE.MathUtils.clamp(s.clear, 0, 1) * calm;
  U.clearCos.value = Math.cos(U.moonRadius.value * Math.max(1.2, s.clearSize));
  U.clearCosIn.value = Math.cos(U.moonRadius.value * 1.12);
  U.silver.value.copy(silverBase).multiplyScalar(Math.max(0, s.silverK));
  U.ambient.value.copy(ambientBase).multiplyScalar(Math.max(0, s.ambientK) * night);

  const cam = f.camera as THREE.PerspectiveCamera;
  cam.getWorldPosition(_camPos);
  cam.getWorldQuaternion(_camQ);
  _right.set(1, 0, 0).applyQuaternion(_camQ);
  _upCam.set(0, 1, 0).applyQuaternion(_camQ);

  // 月亮：首页钉在画面上的一点（宽屏、竖屏各一个位置），星球页是标架里的方位角、高度角；中间按 calm 过渡（转场的云层盖着）
  const tall = (cam.aspect ?? 1.6) < 0.95;
  const [mx, my] = tall ? s.moonTall : s.moonWide;
  screenDir(_home, cam, mx, my);
  direction(_planet, s.moonAzimuth, s.moonElevation).applyQuaternion(f.frameQ);
  const moon = U.moon.value.copy(_planet).lerp(_home, calm);
  if (moon.lengthSq() < 1e-6) moon.copy(_home);
  moon.normalize();
  // 月面的横竖方向贴着画面；月相：照亮月面的方向（本地坐标），亮边朝 moonTilt
  const my3 = U.moonY.value.copy(_upCam).addScaledVector(moon, -_upCam.dot(moon));
  if (my3.lengthSq() < 1e-8) my3.copy(_right).cross(moon);
  my3.normalize();
  U.moonX.value.crossVectors(moon, my3).normalize();
  const ph = THREE.MathUtils.clamp(f.look.moonPhase, 0, 0.5) * Math.PI * 2;
  const tilt = THREE.MathUtils.degToRad(s.moonTilt);
  U.moonLight.value.set(Math.sin(ph) * Math.cos(tilt), Math.sin(ph) * Math.sin(tilt), -Math.cos(ph));
  // 云的银边：月亮的方位，抬到 25° 左右（首页的月亮在云层下面，也是照着云顶朝它那一侧的边）
  _a.copy(moon).addScaledVector(f.up, -moon.dot(f.up));
  if (_a.lengthSq() < 1e-6) _a.copy(_right);
  _a.normalize();
  U.rim.value.copy(_a).addScaledVector(f.up, 0.45).normalize();

  // 银河：首页按画面上的两点定一个大圆（在画面上是一条直线），星球页按标架里的倾角、方位
  const [x1, y1, x2, y2] = s.milkyHome;
  screenDir(_p1, cam, x1, y1);
  screenDir(_p2, cam, x2, y2);
  _n.crossVectors(_p1, _p2).normalize();
  const tiltN = THREE.MathUtils.degToRad(s.milkyTilt);
  const turnN = THREE.MathUtils.degToRad(s.milkyTurn);
  _np.set(Math.sin(tiltN) * Math.sin(turnN), Math.cos(tiltN), Math.sin(tiltN) * Math.cos(turnN)).applyQuaternion(f.frameQ);
  if (_n.dot(_np) < 0) _n.negate();
  const bn = U.bandN.value.copy(_np).lerp(_n, calm);
  if (bn.lengthSq() < 1e-6) bn.copy(_np);
  bn.normalize();
  _b.copy(Math.abs(bn.dot(f.up)) < 0.95 ? f.up : _right);
  U.bandU.value.crossVectors(bn, _b).normalize();
  U.bandV.value.crossVectors(bn, U.bandU.value).normalize();
}

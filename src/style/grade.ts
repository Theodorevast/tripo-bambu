import * as THREE from 'three/webgpu';
import { dot, float, floor, fract, interleavedGradientNoise, length, max, min, mix, smoothstep, uniform, vec2, vec3 } from 'three/tsl';

// 主画面的调色（绘本感）：分两段，都在后处理最后一步（scenes/post.ts）里做，不采样邻近像素、不模糊贴图。
// 1. 场景线性（色调映射之前）：白平衡偏暖一点；饱和度和「自然饱和度」——越灰的颜色加得越多，草和天先变鲜，
//    本来就鲜的颜色（翠宝黄、作品的贴图）动得少。AgX 会把亮色往白里压，在它前面加饱和，颜色鲜但不会溢出去
// 2. 显示空间（色调映射和 sRGB 之后，0..1）：柔和的 S 曲线；暗部偏蓝紫、亮部偏奶油金（分离色调，不改亮度）；
//    黑位抬一点（像印在纸上，不死黑）；四角压暗一点、偏暖紫（不是黑）；可选的纸纹；最后加 ±1/255 的抖动，天空渐变没有色带
// 参数都是 uniform：?tune 改 GRADE 再调 applyGrade() 立刻生效，不重新编译着色器

export const GRADE_DEFAULTS = {
  warmth: 0.12, // 白平衡：正数偏暖，-1..1
  tint: 0, // 正数偏品红、负数偏绿，-1..1
  saturation: 1.08, // 整体饱和度（1 不变）
  vibrance: 0.3, // 自然饱和度：越灰的颜色加得越多
  contrast: 0.16, // S 曲线的强度（0 不变，1 是完整的 smoothstep）
  lift: 0.018, // 黑位抬高（显示空间）
  shadowTint: '#6a5fd0', // 暗部偏的颜色（蓝紫）
  shadows: 0.1, // 暗部偏色的量
  highlightTint: '#ffd08c', // 亮部偏的颜色（奶油金）
  highlights: 0.07, // 亮部偏色的量
  vignette: 0.2, // 四角压暗的量（0 关）
  vignetteTint: '#5d4567', // 压暗时乘的颜色（暖紫）
  paper: 0, // 纸纹的强度（0 关；0.02–0.04 能看出来）
  dither: 1, // 抖动（0 关）
};

export type Grade = typeof GRADE_DEFAULTS;
export const GRADE: Grade = { ...GRADE_DEFAULTS };

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const LUMA = vec3(0.2126, 0.7152, 0.0722);

const U = {
  balance: uniform(new THREE.Vector3(1, 1, 1)), // 白平衡的三通道增益（按亮度归一，不改亮度）
  saturation: uniform(1),
  vibrance: uniform(0),
  contrast: uniform(0),
  lift: uniform(new THREE.Vector3()), // 黑位抬到的颜色
  shadowShift: uniform(new THREE.Vector3()), // 暗部加的偏移（亮度为 0 的偏移，只改色相）
  highlightShift: uniform(new THREE.Vector3()),
  vignette: uniform(0),
  vignetteTint: uniform(new THREE.Vector3(1, 1, 1)),
  paper: uniform(0),
  dither: uniform(1),
};

// 显示空间的颜色：十六进制按原样取 0..1 的分量（不转线性）
const raw = new THREE.Color();
function displayRgb(hex: string, out: THREE.Vector3): THREE.Vector3 {
  raw.setStyle(hex, THREE.LinearSRGBColorSpace);
  return out.set(raw.r, raw.g, raw.b);
}

// 去掉亮度的偏移：(颜色 − 0.5) 减掉它自己的亮度，加上去只改色相、不改明暗
const _v = new THREE.Vector3();
function hueShift(hex: string, amount: number, out: THREE.Vector3): void {
  displayRgb(hex, _v).subScalar(0.5);
  const l = _v.x * 0.2126 + _v.y * 0.7152 + _v.z * 0.0722;
  out.copy(_v).subScalar(l).multiplyScalar(amount);
}

// GRADE 表 → uniform（?tune 改了表以后调）
export function applyGrade(): void {
  const g = GRADE;
  const r = 1 + 0.12 * g.warmth + 0.03 * g.tint;
  const gr = (1 + 0.02 * g.warmth) * (1 - 0.08 * g.tint);
  const b = 1 - 0.16 * g.warmth + 0.03 * g.tint;
  const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  U.balance.value.set(r / l, gr / l, b / l);
  U.saturation.value = g.saturation;
  U.vibrance.value = g.vibrance;
  U.contrast.value = g.contrast;
  displayRgb(g.shadowTint, U.lift.value).multiplyScalar(g.lift * 2);
  hueShift(g.shadowTint, g.shadows, U.shadowShift.value);
  hueShift(g.highlightTint, g.highlights, U.highlightShift.value);
  U.vignette.value = g.vignette;
  displayRgb(g.vignetteTint, U.vignetteTint.value);
  U.paper.value = g.paper;
  U.dither.value = g.dither;
}
applyGrade();

// 场景线性的一段：白平衡 → 饱和度 / 自然饱和度
export function gradeLinear(color: V3): V3 {
  const c = color.mul(U.balance).toVar();
  const l = dot(c, LUMA);
  const hi = max(c.r, max(c.g, c.b));
  const lo = min(c.r, min(c.g, c.b));
  const sat = hi.sub(lo).div(hi.add(1e-4)); // 0 灰 … 1 纯色
  const k = U.saturation.mul(float(1).add(U.vibrance.mul(float(1).sub(sat))));
  return max(mix(vec3(l), c, k), vec3(0));
}

// 值噪声（纸纹、日落光束的条纹用）：格点哈希 + 平滑插值
const hash2 = (p: V2): F => fract(dot(p, vec2(0.1031, 0.1137)).mul(fract(dot(p, vec2(0.0973, 0.1099))).add(3.33)).mul(43.7585));
export function valueNoise(p: V2): F {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash2(i);
  const b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1)));
  const d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 显示空间的一段。color：色调映射和 sRGB 之后的颜色；uv：画面坐标 0..1；pixel：像素坐标（抖动、纸纹用）
export function gradeDisplay(color: V3, uv: V2, pixel: V2): V3 {
  const c0 = color.clamp(0, 1).toVar();
  // 柔和的 S 曲线：两端不动，中间调对比高一点
  const s = c0.mul(c0).mul(float(3).sub(c0.mul(2)));
  const c = mix(c0, s, U.contrast).toVar();
  // 分离色调：按亮度分暗部、亮部，各加一个不改亮度的色相偏移
  const l = dot(c, LUMA);
  c.addAssign(U.shadowShift.mul(float(1).sub(smoothstep(0.0, 0.6, l))));
  c.addAssign(U.highlightShift.mul(smoothstep(0.45, 1.0, l)));
  // 黑位抬高：0 → lift，1 → 1
  c.assign(U.lift.add(c.mul(vec3(1).sub(U.lift))));
  // 四角压暗：画面坐标 [-1, 1]，角上是 1；乘一个暖紫色
  const q = uv.sub(0.5).mul(2);
  const v = smoothstep(0.42, 1.15, length(q).mul(0.7071)).mul(U.vignette);
  c.assign(mix(c, c.mul(U.vignetteTint), v));
  // 纸纹：两种尺度的值噪声（纤维和斑），乘在颜色上；固定在屏幕上，强度很小
  const paper = valueNoise(pixel.mul(0.45)).mul(0.6).add(valueNoise(pixel.mul(0.045)).mul(0.4)).sub(0.5);
  c.assign(c.mul(float(1).add(paper.mul(U.paper))));
  // 三角分布的抖动：±1/255
  const n = interleavedGradientNoise(pixel).add(interleavedGradientNoise(pixel.add(vec2(37.1, 17.3)))).sub(1);
  return c.add(n.mul(U.dither).div(255));
}

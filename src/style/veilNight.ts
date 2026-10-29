import * as THREE from 'three/webgpu';
import { abs, dot, exp, float, floor, fract, max, mix, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl';
import { NIGHT_U } from '../nature/nightSky';

// 转场云层的第二版（v2-sky，接进 style/veil.ts）：
// - 月光的银边：云团朝光那一侧的边缘亮一圈冷银色（夜里的预设才有，白天、日落照旧）
// - 扫过的那道光：原来是一宽一窄两道翠宝黄的光带，改成一条很细的香槟金线 + 跟在后面的一串星尘（一闪一闪、往后慢慢淡），
//   线本身是 HDR 的亮金，后期的泛光（scenes/postGlow.ts）给它一圈柔光。时刻、时长、扫的方向都不变（分镜表的 flashAt、flashMs）
// 参数在下面的 VEIL_NIGHT 表（?tune → Night sky → Transition）

export const VEIL_NIGHT = {
  silver: 0.9, // 云团亮边的银色浓淡
  line: '#e2c98f', // 金线的颜色（Champagne gold，显示色）
  lineGlow: 2.6, // 金线的亮度（HDR，过泛光的阈值）
  width: 1.4, // 金线多宽（像素）
  halo: 0.012, // 金线两边的柔光多宽（画面高度的比例）
  dust: 1, // 星尘浓淡（0 没有）
  trail: 0.22, // 星尘拖在金线后面多长（画面高度的比例）
};

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

export const VEIL_NIGHT_U = {
  silver: uniform(0.9),
  gold: uniform(new THREE.Vector3(2.2, 1.6, 0.75)),
  width: uniform(1.4),
  halo: uniform(0.012),
  dust: uniform(1),
  trail: uniform(0.22),
};

const _c = new THREE.Color();

// 表 → uniform（模块加载时调一次；?tune → Night sky → Transition 改了表以后再调）
export function applyVeilNight(): void {
  const t = VEIL_NIGHT;
  VEIL_NIGHT_U.silver.value = Math.max(0, t.silver);
  _c.set(t.line); // 显示色 → 线性（three 的 Color 默认按 sRGB 解析）
  VEIL_NIGHT_U.gold.value.set(_c.r, _c.g, _c.b).multiplyScalar(Math.max(0, t.lineGlow));
  VEIL_NIGHT_U.width.value = Math.max(0.3, t.width);
  VEIL_NIGHT_U.halo.value = Math.max(0.001, t.halo);
  VEIL_NIGHT_U.dust.value = Math.max(0, t.dust);
  VEIL_NIGHT_U.trail.value = Math.max(0.01, t.trail);
}
applyVeilNight();

// 云团边上那一圈的银色（0..1）：nxy 朝外的方向（球面法线在画面里的分量，边上长度约 1），nz 法线朝镜头的分量，lightXY 光在画面里的方向。
// 只用现成的量（不再归一化、不用 pow），转场的云层每个像素要算几十个云团
export function veilRim(nxy: V2, nz: F, lightXY: V2): F {
  const e = float(1).sub(nz);
  return e.mul(e).mul(smoothstep(0.15, 0.85, dot(nxy, lightXY))).mul(VEIL_NIGHT_U.silver).mul(NIGHT_U.night);
}

// 银边按云团的权重累计好以后（rim 0..1）加成月光的银色：很淡的一圈，不是亮的高光
export function veilSilver(rgb: V3, rim: F): V3 {
  return rgb.add(NIGHT_U.silver.mul(rim.mul(0.9)));
}

const hash = (p: V2): F => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

// 扫过的金线 + 星尘。pos：这个像素沿扫的方向的坐标（画面高度为 1）；lineAt：金线这一刻在哪（VEIL_U.flash.x）；
// along：沿着线的坐标；k：这一刻的浓淡（flash.y）；cover：云的覆盖度；px：一个像素多大
export function veilGlint(rgb: V3, pos: F, lineAt: F, along: F, k: F, cover: F, px: F): V3 {
  const s = pos.sub(lineAt); // 到金线的有向距离：正的是还没扫到的前方
  const w = px.mul(VEIL_NIGHT_U.width);
  const core = float(1).sub(smoothstep(w.mul(0.5), w.mul(1.5), abs(s)));
  const halo = exp(s.mul(s).div(VEIL_NIGHT_U.halo.mul(VEIL_NIGHT_U.halo)).negate()).mul(0.28);
  // 星尘：线后面（s < 0，刚扫过的地方）的一片格子（固定在画面上，金线扫过时一粒粒亮起来），每格最多一粒，离线越远越淡，一闪一闪
  const behind = s.negate();
  const cell = 0.011;
  const g = vec2(pos.div(cell), along.div(cell));
  const id = floor(g);
  const f = fract(g).sub(0.5);
  const r = hash(id);
  const r2 = hash(id.add(17.3));
  const off = vec2(r.sub(0.5), r2.sub(0.5)).mul(0.6);
  const d = f.sub(off).mul(cell).div(px); // 到这一粒的距离（像素）
  const dot2 = dot(d, d);
  const size = r2.mul(0.9).add(0.6);
  const speck = exp(dot2.div(size.mul(size)).negate()).mul(smoothstep(0.55, 0.85, r));
  const fade = exp(behind.div(VEIL_NIGHT_U.trail).negate()).mul(smoothstep(-0.002, 0.004, behind));
  const twinkle = sin(r.mul(40).add(behind.mul(90))).mul(0.4).add(0.6);
  const dust = speck.mul(fade).mul(twinkle).mul(VEIL_NIGHT_U.dust).mul(1.6);
  // 线后面一小段很淡的余光（扫得很快：只有几帧，靠它看出是「扫过去」的）
  const tail = exp(behind.div(VEIL_NIGHT_U.trail.mul(0.3)).negate()).mul(step(0, behind)).mul(0.18);
  const glow = max(core, halo).add(dust).add(tail).mul(k).mul(cover);
  // 金线叠在云上（加色：亮的地方过泛光的阈值，后期给一圈柔光）；云的颜色往金色带一点
  return mix(rgb, rgb.mul(vec3(1.05, 1.0, 0.92)), k.mul(cover).mul(0.3)).add(VEIL_NIGHT_U.gold.mul(glow));
}

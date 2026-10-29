import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  attribute,
  cameraPosition,
  color,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  mix,
  modelWorldMatrixInverse,
  normalize,
  positionLocal,
  positionViewDirection,
  positionWorld,
  pow,
  refract,
  renderGroup,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  transformNormalToView,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { PresetId } from '../data/types';
import { valueNoise3 } from '../planet/tslNoise';
import type { World } from '../scenes/world';
import { createStream, type StreamHost } from './waterStream';
import { windUniforms } from './wind';

// 水：星球低洼处的小水塘（以后有海、小溪也走这里）。做法来自用户笔记「14-星球视觉效果」的「海洋增强」配方，翻译成 TSL，
// 再往「会动的绘本」上靠：浅处青绿透底、深处蓝绿，岸边一圈白沫轻轻涨落，太阳那边一片碎碎的闪光，掠射时映出天空的颜色。
//
// 几何：水面不再是一整个球壳，而是从地表网格里挑出「至少有一个顶点在水面以下」的三角形，顶点按原方向放到水面半径上，
// 每个顶点带上水深（水面半径 − 地表半径，米）。水深在三角形里线性插值，和画出来的地表网格完全一致：
// 水深 = 0 的那条线就是屏幕上水面和地面相交的那条线，白沫正好压在水边上。网格只有水塘那几块，片元也只画水塘。
// 地表换细分（聚焦、离开）时水面跟着重建（onBeforeRender 里比较地表的几何体，不用别处通知）。
//
// 着色：MeshPhysicalNodeMaterial（天空的反光、太阳高光、阴影都和场景里别的东西一致），外加一个小改动的光照模型：
// 每盏平行光再加两项——水面的闪光（高频的「小镜面」正好把太阳反进镜头时亮一下）和水底的光斑（沿折射后的视线落到水底的那一点上取图案）。
// 输出是预乘过透明度的颜色（混合 One / OneMinusSrcAlpha）：水体的颜色按透明度乘过，天空的反光和高光不乘，
// 所以浅水看得见底，同时反光不会跟着变淡（普通透明材质会把反光也乘上透明度，水面发灰）。

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// 可调参数（?tune → Water 改这里，再调 applyWater()）
export const WATER = {
  clarity: 2, // 水的吸收（1/米）：视线在水里每走一米挡掉多少光。越大越浑，浅处也看不见底
  deep: 0.45, // 多深（米）就是深水色
  ripple: 0.16, // 小波纹把法线推歪多少（配方「波光粼粼」）
  rippleScale: 1, // 波纹大小：频率的倍数
  foam: 1, // 岸边白沫的浓度
  foamWidth: 0.07, // 贴着水边的那条白沫有多宽（米）；往里还有一圈约 3 倍宽的碎花边
  lap: 0.7, // 往岸边推的那道浪线从离水边多远的地方出发（米）
  sparkle: 1, // 闪光
  caustics: 1, // 水底光斑
  roughness: 0.07, // 水面的粗糙度：越小天空的倒影越清楚
  sheen: 2, // 天光反射的倍数（正对着看时；掠射时总是全反射）：物理上的水是 1，绘本里水面映的天光更明显
  iceLat: 0.9, // 冰川预设：|y|（纬度的正弦）超过它的水面整片冻住。舞台在北纬约 56°（|y| ≈ 0.83），舞台前的水塘只结岸边那一圈
};

// 每个预设一组颜色（sRGB）：浅水、中间、深水、白沫。没有水的预设也给一组，类型完整
export interface WaterPalette {
  shallow: string;
  mid: string;
  deep: string;
  foam: string;
}

// 海冰的多少（配方「海冰」）：只有冰川预设结冰
export const WATER_ICE: Record<PresetId, number> = { verdant: 0, desert: 0, glacier: 1, volcanic: 0, coral: 0 };

// 第二版 [v2-world]：水偏灰蓝（Water #5f7f97），不用青蓝；浅处透一点灰绿，深处是暗的石板蓝，白沫是象牙白
export const WATER_COLORS: Record<PresetId, WaterPalette> = {
  verdant: { shallow: '#93adb9', mid: '#5f7f97', deep: '#2f4a60', foam: '#ece7dc' },
  desert: { shallow: '#9ab1b8', mid: '#62808f', deep: '#31495a', foam: '#ede6da' },
  glacier: { shallow: '#a9bec9', mid: '#6f8ea4', deep: '#3a566d', foam: '#f0f1ee' },
  volcanic: { shallow: '#8ea4b1', mid: '#5a768c', deep: '#2c4256', foam: '#e6e2da' },
  coral: { shallow: '#98b6b8', mid: '#5f8a94', deep: '#2e5263', foam: '#efe7dd' },
};

// 涉水、雨点的波纹：最多同时 SOURCES 圈（角色走过的地方一圈一圈往外扩）
const SOURCES = 8;
export const RING = {
  speed: 0.55, // 波纹往外跑的速度（米/秒）
  life: 3.2, // 一圈波纹存活多久（秒）
  width: 0.07, // 波包的宽度（米）
  wave: 24, // 波包里的波数（弧度/米）：约 26 厘米一道
  amp: 0.004, // 波高（米）
  step: 0.32, // 角色在水里每走这么远放一圈（米）
  idle: 2.2, // 站着不动时每隔这么久放一圈（秒）
  jitter: 0.09, // 每圈的圆心在脚下随机挪开多远（米）：两只脚轮流踩，圈不是同心的
};

// 所有水面材质共用的 uniform：放进 renderGroup（每次 render 刷新一次）。小溪（waterStream.ts）也读其中几个（WATER_U）
const U = {
  clarity: uniform(WATER.clarity).setGroup(renderGroup),
  deep: uniform(WATER.deep).setGroup(renderGroup),
  ripple: uniform(WATER.ripple).setGroup(renderGroup),
  rippleScale: uniform(WATER.rippleScale).setGroup(renderGroup),
  foam: uniform(WATER.foam).setGroup(renderGroup),
  foamWidth: uniform(WATER.foamWidth).setGroup(renderGroup),
  lap: uniform(WATER.lap).setGroup(renderGroup),
  sparkle: uniform(WATER.sparkle).setGroup(renderGroup),
  caustics: uniform(WATER.caustics).setGroup(renderGroup),
  roughness: uniform(WATER.roughness).setGroup(renderGroup),
  sheen: uniform(WATER.sheen).setGroup(renderGroup),
  iceLat: uniform(WATER.iceLat).setGroup(renderGroup),
  rain: uniform(0).setGroup(renderGroup), // 平滑过的雨量 0..1（installWater 每帧从生机层取）
  walker: uniform(new THREE.Vector4(0, -1e5, 0, 0)).setGroup(renderGroup), // 角色在水里时：xyz = 水面上脚下那一点（世界坐标），w = 1
};

export const WATER_U = U;

const sources = Array.from({ length: SOURCES }, () => new THREE.Vector4(0, -1e5, 0, -1e3)); // xyz = 圆心（世界坐标），w = 出生时刻（秒，TSL 的 time）
const uSources = uniformArray(sources, 'vec4').setGroup(renderGroup);
let nextSource = 0;

export function applyWater(): void {
  U.clarity.value = WATER.clarity;
  U.deep.value = WATER.deep;
  U.ripple.value = WATER.ripple;
  U.rippleScale.value = WATER.rippleScale;
  U.foam.value = WATER.foam;
  U.foamWidth.value = WATER.foamWidth;
  U.lap.value = WATER.lap;
  U.sparkle.value = WATER.sparkle;
  U.caustics.value = WATER.caustics;
  U.roughness.value = WATER.roughness;
  U.sheen.value = WATER.sheen;
  U.iceLat.value = WATER.iceLat;
}

type ColorUniform = THREE.UniformNode<'color', THREE.Color>;
const palettes = new Map<PresetId, Record<keyof WaterPalette, ColorUniform>>();

// 同一预设的水面共用一组颜色 uniform（?tune 改一次全部生效）
export function paletteOf(preset: PresetId): Record<keyof WaterPalette, ColorUniform> {
  let p = palettes.get(preset);
  if (!p) {
    const c = WATER_COLORS[preset];
    p = Object.fromEntries((Object.keys(c) as Array<keyof WaterPalette>).map((k) => [k, uniform(new THREE.Color(c[k])).setGroup(renderGroup)])) as Record<keyof WaterPalette, ColorUniform>;
    palettes.set(preset, p);
  }
  return p;
}

const ices = new Map<PresetId, THREE.UniformNode<'float', number>>();

function iceOf(preset: PresetId): THREE.UniformNode<'float', number> {
  let u = ices.get(preset);
  if (!u) {
    u = uniform(WATER_ICE[preset]).setGroup(renderGroup);
    ices.set(preset, u);
  }
  return u;
}

export function applyWaterPalette(): void {
  for (const [preset, p] of palettes) {
    const c = WATER_COLORS[preset];
    for (const k of Object.keys(p) as Array<keyof WaterPalette>) p[k].value.set(c[k]);
  }
  for (const [preset, u] of ices) u.value = WATER_ICE[preset];
}

// ---------------------------------------------------------------------------------------------
// 噪声

// Dave Hoskins 的 hash33（不用 sin，float32 下稳定），输出 0..1
function hash33(p: V3): V3 {
  const p3 = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
}

// 三个通道的值噪声（0..1）：一次调用给出一个随机方向，拿来推歪法线（配方里的 snoise 换成它：便宜，WebGL2 上编译快）
export const noise3v = Fn(([p]: [V3]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const c = (x: number, y: number, z: number) => hash33(i.add(vec3(x, y, z)));
  const x00 = mix(c(0, 0, 0), c(1, 0, 0), u.x);
  const x10 = mix(c(0, 1, 0), c(1, 1, 0), u.x);
  const x01 = mix(c(0, 0, 1), c(1, 0, 1), u.x);
  const x11 = mix(c(0, 1, 1), c(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}).setLayout({ name: 'waterNoise3v', type: 'vec3', inputs: [{ name: 'p', type: 'vec3' }] }) as unknown as (p: V3) => V3;

// 一个波包的高度 h = env·cos(k·x)（x = 到波峰的距离）对 x 的导数；env 是高斯包络
function packetSlope(x: F, env: F, k: number, width: number): F {
  return env.mul(sin(x.mul(k)).mul(-k).sub(cos(x.mul(k)).mul(x).mul(2 / (width * width))));
}

// 一圈一圈的波纹（世界坐标）：角色走过放下的那几圈 + 下雨时的雨点。返回 xyz = 水面高度的梯度（米/米，未投影到切面），w = 波峰的亮线（0..1）
const ringsNode = Fn(([p, pw]: [V3, V3]) => {
  const grad = vec3(0).toVar();
  const crest = float(0).toVar();
  const invW2 = -1 / (RING.width * RING.width);
  Loop(SOURCES, ({ i }) => {
    const s = uSources.element(i) as unknown as V4;
    const age = time.sub(s.w);
    If(age.greaterThan(0).and(age.lessThan(RING.life)), () => {
      const rel = pw.sub(s.xyz);
      const r = length(rel);
      const x = r.sub(age.mul(RING.speed));
      const fade = float(1).sub(age.div(RING.life));
      const env = exp(x.mul(x).mul(invW2)).mul(fade.mul(fade));
      grad.addAssign(rel.div(max(r, 1e-3)).mul(packetSlope(x, env, RING.wave, RING.width).mul(RING.amp)));
      crest.addAssign(env.mul(smoothstep(0.72, 1, cos(x.mul(RING.wave)))).mul(fade).mul(0.6));
    });
  });
  // 雨点：两层格子（三维格子和水面相交），每格一个雨点，相位随时间循环；雨小时只有一部分格子有雨点
  If(U.rain.greaterThan(0.01), () => {
    for (const [scale, seed] of [[1.7, 0.0], [2.6, 7.7]] as const) {
      const q = p.mul(scale).add(seed);
      const h = hash33(floor(q).add(seed * 3.1));
      const ph = fract(time.mul(0.85).add(h.x.mul(5.7)).add(h.y.mul(3.1)));
      const rel = fract(q).sub(h.mul(0.5).add(0.25)).div(scale);
      const r = length(rel);
      const w = 0.03;
      const x = r.sub(ph.mul(0.2));
      const fade = float(1).sub(ph);
      const env = exp(x.mul(x).mul(-1 / (w * w))).mul(fade.mul(fade)).mul(step(h.z, U.rain.mul(0.85)));
      grad.addAssign(rel.div(max(r, 1e-3)).mul(packetSlope(x, env, 70, w).mul(0.0018)));
      crest.addAssign(env.mul(smoothstep(0.4, 1, cos(x.mul(70)))).mul(0.6));
    }
  });
  return vec4(grad, crest);
}) as unknown as (p: V3, pw: V3) => V4; // 不写 setLayout：uniformArray 在单独生成的 WGSL 函数里找不到（缓冲区只在主函数里声明）

// ---------------------------------------------------------------------------------------------
// 材质

// 光照模型多加的两项（每盏平行光调一次）：L 是指向光源的方向（观察空间）
export interface WaterExtras {
  glint: (L: V3) => F; // 闪光：乘在光的颜色上，加进镜面反射
  caustic: (L: V3) => V3; // 水底光斑：乘在光的颜色上，加进漫反射（透过水看到的水底多出来的光）
  // 画出来的水在哪（0..1）：平行光的漫反射和高光都乘它。three 的直接高光把 F90 写死成 1（BRDF_GGX 的 f90: 1），
  // specularIntensity 压不住：水边外面那一窄条透明的三角形掠射时会反出一道白光
  mask: F;
}

class WaterLightingModel extends THREE.PhysicalLightingModel {
  extras: WaterExtras;

  constructor(extras: WaterExtras) {
    super();
    this.extras = extras;
  }

  direct(input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder): void {
    const light = (input.lightColor as V3).mul(this.extras.mask);
    super.direct({ ...input, lightColor: light }, builder);
    const L = input.lightDirection as V3;
    (input.reflectedLight.directSpecular as V3).addAssign(light.mul(this.extras.glint(L)));
    (input.reflectedLight.directDiffuse as V3).addAssign(light.mul(this.extras.caustic(L)));
  }
}

class WaterNodeMaterial extends THREE.MeshPhysicalNodeMaterial {
  static get type(): string {
    return 'WaterNodeMaterial';
  }

  _extras: WaterExtras | null = null; // 下划线开头：不算进材质的缓存键

  setupLightingModel(): THREE.PhysicalLightingModel {
    return new WaterLightingModel(this._extras!);
  }
}

// 水面材质（几何体要带 waterDepth 属性，见 buildWaterGeometry）。所有噪声按星球本地坐标（米）取，图案大小和星球半径无关
// 水面用的材质：Physical + 上面的光照模型；输出预乘透明度（One / OneMinusSrcAlpha），colorNode 要自己乘好透明度。
// extras 在材质建好以后、第一次编译之前填（小溪 waterStream.ts 也用它）
export function litWaterMaterial(name: string, extras: WaterExtras | null = null): THREE.MeshPhysicalNodeMaterial & { _extras: WaterExtras | null } {
  const m = new WaterNodeMaterial({
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    metalness: 0,
    ior: 1.333,
  });
  m.name = name;
  m._extras = extras;
  return m;
}

export function waterMaterial(preset: PresetId): THREE.MeshPhysicalNodeMaterial {
  const pal = paletteOf(preset);
  const m = litWaterMaterial(`water-${preset}`);
  const p = positionLocal; // 星球本地坐标（米），在水面球壳上
  const n = normalize(p);
  // 水深（米）：二次插值（见 buildWaterGeometry），等深线是弯的，三角形之间没有折痕
  const wd = attribute('waterDepth', 'vec4') as unknown as V4;
  const wg = attribute('waterGrad', 'vec3') as unknown as V3;
  const dq = wd.x.add(dot(wg, p)).sub(wd.y).toVar();
  const d = max(dq, 0);
  const t = time;
  // 防闪：一个像素覆盖多少米。频率 f（每米几个周期）的图案一个周期少于 2 个像素时淡掉
  const perPixel = length(fwidth(p)).max(1e-5).toVar();
  const keep = (f: number | F) => smoothstep(1.2, 3, float(1).div(perPixel.mul(f)));
  const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const V = normalize(camLocal.sub(p));
  const cosV = saturate(dot(n, V));

  // ---- 小波纹（配方「波光粼粼」：两层噪声把法线推歪，频率换算成每米）。风大水面碎一点
  const rs = U.rippleScale;
  const windK = windUniforms.strength.mul(0.9).add(0.55);
  // 再加一层大的（约 3 米一起伏，慢慢漂）：海面远看时天光的倒影有一条条明暗，不是一整片平的。
  // 频率低，在顶点上算（聚焦时顶点间距约 1 米），片元里只插值：海占满画面时省下一次噪声
  const o0 = varying(noise3v(p.mul(rs.mul(0.33)).add(vec3(t.mul(0.05), t.mul(0.03), t.mul(-0.04))).add(41.3)).sub(0.5));
  const o1 = noise3v(p.mul(rs.mul(1.1)).add(vec3(t.mul(0.23), t.mul(-0.17), t.mul(0.11)))).sub(0.5);
  const o2 = noise3v(p.mul(rs.mul(2.6)).add(vec3(t.mul(-0.31), t.mul(0.21), t.mul(-0.26))).add(19.7)).sub(0.5);
  const shimmer = o0.mul(0.6).add(o1.mul(keep(rs.mul(1.1)))).add(o2.mul(0.55).mul(keep(rs.mul(2.6)))).mul(U.ripple).mul(windK);
  // 一圈圈的波纹：梯度（世界坐标；星球不转，方向和本地一样）
  const rings = ringsNode(p, positionWorld).toVar();
  const tilt = shimmer.sub(rings.xyz);
  const nWater = normalize(n.add(tilt.sub(n.mul(dot(n, tilt))))).toVar();

  // ---- 离水边多远（米）：水深 / 岸坡（岸坡最缓按 3.5% 算，平底的大水塘中间不会算出几十米）。
  // 先减去二次插值可能多出来的那点深度（wd.w）：画出来的水边一定落在地表折线里面（水面和地表真正相交的那条折线
  // 藏在完全透明的那一窄条里），再往里收 3–12 厘米、随噪声弯来弯去。e 是到画出来的水边的距离（米），负数在水外
  const dist = dq.sub(wd.w.mul(1.2)).div(max(wd.z, 0.035)).toVar();
  // 只在岸边（离水边 lap + 0.8 米以内）和角色脚边才要的两层噪声：水边的弯曲、白沫的碎边。离岸远的像素不算
  const toWalker = length(positionWorld.sub(U.walker.xyz)).toVar();
  const shoreNoise = Fn(() => {
    const r = vec2(0.5, 0.5).toVar();
    If(dist.lessThan(U.lap.add(0.8)).or(toWalker.lessThan(0.8)), () => {
      r.assign(vec2(valueNoise3(p.mul(1.4).add(2.1)), valueNoise3(p.mul(7.5).add(vec3(t.mul(0.09), 0, t.mul(-0.06))).add(3.3))));
    });
    return r;
  })().toVar();
  const edgeN = shoreNoise.x;
  const fN2 = shoreNoise.y;
  const e = dist.sub(mix(float(0.03), float(0.12), edgeN)).toVar();
  const exists = smoothstep(0.0, max(fwidth(e).mul(1.5), 0.004), e).toVar();

  // ---- 深浅（配方「浅海透明」）：浅处青绿、看得见底，往深处变成蓝绿；大块的不匀，像手涂的（低频，在顶点上算）
  const patch = varying(valueNoise3(p.mul(0.33).add(5.3)).sub(0.5));
  const bigPatch = varying(valueNoise3(p.mul(0.07).add(13.1)).sub(0.5)); // 海上十几米一块的深浅（远看像水彩一笔一笔涂的）
  const tone = saturate(d.div(U.deep).add(patch.mul(0.22)).add(bigPatch.mul(0.3)));
  const body = mix(mix(pal.shallow, pal.mid, smoothstep(0.0, 0.55, tone)), pal.deep, smoothstep(0.45, 1.0, tone));
  const pathLen = d.div(max(cosV, 0.35)); // 视线在水里走过的路程：斜着看更不透（掠射时封顶，近岸那一条斜着看也透底）
  const absorb = float(1).sub(exp(pathLen.mul(U.clarity).negate()));
  const alphaBody = mix(float(0.08), float(0.94), absorb).mul(exists);

  // ---- 岸边白沫（配方「海岸浪花」），按离水边的米数画：贴着水边一条（宽度随时间轻轻涨落，像水一下一下拍岸），
  // 再往里一圈被噪声撕碎的花边；还有一道从外面推向岸边、越来越淡的浪线，断成一截一截（手画的感觉）
  const breathe = sin(t.mul(0.85).add(patch.mul(9))).mul(0.5).add(0.5);
  const rimW = U.foamWidth.mul(breathe.mul(0.7).add(0.65));
  const ee = e.add(fN2.sub(0.5).mul(0.035).mul(keep(7.5)));
  const rim = float(1).sub(smoothstep(rimW.mul(0.55), rimW, ee));
  const lace = float(1).sub(smoothstep(rimW, rimW.mul(3.5), ee)).mul(smoothstep(0.55, 0.68, fN2));
  const phase = fract(t.mul(0.13).add(patch.mul(1.7)));
  const lineAt = U.lap.mul(float(1).sub(phase));
  const line = float(1).sub(smoothstep(0, 0.03, abs(ee.sub(lineAt))))
    .mul(smoothstep(0.0, 0.2, phase)).mul(float(1).sub(smoothstep(0.6, 1.0, phase))).mul(smoothstep(0.5, 0.64, fN2));
  // 角色站在水里：腿边一圈碎白沫
  const legs =exp(toWalker.sub(0.2).div(0.05).pow(2).negate()).mul(U.walker.w).mul(smoothstep(0.35, 0.6, fN2));
  // ---- 海冰（配方「海冰」，只有冰川预设的 ice > 0）：岸边先结一圈不规则的薄冰，离岸两三米内漂着一块块冰（慢慢漂），
  // 两极（|y| 超过 iceLat）整片冻住、边缘按噪声抖。冰上有细细的裂纹，冰的边上一道白边
  const iceAmt = iceOf(preset);
  const ice = Fn(() => {
    const r = float(0).toVar();
    If(iceAmt.greaterThan(0.001), () => {
      const iN = valueNoise3(p.mul(0.25).add(31.7));
      const iN2 = valueNoise3(p.mul(1.6).add(vec3(t.mul(0.012), 0, t.mul(-0.01))).add(9.2));
      const rimIce = float(1).sub(smoothstep(0.1, 0.2, e.add(iN.sub(0.5).mul(0.3)).add(iN2.sub(0.5).mul(0.2))));
      const floes = smoothstep(0.7, 0.73, iN2).mul(smoothstep(0.2, 0.5, e)).mul(float(1).sub(smoothstep(1.2, 2.2, e)));
      const polar = smoothstep(U.iceLat.sub(0.02), U.iceLat.add(0.02), abs(n.y).add(iN.sub(0.5).mul(0.12)).add(iN2.sub(0.5).mul(0.03)));
      r.assign(max(max(rimIce, floes), polar).mul(iceAmt));
    });
    return r;
  })().mul(exists).toVar();
  // 冰的颜色：薄冰（浅水上）透一点水的青色，厚冰发白；一块块冰有大块的明暗；裂纹是细的青线；边上一道白
  const crack = float(1).sub(smoothstep(0.0, 0.035, abs(valueNoise3(p.mul(2.4).add(4.4)).sub(0.5)))).mul(keep(2.4));
  const iceEdge = smoothstep(0.05, 0.45, ice).mul(float(1).sub(smoothstep(0.55, 0.95, ice)));
  const iceBase = mix(mix(pal.shallow, color('#dde3e6'), 0.6), color('#e8ecee'), smoothstep(0.0, 0.4, d).mul(0.7).add(patch.add(0.5).mul(0.3)));
  const iceCol = mix(mix(iceBase, color('#9fb3c0'), crack.mul(0.6)), color('#f6f6f3'), iceEdge);

  const foam = saturate(max(max(rim, lace.mul(0.85)), max(line.mul(0.5), legs.mul(0.8))).add(rings.w.mul(0.3))).mul(U.foam).mul(exists.sub(ice).max(0)).toVar();

  const alpha = mix(mix(alphaBody, exists, foam), exists, ice);
  m.colorNode = mix(mix(body.mul(alphaBody), pal.foam.mul(exists), foam), iceCol.mul(exists), ice); // 预乘过透明度
  m.opacityNode = alpha;
  m.roughnessNode = mix(mix(U.roughness, float(0.85), foam), float(0.3), ice);
  m.normalNode = transformNormalToView(mix(nWater, n, max(foam, ice)));
  // 反光：F0 = 0.02（水的折射率 1.333）× sheen（绘本里水面的天光更明显），F90 = exists：画出来的水边外面不反光
  m.specularColorNode = vec3(U.sheen);
  m.specularIntensityNode = exists;

  // ---- 闪光：更细的一层「小镜面」，只有正好把光反进镜头的那几个亮一下（随时间换位置，一闪一闪）；远处淡掉。
  // 那两层细噪声只在太阳反光的大致范围里算（水面法线和半程向量夹角 37° 以内），别的像素直接跳过。
  // 带导数的量（keep）都在分支外面先算好：WGSL 不许在非一致的分支里取导数
  const glintAmt = U.sparkle.mul(keep(23)).mul(exists.sub(foam).max(0)).mul(5).toVar();
  const nWaterView = transformNormalToView(nWater);
  const glint = (L: V3): F => Fn(() => {
    const out = float(0).toVar();
    const H = normalize(L.add(positionViewDirection)).toVar();
    If(glintAmt.greaterThan(0.001).and(dot(nWaterView, H).greaterThan(0.8)), () => {
      const g1 = noise3v(p.mul(23).add(vec3(t.mul(1.3), t.mul(-0.9), t.mul(0.7)))).sub(0.5);
      const g2 = noise3v(p.mul(37).add(vec3(t.mul(-1.5), t.mul(1.1), t.mul(1.2))).add(7.7)).sub(0.5);
      const gTilt = g1.add(g2.mul(0.8)).mul(0.6);
      const glintN = transformNormalToView(normalize(nWater.add(gTilt.sub(n.mul(dot(n, gTilt))))));
      out.assign(smoothstep(0.9978, 0.9995, dot(glintN, H)).mul(glintAmt));
    });
    return out;
  })() as unknown as F;

  // ---- 水底光斑：沿折射后的视线落到水底的那一点上取两层「脊」噪声相乘，成一张网；浅水最亮，深了、浑了就淡。
  // 只在浅水、看得见底的地方算噪声
  const causticK = U.caustics.mul(0.35).mul(smoothstep(0.01, 0.06, d)).mul(float(1).sub(smoothstep(0.12, 0.55, d)))
    .mul(exists.sub(alphaBody).max(0)).mul(float(1).sub(max(foam, ice))).mul(keep(12)).toVar(); // 远处就不画了：从星球视图看像撒了一层白点
  const causticAmt = Fn(() => {
    const out = float(0).toVar();
    If(causticK.greaterThan(0.001), () => {
      const refr = refract(V.negate(), n, 0.752);
      const q = p.add(refr.mul(d.div(max(dot(refr.negate(), n), 0.25))));
      const ridge = (v: F) => float(1).sub(abs(v.sub(0.5)).mul(2));
      const c1 = valueNoise3(q.mul(2.3).add(vec3(t.mul(0.21), t.mul(-0.13), t.mul(0.17))));
      const c2 = valueNoise3(q.mul(3.1).add(vec3(t.mul(-0.16), t.mul(0.19), t.mul(-0.11))).add(11.1));
      out.assign(pow(ridge(c1).mul(ridge(c2)), 5).mul(causticK));
    });
    return out;
  })() as unknown as F;
  const nView = transformNormalToView(n);

  m._extras = {
    glint,
    caustic: (L) => pal.shallow.mul(causticAmt.mul(saturate(dot(nView, L)))),
    mask: exists,
  };
  return m;
}

// ---------------------------------------------------------------------------------------------
// 几何

const DEGENERATE = new Float32Array(9);
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _g = new THREE.Vector3();
const _t = new THREE.Vector3();

// 从地表网格挑出水塘：至少一个顶点在水面以下的三角形。顶点按原方向放到水面半径上（位置 x），带两个属性：
//   waterGrad（vec3）：这个顶点处水深的梯度 g（周围三角形的梯度按面积平均）；
//   waterDepth（vec4）：x = 水深 d（米，岸上的顶点是负的），y = g·x，z = 岸坡 |g|（周围三角形按面积平均），
//                      w = 这一圈三角形里「二次插值比线性插值深出来」的最大值（米）。
// 着色器里 d + G·p − (g·x) 的插值（G、g·x 都是线性插值的属性）是一个二次插值：在顶点上等于 d，梯度也对得上，
// 所以等深线是弯的；减去 w 以后它的零线一定在地表折线（真正的水边）里面，画出来的水边是一条软曲线。
// 水深 / 岸坡 ≈ 离水边几米：白沫、浪线按米来画，缓坡、陡坡上一样宽。
// 一个也没有时给一个退化三角形（面积为 0，不出片元）：开场预编译时数量为 0 的网格会被跳过，着色器就留到第一次聚焦才编
export function buildWaterGeometry(terrain: THREE.BufferGeometry, sea: number): THREE.BufferGeometry {
  const pos = terrain.getAttribute('position') as THREE.BufferAttribute;
  const src = pos.array as Float32Array;
  const count = pos.count;
  const depth = new Float32Array(count);
  const water = new Float32Array(count * 3); // 顶点放到水面半径上的位置
  for (let i = 0; i < count; i++) {
    const r = Math.hypot(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]) || 1;
    depth[i] = sea - r;
    for (let k = 0; k < 3; k++) water[i * 3 + k] = (src[i * 3 + k] / r) * sea;
  }
  const index = terrain.getIndex();
  const idx = index ? index.array : null;
  const triCount = idx ? idx.length / 3 : count / 3;
  const remap = new Int32Array(count).fill(-1);
  const gradSum = new Float32Array(count * 3);
  const slopeSum = new Float32Array(count);
  const areaSum = new Float32Array(count);
  const tris: number[] = [];
  let used = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    if (depth[a] <= 0 && depth[b] <= 0 && depth[c] <= 0) continue;
    if (remap[a] < 0) remap[a] = used++;
    if (remap[b] < 0) remap[b] = used++;
    if (remap[c] < 0) remap[c] = used++;
    tris.push(a, b, c);
    // 三角形里水深的梯度：g·e1 = Δ1、g·e2 = Δ2，g 在三角形平面里 → g = (Δ1 (e2 × n) + Δ2 (n × e1)) / |n|²
    _t.fromArray(water, a * 3);
    _e1.fromArray(water, b * 3).sub(_t);
    _e2.fromArray(water, c * 3).sub(_t);
    _n.crossVectors(_e1, _e2);
    const n2 = _n.lengthSq();
    if (n2 < 1e-12) continue;
    _g.crossVectors(_e2, _n).multiplyScalar(depth[b] - depth[a]);
    _g.add(_t.crossVectors(_n, _e1).multiplyScalar(depth[c] - depth[a])).divideScalar(n2);
    const area = Math.sqrt(n2);
    const s = _g.length() * area;
    for (const v of [a, b, c]) {
      gradSum[v * 3] += _g.x * area;
      gradSum[v * 3 + 1] += _g.y * area;
      gradSum[v * 3 + 2] += _g.z * area;
      slopeSum[v] += s;
      areaSum[v] += area;
    }
  }
  const geo = new THREE.BufferGeometry();
  if (used === 0) {
    geo.setAttribute('position', new THREE.BufferAttribute(DEGENERATE.slice(), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    geo.setAttribute('waterDepth', new THREE.BufferAttribute(new Float32Array([-1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0]), 4));
    geo.setAttribute('waterGrad', new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setIndex([0, 1, 2]);
  } else {
    const grads = new Float32Array(count * 3); // 每个顶点的平均梯度（按原编号）
    for (let i = 0; i < count; i++) {
      if (remap[i] < 0 || areaSum[i] <= 0) continue;
      for (let k = 0; k < 3; k++) grads[i * 3 + k] = gradSum[i * 3 + k] / areaSum[i];
    }
    const g = (v: number, k: number) => grads[v * 3 + k];
    const x = (v: number, k: number) => water[v * 3 + k];
    // 二次插值比线性插值深出来多少：在三条边的中点上是 ¼ (g_a − g_b)·(x_b − x_a)，在重心上是 1/9 Σ g_i·(x_j − x_i)；取最大的，记到三个顶点上
    const sag = (u: number, v: number) => 0.25 * ((g(u, 0) - g(v, 0)) * (x(v, 0) - x(u, 0)) + (g(u, 1) - g(v, 1)) * (x(v, 1) - x(u, 1)) + (g(u, 2) - g(v, 2)) * (x(v, 2) - x(u, 2)));
    const lift = new Float32Array(count);
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k];
      const b = tris[k + 1];
      const c = tris[k + 2];
      const centroid = ((sag(a, b) + sag(b, c) + sag(c, a)) * 4) / 9; // Σ_i Σ_j g_i·(x_j − x_i) / 9，换成三条边的 sag
      const m = Math.max(0, sag(a, b), sag(b, c), sag(c, a), centroid);
      lift[a] = Math.max(lift[a], m);
      lift[b] = Math.max(lift[b], m);
      lift[c] = Math.max(lift[c], m);
    }
    const positions = new Float32Array(used * 3);
    const normals = new Float32Array(used * 3);
    const depths = new Float32Array(used * 4);
    const gradsOut = new Float32Array(used * 3);
    for (let i = 0; i < count; i++) {
      const k = remap[i];
      if (k < 0) continue;
      let gx = 0;
      for (let j = 0; j < 3; j++) {
        positions[k * 3 + j] = water[i * 3 + j];
        normals[k * 3 + j] = water[i * 3 + j] / sea;
        gradsOut[k * 3 + j] = grads[i * 3 + j];
        gx += grads[i * 3 + j] * water[i * 3 + j];
      }
      depths[k * 4] = depth[i];
      depths[k * 4 + 1] = gx;
      depths[k * 4 + 2] = areaSum[i] > 0 ? slopeSum[i] / areaSum[i] : 0.1;
      depths[k * 4 + 3] = lift[i];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('waterDepth', new THREE.BufferAttribute(depths, 4));
    geo.setAttribute('waterGrad', new THREE.BufferAttribute(gradsOut, 3));
    geo.setIndex(tris.map((v) => remap[v]));
  }
  // 包围球按整颗星球算：水塘不在画面里时照样走 onBeforeRender（换细分时要靠它重建），多画的只是几百个三角形的顶点
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), sea);
  return geo;
}

// 水面挂在哪颗星球上：PlanetObject 满足这个接口（地表、水面半径、高度、遮罩、预设和种子；小溪要找路线、让草让开）
export type WaterHost = StreamHost;

// 建一颗星球的水（PlanetObject.rebuild 调）：水面（水塘、海）+ 一条小溪（找得到路线时）。
// 地表换了几何体（换细分）时，下一次画之前跟着重建
export function createWater(host: WaterHost): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'water-bodies';
  let builtFrom = host.terrain.geometry;
  const mesh = new THREE.Mesh(buildWaterGeometry(builtFrom, host.sea), waterMaterial(host.currentRecipe.preset));
  mesh.name = 'water';
  mesh.receiveShadow = true; // 作品、翠宝的影子落在水面上
  const stream = createStream(host);
  mesh.onBeforeRender = () => {
    const g = host.terrain.geometry;
    if (g === builtFrom) return;
    builtFrom = g;
    const old = mesh.geometry;
    mesh.geometry = buildWaterGeometry(g, host.sea);
    old.dispose();
    stream?.sync(); // 小溪只在聚焦的细分上建、画
  };
  group.add(mesh);
  if (stream) group.add(stream.mesh);
  return group;
}

// ---------------------------------------------------------------------------------------------
// 每帧：雨量、角色涉水的波纹

const _dir = new THREE.Vector3();
const _at = new THREE.Vector3();
const wade = { inWater: false, last: new THREE.Vector3(), lastT: -1e3 };

// 在水面上 at（世界坐标）放一圈波纹
export function emitRipple(at: THREE.Vector3): void {
  sources[nextSource].set(at.x, at.y, at.z, time.value);
  nextSource = (nextSource + 1) % SOURCES;
}

function stepWater(world: World): void {
  U.rain.value = world.life.rain;
  const e = world.focused;
  const feet = world.life.influence.value; // xyz = 脚底（世界坐标），w = 影响半径（没有角色时 0）
  let inWater = false;
  if (e && feet.w > 0 && e.planet.sea > 0) {
    _dir.set(feet.x, feet.y, feet.z).sub(e.home).normalize();
    const depth = e.planet.sea - e.planet.height(_dir.x, _dir.y, _dir.z);
    if (depth > 0.02) {
      inWater = true;
      _at.copy(_dir).multiplyScalar(e.planet.sea).add(e.home);
      const now = time.value;
      U.walker.value.set(_at.x, _at.y, _at.z, 1);
      if (!wade.inWater || _at.distanceTo(wade.last) > RING.step || now - wade.lastT > RING.idle) {
        wade.last.copy(_at);
        wade.lastT = now;
        // 圆心在脚下随机挪开一点（挪完再按回水面半径）
        _at.x += (Math.random() - 0.5) * 2 * RING.jitter;
        _at.y += (Math.random() - 0.5) * 2 * RING.jitter;
        _at.z += (Math.random() - 0.5) * 2 * RING.jitter;
        _at.sub(e.home).setLength(e.planet.sea).add(e.home);
        emitRipple(_at);
      }
    }
  }
  if (!inWater) U.walker.value.w = 0;
  wade.inWater = inWater;
}

// 接到 World 上（main.ts 调一次）：每帧取雨量、看角色是不是站在水里
export function installWater(world: World): () => void {
  const hook = () => stepWater(world);
  world.frameHooks.add(hook);
  return () => world.frameHooks.delete(hook);
}

// ---------------------------------------------------------------------------------------------
// ?tune 面板：Water 一组（tune.ts 调）

interface TuneEvents {
  on(event: 'change', handler: () => void): unknown;
}
interface TuneFolder extends TuneEvents {
  addFolder(params: { title: string; expanded?: boolean }): TuneFolder;
  addBinding<T extends object>(target: T, key: keyof T & string, params?: Record<string, unknown>): TuneEvents;
}

export function tuneWater(pane: TuneFolder): void {
  const f = pane.addFolder({ title: 'Water', expanded: false });
  f.addBinding(WATER, 'clarity', { label: 'murkiness (1/m)', min: 0.5, max: 12, step: 0.1 });
  f.addBinding(WATER, 'deep', { label: 'deep at (m)', min: 0.1, max: 2, step: 0.01 });
  f.addBinding(WATER, 'ripple', { min: 0, max: 0.5, step: 0.005 });
  f.addBinding(WATER, 'rippleScale', { label: 'ripple freq ×', min: 0.3, max: 3, step: 0.01 });
  f.addBinding(WATER, 'foam', { min: 0, max: 1, step: 0.01 });
  f.addBinding(WATER, 'foamWidth', { label: 'foam width (m)', min: 0, max: 0.3, step: 0.005 });
  f.addBinding(WATER, 'lap', { label: 'lapping line from (m)', min: 0, max: 2, step: 0.01 });
  f.addBinding(WATER, 'sparkle', { min: 0, max: 3, step: 0.01 });
  f.addBinding(WATER, 'caustics', { min: 0, max: 3, step: 0.01 });
  f.addBinding(WATER, 'roughness', { min: 0.02, max: 0.5, step: 0.005 });
  f.addBinding(WATER, 'sheen', { label: 'sky sheen ×', min: 0, max: 5, step: 0.05 });
  f.addBinding(WATER, 'iceLat', { label: 'polar ice from |y|', min: 0.5, max: 1.05, step: 0.005 });
  f.on('change', () => applyWater());
  for (const preset of ['verdant', 'glacier', 'coral'] as const) {
    const c = f.addFolder({ title: `Colors · ${preset}`, expanded: false });
    for (const k of Object.keys(WATER_COLORS[preset]) as Array<keyof WaterPalette>) c.addBinding(WATER_COLORS[preset], k);
    c.addBinding(WATER_ICE, preset, { label: 'sea ice', min: 0, max: 1, step: 0.01 });
    c.on('change', () => applyWaterPalette());
  }
}

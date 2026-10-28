import * as THREE from 'three/webgpu';
import { abs, color, cross, dFdx, dFdy, dot, equirectUV, float, fwidth, length, max, mix, normalize, normalLocal, normalView, positionLocal, positionView, pow, saturate, sign, smoothstep, uniform, vec2 } from 'three/tsl';
import type { PresetId } from '../data/types';
import { onPlanetRadius, PLANET_RADIUS, PRESETS, type GroundPalette } from './presets';
import { fbm2, valueNoise3 } from './tslNoise';

// 地表着色器（「小王子」方向）：不再按高度分色带，而是草地、干草、苔藓、泥土、土路之间按噪声遮罩平滑混合；
// 土路和作品空地来自星球遮罩（mask.ts）；法线叠一层细节噪声（Mikkelsen 的无切线凹凸），近处看有颗粒感，远处淡掉不闪。
// 所有噪声都按星球本地坐标（米）取：图案的尺度和星球半径无关，半径变了草斑还是那么大

// 可调参数（?tune 面板改这里，再调 applyGround()）；颜色在 presets.ts 的 ground 里
export const GROUND = {
  patch: 0.045, // 大块干草斑的频率（1/米）：约 20 米一块
  moss: 0.62, // 苔藓阈值（越小苔藓越多）
  soil: 0.74, // 露土阈值（越小土越多）
  clump: 1.6, // 一丛丛草的明暗频率（1/米）
  bump: 0.05, // 细节凹凸的高度（米）
  grain: 18, // 颗粒的频率（1/米）：约 5 厘米一粒
  pathEdge: 0.45, // 路边被草啃出来的不规则程度
};

const U = {
  patch: uniform(GROUND.patch),
  moss: uniform(GROUND.moss),
  soil: uniform(GROUND.soil),
  clump: uniform(GROUND.clump),
  bump: uniform(GROUND.bump),
  grain: uniform(GROUND.grain),
  pathEdge: uniform(GROUND.pathEdge),
  radius: uniform(PLANET_RADIUS),
};

export function applyGround(): void {
  U.patch.value = GROUND.patch;
  U.moss.value = GROUND.moss;
  U.soil.value = GROUND.soil;
  U.clump.value = GROUND.clump;
  U.bump.value = GROUND.bump;
  U.grain.value = GROUND.grain;
  U.pathEdge.value = GROUND.pathEdge;
}

onPlanetRadius((r) => {
  U.radius.value = r;
});

type ColorUniform = THREE.UniformNode<'color', THREE.Color>;

// 每个预设一组颜色 uniform：同一预设的星球共用（材质各自一份，但颜色节点同一个，?tune 改一次全部生效）
const palettes = new Map<PresetId, Record<keyof GroundPalette, ColorUniform>>();

function paletteOf(preset: PresetId): Record<keyof GroundPalette, ColorUniform> {
  let p = palettes.get(preset);
  if (!p) {
    const g = PRESETS[preset].ground;
    p = {
      grass: uniform(new THREE.Color(g.grass)), dry: uniform(new THREE.Color(g.dry)), moss: uniform(new THREE.Color(g.moss)),
      soil: uniform(new THREE.Color(g.soil)), path: uniform(new THREE.Color(g.path)), rock: uniform(new THREE.Color(g.rock)),
    } as Record<keyof GroundPalette, ColorUniform>;
    palettes.set(preset, p);
  }
  return p;
}

// presets.ts 里的地面颜色改了（?tune）：所有星球的地表立刻换色
export function applyGroundPalette(): void {
  for (const [preset, p] of palettes) {
    const g = PRESETS[preset].ground;
    for (const k of Object.keys(p) as Array<keyof GroundPalette>) p[k].value.set(g[k]);
  }
}

// 地表材质。mask：星球遮罩的贴图节点（R 土路，G 作品空地；mask.ts 里换贴图只改它的 value）
export function groundMaterial(preset: PresetId, mask: THREE.TextureNode): THREE.MeshStandardNodeMaterial {
  const pal = paletteOf(preset);
  const amp = PRESETS[preset].amp;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
  m.name = `ground-${preset}`;
  const p = positionLocal;
  const dir = normalize(p);
  const masks = mask.sample(equirectUV(dir));
  const hn = length(p).div(U.radius).sub(1).div(amp); // 归一化高度 -1..1：低洼处苔藓多、颜色深一点
  const slope = float(1).sub(dot(normalize(normalLocal), dir)); // 0 平地，越陡越大
  const camDist = length(positionView);
  // 防闪：一个像素覆盖多少米（屏幕空间导数）。频率为 f（每米几个周期）的噪声，一个周期少于 ~2 个像素时淡掉
  const perPixel = length(fwidth(p)).max(1e-5);
  const keep = (f: number | THREE.Node<'float'>) => smoothstep(1.2, 3, float(1).div(perPixel.mul(f)));

  const big = fbm2(p.mul(U.patch));
  const mid = valueNoise3(p.mul(0.21).add(11.7));
  const clump = valueNoise3(p.mul(U.clump).add(3.1));
  const tuft = valueNoise3(p.mul(4.3).add(41.0));
  const grain = valueNoise3(p.mul(U.grain).add(57.3));
  const crumb = valueNoise3(p.mul(46).add(5.7));
  const kTuft = keep(4.3);
  const kGrain = keep(U.grain);
  const kCrumb = keep(46);

  // 草地：主草色和干草按大斑混，苔藓按中斑（低洼处更多），再按一丛丛（0.6 米）、一簇簇（0.25 米）、颗粒（几厘米）的明暗起伏。
  // 细的那几层按像素大小淡出：远看是均匀的草色，近看有颗粒
  const dryAmt = smoothstep(0.45, 0.78, big.add(mid.sub(0.5).mul(0.25)));
  const mossAmt = smoothstep(U.moss, U.moss.add(0.16), mid.mul(0.7).add(float(1).sub(big).mul(0.3))).mul(smoothstep(0.4, -0.8, hn).mul(0.45).add(0.55));
  const shade = clump.sub(0.5).mul(0.3).add(tuft.sub(0.5).mul(0.28).mul(kTuft)).add(grain.sub(0.5).mul(0.26).mul(kGrain)).add(1);
  const grass = mix(mix(pal.grass, pal.dry, dryAmt), pal.moss, mossAmt.mul(0.85)).mul(shade);
  // 露土：零星的小块，坡陡的地方更多；土里有颗粒
  const soilAmt = max(smoothstep(U.soil, U.soil.add(0.16), clump.mul(0.55).add(mid.mul(0.45))).mul(0.75), smoothstep(0.05, 0.14, slope));
  const soil = pal.soil.mul(grain.sub(0.5).mul(0.35).mul(kGrain).add(crumb.sub(0.5).mul(0.25).mul(kCrumb)).add(1));
  let meadow = mix(grass, soil, soilAmt);

  // 水塘：水面以下的地面往深青色压（越深越暗，透过半透明的水面看得出深浅），岸边一圈湿土、不长花
  const seaN = float(PRESETS[preset].sea ?? -9);
  const under = smoothstep(seaN.add(0.02), seaN.sub(0.35), hn);
  const shore = smoothstep(seaN.add(0.07), seaN.add(0.005), hn).mul(float(1).sub(under));

  // 远看的野花：白、黄、淡紫的小点（约 0.15 米一朵），只在镜头 20 米以外出现（近处是 3D 的花），防闪按像素大小
  const bloomN = valueNoise3(p.mul(3.4).add(83.1));
  const bloomKind = valueNoise3(p.mul(0.9).add(17.9));
  const bloomPatch = smoothstep(0.35, 0.7, valueNoise3(p.mul(0.12).add(7.7))); // 花一片一片地开，不是到处均匀
  const bloom = smoothstep(0.84, 0.88, bloomN).mul(bloomPatch).mul(smoothstep(20, 40, camDist)).mul(keep(3.4))
    .mul(float(1).sub(soilAmt)).mul(float(1).sub(shore)).mul(0.8);
  const flower = mix(mix(color('#f5f0e1'), color('#f2cc4b'), smoothstep(0.45, 0.55, bloomKind)), color('#b59bd9'), smoothstep(0.68, 0.74, bloomKind));
  meadow = mix(meadow, flower, bloom);
  meadow = mix(meadow, pal.soil.mul(0.8), shore.mul(0.5));

  // 土路：遮罩的边缘按噪声抖一抖，像被踩出来的；路中间被踩得浅一点、平一点，路边深一点、混着草；
  // 路面有细碎石（颗粒、碎屑）。路上的小石头是 3D 的（planet/decor.ts 沿路边撒），这里不画
  const wobble = clump.sub(0.5).mul(U.pathEdge).add(grain.sub(0.5).mul(0.12).mul(kGrain));
  const pathAmt = smoothstep(0.42, 0.6, masks.r.add(wobble)).mul(float(1).sub(under));
  const worn = smoothstep(0.75, 1, masks.r); // 路中线附近
  const dirt = mix(mix(pal.path, pal.soil, smoothstep(0.3, 0.85, mid).mul(0.4)), pal.path.mul(1.08), worn.mul(0.5));
  const gravel = grain.sub(0.5).mul(0.22).mul(kGrain).add(crumb.sub(0.5).mul(0.3).mul(kCrumb)).add(1);
  const pathCol = dirt.mul(gravel);
  const border = pathAmt.mul(float(1).sub(pathAmt)).mul(4);
  let col = mix(meadow, pathCol, pathAmt).mul(float(1).sub(border.mul(0.2)));

  // 作品空地：露土加碎石，边上被草啃得不规则
  const clearAmt = smoothstep(0.38, 0.62, masks.g.add(wobble)).mul(float(1).sub(under));
  const clearCol = mix(pal.soil, pal.path, 0.45).mul(gravel);
  col = mix(col, clearCol, clearAmt);
  // 低洼处暗一点（像积了阴影）；水下往深青色压
  col = col.mul(mix(float(0.86), float(1.04), smoothstep(-0.9, 0.5, hn)));
  col = mix(col, col.mul(0.35).add(color(PRESETS[preset].water).mul(0.25)), under);
  // 掠射角下草地发亮一点（远看一片草叶迎着光的那层绒感）
  const facing = saturate(dot(normalize(normalView), normalize(positionView.negate())));
  const sheen = pow(float(1).sub(facing), 3).mul(float(1).sub(max(pathAmt, clearAmt))).mul(0.22);
  m.colorNode = col.add(pal.dry.mul(sheen));
  m.roughnessNode = mix(float(0.96), float(0.88), max(pathAmt, clearAmt));

  // 细节凹凸（米）：一丛丛的起伏 + 一簇簇 + 颗粒 + 土里的碎屑，路面整体低一点、路上的小石头鼓起来；
  // 每一层都按像素大小淡出，按屏幕空间导数算法线（不需要切线）
  const ground = clump.mul(0.5).add(tuft.mul(0.25).mul(kTuft)).add(grain.mul(0.18).mul(kGrain)).add(crumb.mul(0.07).mul(kCrumb));
  const rough = max(pathAmt, clearAmt);
  const h = ground.sub(rough.mul(0.3)).mul(float(1).sub(under.mul(0.7))).mul(U.bump);
  m.normalNode = perturbNormal(h);
  return m;
}

// Mikkelsen「Bump Mapping Unparametrized Surfaces on the GPU」的原式（不把 dP 归一化：凹凸的斜率按世界单位算，远近一样）
export function perturbNormal(h: THREE.Node<'float'>): THREE.Node<'vec3'> {
  const sigmaX = dFdx(positionView);
  const sigmaY = dFdy(positionView);
  const n = normalize(normalView);
  const r1 = cross(sigmaY, n);
  const r2 = cross(n, sigmaX);
  const det = dot(sigmaX, r1);
  const dh = vec2(dFdx(h), dFdy(h));
  const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
  return normalize(abs(det).mul(n).sub(grad));
}

// 地面颜色（sRGB 十六进制），给 CPU 上要和地面配色一致的东西（石头、远景）用
export function groundHex(preset: PresetId, key: keyof GroundPalette): string {
  return PRESETS[preset].ground[key];
}


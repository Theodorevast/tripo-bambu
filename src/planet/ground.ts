import * as THREE from 'three/webgpu';
import { abs, cross, dFdx, dFdy, dot, equirectUV, float, length, max, mix, normalize, normalLocal, normalView, positionLocal, positionView, sign, smoothstep, uniform, vec2 } from 'three/tsl';
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
  bump: 0.045, // 细节凹凸的高度（米）
  grain: 7, // 颗粒的频率（1/米）
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
  const near = smoothstep(26, 7, camDist); // 颗粒只在近处：远了会闪

  const big = fbm2(p.mul(U.patch));
  const mid = valueNoise3(p.mul(0.21).add(11.7));
  const small = valueNoise3(p.mul(U.clump).add(3.1));
  const fine = valueNoise3(p.mul(U.grain).add(57.3));
  const pebbleN = valueNoise3(p.mul(4.3).add(41.0));

  // 草地：主草色和干草按大斑混，苔藓按中斑（低洼处更多），再按一丛丛的明暗起伏
  const dryAmt = smoothstep(0.42, 0.74, big.add(mid.sub(0.5).mul(0.25)));
  const mossAmt = smoothstep(U.moss, U.moss.add(0.16), mid.mul(0.7).add(float(1).sub(big).mul(0.3))).mul(smoothstep(0.4, -0.8, hn).mul(0.45).add(0.55));
  const grass = mix(mix(pal.grass, pal.dry, dryAmt), pal.moss, mossAmt.mul(0.85)).mul(small.mul(0.3).add(0.82));
  // 露土：零星的小块，坡陡的地方更多
  const soilAmt = max(smoothstep(U.soil, U.soil.add(0.16), small.mul(0.55).add(mid.mul(0.45))).mul(0.75), smoothstep(0.05, 0.14, slope));
  const soil = pal.soil.mul(fine.mul(near).mul(0.3).add(0.85));
  const meadow = mix(grass, soil, soilAmt);

  // 土路：遮罩的边缘按噪声抖一抖，像被踩出来的；路面是浅土色带一点碎石，路边一圈压暗（草的阴影）
  const wobble = small.sub(0.5).mul(U.pathEdge).add(fine.sub(0.5).mul(0.12));
  const pathAmt = smoothstep(0.42, 0.6, masks.r.add(wobble));
  const pebble = smoothstep(0.7, 0.8, pebbleN);
  const pathCol = mix(mix(pal.path, pal.soil, smoothstep(0.3, 0.85, mid).mul(0.35)).mul(fine.mul(near).mul(0.18).add(0.91)), pal.rock.mul(1.12), pebble.mul(0.5));
  const border = pathAmt.mul(float(1).sub(pathAmt)).mul(4);
  let col = mix(meadow, pathCol, pathAmt).mul(float(1).sub(border.mul(0.16)));

  // 作品空地：露土加碎石
  const clearAmt = smoothstep(0.38, 0.62, masks.g.add(wobble));
  const clearCol = mix(mix(pal.soil, pal.path, 0.35).mul(fine.mul(near).mul(0.25).add(0.86)), pal.rock, pebble.mul(0.4));
  col = mix(col, clearCol, clearAmt);
  // 低洼处暗一点（像积了阴影）
  col = col.mul(mix(float(0.86), float(1.04), smoothstep(-0.9, 0.5, hn)));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.95), float(0.86), max(pathAmt, clearAmt));

  // 细节凹凸：高度（米）= 一丛丛的起伏 + 颗粒 + 路上的碎石，路面整体低一点；按屏幕空间导数算法线（不需要切线）
  const h = small.mul(0.55).add(fine.mul(near).mul(0.45)).sub(pathAmt.mul(0.25)).add(pebble.mul(max(pathAmt, clearAmt)).mul(0.35)).mul(U.bump);
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


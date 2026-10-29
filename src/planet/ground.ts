import * as THREE from 'three/webgpu';
import { abs, acos, clamp, color, cross, dFdx, dFdy, dot, equirectUV, float, fwidth, length, max, mix, modelPosition, normalize, normalLocal, normalView, positionLocal, positionView, positionWorld, pow, renderGroup, saturate, sign, sin, smoothstep, uniform, uniformArray, vec2, vec3 } from 'three/tsl';
import type { PresetId } from '../data/types';
import { grassTint } from '../nature/grass';
import { galaxyFactor, overviewFactor, planetSurfaceLook, stageFactor, sunDirNode, sunTint } from '../nature/planetLook';
import { onPlanetRadius, PLANET_RADIUS, PRESETS, type GroundPalette } from './presets';
import { shapeSea } from './noise';
import { SHOWCASE_POLE } from './placement';
import { cellDots, cellPuffs, fbm2, valueNoise3 } from './tslNoise';

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
  // 俯瞰时才有的层次（planet 角色）：0..1 的强度
  farMix: 0.85, // 底色换成俯瞰的春绿（预设的 far）多少
  farTint: 0.3, // 俯瞰那几种颜色（far、field、花）的亮度：和 tint 一样是把 sRGB 颜色对齐到 AgX 下的地面亮度
  fieldSun: 0.8, // 朝阳的黄绿大片
  fieldDeep: 0.7, // 低处的深绿
  // 第二版 [v2-world]：团队色的花海、花田都收着（不要糖果色）：覆盖少、颜色往灰里退，星系里星球降饱和、哑光
  teamCover: 0.16, // 团队色花海的覆盖（星球视图里）
  teamCoverGalaxy: 0.42, // 星系里
  teamBright: 0.95, // 花海的亮度
  teamVivid: 0.8, // 团队色的饱和度（1 = 原色；第一版是 1.35，提过一截）
  fieldFlowers: 0.5, // 花田
  warmCool: 0.8, // 冷暖渐变
  galaxySat: 0.08, // 星系里饱和度再提多少（第一版 0.45：糖果色。第二版地面本身已经是灰调的大地色，星系里只提一点点，五种预设分得开）
  galaxyShade: 0.7, // 星系里背光一侧的环境光压暗多少（0..1）（第二版 1 → 0.7：夜里星球不至于整颗发闷）
  galaxyGloss: 0, // 星系里清漆一样的高光（0 = 和近处一样哑光）
  stoneDetail: 1, // 第二版：石头地、土、路面的细节纹理（裂纹、地衣、碎石）的强度
};

// 第二版 [v2-world]：灯柱脚下的一小片暖光（不加光源）：地面着色器里按离灯柱多远加一点暖色的自发光，夜里画面上有几处暖点。
// 最多 LAMP_POOLS 盏，位置是聚焦星球的本地坐标（米），w = 亮度（0 = 没有）；中古点缀（planet/props-v2.ts）摆好灯柱后写进来，离开星球时清零。
// 只在聚焦的星球上、镜头近的时候有（乘这颗星球的淡出系数和「舞台」系数：星系里、星球视图里缩小的邻居都没有）
export const LAMP_POOLS = 6;
export const LAMP_POOL = { radius: 2.8, strength: 0.32, color: '#ffb45a' };
const lampData = Array.from({ length: LAMP_POOLS }, () => new THREE.Vector4(0, 0, 0, 0));
const lampArr = uniformArray(lampData, 'vec4');
const poolU = {
  radius: uniform(LAMP_POOL.radius).setGroup(renderGroup),
  strength: uniform(LAMP_POOL.strength).setGroup(renderGroup),
  color: uniform(new THREE.Color(LAMP_POOL.color)).setGroup(renderGroup),
};

export function setLampPools(list: ReadonlyArray<{ pos: THREE.Vector3; k: number }>): void {
  for (let i = 0; i < LAMP_POOLS; i++) {
    const l = list[i];
    if (l) lampData[i].set(l.pos.x, l.pos.y, l.pos.z, l.k);
    else lampData[i].set(0, 0, 0, 0);
  }
}

export function applyLampPools(): void {
  poolU.radius.value = LAMP_POOL.radius;
  poolU.strength.value = LAMP_POOL.strength;
  poolU.color.value.set(LAMP_POOL.color);
}

// 第二版 [v2-world]：地面上远看的花、花田的颜色（sRGB）：象牙白、淡香槟、灰紫，都退到灰调里（第一版是奶白、明黄、亮紫）
export const FLOWER_V2 = { ivory: '#ece6d8', gold: '#d3c08f', mauve: '#a99cb8' };

// 外沿的石头地：赤道附近一圈（按纬度的正弦）。center 是这一圈的中心，half 是半宽。
// 星球视图里云海和星球接上的地方大约在纬度 0–10°（镜头从斜上方 26° 看过来），这一圈要压在那条线上
export const RIM = { center: 0.07, half: 0.11 };

// 舞台的边（planet 角色）：星球视图的镜头从展示方向的方位角、仰角 26° 看过来（scenes/shots.ts 的 SHOTS.planet），
// 星球的轮廓是离这个方向 67° 的一圈。在 64° 上摆一圈石头（和上面那圈石头地连起来）：轮廓的左右两边和上沿都是圆润的石头，
// 草地像一块圆台，B-612 设定图那样。angle、width 是球心角（度）
export const RIM_RING = { angle: 64, width: 5 };
export const STAGE_VIEW_DIR: [number, number, number] = (() => {
  const az = Math.atan2(SHOWCASE_POLE[0], SHOWCASE_POLE[2]);
  const el = (26 * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
})();

export const GROUND_SPECULAR = 0.15; // 地面镜面反射的强度（MeshPhysicalNodeMaterial.specularIntensity，标准材质相当于 1）。第二版更哑：0.25 → 0.15

// 地表和草叶的衔接（集成时加的，Dressing 每帧按聚焦星球上的草设）：
// 草画到的范围里，草缝里露出来的地面压暗成草根色（近处），往外按距离过渡到「远看的草色」（grassTint，和草叶同一条公式），
// 草淡出的地方地面接得上，不露出一圈边界
export const GRASS_GROUND = {
  dryness: 0.35, // 枯黄色斑的多少（和草叶的 settings.dryness 一致）
  tint: 0.4, // 远看的草色乘多少（地面是 PBR 受光，草叶是自己的风格化受光：用它把两边的亮度对齐）
};

// 所有地面材质共用的 uniform：放进 renderGroup（每次 render 刷新一次，不跟着某个物体的 objectGroup 走）
const U = {
  patch: uniform(GROUND.patch).setGroup(renderGroup),
  moss: uniform(GROUND.moss).setGroup(renderGroup),
  soil: uniform(GROUND.soil).setGroup(renderGroup),
  clump: uniform(GROUND.clump).setGroup(renderGroup),
  bump: uniform(GROUND.bump).setGroup(renderGroup),
  grain: uniform(GROUND.grain).setGroup(renderGroup),
  pathEdge: uniform(GROUND.pathEdge).setGroup(renderGroup),
  farMix: uniform(GROUND.farMix).setGroup(renderGroup),
  farTint: uniform(GROUND.farTint).setGroup(renderGroup),
  fieldSun: uniform(GROUND.fieldSun).setGroup(renderGroup),
  fieldDeep: uniform(GROUND.fieldDeep).setGroup(renderGroup),
  teamCover: uniform(GROUND.teamCover).setGroup(renderGroup),
  teamCoverGalaxy: uniform(GROUND.teamCoverGalaxy).setGroup(renderGroup),
  teamBright: uniform(GROUND.teamBright).setGroup(renderGroup),
  teamVivid: uniform(GROUND.teamVivid).setGroup(renderGroup),
  stoneDetail: uniform(GROUND.stoneDetail).setGroup(renderGroup),
  fieldFlowers: uniform(GROUND.fieldFlowers).setGroup(renderGroup),
  warmCool: uniform(GROUND.warmCool).setGroup(renderGroup),
  galaxySat: uniform(GROUND.galaxySat).setGroup(renderGroup),
  galaxyShade: uniform(GROUND.galaxyShade).setGroup(renderGroup),
  galaxyGloss: uniform(GROUND.galaxyGloss).setGroup(renderGroup),
  rimCenter: uniform(RIM.center).setGroup(renderGroup),
  rimHalf: uniform(RIM.half).setGroup(renderGroup),
  ringAngle: uniform(RIM_RING.angle).setGroup(renderGroup),
  ringWidth: uniform(RIM_RING.width).setGroup(renderGroup),
  radius: uniform(PLANET_RADIUS).setGroup(renderGroup),
  dryness: uniform(GRASS_GROUND.dryness).setGroup(renderGroup),
  tint: uniform(GRASS_GROUND.tint).setGroup(renderGroup),
  grassOn: uniform(0).setGroup(renderGroup), // 0..1：聚焦星球上的草在不在画（草量 0、还没编译好时是 0）
  grassNear: uniform(6).setGroup(renderGroup), // 草的满密度半径（米）：这以内地面是草根色
  grassFar: uniform(32).setGroup(renderGroup), // 草画到多远（米）：这以外地面就是远看的草色
};

export function applyGround(): void {
  U.patch.value = GROUND.patch;
  U.moss.value = GROUND.moss;
  U.soil.value = GROUND.soil;
  U.clump.value = GROUND.clump;
  U.bump.value = GROUND.bump;
  U.grain.value = GROUND.grain;
  U.pathEdge.value = GROUND.pathEdge;
  U.farMix.value = GROUND.farMix;
  U.farTint.value = GROUND.farTint;
  U.fieldSun.value = GROUND.fieldSun;
  U.fieldDeep.value = GROUND.fieldDeep;
  U.teamCover.value = GROUND.teamCover;
  U.teamCoverGalaxy.value = GROUND.teamCoverGalaxy;
  U.teamBright.value = GROUND.teamBright;
  U.teamVivid.value = GROUND.teamVivid;
  U.stoneDetail.value = GROUND.stoneDetail;
  U.fieldFlowers.value = GROUND.fieldFlowers;
  U.warmCool.value = GROUND.warmCool;
  U.galaxySat.value = GROUND.galaxySat;
  U.galaxyShade.value = GROUND.galaxyShade;
  U.galaxyGloss.value = GROUND.galaxyGloss;
  U.rimCenter.value = RIM.center;
  U.rimHalf.value = RIM.half;
  U.ringAngle.value = RIM_RING.angle;
  U.ringWidth.value = RIM_RING.width;
  U.dryness.value = GRASS_GROUND.dryness;
  U.tint.value = GRASS_GROUND.tint;
}

// 聚焦星球上的草：on 0..1，near / far 是草的满密度半径和最远半径（米）。Dressing 每帧调，值没变就不写
export function setGroundGrass(on: number, near: number, far: number): void {
  U.grassOn.value = on;
  U.grassNear.value = near;
  U.grassFar.value = far;
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
    // 同一预设的地面材质共用：放进 renderGroup
    p = Object.fromEntries(
      (Object.keys(g) as Array<keyof GroundPalette>).map((k) => [k, uniform(new THREE.Color(g[k])).setGroup(renderGroup)]),
    ) as Record<keyof GroundPalette, ColorUniform>;
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
// look：这颗星球的远看部件（nature/planetLook.ts 的云层偏移、淡出系数）：远看时地面上有云影、边缘有一层空气；不给就没有（演示页）
export function groundMaterial(preset: PresetId, mask: THREE.TextureNode, look?: { cloudOffset: THREE.UniformNode<'vec3', THREE.Vector3>; fade: THREE.UniformNode<'float', number>; accent: THREE.UniformNode<'color', THREE.Color>; accentAmount: THREE.UniformNode<'float', number>; construction: THREE.UniformNode<'float', number> }): THREE.MeshStandardNodeMaterial {
  const pal = paletteOf(preset);
  const amp = PRESETS[preset].amp;
  // 草地、泥土是很「哑」的表面：镜面反射压到标准材质的 GROUND_SPECULAR 倍（集成时加的）。
  // AgX 下草地的目标亮度很低（参考图里草地中间调只有天空的几十分之一），标准材质固定 4% 的镜面反射会把偏蓝的天光整片叠上去，
  // 草色发灰、发白（实测星球视图里这一项和草本身的亮度差不多大）
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.94, metalness: 0, specularIntensity: GROUND_SPECULAR });
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

  // 草地：底色是「远看的草色」（grassTint：和草叶同一条公式、同一组颜色，主草色 / 嫩草色一片片交替、枯黄斑），
  // 苔藓按中斑（低洼处更多），再按一丛丛（0.6 米）、一簇簇（0.25 米）、颗粒（几厘米）的明暗起伏。
  // 细的那几层按像素大小淡出：远看是均匀的草色，近看有颗粒
  const tint = grassTint(p, { lush: pal.grass, fresh: pal.fresh, dry: pal.dry, tip: pal.tip, dryness: U.dryness }).mul(U.tint).toVar();
  const mossAmt = smoothstep(U.moss, U.moss.add(0.16), mid.mul(0.7).add(float(1).sub(big).mul(0.3))).mul(smoothstep(0.4, -0.8, hn).mul(0.45).add(0.55));
  // 明暗起伏：中斑（约 5 米，集成时加的：星球视图里草地远看不再是平涂的一片）+ 一丛丛 + 一簇簇 + 颗粒
  const shade = mid.sub(0.5).mul(0.32).add(clump.sub(0.5).mul(0.36)).add(tuft.sub(0.5).mul(0.28).mul(kTuft)).add(grain.sub(0.5).mul(0.26).mul(kGrain)).add(1);
  const grass = mix(tint, pal.moss.mul(U.tint), mossAmt.mul(0.6)).mul(shade);
  // 露土：零星的小块，坡陡的地方更多；土里有颗粒
  const soilAmt = max(smoothstep(U.soil, U.soil.add(0.16), clump.mul(0.55).add(mid.mul(0.45))).mul(0.75), smoothstep(0.05, 0.14, slope));
  // 第二版：土里混着小石子（浅一点、偏石头色的圆点，约 18 厘米一格），按像素大小淡出
  const pebbles = cellDots(p.mul(5.5).add(3.3), 0.45).mul(keep(5.5)).mul(U.stoneDetail);
  const soil = mix(pal.soil.mul(grain.sub(0.5).mul(0.35).mul(kGrain).add(crumb.sub(0.5).mul(0.25).mul(kCrumb)).add(1)), pal.rock.mul(1.25), pebbles.mul(0.45));
  let meadow = mix(grass, soil, soilAmt);
  // 聚焦星球上草画到的范围：草缝里露出来的地面是草丛深处的颜色（草根色，带一点草色），往外按距离过渡回远看的草色。
  // 满密度半径以内全是草根色，到草最远半径的 3/4 处完全是远看的草色（那里草已经很稀，地面的颜色就是草的颜色）
  const canopy = U.grassOn.mul(float(1).sub(smoothstep(U.grassNear.mul(0.8), U.grassFar.mul(0.75), camDist)));
  meadow = mix(meadow, mix(pal.root, tint.mul(0.55), 0.4).mul(shade), canopy);

  // 海岸（planet 角色）：rel 是离「海面」的归一化高度（没有水的预设是假想的低地线），岸线附近加一点噪声抖动，
  // 色带边缘不跟着三角形走成直线。海面以下：浅处是沙、往深处过渡到深青（透过半透明的水面看得出深浅）；
  // 岸上一窄条沙滩、湿沙。没有水的预设，低地线以下是盆地：沙漠是发白的干湖，火山是灰紫的火山灰平原
  const hasWater = PRESETS[preset].sea !== null;
  const rel = hn.sub(shapeSea(preset)).add(mid.sub(0.5).mul(0.08)).add(clump.sub(0.5).mul(0.04).mul(keep(U.clump)));
  const lowFloor = smoothstep(0.012, -0.025, rel); // 水下 / 盆地里
  const depthT = smoothstep(0.0, 0.42, rel.negate());
  const under = hasWater ? lowFloor : float(0);
  const beach = smoothstep(hasWater ? 0.075 : 0.07, hasWater ? 0.018 : 0.0, rel).mul(float(1).sub(lowFloor));
  const shore = smoothstep(0.05, 0.012, rel).mul(float(1).sub(lowFloor));
  // 高地偏干、偏黄；靠海的低地更嫩、更绿（远看一块块大陆有层次）
  const upland = smoothstep(0.14, 0.6, rel);
  const lowland = smoothstep(0.32, 0.1, rel).mul(float(1).sub(beach));
  meadow = mix(meadow, pal.dry.mul(U.tint).mul(shade), upland.mul(0.3));
  meadow = mix(meadow, meadow.mul(1.12), lowland.mul(0.4));
  const sandCol = pal.sand.mul(grain.sub(0.5).mul(0.25).mul(kGrain).add(mid.sub(0.5).mul(0.2)).add(1));
  meadow = mix(meadow, sandCol, beach.mul(hasWater ? 0.8 : 0.6));

  // 俯瞰的草甸（planet 角色）：星球视图、星系里没有 3D 的草，地面自己要有「画出来的」层次——
  // 底色换成更亮、更鲜的春绿（预设的 far），上面一大片一大片朝阳的黄绿（field）、低处偏蓝的深绿、
  // 几片花田（一层花色 + 一格一个的圆点小花）。贴地时（漫游）全部淡掉，交给 3D 的草和花，地面颜色和草叶对得上
  const overview = overviewFactor(U.radius);
  const field = fbm2(p.mul(0.03).add(31.2)).mul(0.65).add(valueNoise3(p.mul(0.075).add(5.1)).mul(0.35)); // 约 33 米、13 米两层
  const meadowOnly = float(1).sub(beach).mul(float(1).sub(lowFloor));
  const farBase = pal.far.mul(U.farTint).mul(shade);
  meadow = mix(meadow, farBase, overview.mul(U.farMix));
  const sunny = smoothstep(0.45, 0.6, field).mul(smoothstep(-0.02, 0.2, rel)).mul(meadowOnly);
  const hollow = max(smoothstep(0.42, 0.29, field), smoothstep(0.26, 0.06, rel).mul(0.7)).mul(meadowOnly);
  // 朝阳的大片往团队色靠一点（星系里同一个预设的几颗星球分得开）
  const fieldCol = look ? mix(pal.field, look.accent, look.accentAmount.mul(0.18)) : pal.field; // 第二版：团队色只染一点（0.38 → 0.18）
  meadow = mix(meadow, fieldCol.mul(U.farTint).mul(shade), sunny.mul(overview).mul(U.fieldSun));
  meadow = mix(meadow, pal.far.mul(U.farTint).mul(0.42).mul(color('#cfe0ee')).mul(shade), hollow.mul(overview).mul(U.fieldDeep));
  // 团队的花海（planet 角色，lead 第三轮）：约 30 米一片、按噪声扭过的大块，颜色是团队色（提一点饱和、按 AgX 对齐亮度），
  // 里面有更亮的小花点。星系里覆盖得多一些（一眼分得开：金色麦浪、薰衣草、樱粉、雪原……），星球视图里少一点（作品是主角）
  if (look) {
    const tq = p.mul(0.026).add(valueNoise3(p.mul(0.018).add(9.7)).sub(0.5).mul(2.4));
    const teamN = fbm2(tq.add(51.3));
    const cover = mix(U.teamCover, U.teamCoverGalaxy, galaxyFactor(U.radius)).mul(float(1).sub(look.construction.mul(0.5)));
    const th = float(0.66).sub(cover.mul(0.3));
    const teamAmt = smoothstep(th, th.add(0.05), teamN).mul(meadowOnly).mul(overview).mul(look.accentAmount);
    const accentLin = look.accent as unknown as THREE.Node<'vec3'>; // 颜色 uniform 在着色器里就是 vec3
    const luma = dot(accentLin, vec3(0.2126, 0.7152, 0.0722));
    const vivid = mix(vec3(luma), accentLin, U.teamVivid).max(0.002);
    const teamCol = vivid.mul(U.farTint).mul(U.teamBright).mul(shade);
    meadow = mix(meadow, teamCol, teamAmt.mul(0.85));
    const teamDots = cellDots(p.mul(1.8).add(33.3), 0.6).mul(keep(1.8));
    meadow = mix(meadow, mix(vivid, vec3(1), 0.45).mul(0.5), teamDots.mul(teamAmt).mul(0.6));
  }
  // 花田：约 13 米一片（按噪声扭过，边缘不规则），每片一种主色（白、黄、淡紫）
  const fq = p.mul(0.075).add(valueNoise3(p.mul(0.035).add(3.9)).sub(0.5).mul(3));
  const flowerField = smoothstep(0.57, 0.67, valueNoise3(fq.add(77.7))).mul(meadowOnly).mul(overview).mul(float(1).sub(galaxyFactor(U.radius).mul(0.75))).mul(U.fieldFlowers);
  const fHue = valueNoise3(p.mul(0.04).add(13.3));
  // 第三种花：淡紫，有团队色时换成团队色（调淡一点，像一片那个颜色的花）。
  // 第二版：花色都退到灰调里——象牙白、淡香槟、灰紫（不要明黄、亮紫）
  const third = look ? mix(color(FLOWER_V2.mauve), mix(look.accent, color(FLOWER_V2.ivory), 0.35), look.accentAmount) : color(FLOWER_V2.mauve);
  const fCol = mix(mix(color(FLOWER_V2.ivory), color(FLOWER_V2.gold), smoothstep(0.48, 0.54, fHue)), third, smoothstep(0.64, 0.7, fHue));
  const speck = max(cellDots(p.mul(1.5).add(91.3), 0.7).mul(keep(1.5)), cellDots(p.mul(2.4).add(17.1), 0.55).mul(keep(2.4)));
  meadow = mix(meadow, mix(meadow, fCol.mul(U.farTint).mul(2.2), 0.5), flowerField.mul(0.4));
  meadow = mix(meadow, fCol.mul(0.8), speck.mul(flowerField).mul(0.9));

  // 外沿（planet 角色）：赤道附近一圈石头地——星球视图里草地圆台的边、和云海接上的那一圈，像小王子 B-612 设定图的外沿。
  // 一段一段的（不是一整条带子），石头顶上长苔藓，石缝深一点。3D 的大石头沿同一圈摆（planet/decor.ts）
  const rimWob = valueNoise3(p.mul(0.07).add(61.7)).sub(0.5).mul(0.14);
  const rimBand = smoothstep(U.rimHalf.add(0.06), U.rimHalf.sub(0.02), abs(dir.y.sub(U.rimCenter).add(rimWob)));
  const rimSeg = smoothstep(0.3, 0.52, valueNoise3(p.mul(0.06).add(23.9)));
  // 舞台的边：离星球视图镜头方向 RIM_RING.angle 的一圈（星球视图里正好在轮廓上），宽度也按噪声起伏
  const ringAng = acos(clamp(dot(dir, vec3(...STAGE_VIEW_DIR)), -1, 1)).mul(180 / Math.PI);
  const ringBand = smoothstep(U.ringWidth.add(2.5), U.ringWidth.sub(1), abs(ringAng.sub(U.ringAngle).add(rimWob.mul(40))));
  const rocky = max(rimBand.mul(rimSeg), ringBand.mul(smoothstep(0.22, 0.45, valueNoise3(p.mul(0.06).add(41.3))))).mul(meadowOnly).mul(stageFactor(U.radius)).toVar();
  // 第二版：石头的质感——细细的裂纹（暗）、零星的地衣斑（浅、偏 Lichen 的灰黄绿）、表面的颗粒，都按像素大小淡出
  const crackN = valueNoise3(p.mul(1.7).add(19.3));
  const crack = float(1).sub(smoothstep(0.0, 0.045, abs(crackN.sub(0.5)))).mul(keep(1.7)).mul(U.stoneDetail);
  const lichen = cellDots(p.mul(2.2).add(7.7), 0.4).mul(keep(2.2)).mul(U.stoneDetail);
  const stoneBase = pal.rock.mul(mid.sub(0.5).mul(0.35).add(clump.sub(0.5).mul(0.3)).add(grain.sub(0.5).mul(0.2).mul(kGrain)).add(crumb.sub(0.5).mul(0.16).mul(kCrumb)).add(1.15));
  const stone = mix(stoneBase.mul(float(1).sub(crack.mul(0.38))), stoneBase.mul(vec3(1.3, 1.32, 1.12)), lichen.mul(0.5));
  const mossTop = smoothstep(0.45, 0.7, clump.mul(0.6).add(fbm2(p.mul(0.4).add(8.8)).mul(0.4)));
  const rimCol = mix(stone, pal.moss.mul(U.tint).mul(1.25), mossTop.mul(0.45));
  meadow = mix(meadow, rimCol, rocky);

  // 远看的野花：白、黄、淡紫的小点（约 0.15 米一朵），只在镜头 20 米以外出现（近处是 3D 的花），防闪按像素大小
  const bloomN = valueNoise3(p.mul(3.4).add(83.1));
  const bloomKind = valueNoise3(p.mul(0.9).add(17.9));
  const bloomPatch = smoothstep(0.35, 0.7, valueNoise3(p.mul(0.12).add(7.7))); // 花一片一片地开，不是到处均匀
  // 远看的花点比原来稀、淡一些（集成时调的）：地面按 AgX 压暗以后，原来的密度在星球视图里像撒了一层彩色碎屑
  const bloom = smoothstep(0.87, 0.91, bloomN).mul(bloomPatch).mul(smoothstep(20, 40, camDist)).mul(keep(3.4))
    .mul(float(1).sub(soilAmt)).mul(float(1).sub(max(beach, lowFloor))).mul(float(1).sub(rocky)).mul(0.55);
  const flower = mix(mix(color(FLOWER_V2.ivory), color(FLOWER_V2.gold), smoothstep(0.45, 0.55, bloomKind)), color(FLOWER_V2.mauve), smoothstep(0.68, 0.74, bloomKind));
  meadow = mix(meadow, flower, bloom);
  // 贴着水边的一圈湿沙（颜色深一点）
  meadow = mix(meadow, sandCol.mul(hasWater ? 0.62 : 0.85), shore.mul(0.55));

  // 土路：遮罩的边缘按噪声抖一抖，像被踩出来的；路中间被踩得浅一点、平一点，路边深一点、混着草；
  // 路面有细碎石（颗粒、碎屑）。路上的小石头是 3D 的（planet/decor.ts 沿路边撒），这里不画
  const wobble = clump.sub(0.5).mul(U.pathEdge).add(grain.sub(0.5).mul(0.12).mul(kGrain));
  const pathAmt = smoothstep(0.42, 0.6, masks.r.add(wobble)).mul(float(1).sub(under));
  const worn = smoothstep(0.75, 1, masks.r); // 路中线附近
  const dirt = mix(mix(pal.path, pal.soil, smoothstep(0.3, 0.85, mid).mul(0.4)), pal.path.mul(1.08), worn.mul(0.5));
  const gravel = grain.sub(0.5).mul(0.22).mul(kGrain).add(crumb.sub(0.5).mul(0.3).mul(kCrumb)).add(1);
  // 第二版（轻中古的一点）：路中间铺着一块块磨圆的踏石（约 0.9 米一格，不是每格都有），石缝里是土；路边还是土路
  const paver = cellPuffs(p.mul(1.15).add(5.5), 0.82).mul(keep(1.15)).mul(smoothstep(0.62, 0.9, masks.r)).mul(U.stoneDetail).toVar();
  const paverCol = mix(pal.rock, pal.path, 0.35).mul(1.18).mul(gravel).mul(float(1).sub(crack.mul(0.25)));
  const pathCol = mix(dirt.mul(gravel), paverCol, paver);
  const border = pathAmt.mul(float(1).sub(pathAmt)).mul(4);
  let col = mix(meadow, pathCol, pathAmt).mul(float(1).sub(border.mul(0.2)));

  // 作品空地：露土加碎石，边上被草啃得不规则
  const clearAmt = smoothstep(0.38, 0.62, masks.g.add(wobble)).mul(float(1).sub(under));
  // 作品空地；建设中的星球上是工地：浅色的沙土（远远地看得出来是一块刚翻过的地）
  // 工地上一垄一垄翻过的土（平行的条纹，约 0.8 米一垄，按像素大小淡出）
  const furrow = look ? sin(dot(p, vec3(0.83, 0.12, -0.55)).mul(7.8)).mul(0.5).add(0.5).mul(keep(1.25)).mul(look.construction) : float(0);
  const siteSand = mix(pal.sand, pal.path, 0.45).mul(float(1.05).sub(furrow.mul(0.22))).mul(mix(float(1), float(0.8), galaxyFactor(U.radius)));
  const clearCol = look ? mix(mix(pal.soil, pal.path, 0.45), siteSand, look.construction).mul(gravel) : mix(pal.soil, pal.path, 0.45).mul(gravel);
  col = mix(col, clearCol, clearAmt);
  // 低洼处暗一点（像积了阴影）
  col = col.mul(mix(float(0.9), float(1.03), smoothstep(-0.2, 0.5, rel)));
  // 海底 / 盆地：浅处是沙，往深处过渡到 deep；盆地里再加大块的深浅斑（干湖的盐壳、火山灰的起伏）
  const floorMottle = mid.sub(0.5).mul(0.3).add(clump.sub(0.5).mul(0.16)).add(1);
  const floorCol = mix(pal.sand.mul(hasWater ? 0.5 : 1), pal.deep, depthT.mul(hasWater ? 1 : 0.75)).mul(floorMottle);
  col = mix(col, floorCol, lowFloor);
  // 掠射角下草地发亮一点（远看一片草叶迎着光的那层绒感）
  const facing = saturate(dot(normalize(normalView), normalize(positionView.negate())));
  const sheen = pow(float(1).sub(facing), 3).mul(float(1).sub(max(pathAmt, clearAmt))).mul(0.12).mul(look ? look.fade : float(1)); // 第二版更哑：0.22 → 0.12
  col = col.add(pal.dry.mul(sheen));
  // 冷暖（俯瞰时）：朝太阳的一侧偏暖、背光一侧偏冷，整颗星球上有一层柔和的冷暖渐变
  col = col.mul(sunTint(normalize(positionWorld.sub(modelPosition)), overview.mul(U.warmCool)));
  // 星系里（像一颗颗上了色的玻璃弹珠）：饱和度提一截，背光一侧的环境光压暗（明暗分得开，不是一层奶白的雾）
  // 乘上这颗星球的淡出系数：星球视图里缩小的邻居（淡出到 0）不要这些——它们沉在云海里，清漆的反光会在云上勾出一圈泡泡的边
  const gal = look ? galaxyFactor(U.radius).mul(look.fade) : galaxyFactor(U.radius);
  const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, float(1).add(gal.mul(U.galaxySat)));
  m.aoNode = mix(float(1), smoothstep(-0.35, 0.45, dot(normalize(positionWorld.sub(modelPosition)), sunDirNode())).mul(0.55).add(0.45), gal.mul(U.galaxyShade));
  // 远看（planet 角色）：云影压暗地面，星球边缘一层按受光的空气（自发光，夜面没有）
  if (look) {
    const far = planetSurfaceLook(U.radius, look.cloudOffset, look.fade, color(new THREE.Color(PRESETS[preset].atmosphere)));
    col = col.mul(far.shade);
    // 灯柱脚下的暖光（见 LAMP_POOLS）：离灯柱越近越亮（平方衰减），路面、草地一样亮
    let pool: THREE.Node<'float'> = float(0);
    for (let i = 0; i < LAMP_POOLS; i++) {
      const L = lampArr.element(i) as unknown as THREE.Node<'vec4'>;
      pool = pool.add(L.w.mul(smoothstep(poolU.radius, 0, length(p.sub(L.xyz))).pow(2)));
    }
    const warm = (poolU.color as unknown as THREE.Node<'vec3'>).mul(pool.mul(poolU.strength).mul(look.fade).mul(stageFactor(U.radius)));
    m.emissiveNode = far.haze.add(warm);
  }
  m.colorNode = col;
  // 星系里像上了一层清漆的弹珠：粗糙度降一点、镜面反射强一点，朝阳一侧有一块柔和的高光
  m.roughnessNode = mix(mix(float(0.96), float(0.88), max(pathAmt, clearAmt)), float(0.5), gal.mul(U.galaxyGloss));
  // 星球视图里缩小的邻居（淡出到 0）：镜面反射关掉——它们沉在云海里，轮廓上一圈菲涅尔反光会在云上勾出一个泡泡
  m.specularIntensityNode = mix(float(GROUND_SPECULAR), float(0.7), gal.mul(U.galaxyGloss)).mul(look ? look.fade : float(1));

  // 细节凹凸（米）：一丛丛的起伏 + 一簇簇 + 颗粒 + 土里的碎屑，路面整体低一点、路上的小石头鼓起来；
  // 每一层都按像素大小淡出，按屏幕空间导数算法线（不需要切线）
  const ground = clump.mul(0.5).add(tuft.mul(0.25).mul(kTuft)).add(grain.mul(0.18).mul(kGrain)).add(crumb.mul(0.07).mul(kCrumb));
  const rough = max(pathAmt, clearAmt);
  // 第二版：踏石鼓起来一点、石头地上的裂纹凹下去
  const h = ground.sub(rough.mul(0.3)).add(paver.mul(pathAmt).mul(0.45)).sub(crack.mul(rocky).mul(0.35)).mul(float(1).sub(under.mul(0.7))).mul(U.bump);
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


import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  dot,
  exp,
  float,
  fog,
  fract,
  length,
  log2,
  max,
  min,
  mix,
  modelViewMatrix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  renderGroup,
  screenCoordinate,
  saturate,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { BLUE_HOUR, homeNightCloud, MOONLIT, nightLayer, NIGHT_SKY, NIGHT_U, seaMoonlight, seaNightAlpha, skyLuma, underSky, updateNightSky } from './nightSky';
import { createSkyDust } from './skyDust';

// 天空、云海和光照（独立模块）。参考《小王子：星辰之旅》：淡蓝到奶白的天空、星球下方和四周厚厚的云海、低角度的暖色太阳。
//
// 组成：
// - 天空球：单位球，顶点着色器把它推到远裁剪面（和 three 画 scene.backgroundNode 的做法一样），不受镜头远平面限制；
//   颜色全在 TSL 里算：地平线奶白 → 往上淡蓝，太阳一圈柔和光晕，日落时粉紫到橙金。地平线以下画「远处云海」的颜色。
// - 云海：一块很大的圆盘放在云层顶面，片元里沿视线往下做高度场光线步进（一张 CPU 烘焙的可平铺噪声贴图，步进只采样贴图，
//   不现算噪声），找到云顶后按法线、高度打光：顶部受光偏暖，凹处和底部偏冷偏暗，远处按距离融进地平线的雾色。
//   星球用解析球求交：视线先碰到星球就不画云；云贴近星球表面时变透明，和星球表面的高度雾一起做软过渡。
// - 远处积云：几十个朝向镜头的圆形面片（球形假法线 + 噪声侵蚀的软边），几朵一簇，像绘本里的积云，一次绘制。
// - 光照：低角度暖色平行光（sun）；环境光是解析的天空环境（scene.environmentNode，和天空共用一套颜色，不烘贴图），
//   金属材质反射的是天空和云海，不会发黑；scene.fogNode 是偏天空色的距离雾 + 云海附近的高度雾。
// - 色调映射 AgX（理由见报告），曝光随预设。不加全屏 bloom：太阳光晕直接画在天空和云的着色里，作品不会被糊。
//
// 「上」方向：在轨道视角里是世界 +Y；镜头贴地时跟着镜头所在位置的球面法线转（漫游时走到星球侧面、背面，地平线和云海仍然在脚下），
// 轨道镜头转到星球下方时也会倾斜，保证镜头总在云海上方。太阳方向跟着这个标架一起转（平行移动，翻过两极不会跳）。

// blue（蓝调时刻）、moon（月夜）是第二版的夜里预设（v2-sky，nature/nightSky.ts），游戏里默认 blue
export type AtmospherePreset = 'day' | 'sunset' | 'blue' | 'moon';

export interface AtmosphereOptions {
  planetRadius: number;
  preset?: AtmospherePreset;
  // 阴影相机由谁摆：默认这里按整颗星球框（演示页）；游戏里 World 自己摆（跟着镜头看的地方），传 false
  frameShadow?: boolean;
}

// 可调参数（演示页的 Tweakpane 直接改这张表，update() 每帧读）。切换预设时太阳高度、方位会在 2 秒内过渡到预设值
export interface AtmosphereParams {
  sunElevation: number; // 太阳高度角（度），相对当前的「上」
  sunAzimuth: number; // 太阳方位角（度，从 +Z 转向 +X）
  seaHeight: number; // 云海平均顶面相对星球中心的高度（× 半径；负数在中心以下）
  seaThickness: number; // 云层厚度（× 半径）：云顶起伏和凹处的落差
  cloudScale: number; // 云团大小的倍数
  cloudSpeed: number; // 流动速度的倍数
  fog: number; // 距离雾浓度的倍数
  exposure: number; // 曝光的倍数（乘在预设的曝光上）
  farClouds: boolean; // 远处积云
  cloudSteps: number; // 云海每个像素的步进次数（画质 / 开销的旋钮：24 默认；弱显卡可降到 12 左右，开销大致按比例下降）
  seaAmount: number; // 0..1：云海、远处积云和高度雾一起淡出（星系视图里没有聚焦的星球，云海压到 0；集成时加的）
}

// setPlanet 的可选项（集成时加的），和星球中心、半径一起缓动：
// seaDrop：云海再往下压多少（× 半径）。星系视图里没有聚焦的星球，云海压到所有星球下面（星球浮在云海上，不穿过云层）；
// fog：距离雾的倍数（乘在 params.fog 上）。星系视图镜头离星球几百米，雾按星球视图的浓度会把星球糊成一片灰
export interface AtmospherePlanetOptions {
  seaDrop?: number;
  fog?: number;
  calm?: number; // 0..1：首页（星系视图）把云海放安静（见 CALM），和中心一起缓动
}

// 首页的云海放安静（H2）：calm = 1 时按这些比例改，0 时完全是原样（星球视图不受影响）。
// 起伏变平、云团变大（少掉碎的高频细节）、贴图取更模糊的一级、明暗对比收一些、空气透视浓一点；
// 天上的细云条和远处的积云淡掉，天空只剩一层柔和的渐变。步进次数跟着少（云面平了，少走几步也找得准），GPU 也省一点
// 首页云海的暖奶油色（线性、曝光前，和 PRESETS 的云同一个空间）：亮面、中间调、背光、缝隙差得不多，整片是一层柔和的奶油
const CALM_CREAM = {
  lit: new THREE.Vector3(1.32, 1.04, 0.64),
  mid: new THREE.Vector3(0.9, 0.67, 0.44),
  shade: new THREE.Vector3(0.62, 0.45, 0.34),
  deep: new THREE.Vector3(0.48, 0.34, 0.28),
};

export const CALM = {
  thickness: 0.45, // 云层厚度少多少（起伏）
  scale: 0.7, // 云团放大多少（+70%）
  blur: 0.6, // 贴图细节等级再模糊多少倍
  soft: 0.35, // 背光、缝隙的颜色往中间调靠多少（明暗对比）
  haze: 0.9, // 空气透视浓多少
  streaks: 1, // 天上的细云条淡掉多少
  puffs: 0.75, // 远处积云淡掉多少
  steps: 0.4, // 步进次数少多少
  horizon: 1.6, // 地平线附近融进雾色的范围宽多少（镜头低的时候，远处的云海和天空之间没有一条硬边）
  cream: 0.7, // 云的颜色往一套暖奶油色（CALM_CREAM）靠多少：没有粉紫的斑驳，首页的星尘跳得出来
  dim: 0.2, // 云海、地平线的雾色暗多少（金色的星尘叠在上面才「发光」）
};

export interface Atmosphere {
  update(dtSec: number, camera: THREE.Camera): void;
  setPreset(p: AtmospherePreset): void;
  setPlanet(center: THREE.Vector3, radius: number, opts?: AtmospherePlanetOptions): void; // 云海跟着当前聚焦的星球
  sun: THREE.DirectionalLight; // 主光（低角度、暖色）
  sunDir: THREE.Vector3; // 太阳方向（从场景指向太阳，单位向量），给草做逆光用
  dispose(): void;
  // 以下是演示页和自查用的附加成员
  readonly params: AtmosphereParams;
  readonly up: THREE.Vector3; // 当前的「上」
  readonly preset: AtmospherePreset;
  readonly objects: { sky: THREE.Mesh; sea: THREE.Mesh; clouds: THREE.Mesh };
  visible: boolean; // 天空、云海、远处积云和雾一起显示 / 隐藏（量开销时对比用；光照和环境贴图不受影响）
  // 以下是集成时加的最小接口
  setRain(amount: number): void; // 0..1（生机层 onRain 给的平滑雨量）：光变冷变暗，天和云发灰，雾浓一点
  readonly rain: number;
  readonly seaTop: number; // 云顶的平均高度（世界坐标 y；星系视图里「上」是 +Y）：星球在云海上的影子贴在这里（H2）
  readonly horizon: THREE.Color; // 现在的地平线雾色（线性、曝光前；含预设过渡和雨）：首页把后排的星球往这个颜色淡（H2）
  // 漫游时地平线的「上」：传 camera.up（角色脚下的球面法线），标架直接跟着它；传 null 回到按镜头位置算（轨道视角）
  setHorizonUp(up: THREE.Vector3 | null): void;
  // 首页（H2）：太阳的方位角再加多少度（跟着镜头左右转：星系转到背面也是迎光的，不会背光发黑）。只改 uniform，不加灯
  setSunTurn(deg: number): void;
  readonly night: number; // 现在的夜（0..1，含预设过渡和雨；v2-sky）：日落光束、生机层的傍晚系数按它走
}

// ---------------------------------------------------------------------------------------------
// 预设

type RGB = THREE.Color;

// 天空和云的颜色都是「线性、曝光前」的值：从参考图（F4、F5、F9）按区域取色，再把 three 的 AgX 反过来算出来的
// （曝光 1.4 时，色调映射后正好是参考图的颜色）。所以这些值可以大于 1，而且比看上去的颜色更深、更饱和：AgX 会把亮色往白里压
export interface Palette {
  zenith: RGB; // 天顶（高度角 gradZenith 以上）
  upper: RGB; // 高空（高度角 gradUpper 处）
  horizon: RGB; // 地平线（背着太阳的一侧）
  horizonSun: RGB; // 地平线（朝太阳的一侧）
  gradUpper: number; // 地平线色 → 高空色在多高处完成（高度角的正弦）
  gradZenith: number; // 高空色 → 天顶色在多高处完成
  glow: RGB; // 太阳周围的光晕色
  glowStrength: number;
  streaks: number; // 高空细云条的浓度
  sunDisc: RGB; // 日轮（HDR，色调映射后是白的）
  sunLight: RGB; // 平行光颜色
  sunIntensity: number;
  cloudLit: RGB; // 云海受光面（最亮的 5%）
  cloudMid: RGB; // 云海的中间调（一半的像素在这附近）
  cloudShade: RGB; // 背光面
  cloudDeep: RGB; // 最深的缝隙
  ground: RGB; // 环境贴图里正下方的颜色：脚下草地反上来的光（风格化光照里的「地面反弹光」）
  envIntensity: number; // 环境贴图强度
  envBelow: number; // 环境贴图里地平线以下、远处云海的亮度倍数
  fogDensity: number; // 距离雾（每米）
  exposure: number;
  sunElevation: number; // 度
  sunAzimuth: number; // 度
  // 第二版的夜空（v2-sky，nightSky.ts）：白天、日落都是 0
  night: number; // 0..1：星星、银河、月亮、云的月光银边和云缝、夜里的冷色补光
  stars: number; // 星星的亮度
  moon: number; // 月亮的亮度
  moonPhase: number; // 月相：0 新月 … 0.5 满月
}

const lin = (r: number, g: number, b: number) => new THREE.Color(r, g, b); // 直接写线性值，不做 sRGB 转换

export const PRESETS: Record<AtmospherePreset, Palette> = {
  // 白天（F4、F5）：天顶 #5b91be 左右的蓝，往下 #85a2c1，地平线奶白偏灰，朝太阳一侧奶黄；
  // 云：亮面 #e5dec7，中间调偏粉灰 #b8a8aa，背光 #938e9e 灰紫，缝隙 #777d98 蓝灰。太阳高 22°
  day: {
    zenith: lin(0.045, 0.17, 0.47),
    upper: lin(0.15, 0.26, 0.54),
    horizon: lin(0.62, 0.6, 0.55),
    horizonSun: lin(1.15, 0.95, 0.58),
    gradUpper: 0.11,
    gradZenith: 0.42,
    glow: lin(1.0, 0.86, 0.62),
    glowStrength: 1,
    streaks: 0.35,
    sunDisc: lin(14, 12.5, 10),
    sunLight: lin(1, 0.88, 0.72),
    sunIntensity: 6,
    cloudLit: lin(1.68, 1.4, 0.74),
    cloudMid: lin(0.6, 0.45, 0.42),
    cloudShade: lin(0.2, 0.18, 0.27),
    cloudDeep: lin(0.095, 0.11, 0.22),
    ground: lin(0.1, 0.15, 0.05),
    envIntensity: 0.8,
    envBelow: 0.7,
    fogDensity: 0.0004,
    exposure: 1.4,
    sunElevation: 22,
    sunAzimuth: 35,
    night: 0,
    stars: 0,
    moon: 0,
    moonPhase: 0.25,
  },
  // 日落（F9、F2）：天顶 #9b87a2 灰紫，往下粉，地平线 #b38e8e 玫瑰灰，朝太阳一侧 #d9b59e 橙金；
  // 云：亮面 #e2c3ad 桃色，中间调 #dcb4a1，背光 #bc948f 粉灰，缝隙 #8f7582 紫灰。太阳高 6°
  sunset: {
    zenith: lin(0.23, 0.13, 0.27),
    upper: lin(0.32, 0.18, 0.28),
    horizon: lin(0.42, 0.19, 0.19),
    horizonSun: lin(1.05, 0.47, 0.22),
    gradUpper: 0.2,
    gradZenith: 0.62,
    glow: lin(1.35, 0.66, 0.38),
    glowStrength: 1,
    streaks: 0.6,
    sunDisc: lin(12, 8.5, 5),
    sunLight: lin(1, 0.6, 0.36),
    sunIntensity: 5,
    cloudLit: lin(1.34, 0.6, 0.3),
    cloudMid: lin(0.95, 0.37, 0.22),
    cloudShade: lin(0.46, 0.19, 0.17),
    cloudDeep: lin(0.18, 0.095, 0.14),
    ground: lin(0.12, 0.1, 0.06),
    envIntensity: 1,
    envBelow: 0.7,
    fogDensity: 0.0005,
    exposure: 1.4,
    sunElevation: 6,
    sunAzimuth: 35,
    night: 0,
    stars: 0,
    moon: 0,
    moonPhase: 0.25,
  },
  blue: BLUE_HOUR,
  moon: MOONLIT,
};

// 下雨时往这一套靠（集成时加的）：阴天的冷灰，太阳弱、偏冷，天光和云都发灰，雾浓一些、曝光低一点。
// 太阳的高度、方位不跟着变（雨停了光照方向还是原来的）。雨量 1 时混到 RAIN_MIX，留一点预设的色调（日落下雨还带一点暖）
export const RAIN_MIX = 0.82;
export const RAIN_PALETTE: Palette = {
  zenith: lin(0.13, 0.16, 0.21),
  upper: lin(0.2, 0.23, 0.28),
  horizon: lin(0.4, 0.42, 0.44),
  horizonSun: lin(0.52, 0.51, 0.49),
  gradUpper: 0.2,
  gradZenith: 0.6,
  glow: lin(0.35, 0.35, 0.36),
  glowStrength: 0.25,
  streaks: 0.85,
  sunDisc: lin(1.6, 1.6, 1.6),
  sunLight: lin(0.78, 0.84, 0.95),
  sunIntensity: 2.2,
  cloudLit: lin(0.78, 0.8, 0.84),
  cloudMid: lin(0.36, 0.38, 0.43),
  cloudShade: lin(0.15, 0.16, 0.2),
  cloudDeep: lin(0.07, 0.08, 0.11),
  ground: lin(0.06, 0.08, 0.05),
  envIntensity: 0.75,
  envBelow: 0.6,
  fogDensity: 0.0016,
  exposure: 1.22,
  sunElevation: 22,
  sunAzimuth: 35,
  night: 0,
  stars: 0,
  moon: 0,
  moonPhase: 0.25,
};

export const TRANSITION_SECONDS = 2;
export const PLANET_SECONDS = 1.2; // 换星球时云海移过去的时长，和游戏里镜头在星球之间飞的时长一样

// 两套预设之间插值（颜色在线性空间插值），写进 out
export function blendPalette(out: Palette, a: Palette, b: Palette, k: number): Palette {
  for (const key of Object.keys(a) as (keyof Palette)[]) {
    const va = a[key];
    const vb = b[key];
    if (va instanceof THREE.Color && vb instanceof THREE.Color) {
      if (k >= 1) (out[key] as THREE.Color).copy(vb);
      else (out[key] as THREE.Color).copy(va).lerp(vb, k);
    } else (out[key] as number) = k >= 1 ? (vb as number) : (va as number) + ((vb as number) - (va as number)) * k;
  }
  return out;
}

export function clonePalette(p: Palette): Palette {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) out[k] = v instanceof THREE.Color ? v.clone() : v;
  return out as unknown as Palette;
}

// 过渡曲线：两端平缓（smootherstep）
export function ease(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// 星球周围堆起来的云有多高（× 半径；首页放安静时按 1 − calm 收掉）
const COLLAR = 0.45;

// 云海圆盘离星球中心多高（沿「上」，米）：云层最高处（云底 + 厚度 + 星球周围的堆云）再高 0.5 米；drop、calm 是 setPlanet 的 seaDrop、calm。
// 圆盘以上没有云；圆盘以下、离星球远的地方云海是不透明的，挡在它后面的东西都被盖住（云海不写深度，被盖住的东西深度还在）。
// World 按它把星球视图里沉进云海的邻居藏起来（F2）
export function seaCeiling(params: Pick<AtmosphereParams, 'seaHeight' | 'seaThickness'>, radius: number, drop = 0, calm = 0): number {
  const top = (params.seaHeight - drop) * radius;
  const thick = Math.max(0.02, params.seaThickness) * radius * (1 - CALM.thickness * calm);
  return top - thick * 0.6 + thick + radius * COLLAR * (1 - calm) + 0.5;
}

// 方位角、高度角 → 单位方向（和 scenes/lights.ts 的约定一样：方位角从 +Z 转向 +X）
export function sunDirection(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

// ---------------------------------------------------------------------------------------------
// 「上」方向的标架

const WORLD_UP = new THREE.Vector3(0, 1, 0);
export const FRAME = {
  orbitMinElevation: 20, // 轨道视角：镜头相对「上」的仰角至少这么多度（转到星球下面时「上」跟着倾斜）
  groundNear: 0.15, // 镜头离地面低于 0.15R：完全按镜头所在位置的球面法线当「上」
  groundFar: 0.6, // 高于 0.6R：按轨道视角算
  rate: 3, // 「上」逼近目标的速率（每秒）
  hintRate: 10, // 漫游时跟 camera.up 的速率（camera.up 本身已经是平滑的，这里只做很轻的跟随）
  untwist: 0.8, // 轨道视角下，绕「上」的扭转慢慢回正的速率（每秒）
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _cream = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

// 目标「上」：尽量是世界 +Y，但镜头相对它的仰角不低于 minElevation（镜头贴地时 minElevation = 90°，即镜头所在位置的球面法线）
export function targetUp(out: THREE.Vector3, camPos: THREE.Vector3, center: THREE.Vector3, radius: number, hint: THREE.Vector3): THREE.Vector3 {
  const rel = _a.subVectors(camPos, center);
  const d = rel.length();
  if (d < 1e-6) return out.copy(hint);
  rel.divideScalar(d);
  const alt = d - radius;
  const g = 1 - THREE.MathUtils.smoothstep(alt, FRAME.groundNear * radius, FRAME.groundFar * radius);
  const minEl = THREE.MathUtils.lerp(FRAME.orbitMinElevation, 90, g);
  const beta = THREE.MathUtils.degToRad(90 - minEl); // 「上」和镜头方向的最大夹角
  const alpha = Math.acos(THREE.MathUtils.clamp(rel.dot(WORLD_UP), -1, 1));
  if (alpha <= beta) return out.copy(WORLD_UP);
  // 把镜头方向朝世界 +Y 转 beta；镜头正好在正下方时用上一帧的「上」定转轴
  const axis = _b.crossVectors(rel, WORLD_UP);
  if (axis.lengthSq() < 1e-8) axis.crossVectors(rel, hint);
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).cross(rel);
  axis.normalize();
  return out.copy(rel).applyAxisAngle(axis, beta);
}

// 标架：q 把「世界 +Y 为上」的方向转到当前标架。逐帧按最小旋转转过去（平行移动），翻过两极也连续；
// 轨道视角下再把绕「上」的扭转慢慢回正，太阳方位回到设定值
export class AtmosphereFrame {
  readonly q = new THREE.Quaternion();
  readonly up = new THREE.Vector3(0, 1, 0);
  private started = false;
  private readonly goal = new THREE.Vector3();

  // hint：漫游时外面给的「上」（camera.up）；给了就直接跟着它，不按镜头位置推算
  update(dt: number, camPos: THREE.Vector3, center: THREE.Vector3, radius: number, hint: THREE.Vector3 | null = null): void {
    if (hint && hint.lengthSq() > 1e-8) this.goal.copy(hint).normalize();
    else targetUp(this.goal, camPos, center, radius, this.up);
    if (!this.started) {
      this.started = true;
      this.q.setFromUnitVectors(WORLD_UP, this.goal);
      this.up.copy(WORLD_UP).applyQuaternion(this.q);
      return;
    }
    const k = 1 - Math.exp(-(hint ? FRAME.hintRate : FRAME.rate) * dt);
    _q.setFromUnitVectors(this.up, this.goal);
    _q2.identity().slerp(_q, k);
    this.q.premultiply(_q2).normalize();
    this.up.copy(WORLD_UP).applyQuaternion(this.q);
    // 回正扭转：只在离开地面、「上」不朝下时做（最小旋转在那里有定义且连续）
    const rel = _a.subVectors(camPos, center);
    const ground = hint !== null || rel.length() - radius < FRAME.groundFar * radius;
    if (!ground && this.up.y > 0.2) {
      _q.setFromUnitVectors(WORLD_UP, this.up);
      this.q.slerp(_q, 1 - Math.exp(-FRAME.untwist * dt)).normalize();
      this.up.copy(WORLD_UP).applyQuaternion(this.q);
    }
  }

  reset(): void {
    this.started = false;
  }
}

// ---------------------------------------------------------------------------------------------
// 噪声贴图（CPU 烘焙，可平铺）

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 一层「球冠」：n×n 个格子，每格一个随机位置、随机半径的圆顶，取最大值 —— 一团团圆顶挤在一起，像积云顶
function capsLayer(size: number, n: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = ((x + 0.5) / size) * n;
      const py = ((y + 0.5) / size) * n;
      const cx = Math.floor(px);
      const cy = Math.floor(py);
      let best = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          const wx = ((gx % n) + n) % n;
          const wy = ((gy % n) + n) % n;
          const fx = gx + 0.15 + 0.7 * hash2(wx, wy, seed);
          const fy = gy + 0.15 + 0.7 * hash2(wx, wy, seed + 1);
          const r = 0.75 + 0.75 * hash2(wx, wy, seed + 2);
          const hgt = 0.55 + 0.45 * hash2(wx, wy, seed + 3);
          const ddx = (px - fx) / r;
          const ddy = (py - fy) / r;
          const q = 1 - ddx * ddx - ddy * ddy;
          if (q > 0) {
            const v = Math.sqrt(q) * hgt;
            if (v > best) best = v;
          }
        }
      }
      out[y * size + x] = best;
    }
  }
  return out;
}

// 可平铺的梯度噪声（周期 period 个格子）
function gradNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash2(((ix % period) + period) % period, ((iy % period) + period) % period, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = grad(x0, y0, fx, fy);
  const n10 = grad(x0 + 1, y0, fx - 1, fy);
  const n01 = grad(x0, y0 + 1, fx, fy - 1);
  const n11 = grad(x0 + 1, y0 + 1, fx - 1, fy - 1);
  return (n00 + (n10 - n00) * u + (n01 - n00) * v + (n00 - n10 - n01 + n11) * u * v) * 1.4;
}

function fbmLayer(size: number, base: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let amp = 0.5;
      let f = base;
      for (let o = 0; o < octaves; o++) {
        sum += amp * gradNoise(((x + 0.5) / size) * f, ((y + 0.5) / size) * f, f, seed + o * 17);
        amp *= 0.5;
        f *= 2;
      }
      out[y * size + x] = sum * 0.5 + 0.5;
    }
  }
  return out;
}

function normalize01(a: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const s = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * s;
  return a;
}

// RGBA8：R、G = 两组积云高度场（大团 + 中团 + 小团叠加，0..1），B、A = 两组分形噪声（边缘侵蚀、天上的细云）
export function bakeCloudNoise(size = 256, seed = 7): Uint8Array {
  const layer = (s: number) => {
    const big = capsLayer(size, 5, s);
    const mid = capsLayer(size, 11, s + 11);
    const small = capsLayer(size, 23, s + 23);
    const warp = fbmLayer(size, 4, 3, s + 31);
    // 大尺度起伏：有的地方云堆得高、团大，有的地方低平，露出偏冷的深缝（参考 F4 的大片凹处）
    const macro = normalize01(fbmLayer(size, 2, 2, s + 47));
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) h[i] = (big[i] + 0.42 * mid[i] + 0.16 * small[i] + 0.25 * (warp[i] - 0.5)) * (0.45 + 0.55 * macro[i]);
    return normalize01(h);
  };
  const r = layer(seed);
  const g = layer(seed + 101);
  const b = normalize01(fbmLayer(size, 4, 5, seed + 211));
  const a = normalize01(fbmLayer(size, 8, 4, seed + 307));
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = Math.round(b[i] * 255);
    data[i * 4 + 3] = Math.round(a[i] * 255);
  }
  return data;
}

const NOISE_SIZE = 256;

// ---------------------------------------------------------------------------------------------
// 远处积云的布局（星球本地标架里：y 是「上」，单位是星球半径的倍数，创建时按半径换算）

export interface Puff {
  x: number;
  y: number;
  z: number;
  r: number;
  base: number; // 这一簇的底面高度
  top: number; // 这一簇的大致顶高（打光用）
  seed: number;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 几簇积云围着星球排一圈：每簇底下一排大团、上面几团小的，平底圆顶
export function layoutPuffs(clusters = 9, seed = 5): Puff[] {
  const rng = mulberry32(seed);
  const puffs: Puff[] = [];
  for (let k = 0; k < clusters; k++) {
    const az = ((k + 0.2 + rng() * 0.6) / clusters) * Math.PI * 2;
    const dist = 20 + rng() * 14; // × 半径
    const w = 6 + rng() * 5; // 簇宽
    const hgt = w * (0.4 + rng() * 0.3);
    const base = 0.1 + rng() * 0.6; // 底面在云海顶面上方多少（× 半径）
    const cx = Math.sin(az) * dist;
    const cz = Math.cos(az) * dist;
    const tx = Math.cos(az); // 切向（簇沿着这个方向展开）
    const tz = -Math.sin(az);
    const rows = [
      { n: 4 + Math.floor(rng() * 3), y: 0.22, r: 0.24, spread: 0.5 },
      { n: 2 + Math.floor(rng() * 3), y: 0.5, r: 0.22, spread: 0.32 },
      { n: 1 + Math.floor(rng() * 2), y: 0.78, r: 0.18, spread: 0.18 },
    ];
    for (const row of rows) {
      for (let i = 0; i < row.n; i++) {
        const s = row.n === 1 ? 0 : (i / (row.n - 1)) * 2 - 1;
        const off = (s * row.spread + (rng() - 0.5) * 0.12) * w;
        const depth = (rng() - 0.5) * 0.25 * w;
        const r = (row.r + rng() * 0.08) * w;
        puffs.push({
          x: cx + tx * off + Math.sin(az) * depth,
          y: base + row.y * hgt + (rng() - 0.5) * 0.08 * hgt,
          z: cz + tz * off + Math.cos(az) * depth,
          r,
          base,
          top: base + hgt,
          seed: rng(),
        });
      }
    }
  }
  return puffs;
}

// ---------------------------------------------------------------------------------------------

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;
// 颜色 uniform 用 vec3 存（线性 RGB），和其他向量运算类型一致
// 所有 uniform 都放进 renderGroup（每次 render 更新一次）。雾节点会编进场景里每个开着 fog 的材质，而 three 默认的 objectGroup
// 在「没有节点属性」的材质（比如普通的 MeshStandardNodeMaterial、glTF 作品）上只在物体或材质变了时才刷新——
// 那样切预设时作品上的雾色、标架转动时雾的高度方向都会停在旧值（实测：走到南极时地面被旧的高度雾盖成奶白）
const colorUniform = (c: THREE.Color) => uniform(new THREE.Vector3(c.r, c.g, c.b)).setGroup(renderGroup);

export function createAtmosphere(scene: THREE.Scene, renderer: THREE.WebGPURenderer, opts: AtmosphereOptions): Atmosphere {
  const presetName0: AtmospherePreset = opts.preset ?? 'day';
  let presetName = presetName0;
  const palette = clonePalette(PRESETS[presetName0]);
  const fromPalette = clonePalette(palette);
  let transition = 1; // 0..1，1 表示没有在过渡
  const fromSun = { el: palette.sunElevation, az: palette.sunAzimuth };

  const params: AtmosphereParams = {
    sunElevation: palette.sunElevation,
    sunAzimuth: palette.sunAzimuth,
    seaHeight: -0.18,
    seaThickness: 0.8,
    cloudScale: 1,
    cloudSpeed: 1,
    fog: 1,
    exposure: 1,
    farClouds: true,
    cloudSteps: 24,
    seaAmount: 1,
  };
  const frameShadow = opts.frameShadow !== false;
  // 实际用的配色：预设（含过渡）再按雨量往阴天那一套靠
  const look = clonePalette(palette);
  let rain = 0;
  let lookDirty = true;
  let horizonUp: THREE.Vector3 | null = null;
  let sunTurn = 0; // setSunTurn：方位角再加多少度

  // ---- 状态
  const center = new THREE.Vector3();
  const centerGoal = new THREE.Vector3();
  const centerFrom = new THREE.Vector3();
  let radius = opts.planetRadius;
  let radiusGoal = radius;
  let radiusFrom = radius;
  // setPlanet 的可选项：云海下压（× 半径）、雾的倍数，和中心一起缓动
  const extra = { drop: 0, dropFrom: 0, dropGoal: 0, fog: 1, fogFrom: 1, fogGoal: 1, calm: 0, calmFrom: 0, calmGoal: 0 };
  let planetJump = true; // 第一帧之前设的星球直接到位
  let planetT = 1;
  const frame = new AtmosphereFrame();
  const sunDir = new THREE.Vector3();
  const sunLocal = new THREE.Vector3();
  let time = 0;
  let shown = true;

  // ---- uniform（世界坐标）
  const uUp = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  const uE1 = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  const uE2 = uniform(new THREE.Vector3(0, 0, 1)).setGroup(renderGroup);
  const uSun = uniform(new THREE.Vector3(0, 0.4, 0.9).normalize()).setGroup(renderGroup);
  const uCenter = uniform(new THREE.Vector3()).setGroup(renderGroup);
  const uRadius = uniform(radius).setGroup(renderGroup);
  const uSeaBase = uniform(0).setGroup(renderGroup); // 云底（凹处）相对星球中心的高度
  const uSeaThick = uniform(1).setGroup(renderGroup);
  const uCollar = uniform(0).setGroup(renderGroup); // 星球周围云堆起来的高度
  const uCollarR = uniform(1).setGroup(renderGroup); // 堆云的范围（离星球竖轴的水平距离）
  const uScale1 = uniform(1 / 420).setGroup(renderGroup); // 世界米 → 贴图坐标
  const uScale2 = uniform(1 / 270).setGroup(renderGroup);
  const uFlow1 = uniform(new THREE.Vector2()).setGroup(renderGroup);
  const uFlow2 = uniform(new THREE.Vector2()).setGroup(renderGroup);
  const uLodK = uniform(1).setGroup(renderGroup); // 像素张角 / 贴图单个像素的世界尺寸
  const uSteps = uniform(24, 'int').setGroup(renderGroup);
  const uHaze = uniform(1 / 2600).setGroup(renderGroup); // 云海、远处积云的空气透视（每米）
  const uFogDensity = uniform(palette.fogDensity).setGroup(renderGroup);
  const uCamRight = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup);
  const uCamUp = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
  const uSeaAmount = uniform(1).setGroup(renderGroup); // 云海、远处积云、高度雾的整体浓度（星系视图里淡到 0）
  const uPuffs = uniform(1).setGroup(renderGroup); // 远处积云的浓度（首页放安静时淡一些，CALM.puffs）
  const uGraze = uniform(0.07).setGroup(renderGroup); // 视线贴着云海时融进雾色的范围（掠射角的正弦；首页放安静时更宽，CALM.horizon）

  const uZenith = colorUniform(palette.zenith);
  const uUpper = colorUniform(palette.upper);
  const uHorizon = colorUniform(palette.horizon);
  const uHorizonSun = colorUniform(palette.horizonSun);
  const uGlow = colorUniform(palette.glow);
  const uGlowStrength = uniform(palette.glowStrength).setGroup(renderGroup);
  const uStreaks = uniform(palette.streaks).setGroup(renderGroup);
  const uSunDisc = colorUniform(palette.sunDisc);
  const uCloudLit = colorUniform(palette.cloudLit);
  const uCloudMid = colorUniform(palette.cloudMid);
  const uCloudShade = colorUniform(palette.cloudShade);
  const uCloudDeep = colorUniform(palette.cloudDeep);
  const uGround = colorUniform(palette.ground);
  const uGradUpper = uniform(palette.gradUpper).setGroup(renderGroup);
  const uGradZenith = uniform(palette.gradZenith).setGroup(renderGroup);
  const uBelow = uniform(palette.envBelow).setGroup(renderGroup);
  const uEnvIntensity = uniform(palette.envIntensity).setGroup(renderGroup); // 不用 scene.environmentIntensity：它走 objectGroup，静态物体上不刷新 // 环境贴图里地平线以下（云海）的亮度倍数

  // ---- 噪声贴图
  const noiseTex = new THREE.DataTexture(bakeCloudNoise(NOISE_SIZE), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  noiseTex.wrapS = THREE.RepeatWrapping;
  noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.colorSpace = THREE.NoColorSpace;
  noiseTex.needsUpdate = true;
  const noise = texture(noiseTex);

  // ---- 共用的天空函数（TSL 表达式，内联进各个材质）
  const sunSide = (dir: V3) => {
    // 水平方向上朝太阳的程度 0..1
    const dh = normalize(dir.sub(uUp.mul(dot(dir, uUp))).add(vec3(1e-5, 0, 0)));
    const sh = normalize(uSun.sub(uUp.mul(dot(uSun, uUp))).add(vec3(1e-5, 0, 0)));
    return pow(saturate(dot(dh, sh).mul(0.5).add(0.5)), 2.2);
  };
  // 太阳光晕：大范围的柔光 + 中等的一圈 + 贴着日轮的亮圈（各项都是 cos 的幂，没有贴图采样）
  const glow = (dir: V3) => {
    const cs = saturate(dot(dir, uSun));
    return uGlow.mul(pow(cs, 4).mul(0.14).add(pow(cs, 28).mul(0.32)).add(pow(cs, 400).mul(1.1))).mul(uGlowStrength);
  };
  // 地平线的雾色（不含光晕）：云海远处、距离雾、天空最下沿用同一个颜色，接缝处看不出来
  const hazeColor = (dir: V3) => mix(uHorizon, uHorizonSun, sunSide(dir));
  // env = true：烘环境贴图用的版本，不画日轮（太阳的高光由平行光负责，免得算两遍）；
  // 地平线以下先是压暗的远处云海色，再往下（脚下）渐变成草地反上来的光
  const skyColor = (dir: V3, env: boolean) => {
    const e = dot(dir, uUp);
    const eh = max(e, 0);
    const hz = hazeColor(dir);
    let col = mix(hz, uUpper, smoothstep(0.0, uGradUpper, eh));
    col = mix(col, uZenith, smoothstep(uGradUpper.mul(0.6), uGradZenith, eh));
    // 高空的细云条（绘本感，只画在天空球上；环境光里不要，免得在所有材质的光照代码里多一次贴图采样）：把方向投到一块「天花板」上采样噪声，沿一个方向拉长；只在中低空出现，跟着云海一起慢慢飘
    const flat = dir.sub(uUp.mul(e));
    const suv = vec2(dot(flat, uE1), dot(flat, uE2)).div(eh.add(0.12)).mul(0.3).add(uFlow1.mul(1.5));
    const sn = noise.sample(suv.mul(vec2(0.7, 3.2))).b;
    const streak = smoothstep(0.52, 0.86, sn).mul(smoothstep(0.02, 0.14, eh)).mul(float(1).sub(smoothstep(0.32, 0.75, eh))).mul(uStreaks);
    if (!env) col = mix(col, hz.mul(1.25).add(glow(dir).mul(0.6)), streak);
    const below = smoothstep(0.0, -0.035, e);
    if (env) return mix(col.add(glow(dir)), mix(hz.mul(uBelow), uGround, smoothstep(-0.08, -0.45, e)), below);
    // 日轮：半径约 1.4° 的软边圆盘（HDR，色调映射后是白的）
    const disc = smoothstep(0.9997, 0.99985, dot(dir, uSun));
    // 夜里（v2-sky）：地平线以下是往下变深的夜空（首页的云缝里透出来），再叠上星星、银河、月亮（nightSky.ts）
    const under = mix(hz.add(glow(dir)), underSky(e, hz, uUpper, uZenith).add(glow(dir).mul(0.5)), NIGHT_U.night);
    const base = mix(col.add(glow(dir)).add(uSunDisc.mul(disc)), under, below);
    return base.add(nightLayer(dir, e, skyLuma(base), uCamRight, uCamUp, noise));
  };

  // 云的配色：按受光量 lit（0..1）在「缝隙 → 背光 → 中间调 → 亮面」之间取色；height（0..1）越低越偏缝隙色
  const cloudRamp = (lit: F, height: F) => {
    const base = mix(uCloudDeep, uCloudShade, smoothstep(0.0, 0.55, height));
    const col = mix(base, uCloudMid, smoothstep(0.08, 0.38, lit));
    return mix(col, uCloudLit, smoothstep(0.34, 0.8, lit));
  };

  // ---- 天空球
  const skyGeo = new THREE.SphereGeometry(1, 48, 24);
  const makeSkyMaterial = (env: boolean) => {
    const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false });
    const view = modelViewMatrix.mul(vec4(positionLocal, 0));
    const clip = cameraProjectionMatrix.mul(vec4(view.xyz, 1));
    m.vertexNode = vec4(clip.x, clip.y, clip.w, clip.w); // 推到远裁剪面
    m.colorNode = skyColor(normalize(positionLocal), env);
    return m;
  };
  const skyMat = makeSkyMaterial(false);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'atmosphere-sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // ---- 云海
  // 高度场（相对星球中心，沿「上」）：云底 + 厚度 × H（两层贴图交叉淡化）+ 星球周围堆起来的一圈
  // 星球周围堆云的权重：贴着星球最高，离星球竖轴 uCollarR 以外为 0
  const collarWeight = (rho: F) => float(1).sub(smoothstep(uRadius.mul(0.85), uCollarR, rho));
  const surface = (p: V3, lod: F) => {
    const rel = p.sub(uCenter);
    const xz = vec2(dot(rel, uE1), dot(rel, uE2));
    const a = noise.sample(xz.mul(uScale1).add(uFlow1)).level(lod).r;
    const b = noise.sample(xz.mul(uScale2).add(uFlow2)).level(lod.sub(0.6)).g;
    const h = mix(a, b, 0.38);
    const rho = length(rel.sub(uUp.mul(dot(rel, uUp))));
    const collar = uCollar.mul(collarWeight(rho)).mul(h.mul(0.55).add(0.45));
    return uSeaBase.add(uSeaThick.mul(h)).add(collar);
  };
  const seaNode = Fn(() => {
    const p0 = positionWorld.toVar();
    const dir = normalize(p0.sub(cameraPosition)).toVar();
    const rel0 = p0.sub(uCenter).toVar();
    const dy = min(dot(dir, uUp), -0.0004).toVar();
    const y0 = dot(rel0, uUp).toVar();
    const dist0 = length(p0.sub(cameraPosition)).toVar();
    // 贴图细节等级：像素在云面上的投影随距离变大，掠射时沿视线方向再拉长（取几何平均）
    const lodScale = uLodK.div(sqrt(max(dy.negate(), 0.004))).toVar();
    const lodAt = (dist: F) => min(max(log2(max(dist.mul(lodScale), 1)), 0), 7.5);
    // 远离星球的视线：从普通云顶的高度开始走（堆云只在星球附近）
    const rho0 = length(rel0.sub(uUp.mul(y0)));
    // 起点：视线降到「这一处云顶可能的最高点」时再开始走（远处是普通云顶，星球附近加上堆云）；随入射点连续变化，不会有接缝
    const topHere = uSeaBase.add(uSeaThick).add(uCollar.mul(collarWeight(rho0)));
    const tStart = max(topHere.sub(y0).div(dy), 0).toVar();
    const tBot = uSeaBase.sub(y0).div(dy).toVar();
    // 星球（解析球）：视线先碰到星球就不画云
    const rs = uRadius.mul(0.985);
    const b = dot(rel0, dir);
    const disc = b.mul(b).sub(dot(rel0, rel0).sub(rs.mul(rs)));
    const tS = b.negate().sub(sqrt(max(disc, 0)));
    const tSph = select(disc.greaterThan(0).and(tS.greaterThan(0)), tS, float(1e9)).toVar();
    const tEnd = min(tBot, tSph).toVar();
    const dt = max(tEnd.sub(tStart), 0).div(float(uSteps)).toVar();
    // 起点按像素错开一点（交错梯度噪声）：步长不够时云团轮廓上的台阶变成很细的抖动，DPR 2 下看不出来
    const ign = fract(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189));
    const t = tStart.add(dt.mul(ign).mul(0.5)).sub(dt).toVar();
    const tPrev = tStart.toVar();
    const hit = float(0).toVar();
    Loop({ start: 0, end: uSteps, type: 'int', condition: '<' }, () => {
      t.addAssign(dt);
      const lod = lodAt(dist0.add(t));
      const hRay = y0.add(dy.mul(t));
      If(hRay.lessThan(surface(p0.add(dir.mul(t)), lod)), () => {
        hit.assign(1);
        Break();
      });
      tPrev.assign(t);
    });
    // 二分细化交点
    If(hit.greaterThan(0.5), () => {
      Loop(4, () => {
        const tm = tPrev.add(t).mul(0.5);
        const lod = lodAt(dist0.add(tm));
        If(y0.add(dy.mul(tm)).lessThan(surface(p0.add(dir.mul(tm)), lod)), () => {
          t.assign(tm);
        }).Else(() => {
          tPrev.assign(tm);
        });
      });
    });
    // 没碰到云：要么到了云底（当作碰到最深的缝隙），要么碰到了星球（透明）
    const onPlanet = hit.lessThan(0.5).and(tSph.lessThan(tBot));
    const ph = p0.add(dir.mul(t)).toVar();
    const dist = dist0.add(t);
    const lod = lodAt(dist);
    // 法线：高度场的有限差分，步长随距离变大（远处更平滑）
    const eps = max(dist.mul(0.0025), 0.5);
    const h0 = surface(ph, lod);
    const hx = surface(ph.add(uE1.mul(eps)), lod);
    const hz = surface(ph.add(uE2.mul(eps)), lod);
    const n = normalize(uUp.mul(eps).sub(uE1.mul(hx.sub(h0))).sub(uE2.mul(hz.sub(h0)))).toVar();
    // 打光：包裹漫反射 + 高度遮蔽（凹处偏冷偏暗）+ 天光 + 逆光时的亮边
    const k = saturate(y0.add(dy.mul(t)).sub(uSeaBase).div(uSeaThick.add(uCollar)));
    const wrap = saturate(dot(n, uSun).add(0.22).div(1.22));
    const lit = wrap.mul(mix(float(0.22), float(1), pow(smoothstep(0.0, 0.95, k), 0.7)));
    let col = cloudRamp(lit, k);
    col = col.add(uZenith.mul(0.08).mul(dot(n, uUp).mul(0.5).add(0.5)));
    const towardSun = pow(saturate(dot(dir, uSun)), 6);
    const rim = pow(float(1).sub(saturate(dot(n, dir.negate()))), 3);
    col = col.add(uGlow.mul(towardSun.mul(rim).mul(1.2).mul(uGlowStrength)));
    col = col.add(seaMoonlight(n, dir, k)); // 夜里：上缘的月光银边、月亮附近被照亮的一圈（v2-sky）
    // 空气透视：按距离融进地平线的颜色（加上太阳方向的光晕）
    // 再加一道只看视线掠射角的淡出：越贴近地平线越融进雾色，远处的云海连成一片亮带（参考图的地平线）
    // 首页放安静时这道淡出更宽（uGraze）：远处的云海和地平线的雾连成一片，没有一条硬边
    const fogK = float(1).sub(exp(dist.mul(uHaze).negate()).mul(smoothstep(0.004, uGraze, dy.negate())));
    const far = hazeColor(dir).add(glow(dir));
    col = mix(col, far, fogK);
    // 贴近星球表面时变透明（软过渡）；视线先碰到星球的像素完全透明
    const gap = length(ph.sub(uCenter)).sub(uRadius);
    // 夜里云缝透出下面的星空、月亮那一块变薄（v2-sky）
    const alpha = select(onPlanet, float(0), smoothstep(0.0, uRadius.mul(0.05), gap)).mul(uSeaAmount).mul(seaNightAlpha(k, dir));
    return vec4(col, alpha);
  });

  const seaMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  seaMat.colorNode = seaNode();
  const seaGeo = new THREE.CircleGeometry(1, 96);
  seaGeo.rotateX(-Math.PI / 2); // 法线朝 +Y
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.name = 'atmosphere-sea';
  sea.frustumCulled = false;
  sea.renderOrder = -10; // 透明物体里最先画：星球上的透明物件（水面等）叠在云上面
  scene.add(sea);

  // ---- 远处积云：每团一个朝向镜头的面片
  const puffs = layoutPuffs();
  const nP = puffs.length;
  const aCenter = new Float32Array(nP * 4 * 3);
  const aCorner = new Float32Array(nP * 4 * 2);
  const aInfo = new Float32Array(nP * 4 * 4); // 半径、底面、顶高、随机数（都是 × 半径，种子除外）
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  puffs.forEach((p, i) => {
    for (let v = 0; v < 4; v++) {
      const j = i * 4 + v;
      aCenter.set([p.x, p.y, p.z], j * 3);
      aCorner.set([corners[v * 2], corners[v * 2 + 1]], j * 2);
      aInfo.set([p.r, p.base, p.top, p.seed], j * 4);
    }
  });
  const puffIndex = new Uint16Array(nP * 6);
  const writeOrder = (order: number[]) => {
    order.forEach((pi, k) => puffIndex.set([pi * 4, pi * 4 + 1, pi * 4 + 2, pi * 4, pi * 4 + 2, pi * 4 + 3], k * 6));
  };
  writeOrder(puffs.map((_, i) => i));
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nP * 4 * 3), 3)); // 占位：真正的位置在 positionNode 里算
  cloudGeo.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
  cloudGeo.setAttribute('aCorner', new THREE.BufferAttribute(aCorner, 2));
  cloudGeo.setAttribute('aInfo', new THREE.BufferAttribute(aInfo, 4));
  const indexAttr = new THREE.BufferAttribute(puffIndex, 1);
  cloudGeo.setIndex(indexAttr);

  const uSeaTopNow = uniform(0).setGroup(renderGroup); // 云海平均顶面（远处积云的底面从这里量）
  const cloudMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  {
    const cLocal = attribute('aCenter', 'vec3');
    const corner = attribute('aCorner', 'vec2');
    const info = attribute('aInfo', 'vec4');
    const R = uRadius;
    const worldCenter = uCenter.add(uE1.mul(cLocal.x.mul(R))).add(uUp.mul(cLocal.y.mul(R).add(uSeaTopNow))).add(uE2.mul(cLocal.z.mul(R)));
    const rad = info.x.mul(R);
    cloudMat.positionNode = worldCenter.add(uCamRight.mul(corner.x.mul(rad))).add(uCamUp.mul(corner.y.mul(rad)));
    const vUv = varying(corner);
    const vCenter = varying(worldCenter);
    const vInfo = varying(info);
    cloudMat.colorNode = Fn(() => {
      const uv = vUv;
      const r2 = dot(uv, uv);
      const seed = vInfo.w;
      const n1 = noise.sample(uv.mul(0.32).add(vec2(seed.mul(7.3), seed.mul(3.1)))).level(float(0)).b;
      const n2 = noise.sample(uv.mul(0.7).add(vec2(seed.mul(1.7), seed.mul(5.9)))).level(float(0)).a;
      const edge = sqrt(r2).add(n1.sub(0.5).mul(0.5)).add(n2.sub(0.5).mul(0.12));
      let alpha = float(1).sub(smoothstep(0.55, 1.0, edge)).mul(float(1).sub(smoothstep(0.82, 1.0, sqrt(r2))));
      // 平底：簇的底面以下淡出
      const toCam = normalize(cameraPosition.sub(vCenter));
      const nz = sqrt(saturate(float(1).sub(r2)));
      const nrm = normalize(uCamRight.mul(uv.x).add(uCamUp.mul(uv.y)).add(toCam.mul(nz)));
      const hFrag = dot(positionWorld.sub(uCenter), uUp).sub(uSeaTopNow).div(R);
      const base = vInfo.y;
      const top = vInfo.z;
      alpha = alpha.mul(smoothstep(base.sub(0.05), base.add(0.22), hFrag));
      const kH = saturate(hFrag.sub(base).div(top.sub(base)));
      const wrap = saturate(dot(nrm, uSun).add(0.6).div(1.6));
      let col = cloudRamp(wrap.mul(mix(float(0.5), float(1), kH)), kH.mul(0.6).add(0.4));
      col = col.add(uZenith.mul(0.08).mul(dot(nrm, uUp).mul(0.5).add(0.5)));
      const back = pow(saturate(dot(toCam.negate(), uSun)), 5);
      const rim = pow(float(1).sub(nz), 2);
      col = col.add(uGlow.mul(back.mul(rim).mul(1.6).mul(uGlowStrength)));
      const d = length(cameraPosition.sub(vCenter));
      const dirToC = normalize(vCenter.sub(cameraPosition));
      col = mix(col, hazeColor(dirToC).add(glow(dirToC)), float(1).sub(exp(d.mul(uHaze).mul(1.6).negate())));
      return vec4(col, saturate(alpha).mul(uSeaAmount).mul(uPuffs));
    })();
  }
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.name = 'atmosphere-clouds';
  clouds.frustumCulled = false;
  clouds.renderOrder = -9;
  scene.add(clouds);
  // 不参与拾取：云海圆盘铺到远平面，天空球包住一切，游戏里对整个场景做射线检测时不能被它们挡住
  for (const o of [sky, sea, clouds]) o.raycast = () => {};
  // 首页空气里的星屑（v2-sky，skyDust.ts）：一次绘制，开场预热时和天空一起编译
  const dust = createSkyDust();
  scene.add(dust.sprite);

  // ---- 距离雾 + 云海附近的高度雾（对场景里所有开着 fog 的材质生效）
  const fogNode = Fn(() => {
    const rel = positionWorld.sub(cameraPosition);
    const d = length(rel);
    const dir = rel.div(max(d, 1e-4));
    const distK = float(1).sub(exp(d.mul(uFogDensity).negate()));
    const above = dot(positionWorld.sub(uCenter), uUp).sub(uSeaTopNow);
    const heightK = smoothstep(uRadius.mul(0.35), uRadius.mul(-0.05), above).mul(0.7).mul(uSeaAmount);
    // 高度雾的颜色按云的配色走：用星球表面的球面法线和太阳算受光量，雾里的星球底部和旁边的云一样有亮面和背光面。
    // 受光量的下限抬高（集成时调的）：原来背光那一侧是偏灰的阴影色，星球底部像罩了一层灰玻璃，和旁边亮白的云海接不上
    const nrm = normalize(positionWorld.sub(uCenter));
    const cloudish = cloudRamp(saturate(dot(nrm, uSun).mul(0.45).add(0.55)), float(0.8));
    const col = mix(hazeColor(dir).add(glow(dir).mul(0.5)), cloudish, heightK);
    return fog(col, saturate(distK.add(heightK.mul(float(1).sub(distK)))));
  })();
  const sceneWithFog = scene as THREE.Scene & { fogNode?: unknown }; // three 支持 scene.fogNode，类型声明里没有
  const prevFogNode = sceneWithFog.fogNode ?? null;
  sceneWithFog.fogNode = fogNode;

  // ---- 主光
  const sun = new THREE.DirectionalLight(palette.sunLight.clone(), palette.sunIntensity);
  sun.name = 'atmosphere-sun';
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun, sun.target);

  // ---- 环境光：解析的天空环境（scene.environmentNode），不烘贴图
  // PBR 材质（MeshStandard / Physical，社区作品都是）的环境反射和环境漫反射都从这里取。three 的 EnvironmentNode 在「镜面」上下文里
  // 给出世界空间的反射方向和粗糙度，在「漫反射」上下文里给出法线、粗糙度 1（结果再乘 π）。光滑的金属看到清楚的天空（地平线以下是
  // 远处云海，正下方是草地反上来的光），粗糙的表面拿到半球平均的天光：所以金属不会发黑，阴影偏天空的蓝紫，朝下的面泛一点草绿。
  // 和天空共用 uniform：切预设、「上」方向转动都实时跟着变。原先用的 PMREM 每烘一次约 0.8–0.9 ms（二十来个小渲染通道），
  // 漫游时「上」一直在转就得一直烘，换成解析的以后没有这笔开销
  const envSoft = (n: V3) => {
    const skyMean = uHorizon.mul(0.25).add(uHorizonSun.mul(0.1)).add(uUpper.mul(0.35)).add(uZenith.mul(0.3));
    const below = mix(uGround, mix(uHorizon, uHorizonSun, 0.3).mul(uBelow), 0.3);
    const hemi = mix(below, skyMean, smoothstep(-0.8, 0.5, dot(n, uUp))); // 侧面朝向的表面也主要拿天光：阴影偏天空的蓝紫
    return hemi.add(uGlow.mul(uGlowStrength).mul(saturate(dot(n, uSun)).mul(0.12))); // 朝太阳一侧多一点光晕的暖光
  };
  const envNode = Fn((builder: THREE.NodeBuilder) => {
    const ctx = builder.context as unknown as { getUV?: () => V3; getTextureLevel?: () => F };
    const dir = ctx.getUV ? normalize(ctx.getUV()) : vec3(0, 1, 0);
    const rough = ctx.getTextureLevel ? ctx.getTextureLevel() : float(1);
    // 夜里加一层冷色补光（v2-sky）：天色很暗时作品的暗面也看得清
    return mix(skyColor(dir, true), envSoft(dir), smoothstep(0.08, 0.7, rough)).add(NIGHT_U.ambient).mul(uEnvIntensity);
  })();
  const sceneWithEnv = scene as THREE.Scene & { environmentNode?: unknown };
  const prevEnvNode = sceneWithEnv.environmentNode ?? null;
  sceneWithEnv.environmentNode = envNode;

  renderer.toneMapping = THREE.AgXToneMapping;

  // ---- 每帧
  const camPos = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const size = new THREE.Vector2();
  const camQ = new THREE.Quaternion();
  const sortPos = new THREE.Vector3(Infinity, 0, 0);
  const sortUp = new THREE.Vector3();
  const order = puffs.map((_, i) => i);
  const depth = new Float32Array(nP);

  const sortPuffs = () => {
    // 远的先画：按到镜头的距离排（只在镜头挪动较多、标架转动时重排）
    for (let i = 0; i < nP; i++) {
      const p = puffs[i];
      tmp.set(p.x * radius, p.y * radius + uSeaTopNow.value, p.z * radius).applyQuaternion(frame.q).add(center);
      depth[i] = tmp.distanceToSquared(camPos);
    }
    order.sort((a, b) => depth[b] - depth[a]);
    writeOrder(order);
    indexAttr.needsUpdate = true;
    sortPos.copy(camPos);
    sortUp.copy(frame.up);
  };

  const applyPalette = () => {
    // 预设（含过渡）→ 按雨量往阴天那一套靠，写进 look；下面全用 look
    blendPalette(look, palette, RAIN_PALETTE, rain * RAIN_MIX);
    lookDirty = false;
    uZenith.value.set(look.zenith.r, look.zenith.g, look.zenith.b);
    uUpper.value.set(look.upper.r, look.upper.g, look.upper.b);
    uHorizon.value.set(look.horizon.r, look.horizon.g, look.horizon.b);
    uHorizonSun.value.set(look.horizonSun.r, look.horizonSun.g, look.horizonSun.b);
    uGlow.value.set(look.glow.r, look.glow.g, look.glow.b);
    uGlowStrength.value = look.glowStrength;
    uStreaks.value = look.streaks;
    uSunDisc.value.set(look.sunDisc.r, look.sunDisc.g, look.sunDisc.b);
    uCloudLit.value.set(look.cloudLit.r, look.cloudLit.g, look.cloudLit.b);
    uCloudMid.value.set(look.cloudMid.r, look.cloudMid.g, look.cloudMid.b);
    uGround.value.set(look.ground.r, look.ground.g, look.ground.b);
    uGradUpper.value = look.gradUpper;
    uGradZenith.value = look.gradZenith;
    uBelow.value = look.envBelow;
    uCloudShade.value.set(look.cloudShade.r, look.cloudShade.g, look.cloudShade.b);
    uCloudDeep.value.set(look.cloudDeep.r, look.cloudDeep.g, look.cloudDeep.b);
    sun.color.copy(look.sunLight);
    sun.intensity = look.sunIntensity;
    uEnvIntensity.value = look.envIntensity;
  };
  applyPalette();

  const update = (dtSec: number, camera: THREE.Camera) => {
    const dt = Math.min(Math.max(dtSec, 0), 0.1);
    time += dt;
    camera.getWorldPosition(camPos);

    // 星球（setPlanet 之后 PLANET_SECONDS 秒缓动过去）
    if (planetJump) {
      center.copy(centerGoal);
      radius = radiusGoal;
      extra.drop = extra.dropGoal;
      extra.fog = extra.fogGoal;
      extra.calm = extra.calmGoal;
      planetJump = false;
      planetT = 1;
    } else if (planetT < 1) {
      planetT = Math.min(1, planetT + dt / PLANET_SECONDS);
      const k = ease(planetT);
      center.lerpVectors(centerFrom, centerGoal, k);
      radius = radiusFrom + (radiusGoal - radiusFrom) * k;
      extra.drop = extra.dropFrom + (extra.dropGoal - extra.dropFrom) * k;
      extra.fog = extra.fogFrom + (extra.fogGoal - extra.fogFrom) * k;
      extra.calm = extra.calmFrom + (extra.calmGoal - extra.calmFrom) * k;
    }

    // 预设过渡
    if (transition < 1) {
      transition = Math.min(1, transition + dt / TRANSITION_SECONDS);
      const k = ease(transition);
      const target = PRESETS[presetName];
      blendPalette(palette, fromPalette, target, k);
      params.sunElevation = fromSun.el + (target.sunElevation - fromSun.el) * k;
      params.sunAzimuth = fromSun.az + (target.sunAzimuth - fromSun.az) * k;
      applyPalette();
    } else if (lookDirty) applyPalette();

    // 标架和太阳（漫游时「上」跟着 camera.up）
    frame.update(dt, camPos, center, radius, horizonUp);
    sunDirection(sunLocal, params.sunAzimuth + sunTurn, params.sunElevation);
    sunDir.copy(sunLocal).applyQuaternion(frame.q).normalize();
    uUp.value.copy(frame.up);
    uE1.value.set(1, 0, 0).applyQuaternion(frame.q);
    uE2.value.set(0, 0, 1).applyQuaternion(frame.q);
    uSun.value.copy(sunDir);
    sun.position.copy(center).addScaledVector(sunDir, radius * 4);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    // 阴影相机（默认不开阴影；集成时打开 castShadow 就能用）：正交框住整颗星球。游戏里由 World 摆（frameShadow = false）
    const sc = sun.shadow.camera;
    if (frameShadow && Math.abs(sc.right - radius * 1.25) > 1e-3) {
      sc.left = sc.bottom = -radius * 1.25;
      sc.right = sc.top = radius * 1.25;
      sc.near = radius * 0.5;
      sc.far = radius * 8;
      sc.updateProjectionMatrix();
    }

    // 云海（calm：首页放安静，见 CALM；星球视图里是 0）
    const R = radius;
    const calm = extra.calm;
    uCenter.value.copy(center);
    uRadius.value = R;
    const top = (params.seaHeight - extra.drop) * R;
    const thick = Math.max(0.02, params.seaThickness) * R * (1 - CALM.thickness * calm);
    uSeaBase.value = top - thick * 0.6; // 平均顶面以下 0.6 个厚度是缝隙最深处
    uSeaThick.value = thick;
    uSeaTopNow.value = top;
    uCollar.value = R * COLLAR * (1 - calm); // 星系视图里没有聚焦的星球：中间不堆云
    uCollarR.value = R * 1.75;
    const scale = Math.max(0.1, params.cloudScale) * (1 + CALM.scale * calm);
    uScale1.value = 1 / (7 * R * scale);
    uScale2.value = 1 / (4.4 * R * scale);
    const speed = params.cloudSpeed * dt;
    uFlow1.value.x += speed * 0.0042;
    uFlow1.value.y += speed * 0.0017;
    uFlow2.value.x -= speed * 0.0021;
    uFlow2.value.y += speed * 0.0036;
    uFogDensity.value = look.fogDensity * params.fog * extra.fog;
    const seaAmount = THREE.MathUtils.clamp(params.seaAmount, 0, 1);
    uSeaAmount.value = seaAmount;
    uSteps.value = Math.round(THREE.MathUtils.clamp(params.cloudSteps * (1 - CALM.steps * calm), 4, 64));
    uHaze.value = (1 / (260 * R)) * Math.max(0.25, params.fog) * (1 + CALM.haze * calm);
    // 放安静：明暗对比收一些（背光、缝隙往中间调靠），天上的细云条、远处积云淡掉
    const soft = CALM.soft * calm;
    // 夜里（v2-sky）首页的云不往暖奶油靠，往一套月光下的冷灰紫靠（nightSky.ts 的 NIGHT_SKY.home*）
    const night = THREE.MathUtils.clamp(look.night, 0, 1);
    const cream = (CALM.cream + (NIGHT_SKY.homeMix - CALM.cream) * night) * calm;
    const dim = 1 - CALM.dim * calm;
    const toCream = (u: { value: THREE.Vector3 }, c: THREE.Color, which: keyof typeof CALM_CREAM) =>
      u.value.set(c.r, c.g, c.b).lerp(_cream.copy(CALM_CREAM[which]).lerp(homeNightCloud(which), night), cream).multiplyScalar(dim);
    toCream(uCloudLit, look.cloudLit, 'lit');
    toCream(uCloudMid, look.cloudMid, 'mid');
    toCream(uCloudShade, look.cloudShade, 'shade').lerp(uCloudMid.value, soft);
    toCream(uCloudDeep, look.cloudDeep, 'deep').lerp(uCloudMid.value, soft);
    const haze = 1 - CALM.dim * calm * 0.6; // 地平线的雾色也暗一点：远处的云海和雾接得上
    uHorizon.value.set(look.horizon.r, look.horizon.g, look.horizon.b).multiplyScalar(haze);
    uHorizonSun.value.set(look.horizonSun.r, look.horizonSun.g, look.horizonSun.b).multiplyScalar(haze);
    uStreaks.value = look.streaks * (1 - CALM.streaks * calm);
    uPuffs.value = 1 - CALM.puffs * calm;
    uGraze.value = 0.07 * (1 + CALM.horizon * calm);

    // 圆盘：放在云层最高处（含堆云），中心在镜头正下方，半径铺到远平面以内
    const discTop = seaCeiling(params, R, extra.drop, calm);
    const camH = tmp.subVectors(camPos, center).dot(frame.up);
    sea.position.copy(camPos).addScaledVector(frame.up, discTop - camH);
    sea.quaternion.copy(frame.q);
    const far = (camera as THREE.PerspectiveCamera).far ?? 6000;
    const discR = Math.max(R * 4, far * 0.92);
    sea.scale.set(discR, 1, discR);
    sky.visible = shown;
    sea.visible = shown && camH > discTop + 0.01 && seaAmount > 0.001;

    // 贴图细节等级：像素张角 × 距离 / 贴图像素的世界尺寸
    renderer.getDrawingBufferSize(size);
    const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 45;
    const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(1, size.y);
    uLodK.value = pixelAngle / (1 / uScale1.value / NOISE_SIZE) * 1.6 * (1 + CALM.blur * calm);
    // 夜空（v2-sky）：月亮、银河的方向，星星的大小按像素张角
    updateNightSky({ camera, frameQ: frame.q, up: frame.up, look, calm, pixelAngle });
    dust.update({ dt, center, radius: R, seaTop: top, e1: uE1.value, up: frame.up, e2: uE2.value, home: calm, pixelAngle, shown });

    // 远处积云
    camera.getWorldQuaternion(camQ);
    uCamRight.value.set(1, 0, 0).applyQuaternion(camQ);
    uCamUp.value.set(0, 1, 0).applyQuaternion(camQ);
    clouds.visible = shown && params.farClouds && seaAmount > 0.001;
    if (sortPos.distanceToSquared(camPos) > (R * 0.5) ** 2 || sortUp.dot(frame.up) < 0.9995) sortPuffs();

    // 曝光（色调映射在创建时设成 AgX；曝光随预设过渡，下雨时低一点）
    renderer.toneMappingExposure = look.exposure * params.exposure;
  };

  const api: Atmosphere = {
    update,
    setPreset(p: AtmospherePreset) {
      if (p === presetName && transition >= 1) return;
      presetName = p;
      Object.assign(fromPalette, clonePalette(palette));
      fromSun.el = params.sunElevation;
      fromSun.az = params.sunAzimuth;
      transition = 0;
    },
    setPlanet(c: THREE.Vector3, r: number, o: AtmospherePlanetOptions = {}) {
      const drop = o.seaDrop ?? 0;
      const fogK = o.fog ?? 1;
      const calmK = THREE.MathUtils.clamp(o.calm ?? 0, 0, 1);
      // 每帧用同样的参数调也没关系：目标没变就不重新开始
      if (c.distanceToSquared(centerGoal) < 1e-8 && Math.abs(r - radiusGoal) < 1e-6 && drop === extra.dropGoal && fogK === extra.fogGoal && calmK === extra.calmGoal) return;
      centerFrom.copy(center);
      radiusFrom = radius;
      extra.dropFrom = extra.drop;
      extra.fogFrom = extra.fog;
      extra.calmFrom = extra.calm;
      centerGoal.copy(c);
      radiusGoal = r;
      extra.dropGoal = drop;
      extra.fogGoal = fogK;
      extra.calmGoal = calmK;
      planetT = 0;
    },
    sun,
    sunDir,
    dispose() {
      scene.remove(sky, sea, clouds, sun, sun.target);
      dust.dispose();
      skyGeo.dispose();
      skyMat.dispose();
      seaGeo.dispose();
      seaMat.dispose();
      cloudGeo.dispose();
      cloudMat.dispose();
      noiseTex.dispose();
      if (sceneWithEnv.environmentNode === envNode) sceneWithEnv.environmentNode = prevEnvNode;
      if (sceneWithFog.fogNode === fogNode) sceneWithFog.fogNode = prevFogNode;
      sun.dispose();
    },
    params,
    get up() {
      return frame.up;
    },
    get preset() {
      return presetName;
    },
    objects: { sky, sea, clouds },
    get visible() {
      return shown;
    },
    set visible(v: boolean) {
      shown = v;
      sky.visible = v;
      sea.visible = v;
      clouds.visible = v && params.farClouds;
      sceneWithFog.fogNode = v ? fogNode : prevFogNode;
    },
    setRain(amount: number) {
      const r = THREE.MathUtils.clamp(amount, 0, 1);
      if (Math.abs(r - rain) < 1e-4) return;
      rain = r;
      lookDirty = true;
    },
    get rain() {
      return rain;
    },
    get seaTop() {
      return center.y + uSeaTopNow.value * frame.up.y;
    },
    get horizon() {
      return look.horizon;
    },
    get night() {
      return THREE.MathUtils.clamp(look.night, 0, 1);
    },
    setSunTurn(deg: number) {
      sunTurn = deg;
    },
    setHorizonUp(up: THREE.Vector3 | null) {
      horizonUp = up;
    },
  };
  centerGoal.set(0, 0, 0);
  return api;
}

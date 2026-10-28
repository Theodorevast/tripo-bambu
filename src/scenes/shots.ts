import * as THREE from 'three/webgpu';
import { SHOWCASE_POLE } from '../planet/placement';
import { PLANET_RADIUS } from '../planet/presets';
import type { Framing } from './camera';
import type { Bezier } from './ease';
import { galaxyScale } from './layout';

// 镜头表：星系全景和星球近景的取景参数。?tune 面板直接改这张表，World.applyShots() 让当前视图立刻按新参数取景；
// 调好后用面板的「Copy parameters」把 JSON 发回来，写回这里的默认值。
// 距离都按星球半径换算（星系的按星系放大倍数 radius / 10，星球的按半径的倍数），拖半径滑块时取景跟着变

export interface GalaxyShot {
  distance: number; // 镜头离星系中心（星球半径 10 时的值，按 galaxyScale 放大）
  elevation: number; // 仰角（度）
  lift: number; // 画面中心比星系中心高多少（同上，按 galaxyScale 放大；负数是往下压）
  fov: number; // 竖直视角（度）
  minDistance: number; // 滚轮拉近、推远的限制（按到星系中心的距离，同上）
  maxDistance: number;
}

export interface PlanetShot {
  distance: number; // 镜头离星球中心：星球半径的几倍
  elevation: number; // 从斜上方看：镜头在水平面以上多少度（星球视图：大半颗星球的弧度，草地像一块圆台，四周是云海）
  lift: number; // 画面中心比星球中心高多少：星球半径的几倍
  fov: number;
  minDistance: number; // 远近限制：星球半径的几倍
  maxDistance: number;
  minElevation: number; // 拖动时镜头最低压到水平面以上多少度（再低就钻到云海里了）
  maxElevation: number; // 最高（度）
}

export const SHOTS: { galaxy: GalaxyShot; planet: PlanetShot } = {
  // 星系全景：离中心 270、仰角 30°，画面中心压到星系中心下方 25（lift 为负）——
  // 离镜头近的星球在画面里偏低，整片星系往上提一点，上下才匀称。都是星球半径 10 时的数，按 galaxyScale 放大
  galaxy: { distance: 270, elevation: 30, lift: -25, fov: 45, minDistance: 140, maxDistance: 500 },
  // 星球视图：沿展示方向的方位角、从斜上方 26° 看，离星球中心 2.6 个半径；画面中心比星球中心高 0.3 个半径（镜头往上抬约 6.6°），
  // 星球露在云海上面的那半个（草地圆台和作品）占画面宽的六成多，上面还露出一条地平线和天空
  planet: { distance: 2.6, elevation: 26, lift: 0.3, fov: 45, minDistance: 1.35, maxDistance: 4, minElevation: 8, maxElevation: 80 },
};

// —— 分镜表：各个转场的镜头参数（转场的编排在 transition.ts / director.ts）——
// 时间点（cloudIn、popAt……）都按「占这个转场总时长的比例」写（0..1），改 seconds 时整段按比例伸缩。
// 缓动曲线是 CSS 的 cubic-bezier 四个数（ease.ts）：y1 < 0 是起步前先往回收（预备动作），y2 > 1 是落地时冲过头再回来。
// ?tune 面板的「Transitions」直接改这张表，下一次转场就用新值
export interface TransitionShot {
  seconds: number; // 总时长
  ease: Bezier; // 镜头位置（连同视角的过渡）的缓动
  look: Bezier; // 视线（看向哪里）的缓动
  lookSpan: number; // 视线在前多少比例的时间里转完：< 1 是先把镜头对准、再推进；甩镜靠它
  fovPunch: number; // FOV 冲击：中途额外拉宽多少度，然后收回（0 = 不冲）
  fovPeak: number; // 冲到最宽的时刻
  arc: number; // 抬升量：路径中点往上拱多高（按起点到终点距离的比例）
  bank: number; // 甩镜时绕视线侧倾多少度（0 = 不倾）
  cloudIn: number; // 云从画面边缘涌进来
  cloudFull: number; // 云把画面全遮住：这一刻换场景（离开旧星球、摆上新星球的作品、换地表细分、草和石头）
  cloudOut: number; // 云开始散开
  cloudGone: number; // 云散完
  cloudSize: number; // 云团大小（1 = 默认）
  flashAt: number; // 翠宝黄的光扫过云层的时刻（< 0：不闪）
  flashMs: number; // 光停留多久（毫秒）。品牌露出要克制：不超过约 150
  popAt: number; // 作品开始依次弹出来的时刻（进星球的转场）
  stagger: number; // 作品之间间隔多少秒
}

export interface IntroShot {
  seconds: number; // 开场从远处推进到星系全景
  distance: number; // 从全景距离的几倍远处开始
}

// 开场：翠宝从一颗星球后面探出头、挥手、再缩回去
export interface PeekShot {
  delay: number; // 开场飞行结束后等多久（秒）
  rise: number; // 探出头
  wave: number; // 挥手
  waves: number; // 挥几下
  duck: number; // 缩回去
  size: number; // 翠宝在画面里多高（占画面高度的比例）
  lean: number; // 探头时往旁边歪多少度
  swing: number; // 挥手的幅度（度）
}

export const TRANSITIONS: { enter: TransitionShot; hop: TransitionShot; leave: TransitionShot; fade: TransitionShot } = {
  // 星系 → 星球：「穿云」。镜头先微微后收（预备），再加速推近，FOV 先拉宽再收回；推到最快的那一段藏在云里，
  // 云层散开时镜头已经在减速落地，作品在云散开后依次弹出来
  enter: {
    seconds: 1.55,
    ease: { x1: 0.45, y1: -0.05, x2: 0.22, y2: 1 },
    look: { x1: 0.35, y1: 0, x2: 0.25, y2: 1 },
    lookSpan: 0.55,
    fovPunch: 7,
    fovPeak: 0.5,
    arc: 0.06,
    bank: 0,
    cloudIn: 0.3,
    cloudFull: 0.52,
    cloudOut: 0.6,
    cloudGone: 0.88,
    cloudSize: 1,
    flashAt: 0.53,
    flashMs: 130,
    popAt: 0.78,
    stagger: 0.06,
  },
  // 星球 → 另一颗星球：先把视线甩向新星球（甩镜，带一点侧倾），云带从甩过去的那一侧横扫过来盖住画面，
  // 镜头在云里沿弧线跳过去，云从另一侧扫走时已经在新星球前面减速
  hop: {
    seconds: 1.4,
    ease: { x1: 0.7, y1: 0, x2: 0.25, y2: 1 },
    look: { x1: 0.45, y1: 0, x2: 0.2, y2: 1 },
    lookSpan: 0.36,
    fovPunch: 12,
    fovPeak: 0.3,
    arc: 0.3,
    bank: 7,
    cloudIn: 0.14,
    cloudFull: 0.36,
    cloudOut: 0.48,
    cloudGone: 0.8,
    cloudSize: 1,
    flashAt: 0.4,
    flashMs: 120,
    popAt: 0.8,
    stagger: 0.06,
  },
  // 星球 → 星系：反向，更短、更轻快。云「噗」地一下从四边合拢（这时撤下作品），镜头在全遮住时才起飞
  // （ease、look、fovPunch、arc 都按起飞后的那一段算），一边往后拉一边让云散开
  leave: {
    seconds: 0.95,
    ease: { x1: 0.25, y1: 0.55, x2: 0.3, y2: 1 },
    look: { x1: 0.25, y1: 0.55, x2: 0.3, y2: 1 },
    lookSpan: 1,
    fovPunch: 5,
    fovPeak: 0.35,
    arc: 0,
    bank: 0,
    cloudIn: 0,
    cloudFull: 0.18,
    cloudOut: 0.2,
    cloudGone: 0.62,
    cloudSize: 0.8,
    flashAt: -1,
    flashMs: 0,
    popAt: 0,
    stagger: 0,
  },
  // 系统设置了「减少动态效果」（prefers-reduced-motion）时，三种转场都退化成这个：淡到云的颜色、换场景、再淡回来。
  // 镜头不飞（直接跳到终点），不闪光，作品不依次弹（同时出现）
  fade: {
    seconds: 0.6,
    ease: { x1: 0, y1: 0, x2: 1, y2: 1 },
    look: { x1: 0, y1: 0, x2: 1, y2: 1 },
    lookSpan: 1,
    fovPunch: 0,
    fovPeak: 0.5,
    arc: 0,
    bank: 0,
    cloudIn: 0,
    cloudFull: 0.4,
    cloudOut: 0.45,
    cloudGone: 1,
    cloudSize: 1,
    flashAt: -1,
    flashMs: 0,
    popAt: 0.45,
    stagger: 0,
  },
};

export const INTRO: IntroShot = { seconds: 2.4, distance: 2.6 };

export const PEEK: PeekShot = { delay: 0.2, rise: 0.55, wave: 1.2, waves: 3, duck: 0.42, size: 0.15, lean: 12, swing: 34 };

const GALAXY_ASPECT = 1.6; // 星系全景是按这个宽高比调的；更窄的窗口把镜头按比例拉远，左右两边的星球才不出画
const POLE = new THREE.Vector3(...SHOWCASE_POLE);
const AZIMUTH = Math.atan2(POLE.x, POLE.z); // 展示方向的方位角（从 +Z 转向 +X）

export function galaxyFraming(aspect: number, shot: GalaxyShot = SHOTS.galaxy, radius = PLANET_RADIUS): Framing {
  const k = Math.max(1, GALAXY_ASPECT / aspect) * galaxyScale(radius);
  const el = THREE.MathUtils.degToRad(shot.elevation);
  return {
    target: new THREE.Vector3(0, 0, 0),
    position: new THREE.Vector3(0, Math.sin(el), Math.cos(el)).multiplyScalar(shot.distance * k),
    lift: shot.lift * galaxyScale(radius),
    fov: shot.fov,
    minDistance: shot.minDistance * k,
    maxDistance: shot.maxDistance * k,
    autoRotate: true,
  };
}

// 星球视图的镜头方向（单位向量，星球本地坐标）：展示方向的方位角、仰角 elevation
export function planetViewDir(shot: PlanetShot = SHOTS.planet): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(shot.elevation);
  return new THREE.Vector3(Math.sin(AZIMUTH) * Math.cos(el), Math.sin(el), Math.cos(AZIMUTH) * Math.cos(el));
}

export function planetFraming(home: THREE.Vector3, shot: PlanetShot = SHOTS.planet, radius = PLANET_RADIUS): Framing {
  return {
    target: home.clone(),
    position: home.clone().addScaledVector(planetViewDir(shot), shot.distance * radius),
    lift: shot.lift * radius,
    fov: shot.fov,
    minDistance: shot.minDistance * radius,
    maxDistance: shot.maxDistance * radius,
    minPolar: THREE.MathUtils.degToRad(90 - shot.maxElevation),
    maxPolar: THREE.MathUtils.degToRad(90 - shot.minElevation),
    autoRotate: false,
  };
}

// 编辑器在作品栏里点了已经摆上的作品：镜头飞到它正上方、离地面约 0.6 个半径（不抬头），远近限制同星球视图
export function workFraming(home: THREE.Vector3, dir: THREE.Vector3, shot: PlanetShot = SHOTS.planet, radius = PLANET_RADIUS): Framing {
  return {
    target: home.clone(),
    position: home.clone().addScaledVector(dir.clone().normalize(), radius * 1.6),
    minDistance: shot.minDistance * radius,
    maxDistance: shot.maxDistance * radius,
    autoRotate: false,
  };
}

import * as THREE from 'three/webgpu';
import { SHOWCASE_POLE } from '../planet/placement';
import { PLANET_RADIUS } from '../planet/presets';
import type { Framing } from './camera';
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

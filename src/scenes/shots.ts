import * as THREE from 'three/webgpu';
import { SHOWCASE_POLE } from '../planet/placement';
import type { Framing } from './camera';

// 镜头表：星系全景和星球近景的取景参数（原来散在 world.ts 里的常量都收到这里）。
// ?tune 面板直接改这张表，World.applyShots() 让当前视图立刻按新参数取景；
// 调好后用面板的「Copy parameters」把 JSON 发回来，写回这里的默认值

export interface GalaxyShot {
  distance: number; // 镜头离星系中心
  elevation: number; // 仰角（度）
  lift: number; // 画面中心比星系中心高多少（世界单位；负数是往下压）
  fov: number; // 竖直视角（度）
  minDistance: number; // 滚轮拉近、推远的限制（按到星系中心的距离）
  maxDistance: number;
}

export interface PlanetShot {
  distance: number; // 镜头离星球中心
  lift: number; // 平视星球再抬头多少（世界单位）
  fov: number;
  minDistance: number;
  maxDistance: number;
}

export const SHOTS: { galaxy: GalaxyShot; planet: PlanetShot } = {
  // 星系全景：离中心 270、仰角 30°，画面中心压到星系中心下方 25（lift 为负）——
  // 离镜头近的星球在画面里偏低，整片星系往上提一点，上下才匀称。
  // 按 1440×900（宽高比 1.6）算：自转一整圈里 14 颗星球连光环都在画面里，横向约占 104–1336 px、纵向约占 107–858 px
  galaxy: { distance: 270, elevation: 30, lift: -25, fov: 45, minDistance: 140, maxDistance: 500 },
  // 星球视图（小王子式取景）：镜头沿展示方向（SHOWCASE_POLE：作品的摆放按它排，所以方向不在这里调）、离星球中心 distance，
  // 平视星球再抬头 lift，星球的上缘落在画面中上部，初始作品（showcaseDirs）就站在这道地平线上、衬着星空，星球下半部分可以出画。
  // 镜头仍绕星球中心转，远近限制按到星球中心的距离算
  planet: { distance: 24, lift: 8.5, fov: 45, minDistance: 15, maxDistance: 70 },
};

const GALAXY_ASPECT = 1.6; // 星系全景是按这个宽高比调的；更窄的窗口把镜头按比例拉远，左右两边的星球才不出画
const POLE = new THREE.Vector3(...SHOWCASE_POLE);

export function galaxyFraming(aspect: number, shot: GalaxyShot = SHOTS.galaxy): Framing {
  const k = Math.max(1, GALAXY_ASPECT / aspect);
  const el = THREE.MathUtils.degToRad(shot.elevation);
  return {
    target: new THREE.Vector3(0, 0, 0),
    position: new THREE.Vector3(0, Math.sin(el), Math.cos(el)).multiplyScalar(shot.distance * k),
    lift: shot.lift,
    fov: shot.fov,
    minDistance: shot.minDistance * k,
    maxDistance: shot.maxDistance * k,
    autoRotate: true,
  };
}

export function planetFraming(home: THREE.Vector3, shot: PlanetShot = SHOTS.planet): Framing {
  return {
    target: home.clone(),
    position: home.clone().addScaledVector(POLE, shot.distance),
    lift: shot.lift,
    fov: shot.fov,
    minDistance: shot.minDistance,
    maxDistance: shot.maxDistance,
    autoRotate: false,
  };
}

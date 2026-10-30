import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { WalkMode } from './walkMode';

// 给 Playwright 脚本（scripts/check-walk.mjs）用：读漫游状态、瞬移、逐帧记录镜头和角色
type Vec = [number, number, number];

export interface WalkSample {
  phase: string;
  dir: Vec; // 角色方向（星球本地坐标的单位向量）
  feet: number; // 角色模型根节点（脚底）离星球中心的距离：渲染出来的位置
  ground: number; // 那个方向上走路用的地面半径
  up: Vec; // 镜头的上方向（世界坐标）
  right: Vec; // 镜头的右方向
  clearance: number; // 离最近的作品圆柱边还有多远（球面路程；负数是穿进去了）
}

export interface WalkState {
  phase: string;
  ready: boolean; // 角色模型加载、预编译好了
  triboo: boolean; // 用的是翠宝模型（否则是胶囊体）
  teamId: string | null;
  home: Vec | null; // 正在走的星球中心（世界坐标）
  dir: Vec;
  facing: Vec;
  heading: Vec; // 镜头的水平朝向
  radius: number;
  ground: number;
  feet: number;
  speed: number;
  moving: boolean; // 正在自动走
  target: Vec | null; // 自动走的目标方向
  orbit: Vec | null; // 进入漫游前的轨道镜头位置（世界坐标）：退出时回到这里
  near: string | null; // 显示标签的作品
  label: { visible: boolean; text: string; x: number; y: number };
  camera: { position: Vec; up: Vec; drive: boolean; controls: boolean };
  anim: { rig: boolean; shoeTris: number[] | null; phase: number; amp: number }; // 走路动画：翠宝拆成部件了没有、鞋分成左右后的三角形数（左、右、原来）
}

// 走路动画里一只脚这一帧的样子（星球本地坐标）
export interface FootSample {
  planted: boolean;
  pos: Vec;
  lift: number;
}

declare global {
  interface Window {
    __walk?: {
      state(): WalkState;
      obstacles(): Array<{ id: string; dir: Vec; minAngle: number; side: number }>; // side：作品在角色侧面时多挡的球心角（手臂）
      teleport(dir: Vec, heading: Vec): boolean;
      trace(on: boolean): WalkSample[]; // trace(true) 开始记、返回空数组；trace(false) 停下、返回记下的每一帧
      feet(): { left: FootSample; right: FootSample; phase: number; amp: number; bob: number; squash: number }; // 两只脚、身体颠的高度和伸缩：自查、录屏脚本算着地时滑了多远
    };
  }
}

const vec = (v: THREE.Vector3): Vec => [v.x, v.y, v.z];

export function installWalkDebug(app: App, walk: WalkMode): void {
  const camera = app.world.rig.camera;
  const root = walk.character.root;
  const feet = (): number => {
    const entry = walk.planet;
    if (!entry || !root.parent) return NaN;
    root.updateWorldMatrix(true, false);
    return root.getWorldPosition(new THREE.Vector3()).distanceTo(entry.home);
  };
  const clearance = (): number => {
    const { obstacles, count } = walk.colliders;
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const a = Math.acos(THREE.MathUtils.clamp(walk.walker.dir.dot(obstacles[i].center), -1, 1));
      best = Math.min(best, (a - obstacles[i].minAngle) * walk.walker.radius);
    }
    return best;
  };
  const axis = (x: number, y: number): Vec => vec(new THREE.Vector3(x, y, 0).applyQuaternion(camera.quaternion));
  let samples: WalkSample[] | null = null;
  // 只在记轨迹时分配：平时这个回调直接返回
  walk.onStep = () => {
    if (!samples) return;
    samples.push({ phase: walk.phase, dir: vec(walk.walker.dir), feet: feet(), ground: walk.walker.ground(walk.walker.dir), up: axis(0, 1), right: axis(1, 0), clearance: clearance() });
  };
  window.__walk = {
    state: () => {
      const label = app.root.querySelector<HTMLElement>('.walk-label');
      const box = label && !label.hidden ? label.getBoundingClientRect() : null;
      return {
        phase: walk.phase,
        ready: walk.ready,
        triboo: walk.triboo,
        teamId: walk.planet?.team.id ?? null,
        home: walk.planet ? vec(walk.planet.home) : null,
        dir: vec(walk.walker.dir),
        facing: vec(walk.walker.facing),
        heading: vec(walk.cam.heading),
        radius: walk.walker.radius,
        ground: walk.walker.ground(walk.walker.dir),
        feet: feet(),
        speed: walk.walker.speed,
        moving: walk.walker.hasTarget,
        target: walk.walker.hasTarget ? vec(walk.walker.target) : null,
        orbit: walk.planet ? vec(walk.orbitPosition.clone().add(walk.planet.home)) : null,
        near: walk.nearWork?.work.id ?? null,
        label: { visible: !!box, text: label?.textContent ?? '', x: box ? box.left + box.width / 2 : NaN, y: box ? box.top + box.height / 2 : NaN },
        camera: { position: vec(camera.position), up: axis(0, 1), drive: app.world.rig.drive !== null, controls: app.world.rig.controls.enabled },
        anim: { rig: walk.character.parts !== null, shoeTris: walk.character.parts ? [...walk.character.parts.shoeTris] : null, phase: walk.character.gait.phase, amp: walk.character.gait.amp },
      };
    },
    obstacles: () => {
      const { works, obstacles, count } = walk.colliders;
      return Array.from({ length: count }, (_, i) => ({ id: works[i].work.id, dir: vec(obstacles[i].center), minAngle: obstacles[i].minAngle, side: obstacles[i].side }));
    },
    teleport: (dir, heading) => {
      if (!walk.planet) return false;
      walk.teleport(new THREE.Vector3(...dir), new THREE.Vector3(...heading));
      return true;
    },
    feet: () => {
      const [l, r] = walk.character.gait.feet;
      const foot = (f: typeof l): FootSample => ({ planted: f.planted, pos: vec(f.pos), lift: f.lift });
      const g = walk.character.gait;
      return { left: foot(l), right: foot(r), phase: g.phase, amp: g.amp, bob: g.bob, squash: g.squash };
    },
    trace: (on) => {
      const done = samples ?? [];
      samples = on ? [] : null;
      return on ? [] : done;
    },
  };
}

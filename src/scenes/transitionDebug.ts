import { VEIL_U } from '../style/veil';
import { reducedMotion, type TransitionKind } from './transition';
import type { World } from './world';

// 给自查脚本用（scripts/check-transitions.mjs）：看转场进行到哪、云层画没画、作品是不是还排着；录慢动作时调时间流速；重放开场探头
export interface TransitionDebug {
  timeScale(value?: number): number; // 0 = 时间停住（配合 advance 逐帧录屏）
  advance(seconds: number): void; // 时间停住时，下一帧往前走这么多秒
  state(): {
    transition: { kind: TransitionKind; t: number } | null;
    flying: boolean;
    veil: boolean;
    holding: boolean; // 作品还排着、没开始弹
    queued: number; // 排着的有几件
    peek: boolean; // 开场探头的翠宝正在演
    reduced: boolean; // 系统设置了减少动态效果
    fov: number;
    flash: number; // 翠宝黄的光这一帧的浓淡
    releases: number[]; // 最近几次作品出场的时刻（秒，stage 的时钟）
    clock: number; // stage 的时钟
  };
  peek(): boolean;
}

declare global {
  interface Window {
    __trans?: TransitionDebug;
  }
}

export function installTransitionDebug(world: World): void {
  const director = world.director;
  window.__trans = {
    timeScale: (value) => {
      if (value !== undefined && Number.isFinite(value) && value >= 0) director.timeScale = value;
      return director.timeScale;
    },
    advance: (seconds) => director.advance(seconds),
    state: () => ({
      transition: director.transition,
      flying: world.rig.flying,
      veil: VEIL_U.on.value > 0.5,
      holding: world.stage.holding,
      queued: world.stage.queued,
      peek: director.peeking,
      reduced: reducedMotion(),
      fov: world.rig.camera.fov,
      flash: VEIL_U.flash.value.y,
      releases: [...world.stage.releases],
      clock: world.stage.now,
    }),
    peek: () => director.peekIntro(),
  };
}

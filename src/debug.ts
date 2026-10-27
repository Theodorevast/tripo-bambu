import * as THREE from 'three/webgpu';
import type { App } from './app';
import type { PlanetRecipe } from './data/types';
import { PLINTH_HEIGHT } from './planet/placement';
import type { PlanetScreen } from './ui/planetScreen';

// 给 Playwright 脚本用：把 3D 物体换算成屏幕坐标，脚本才「点」得到它们
export interface DebugHooks {
  planetScreenPos(teamId: string): { x: number; y: number } | null;
  workScreenPos(workId: string): { x: number; y: number } | null;
  placedIds(): string[];
  teamPlanet(teamId: string): PlanetRecipe | null;
}

export function installDebugHooks(app: App, screen: PlanetScreen): void {
  window.__app = {
    planetScreenPos: (teamId) => {
      const e = app.world.planets.get(teamId);
      return e ? app.world.toScreen(e.home) : null;
    },
    workScreenPos: (workId) => {
      const pw = screen.view.placed.get(workId);
      if (!pw) return null;
      const y = (PLINTH_HEIGHT + Math.min(1, (pw.model?.height ?? 1) / 2)) * pw.placement.scale;
      return app.world.toScreen(pw.root.localToWorld(new THREE.Vector3(0, y, 0)));
    },
    placedIds: () => [...screen.view.placed.keys()],
    teamPlanet: (teamId) => {
      const planet = app.teams.find((t) => t.id === teamId)?.planet;
      return planet ? structuredClone(planet) : null; // 给副本：调用方改不到正在用的配方
    },
  };
}

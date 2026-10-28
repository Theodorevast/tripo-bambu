import * as THREE from 'three/webgpu';
import type { App } from './app';
import type { PlanetRecipe } from './data/types';
import { PLINTH_HEIGHT } from './planet/placement';
import type { PlanetScreen } from './ui/planetScreen';

// 给 Playwright 脚本用：把 3D 物体换算成屏幕坐标，脚本才「点」得到它们
// 星球视图的模型都挂好了看 #app[data-planet-ready="<teamId>"]（PlanetScreen 设置），不在这里
export interface DebugHooks {
  planetScreenPos(teamId: string): { x: number; y: number } | null;
  workScreenPos(workId: string): { x: number; y: number } | null;
  placedIds(): string[];
  teamPlanet(teamId: string): PlanetRecipe | null;
  routeIdle(): boolean; // 路由队列空着：没有跳转正在处理或排着（window.__ready 只管开页时的第一次）
  flights(): number; // 开页以来镜头飞了几次（星系开场、进出星球、编辑器转到作品都算）
  worksMeshes(teamId: string): number; // 这颗星球上挂着的作品网格数（展台、拾取盒、模型）：查迟到的模型有没有挂错星球
  highlighted(): string[]; // 星球视图里展台正高亮着的作品
  backend(): 'webgpu' | 'webgl2'; // 主画面实际用的渲染后端
}

export function installDebugHooks(app: App, screen: PlanetScreen): void {
  // 数镜头飞行：包一层 rig.fly，行为不变
  let flights = 0;
  const rig = app.world.rig;
  const fly = rig.fly.bind(rig);
  rig.fly = (f, duration) => {
    flights++;
    return fly(f, duration);
  };
  window.__world = app.world;
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
    routeIdle: () => !app.routing,
    flights: () => flights,
    worksMeshes: (teamId) => {
      let n = 0;
      app.world.planets.get(teamId)?.planet.works.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
      return n;
    },
    highlighted: () => [...screen.view.placed.values()]
      .filter((pw) => (pw.plinth.material as THREE.MeshStandardNodeMaterial).emissiveIntensity > 0)
      .map((pw) => pw.work.id),
    backend: () => ((app.world.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'),
  };
}

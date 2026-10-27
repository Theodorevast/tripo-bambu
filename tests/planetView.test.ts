import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { BASE_RADIUS, PRESETS } from '../src/planet/presets';
import { PlanetView, plinthRadius } from '../src/scenes/planetView';
import type { World } from '../src/scenes/world';

const team: Team = {
  id: 't', name: 'T', motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'm', handle: 'm', displayName: 'M', role: 'captain' }],
  works: [
    { id: 'w1', title: 'One', authorId: 'm', file: '', thumb: '', tris: 10 },
    { id: 'w2', title: 'Two', authorId: 'm', file: '', thumb: '', tris: 10 },
  ],
  planet: {
    seed: 3, preset: 'desert', ring: false, atmosphere: false,
    placements: [
      { workId: 'w1', dir: [0, 1, 0], yaw: 0, scale: 1 },
      { workId: 'w2', dir: [1, 0, 0], yaw: 0, scale: 1.5 },
    ],
  },
};

// PlanetView 只用到 world.planets 和 world.rayFrom；home 是星球在星系里的位置（和 World.setTeams 一样，星球的 group 也放到那里）
function fakeWorld(home = new THREE.Vector3()): World {
  const planet = new PlanetObject(team.planet);
  planet.group.position.copy(home);
  return { planets: new Map([[team.id, { team, planet, hit: new THREE.Mesh(), home }]]) } as unknown as World;
}

describe('PlanetView', () => {
  it('enter 摆上所有作品：贴在地表上，按 scale 缩放，模型已挂上', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    await view.enter(team);
    expect([...view.placed.keys()]).toEqual(['w1', 'w2']);
    const entry = world.planets.get('t')!;
    const w1 = view.placed.get('w1')!;
    expect(w1.root.parent).toBe(entry.planet.works);
    expect(w1.root.position.length()).toBeGreaterThanOrEqual(entry.planet.height(0, 1, 0) - 1e-9);
    expect(w1.root.position.length()).toBeLessThanOrEqual(BASE_RADIUS * (1 + PRESETS.desert.amp) + 1e-9);
    expect(view.placed.get('w2')!.scaler.scale.x).toBe(1.5);
    expect(w1.model).not.toBeNull();
  });
  it('remove 拿掉一件；leave 清空全部', async () => {
    const view = new PlanetView(fakeWorld());
    await view.enter(team);
    view.remove('w1');
    expect(view.placed.has('w1')).toBe(false);
    view.leave();
    expect(view.placed.size).toBe(0);
    expect(view.team).toBeNull();
  });
  it('找不到的作品不摆', async () => {
    const view = new PlanetView(fakeWorld());
    await view.enter({ ...team, planet: { ...team.planet, placements: [{ workId: 'nope', dir: [0, 1, 0], yaw: 0, scale: 1 }] } });
    expect(view.placed.size).toBe(0);
  });
  it('pick 不穿过星球：正面的作品拾取得到，被星球挡住的拾取不到', async () => {
    const raycaster = new THREE.Raycaster();
    const world = Object.assign(fakeWorld(), { rayFrom: () => raycaster });
    const view = new PlanetView(world);
    await view.enter(team);
    world.planets.get('t')!.planet.group.updateMatrixWorld(true); // 真实页面里每帧渲染时更新
    // w1 在北极：从上往下打，拾取盒在星球前面；从下往上打，射线要先穿过整颗星球
    raycaster.ray.set(new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, -1, 0));
    expect(view.pick(0, 0)?.work.id).toBe('w1');
    raycaster.ray.set(new THREE.Vector3(0, -30, 0), new THREE.Vector3(0, 1, 0));
    expect(view.pick(0, 0)).toBeNull();
  });
  it('pick：擦着地平线的射线仍然拾取到地平线上的作品（遮挡球取最低的地形，不能取最高的）', async () => {
    const raycaster = new THREE.Raycaster();
    const world = Object.assign(fakeWorld(), { rayFrom: () => raycaster });
    const view = new PlanetView(world);
    // 作品都换成窄而高的（水平半径 0.5、高 2.6）：w1 的拾取盒只有 1 宽，射线在 x = 0.5 处才打到它。
    // 占位体 w1 的水平半径有 1.53，比最高地形的球在 y = 10.7 处的半宽（√(10.8² − 10.7²) ≈ 1.47）还宽，测不出遮挡球取错了半径
    vi.spyOn(view.library, 'load').mockImplementation(async () => ({ object: new THREE.Group(), height: 2.6, footprint: 0.5, failed: false }));
    await view.enter(team);
    world.planets.get('t')!.planet.group.updateMatrixWorld(true);
    // w1 立在北极。y = 10.7 的水平射线从侧面擦过北极上空：比最低的地形（9.2）高，比最高的地形（10.8）低。
    // 遮挡球要是取了最高的地形，射线在打到拾取盒之前就先「进了星球」，地平线上的作品就点不到了
    raycaster.ray.set(new THREE.Vector3(30, 10.7, 0), new THREE.Vector3(-1, 0, 0));
    expect(view.pick(0, 0)?.work.id).toBe('w1');
  });
  it('星球不在原点：遮挡球跟着 entry.home 走（pick 和 occluded 都是）', async () => {
    const home = new THREE.Vector3(40, -12, 25);
    const raycaster = new THREE.Raycaster();
    const world = Object.assign(fakeWorld(home), { rayFrom: () => raycaster });
    const view = new PlanetView(world);
    await view.enter(team);
    world.planets.get('t')!.planet.group.updateMatrixWorld(true);
    const above = home.clone().add(new THREE.Vector3(0, 30, 0));
    const below = home.clone().add(new THREE.Vector3(0, -30, 0));
    raycaster.ray.set(above, new THREE.Vector3(0, -1, 0));
    expect(view.pick(0, 0)?.work.id).toBe('w1');
    // 从星球底下往上打：射线先穿过这颗星球（不是原点那里）才到 w1
    raycaster.ray.set(below, new THREE.Vector3(0, 1, 0));
    expect(view.pick(0, 0)).toBeNull();
    const top = view.topOf(view.placed.get('w1')!);
    expect(view.occluded(above, top)).toBe(false);
    expect(view.occluded(below, top)).toBe(true);
  });
  it('occluded：从镜头看过去隔着星球的点（悬浮标签用）', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    await view.enter(team);
    world.planets.get('t')!.planet.group.updateMatrixWorld(true);
    const top = view.topOf(view.placed.get('w1')!);
    expect(view.occluded(new THREE.Vector3(0, 30, 0), top)).toBe(false);
    expect(view.occluded(new THREE.Vector3(0, -30, 0), top)).toBe(true);
    expect(view.occluded(new THREE.Vector3(30, 0, 0), top)).toBe(false); // 从侧面斜看，视线擦过星球上方
  });
  it('plinthRadius 就是展台实际用的半径', async () => {
    const view = new PlanetView(fakeWorld());
    await view.enter(team);
    const w1 = view.placed.get('w1')!;
    expect(w1.plinth.scale.x).toBe(plinthRadius(w1.model!.footprint));
    expect(plinthRadius(0.1)).toBe(0.55);
  });
});

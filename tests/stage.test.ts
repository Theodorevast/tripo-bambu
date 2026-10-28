import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { PLANET_RADIUS } from '../src/planet/presets';
import { PlanetView, STAGE } from '../src/scenes/planetView';
import { STAND_TOP } from '../src/scenes/plinth';
import type { Stage } from '../src/scenes/stager';
import type { World } from '../src/scenes/world';

// 地标缩放（stage 角色）：镜头离地面高（星球视图）时作品连展台一起放大，贴地（漫游）时原大；放大在 stand 这一层，
// scaler 还是摆放的缩放（编辑器、漫游的碰撞都按它算）

const R = PLANET_RADIUS;
// 一排三件，都朝 +Z：土路从它们正面经过（和种子数据的摆法一样）；路的两头往 ±X 伸出去，不从作品身上过
const along = (m: number): [number, number, number] => [Math.sin(m / R), Math.cos(m / R), 0];
const team: Team = {
  id: 't', name: 'T', motto: '', color: '#d9b77e', status: 'active', foundedDaysAgo: 1,
  members: [{ id: 'm', handle: 'ann', displayName: 'Ann', role: 'captain' }],
  works: [
    { id: 'w1', title: 'One', authorId: 'm', file: '', thumb: '', tris: 10 },
    { id: 'w2', title: 'Two', authorId: 'm', file: '', thumb: '', tris: 10 },
    { id: 'w3', title: 'Three', authorId: 'm', file: '', thumb: '', tris: 10 },
  ],
  planet: {
    seed: 3, preset: 'desert', ring: false, atmosphere: false,
    placements: [
      { workId: 'w1', dir: along(0), yaw: 0, scale: 1 },
      { workId: 'w2', dir: along(11), yaw: 0, scale: 1.5 },
      { workId: 'w3', dir: along(-11), yaw: 0, scale: 1 },
    ],
  },
};
const instantStage: Stage = { precompile: async () => {}, prepare: async () => ({ start() {}, cancel() {} }) };

function setup() {
  const planet = new PlanetObject(team.planet);
  const home = new THREE.Vector3();
  const hooks = new Set<(dt: number) => void>();
  const camera = new THREE.PerspectiveCamera();
  const world = { planets: new Map([[team.id, { team, planet, hit: new THREE.Mesh(), home }]]), stage: instantStage, frameHooks: hooks, rig: { camera } } as unknown as World;
  const view = new PlanetView(world);
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) for (const h of hooks) h(1 / 60);
  };
  return { view, camera, run };
}

describe('地标缩放', () => {
  it('星球视图的高度：作品连展台放大；漫游的高度：原大。scaler 一直是摆放的缩放', async () => {
    const { view, camera, run } = setup();
    view.enter(team);
    await view.loaded;
    camera.position.set(0, R * 2.6, 0); // 离地面 1.6 R：星球视图
    run(1.5);
    const w1 = view.placed.get('w1')!;
    const w2 = view.placed.get('w2')!;
    expect(view.presentScale).toBeCloseTo(STAGE.overview, 3);
    expect(w1.hero).toBeGreaterThan(1.3);
    expect(w1.hero).toBeLessThanOrEqual(STAGE.overview + 1e-6);
    expect(w1.stand.scale.x).toBeCloseTo(w1.hero, 6);
    expect(w2.scaler.scale.x).toBe(1.5);
    // 标签的锚点跟着放大
    const top = view.topOf(w1).length() - w1.root.position.length();
    expect(top).toBeCloseTo((STAND_TOP + (w1.model?.height ?? 1) + 0.4) * w1.hero, 4);
    camera.position.set(0, R + 1.2, 0); // 贴地：漫游
    run(1.5);
    expect(view.presentScale).toBe(1);
    expect(w1.hero).toBeCloseTo(1, 2);
    expect(w1.stand.scale.x).toBeCloseTo(1, 2);
  });

  it('作品的位置不随放大变（只有 stand 这一层放大）', async () => {
    const { view, camera, run } = setup();
    view.enter(team);
    await view.loaded;
    const w1 = view.placed.get('w1')!;
    const before = w1.root.position.clone();
    camera.position.set(0, R * 2.6, 0);
    run(1);
    expect(w1.root.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it('编辑器拖起、放下：拖着时悬在半空，放下后落回地面', async () => {
    const { view, camera, run } = setup();
    view.enter(team);
    await view.loaded;
    camera.position.set(0, R + 1.2, 0);
    const w1 = view.placed.get('w1')!;
    view.pickUp(w1);
    run(0.5);
    expect(w1.stand.position.y).toBeGreaterThan(0.15);
    view.putDown(w1);
    run(1.5);
    expect(w1.stand.position.y).toBe(0);
    expect(w1.stand.scale.y).toBeCloseTo(w1.hero, 6);
  });
});

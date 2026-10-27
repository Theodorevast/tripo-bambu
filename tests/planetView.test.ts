import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { BASE_RADIUS, PRESETS } from '../src/planet/presets';
import { PlanetView } from '../src/scenes/planetView';
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

// PlanetView 只用到 world.planets 和 world.rayFrom
function fakeWorld(): World {
  const planet = new PlanetObject(team.planet);
  return { planets: new Map([[team.id, { team, planet, hit: new THREE.Mesh(), home: new THREE.Vector3() }]]) } as unknown as World;
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
});

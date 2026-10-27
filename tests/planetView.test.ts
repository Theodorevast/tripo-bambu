import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedModel } from '../src/assets/models';
import type { Team } from '../src/data/types';
import { PlanetObject } from '../src/planet/planetObject';
import { BASE_RADIUS, PRESETS } from '../src/planet/presets';
import { PlanetView, plinthRadius } from '../src/scenes/planetView';
import type { Entrance, Stage } from '../src/scenes/stager';
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

// 另一个团队，作品 id 故意和 team 的一样：迟到的模型按 id 找位置的话就会挂错
const other: Team = {
  ...team, id: 'u', name: 'U', color: '#7e9bd9',
  works: team.works.map((w) => ({ ...w, title: `${w.title} (U)` })),
  planet: { ...team.planet, seed: 8, preset: 'glacier' },
};

// 新模型立刻放行（真实页面里 Stager 要等贴图上传、着色器编译，再排到某一帧才挂上）
const instantStage: Stage = { precompile: async () => {}, prepare: async () => ({ start() {}, cancel() {} }) };

// PlanetView 只用到 world.planets、world.stage 和 world.rayFrom；home 是星球在星系里的位置（和 World.setTeams 一样，星球的 group 也放到那里）
function fakeWorld(home = new THREE.Vector3(), stage: Stage = instantStage): World {
  const entries = [team, other].map((t, i) => {
    const planet = new PlanetObject(t.planet);
    const at = i === 0 ? home : new THREE.Vector3(60, 0, 0);
    planet.group.position.copy(at);
    return [t.id, { team: t, planet, hit: new THREE.Mesh(), home: at }] as const;
  });
  return { planets: new Map(entries), stage } as unknown as World;
}

// 进入星球并等这次进入的模型都挂好
async function enterLoaded(view: PlanetView, t: Team): Promise<void> {
  view.enter(t);
  await view.loaded;
}

// 模型加载由测试手动放行：release(id) 放行这件作品最早一次还没放行的加载，返回交出去的模型
function slowModels(view: PlanetView) {
  const waiting: Array<{ id: string; resolve: (m: LoadedModel) => void }> = [];
  vi.spyOn(view.library, 'load').mockImplementation((work) => new Promise((resolve) => waiting.push({ id: work.id, resolve })));
  return {
    waiting,
    release(id: string): LoadedModel {
      const i = waiting.findIndex((w) => w.id === id);
      const [w] = waiting.splice(i, 1);
      const model: LoadedModel = { object: new THREE.Group(), height: 2, footprint: 0.6, failed: false };
      model.object.userData.isModel = true; // modelsOn 按这个找
      w.resolve(model);
      return model;
    },
  };
}

// 等排队的 Promise 回调都跑完
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const opacity = (view: PlanetView, id: string) => (view.placed.get(id)!.plinth.material as THREE.MeshStandardNodeMaterial).opacity;
// 这颗星球上挂着的、slowModels 交出去的模型
const modelsOn = (world: World, teamId: string) => {
  const found: THREE.Object3D[] = [];
  world.planets.get(teamId)!.planet.works.traverse((o) => { if (o.userData.isModel) found.push(o); });
  return found;
};

describe('PlanetView', () => {
  it('enter 摆上所有作品：贴在地表上，按 scale 缩放，模型已挂上', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    await enterLoaded(view, team);
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
    await enterLoaded(view, team);
    view.remove('w1');
    expect(view.placed.has('w1')).toBe(false);
    view.leave();
    expect(view.placed.size).toBe(0);
    expect(view.team).toBeNull();
  });
  it('找不到的作品不摆', async () => {
    const view = new PlanetView(fakeWorld());
    await enterLoaded(view, { ...team, planet: { ...team.planet, placements: [{ workId: 'nope', dir: [0, 1, 0], yaw: 0, scale: 1 }] } });
    expect(view.placed.size).toBe(0);
  });
  it('pick 不穿过星球：正面的作品拾取得到，被星球挡住的拾取不到', async () => {
    const raycaster = new THREE.Raycaster();
    const world = Object.assign(fakeWorld(), { rayFrom: () => raycaster });
    const view = new PlanetView(world);
    await enterLoaded(view, team);
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
    await enterLoaded(view, team);
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
    await enterLoaded(view, team);
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
    await enterLoaded(view, team);
    world.planets.get('t')!.planet.group.updateMatrixWorld(true);
    const top = view.topOf(view.placed.get('w1')!);
    expect(view.occluded(new THREE.Vector3(0, 30, 0), top)).toBe(false);
    expect(view.occluded(new THREE.Vector3(0, -30, 0), top)).toBe(true);
    expect(view.occluded(new THREE.Vector3(30, 0, 0), top)).toBe(false); // 从侧面斜看，视线擦过星球上方
  });
  it('plinthRadius 就是展台实际用的半径', async () => {
    const view = new PlanetView(fakeWorld());
    await enterLoaded(view, team);
    const w1 = view.placed.get('w1')!;
    expect(w1.plinth.scale.x).toBe(plinthRadius(w1.model!.footprint));
    expect(plinthRadius(0.1)).toBe(0.55);
  });
});

describe('PlanetView：模型在后台加载，进入星球不等它们', () => {
  it('enter 立即摆好全部展台（半透明）就返回；loaded 等这次的模型都挂好才 resolve', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    const models = slowModels(view);
    expect(view.enter(team)).toBeUndefined();
    expect([...view.placed.keys()]).toEqual(['w1', 'w2']);
    const w1 = view.placed.get('w1')!;
    expect(w1.root.parent).toBe(world.planets.get('t')!.planet.works);
    expect(w1.model).toBeNull();
    expect(opacity(view, 'w1')).toBe(0.4);
    let loaded = false;
    void view.loaded.then(() => { loaded = true; });
    const m1 = models.release('w1');
    await settle();
    expect(w1.model?.object).toBe(m1.object);
    expect(opacity(view, 'w1')).toBe(1);
    expect(loaded).toBe(false); // w2 还在加载
    models.release('w2');
    await settle();
    expect(loaded).toBe(true);
    expect(opacity(view, 'w2')).toBe(1);
  });

  it('加载期间离开：迟到的模型不挂上', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    const models = slowModels(view);
    view.enter(team);
    const w1 = view.placed.get('w1')!;
    view.leave();
    const late = [models.release('w1'), models.release('w2')];
    await settle();
    expect(w1.model).toBeNull();
    for (const m of late) expect(m.object.parent).toBeNull();
    expect(world.planets.get('t')!.planet.works.children).toHaveLength(0);
  });

  it('加载期间换到别的团队（作品 id 相同）：迟到的模型不挂到新团队的星球上', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    const models = slowModels(view);
    view.enter(team);
    view.leave();
    view.enter(other);
    const late = [models.release('w1'), models.release('w2')]; // 先放行的是 team 的那两次加载
    await settle();
    for (const m of late) expect(m.object.parent).toBeNull();
    expect(view.placed.get('w1')!.model).toBeNull();
    expect(modelsOn(world, 'u')).toHaveLength(0);
    expect(world.planets.get('t')!.planet.works.children).toHaveLength(0);
    const own = [models.release('w1'), models.release('w2')];
    await view.loaded;
    expect(view.placed.get('w1')!.model?.object).toBe(own[0].object);
    expect(modelsOn(world, 'u')).toEqual(own.map((m) => m.object));
  });

  it('加载期间离开又回到同一个团队：第一次进入的模型作废，第二次的各自挂上，不会多挂一份', async () => {
    const world = fakeWorld();
    const view = new PlanetView(world);
    const models = slowModels(view);
    view.enter(team);
    view.leave();
    view.enter(team);
    const second = view.placed.get('w1')!;
    const stale = models.release('w1');
    await settle();
    expect(stale.object.parent).toBeNull();
    expect(second.model).toBeNull();
    const fresh = models.release('w1');
    const staleW2 = models.release('w2'); // w2 也是先放行第一次进入的那次加载
    models.release('w2');
    await view.loaded;
    expect(second.model?.object).toBe(fresh.object);
    expect(staleW2.object.parent).toBeNull();
    expect(modelsOn(world, 't')).toHaveLength(2);
  });

  it('编辑器单独 await place()：展台马上摆上，模型挂好后才 resolve，拿到的就是摆上去的那件', async () => {
    const view = new PlanetView(fakeWorld());
    const models = slowModels(view);
    view.enter({ ...team, planet: { ...team.planet, placements: [] } });
    const placing = view.place({ workId: 'w1', dir: [0, 1, 0], yaw: 0, scale: 1 });
    expect(view.placed.has('w1')).toBe(true);
    const m = models.release('w1');
    const pw = await placing;
    expect(pw).toBe(view.placed.get('w1'));
    expect(pw!.model?.object).toBe(m.object);
  });

  it('place 期间被编辑器删掉：返回 null，模型不挂', async () => {
    const view = new PlanetView(fakeWorld());
    const models = slowModels(view);
    view.enter({ ...team, planet: { ...team.planet, placements: [] } });
    const placing = view.place({ workId: 'w1', dir: [0, 1, 0], yaw: 0, scale: 1 });
    view.remove('w1');
    const m = models.release('w1');
    expect(await placing).toBeNull();
    expect(m.object.parent).toBeNull();
  });
});

// 准备阶段（贴图上传、着色器编译、排队）由测试手动放行：pending 里是每次 prepare 的模型、alive 和放行函数
function manualStage() {
  const pending: Array<{ object: THREE.Object3D; alive: () => boolean; resolve: (e: Entrance | null) => void }> = [];
  const stage: Stage = {
    precompile: async () => {},
    prepare: (object, alive = () => true) => new Promise((resolve) => pending.push({ object, alive, resolve })),
  };
  return { stage, pending };
}

describe('PlanetView：模型先准备好（贴图、着色器）再挂上，挂上后缩放淡入', () => {
  it('准备好之前模型不挂、展台还是半透明；轮到它时挂上、展台变实，并开始缩放淡入', async () => {
    const { stage, pending } = manualStage();
    const view = new PlanetView(fakeWorld(undefined, stage));
    view.enter(team);
    await settle();
    expect(pending).toHaveLength(2);
    const w1 = view.placed.get('w1')!;
    expect(w1.model).toBeNull();
    expect(pending[0].object.parent).toBeNull();
    expect(opacity(view, 'w1')).toBe(0.4);
    const entrance = { start: vi.fn(), cancel: vi.fn() };
    pending[0].resolve(entrance);
    await settle();
    expect(w1.model?.object).toBe(pending[0].object);
    expect(pending[0].object.parent).toBe(w1.scaler);
    expect(opacity(view, 'w1')).toBe(1);
    expect(entrance.start).toHaveBeenCalledOnce();
    expect(entrance.cancel).not.toHaveBeenCalled();
  });

  it('准备期间离开星球：alive() 变成 false；准备完了也不挂，交回的 Entrance 被取消', async () => {
    const { stage, pending } = manualStage();
    const world = fakeWorld(undefined, stage);
    const view = new PlanetView(world);
    view.enter(team);
    await settle();
    expect(pending[0].alive()).toBe(true);
    view.leave();
    expect(pending[0].alive()).toBe(false);
    const late = { start: vi.fn(), cancel: vi.fn() };
    pending[0].resolve(late);
    pending[1].resolve(null); // Stager 自己发现不要了
    await view.loaded;
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.start).not.toHaveBeenCalled();
    expect(pending[0].object.parent).toBeNull();
    expect(world.planets.get('t')!.planet.works.children).toHaveLength(0);
  });
});

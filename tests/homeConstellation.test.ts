import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { HomeConstellation } from '../src/scenes/homeConstellation';
import type { PlanetEntry, World } from '../src/scenes/world';

// 首页的星座线（第二版 [v2-world]）：换版式（加 / 减星球、换档位、挪位置）时连线数对、绘制范围对，
// 而且线和小星的缓冲、几何都还是原来那几份（原地更新，不重新分配）

type Tier = 'you' | 'built' | 'building';
interface Spec {
  id: string;
  tier: Tier;
  pos: [number, number, number];
}

// 假的 World：只有星座线用到的 planets、slotOf、hovered
function fakeWorld(): { world: World; set(specs: Spec[]): void; entry(id: string): PlanetEntry } {
  const planets = new Map<string, PlanetEntry>();
  const slots = new Map<PlanetEntry, { tier: Tier; scale: number }>();
  const world = { planets, hovered: null as PlanetEntry | null, slotOf: (e: PlanetEntry) => slots.get(e) ?? null } as unknown as World;
  return {
    world,
    set(specs) {
      // 已经有的星球留着原来的对象（和 World.setTeams 以外的换版式一样）：只改位置和档位
      const keep = new Set(specs.map((s) => s.id));
      for (const id of [...planets.keys()]) if (!keep.has(id)) planets.delete(id);
      for (const s of specs) {
        let e = planets.get(s.id);
        if (!e) {
          e = { team: { id: s.id }, home: new THREE.Vector3() } as unknown as PlanetEntry;
          planets.set(s.id, e);
        }
        e.home.set(...s.pos);
        slots.set(e, { tier: s.tier, scale: 1 });
      }
    },
    entry: (id) => planets.get(id)!,
  };
}

// 星球之间离得够远（线不会因为挨得太近被藏掉）
const ring = (n: number, r: number, from = 0): Array<[number, number, number]> =>
  Array.from({ length: n }, (_, i) => [Math.cos(((i + from) / 12) * Math.PI * 2) * r, 0, Math.sin(((i + from) / 12) * Math.PI * 2) * r]);

function specs(built: number, building: number, r = 400): Spec[] {
  const out: Spec[] = [{ id: 'you', tier: 'you', pos: [0, 0, 0] }];
  ring(built, r).forEach((p, i) => out.push({ id: `b${i}`, tier: 'built', pos: p }));
  ring(building, r * 2, 0.5).forEach((p, i) => out.push({ id: `g${i}`, tier: 'building', pos: p }));
  return out;
}

const step = (c: HomeConstellation, w: World) => c.update(0.25, w, true); // 0.25 秒：过了 0.2 秒的检查间隔

describe('首页的星座线：原地更新', () => {
  it('两条臂：你的星球连到每条臂的第一颗，同一条臂上相邻的相连；绘制范围只画用到的那几组', () => {
    const f = fakeWorld();
    const c = new HomeConstellation();
    f.set(specs(4, 0));
    step(c, f.world);
    // 建好的 b0、b2 在第 0 条臂，b1、b3 在第 1 条臂：you→b0、b0→b2、you→b1、b1→b3
    expect(c.state.links).toBe(4);
    expect(c.lines.drawCount).toBe(4 * 3 * 6); // 每条一组（1 条线 + 2 颗星 = 3 个四边形，每个 6 个索引）
  });

  it('加了星球、换了档位：连线数跟着变，缓冲和几何都是原来那几份', () => {
    const f = fakeWorld();
    const c = new HomeConstellation();
    f.set(specs(4, 0));
    step(c, f.world);
    const geometry = c.lines.mesh.geometry;
    const buffers = c.lines.buffers.slice();
    // 6 颗建好的 + 2 颗建设中的：第 0 条臂 b0 b2 b4 g0，第 1 条臂 b1 b3 b5 g1，各 1 + 3 条
    f.set(specs(6, 2));
    step(c, f.world);
    expect(c.state.links).toBe(8);
    expect(c.lines.drawCount).toBe(8 * 3 * 6);
    expect(c.lines.mesh.geometry).toBe(geometry);
    c.lines.buffers.forEach((b, i) => expect(b).toBe(buffers[i]));
    // 少了星球：连线变少，缓冲照旧
    f.set(specs(2, 0));
    step(c, f.world);
    expect(c.state.links).toBe(2);
    expect(c.lines.drawCount).toBe(2 * 3 * 6);
    c.lines.buffers.forEach((b, i) => expect(b).toBe(buffers[i]));
  });

  it('只是挪了位置（换版式时星球慢慢挪过去）：不重新连，只重摆顶点', () => {
    const f = fakeWorld();
    const c = new HomeConstellation();
    f.set(specs(4, 0));
    step(c, f.world);
    const relinks = c.state.relinks;
    const pos = c.lines.buffers[0] as Float32Array;
    const before = Array.from(pos.subarray(0, 12));
    f.set(specs(4, 0, 520));
    step(c, f.world);
    expect(c.state.relinks).toBe(relinks);
    expect(c.state.links).toBe(4);
    expect(Array.from(pos.subarray(0, 12))).not.toEqual(before);
  });

  it('指着一颗星球：连着它的线变亮，别的不变', () => {
    const f = fakeWorld();
    const c = new HomeConstellation();
    f.set(specs(4, 0));
    step(c, f.world);
    (f.world as unknown as { hovered: PlanetEntry | null }).hovered = f.entry('b0');
    for (let i = 0; i < 20; i++) c.update(0.05, f.world, true);
    // b0 连着两条：you→b0、b0→b2
    expect(c.state.lit).toBe(2);
  });
});

import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { PIECE_IDS } from '../src/nature/decorKit';
import { filterGarden, GARDEN_V2, gardenCandidates, gardenReach, Gardens, vivid, type GardenGround, type GardenWork } from '../src/nature/decorGarden';

// 作品四周的小花园（stage 角色）：布局按作品 id 定、过滤只看土路 / 水 / 邻居、横杆跟着柱子走、长出来和缩回去

const R = 30;
const north = new THREE.Vector3(0, 1, 0);
const work = (id: string, dir = north, label: string | null = '@ann', plinth = 0.6): GardenWork => ({
  id, dir: dir.clone().normalize(), front: new THREE.Vector3(0, 0, 1), plinth, scale: 1, label, accent: new THREE.Color('#d9b77e'),
});
const ground = (path: (d: THREE.Vector3) => number = () => 0): GardenGround => ({ radius: R, height: () => R, sea: 0, path });
const kind = (it: { piece: number }) => PIECE_IDS[it.piece];
// 北极往 +x（作品的右边）转过 m 米
const east = (m: number) => new THREE.Vector3(Math.sin(m / R), Math.cos(m / R), 0);

describe('花园的布局', () => {
  it('同一件作品每次长得一样，换一件就不一样', () => {
    const a = gardenCandidates(work('w-1')).map((it) => `${kind(it)}:${it.x.toFixed(4)},${it.z.toFixed(4)}`);
    const again = gardenCandidates(work('w-1')).map((it) => `${kind(it)}:${it.x.toFixed(4)},${it.z.toFixed(4)}`);
    const b = gardenCandidates(work('w-2')).map((it) => `${kind(it)}:${it.x.toFixed(4)},${it.z.toFixed(4)}`);
    expect(again).toEqual(a);
    expect(b).not.toEqual(a);
  });

  it('有栅栏（柱子 + 横杆）、花、叶丛、灌木、踏脚石和写着作者的路牌；没有作者就不立路牌；第二版默认没有团队色小旗（GARDEN_V2.flags）', () => {
    const kinds = new Set(gardenCandidates(work('w-1')).map(kind));
    for (const k of ['post', 'rail', 'tuft', 'slab', 'signpost', 'signface'] as const) expect(kinds.has(k)).toBe(true);
    expect(kinds.has('flag')).toBe(GARDEN_V2.flags);
    GARDEN_V2.flags = true;
    try {
      const flagged = gardenCandidates(work('w-1'));
      expect(new Set(flagged.map(kind)).has('flag')).toBe(true);
      // 旗子开不开，别的零件的位置都一样（随机数照样取）
      const others = (xs: ReturnType<typeof gardenCandidates>) => xs.filter((it) => kind(it) !== 'flag').map((it) => `${kind(it)}:${it.x.toFixed(4)},${it.z.toFixed(4)}`);
      GARDEN_V2.flags = false;
      expect(others(gardenCandidates(work('w-1')))).toEqual(others(flagged));
    } finally {
      GARDEN_V2.flags = false;
    }
    expect(['daisy', 'bell', 'pom'].some((k) => kinds.has(k as never))).toBe(true);
    expect(kinds.has('bush') || kinds.has('bloom')).toBe(true);
    const unsigned = new Set(gardenCandidates(work('w-1', north, null)).map(kind));
    expect(unsigned.has('signpost')).toBe(false);
    expect(unsigned.has('signface')).toBe(false);
  });

  it('正面留给土路：栅栏、灌木、长椅都在作品两侧和背后', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      for (const it of gardenCandidates(work(id))) {
        if (['post', 'rail', 'bush', 'bloom', 'bench', 'flag'].includes(kind(it))) expect(it.z).toBeLessThan(0.35);
      }
    }
  });

  it('土路上不长东西（踏脚石可以铺到路边）', () => {
    // 作品正面 1.2 米以外整片都是路
    const items = gardenCandidates(work('w-1'));
    filterGarden(items, work('w-1'), ground((d) => (d.z * R > 1.2 ? 1 : 0)), [], 1);
    for (const it of items) if (it.ok) expect(it.z).toBeLessThan(1.25);
    expect(items.some((it) => !it.ok)).toBe(true);
  });

  it('不压到邻居：邻居展台四周不放零件，栅栏、灌木离得更远', () => {
    const me = work('w-1');
    const other = work('w-2', east(2.2));
    const items = gardenCandidates(me);
    filterGarden(items, me, ground(), [other], 1);
    for (const it of items) {
      if (!it.ok) continue;
      const d = east(it.x).applyAxisAngle(new THREE.Vector3(1, 0, 0), it.z / R); // 足够近似
      const gap = d.angleTo(other.dir) * R;
      expect(gap).toBeGreaterThan(other.plinth + 0.4);
    }
  });

  it('柱子没了，两边的横杆也不要', () => {
    const me = work('w-1');
    const items = gardenCandidates(me);
    const post = items.find((it) => kind(it) === 'post' && items.filter((r) => r.rail && ((Math.abs(r.rail[0] - it.x) < 1e-9 && Math.abs(r.rail[1] - it.z) < 1e-9) || (Math.abs(r.rail[2] - it.x) < 1e-9 && Math.abs(r.rail[3] - it.z) < 1e-9))).length > 0)!;
    // 只有这根柱子脚下是「路」
    const at = new THREE.Vector3(Math.sin(post.x / R), 1, Math.sin(post.z / R)).normalize();
    filterGarden(items, me, ground((d) => (d.angleTo(at) * R < 0.05 ? 1 : 0)), [], 1);
    expect(post.ok).toBe(false);
    for (const r of items.filter((it) => it.rail)) {
      const touches = [[r.rail![0], r.rail![1]], [r.rail![2], r.rail![3]]].some(([x, z]) => Math.abs(x - post.x) < 1e-9 && Math.abs(z - post.z) < 1e-9);
      if (touches) expect(r.ok).toBe(false);
    }
  });

  it('花园的范围比展台大一圈', () => {
    const items = gardenCandidates(work('w-1'));
    filterGarden(items, work('w-1'), ground(), [], 1);
    expect(gardenReach(items)).toBeGreaterThan(0.6 + 0.8);
  });

  it('团队色（多是粉彩）给小旗用时提饱和度', () => {
    const hsl = { h: 0, s: 0, l: 0 };
    vivid(new THREE.Color('#d9b77e')).getHSL(hsl, THREE.SRGBColorSpace);
    expect(hsl.s).toBeGreaterThanOrEqual(0.72 - 1e-4);
    expect(hsl.l).toBeGreaterThanOrEqual(0.46 - 1e-4);
    expect(hsl.l).toBeLessThanOrEqual(0.6 + 1e-4); // sRGB ↔ 线性来回换一次有一点误差
  });
});

describe('Gardens：实例化、长出来、缩回去', () => {
  it('布置以后有零件；删掉（带动画）缩完就拿走', () => {
    const g = new Gardens();
    g.setGround(ground());
    g.layout(work('w-1'), [], 1, { sprout: true });
    g.update(0.016);
    expect(g.stats().items).toBeGreaterThan(20);
    expect(g.has('w-1')).toBe(true);
    g.remove('w-1', true);
    for (let i = 0; i < 30; i++) g.update(0.05);
    expect(g.has('w-1')).toBe(false);
    expect(g.stats().items).toBe(0);
  });

  it('两座花园各自的零件都在，清空后一个不剩', () => {
    const g = new Gardens();
    g.setGround(ground());
    g.layout(work('w-1'), [], 1, {});
    g.update(0.016);
    const one = g.stats().items;
    g.layout(work('w-2', east(12)), [work('w-1')], 1, {});
    g.update(0.016);
    expect(g.stats().items).toBeGreaterThan(one);
    g.clear();
    g.update(0.016);
    expect(g.stats().items).toBe(0);
  });
});

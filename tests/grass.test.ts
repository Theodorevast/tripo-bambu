import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { equirectUV, vec3 } from 'three/tsl';
import { BAND_SIZES, BLADES_PER_TILE, GRID, SphereTiles, bandFor, buildNoiseVolume, createGrassField, densityAt, densityScaleFor, type GrassPlanet, type GrassWind } from '../src/nature/grass';
import { mulberry32 } from '../src/planet/rng';

// 只用到 getDrawingBufferSize：node 里没有 GPU，草的 CPU 部分（选瓦片、分档、算地面网格）照样能测
const renderer = { getDrawingBufferSize: (v: THREE.Vector2) => v.set(2880, 1800) } as unknown as THREE.WebGPURenderer;
const R = 30;

function flatPlanet(): GrassPlanet & { calls: number } {
  const p = { radius: R, center: new THREE.Vector3(), sea: null, calls: 0, height: (_d: THREE.Vector3) => R };
  p.height = () => {
    p.calls++;
    return R;
  };
  return p;
}

// 站在星球顶上 eye 米高，朝 heading（切向）看，略往下
function groundCamera(eye = 1.4, pitch = -0.2, dir = new THREE.Vector3(0, 1, 0), heading = new THREE.Vector3(0, 0, -1)): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 1440 / 900, 0.05, 2000);
  cam.position.copy(dir).multiplyScalar(R + eye);
  cam.up.copy(dir);
  const look = heading.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(dir, Math.sin(pitch));
  cam.lookAt(cam.position.clone().add(look));
  cam.updateMatrixWorld();
  return cam;
}

const randomDir = (rng: () => number) => {
  const z = rng() * 2 - 1;
  const a = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return new THREE.Vector3(Math.cos(a) * s, Math.sin(a) * s, z);
};

describe('SphereTiles（等角立方体球瓦片）', () => {
  const tiles = new SphereTiles(SphereTiles.sizeFor(R));

  it('半径 30 时每面 16×16 块，瓦片边长约 2.9 m', () => {
    expect(tiles.n).toBe(16);
    expect(tiles.count).toBe(6 * 16 * 16);
    expect(((R * Math.PI) / 2) / tiles.n).toBeCloseTo(2.95, 1);
  });

  it('瓦片中心和瓦片里任意一点都查回这块瓦片', () => {
    const rng = mulberry32(3);
    const v = new THREE.Vector3();
    for (let t = 0; t < tiles.count; t++) {
      expect(tiles.tileOf(tiles.center[t * 3], tiles.center[t * 3 + 1], tiles.center[t * 3 + 2])).toBe(t);
      for (let k = 0; k < 4; k++) {
        tiles.dirAt(t, 0.02 + rng() * 0.96, 0.02 + rng() * 0.96, v);
        expect(tiles.tileOf(v.x, v.y, v.z)).toBe(t);
      }
    }
  });

  it('任意方向都落在某块瓦片里，离瓦片中心不超过它的半对角线', () => {
    const rng = mulberry32(9);
    const c = new THREE.Vector3();
    for (let i = 0; i < 2000; i++) {
      const d = randomDir(rng);
      const t = tiles.tileOf(d.x, d.y, d.z);
      c.fromArray(tiles.center, t * 3);
      expect(c.angleTo(d)).toBeLessThanOrEqual(tiles.spread[t] + 1e-5);
    }
  });

  it('邻居互相认（跨面也一样），相邻瓦片中心很近', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let t = 0; t < tiles.count; t++) {
      for (let k = 0; k < 4; k++) {
        const nb = tiles.neighbors[t * 4 + k];
        expect(nb).not.toBe(t);
        expect([...tiles.neighbors.subarray(nb * 4, nb * 4 + 4)]).toContain(t);
        a.fromArray(tiles.center, t * 3);
        b.fromArray(tiles.center, nb * 3);
        expect(a.angleTo(b)).toBeLessThan(tiles.spread[t] + tiles.spread[nb]);
      }
    }
  });

  it('等角划分让瓦片面积差别不大（最小的也有最大的 70% 以上）', () => {
    let mn = Infinity;
    let mx = 0;
    for (const a of tiles.area) {
      mn = Math.min(mn, a);
      mx = Math.max(mx, a);
    }
    expect(mx).toBeCloseTo(1, 5);
    expect(mn).toBeGreaterThan(0.7);
  });
});

describe('密度曲线和分档', () => {
  it('满密度半径内是 1，往外单调变小，到最远半径是 0', () => {
    expect(densityAt(0, 5, 30)).toBe(1);
    expect(densityAt(5, 5, 30)).toBe(1);
    let last = 1;
    for (let d = 5; d <= 30; d += 0.5) {
      const v = densityAt(d, 5, 30);
      expect(v).toBeLessThanOrEqual(last + 1e-12);
      last = v;
    }
    expect(densityAt(30, 5, 30)).toBe(0);
    expect(densityAt(40, 5, 30)).toBe(0);
  });

  it('档位够用：选中的档每块画的根数不少于需要的根数', () => {
    for (const needed of [0.6, 10, 128, 129, 500, 512, 513, 2048, 2049, 5000, 8192]) {
      const b = bandFor(needed);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(BAND_SIZES[b]).toBeGreaterThanOrEqual(Math.min(needed, BLADES_PER_TILE));
      if (b < BAND_SIZES.length - 1) expect(BAND_SIZES[b + 1]).toBeLessThan(needed);
    }
    expect(bandFor(0)).toBe(-1);
    expect(bandFor(0.4)).toBe(-1);
  });
});

describe('createGrassField（CPU 部分）', () => {
  it('贴地看：选出视锥里的瓦片，每档一个绘制调用，实例数 = 块数 × 每块根数', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    g.update(groundCamera(), 0);
    const s = g.stats;
    expect(s.tiles).toBeGreaterThan(20);
    expect(s.drawCalls).toBeGreaterThanOrEqual(2);
    expect(s.drawCalls).toBeLessThanOrEqual(BAND_SIZES.length + 1);
    expect(s.instances).toBe(s.bands.reduce((sum, n, b) => sum + n * BAND_SIZES[b], 0));
    expect(s.bands[0]).toBeGreaterThan(0); // 脚下有满密度的瓦片
    expect(s.flowerInstances).toBeGreaterThan(0);
    g.dispose();
  });

  it('镜头离地面比草的最远半径还高：一根草都不画', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    const cam = new THREE.PerspectiveCamera(50, 1.6, 0.1, 2000);
    cam.position.set(0, R + 120, 0);
    cam.lookAt(0, 0, 0);
    g.update(cam, 0);
    expect(g.stats.instances).toBe(0);
    expect(g.stats.drawCalls).toBe(0);
    g.dispose();
  });

  it('看向天空：视锥剔除掉几乎所有瓦片，只剩脚下包围球碰到镜头的几块', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    g.update(groundCamera(1.4, -0.2), 0);
    const ground = g.stats.tiles;
    g.update(groundCamera(1.4, 1.45), 0.016);
    expect(g.stats.tiles).toBeLessThanOrEqual(4);
    expect(g.stats.tiles).toBeLessThan(ground / 10);
    g.dispose();
  });

  it('密度档位越低，画的实例越少', () => {
    const g = createGrassField({ renderer, planet: flatPlanet(), density: 1 });
    const cam = groundCamera();
    g.update(cam, 0);
    g.update(cam, 1); // 新瓦片淡入完
    const full = g.stats.instances;
    g.setDensity(0.25);
    g.update(cam, 1.1);
    expect(g.stats.instances).toBeLessThan(full);
    expect(g.stats.instances).toBeGreaterThan(0);
    g.dispose();
  });

  it('每块瓦片算一次 9×9 的地面网格：height 和 exclude 各调 81 次，以后不重复算', () => {
    const planet = flatPlanet();
    let excludeCalls = 0;
    const g = createGrassField({ renderer, planet, exclude: () => (excludeCalls++, 0) });
    const cam = groundCamera();
    g.update(cam, 0);
    const cached = g.stats.cachedTiles;
    expect(cached).toBeGreaterThan(0);
    expect(planet.calls).toBe(cached * GRID * GRID);
    expect(excludeCalls).toBe(cached * GRID * GRID);
    g.update(cam, 0.016);
    expect(g.stats.generated).toBe(0);
    expect(planet.calls).toBe(cached * GRID * GRID);
    g.refresh(); // exclude 变了：清掉重算
    g.update(cam, 0.032);
    expect(g.stats.generated).toBeGreaterThan(0);
    g.dispose();
  });

  it('草长在哪里只看瓦片（世界固定），和镜头在哪无关：同一块瓦片在不同镜头位置下写进列表的数据一样', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    const cam = groundCamera();
    g.update(cam, 0);
    g.update(cam, 1); // 淡入完
    const before = new Map(g.inspect().filter((e) => e.band >= 0).map((e) => [e.tile, e]));
    // 往前走 0.4 m、再转 20°：瓦片集合会变一点，但还在的瓦片数据（位置框架、瓦片编号）完全一样，草不会跳格
    cam.position.addScaledVector(new THREE.Vector3(0, 0, -1), 0.4);
    cam.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(20));
    cam.updateMatrixWorld();
    g.update(cam, 1.016);
    const after = g.inspect().filter((e) => e.band >= 0);
    let shared = 0;
    for (const e of after) {
      const b = before.get(e.tile);
      if (!b) continue;
      shared++;
      expect(e.frame).toEqual(b.frame);
      expect(e.slot).toBe(b.slot); // 地面网格缓存住了，没有重算
    }
    expect(shared).toBeGreaterThan(after.length * 0.5);
    // 每块瓦片只在一个档里出现
    expect(new Set(after.map((e) => e.tile)).size).toBe(after.length);
    g.dispose();
  });

  it('画进某一档的瓦片，这一档的根数够它最近处需要的密度（名次淡出的草不会被截掉）', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    const cam = groundCamera();
    g.update(cam, 0);
    g.update(cam, 1);
    const tiles = new SphereTiles(SphereTiles.sizeFor(R));
    const c = new THREE.Vector3();
    for (const e of g.inspect()) {
      if (e.band < 0) continue;
      c.fromArray(tiles.center, e.tile * 3).multiplyScalar(R);
      const dNear = Math.max(0, c.distanceTo(cam.position) - tiles.spread[e.tile] * R - 0.1);
      const needed = densityScaleFor(R) * densityAt(dNear, g.settings.fullRadius, g.settings.radius) * e.scale * BLADES_PER_TILE;
      expect(BAND_SIZES[e.band]).toBeGreaterThanOrEqual(Math.min(BLADES_PER_TILE, Math.floor(needed)));
    }
    g.dispose();
  });

  it('风可以从外面接进来（共用的风场）；不给就用模块自己的风', () => {
    const shared: GrassWind = (pos) => vec3(1, 0, 0).mul(pos.x.mul(0));
    const a = createGrassField({ renderer, planet: flatPlanet(), wind: shared });
    expect(a.windAt).toBe(shared);
    const b = createGrassField({ renderer, planet: flatPlanet() });
    expect(typeof b.windAt).toBe('function');
    expect(b.windAt).not.toBe(shared);
    a.dispose();
    b.dispose();
  });

  it('踩草贴图可以接进来；接了以后 CPU 部分照常工作', () => {
    const tex = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
    const g = createGrassField({ renderer, planet: flatPlanet(), trample: { texture: tex, uvOf: (dir) => equirectUV(dir) } });
    g.update(groundCamera(), 0);
    expect(g.stats.instances).toBeGreaterThan(0);
    g.dispose();
  });

  it('setSun 只改方向和颜色，不会因为没传颜色就把光弄没', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    expect(() => g.setSun(new THREE.Vector3(0, 1, 1))).not.toThrow();
    expect(() => g.setSun(new THREE.Vector3(1, 0.2, 0), '#ffd9a8', 2.4)).not.toThrow();
    g.dispose();
  });

  it('dispose 之后从父节点上摘掉', () => {
    const g = createGrassField({ renderer, planet: flatPlanet() });
    const scene = new THREE.Scene();
    scene.add(g.object);
    g.dispose();
    expect(g.object.parent).toBeNull();
  });
});

describe('噪声体积贴图', () => {
  it('相邻纹素变化平缓（远处地面色斑不会一块一块）', () => {
    const t = buildNoiseVolume();
    const d = t.image.data as Uint8Array;
    const S = 32;
    let maxStep = 0;
    for (let ch = 0; ch < 4; ch++)
      for (let z = 0; z < S; z++)
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            const a = d[((z * S + y) * S + x) * 4 + ch];
            const b = d[((z * S + y) * S + ((x + 1) % S)) * 4 + ch];
            maxStep = Math.max(maxStep, Math.abs(a - b));
          }
    expect(maxStep).toBeLessThan(60);
    expect(t.wrapR).toBe(THREE.RepeatWrapping);
    expect(t.minFilter).toBe(THREE.LinearFilter);
  });
});

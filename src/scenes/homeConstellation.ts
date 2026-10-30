import * as THREE from 'three/webgpu';
import { PLANET_RADIUS } from '../planet/presets';
import { FineLines } from './fineLines';
import { HOME_SPIRAL } from './homeLayout';
import type { PlanetEntry, World } from './world';

// 第二版 [v2-world]：首页的「星座线」——同一条螺旋臂上相邻的两颗星球之间连一条很淡的细金线，线的两头各一颗小星，
// 整个星系像一张星图。你的星球连到每条臂上的第一颗。指着一颗星球（或它的名牌）时，连着它的那几条线亮一点。
// 线从星球的轮廓外面一点开始（不压在星球上），星球挡得住从它背后经过的线（深度测试）。一份 FineLines：一次绘制。
// 哪颗在哪条臂上：和 homeLayout 的排法一样——建好的按数据里的顺序轮流放到各条臂上，建设中的接着往外排（i % 臂数）。
// 不改版式的计算，只读每颗星球的槽位（world.slotOf）。
//
// 原地更新（main 06:28：造星 Launch 以后重新排位时这里跑过一次 60 ms）：
// - 线、小星的缓冲按最多 MAX_LINKS 条预先分配好（FineLines 按「一条线 + 两颗星」一组连着放），换版式只改顶点、改绘制范围（只画前 n 组），
//   不新建数组、几何
// - 每条线的两头、透明度存在预先分配的类型数组里；版式的指纹是一个数（不拼字符串）
// - 每帧的热路径（悬停时线变亮）只改透明度、只传透明度那一份缓冲；不分配内存（tests/homeConstellation.test.ts 量过）

export const CONSTELLATION = {
  on: 1, // 0 = 不要
  alpha: 0.32, // 平时线有多淡
  hover: 0.85, // 指着的那颗星球连出去的线
  building: 0.6, // 连到建设中的星球的线再乘这个（外圈更淡）
  width: 1, // 线宽（像素）
  margin: 1.32, // 线从离星球中心多远开始（× 星球在首页上的半径）
  stars: 1, // 线两头的小星（大小倍数，0 = 没有）
  fromYou: 1, // 你的星球连到每条臂上的第一颗
};

const GOLD = new THREE.Color('#d8c08e').multiplyScalar(1.1);
const STAR = new THREE.Color('#f6f1e7').multiplyScalar(1.5);
export const MAX_LINKS = 48;
const MAX_PLANETS = 96; // 星球最多几颗（超过的不连线）
const MAX_ARMS = 8;
const TIER_YOU = 1;
const TIER_BUILT = 2;
const TIER_BUILDING = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();

export class HomeConstellation {
  readonly lines = new FineLines(MAX_LINKS, MAX_LINKS * 2, { additive: true, twinkle: 0.35, twinkleSpeed: 0.9, name: 'home-constellation', group: { segments: 1, stars: 2 } });
  // 这一版的星球（按 world.planets 的顺序）、每颗的档位：预先分配，换版式时原地改
  private readonly entries: Array<PlanetEntry | null> = new Array<PlanetEntry | null>(MAX_PLANETS).fill(null);
  private readonly tiers = new Uint8Array(MAX_PLANETS);
  private planetCount = 0;
  // 连线：两头是第几颗星球、平时的透明度倍数、现在的透明度
  private readonly linkA = new Int16Array(MAX_LINKS);
  private readonly linkB = new Int16Array(MAX_LINKS);
  private readonly linkK = new Float32Array(MAX_LINKS);
  private readonly linkNow = new Float32Array(MAX_LINKS);
  private linkCount = 0;
  // 上一版的连线（两头的星球对象、透明度）：重新连的时候同一对星球的线接着用原来的透明度，不闪
  private readonly prevA: Array<PlanetEntry | null> = new Array<PlanetEntry | null>(MAX_LINKS).fill(null);
  private readonly prevB: Array<PlanetEntry | null> = new Array<PlanetEntry | null>(MAX_LINKS).fill(null);
  private readonly prevNow = new Float32Array(MAX_LINKS);
  private prevCount = 0;
  // 每条臂上的星球（下标）：MAX_ARMS 条 × MAX_PLANETS
  private readonly armSeq = new Int16Array(MAX_ARMS * MAX_PLANETS);
  private readonly armLen = new Int16Array(MAX_ARMS);
  private topoSig = NaN; // 连法的指纹：星球数、档位、参数
  private posSig = NaN; // 位置、大小的指纹
  private fade = 0;
  private recheck = 0;
  private relinks = 0; // 自查：重新连了几次
  // 遍历 world.planets 时用的（Map.forEach + 事先绑好的函数：不分配迭代器、闭包）
  private visitWorld: World | null = null;
  private visitIndex = 0;
  private visitTopo = 0;
  private visitPos = 0;
  private topoDirty = false;
  private readonly visit = (e: PlanetEntry): void => {
    const i = this.visitIndex++;
    if (i >= MAX_PLANETS) return;
    const s = this.visitWorld!.slotOf(e);
    const tier = s?.tier === 'you' ? TIER_YOU : s?.tier === 'built' ? TIER_BUILT : s?.tier === 'building' ? TIER_BUILDING : 0;
    if (this.entries[i] !== e) {
      this.entries[i] = e;
      this.topoDirty = true;
    }
    this.tiers[i] = tier;
    this.visitTopo = (this.visitTopo * 31 + tier * 7 + i) % 1000003;
    const h = e.home;
    this.visitPos += (i + 1) * (h.x * 0.731 + h.y * 1.37 + h.z * 2.11) + (s?.scale ?? 0) * (97 + i);
  };

  constructor() {
    this.lines.mesh.renderOrder = -4;
    this.lines.setDrawGroups(0);
    this.lines.commit();
    this.lines.fade.value = 0;
  }

  // 按档位重新连：哪几对（只在星球数、档位、参数变了的时候）。都写进预先分配的数组，不新建对象
  private relink(): void {
    this.relinks++;
    // 记下上一版：同一对星球接着用原来的透明度
    for (let i = 0; i < this.linkCount; i++) {
      this.prevA[i] = this.entries[this.linkA[i]] ?? null;
      this.prevB[i] = this.entries[this.linkB[i]] ?? null;
      this.prevNow[i] = this.linkNow[i];
    }
    this.prevCount = this.linkCount;
    const arms = Math.min(MAX_ARMS, Math.max(1, Math.round(HOME_SPIRAL.arms)));
    this.armLen.fill(0);
    let you = -1;
    let built = 0;
    let building = 0;
    const n = Math.min(this.planetCount, MAX_PLANETS);
    // 建好的先轮流放，建设中的接着往外（和 homeLayout 一样：各自从第 0 条臂开始轮）
    for (let i = 0; i < n; i++) {
      const t = this.tiers[i];
      if (t === TIER_YOU) you = i;
      else if (t === TIER_BUILT) this.pushArm(built++ % arms, i);
    }
    for (let i = 0; i < n; i++) if (this.tiers[i] === TIER_BUILDING) this.pushArm(building++ % arms, i);
    this.linkCount = 0;
    for (let arm = 0; arm < arms; arm++) {
      const len = this.armLen[arm];
      const base = arm * MAX_PLANETS;
      if (you >= 0 && len > 0 && CONSTELLATION.fromYou > 0) this.pushLink(you, this.armSeq[base]);
      for (let j = 1; j < len; j++) this.pushLink(this.armSeq[base + j - 1], this.armSeq[base + j]);
    }
  }

  private pushArm(arm: number, i: number): void {
    const len = this.armLen[arm];
    if (len >= MAX_PLANETS) return;
    this.armSeq[arm * MAX_PLANETS + len] = i;
    this.armLen[arm] = len + 1;
  }

  private pushLink(a: number, b: number): void {
    const i = this.linkCount;
    if (i >= MAX_LINKS) return;
    this.linkA[i] = a;
    this.linkB[i] = b;
    this.linkK[i] = this.tiers[a] === TIER_BUILDING || this.tiers[b] === TIER_BUILDING ? CONSTELLATION.building : 1;
    const ea = this.entries[a];
    const eb = this.entries[b];
    let now = 0;
    for (let j = 0; j < this.prevCount; j++) {
      if (this.prevA[j] === ea && this.prevB[j] === eb) {
        now = this.prevNow[j];
        break;
      }
    }
    this.linkNow[i] = now;
    this.linkCount = i + 1;
  }

  // 两头的位置：从星球中心朝对方挪出 margin 个（首页上的）半径；只写前 linkCount 组，绘制范围也只画这么多
  private place(world: World): void {
    const L = this.lines;
    const size = 2.6 * CONSTELLATION.stars;
    for (let i = 0; i < this.linkCount; i++) {
      const ea = this.entries[this.linkA[i]];
      const eb = this.entries[this.linkB[i]];
      if (!ea || !eb) continue;
      const ra = PLANET_RADIUS * (world.slotOf(ea)?.scale ?? 1) * CONSTELLATION.margin;
      const rb = PLANET_RADIUS * (world.slotOf(eb)?.scale ?? 1) * CONSTELLATION.margin;
      _d.subVectors(eb.home, ea.home);
      const len = _d.length();
      if (len < (ra + rb) * 1.15) {
        // 挨得太近：线短得不成样子，不画（透明度 0）
        L.setSegmentRaw(i, ea.home, eb.home, CONSTELLATION.width, GOLD, 0);
        L.setStarRaw(i * 2, ea.home, 0, STAR, 0, 0);
        L.setStarRaw(i * 2 + 1, eb.home, 0, STAR, 0, 0);
        continue;
      }
      _d.divideScalar(len);
      _a.copy(ea.home).addScaledVector(_d, ra);
      _b.copy(eb.home).addScaledVector(_d, -rb);
      const now = this.linkNow[i];
      L.setSegmentRaw(i, _a, _b, CONSTELLATION.width, GOLD, now);
      L.setStarRaw(i * 2, _a, size, STAR, Math.min(1, now * 1.6), i * 1.7);
      L.setStarRaw(i * 2 + 1, _b, size, STAR, Math.min(1, now * 1.6), i * 2.9 + 1);
    }
    L.setDrawGroups(this.linkCount);
    L.commit(true);
  }

  // 只改透明度（悬停变亮的那几帧）：挨得太近的那几条本来就是 0，不动
  private paintAlpha(world: World): void {
    const L = this.lines;
    for (let i = 0; i < this.linkCount; i++) {
      const ea = this.entries[this.linkA[i]];
      const eb = this.entries[this.linkB[i]];
      if (!ea || !eb) continue;
      const ra = PLANET_RADIUS * (world.slotOf(ea)?.scale ?? 1) * CONSTELLATION.margin;
      const rb = PLANET_RADIUS * (world.slotOf(eb)?.scale ?? 1) * CONSTELLATION.margin;
      if (ea.home.distanceTo(eb.home) < (ra + rb) * 1.15) continue;
      const now = this.linkNow[i];
      L.setAlpha(i, now);
      L.setAlpha(i * 2, Math.min(1, now * 1.6), true);
      L.setAlpha(i * 2 + 1, Math.min(1, now * 1.6), true);
    }
    L.commit(false);
  }

  // 每帧：首页淡入；版式变了重连 / 重摆；悬停的那颗连出去的线变亮（透明度逐帧逼近）
  // dim：整体再乘的亮度（开场拼标志的时候压下去，让标志单独出来）
  update(dt: number, world: World, home: boolean, dim = 1): void {
    const on = home && CONSTELLATION.on > 0;
    this.fade += ((on ? 1 : 0) - this.fade) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.fade - (on ? 1 : 0)) < 0.002) this.fade = on ? 1 : 0;
    this.lines.fade.value = this.fade * dim;
    this.lines.mesh.visible = this.fade > 0.001;
    if (!this.lines.mesh.visible) return;
    // 版式（星球、档位、位置、大小）：每 0.2 秒对一次指纹。连法变了重连，只是位置变了（换版式时星球慢慢挪过去）就只重摆
    this.recheck -= dt;
    let moved = false;
    if (this.recheck <= 0) {
      this.recheck = 0.2;
      this.visitWorld = world;
      this.visitIndex = 0;
      this.visitTopo = 0;
      this.visitPos = 0;
      this.topoDirty = false;
      world.planets.forEach(this.visit);
      this.visitWorld = null;
      const count = Math.min(this.visitIndex, MAX_PLANETS);
      for (let i = count; i < this.planetCount; i++) this.entries[i] = null; // 少了星球：后面的清掉（不留旧对象）
      if (count !== this.planetCount) this.topoDirty = true;
      this.planetCount = count;
      const topo = this.visitTopo * 7 + count + CONSTELLATION.fromYou * 3 + CONSTELLATION.building * 11 + Math.round(HOME_SPIRAL.arms) * 13;
      const pos = this.visitPos + CONSTELLATION.margin * 101 + CONSTELLATION.width * 103 + CONSTELLATION.stars * 107;
      if (this.topoDirty || topo !== this.topoSig) {
        this.topoSig = topo;
        this.relink();
        moved = true;
      }
      if (moved || pos !== this.posSig) {
        this.posSig = pos;
        moved = true;
      }
    }
    const hovered = world.hovered;
    const k = 1 - Math.exp(-6 * dt);
    let changed = false;
    for (let i = 0; i < this.linkCount; i++) {
      const ea = this.entries[this.linkA[i]];
      const eb = this.entries[this.linkB[i]];
      // linkNow 是 Float32Array：目标值先按单精度取整再比（不然存进去再读出来永远差一点点，每帧都当成「变了」）
      const goal = Math.fround((hovered !== null && (ea === hovered || eb === hovered) ? CONSTELLATION.hover : CONSTELLATION.alpha) * this.linkK[i]);
      const now = this.linkNow[i];
      if (Math.abs(goal - now) > 0.002) {
        this.linkNow[i] = now + (goal - now) * k;
        changed = true;
      } else if (now !== goal) {
        this.linkNow[i] = goal;
        changed = true;
      }
    }
    if (moved) this.place(world);
    else if (changed) this.paintAlpha(world);
  }

  // ?tune 改了参数：下一帧重连、重摆
  refresh(): void {
    this.topoSig = NaN;
    this.posSig = NaN;
    this.recheck = 0;
  }

  // 自查脚本、单元测试：现在连了几条、指着的那颗连出去几条、重新连了几次
  get state(): { links: number; lit: number; relinks: number } {
    let lit = 0;
    for (let i = 0; i < this.linkCount; i++) if (this.linkNow[i] > ((CONSTELLATION.alpha + CONSTELLATION.hover) / 2) * this.linkK[i]) lit++;
    return { links: this.linkCount, lit, relinks: this.relinks };
  }
}

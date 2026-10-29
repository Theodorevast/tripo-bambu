import * as THREE from 'three/webgpu';
import { PLANET_RADIUS } from '../planet/presets';
import { FineLines } from './fineLines';
import { HOME_SPIRAL } from './homeLayout';
import type { PlanetEntry, World } from './world';

// 第二版 [v2-world]：首页的「星座线」——同一条螺旋臂上相邻的两颗星球之间连一条很淡的细金线，线的两头各一颗小星，
// 整个星系像一张星图。你的星球连到每条臂上的第一颗。指着一颗星球（或它的名牌）时，连着它的那几条线亮一点。
// 线从星球的轮廓外面一点开始（不压在星球上），星球挡得住从它背后经过的线（深度测试）。一份 FineLines：一次绘制。
// 哪颗在哪条臂上：和 homeLayout 的排法一样——建好的按数据里的顺序轮流放到各条臂上，建设中的接着往外排（i % 臂数）。
// 不改版式的计算，只读每颗星球的槽位（world.slotOf）

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
const MAX_LINKS = 48;

interface Link {
  a: PlanetEntry;
  b: PlanetEntry;
  k: number; // 平时的透明度倍数（连到建设中的更淡）
  now: number; // 现在的透明度（逐帧逼近目标）
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();

export class HomeConstellation {
  readonly lines = new FineLines(MAX_LINKS, MAX_LINKS * 2, { additive: true, twinkle: 0.35, twinkleSpeed: 0.9, name: 'home-constellation' });
  private links: Link[] = [];
  private key = '';
  private fade = 0;
  private recheck = 0;

  constructor() {
    this.lines.mesh.renderOrder = -4;
    this.lines.hideFrom(0, 0);
    this.lines.commit();
    this.lines.fade.value = 0;
  }

  // 按槽位重新连：哪几对、两头在哪。版式变了（加了星球、换了宽屏 / 竖屏、拖了半径）才重连
  private relink(world: World): void {
    const entries = [...world.planets.values()];
    const arms = Math.max(1, Math.round(HOME_SPIRAL.arms));
    const you = entries.find((e) => world.slotOf(e)?.tier === 'you') ?? null;
    const built = entries.filter((e) => world.slotOf(e)?.tier === 'built');
    const building = entries.filter((e) => world.slotOf(e)?.tier === 'building');
    const perArm: PlanetEntry[][] = Array.from({ length: arms }, () => []);
    built.forEach((e, i) => perArm[i % arms].push(e));
    building.forEach((e, i) => perArm[i % arms].push(e));
    const old = new Map(this.links.map((l) => [`${l.a.team.id}|${l.b.team.id}`, l.now]));
    const links: Link[] = [];
    const push = (a: PlanetEntry, b: PlanetEntry) => {
      if (links.length >= MAX_LINKS) return;
      const k = world.slotOf(a)?.tier === 'building' || world.slotOf(b)?.tier === 'building' ? CONSTELLATION.building : 1;
      links.push({ a, b, k, now: old.get(`${a.team.id}|${b.team.id}`) ?? 0 });
    };
    for (const arm of perArm) {
      if (you && arm.length && CONSTELLATION.fromYou > 0) push(you, arm[0]);
      for (let i = 1; i < arm.length; i++) push(arm[i - 1], arm[i]);
    }
    this.links = links;
  }

  // 两头的位置：从星球中心朝对方挪出 margin 个（首页上的）半径
  private place(world: World): void {
    const L = this.lines;
    let seg = 0;
    let star = 0;
    for (const l of this.links) {
      const ra = PLANET_RADIUS * (world.slotOf(l.a)?.scale ?? 1) * CONSTELLATION.margin;
      const rb = PLANET_RADIUS * (world.slotOf(l.b)?.scale ?? 1) * CONSTELLATION.margin;
      _d.subVectors(l.b.home, l.a.home);
      const len = _d.length();
      if (len < (ra + rb) * 1.15) {
        // 挨得太近：线短得不成样子，不画（透明度 0）
        L.setSegment(seg++, { a: l.a.home, b: l.b.home, width: CONSTELLATION.width, color: GOLD, alpha: 0 });
        L.setStar(star++, { at: l.a.home, size: 0, color: STAR, alpha: 0, phase: 0 });
        L.setStar(star++, { at: l.b.home, size: 0, color: STAR, alpha: 0, phase: 0 });
        continue;
      }
      _d.divideScalar(len);
      _a.copy(l.a.home).addScaledVector(_d, ra);
      _b.copy(l.b.home).addScaledVector(_d, -rb);
      L.setSegment(seg++, { a: _a, b: _b, width: CONSTELLATION.width, color: GOLD, alpha: l.now });
      const size = 2.6 * CONSTELLATION.stars;
      L.setStar(star++, { at: _a, size, color: STAR, alpha: Math.min(1, l.now * 1.6), phase: seg * 1.7 });
      L.setStar(star++, { at: _b, size, color: STAR, alpha: Math.min(1, l.now * 1.6), phase: seg * 2.9 + 1 });
    }
    L.hideFrom(seg, star);
    L.commit();
  }

  // 每帧：首页淡入；版式变了重连；悬停的那颗连出去的线变亮（透明度逐帧逼近）
  update(dt: number, world: World, home: boolean): void {
    const on = home && CONSTELLATION.on > 0;
    this.fade += ((on ? 1 : 0) - this.fade) * (1 - Math.exp(-5 * dt));
    if (Math.abs(this.fade - (on ? 1 : 0)) < 0.002) this.fade = on ? 1 : 0;
    this.lines.fade.value = this.fade;
    this.lines.mesh.visible = this.fade > 0.001;
    if (!this.lines.mesh.visible) return;
    // 版式（位置、大小）：每 0.2 秒对一次，变了就重连（换版式时星球慢慢挪过去，线跟着走）
    this.recheck -= dt;
    let moved = false;
    if (this.recheck <= 0) {
      this.recheck = 0.2;
      let key = `${CONSTELLATION.fromYou}|${CONSTELLATION.building}|${HOME_SPIRAL.arms}`;
      for (const e of world.planets.values()) {
        const s = world.slotOf(e);
        key += `|${e.team.id}:${s?.tier}:${e.home.x.toFixed(1)},${e.home.y.toFixed(1)},${e.home.z.toFixed(1)}:${(s?.scale ?? 0).toFixed(2)}`;
      }
      if (key !== this.key) {
        this.key = key;
        this.relink(world);
        moved = true;
      }
    }
    const hovered = world.hovered;
    const k = 1 - Math.exp(-6 * dt);
    let changed = moved;
    for (const l of this.links) {
      const goal = (hovered && (l.a === hovered || l.b === hovered) ? CONSTELLATION.hover : CONSTELLATION.alpha) * l.k;
      if (Math.abs(goal - l.now) > 0.002) {
        l.now += (goal - l.now) * k;
        changed = true;
      } else if (l.now !== goal) {
        l.now = goal;
        changed = true;
      }
    }
    if (changed) this.place(world);
  }

  // ?tune 改了参数：下一帧重连、重摆
  refresh(): void {
    this.key = '';
    this.recheck = 0;
  }

  // 自查脚本：现在连了几条、指着的那颗连出去几条
  get state(): { links: number; lit: number } {
    const lit = this.links.filter((l) => l.now > (CONSTELLATION.alpha + CONSTELLATION.hover) / 2 * l.k).length;
    return { links: this.links.length, lit };
  }
}

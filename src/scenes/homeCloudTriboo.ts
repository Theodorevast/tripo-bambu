import * as THREE from 'three/webgpu';
import { FineLines } from './fineLines';
import type { PlanetEntry, World } from './world';

// 首页的「星座翠宝」（第二版 [v2-world]，代替第一版的「云朵翠宝」）：用星点和细金线在夜空里勾出翠宝——
// 圆圆的身子（一圈 11 颗星连成的圆）、胸口的 V（三颗亮一点的金星）、两只举起来打招呼的手、底下一对脚。
// - 一份 FineLines（细线 + 小星）：一次绘制。挂在一个组里，组的朝向、大小、位置每次出现时按镜头定（平面正对镜头），几何不变
// - 出现时一颗一颗星亮起来，再一笔一笔连上线；挂一会儿（星星慢慢闪），线先淡掉、星再淡掉，换个地方再出现
// - 放在星系外沿空的地方：投到屏幕上不压星球、名牌、标题卡片、徽章、右下角的翠宝（每次出现前在屏幕上挑）
// 只在首页显示（进星球时淡出）；减弱动态效果时不飘、不换地方，一直挂在一个地方。
// 名字、接口沿用第一版（CLOUD_TRIBOO、cloudTriboo()、screenRect()、opacity）：云里探头的翠宝（fun/cloudPeek.ts）靠后两个躲开它

export const CLOUD_TRIBOO = {
  on: 1, // 0 = 不要
  size: 1.25, // 大小（× 默认：身子半径约占画面高度的 7%）
  cycle: 40, // 多少秒淡掉、换个地方再出现（秒）
  gather: 3.2, // 亮起来要多久（一颗颗星 + 一笔笔线）
  scatter: 2.6, // 淡掉要多久
  drift: 0.25, // 一个周期里慢慢飘多远（× 身子半径）
  opacity: 0.9, // 线和星的亮度
  gold: 1, // 胸口 V 的亮度（0 = 和别的星一样）
  afterIntro: 2.6, // 开场星尘放完以后等多久才第一次出现（秒：让右边的翠宝先打完招呼）
};

// —— 形状（翠宝的平面坐标，身子半径 = 1，y 朝上）——
interface FigStar {
  x: number;
  y: number;
  size: number; // 像素
  gold: boolean; // 胸口 V 的星：偏暖的金
  order: number; // 亮起来的先后 0..1
}

interface FigLine {
  a: number;
  b: number;
  order: number;
  gold: boolean;
}

function figure(): { stars: FigStar[]; lines: FigLine[] } {
  const stars: FigStar[] = [];
  const lines: FigLine[] = [];
  const add = (x: number, y: number, size: number, gold = false) => {
    stars.push({ x, y, size, gold, order: 0 });
    return stars.length - 1;
  };
  // 身子：11 颗星围成的圆（从顶上开始顺时针），半径按一个固定的表抖一点（星座不是圆规画的）
  const N = 11;
  const wob = [1.0, 0.97, 1.03, 0.98, 1.02, 0.99, 1.03, 0.97, 1.01, 1.03, 0.98];
  const ring: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = Math.PI / 2 - (k / N) * Math.PI * 2;
    ring.push(add(Math.cos(a) * wob[k], Math.sin(a) * wob[k], k % 3 === 0 ? 4.6 : 3.6));
  }
  for (let k = 0; k < N; k++) lines.push({ a: ring[k], b: ring[(k + 1) % N], order: 0, gold: false });
  // 离某个角度最近的那颗身子上的星（手、脚从那里接出去）
  const nearest = (deg: number) => {
    const a = THREE.MathUtils.degToRad(deg);
    let best = ring[0];
    let bd = Infinity;
    for (const i of ring) {
      const d = Math.hypot(stars[i].x - Math.cos(a), stars[i].y - Math.sin(a));
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  // 两只手：从身子两边伸出去、往上举（打招呼）
  for (const s of [1, -1]) {
    const from = nearest(s > 0 ? 5 : 175);
    const elbow = add(s * 1.36, 0.16, 3.4);
    const hand = add(s * 1.56, 0.56, 4.8);
    lines.push({ a: from, b: elbow, order: 0, gold: false }, { a: elbow, b: hand, order: 0, gold: false });
  }
  // 一对脚：从身子底下往下，再往外一小截（鞋）
  for (const s of [1, -1]) {
    const from = nearest(s > 0 ? -68 : -112);
    const ankle = add(s * 0.44, -1.22, 3.4);
    const toe = add(s * 0.74, -1.27, 4.2);
    lines.push({ a: from, b: ankle, order: 0, gold: false }, { a: ankle, b: toe, order: 0, gold: false });
  }
  // 胸口的 V（翠宝标志上的 V：和 ui/badge.ts 同一套坐标，y 翻过来，缩小一点）
  const v = [[-0.5, 0.3], [-0.03, -0.4], [0.44, 0.1]].map(([x, y]) => add(x * 0.6, y * 0.6 - 0.02, 5.2, true));
  lines.push({ a: v[0], b: v[1], order: 0, gold: true }, { a: v[1], b: v[2], order: 0, gold: true });
  // 先后：星按「身子顺时针 → 手 → 脚 → V」；线跟在两头的星后面
  stars.forEach((s, i) => { s.order = i / Math.max(1, stars.length - 1); });
  for (const l of lines) l.order = Math.max(stars[l.a].order, stars[l.b].order);
  return { stars, lines };
}

const LINE = new THREE.Color('#d8c08e').multiplyScalar(1.2); // Champagne gold
const LINE_V = new THREE.Color('#ead2a0').multiplyScalar(1.5);
const STAR = new THREE.Color('#f6f1e7').multiplyScalar(1.7); // Starlight
const STAR_V = new THREE.Color('#f2d9a2').multiplyScalar(2.1);

// 图形在自己平面里的范围（身子半径 = 1）：screenRect、留空都按它
const BOX = { left: -1.62, right: 1.62, bottom: -1.34, top: 1.08 };

type Phase = 'hidden' | 'gather' | 'show' | 'scatter';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = { x: 0, y: 0, r: 0 };
const smooth = (e0: number, e1: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export class CloudTriboo {
  readonly group = new THREE.Group(); // 第一版叫 sprite：现在是挂着星座的组
  private readonly world: World;
  private readonly lines: FineLines;
  private readonly fig = figure();
  private readonly center = new THREE.Vector3();
  private readonly right = new THREE.Vector3(1, 0, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private scale = 40;
  private progress = 0; // 0 全暗 … 1 全亮（亮起来时一颗颗星、一笔笔线按先后跟着它）
  private shown = -1; // 上一次按哪个进度、亮度写的透明度（没变不重写）
  private phase: Phase = 'hidden';
  private t = 0;
  private wait = 1.5; // 第一次出现之前等多久（开场的星尘、翠宝探头之后）
  private last: THREE.Vector3 | null = null; // 上一次在哪（换个地方）
  private readonly drift = new THREE.Vector3();
  private readonly base = new THREE.Vector3();
  private fade = 0;
  private recheck = 0; // 每隔一会儿看一下现在这个地方还空不空（镜头重新取景、版式变了以后可能压到星球）
  private warmed = false; // 开场预热完以前一直显示着（compileAsync 跳过不显示的），透明度是 0

  constructor(world: World) {
    this.world = world;
    void world.warm.then(() => { this.warmed = true; });
    const { stars, lines } = this.fig;
    this.lines = new FineLines(lines.length, stars.length, { additive: true, twinkle: 0.45, twinkleSpeed: 1.4, name: 'home-constellation-triboo' });
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    lines.forEach((l, i) => {
      a.set(stars[l.a].x, stars[l.a].y, 0);
      b.set(stars[l.b].x, stars[l.b].y, 0);
      this.lines.setSegment(i, { a, b, width: 1, color: l.gold ? LINE_V : LINE, alpha: 0 });
    });
    stars.forEach((s, i) => this.lines.setStar(i, { at: a.set(s.x, s.y, 0), size: s.size, color: s.gold ? STAR_V : STAR, alpha: 0, phase: i * 2.399 }));
    this.lines.commit();
    this.lines.fade.value = 0;
    this.lines.mesh.renderOrder = -4; // 云海（-10）、星尘（-6）之后
    this.group.name = 'home-constellation-triboo';
    this.group.add(this.lines.mesh);
  }

  // ?tune → Cloud Triboo → Replay：马上淡掉，换个地方再出现
  replay(): void {
    if (this.phase === 'show' || this.phase === 'gather') {
      this.phase = 'scatter';
      this.t = 0;
    } else {
      this.wait = 0;
    }
  }

  // 每颗星、每笔线的透明度按进度写（亮起来：星在前、线跟着；淡掉：反过来，线先没）
  private paint(): void {
    const p = this.progress;
    const key = Math.round(p * 2000) + Math.round(CLOUD_TRIBOO.opacity * 100) * 4096 + Math.round(CLOUD_TRIBOO.gold * 100) * 4096 * 128;
    if (key === this.shown) return;
    this.shown = key;
    const o = CLOUD_TRIBOO.opacity;
    const { stars, lines } = this.fig;
    stars.forEach((s, i) => {
      const k = smooth(s.order * 0.55, s.order * 0.55 + 0.18, p);
      this.lines.setAlpha(i, k * o * (s.gold ? Math.min(1.4, 0.7 + 0.5 * CLOUD_TRIBOO.gold) : 0.95), true);
    });
    lines.forEach((l, i) => {
      const k = smooth(0.3 + l.order * 0.55, 0.42 + l.order * 0.55, p);
      this.lines.setAlpha(i, k * o * (l.gold ? Math.min(1.2, 0.55 + 0.45 * CLOUD_TRIBOO.gold) : 0.55));
    });
    this.lines.commit(false);
  }

  // 组的摆法：平面和画面平行（朝向 = 镜头的朝向：画面上永远是正的，不会因为透视歪过去；镜头绕着星系转时也一直正对着看），
  // 大小 = 身子半径。每帧跟着镜头转（位置不动）
  private pose(): void {
    const cam = this.world.rig.camera;
    cam.updateMatrixWorld();
    cam.matrixWorld.extractBasis(this.right, this.up, this.fwd);
    this.right.normalize();
    this.up.normalize();
    this.fwd.normalize();
    this.group.quaternion.setFromRotationMatrix(cam.matrixWorld);
    this.group.position.copy(this.center);
    this.group.scale.setScalar(this.scale);
  }

  // 每帧（World.frameHooks）
  update(dt: number): void {
    const world = this.world;
    if (!this.warmed) return;
    const home = !world.focused && !world.director.busy && CLOUD_TRIBOO.on > 0;
    this.fade += ((home ? 1 : 0) - this.fade) * (1 - Math.exp(-4 * dt));
    this.lines.fade.value = this.fade;
    this.group.visible = this.fade > 0.003 && this.phase !== 'hidden';
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 只在首页、镜头不在飞的时候换地方（换地方要按镜头现在的方向挑）；开场的星尘拼标志在放的时候也不出现（一个一个来）
    const calm = home && !world.rig.flying && !world.rig.drive && world.galaxy.shapeState.t < 0;
    this.t += dt;
    if (this.group.visible) this.pose();
    switch (this.phase) {
      case 'hidden':
        if (world.galaxy.shapeState.t >= 0) this.wait = Math.max(this.wait, CLOUD_TRIBOO.afterIntro);
        this.wait -= dt;
        if (this.wait <= 0 && calm && this.place()) {
          this.phase = 'gather';
          this.t = 0;
        }
        this.progress = 0;
        break;
      case 'gather': {
        const k = reduce ? 1 : Math.min(1, this.t / CLOUD_TRIBOO.gather);
        this.progress = k;
        if (k >= 1) {
          this.phase = 'show';
          this.t = 0;
        }
        break;
      }
      case 'show': {
        this.progress = 1;
        // 镜头重新取景（标题卡片量好了、窗口变了）、版式变了以后这里可能压到星球：提前淡掉，换个空的地方
        this.recheck -= dt;
        if (this.recheck <= 0 && calm) {
          this.recheck = 0.5;
          const card = document.querySelector('#app .tb-title')?.getBoundingClientRect() ?? null;
          if (this.clearance(this.center, this.scale, [...world.planets.values()], card) < -6) {
            this.phase = 'scatter';
            this.t = 0;
            break;
          }
        }
        // 慢慢飘：沿镜头的左右方向来回一点
        if (!reduce) {
          const k = Math.min(1, this.t / Math.max(1, CLOUD_TRIBOO.cycle));
          this.center.copy(this.base).addScaledVector(this.drift, Math.sin(k * Math.PI) * CLOUD_TRIBOO.drift);
          this.group.position.copy(this.center);
        }
        const show = CLOUD_TRIBOO.cycle - CLOUD_TRIBOO.gather - CLOUD_TRIBOO.scatter;
        if (!reduce && this.t >= Math.max(4, show) && calm) {
          this.phase = 'scatter';
          this.t = 0;
        }
        break;
      }
      case 'scatter': {
        const k = Math.min(1, this.t / CLOUD_TRIBOO.scatter);
        this.progress = 1 - k;
        if (k >= 1) {
          this.phase = 'hidden';
          this.t = 0;
          this.wait = 0.6;
        }
        break;
      }
    }
    this.paint();
  }

  // 挑一个地方：在画面上撒一张网格（宽屏 7 × 5，竖屏 6 × 11），每一格从镜头打一条线到星座那一层（云顶以上约 2.4 个身子半径），
  // 算出星座在那里时离星球（连名牌）、标题卡片、徽章、右下角的翠宝、画面边缘还有多少空（像素）。
  // 没压到东西的格子里挑最空的；在螺旋臂外面、离上一次远的加分。找不到就这次不出来
  private place(): boolean {
    const world = this.world;
    const cam = world.rig.camera;
    const planets = [...world.planets.values()];
    if (!planets.length) return false;
    let maxR = 0;
    for (const e of planets) maxR = Math.max(maxR, Math.hypot(e.home.x, e.home.z));
    const H = Math.max(1, innerHeight);
    const W = Math.max(1, innerWidth);
    // 窄屏（手机竖屏）星球排得满：小一点
    const px = Math.min(W * (W < 700 ? 0.052 : 0.085), H * 0.07) * CLOUD_TRIBOO.size;
    const dist = cam.position.length();
    const S = (px * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (H / 2);
    const plane = world.atmosphere.seaTop + S * 2.4; // 挂在云海上空（不沉在云里）
    const card = document.querySelector('#app .tb-title')?.getBoundingClientRect() ?? null;
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    const NX = W >= H ? 7 : 6;
    const NY = W >= H ? 5 : 11;
    for (let gy = 0; gy < NY; gy++) {
      for (let gx = 0; gx < NX; gx++) {
        _v.set(((gx + 0.5) / NX) * 2 - 1, -(((gy + 0.5) / NY) * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize();
        if (_v.y > -1e-3) continue;
        const t = (plane - cam.position.y) / _v.y;
        if (t <= 0) continue;
        const c = cam.position.clone().addScaledVector(_v, t);
        const room = this.clearance(c, S, planets, card);
        if (room < 0) continue;
        const outer = Math.min(1.5, Math.hypot(c.x, c.z) / Math.max(1, maxR));
        const away = this.last ? Math.min(1, c.distanceTo(this.last) / (S * 6)) : 1;
        const score = Math.min(room, 120) + 60 * outer + 40 * away + Math.random() * 10;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    if (!best) return false;
    this.orient(best, S);
    this.last = best.clone();
    return true;
  }

  // 星座（连手带脚，约 1.95 倍身子半径的圆）放在 c 时，离最近的东西还有多少像素：画面边缘、标题卡片、左下角的徽章、
  // 右下角躲着的翠宝、每颗星球连同它下面的名牌（星球的外接方框往下多 44 像素）。负的 = 压到了；不在画面里是 -Infinity
  private clearance(c: THREE.Vector3, S: number, planets: PlanetEntry[], card: DOMRect | null): number {
    const cam = this.world.rig.camera;
    _w.copy(c).project(cam);
    if (_w.z > 1) return -Infinity;
    const W = innerWidth;
    const H = innerHeight;
    const x = ((_w.x + 1) / 2) * W;
    const y = ((1 - _w.y) / 2) * H;
    const d = cam.position.distanceTo(c);
    const r = ((S * 1.95) / d / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * (H / 2);
    let room = Math.min(x - r, W - x - r, y - r, H - y - r) - 8;
    const rect = (l: number, t: number, rr: number, b: number) => {
      const nx = THREE.MathUtils.clamp(x, l, rr);
      const ny = THREE.MathUtils.clamp(y, t, b);
      room = Math.min(room, Math.hypot(nx - x, ny - y) - r);
    };
    if (card) rect(card.left - 8, card.top - 8, card.right + 8, card.bottom + 8);
    rect(0, H - 60, Math.min(210, W * 0.4), H); // Made with Tripo
    rect(W - Math.min(170, W * 0.24), H * (W < H ? 0.8 : 0.45), W, H); // 右下角躲着的翠宝（H2）：竖屏上它只占右下角一小块
    for (const e of planets) {
      if (!this.world.planetOnScreen(e, _c)) continue;
      const pr = _c.r + 10;
      rect(_c.x - pr, _c.y - pr, _c.x + pr, _c.y + pr + 44);
    }
    return room;
  }

  // 摆到 c：平面和画面平行（pose）；慢慢飘的方向是镜头的左右
  private orient(c: THREE.Vector3, S: number): void {
    this.scale = S;
    this.base.copy(c);
    this.center.copy(c);
    this.pose();
    this.drift.copy(this.right).multiplyScalar(S * (Math.random() < 0.5 ? -1 : 1));
  }

  get state(): { phase: Phase; center: [number, number, number]; scale: number; progress: number } {
    const c = this.center;
    return { phase: this.phase, center: [c.x, c.y, c.z], scale: this.scale, progress: this.progress };
  }

  // 只读：星座现在看得多清楚（0..1：亮起来、淡掉的进度和首页淡入淡出都算上）
  get opacity(): number {
    if (this.phase === 'hidden' || !this.group.visible) return 0;
    return this.progress * this.fade;
  }

  // 只读：星座现在在画面上占的地方（CSS 像素的方框；没在画时 null）。按图形的外框（连手带脚）四个角投到屏幕上取范围；
  // 亮起来时从一开始就算（它要出现在这里），淡掉时淡到快看不见就不算（它要走了）。首页云里探头的翠宝（fun/cloudPeek.ts）挑位置时躲开它
  screenRect(out: ScreenRect = { left: 0, top: 0, right: 0, bottom: 0 }): ScreenRect | null {
    if (this.phase === 'hidden' || !this.group.visible) return null;
    if (this.phase === 'scatter' && this.progress * this.fade < 0.12) return null;
    const cam = this.world.rig.camera;
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const [fx, fy] of [[BOX.left, BOX.bottom], [BOX.right, BOX.bottom], [BOX.left, BOX.top], [BOX.right, BOX.top]]) {
      _w.copy(this.center).addScaledVector(this.right, fx * this.scale).addScaledVector(this.up, fy * this.scale).project(cam);
      if (_w.z > 1) return null;
      const x = ((_w.x + 1) / 2) * innerWidth;
      const y = ((1 - _w.y) / 2) * innerHeight;
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
    }
    out.left = l;
    out.top = t;
    out.right = r;
    out.bottom = b;
    return out;
  }
}

// 第二版的名字（同一个类）
export { CloudTriboo as ConstellationTriboo };

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

let installed: CloudTriboo | null = null;

// main.ts 调一次（开场预热之前：一起编译）
export function installCloudTriboo(world: World): CloudTriboo {
  const ct = new CloudTriboo(world);
  world.scene.add(ct.group);
  ct.group.visible = true; // 预热时显示着（compileAsync 跳过不显示的），第一帧 update 以后按状态藏起来
  world.frameHooks.add((dt) => ct.update(dt));
  installed = ct;
  return ct;
}

export function cloudTriboo(): CloudTriboo | null {
  return installed;
}

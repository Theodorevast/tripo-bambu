import * as THREE from 'three/webgpu';
import { texture, uniform, uv, vec4 } from 'three/tsl';
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
  size: 0.78, // 大小（× 默认：身子半径约占画面高度的 7%）。第二版 main 05:45：缩到原来的六成多（1.25 → 0.78），不和内圈星系一样大
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
  size: number; // 像素（0 = 只是线的拐点，不画星）
  bright: number; // 亮度（星图上的星有亮有暗）
  gold: boolean; // 胸口 V 的星：偏暖的金
  order: number; // 亮起来的先后 0..1
}

interface FigLine {
  a: number;
  b: number;
  order: number;
  gold: boolean;
  width: number; // 线宽（像素）
  alpha: number; // 这一笔多淡
}

// 星图上的星座画法（main 05:45）：轮廓是 9 颗大小、亮度各不相同的星，节点之间连几段细而淡的弧（不画完整的圆，留两个口子）；
// 胸口三颗亮一点的金星连成 V；两只手是两小段弧（手套，左手抬起来打招呼），两只脚是两小段往下弯的弧（球鞋鞋底）；
// 下面写星座名 TRIBOO（label：Cinzel 小号大写、字距拉开）
function figure(): { stars: FigStar[]; lines: FigLine[] } {
  const stars: FigStar[] = [];
  const lines: FigLine[] = [];
  const add = (x: number, y: number, size: number, bright = 1, gold = false) => {
    stars.push({ x, y, size, bright, gold, order: 0 });
    return stars.length - 1;
  };
  const line = (a: number, b: number, width = 0.9, alpha = 0.42, gold = false) => lines.push({ a, b, order: 0, gold, width, alpha });
  // 一段弧：从 a0 到 a1（弧度），半径 r0 → r1 线性变化，n 段；两头接已有的点（from、to），中间的拐点不画星
  const arc = (cx: number, cy: number, a0: number, a1: number, r0: number, r1: number, n: number, from: number | null, to: number | null, width = 0.9, alpha = 0.42) => {
    let prev = from ?? add(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0, 0);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const a = a0 + (a1 - a0) * t;
      const r = r0 + (r1 - r0) * t;
      const id = k === n && to !== null ? to : add(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0);
      line(prev, id, width, alpha);
      prev = id;
    }
    return prev;
  };
  // 身子：9 颗星（角度、半径、大小、亮度都不一样）
  const body: Array<[number, number, number, number]> = [
    [96, 1.0, 5.2, 1.0],
    [54, 0.98, 3.0, 0.62],
    [14, 1.02, 4.3, 0.85],
    [-28, 0.97, 2.7, 0.55],
    [-66, 1.01, 4.6, 0.9],
    [-112, 0.99, 3.5, 0.72],
    [-150, 1.03, 2.6, 0.52],
    [170, 0.98, 4.4, 0.86],
    [132, 1.01, 3.1, 0.66],
  ];
  const ids = body.map(([deg, r, size, b]) => add(Math.cos(THREE.MathUtils.degToRad(deg)) * r, Math.sin(THREE.MathUtils.degToRad(deg)) * r, size, b));
  // 相邻两颗之间沿着圆连一段弧；在右上（54° → 14°）和左下（-112° → -150°）各留一个口子：读起来是圆的，但不是一个画满的圈
  for (let k = 0; k < body.length; k++) {
    const j = (k + 1) % body.length;
    if (k === 1 || k === 5) continue;
    const a0 = THREE.MathUtils.degToRad(body[k][0]);
    let a1 = THREE.MathUtils.degToRad(body[j][0]);
    if (a1 > a0) a1 -= Math.PI * 2; // 顺时针
    arc(0, 0, a0, a1, body[k][1], body[j][1], 4, ids[k], ids[j]);
  }
  // 胸口的 V（翠宝标志上的 V：和 ui/badge.ts 同一套坐标，y 翻过来）：三颗亮的金星，线粗一点、亮一点
  const v = [[-0.5, 0.3], [-0.03, -0.4], [0.44, 0.1]].map(([x, y], i) => add(x * 0.72, y * 0.72 - 0.04, i === 1 ? 6.2 : 5.4, 1, true));
  line(v[0], v[1], 1.4, 0.78, true);
  line(v[1], v[2], 1.4, 0.78, true);
  // 两只手：从肩上的星伸出一小截，手是一小段弧（手套：开口朝着手腕），手尖一颗小星。左手抬起来打招呼，右手放下
  const mitten = (shoulder: number, wx: number, wy: number, cx: number, cy: number, r: number) => {
    const wrist = add(wx, wy, 0);
    line(shoulder, wrist, 0.9, 0.45);
    const toward = Math.atan2(wy - cy, wx - cx);
    const tip = add(cx - Math.cos(toward) * r, cy - Math.sin(toward) * r, 3.2, 0.8);
    arc(cx, cy, toward + 0.9, toward + Math.PI, r, r, 3, null, tip, 0.9, 0.5);
    arc(cx, cy, toward + Math.PI, toward + Math.PI * 2 - 0.9, r, r, 3, tip, null, 0.9, 0.5);
  };
  mitten(ids[7], -1.17, 0.3, -1.31, 0.42, 0.15);
  mitten(ids[3], 1.08, -0.62, 1.19, -0.72, 0.13);
  // 两只脚：从髋上的星往下一小截，鞋底是一段往下弯的弧（鞋头朝外，鞋头一颗星）
  const sole = (hip: number, s: number) => {
    const ankle = add(s * 0.44, -1.12, 0);
    line(hip, ankle, 0.9, 0.45);
    const toe = add(s * 0.76, -1.18, 3.8, 0.82);
    const heel = add(s * 0.2, -1.2, 0);
    // 鞋底：从鞋跟到鞋头，往下弯（二次曲线取 5 段）
    let prev = heel;
    for (let k = 1; k <= 5; k++) {
      const t = k / 5;
      const x = (1 - t) * (1 - t) * (s * 0.2) + 2 * t * (1 - t) * (s * 0.46) + t * t * (s * 0.76);
      const y = (1 - t) * (1 - t) * -1.2 + 2 * t * (1 - t) * -1.33 + t * t * -1.18;
      const id = k === 5 ? toe : add(x, y, 0);
      line(prev, id, 0.9, 0.5);
      prev = id;
    }
  };
  sole(ids[5], -1);
  sole(ids[4], 1);
  // 先后：身子一圈先亮（从顶上顺时针），然后 V、手、脚；线跟在两头的星后面
  stars.forEach((st, i) => { st.order = i / Math.max(1, stars.length - 1); });
  for (const l of lines) l.order = Math.max(stars[l.a].order, stars[l.b].order);
  return { stars, lines };
}

// 星座名：下面一行 Cinzel 小号大写的「TRIBOO」，字距拉开，香槟金（画在画布上，一个面片，一次绘制）。字体加载好以后重画一次
const LABEL_W = 512;
const LABEL_H = 96;
function labelCanvas(): { canvas: HTMLCanvasElement | null; draw: () => void } {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (canvas) {
    canvas.width = LABEL_W;
    canvas.height = LABEL_H;
  }
  const draw = () => {
    if (!ctx) return;
    ctx.clearRect(0, 0, LABEL_W, LABEL_H);
    ctx.font = "600 54px Cinzel, 'Cormorant Garamond', Georgia, serif";
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '20px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2cd9a';
    ctx.fillText('TRIBOO', LABEL_W / 2 + 10, LABEL_H / 2 + 3); // 字距加在每个字后面：往右挪半个字距才居中
    // 两边各一道很短的细线（星图上标注的样子）
    ctx.fillRect(LABEL_W / 2 - 244, LABEL_H / 2, 30, 2);
    ctx.fillRect(LABEL_W / 2 + 214, LABEL_H / 2, 30, 2);
  };
  draw();
  return { canvas, draw };
}

const LINE = new THREE.Color('#d8c08e').multiplyScalar(1.2); // Champagne gold
const LINE_V = new THREE.Color('#ead2a0').multiplyScalar(1.5);
const STAR = new THREE.Color('#f6f1e7').multiplyScalar(1.7); // Starlight
const STAR_V = new THREE.Color('#f2d9a2').multiplyScalar(2.1);

// 图形在自己平面里的范围（身子半径 = 1）：screenRect、留空都按它
const BOX = { left: -1.56, right: 1.56, bottom: -1.86, top: 1.08 }; // 连星座名一起

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
  private readonly labelTex: THREE.Texture;
  private readonly uLabel = uniform(0); // 星座名的透明度（亮起来最后才出现）
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
    this.lines = new FineLines(lines.length, stars.length, { blend: 'max', twinkle: 0.45, twinkleSpeed: 1.4, name: 'home-constellation-triboo' });
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    lines.forEach((l, i) => {
      a.set(stars[l.a].x, stars[l.a].y, 0);
      b.set(stars[l.b].x, stars[l.b].y, 0);
      this.lines.setSegment(i, { a, b, width: l.width, color: l.gold ? LINE_V : LINE, alpha: 0 });
    });
    stars.forEach((s, i) => this.lines.setStar(i, { at: a.set(s.x, s.y, 0), size: s.size, color: s.gold ? STAR_V : STAR, alpha: 0, phase: i * 2.399 }));
    this.lines.commit();
    this.lines.fade.value = 0;
    this.lines.mesh.renderOrder = -4; // 云海（-10）、星尘（-6）之后
    this.group.name = 'home-constellation-triboo';
    this.group.add(this.lines.mesh);
    // 星座名：一个面片（多 1 次绘制），在脚下面
    // 贴图用 DataTexture（画布画好后 getImageData 拷进去，走 writeTexture）：CanvasTexture 第一次更新走 copyExternalImageToTexture，
    // WebGPU 上那一帧会卡几十毫秒（decorKit.ts 的路牌图集踩过）；不生成 mipmap（不用多编一份生成 mipmap 的管线）
    const label = labelCanvas();
    const data = new Uint8Array(LABEL_W * LABEL_H * 4);
    const copy = () => {
      const ctx = label.canvas && typeof label.canvas.getContext === 'function' ? label.canvas.getContext('2d') : null;
      if (!ctx) return;
      const img = ctx.getImageData(0, 0, LABEL_W, LABEL_H).data;
      // DataTexture 不翻转：第一行是 v = 0（下边），画布的第一行在上面，倒着拷
      for (let y = 0; y < LABEL_H; y++) data.set(img.subarray(y * LABEL_W * 4, (y + 1) * LABEL_W * 4), (LABEL_H - 1 - y) * LABEL_W * 4);
    };
    copy();
    const tex = new THREE.DataTexture(data, LABEL_W, LABEL_H, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.labelTex = tex;
    const lm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    lm.name = 'home-constellation-label';
    const tx = texture(this.labelTex, uv());
    lm.colorNode = vec4(tx.rgb.mul(1.25), tx.a.mul(this.uLabel));
    const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.1, (2.1 * LABEL_H) / LABEL_W), lm);
    labelMesh.name = 'home-constellation-label';
    labelMesh.position.set(0, -1.66, 0);
    labelMesh.renderOrder = -4;
    labelMesh.frustumCulled = false;
    this.group.add(labelMesh);
    void (typeof document !== 'undefined' ? document.fonts?.load('600 40px Cinzel') : undefined)?.then(() => {
      label.draw();
      copy();
      this.labelTex.needsUpdate = true;
    }, () => {});
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
      this.lines.setAlpha(i, s.size > 0 ? k * o * s.bright * (s.gold ? Math.min(1.4, 0.7 + 0.5 * CLOUD_TRIBOO.gold) : 1) : 0, true);
    });
    lines.forEach((l, i) => {
      const k = smooth(0.3 + l.order * 0.55, 0.42 + l.order * 0.55, p);
      this.lines.setAlpha(i, k * o * l.alpha * (l.gold ? Math.min(1.5, 0.6 + 0.4 * CLOUD_TRIBOO.gold) : 1));
    });
    // 星座名最后出来、最先淡掉；本身就淡（像星图上的标注）
    this.uLabel.value = smooth(0.82, 1, p) * o * 0.62;
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

import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, max, mix, positionWorld, sin, smoothstep, texture, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { PRESETS } from '../nature/atmosphere';
import type { PlanetEntry, World } from './world';

// 首页的「云朵翠宝」（P3 → 首页翠宝元素①）：云海上空一朵翠宝形状的云——圆圆的身子、两只张开的小手、底下一对小脚，胸口一点淡金色的 V。
// - 质感和首页的云海一样：暖奶油色、上亮下暗（按每团的上下渐变，底下乘云海的中间调）、大小不一的软边云团叠在一起，脚一半沉在云海里
// - 一个 Sprite（SpriteNodeMaterial，按实例画）：一次绘制。每团的位置在顶点着色器里按「这朵云的中心、朝向、大小 + 这一团在身上的位置」算，
//   散开 / 聚拢也在着色器里（uniform 一个进度），CPU 每帧只改几个 uniform
// - 云的那个平面正对镜头（每次聚拢时按镜头现在的方向定）：默认视角、更俯视的角度都认得出来
// - 放在星系外沿（螺旋臂外面）一个空的地方：投到屏幕上不压星球、名牌、标题卡片（每次聚拢前在屏幕上挑）
// - 慢慢飘；大约每 40 秒散成云絮，换个地方再聚起来
// 只在首页显示（进星球时淡出）；减弱动效时不飘、不散，一直在一个地方

export const CLOUD_TRIBOO = {
  on: 1, // 0 = 不要
  size: 1.25, // 大小（× 默认：身子半径约占画面高度的 7%）
  cycle: 40, // 多少秒散开、换个地方再聚（秒）
  gather: 2.6, // 聚拢要多久
  scatter: 2.4, // 散开要多久
  drift: 0.35, // 一个周期里慢慢飘多远（× 身子半径）
  opacity: 0.92,
  gold: 0.95, // 胸口那一点淡金色的 V（0 = 没有）
  afterIntro: 2.6, // 开场星尘放完以后等多久才第一次聚（秒：让右边的翠宝先打完招呼）
};

// —— 形状：身上每一团（翠宝的平面坐标，身子半径 = 1，y 朝上；z 往镜头那边鼓一点）——
interface Lump {
  x: number;
  y: number;
  z: number;
  s: number; // 大小（× 身子半径）
  kind: 0 | 1; // 0 云，1 胸口的淡金色 V
}

function shape(): Lump[] {
  const out: Lump[] = [];
  const rnd = mulberry(7);
  // 身子：一个实心的圆，外面一圈大一点的团（轮廓圆鼓鼓的），里面填满；中间往镜头鼓（有体积）
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rnd() * 0.1;
    const r = 0.84 + rnd() * 0.04;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0.1, s: 0.27 + rnd() * 0.06, kind: 0 });
  }
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt((i + rnd()) / 18) * 0.6;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0.35 * Math.sqrt(1 - r * r), s: 0.42 + rnd() * 0.12, kind: 0 });
  }
  // 两只张开的小手：在身子两边、往上举一点（像在打招呼），手掌一团、拇指一小团
  for (const side of [-1, 1]) {
    out.push({ x: side * 1.08, y: 0.02, z: 0.05, s: 0.2, kind: 0 });
    out.push({ x: side * 1.26, y: 0.2, z: 0.05, s: 0.24, kind: 0 });
    out.push({ x: side * 1.34, y: 0.42, z: 0.05, s: 0.2, kind: 0 });
    out.push({ x: side * 1.14, y: 0.42, z: 0.08, s: 0.14, kind: 0 });
  }
  // 一对小脚：底下两团扁的
  for (const side of [-1, 1]) {
    out.push({ x: side * 0.4, y: -1.02, z: 0.05, s: 0.23, kind: 0 });
    out.push({ x: side * 0.56, y: -1.08, z: 0.1, s: 0.17, kind: 0 });
    out.push({ x: side * 0.27, y: -1.09, z: 0.1, s: 0.16, kind: 0 });
  }
  // 胸口的 V（翠宝标志上的 V：和 ui/badge.ts 同一套坐标，y 翻过来），缩小一点，往镜头靠
  const v = [[-0.5, 0.3], [-0.03, -0.4], [0.44, 0.1]];
  for (let seg = 0; seg < 2; seg++) {
    const [x0, y0] = v[seg];
    const [x1, y1] = v[seg + 1];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      out.push({ x: (x0 + (x1 - x0) * t) * 0.62, y: (y0 + (y1 - y0) * t) * 0.62 - 0.02, z: 0.6, s: 0.16, kind: 1 });
    }
  }
  return out;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 一团软边的积云（贴图）：几个大小不一的圆叠在一起，边缘很软；明暗在着色器里按上下渐变做
function lumpTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const blob = (x: number, y: number, r: number, a: number) => {
      const grad = g.createRadialGradient(x, y, r * 0.05, x, y, r);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.55, `rgba(255,255,255,${a * 0.82})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    blob(64, 70, 46, 0.9);
    blob(40, 72, 30, 0.82);
    blob(90, 70, 30, 0.82);
    blob(56, 48, 30, 0.78);
    blob(80, 46, 26, 0.72);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Phase = 'hidden' | 'gather' | 'show' | 'scatter';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _c = { x: 0, y: 0, r: 0 };

export class CloudTriboo {
  readonly sprite: THREE.Sprite;
  private readonly world: World;
  private readonly lumps: Lump[];
  private readonly uCenter = uniform(new THREE.Vector3());
  private readonly uRight = uniform(new THREE.Vector3(1, 0, 0));
  private readonly uUp = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uFwd = uniform(new THREE.Vector3(0, 0, 1));
  private readonly uScale = uniform(40);
  private readonly uScatter = uniform(1); // 0 聚成翠宝，1 散成云絮
  private readonly uFade = uniform(0); // 首页 1，星球视图 0
  private readonly uSeaTop = uniform(-100);
  private readonly uLit = uniform(new THREE.Color(1, 0.95, 0.85));
  private readonly uShade = uniform(new THREE.Color(0.7, 0.62, 0.66));
  private readonly uGold = uniform(new THREE.Color(1.65, 1.2, 0.42));
  private readonly uGoldK = uniform(CLOUD_TRIBOO.gold);
  private readonly uOpacity = uniform(CLOUD_TRIBOO.opacity);
  private phase: Phase = 'hidden';
  private t = 0;
  private wait = 1.5; // 第一次聚起来之前等多久（开场的星尘、翠宝探头之后）
  private last: THREE.Vector3 | null = null; // 上一次在哪（换个地方）
  private readonly drift = new THREE.Vector3();
  private readonly base = new THREE.Vector3();
  private fade = 0;
  private recheck = 0; // 每隔一会儿看一下现在这个地方还空不空（镜头重新取景、版式变了以后可能压到星球）
  private warmed = false; // 开场预热完以前一直显示着（compileAsync 跳过不显示的），透明度是 0

  constructor(world: World) {
    this.world = world;
    void world.warm.then(() => { this.warmed = true; });
    this.lumps = shape();
    const n = this.lumps.length;
    const local = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // x, y, z, 大小
    const rand = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // 散开的方向 xyz、相位
    const kind = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    const r = mulberry(11);
    this.lumps.forEach((l, i) => {
      local.setXYZW(i, l.x, l.y, l.z, l.s);
      const d = new THREE.Vector3(l.x + (r() - 0.5) * 0.8, l.y + (r() - 0.3) * 0.8, (r() - 0.5) * 1.2).normalize();
      rand.setXYZW(i, d.x, d.y, d.z, r() * Math.PI * 2);
      kind.setX(i, l.kind);
    });
    const L = instancedBufferAttribute(local) as unknown as THREE.Node<'vec4'>;
    const Q = instancedBufferAttribute(rand) as unknown as THREE.Node<'vec4'>;
    const K = instancedBufferAttribute(kind) as unknown as THREE.Node<'float'>;
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    m.name = 'home-cloud-triboo';
    const sc = smoothstep(0, 1, this.uScatter);
    const bob = sin(time.mul(0.55).add(Q.w)).mul(0.025);
    const spread = Q.xyz.mul(sc.mul(2.4)).add(vec3(0, 0.5, 0).mul(sc));
    const lx = L.x.add(spread.x);
    const ly = L.y.add(spread.y).add(bob);
    const lz = L.z.add(spread.z);
    const world0 = this.uCenter.add(this.uRight.mul(lx).add(this.uUp.mul(ly)).add(this.uFwd.mul(lz)).mul(this.uScale));
    m.positionNode = world0;
    m.scaleNode = L.w.mul(this.uScale).mul(float(1.85).add(sc.mul(1.8)));
    const tex = texture(lumpTexture(), uv());
    const lift = smoothstep(0.1, 0.85, uv().y);
    const cloud = mix((this.uShade as unknown as THREE.Node<'vec3'>), (this.uLit as unknown as THREE.Node<'vec3'>), lift);
    const col = mix(cloud, (this.uGold as unknown as THREE.Node<'vec3'>), K.mul(this.uGoldK));
    // 脚、身子低于云顶的部分渐渐透明（沉在云海里）；散开时淡掉；V 的那几团淡一点（是一点光，不是一块金子）
    const sunk = smoothstep(this.uSeaTop.sub(this.uScale.mul(0.25)), this.uSeaTop.add(this.uScale.mul(0.2)), positionWorld.y);
    const a = tex.a.mul(this.uOpacity).mul(float(1).sub(sc.pow(1.4))).mul(this.uFade).mul(sunk).mul(mix(float(1), float(0.85), K));
    m.colorNode = vec4(col.mul(tex.rgb), max(a, 0));
    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'home-cloud-triboo';
    this.sprite.count = n;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = -7; // 云海（-10）、云上的影子之后，星尘（-6）之前
  }

  // ?tune → Cloud Triboo → Replay：马上散开，换个地方再聚
  replay(): void {
    if (this.phase === 'show' || this.phase === 'gather') {
      this.phase = 'scatter';
      this.t = 0;
    } else {
      this.wait = 0;
    }
  }

  // 每帧（World.frameHooks）
  update(dt: number): void {
    const world = this.world;
    if (!this.warmed) return;
    const home = !world.focused && !world.director.busy && CLOUD_TRIBOO.on > 0;
    this.fade += ((home ? 1 : 0) - this.fade) * (1 - Math.exp(-4 * dt));
    this.uFade.value = this.fade;
    this.sprite.visible = this.fade > 0.003 && this.phase !== 'hidden';
    this.uGoldK.value = CLOUD_TRIBOO.gold;
    this.uOpacity.value = CLOUD_TRIBOO.opacity;
    this.uSeaTop.value = world.atmosphere.seaTop;
    const pal = PRESETS[world.atmosphere.preset];
    this.uLit.value.copy(pal.cloudLit).multiplyScalar(1.08);
    this.uShade.value.setRGB(
      THREE.MathUtils.clamp(pal.cloudMid.r / Math.max(1e-3, pal.cloudLit.r), 0.3, 0.78),
      THREE.MathUtils.clamp(pal.cloudMid.g / Math.max(1e-3, pal.cloudLit.g), 0.3, 0.76),
      THREE.MathUtils.clamp(pal.cloudMid.b / Math.max(1e-3, pal.cloudLit.b), 0.3, 0.86),
    );
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 只在首页、镜头不在飞的时候换地方（换地方要按镜头现在的方向挑）
    // 开场的星尘拼标志在放的时候也不聚（一个一个来）
    const calm = home && !world.rig.flying && !world.rig.drive && world.galaxy.shapeState.t < 0;
    this.t += dt;
    switch (this.phase) {
      case 'hidden':
        // 开场的星尘拼标志在放：放完以后再等一会儿（右边的翠宝这时探头打招呼），一个一个来
        if (world.galaxy.shapeState.t >= 0) this.wait = Math.max(this.wait, CLOUD_TRIBOO.afterIntro);
        this.wait -= dt;
        if (this.wait <= 0 && calm && this.place()) {
          this.phase = 'gather';
          this.t = 0;
        }
        this.uScatter.value = 1;
        break;
      case 'gather': {
        const k = reduce ? 1 : Math.min(1, this.t / CLOUD_TRIBOO.gather);
        this.uScatter.value = 1 - k;
        if (k >= 1) {
          this.phase = 'show';
          this.t = 0;
        }
        break;
      }
      case 'show': {
        this.uScatter.value = 0;
        // 镜头重新取景（标题卡片量好了、窗口变了）、版式变了以后这里可能压到星球：提前散开，换个空的地方
        this.recheck -= dt;
        if (this.recheck <= 0 && calm) {
          this.recheck = 0.5;
          const card = document.querySelector('#app .tb-title')?.getBoundingClientRect() ?? null;
          if (this.clearance(this.uCenter.value, this.uScale.value, [...world.planets.values()], card) < -6) {
            this.phase = 'scatter';
            this.t = 0;
            break;
          }
        }
        // 慢慢飘：沿镜头的左右方向来回一点
        if (!reduce) {
          const k = Math.min(1, this.t / Math.max(1, CLOUD_TRIBOO.cycle));
          this.uCenter.value.copy(this.base).addScaledVector(this.drift, Math.sin(k * Math.PI) * CLOUD_TRIBOO.drift);
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
        this.uScatter.value = k;
        if (k >= 1) {
          this.phase = 'hidden';
          this.t = 0;
          this.wait = 0.6;
        }
        break;
      }
    }
  }

  // 挑一个地方：星系外沿（最外那颗星球再往外一点）、镜头的左边 / 左后 / 远处 / 右后……按顺序试，
  // 投到屏幕上不压星球（连同名牌往下的一截）、标题卡片，也不出画；和上一次的地方离得远一点。找不到就这次不出来
  private place(): boolean {
    const world = this.world;
    const cam = world.rig.camera;
    const planets = [...world.planets.values()];
    if (!planets.length) return false;
    let maxR = 0;
    for (const e of planets) maxR = Math.max(maxR, Math.hypot(e.home.x, e.home.z));
    const R = planets[0].planet.radius;
    // 镜头的水平方向：右、往镜头（从星系中心看过去）
    const fwdH = cam.getWorldDirection(_v).setY(0);
    if (fwdH.lengthSq() < 1e-6) fwdH.set(0, 0, -1);
    fwdH.normalize();
    const rightH = _w.crossVectors(fwdH, new THREE.Vector3(0, 1, 0)).normalize().clone();
    // 身子在画面里多大（像素）→ 世界里多大：按镜头到星系中心的距离换算
    const H = Math.max(1, innerHeight);
    const W = Math.max(1, innerWidth);
    // 窄屏（手机竖屏）星球排得满：小一点
    const px = Math.min(W * (W < 700 ? 0.052 : 0.085), H * 0.07) * CLOUD_TRIBOO.size;
    const dist = cam.position.length();
    const S = (px * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (H / 2);
    const plane = world.atmosphere.seaTop + S * 1.12; // 云的中心在云顶以上这么高（脚沉在云里）
    const card = document.querySelector('#app .tb-title')?.getBoundingClientRect() ?? null;
    void rightH;
    // 在画面上撒一张 7 × 5 的网格，每一格从镜头打一条线到云的高度那一层，算出这朵云在那里时离星球（连名牌）、标题卡片、徽章、
    // 右下角的翠宝、画面边缘还有多少空（像素）。没压到东西的格子里挑最空的；在螺旋臂外面、离上一次远的加分
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    // 竖屏的格子竖着多、横着少（手机上空的地方小，格子细一点）
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
    void R;
    void fwdH;
    this.orient(best, S);
    this.last = best.clone();
    return true;
  }

  // 这朵云（连手带脚，约 1.9 倍身子半径的圆）放在 c 时，离最近的东西还有多少像素：画面边缘、标题卡片、左下角的徽章、
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
    const r = ((S * 1.9) / d / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * (H / 2);
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

  // 正对镜头摆：平面的法线指向镜头；左右是水平的；慢慢飘的方向是镜头的左右
  private orient(c: THREE.Vector3, S: number): void {
    const cam = this.world.rig.camera;
    const n = cam.position.clone().sub(c).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(n, right).normalize();
    this.uRight.value.copy(right);
    this.uUp.value.copy(up);
    this.uFwd.value.copy(n);
    this.uScale.value = S;
    this.base.copy(c);
    this.uCenter.value.copy(c);
    this.drift.copy(right).multiplyScalar(S * (Math.random() < 0.5 ? -1 : 1));
  }

  get state(): { phase: Phase; center: [number, number, number]; scale: number } {
    const c = this.uCenter.value;
    return { phase: this.phase, center: [c.x, c.y, c.z], scale: this.uScale.value };
  }

  // 只读：这朵云现在看得多清楚（0..1：散开的进度、首页淡入淡出都算上，同着色器）
  get opacity(): number {
    if (this.phase === 'hidden' || !this.sprite.visible) return 0;
    const sc = this.scatterK();
    return (1 - sc ** 1.4) * this.fade;
  }

  // 只读：这朵云现在在画面上占的地方（CSS 像素的方框；没在画时 null）。
  // 聚好时按连手带脚约 1.9 倍身子半径的圆算（同 clearance）；散开、聚拢的时候按云絮散到多远算（着色器里每团最多往外散 2.4 倍、往上 0.5 倍），
  // 散得越开越大。聚拢时从一开始就算（它要聚到这里来）；散开时淡到快看不见就不算（它要走了）。
  // 首页云里探头的翠宝（fun/cloudPeek.ts）挑位置时躲开它
  screenRect(out: ScreenRect = { left: 0, top: 0, right: 0, bottom: 0 }): ScreenRect | null {
    if (this.phase === 'hidden' || !this.sprite.visible) return null;
    const sc = this.scatterK();
    if (this.phase === 'scatter' && (1 - sc ** 1.4) * this.fade < 0.12) return null;
    const cam = this.world.rig.camera;
    const S = this.uScale.value;
    _rc.copy(this.uCenter.value).addScaledVector(this.uUp.value, 0.5 * sc * S);
    _rp.copy(_rc).project(cam);
    if (_rp.z > 1) return null;
    const x = ((_rp.x + 1) / 2) * innerWidth;
    const y = ((1 - _rp.y) / 2) * innerHeight;
    const d = Math.max(1e-3, cam.position.distanceTo(_rc));
    const r = ((S * (1.9 + 2.4 * sc)) / d / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) * (innerHeight / 2);
    out.left = x - r;
    out.top = y - r;
    out.right = x + r;
    out.bottom = y + r;
    return out;
  }

  // 散开的进度（同着色器里的 smoothstep(0, 1, uScatter)）
  private scatterK(): number {
    const u = THREE.MathUtils.clamp(this.uScatter.value, 0, 1);
    return u * u * (3 - 2 * u);
  }
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const _rc = new THREE.Vector3();
const _rp = new THREE.Vector3();

let installed: CloudTriboo | null = null;

// main.ts 调一次（开场预热之前：一起编译）
export function installCloudTriboo(world: World): CloudTriboo {
  const ct = new CloudTriboo(world);
  world.scene.add(ct.sprite);
  ct.sprite.visible = true; // 预热时显示着（compileAsync 跳过不显示的），第一帧 update 以后按状态藏起来
  world.frameHooks.add((dt) => ct.update(dt));
  installed = ct;
  return ct;
}

export function cloudTriboo(): CloudTriboo | null {
  return installed;
}

import * as THREE from 'three/webgpu';
import { atan, cos, float, instancedBufferAttribute, length, mix, sin, smoothstep, step, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import { HOME_SPIRAL, spiralB, spiralPoint, spiralR0, type HomeSpiral } from './homeLayout';
import { BRAND_MARK, closed } from './brandMark';
import { FineLines } from './fineLines';

// 首页螺旋星系的点缀（H2）：星球只有十几颗时看不出螺旋臂，沿两条臂撒上
// - 星尘：沿臂的中线密、离开中线很快变稀，一条窄窄的弧带；靠中心亮、往外慢慢暗，一直画到最外那颗星球外面；
//   一条臂偏暖金、一条偏奶白；两边再零星撒几粒。叠加混合（会发光），慢慢闪
// - 小云絮：几十团很淡的奶油色、桃粉色软云，压在臂底下，给螺旋臂一点「身体」
// - 你的星球：后面一圈暖光，底下的云面上一圈柔和的光环（这颗是你的）
// 星尘、云絮各一次绘制（朝向镜头的面片：SpriteNodeMaterial + 每个实例的位置、大小、颜色），暖光、光环各一次。
// 不写深度：星球挡得住它们，它们不挡星球。只在首页显示，进星球时淡出、藏起来

export const HOME_DUST = {
  density: 1, // 星尘多少（× 默认粒数）
  size: 1, // 星尘大小
  glow: 1, // 星尘亮度
  width: 1, // 弧带多宽
  wisps: 0, // 小云絮浓淡（0 = 没有）。第二版不要：夜里一团团的软云像两条发光的奶油虫，旋臂只靠细小的颗粒和亮度渐变显出形状
  halo: 1, // 你的星球的暖光、底下的光环（0 = 没有）
  extra: 1.6, // 螺旋臂画到最外那颗星球外面再多长多少（× 半径）
};

// 开场「星尘拼出翠宝」（P3 → 首页翠宝元素⑤）：开场飞行快落定时，螺旋臂上的星尘沿着螺旋流过来，拼成 Tripo 的标志
// （翠宝胸口那个：一圈圆、一个 V、一个 T，和 ui/badge.ts 同一套坐标），停一秒，再顺着螺旋流回两条臂。
// 在顶点着色器里按进度插值（每粒自己的目标点、错开的先后都在缓冲里，CPU 只推一个进度）：绕星系中心按极坐标插值，
// 流过来、流回去都是绕着中心转的（顺着螺旋）。只在开场放一次；?tune → Stardust Triboo → Replay 再放一次
export const STARDUST_TRIBOO = {
  on: 1, // 0 = 开场不拼
  at: 0.36, // 开场飞行走到几成时开始聚（0..1）
  gather: 1.35, // 聚成标志要多久（秒，最后一粒到位）
  hold: 1.0, // 停多久
  back: 1.5, // 流回螺旋臂要多久
  size: 0.36, // 标志多大（圆的直径 × 画面高度）
  twist: 1.1, // 流的时候额外绕中心转多少（弧度，路上最多）
  lift: 0.6, // 流的时候往上拱多高（× 星球半径）
};

const DUST_BASE = 6400; // 第二版 [v2-world]：粒子更细、多一些（3600 → 6400，其中四成是极细的微尘），总的填充量反而小了
const WISP_COUNT = 110;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 正态分布（Box–Muller）
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * Math.cos(2 * Math.PI * r());
}

interface Batch {
  sprite: THREE.Sprite;
  pos: THREE.InstancedBufferAttribute;
  size: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute; // rgb + 亮度
  max: number;
}

// 一批朝向镜头的面片：每个实例的位置、大小、颜色从缓冲里取；shade 按颜色算出这一片的颜色和不透明度
function makeBatch(max: number, name: string, fade: THREE.Node<'float'>, additive: boolean, shade: (c: THREE.Node<'vec4'>) => THREE.Node<'vec4'>): Batch {
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  if (additive) m.blending = THREE.AdditiveBlending;
  m.positionNode = instancedBufferAttribute(pos);
  m.scaleNode = instancedBufferAttribute(size);
  const out = shade(instancedBufferAttribute(color) as unknown as THREE.Node<'vec4'>);
  m.colorNode = vec4(out.rgb, out.a.mul(fade));
  const sprite = new THREE.Sprite(m);
  sprite.name = name;
  sprite.frustumCulled = false;
  sprite.count = max;
  return { sprite, pos, size, color, max };
}

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
};

export interface GalaxyExtent {
  maxR: number; // 最外那颗星球离中心多远（没拉长时，世界单位）
  stretch: number; // 沿纵深（z）拉长多少（手机竖屏）
  rotation: number; // 版式把星系在平面里转了多少（弧度，homeLayout 的 meta）
}

// 标志：一圈圆（半径 1）、V 和 T 的外轮廓。几何在 brandMark.ts（和启动画面天体仪中心的细金线标志同一份），坐标 y 朝上
const MARK_V = closed(BRAND_MARK.vOutline);
const MARK_T = closed(BRAND_MARK.tOutline);
// 第二版：只有三成星尘去拼标志（其余的留在旋臂上、拼的时候暗一点），主笔画用细金线描（下面的 mark，FineLines），星尘只做点缀
const MARK_SHARE = 3; // 每 10 粒里几粒去拼

// 沿一条折线按长度均匀取第 u（0..1）处的点
function along(line: Array<[number, number]>, u: number): [number, number] {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  let d = u * total;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (d <= len || i === line.length - 1) {
      const t = len > 0 ? Math.min(1, d / len) : 0;
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    d -= len;
  }
  return line[line.length - 1];
}

// 每粒星尘在标志上的目标：x、y（标志平面，圆的半径 = 1）、先后（0..1）、哪一笔（0 圆、1 V、2 T；-1 = 不去拼，留在旋臂上）。
// 第二版：每 10 粒里只有 MARK_SHARE 粒去拼；去拼的那些里圆 42%、V 34%、T 24%，沿笔画均匀撒，横着抖得很少（笔画是细线，星尘贴着线）；
// 先后按高度（从上往下扫）加一点随机
function markTargets(out: Float32Array, n: number, rand: () => number): void {
  const logo = (i: number) => i % 10 < MARK_SHARE;
  const total = Math.floor(n / 10) * MARK_SHARE + Math.min(n % 10, MARK_SHARE);
  const nRing = Math.round(total * 0.42);
  const nV = Math.round(total * 0.34);
  for (let idx = 0; idx < n; idx++) {
    if (!logo(idx)) {
      out[idx * 4] = 0;
      out[idx * 4 + 1] = 0;
      out[idx * 4 + 2] = rand();
      out[idx * 4 + 3] = -1;
      continue;
    }
    const i = Math.floor(idx / 10) * MARK_SHARE + (idx % 10); // 去拼的那些里排第几
    let x: number;
    let y: number;
    let part: number;
    if (i < nRing) {
      const a = (i / nRing) * Math.PI * 2;
      const r = 1 + gauss(rand) * 0.012;
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
      part = 0;
    } else if (i < nRing + nV) {
      [x, y] = along(MARK_V, (i - nRing) / Math.max(1, nV - 1));
      x += gauss(rand) * 0.01;
      y += gauss(rand) * 0.01;
      part = 1;
    } else {
      const k = (i - nRing - nV) / Math.max(1, total - nRing - nV - 1);
      [x, y] = along(MARK_T, k);
      x += gauss(rand) * 0.01;
      y += gauss(rand) * 0.01;
      part = 2;
    }
    out[idx * 4] = x;
    out[idx * 4 + 1] = y;
    out[idx * 4 + 2] = THREE.MathUtils.clamp((1 - y) / 2 * 0.8 + rand() * 0.2, 0, 1);
    out[idx * 4 + 3] = part;
  }
}

export class GalaxyDecor {
  readonly group = new THREE.Group();
  private readonly fade = uniform(1); // 首页 1，星球视图 0
  private readonly glow = uniform(1);
  private readonly wispK = uniform(1);
  private readonly haloK = uniform(1);
  private readonly dust: Batch;
  // 开场拼标志：每粒的目标（标志平面里的 x、y，先后 0..1，哪一笔：0 圆、1 V、2 T）、进度、标志放在哪
  private readonly shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(Math.round(DUST_BASE * 2.5) * 4), 4);
  private readonly uShape = uniform(0);
  private readonly uShapeCenter = uniform(new THREE.Vector3());
  private readonly uShapeRight = uniform(new THREE.Vector3(1, 0, 0));
  private readonly uShapeUp = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uShapeScale = uniform(100);
  private readonly uTwist = uniform(STARDUST_TRIBOO.twist);
  private readonly uLift = uniform(30);
  private shapeT = -1; // 拼标志放到哪儿了（秒；< 0 没在放）
  private radius = 30; // 星球半径（build 时记下）
  private shapeWait = 0;
  private shapeEnd: (() => void) | null = null;
  private shapePromise: Promise<void> = Promise.resolve();
  private readonly wisps: Batch;
  private readonly halo: THREE.Sprite;
  private readonly ground: THREE.Mesh;
  private builtFor = '';
  // 开场标志的主笔画（第二版）：细金线一笔一笔描出来（圆 → V → T），几颗星光白的小星点在笔画端点；星尘只做点缀
  private readonly markGroup = new THREE.Group();
  private readonly mark: FineLines;
  private readonly markOrder: Float32Array; // 每一段在描的顺序里排在哪（0..1）
  private readonly markStarOrder: number[] = [];
  private markShown = -1; // 上一次写透明度时的「描到哪 × 亮度」（没变不重写）

  constructor() {
    this.group.name = 'home-galaxy';
    // 星尘：圆的小光点，中间实、边上一圈软的晕；每粒按自己的亮度当相位慢慢闪。叠加混合：和云海拉开，像在发光
    const S = instancedBufferAttribute(this.shapeAttr) as unknown as THREE.Node<'vec4'>;
    const isLogo = step(-0.5, S.w); // 去拼标志的（其余的留在旋臂上）
    const shapeK = smoothstep(0, 1, this.uShape.mul(1.6).sub(S.z.mul(0.6)).clamp(0, 1)).mul(isLogo); // 这一粒到了几成（先后错开）
    // 第二版：拼标志的星尘是香槟金，只有少数几粒星光白当点缀（亮一点、会带一点泛光）；每一粒都暗、小，叠在一起也不发白
    const accent = step(0.93, S.z.mul(91.7).add(S.x.mul(13.1)).fract());
    const partColor = mix(lin('#d8c08e'), lin('#f6f1e7'), accent);
    // 不拼的那些：拼的时候暗下去一半多（旋臂还在，但让开主角）
    const stay = float(1).sub(smoothstep(0, 1, this.uShape).mul(float(1).sub(isLogo)).mul(0.6));
    this.dust = makeBatch(Math.round(DUST_BASE * 2.5), 'home-dust', this.fade, true, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      // 第二版：亮点更小更实、晕更淡；闪烁更克制（慢、幅度小）
      const core = smoothstep(0.36, 0.0, d);
      const halo = smoothstep(1.0, 0.2, d).mul(0.16);
      const twinkle = sin(time.mul(0.9).add(c.a.mul(53))).mul(0.09).add(0.95);
      const bright = mix(c.a.mul(stay), mix(float(0.3), float(0.85), accent), shapeK);
      const k = core.add(halo).mul(bright).mul(twinkle).mul(this.glow).mul(2.0);
      return vec4(mix(c.rgb, partColor, shapeK).mul(k), k); // 叠加：颜色本身乘亮度
    });
    {
      // 位置：螺旋臂上的点 → 标志上的点，绕星系中心按极坐标插值（顺着螺旋转过去），路上往上拱一点、多转一点
      const P = instancedBufferAttribute(this.dust.pos) as unknown as THREE.Node<'vec3'>;
      const T = this.uShapeCenter.add(this.uShapeRight.mul(S.x.mul(this.uShapeScale))).add(this.uShapeUp.mul(S.y.mul(this.uShapeScale)));
      const a0 = atan(P.z, P.x);
      const a1 = atan(T.z, T.x);
      const raw = a1.sub(a0);
      const da = raw.sub(raw.div(Math.PI * 2).round().mul(Math.PI * 2));
      const arc = sin(shapeK.mul(Math.PI));
      const ang = a0.add(da.mul(shapeK)).add(arc.mul(this.uTwist));
      const rad = mix(length(vec3(P.x, 0, P.z)), length(vec3(T.x, 0, T.z)), shapeK);
      const y = mix(P.y, T.y, shapeK).add(arc.mul(this.uLift));
      const m = this.dust.sprite.material as THREE.SpriteNodeMaterial;
      m.positionNode = vec3(cos(ang).mul(rad), y, sin(ang).mul(rad));
      m.scaleNode = (instancedBufferAttribute(this.dust.size) as unknown as THREE.Node<'float'>).mul(mix(float(1), mix(float(0.5), float(0.8), accent), shapeK));
    }
    // 小云絮：很软的圆斑
    this.wisps = makeBatch(WISP_COUNT, 'home-wisps', this.fade, false, (c) => {
      const d = length(uv().sub(0.5)).mul(2);
      const soft = smoothstep(1.0, 0.0, d);
      return vec4(c.rgb, soft.mul(soft).mul(c.a).mul(this.wispK));
    });
    // 你的星球后面的暖光：一个大的软圆，中间奶白、往外暖金、再淡成透明
    const haloMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    haloMat.blending = THREE.AdditiveBlending;
    {
      const d = length(uv().sub(0.5)).mul(2);
      const ring = smoothstep(1.0, 0.55, d).mul(smoothstep(0.25, 0.62, d));
      const inner = smoothstep(0.75, 0.0, d).mul(0.5);
      const pulse = sin(time.mul(1.3)).mul(0.08).add(0.92);
      // 第二版：很淡的一层星光白往香槟金过渡（你的星球主要靠天体仪环认出来，homeArmillary.ts）
      const k = ring.add(inner).mul(0.26).mul(pulse).mul(this.fade).mul(this.haloK);
      haloMat.colorNode = vec4(mix(lin('#f6f1e7'), lin('#d8c08e'), smoothstep(0.2, 0.9, d)).mul(k), k);
    }
    this.halo = new THREE.Sprite(haloMat);
    this.halo.name = 'home-you-halo';
    // 底下云面上的光环：平放的一圈柔光（中间空、一圈亮、外面淡掉），慢慢呼吸
    const groundMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    groundMat.blending = THREE.AdditiveBlending;
    {
      const d = length(uv().sub(0.5)).mul(2);
      // 第二版：一道细细的金线圈（不是一大片光环），里面一点点微光
      const band = smoothstep(0.66, 0.7, d).mul(smoothstep(0.74, 0.7, d));
      const fill = smoothstep(0.85, 0.0, d).mul(0.06);
      const pulse = sin(time.mul(1.1)).mul(0.1).add(0.9);
      const k = band.add(fill).mul(0.6).mul(pulse).mul(this.fade).mul(this.haloK);
      groundMat.colorNode = vec4(lin('#d8c08e').mul(k), k);
    }
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.name = 'home-you-ring';
    this.ground.frustumCulled = false;
    this.ground.renderOrder = -8; // 云海（-10）、远处积云（-9）之后
    this.wisps.sprite.renderOrder = -7;
    this.dust.sprite.renderOrder = -6;
    this.halo.renderOrder = -5;
    this.group.add(this.ground, this.wisps.sprite, this.dust.sprite, this.halo);
    // 标志的细金线：圆分 120 段，V、T 的外轮廓（和启动画面同一份）每条边按长度切小段；先描圆，再沿 V 的轮廓走一圈、再沿 T 的走一圈。
    // 普通混合（不叠加），亮度压在泛光的门槛下面，只有几颗点缀的小星会带一点光
    {
      const segs: Array<[number, number, number, number, number]> = []; // x0, y0, x1, y1, 先后
      const R = BRAND_MARK.ring;
      const ringN = 120;
      for (let k = 0; k < ringN; k++) {
        // 从顶上开始逆时针描一圈
        const a0 = Math.PI / 2 + (k / ringN) * Math.PI * 2;
        const a1 = Math.PI / 2 + ((k + 1) / ringN) * Math.PI * 2;
        segs.push([Math.cos(a0) * R, Math.sin(a0) * R, Math.cos(a1) * R, Math.sin(a1) * R, (k / ringN) * 0.45]);
      }
      // 轮廓沿着描一圈：每条边按长度切成约 0.035 一段（拐角保持尖的），先后按走过的长度；返回描到每个顶点时的先后（点缀的小星用）
      const stroke = (line: Array<[number, number]>, from: number, to: number): number[] => {
        const at: number[] = [from];
        let total = 0;
        for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
        let walked = 0;
        for (let i = 1; i < line.length; i++) {
          const [x0, y0] = line[i - 1];
          const [x1, y1] = line[i];
          const len = Math.hypot(x1 - x0, y1 - y0);
          const n = Math.max(1, Math.ceil(len / 0.035));
          for (let k = 0; k < n; k++) {
            const u0 = k / n;
            const u1 = (k + 1) / n;
            segs.push([x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0, x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1, from + ((to - from) * (walked + len * u0)) / total]);
          }
          walked += len;
          at.push(from + ((to - from) * walked) / total);
        }
        return at;
      };
      const vAt = stroke(MARK_V, 0.47, 0.75);
      const tAt = stroke(MARK_T, 0.77, 0.98);
      // 点缀的小星放在笔画的端点上，描到那里时亮起来（顶点编号见 brandMark.ts 的轮廓）
      const vStar = (i: number, size: number): [number, number, number, number] => [MARK_V[i][0], MARK_V[i][1], size, vAt[i]];
      const tStar = (i: number, size: number): [number, number, number, number] => [MARK_T[i][0], MARK_T[i][1], size, tAt[i]];
      const stars: Array<[number, number, number, number]> = [
        [0, R, 3.4, 0.0], // 圆的顶上（起笔）
        vStar(0, 3.0), // V 左边那一笔的顶（起笔）
        vStar(8, 3.0), // V 右边那一笔的顶
        vStar(13, 3.8), // V 的尖
        tStar(6, 3.0), // T 横的右端
        tStar(10, 2.8), // T 的尖
      ];
      this.mark = new FineLines(segs.length, stars.length, { name: 'home-mark-lines', twinkle: 0.3, twinkleSpeed: 1.2 });
      this.markOrder = new Float32Array(segs.length);
      const gold = new THREE.Color(BRAND_MARK.color).multiplyScalar(1.05);
      const star = new THREE.Color('#f6f1e7').multiplyScalar(1.7);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      segs.forEach(([x0, y0, x1, y1, o], i) => {
        this.mark.setSegment(i, { a: a.set(x0, y0, 0), b: b.set(x1, y1, 0), width: BRAND_MARK.lineWidthPx, color: gold, alpha: 0 });
        this.markOrder[i] = o;
      });
      stars.forEach(([x, y, size, o], i) => {
        this.mark.setStar(i, { at: a.set(x, y, 0), size, color: star, alpha: 0, phase: i * 2.3 });
        this.markStarOrder.push(o);
      });
      this.mark.commit();
      this.mark.fade.value = 0;
      this.mark.mesh.renderOrder = -5.5; // 星尘（-6）之后、你的星球的暖光（-5）之前
      this.markGroup.name = 'home-mark';
      this.markGroup.add(this.mark.mesh);
      this.group.add(this.markGroup); // 开场预热时显示着一起编译；放完拼标志就藏起来（不占绘制调用）
    }
  }

  // 按螺旋臂的参数、星球半径、星系多大重新撒（参数改了、半径变了、星系变大了才重撒）
  build(radius: number, ext: GalaxyExtent, p: HomeSpiral = HOME_SPIRAL): void {
    this.radius = radius;
    const key = JSON.stringify([radius, Math.round(ext.maxR), ext.stretch, p, HOME_DUST]);
    if (key === this.builtFor) return;
    this.builtFor = key;
    const R = radius;
    const arms = Math.max(1, Math.round(p.arms));
    const r0 = spiralR0(R, p);
    const b = spiralB(p);
    // 臂画到最外那颗星球再往外 extra 个半径（螺旋臂一直延伸到星球外面）
    const rEnd = Math.max(r0 * 1.5, ext.maxR + HOME_DUST.extra * R);
    const total = Math.log(rEnd / r0) / b;
    const sz = ext.stretch;
    const rc = Math.cos(ext.rotation);
    const rs = Math.sin(ext.rotation);
    const pt = { x: 0, z: 0, r: 0, a: 0 };
    const rand = rng(91);
    // 第二版：一条臂香槟金（往外偏古金），一条星光白（往外偏一点桃色的余晖）
    const gold = new THREE.Color('#d8c08e');
    const amber = new THREE.Color('#a8894f');
    const cream = new THREE.Color('#f6f1e7');
    const pearl = new THREE.Color('#e6c2a6');
    const tmp = new THREE.Color();
    // —— 星尘 ——
    const n = Math.min(this.dust.max, Math.round(DUST_BASE * HOME_DUST.density));
    const pos = this.dust.pos.array as Float32Array;
    const size = this.dust.size.array as Float32Array;
    const col = this.dust.color.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const arm = i % arms;
      let x: number;
      let z: number;
      let y: number;
      let k: number; // 0 中心 .. 1 外端
      let bright: number;
      let fine = false; // 第二版：极细、很淡的微尘（铺出旋臂的「身体」，代替第一版的小云絮）
      if (rand() < 0.1) {
        // 中间一小团（核球）：围着你的星球
        const rr = Math.abs(gauss(rand)) * r0 * 0.45 + R * 1.6;
        const a = rand() * Math.PI * 2;
        x = Math.cos(a) * rr;
        z = Math.sin(a) * rr;
        y = gauss(rand) * R * 0.25;
        k = 0.05;
        bright = 0.9;
      } else {
        // 沿臂：里面密一点，横着按窄的正态分布（越往外略宽）；12% 的是零星散在两边的
        const t = Math.pow(rand(), 0.85);
        spiralPoint(arm, t * total, r0, p, pt);
        const loose = rand() < 0.12;
        fine = !loose && rand() < 0.45;
        const w = R * HOME_DUST.width * (loose ? 1.6 + 1.4 * t : (0.32 + 0.45 * t) * (fine ? 1.9 : 1));
        const across = gauss(rand) * w;
        const along = gauss(rand) * R * 0.3;
        const ta = pt.a + Math.PI / 2;
        x = pt.x + Math.cos(pt.a) * across + Math.cos(ta) * along;
        z = pt.z + Math.sin(pt.a) * across + Math.sin(ta) * along;
        y = gauss(rand) * R * (0.15 + 0.2 * t);
        k = t;
        bright = (loose ? 0.45 : fine ? 0.42 : 1) * (1 - 0.6 * t); // 往外慢慢暗，但一直看得出来
      }
      pos[i * 3] = x * rc - z * rs;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = (x * rs + z * rc) * sz;
      size[i] = R * (fine ? 0.045 + 0.05 * rand() : 0.12 + 0.3 * rand() * rand()) * (1.15 - 0.35 * k) * HOME_DUST.size;
      // 一条臂暖金（往外偏琥珀），一条奶白（往外偏珍珠桃）
      if (arm === 0) tmp.copy(gold).lerp(amber, k * 0.8);
      else tmp.copy(cream).lerp(pearl, k * 0.8);
      col[i * 4] = tmp.r;
      col[i * 4 + 1] = tmp.g;
      col[i * 4 + 2] = tmp.b;
      col[i * 4 + 3] = bright * (0.7 + 0.3 * rand());
    }
    // 开场拼标志的目标：每一粒分到一笔（圆 42%、V 34%、T 24%），沿着那一笔均匀撒、横着抖一点；先后按在标志上的位置（从上往下扫过去）
    markTargets(this.shapeAttr.array as Float32Array, n, rng(173)); // 自己的随机数：不改后面小云絮的位置
    this.shapeAttr.needsUpdate = true;
    this.dust.sprite.count = n;
    this.dust.pos.needsUpdate = true;
    this.dust.size.needsUpdate = true;
    this.dust.color.needsUpdate = true;
    // —— 小云絮：压在臂底下 ——
    const wp = this.wisps.pos.array as Float32Array;
    const ws = this.wisps.size.array as Float32Array;
    const wc = this.wisps.color.array as Float32Array;
    // 第二版：小云絮换成很淡的暮色薄雾（灰紫、往外偏 Mauve），给螺旋臂一点身体，不是奶油色的软云
    const pink = new THREE.Color('#6f6488');
    const butter = new THREE.Color('#8a7f9c');
    for (let i = 0; i < WISP_COUNT; i++) {
      const t = 0.04 + 0.96 * (i / WISP_COUNT);
      spiralPoint(i % arms, t * total, r0, p, pt);
      const across = gauss(rand) * R * (0.12 + 0.2 * t);
      const wx = pt.x + Math.cos(pt.a) * across;
      const wz = pt.z + Math.sin(pt.a) * across;
      wp[i * 3] = wx * rc - wz * rs;
      wp[i * 3 + 1] = -R * (0.5 + 0.3 * rand());
      wp[i * 3 + 2] = (wx * rs + wz * rc) * sz;
      ws[i] = R * (1.3 + 0.9 * rand()) * (1 + t * 0.4);
      tmp.copy(butter).lerp(pink, t);
      wc[i * 4] = tmp.r;
      wc[i * 4 + 1] = tmp.g;
      wc[i * 4 + 2] = tmp.b;
      wc[i * 4 + 3] = 0.32 * (1 - t * 0.45);
    }
    this.wisps.pos.needsUpdate = true;
    this.wisps.size.needsUpdate = true;
    this.wisps.color.needsUpdate = true;
  }

  // 开场拼标志（World.intro 调）：view 是开场飞行落定时的取景（标志正对它、放在镜头和看的点之间）；delay 秒以后开始聚。
  // 减弱动效、关掉了（STARDUST_TRIBOO.on = 0）时不放。返回的 Promise 在流回螺旋臂以后 resolve（右边的翠宝等它放完再探头）
  playShape(view: { position: THREE.Vector3; target: THREE.Vector3; fov: number }, delay = 0): Promise<void> {
    this.shapeEnd?.();
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (STARDUST_TRIBOO.on <= 0 || reduce) {
      this.shapeT = -1;
      this.uShape.value = 0;
      this.markGroup.visible = false;
      this.shapePromise = Promise.resolve();
      return this.shapePromise;
    }
    const dir = view.target.clone().sub(view.position);
    const dist = dir.length();
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    // 放在镜头和看的点之间（镜头往前 82% 的地方：在大部分星球前面），按画面高度定大小
    const d = dist * 0.82;
    this.uShapeCenter.value.copy(view.position).addScaledVector(dir, d);
    this.uShapeRight.value.copy(right);
    this.uShapeUp.value.copy(up);
    this.uShapeScale.value = d * Math.tan(THREE.MathUtils.degToRad(view.fov) / 2) * STARDUST_TRIBOO.size;
    this.uTwist.value = STARDUST_TRIBOO.twist;
    this.uLift.value = this.radius * STARDUST_TRIBOO.lift;
    // 细金线放在同一个平面上：组的朝向是标志平面（x 往右、y 往上），大小 = 标志的尺度
    this.markGroup.position.copy(this.uShapeCenter.value);
    this.markGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir.clone().negate()));
    this.markGroup.scale.setScalar(this.uShapeScale.value);
    this.markGroup.visible = true;
    this.markShown = -1;
    this.shapeWait = Math.max(0, delay);
    this.shapeT = 0;
    this.uShape.value = 0;
    this.shapePromise = new Promise((resolve) => { this.shapeEnd = resolve; });
    return this.shapePromise;
  }

  // 开场的拼标志放完了（没放就是马上）
  shapeDone(): Promise<void> {
    return this.shapePromise;
  }

  get shapeState(): { t: number; progress: number } {
    return { t: this.shapeT, progress: this.uShape.value };
  }

  private stepShape(dt: number): void {
    if (this.shapeT < 0) return;
    if (this.shapeWait > 0) {
      this.shapeWait -= dt;
      return;
    }
    this.shapeT += dt;
    const g = STARDUST_TRIBOO.gather;
    const h = STARDUST_TRIBOO.hold;
    const b = STARDUST_TRIBOO.back;
    const t = this.shapeT;
    this.uShape.value = t < g ? t / g : t < g + h ? 1 : Math.max(0, 1 - (t - g - h) / b);
    // 细金线：星尘快聚好时开始描（圆 → V → T，一笔一笔），停着的时候是满的；流回去时先淡掉
    const draw = t < g ? THREE.MathUtils.smoothstep(t / g, 0.3, 1.0) : 1;
    const keep = t < g + h ? 1 : THREE.MathUtils.smoothstep(this.uShape.value, 0.45, 0.95);
    this.paintMark(draw, keep);
    if (t >= g + h + b) {
      this.shapeT = -1;
      this.uShape.value = 0;
      this.paintMark(0, 0);
      this.markGroup.visible = false; // 放完就不画了（第一次放的时候管线已经编好，以后再放直接显示）
      const end = this.shapeEnd;
      this.shapeEnd = null;
      end?.();
    }
  }

  // 每一段按先后透明度：描到 draw 的地方亮起来；keep 是整体的亮度（流回去时淡掉）。值没变不重写
  private paintMark(draw: number, keep: number): void {
    const key = Math.round(draw * 1000) * 1001 + Math.round(keep * 1000);
    if (key === this.markShown) return;
    this.markShown = key;
    this.mark.fade.value = keep;
    const o = this.markOrder;
    for (let i = 0; i < o.length; i++) this.mark.setAlpha(i, 0.9 * THREE.MathUtils.smoothstep(draw, o[i], o[i] + 0.04));
    for (let i = 0; i < this.markStarOrder.length; i++) this.mark.setAlpha(i, THREE.MathUtils.smoothstep(draw, this.markStarOrder[i], this.markStarOrder[i] + 0.06), true);
    this.mark.commit(false);
  }

  // 每帧：首页显示、星球视图淡出；你的星球的暖光跟着它，光环平放在它底下的云面上（seaTop：云顶的高度）
  update(dt: number, home: boolean, you: { pos: THREE.Vector3; size: number } | null, seaTop: number): void {
    this.stepShape(dt);
    const goal = home ? 1 : 0;
    const f = this.fade.value;
    this.fade.value = Math.abs(goal - f) < 0.01 ? goal : f + (goal - f) * (1 - Math.exp(-6 * dt));
    this.group.visible = this.fade.value > 0.001;
    this.glow.value = HOME_DUST.glow;
    this.wispK.value = HOME_DUST.wisps;
    this.wisps.sprite.visible = HOME_DUST.wisps > 0; // 第二版默认没有小云絮：不画（不白占一百多个大面片的填充）
    this.haloK.value = you ? HOME_DUST.halo : 0;
    if (you) {
      this.halo.position.copy(you.pos);
      this.halo.scale.setScalar(you.size * 3.0);
      this.ground.position.set(you.pos.x, seaTop + you.size * 0.05, you.pos.z);
      this.ground.scale.setScalar(you.size * 4.6);
    }
  }
}

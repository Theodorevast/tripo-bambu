import * as THREE from 'three/webgpu';
import { hashString, mulberry32, type Rng } from '../planet/rng';
import { gardenMaterial, gardenPieces, PALETTE, PIECE_IDS, SignAtlas, signMaterial, type PieceId } from './decorKit';

// 作品四周自动长出来的小花园（stage 角色，Tiny Glade / Townscaper 的那种「放下去，周围自己长好」）。
//
// 一件作品一座花园，按作品 id 定种子：同一件作品每次长得一样，换个位置也认得出。布局在作品自己的切平面里（x 右、z 正面，米）：
// - 正面：留给土路。几块扁石板从展台前沿铺向土路（踏脚石），到路边为止
// - 两侧：贴着展台的花床（一丛叶子 + 几朵花），侧面一块路牌写着作者名，另一侧有时放一张长椅朝着作品
// - 背后：一道矮栅栏围半圈，两头各一丛灌木，零星几块圆石头
// 所有零件按「先全部生成候选，再按土路、水、邻居过滤」两步走：随机数的消耗和过滤无关，摆放变了（土路改道）只是个别零件出现、消失，
// 不会整座花园换一个样子。
//
// 地标缩放（hero）：星球视图里镜头离地面几十米，1.6 米的作品只有三十来个像素，认不出来。PlanetView 按镜头高度给每件作品一个放大倍数
// （漫游时 1，星球视图约 2.2），作品、展台和整座花园一起绕作品中心放大；花园里的每个零件按放大后的位置重新贴地（球面会弯下去、地形有起伏），
// 不会悬空。放大后会压到土路上的零件（多半是正面的踏脚石、花床）跟着倍数淡出。
//
// 渲染：每种零件一个实例化网格（容量 1100：超过 three 的 uniform 数组上限，一律走实例属性，换数量不重编着色器），
// 网格一直留着，换星球、换作品只重写实例数据。动画（长出来、缩回去）和放大都只改实例矩阵

export const GARDEN_CAPACITY = 1100;

export interface GardenWork {
  id: string;
  dir: THREE.Vector3; // 作品方向（星球本地，单位向量）
  front: THREE.Vector3; // 作品正面（切向单位向量，模型 +Z 转到星球上）
  plinth: number; // 展台半径（米，已乘作品缩放）
  scale: number; // 作品缩放（placement.scale）：零件跟着放大一点
  label: string | null; // 路牌上的字（作者），null = 不立路牌
  accent: THREE.Color; // 团队色：花里会有一两丛这个颜色
}

export interface GardenGround {
  radius: number; // 星球半径（米）
  height(dir: THREE.Vector3): number; // 方向 → 地面半径
  sea: number; // 水面半径，没有水是 0
  path(dir: THREE.Vector3): number; // 0..1：土路
}

interface Item {
  piece: number; // PIECE_IDS 里的下标
  x: number; // 切平面里的位置（米，放大倍数 1 时）：x 右、z 正面
  z: number;
  yaw: number; // 绕法线转（相对作品的正面）
  tiltX: number;
  tiltZ: number;
  sx: number;
  sy: number;
  sz: number;
  lift: number; // 离地多高（米，放大倍数 1 时）：栅栏横杆
  sink: number; // 埋进地里多深
  rail: [number, number, number, number] | null; // 横杆：两头柱子的 x, z（按两头的地面高度斜一点）
  tint: THREE.Color;
  sway: number; // 风吹、碰撞的幅度
  delay: number; // 长出来之前等多久（秒）
  front: boolean; // 放大后会压到土路：按放大倍数淡出
  slot: number; // 路牌字的图集格子（只有 signface 用）
  ok: boolean; // 过滤后还在
  grow: number; // 0..1：长出来的进度
  goal: 0 | 1;
  wait: number;
  inst: number; // 在自己那种零件的实例化网格里是第几个（-1 = 没分到）
}

interface Garden {
  work: GardenWork;
  items: Item[];
  hero: number; // 当前的放大倍数
  cap: number; // 这件作品最多放大到多少（PlanetView 按土路、邻居算）
  reach: number; // 花园最远的零件离作品中心多远（米，放大倍数 1）
  dirty: boolean; // 实例矩阵要重写
  removing: boolean; // 缩回去以后删掉
}

const PIECE_INDEX = Object.fromEntries(PIECE_IDS.map((id, i) => [id, i])) as Record<PieceId, number>;
const GROW_SECONDS = 0.42;
const SHRINK_SECONDS = 0.16;
const BACK = 1.9; // 长出来时的回弹（easeOutBack），花草「蹦」出来

const easeOutBack = (t: number) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length];
const hex = (s: string) => new THREE.Color(s);

// 团队色多半是浅浅的粉彩：小旗、开花的灌木要从远处看得见，同一个色相提饱和度、亮度压到中间
const _hsl = { h: 0, s: 0, l: 0 };
export function vivid(c: THREE.Color): THREE.Color {
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(_hsl.h, Math.max(_hsl.s, 0.72), Math.min(0.6, Math.max(0.46, _hsl.l)), THREE.SRGBColorSpace);
}

// —— 布局：一件作品的全部候选零件（放大倍数 1，切平面坐标）——
// 只依赖作品 id、展台半径、作品缩放和团队色：和地面、邻居无关（过滤在 filterGarden 里做）
export function gardenCandidates(work: GardenWork): Item[] {
  const rng = mulberry32(hashString(`garden-${work.id}`));
  const rp = work.plinth;
  const k = Math.min(1.6, Math.max(0.8, work.scale)); // 零件大小跟作品缩放走一点
  const items: Item[] = [];
  const add = (piece: PieceId, x: number, z: number, o: Partial<Item> = {}) => {
    const it: Item = {
      piece: PIECE_INDEX[piece], x, z, yaw: 0, tiltX: 0, tiltZ: 0, sx: k, sy: k, sz: k, lift: 0, sink: 0, rail: null,
      tint: new THREE.Color(1, 1, 1), sway: 0, delay: 0, front: false, slot: -1, ok: true, grow: 0, goal: 1, wait: 0, inst: -1, ...o,
    };
    items.push(it);
    return it;
  };
  const polar = (r: number, a: number): [number, number] => [Math.sin(a) * r, Math.cos(a) * r]; // a = 0 正面，往 +x（右）转
  const accent = vivid(work.accent);
  const flowerColors = [...PALETTE.flowers.map(hex), accent];

  // 1. 踏脚石：从展台正面往土路铺 3 块扁石板
  for (let i = 0; i < 3; i++) {
    const r = rp + 0.28 + i * 0.36;
    const [x, z] = polar(r, (rng() - 0.5) * 0.35 + (i % 2 ? 0.12 : -0.12));
    const s = (0.12 + rng() * 0.05) * k;
    add('slab', x, z, { yaw: rng() * Math.PI * 2, sx: s, sy: s * (0.8 + rng() * 0.3), sz: s * (0.85 + rng() * 0.25), sink: 0.012 * k, tint: hex(PALETTE.stone).multiplyScalar(0.95 + rng() * 0.12), delay: 0.04 + i * 0.07 });
  }

  // 2. 花床：展台两侧各一丛贴着展台（前侧），两侧再各一丛稍远的
  const clump = (r: number, a: number, delay: number, big: number) => {
    const [cx, cz] = polar(r, a);
    add('tuft', cx, cz, { yaw: rng() * 6.28, sx: big * k, sy: big * k * (0.9 + rng() * 0.3), sz: big * k, sway: 0.025, delay, tint: new THREE.Color(1, 1, 1).multiplyScalar(0.9 + rng() * 0.2) });
    const kind = pick(rng, ['daisy', 'bell', 'pom', 'daisy'] as const);
    const col = pick(rng, flowerColors);
    const n = 4 + Math.floor(rng() * 4);
    for (let f = 0; f < n; f++) {
      const fa = rng() * Math.PI * 2;
      const fr = Math.sqrt(rng()) * 0.1 * big * k;
      const s = (0.85 + rng() * 0.45) * big * k;
      const mixed = rng() < 0.2 ? pick(rng, flowerColors) : col;
      add(rng() < 0.75 ? kind : pick(rng, ['daisy', 'bell', 'pom'] as const), cx + Math.cos(fa) * fr, cz + Math.sin(fa) * fr, {
        yaw: rng() * 6.28, tiltX: (rng() - 0.5) * 0.25, tiltZ: (rng() - 0.5) * 0.25, sx: s, sy: s, sz: s, sway: 0.06, delay: delay + 0.05 + rng() * 0.25,
        tint: mixed.clone().multiplyScalar(0.92 + rng() * 0.12),
      });
    }
  };
  const side = rng() < 0.5 ? 1 : -1; // 路牌在哪一侧；长椅在另一侧
  clump(rp + 0.24, side * (0.75 + rng() * 0.25), 0.3, 1);
  clump(rp + 0.24, -side * (0.75 + rng() * 0.25), 0.36, 1);
  clump(rp + 0.45 + rng() * 0.2, side * (1.75 + rng() * 0.35), 0.5, 1.15);
  clump(rp + 0.45 + rng() * 0.2, -side * (1.6 + rng() * 0.35), 0.55, 1.1);

  // 3. 栅栏：背后半圈，柱子间距约 0.42 米，两道横杆；偶尔缺一段（老栅栏）
  const rf = rp + 0.82 + rng() * 0.15;
  const half = 0.85 + rng() * 0.3; // 半圈张开多少（弧度）
  const fenceTint = hex(pick(rng, PALETTE.fences)).multiplyScalar(0.95 + rng() * 0.1);
  const posts = Math.max(3, Math.round((2 * half * rf) / (0.42 * k)) + 1);
  const gap = rng() < 0.35 ? 1 + Math.floor(rng() * (posts - 2)) : -1;
  let prev: [number, number] | null = null;
  for (let i = 0; i < posts; i++) {
    const a = Math.PI - half + (2 * half * i) / (posts - 1);
    const [x, z] = polar(rf + (rng() - 0.5) * 0.04, a);
    add('post', x, z, { yaw: rng() * 6.28, tiltX: (rng() - 0.5) * 0.08, tiltZ: (rng() - 0.5) * 0.08, sx: k, sy: k * (0.92 + rng() * 0.16), sz: k, sink: 0.03 * k, tint: fenceTint, delay: 0.15 + i * 0.06 });
    if (prev && i !== gap) {
      const [px, pz] = prev;
      const len = Math.hypot(x - px, z - pz);
      const yaw = Math.atan2(-(z - pz), x - px); // 横杆的 +x 沿两根柱子
      for (const h of [0.13, 0.27]) {
        add('rail', (x + px) / 2, (z + pz) / 2, { yaw, sx: len, sy: k, sz: k, lift: h * k, rail: [px, pz, x, z], tint: fenceTint, delay: 0.2 + i * 0.06 + h * 0.3 });
      }
    }
    prev = [x, z];
  }

  // 4. 灌木：栅栏两头各一丛（一丛常常是开满花的，远看是一团颜色），背后偶尔再来一丛大的
  const bloomColor = rng() < 0.5 ? accent.clone() : pick(rng, flowerColors);
  for (const end of [-1, 1]) {
    const [x, z] = polar(rf + 0.12, Math.PI + end * (half + 0.28));
    const s = (0.8 + rng() * 0.3) * k;
    const bloom = end === side || rng() < 0.3;
    const tint = bloom ? bloomColor.clone().multiplyScalar(0.92 + rng() * 0.12) : new THREE.Color(1, 1, 1).multiplyScalar(0.88 + rng() * 0.2);
    add(bloom ? 'bloom' : 'bush', x, z, { yaw: rng() * 6.28, sx: s, sy: s * (0.85 + rng() * 0.3), sz: s, sink: 0.04 * k, sway: 0.02, tint, delay: 0.45 + rng() * 0.15 });
  }
  if (rng() < 0.55) {
    const [x, z] = polar(rf + 0.55, Math.PI + (rng() - 0.5) * 0.7);
    const s = (1.1 + rng() * 0.3) * k;
    add('bush', x, z, { yaw: rng() * 6.28, sx: s, sy: s * (0.9 + rng() * 0.25), sz: s, sink: 0.05 * k, sway: 0.02, tint: new THREE.Color(1, 1, 1).multiplyScalar(0.85 + rng() * 0.2), delay: 0.6 });
  }

  // 5. 圆石头：灌木脚下一块大的，花床和栅栏之间零星几块小的
  {
    const [x, z] = polar(rf + 0.05, Math.PI + side * (half + 0.62));
    const s = (0.17 + rng() * 0.07) * k;
    add('pebble', x, z, { yaw: rng() * 6.28, sx: s, sy: s * (0.8 + rng() * 0.4), sz: s, sink: 0.02 * k, tint: hex(PALETTE.stone).multiplyScalar(0.9 + rng() * 0.15), delay: 0.25 });
  }
  const pebbles = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < pebbles; i++) {
    const [x, z] = polar(rp + 0.3 + rng() * 0.45, Math.PI + (rng() - 0.5) * 2.6);
    const s = (0.05 + rng() * 0.06) * k;
    add('pebble', x, z, { yaw: rng() * 6.28, sx: s, sy: s * (0.7 + rng() * 0.5), sz: s, sink: 0.01 * k, tint: hex(PALETTE.stone).multiplyScalar(0.85 + rng() * 0.25), delay: 0.12 + rng() * 0.3 });
  }

  // 6. 路牌：侧前方，牌子朝外偏前（从土路上走过来就看得到）
  if (work.label !== null) {
    const a = side * (1.12 + rng() * 0.2);
    const [x, z] = polar(rp + 0.5, a);
    const yaw = a * 0.5 + (rng() - 0.5) * 0.15; // 朝向在正面和侧面之间
    const tilt = (rng() - 0.5) * 0.06;
    const common = { yaw, tiltX: tilt, sink: 0.04 * k, delay: 0.1 };
    add('signpost', x, z, { ...common, tint: hex(PALETTE.sign).multiplyScalar(0.95 + rng() * 0.1) });
    add('signface', x, z, { ...common });
  }

  // 7. 小旗：栅栏外侧、背后偏路牌那一侧，团队色的三角旗。远看是一根竖线挑着一块颜色，作品在哪一眼就找到
  {
    const [x, z] = polar(rf + 0.22, Math.PI - side * (0.35 + rng() * 0.2));
    add('flag', x, z, { yaw: rng() * 6.28, sx: k, sy: k * (0.95 + rng() * 0.1), sz: k, sink: 0.03 * k, sway: 0.16, tint: accent.clone(), delay: 0.32 });
  }

  // 8. 长椅：另一侧稍后方，朝着作品
  if (rng() < 0.6) {
    const a = -side * (1.95 + rng() * 0.25);
    const [x, z] = polar(rp + 1.05, a);
    add('bench', x, z, { yaw: a + Math.PI, sink: 0.01 * k, tint: hex(pick(rng, PALETTE.benches)).multiplyScalar(0.95 + rng() * 0.1), delay: 0.7 });
  }
  return items;
}

const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _side = new THREE.Vector3();

// 切平面里 (x, z) 米、放大 s 倍处的方向（单位向量）
function dirAt(work: GardenWork, x: number, z: number, s: number, R: number, out: THREE.Vector3): THREE.Vector3 {
  const r = Math.hypot(x, z) * s;
  if (r < 1e-6) return out.copy(work.dir);
  _side.crossVectors(work.dir, work.front); // 局部 +x
  _t.copy(_side).multiplyScalar(x).addScaledVector(work.front, z).normalize();
  const a = r / R;
  return out.copy(work.dir).multiplyScalar(Math.cos(a)).addScaledVector(_t, Math.sin(a)).normalize();
}

// 按地面、水、邻居过滤；放大到 cap 倍时会压到土路的零件标成 front（随放大淡出）
export function filterGarden(items: Item[], work: GardenWork, ground: GardenGround, others: GardenWork[], cap: number): void {
  const R = ground.radius;
  for (const it of items) {
    const id = PIECE_IDS[it.piece];
    const d = dirAt(work, it.x, it.z, 1, R, _d);
    let ok = true;
    const onPath = ground.path(d);
    // 踏脚石可以碰到路边（铺到路上为止），别的零件不进土路
    if (onPath > (id === 'slab' ? 0.55 : 0.18)) ok = false;
    if (ground.sea > 0 && ground.height(d) < ground.sea + 0.04) ok = false;
    for (const o of others) {
      const near = d.angleTo(o.dir) * R;
      const keep = id === 'post' || id === 'rail' || id === 'bush' || id === 'bloom' || id === 'bench' || id === 'flag' ? o.plinth + 1.2 : o.plinth + 0.45;
      if (near < keep) ok = false;
    }
    it.ok = ok;
    if (ok && cap > 1.05) {
      const dc = dirAt(work, it.x, it.z, cap, R, _d);
      it.front = ground.path(dc) > 0.25;
    } else it.front = false;
  }
  // 横杆两头的柱子不在了，横杆也不要
  const posts = items.filter((it) => PIECE_IDS[it.piece] === 'post');
  for (const it of items) {
    if (!it.rail || !it.ok) continue;
    const [ax, az, bx, bz] = it.rail;
    const has = (x: number, z: number) => posts.some((p) => p.ok && Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6);
    if (!has(ax, az) || !has(bx, bz)) it.ok = false;
  }
  // 路牌的牌子和字一起留、一起去
  const post = items.find((it) => PIECE_IDS[it.piece] === 'signpost');
  const face = items.find((it) => PIECE_IDS[it.piece] === 'signface');
  if (post && face) face.ok = post.ok;
}

// 花园最远的零件离作品中心多远（米，放大倍数 1）：邻居之间放大时不互相压上
export function gardenReach(items: Item[]): number {
  let r = 0;
  for (const it of items) if (it.ok) r = Math.max(r, Math.hypot(it.x, it.z) + 0.35 * it.sx);
  return r;
}

const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _bx = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d2 = new THREE.Vector3();

export class Gardens {
  readonly group = new THREE.Group();
  readonly atlas = new SignAtlas();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly tints: THREE.InstancedBufferAttribute[];
  private readonly rects: THREE.InstancedBufferAttribute;
  private readonly gardens = new Map<string, Garden>();
  private ground: GardenGround | null = null;
  private packed = false; // 实例分配要重做
  private readonly owner: Array<Array<{ g: Garden; i: number }>>; // 每个网格的第 n 个实例属于哪座花园的哪个零件
  private readonly touched = new Set<number>();

  constructor(influence?: THREE.Node<'vec4'>) {
    this.group.name = 'gardens';
    const signs = signMaterial(this.atlas.texture);
    this.meshes = [];
    this.tints = [];
    this.owner = [];
    for (const piece of gardenPieces()) {
      const g = piece.geometry;
      const tint = new THREE.InstancedBufferAttribute(new Float32Array(GARDEN_CAPACITY * 4), 4);
      tint.setUsage(THREE.DynamicDrawUsage);
      if (piece.id === 'signface') {
        const rect = new THREE.InstancedBufferAttribute(new Float32Array(GARDEN_CAPACITY * 4), 4);
        rect.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('aRect', rect);
        this.rects = rect;
      } else {
        g.setAttribute('aTint', tint);
      }
      const mesh = new THREE.InstancedMesh(g, piece.id === 'signface' ? signs : gardenMaterial(influence, piece.flexible), GARDEN_CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.name = `garden-${piece.id}`;
      mesh.castShadow = piece.castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // 实例散在整颗星球上，包围球按实例算太麻烦；花园只有聚焦的星球有
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.tints.push(tint);
      this.owner.push([]);
    }
    this.rects ??= new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
  }

  // 预编译用：每种零件先画 1 个（数量 0 的网格编译时会被跳过）
  showOneEach(on: boolean): void {
    for (const m of this.meshes) m.count = on ? 1 : 0;
    if (!on) this.packed = false;
  }

  setGround(ground: GardenGround | null): void {
    this.ground = ground;
  }

  has(id: string): boolean {
    return this.gardens.has(id);
  }

  reachOf(id: string): number {
    return this.gardens.get(id)?.reach ?? 0;
  }

  // 布置（或重新布置）一件作品的花园。sprout：从零长出来；否则已有的零件保持现状，新出现的长出来。tucked：先不长（拖动中）
  layout(work: GardenWork, others: GardenWork[], cap: number, opts: { sprout?: boolean; tucked?: boolean; delay?: number } = {}): void {
    const ground = this.ground;
    if (!ground) return;
    const old = this.gardens.get(work.id);
    const items = gardenCandidates(work);
    filterGarden(items, work, ground, others, cap);
    const signText = work.label;
    for (const it of items) {
      if (PIECE_IDS[it.piece] === 'signface' && signText !== null) it.slot = this.atlas.claim(signText);
      if (PIECE_IDS[it.piece] === 'signface' && it.slot < 0) it.ok = false;
    }
    const keep = old && !old.removing && !opts.sprout;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const was = keep ? old.items[i] : undefined;
      if (was && was.piece === it.piece && was.ok) {
        it.grow = was.grow;
        it.goal = was.goal;
        it.wait = was.wait;
      } else {
        it.grow = 0;
        it.goal = opts.tucked ? 0 : 1;
        it.wait = (opts.delay ?? 0) + it.delay;
      }
      if (!it.ok) it.goal = 0;
      if (opts.tucked) it.goal = 0;
    }
    const g: Garden = { work, items, hero: old?.hero ?? 1, cap, reach: gardenReach(items), dirty: true, removing: false };
    this.gardens.set(work.id, g);
    this.packed = false;
  }

  // 收起（拖起来的时候）：很快缩回去
  tuck(id: string): void {
    const g = this.gardens.get(id);
    if (!g) return;
    for (const it of g.items) {
      it.goal = 0;
      it.wait = 0;
    }
    g.dirty = true;
  }

  // 从零重新长出来（放下以后）：按各自的延迟错开，像一圈一圈冒出来
  sprout(id: string, delay = 0): void {
    const g = this.gardens.get(id);
    if (!g) return;
    for (const it of g.items) {
      if (!it.ok) continue;
      it.goal = 1;
      it.grow = Math.min(it.grow, 0);
      it.wait = delay + it.delay;
    }
    g.dirty = true;
  }

  remove(id: string, animate: boolean): void {
    const g = this.gardens.get(id);
    if (!g) return;
    if (!animate) {
      this.gardens.delete(id);
      this.packed = false;
      return;
    }
    g.removing = true;
    this.tuck(id);
  }

  clear(): void {
    this.gardens.clear();
    this.atlas.reset();
    this.packed = false;
  }

  setHero(id: string, s: number): void {
    const g = this.gardens.get(id);
    if (!g || Math.abs(g.hero - s) < 1e-4) return;
    g.hero = s;
    g.dirty = true;
  }

  // 统计（?tune、性能脚本）：零件数、正在画的网格数、三角形数
  stats(): { items: number; drawCalls: number; triangles: number } {
    let items = 0;
    let drawCalls = 0;
    let triangles = 0;
    this.meshes.forEach((m) => {
      if (m.count === 0) return;
      items += m.count;
      drawCalls++;
      const g = m.geometry;
      triangles += (g.index ? g.index.count / 3 : g.getAttribute('position').count / 3) * m.count;
    });
    return { items, drawCalls, triangles };
  }

  // 每帧：推进长出来 / 缩回去的动画，重写有变化的花园的实例矩阵
  update(dt: number): void {
    this.atlas.flush();
    const ground = this.ground;
    if (!ground) return;
    for (const [id, g] of this.gardens) {
      let animating = false;
      for (const it of g.items) {
        if (it.wait > 0) {
          it.wait -= dt;
          if (it.goal === 1) animating = true;
          continue;
        }
        if (it.goal === 1 && it.grow < 1) {
          it.grow = Math.min(1, it.grow + dt / GROW_SECONDS);
          animating = true;
        } else if (it.goal === 0 && it.grow > 0) {
          it.grow = Math.max(0, it.grow - dt / SHRINK_SECONDS);
          animating = true;
        }
      }
      if (animating) g.dirty = true;
      if (g.removing && !animating && g.items.every((it) => it.grow === 0)) {
        this.gardens.delete(id);
        this.packed = false;
      }
    }
    if (!this.packed) this.pack();
    const touched = this.touched;
    touched.clear();
    for (const g of this.gardens.values()) {
      if (!g.dirty) continue;
      g.dirty = false;
      this.writeGarden(g, ground, touched);
    }
    for (const mi of touched) {
      const mesh = this.meshes[mi];
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // 重新分配实例：每种零件的实例按花园依次排；色调、路牌格子一起写
  private pack(): void {
    this.packed = true;
    for (const list of this.owner) list.length = 0;
    for (const g of this.gardens.values()) {
      g.items.forEach((it, i) => {
        it.inst = -1;
        if (!it.ok && it.grow === 0) return;
        const list = this.owner[it.piece];
        if (list.length >= GARDEN_CAPACITY) return;
        it.inst = list.length;
        list.push({ g, i });
      });
      g.dirty = true;
    }
    this.meshes.forEach((mesh, mi) => {
      const list = this.owner[mi];
      mesh.count = list.length;
      mesh.visible = list.length > 0;
      const tint = this.tints[mi];
      const signface = PIECE_IDS[mi] === 'signface';
      list.forEach(({ g, i }, n) => {
        const it = g.items[i];
        if (signface) {
          const [u, v, du, dv] = it.slot >= 0 ? this.atlas.rect(it.slot) : [0, 0, 0, 0];
          this.rects.setXYZW(n, u, v, du, dv);
        } else {
          tint.setXYZW(n, it.tint.r, it.tint.g, it.tint.b, it.sway * Math.max(0.6, it.sy));
        }
      });
      if (signface) {
        this.rects.clearUpdateRanges();
        this.rects.addUpdateRange(0, Math.max(1, list.length) * 4);
        this.rects.needsUpdate = true;
      } else {
        tint.clearUpdateRanges();
        tint.addUpdateRange(0, Math.max(1, list.length) * 4);
        tint.needsUpdate = true;
      }
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(1, list.length) * 16);
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  private writeGarden(g: Garden, ground: GardenGround, touched: Set<number>): void {
    const R = ground.radius;
    const s = g.hero;
    const work = g.work;
    // 放大后压到土路的零件：放大倍数从 1.15 到 1.45 之间淡出
    const frontFade = 1 - smooth(1.15, 1.45, s);
    for (const it of g.items) {
      if (it.inst < 0) continue;
      const mesh = this.meshes[it.piece];
      touched.add(it.piece);
      const vis = it.goal === 1 && it.grow < 1 ? easeOutBack(it.grow) : it.grow * it.grow * (3 - 2 * it.grow);
      const k = vis * (it.front ? frontFade : 1);
      if (k <= 1e-4) {
        _m.makeScale(0, 0, 0);
        mesh.setMatrixAt(it.inst, _m);
        continue;
      }
      const d = dirAt(work, it.x, it.z, s, R, _d2);
      const gr = Math.max(ground.height(d), ground.sea);
      // 朝向：法线是 Y，作品的正面投到这里的切平面上是 Z，再绕法线转 yaw、稍微歪一点
      _bz.copy(work.front).addScaledVector(d, -work.front.dot(d)).normalize();
      _bx.crossVectors(d, _bz);
      _m.makeBasis(_bx, d, _bz);
      _qb.setFromRotationMatrix(_m);
      let tiltZ = it.tiltZ;
      if (it.rail) {
        // 横杆两头按各自的地面高度：斜过去接上两根柱子
        const [ax, az, bx, bz] = it.rail;
        const ha = ground.height(dirAt(work, ax, az, s, R, _p));
        const hb = ground.height(dirAt(work, bx, bz, s, R, _p));
        tiltZ += Math.atan2(hb - ha, it.sx * s);
      }
      _q.setFromEuler(_e.set(it.tiltX, it.yaw, tiltZ, 'YXZ'));
      _qb.multiply(_q);
      _p.copy(d).multiplyScalar(gr + (it.lift - it.sink) * s);
      // 横杆的长度不跟着长出来的进度缩（两头总是接着柱子），只有粗细跟着
      _s.set(it.sx * s * (it.rail ? 1 : k), it.sy * s * k, it.sz * s * k);
      _m.compose(_p, _qb, _s);
      mesh.setMatrixAt(it.inst, _m);
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.group.removeFromParent();
  }
}

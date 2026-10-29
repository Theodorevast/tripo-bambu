import * as THREE from 'three/webgpu';

// 首页（星系视图，H2）的版式：一排一排的星球，像舞台上的合唱队。
// - 前排：建好的星球（有作品），「你的星球」在最中间、往前一点、大一点；放不下时分成几排，越往后越高（阶梯）
// - 后排：建设中的星球，更小、更淡（往天色里淡一些），在建好的那几排后面、再高一些
// - 每排两头往后弯一点（一条平缓的弧线）；高低带一点点手作感的错落
// 宽屏一排放得多、镜头低一点；竖屏（手机）一排少放几颗、排数多，镜头从高一点的地方往下看，一排排在画面上竖着叠起来。
// 位置都按星球半径算（拖半径滑块时整个版式按比例变），团队数量变了照样排（前排 1–N 颗、后排 0–N 颗都行）。
// 镜头按版式取景（fitHomeCamera）：所有星球连同下面的名牌都落在画面的「安全区」里（避开左上角的标题、右边的翠宝、左下角的徽章）

export type HomeShape = 'wide' | 'tall';

export interface HomeRows {
  youAlone: boolean; // 「你的星球」单独站在最前面（正中、往前、大一点），别的建好的星球排在它后面；false = 和别的在同一排的正中
  youForward: number; // 单独站时离第一排多远（× 半径，往镜头这边）
  youDown: number; // 单独站时比第一排低多少（× 半径；竖屏里它在最下面）
  youScale: number; // 「你的星球」放大多少
  peek: number; // 你的星球正后面那颗（第一排奇数颗时的中间那颗）再抬高多少，从你的星球上面露出来（× 半径）
  frontMax: number; // 建好的星球一排最多几颗
  gap: number; // 同一排相邻两颗星球表面之间的空隙（× 半径）
  rowBack: number; // 建好的星球每多一排往后退多少（× 半径）
  rowUp: number; // 每多一排抬高多少（× 半径）
  backMax: number; // 建设中的星球一排最多几颗
  backGap: number; // 建设中的一排里表面之间的空隙（× 半径，按原大小算）
  backDepth: number; // 建设中的第一排在建好的最后一排后面多远（× 半径）
  backUp: number; // 比建好的最后一排高多少（× 半径）
  backRowBack: number; // 建设中的每多一排往后退多少
  backRowUp: number; // 每多一排抬高多少
  arc: number; // 每排两头往后弯多少（× 半径，按「离中间多远 / 半排宽」的平方）
  arcY: number; // 每排两头往下弯多少（同上）：一排像一道微笑，相邻两颗的名牌一高一低，窄屏上也不挤在一起
  wobble: number; // 高低错落（× 半径）
}

export const HOME_LAYOUT: { backScale: number; backDim: number; wide: HomeRows; tall: HomeRows } = {
  backScale: 0.6, // 建设中的星球缩到多大
  backDim: 0.24, // 建设中的星球往天色里淡多少（0..1）
  // 宽屏：你的星球站在正中最前面，别的建好的在它后面排成一道平缓的弧（左右对称），建设中的在更后、更高的地方
  wide: { youAlone: true, youForward: 2.6, youDown: 0.95, youScale: 1.12, peek: 1.5, frontMax: 6, gap: 1.3, rowBack: 3.0, rowUp: 2.2, backMax: 6, backGap: 3.3, backDepth: 5.2, backUp: 3.1, backRowBack: 2.6, backRowUp: 1.25, arc: 1.4, arcY: 0, wobble: 0.2 },
  // 竖屏：一排排主要往上叠（rowUp 大、rowBack 小），镜头差不多平着看：每排都离镜头差不多远，星球在小屏幕上也够大；你的星球在最下面
  tall: { youAlone: true, youForward: 0.9, youDown: 3.1, youScale: 1.15, peek: 0, frontMax: 3, gap: 1.0, rowBack: 0.9, rowUp: 2.75, backMax: 4, backGap: 1.1, backDepth: 1.6, backUp: 2.9, backRowBack: 0.8, backRowUp: 2.15, arc: 0.4, arcY: 0.95, wobble: 0.1 },
};

// 竖屏：宽高比小于这个用竖排
export const TALL_BELOW = 0.95;

export function homeShape(aspect: number): HomeShape {
  return aspect < TALL_BELOW ? 'tall' : 'wide';
}

export interface HomeTeam {
  id: string;
  built: boolean; // 建好了（有作品）；false = 建设中
}

export interface HomeSlot {
  id: string;
  pos: [number, number, number]; // 世界坐标
  scale: number; // 星系里的大小（星球组的缩放）
  dim: number; // 往天色里淡多少 0..1
  tier: 'you' | 'built' | 'building';
  row: number; // 从前往后第几排（0 = 最前）
}

// 一排 n 颗的横坐标（× 半径）：居中、等距
function rowXs(n: number, spacing: number): number[] {
  return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * spacing);
}

// 把 n 颗分成几排，每排不超过 max，各排数量尽量平均（前面的排多放一颗）
export function splitRows(n: number, max: number): number[] {
  if (n <= 0) return [];
  const rows = Math.ceil(n / Math.max(1, max));
  const base = Math.floor(n / rows);
  const extra = n - base * rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

// 「你的星球」放在第一排正中（偶数颗时中间偏左那个位置）；别的按原来的顺序从中间往两边填：右、左、右、左……
export function centerOrder<T>(you: T | null, others: T[], n: number): T[] {
  const slots: Array<T | null> = Array.from({ length: n }, () => null);
  const mid = Math.floor((n - 1) / 2);
  const order = [mid];
  for (let d = 1; d < n; d++) {
    if (mid + d < n) order.push(mid + d);
    if (mid - d >= 0) order.push(mid - d);
  }
  let k = 0;
  for (const i of order) {
    if (i === mid && you !== null) slots[i] = you;
    else if (k < others.length) slots[i] = others[k++];
  }
  return slots.filter((s): s is T => s !== null);
}

// 排版：teams 按数据里的顺序给，返回同样顺序的槽位
export function homeLayout(teams: HomeTeam[], youId: string | null, shape: HomeShape, radius: number): HomeSlot[] {
  const p = HOME_LAYOUT[shape];
  const R = radius;
  const you = teams.find((t) => t.id === youId) ?? null;
  // 「你的星球」不管建没建好都在最前面正中
  const built = teams.filter((t) => t !== you && t.built);
  const building = teams.filter((t) => t !== you && !t.built);
  const out = new Map<string, HomeSlot>();
  const wob = (i: number) => Math.sin(i * 2.399 + 0.7) * p.wobble * R; // 黄金角错开：相邻两颗不一样高
  let index = 0;
  const alone = p.youAlone && you !== null;
  if (alone) out.set(you.id, { id: you.id, pos: [0, -p.youDown * R, p.youForward * R], scale: p.youScale, dim: 0, tier: 'you', row: 0 });

  // 建好的几排（第一排在 y = 0、z = 0，往后一排退 rowBack、高 rowUp）；你的星球不单独站时在第一排正中
  const builtRows = splitRows(built.length + (you && !alone ? 1 : 0), p.frontMax);
  const spacing = (2 + p.gap) * R;
  const first = alone ? 1 : 0;
  let rest = built.slice();
  builtRows.forEach((n, row) => {
    const withYou = row === 0 && you !== null && !alone;
    const members = rest.slice(0, withYou ? n - 1 : n);
    rest = rest.slice(members.length);
    const ordered = centerOrder<HomeTeam>(withYou ? you : null, members, n);
    const xs = rowXs(ordered.length, spacing);
    const half = Math.max(spacing, Math.abs(xs[0] ?? 0));
    const mid = (ordered.length - 1) / 2;
    ordered.forEach((t, i) => {
      const u = xs[i] / half;
      const isYou = t === you;
      // 你的星球单独站在前面时，正后面那颗（奇数颗的中间）抬高一点，从它上面露出来
      const peek = alone && row === 0 && i === mid ? p.peek * R : 0;
      const z = -row * p.rowBack * R - p.arc * R * u * u + (isYou ? p.youForward * R * 0.35 : 0);
      const y = row * p.rowUp * R + peek + (isYou ? 0 : wob(index)) - p.arcY * R * u * u;
      out.set(t.id, { id: t.id, pos: [xs[i], y, z], scale: isYou ? p.youScale : 1, dim: 0, tier: isYou ? 'you' : 'built', row: row + first });
      index++;
    });
  });

  // 建设中的几排：在建好的最后一排后面、更高
  const lastBuilt = Math.max(0, builtRows.length - 1);
  const z0 = -lastBuilt * p.rowBack * R - p.backDepth * R;
  const y0 = lastBuilt * p.rowUp * R + p.backUp * R;
  const s = HOME_LAYOUT.backScale;
  const backSpacing = (2 * s + p.backGap) * R;
  let left = building.slice();
  const backRows = splitRows(building.length, p.backMax);
  backRows.forEach((n, k) => {
    const members = left.slice(0, n);
    left = left.slice(n);
    // 相邻两排一样多时左右各错开 1/4 个间距：后一排从前一排的空隙里露出来（整体仍然左右对称）
    const other = backRows[k % 2 === 0 ? k + 1 : k - 1];
    const shift = other === n ? (k % 2 === 0 ? -0.25 : 0.25) * backSpacing : 0;
    const xs = rowXs(n, backSpacing).map((x) => x + shift);
    const half = Math.max(backSpacing, Math.abs(xs[0] ?? 0));
    members.forEach((t, i) => {
      const u = xs[i] / half;
      const z = z0 - k * p.backRowBack * R - p.arc * 0.6 * R * u * u;
      const y = y0 + k * p.backRowUp * R + wob(index) * 0.8 - p.arcY * 0.8 * R * u * u;
      out.set(t.id, { id: t.id, pos: [xs[i], y, z], scale: s, dim: HOME_LAYOUT.backDim, tier: 'building', row: first + builtRows.length + k });
      index++;
    });
  });
  return teams.map((t) => out.get(t.id)!);
}

// —— 镜头取景 ——

export interface HomeFit {
  fov: number; // 竖直视角（度）
  elevation: number; // 仰角（度）：镜头在版式中心的斜上方多少度
  // 画面里的安全区（NDC，-1..1）：星球和名牌都要落在里面
  left: number;
  right: number;
  top: number;
  bottom: number;
  tagPx: number; // 每颗星球下面给名牌留多高（像素）
}

export const HOME_FIT: Record<HomeShape, HomeFit> = {
  // 宽屏：左上角标题、右边缘翠宝、底下名牌和徽章
  wide: { fov: 40, elevation: 13, left: -0.84, right: 0.74, top: 0.5, bottom: -0.7, tagPx: 44 },
  // 竖屏：上面是标题（整行），右下角翠宝，左下角徽章
  tall: { fov: 46, elevation: 7, left: -0.92, right: 0.92, top: 0.5, bottom: -0.74, tagPx: 40 },
};

export interface HomeCamera {
  target: THREE.Vector3;
  position: THREE.Vector3;
  distance: number;
  fov: number;
}

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _d = new THREE.Vector3();

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// 从 eye 看向 target（上方 = 世界 +Y）时，所有星球（球心、半径）连同名牌占的画面范围（NDC）
function project(slots: Array<{ p: THREE.Vector3; r: number }>, eye: THREE.Vector3, target: THREE.Vector3, tanH: number, aspect: number, tagNdc: number, out: Bounds): Bounds {
  _f.copy(target).sub(eye).normalize();
  _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
  _u.crossVectors(_r, _f);
  out.minX = Infinity;
  out.maxX = -Infinity;
  out.minY = Infinity;
  out.maxY = -Infinity;
  for (const s of slots) {
    _d.copy(s.p).sub(eye);
    const z = Math.max(1e-3, _d.dot(_f));
    const x = _d.dot(_r) / (z * tanH * aspect);
    const y = _d.dot(_u) / (z * tanH);
    const ry = s.r / Math.sqrt(Math.max(1e-6, z * z - s.r * s.r)) / tanH; // 球的视半角
    const rx = ry / aspect;
    out.minX = Math.min(out.minX, x - rx);
    out.maxX = Math.max(out.maxX, x + rx);
    out.minY = Math.min(out.minY, y - ry - tagNdc);
    out.maxY = Math.max(out.maxY, y + ry);
  }
  return out;
}

// 取景：镜头从仰角 elevation 的方向看版式，找最近的距离，使所有星球连同名牌都放得进安全区；再平移看的点，让它们在安全区里居中。
// width / height：画布的 CSS 像素（名牌留的高度按像素算）
export function fitHomeCamera(slots: HomeSlot[], radius: number, width: number, height: number, fit: HomeFit): HomeCamera {
  const aspect = width / Math.max(1, height);
  const tanH = Math.tan(THREE.MathUtils.degToRad(fit.fov) / 2);
  const tagNdc = (fit.tagPx / Math.max(1, height)) * 2;
  const spheres = slots.map((s) => ({ p: new THREE.Vector3(...s.pos), r: radius * s.scale * 1.08 })); // 1.08：悬停放大、地形起伏
  const target = new THREE.Vector3();
  if (spheres.length) {
    const box = new THREE.Box3();
    for (const s of spheres) box.expandByPoint(s.p);
    box.getCenter(target);
  }
  const el = THREE.MathUtils.degToRad(fit.elevation);
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  const eye = new THREE.Vector3();
  const b: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const safeW = fit.right - fit.left;
  const safeH = fit.top - fit.bottom;
  const fits = (D: number) => {
    eye.copy(target).addScaledVector(dir, D);
    project(spheres, eye, target, tanH, aspect, tagNdc, b);
    return b.maxX - b.minX <= safeW && b.maxY - b.minY <= safeH;
  };
  let D = radius * 4;
  // 两轮：先找距离，再把看的点挪到让星球在安全区里居中（挪了以后透视略有变化，再找一次距离）
  for (let pass = 0; pass < 3; pass++) {
    let lo = radius * 2;
    let hi = radius * 400;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    D = hi;
    fits(D);
    const dx = (fit.left + fit.right) / 2 - (b.minX + b.maxX) / 2;
    const dy = (fit.top + fit.bottom) / 2 - (b.minY + b.maxY) / 2;
    // 画面上往右挪 dx：看的点往左挪（镜头和看的点一起平移）
    target.addScaledVector(_r, -dx * D * tanH * aspect).addScaledVector(_u, -dy * D * tanH);
  }
  return { target, position: target.clone().addScaledVector(dir, D), distance: D, fov: fit.fov };
}

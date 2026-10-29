import * as THREE from 'three/webgpu';

// 首页（星系视图，H2）的版式：螺旋星系。俯看像一个真的旋涡星系——
// - 你的星球在正中、最大（发一圈暖光，homeGalaxy.ts）
// - 别的星球沿两条对数螺旋臂从里往外排：建好的在里圈，建设中的在外圈；越往外越小、越淡
// - 每颗按团队 id 定一点随机的偏移（横着、上下），不死板；加了一颗星球，别的星球的偏移不变
// - 螺旋臂上撒星尘和小云絮（homeGalaxy.ts），星球少时也看得出两条臂
// 位置都按星球半径算（拖半径滑块时整个版式按比例变）；团队数量随便变（1–20 颗都不重叠，有单元测试）。
// 镜头（fitHomeCamera）：看向星系中心，按仰角从斜上方看；按整个圆盘（不是某个角度下的样子）取景，左右转 360° 都放得下

export type HomeShape = 'wide' | 'tall';

export const HOME_SPIRAL = {
  arms: 2, // 几条螺旋臂
  turns: 0.85, // 螺旋臂从里到外绕多少圈（星球按角度大致均匀地铺满这一段；多了接着往外排）
  inner: 3.5, // 第一颗星球离中心多远（× 半径；再近也要让开中间的你的星球）
  outer: 4.2, // 螺旋臂外端和里端的半径比（越大越「张开」）
  gap: 0.6, // 同一条臂上相邻两颗星球之间的空隙（× 两颗半径之和）
  ringGap: 0.5, // 建好的和建设中的之间多空出来一点（× 半径）：里圈、外圈分得开
  spread: 0.25, // 横着离开螺旋臂的随机偏移（× 半径）
  bob: 0.4, // 上下的随机偏移（× 半径）
  youScale: 1.75, // 你的星球放大多少
  builtScale: 1.3, // 建好的第一颗多大
  builtFalloff: 0.2, // 建好的越往外缩多少（到最外那颗缩到 1 − falloff）
  buildingScale: 0.78, // 建设中的第一颗多大
  buildingFalloff: 0.3,
  buildingDim: 0.14, // 建设中的往天色里淡多少（最里那颗）
  dimFalloff: 0.22, // 越往外再淡多少
  tallStretch: 1.45, // 手机竖屏：星系沿镜头的纵深方向拉长多少（长的方向对着竖屏）
  facing: 90, // 默认角度下，星系长的方向和画面横向差多少度（90 = 长的方向朝着镜头：两条臂的打旋看得最清楚）
  tallFacing: 90, // 手机竖屏（长的方向朝着镜头、再拉长，画面上竖着）
};

export type HomeSpiral = typeof HOME_SPIRAL;

// 竖屏：宽高比小于这个用竖屏的镜头（更高、更接近俯视）
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
  row: number; // 0 = 你的星球，1 = 建好的（里圈），2 = 建设中的（外圈）
}

// 团队 id → 0..1 的随机数（FNV-1a 哈希 + mulberry32）：同一个团队每次一样，加了别的团队也不变
function idRandom(id: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 螺旋臂上的一点（星系平面 y = 0）：arm 第几条臂，theta 沿臂转过的角度（弧度，0 = 里端）。r = r0 · e^(b·θ)
export function spiralB(p: HomeSpiral = HOME_SPIRAL): number {
  return Math.log(Math.max(1.05, p.outer)) / Math.max(0.05, p.turns * Math.PI * 2);
}

export function spiralPoint(arm: number, theta: number, r0: number, p: HomeSpiral = HOME_SPIRAL, out: { x: number; z: number; r: number; a: number } = { x: 0, z: 0, r: 0, a: 0 }) {
  const a0 = (arm / Math.max(1, Math.round(p.arms))) * Math.PI * 2 + 0.35;
  const r = r0 * Math.exp(spiralB(p) * theta);
  const a = a0 + theta;
  out.r = r;
  out.a = a;
  out.x = Math.cos(a) * r;
  out.z = Math.sin(a) * r;
  return out;
}

// 螺旋臂里端的半径（× 半径）：让开中间你的星球
export function spiralR0(radius: number, p: HomeSpiral = HOME_SPIRAL): number {
  return Math.max(p.inner, (p.youScale + p.builtScale) * (1 + p.gap) + 0.2) * radius;
}

interface Placed {
  team: HomeTeam;
  x: number;
  y: number;
  z: number;
  s: number;
  tier: HomeSlot['tier'];
}

// 排版：teams 按数据里的顺序给，返回同样顺序的槽位
// meta.rotation：整个星系在平面里转了多少（弧度）：把星系长的方向转到画面长的那一边（宽屏横着、手机竖着）；星尘跟着转同样的角度
export function homeLayout(teams: HomeTeam[], youId: string | null, shape: HomeShape, radius: number, p: HomeSpiral = HOME_SPIRAL, meta?: { rotation: number }): HomeSlot[] {
  const R = radius;
  const arms = Math.max(1, Math.round(p.arms));
  const you = teams.find((t) => t.id === youId) ?? null;
  const built = teams.filter((t) => t !== you && t.built);
  const building = teams.filter((t) => t !== you && !t.built);
  const out = new Map<string, HomeSlot>();
  const placed: Placed[] = [];
  if (you) {
    out.set(you.id, { id: you.id, pos: [0, 0, 0], scale: p.youScale, dim: 0, tier: 'you', row: 0 });
    placed.push({ team: you, x: 0, y: 0, z: 0, s: p.youScale, tier: 'you' });
  }
  const r0 = spiralR0(R, p);
  const pt = { x: 0, z: 0, r: 0, a: 0 };
  // 每条臂走到哪了（角度）、上一颗在哪、多大。每条臂上的星球按角度大致均匀地铺满一圈臂（turns），螺旋看得出来；
  // 挨得太近时再往外走（两颗半径之和 × (1 + gap)）
  const walk = Array.from({ length: arms }, () => ({ theta: 0, last: -Infinity, x: NaN, z: NaN, s: 0 }));
  const perArm = Math.max(1, Math.ceil((teams.length - (you ? 1 : 0)) / arms));
  const step = (p.turns * Math.PI * 2) / Math.max(1, perArm); // 均匀铺开时相邻两颗差多少角度
  const place = (list: HomeTeam[], tier: 'built' | 'building', minR: number): number => {
    let maxR = 0;
    list.forEach((team, i) => {
      const arm = i % arms;
      const k = list.length > 1 ? i / (list.length - 1) : 0;
      const s = tier === 'built' ? p.builtScale * (1 - p.builtFalloff * k) : p.buildingScale * (1 - p.buildingFalloff * k);
      const w = walk[arm];
      // 沿臂往外走：离上一颗至少差均匀的角度（step × 0.9）、离得够远（两颗半径之和 × (1 + gap)），而且不比 minR 近
      const need = Number.isNaN(w.x) ? 0 : (w.s + s) * R * (1 + p.gap * (shape === 'tall' ? 0.6 : 1));
      if (!Number.isNaN(w.x)) w.theta = Math.max(w.theta, w.last + step * 0.8);
      let guard = 0;
      for (;;) {
        spiralPoint(arm, w.theta, r0, p, pt);
        const far = Number.isNaN(w.x) || Math.hypot(pt.x - w.x, pt.z - w.z) >= need;
        if ((far && pt.r >= minR) || guard++ > 4000) break;
        w.theta += 0.01;
      }
      w.last = w.theta;
      const rand = idRandom(team.id);
      // 横着离开螺旋臂一点（沿半径方向）、上下错落
      const across = (rand() - 0.5) * 2 * p.spread * R;
      const x = pt.x + Math.cos(pt.a) * across;
      const z = pt.z + Math.sin(pt.a) * across;
      const y = (rand() - 0.5) * 2 * p.bob * R;
      w.x = pt.x;
      w.z = pt.z;
      w.s = s;
      const dim = tier === 'built' ? 0 : Math.min(0.7, p.buildingDim + p.dimFalloff * k);
      out.set(team.id, { id: team.id, pos: [x, y, z], scale: s, dim, tier, row: tier === 'built' ? 1 : 2 });
      placed.push({ team, x, y, z, s, tier });
      maxR = Math.max(maxR, Math.hypot(x, z) + s * R);
    });
    return maxR;
  };
  const builtR = place(built, 'built', 0);
  // 建设中的：都在建好的外面（外圈）
  place(building, 'building', built.length ? builtR + p.ringGap * R : 0);
  // 收尾：偏移以后万一挨得太近（不同臂上的、横着偏过头的），沿连线推开一点（你的星球不动）
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz) || 1e-6;
        const min = (a.s + b.s) * R * 1.18;
        if (d >= min) continue;
        const push = (min - d) / 2 + 0.01;
        const ux = dx / d;
        const uz = dz / d;
        if (a.tier === 'you') {
          b.x += ux * push * 2;
          b.z += uz * push * 2;
        } else {
          a.x -= ux * push;
          a.z -= uz * push;
          b.x += ux * push;
          b.z += uz * push;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 星系长的方向（主轴）：宽屏转到横着（x），手机转到纵深（z，画面上是竖着）；转的是整个平面，形状不变
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const q of placed) {
    sxx += q.x * q.x;
    szz += q.z * q.z;
    sxz += q.x * q.z;
  }
  const axis = placed.length > 2 ? 0.5 * Math.atan2(2 * sxz, sxx - szz) : 0;
  const rot = THREE.MathUtils.degToRad(shape === 'tall' ? p.tallFacing : p.facing) - axis;
  if (meta) meta.rotation = rot;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  // 手机竖屏：再沿纵深（z，镜头那边）拉长，长的方向对着竖屏（拉长只会让星球离得更远，不会叠起来）
  const sz = shape === 'tall' ? Math.max(1, p.tallStretch) : 1;
  for (const q of placed) {
    const s = out.get(q.team.id)!;
    s.pos = [q.x * c - q.z * sn, q.y, (q.x * sn + q.z * c) * sz];
  }
  return teams.map((t) => out.get(t.id)!);
}

// —— 镜头取景 ——

export interface HomeFit {
  fov: number; // 竖直视角（度）
  elevation: number; // 仰角（度）：从斜上方多少度看星系中心
  // 画面里能用的范围（NDC，-1..1）：星系连同名牌都要落在里面；左上角的标题卡片另外躲开（HomeCard）
  left: number;
  right: number;
  top: number;
  bottom: number;
  tagPx: number; // 每颗星球下面给名牌留多高（像素）
}

export const HOME_FIT: Record<HomeShape, HomeFit> = {
  // 宽屏：星系占满标题卡片以外的地方（宽度七八成），太挤时往右下挪、躲开左上角的标题卡片
  wide: { fov: 38, elevation: 44, left: -0.88, right: 0.78, top: 0.9, bottom: -0.84, tagPx: 30 },
  // 竖屏：更接近俯视，星系沿纵深拉长（homeLayout 的 tallStretch），长的方向对着竖屏，占满标题卡片下面
  tall: { fov: 46, elevation: 66, left: -0.95, right: 0.88, top: 0.94, bottom: -0.84, tagPx: 24 },
};

// 标题卡片在画面上占的地方（NDC）：右边、下边。星系躲开 x < right 且 y > bottom 那一块
export interface HomeCard {
  right: number;
  bottom: number;
}

export interface HomeCamera {
  target: THREE.Vector3; // 星系中心（转镜头时绕它转）
  position: THREE.Vector3;
  distance: number;
  fov: number;
  lift: number; // 画面中心比星系中心高多少（世界单位）：镜头抬头，星系在画面里往下挪
  yaw: number; // 镜头再往左转多少（弧度）：星系在画面里往右挪（躲开左上角的标题卡片）
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _d = new THREE.Vector3();

// 星系的外沿（一圈点：宽屏是圆，手机是沿纵深拉长的椭圆）连同名牌、中间你的星球，在镜头 eye 看 target 时的画面坐标（NDC）
function projectAll(points: Array<{ p: THREE.Vector3; r: number; tag: boolean }>, eye: THREE.Vector3, target: THREE.Vector3, tanH: number, aspect: number, tagNdc: number, out: Array<[number, number, number, number]>): void {
  _f.copy(target).sub(eye).normalize();
  _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
  _u.crossVectors(_r, _f);
  out.length = 0;
  for (const s of points) {
    _d.copy(s.p).sub(eye);
    const z = Math.max(1e-3, _d.dot(_f));
    const x = _d.dot(_r) / (z * tanH * aspect);
    const y = _d.dot(_u) / (z * tanH);
    const ry = s.r / Math.sqrt(Math.max(1e-6, z * z - s.r * s.r)) / tanH;
    out.push([x - ry / aspect, x + ry / aspect, y - ry - (s.tag ? tagNdc : 0), y + ry]);
  }
}

// 取景：镜头从仰角 elevation 的方向（方位角 0，+Z 那一侧）看星系中心；找最近的距离，使星系放得进画面，而且挪一挪（往右、往下）
// 能躲开左上角的标题卡片。挪是用镜头抬头（lift）、往左转（yaw）做的，绕的还是星系中心：左右转镜头时星系不会甩出去。
// width / height：画布的 CSS 像素（名牌留的高度按像素算）；card：标题卡片（NDC），没有就不躲
export function fitHomeCamera(slots: HomeSlot[], radius: number, width: number, height: number, fit: HomeFit, card: HomeCard | null = null, stretch = 1): HomeCamera {
  const aspect = width / Math.max(1, height);
  const tanH = Math.tan(THREE.MathUtils.degToRad(fit.fov) / 2);
  const tagNdc = (fit.tagPx / Math.max(1, height)) * 2;
  // 默认的角度下每颗星球（连同建好的、你的星球下面的名牌）都放得下；转到别的角度时有的会出画，拉远就看得到
  void stretch;
  const points: Array<{ p: THREE.Vector3; r: number; tag: boolean }> = slots.map((s) => ({ p: new THREE.Vector3(...s.pos), r: radius * s.scale * 1.1, tag: s.tier !== 'building' }));
  if (!points.length) points.push({ p: new THREE.Vector3(), r: radius, tag: true });
  const target = new THREE.Vector3(0, 0, 0);
  const el = THREE.MathUtils.degToRad(fit.elevation);
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  const eye = new THREE.Vector3();
  const boxes: Array<[number, number, number, number]> = [];
  // 距离 D 时能不能放下：返回往右、往上挪多少（NDC），放不下返回 null
  const place = (D: number): [number, number] | null => {
    eye.copy(target).addScaledVector(dir, D);
    projectAll(points, eye, target, tanH, aspect, tagNdc, boxes);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x0, x1, y0, y1] of boxes) {
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y1);
    }
    if (maxX - minX > fit.right - fit.left || maxY - minY > fit.top - fit.bottom) return null;
    // 先居中；躲不开标题卡片时往右、往下挪（挪得最少的那个）
    const dx0 = (fit.left + fit.right) / 2 - (minX + maxX) / 2;
    const dy0 = (fit.top + fit.bottom) / 2 - (minY + maxY) / 2;
    const dxMax = fit.right - maxX;
    const dyMin = fit.bottom - minY;
    const clear = (dx: number, dy: number): boolean => {
      if (!card) return true;
      for (const [x0, , , y1] of boxes) if (x0 + dx < card.right && y1 + dy > card.bottom) return false;
      return true;
    };
    let best: [number, number] | null = null;
    let cost = Infinity;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const dx = dx0 + ((dxMax - dx0) * i) / 8;
        const dy = dy0 + ((dyMin - dy0) * j) / 8;
        const c = (dx - dx0) ** 2 + (dy - dy0) ** 2;
        if (c < cost && clear(dx, dy)) {
          cost = c;
          best = [dx, dy];
        }
      }
    }
    return best;
  };
  let lo = radius * 2;
  let hi = radius * 600;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (place(mid)) hi = mid;
    else lo = mid;
  }
  const D = hi;
  const [dx, dy] = place(D) ?? [0, 0];
  // 画面上挪 (dx, dy)：往上抬头（lift 为正时内容往下）、往左转（yaw 为正时内容往右）
  const lift = -dy * D * tanH;
  const yaw = Math.atan(dx * tanH * aspect);
  return { target, position: target.clone().addScaledVector(dir, D), distance: D, fov: fit.fov, lift, yaw };
}

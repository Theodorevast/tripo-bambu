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
  turns: 0.9, // 螺旋臂从里到外绕多少圈（星尘画到这里；星球多了会接着往外排）
  inner: 2.2, // 第一颗星球离中心多远（× 半径；再近也要让开中间的你的星球）
  outer: 3.0, // 螺旋臂外端和里端的半径比（越大越「张开」）
  gap: 0.3, // 同一条臂上相邻两颗星球之间的空隙（× 两颗半径之和）
  ringGap: 0.2, // 建好的和建设中的之间多空出来一点（× 半径）：里圈、外圈分得开
  spread: 0.22, // 横着离开螺旋臂的随机偏移（× 半径）
  bob: 0.45, // 上下的随机偏移（× 半径）
  youScale: 1.5, // 你的星球放大多少
  builtScale: 1.0, // 建好的第一颗多大
  builtFalloff: 0.22, // 建好的越往外缩多少（到最外那颗缩到 1 − falloff）
  buildingScale: 0.66, // 建设中的第一颗多大
  buildingFalloff: 0.3,
  buildingDim: 0.16, // 建设中的往天色里淡多少（最里那颗）
  dimFalloff: 0.24, // 越往外再淡多少
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
export function homeLayout(teams: HomeTeam[], youId: string | null, _shape: HomeShape, radius: number, p: HomeSpiral = HOME_SPIRAL): HomeSlot[] {
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
      const need = Number.isNaN(w.x) ? 0 : (w.s + s) * R * (1 + p.gap);
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
  for (const q of placed) {
    const s = out.get(q.team.id)!;
    s.pos = [q.x, q.y, q.z];
  }
  return teams.map((t) => out.get(t.id)!);
}

// —— 镜头取景 ——

export interface HomeFit {
  fov: number; // 竖直视角（度）
  elevation: number; // 仰角（度）：从斜上方多少度看星系中心
  // 画面里的安全区（NDC，-1..1）：整个星系（转到哪个角度都一样）连同名牌都要落在里面
  left: number;
  right: number;
  top: number;
  bottom: number;
  tagPx: number; // 每颗星球下面给名牌留多高（像素）
}

export const HOME_FIT: Record<HomeShape, HomeFit> = {
  // 宽屏：左上角标题卡片（上沿由 World 按卡片的实际高度再压低）、右下角翠宝、左下角徽章
  wide: { fov: 38, elevation: 50, left: -0.8, right: 0.8, top: 0.62, bottom: -0.88, tagPx: 30 },
  // 竖屏：更接近俯视，星系是一个差不多圆的盘，横着撑满
  tall: { fov: 46, elevation: 64, left: -0.96, right: 0.96, top: 0.5, bottom: -0.8, tagPx: 24 },
};

export interface HomeCamera {
  target: THREE.Vector3; // 星系中心（转镜头时绕它转）
  position: THREE.Vector3;
  distance: number;
  fov: number;
  lift: number; // 画面中心比星系中心高多少（世界单位）：星系在画面里往下挪，让开上面的标题卡片
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// 镜头在 eye、看向 target、再抬头 atan(lift / 距离) 时，这些点（球心、半径）和下面的名牌在画面上占的范围（NDC）
function project(points: Array<{ p: THREE.Vector3; r: number; tag: boolean }>, eye: THREE.Vector3, target: THREE.Vector3, lift: number, tanH: number, aspect: number, tagNdc: number, out: Bounds): Bounds {
  _f.copy(target).sub(eye);
  const dist = _f.length();
  _f.divideScalar(dist || 1);
  _r.crossVectors(_f, THREE.Object3D.DEFAULT_UP).normalize();
  _u.crossVectors(_r, _f);
  const pitch = Math.atan2(lift, dist || 1);
  _q.setFromAxisAngle(_r, pitch);
  _f.applyQuaternion(_q);
  _u.applyQuaternion(_q);
  out.minX = Infinity;
  out.maxX = -Infinity;
  out.minY = Infinity;
  out.maxY = -Infinity;
  for (const s of points) {
    _d.copy(s.p).sub(eye);
    const z = Math.max(1e-3, _d.dot(_f));
    const x = _d.dot(_r) / (z * tanH * aspect);
    const y = _d.dot(_u) / (z * tanH);
    const ry = s.r / Math.sqrt(Math.max(1e-6, z * z - s.r * s.r)) / tanH;
    const rx = ry / aspect;
    out.minX = Math.min(out.minX, x - rx);
    out.maxX = Math.max(out.maxX, x + rx);
    out.minY = Math.min(out.minY, y - ry - (s.tag ? tagNdc : 0));
    out.maxY = Math.max(out.maxY, y + ry);
  }
  return out;
}

// 取景：镜头从仰角 elevation 的方向（方位角 0，+Z 那一侧）看星系中心，找最近的距离，使整个星系放得进安全区；再用抬头（lift）
// 把它在安全区里上下居中。按「圆盘」算：星系外圈半径上一圈点，左右转到哪个角度画面里都放得下。
// width / height：画布的 CSS 像素（名牌留的高度按像素算）
export function fitHomeCamera(slots: HomeSlot[], radius: number, width: number, height: number, fit: HomeFit): HomeCamera {
  const aspect = width / Math.max(1, height);
  const tanH = Math.tan(THREE.MathUtils.degToRad(fit.fov) / 2);
  const tagNdc = (fit.tagPx / Math.max(1, height)) * 2;
  let disc = radius * 2;
  let yMin = -radius;
  let yMax = radius;
  for (const s of slots) {
    disc = Math.max(disc, Math.hypot(s.pos[0], s.pos[2]) + radius * s.scale * 1.1);
    yMin = Math.min(yMin, s.pos[1] - radius * s.scale);
    yMax = Math.max(yMax, s.pos[1] + radius * s.scale);
  }
  // 外圈一圈点（星球那么大的球，带名牌）+ 中间你的星球
  const points: Array<{ p: THREE.Vector3; r: number; tag: boolean }> = [];
  const ringR = disc - radius * 0.8;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    points.push({ p: new THREE.Vector3(Math.cos(a) * ringR, (yMin + yMax) / 2, Math.sin(a) * ringR), r: radius * 0.8, tag: false });
  }
  const center = slots.find((s) => s.tier === 'you');
  points.push({ p: new THREE.Vector3(0, 0, 0), r: radius * (center?.scale ?? 1) * 1.08, tag: true });
  const target = new THREE.Vector3(0, 0, 0);
  const el = THREE.MathUtils.degToRad(fit.elevation);
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  const eye = new THREE.Vector3();
  const b: Bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const safeW = fit.right - fit.left;
  const safeH = fit.top - fit.bottom;
  let lift = 0;
  const fits = (D: number) => {
    eye.copy(target).addScaledVector(dir, D);
    project(points, eye, target, lift, tanH, aspect, tagNdc, b);
    return b.maxX - b.minX <= safeW && b.maxY - b.minY <= safeH;
  };
  let D = radius * 10;
  for (let pass = 0; pass < 4; pass++) {
    let lo = radius * 2;
    let hi = radius * 600;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    D = hi;
    fits(D);
    // 上下居中：抬头把画面往下挪（lift 变大，星系在画面里往下）
    const dy = (b.minY + b.maxY) / 2 - (fit.top + fit.bottom) / 2;
    lift += dy * D * tanH;
  }
  return { target, position: target.clone().addScaledVector(dir, D), distance: D, fov: fit.fov, lift };
}

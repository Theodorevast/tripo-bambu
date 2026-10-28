import * as THREE from 'three/webgpu';
import { atan, cos, dot, exp, float, floor, Fn, fract, If, length, max, min, mix, normalize, positionGeometry, screenSize, screenUV, select, sin, smoothstep, sqrt, uniform, vec2, vec3, vec4 } from 'three/tsl';

// 转场的云层：画面最上面盖一层全屏的云，从画面边缘涌进来、把画面全遮住、再散开。
// 画法跟着新画风走（和云海同一套颜色，绘本式的大块积云，不描线）：
// - 每个云团当成一个鼓起来的半球来打光：光从右上方来，受光的一侧是云海的亮面色（暖奶油），往背光一侧依次是中间调（粉灰）、
//   背光色（灰紫）、最深的缝隙色（蓝灰）。几个云团叠在一起时按高度做软的混合（softmax，云团边上那一圈分量小），
//   交界处是柔和的过渡，没有硬的折线，也不描线。
// - 主云团朝外的一侧再鼓出几个小云团（菜花边），轮廓是一串大小不一的圆包；边缘柔化几个像素、带一点低频的抖动（水彩的边）；
//   表面有很淡的笔触起伏（法线上加一点低频噪声）和大块的斑驳明暗。
// - 两层：后面一层颜色往天空色靠（隔着空气），先到后走；前面一层是正常的云。
// 两种形状：
// - iris：围着一个中心合拢的一圈云（洞的边缘一圈云团，后面一圈更大的云团叠在云墙上）：进星球、回星系；
// - band：一条云带从画面一侧横扫到另一侧（两条边都是云团）：星球之间甩镜跳过去。
// 另外两样：翠宝黄的光扫过云层（≤ 150 ms，照亮云团鼓起来的受光面，不是一块贴上去的色带），减弱动效时整屏淡到云的颜色。
// 画法：一个全屏三角形（不经过镜头投影），挂在主场景里最后画（透明、不做深度测试）；只在转场时显示（director.ts 管显隐），
// 平时不画、没有开销。颜色是线性的、曝光前的值：场景画完后和别的东西一起经过同一次色调映射（AgX）和曝光，和云海一致。
// 参数每帧由 scenes/transition.ts 算好写进 VEIL_U，不重新编译着色器

// 画面坐标：高 = 1，原点在画面中心，x 朝右、y 朝上（宽度按宽高比）
export const VEIL_U = {
  on: uniform(0), // 1：这一帧要画云（0 时整段跳过）
  band: uniform(0), // 0：iris；1：band
  center: uniform(new THREE.Vector2()), // iris 的中心
  dir: uniform(new THREE.Vector2(-1, 0)), // band 移动的方向（单位向量）
  // 每层：iris 时 x = 洞的半径；band 时 x = 前沿、y = 后沿（都沿 dir 量）；z = 云团大小（1 = 默认）；w = 云团排布的转角或错位
  front: uniform(new THREE.Vector4(9, -9, 1, 0)),
  back: uniform(new THREE.Vector4(9, -9, 1, 0)),
  flash: uniform(new THREE.Vector2(0, 0)), // x = 光带的位置（沿光带的法线量），y = 浓淡（0 不画）
  fade: uniform(0), // 淡入淡出：整屏混进云的颜色
  clock: uniform(0), // 云团慢慢鼓动用的时钟（按转场的时间走：逐帧录屏时也是确定的）
  // 颜色（线性、曝光前，可以大于 1）：转场开始时按当前的天空预设取云海的颜色（director.ts），默认是白天
  lit: uniform(new THREE.Vector3(1.68, 1.4, 0.74)),
  mid: uniform(new THREE.Vector3(0.6, 0.45, 0.42)),
  shade: uniform(new THREE.Vector3(0.2, 0.18, 0.27)),
  deep: uniform(new THREE.Vector3(0.095, 0.11, 0.22)),
  sky: uniform(new THREE.Vector3(0.62, 0.6, 0.55)), // 后面那层往这个颜色靠（地平线的天空色）
  gold: uniform(new THREE.Vector3(2.4, 1.25, 0.03)), // 翠宝黄的光（#F2B705 在曝光、AgX 之后还看得出是黄，不冲成白）
};

const FRONT_PUFFS = 16; // iris 一圈几个云团（前后两层个数不同，叠起来不规整）
const BACK_PUFFS = 12;
// 光从右上方、朝着镜头这边照过来（单位向量，在 JS 里先算好：写成 normalize() 的话，它第一次出现在 iris / band 某个分支里时
// 只在那个分支里赋值，另一个分支读到的是 0，整层云都变成暗面色）
const LIGHT = vec3(0.5014, 0.6217, 0.6017);
const FLASH_NORMAL = vec2(0.866, -0.5); // 光带斜着（和 logo 里 T 的竖笔差不多的斜度），沿这个方向扫过去
const NONE = -1000; // 「这个云团不在这里」的高度
// 主云团朝外鼓出的小云团（菜花边）：相对朝外方向的转角、圆心离主云团圆心多远、半径、往镜头抬多少（都按主云团半径）
const BUDS = [
  { turn: -0.85, at: 0.72, r: 0.42, z: 0.42 },
  { turn: 0, at: 0.6, r: 0.47, z: 0.5 },
  { turn: 0.85, at: 0.72, r: 0.42, z: 0.42 },
] as const;

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

const hash = (n: F, seed: number) => fract(sin(n.mul(12.9898).add(seed * 78.233)).mul(43758.5453));

// 二维值噪声（0..1，平滑）：笔触、斑驳、边缘的抖动
function vnoise(p: V2): F {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const h = (q: V2) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453));
  const a = h(i);
  const b = h(i.add(vec2(1, 0)));
  const c = h(i.add(vec2(0, 1)));
  const d = h(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// iris 一圈相邻云团圆心之间的距离（弦长）：云团大小按它定，洞大时云团大（离镜头近），洞合拢时云团挤小
const irisSpacing = (hole: F, count: number) => hole.max(0).add(0.06).mul((Math.PI * 2) / count);

// 一层云在某个像素上的累计：按高度做 softmax（m 最高的高度，s = Σ exp((h - m)/k)，sw = 同样权重下的受光量之和），
// d 到这层云边界的有向距离（< 0 在云里）
interface Acc {
  m: F;
  s: F;
  sw: F;
  d: F;
}

function acc(): Acc {
  return { m: float(NONE).toVar(), s: float(0).toVar(), sw: float(0).toVar(), d: float(1000).toVar() };
}

// 加一个面：高度 h（NONE 表示不在这里）、受光量 w。k 是混合的软硬（高度差几个 k 以外就只看高的那个）；
// weight：这个面自己的分量（云团边上那一圈小，往中间变大：一个云团压到另一个上面时，交界是渐变的，不是一圈圆的接缝）
function blend(a: Acc, h: F, w: F, k: F, weight: F): void {
  const m2 = max(a.m, h).toVar();
  const keep = exp(a.m.sub(m2).div(k));
  const e = select(h.greaterThan(NONE * 0.5), exp(h.sub(m2).div(k)).mul(weight), float(0)).toVar();
  a.s.assign(a.s.mul(keep).add(e));
  a.sw.assign(a.sw.mul(keep).add(e.mul(w)));
  a.m.assign(m2);
}

// 受光量：法线点乘光的方向，包一点（wrap），暗部不死黑
const lightOf = (n: V3) => dot(normalize(n), LIGHT).mul(0.72).add(0.3);

// 一个云团：圆心 c、半径 r，整体往镜头这边抬 z。当成半球：高度 z + r·√(1 − q²)，法线就是球面法线（加一点笔触的起伏 tilt）。
// feather 以内也算在云团上（柔边那一圈也按这个云团的边缘打光，不会在亮边外面多出一圈别的颜色）。
// rot：在 band 的局部坐标里算时，法线转回画面坐标用的方向（x 轴）
function puff(a: Acc, p: V2, c: V2, r: F, z: F, feather: F, k: F, tilt: V2, rot: V2 | null): void {
  const q = p.sub(c).div(r).toVar();
  const len = length(q).toVar();
  const dist = len.sub(1).mul(r).toVar();
  a.d.assign(min(a.d, dist));
  const qn = q.div(max(len, 1));
  const nz = sqrt(max(float(1).sub(dot(qn, qn)), 0));
  const nl = qn.add(tilt);
  const nxy = rot ? vec2(nl.x.mul(rot.x).sub(nl.y.mul(rot.y)), nl.x.mul(rot.y).add(nl.y.mul(rot.x))) : nl;
  const h = select(dist.lessThan(feather), z.add(r.mul(nz)), float(NONE));
  // 分量：往边上变小，到柔边的外沿正好是 0（不然这个云团在柔边外沿一下子消失，颜色跳一下，看起来是一圈亮边）
  blend(a, h, lightOf(vec3(nxy, nz)), k, smoothstep(0, 0.45, nz).mul(0.92).add(0.08).mul(smoothstep(feather, feather.negate(), dist)));
}

// 云墙（云团后面成片的云）：高度 0、法线朝镜头（带笔触起伏）。edge：到墙边的有向距离（< 0 在墙里）；
// body：墙面大块的明暗起伏（在云里面时整屏都是墙，不能是一块平的颜色）
function wall(a: Acc, edge: F, feather: F, k: F, tilt: V2, body: F): void {
  a.d.assign(min(a.d, edge));
  blend(a, select(edge.lessThan(feather), float(0), float(NONE)), lightOf(vec3(tilt.mul(1.6), 1)).add(body), k, smoothstep(feather, k.mul(-3), edge));
}

// iris：洞外面整片是云墙；洞的边上一圈云团（圆心就在洞边上，前后错一点），往洞里鼓出一个个圆包，每个再鼓出几个小包；
// 云团半径是弦长的 0.58–0.88 倍，相邻的一定叠上。后面再一圈更大的云团（错开半格）叠在墙上，墙不是一整块平的。
// 洞的大小、云团大小和 transition.ts 的 irisClearRadius 对得上（最里面的那圈决定云什么时候完全出画）
function irisLayer(a: Acc, p: V2, prm: V4, seed: number, count: number, feather: F, tilt: V2, body: F): void {
  const step = (Math.PI * 2) / count;
  const hole = prm.x.toVar();
  const spacing = irisSpacing(hole, count).mul(prm.z).toVar();
  const k = spacing.mul(0.14).toVar();
  const r = length(p).toVar();
  // 离洞边太远（洞的中间）：这层云肯定不在这里，整段跳过
  If(r.greaterThan(hole.sub(spacing.mul(1.4))), () => {
    const ang = atan(p.y, p.x).sub(prm.w).toVar();
    wall(a, hole.add(spacing.mul(0.25)).sub(r), feather, k, tilt, body);
    for (const ring of [0, 1]) {
      const kc = floor(ang.div(step).sub(ring * 0.5));
      for (const j of [-1, 0, 1]) {
        const kk = kc.add(j);
        const idx = kk.sub(floor(kk.div(count)).mul(count)); // 绕一圈回到同一个云团（哈希不出接缝）
        const s = seed + ring * 31;
        const ac = kk.add(0.5 + ring * 0.5).add(hash(idx, s).sub(0.5).mul(0.16)).mul(step).add(prm.w);
        const out = vec2(cos(ac), sin(ac));
        if (ring === 0) {
          const rad = spacing.mul(hash(idx, s + 7).mul(0.3).add(0.58)).toVar();
          const c = out.mul(hole.add(rad.mul(hash(idx, s + 13).sub(0.5).mul(0.3)))).toVar();
          const z = spacing.mul(hash(idx, s + 17).mul(0.2).add(0.25)).toVar();
          puff(a, p, c, rad, z, feather, k, tilt, null);
          // 朝洞里（画面上看得见的那一侧）鼓出的小包
          for (const bud of BUDS) {
            const t = bud.turn + (ring === 0 ? 0 : 0);
            const ab = ac.add(Math.PI + t);
            const cb = c.add(vec2(cos(ab), sin(ab)).mul(rad.mul(bud.at)));
            puff(a, p, cb, rad.mul(bud.r), z.add(rad.mul(bud.z)), feather, k, tilt, null);
          }
        } else {
          const rad = spacing.mul(hash(idx, s + 7).mul(0.45).add(0.85));
          const c = out.mul(hole.add(spacing.mul(hash(idx, s + 13).mul(0.4).add(1))));
          puff(a, p, c, rad, spacing.mul(hash(idx, s + 17).mul(0.12)), feather, k, tilt, null);
        }
      }
    }
  });
}

// band：沿 dir 在 [后沿, 前沿] 之间是云墙，两条边上各排一列云团（沿边的方向按格子重复，只看相邻三格），
// 前沿（扫过来的那一边）的云团再鼓出小包。云团的位置、大小和 transition.ts 的 bandLayer 对得上
function bandLayer(a: Acc, p: V2, prm: V4, seed: number, feather: F, tilt: V2, body: F): void {
  const dir = VEIL_U.dir;
  const x = dot(p, dir).toVar();
  const y = dot(p, vec2(dir.y.negate(), dir.x)).add(prm.w).toVar();
  const q = vec2(x, y).toVar();
  const size = prm.z.mul(0.16).toVar();
  const k = size.mul(0.16).toVar();
  // 离两条边都远（云带外面）：整段跳过
  If(x.lessThan(prm.x.add(size.mul(1.6))).and(x.greaterThan(prm.y.sub(size.mul(1.6)))), () => {
    const spacing = size.mul(1.45);
    const kc = floor(y.div(spacing));
    wall(a, max(x.sub(prm.x), prm.y.sub(x)), feather, k, tilt, body);
    for (const j of [-1, 0, 1]) {
      const kk = kc.add(j);
      const yc = kk.add(0.5).add(hash(kk, seed).sub(0.5).mul(0.5)).mul(spacing);
      const rLead = size.mul(hash(kk, seed + 3).mul(0.5).add(0.75)).toVar();
      const rTrail = size.mul(hash(kk, seed + 5).mul(0.5).add(0.75));
      const lead = vec2(prm.x.sub(rLead.mul(0.4)).add(hash(kk, seed + 9).sub(0.5).mul(rLead.mul(0.6))), yc).toVar();
      const trail = vec2(prm.y.add(rTrail.mul(0.4)).sub(hash(kk, seed + 11).sub(0.5).mul(rTrail.mul(0.6))), yc);
      const zLead = size.mul(hash(kk, seed + 13).mul(0.2).add(0.2)).toVar();
      puff(a, q, lead, rLead, zLead, feather, k, tilt, dir);
      puff(a, q, trail, rTrail, size.mul(hash(kk, seed + 15).mul(0.2).add(0.2)), feather, k, tilt, dir);
      // 前沿朝外（+x）鼓出的小包（两侧的两个）
      for (const bud of [BUDS[0], BUDS[2]]) {
        const cb = lead.add(vec2(Math.cos(bud.turn), Math.sin(bud.turn)).mul(rLead.mul(bud.at)));
        puff(a, q, cb, rLead.mul(bud.r), zLead.add(rLead.mul(bud.z)), feather, k, tilt, dir);
      }
    }
  });
}

// 每个像素的一份噪声（两层共用，省一半的噪声计算）：边缘的抖动、笔触（法线的起伏）、云墙大块的明暗、斑驳
interface Grain {
  wobble: F;
  tilt: V2;
  body: F;
  mottle: F;
}

function grainAt(p: V2): Grain {
  const n1 = vnoise(p.mul(7)).toVar();
  const n2 = vnoise(p.mul(7).add(17.3)).toVar();
  const n3 = vnoise(p.mul(1.6).add(5.1)).toVar();
  const n4 = vnoise(p.mul(3.7).add(9.7)).toVar();
  return {
    // 边缘的抖动：水彩的边（两个中频噪声拼一下，省一次）
    wobble: n1.add(n4).sub(1).mul(0.0065).toVar(),
    // 笔触：法线上加一点低频起伏（大块的、柔和的，像刷子刷出来的明暗）
    tilt: vec2(n1, n2).sub(0.5).mul(0.42).toVar(),
    // 云墙大块的明暗：两层低频噪声（在云里面、整屏都是墙的时候也有大团的亮和暗）
    body: n3.sub(0.5).mul(0.36).add(n4.sub(0.5).mul(0.14)).toVar(),
    mottle: n3.add(n2).sub(1).mul(0.11).toVar(),
  };
}

// 远的那层用同一份噪声，分量换个位置（看不出是同一份）
const swapGrain = (g: Grain): Grain => ({ wobble: g.wobble.negate(), tilt: vec2(g.tilt.y, g.tilt.x.negate()), body: g.mottle.mul(1.6), mottle: g.body.mul(0.45) });

// 一层云：返回线性颜色、覆盖度（0..1）和受光量（光带按它亮）。tint：往天空色靠多少（远的那层）；beat：鼓动的节奏
function cloudLayer(p: V2, prmIn: V4, seed: number, count: number, px: F, tint: number, beat: number, grain: Grain): { rgb: V3; alpha: F; w: F } {
  // 云团慢慢鼓动：大小随时间起伏几个百分点（两层节奏不同）。
  // 在两个分支（iris / band）外面先算好、存成变量：TSL 把第一次用到的子表达式就地生成，要是第一次出现在某个分支里，
  // 另一个分支走到时它就是没赋过值的（T2 实测 band 模式下近的那层整个画错）
  const prm = vec4(prmIn.x, prmIn.y, prmIn.z.mul(sin(VEIL_U.clock.mul(beat)).mul(0.035).add(1)), prmIn.w).toVar();
  // 边缘的柔化宽度：两个多像素 + 一点点按云团大小的晕开；边缘再按低频噪声轻轻抖一下（水彩的边）
  const feather = px.mul(2.2).add(prm.z.mul(0.003)).toVar();
  const { wobble, tilt, body } = grain;
  const a = acc();
  If(VEIL_U.band.greaterThan(0.5), () => {
    bandLayer(a, p, prm, seed, feather, tilt, body);
  }).Else(() => {
    irisLayer(a, p, prm, seed, count, feather, tilt, body);
  });
  // 大块的斑驳明暗（很淡）
  const mottle = grain.mottle;
  const w = a.sw.div(max(a.s, 1e-6)).add(mottle).clamp(0, 1).toVar();
  const deep = mix(VEIL_U.deep, VEIL_U.sky, tint * 0.9);
  const shade = mix(VEIL_U.shade, VEIL_U.sky, tint * 0.75);
  const mid = mix(VEIL_U.mid, VEIL_U.sky, tint * 0.55);
  const lit = mix(VEIL_U.lit, VEIL_U.sky, tint * 0.35);
  const c0 = mix(deep, shade, smoothstep(0.04, 0.36, w));
  const c1 = mix(c0, mid, smoothstep(0.3, 0.58, w));
  const c2 = mix(c1, lit, smoothstep(0.52, 0.86, w));
  const rgb = c2;
  const alpha = smoothstep(feather, feather.negate(), a.d.add(wobble));
  return { rgb, alpha, w };
}

// 全屏三角形的颜色：两层云（近的压在远的上面）、翠宝黄的光、淡入淡出
const veilColor = Fn(() => {
  const out = vec4(0, 0, 0, 0).toVar();
  If(VEIL_U.on.greaterThan(0.5), () => {
    const st = screenUV;
    const aspect = screenSize.x.div(screenSize.y);
    const px = float(1).div(screenSize.y).toVar(); // 一个像素在画面坐标里多大
    // 同上：分支外面先存成变量
    const p = vec2(st.x.sub(0.5).mul(aspect), float(0.5).sub(st.y)).toVar();
    const q = p.sub(VEIL_U.center.mul(float(1).sub(VEIL_U.band))).toVar();
    const rgb = vec3(0).toVar();
    const alpha = float(0).toVar();
    // 粗判：iris 时离中心比两层的洞都近得多的像素（洞的中间）肯定没有云，整段跳过（云刚涌进来时画面大半是这样）。
    // 洞边上的云团最多往里鼓 1.32 个弦长（transition.ts 的 irisClearRadius），再留一点鼓动的余量
    const r = length(q);
    const reach = (prm: V4, count: number) => prm.x.sub(irisSpacing(prm.x, count).mul(prm.z).mul(1.45));
    const maybe = VEIL_U.band.greaterThan(0.5).or(r.greaterThan(min(reach(VEIL_U.front, FRONT_PUFFS), reach(VEIL_U.back, BACK_PUFFS))));
    If(maybe, () => {
      const grain = grainAt(q);
      const f = cloudLayer(q, VEIL_U.front, 1.7, FRONT_PUFFS, px, 0, 5.3, grain);
      const fAlpha = f.alpha.toVar();
      const fRgb = f.rgb.toVar();
      const fW = f.w.toVar();
      // 远的那层：近的那层已经完全盖住的地方（全遮住时画面四周那一圈）不用算
      const b = { rgb: vec3(0).toVar(), alpha: float(0).toVar(), w: float(0).toVar() };
      If(fAlpha.lessThan(0.999), () => {
        const back = cloudLayer(q, VEIL_U.back, 3.1, BACK_PUFFS, px, 0.3, 4.1, swapGrain(grain));
        b.rgb.assign(back.rgb);
        b.alpha.assign(back.alpha);
        b.w.assign(back.w);
      });
      // 近的压在远的上面（over）
      alpha.assign(fAlpha.add(b.alpha.mul(float(1).sub(fAlpha))));
      rgb.assign(fRgb.mul(fAlpha).add(b.rgb.mul(b.alpha).mul(float(1).sub(fAlpha))).div(max(alpha, 1e-4)));
      const lit = mix(b.w, fW, fAlpha);
      // 翠宝黄的光：一宽一窄两道，斜着扫过云层，边是软的；照亮云团鼓起来的受光面（暗面只亮一点），像一道阳光掠过云顶
      const s = dot(p, FLASH_NORMAL).sub(VEIL_U.flash.x);
      const wide = float(1).sub(smoothstep(0.02, 0.075, s.abs()));
      const thin = float(1).sub(smoothstep(0.004, 0.02, s.add(0.1).abs())).mul(0.75);
      const glow = max(wide, thin).mul(VEIL_U.flash.y).mul(alpha).mul(lit.mul(0.75).add(0.25)).toVar();
      rgb.assign(mix(rgb, VEIL_U.gold, glow.mul(0.6)).add(VEIL_U.gold.mul(glow.mul(0.15))));
    });
    // 减弱动效：整屏淡到云的亮面和中间调之间的颜色
    rgb.assign(mix(rgb, mix(VEIL_U.mid, VEIL_U.lit, 0.7), VEIL_U.fade));
    alpha.assign(max(alpha, VEIL_U.fade));
    out.assign(vec4(rgb, alpha));
  });
  return out;
});

// 全屏三角形：顶点直接给裁剪空间坐标（不经过镜头），透明、不做深度测试、最后画；不投影、不雾化、射线打不中
export function createVeil(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const material = new THREE.NodeMaterial();
  material.name = 'transition-veil';
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = veilColor();
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.side = THREE.DoubleSide;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'transition-veil';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  return mesh;
}

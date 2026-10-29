import { clamp01, easeInOutCubic, easeOutCubic, smooth, span } from '../scenes/ease';

// 点翠宝吐优惠券（coupons）：时长、幅度、手感参数和纯函数（不碰 three，单元测试直接测）。
// 节奏是「蓄力 → 吐出 → 落地」：
//   （漫游时先转身对着镜头）→ 蓄力：往下压扁、身体发抖、logo 越来越亮 → 弹起：从压扁弹到拉长、往上一蹦，
//   弹到一半从 logo 上方喷出 3–5 张券、一团彩屑、「啵」一声 → 回弹：落回地面，身子按衰减的弹簧回到原样 → 开心地左右晃两下 → （转回去）
// 券沿抛物线飞出去，边飞边翻、快落地时像纸片一样左右飘，轻轻停在草上方，慢慢转、微微发光；没捡的过 life 秒淡出。
// 所有时长都在 ?tune → Coupons（couponsTune.ts），改了下一次就用新值

export const COUPONS = {
  // —— 翠宝 ——
  turn: 0.22, // 漫游时先转身对着镜头（秒；本来就对着镜头时不转）
  charge: 0.25, // 蓄力
  squash: 0.24, // 蓄力压扁多少（竖着缩到 1 − squash）
  tremble: 0.018, // 蓄力时左右发抖的幅度（× 身高）
  spring: 0.15, // 从压扁弹到拉长
  stretch: 0.2, // 弹起时拉长多少（竖着伸到 1 + stretch）
  hop: 0.14, // 弹起时离地多高（× 身高）
  launchAt: 0.45, // 弹起到这个比例时开始吐券
  recover: 0.55, // 回弹：落回地面、衰减的弹簧回到原样
  wiggle: 0.7, // 开心地晃两下
  wiggleAngle: 10, // 晃的角度（度）
  shakeSeconds: 0.6, // 冷却中再点：摇头
  shakeAngle: 22, // 摇头的角度（度）
  hoverSquash: 0.07, // 指针悬停时轻轻一缩（竖着缩多少）
  glow: 2.2, // logo 亮一下的强度（自发光 × 原色）
  cooldown: 3, // 吐完以后多久之内再点只摇头（秒，从券飞出去算起）
  // —— 券 ——
  countMin: 3,
  countMax: 5,
  stagger: 0.06, // 一张接一张喷出来的间隔（秒）
  flight: 0.95, // 在空中飞多久（秒，每张再随机 ±12%）
  arc: 0.85, // 抛物线比出口高多少（米，按身高 1 米）
  spread: 1.35, // 落点离翠宝多远（米）
  fan: 150, // 落点在正前方左右张开多少度
  flips: 2, // 飞的时候翻几圈
  flutter: 0.16, // 快落地时左右飘的幅度（米）
  hover: 0.42, // 落地后浮在离地多高（米：草高约 0.3）
  bob: 0.035, // 浮着时上下起伏（米）
  spin: 0.55, // 浮着时慢慢转（弧度 / 秒）
  size: 0.5, // 券的长边（米）
  life: 10, // 落地后多久没捡就淡出（秒）
  fade: 0.7, // 淡出用多久（秒）
  confetti: 28, // 一团彩屑和星星有几粒
  // —— 捡券 ——
  pickup: 0.5, // 飞向镜头（秒）
  cardPx: 360, // 券飞到镜头前时在画面上多宽（像素，和卡片上的券一样大）
  // —— 星球视图：作品放大多少，站桩翠宝和券跟着放大（再乘 boost） ——
  boost: 1.2,
  volume: 0.5, // 音量（0 关）
};

export type CouponParams = typeof COUPONS;

// 翠宝这一帧的姿态（叠在它自己的站姿、走路动作上面）。缩放以脚底为原点
export interface TribooPose {
  sy: number; // 竖着的缩放
  sxz: number; // 横着的缩放（体积大致不变）
  lift: number; // 离地（× 身高）
  roll: number; // 左右晃（弧度，绕前后轴；正的往右歪）
  pitch: number; // 前后探（弧度，绕左右轴；正的往前探）
  yaw: number; // 摇头（弧度，绕上下轴）
  jitter: number; // 发抖：往左右偏（× 身高）
  glow: number; // logo 亮度 0..1
  face: number; // 转向镜头的程度 0..1（漫游时用）
}

export function restPose(out: TribooPose = { sy: 1, sxz: 1, lift: 0, roll: 0, pitch: 0, yaw: 0, jitter: 0, glow: 0, face: 0 }): TribooPose {
  out.sy = 1;
  out.sxz = 1;
  out.lift = 0;
  out.roll = 0;
  out.pitch = 0;
  out.yaw = 0;
  out.jitter = 0;
  out.glow = 0;
  out.face = 0;
  return out;
}

// 吐券这一段的时间点（秒，从点下去算起）。turn：要不要先转身
export interface SpitTimes {
  turn: number; // 转身结束（不转身时是 0）
  charge: number; // 蓄力结束 = 开始弹起
  launch: number; // 第一张券飞出去
  peak: number; // 弹到最高、最长
  end: number; // 动作做完（转回去之前）
  done: number; // 全部结束（转回去之后）
}

export function spitTimes(turning: boolean, p: CouponParams = COUPONS): SpitTimes {
  const turn = turning ? p.turn : 0;
  const charge = turn + p.charge;
  const launch = charge + p.spring * clamp01(p.launchAt);
  const peak = charge + p.spring;
  const end = peak + Math.max(p.recover, 0.12 + p.wiggle);
  return { turn, charge, launch, peak, end, done: end + turn };
}

// 吐券时翠宝的姿态：t 是从点下去算起的秒数
export function spitPose(t: number, turning: boolean, out: TribooPose, p: CouponParams = COUPONS): TribooPose {
  restPose(out);
  const T = spitTimes(turning, p);
  // 转身：开始时转向镜头，结束时转回去
  if (turning) out.face = easeInOutCubic(span(t, 0, T.turn)) * (1 - easeInOutCubic(span(t, T.end, T.done)));
  if (t < T.turn || t >= T.done) return out;
  const low = 1 - p.squash;
  if (t < T.charge) {
    // 蓄力：很快压下去、压着发抖（越来越抖），身子往后仰一点（预备动作），logo 后半段亮起来
    const u = span(t, T.turn, T.charge);
    const k = easeOutCubic(span(u, 0, 0.7));
    out.sy = 1 - p.squash * k;
    out.jitter = Math.sin(t * Math.PI * 2 * 23) * p.tremble * u;
    out.pitch = -0.07 * k;
    out.glow = smooth(span(u, 0.25, 1));
  } else if (t < T.peak) {
    // 弹起：从压扁到拉长、往上蹦，身子往前探（吐的方向）
    const u = span(t, T.charge, T.peak);
    const k = easeOutCubic(u);
    out.sy = low + (1 + p.stretch - low) * k;
    out.lift = p.hop * Math.sin((Math.PI / 2) * k);
    out.pitch = -0.07 + 0.2 * k;
    out.glow = 1;
  } else {
    // 回弹：从最高处落下（0.18 秒），竖着的缩放按衰减的弹簧回到 1（落地那一下正好压扁一点）
    const s = t - T.peak;
    const fall = 0.18;
    out.lift = s < fall ? p.hop * (1 - (s / fall) ** 2) : 0;
    const settle = Math.max(0.05, p.recover);
    out.sy = 1 + p.stretch * Math.exp((-6 * s) / (settle / 0.55)) * Math.cos(2 * Math.PI * 3.2 * s * (0.55 / settle));
    out.pitch = 0.13 * Math.exp(-9 * s) * Math.cos(10 * s);
    out.glow = 1 - smooth(span(s, 0, 0.3));
    // 开心地晃两下：左右各两次，越晃越小，晃到一边时轻轻一颠
    const w = span(s, 0.12, 0.12 + p.wiggle);
    if (w > 0 && w < 1) {
      const env = (1 - w) ** 0.8 * smooth(span(w, 0, 0.08));
      const phase = Math.sin(w * Math.PI * 4);
      out.roll = ((p.wiggleAngle * Math.PI) / 180) * phase * env;
      out.lift += 0.025 * Math.abs(phase) * env;
    }
  }
  out.sxz = 1 / Math.sqrt(Math.max(0.2, out.sy));
  return out;
}

// 冷却中再点：摇头（整个身子绕上下轴左右转两个来回，越摇越小），身子轻轻一缩
export function shakePose(t: number, out: TribooPose, p: CouponParams = COUPONS): TribooPose {
  restPose(out);
  const u = span(t, 0, p.shakeSeconds);
  if (u <= 0 || u >= 1) return out;
  const env = (1 - u) ** 1.2 * smooth(span(u, 0, 0.1));
  out.yaw = ((p.shakeAngle * Math.PI) / 180) * Math.sin(u * Math.PI * 4.5) * env;
  out.sy = 1 - 0.04 * Math.sin(Math.PI * u);
  out.sxz = 1 / Math.sqrt(out.sy);
  out.roll = 0.04 * Math.sin(u * Math.PI * 4.5 + 0.6) * env;
  return out;
}

// 悬停时轻轻一缩：欠阻尼的弹簧（缩进去时带一点点回弹），每帧一步。state = [位置, 速度]
export function stepHover(state: [number, number], target: number, dt: number): number {
  const k = 260;
  const c = 18;
  const h = Math.min(dt, 1 / 30);
  const a = -k * (state[0] - target) - c * state[1];
  state[1] += a * h;
  state[0] += state[1] * h;
  return state[0];
}

// —— 券的轨迹（u = 飞了多久 / 总时长，0..1）——

// 水平方向的进度：一开始冲得快，后面越来越慢
export const flightAcross = (u: number): number => 1 - (1 - clamp01(u)) ** 2;
// 抛物线的鼓包：u = 1/3 时最高（= 1），落地时竖直速度是 0（纸片轻轻停住，不是砸下来）
export const flightArc = (u: number): number => {
  const x = clamp01(u);
  return 6.75 * x * (1 - x) * (1 - x);
};
// 快落地时左右飘：过了最高点以后渐强，停住之前收掉
export const flutterWeight = (u: number): number => smooth(span(u, 0.3, 0.55)) * (1 - smooth(span(u, 0.82, 1)));
// 翻转：前面翻得快、后面慢，落地时正好翻完整数圈（立着）
export const flipAngle = (u: number, flips: number): number => Math.PI * 2 * Math.round(flips) * (1 - (1 - clamp01(u)) ** 3);

// 一张券的落点（翠宝脚下的坐标里：x 往右，z 往前，米）：在正前方左右张开 fan 度的扇形里均匀排开，带一点随机
export function landingSpot(i: number, n: number, rand: () => number, p: CouponParams = COUPONS): { x: number; z: number } {
  const fan = (p.fan * Math.PI) / 180;
  const slot = n > 1 ? i / (n - 1) - 0.5 : 0;
  const a = slot * fan + (rand() - 0.5) * (fan / Math.max(2, n)) * 0.6;
  const d = p.spread * (0.72 + rand() * 0.45);
  return { x: Math.sin(a) * d, z: Math.cos(a) * d };
}

// 一次吐几张
export function couponCount(rand: () => number, p: CouponParams = COUPONS): number {
  const lo = Math.max(1, Math.round(Math.min(p.countMin, p.countMax)));
  const hi = Math.max(lo, Math.round(Math.max(p.countMin, p.countMax)));
  return lo + Math.min(hi - lo, Math.floor(rand() * (hi - lo + 1)));
}

// 捡券：先往上一跳，再加速飞向镜头前（二次贝塞尔：起点 → 起点上方 → 终点）。返回 [沿路径的进度, 往上跳的权重]
export function pickupCurve(u: number): number {
  return easeInOutCubic(clamp01(u));
}

// 落地以后的寿命：浮着 life 秒，然后 fade 秒淡出。返回不透明度（0 = 该收走了）
export function lifeOpacity(since: number, p: CouponParams = COUPONS): number {
  if (since < p.life) return 1;
  return 1 - smooth(span(since, p.life, p.life + Math.max(0.05, p.fade)));
}

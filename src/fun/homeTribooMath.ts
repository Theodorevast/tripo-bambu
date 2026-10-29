import { clamp01, easeOutBack, smooth, span } from '../scenes/ease';

// 首页右下角躲着的翠宝（H2）：参数和纯函数（不碰 three，单元测试直接测）。
// 翠宝站在画面右下角外面，脚藏在底边下面，身子从右边缘探进来：平时只露出一小半（看得到黑色的圆身子和胸前 logo 的一角），
// 隔一会儿探出头看一眼再缩回去；指针靠近时探出更多、挥手；点它就蓄力、弹起来吐一张券（吐券的姿态用 couponsMath 的 spitPose）。
// 「露出多少」按身体（球）的宽度算：0 = 刚好全藏在边外，1 = 整个身子都进了画面

export const HOME_TRIBOO = {
  size: 0.27, // 身高占画面高度多少（宽屏）
  sizeTall: 0.17, // 竖屏（手机）
  feet: -1.02, // 脚底在画面上的高度（NDC，-1 是底边）：脚藏在底边下面，像从右下角探出来
  depth: 14, // 离镜头多远（世界单位）：只影响透视，大小按 size 算
  hide: 0.46, // 平时露出多少：logo 的 V 露出来，认得出是翠宝
  peek: 0.68, // 偶尔探出头看一眼
  near: 0.82, // 指针靠近
  act: 0.92, // 吐券、摇头
  greet: 0.8, // 开场打招呼
  away: -0.4, // 离开首页（转场、星球视图）：整个缩到边外
  lean: 16, // 往画面里歪多少度（探得越出越歪）
  turn: 38, // 身子往画面中间转多少度（正面、logo 朝着画面里）
  reach: 300, // 指针离翠宝多近（像素）算「靠近」
  peekMin: 5.5, // 隔多久探一次头（秒，在 min..max 之间随机）
  peekMax: 10,
  peekHold: 1.6, // 探出去看多久（秒）
  look: 18, // 探头时左右看的角度（度）
  waveHz: 1.5, // 挥手的快慢（来回 / 秒）
  swing: 30, // 挥手的幅度（度）
  greetHold: 2.4, // 开场打招呼一共多久（秒）：探出来、挥两下、缩回去
  flight: 0.62, // 券从嘴里飞到画面中间用多久（秒）
  ticket: 0.3, // 券刚出嘴时的长边（× 身高）
  spring: 75, // 探出、缩回的弹簧刚度（欠阻尼：探出来时轻轻一弹）
  damping: 12,
};

export type HomeTribooParams = typeof HOME_TRIBOO;

export const BODY_R = 0.4; // 身体（球）的半径（× 身高）
export const BODY_Y = 0.62; // 身体中心离脚底多高（× 身高）

export interface Placement {
  height: number; // 身高（世界单位）
  bodyR: number; // 身体半径
  x: number; // 脚底在镜头坐标里的位置（镜头看 -Z，+X 是画面右边，+Y 是画面上方）
  y: number;
  z: number;
  bodyX: number; // 身体中心在镜头坐标里的位置
  bodyY: number;
}

// 翠宝在镜头坐标里的摆法：身体露出 out（按身体宽度），往画面里歪 leanDeg 度（以脚底为轴），脚底在 NDC 的 feet 那条线上
export function placeTriboo(out: number, leanDeg: number, aspect: number, fovDeg: number, size: number, p: HomeTribooParams = HOME_TRIBOO, into?: Placement): Placement {
  const tanH = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const halfH = p.depth * tanH;
  const halfW = halfH * aspect;
  const height = size * 2 * halfH;
  const bodyR = BODY_R * height;
  const lean = (leanDeg * Math.PI) / 180;
  const bodyX = halfW + bodyR * (1 - 2 * out); // 身体左边缘在 halfW − 2·out·r：露出 2·out·r 宽
  const y = p.feet * halfH;
  const o = into ?? { height: 0, bodyR: 0, x: 0, y: 0, z: 0, bodyX: 0, bodyY: 0 };
  o.height = height;
  o.bodyR = bodyR;
  o.bodyX = bodyX;
  o.bodyY = y + Math.cos(lean) * BODY_Y * height;
  o.x = bodyX + Math.sin(lean) * BODY_Y * height; // 往左歪：脚在身体右下方
  o.y = y;
  o.z = -p.depth;
  return o;
}

// 往画面里歪多少度：探得越出越歪（平时一点点）
export function leanFor(out: number, p: HomeTribooParams = HOME_TRIBOO): number {
  const k = clamp01((out - p.hide) / Math.max(1e-6, p.act - p.hide));
  return p.lean * (0.35 + 0.65 * smooth(k));
}

// 开场打招呼（t 从 0 到 greetHold）：返回要露出多少和挥手的抬起量 0..1、挥到哪（-1..1）
export function greetPose(t: number, p: HomeTribooParams = HOME_TRIBOO): { out: number; raise: number; wave: number } {
  const T = p.greetHold;
  const rise = 0.45;
  const back = 0.4;
  if (t <= 0 || t >= T) return { out: p.hide, raise: 0, wave: 0 };
  const outK = t < rise ? easeOutBack(t / rise, 1.6) : t > T - back ? 1 - smooth(span(t, T - back, T)) : 1;
  const waveT = span(t, rise * 0.6, T - back);
  const raise = smooth(span(waveT, 0, 0.15)) * (1 - smooth(span(waveT, 0.85, 1)));
  return { out: p.hide + (p.greet - p.hide) * outK, raise, wave: Math.sin(t * Math.PI * 2 * p.waveHz) };
}

// 偶尔探头（t 从 0 到 peekHold）：露出多少、往哪边看（-1..1，乘 look 度）
export function peekPose(t: number, p: HomeTribooParams = HOME_TRIBOO): { out: number; look: number } {
  const T = p.peekHold;
  if (t <= 0 || t >= T) return { out: p.hide, look: 0 };
  const inK = smooth(span(t, 0, 0.3));
  const outK = 1 - smooth(span(t, T - 0.35, T));
  const k = Math.min(inK, outK);
  // 先往画面里看（左），再往上看一眼，回来
  const look = Math.sin(span(t, 0.2, T - 0.3) * Math.PI * 2) * k;
  return { out: p.hide + (p.peek - p.hide) * k, look };
}

// 下一次探头在几秒以后（rand：0..1）
export function nextPeek(rand: number, p: HomeTribooParams = HOME_TRIBOO): number {
  return p.peekMin + (p.peekMax - p.peekMin) * clamp01(rand);
}

// 露出多少的弹簧（欠阻尼），每帧一步，按 1/120 秒细分：卡了一帧也稳。state = [位置, 速度]
export function stepOut(state: [number, number], target: number, dt: number, p: HomeTribooParams = HOME_TRIBOO): number {
  for (let left = Math.min(Math.max(dt, 0), 0.1); left > 1e-6; left -= 1 / 120) {
    const h = Math.min(1 / 120, left);
    const a = -p.spring * (state[0] - target) - p.damping * state[1];
    state[1] += a * h;
    state[0] += state[1] * h;
  }
  return state[0];
}

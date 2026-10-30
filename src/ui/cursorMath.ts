// 鼠标跟随层（ui/cursor.ts）的纯计算部分：认光标种类、两种弹簧、指数趋近。不碰 DOM，测试直接调
// 每帧不新建对象：状态和参数都放在一个 Float64Array 里，下面的函数只收下标（小整数）——
// 函数没被内联时，传进传出的 double 都要在堆上装箱（HeapNumber），每帧都是垃圾；全传下标就没有

export type CursorMode = 'default' | 'pointer' | 'grab' | 'grabbing' | 'text';

const TEXT_TAIL = /(^|,\s*)(text|vertical-text)$/;

// 光标的计算值，比如 'image-set(url("…") 1dppx, url("…") 2dppx) 4 3, pointer'：看最后的关键字（cursor.css 里每张图都带着后备关键字）
export function cursorMode(computed: string): CursorMode {
  const v = computed.trim();
  if (v.endsWith('grabbing')) return 'grabbing';
  if (v.endsWith('grab')) return 'grab';
  if (v.endsWith('pointer')) return 'pointer';
  if (TEXT_TAIL.test(v)) return 'text';
  return 'default';
}

// 临界阻尼的平滑追随（Game Programming Gems 4 的近似，同 Unity 的 SmoothDamp）：任何 dt 都稳，不过冲。
// s[i] 位置、s[i + 1] 速度，追 s[target]；s[time] 大约是追上要的秒数，s[dt] 这一帧的秒数
export function smoothDamp(s: Float64Array, i: number, target: number, time: number, dt: number): void {
  const h = s[dt];
  const omega = 2 / Math.max(1e-4, s[time]);
  const x = omega * h;
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s[i] - s[target];
  const temp = (s[i + 1] + omega * change) * h;
  s[i + 1] = (s[i + 1] - omega * temp) * k;
  s[i] = s[target] + (change + temp) * k;
}

// 阻尼弹簧（半隐式欧拉，切成不超过 1/240 秒的小步，硬一点也稳）：s[i]、s[i + 1] 追 s[target]，
// s[omega] 角频率，s[zeta] 阻尼比（< 1 会弹一下，= 1 刚好不弹）
export function spring(s: Float64Array, i: number, target: number, omega: number, zeta: number, dt: number): void {
  const n = Math.max(1, Math.ceil(s[dt] * 240));
  const h = s[dt] / n;
  const w = s[omega];
  const z = s[zeta];
  const to = s[target];
  let x = s[i];
  let v = s[i + 1];
  for (let k = 0; k < n; k++) {
    v += (-2 * z * w * v - w * w * (x - to)) * h;
    x += v * h;
  }
  s[i] = x;
  s[i + 1] = v;
}

// 指数趋近（淡入淡出、拉长量）：s[i] 往 s[target] 走，s[tau] 秒走掉 63%
export function approach(s: Float64Array, i: number, target: number, tau: number, dt: number): void {
  s[i] = s[target] + (s[i] - s[target]) * Math.exp(-s[dt] / Math.max(1e-4, s[tau]));
}

// 鼠标跟随层（ui/cursor.ts）的纯计算部分：认光标种类、两种弹簧。不碰 DOM，测试直接调
// 弹簧的状态放在 Float64Array 里原地改（s[i] 位置、s[i + 1] 速度）：每帧不新建对象

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
// smoothTime 大约是追上目标要的时间（秒）
export function smoothDamp(s: Float64Array, i: number, target: number, smoothTime: number, dt: number): void {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const k = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s[i] - target;
  const temp = (s[i + 1] + omega * change) * dt;
  s[i + 1] = (s[i + 1] - omega * temp) * k;
  s[i] = target + (change + temp) * k;
}

// 阻尼弹簧（半隐式欧拉，切成不超过 1/240 秒的小步，硬一点也稳）：zeta < 1 会弹一下，zeta = 1 刚好不弹
export function spring(s: Float64Array, i: number, target: number, omega: number, zeta: number, dt: number): void {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  let x = s[i];
  let v = s[i + 1];
  for (let k = 0; k < n; k++) {
    v += (-2 * zeta * omega * v - omega * omega * (x - target)) * h;
    x += v * h;
  }
  s[i] = x;
  s[i + 1] = v;
}

// 指数趋近（淡入淡出、拉长量）：tau 秒走掉 63%
export function approach(value: number, target: number, tau: number, dt: number): number {
  return target + (value - target) * Math.exp(-dt / Math.max(1e-4, tau));
}

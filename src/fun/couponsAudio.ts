import { COUPONS } from './couponsMath';

// 吐券的声音：Web Audio 现场合成，不放音频文件。只有用户和页面交互过（点过、按过键）以后才出声（浏览器的自动播放规则也是这样）。
// 建 AudioContext 要打开音频设备：实测 Chrome 主线程上一次 37 ms，放在用户点翠宝的那一下里就掉一帧。所以开场时
// （coupons 装上的时候，启动画面还盖着）先建好，这时它是 suspended，不出声；用户第一次按下（指针、按键）时只 resume()，从这以后才出声。
// - pop：「啵」——正弦波从高音很快滑到低音，前面垫一小下带通噪声当「p」的气音
// - sparkle：券飞出去时三个很短的高音（叮铃）
// - charge：蓄力时一声很轻的往上滑的「嗯——」
// - nope：冷却中摇头：两声往下的「嘟嘟」
// - pickup：捡券：往上走的三个音
// - tick：复制成功

type Voice = 'pop' | 'sparkle' | 'charge' | 'nope' | 'pickup' | 'tick';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let armed = false; // 用户已经和页面交互过

// 开场时建好（suspended，不出声）：打开音频设备的那几十毫秒藏在启动画面后面
export function prepareAudio(): void {
  if (ctx || typeof window === 'undefined') return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    // 一小段白噪声（0.2 秒），「p」的气音用它
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.2), ctx.sampleRate);
    const data = noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x7fffffff) * 2 - 1;
    }
  } catch {
    ctx = null;
  }
}

// 用户第一次按下（capture 阶段、只听一次）：从这以后允许出声，把 AudioContext 唤醒
export function armOnFirstGesture(): void {
  if (typeof addEventListener !== 'function') return;
  const once = () => {
    removeEventListener('pointerdown', once, true);
    removeEventListener('keydown', once, true);
    armed = true;
    if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
  };
  addEventListener('pointerdown', once, true);
  addEventListener('keydown', once, true);
}

export function audioReady(): boolean {
  return ctx !== null && armed;
}

function tone(type: OscillatorType, from: number, to: number, at: number, length: number, peak: number, attack = 0.004): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(g).connect(master);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

function hiss(at: number, length: number, freq: number, q: number, peak: number): void {
  if (!ctx || !master || !noise) return;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(band).connect(g).connect(master);
  src.start(at);
  src.stop(at + length + 0.02);
}

// 放一个声音（没 arm、音量是 0、页面在后台时什么也不做）。pitch：整体升降（1 = 原调），每次稍微变一点听起来不机械
export function play(voice: Voice, pitch = 1): void {
  if (!ctx || !master || !armed || COUPONS.volume <= 0) return;
  if (ctx.state === 'suspended') void ctx.resume();
  master.gain.value = Math.min(1, COUPONS.volume);
  const t = ctx.currentTime + 0.005;
  const p = pitch;
  switch (voice) {
    case 'pop':
      hiss(t, 0.03, 2400 * p, 1.2, 0.18);
      tone('sine', 880 * p, 190 * p, t, 0.11, 0.5);
      tone('triangle', 1320 * p, 420 * p, t + 0.004, 0.06, 0.12);
      break;
    case 'sparkle': {
      const notes = [1568, 2093, 2637];
      notes.forEach((f, i) => tone('triangle', f * p, f * p * 1.01, t + i * 0.045, 0.12, 0.07, 0.002));
      break;
    }
    case 'charge':
      tone('sine', 180 * p, 330 * p, t, COUPONS.charge + 0.05, 0.05, 0.05);
      break;
    case 'nope':
      tone('sine', 330 * p, 300 * p, t, 0.09, 0.18);
      tone('sine', 262 * p, 220 * p, t + 0.13, 0.12, 0.18);
      break;
    case 'pickup':
      hiss(t, 0.12, 3200, 0.7, 0.05);
      [988, 1319, 1976].forEach((f, i) => tone('triangle', f * p, f * p, t + 0.05 + i * 0.06, 0.16, 0.09, 0.003));
      break;
    case 'tick':
      tone('square', 1760, 1700, t, 0.035, 0.05, 0.002);
      tone('sine', 2637, 2637, t + 0.04, 0.09, 0.06, 0.002);
      break;
  }
}

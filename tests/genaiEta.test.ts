import { describe, expect, it } from 'vitest';
import { creditsOf, etaOf, formatEta, leftText, remainingSec, smoothRemaining, type EtaJob } from '../src/genai/eta';
import type { ModelInfo } from '../src/genai/types';

// 预计时间：模型选择器上的时长、生成中的倒计时（按模型目录的预计耗时 + Tripo 的进度）

const H31: ModelInfo = {
  id: 'v3.1-20260211', label: 'H3.1', blurb: 'x', textures: ['none', 'fast', 'standard'], measured: false,
  eta: { text: { none: 90, fast: 120, standard: 170 }, image: { none: 75 }, multiview: {} },
  credits: { text: { none: 10, fast: 20, standard: 20 }, image: {}, multiview: {} },
};
const T0 = 1_000_000;
const job = (over: Partial<EtaJob> = {}): EtaJob => ({ phase: 'running', progress: 0, etaSec: 100, startedAt: T0, ...over });

describe('预计时间', () => {
  it('从模型目录查预计耗时和积分；没有这一格时 null', () => {
    expect(etaOf(H31, 'text', 'fast')).toBe(120);
    expect(creditsOf(H31, 'text', 'none')).toBe(10);
    expect(etaOf(H31, 'multiview', 'standard')).toBeNull();
    expect(etaOf(undefined, 'text', 'none')).toBeNull();
  });

  it('选择器上的时长：50 秒以下按 5 秒，再往上按半分钟', () => {
    expect(formatEta(42)).toBe('≈ 40 s');
    expect(formatEta(3)).toBe('≈ 5 s');
    expect(formatEta(90)).toBe('≈ 1.5 min');
    expect(formatEta(170)).toBe('≈ 3 min');
    expect(formatEta(0)).toBe('');
  });

  it('还没开始按进度推时只看预计耗时；进度越往后越信进度（最多八成五）', () => {
    expect(remainingSec(job({ phase: 'queued' }), T0 + 10_000)).toBe(90);
    expect(remainingSec(job({ startedAt: undefined }), T0)).toBeNull();
    // 生成 30 秒到了 50%：按进度还要 30 秒，按预计还要 60 秒；50% 时信进度 0.6375
    const r = remainingSec(job({ progress: 50, runningAt: T0 + 10_000 }), T0 + 40_000)!;
    expect(r).toBeCloseTo(0.3625 * 60 + 0.6375 * 30, 5);
    // 进度很靠后：差不多全按进度
    const late = remainingSec(job({ progress: 95, runningAt: T0 }), T0 + 95_000)!;
    expect(late).toBeCloseTo(0.15 * 5 + 0.85 * 5, 5);
  });

  it('倒计时的一句话：快完了、超时了、秒、分钟', () => {
    expect(leftText(job(), 42, T0)).toBe('About 45 s left');
    expect(leftText(job(), 95, T0)).toBe('About 1.5 min left');
    expect(leftText(job(), 2, T0 + 50_000)).toBe('Almost done…');
    expect(leftText(job(), -20, T0 + 130_000)).toBe('Taking a little longer than usual…');
    expect(leftText(job({ etaSec: undefined }), 30, T0)).toBeNull();
  });

  it('平滑：往下跳照收；往上涨不到 15 秒当没涨、接着往下数；涨得多才改口', () => {
    expect(smoothRemaining(null, 50, T0)).toBe(50);
    const prev = { sec: 50, at: T0 };
    expect(smoothRemaining(prev, 40, T0 + 1000)).toBe(40);
    expect(smoothRemaining(prev, 55, T0 + 1000)).toBe(49);
    expect(smoothRemaining(prev, 80, T0 + 1000)).toBe(80);
  });
});

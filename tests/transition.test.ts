import { describe, expect, it } from 'vitest';
import { bump, cubicBezier, easeInBack, easeOutBack, span } from '../src/scenes/ease';
import { INTRO, PEEK, TRANSITIONS, type TransitionShot } from '../src/scenes/shots';
import { irisClearRadius, moveFor, Timeline, veilFrame, type TransitionKind, type VeilContext } from '../src/scenes/transition';

const ctx = (over: Partial<VeilContext> = {}): VeilContext => ({ aspect: 1.6, centerIn: [0, 0], centerOut: [0, 0.04], dir: [-1, 0], spin: 0.7, ...over });
const kinds: Array<Exclude<TransitionKind, 'fade'>> = ['enter', 'hop', 'leave'];

describe('缓动曲线（cubic-bezier）', () => {
  it('两端精确是 0 和 1；(0,0,1,1) 是直线；标准 ease-in-out 关于中点对称、单调', () => {
    const lin = cubicBezier({ x1: 0, y1: 0, x2: 1, y2: 1 });
    const io = cubicBezier({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
    expect([lin(0), lin(1), io(0), io(1)]).toEqual([0, 1, 0, 1]);
    for (const t of [0.1, 0.25, 0.5, 0.8]) expect(lin(t)).toBeCloseTo(t, 6);
    expect(io(0.5)).toBeCloseTo(0.5, 6);
    expect(io(0.2) + io(0.8)).toBeCloseTo(1, 6);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = io(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('y1 < 0 时起步先往回收（预备动作），y2 > 1 时冲过头再回来', () => {
    const anticipate = cubicBezier({ x1: 0.5, y1: -0.4, x2: 0.5, y2: 1 });
    const overshoot = cubicBezier({ x1: 0.3, y1: 0, x2: 0.4, y2: 1.5 });
    expect(Math.min(...[0.05, 0.1, 0.15, 0.2].map(anticipate))).toBeLessThan(0);
    expect(Math.max(...[0.6, 0.7, 0.8, 0.9].map(overshoot))).toBeGreaterThan(1);
    expect(overshoot(1)).toBe(1);
  });

  it('鼓包：两端是 0、峰值时刻是 1；span 把一段时间映射到 0..1；回弹缓动两端是 0 和 1', () => {
    expect([bump(0, 0.3), bump(1, 0.3), bump(0.3, 0.3)]).toEqual([0, 0, 1]);
    expect(bump(0.15, 0.3)).toBeCloseTo(0.5, 6);
    expect(span(0.1, 0.2, 0.4)).toBe(0);
    expect(span(0.3, 0.2, 0.4)).toBeCloseTo(0.5, 9);
    expect(span(0.5, 0.2, 0.4)).toBe(1);
    expect(easeOutBack(0)).toBeCloseTo(0, 9);
    expect(easeOutBack(1)).toBeCloseTo(1, 9);
    expect(easeInBack(1)).toBeCloseTo(1, 9);
    expect(easeInBack(0.2)).toBeLessThan(0); // 先往反方向
  });
});

describe('分镜表', () => {
  const shots = Object.entries(TRANSITIONS) as Array<[TransitionKind, TransitionShot]>;

  it('每个转场：云的四个时刻按顺序、都在 0..1 里；作品在云开始散开之后才弹出来', () => {
    for (const [, s] of shots) {
      expect(s.seconds).toBeGreaterThan(0);
      expect(0 <= s.cloudIn && s.cloudIn <= s.cloudFull && s.cloudFull <= s.cloudOut && s.cloudOut <= s.cloudGone && s.cloudGone <= 1).toBe(true);
    }
    for (const k of ['enter', 'hop'] as const) {
      expect(TRANSITIONS[k].popAt).toBeGreaterThanOrEqual(TRANSITIONS[k].cloudOut);
      expect(TRANSITIONS[k].stagger).toBeCloseTo(0.06, 9); // 每件间隔约 60 ms
    }
  });

  it('品牌露出要克制：翠宝黄光带不超过约 150 ms；回星系、减弱动效时不闪', () => {
    for (const [, s] of shots) if (s.flashAt >= 0) expect(s.flashMs).toBeLessThanOrEqual(150);
    expect(TRANSITIONS.enter.flashAt).toBeGreaterThanOrEqual(0);
    expect(TRANSITIONS.hop.flashAt).toBeGreaterThanOrEqual(0);
    expect(TRANSITIONS.leave.flashAt).toBeLessThan(0);
    expect(TRANSITIONS.fade.flashAt).toBeLessThan(0);
  });

  it('回星系比进星球短；开场和探头的参数在表里', () => {
    expect(TRANSITIONS.leave.seconds).toBeLessThan(TRANSITIONS.enter.seconds);
    expect(INTRO.seconds).toBeGreaterThan(0);
    expect(PEEK.rise + PEEK.wave + PEEK.duck).toBeGreaterThan(1);
  });
});

describe('云层的每一帧（veilFrame）', () => {
  it('开始和结束时没有云；云层全遮住的那一刻整个画面都盖住', () => {
    for (const k of kinds) {
      const s = TRANSITIONS[k];
      expect(veilFrame(k, s, 0, ctx()).on).toBe(false);
      expect(veilFrame(k, s, 1, ctx()).on).toBe(false);
      const full = veilFrame(k, s, s.cloudFull, ctx());
      expect(full.on).toBe(true);
      if (k === 'hop') {
        // 云带：前沿已经越过画面另一边、后沿还没进来（画面半宽沿 dir 是 0.8）
        expect(full.front[0]).toBeGreaterThan(0.8);
        expect(full.front[1]).toBeLessThan(-0.8);
      } else {
        // iris：远的那层洞已经合死（< 0）
        expect(full.back[0]).toBeLessThan(0);
      }
    }
  });

  it('云刚开始涌进来时，云团整个在画面外（洞比画面最远的角还大）', () => {
    const corner = Math.hypot(0.8, 0.5);
    for (const k of ['enter', 'leave'] as const) {
      const s = TRANSITIONS[k];
      const f = veilFrame(k, s, s.cloudIn + 1e-6, ctx());
      expect(f.front[0]).toBeGreaterThan(corner);
      expect(f.back[0]).toBeGreaterThan(corner);
    }
    expect(irisClearRadius(1, 16, 1)).toBeGreaterThan(1);
    expect(irisClearRadius(1, 16, 1.3)).toBeGreaterThan(irisClearRadius(1, 16, 1));
  });

  it('光带只在 flashAt 之后 flashMs 毫秒里出现', () => {
    const s = TRANSITIONS.enter;
    const at = (ms: number) => veilFrame('enter', s, s.flashAt + ms / 1000 / s.seconds, ctx()).flash[1];
    expect(at(-10)).toBe(0);
    expect(at(s.flashMs / 2)).toBeGreaterThan(0.5);
    expect(at(s.flashMs + 10)).toBe(0);
  });

  it('减弱动效：只有整屏淡入淡出（先淡到最深、换场景、再淡回来），没有云团和光带', () => {
    const s = TRANSITIONS.fade;
    expect(veilFrame('fade', s, 0, ctx()).fade).toBe(0);
    expect(veilFrame('fade', s, s.cloudFull, ctx()).fade).toBeCloseTo(1, 9);
    expect(veilFrame('fade', s, 1, ctx()).fade).toBeCloseTo(0, 9);
    const mid = veilFrame('fade', s, s.cloudFull, ctx());
    expect(mid.flash[1]).toBe(0);
    expect(mid.front[0]).toBeGreaterThan(5); // 云团都在远处
  });
});

describe('镜头怎么飞（moveFor）', () => {
  it('FOV 冲击、侧倾在起点终点都是 0，中途不是；抬升量按距离；leave 在全遮住后才起飞，飞剩下的时间', () => {
    const hop = moveFor('hop', TRANSITIONS.hop, 100, 1);
    expect(hop.seconds).toBe(TRANSITIONS.hop.seconds);
    expect(hop.fovKick!(0)).toBe(0);
    expect(hop.fovKick!(1)).toBe(0);
    expect(hop.fovKick!(TRANSITIONS.hop.fovPeak)).toBeCloseTo(TRANSITIONS.hop.fovPunch, 9);
    expect(hop.roll!(0)).toBeCloseTo(0, 12);
    expect(hop.roll!(1)).toBeCloseTo(0, 12);
    expect(Math.abs(hop.roll!(TRANSITIONS.hop.fovPeak))).toBeGreaterThan(0.05);
    expect(hop.arc).toBeCloseTo(TRANSITIONS.hop.arc * 100, 9);
    expect(hop.ease!(1)).toBe(1);
    expect(hop.look!(TRANSITIONS.hop.lookSpan)).toBe(1); // 视线先转完
    const leave = moveFor('leave', TRANSITIONS.leave, 100);
    expect(leave.seconds).toBeCloseTo(TRANSITIONS.leave.seconds * (1 - TRANSITIONS.leave.cloudFull), 9);
    expect(moveFor('enter', TRANSITIONS.enter, 50).roll).toBeUndefined(); // 进星球不侧倾
  });
});

describe('时间线', () => {
  it('按 dt 走；到点的事件按先后触发（一帧跨过几个点就依次触发）；走完 done resolve', async () => {
    const log: string[] = [];
    const seen: number[] = [];
    const tl = new Timeline(1, (t) => seen.push(t));
    tl.at(0.5, () => log.push('b')).at(0.2, () => log.push('a')).at(0.9, () => log.push('c'));
    let done = false;
    void tl.done.then(() => { done = true; });
    expect(tl.step(0.1)).toBe(true);
    expect(log).toEqual([]);
    expect(tl.step(0.5)).toBe(true); // 0.6：a、b 都过了
    expect(log).toEqual(['a', 'b']);
    expect(tl.step(0.5)).toBe(false);
    expect(log).toEqual(['a', 'b', 'c']);
    expect(seen.at(-1)).toBe(1);
    await Promise.resolve();
    expect(done).toBe(true);
  });
});

import type { GenJob, GenMode, ModelInfo, TextureChoice } from './types';

// 预计时间：模型选择器上的「≈ 1.5 min」、生成中的倒计时。纯函数，不碰 DOM。
// 先验是中转模型目录里的预计耗时（ETA_SEC，秒，从建任务到完成）；开始生成以后按 Tripo 报的进度推一个，
// 进度越往后越信进度（最多八成五：Tripo 的进度在最后一段常常不动，全信它会一直说「还剩几秒」）

const PROGRESS_FROM = 5; // 进度到这么多才开始按进度推（太早的进度很不准）
const PROGRESS_SPAN = 60; // 从 5% 到 65%，对进度的信任从 0 涨到最大
const PROGRESS_TRUST = 0.85;
const LATE = 1.25; // 过了预计耗时的这么多倍还没完：说「比平时久一点」

export type EtaJob = Pick<GenJob, 'phase' | 'progress' | 'etaSec' | 'startedAt' | 'runningAt'>;

// 模型目录里这个组合的预计耗时、积分；没有（不支持这个贴图档、目录里没写）时 null
export function etaOf(model: ModelInfo | undefined, mode: GenMode, texture: TextureChoice): number | null {
  return model?.eta?.[mode]?.[texture] ?? null;
}
export function creditsOf(model: ModelInfo | undefined, mode: GenMode, texture: TextureChoice): number | null {
  return model?.credits?.[mode]?.[texture] ?? null;
}

// 选择器上的时长：45 秒以下按 5 秒取整（≈ 40 s），再往上按半分钟（≈ 1.5 min、≈ 2 min）
export function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 50) return `≈ ${Math.max(5, Math.round(sec / 5) * 5)} s`;
  const half = Math.max(1, Math.round(sec / 30) / 2);
  return `≈ ${half} min`;
}

// 还要多少秒（可以是负数：已经超过预计了）；没有预计耗时、还没拿到 taskId 时 null
export function remainingSec(job: EtaJob, now: number): number | null {
  if (!job.etaSec || job.startedAt === undefined) return null;
  const elapsed = (now - job.startedAt) / 1000;
  const prior = job.etaSec - elapsed;
  if (job.phase !== 'running' || job.runningAt === undefined || job.progress < PROGRESS_FROM) return prior;
  const run = Math.max(0, (now - job.runningAt) / 1000);
  const byProgress = (run * (100 - job.progress)) / job.progress;
  const w = Math.min(PROGRESS_TRUST, Math.max(0, (job.progress - PROGRESS_FROM) / PROGRESS_SPAN) * PROGRESS_TRUST);
  return (1 - w) * prior + w * byProgress;
}

// 倒计时的一句话：About 40 s left、About 1.5 min left、Almost done…、Taking a little longer than usual…
// shownSec：界面上实际显示的剩余秒数（平滑过的，见 smoothRemaining）
export function leftText(job: EtaJob, shownSec: number | null, now: number): string | null {
  if (shownSec === null || !job.etaSec || job.startedAt === undefined) return null;
  const elapsed = (now - job.startedAt) / 1000;
  if (shownSec <= 4) return elapsed > job.etaSec * LATE ? 'Taking a little longer than usual…' : 'Almost done…';
  if (shownSec < 55) return `About ${Math.ceil(shownSec / 5) * 5} s left`;
  return `About ${Math.max(1, Math.round(shownSec / 30) / 2)} min left`;
}

// 倒计时平滑：每秒算一次的剩余时间会跟着轮询跳（两次轮询之间进度不动，按进度推的就往上涨）。
// 往下跳照收；往上涨不到 15 秒就当没涨，接着按时间往下数；涨得多（Tripo 明显慢了）才改口
export function smoothRemaining(prev: { sec: number; at: number } | null, raw: number, now: number): number {
  if (!prev) return raw;
  const counted = prev.sec - (now - prev.at) / 1000;
  if (raw <= counted) return raw;
  return raw - counted < 15 ? counted : raw;
}

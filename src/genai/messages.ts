import type { GenErrorCode, GenJob } from './types';

// Tripo 生成的界面文字：错误提示、任务进度、默认作品名。全部是给人看的英文句子，Tripo 首字母大写。
// 中转、Tripo 回的原话（message、任务的 error）是中文，界面只用英文：提示一律按错误码用这里的句子，原话只记在 GenError.detail 里给日志看

const MAX_TITLE = 40; // 默认作品名最多这么长
const TITLE_WORDS = 6; // 从提示词里取前几个词

// 要等多久：12 seconds、5 minutes、3 hours（向上取整）
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.ceil(s / 3600);
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

const validWait = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// 错误码 → 提示（英文，固定的句子）。retryAfter（秒）：429 的 rate_limited、daily_cap 带着，提示里说要等多久。
// _detail：中转的原话，只为了和以前的调用（describeError(code, message, retryAfter)）兼容，不会出现在提示里
export function describeError(code: GenErrorCode, _detail?: string, retryAfter?: number): string {
  switch (code) {
    case 'quota':
      return "This demo's Tripo credits are used up. You can still upload your own models.";
    case 'daily_cap':
      return validWait(retryAfter)
        ? `Today's generation limit for this demo is reached. Try again in ${waitText(retryAfter)}, or upload a model instead.`
        : "Today's generation limit for this demo is reached. Try again tomorrow, or upload a model instead.";
    case 'rate_limited':
      return validWait(retryAfter) ? `Tripo is busy right now. Try again in ${waitText(retryAfter)}.` : 'Tripo is busy right now. Wait a few seconds and try again.';
    case 'bad_request':
      // 内容不合规也回 bad_request（原话是中文，不显示）
      return "Tripo couldn't use that input. Check your prompt or images and try again.";
    case 'upstream':
      return "Tripo couldn't generate this model. Please try again.";
    case 'not_found':
      return "Tripo can't find this generation anymore. Please start a new one.";
    case 'network':
      return "Can't reach the Tripo service. Check your connection and try again.";
    case 'unavailable':
      return "Tripo generation isn't set up on this site yet. You can still upload models.";
    case 'import_failed':
      return "The model was generated, but it couldn't be added to your planet. Please try again.";
    case 'interrupted':
      return 'The page was closed before Tripo received this request. Please try again.';
    default:
      return 'Something went wrong with Tripo. Please try again.';
  }
}

// 任务 stalled（轮询、下载暂时出错，正在重试）时在进度旁边加的一句
export const STALLED_HINT = 'Tripo is slow to answer. Still trying…';

// 任务现在在做什么（任务列表、完成提示上的一行字）
export function phaseLabel(job: Pick<GenJob, 'phase' | 'progress' | 'mode'>): string {
  switch (job.phase) {
    case 'uploading':
      return job.mode === 'multiview' ? 'Uploading images…' : 'Uploading image…';
    case 'submitting':
      return 'Sending to Tripo…';
    case 'queued':
      return 'Waiting in line…';
    case 'running':
      return `Generating… ${Math.round(Math.min(100, Math.max(0, job.progress)))}%`;
    case 'downloading':
      return 'Downloading…';
    case 'importing':
      return 'Optimizing…';
    case 'done':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

// 去掉首尾的标点、引号、括号
function trimMarks(s: string): string {
  return s.replace(/^[\s"'“”‘’«»(（[\-–—,，.。:：;；!！?？…]+/u, '').replace(/[\s"'“”‘’«»)）\]\-–—,，.。:：;；!！?？、…]+$/u, '');
}

// 太长时在词边界截断（找不到合适的空格就硬截）
function shorten(s: string): string {
  if (s.length <= MAX_TITLE) return s;
  const cut = s.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(' ');
  return space >= 12 ? cut.slice(0, space) : cut;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// 提示词 → 默认作品名：前 6 个词、最多 40 个字符，首字母大写，去掉末尾的标点
export function titleFromPrompt(prompt: string): string {
  const words = trimMarks(prompt.replace(/\s+/g, ' ').trim()).split(' ').filter(Boolean).slice(0, TITLE_WORDS);
  return capitalize(trimMarks(shorten(words.join(' ')))) || 'Untitled model';
}

// 文件名 → 默认作品名：去掉路径和扩展名，下划线、连字符换成空格
export function titleFromFile(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const words = base.replace(/[_\-.+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return capitalize(trimMarks(shorten(trimMarks(words)))) || 'Untitled model';
}

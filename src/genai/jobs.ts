import type { StorageLike } from '../data/store';
import { toTripoError } from './api';
import { describeError, titleFromFile, titleFromPrompt } from './messages';
import { ACTIVE_PHASES, type GenError, type GenErrorCode, type GenInput, type GenJob, type GenMode, type GenOptions, type GenSubmit, type JobEvent, type JobPhase, type TaskInfo, type TaskRequest, type TripoApi } from './types';

// Tripo 生成任务的管理：提交（图片先上传拿 token 再建任务）→ 轮询（2–5 秒，退避）→ 下载 GLB → 交给 finish（导入管线、加进作品）。
// 状态机见 types.ts 的 JobPhase。任务列表存在 localStorage（gbn:v1:tripo-jobs）：刷新以后 resume() 接着轮询，
// 有 taskId 的没完成的任务不会丢；还没拿到 taskId 就关了页面的（上传中、提交中）标成失败（interrupted），请用户重来。
// 出错：
// - 提交时（上传、建任务）出错 → failed，提示按错误码（quota、daily_cap、rate_limited 带 retryAfter……）
// - 轮询、下载时 Tripo 忙、连不上、中转出错 → 不算失败：job.stalled = true，隔 5 秒（或者中转说的 retryAfter，最多 30 秒）再试，一直试到好或者用户取消
// - 任务找不到（not_found）、Tripo 说任务失败 → failed
// - finish 抛错（导入失败）→ failed（import_failed），retry() 可以重来（下载好的模型还在内存里就不用再下载）
// 提示一律是英文（messages.ts）；中转、Tripo 的原话（中文）只放在 error.detail 里给日志看。
// 取消只是停止轮询、界面标成已取消（中转没有取消接口）；导入那一步已经在往星球上加了，不能取消

export const POLL_MIN_MS = 2000; // 轮询间隔：最短（状态、进度一变就回到它）
export const POLL_MAX_MS = 5000; // 最长；轮询、下载出错后也隔这么久再试
export const POLL_GROWTH = 1.25; // 状态没变时，每次间隔乘以它
// 收尾：快完成时每秒问一次，成功了马上知道（平均早 1–2 秒开始下载；Tripo 建议 1–2 秒一次）。
// 快完成 = 进度到 90%，或者已经过了预计耗时的 85%（Tripo 的进度常常在最后一段不动）；超过预计耗时的 1.5 倍还没完，回到平时的退避
export const POLL_TAIL_MS = 1000;
export const POLL_TAIL_PROGRESS = 90;
export const POLL_TAIL_FROM = 0.85;
export const POLL_TAIL_UNTIL = 1.5;
export const RETRY_AFTER_CAP_MS = 30_000; // 中转说的 retryAfter 最多等这么久
export const MAX_JOBS = 30; // 列表里最多留几个（多了先删最早结束的；没结束的不删）
export const MAX_PROMPT_CHARS = 1024; // 提示词最多几个字符（Tripo 的上限；界面的字数提示也用它）
export const MIN_MULTIVIEW_IMAGES = 2; // 多视图至少几张（前视图必须是其中一张）
export const JOBS_KEY = 'gbn:v1:tripo-jobs';

const PHASES: readonly JobPhase[] = [...ACTIVE_PHASES, 'done', 'failed', 'cancelled'];
const MODES: readonly GenMode[] = ['text', 'image', 'multiview'];
const CODES: readonly GenErrorCode[] = ['rate_limited', 'daily_cap', 'quota', 'bad_request', 'upstream', 'not_found', 'network', 'unavailable', 'import_failed', 'interrupted'];
const CANCELLABLE: readonly JobPhase[] = ['uploading', 'submitting', 'queued', 'running', 'downloading'];

export interface GenJobsDeps {
  api: TripoApi;
  storage: StorageLike | null; // null：只在内存里（刷新就没了）
  // 下载好的 GLB 交给它：走导入管线、加进作品，返回作品 id。抛错 → 任务失败（import_failed），可以 retry()
  finish(job: GenJob, glb: Blob): Promise<{ workId: string }>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown; // 不给：全局的 setTimeout（单元测试换成手动的）
  clearTimeout?: (handle: unknown) => void;
  newId?: () => string;
}

// 存档里的任务：比 GenJob 多两个内部字段，retry() 用（不给界面：界面问 canRetry）
interface StoredJob extends GenJob {
  failedAt?: JobPhase; // 出错时在哪一步
  retryable?: boolean; // retry() 能不能接着做
}

// 一个正在跑的任务：token 每次开始、取消、重来都换新的，晚到的结果对不上号就丢掉
interface Runner {
  token: number;
  timer: unknown;
  hasTimer: boolean;
  interval: number; // 下一次轮询隔多久
}

interface Failure {
  message?: string; // 自己写的英文提示（不给就按错误码）
  detail?: string; // 原话，只进 error.detail
  retryAfter?: number;
  retryable?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isActive = (phase: JobPhase): boolean => ACTIVE_PHASES.includes(phase);
const clampProgress = (v: number): number => Math.round(Math.min(100, Math.max(0, Number.isFinite(v) ? v : 0)));

// 只留认识的选项（undefined 不带：请求里就没有这个字段）
function cleanOptions(o: unknown): GenOptions {
  const out: GenOptions = {};
  if (!isRecord(o)) return out;
  if (typeof o.texture === 'boolean') out.texture = o.texture;
  if (typeof o.pbr === 'boolean') out.pbr = o.pbr;
  if (isText(o.modelVersion, 60) && o.modelVersion) out.modelVersion = o.modelVersion;
  if (o.textureQuality === 'fast' || o.textureQuality === 'standard') out.textureQuality = o.textureQuality;
  return out;
}

// 预览图地址：中转的 /…/preview/:id、模拟中转的 /thumbs/…，或者 http(s) 的绝对地址；别的（javascript: 之类）不要
const isPreviewUrl = (v: unknown): v is string => isText(v, 500) && (/^\/(?!\/)/.test(v) || /^https?:\/\//i.test(v));

function toError(v: unknown): GenError | null {
  if (!isRecord(v) || typeof v.code !== 'string' || !(CODES as readonly string[]).includes(v.code) || !isText(v.message, 500)) return null;
  const error: GenError = { code: v.code as GenErrorCode, message: v.message };
  if (isTime(v.retryAfter)) error.retryAfter = v.retryAfter;
  if (isText(v.detail, 1000) && v.detail) error.detail = v.detail;
  return error;
}

// 存档里读回来的任务：逐个字段核对，只留认识的字段；必需的字段不对就整条不要
function toStoredJob(v: unknown): StoredJob | null {
  if (!isRecord(v)) return null;
  const { id, mode, title, teamId, options, phase, progress, createdAt, updatedAt } = v;
  if (!isText(id, 120) || !id || typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode) || !isText(title, 200) || !isText(teamId, 80) || !teamId) return null;
  if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase) || !isTime(createdAt) || !isTime(updatedAt)) return null;
  const job: StoredJob = {
    id, mode: mode as GenMode, title, teamId, options: cleanOptions(options), phase: phase as JobPhase,
    progress: clampProgress(typeof progress === 'number' ? progress : 0), createdAt, updatedAt,
  };
  if (isText(v.prompt, 2000)) job.prompt = v.prompt;
  if (Array.isArray(v.inputNames) && v.inputNames.every((n) => isText(n, 260))) job.inputNames = [...(v.inputNames as string[])];
  if (isText(v.taskId, 200) && v.taskId) job.taskId = v.taskId;
  const error = toError(v.error);
  if (error) job.error = error;
  if (isText(v.workId, 120) && v.workId) job.workId = v.workId;
  if (v.seen === true) job.seen = true;
  if (isTime(v.etaSec) && v.etaSec > 0 && v.etaSec <= 3600) job.etaSec = v.etaSec;
  if (isText(v.modelLabel, 40) && v.modelLabel) job.modelLabel = v.modelLabel;
  if (isTime(v.startedAt)) job.startedAt = v.startedAt;
  if (isTime(v.runningAt)) job.runningAt = v.runningAt;
  if (isPreviewUrl(v.previewUrl)) job.previewUrl = v.previewUrl;
  if (typeof v.failedAt === 'string' && (PHASES as readonly string[]).includes(v.failedAt)) job.failedAt = v.failedAt as JobPhase;
  if (v.retryable === true) job.retryable = true;
  return job;
}

// 给出去的副本：去掉内部字段
function toPublic(job: StoredJob): GenJob {
  const copy: StoredJob = structuredClone(job);
  delete copy.failedAt;
  delete copy.retryable;
  return copy;
}

function defaultTitle(input: GenInput): string {
  if (input.mode === 'text') return titleFromPrompt(input.prompt);
  const file = input.mode === 'image' ? input.image : input.views.find((f): f is File => !!f);
  return file ? titleFromFile(file.name) : 'Untitled model';
}

export class GenJobs {
  private readonly api: TripoApi;
  private readonly storage: StorageLike | null;
  private readonly finishWork: (job: GenJob, glb: Blob) => Promise<{ workId: string }>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly makeId: () => string;
  private jobs: StoredJob[]; // 新的在前
  private readonly runners = new Map<string, Runner>();
  private readonly downloads = new Map<string, Blob>(); // 下载好、还没导入成功的模型（导入失败时 retry 不用再下载）
  private readonly listeners = new Set<(e: JobEvent) => void>();
  private tokens = 0;

  constructor(deps: GenJobsDeps) {
    this.api = deps.api;
    this.storage = deps.storage;
    this.finishWork = (job, glb) => deps.finish(job, glb);
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
    this.makeId = deps.newId ?? (() => `job-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0')}`);
    this.jobs = this.read();
  }

  // —— 查询 ——

  // 全部任务，新的在前（副本）
  list(): GenJob[] {
    return this.jobs.map(toPublic);
  }

  get(id: string): GenJob | undefined {
    const job = this.find(id);
    return job ? toPublic(job) : undefined;
  }

  // 还没结束的（上传、提交、排队、生成、下载、导入中）
  active(): GenJob[] {
    return this.jobs.filter((j) => isActive(j.phase)).map(toPublic);
  }

  // 现在能不能取消：导入那一步（已经在往星球上加了）和结束了的不能
  canCancel(id: string): boolean {
    const job = this.find(id);
    return !!job && CANCELLABLE.includes(job.phase);
  }

  // 失败的任务能不能 retry()：现在只有导入失败的（Tripo 那边的模型还在）
  canRetry(id: string): boolean {
    const job = this.find(id);
    return !!job && job.phase === 'failed' && !!job.taskId && job.retryable === true;
  }

  // 任务变了（状态、进度、stalled、seen、删掉）就通知；在存档之后调。返回取消订阅的函数
  subscribe(fn: (e: JobEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // —— 操作 ——

  // 提交一个生成任务：马上返回新任务（单图、多视图是 uploading，文字是 submitting），之后的步骤在后台做，变化通过 subscribe 通知
  submit(input: GenSubmit): GenJob {
    const t = this.now();
    let id = this.makeId();
    if (this.find(id)) id = `${id}-${this.jobs.length}`;
    const job: StoredJob = {
      id,
      mode: input.mode,
      title: input.title.trim() || defaultTitle(input),
      teamId: input.teamId,
      options: cleanOptions(input.options),
      phase: input.mode === 'text' ? 'submitting' : 'uploading',
      progress: 0,
      createdAt: t,
      updatedAt: t,
    };
    if (input.mode === 'text') job.prompt = input.prompt.trim();
    else job.inputNames = (input.mode === 'image' ? [input.image] : input.views).filter((f): f is File => !!f).map((f) => f.name);
    if (typeof input.etaSec === 'number' && Number.isFinite(input.etaSec) && input.etaSec > 0) job.etaSec = Math.min(3600, input.etaSec);
    if (input.modelLabel) job.modelLabel = input.modelLabel.slice(0, 40);
    this.jobs.unshift(job);
    this.prune();
    this.persist();
    this.emit(job, null);
    const { token } = this.begin(id);
    // 下一个微任务才开始：调用方先拿到新任务，再收到它的变化（哪怕马上就失败）
    void Promise.resolve().then(() => this.run(id, token, input)).catch((err: unknown) => console.error('[tripo] job crashed', err));
    return toPublic(job);
  }

  // 取消：停止轮询，标成 cancelled，之后到的结果都不要。返回有没有取消（导入中、已经结束的不能取消）
  cancel(id: string): boolean {
    const job = this.find(id);
    if (!job || !CANCELLABLE.includes(job.phase)) return false;
    this.stop(id);
    this.downloads.delete(id);
    this.set(id, { phase: 'cancelled', stalled: undefined });
    return true;
  }

  // 重来一个失败的任务（canRetry 为真时）：模型还在内存里就直接再导入，不然重新下载。返回有没有开始
  retry(id: string): boolean {
    const job = this.find(id);
    if (!job || !this.canRetry(id)) return false;
    const { token } = this.begin(id);
    const fromDownload = this.downloads.has(id) || job.failedAt === 'downloading' || job.failedAt === 'importing';
    const phase: JobPhase = fromDownload ? (this.downloads.has(id) ? 'importing' : 'downloading') : job.failedAt === 'queued' ? 'queued' : 'running';
    this.set(id, { phase, error: undefined, failedAt: undefined, retryable: undefined });
    this.guard(() => (fromDownload ? this.fetchModel(id, token) : this.poll(id, token)));
    return true;
  }

  // 从列表里拿掉一个结束了的任务（done、failed、cancelled）。返回有没有拿掉
  dismiss(id: string): boolean {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0 || isActive(this.jobs[i].phase)) return false;
    const [job] = this.jobs.splice(i, 1);
    this.stop(id);
    this.downloads.delete(id);
    this.persist();
    this.emit(job, job.phase);
    return true;
  }

  // 页面打开后调一次：接着做存档里没完成的任务。有 taskId 的接着轮询（下载、导入中的重新下载）；
  // 还没拿到 taskId 的（上传、提交到一半关了页面）接不上，标成失败。已经在跑的不动（调几次都一样）
  resume(): void {
    for (const job of [...this.jobs]) {
      if (!isActive(job.phase) || this.runners.has(job.id)) continue;
      if (!job.taskId) {
        this.set(job.id, { phase: 'failed', error: { code: 'interrupted', message: describeError('interrupted') }, failedAt: job.phase, stalled: undefined });
        continue;
      }
      const { token } = this.begin(job.id);
      const id = job.id;
      if (job.phase === 'downloading' || job.phase === 'importing') this.guard(() => this.fetchModel(id, token));
      else this.guard(() => this.poll(id, token));
    }
  }

  // 用户看过结果了（点了完成提示、在窗口里打开过）
  markSeen(id: string): void {
    const job = this.find(id);
    if (job && !job.seen) this.set(id, { seen: true });
  }

  // Reset demo：停掉所有轮询、清空列表、删掉存档
  clear(): void {
    for (const id of [...this.runners.keys()]) this.stop(id);
    this.downloads.clear();
    const gone = this.jobs;
    this.jobs = [];
    try {
      this.storage?.removeItem(JOBS_KEY);
    } catch {
      // 删不掉也只能这样：内存里已经清空
    }
    for (const job of gone) this.emit(job, job.phase);
  }

  // —— 流程 ——

  private async run(id: string, token: number, input: GenInput): Promise<void> {
    const job = this.find(id);
    if (!job || this.stale(id, token)) return;
    const options = { ...job.options };
    try {
      let req: TaskRequest;
      if (input.mode === 'text') {
        if (!job.prompt) return this.fail(id, token, 'bad_request', { message: 'Describe the model you want first.' });
        if (job.prompt.length > MAX_PROMPT_CHARS) return this.fail(id, token, 'bad_request', { message: `Prompts can be up to ${MAX_PROMPT_CHARS} characters.` });
        req = { mode: 'text', prompt: job.prompt, ...options };
      } else if (input.mode === 'image') {
        const ref = await this.api.upload(input.image, input.image.name);
        if (this.stale(id, token)) return;
        this.set(id, { phase: 'submitting' });
        req = { mode: 'image', ...ref, ...options };
      } else {
        // 顺序：前、左、后、右；空着的格子留 null。前视图必须有，总共至少两张（中转也这样核对：先在这里拦下，不白传图片）
        const files = [0, 1, 2, 3].map((i) => input.views[i] ?? null);
        if (!files[0]) return this.fail(id, token, 'bad_request', { message: 'Add a front view first.' });
        if (files.filter((f) => f !== null).length < MIN_MULTIVIEW_IMAGES) return this.fail(id, token, 'bad_request', { message: 'Add at least one more view besides the front.' });
        const views = await Promise.all(files.map((f) => (f ? this.api.upload(f, f.name) : Promise.resolve(null))));
        if (this.stale(id, token)) return;
        this.set(id, { phase: 'submitting' });
        req = { mode: 'multiview', views, ...options };
      }
      const { taskId } = await this.api.createTask(req);
      if (this.stale(id, token)) return;
      this.set(id, { phase: 'queued', taskId, progress: 0, startedAt: this.now() });
      this.schedule(id, token, POLL_MIN_MS, () => this.poll(id, token));
    } catch (err) {
      if (this.stale(id, token)) return;
      const e = toTripoError(err);
      this.fail(id, token, e.code, { detail: e.serverMessage, retryAfter: e.retryAfter });
    }
  }

  // 问一次任务状态。排队、生成中：状态或进度变了就 2 秒后再问，没变就把间隔拉长（×1.25，最多 5 秒）
  private async poll(id: string, token: number): Promise<void> {
    const job = this.find(id);
    if (!job?.taskId || this.stale(id, token)) return;
    let info: TaskInfo;
    try {
      info = await this.api.getTask(job.taskId);
    } catch (err) {
      if (!this.stale(id, token)) this.hiccup(id, token, err, () => this.poll(id, token));
      return;
    }
    const r = this.runners.get(id);
    const cur = this.find(id);
    if (!r || r.token !== token || !cur) return;
    // 成功：Tripo 渲染的预览图先记下来，下载、导入模型期间窗口里就有图看
    if (info.status === 'success') return this.fetchModel(id, token, info.previewUrl ? this.api.resolve(info.previewUrl) : undefined);
    if (info.status === 'failed') return this.fail(id, token, 'upstream', { detail: info.error });
    if (info.status === 'cancelled') return this.end(id, token, { phase: 'cancelled', stalled: undefined });
    // unknown：当作没变，接着问
    const phase: JobPhase = info.status === 'queued' || info.status === 'running' ? info.status : cur.phase === 'queued' ? 'queued' : 'running';
    const reported = info.status === 'unknown' ? cur.progress : clampProgress(info.progress);
    const progress = phase === cur.phase ? Math.max(cur.progress, reported) : reported; // 同一步里进度不往回走
    const changed = phase !== cur.phase || progress !== cur.progress;
    const t = this.now();
    r.interval = this.inTail(cur, progress, t) ? POLL_TAIL_MS : changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(r.interval * POLL_GROWTH)));
    const patch: Partial<StoredJob> = { phase, progress, stalled: undefined };
    if (phase === 'running' && cur.runningAt === undefined) patch.runningAt = t;
    if (changed || cur.stalled || patch.runningAt !== undefined) this.set(id, patch);
    this.schedule(id, token, r.interval, () => this.poll(id, token));
  }

  // 是不是到了收尾（见 POLL_TAIL_*）：进度到了，或者在预计耗时的 85%–150% 之间
  private inTail(job: StoredJob, progress: number, t: number): boolean {
    if (progress >= POLL_TAIL_PROGRESS) return true;
    if (!job.etaSec || job.startedAt === undefined) return false;
    const k = (t - job.startedAt) / (job.etaSec * 1000);
    return k >= POLL_TAIL_FROM && k <= POLL_TAIL_UNTIL;
  }

  // 下载模型、交给 finish 导入。previewUrl：刚成功时轮询拿到的预览图
  private async fetchModel(id: string, token: number, previewUrl?: string): Promise<void> {
    let blob = this.downloads.get(id);
    if (!blob) {
      const job = this.find(id);
      if (!job?.taskId || this.stale(id, token)) return;
      // 从轮询转过来：stalled 清掉（下载重试时阶段已经是 downloading，不动它，免得一闪一闪）
      if (job.phase !== 'downloading') this.set(id, { phase: 'downloading', progress: 100, stalled: undefined, ...(previewUrl ? { previewUrl } : {}) });
      try {
        // 下载进度只通知、不存档（一秒好几次）
        blob = await this.api.download(job.taskId, (p) => { if (!this.stale(id, token)) this.set(id, { download: p }, false); });
      } catch (err) {
        if (!this.stale(id, token)) this.hiccup(id, token, err, () => this.fetchModel(id, token));
        return;
      }
      if (this.stale(id, token)) return;
      this.downloads.set(id, blob);
    }
    const job = this.find(id);
    if (!job || this.stale(id, token)) return;
    this.set(id, { phase: 'importing', progress: 100, stalled: undefined, download: undefined });
    let result: { workId: string };
    try {
      result = await this.finishWork(toPublic(job), blob);
    } catch (err) {
      if (this.stale(id, token)) return;
      return this.fail(id, token, 'import_failed', { detail: err instanceof Error ? err.message : String(err), retryable: true });
    }
    if (this.stale(id, token)) return;
    this.downloads.delete(id);
    this.end(id, token, { phase: 'done', progress: 100, workId: result.workId, error: undefined, stalled: undefined });
  }

  // 轮询、下载时出错：任务找不到就失败；别的（Tripo 忙、连不上、中转出错）不算失败，标成 stalled，过一会儿再试
  private hiccup(id: string, token: number, err: unknown, again: () => Promise<void>): void {
    const e = toTripoError(err);
    if (e.code === 'not_found') return this.fail(id, token, 'not_found', { detail: e.serverMessage });
    const wait = Math.min(RETRY_AFTER_CAP_MS, Math.max(POLL_MAX_MS, (e.retryAfter ?? 0) * 1000));
    if (!this.find(id)?.stalled) this.set(id, { stalled: true });
    this.schedule(id, token, wait, again);
  }

  private fail(id: string, token: number, code: GenErrorCode, f: Failure = {}): void {
    const job = this.find(id);
    if (!job || this.stale(id, token)) return;
    const error: GenError = { code, message: f.message ?? describeError(code, undefined, f.retryAfter) };
    if (f.retryAfter !== undefined) error.retryAfter = f.retryAfter;
    if (f.detail) error.detail = f.detail;
    this.end(id, token, { phase: 'failed', error, failedAt: job.phase, retryable: f.retryable && job.taskId ? true : undefined, stalled: undefined });
  }

  // 结束这一轮（done、failed、cancelled）：停掉计时器，写上结果
  private end(id: string, token: number, patch: Partial<StoredJob>): void {
    if (this.stale(id, token)) return;
    this.stop(id);
    this.set(id, patch);
  }

  // —— 计时器、token ——

  private begin(id: string): Runner {
    this.stop(id);
    const r: Runner = { token: ++this.tokens, timer: undefined, hasTimer: false, interval: POLL_MIN_MS };
    this.runners.set(id, r);
    return r;
  }

  private stop(id: string): void {
    const r = this.runners.get(id);
    if (!r) return;
    if (r.hasTimer) this.clearTimer(r.timer);
    r.hasTimer = false;
    this.runners.delete(id);
  }

  private stale(id: string, token: number): boolean {
    return this.runners.get(id)?.token !== token;
  }

  private schedule(id: string, token: number, ms: number, fn: () => Promise<void>): void {
    const r = this.runners.get(id);
    if (!r || r.token !== token) return;
    if (r.hasTimer) this.clearTimer(r.timer);
    r.hasTimer = true;
    r.timer = this.setTimer(() => {
      if (this.runners.get(id) !== r) return;
      r.hasTimer = false;
      this.guard(fn);
    }, ms);
  }

  private guard(fn: () => Promise<void>): void {
    fn().catch((err: unknown) => console.error('[tripo] job crashed', err));
  }

  // —— 数据 ——

  private find(id: string): StoredJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  // 改任务（值是 undefined 的字段删掉）→ 存档 → 通知。save = false：只通知（下载进度这种一秒好几次的）
  private set(id: string, patch: Partial<StoredJob>, save = true): void {
    const job = this.find(id);
    if (!job) return;
    const from = job.phase;
    const target = job as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
    job.updatedAt = this.now();
    if (save) this.persist();
    this.emit(job, from);
  }

  private emit(job: StoredJob, from: JobPhase | null): void {
    if (!this.listeners.size) return;
    const event: JobEvent = { job: toPublic(job), from };
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // 超过 MAX_JOBS：从最旧的开始删已经结束的；没结束的一个都不删
  private prune(): void {
    for (let i = this.jobs.length - 1; i >= 0 && this.jobs.length > MAX_JOBS; i--) {
      if (isActive(this.jobs[i].phase)) continue;
      this.downloads.delete(this.jobs[i].id);
      this.jobs.splice(i, 1);
    }
  }

  // 存档：{ v: 1, jobs }。stalled、download 不存（刷新以后重新判断、重新下载）；写不进去（配额满、隐私模式）时只留在内存里
  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(JOBS_KEY, JSON.stringify({ v: 1, jobs: this.jobs }, (key, value: unknown) => (key === 'stalled' || key === 'download' ? undefined : value)));
    } catch {
      // 下次改动时再试
    }
  }

  private read(): StoredJob[] {
    let raw: string | null;
    try {
      raw = this.storage?.getItem(JOBS_KEY) ?? null;
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const list: unknown[] = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const ids = new Set<string>();
    const jobs: StoredJob[] = [];
    for (const v of list) {
      const job = toStoredJob(v);
      if (!job || ids.has(job.id)) continue;
      ids.add(job.id);
      jobs.push(job);
    }
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }
}

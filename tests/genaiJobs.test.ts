import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../src/data/store';
import { TripoError } from '../src/genai/api';
import { GenJobs, JOBS_KEY, MAX_JOBS, MAX_PROMPT_CHARS, POLL_MAX_MS, POLL_MIN_MS, POLL_TAIL_MS, RETRY_AFTER_CAP_MS } from '../src/genai/jobs';
import type { GenJob, GenSubmit, ImageRef, JobEvent, JobPhase, TaskInfo, TaskRequest, TripoApi } from '../src/genai/types';

// 生成任务的状态机：假的中转（TripoApi）+ 手动计时器（一个个放出来），不碰网络、不等真时间

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

// 等排着的 Promise 回调都跑完（真的 setTimeout，没有被换掉）
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

// 手动计时器：GenJobs 排的每个计时器记下来，tick() 放出最早排的那个
function manualTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  return {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      pending.set(id, { fn, ms });
      delays.push(ms);
      return id;
    },
    clearTimeout: (h: unknown): void => void pending.delete(h as number),
    delays,
    pending: (): number => pending.size,
    nextDelay: (): number | undefined => [...pending.values()][0]?.ms,
    async tick(): Promise<number | undefined> {
      const first = [...pending.entries()][0];
      if (!first) return undefined;
      pending.delete(first[0]);
      first[1].fn();
      await flush();
      return first[1].ms;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GLB = new Blob(['glb-bytes'], { type: 'model/gltf-binary' });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (name: string): File => new File([PNG], name, { type: 'image/png' });
const running = (progress: number): TaskInfo => ({ status: 'running', progress });
const CJK = /[㐀-鿿]/;

// 假的中转：statuses 是 getTask 依次回的东西（Error 就抛出去；最后一个一直重复）
function fakeApi() {
  const statuses: Array<TaskInfo | Error | Promise<TaskInfo>> = [];
  let uploads = 0;
  const api = {
    base: '/api/tripo',
    health: vi.fn(async () => ({ ok: true, mock: true })),
    models: vi.fn(async () => ({ defaultModel: 'v3.1-20260211', defaultTexture: 'fast' as const, models: [] })),
    resolve: (url: string) => url,
    balance: vi.fn(async () => ({ balance: 100, frozen: 0 })),
    upload: vi.fn(async (_file: Blob, _name: string): Promise<ImageRef> => ({ token: `tok-${++uploads}`, type: 'png' })),
    createTask: vi.fn(async (_req: TaskRequest) => ({ taskId: 'task-1' })),
    getTask: vi.fn(async (_id: string): Promise<TaskInfo> => {
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (!next) return { status: 'queued', progress: 0 };
      if (next instanceof Error) throw next;
      return next;
    }),
    download: vi.fn(async (_id: string, _onProgress?: (p: { loaded: number; total?: number }) => void): Promise<Blob> => GLB),
  } satisfies TripoApi;
  return { api, statuses };
}

function setup(opts: { api?: TripoApi; storage?: ReturnType<typeof memStorage>; finish?: (job: GenJob, glb: Blob) => Promise<{ workId: string }> } = {}) {
  const timers = manualTimers();
  const storage = opts.storage ?? memStorage();
  const impl: (job: GenJob, glb: Blob) => Promise<{ workId: string }> = opts.finish ?? (async () => ({ workId: 'u-1' }));
  const finish = vi.fn(impl);
  const api = opts.api ?? fakeApi().api;
  let n = 0;
  let clock = 1_000_000;
  const jobs = new GenJobs({ api, storage, finish, now: () => clock, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, newId: () => `job-${++n}-${clock}` });
  const events: JobEvent[] = [];
  jobs.subscribe((e) => events.push(e));
  // 某个任务经过的阶段（连续相同的只算一次）
  const phases = (id: string): JobPhase[] => events.filter((e) => e.job.id === id).map((e) => e.job.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);
  return { jobs, timers, storage, finish, events, phases, advance: (ms: number) => { clock += ms; } };
}

const text = (prompt: string, extra: Partial<{ title: string; teamId: string }> = {}): GenSubmit =>
  ({ mode: 'text' as const, prompt, title: extra.title ?? '', teamId: extra.teamId ?? 'lumen-guild', options: { texture: true } });

afterEach(() => {
  vi.useRealTimers();
});

describe('GenJobs：提交和轮询', () => {
  it('文字：submitting → queued → running → downloading → importing → done，finish 拿到下载的 GLB，结果存进本地', async () => {
    const { api, statuses } = fakeApi();
    statuses.push({ status: 'queued', progress: 0 }, running(40), { status: 'success', progress: 100, modelUrl: '/api/tripo/download/task-1' });
    const t = setup({ api });
    const job = t.jobs.submit(text('  a red fox, sitting!  '));
    expect(job).toMatchObject({ phase: 'submitting', progress: 0, title: 'A red fox, sitting', prompt: 'a red fox, sitting!', teamId: 'lumen-guild', options: { texture: true } });
    expect(t.events[0].from).toBeNull();
    await flush();
    expect(api.createTask).toHaveBeenCalledWith({ mode: 'text', prompt: 'a red fox, sitting!', texture: true });
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'queued', taskId: 'task-1' });
    expect(t.timers.nextDelay()).toBe(POLL_MIN_MS);
    await t.timers.tick(); // queued 0：没变
    expect(t.jobs.get(job.id)?.phase).toBe('queued');
    await t.timers.tick(); // running 40
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 40 });
    await t.timers.tick(); // success → 下载 → 导入 → done
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'done', progress: 100, workId: 'u-1', taskId: 'task-1' });
    expect(api.download).toHaveBeenCalledWith('task-1', expect.any(Function));
    expect(t.finish).toHaveBeenCalledTimes(1);
    expect(t.finish.mock.calls[0][0]).toMatchObject({ id: job.id, prompt: 'a red fox, sitting!', teamId: 'lumen-guild', phase: 'importing' });
    expect(t.finish.mock.calls[0][1]).toBe(GLB);
    expect(t.phases(job.id)).toEqual(['submitting', 'queued', 'running', 'downloading', 'importing', 'done']);
    expect(t.timers.pending()).toBe(0);
    expect(t.jobs.active()).toEqual([]);
    const again = new GenJobs({ api, storage: t.storage, finish: t.finish });
    expect(again.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-1' });
  });

  it('单图：先上传拿 token，再用 token、type 建任务（uploading → submitting → queued）', async () => {
    const { api } = fakeApi();
    const t = setup({ api });
    const file = png('my_fox-photo.png');
    const job = t.jobs.submit({ mode: 'image', image: file, title: '', teamId: 'kiln-collective', options: {} });
    expect(job).toMatchObject({ phase: 'uploading', title: 'My fox photo', inputNames: ['my_fox-photo.png'] });
    await flush();
    expect(api.upload).toHaveBeenCalledWith(file, 'my_fox-photo.png');
    expect(api.createTask).toHaveBeenCalledWith({ mode: 'image', token: 'tok-1', type: 'png' });
    expect(t.phases(job.id)).toEqual(['uploading', 'submitting', 'queued']);
  });

  it('单图：中转没回 type 时请求里也不带 type', async () => {
    const { api } = fakeApi();
    api.upload.mockResolvedValueOnce({ token: 'tok-x' });
    const t = setup({ api });
    t.jobs.submit({ mode: 'image', image: png('a.png'), title: 'A', teamId: 't', options: {} });
    await flush();
    expect(api.createTask).toHaveBeenCalledWith({ mode: 'image', token: 'tok-x' });
  });

  it('多视图：空着的格子留 null（前、左、后、右），只上传有图的', async () => {
    const { api } = fakeApi();
    const t = setup({ api });
    const front = png('front.png');
    const back = png('back.png');
    const job = t.jobs.submit({ mode: 'multiview', views: [front, null, back, null], title: 'Robot', teamId: 't', options: { texture: false } });
    expect(job).toMatchObject({ phase: 'uploading', title: 'Robot', inputNames: ['front.png', 'back.png'] });
    await flush();
    expect(api.upload.mock.calls.map((c) => c[1])).toEqual(['front.png', 'back.png']);
    expect(api.createTask).toHaveBeenCalledWith({ mode: 'multiview', views: [{ token: 'tok-1', type: 'png' }, null, { token: 'tok-2', type: 'png' }, null], texture: false });
    expect(t.jobs.get(job.id)?.phase).toBe('queued');
  });

  it('多视图：没有前视图、或者只有前视图 → bad_request，不上传、不建任务', async () => {
    const { api } = fakeApi();
    const t = setup({ api });
    const noFront = t.jobs.submit({ mode: 'multiview', views: [null, png('left.png'), png('back.png'), null], title: '', teamId: 't', options: {} });
    expect(noFront.phase).toBe('uploading'); // 先拿到新任务，失败在后面通知
    const onlyFront = t.jobs.submit({ mode: 'multiview', views: [png('front.png'), null, null, null], title: '', teamId: 't', options: {} });
    await flush();
    expect(t.jobs.get(noFront.id)).toMatchObject({ phase: 'failed', error: { code: 'bad_request', message: 'Add a front view first.' } });
    expect(t.jobs.get(onlyFront.id)).toMatchObject({ phase: 'failed', error: { code: 'bad_request', message: 'Add at least one more view besides the front.' } });
    expect(api.upload).not.toHaveBeenCalled();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(t.jobs.canRetry(noFront.id)).toBe(false);
  });

  it('退避：状态没变时间隔 ×1.25 拉长到 5 秒为止，进度一变回到 2 秒；所有间隔都在 2–5 秒之间', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(running(10), running(10), running(10), running(10), running(10), running(10), running(10), running(20), running(20));
    const t = setup({ api });
    t.jobs.submit(text('a lamp'));
    await flush();
    for (let i = 0; i < 9; i++) await t.timers.tick();
    expect(t.timers.delays).toEqual([2000, 2000, 2500, 3125, 3906, 4883, 5000, 5000, 2000, 2500]);
    for (const d of t.timers.delays) {
      expect(d).toBeGreaterThanOrEqual(POLL_MIN_MS);
      expect(d).toBeLessThanOrEqual(POLL_MAX_MS);
    }
  });

  it('收尾：进度到 90% 以后每秒问一次；按预计耗时，过了 85% 也每秒问，超过 1.5 倍回到平时的退避', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(running(50), running(90), running(95));
    const t = setup({ api });
    t.jobs.submit(text('a lamp'));
    await flush();
    for (let i = 0; i < 3; i++) await t.timers.tick();
    // 2000（建好后第一次问）→ running 50 变了：2000 → running 90：收尾 1000 → 95：1000
    expect(t.timers.delays).toEqual([2000, 2000, POLL_TAIL_MS, POLL_TAIL_MS]);

    const b = fakeApi();
    b.statuses.push(running(40));
    const u = setup({ api: b.api });
    u.jobs.submit({ ...text('a vase'), etaSec: 100 });
    await flush();
    await u.timers.tick(); // 刚建好：40% 变了 → 2 秒
    u.advance(86_000); // 过了预计的 86%
    await u.timers.tick();
    u.advance(70_000); // 156%：超过 1.5 倍
    await u.timers.tick();
    expect(u.timers.delays).toEqual([2000, 2000, POLL_TAIL_MS, POLL_MIN_MS]);
  });

  it('记下预计耗时、模型名、开始时间、第一次 running 的时间、成功时的预览图（按中转地址解析），刷新以后还在；下载进度不存档', async () => {
    const { api, statuses } = fakeApi();
    let progressSeen = false;
    api.resolve = (url: string) => `https://proxy.example${url}`;
    api.download.mockImplementation(async (_id: string, onProgress?: (p: { loaded: number; total?: number }) => void) => {
      onProgress?.({ loaded: 10, total: 40 });
      progressSeen = true;
      return GLB;
    });
    statuses.push(running(30), { status: 'success', progress: 100, modelUrl: '/api/tripo/download/task-1', previewUrl: '/api/tripo/preview/task-1' });
    let release!: () => void;
    const t = setup({ api, finish: () => new Promise((r) => { release = () => r({ workId: 'u-9' }); }) });
    const job = t.jobs.submit({ ...text('a kite'), etaSec: 95, modelLabel: 'H3.1' });
    expect(job).toMatchObject({ etaSec: 95, modelLabel: 'H3.1' });
    await flush();
    expect(t.jobs.get(job.id)?.startedAt).toBe(1_000_000);
    t.advance(3000);
    await t.timers.tick(); // running 30
    expect(t.jobs.get(job.id)?.runningAt).toBe(1_003_000);
    await t.timers.tick(); // success → 下载（报一次进度）→ 导入（finish 还没回）
    expect(progressSeen).toBe(true);
    expect(t.events.some((e) => e.job.download?.loaded === 10 && e.job.download.total === 40)).toBe(true);
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'importing', previewUrl: 'https://proxy.example/api/tripo/preview/task-1' });
    expect(t.jobs.get(job.id)?.download).toBeUndefined();
    const saved = t.storage.data.get(JOBS_KEY) ?? '';
    expect(saved).not.toContain('"download"');
    const again = new GenJobs({ api, storage: t.storage, finish: async () => ({ workId: 'x' }) });
    expect(again.get(job.id)).toMatchObject({ etaSec: 95, modelLabel: 'H3.1', startedAt: 1_000_000, runningAt: 1_003_000, previewUrl: 'https://proxy.example/api/tripo/preview/task-1' });
    release();
    await flush();
    expect(t.jobs.get(job.id)?.phase).toBe('done');
  });

  it('存档里的预览图地址只认 / 开头的路径和 http(s)：javascript: 之类丢掉', () => {
    const storage = memStorage();
    const base = { mode: 'text', title: 'A', teamId: 't', options: {}, phase: 'importing', progress: 100, createdAt: 1, updatedAt: 1, taskId: 'task-1' };
    storage.setItem(JOBS_KEY, JSON.stringify({ v: 1, jobs: [{ ...base, id: 'job-a', previewUrl: 'javascript:alert(1)' }, { ...base, id: 'job-b', previewUrl: '//evil.example/x.png' }, { ...base, id: 'job-c', previewUrl: '/api/tripo/preview/task-1' }] }));
    const jobs = new GenJobs({ api: fakeApi().api, storage, finish: async () => ({ workId: 'x' }) });
    expect(jobs.get('job-a')?.previewUrl).toBeUndefined();
    expect(jobs.get('job-b')?.previewUrl).toBeUndefined();
    expect(jobs.get('job-c')?.previewUrl).toBe('/api/tripo/preview/task-1');
  });

  it('进度不往回走；unknown 当作没变，接着问', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(running(50), running(30), { status: 'unknown', progress: 0 }, running(70));
    const t = setup({ api });
    const job = t.jobs.submit(text('a vase'));
    await flush();
    await t.timers.tick();
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 50 });
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 50 });
    await t.timers.tick();
    expect(t.jobs.get(job.id)?.progress).toBe(70);
  });
});

describe('GenJobs：出错', () => {
  it('提交时额度用完（quota）：失败，英文提示说额度用完；中转的原话只在 detail 里；不能 retry', async () => {
    const { api } = fakeApi();
    api.createTask.mockRejectedValueOnce(new TripoError('quota', { status: 402, serverMessage: '额度不足' }));
    const t = setup({ api });
    const job = t.jobs.submit(text('a castle'));
    await flush();
    const failed = t.jobs.get(job.id)!;
    expect(failed).toMatchObject({ phase: 'failed', error: { code: 'quota', detail: '额度不足' } });
    expect(failed.error?.message).toMatch(/credits are used up/);
    expect(failed.error?.message).not.toMatch(CJK);
    expect(t.jobs.canRetry(job.id)).toBe(false);
    expect(t.jobs.retry(job.id)).toBe(false);
    expect(t.timers.pending()).toBe(0);
  });

  it('提交时今天的上限（daily_cap）、Tripo 忙（rate_limited）：提示里说要等多久，retryAfter 记在 error 上', async () => {
    const { api } = fakeApi();
    api.createTask
      .mockRejectedValueOnce(new TripoError('daily_cap', { status: 429, retryAfter: 7200 }))
      .mockRejectedValueOnce(new TripoError('rate_limited', { status: 429, retryAfter: 12, serverMessage: '请求太频繁' }));
    const t = setup({ api });
    const cap = t.jobs.submit(text('a tree'));
    await flush();
    const busy = t.jobs.submit(text('a bush'));
    await flush();
    expect(t.jobs.get(cap.id)?.error).toMatchObject({ code: 'daily_cap', retryAfter: 7200 });
    expect(t.jobs.get(cap.id)?.error?.message).toBe("Today's generation limit for this demo is reached. Try again in 2 hours, or upload a model instead.");
    expect(t.jobs.get(busy.id)?.error).toMatchObject({ code: 'rate_limited', retryAfter: 12, detail: '请求太频繁', message: 'Tripo is busy right now. Try again in 12 seconds.' });
  });

  it('上传失败（bad_request，比如图片格式不对）：失败，不建任务', async () => {
    const { api } = fakeApi();
    api.upload.mockRejectedValueOnce(new TripoError('bad_request', { status: 400, serverMessage: '只支持 PNG 和 JPEG' }));
    const t = setup({ api });
    const job = t.jobs.submit({ mode: 'image', image: png('x.webp'), title: '', teamId: 't', options: {} });
    await flush();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'failed', error: { code: 'bad_request', detail: '只支持 PNG 和 JPEG' } });
    expect(t.jobs.get(job.id)?.error?.message).not.toMatch(CJK);
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('提交时连不上（fetch 抛的普通错误）：network', async () => {
    const { api } = fakeApi();
    api.createTask.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const t = setup({ api });
    const job = t.jobs.submit(text('a boat'));
    await flush();
    expect(t.jobs.get(job.id)?.error?.code).toBe('network');
  });

  it('Tripo 说任务失败：upstream，提示是英文，原话进 detail；不能 retry', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(running(30), { status: 'failed', progress: 60, error: '模拟失败：提示词里带了 #fail' });
    const t = setup({ api });
    const job = t.jobs.submit(text('a ship #fail'));
    await flush();
    await t.timers.tick();
    await t.timers.tick();
    const failed = t.jobs.get(job.id)!;
    expect(failed).toMatchObject({ phase: 'failed', progress: 30, error: { code: 'upstream', message: "Tripo couldn't generate this model. Please try again.", detail: '模拟失败：提示词里带了 #fail' } });
    expect(t.jobs.canRetry(job.id)).toBe(false);
    expect(api.download).not.toHaveBeenCalled();
    expect(t.timers.pending()).toBe(0);
  });

  it('轮询时 Tripo 忙、连不上、中转出错都不算失败：stalled，隔 5 秒（或 retryAfter，最多 30 秒）再问，好了以后接着走完', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(
      new TripoError('network'),
      new TripoError('rate_limited', { status: 429, retryAfter: 12 }),
      new TripoError('rate_limited', { status: 429, retryAfter: 120 }),
      new TripoError('upstream', { status: 502 }),
      new TripoError('unavailable', { status: 404 }),
      running(30),
      { status: 'success', progress: 100 },
    );
    const t = setup({ api });
    const job = t.jobs.submit(text('a crown'));
    await flush();
    await t.timers.tick(); // network
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'queued', stalled: true });
    expect(t.storage.data.get(JOBS_KEY)).not.toContain('stalled'); // stalled 不存档
    expect(t.timers.nextDelay()).toBe(POLL_MAX_MS);
    await t.timers.tick(); // rate_limited 12 秒
    expect(t.timers.nextDelay()).toBe(12_000);
    await t.timers.tick(); // rate_limited 120 秒：最多等 30 秒
    expect(t.timers.nextDelay()).toBe(RETRY_AFTER_CAP_MS);
    await t.timers.tick(); // upstream
    expect(t.timers.nextDelay()).toBe(POLL_MAX_MS);
    await t.timers.tick(); // unavailable
    expect(t.jobs.get(job.id)?.phase).toBe('queued');
    await t.timers.tick(); // running 30：stalled 清掉
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 30 });
    expect(t.jobs.get(job.id)?.stalled).toBeUndefined();
    expect(t.timers.nextDelay()).toBe(POLL_MIN_MS);
    await t.timers.tick();
    expect(t.jobs.get(job.id)?.phase).toBe('done');
    const stalls = t.events.filter((e) => e.job.stalled).length;
    expect(stalls).toBe(1); // 只在开始 stalled 时通知一次
  });

  it('连着出错很多次也不放弃（一直问到好或者用户取消）', async () => {
    const { api, statuses } = fakeApi();
    for (let i = 0; i < 20; i++) statuses.push(new TripoError('network'));
    statuses.push(running(5));
    const t = setup({ api });
    const job = t.jobs.submit(text('a mug'));
    await flush();
    for (let i = 0; i < 20; i++) await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'queued', stalled: true });
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 5 });
    expect(t.jobs.cancel(job.id)).toBe(true);
  });

  it('轮询时 stalled，任务一好转去下载：stalled 清掉', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(new TripoError('network'), { status: 'success', progress: 100 });
    const download = deferred<Blob>();
    api.download.mockReturnValueOnce(download.promise);
    const t = setup({ api });
    const job = t.jobs.submit(text('a bowl'));
    await flush();
    await t.timers.tick();
    expect(t.jobs.get(job.id)?.stalled).toBe(true);
    await t.timers.tick();
    expect(t.jobs.get(job.id)?.phase).toBe('downloading');
    expect(t.jobs.get(job.id)?.stalled).toBeUndefined();
    download.resolve(GLB);
    await flush();
    expect(t.jobs.get(job.id)?.phase).toBe('done');
  });

  it(`提示词超过 ${MAX_PROMPT_CHARS} 个字符：bad_request，不建任务`, async () => {
    const { api } = fakeApi();
    const t = setup({ api });
    const job = t.jobs.submit(text('x'.repeat(MAX_PROMPT_CHARS + 1)));
    await flush();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'failed', error: { code: 'bad_request', message: `Prompts can be up to ${MAX_PROMPT_CHARS} characters.` } });
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('轮询时任务找不到（not_found）：失败，不能 retry', async () => {
    const { api, statuses } = fakeApi();
    statuses.push(new TripoError('not_found', { status: 404, serverMessage: '任务不存在' }));
    const t = setup({ api });
    const job = t.jobs.submit(text('a key'));
    await flush();
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'failed', error: { code: 'not_found', detail: '任务不存在' } });
    expect(t.jobs.canRetry(job.id)).toBe(false);
    expect(t.timers.pending()).toBe(0);
  });

  it('下载时连不上：stalled，5 秒后再下；下载时 not_found：失败', async () => {
    const { api, statuses } = fakeApi();
    statuses.push({ status: 'success', progress: 100 });
    api.download.mockRejectedValueOnce(new TripoError('network')).mockRejectedValueOnce(new TripoError('upstream', { status: 500 }));
    const t = setup({ api });
    const job = t.jobs.submit(text('a drum'));
    await flush();
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'downloading', stalled: true });
    expect(t.timers.nextDelay()).toBe(POLL_MAX_MS);
    await t.timers.tick();
    expect(t.jobs.get(job.id)?.phase).toBe('downloading');
    await t.timers.tick();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-1' });
    expect(api.download).toHaveBeenCalledTimes(3);

    const second = fakeApi();
    second.statuses.push({ status: 'success', progress: 100 });
    second.api.download.mockRejectedValueOnce(new TripoError('not_found', { status: 404 }));
    const u = setup({ api: second.api });
    const gone = u.jobs.submit(text('a bell'));
    await flush();
    await u.timers.tick();
    expect(u.jobs.get(gone.id)).toMatchObject({ phase: 'failed', error: { code: 'not_found' } });
  });

  it('导入失败：import_failed（英文提示，原话进 detail），能 retry；重来时直接用内存里的模型，不再下载', async () => {
    const { api, statuses } = fakeApi();
    statuses.push({ status: 'success', progress: 100 });
    const finish = vi.fn<(job: GenJob, glb: Blob) => Promise<{ workId: string }>>()
      .mockRejectedValueOnce(new Error('This file uses Draco compression'))
      .mockResolvedValueOnce({ workId: 'u-9' });
    const t = setup({ api, finish });
    const job = t.jobs.submit(text('a chair'));
    await flush();
    await t.timers.tick();
    const failed = t.jobs.get(job.id)!;
    expect(failed).toMatchObject({ phase: 'failed', error: { code: 'import_failed', detail: 'This file uses Draco compression' } });
    expect(failed.error?.message).toBe("The model was generated, but it couldn't be added to your planet. Please try again.");
    expect(failed).not.toHaveProperty('retryable'); // 内部字段不给出去
    expect(t.jobs.canRetry(job.id)).toBe(true);
    expect(t.jobs.retry(job.id)).toBe(true);
    await flush();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-9' });
    expect(t.jobs.get(job.id)?.error).toBeUndefined();
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(t.finish).toHaveBeenCalledTimes(2);
    expect(t.finish.mock.calls[1][1]).toBe(GLB);
  });

  it('导入失败以后刷新：存档里记得能 retry，重来时重新下载', async () => {
    const storage = memStorage();
    const first = fakeApi();
    first.statuses.push({ status: 'success', progress: 100 });
    const a = setup({ api: first.api, storage, finish: async () => { throw new Error('bad glb'); } });
    const job = a.jobs.submit(text('a sofa'));
    await flush();
    await a.timers.tick();
    expect(a.jobs.get(job.id)?.phase).toBe('failed');
    const second = fakeApi();
    const b = setup({ api: second.api, storage });
    expect(b.jobs.canRetry(job.id)).toBe(true);
    expect(b.jobs.retry(job.id)).toBe(true);
    await flush();
    expect(second.api.download).toHaveBeenCalledWith('task-1', expect.any(Function));
    expect(b.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-1' });
  });
});

describe('GenJobs：取消、刷新、清空', () => {
  it('轮询中取消：标成 cancelled，不再问；晚到的结果不要', async () => {
    const { api, statuses } = fakeApi();
    const late = deferred<TaskInfo>();
    statuses.push(late.promise);
    const t = setup({ api });
    const job = t.jobs.submit(text('a sword'));
    await flush();
    void t.timers.tick(); // getTask 发出去了，还没回
    await flush();
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect(t.jobs.canCancel(job.id)).toBe(true);
    expect(t.jobs.cancel(job.id)).toBe(true);
    expect(t.jobs.get(job.id)?.phase).toBe('cancelled');
    late.resolve({ status: 'success', progress: 100 });
    await flush();
    expect(t.jobs.get(job.id)?.phase).toBe('cancelled');
    expect(api.download).not.toHaveBeenCalled();
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect(t.timers.pending()).toBe(0);
    expect(t.jobs.cancel(job.id)).toBe(false); // 已经结束的不能再取消
  });

  it('上传中取消：上传回来以后不建任务', async () => {
    const { api } = fakeApi();
    const up = deferred<ImageRef>();
    api.upload.mockReturnValueOnce(up.promise);
    const t = setup({ api });
    const job = t.jobs.submit({ mode: 'image', image: png('a.png'), title: '', teamId: 't', options: {} });
    await flush();
    expect(t.jobs.cancel(job.id)).toBe(true);
    up.resolve({ token: 'tok', type: 'png' });
    await flush();
    expect(api.createTask).not.toHaveBeenCalled();
    expect(t.jobs.get(job.id)?.phase).toBe('cancelled');
  });

  it('导入中不能取消（已经在往星球上加了）', async () => {
    const { api, statuses } = fakeApi();
    statuses.push({ status: 'success', progress: 100 });
    const importing = deferred<{ workId: string }>();
    const t = setup({ api, finish: () => importing.promise });
    const job = t.jobs.submit(text('a hat'));
    await flush();
    void t.timers.tick();
    await flush();
    expect(t.jobs.get(job.id)?.phase).toBe('importing');
    expect(t.jobs.canCancel(job.id)).toBe(false);
    expect(t.jobs.cancel(job.id)).toBe(false);
    importing.resolve({ workId: 'u-2' });
    await flush();
    expect(t.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-2' });
  });

  it('刷新以后：有 taskId 的接着轮询（马上问一次）；上传到一半的接不上，标成 interrupted；resume 调几次都一样', async () => {
    const storage = memStorage();
    const first = fakeApi();
    first.api.upload.mockReturnValue(new Promise<ImageRef>(() => {})); // 上传一直没回：页面就在这时刷新了
    const a = setup({ api: first.api, storage });
    const textJob = a.jobs.submit(text('a robot'));
    a.advance(1000);
    const imgJob = a.jobs.submit({ mode: 'image', image: png('cat.png'), title: '', teamId: 't', options: {} });
    await flush();
    expect(a.jobs.get(textJob.id)).toMatchObject({ phase: 'queued', taskId: 'task-1' });
    expect(a.jobs.get(imgJob.id)?.phase).toBe('uploading');

    const second = fakeApi();
    second.statuses.push(running(50), { status: 'success', progress: 100 });
    const b = setup({ api: second.api, storage });
    expect(b.jobs.list().map((j) => j.id)).toEqual([imgJob.id, textJob.id]); // 新的在前
    b.jobs.resume();
    await flush();
    expect(second.api.getTask).toHaveBeenCalledWith('task-1');
    expect(b.jobs.get(textJob.id)).toMatchObject({ phase: 'running', progress: 50 });
    expect(b.jobs.get(imgJob.id)).toMatchObject({ phase: 'failed', error: { code: 'interrupted' } });
    expect(b.jobs.get(imgJob.id)?.error?.message).toMatch(/closed before Tripo received/);
    expect(b.jobs.canRetry(imgJob.id)).toBe(false);
    b.jobs.resume();
    await flush();
    expect(second.api.getTask).toHaveBeenCalledTimes(1);
    await b.timers.tick();
    expect(b.jobs.get(textJob.id)).toMatchObject({ phase: 'done', workId: 'u-1' });
  });

  it('刷新以后：下载、导入到一半的重新下载', async () => {
    const storage = memStorage();
    const first = fakeApi();
    first.statuses.push({ status: 'success', progress: 100 });
    const importing = deferred<{ workId: string }>();
    const a = setup({ api: first.api, storage, finish: () => importing.promise });
    const job = a.jobs.submit(text('a tower'));
    await flush();
    void a.timers.tick();
    await flush();
    expect(a.jobs.get(job.id)?.phase).toBe('importing');
    const second = fakeApi();
    const b = setup({ api: second.api, storage });
    b.jobs.resume();
    await flush();
    expect(second.api.getTask).not.toHaveBeenCalled();
    expect(second.api.download).toHaveBeenCalledWith('task-1', expect.any(Function));
    expect(b.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-1' });
  });

  it('clear（Reset demo）：停掉所有轮询，列表清空，存档删掉；晚到的结果不要', async () => {
    const { api, statuses } = fakeApi();
    const late = deferred<TaskInfo>();
    statuses.push(late.promise);
    const t = setup({ api });
    t.jobs.submit(text('a fish'));
    t.jobs.submit(text('a frog'));
    await flush();
    void t.timers.tick();
    await flush();
    expect(t.storage.data.has(JOBS_KEY)).toBe(true);
    t.jobs.clear();
    expect(t.jobs.list()).toEqual([]);
    expect(t.storage.data.has(JOBS_KEY)).toBe(false);
    expect(t.timers.pending()).toBe(0);
    late.resolve({ status: 'success', progress: 100 });
    await flush();
    expect(api.download).not.toHaveBeenCalled();
    expect(t.jobs.list()).toEqual([]);
    expect(t.storage.data.has(JOBS_KEY)).toBe(false);
  });

  it('dismiss：只能拿掉结束了的任务；markSeen 存下来；退订以后不再通知', async () => {
    const { api } = fakeApi();
    api.createTask.mockRejectedValueOnce(new TripoError('quota'));
    const t = setup({ api });
    const failed = t.jobs.submit(text('a coin'));
    const live = t.jobs.submit(text('a gem'));
    await flush();
    expect(t.jobs.dismiss(live.id)).toBe(false);
    t.jobs.markSeen(failed.id);
    expect(new GenJobs({ api, storage: t.storage, finish: t.finish }).get(failed.id)?.seen).toBe(true);
    expect(t.jobs.dismiss(failed.id)).toBe(true);
    expect(t.jobs.list().map((j) => j.id)).toEqual([live.id]);
    expect(new GenJobs({ api, storage: t.storage, finish: t.finish }).get(failed.id)).toBeUndefined();
    const seen: JobEvent[] = [];
    const off = t.jobs.subscribe((e) => seen.push(e));
    off();
    t.jobs.cancel(live.id);
    expect(seen).toEqual([]);
  });

  it('通知在存档之后：监听者读存档时已经是新状态', async () => {
    const { api } = fakeApi();
    const t = setup({ api });
    const stored: string[] = [];
    t.jobs.subscribe((e) => {
      const raw = JSON.parse(t.storage.data.get(JOBS_KEY) ?? '{"jobs":[]}') as { jobs: GenJob[] };
      stored.push(`${e.job.phase}=${raw.jobs.find((j) => j.id === e.job.id)?.phase}`);
    });
    t.jobs.submit(text('a kite'));
    await flush();
    expect(stored).toEqual(['submitting=submitting', 'queued=queued']);
  });

  it(`最多留 ${MAX_JOBS} 个：先删最早结束的，没结束的一个都不删`, async () => {
    const storage = memStorage();
    const base = { mode: 'text', title: 'Old', teamId: 't', options: {}, progress: 100 };
    const jobs = [
      ...Array.from({ length: 32 }, (_, i) => ({ ...base, id: `job-done-${i}`, phase: 'done', createdAt: 1000 + i, updatedAt: 1000 + i, workId: `u-${i}` })),
      { ...base, id: 'job-old-live', phase: 'running', progress: 10, taskId: 'task-old', createdAt: 1, updatedAt: 1 },
    ];
    storage.setItem(JOBS_KEY, JSON.stringify({ v: 1, jobs: [...jobs, { id: 'broken' }] }));
    const t = setup({ api: fakeApi().api, storage });
    expect(t.jobs.list()).toHaveLength(33); // 坏的那条丢掉
    t.jobs.submit(text('a new one'));
    const left = t.jobs.list();
    expect(left).toHaveLength(MAX_JOBS);
    expect(left.some((j) => j.id === 'job-old-live')).toBe(true);
    expect(left.some((j) => j.id === 'job-done-0')).toBe(false);
    expect(left.some((j) => j.id === 'job-done-31')).toBe(true);
  });

  it('不给计时器时用全局的 setTimeout（vi.useFakeTimers）', async () => {
    vi.useFakeTimers();
    const { api, statuses } = fakeApi();
    statuses.push(running(20));
    const jobs = new GenJobs({ api, storage: null, finish: async () => ({ workId: 'u-1' }) });
    const job = jobs.submit(text('a cup'));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.createTask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MIN_MS - 1);
    expect(api.getTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.getTask).toHaveBeenCalledTimes(1);
    expect(jobs.get(job.id)).toMatchObject({ phase: 'running', progress: 20 });
    jobs.clear();
  });
});

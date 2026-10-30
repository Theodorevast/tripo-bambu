import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../src/data/store';
import { createTripoApi, TripoError } from '../src/genai/api';
import { GenJobs } from '../src/genai/jobs';
import {
  clearMockState, createMockFetch, MOCK_COSTS, MOCK_FAIL_AT, MOCK_FAIL_ERROR, MOCK_IMAGE_MODEL, MOCK_KEY, MOCK_MAX_IMAGE_BYTES, MOCK_MULTIVIEW_MODEL,
  MOCK_QUEUE_MS, MOCK_RATE_RETRY_AFTER, MOCK_RUN_MS, MOCK_START_BALANCE, MOCK_TEXT_MODELS, type MockOptions,
} from '../src/genai/mock';
import type { GenJob, TripoApi } from '../src/genai/types';

// 前端的模拟中转：走 createTripoApi（和真的中转同一套客户端），时间用注入的时钟，模型用假的 Blob，不碰网络

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const image = (name: string, bytes = PNG, type = 'image/png'): File => new File([new Uint8Array(bytes)], name, { type });
const BASE = '/api/tripo';

function setup(extra: Partial<MockOptions> = {}) {
  let clock = 1_700_000_000_000;
  const storage = memStorage();
  const fetchModel = vi.fn(async (file: string) => new Blob([`glb:${file}`], { type: 'model/gltf-binary' }));
  const mockFetch = (opts: Partial<MockOptions> = {}) => createMockFetch({ base: BASE, storage, now: () => clock, latency: 0, fetchModel, ...extra, ...opts });
  const make = (opts: Partial<MockOptions> = {}): TripoApi => createTripoApi({ base: BASE, fetch: mockFetch(opts) });
  return { api: make(), make, mockFetch, storage, fetchModel, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

async function rejects(p: Promise<unknown>): Promise<TripoError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TripoError);
    return err as TripoError;
  }
  throw new Error('expected a TripoError');
}

const DONE_MS = MOCK_QUEUE_MS + MOCK_RUN_MS + 1;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模拟中转：接口', () => {
  it('health 说是模拟模式；balance 开始是 2000，建任务时冻结，成功了扣掉，失败了退回', async () => {
    const m = setup();
    expect(await m.api.health()).toEqual({ ok: true, mock: true });
    expect(await m.api.balance()).toEqual({ balance: MOCK_START_BALANCE, frozen: 0 });
    await m.api.createTask({ mode: 'text', prompt: 'a red fox' });
    expect(await m.api.balance()).toEqual({ balance: MOCK_START_BALANCE - MOCK_COSTS.text, frozen: MOCK_COSTS.text });
    await m.api.createTask({ mode: 'text', prompt: 'a broken fox #fail' });
    expect((await m.api.balance()).frozen).toBe(2 * MOCK_COSTS.text);
    m.advance(DONE_MS);
    expect(await m.api.balance()).toEqual({ balance: MOCK_START_BALANCE - MOCK_COSTS.text, frozen: 0 }); // 失败的那个退回了
  });

  it('上传：只收 PNG、JPEG（看文件头），10 MB 以内；token 是 mock-img- 开头', async () => {
    const m = setup();
    const p = await m.api.upload(image('front.png'), 'front.png');
    expect(p.token).toMatch(/^mock-img-/);
    expect(p.type).toBe('png');
    expect((await m.api.upload(image('photo.jpg', JPG, 'image/jpeg'), 'photo.jpg')).type).toBe('jpg');
    // 扩展名、MIME 不算数，看文件头：叫 .png 的 JPEG 也是 jpg
    expect((await m.api.upload(image('lies.png', JPG, 'image/png'), 'lies.png')).type).toBe('jpg');
    for (const [file, name] of [
      [image('pic.webp', WEBP, 'image/webp'), 'pic.webp'],
      [new File(['hello'], 'notes.png', { type: 'image/png' }), 'notes.png'],
      [new File(['hello'], 'notes.txt', { type: 'text/plain' }), 'notes.txt'],
    ] as const) {
      const err = await rejects(m.api.upload(file, name));
      expect(err.code).toBe('bad_request');
      expect(err.status).toBe(400);
    }
    const big = new Uint8Array(MOCK_MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect((await rejects(m.api.upload(new File([big], 'big.png', { type: 'image/png' }), 'big.png'))).code).toBe('bad_request');
  });

  it('任务按时间走：排队（0%）→ 生成中（0 → 99%）→ success（有 modelUrl、previewUrl），下载拿到模型', async () => {
    const m = setup();
    const { taskId } = await m.api.createTask({ mode: 'text', prompt: 'A Red Fox', texture: true });
    expect(taskId).toMatch(/^mock-/);
    expect(await m.api.getTask(taskId)).toEqual({ status: 'queued', progress: 0 });
    expect((await rejects(m.api.download(taskId))).code).toBe('bad_request'); // 还没好
    m.advance(MOCK_QUEUE_MS + MOCK_RUN_MS / 2);
    const mid = await m.api.getTask(taskId);
    expect(mid.status).toBe('running');
    expect(mid.progress).toBeGreaterThan(40);
    expect(mid.progress).toBeLessThan(60);
    m.advance(MOCK_RUN_MS / 2 + 1);
    const done = await m.api.getTask(taskId);
    expect(done).toMatchObject({ status: 'success', progress: 100, modelUrl: `${BASE}/download/${taskId}` });
    expect(done.previewUrl).toMatch(/thumbs\/[\w-]+\.webp$/);
    const glb = await m.api.download(taskId);
    expect(glb.type).toBe('model/gltf-binary');
    const file = (await glb.text()).replace('glb:', '');
    expect(MOCK_TEXT_MODELS as readonly string[]).toContain(file);
    // 同一句提示词（不分大小写）总是同一件
    const again = await m.api.createTask({ mode: 'text', prompt: 'a red fox' });
    m.advance(DONE_MS);
    expect(await (await m.api.download(again.taskId)).text()).toBe(`glb:${file}`);
  });

  it('单图用 jade-guardian-lion，多视图用 tufted-armchair', async () => {
    const m = setup();
    const ref = await m.api.upload(image('cat.png'), 'cat.png');
    const back = await m.api.upload(image('back.png'), 'back.png');
    const one = await m.api.createTask({ mode: 'image', ...ref });
    const many = await m.api.createTask({ mode: 'multiview', views: [ref, null, back, null] });
    m.advance(DONE_MS);
    expect(await (await m.api.download(one.taskId)).text()).toBe(`glb:${MOCK_IMAGE_MODEL}`);
    expect(await (await m.api.download(many.taskId)).text()).toBe(`glb:${MOCK_MULTIVIEW_MODEL}`);
    expect(await m.api.balance()).toEqual({ balance: MOCK_START_BALANCE - MOCK_COSTS.image - MOCK_COSTS.multiview, frozen: 0 });
  });

  it('#fail：生成到 60% 左右失败（带 error），下载 not_found；图片文件名带 #fail 也一样（单图、多视图）', async () => {
    const m = setup();
    const t = await m.api.createTask({ mode: 'text', prompt: 'a cursed lamp #fail' });
    const failing = await m.api.upload(image('bad #fail.png'), 'bad #fail.png');
    const good = await m.api.upload(image('good.png'), 'good.png');
    const i = await m.api.createTask({ mode: 'image', token: failing.token });
    const mv = await m.api.createTask({ mode: 'multiview', views: [good, failing, null, null] });
    const ok = await m.api.createTask({ mode: 'multiview', views: [good, null, good, null] });
    m.advance(MOCK_QUEUE_MS + MOCK_RUN_MS * 0.5);
    expect((await m.api.getTask(t.taskId)).status).toBe('running');
    m.advance(MOCK_RUN_MS * 0.2);
    for (const id of [t.taskId, i.taskId, mv.taskId]) {
      expect(await m.api.getTask(id)).toEqual({ status: 'failed', progress: MOCK_FAIL_AT, error: MOCK_FAIL_ERROR });
    }
    expect((await m.api.getTask(ok.taskId)).status).toBe('running');
    m.advance(DONE_MS);
    expect((await rejects(m.api.download(t.taskId))).code).toBe('not_found');
    expect((await m.api.getTask(ok.taskId)).status).toBe('success');
  });

  it('建任务时的记号：#quota → 402 quota，#upstream → upstream，#cap → 429 daily_cap，#rate → 429 rate_limited（都带 retryAfter）', async () => {
    const m = setup();
    const quota = await rejects(m.api.createTask({ mode: 'text', prompt: 'a gold bar #quota' }));
    expect(quota).toMatchObject({ code: 'quota', status: 402 });
    expect(quota.message).toMatch(/credits are used up/);
    expect((await rejects(m.api.createTask({ mode: 'text', prompt: 'a rock #upstream' }))).code).toBe('upstream');
    const cap = await rejects(m.api.createTask({ mode: 'text', prompt: 'a tree #cap' }));
    expect(cap).toMatchObject({ code: 'daily_cap', status: 429 });
    expect(cap.retryAfter).toBeGreaterThanOrEqual(60);
    expect(cap.retryAfter).toBeLessThanOrEqual(86_400);
    const rate = await rejects(m.api.createTask({ mode: 'text', prompt: 'a bird #rate' }));
    expect(rate).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: MOCK_RATE_RETRY_AFTER });
    expect(rate.message).toBe(`Tripo is busy right now. Try again in ${MOCK_RATE_RETRY_AFTER} seconds.`);
    expect(await m.api.balance()).toEqual({ balance: MOCK_START_BALANCE, frozen: 0 }); // 都没建成，不花额度
    // 429 的头里也有 Retry-After
    const res = await m.mockFetch()(`${BASE}/task`, { method: 'POST', body: JSON.stringify({ mode: 'text', prompt: 'x #rate' }) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(MOCK_RATE_RETRY_AFTER));
  });

  it('请求体不对：400 bad_request', async () => {
    const m = setup();
    const ref = await m.api.upload(image('front.png'), 'front.png');
    const bad: unknown[] = [
      { mode: 'text', prompt: '   ' },
      { mode: 'text', prompt: 'x'.repeat(1025) },
      { mode: 'text', prompt: 'ok', texture: 'yes' },
      { mode: 'image' },
      { mode: 'image', token: 'someone-elses-token' },
      { mode: 'image', token: ref.token, type: 'gif' },
      { mode: 'multiview', views: [null, ref, ref, null] }, // 没有前视图
      { mode: 'multiview', views: [ref, null, null, null] }, // 只有前视图
      { mode: 'multiview', views: [ref, ref, null] }, // 不是四个
      { mode: 'multiview', views: [ref, { token: 'nope' }, null, null] },
      { mode: 'sculpt' },
    ];
    for (const body of bad) {
      const err = await rejects(m.api.createTask(body as never));
      expect(err.code, JSON.stringify(body)).toBe('bad_request');
    }
    // type 可以不带
    expect((await m.api.createTask({ mode: 'image', token: ref.token })).taskId).toMatch(/^mock-/);
  });

  it('不认识的任务 id：not_found；不认识的接口：404；方法不对：405', async () => {
    const m = setup();
    expect((await rejects(m.api.getTask('nope'))).code).toBe('not_found');
    expect((await rejects(m.api.download('nope'))).code).toBe('not_found');
    const f = m.mockFetch();
    const unknown = await f(`${BASE}/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, code: 'not_found' });
    expect((await f(`${BASE}/task`)).status).toBe(405);
  });

  it('额度不够时建任务回 quota（startBalance）', async () => {
    const m = setup({ startBalance: 50 });
    await m.api.createTask({ mode: 'text', prompt: 'one' });
    expect((await rejects(m.api.createTask({ mode: 'text', prompt: 'two' }))).code).toBe('quota');
    m.advance(DONE_MS);
    expect(await m.api.balance()).toEqual({ balance: 20, frozen: 0 });
  });

  it('speed：时间流速加快', async () => {
    const m = setup({ speed: 3 });
    const { taskId } = await m.api.createTask({ mode: 'text', prompt: 'quick' });
    m.advance(Math.ceil(DONE_MS / 3));
    expect((await m.api.getTask(taskId)).status).toBe('success');
  });

  it('状态存在存档里：刷新（新的模拟实例、同一个存档）以后任务接着走，额度对得上；clearMockState 清掉', async () => {
    const m = setup();
    const { taskId } = await m.api.createTask({ mode: 'text', prompt: 'a lantern' });
    expect(m.storage.data.has(MOCK_KEY)).toBe(true);
    m.advance(MOCK_QUEUE_MS + 100);
    const reloaded = m.make();
    expect((await reloaded.getTask(taskId)).status).toBe('running');
    m.advance(DONE_MS);
    expect((await reloaded.getTask(taskId)).status).toBe('success');
    expect(await reloaded.balance()).toEqual({ balance: MOCK_START_BALANCE - MOCK_COSTS.text, frozen: 0 });
    clearMockState(m.storage);
    expect(m.storage.data.has(MOCK_KEY)).toBe(false);
    expect((await rejects(reloaded.getTask(taskId))).code).toBe('not_found');
    expect(await reloaded.balance()).toEqual({ balance: MOCK_START_BALANCE, frozen: 0 });
  });

  it('不在中转地址下面的请求照常交给真的 fetch', async () => {
    const real = vi.fn(async () => new Response('outside'));
    vi.stubGlobal('fetch', real);
    const m = setup();
    const res = await m.mockFetch()('/models/castle.glb');
    expect(await res.text()).toBe('outside');
    expect(real).toHaveBeenCalledTimes(1);
  });
});

describe('模拟中转 + GenJobs：从提交到加进作品', () => {
  // 手动计时器 + 模拟中转的时钟一起往前拨
  function run() {
    const m = setup();
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let seq = 0;
    const finish = vi.fn(async (_job: GenJob, _glb: Blob) => ({ workId: 'u-mock' }));
    const jobs = new GenJobs({
      api: m.api,
      storage: memStorage(),
      finish,
      now: m.now,
      setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; },
      clearTimeout: (h) => void timers.delete(h as number),
    });
    const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
    const tick = async () => {
      const first = [...timers.entries()][0];
      if (!first) return false;
      timers.delete(first[0]);
      m.advance(first[1].ms);
      first[1].fn();
      await flush();
      return true;
    };
    return { m, jobs, finish, flush, tick };
  }

  it('文字：走完，finish 拿到模拟的模型；多视图（前 + 后）也走完', async () => {
    const r = run();
    const job = r.jobs.submit({ mode: 'text', prompt: 'a tiny teapot', title: '', teamId: 'lumen-guild', options: { texture: true } });
    await r.flush();
    for (let i = 0; i < 20 && r.jobs.get(job.id)?.phase !== 'done'; i++) await r.tick();
    expect(r.jobs.get(job.id)).toMatchObject({ phase: 'done', workId: 'u-mock', title: 'A tiny teapot' });
    const glb = r.finish.mock.calls[0][1] as Blob;
    expect(MOCK_TEXT_MODELS.map((f) => `glb:${f}`)).toContain(await glb.text());

    const mv = r.jobs.submit({ mode: 'multiview', views: [image('front.png'), null, image('back.png', JPG, 'image/jpeg'), null], title: '', teamId: 'lumen-guild', options: {} });
    await r.flush();
    for (let i = 0; i < 20 && r.jobs.get(mv.id)?.phase !== 'done'; i++) await r.tick();
    expect(r.jobs.get(mv.id)).toMatchObject({ phase: 'done', title: 'Front' });
    expect(await (r.finish.mock.calls[1][1] as Blob).text()).toBe(`glb:${MOCK_MULTIVIEW_MODEL}`);
  });

  it('#fail：失败，提示是英文；#quota：提交时就失败', async () => {
    const r = run();
    const job = r.jobs.submit({ mode: 'text', prompt: 'a gloomy tower #fail', title: '', teamId: 't', options: {} });
    const broke = r.jobs.submit({ mode: 'text', prompt: 'a gold bar #quota', title: '', teamId: 't', options: {} });
    await r.flush();
    expect(r.jobs.get(broke.id)?.error?.code).toBe('quota');
    for (let i = 0; i < 20 && r.jobs.get(job.id)?.phase !== 'failed'; i++) await r.tick();
    expect(r.jobs.get(job.id)).toMatchObject({ phase: 'failed', error: { code: 'upstream', message: "Tripo couldn't generate this model. Please try again.", detail: MOCK_FAIL_ERROR } });
    expect(r.finish).not.toHaveBeenCalled();
  });
});

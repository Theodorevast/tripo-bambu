import { describe, expect, it, vi } from 'vitest';
import { createTripoApi, defaultTripoBase, isMockMode, retryAfterOf, toTripoError, TripoError } from '../src/genai/api';
import { describeError, phaseLabel, titleFromFile, titleFromPrompt, waitText } from '../src/genai/messages';
import type { GenErrorCode, JobPhase } from '../src/genai/types';

// 中转客户端：请求怎么发、回复和错误怎么整理（假的 fetch，不碰网络）；界面文字

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const htmlRes = (status: number): Response => new Response('<!doctype html><html><body>index</body></html>', { status, headers: { 'content-type': 'text/html' } });

function apiWith(...responses: Array<Response | Error>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  return { api: createTripoApi({ base: '/api/tripo/', fetch }), fetch };
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

const CJK = /[\u3400-\u9fff]/;

describe('createTripoApi：请求', () => {
  it('地址去掉结尾的 /；health、balance 是 GET，不走缓存', async () => {
    const { api, fetch } = apiWith(jsonRes(200, { ok: true, mock: false }), jsonRes(200, { ok: true, balance: '41465.00', frozen: 12.5 }));
    expect(api.base).toBe('/api/tripo');
    expect(await api.health()).toEqual({ ok: true, mock: false });
    expect(await api.balance()).toEqual({ balance: 41465, frozen: 12.5 }); // 小数（字符串也行），不能 parseInt
    expect(fetch.mock.calls[0][0]).toBe('/api/tripo/health');
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetch.mock.calls[1][0]).toBe('/api/tripo/balance');
  });

  it('balance：frozen 没有时算 0；balance 不是数字时报 upstream', async () => {
    const { api } = apiWith(jsonRes(200, { ok: true, balance: 41465.75 }), jsonRes(200, { ok: true, balance: 'lots' }));
    expect(await api.balance()).toEqual({ balance: 41465.75, frozen: 0 });
    expect((await rejects(api.balance())).code).toBe('upstream');
  });

  it('upload：multipart，字段 file 带文件名；回复里没有 type 时引用里也没有', async () => {
    const { api, fetch } = apiWith(jsonRes(200, { ok: true, token: 'tok-1', type: 'png' }), jsonRes(200, { ok: true, token: 'tok-2' }));
    const file = new File([new Uint8Array([1, 2, 3])], 'local-name.png', { type: 'image/png' });
    expect(await api.upload(file, 'front.png')).toEqual({ token: 'tok-1', type: 'png' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/tripo/upload');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const sent = form.get('file') as File;
    expect(sent.name).toBe('front.png');
    expect(sent.size).toBe(3);
    expect(new Headers(init?.headers).get('content-type')).toBeNull(); // 浏览器自己写 multipart 的分隔符
    expect(await api.upload(file, 'b.png')).toEqual({ token: 'tok-2' });
  });

  it('createTask：POST JSON；taskId（也认 task_id）', async () => {
    const { api, fetch } = apiWith(jsonRes(200, { ok: true, taskId: 't-1' }), jsonRes(200, { ok: true, task_id: 't-2' }));
    expect(await api.createTask({ mode: 'text', prompt: 'a fox', texture: true })).toEqual({ taskId: 't-1' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/tripo/task');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ mode: 'text', prompt: 'a fox', texture: true });
    expect(await api.createTask({ mode: 'image', token: 'tok' })).toEqual({ taskId: 't-2' });
  });

  it('getTask：状态不认识算 unknown，进度夹在 0–100，error 可以是字符串或 { message }；id 转义', async () => {
    const { api, fetch } = apiWith(
      jsonRes(200, { ok: true, status: 'running', progress: 150, previewUrl: '/p.webp' }),
      jsonRes(200, { ok: true, status: 'banana', progress: -3 }),
      jsonRes(200, { ok: true, status: 'failed', progress: '60', error: { message: '失败了' } }),
      jsonRes(200, { ok: true, status: 'success', progress: 100, modelUrl: '/api/tripo/download/a b', error: 'none' }),
    );
    expect(await api.getTask('a b')).toEqual({ status: 'running', progress: 100, previewUrl: '/p.webp' });
    expect(fetch.mock.calls[0][0]).toBe('/api/tripo/task/a%20b');
    expect(await api.getTask('x')).toEqual({ status: 'unknown', progress: 0 });
    expect(await api.getTask('x')).toEqual({ status: 'failed', progress: 60, error: '失败了' });
    expect(await api.getTask('x')).toEqual({ status: 'success', progress: 100, modelUrl: '/api/tripo/download/a b', error: 'none' });
  });

  it('download：返回 Blob；404 页面 → not_found；回的是网页 → unavailable；回的是 JSON 错误 → 它的 code；空文件 → upstream', async () => {
    const { api } = apiWith(
      new Response(new Uint8Array([103, 108, 84, 70]), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
      new Response('Not Found', { status: 404 }),
      htmlRes(200),
      jsonRes(200, { ok: false, code: 'not_found', message: '没有模型' }),
      new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'model/gltf-binary' } }),
    );
    const blob = await api.download('t-1');
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('model/gltf-binary');
    expect((await rejects(api.download('t-1'))).code).toBe('not_found');
    expect((await rejects(api.download('t-1'))).code).toBe('unavailable');
    expect((await rejects(api.download('t-1'))).code).toBe('not_found');
    expect((await rejects(api.download('t-1'))).code).toBe('upstream');
  });

  it('download 带 onProgress：边收边报（有 Content-Length 时带总长），最后一次是收齐的', async () => {
    const parts = [new Uint8Array(300), new Uint8Array(700)];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
    const { api } = apiWith(new Response(body, { status: 200, headers: { 'content-type': 'model/gltf-binary', 'content-length': '1000' } }));
    const seen: Array<{ loaded: number; total?: number }> = [];
    const blob = await api.download('t-1', (p) => seen.push(p));
    expect(blob.size).toBe(1000);
    expect(seen.at(-1)).toEqual({ loaded: 1000, total: 1000 });
  });

  it('models：只留认得的字段和正数；默认版本不在列表里时用第一个；空列表报 upstream', async () => {
    const { api, fetch } = apiWith(
      jsonRes(200, {
        ok: true, defaultModel: 'nope', defaultTexture: 'fast',
        models: [
          { id: 'v3.1-20260211', label: 'H3.1', blurb: 'Best', textures: ['none', 'fast', 'standard', 'ultra'], measured: true, eta: { text: { none: 90, fast: null, standard: -1 } }, credits: { text: { none: 10 } } },
          { id: '', label: 'broken' },
          { id: 'v9', textures: 'none' },
        ],
      }),
      jsonRes(200, { ok: true, defaultModel: 'x', models: [] }),
    );
    const list = await api.models();
    expect(fetch.mock.calls[0][0]).toBe('/api/tripo/models');
    expect(list.defaultModel).toBe('v3.1-20260211');
    expect(list.defaultTexture).toBe('fast');
    expect(list.models.map((m) => m.id)).toEqual(['v3.1-20260211', 'v9']);
    expect(list.models[0]).toMatchObject({ label: 'H3.1', textures: ['none', 'fast', 'standard'], measured: true, eta: { text: { none: 90 } }, credits: { text: { none: 10 } } });
    expect(list.models[0].eta?.text).not.toHaveProperty('fast');
    expect(list.models[1]).toMatchObject({ label: 'v9', textures: ['none', 'standard'], eta: null, credits: null });
    expect((await rejects(api.models())).code).toBe('upstream');
  });

  it('resolve：同源部署原样；中转在别的域名时按中转地址解析', () => {
    expect(createTripoApi({ base: '/api/tripo' }).resolve('/api/tripo/preview/t-1')).toBe('/api/tripo/preview/t-1');
    const far = createTripoApi({ base: 'https://proxy.example/api/tripo' });
    expect(far.resolve('/api/tripo/preview/t-1')).toBe('https://proxy.example/api/tripo/preview/t-1');
    expect(far.resolve('https://cdn.example/a.webp')).toBe('https://cdn.example/a.webp');
  });
});

describe('createTripoApi：错误', () => {
  it('回复里有 code 就用它；message 是英文提示，原话在 serverMessage；429 的 retryAfter（回复体）', async () => {
    const { api } = apiWith(jsonRes(429, { ok: false, code: 'rate_limited', message: '请求太频繁，请稍后再试', retryAfter: 7 }, { 'Retry-After': '99' }));
    const err = await rejects(api.createTask({ mode: 'text', prompt: 'x' }));
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 7, serverMessage: '请求太频繁，请稍后再试' });
    expect(err.message).toBe('Tripo is busy right now. Try again in 7 seconds.');
    expect(err.message).not.toMatch(CJK);
  });

  it('retryAfter 只在 Retry-After 头里（秒数或 HTTP 日期）', async () => {
    const { api } = apiWith(new Response('', { status: 429, headers: { 'Retry-After': '20' } }));
    expect(await rejects(api.getTask('x'))).toMatchObject({ code: 'rate_limited', retryAfter: 20 });
    const now = Date.parse('2026-10-30T12:00:00Z');
    const res = new Response('', { status: 429, headers: { 'Retry-After': 'Fri, 30 Oct 2026 12:01:30 GMT' } });
    expect(retryAfterOf(res, undefined, now)).toBe(90);
    expect(retryAfterOf(new Response(''), undefined, now)).toBeUndefined();
    expect(retryAfterOf(new Response(''), { retryAfter: '15' }, now)).toBe(15);
  });

  it('回复里没有 code：按 HTTP 状态推', async () => {
    const cases: Array<[Response, GenErrorCode]> = [
      [jsonRes(402, { ok: false }), 'quota'],
      [jsonRes(404, { ok: false, message: 'no such task' }), 'not_found'],
      [new Response('Not Found', { status: 404 }), 'unavailable'], // 路由都没有：中转没部署
      [jsonRes(400, {}), 'bad_request'],
      [jsonRes(422, { ok: false }), 'bad_request'],
      [htmlRes(405), 'unavailable'],
      [jsonRes(403, {}), 'unavailable'],
      [jsonRes(503, { ok: false }), 'upstream'],
      [new Response('Bad Gateway', { status: 502 }), 'upstream'],
      [jsonRes(200, { ok: false, message: '出错了' }), 'upstream'],
      [jsonRes(500, { ok: false, code: 'something_new' }), 'upstream'], // 不认识的 code：按状态推
    ];
    for (const [res, code] of cases) {
      const { api } = apiWith(res);
      expect((await rejects(api.getTask('x'))).code, `${res.status}`).toBe(code);
    }
  });

  it('200 但回的是网页（静态托管回 index.html）→ unavailable；fetch 本身抛错 → network', async () => {
    const { api } = apiWith(htmlRes(200), new TypeError('Failed to fetch'));
    expect((await rejects(api.balance())).code).toBe('unavailable');
    const err = await rejects(api.balance());
    expect(err.code).toBe('network');
    expect(err.status).toBeUndefined();
  });

  it('health 404（不管是不是 JSON）→ unavailable', async () => {
    const { api } = apiWith(new Response('nope', { status: 404 }), jsonRes(404, { ok: false, code: 'not_found' }));
    expect((await rejects(api.health())).code).toBe('unavailable');
    expect((await rejects(api.health())).code).toBe('unavailable');
  });

  it('toTripoError：TripoError 原样返回，别的当作连不上', () => {
    const e = new TripoError('quota');
    expect(toTripoError(e)).toBe(e);
    expect(toTripoError(new Error('boom'))).toMatchObject({ code: 'network', serverMessage: 'boom' });
    expect(toTripoError('weird').code).toBe('network');
  });
});

describe('中转地址、模拟模式', () => {
  it('默认同源的 /api/tripo；?tripo=mock 才是模拟模式', () => {
    expect(defaultTripoBase()).toBe('/api/tripo');
    expect(isMockMode('?tripo=mock')).toBe(true);
    expect(isMockMode('?nolocal&tripo=mock')).toBe(true);
    expect(isMockMode('?tripo=real')).toBe(false);
    expect(isMockMode('')).toBe(false);
    expect(isMockMode()).toBe(false); // node 里没有 location
  });
});

describe('界面文字', () => {
  const codes: GenErrorCode[] = ['rate_limited', 'daily_cap', 'quota', 'bad_request', 'upstream', 'not_found', 'network', 'unavailable', 'import_failed', 'interrupted'];

  it('每个错误码都是英文句子，不带中转的原话', () => {
    for (const code of codes) {
      const text = describeError(code, '中转的原话：出错了');
      expect(text, code).toMatch(/^[A-Z]/);
      expect(text, code).toMatch(/[.!]$/);
      expect(text, code).not.toMatch(CJK);
      expect(text, code).not.toContain('原话');
    }
    expect(describeError('quota')).toBe("This demo's Tripo credits are used up. You can still upload your own models.");
    expect(describeError('network')).toBe("Can't reach the Tripo service. Check your connection and try again.");
    expect(describeError('unavailable')).toBe("Tripo generation isn't set up on this site yet. You can still upload models.");
    expect(describeError('interrupted')).toBe('The page was closed before Tripo received this request. Please try again.');
  });

  it('rate_limited、daily_cap 说要等多久', () => {
    expect(describeError('rate_limited')).toBe('Tripo is busy right now. Wait a few seconds and try again.');
    expect(describeError('rate_limited', undefined, 1)).toBe('Tripo is busy right now. Try again in 1 second.');
    expect(describeError('rate_limited', undefined, 45.2)).toBe('Tripo is busy right now. Try again in 46 seconds.');
    expect(describeError('daily_cap')).toBe("Today's generation limit for this demo is reached. Try again tomorrow, or upload a model instead.");
    expect(describeError('daily_cap', undefined, 3 * 3600)).toBe("Today's generation limit for this demo is reached. Try again in 3 hours, or upload a model instead.");
    expect(waitText(89)).toBe('89 seconds');
    expect(waitText(90)).toBe('2 minutes');
    expect(waitText(600)).toBe('10 minutes');
    expect(waitText(5400)).toBe('2 hours');
  });

  it('phaseLabel', () => {
    const label = (phase: JobPhase, progress = 0, mode: 'text' | 'image' | 'multiview' = 'text') => phaseLabel({ phase, progress, mode });
    expect(label('uploading', 0, 'image')).toBe('Uploading image…');
    expect(label('uploading', 0, 'multiview')).toBe('Uploading images…');
    expect(label('submitting')).toBe('Sending to Tripo…');
    expect(label('queued')).toBe('Waiting in line…');
    expect(label('running', 41.6)).toBe('Generating… 42%');
    expect(label('downloading')).toBe('Downloading…');
    expect(label('importing')).toBe('Optimizing…');
    expect(label('done')).toBe('Ready');
    expect(label('failed')).toBe('Failed');
    expect(label('cancelled')).toBe('Cancelled');
  });

  it('titleFromPrompt：前 6 个词、最多 40 个字符，首字母大写，去掉首尾的标点和结尾的虚词', () => {
    expect(titleFromPrompt('a cute red fox wearing a tiny wizard hat')).toBe('A cute red fox wearing');
    expect(titleFromPrompt('A tiny robot gardener holding a watering can')).toBe('A tiny robot gardener holding');
    expect(titleFromPrompt('a lantern of the')).toBe('A lantern');
    expect(titleFromPrompt('the')).toBe('The');
    expect(titleFromPrompt('  "steampunk   airship!!"  ')).toBe('Steampunk airship');
    expect(titleFromPrompt('supercalifragilisticexpialidocious extraordinarily magnificent')).toBe('Supercalifragilisticexpialidocious');
    expect(titleFromPrompt('x'.repeat(60))).toBe('X'.padEnd(40, 'x'));
    expect(titleFromPrompt('一只戴着帽子的小狐狸')).toBe('一只戴着帽子的小狐狸');
    expect(titleFromPrompt('   ')).toBe('Untitled model');
    expect(titleFromPrompt('...')).toBe('Untitled model');
  });

  it('titleFromFile：去掉路径、扩展名，下划线、连字符换成空格', () => {
    expect(titleFromFile('my_cool-robot.final.png')).toBe('My cool robot final');
    expect(titleFromFile('C:\\photos\\IMG_1234.JPG')).toBe('IMG 1234');
    expect(titleFromFile('front.jpeg')).toBe('Front');
    expect(titleFromFile('.png')).toBe('Untitled model');
  });
});

// Tripo API 中转（server/tripo/handler.mjs）的单元测试：fetch 打桩成假的 Tripo 上游，不会发出任何真实请求。
// 覆盖：环境变量优先级（TRIPO_MOCK=1 最优先）、每个 IP 的限流、每日上限、参数白名单、上传校验、
// 下载只放行 Tripo 主机、错误码映射、跨域、模拟模式，以及密钥不出现在任何响应和日志里。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler, createMemoryStore, ipKey, readConfig, type TripoEnv, type TripoHandle, type TripoHandlerOptions } from '../server/tripo/handler.mjs';
import { loadEnvFiles, modeBanner } from '../server/tripo/node-adapter.mjs';
import tripoProxy from '../server/tripo/vite-plugin.mjs';
import worker from '../server/tripo/worker.mjs';
import { makeEnvDir } from './tripoEnvDir.mjs';

const KEY = 'tsk_unit_test_SECRET_9f8e7d6c5b4a';
const SITE = 'http://site.test';
const API = 'https://openapi.tripo3d.ai/v3';
const REAL: TripoEnv = { TRIPO_API_KEY: KEY };
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

interface Call { url: string; method: string; headers: Headers; body: unknown }
type Route = (call: Call) => Response | Promise<Response>;

let clock = T0;
let logs: string[] = [];
// 每个响应的头和正文、每条日志都记下来：最后统一检查里面没有密钥
const seen: string[] = [];

// 假的 Tripo 上游。路由键是「方法 主机路径」，末尾带 * 的按前缀匹配；没配的路由当 404
function fakeUpstream(routes: Record<string, Route> = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        // 不是 JSON 就原样记
      }
    }
    const call: Call = { url, method, headers: new Headers(init?.headers), body };
    calls.push(call);
    const u = new URL(url);
    const key = `${method} ${u.host}${u.pathname}`;
    const route = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    return route ? route(call) : new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const tripoOk = (data: unknown, init?: ResponseInit) => Response.json({ code: 0, data }, init);
const tripoErr = (status: number, code: number, message = 'error', headers?: HeadersInit) =>
  Response.json({ code, status: 'error', message, suggestion: 'x', request_id: 'req_1' }, { status, headers });
const taskOk = (output: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  tripoOk({ task_id: UUID, type: 'text_to_model', status: 'success', progress: 100, output, created_at: '2026-10-30T08:00:00Z', ...extra });

function make(options: TripoHandlerOptions = {}): TripoHandle {
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  return createHandler({ now: () => clock, store: createMemoryStore(), log, ...options });
}

interface Out { status: number; headers: Headers; text: string; json: any; bytes: Uint8Array }
async function send(handle: TripoHandle, request: Request, env: TripoEnv = {}, ip = '203.0.113.7'): Promise<Out> {
  const res = await handle(request, env, { ip });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  seen.push(text, JSON.stringify([...res.headers]));
  return { status: res.status, headers: res.headers, text, json, bytes };
}
const get = (path: string, headers?: HeadersInit) => new Request(SITE + path, { headers });
const postJson = (body: unknown, headers: Record<string, string> = {}, path = '/api/tripo/task') =>
  new Request(SITE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function postFile(parts: Array<[string, Blob | string, string?]>) {
  const fd = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === 'string') fd.append(name, value);
    else fd.append(name, value, filename ?? 'a.png');
  }
  return new Request(`${SITE}/api/tripo/upload`, { method: 'POST', body: fd });
}
const text = (prompt = 'a small wooden chair', extra: Record<string, unknown> = {}) => postJson({ mode: 'text', prompt, ...extra });
const createdOk = () => tripoOk({ task_id: UUID });

beforeEach(() => {
  clock = T0;
  logs = [];
});
afterEach(() => {
  seen.push(...logs);
  vi.unstubAllGlobals();
});
afterAll(() => {
  // 所有用例跑过的响应和日志里都不能出现密钥
  for (const s of seen) expect(s).not.toContain(KEY);
});

describe('环境变量和模式', () => {
  let removers: Array<() => void> = [];
  const envDir = (files: Record<string, string>) => {
    const made = makeEnvDir(files);
    removers.push(made.remove);
    return made.dir;
  };
  afterEach(() => {
    for (const remove of removers) remove();
    removers = [];
  });

  it('进程环境变量里的 TRIPO_MOCK=1 优先级最高：.env.local 里有密钥（甚至写了 TRIPO_MOCK=0）也走模拟，不发上游请求', async () => {
    const dir = envDir({ '.env.local': `TRIPO_API_KEY=${KEY}\nTRIPO_MOCK=0\n` });
    const env = loadEnvFiles({ dir, mode: 'development', processEnv: { TRIPO_MOCK: '1' } });
    expect(env.TRIPO_API_KEY).toBe(KEY);
    expect(env.TRIPO_MOCK).toBe('1');
    expect(readConfig(env).mock).toBe(true);
    const calls = fakeUpstream();
    const handle = make();
    expect((await send(handle, get('/api/tripo/health'), env)).json).toEqual({ ok: true, mock: true });
    const created = await send(handle, text(), env);
    expect(created.json.taskId).toMatch(/^mock_/);
    expect((await send(handle, get('/api/tripo/balance'), env)).json).toEqual({ ok: true, balance: 1000, frozen: 0 });
    expect(calls).toHaveLength(0);
  });

  it('.env.local 里有密钥、没有 TRIPO_MOCK：真实模式，health 如实报 mock: false', async () => {
    const dir = envDir({ '.env.local': `TRIPO_API_KEY=${KEY}\n` });
    const env = loadEnvFiles({ dir, mode: 'development', processEnv: {} });
    const calls = fakeUpstream();
    expect((await send(make(), get('/api/tripo/health'), env)).json).toEqual({ ok: true, mock: false });
    expect(calls).toHaveLength(0);
  });

  it('文件的先后顺序和 Vite 一致，进程环境变量盖住所有文件', () => {
    const dir = envDir({ '.env': 'A=env\nB=env\nC=env\n', '.env.local': 'B=local\nC=local\n', '.env.production.local': 'C=production-local\n' });
    const env = loadEnvFiles({ dir, mode: 'production', processEnv: { A: 'process' } });
    expect([env.A, env.B, env.C]).toEqual(['process', 'local', 'production-local']);
  });

  it('没有密钥就是模拟模式；空的 TRIPO_API_KEY 也算没有', () => {
    expect(readConfig({}).mock).toBe(true);
    expect(readConfig({ TRIPO_API_KEY: '' }).mock).toBe(true);
    expect(readConfig({ TRIPO_API_KEY: KEY, TRIPO_MOCK: 'true' }).mock).toBe(true);
    expect(readConfig(REAL).mock).toBe(false);
  });

  it('启动提示：真实模式醒目地说会消耗额度，不带密钥的任何一部分', () => {
    const real = modeBanner(REAL);
    expect(real.level).toBe('warn');
    expect(real.text).toContain('真实模式');
    expect(real.text).toContain('消耗额度');
    for (let i = 0; i + 4 <= KEY.length; i++) expect(real.text).not.toContain(KEY.slice(i, i + 4));
    expect(modeBanner({}).level).toBe('info');
    expect(modeBanner({ TRIPO_API_KEY: KEY, TRIPO_MOCK: '1' }).text).toContain('模拟模式');
  });

  it('照抄 .env.example（值全空）不会把上限变成 0', () => {
    const cfg = readConfig({ TRIPO_MAX_TASKS_PER_DAY: '', TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '' });
    expect([cfg.tasksPerDay, cfg.tasksPerIpPerHour]).toEqual([50, 5]);
  });
});

describe('限流和每日上限', () => {
  it('每个 IP 每小时 5 个任务，第 6 个返回 rate_limited 和 Retry-After；别的 IP 不受影响；过一小时恢复', async () => {
    fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': createdOk });
    const handle = make();
    for (let i = 0; i < 5; i++) expect((await send(handle, text(), REAL, '198.51.100.1')).status).toBe(200);
    const sixth = await send(handle, text(), REAL, '198.51.100.1');
    expect(sixth.status).toBe(429);
    expect(sixth.json).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(sixth.json.retryAfter).toBeGreaterThan(0);
    expect((await send(handle, text(), REAL, '198.51.100.2')).status).toBe(200);
    clock += 60 * 60 * 1000 + 1000;
    expect((await send(handle, text(), REAL, '198.51.100.1')).status).toBe(200);
  });

  it('每个 IP 的上限可以配置', async () => {
    fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': createdOk });
    const handle = make();
    const env = { ...REAL, TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '2' };
    expect((await send(handle, text(), env)).status).toBe(200);
    expect((await send(handle, text(), env)).status).toBe(200);
    expect((await send(handle, text(), env)).json.code).toBe('rate_limited');
  });

  it('全局每日上限 TRIPO_MAX_TASKS_PER_DAY：换 IP 也绕不过去，24 小时后恢复', async () => {
    const calls = fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': createdOk });
    const handle = make();
    const env = { ...REAL, TRIPO_MAX_TASKS_PER_DAY: '3' };
    for (let i = 0; i < 3; i++) expect((await send(handle, text(), env, `192.0.2.${i}`)).status).toBe(200);
    const capped = await send(handle, text(), env, '192.0.2.99');
    expect(capped.status).toBe(429);
    expect(capped.json.code).toBe('daily_cap');
    expect(calls).toHaveLength(3);
    clock += 24 * 60 * 60 * 1000 + 1000;
    expect((await send(handle, text(), env, '192.0.2.99')).status).toBe(200);
  });

  it('TRIPO_MAX_TASKS_PER_DAY=0 等于关掉生成（应急开关），不调上游', async () => {
    const calls = fakeUpstream();
    const out = await send(make(), text(), { ...REAL, TRIPO_MAX_TASKS_PER_DAY: '0' });
    expect(out.json.code).toBe('daily_cap');
    expect(calls).toHaveLength(0);
  });

  it('被每日上限拦下时，不占用这个 IP 的名额', async () => {
    fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': createdOk });
    const handle = make();
    const capped = { ...REAL, TRIPO_MAX_TASKS_PER_DAY: '0', TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '1' };
    expect((await send(handle, text(), capped)).json.code).toBe('daily_cap');
    expect((await send(handle, text(), { ...REAL, TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '1' })).status).toBe(200);
  });

  it('Tripo 明确拒绝（4xx）时退回名额；结果不明（5xx、超时）时不退，免得重复扣费时还多放一次', async () => {
    let reply: () => Response = () => tripoErr(400, 1004, 'bad param');
    fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': () => reply() });
    const handle = make();
    const env = { ...REAL, TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '1' };
    expect((await send(handle, text(), env)).json.code).toBe('bad_request');
    reply = () => new Response('<html>bad gateway</html>', { status: 502 });
    expect((await send(handle, text(), env)).json.code).toBe('upstream');
    reply = createdOk;
    expect((await send(handle, text(), env)).json.code).toBe('rate_limited');
  });

  it('模拟模式下限流一样生效（前端能测到 rate_limited）', async () => {
    const handle = make();
    for (let i = 0; i < 5; i++) expect((await send(handle, text())).status).toBe(200);
    expect((await send(handle, text())).json.code).toBe('rate_limited');
  });

  it('上传也有每个 IP 的上限', async () => {
    const handle = make();
    const env = { TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR: '2' };
    const png = () => postFile([['file', new Blob([PNG], { type: 'image/png' })]]);
    expect((await send(handle, png(), env)).status).toBe(200);
    expect((await send(handle, png(), env)).status).toBe(200);
    expect((await send(handle, png(), env)).json.code).toBe('rate_limited');
  });

  it('所有接口合计的每分钟上限（轮询也算）', async () => {
    const handle = make();
    const env = { TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE: '3' };
    for (let i = 0; i < 3; i++) expect((await send(handle, get('/api/tripo/health'), env)).status).toBe(200);
    expect((await send(handle, get('/api/tripo/health'), env)).json.code).toBe('rate_limited');
  });

  it('IPv6 按 /64 算同一个人，IPv4 映射地址还原成 IPv4', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe(ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('')).toBe('unknown');
  });
});

describe('参数白名单', () => {
  let calls: Call[] = [];
  beforeEach(() => {
    calls = fakeUpstream({
      'POST openapi.tripo3d.ai/v3/generation/text-to-model': createdOk,
      'POST openapi.tripo3d.ai/v3/generation/image-to-model': createdOk,
      'POST openapi.tripo3d.ai/v3/generation/multiview-to-model': createdOk,
    });
  });
  const bad = async (body: unknown, env: TripoEnv = REAL) => {
    const out = await send(make(), postJson(body), env);
    expect(out.status).toBe(400);
    expect(out.json.code).toBe('bad_request');
    expect(calls).toHaveLength(0);
    return out;
  };

  it('不认识的任务类型、不认识的字段一律拒绝', async () => {
    await bad({ mode: 'refine', prompt: 'x' });
    await bad({ mode: 'text', prompt: 'x', face_limit: 100 });
    await bad({ mode: 'text', prompt: 'x', type: 'png' });
    await bad({ mode: 'image', token: 'file_abc', prompt: 'x' });
    await bad({ mode: '__proto__' });
    await bad(['text']);
  });

  it('modelVersion 只放行白名单（默认只有 H 系列，P 系列要在 TRIPO_MODEL_VERSIONS 里加）', async () => {
    await bad({ mode: 'text', prompt: 'x', modelVersion: 'P2-20260801' });
    await bad({ mode: 'text', prompt: 'x', modelVersion: 'v2.0-20240919' });
    const out = await send(make(), postJson({ mode: 'text', prompt: 'x', modelVersion: 'P2-20260801' }), { ...REAL, TRIPO_MODEL_VERSIONS: 'v3.1-20260211,P2-20260801' });
    expect(out.status).toBe(200);
    expect(calls[0].body).toMatchObject({ model: 'P2-20260801' });
  });

  it('token 只能是上传拿到的 file_token：URL、路径、超长的都拒绝', async () => {
    await bad({ mode: 'image', token: 'https://evil.example/x.png' });
    await bad({ mode: 'image', token: '../tasks/x' });
    await bad({ mode: 'image', token: 'a'.repeat(200) });
    await bad({ mode: 'image', token: 'file_abc', type: 'gif' });
    await bad({ mode: 'image' });
  });

  it('多视图：正好 4 项、正面必须有、至少 2 张、每项只认 token 和 type', async () => {
    await bad({ mode: 'multiview', views: [{ token: 'file_f' }, { token: 'file_l' }, null] });
    await bad({ mode: 'multiview', views: [null, { token: 'file_l' }, { token: 'file_b' }, null] });
    await bad({ mode: 'multiview', views: [{ token: 'file_f' }, null, null, null] });
    await bad({ mode: 'multiview', views: [{ token: 'file_f', url: 'https://x' }, { token: 'file_b' }, null, null] });
    await bad({ mode: 'multiview', views: 'file_f' });
  });

  it('prompt 不能为空、最多 1024 个字；texture / pbr 只能是布尔值', async () => {
    await bad({ mode: 'text', prompt: '   ' });
    await bad({ mode: 'text', prompt: '字'.repeat(1025) });
    await bad({ mode: 'text', prompt: 'x', texture: 'yes' });
    await bad({ mode: 'text', prompt: 'x', pbr: 1 });
  });

  it('请求体要是 JSON、不能太大', async () => {
    const handle = make();
    const form = new Request(`${SITE}/api/tripo/task`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect((await send(handle, form, REAL)).status).toBe(415);
    const broken = new Request(`${SITE}/api/tripo/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect((await send(handle, broken, REAL)).json.code).toBe('bad_request');
    expect((await send(handle, text('x'.repeat(20_000)), REAL)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('发给 Tripo 的请求体：v3 路由和字段，带 Bearer 密钥，只有白名单里的字段', async () => {
    const handle = make();
    await send(handle, postJson({ mode: 'text', prompt: '  a chair  ', texture: false }), REAL);
    await send(handle, postJson({ mode: 'image', token: 'file_abc123', type: 'png', pbr: true }), REAL);
    await send(handle, postJson({ mode: 'multiview', views: [{ token: 'file_f' }, null, { token: 'file_b', type: 'jpeg' }, null], modelVersion: 'v3.0-20250812' }), REAL);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/generation/text-to-model`,
      `POST ${API}/generation/image-to-model`,
      `POST ${API}/generation/multiview-to-model`,
    ]);
    // texture=false 时一并关掉 pbr（Tripo 的 pbr 默认 true，会强制带贴图）
    expect(calls[0].body).toEqual({ prompt: 'a chair', model: 'v3.1-20260211', texture: false, pbr: false });
    expect(calls[1].body).toEqual({ input: 'file_abc123', model: 'v3.1-20260211', texture: true, pbr: true });
    // 多视图用 view-key 写法，跳过没有的视图
    expect(calls[2].body).toEqual({ inputs: [{ front: 'file_f' }, { back: 'file_b' }], model: 'v3.0-20250812' });
    for (const c of calls) expect(c.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });
});

describe('上传', () => {
  it('PNG 转发到 Tripo 的 POST /v3/files（multipart，字段 file），返回 token 和 type', async () => {
    const calls = fakeUpstream({ 'POST openapi.tripo3d.ai/v3/files': () => tripoOk({ file_token: 'file_abc123' }) });
    const out = await send(make(), postFile([['file', new Blob([PNG], { type: 'image/png' }), 'cat.png']]), REAL);
    expect(out.json).toEqual({ ok: true, token: 'file_abc123', type: 'png' });
    expect(calls).toHaveLength(1);
    const form = calls[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('file') as Blob;
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(PNG.length);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('JPEG 认得出来', async () => {
    const out = await send(make(), postFile([['file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])])]]));
    expect(out.json).toMatchObject({ ok: true, type: 'jpeg' });
  });

  it('单张图超过 10 MB 拒绝（413），不调上游', async () => {
    const calls = fakeUpstream();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    const out = await send(make(), postFile([['file', new Blob([big], { type: 'image/png' })]]), REAL);
    expect(out.status).toBe(413);
    expect(out.json.code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('不是 PNG / JPEG 的拒绝（按文件头判断，不信扩展名和 Content-Type）', async () => {
    const handle = make();
    const html = await send(handle, postFile([['file', new Blob(['<html>hi</html>'], { type: 'image/png' }), 'x.png']]));
    expect(html.status).toBe(415);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect((await send(handle, postFile([['file', new Blob([webp])]]))).status).toBe(415);
  });

  it('一次只收一张图，字段名只能是 file', async () => {
    const handle = make();
    const two = postFile([['file', new Blob([PNG])], ['file', new Blob([PNG])]]);
    expect((await send(handle, two)).json.code).toBe('bad_request');
    expect((await send(handle, postFile([['image', new Blob([PNG])]]))).json.code).toBe('bad_request');
    expect((await send(handle, postFile([['file', new Blob([PNG])], ['note', 'hi']]))).json.code).toBe('bad_request');
    const notMultipart = new Request(`${SITE}/api/tripo/upload`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    expect((await send(handle, notMultipart)).status).toBe(415);
  });
});

describe('下载只放行 Tripo 的结果，不能当通用代理', () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 1, 2, 3, 4]);
  function upstreamWith(modelUrl: string, extra: Record<string, Route> = {}) {
    return fakeUpstream({ [`GET openapi.tripo3d.ai/v3/tasks/${UUID}`]: () => taskOk({ model_url: modelUrl, rendered_image_url: modelUrl.replace('.glb', '.webp') }), ...extra });
  }
  const download = (env: TripoEnv = REAL) => send(make(), get(`/api/tripo/download/${UUID}`), env);

  it('结果在 Tripo 的主机上：流式转发，带 Content-Type 和长度，不把密钥发给存储主机', async () => {
    const calls = upstreamWith('https://openapi.cdn.tripo3d.com/out/model.glb?auth_key=abc', {
      'GET openapi.cdn.tripo3d.com/out/model.glb': () => new Response(glb, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(glb.length) } }),
    });
    const out = await download();
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toBe('model/gltf-binary');
    expect(out.headers.get('content-length')).toBe(String(glb.length));
    expect(Array.from(out.bytes)).toEqual(Array.from(glb));
    const storage = calls.find((c) => c.url.startsWith('https://openapi.cdn.tripo3d.com/'));
    expect(storage?.headers.get('authorization')).toBeNull();
  });

  it('存储主机压缩了响应：不照抄压缩后的 Content-Length（fetch 已经解压），并且请求时要原始字节', async () => {
    const calls = upstreamWith('https://openapi.cdn.tripo3d.com/out/model.glb', {
      'GET openapi.cdn.tripo3d.com/out/model.glb': () => new Response(glb, { headers: { 'content-encoding': 'gzip', 'content-length': '5' } }),
    });
    const out = await download();
    expect(out.status).toBe(200);
    expect(out.headers.get('content-length')).toBeNull();
    expect(out.bytes.length).toBe(glb.length);
    expect(calls.find((c) => c.url.includes('cdn.tripo3d.com'))?.headers.get('accept-encoding')).toBe('identity');
  });

  it.each([
    ['别的主机', 'https://evil.example.com/model.glb'],
    ['后缀伪装', 'https://openapi.cdn.tripo3d.com.evil.example/model.glb'],
    ['不是 https', 'http://openapi.cdn.tripo3d.com/model.glb'],
    ['带账号密码', 'https://user:pw@openapi.cdn.tripo3d.com/model.glb'],
    ['非默认端口', 'https://openapi.cdn.tripo3d.com:8443/model.glb'],
    ['内网地址', 'https://169.254.169.254/latest/meta-data'],
  ])('结果链接是%s：拒绝，也不去请求它', async (_name, url) => {
    const calls = upstreamWith(url);
    const out = await download();
    expect(out.status).toBe(502);
    expect(out.json.code).toBe('upstream');
    expect(calls.map((c) => c.url)).toEqual([`${API}/tasks/${UUID}`]);
  });

  it('跳转到白名单外的主机：拒绝，不跟过去', async () => {
    const calls = upstreamWith('https://openapi.cdn.tripo3d.com/model.glb', {
      'GET openapi.cdn.tripo3d.com/model.glb': () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }),
    });
    const out = await download();
    expect(out.json.code).toBe('upstream');
    expect(calls.some((c) => c.url.includes('evil.example.com'))).toBe(false);
  });

  it('TRIPO_DOWNLOAD_HOSTS 可以加主机', async () => {
    upstreamWith('https://d111.cloudfront.net/model.glb', { 'GET d111.cloudfront.net/model.glb': () => new Response(glb) });
    expect((await download()).status).toBe(502);
    upstreamWith('https://d111.cloudfront.net/model.glb', { 'GET d111.cloudfront.net/model.glb': () => new Response(glb) });
    expect((await download({ ...REAL, TRIPO_DOWNLOAD_HOSTS: 'd111.cloudfront.net' })).status).toBe(200);
  });

  it('任务没成功、任务 id 格式不对、模拟任务 id 到了真实模式：都不下载', async () => {
    const calls = fakeUpstream({ [`GET openapi.tripo3d.ai/v3/tasks/${UUID}`]: () => tripoOk({ task_id: UUID, status: 'running', progress: 40 }) });
    const handle = make();
    expect((await send(handle, get(`/api/tripo/download/${UUID}`), REAL)).json.code).toBe('not_found');
    expect((await send(handle, get('/api/tripo/download/..%2F..%2Fetc'), REAL)).json.code).toBe('bad_request');
    expect((await send(handle, get('/api/tripo/download/a.b.c.d.e.f.g'), REAL)).json.code).toBe('bad_request');
    expect((await send(handle, get('/api/tripo/download/mock_abc_8000_s_0123abcd'), REAL)).json.code).toBe('not_found');
    expect(calls).toHaveLength(1);
  });

  it('预览图：保留图片类型；上游给的不是图片就按二进制给，绝不当网页', async () => {
    upstreamWith('https://openapi.cdn.tripo3d.com/out/model.glb', {
      'GET openapi.cdn.tripo3d.com/out/model.webp': () => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }),
    });
    const out = await send(make(), get(`/api/tripo/preview/${UUID}`), REAL);
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toBe('application/octet-stream');
    expect(out.headers.get('x-content-type-options')).toBe('nosniff');
    expect(out.headers.get('content-security-policy')).toContain('sandbox');
  });
});

describe('查任务：状态和字段映射', () => {
  const poll = async (data: Record<string, unknown>, path = `/api/tripo/task/${UUID}`) => {
    fakeUpstream({ [`GET openapi.tripo3d.ai/v3/tasks/${UUID}`]: () => tripoOk({ task_id: UUID, type: 'text_to_model', ...data }) });
    return (await send(make(), get(path), REAL)).json;
  };

  it('成功：modelUrl / previewUrl 指向本服务（子路径部署也对）', async () => {
    const out = await poll({ status: 'success', progress: 100, output: { model_url: 'https://x.tripo3d.com/m.glb', rendered_image_url: 'https://x.tripo3d.com/p.webp' } }, `/gbn/api/tripo/task/${UUID}`);
    expect(out).toEqual({ ok: true, status: 'success', progress: 100, modelUrl: `/gbn/api/tripo/download/${UUID}`, previewUrl: `/gbn/api/tripo/preview/${UUID}` });
  });

  it('banned / expired 当 failed，没见过的状态当 unknown，进度夹在 0–100', async () => {
    expect((await poll({ status: 'banned', progress: 30 })).status).toBe('failed');
    expect((await poll({ status: 'expired' })).status).toBe('failed');
    expect(await poll({ status: 'weird', progress: 150 })).toEqual({ ok: true, status: 'unknown', progress: 100 });
    expect((await poll({ status: 'running', progress: -5 })).progress).toBe(0);
    expect(await poll({ status: 'queued' })).toEqual({ ok: true, status: 'queued', progress: 0 });
  });

  it('失败时给出原因和 Tripo 的错误码', async () => {
    const out = await poll({ status: 'failed', progress: 50, error_code: 2008, error_message: 'content policy' });
    expect(out.error).toContain('content policy');
    expect(out.error).toContain('2008');
  });

  it('Tripo 上找不到任务 → not_found', async () => {
    fakeUpstream({ [`GET openapi.tripo3d.ai/v3/tasks/${UUID}`]: () => tripoErr(404, 1004, 'task not found') });
    expect((await send(make(), get(`/api/tripo/task/${UUID}`), REAL)).json.code).toBe('not_found');
  });
});

describe('Tripo 的错误码映射', () => {
  const create = async (reply: Route) => {
    fakeUpstream({ 'POST openapi.tripo3d.ai/v3/generation/text-to-model': reply });
    return send(make(), text(), REAL);
  };

  it('2010 积分不足 → quota', async () => {
    const out = await create(() => tripoErr(403, 2010, "You don't have enough credit"));
    expect([out.status, out.json.code]).toEqual([402, 'quota']);
  });

  it('1007 / 2000（Tripo 的频率和并发上限）→ rate_limited，带上游的 Retry-After', async () => {
    const out = await create(() => tripoErr(429, 2000, 'limit', { 'retry-after': '17' }));
    expect([out.status, out.json.code, out.headers.get('retry-after')]).toEqual([429, 'rate_limited', '17']);
    expect((await create(() => tripoErr(429, 1007, 'rate'))).json.code).toBe('rate_limited');
  });

  it('2008 内容审核不过 → bad_request；401 密钥无效 → upstream；500 → upstream；连不上 → upstream', async () => {
    expect((await create(() => tripoErr(400, 2008, 'policy'))).json.code).toBe('bad_request');
    const unauthorized = await create(() => tripoErr(401, 1002, 'Authentication failed'));
    expect([unauthorized.status, unauthorized.json.code]).toEqual([502, 'upstream']);
    expect((await create(() => tripoErr(500, 1000, 'boom'))).json.code).toBe('upstream');
    const down = await create(() => {
      throw new TypeError('fetch failed');
    });
    expect([down.status, down.json.code]).toEqual([502, 'upstream']);
  });

  it('HTTP 200 但 code 不是 0 也算错', async () => {
    expect((await create(() => Response.json({ code: 2010, message: 'Insufficient credits' }))).json.code).toBe('quota');
  });
});

describe('密钥不出现在任何响应和日志里', () => {
  it('上游的报错里带着密钥也会被抹掉', async () => {
    fakeUpstream({
      'POST openapi.tripo3d.ai/v3/generation/text-to-model': () => tripoErr(400, 1004, `invalid key ${KEY} for tsk_other_key_123456`),
      [`GET openapi.tripo3d.ai/v3/tasks/${UUID}`]: () => tripoOk({ task_id: UUID, status: 'failed', error_message: `bad auth ${KEY}` }),
      'GET openapi.tripo3d.ai/v3/account/balance': () => tripoOk({ balance: 41465.5, frozen: 30 }),
    });
    const handle = make();
    const created = await send(handle, text(), REAL);
    expect(created.json.code).toBe('bad_request');
    expect(created.text).not.toContain('tsk_other_key_123456');
    const polled = await send(handle, get(`/api/tripo/task/${UUID}`), REAL);
    expect(polled.json.status).toBe('failed');
    expect((await send(handle, get('/api/tripo/balance'), REAL)).json).toEqual({ ok: true, balance: 41465.5, frozen: 30 });
    for (const out of [created, polled]) expect(out.text).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('网络错误的日志里也没有密钥', async () => {
    fakeUpstream({
      'POST openapi.tripo3d.ai/v3/generation/text-to-model': () => {
        throw new Error(`socket hang up (Authorization: Bearer ${KEY})`);
      },
    });
    await send(make(), text(), REAL);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(KEY);
  });
});

describe('跨域白名单', () => {
  it('别的网站来的请求拒绝（403），预检也拒绝', async () => {
    const handle = make();
    const out = await send(handle, get('/api/tripo/health', { origin: 'https://evil.example' }));
    expect(out.status).toBe(403);
    expect(out.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = new Request(`${SITE}/api/tripo/task`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect((await send(handle, preflight)).status).toBe(403);
  });

  it('ALLOWED_ORIGINS 里的来源放行，回带 Access-Control-Allow-Origin；结尾的斜杠不影响', async () => {
    const handle = make();
    const env = { ALLOWED_ORIGINS: 'https://demo.example/, https://other.example' };
    const out = await send(handle, get('/api/tripo/health', { origin: 'https://demo.example' }), env);
    expect(out.status).toBe(200);
    expect(out.headers.get('access-control-allow-origin')).toBe('https://demo.example');
    expect(out.headers.get('vary')).toContain('Origin');
    const preflight = new Request(`${SITE}/api/tripo/task`, { method: 'OPTIONS', headers: { origin: 'https://other.example' } });
    const pre = await send(handle, preflight, env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('同源请求（Origin 和 Host 一致，协议不论）、不带 Origin 的请求放行', async () => {
    const handle = make();
    expect((await send(handle, get('/api/tripo/health', { origin: 'https://site.test' }))).status).toBe(200);
    expect((await send(handle, get('/api/tripo/health'))).status).toBe(200);
  });
});

describe('模拟模式', () => {
  const at = async (handle: TripoHandle, id: string) => (await send(handle, get(`/api/tripo/task/${id}`))).json;

  it('任务 8–12 秒内 queued → running → success，进度只升不降；成功后能下载、能看预览', async () => {
    const model = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const handle = make({ loadMockModel: async () => ({ body: model, size: model.length, contentType: 'model/gltf-binary' }) });
    const { taskId } = (await send(handle, text())).json;
    expect(await at(handle, taskId)).toEqual({ ok: true, status: 'queued', progress: 0 });
    let last = 0;
    for (let t = 2000; t < 8000; t += 1000) {
      clock = T0 + t;
      const s = await at(handle, taskId);
      expect(s.status).toBe('running');
      expect(s.progress).toBeGreaterThanOrEqual(last);
      expect(s.progress).toBeLessThan(100);
      last = s.progress;
    }
    expect((await send(handle, get(`/api/tripo/download/${taskId}`))).json.code).toBe('not_found');
    clock = T0 + 12_000;
    const done = await at(handle, taskId);
    expect(done).toEqual({ ok: true, status: 'success', progress: 100, modelUrl: `/api/tripo/download/${taskId}`, previewUrl: `/api/tripo/preview/${taskId}` });
    const file = await send(handle, get(done.modelUrl));
    expect(file.headers.get('content-type')).toBe('model/gltf-binary');
    expect(file.headers.get('content-length')).toBe(String(model.length));
    const preview = await send(handle, get(done.previewUrl));
    expect(preview.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('提示词带 #fail：跑到一半失败；#quota、#upstream：建任务时直接报对应的错', async () => {
    const handle = make();
    const { taskId } = (await send(handle, text('chair #fail'))).json;
    clock = T0 + 12_000;
    const s = await at(handle, taskId);
    expect(s.status).toBe('failed');
    expect(s.error).toContain('#fail');
    expect((await send(handle, text('chair #quota'))).json.code).toBe('quota');
    expect((await send(handle, text('chair #upstream'))).json.code).toBe('upstream');
  });

  it('上传的文件名带 #fail：用它的图片任务、多视图任务都会失败', async () => {
    const handle = make();
    const up = (await send(handle, postFile([['file', new Blob([PNG]), 'cat#fail.png']]))).json;
    expect(up.token).toMatch(/^mock_file_fail_/);
    const good = (await send(handle, postFile([['file', new Blob([PNG]), 'cat.png']]))).json;
    const image = (await send(handle, postJson({ mode: 'image', token: up.token, type: up.type }))).json.taskId;
    const multi = (await send(handle, postJson({ mode: 'multiview', views: [{ token: good.token }, { token: up.token }, null, null] }))).json.taskId;
    clock = T0 + 12_000;
    expect((await at(handle, image)).status).toBe('failed');
    expect((await at(handle, multi)).status).toBe('failed');
  });

  it('没有模型加载器时按 MOCK_MODEL_URL 去取（Worker 的用法）', async () => {
    const model = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
    const calls = fakeUpstream({ 'GET assets.site.test/models/m.glb': () => new Response(model, { headers: { 'content-length': '4' } }) });
    const handle = make();
    const { taskId } = (await send(handle, text())).json;
    clock = T0 + 12_000;
    const out = await send(handle, get(`/api/tripo/download/${taskId}`), { MOCK_MODEL_URL: 'https://assets.site.test/models/m.glb' });
    expect(out.status).toBe(200);
    expect(out.bytes.length).toBe(4);
    expect(calls).toHaveLength(1);
    expect((await send(handle, get(`/api/tripo/download/${taskId}`))).json.code).toBe('upstream');
  });

  it('模拟模式不认真实任务 id', async () => {
    expect((await send(make(), get(`/api/tripo/task/${UUID}`))).json.code).toBe('not_found');
  });
});

describe('Cloudflare Worker 外壳（worker.mjs）', () => {
  // ASSETS 绑定的替身：记下被要的地址
  function fakeAssets(files: Record<string, Uint8Array<ArrayBuffer>> = {}) {
    const asked: string[] = [];
    return {
      asked,
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        const body = files[path];
        return body ? new Response(body, { headers: { 'content-length': String(body.length), 'content-type': 'model/gltf-binary' } }) : new Response('page', { status: 200 });
      },
    };
  }
  const wreq = (path: string, init: RequestInit = {}, ip = '198.18.0.1') => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', ip);
    return new Request(`https://planets.example${path}`, { ...init, headers });
  };
  afterEach(() => vi.useRealTimers());

  it('真实模式下每个实例第一次处理接口请求时提示一次会消耗额度，不带密钥', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await worker.fetch(wreq('/api/tripo/health'), { TRIPO_API_KEY: KEY });
    expect(await res.json()).toEqual({ ok: true, mock: false });
    await worker.fetch(wreq('/api/tripo/health'), { TRIPO_API_KEY: KEY });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('真实模式');
    expect(String(warn.mock.calls[0][0])).not.toContain(KEY);
    warn.mockRestore();
  });

  it('/api/tripo/* 交给中转，其余交给静态资源', async () => {
    const assets = fakeAssets();
    expect(await (await worker.fetch(wreq('/api/tripo/health'), { ASSETS: assets })).json()).toEqual({ ok: true, mock: true });
    expect((await worker.fetch(wreq('/index.html'), { ASSETS: assets })).status).toBe(200);
    expect(assets.asked).toEqual(['/index.html']);
    expect((await worker.fetch(wreq('/x'), {})).status).toBe(404);
  });

  it('按 CF-Connecting-IP 限流', async () => {
    const env = { TRIPO_MAX_TASKS_PER_IP_PER_HOUR: '1' };
    const task = (ip: string) => worker.fetch(wreq('/api/tripo/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text', prompt: 'x' }) }, ip), env);
    expect((await task('198.18.1.1')).status).toBe(200);
    expect((await task('198.18.1.1')).status).toBe(429);
    expect((await task('198.18.1.2')).status).toBe(200);
  });

  it('模拟模式的模型按 MOCK_MODEL_URL 从静态资源取（同源相对地址不绕回 Worker）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    const assets = fakeAssets({ '/models/m.glb': glb });
    const env = { ASSETS: assets, MOCK_MODEL_URL: '/models/m.glb' };
    const created = await (await worker.fetch(wreq('/api/tripo/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text', prompt: 'x' }) }, '198.18.2.1'), env)).json();
    vi.setSystemTime(T0 + 13_000);
    const res = await worker.fetch(wreq(`/api/tripo/download/${created.taskId}`, {}, '198.18.2.1'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(glb.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(glb);
    expect(assets.asked).toEqual(['/models/m.glb']);
  });
});

describe('Vite 插件', () => {
  it('会进前端包的 VITE_ 变量里有像 Tripo 密钥的就直接报错', () => {
    const plugin = tripoProxy() as unknown as { configResolved(config: { env: Record<string, string> }): void };
    expect(() => plugin.configResolved({ env: { VITE_TRIPO_API_KEY: 'x' } })).toThrow(/VITE_TRIPO_API_KEY/);
    expect(() => plugin.configResolved({ env: { VITE_TRIPO_PROXY: 'https://proxy.example', MODE: 'development' } })).not.toThrow();
  });
});

describe('路由', () => {
  it('不存在的接口 → not_found；方法不对 → bad_request（405）', async () => {
    const handle = make();
    expect((await send(handle, get('/api/tripo/nope'))).json.code).toBe('not_found');
    const wrong = await send(handle, new Request(`${SITE}/api/tripo/health`, { method: 'DELETE' }));
    expect([wrong.status, wrong.json.code]).toEqual([405, 'bad_request']);
    expect((await send(handle, get('/api/tripo/task'))).status).toBe(405);
  });
});

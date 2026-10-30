// Durable Objects 版的限流（server/tripo/rate-limiter.mjs）和 Worker 外壳（worker.mjs）的单元测试。
// Durable Objects 用 tests/fakeRateLimiter.ts 的替身（按名字建真的 RateLimiter 类，存储是内存里的假 SQLite KV），不连 Cloudflare。
// 覆盖：滑动窗口的纯逻辑（和内存版共用）、对象里的存取 / 重启后计数还在 / 过期清理、Worker 这边一次检查一次往返、
// 退名额走 waitUntil、可重试的错误重试一次、和内存版逐步一致、经过中转的 rate_limited / daily_cap、
// worker.mjs 的路由（静态资源不碰 Durable Objects）、第一版和第二版共用每日上限、真实模式缺绑定时拒绝。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler, createMemoryStore, pruneStamps, RATE_WINDOW_MAX_MS, windowHit, windowRelease, type RateLimitHit, type TripoEnv } from '../server/tripo/handler.mjs';
import { createDurableStore, RateLimiter } from '../server/tripo/rate-limiter.mjs';
import worker from '../server/tripo/worker.mjs';
import { fakeDurableState, fakeLimiterNamespace, type FakeRpcError } from './fakeRateLimiter';

const T0 = Date.UTC(2026, 9, 30, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KEY = 'tsk_unit_test_SECRET_1a2b3c4d5e6f';

let clock = T0;
beforeEach(() => {
  clock = T0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 收集 waitUntil 交过来的活，测试里等它们做完
function pending() {
  const list: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void list.push(p), flush: () => Promise.all(list.splice(0)) };
}

describe('滑动窗口的纯逻辑（内存版和 Durable Objects 版共用）', () => {
  it('窗口里满了就拒，给出还要等多久（至少 1 秒）；最早的那个过期后又能用', () => {
    const s: number[] = [];
    for (let i = 0; i < 3; i++) expect(windowHit(s, 3, HOUR, T0 + i * MINUTE)).toEqual({ ok: true, retryAfterMs: 0 });
    expect(windowHit(s, 3, HOUR, T0 + 10 * MINUTE)).toEqual({ ok: false, retryAfterMs: 50 * MINUTE });
    expect(windowHit(s, 3, HOUR, T0 + HOUR - 1)).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(windowHit(s, 3, HOUR, T0 + HOUR)).toEqual({ ok: true, retryAfterMs: 0 });
    expect(s).toEqual([T0 + MINUTE, T0 + 2 * MINUTE, T0 + HOUR]);
  });

  it('limit ≤ 0 表示关掉：直接拒，不记时间戳', () => {
    const s: number[] = [];
    expect(windowHit(s, 0, DAY, T0)).toEqual({ ok: false, retryAfterMs: null });
    expect(s).toEqual([]);
  });

  it('各实例的时钟差几毫秒也保持升序；退名额去掉对应的时间戳，没有就返回 false', () => {
    const s: number[] = [];
    windowHit(s, 5, HOUR, T0 + 20);
    windowHit(s, 5, HOUR, T0 + 5);
    windowHit(s, 5, HOUR, T0 + 30);
    expect(s).toEqual([T0 + 5, T0 + 20, T0 + 30]);
    expect(windowRelease(s, T0 + 20)).toBe(true);
    expect(windowRelease(s, T0 + 20)).toBe(false);
    expect(s).toEqual([T0 + 5, T0 + 30]);
    pruneStamps(s, T0 + 5);
    expect(s).toEqual([T0 + 30]);
  });
});

describe('RateLimiter（Durable Object 本身）', () => {
  it('占名额写进存储；对象被回收、重新建出来以后接着数（wrangler dev 重启也是这样）', async () => {
    const state = fakeDurableState();
    const a = new RateLimiter(state, {});
    for (let i = 0; i < 5; i++) expect((await a.hit('task:1.2.3.4', 5, HOUR, T0 + i)).ok).toBe(true);
    expect(state.data.get('task:1.2.3.4')).toHaveLength(5);
    const b = new RateLimiter(state, {});
    expect(await b.hit('task:1.2.3.4', 5, HOUR, T0 + 10)).toEqual({ ok: false, retryAfterMs: HOUR - 10 });
    await b.release('task:1.2.3.4', T0 + 4);
    expect(state.data.get('task:1.2.3.4')).toHaveLength(4);
  });

  it('被拒的请求不写存储；退到一个不剩就删掉这个 key', async () => {
    const state = fakeDurableState();
    const o = new RateLimiter(state, {});
    await o.hit('task:all', 1, DAY, T0);
    const writes = state.stats.writes;
    expect((await o.hit('task:all', 1, DAY, T0 + 1)).ok).toBe(false);
    expect(state.stats.writes).toBe(writes);
    await o.release('task:all', T0);
    expect(state.data.has('task:all')).toBe(false);
  });

  it('只排一次清理闹钟；闹钟响时比一天还旧的都清掉，什么都不剩就整个删掉，还有新的就等它过期再来', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const state = fakeDurableState();
    const o = new RateLimiter(state, {});
    await o.hit('req:1.2.3.4', 300, MINUTE, T0);
    const first = state.alarm();
    expect(first).toBeGreaterThan(T0 + RATE_WINDOW_MAX_MS);
    await o.hit('req:1.2.3.4', 300, MINUTE, T0 + 1000);
    expect(state.alarm()).toBe(first);

    // 一天后又来了一次请求，闹钟响时还剩这一个：不删，改排到它过期以后
    vi.setSystemTime(T0 + DAY);
    await o.hit('req:1.2.3.4', 300, MINUTE, T0 + DAY);
    vi.setSystemTime(first!);
    await o.alarm();
    expect(state.data.get('req:1.2.3.4')).toEqual([T0 + DAY]);
    expect(state.alarm()).toBeGreaterThan(T0 + 2 * DAY);

    vi.setSystemTime(state.alarm()!);
    await o.alarm();
    expect(state.data.size).toBe(0);
    expect(state.alarm()).toBeNull();
    // 删干净以后照样能用，会重新排闹钟
    expect((await o.hit('req:1.2.3.4', 300, MINUTE, T0 + 3 * DAY)).ok).toBe(true);
    expect(state.alarm()).not.toBeNull();
  });
});

describe('createDurableStore（Worker 这边）', () => {
  it('一次限流检查一次 RPC；同一个 key 总是同一个对象，task:all 全球只有一个对象', async () => {
    const ns = fakeLimiterNamespace();
    const store = createDurableStore(ns);
    await store.hit('task:198.51.100.1', 5, HOUR, T0);
    await store.hit('task:all', 30, DAY, T0);
    await store.hit('task:198.51.100.2', 5, HOUR, T0);
    await store.hit('task:all', 30, DAY, T0 + 1);
    expect(ns.calls).toEqual(['hit task:198.51.100.1', 'hit task:all', 'hit task:198.51.100.2', 'hit task:all']);
    expect(ns.stamps('task:all')).toEqual([T0, T0 + 1]);
    expect(ns.stamps('task:198.51.100.1')).toEqual([T0]);
  });

  it('退名额交给 waitUntil，做完以后名额回来了；退两次只算一次；被拒的结果退了也没事', async () => {
    const ns = fakeLimiterNamespace();
    const jobs = pending();
    const store = createDurableStore(ns, jobs);
    const a = await store.hit('upload:1.2.3.4', 1, HOUR, T0);
    const denied = await store.hit('upload:1.2.3.4', 1, HOUR, T0 + 1);
    expect([a.ok, denied.ok, denied.retryAfterMs]).toEqual([true, false, HOUR - 1]);
    denied.release();
    a.release();
    a.release();
    await jobs.flush();
    expect(ns.calls.filter((c) => c.startsWith('release'))).toHaveLength(1);
    expect(ns.stamps('upload:1.2.3.4')).toEqual([]);
    expect((await store.hit('upload:1.2.3.4', 1, HOUR, T0 + 2)).ok).toBe(true);
  });

  it('可重试的错误（比如部署时对象被重置）重试一次；overloaded 和别的错误直接抛出', async () => {
    const ns = fakeLimiterNamespace();
    const store = createDurableStore(ns);
    const err = (message: string, extra: Partial<FakeRpcError>) => Object.assign(new Error(message), extra);
    ns.failNext.push(err('reset', { retryable: true }));
    expect((await store.hit('req:a', 10, MINUTE, T0)).ok).toBe(true);
    expect(ns.calls).toEqual(['hit req:a', 'hit req:a']);
    ns.failNext.push(err('busy', { retryable: true, overloaded: true }));
    await expect(store.hit('req:a', 10, MINUTE, T0)).rejects.toThrow('busy');
    ns.failNext.push(err('boom', {}));
    await expect(store.hit('req:a', 10, MINUTE, T0)).rejects.toThrow('boom');
    ns.failNext.push(err('reset', { retryable: true }), err('reset again', { retryable: true }));
    await expect(store.hit('req:a', 10, MINUTE, T0)).rejects.toThrow('reset again');
  });

  it('和内存版逐步一致（同一串随机的占名额、退名额）', async () => {
    const memory = createMemoryStore();
    const ns = fakeLimiterNamespace();
    const jobs = pending();
    const durable = createDurableStore(ns, jobs);
    let seed = 20261030;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const held: Array<[RateLimitHit, RateLimitHit]> = [];
    let t = T0;
    let accepted = 0;
    for (let i = 0; i < 500; i++) {
      t += Math.floor(rand() * 15 * MINUTE);
      if (held.length && rand() < 0.2) {
        const [a, b] = held.splice(Math.floor(rand() * held.length), 1)[0];
        a.release();
        b.release();
        await jobs.flush();
        continue;
      }
      const key = ['task:a', 'task:b', 'task:all'][Math.floor(rand() * 3)];
      const limit = key === 'task:all' ? 6 : 3;
      const a = await memory.hit(key, limit, HOUR, t);
      const b = await durable.hit(key, limit, HOUR, t);
      expect([b.ok, b.retryAfterMs]).toEqual([a.ok, a.retryAfterMs]);
      if (a.ok) {
        accepted++;
        held.push([a, b]);
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(450);
  });
});

describe('中转 + Durable Objects 计数', () => {
  const task = (prompt = 'a small wooden chair') =>
    new Request('http://site.test/api/tripo/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text', prompt }) });
  const send = async (handle: ReturnType<typeof createHandler>, env: TripoEnv, ip: string) => {
    const res = await handle(task(), env, { ip });
    return { status: res.status, json: await res.json() };
  };
  const make = (ns: ReturnType<typeof fakeLimiterNamespace>) => createHandler({ now: () => clock, store: createDurableStore(ns), log: {} });

  it('同一个 IP 第 6 个任务 rate_limited；重启（对象和中转都重新建）以后还是被拦', async () => {
    const ns = fakeLimiterNamespace();
    let handle = make(ns);
    for (let i = 0; i < 5; i++) expect((await send(handle, {}, '198.51.100.1')).status).toBe(200);
    ns.restart();
    handle = make(ns);
    const sixth = await send(handle, {}, '198.51.100.1');
    expect([sixth.status, sixth.json.code]).toEqual([429, 'rate_limited']);
    expect(sixth.json.retryAfter).toBeGreaterThan(0);
    clock += HOUR + 1000;
    expect((await send(handle, {}, '198.51.100.1')).status).toBe(200);
  });

  it('每日上限换 IP 也绕不过去；设 0 立刻关掉，并且不占这个 IP 的名额', async () => {
    const ns = fakeLimiterNamespace();
    const handle = make(ns);
    const env = { TRIPO_MAX_TASKS_PER_DAY: '3' };
    for (let i = 0; i < 3; i++) expect((await send(handle, env, `192.0.2.${i}`)).status).toBe(200);
    expect((await send(handle, env, '192.0.2.99')).json.code).toBe('daily_cap');
    expect((await send(handle, { TRIPO_MAX_TASKS_PER_DAY: '0' }, '192.0.2.50')).json.code).toBe('daily_cap');
    expect(ns.stamps('task:192.0.2.50')).toEqual([]);
  });
});

describe('worker.mjs 接上 Durable Objects', () => {
  const ASSET = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
  // withLength=false：和 Worker 运行时里的静态资源绑定一样，响应头里没有 Content-Length
  function fakeAssets({ withLength = true } = {}) {
    const asked: string[] = [];
    return {
      asked,
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        const length: Record<string, string> = withLength ? { 'content-length': String(ASSET.length) } : {};
        if (path === '/models/m.glb') return new Response(ASSET, { headers: { ...length, 'content-type': 'model/gltf-binary' } });
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      },
    };
  }
  const wreq = (path: string, ip = '198.18.0.1', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', ip);
    return new Request(`https://planets.example${path}`, { ...init, headers });
  };
  const postTask = (ip: string, prompt = 'x') =>
    wreq('/api/tripo/task', ip, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'text', prompt }) });

  it('静态资源不碰 Durable Objects；每个接口请求只查一次 req:<ip>，建任务再查 task:<ip> 和 task:all', async () => {
    const ns = fakeLimiterNamespace();
    const env = { ASSETS: fakeAssets(), RATE_LIMITER: ns };
    expect((await worker.fetch(wreq('/'), env)).status).toBe(200);
    expect((await worker.fetch(wreq('/models/m.glb'), env)).status).toBe(200);
    expect(ns.calls).toEqual([]);
    expect(await (await worker.fetch(wreq('/api/tripo/health'), env)).json()).toEqual({ ok: true, mock: true });
    expect(ns.calls).toEqual(['hit req:198.18.0.1']);
    expect((await worker.fetch(postTask('198.18.0.2'), env)).status).toBe(200);
    expect(ns.calls.slice(1)).toEqual(['hit req:198.18.0.2', 'hit task:198.18.0.2', 'hit task:all']);
  });

  it('第一版和第二版绑同一个 RateLimiter：每日上限两边合计', async () => {
    const ns = fakeLimiterNamespace();
    const v1 = { RATE_LIMITER: ns, TRIPO_MAX_TASKS_PER_DAY: '3' };
    const v2 = { RATE_LIMITER: ns, TRIPO_MAX_TASKS_PER_DAY: '3', MOCK_MODEL_URL: '/models/m.glb' };
    expect((await worker.fetch(postTask('198.18.1.1'), v1)).status).toBe(200);
    expect((await worker.fetch(postTask('198.18.1.2'), v2)).status).toBe(200);
    expect((await worker.fetch(postTask('198.18.1.3'), v1)).status).toBe(200);
    const capped = await worker.fetch(postTask('198.18.1.4'), v2);
    expect([capped.status, (await capped.json()).code]).toEqual([429, 'daily_cap']);
    expect(ns.stamps('task:all')).toHaveLength(3);
  });

  it('模拟的生成走完：建任务、轮询到 success、下载的模型从静态资源流式转发', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const assets = fakeAssets();
    const env = { ASSETS: assets, RATE_LIMITER: fakeLimiterNamespace(), MOCK_MODEL_URL: '/models/m.glb' };
    const { taskId } = await (await worker.fetch(postTask('198.18.2.1'), env)).json();
    vi.setSystemTime(T0 + 13_000);
    const state = await (await worker.fetch(wreq(`/api/tripo/task/${taskId}`, '198.18.2.1'), env)).json();
    expect(state).toMatchObject({ ok: true, status: 'success', progress: 100, modelUrl: `/api/tripo/download/${taskId}` });
    const glb = await worker.fetch(wreq(state.modelUrl, '198.18.2.1'), env);
    expect([glb.status, glb.headers.get('content-type'), glb.headers.get('content-length')]).toEqual([200, 'model/gltf-binary', String(ASSET.length)]);
    expect(new Uint8Array(await glb.arrayBuffer())).toEqual(ASSET);
  });

  it('模拟模式的模型是自己的文件：静态资源绑定不给长度时也原样转发，不套限大小的 TransformStream', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    // 上限设成 0：要是还套着限大小的流，下载会在第一个分块就断
    const env = { ASSETS: fakeAssets({ withLength: false }), RATE_LIMITER: fakeLimiterNamespace(), MOCK_MODEL_URL: '/models/m.glb', TRIPO_MAX_DOWNLOAD_MB: '0' };
    const { taskId } = await (await worker.fetch(postTask('198.18.2.9'), env)).json();
    vi.setSystemTime(T0 + 13_000);
    const glb = await worker.fetch(wreq(`/api/tripo/download/${taskId}`, '198.18.2.9'), env);
    expect(glb.status).toBe(200);
    expect(new Uint8Array(await glb.arrayBuffer())).toEqual(ASSET);
  });

  it('Tripo 明确拒绝时退回名额：退名额交给 ctx.waitUntil，做完以后计数回到原样', async () => {
    const ns = fakeLimiterNamespace();
    const jobs = pending();
    const res = await worker.fetch(postTask('198.18.3.1', 'chair #quota'), { RATE_LIMITER: ns }, jobs);
    expect((await res.json()).code).toBe('quota');
    await jobs.flush();
    expect(ns.stamps('task:198.18.3.1')).toEqual([]);
    expect(ns.stamps('task:all')).toEqual([]);
  });

  it('真实模式没有 RATE_LIMITER 绑定：所有接口都拒绝（500），不调 Tripo；模拟模式退回内存计数', async () => {
    vi.resetModules();
    const fresh = (await import('../server/tripo/worker.mjs')).default;
    const upstream = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', upstream);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const health = await fresh.fetch(wreq('/api/tripo/health'), { TRIPO_API_KEY: KEY });
    expect(health.status).toBe(500);
    expect((await health.json()).message).toContain('RATE_LIMITER');
    expect((await fresh.fetch(postTask('198.18.4.1'), { TRIPO_API_KEY: KEY })).status).toBe(500);
    expect(upstream).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/真实模式[\s\S]*RATE_LIMITER/);
    expect(warn.mock.calls.join('\n')).not.toContain(KEY);
    expect(await (await fresh.fetch(wreq('/api/tripo/health'), {})).json()).toEqual({ ok: true, mock: true });
  });
});

// Cloudflare Worker 外壳：/api/tripo/* 交给 handler.mjs，其余请求交给静态资源（Workers Static Assets，绑定名 ASSETS）。
// 配置在仓库根目录的 wrangler.toml（第一版用顶层配置，第二版加 --env v2），上线步骤见 docs/TRIPO.md 第 7 节：
//   方案 A（在用的）：同一个 Worker 既托管 dist/ 又做中转（同源，ALLOWED_ORIGINS 留空）；
//   方案 B：Worker 只做中转，前端放在别处，构建时设 VITE_TRIPO_PROXY=<Worker 地址>，Worker 上设 ALLOWED_ORIGINS=<前端地址>。
// 密钥用 `npx wrangler@4.156.0 secret put TRIPO_API_KEY` 存，不写进 wrangler.toml。
//
// 限流计数在 Durable Objects 里（rate-limiter.mjs，绑定名 RATE_LIMITER）：全局一致，全站每日上限只有一个对象。
// 静态资源的请求不进 Worker（wrangler.toml 里 run_worker_first 只有 /api/*），也就不碰 Durable Objects。
// 没有 RATE_LIMITER 绑定时：模拟模式退回内存计数（不花钱，单元测试、只看页面时用）；真实模式直接拒绝，不让限流形同虚设。
import { createHandler, isTripoPath, readConfig } from './handler.mjs';
import { createDurableStore } from './rate-limiter.mjs';

// Durable Object 的类要从入口模块导出，wrangler.toml 的 [[durable_objects.bindings]] 按类名找它
export { RateLimiter } from './rate-limiter.mjs';

// 模拟模式的模型和预览图：MOCK_MODEL_URL / MOCK_PREVIEW_URL。同源的相对地址（如 /models/x.glb）直接从静态资源取，不绕回 Worker 自己
function assetLoader(kind) {
  return async (env, request) => {
    const raw = kind === 'model' ? env.MOCK_MODEL_URL : env.MOCK_PREVIEW_URL;
    if (!raw) return null;
    const target = new URL(raw, request.url);
    const sameOrigin = target.origin === new URL(request.url).origin;
    const res = sameOrigin && env.ASSETS ? await env.ASSETS.fetch(new Request(target)) : await fetch(target);
    if (!res.ok || !res.body) return null;
    const size = Number(res.headers.get('content-length'));
    return { body: res.body, size: size > 0 ? size : undefined, contentType: res.headers.get('content-type') ?? undefined };
  };
}

const loaders = { loadMockModel: assetLoader('model'), loadMockPreview: assetLoader('preview') };
const memoryHandle = createHandler(loaders);
let announced = false;

// 真实模式缺了 RATE_LIMITER 绑定：宁可停用接口，也不在只有单实例计数的情况下花额度
function missingLimiter() {
  const message = '服务端没有配置 Durable Objects 限流（RATE_LIMITER 绑定），为防止盗刷，接口已停用。请检查 wrangler.toml';
  return new Response(JSON.stringify({ ok: false, code: 'upstream', message }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!isTripoPath(url.pathname)) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const cfg = readConfig(env);
    // Worker 没有「启动」时机：每个实例第一次处理接口请求时打一行（wrangler tail 能看到），不带密钥
    if (!announced) {
      announced = true;
      if (!cfg.mock) console.warn(`⚠ Tripo 真实模式：会消耗额度（每个 IP 每小时 ${cfg.tasksPerIpPerHour} 个任务，24 小时内最多 ${cfg.tasksPerDay} 个）`);
      if (!env.RATE_LIMITER) console.warn(`[tripo] 没有 RATE_LIMITER 绑定（Durable Objects）：${cfg.mock ? '模拟模式先用单实例的内存计数' : '真实模式拒绝所有接口请求'}`);
    }
    let handle = memoryHandle;
    if (env.RATE_LIMITER) {
      // 按请求建：store 要用这次请求的绑定和 ctx.waitUntil
      handle = createHandler({ ...loaders, store: createDurableStore(env.RATE_LIMITER, { waitUntil: ctx?.waitUntil?.bind(ctx) }) });
    } else if (!cfg.mock) {
      return missingLimiter();
    }
    // CF-Connecting-IP 由 Cloudflare 填，客户端伪造不了
    return handle(request, env, { ip: request.headers.get('cf-connecting-ip') ?? '' });
  },
};

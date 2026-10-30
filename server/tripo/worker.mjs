// Cloudflare Worker 外壳：/api/tripo/* 交给 handler.mjs，其余请求交给静态资源（Workers Static Assets，绑定名 ASSETS）。
// 部署方式见 wrangler.toml.example 和 docs/TRIPO.md：
//   方案 A：同一个 Worker 既托管 dist/ 又做中转（同源，ALLOWED_ORIGINS 留空）；
//   方案 B：Worker 只做中转，前端放在别处，构建时设 VITE_TRIPO_PROXY=<Worker 地址>，Worker 上设 ALLOWED_ORIGINS=<前端地址>。
// 密钥用 `npx wrangler secret put TRIPO_API_KEY` 存，不写进 wrangler.toml。
//
// 注意：限流计数在内存里，只在单个 Worker 实例（isolate）里有效。Cloudflare 会在很多机房同时跑很多实例、随时回收，
// 所以这里的每 IP 限流和每日上限只能挡住同一实例里的连续请求，挡不住分散的盗刷。真正上线要换成 Durable Objects（强一致，推荐）
// 或 KV（最终一致，计数会有误差），做法：实现 hit(key, limit, windowMs, now) → { ok, retryAfterMs, release() }，
// 传给 createHandler({ store })。docs/TRIPO.md 里有示意代码。
import { createHandler, isTripoPath, readConfig } from './handler.mjs';

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

const handle = createHandler({ loadMockModel: assetLoader('model'), loadMockPreview: assetLoader('preview') });
let announced = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTripoPath(url.pathname)) {
      // Worker 没有「启动」时机：每个实例第一次处理接口请求时打一行（wrangler tail 能看到），不带密钥
      if (!announced) {
        announced = true;
        if (!readConfig(env).mock) console.warn('⚠ Tripo 真实模式：会消耗额度');
      }
      // CF-Connecting-IP 由 Cloudflare 填，客户端伪造不了
      return handle(request, env, { ip: request.headers.get('cf-connecting-ip') ?? '' });
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};

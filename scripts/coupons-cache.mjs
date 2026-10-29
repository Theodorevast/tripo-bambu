// 跑现成的自查脚本（smoke、check-walk、check-editor……）时，给开发服务器一个只属于自己的缓存目录：
//   node --import ./scripts/coupons-cache.mjs scripts/smoke.mjs
// worktree 里的 node_modules 是指向主目录的链接，Vite 默认的缓存 node_modules/.vite 是几个 agent 共用的，同时跑会互相踩。
// 做法：加载 scripts/lib/browser.mjs 时，在 createServer 的配置里垫一个 cacheDir（VITE_CACHE_DIR，默认 .tmp/vite-coupons），脚本本身不用改
import { register } from 'node:module';

const hook = `
export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith('/lib/browser.mjs')) return r;
  const text = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  const dir = ${JSON.stringify(process.env.VITE_CACHE_DIR ?? '.tmp/vite-coupons')};
  return { ...r, source: text.replace('createServer({ ...overrides,', 'createServer({ cacheDir: ' + JSON.stringify(dir) + ', ...overrides,') };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

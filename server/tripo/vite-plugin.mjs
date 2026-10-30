// Vite 插件：开发服务器（npm run dev）和本地预览（vite preview）都挂上 /api/tripo，环境变量从 .env.local 等文件读。
// 只有服务端读这些变量；VITE_ 开头的才会进前端包，所以密钥一定叫 TRIPO_API_KEY，不能叫 VITE_TRIPO_API_KEY。
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { createHandler, readConfig } from './handler.mjs';
import { createFileLoaders, createNodeMiddleware } from './node-adapter.mjs';

// Host 头检查（防 DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1 来调本机的接口）。
// Vite 自己也查，但我们的中间件排在它前面，所以这里照 Vite 的 allowedHosts 规则再查一遍
function hostAllowed(hostHeader, allowed) {
  if (allowed === true) return true;
  const hostname = String(hostHeader ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return true; // IP 字面量
  return Array.isArray(allowed) && allowed.some((a) => (a.startsWith('.') ? hostname === a.slice(1) || hostname.endsWith(a) : hostname === a));
}

function mount(server, kind) {
  const config = server.config;
  const env = config.envDir === false ? { ...process.env } : loadEnv(config.mode, config.envDir || config.root, '');
  const cfg = readConfig(env);
  const handle = createHandler(createFileLoaders({ dirs: [config.publicDir, resolve(config.root, config.build.outDir), config.root] }));
  const middleware = createNodeMiddleware({ handle, getEnv: () => env, log: { error: (m) => config.logger.error(m) } });
  const allowed = kind === 'preview' ? config.preview?.allowedHosts ?? config.server?.allowedHosts : config.server?.allowedHosts;
  server.middlewares.use((req, res, next) => {
    const path = String(req.url ?? '');
    if (path.includes('/api/tripo') && !hostAllowed(req.headers.host, allowed)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, code: 'bad_request', message: 'Host 不在 allowedHosts 里' }));
      return;
    }
    middleware(req, res, next);
  });
  const keyNote = cfg.key && !cfg.key.startsWith('tsk_') ? '（TRIPO_API_KEY 看起来不对：Tripo 的密钥以 tsk_ 开头）' : '';
  config.logger.info(`  [tripo] /api/tripo 已挂上：${cfg.mock ? '模拟模式（没有 TRIPO_API_KEY 或 TRIPO_MOCK=1）' : '真实模式，会花 Tripo 积分'}${keyNote}`);
}

export default function tripoProxy() {
  return {
    name: 'tripo-proxy',
    configResolved(config) {
      // 防呆：任何会进前端包的变量（VITE_ 开头）只要像 Tripo 密钥就直接报错
      for (const k of Object.keys(config.env ?? {})) {
        if (/TRIPO/i.test(k) && /KEY|TOKEN|SECRET/i.test(k)) {
          throw new Error(`[tripo] 不要把 Tripo 密钥放进 ${k}：VITE_ 开头的变量会被打进前端包。请改名为 TRIPO_API_KEY`);
        }
      }
    },
    configureServer(server) {
      mount(server, 'dev');
    },
    configurePreviewServer(server) {
      mount(server, 'preview');
    },
  };
}

// 自查脚本共用：启动 Vite 开发服务器、用本机 Chrome 打开页面、收集页面错误
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

export const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// overrides 合并进 Vite 配置，例如 { publicDir: '.tmp/out' }
export async function startServer(overrides = {}) {
  // 自查脚本默认走 Tripo 模拟模式：.env.local 里有真实密钥也不扣额度。真要连 Tripo 就显式设 TRIPO_MOCK=0
  process.env.TRIPO_MOCK ??= '1';
  // worktree 里的 node_modules 是指向主目录的链接，Vite 默认拒绝读取项目外的文件，字体会 403
  // VITE_CACHE_DIR：给这次的开发服务器用自己的依赖缓存（worktree 里的 node_modules 是链接，默认的 node_modules/.vite 各个 worktree 共用，
  // 这边重新预构建会让别的开发服务器报 Outdated Optimize Dep、整页刷新）。不设时照旧
  const server = await createServer({ cacheDir: process.env.VITE_CACHE_DIR, ...overrides, logLevel: 'warn', server: { host: '127.0.0.1', port: 5199, strictPort: false, fs: { strict: false } } });
  await server.listen();
  const base = (server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/').replace(/\/$/, '');
  return { server, base };
}

// HEADED=1 时开有界面的 Chrome：无头模式下可能拿不到 WebGPU，只会测到 WebGL2 后备
export function launch() {
  return chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
}

export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`JS: ${e.message}`));
  // 页面没写图标时浏览器会自己去要 /favicon.ico；找不到时 Chrome 记一条控制台错误（不一定有 response 事件），不算页面的错
  page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.endsWith('/favicon.ico')) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}

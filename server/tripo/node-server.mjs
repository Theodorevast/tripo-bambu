// 独立的 Node 服务（Node 24，零依赖）：一个进程同时托管 dist/ 静态文件和 /api/tripo/*，可以直接部署。
// 用法：npm run build && npm start（等于 node server/tripo/node-server.mjs）
// 环境变量：主机上设的优先；本地还会读仓库根目录的 .env、.env.local、.env.production、.env.production.local（进程环境变量盖住文件）。
//   PORT（默认 8787）、HOST（默认 0.0.0.0）、STATIC_DIR（默认仓库里的 dist/）、
//   TRUST_PROXY（前面有几层自己的反向代理，默认 0：直连时不看 X-Forwarded-For，它可以伪造）
//   以及 docs/TRIPO.md 里列的 TRIPO_*、ALLOWED_ORIGINS。只想自测就带 TRIPO_MOCK=1。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { createHandler, isTripoPath, readConfig } from './handler.mjs';
import { createFileLoaders, createNodeMiddleware, loadEnvFiles, modeBanner } from './node-adapter.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const env = loadEnvFiles({ dir: ROOT, mode: 'production' });
const PORT = Number(env.PORT) || 8787;
const HOST = String(env.HOST ?? '').trim() || '0.0.0.0';
const STATIC_DIR = resolve(ROOT, String(env.STATIC_DIR ?? '').trim() || 'dist');
const TRUST_PROXY = /^true$/i.test(String(env.TRUST_PROXY ?? '')) ? 1 : Math.max(0, Math.floor(Number(env.TRUST_PROXY) || 0));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg\+xml|model\/gltf\+json)/;

function plain(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(text);
}

// 静态文件：只读 STATIC_DIR 里面的文件，挡掉 ../ 越界和点开头的文件（.env 之类，万一 STATIC_DIR 配错成仓库根目录也不会泄露）
async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method Not Allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return plain(res, 400, 'Bad Request');
  }
  if (pathname.includes('\0')) return plain(res, 400, 'Bad Request');
  const rel = normalize(pathname).replace(/^[/\\]+/, '');
  if (rel.split(/[/\\]/).some((part) => part.startsWith('.') && part !== '.well-known')) return plain(res, 404, 'Not Found');
  let file = resolve(STATIC_DIR, rel);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) return plain(res, 403, 'Forbidden');
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = await stat(file).catch(() => null);
  }
  if (!st?.isFile()) return plain(res, 404, 'Not Found');

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('content-type', type);
  res.setHeader('etag', etag);
  res.setHeader('last-modified', st.mtime.toUTCString());
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  // Vite 构建出来的 assets/ 文件名带内容哈希，可以长期缓存；其余（index.html、模型）每次都问一下有没有变
  res.setHeader('cache-control', /^assets[/\\]/.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const gzip = COMPRESSIBLE.test(type) && st.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  res.setHeader('vary', 'Accept-Encoding');
  if (gzip) res.setHeader('content-encoding', 'gzip');
  else res.setHeader('content-length', String(st.size));
  res.statusCode = 200;
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    if (gzip) await pipeline(createReadStream(file), createGzip(), res);
    else await pipeline(createReadStream(file), res);
  } catch (err) {
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`[static] ${pathname}：${err?.message ?? err}`);
  }
}

const staticOk = await stat(join(STATIC_DIR, 'index.html')).then((s) => s.isFile()).catch(() => false);
const handle = createHandler(createFileLoaders({ dirs: [join(ROOT, 'public'), STATIC_DIR, ROOT] }));
const api = createNodeMiddleware({ handle, getEnv: () => env, trustProxy: () => TRUST_PROXY });

const server = http.createServer((req, res) => {
  const started = Date.now();
  const pathname = String(req.url ?? '/').split('?')[0];
  if (isTripoPath(pathname)) {
    // 每个接口请求一行日志：方法、路径、状态、耗时。不记请求头、请求体和查询串
    res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`));
    api(req, res, () => plain(res, 404, 'Not Found'));
    return;
  }
  if (!staticOk) return plain(res, 404, 'Not Found');
  serveStatic(req, res).catch((err) => {
    console.error(`[static] ${err?.message ?? err}`);
    if (!res.headersSent) plain(res, 500, 'Internal Server Error');
    else res.destroy();
  });
});
server.requestTimeout = 120_000; // 慢网上传 10 MB 也够
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  const cfg = readConfig(env);
  console.log(`[tripo] 监听 http://${HOST}:${PORT}`);
  console.log(staticOk ? `[tripo] 静态文件：${STATIC_DIR}` : `[tripo] 没找到 ${join(STATIC_DIR, 'index.html')}，只提供 /api/tripo（要托管网页先 npm run build）`);
  const banner = modeBanner(env);
  if (banner.level === 'warn') console.warn(process.stdout.isTTY ? `\x1b[33m${banner.text}\x1b[0m` : banner.text);
  else console.log(banner.text);
  console.log(`[tripo] 跨域白名单：${cfg.origins.length ? cfg.origins.join(', ') : '（空，只允许同源）'}；TRUST_PROXY=${TRUST_PROXY}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

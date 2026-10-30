// 加载速度：冷启动（空缓存）到星系可以操作 → 停 DWELL 毫秒后点「Visit your planet」→ 作品全部出场；
// 再在同一个浏览器里开一次（热启动，HTTP 缓存还在）走同样两步。记下每一步的时间、请求瀑布、按类别的请求数和字节。
// 用法：
//   线上：LOAD_BASE=https://community-planets.<你的子域>.workers.dev node scripts/perf-load.mjs
//   本机：先 npm run build，再 node scripts/perf-load.mjs —— 起 vite preview（PORT，默认 4391），按 dist/_headers 加响应头，
//         没写到的用 Cloudflare 的默认值（public, max-age=0, must-revalidate），和线上的 Workers Static Assets 一样
//   THROTTLE=3000/300：Chrome 限速，下行 3000 kbps、往返 300 ms（上行同速）
//   DWELL=3000：星系可以操作以后停多久再点（毫秒）；LABEL=<名字>：结果存到 .tmp/perf-load/<名字>.json；RUNS=<n>：冷 + 热各量几轮
//   WATERFALL=1：打印完整瀑布（默认只打印模型和最慢的几个）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { preview } from 'vite';
import { headersFor, parseHeadersFile } from './lib/headersFile.mjs';
import { launch, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const TEAM = seed.you.teamId;
const DWELL = Number(process.env.DWELL ?? 3000);
const RUNS = Number(process.env.RUNS ?? 1);
const LABEL = process.env.LABEL ?? `load-${Date.now()}`;
const throttle = process.env.THROTTLE ? process.env.THROTTLE.split('/').map(Number) : null;
const DEFAULT_CACHE = 'public, max-age=0, must-revalidate'; // Cloudflare Workers Static Assets 没有 _headers 时的默认值

// vite preview 默认每个文件都回 Cache-Control: no-cache；这里换成 Cloudflare 的默认值，再按 dist/_headers 改（sirv 调 writeHead 时改）
function cloudflareHeaders(dist) {
  return {
    name: 'perf-load-cloudflare-headers',
    configurePreviewServer(server) {
      const file = path.join(dist, '_headers');
      const rules = existsSync(file) ? parseHeadersFile(readFileSync(file, 'utf8')) : [];
      server.middlewares.use((req, res, next) => {
        const { set, unset } = headersFor(rules, new URL(req.url, 'http://x').pathname);
        const writeHead = res.writeHead;
        res.writeHead = function (status, ...rest) {
          const headers = rest.find((r) => r && typeof r === 'object');
          if (headers && !Array.isArray(headers)) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          if (status !== 304 || res.hasHeader('cache-control')) res.setHeader('Cache-Control', DEFAULT_CACHE);
          for (const [, [name, value]] of set) res.setHeader(name, value);
          for (const key of unset) res.removeHeader(key);
          return writeHead.call(this, status, ...rest.filter((r) => typeof r === 'string'));
        };
        next();
      });
    },
  };
}

// 请求的类别（汇总用）
function kind(url) {
  const p = new URL(url).pathname;
  if (/\/models\/lod\//.test(p)) return 'model-lod';
  if (/\/models\//.test(p)) return 'model';
  if (/\/brand\/.*\.glb$/.test(p)) return 'brand-glb';
  if (/\/brand\//.test(p)) return 'brand';
  if (/\/thumbs\//.test(p)) return 'thumb';
  if (/\.js$/.test(p)) return 'js';
  if (/\.css$/.test(p)) return 'css';
  if (/\.woff2?$/.test(p)) return 'font';
  if (/\/$|\.html$/.test(p)) return 'html';
  return 'other';
}

// 用 CDP 记网络：每个请求的开始、收到响应头、结束（秒，按导航开始算）、线上字节、是不是走的缓存、协议
function recordNetwork(cdp) {
  const reqs = new Map();
  let t0 = null;
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.type === 'Document' && t0 === null) t0 = e.timestamp;
    if (!/^https?:/.test(e.request.url)) return;
    reqs.set(e.requestId, { url: e.request.url, start: e.timestamp, priority: e.request.initialPriority, kind: kind(e.request.url) });
  });
  cdp.on('Network.requestServedFromCache', (e) => { const r = reqs.get(e.requestId); if (r) r.cache = 'memory'; });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    r.status = e.response.status;
    r.protocol = e.response.protocol;
    r.ttfb = e.timestamp;
    if (e.response.fromDiskCache) r.cache = 'disk';
    if (e.response.status === 304) r.cache = '304';
    r.cacheControl = e.response.headers['cache-control'] ?? e.response.headers['Cache-Control'];
  });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.failed = e.errorText; } });
  return {
    reset() { reqs.clear(); t0 = null; },
    list: () => [...reqs.values()].map((r) => ({ ...r, start: r.start - t0, ttfb: r.ttfb ? r.ttfb - t0 : null, end: r.end ? r.end - t0 : null })),
  };
}

const fmt = (s) => (s == null ? '   -  ' : `${s.toFixed(2).padStart(6)}`);
const mb = (b) => (b / 1048576).toFixed(2);

function summarize(list, from = -Infinity, to = Infinity) {
  const by = {};
  for (const r of list) {
    if (r.start < from || r.start > to) continue;
    const k = (by[r.kind] ??= { n: 0, bytes: 0, cached: 0, last: 0 });
    k.n++;
    k.bytes += r.bytes ?? 0;
    if (r.cache) k.cached++;
    k.last = Math.max(k.last, r.end ?? 0);
  }
  return by;
}

function printSummary(title, by) {
  const rows = Object.entries(by).sort((a, b) => b[1].bytes - a[1].bytes);
  const total = rows.reduce((n, [, v]) => n + v.bytes, 0);
  console.log(`  ${title}：${rows.reduce((n, [, v]) => n + v.n, 0)} 个请求，线上 ${mb(total)} MB  ` + rows.map(([k, v]) => `${k} ${v.n}${v.cached ? `（缓存 ${v.cached}）` : ''}/${mb(v.bytes)}MB`).join('  '));
}

function printWaterfall(list, from, to) {
  const rows = list.filter((r) => r.start >= from && r.start <= to);
  const show = process.env.WATERFALL === '1' ? rows : rows.filter((r) => /model|brand-glb/.test(r.kind) || (r.end ?? 0) - r.start > 1.5);
  for (const r of show.sort((a, b) => a.start - b.start)) {
    const name = new URL(r.url).pathname.replace(/^.*\/(assets|models|brand|thumbs)\//, '$1/') + new URL(r.url).search;
    console.log(`    ${fmt(r.start)} → ${fmt(r.ttfb)} → ${fmt(r.end)} s  ${String(r.status ?? '-').padEnd(3)} ${(r.cache ?? r.protocol ?? '').padEnd(8)} ${mb(r.bytes ?? 0).padStart(5)} MB  ${r.priority?.padEnd(8) ?? ''} ${name}`);
  }
}

async function visit(context, base, net, label) {
  const page = await context.newPage();
  const errors = watchErrors(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (throttle) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: throttle[1], downloadThroughput: (throttle[0] * 1000) / 8, uploadThroughput: (throttle[0] * 1000) / 8 });
  const rec = recordNetwork(cdp);
  // 作品挂上的时刻：点 Visit 以后每帧数这颗星球上的网格数（每件作品先有展台 + 拾取盒，模型挂上时再多出模型的网格），涨了就记一笔（秒，按导航开始算）
  await page.addInitScript((team) => {
    window.__load = { attached: [], click: null, ready: null };
    let meshes = -1;
    const tick = () => {
      const app = window.__app;
      if (app && window.__load.click !== null && window.__load.ready === null) {
        const n = app.worksMeshes(team);
        const placed = app.placedIds().length;
        if (meshes >= 0 && n > meshes && n > placed * 2) window.__load.attached.push(performance.now() / 1000);
        meshes = n;
        if (document.querySelector('#app')?.dataset.planetReady === team) window.__load.ready = performance.now() / 1000;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, TEAM);
  const t = {};
  await page.goto(`${base}/`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
  Object.assign(t, await page.evaluate(() => {
    const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('boot:')).map((m) => [m.name, m.startTime / 1000]));
    const nav = performance.getEntriesByType('navigation')[0];
    return { html: nav.responseEnd / 1000, domContentLoaded: nav.domContentLoadedEventEnd / 1000, ...marks, ready: performance.now() / 1000, backend: window.__app.backend() };
  }));
  await page.waitForTimeout(DWELL);
  const before = rec.list().length;
  t.click = await page.evaluate(() => (window.__load.click = performance.now() / 1000));
  await page.click('.tb-visit');
  await page.waitForFunction((team) => document.querySelector('#app')?.dataset.planetReady === team, TEAM, { timeout: 600000 });
  await page.waitForFunction(() => window.__load.ready !== null, null, { timeout: 10000 });
  const load = await page.evaluate(() => window.__load);
  t.planetReady = load.ready;
  t.attached = load.attached;
  const list = rec.list();
  const result = { label, t, requests: list, errors: [...errors] };
  console.log(`\n[${label}] 后端 ${t.backend}`);
  console.log(`  HTML ${fmt(t.html)} s，DOMContentLoaded ${fmt(t.domContentLoaded)} s，启动画面：sky ${fmt(t['boot:sky'])} warm ${fmt(t['boot:warm'])} land ${fmt(t['boot:land'])} 散开 ${fmt(t['boot:leave'])}，星系可以操作（__ready）${fmt(t.ready)} s`);
  console.log(`  点 Visit（${fmt(t.click)} s）→ 作品陆续出场 ${t.attached.map((a) => `+${(a - t.click).toFixed(1)}`).join(' ')} s，全部出场（data-planet-ready）+${(t.planetReady - t.click).toFixed(2)} s`);
  printSummary('首页（到点 Visit 为止）', summarize(list.slice(0, before)));
  printSummary('进星球（点 Visit 以后）', summarize(list.slice(before)));
  printWaterfall(list, -Infinity, Infinity);
  await page.close();
  return result;
}

let server = null;
let browser = null;
try {
  let base = process.env.LOAD_BASE?.replace(/\/$/, '');
  if (!base) {
    const dist = path.resolve('dist');
    if (!existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ 里没有构建结果：先 npm run build');
    process.env.TRIPO_MOCK ??= '1';
    server = await preview({ cacheDir: process.env.VITE_CACHE_DIR, logLevel: 'warn', preview: { port: Number(process.env.PORT ?? 4391), strictPort: true, host: '127.0.0.1' }, plugins: [cloudflareHeaders(dist)] });
    base = `http://127.0.0.1:${Number(process.env.PORT ?? 4391)}`;
  }
  console.log(`测 ${base}${throttle ? `，限速 ${throttle[0]} kbps / ${throttle[1]} ms` : '，不限速'}，点 Visit 前停 ${DWELL} ms`);
  browser = await launch();
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    results.push(await visit(context, base, null, `冷启动 #${i + 1}`));
    results.push(await visit(context, base, null, `热启动 #${i + 1}`));
    await context.close();
  }
  mkdirSync('.tmp/perf-load', { recursive: true });
  writeFileSync(`.tmp/perf-load/${LABEL}.json`, JSON.stringify({ base, throttle, dwell: DWELL, results }, null, 1));
  console.log(`\n结果存在 .tmp/perf-load/${LABEL}.json`);
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
}

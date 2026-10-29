// 开场流畅度（构建版、不限速）：比较几份构建结果的开场。
//   A. #boot 从页面上移除以后 3 秒里的最长帧间隔、超过 33 ms 的帧数
//   B. 更宽的一段：启动画面开始散开（data-state="leaving"）到移除后 5 秒（开场的星尘拼标志整段都在里面）
//   C. 之后：移除后 3 秒到 12 秒（右边翠宝探头挥手、云朵翠宝第一次聚都在里面）
// 每份构建开 runs 次，轮流开（A B A B …），每次新开一个浏览器（着色器缓存是冷的），1440 × 900、像素比 1
// node scripts/perf-opening.mjs <dist 目录> [<dist 目录> …] [--runs 5] [--webgl2]
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { CHROME } from './lib/browser.mjs';

const args = process.argv.slice(2);
const runs = Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 5);
const webgl2 = args.includes('--webgl2');
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
if (!dirs.length) {
  console.log('用法：node scripts/perf-opening.mjs <dist 目录> [<dist 目录> …] [--runs 5] [--webgl2]');
  process.exit(1);
}

const servers = [];
for (const dir of dirs) {
  const s = await preview({ configFile: false, logLevel: 'warn', build: { outDir: dir }, preview: { host: '127.0.0.1', port: 5310, strictPort: false } });
  servers.push({ dir, server: s, url: s.resolvedUrls.local[0], runs: [] });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function once(url) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  // 每帧记时间；记下启动画面开始散开、从页面上移除的那一帧
  await page.addInitScript(() => {
    const op = { frames: [], leaving: null, removed: null, seen: false, shape: null };
    window.__opening = op;
    const tick = (t) => {
      op.frames.push(t);
      if (op.shape === null && (window.__world?.galaxy?.shapeState?.progress ?? 0) > 0) op.shape = t; // 星尘开始拼标志的那一帧
      const boot = document.getElementById('boot');
      if (boot) op.seen = true;
      if (boot && boot.dataset.state === 'leaving' && op.leaving === null) op.leaving = t;
      if (!boot && op.seen && op.removed === null) op.removed = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__opening.removed !== null && performance.now() > window.__opening.removed + 12200, null, { timeout: 120000, polling: 200 });
  const r = await page.evaluate(() => {
    const op = window.__opening;
    const gaps = (from, to) => {
      const out = [];
      for (let i = 1; i < op.frames.length; i++) if (op.frames[i] > from && op.frames[i] <= to) out.push(op.frames[i] - op.frames[i - 1]);
      return out;
    };
    const from = op.leaving ?? op.removed;
    const a = gaps(op.removed, op.removed + 3000);
    const b = gaps(from, op.removed + 5000);
    const c = gaps(op.removed + 3000, op.removed + 12000);
    // B 段里最长那一帧在启动画面开始散开以后多少毫秒（看它落在启动画面交接、开场飞行还是星尘拼标志上）
    let atB = 0;
    for (let i = 1, best = 0; i < op.frames.length; i++) {
      const g = op.frames[i] - op.frames[i - 1];
      if (op.frames[i] > from && op.frames[i] <= op.removed + 5000 && g > best) {
        best = g;
        atB = op.frames[i] - from;
      }
    }
    return { maxA: Math.max(...a), slowA: a.filter((g) => g > 33.4).length, maxB: Math.max(...b), slowB: b.filter((g) => g > 33.4).length, atB, removedAt: op.removed - from, shapeAt: op.shape === null ? null : op.shape - from, maxC: Math.max(...c), slowC: c.filter((g) => g > 33.4).length };
  });
  await browser.close();
  return { ...r, errors: errors.length };
}

for (let i = 0; i < runs; i++) {
  for (const s of servers) {
    const r = await once(s.url);
    s.runs.push(r);
    console.log(`${s.dir} #${i + 1}：移除后 3 秒最长 ${r.maxA.toFixed(1)} ms（>33 ms ${r.slowA} 帧）；散开到移除后 5 秒最长 ${r.maxB.toFixed(1)} ms（>33 ms ${r.slowB} 帧，最长那帧在散开后 ${Math.round(r.atB)} ms；移除在散开后 ${Math.round(r.removedAt)} ms${r.shapeAt === null ? "" : `；星尘开始拼在散开后 ${Math.round(r.shapeAt)} ms`}）；移除后 3 到 12 秒最长 ${r.maxC.toFixed(1)} ms（>33 ms ${r.slowC} 帧）${r.errors ? `，页面错误 ${r.errors}` : ''}`);
  }
}
console.log(`\n${webgl2 ? 'WebGL2' : 'WebGPU'}，1440×900 DPR 1，每份 ${runs} 次（冷启动）中位数：`);
for (const s of servers) {
  const m = (k) => median(s.runs.map((r) => r[k]));
  console.log(`  ${s.dir}：移除后 3 秒最长 ${m('maxA').toFixed(1)} ms（各次 ${s.runs.map((r) => r.maxA.toFixed(1)).join(' / ')}）；散开到移除后 5 秒最长 ${m('maxB').toFixed(1)} ms（各次 ${s.runs.map((r) => r.maxB.toFixed(1)).join(' / ')}）；移除后 3 到 12 秒最长 ${m('maxC').toFixed(1)} ms（各次 ${s.runs.map((r) => r.maxC.toFixed(1)).join(' / ')}）`);
}
for (const s of servers) await new Promise((res) => s.server.httpServer.close(res));

// 造星窗口（P3）的开销：1440×900、DPR 2。量三段，每段 N 帧：
//   1. 首页，窗口关着（基准）
//   2. 窗口开着、预览在转（主画面照常跑）：主画面每帧的 GPU 时间、帧间隔；预览每帧的 GPU 时间（它自己的渲染器）、主线程时间
//   3. 打开窗口的那一下（从点按钮到预览画好）：最长帧间隔
// GPU 时间用时间戳查询（地址带 ?gputime：主画面的 World 和预览的渲染器都打开 trackTimestamp）。
// 用法：node scripts/perf-create.mjs [--webgl2] [--frames 240]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const frames = Number(opt('--frames', 240));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.addInitScript(() => {
  window.__gaps = null;
  let last = 0;
  const tick = (t) => {
    if (window.__gaps && last) window.__gaps.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// 主画面 n 帧：每帧画完读一次时间戳（回来的是上次回读以后所有渲染的 GPU 时间）、帧间隔
const measureMain = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  const dts = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const before = (dt) => { if (seen > 5) dts.push(dt * 1000); };
    const after = () => {
      seen++;
      if (seen > 5) {
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((ms) => { pending--; if (typeof ms === 'number' && ms > 0) gpu.push(ms); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.frameHooks.delete(before);
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.frameHooks.add(before);
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  return { gpu, dts, calls: w.renderer.info.render.drawCalls };
}, n);

try {
  await page.goto(`${base}/?gputime&nolocal`);
  await page.waitForFunction(() => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const backend = await page.evaluate(() => window.__app.backend());
  const closed = await measureMain(frames);

  await page.evaluate(() => { window.__gaps = []; });
  await page.locator('.topbar .tb-create').click();
  await page.waitForFunction(() => window.__create?.state().open && window.__create.state().previewReady, null, { timeout: 60000 });
  // 预览的第一颗编好以后，别的预设也在后台一颗颗备好：等它们都编完再量（量的是稳定开着的时候）
  await page.waitForTimeout(6000);
  const openGaps = await page.evaluate(() => { const g = window.__gaps; window.__gaps = null; return g; });
  const p0 = await page.evaluate(() => window.__create.preview());
  const open = await measureMain(frames);
  const p1 = await page.evaluate(() => window.__create.preview());
  const pvFrames = p1.frames - p0.frames;
  const pvCpu = pvFrames > 0 ? (p1.cpuMs - p0.cpuMs) / pvFrames : NaN;
  const pvGpu = p1.gpu.slice(-Math.max(1, pvFrames));
  const canvas = await page.evaluate(() => { const c = document.querySelector('.cp-canvas'); return `${c.width}×${c.height}`; });

  console.log(`backend ${backend} · 1440×900 DPR 2 · 每段 ${frames} 帧`);
  console.log(`首页（窗口关着）：主画面 GPU p50 ${f1(pct(closed.gpu, 0.5))} / p95 ${f1(pct(closed.gpu, 0.95))} ms；帧间隔 p50 ${f1(pct(closed.dts, 0.5))} / p95 ${f1(pct(closed.dts, 0.95))} / 最长 ${f1(Math.max(...closed.dts))} ms`);
  console.log(`窗口开着：主画面 GPU p50 ${f1(pct(open.gpu, 0.5))} / p95 ${f1(pct(open.gpu, 0.95))} ms；帧间隔 p50 ${f1(pct(open.dts, 0.5))} / p95 ${f1(pct(open.dts, 0.95))} / 最长 ${f1(Math.max(...open.dts))} ms`);
  console.log(`预览（画布 ${canvas}）：GPU p50 ${f1(pct(pvGpu, 0.5))} / p95 ${f1(pct(pvGpu, 0.95))} ms（${pvGpu.length} 个样本）；主线程每帧 ${f1(pvCpu)} ms，最长 ${f1(p1.cpuMax)} ms；建了 ${p1.builds} 颗，编译 ${p1.compileMs.join(' / ')} ms`);
  console.log(`打开窗口（点按钮 → 预览画好 → 后台备好别的预设，约 6 秒）：帧间隔 p95 ${f1(pct(openGaps, 0.95))} / 最长 ${f1(Math.max(...openGaps))} ms，超过 25 ms 的 ${openGaps.filter((g) => g > 25).length} 帧`);
  console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
} finally {
  await browser.close();
  await server.close();
}

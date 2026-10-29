// 第一版 / 第二版对比页的性能数字（v2-compare）：1440×900、像素比 2（画布 2880×1800），WebGPU。
// node scripts/compare-perf.mjs <base> <名字 v1|v2> <输出 json> [--webgl2]（已有的 json 里按名字合进去）
//   --webgl2：藏起 navigator.gpu 走 WebGL2，只量首页每帧的 GPU 时间，记成 homeGpuWebgl2（要开有界面的 Chrome：HEADED=1，无头模式下拿不到计时查询）
// 量完重新生成对比页：node scripts/compare-page.mjs <截图目录> compare compare/perf.json（截图目录里没有图时照用 compare/img 里已经转好的）
//   首页静止 4 秒的帧间隔（中位、p95、最长）、首页每帧 GPU 时间（?gputime 的时间戳查询，取 p50）、
//   进星球（穿云）、跳星球、回星系三段转场的最长帧间隔（requestAnimationFrame 逐帧记）
// 同一台机器上别的进程也在用 GPU / CPU 时，帧间隔会有偶发的长帧：页面上和数字一起写明是什么时候、在什么负载下量的
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME, watchErrors } from './lib/browser.mjs';

const webgl2 = process.argv.includes('--webgl2');
const [base, name, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!base || !name || !out) {
  console.log('用法：node scripts/compare-perf.mjs <base> <名字> <输出 json>');
  process.exit(1);
}
const you = 'lumen-guild';
const other = 'quiet-vertex';
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.addInitScript(() => {
  window.__rec = null;
  const tick = (t) => {
    const r = window.__rec;
    if (r) {
      r.frames.push(t - r.last);
      r.last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const startRec = () => page.evaluate(() => { window.__rec = { frames: [], last: performance.now() }; });
const stopRec = () => page.evaluate(() => { const r = window.__rec; window.__rec = null; return r.frames.slice(1); });
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const r1 = (x) => Math.round(x * 10) / 10;
const gpu = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const ms = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((v) => { pending--; if (typeof v === 'number' && v > 0) ms.push(v); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const sorted = [...ms].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}, n);
const transition = async (label, trigger, done) => {
  await startRec();
  await trigger();
  await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 8000 }).catch(() => {});
  await done();
  await page.waitForTimeout(400);
  const f = await stopRec();
  return { label, max: r1(Math.max(...f)), p95: r1(pct(f, 0.95)), over33: f.filter((x) => x > 33.4).length, frames: f.length };
};

const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const result = webgl2 ? { ...(prev[name] ?? {}), homeGpuWebgl2Runs: [] } : { base, at: new Date().toISOString(), backend: '', homeIdle: null, homeGpu: [], transitions: [] };
try {
  await page.goto(`${base}/?gputime&nolocal`);
  await page.waitForFunction(() => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, { timeout: 120000 });
  await page.waitForTimeout(9000); // 开场：星尘拼标志、翠宝打招呼都放完
  await page.mouse.move(720, 40);
  if (webgl2) {
    for (let k = 0; k < 3; k++) result.homeGpuWebgl2Runs.push(await gpu(180));
    const xs = result.homeGpuWebgl2Runs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
    result.homeGpuWebgl2 = xs.length ? Math.round(xs[Math.floor(xs.length / 2)] * 1000) / 1000 : null;
    throw new Error('done');
  }
  result.backend = await page.evaluate(() => window.__app.backend());
  await startRec();
  await page.waitForTimeout(4000);
  const idle = await stopRec();
  result.homeIdle = { p50: r1(pct(idle, 0.5)), p95: r1(pct(idle, 0.95)), max: r1(Math.max(...idle)), over33: idle.filter((x) => x > 33.4).length };
  for (let k = 0; k < 3; k++) result.homeGpu.push(await gpu(180));
  const planetReady = (id) => page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t && window.__app.routeIdle(), id, { timeout: 120000 });
  result.transitions.push(await transition('enter', () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, you), () => planetReady(you)));
  await page.waitForTimeout(1500);
  result.transitions.push(await transition('hop', () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, other), () => planetReady(other)));
  await page.waitForTimeout(1500);
  result.transitions.push(await transition('leave', () => page.evaluate(() => { location.hash = '#/'; }), () => page.waitForFunction(() => (location.hash === '#/' || location.hash === '') && window.__app.routeIdle() && !window.__trans.state().transition, null, { timeout: 60000 })));
} catch (err) {
  if (String(err?.message) !== 'done') throw err;
} finally {
  if (errors.length) result.errors = errors.slice(0, 5);
  const all = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  all[name] = result;
  writeFileSync(out, JSON.stringify(all, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

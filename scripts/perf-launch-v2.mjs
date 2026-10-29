// 造星 Launch（星球从云里冲出来）的帧间隔：连做 N 次（每次重新开页），每次记下每一帧的间隔和当时的阶段，
// 打出每次的最长帧、在哪个阶段、超过 33 ms 的帧数。给 v2-ui 改冲出特效（createPlanetBurst.ts）前后对照用。
// node scripts/perf-launch-v2.mjs [--runs 3] [--settle 15]。WEBGL2=1 走 WebGL2。1440×900、DPR 2（同 check-create）。
// --settle：开页、启动画面撤掉以后先等几秒再开始造星（默认 15）：首页开场的那几件头一回的事（星尘拼标志、云朵翠宝第一次聚、
// 右边翠宝探头，都在启动画面撤掉后 3–12 秒）不和 Launch 挤在一起；设 0 就和第一版的量法一样（开页马上造）。
// 每个长帧后面标上那一帧主线程有没有被 long task 占着
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1] || 3);
const SETTLE = args.includes('--settle') ? Number(args[args.indexOf('--settle') + 1]) : 15;
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-perf' });
const browser = await launch();
const out = [];
for (let run = 0; run < RUNS; run++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = watchErrors(p);
  if (process.env.WEBGL2 === '1') await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await p.addInitScript(() => {
    window.__lt = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  });
  await p.goto(`${base}/?nolocal`);
  await p.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  if (SETTLE > 0) await p.waitForTimeout(SETTLE * 1000);
  await p.evaluate(() => { location.hash = '#/create'; });
  await p.waitForFunction(() => window.__create?.state().open && window.__create.state().previewReady, null, { timeout: 90000 });
  await p.locator('#cp-name').fill(`Perf Run ${run + 1}`);
  for (const s of ['look', 'crew', 'launch']) {
    await p.locator('.cp-next').click();
    await p.waitForFunction((x) => window.__create.state().step === x, s);
  }
  await p.waitForFunction(() => window.__create.state().twinReady, null, { timeout: 30000 });
  await p.waitForTimeout(1500); // 真人在第四步也会停一下
  await p.evaluate(() => {
    window.__lg = [];
    let last = -1;
    const tick = (t) => {
      const s = window.__create.state().launch.phase;
      if (last >= 0) window.__lg.push([t - last, s, last]);
      last = t;
      if (!(s === 'home' && !window.__world.rig.flying)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await p.locator('.cp-next').click();
  await p.waitForFunction(() => window.__create.state().launch.phase === 'home' && !window.__world.rig.flying && !window.__world.rig.drive && window.__app.routeIdle(), null, { timeout: 60000 });
  const { lg, lt, twin } = await p.evaluate(() => ({ lg: window.__lg, lt: window.__lt, twin: window.__create.state().usedTwin }));
  const worst = lg.reduce((a, b) => (b[0] > a[0] ? b : a), [0, '']);
  const over = lg.filter(([g]) => g > 33.5);
  const busy = ([g, , at]) => (lt.some(([s, d]) => s < at + g && s + d > at) ? '·主线程忙' : '');
  out.push(`第 ${run + 1} 次（${twin ? '用了替身' : '新建'}）：${lg.length} 帧，最长 ${worst[0].toFixed(1)} ms（${worst[1]}），超过 33 ms 的 ${over.length} 帧${over.length ? `：${over.map((f) => `${f[0].toFixed(0)}@${f[1]}${busy(f)}`).join(' ')}` : ''}${errors.length ? `；页面错误 ${errors.length}` : ''}`);
  await ctx.close();
}
console.log(`${process.env.WEBGL2 === '1' ? 'WebGL2' : 'WebGPU'} · 1440×900 @2x · 开页后先等 ${SETTLE} 秒`);
console.log(out.join('\n'));
await browser.close();
await server.close();

// 第二版 [v2-world] 自查：转场里每一帧主线程上 World.frame 花了多久（CPU，不含 GPU 和等垂直同步），找最长的几帧。
// 比帧间隔稳（同机别的程序抢 GPU 时帧间隔会跳，CPU 时间不太受影响）。node scripts/perf-frame-cpu.mjs [--webgl2] [--runs 2]
// 流程：开页 → 等首页稳定 → 星系 → lumen-guild → quiet-vertex（跳星球）→ 星系；每一段记 World.frame 的耗时
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const runs = Number(args[args.indexOf('--runs') + 1] || 1);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
try {
  for (let run = 0; run < runs; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = watchErrors(page);
    if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    await page.goto(`${base}/?nolocal#/`);
    await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const w = window.__world;
      const orig = w.frame.bind(w);
      window.__cpu = [];
      w.frame = (t) => {
        const t0 = performance.now();
        orig(t);
        const ms = performance.now() - t0;
        if (window.__cpu) window.__cpu.push([ms, window.__seg ?? '']);
      };
      // setAnimationLoop 拿的是旧的函数：换成新的
      w.renderer.setAnimationLoop((t) => w.frame(t));
    });
    const seg = async (name, hash, ready) => {
      await page.evaluate((n) => { window.__seg = n; }, name);
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForFunction(ready, null, { timeout: 120000 });
      await page.waitForTimeout(1500);
    };
    await seg('enter', '#/t/lumen-guild', () => document.querySelector('#app')?.dataset.planetReady === 'lumen-guild' && window.__app.routeIdle());
    await seg('hop', '#/t/quiet-vertex', () => document.querySelector('#app')?.dataset.planetReady === 'quiet-vertex' && window.__app.routeIdle());
    await seg('leave', '#/', () => location.hash === '#/' && window.__app.routeIdle());
    await page.evaluate(() => { window.__seg = 'home'; });
    await page.waitForTimeout(3000);
    const cpu = await page.evaluate(() => window.__cpu);
    const by = {};
    for (const [ms, s] of cpu) (by[s] ??= []).push(ms);
    const backend = await page.evaluate(() => window.__app.backend());
    for (const [s, xs] of Object.entries(by)) {
      const sorted = [...xs].sort((a, b) => b - a);
      const med = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      console.log(`[${backend} #${run + 1}] ${s.padEnd(5)} 帧数 ${xs.length}，中位 ${med.toFixed(2)} ms，最长 ${sorted.slice(0, 4).map((v) => v.toFixed(1)).join(' / ')} ms`);
    }
    if (errors.length) console.log(`页面错误：${errors.join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

// 第二版 [v2-world]：首页星座线 HomeConstellation.update 的耗时（main 06:28：重新排位时跑过一次 60 ms）。
// 开页、等首页稳定，在页面里直接调 update：① 平时（没有变化）② 只挪位置（换版式时星球慢慢挪过去）③ 重新连（档位变了），各 200 次，
// 报中位和最长；顺带看这几百次调用前后 JS 堆涨了多少（热路径不该分配）。node scripts/perf-constellation.mjs
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = watchErrors(page);
  await page.goto(`${base}/?nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const w = window.__world;
    const c = window.__v2world.constellation;
    const run = (n, before) => {
      const ms = [];
      for (let i = 0; i < n; i++) {
        before(i);
        const t0 = performance.now();
        c.update(0.25, w, true);
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      return { p50: +ms[Math.floor(n / 2)].toFixed(3), max: +ms[n - 1].toFixed(3) };
    };
    const entries = [...w.planets.values()];
    const e = entries[1];
    const home0 = e.home.clone();
    if (window.gc) window.gc();
    const heap0 = performance.memory?.usedJSHeapSize ?? 0;
    const idle = run(200, () => {});
    const move = run(200, (i) => { e.home.set(home0.x + (i % 2 ? 2 : -2), home0.y, home0.z); });
    e.home.copy(home0);
    const relink = run(200, () => c.refresh());
    const heap1 = performance.memory?.usedJSHeapSize ?? 0;
    return { idle, move, relink, heapKb: Math.round((heap1 - heap0) / 1024), links: c.state.links };
  });
  console.log(`星座线 ${r.links} 条；HomeConstellation.update：平时 中位 ${r.idle.p50} / 最长 ${r.idle.max} ms，只挪位置 ${r.move.p50} / ${r.move.max} ms，重新连 ${r.relink.p50} / ${r.relink.max} ms；600 次调用前后 JS 堆 ${r.heapKb >= 0 ? '+' : ''}${r.heapKb} KB`);
  if (errors.length) console.log(`页面错误：${errors.join(' | ')}`);
} finally {
  await browser.close();
  await server.close();
}

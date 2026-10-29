// 第二版 [v2-world] 自查：点 Walk 进漫游的那几帧主线程在做什么（check-walk 量到第二版进漫游时最长一帧 66 ms）。
// 和 check-walk 一样：1440×900、像素比 1、直接开你的星球；等角色准备好、镜头停稳 2.5 秒以后点 Walk。
// CPU 采样：按「一次 World.frame 调用」切段，列出最长的几段和段里最花时间的函数；另外把每一帧 World.frame 的耗时和帧间隔对上。
// node scripts/probe-walk-entry.mjs [--webgl2] [--runs 1]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const runs = Number(args[args.indexOf('--runs') + 1] || 1);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
try {
  for (let run = 0; run < runs; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = watchErrors(page);
    if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    await page.goto(`${base}/?nolocal#/t/lumen-guild`);
    await page.waitForFunction(() => window.__ready === true && document.querySelector('#app')?.dataset.planetReady === 'lumen-guild' && window.__app.routeIdle(), null, { timeout: 90000 });
    await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    // 每一帧：帧间隔（rAF）和 World.frame 的耗时
    await page.evaluate(() => {
      const w = window.__world;
      const orig = w.frame.bind(w);
      window.__fr = [];
      w.frame = (t) => {
        const t0 = performance.now();
        orig(t);
        window.__fr.push([t0, performance.now() - t0]);
      };
      w.renderer.setAnimationLoop((t) => w.frame(t));
      window.__raf = [];
      let last = performance.now();
      const tick = (t) => { window.__raf.push([t, t - last]); last = t; if (window.__raf.length < 400) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    const clickAt = await page.evaluate(() => performance.now());
    await page.locator('.topbar button.walk').click();
    await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
    await page.waitForTimeout(900);
    const { profile } = await cdp.send('Profiler.stop');
    const { fr, raf } = await page.evaluate(() => ({ fr: window.__fr, raf: window.__raf }));
    // 帧间隔最长的几帧（点下去以后）
    const after = raf.filter(([t]) => t >= clickAt - 20);
    const top = [...after].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const backend = await page.evaluate(() => window.__app.backend());
    console.log(`[${backend} #${run + 1}] 点下去以后最长的帧间隔：${top.map(([t, d]) => `${d.toFixed(1)} ms（点下去后 ${(t - clickAt).toFixed(0)} ms）`).join('；')}`);
    const frTop = [...fr.filter(([t]) => t >= clickAt - 20)].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(`  World.frame 最长：${frTop.map(([t, d]) => `${d.toFixed(1)} ms（点下去后 ${(t - clickAt).toFixed(0)} ms）`).join('；')}`);
    // CPU 采样按调用栈里有没有 World.frame 切段：最长的一段里谁最花时间（自身时间、总时间）
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const key = (n) => `${n.callFrame.functionName || '(anon)'} @ ${(n.callFrame.url || '').split('/').pop().split('?')[0]}:${n.callFrame.lineNumber}`;
    const inFrame = (id) => {
      let cur = id;
      while (cur !== undefined) {
        const f = byId.get(cur).callFrame;
        if (f.functionName === 'frame' && /world\.ts/.test(f.url)) return true;
        cur = parent.get(cur);
      }
      return false;
    };
    const segs = [];
    let cur = null;
    profile.samples.forEach((id, i) => {
      const us = profile.timeDeltas[i] ?? 0;
      const n = byId.get(id);
      const fn = n.callFrame.functionName;
      if (inFrame(id)) {
        if (!cur) {
          cur = { total: 0, ids: [] };
          segs.push(cur);
        }
        cur.total += us;
        cur.ids.push([id, us]);
      } else if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)') {
        // 空闲 / 原生 / GC：记进当前段（GPU 进程那边的等待也会显示成 program），段不断开，直到下一次进 idle 超过 4 毫秒
        if (cur && fn !== '(idle)') {
          cur.total += us;
          cur.ids.push([id, us]);
        } else if (fn === '(idle)') cur = null;
      } else {
        cur = null;
      }
    });
    segs.sort((a, b) => b.total - a.total);
    for (const s of segs.slice(0, 2)) {
      const self = new Map();
      const total = new Map();
      for (const [id, us] of s.ids) {
        const n = byId.get(id);
        self.set(key(n), (self.get(key(n)) ?? 0) + us);
        const seen = new Set();
        let c = id;
        while (c !== undefined) {
          const k = key(byId.get(c));
          if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + us); }
          c = parent.get(c);
        }
      }
      const fmt = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => `    ${(us / 1000).toFixed(1).padStart(6)} ms  ${k}`).join('\n');
      console.log(`  —— 一段 ${(s.total / 1000).toFixed(1)} ms ——\n  自身时间：\n${fmt(self, 10)}\n  总时间：\n${fmt(total, 22)}`);
    }
    if (errors.length) console.log(`页面错误：${errors.join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

// 第二版 [v2-world]：新建一颗星球时，它的地表材质（groundMaterial）在主线程上生成着色器要花多少 CPU。
// 造星的 Launch 会新建一颗 PlanetObject；compileAsync 里建节点、出 WGSL / GLSL 都在主线程上（只是挪到了微任务里），这段就是卡住的那一下。
// 做法：开页、等开场预热完、停掉主循环（不画别的），按每个预设新建一颗星球（和 Launch 一样的 PlanetObject），只把地表网格拿去 compileAsync；
// 用 CPU 采样记下从调用到完成之间主线程忙了多久（不含空闲），以及其中 NodeBuilder 建节点占多少。每个预设量 2 次。
// node scripts/perf-ground-build.mjs [--webgl2]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const webgl2 = process.argv.includes('--webgl2');
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/?nolocal#/`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    window.__PlanetObject = (await import('/src/planet/planetObject.ts')).PlanetObject;
    window.__world.renderer.setAnimationLoop(null); // 停掉主循环：采样里只有编译
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const backend = await page.evaluate(() => window.__app.backend());
  for (const preset of ['verdant', 'desert', 'glacier', 'volcanic', 'coral']) {
    const runs = [];
    for (let k = 0; k < 2; k++) {
      await page.evaluate(([pr, seed]) => {
        const w = window.__world;
        const planet = new window.__PlanetObject({ seed, preset: pr, ring: false, atmosphere: true, placements: [] }, '#9fb4c8', false);
        planet.group.position.set(0, -5000, 0);
        w.scene.add(planet.group);
        planet.group.updateMatrixWorld(true);
        window.__probe = planet;
      }, [preset, 900 + k * 17]);
      await cdp.send('Profiler.start');
      await page.evaluate(async () => {
        const w = window.__world;
        await w.renderer.compileAsync(window.__probe.terrain, w.rig.camera, w.scene);
      });
      const { profile } = await cdp.send('Profiler.stop');
      await page.evaluate(() => { window.__world.scene.remove(window.__probe.group); });
      // 主线程忙了多久：所有非空闲采样；建节点：调用栈里有 NodeBuilder 的 build / 各节点的 setup、generate 的那部分
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const parent = new Map();
      for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
      let busy = 0;
      let build = 0;
      profile.samples.forEach((id, i) => {
        const us = profile.timeDeltas[i] ?? 0;
        const n = byId.get(id);
        const fn = n.callFrame.functionName;
        if (fn === '(idle)' || fn === '(garbage collector)' && false) return;
        if (fn === '(idle)') return;
        busy += us;
        let cur = id;
        while (cur !== undefined) {
          const f = byId.get(cur).callFrame;
          if (/three_webgpu/.test(f.url) && (f.functionName === 'build' || f.functionName === 'getForRender')) {
            build += us;
            break;
          }
          cur = parent.get(cur);
        }
      });
      runs.push([busy / 1000, build / 1000]);
      if (process.env.DUMP && k === 0 && preset === 'verdant') {
        const total = new Map();
        profile.samples.forEach((id, i) => {
          const us = profile.timeDeltas[i] ?? 0;
          const seen = new Set();
          let cur = id;
          while (cur !== undefined) {
            const f = byId.get(cur).callFrame;
            const key = (f.functionName || '(anon)') + ' @ ' + (f.url || '').split('/').pop().split('?')[0] + ':' + f.lineNumber;
            if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) ?? 0) + us); }
            cur = parent.get(cur);
          }
        });
        console.log([...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([kk, v]) => (v / 1000).toFixed(1).padStart(7) + ' ms ' + kk).join(String.fromCharCode(10)));
      }
    }
    console.log(`[${backend}] ${preset.padEnd(8)} 主线程忙 ${runs.map((r) => r[0].toFixed(1)).join(' / ')} ms，其中建节点 ${runs.map((r) => r[1].toFixed(1)).join(' / ')} ms`);
  }
  if (errors.length) console.log(`页面错误：${errors.join(' | ')}`);
} finally {
  await browser.close();
  await server.close();
}

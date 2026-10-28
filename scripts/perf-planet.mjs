// planet 角色的 GPU 开销（A/B）：1440×900、像素比 2，GPU 时间戳（同 perf-gpu.mjs）。
// 星系全景：全开 vs 藏起所有星球的远看部件（云层、大气晕、石头带、小浮岛、云海上的影子）；
// 星球视图：全开 vs 藏起聚焦星球的地表（整个地表着色器的开销，含原来就有的部分）。
// 用法：node scripts/perf-planet.mjs [--webgl2] [--frames 180]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const frames = Number(opt('--frames', 180));
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

// n 帧的 GPU 时间（每帧画完发一次时间戳回读），取中位数和 p95
const measure = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((ms) => { pending--; if (typeof ms === 'number' && ms > 0) gpu.push(ms); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), calls: w.renderer.info.render.drawCalls };
}, n);
const fmt = (r) => `p50 ${r.p50.toFixed(2)} ms / p95 ${r.p95.toFixed(2)} ms`;
const setLook = (on) => page.evaluate((v) => { for (const e of window.__world.planets.values()) e.planet.look.group.visible = v; window.__lookOverride = !v; }, on);

try {
  await page.goto(`${base}/?gputime&nolocal#/`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForFunction(() => window.__app.routeIdle(), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__world.rig.controls.autoRotate = false; });
  console.log(`backend ${await page.evaluate(() => window.__app.backend())}，像素比 2`);
  const g1 = await measure(frames);
  // 远看部件每帧由 updatePlanetLook 打开：藏起来要在每帧更新之后再关（frameHooks 在它之前跑，所以用 renderHooks 前的 frame 钩子不行，
  // 这里直接挪到场景外再量）
  await page.evaluate(() => { window.__parked = []; for (const e of window.__world.planets.values()) { const g = e.planet.look.group; window.__parked.push([g, g.parent]); g.removeFromParent(); } });
  const g0 = await measure(frames);
  await page.evaluate(() => { for (const [g, p] of window.__parked) p.add(g); });
  console.log(`星系全景：全开 ${fmt(g1)}（${g1.calls} 次绘制）；去掉远看部件 ${fmt(g0)}（${g0.calls} 次绘制）→ 远看部件约 ${(g1.p50 - g0.p50).toFixed(2)} ms`);
  void setLook;
  const team = 'lumen-guild';
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, team);
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const p1 = await measure(frames);
  await page.evaluate((t) => { window.__world.planets.get(t).planet.terrain.visible = false; }, team);
  const p0 = await measure(frames);
  await page.evaluate((t) => { window.__world.planets.get(t).planet.terrain.visible = true; }, team);
  console.log(`星球视图：全开 ${fmt(p1)}；藏起地表 ${fmt(p0)} → 地表着色器约 ${(p1.p50 - p0.p50).toFixed(2)} ms（含原来就有的部分）`);
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

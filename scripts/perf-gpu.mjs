// GPU 性能自查（V5）：1440×900、像素比 2（画布 2880×1800），量三个场景每帧的 GPU 时间、绘制调用数、三角形数：
//   星球视图（静止）、漫游（按住 W 走）、星系全景。
// GPU 时间用渲染器的时间戳查询（地址带 ?gputime 时 World 打开 trackTimestamp）：WebGPU 走 timestamp-query，
// WebGL2 走 EXT_disjoint_timer_query_webgl2；每帧把这一帧所有渲染（含阴影贴图）的 GPU 时间加起来。
// 用法：node scripts/perf-gpu.mjs [--webgl2] [--local] [--dpr 2] [--frames 240]
//   --local：用本机的私有模型（.tmp/local-models，30 万面的真实作品）；不加就是种子里的占位作品
// 星球半径、草量等用页面默认值；要测别的档位，在页面里改（?tune）或改这里的 setup
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const local = args.includes('--local');
const dpr = Number(opt('--dpr', 2));
const frames = Number(opt('--frames', 240));

const { server, base } = await startServer();
// 开发者特性：WebGPU 时间戳不做 100 µs 的量化，量得准
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

// 量 n 帧：每帧（主循环的钩子里，渲染之前）读上一帧的绘制统计，并发起一次时间戳回读（回来的是上次回读以后所有渲染的 GPU 时间）
const measure = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  const calls = [];
  const tris = [];
  const dts = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const before = (dt) => { if (seen > 5) dts.push(dt * 1000); };
    // 画完这一帧以后：读这一帧的绘制统计（renderer.info 在下一帧开始时清零）
    const after = () => {
      seen++;
      if (seen > 5) {
        const info = w.renderer.info.render;
        calls.push(info.drawCalls);
        tris.push(info.triangles);
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
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  return {
    gpuP50: pct(gpu, 0.5), gpuP95: pct(gpu, 0.95), gpuSamples: gpu.length,
    frameP50: pct(dts, 0.5), frameP95: pct(dts, 0.95), frameMax: Math.max(...dts),
    calls: pct(calls, 0.5), triangles: pct(tris, 0.5),
    canvas: `${w.renderer.domElement.width}×${w.renderer.domElement.height}`,
  };
}, n);

const fmt = (r) => `GPU p50 ${r.gpuP50.toFixed(2)} ms / p95 ${r.gpuP95.toFixed(2)} ms（${r.gpuSamples} 个样本）；帧间隔 p50 ${r.frameP50.toFixed(1)} / p95 ${r.frameP95.toFixed(1)} / 最大 ${r.frameMax.toFixed(1)} ms；绘制调用 ${r.calls}，三角形 ${r.triangles.toLocaleString('en-US')}；画布 ${r.canvas}`;

try {
  const seed = (await import('../src/data/seed.json', { with: { type: 'json' } })).default;
  const team = seed.you.teamId;
  await page.goto(`${base}/?gputime${local ? '' : '&nolocal'}#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  const backend = await page.evaluate(() => window.__app.backend());
  const grass = await page.evaluate(() => {
    const g = window.__world.dressing;
    let blades = 0;
    g.grass?.object.traverse((o) => { if (o.isInstancedMesh) blades += o.count; });
    return { instances: blades, rocks: g.rocks };
  });
  await page.waitForTimeout(2500);
  console.log(`backend ${backend}，像素比 ${dpr}，${local ? '本机真实模型' : '占位作品'}；草（实例）${grass.instances}，石头 ${grass.rocks.instances} 块 / ${grass.rocks.drawCalls} 次绘制 / ${grass.rocks.triangles.toLocaleString('en-US')} 三角形`);
  console.log(`星球视图：${fmt(await measure(frames))}`);
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  console.log(`漫游（按住 W）：${fmt(await measure(frames))}`);
  await page.keyboard.up('w');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__walk.state().phase === 'off', null, { timeout: 8000 });
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForFunction(() => window.__app.routeIdle() && location.hash === '#/', null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  console.log(`星系全景：${fmt(await measure(frames))}`);
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

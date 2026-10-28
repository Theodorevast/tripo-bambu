// stage 角色的性能对比：同一个画面里花园开 / 关、地标放大开 / 关，各量 N 帧的 GPU 时间（时间戳查询，含阴影那一遍）。
// 1440×900、像素比 2（画布 2880×1800）。场景：星球视图（静止）、漫游（站在作品旁边看着花园）。
// 用法：node scripts/perf-stage.mjs [--webgl2] [--local] [--frames 240]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const local = args.includes('--local');
const frames = Number(opt('--frames', 240));

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

// 量 n 帧（同 perf-gpu.mjs）
const measure = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  const calls = [];
  const tris = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
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
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), calls: pct(calls, 0.5), tris: pct(tris, 0.5) };
}, n);

const set = (patch) => page.evaluate(async (p) => {
  const m = await import('/src/scenes/planetView.ts');
  Object.assign(m.STAGE, p);
  m.PlanetView.active?.applyStage();
}, patch);
const fmt = (r) => `GPU p50 ${r.p50.toFixed(3)} / p95 ${r.p95.toFixed(3)} ms，绘制 ${r.calls}，三角形 ${Math.round(r.tris).toLocaleString('en-US')}`;

async function ab(label) {
  await set({ gardens: true });
  await page.waitForTimeout(1500);
  const on = await measure(frames);
  const stats = await page.evaluate(async () => (await import('/src/scenes/planetView.ts')).PlanetView.active?.gardenStats());
  await set({ gardens: false });
  await page.waitForTimeout(1500);
  const off = await measure(frames);
  await set({ gardens: true });
  console.log(`${label}\n  花园开：${fmt(on)}\n  花园关：${fmt(off)}\n  差：GPU p50 ${(on.p50 - off.p50).toFixed(3)} ms，绘制 ${on.calls - off.calls}，三角形 ${Math.round(on.tris - off.tris).toLocaleString('en-US')}（花园 ${stats?.items} 件零件 / ${stats?.drawCalls} 个网格 / ${stats?.triangles.toLocaleString('en-US')} 三角形，未含阴影）`);
}

try {
  const team = 'lumen-guild';
  await page.goto(`${base}/?gputime${local ? '' : '&nolocal'}#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  console.log(`backend ${await page.evaluate(() => window.__app.backend())}，像素比 2，${local ? '本机真实模型' : '占位作品'}`);
  await ab('星球视图（作品按地标放大）');
  // 地标放大关掉（overview = 1）：看放大本身有没有代价（多出来的是更大的阴影、像素覆盖）
  await set({ overview: 1 });
  await page.waitForTimeout(1500);
  const flat = await measure(frames);
  await set({ overview: 2.2 });
  await page.waitForTimeout(1500);
  const hero = await measure(frames);
  console.log(`  地标放大：开 ${fmt(hero)}\n            关 ${fmt(flat)}`);
  // 漫游：站在作品旁边、看着它的花园
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate(() => {
    const o = window.__walk.obstacles().find((x) => x.id === 'ph-02') ?? window.__walk.obstacles()[0];
    const c = o.dir;
    const R = window.__walk.state().radius;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const north = norm([0, 1, 0].map((u, k) => u - c[k] * dot(c, [0, 1, 0])));
    const a = (o.minAngle * R + 4) / R;
    const p = norm(c.map((x, k) => x * Math.cos(a) - north[k] * Math.sin(a)));
    const h = norm(c.map((x, k) => x - p[k] * dot(p, c)));
    window.__walk.teleport(p, h);
  });
  await page.waitForTimeout(2500);
  await ab('漫游（站在作品前 4 米，看着花园）');
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

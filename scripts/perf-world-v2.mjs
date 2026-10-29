// 第二版 [v2-world] 的性能：1440×900、像素比 2（画布 2880×1800）。
//   1. 首页静止 6 秒：帧间隔（中位、p95、最长、超过 33 ms 的帧数）
//   2. 首页每帧 GPU 时间、绘制调用：天体仪环、星座线、星座翠宝都开着 / 都关掉（差值就是这三样新加的）
//   3. 星球视图（lumen-guild）每帧 GPU 时间、绘制调用：中古点缀开着 / 关掉
//   4. 转场：星系 → lumen-guild（进星球）→ quiet-vertex（跳星球）→ 星系，每一段最长的帧间隔
// node scripts/perf-world-v2.mjs [--webgl2] [--frames 240]。WebGL2 的 GPU 计时要开有界面的 Chrome（HEADED=1）
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const frames = Number(args[args.indexOf('--frames') + 1] || 240);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
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
const intervals = (xs) => `${xs.length} 帧，中位 ${pct(xs, 0.5).toFixed(1)} ms，p95 ${pct(xs, 0.95).toFixed(1)} ms，最长 ${Math.max(...xs).toFixed(1)} ms，超过 33 ms 的 ${xs.filter((f) => f > 33.4).length} 帧`;

// n 帧的 GPU 时间（渲染器的时间戳查询，?gputime）和绘制调用（每帧画完时读 renderer.info）
const gpu = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const ms = [];
  const calls = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        calls.push(w.renderer.info.render.drawCalls);
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
  const p = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : NaN);
  return { p50: p(ms, 0.5), p95: p(ms, 0.95), samples: ms.length, calls: p(calls, 0.5) };
}, n);
const fmt = (r) => `GPU p50 ${r.p50.toFixed(2)} ms / p95 ${r.p95.toFixed(2)} ms（${r.samples} 帧），绘制调用 ${r.calls}`;
const setHome = (on) => page.evaluate(async (v) => {
  const { ARMILLARY } = await import('/src/scenes/homeArmillary.ts');
  const { CONSTELLATION } = await import('/src/scenes/homeConstellation.ts');
  const { CLOUD_TRIBOO, cloudTriboo } = await import('/src/scenes/homeCloudTriboo.ts');
  ARMILLARY.on = v;
  CONSTELLATION.on = v;
  CLOUD_TRIBOO.on = v;
  if (v) cloudTriboo()?.replay();
}, on ? 1 : 0);
const setProps = (on) => page.evaluate(async (v) => {
  const { PROPS } = await import('/src/planet/props-v2.ts');
  const { refillPropsV2 } = await import('/src/scenes/propsV2Install.ts');
  PROPS.on = v;
  refillPropsV2();
}, on ? 1 : 0);

try {
  const step = (m) => { if (process.env.VERBOSE === '1') console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); };
  step('开页');
  await page.goto(`${base}/?gputime&nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.mouse.move(700, 120);
  const backend = await page.evaluate(() => window.__app.backend());
  step(`页面好了（${backend}）`);
  // 星座翠宝马上出来、亮好（量的时候它在画面里）
  await page.evaluate(() => window.__v2world?.showConstellation?.());
  await page.waitForFunction(() => window.__v2world?.constellationState?.()?.phase === 'show', null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  await startRec();
  await page.waitForTimeout(6000);
  const idle = await stopRec();
  step('首页 GPU');
  const homeOn = await gpu(frames);
  await setHome(false);
  await page.waitForTimeout(1600);
  const homeOff = await gpu(frames);
  await setHome(true);
  console.log(`[${backend}] 首页静止 6 秒：${intervals(idle)}`);
  console.log(`[${backend}] 首页（天体仪环、星座线、星座翠宝都开着）：${fmt(homeOn)}`);
  console.log(`[${backend}] 首页（三样都关掉）：${fmt(homeOff)}`);
  // 转场 + 星球视图
  const seg = async (hash, ready) => {
    await startRec();
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction(ready, null, { timeout: 120000 });
    await page.waitForTimeout(1200);
    return stopRec();
  };
  step('进星球');
  const enter = await seg('#/t/lumen-guild', () => document.querySelector('#app')?.dataset.planetReady === 'lumen-guild' && window.__app.routeIdle());
  await page.waitForTimeout(1500);
  const planetOn = await gpu(frames);
  await setProps(false);
  await page.waitForTimeout(600);
  const planetOff = await gpu(frames);
  await setProps(true);
  await page.waitForTimeout(600);
  const hop = await seg('#/t/quiet-vertex', () => document.querySelector('#app')?.dataset.planetReady === 'quiet-vertex' && window.__app.routeIdle());
  const leave = await seg('#/', () => location.hash === '#/' && window.__app.routeIdle());
  console.log(`[${backend}] 星球视图（中古点缀开着）：${fmt(planetOn)}`);
  console.log(`[${backend}] 星球视图（中古点缀关掉）：${fmt(planetOff)}`);
  console.log(`[${backend}] 进星球：${intervals(enter)}`);
  console.log(`[${backend}] 跳星球：${intervals(hop)}`);
  console.log(`[${backend}] 回星系：${intervals(leave)}`);
  if (errors.length) console.log(`页面错误：${errors.join(' | ')}`);
} catch (e) {
  console.log(`✗ 脚本出错：${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

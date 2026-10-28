// 转场云层的 GPU 开销（motion）：1440×900、像素比 2（画布 2880×1800），星球视图里量每帧的 GPU 时间：
//   不转场（云层不画）、穿云全遮住那一刻（两层 iris 都在算，最贵）、跳星球全遮住那一刻（两层 band）、云刚涌进来（只有画面边上有云）。
// 云层的参数直接按分镜表算好写进去（transition.ts 的 veilFrame），时间停住，同一个画面连续量 N 帧，和不画云层的那组比。
// GPU 时间用渲染器的时间戳查询（?gputime，同 perf-gpu.mjs）。用法：node scripts/perf-veil.mjs [--webgl2] [--dpr 2] [--frames 180]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const dpr = Number(opt('--dpr', 2));
const frames = Number(opt('--frames', 180));
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

// 量 n 帧的 GPU 时间（每帧画完发起一次时间戳回读）
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
  return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), samples: gpu.length };
}, n);

// 把云层定在某个转场的某一刻（时间停住，不走时间线）
const pose = (kind, t) => page.evaluate(async ([k, at]) => {
  const { veilFrame, writeVeil, clearVeil } = await import('/src/scenes/transition.ts');
  const { TRANSITIONS } = await import('/src/scenes/shots.ts');
  if (!k) {
    clearVeil();
    return;
  }
  const cam = window.__world.rig.camera;
  writeVeil(veilFrame(k, TRANSITIONS[k], at, { aspect: cam.aspect, centerIn: [0, 0], centerOut: [0, 0.04], dir: [-1, 0], spin: 0.7 }));
}, [kind, t]);

try {
  await page.goto(`${base}/?gputime&nolocal#/t/${seed.you.teamId}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, seed.you.teamId, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const backend = await page.evaluate(() => window.__app.backend());
  const canvas = await page.evaluate(() => `${window.__world.renderer.domElement.width}×${window.__world.renderer.domElement.height}`);
  await page.evaluate(() => window.__trans.timeScale(0)); // 时间停住：画面不动，几组之间只差云层
  const rows = [];
  for (const [name, kind, t] of [
    ['不转场（云层不画）', null, 0],
    ['穿云：云刚涌进来（t=0.35）', 'enter', 0.35],
    ['穿云：全遮住（t=0.55，两层 iris）', 'enter', 0.55],
    ['跳星球：全遮住（t=0.42，两层 band）', 'hop', 0.42],
    ['回星系：全遮住（t=0.19）', 'leave', 0.19],
  ]) {
    await pose(kind, t);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const m = await measure(frames);
    rows.push({ name, ...m });
  }
  await pose(null, 0);
  await page.evaluate(() => window.__trans.timeScale(1));
  const base0 = rows[0].p50;
  console.log(`backend ${backend}，画布 ${canvas}（DPR ${dpr}），每组 ${frames} 帧`);
  console.log('| 画面 | GPU p50 | GPU p95 | 比不转场多 |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.p50.toFixed(2)} ms | ${r.p95.toFixed(2)} ms | ${r === rows[0] ? '-' : `${(r.p50 - base0).toFixed(2)} ms`} |`);
  if (rows.some((r) => !(r.samples > 0))) console.log('（有一组没有拿到时间戳：这个后端可能不支持时间戳查询）');
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

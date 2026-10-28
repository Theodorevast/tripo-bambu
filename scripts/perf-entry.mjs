// 进入星球的流畅度（V5）：从星系全景点进「你的星球」，记下镜头飞行和模型陆续上场期间每一帧的间隔（requestAnimationFrame，
// 不受主循环 dt 封顶的影响），直到作品都挂好再多看 1.5 秒；再进漫游、走 3 秒。报告最长帧间隔和超过 50 ms 的帧。
// 用法：node scripts/perf-entry.mjs [--webgl2] [--local]（--local 用本机的私有真实模型）
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const local = args.includes('--local');
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

const startFrames = () => page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    if (!window.__frames) return;
    window.__frames.push([t - last, t]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopFrames = () => page.evaluate(() => { const f = window.__frames ?? []; window.__frames = null; return f; });
const report = (name, frames) => {
  const dts = frames.map((f) => f[0]);
  const t0 = frames[0]?.[1] ?? 0;
  const long = frames.filter((f) => f[0] > 50).map((f) => `${f[0].toFixed(0)} ms @${((f[1] - t0) / 1000).toFixed(2)} s`);
  console.log(`${name}：${frames.length} 帧，最长 ${Math.max(...dts).toFixed(1)} ms${long.length ? `；超过 50 ms 的：${long.join('，')}` : '；没有超过 50 ms 的帧'}`);
};

try {
  const seed = (await import('../src/data/seed.json', { with: { type: 'json' } })).default;
  const team = seed.you.teamId;
  await page.goto(`${base}/?${local ? '' : 'nolocal&'}${process.env.QUERY ?? ''}#/`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__app.routeIdle(), null, { timeout: 30000 });
  await page.waitForTimeout(2000);
  const backend = await page.evaluate(() => window.__app.backend());
  console.log(`backend ${backend}，${local ? '本机真实模型' : '占位作品'}`);
  await startFrames();
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, team);
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForTimeout(1500);
  report('星系 → 星球（飞行 + 作品上场）', await stopFrames());
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await startFrames();
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  report('进入漫游 + 走 3 秒', await stopFrames());
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

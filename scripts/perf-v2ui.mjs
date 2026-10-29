// 第二版界面（v2-ui）的帧时间对照：同一页、同一个 3D 画面，把 theme-v2.css 关掉（= 第一版的界面样式）和打开各量一次，
// 看界面换皮有没有让帧时间变差。1440×900、像素比 2（画布 2880×1800），WebGPU（WEBGL2=1 走 WebGL2）。
// 量的是 rAF 帧间隔：首页静止、首页指着名牌来回移动（名牌悬停、细金线伸长）、星球页静止、Members 开着、Museum 开着。
// node scripts/perf-v2ui.mjs [--frames 240]。依赖缓存默认 .tmp/vite-perf（VITE_CACHE_DIR 可改）
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const FRAMES = Number(args[args.indexOf('--frames') + 1] || 240);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-perf' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.addInitScript(() => {
  window.__rec = null;
  const tick = (t) => {
    const r = window.__rec;
    if (r) {
      if (r.last >= 0) r.frames.push(t - r.last);
      r.last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.goto(`${base}/?nolocal`);
await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
await page.waitForFunction(() => !window.__home.state().intro, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const backend = await page.evaluate(() => window.__app.backend());

// 打开 / 关掉第二版的主题（开发服务器把每个 CSS 插成一个 <style data-vite-dev-id="…/theme-v2.css">）
const theme = (on) => page.evaluate((v) => {
  for (const s of document.querySelectorAll('style[data-vite-dev-id]')) if (s.dataset.viteDevId.endsWith('theme-v2.css') && s.sheet) s.sheet.disabled = !v;
}, on);
const record = async (n, during) => {
  await page.evaluate(() => { window.__rec = { frames: [], last: -1 }; });
  const job = during?.();
  await page.waitForFunction((k) => window.__rec.frames.length >= k, n, { timeout: 60000 });
  await job;
  const f = await page.evaluate(() => { const r = window.__rec; window.__rec = null; return r.frames; });
  const s = [...f].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: q(0.5), p95: q(0.95), max: s[s.length - 1], over33: f.filter((x) => x > 33.4).length, n: f.length };
};
// 指着名牌来回移动：每个显示着的名牌停一下
const sweepTags = async () => {
  const pts = await page.evaluate(() => [...document.querySelectorAll('.planet-tag:not(.is-off)')].map((t) => { const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }).filter((p) => p.x > 0));
  for (let k = 0; k < 3; k++) for (const p of pts) {
    await page.mouse.move(p.x, p.y, { steps: 6 });
    await page.waitForTimeout(120);
  }
};
const rows = [];
const measure = async (label, during) => {
  for (const on of [false, true]) {
    await theme(on);
    await page.waitForTimeout(700);
    const r = await record(FRAMES, during);
    rows.push({ label, ui: on ? 'v2' : 'v1 样式', ...r });
  }
};
await measure('首页静止');
await measure('首页指着名牌移动', sweepTags);
await page.mouse.move(720, 30);
await page.locator('.topbar .tb-visit').click();
await page.waitForFunction(() => !!document.querySelector('#app')?.dataset.planetReady && window.__app.routeIdle(), null, { timeout: 90000 });
await page.waitForTimeout(1500);
await measure('星球页静止');
await page.getByRole('button', { name: 'Members', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.sheet.members')?.hidden === false && window.__app.routeIdle(), null, { timeout: 30000 });
await page.waitForTimeout(1200);
await measure('Members 开着');
await page.getByRole('button', { name: 'Museum', exact: true }).click();
await page.waitForFunction(() => document.querySelector('section.museum')?.dataset.ready === 'true', null, { timeout: 60000 });
await page.waitForTimeout(1200);
await measure('Museum 开着（卡片里的模型在转）');
await theme(true);

const fmt = (x) => x.toFixed(1).padStart(5);
console.log(`backend: ${backend} · 1440×900 @2x · 每项 ${FRAMES} 帧（rAF 帧间隔，毫秒）`);
console.log('场景                              界面       中位   p95    最长  >33ms');
for (const r of rows) console.log(`${r.label.padEnd(26)}  ${r.ui.padEnd(7)}  ${fmt(r.median)}  ${fmt(r.p95)}  ${fmt(r.max)}  ${String(r.over33).padStart(4)}`);
if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.slice(0, 8).join('\n')}`);
await browser.close();
await server.close();

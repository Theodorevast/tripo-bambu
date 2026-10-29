// 第二版 [v2-world]：开场以后在主线程上新建了哪些渲染管线（第一次画时才同步编译的，就是卡顿的来源）。
// 比 check-pipelines.mjs 多几步：首页停一会儿（星座翠宝亮起来、天体仪环、星座线）→ 进星球 → 漫游 → 回星系 → 跳到另一个预设的星球。
// node scripts/check-pipelines-v2.mjs [--webgl2]。作品模型（tripo_material_*）是 Stager 在后台编的，列出来但不算问题
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const webgl2 = process.argv.includes('--webgl2');
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal#/`);
await page.waitForFunction(() => window.__ready === true && !document.querySelector('#boot'), null, { timeout: 90000 });
await page.waitForTimeout(1500);
const names = () => page.evaluate(() => {
  const r = window.__world.renderer;
  const out = {};
  for (const [key, p] of r._pipelines.caches) {
    const v = p.vertexProgram?.name ?? '';
    const f = p.fragmentProgram?.name ?? p.computeProgram?.name ?? '';
    out[key] = `${v} | ${f}`;
  }
  return out;
});
let prev = await names();
const step = async (label) => {
  const now = await names();
  const added = Object.keys(now).filter((k) => !(k in prev));
  const count = {};
  for (const k of added) count[now[k]] = (count[now[k]] ?? 0) + 1;
  const list = Object.entries(count).map(([n, c]) => `${c} × ${n}`);
  const bad = list.filter((s) => !/tripo_material|ShadowMaterial/.test(s));
  console.log(`${bad.length ? '✗' : '✓'} ${label}：新增 ${added.length} 条${list.length ? `（${list.join('；')}）` : ''}`);
  prev = now;
};
// 首页：叫星座翠宝出来，等它亮好；指着一颗星球（星座线变亮）
await page.evaluate(() => window.__v2world?.showConstellation?.());
await page.waitForFunction(() => window.__v2world?.constellationState?.()?.phase === 'show', null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
await step('首页（星座翠宝、天体仪环、星座线）');
const ready = (t) => page.waitForFunction((id) => document.querySelector('#app')?.dataset.planetReady === id && window.__app.routeIdle(), t, { timeout: 120000 });
await page.evaluate(() => { location.hash = '#/t/lumen-guild'; });
await ready('lumen-guild');
await page.waitForTimeout(2500);
await step('进星球（lumen-guild）');
await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
await page.locator('.topbar button.walk').click();
await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
await page.keyboard.down('w');
await page.waitForTimeout(1500);
await page.keyboard.up('w');
await page.waitForTimeout(800);
await step('漫游');
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
await page.evaluate(() => { location.hash = '#/t/kiln-collective'; });
await ready('kiln-collective');
await page.waitForTimeout(2500);
await step('跳星球（kiln-collective，沙漠）');
await page.evaluate(() => { location.hash = '#/t/ember-forge'; });
await ready('ember-forge');
await page.waitForTimeout(2500);
await step('跳星球（ember-forge，火山）');
await page.evaluate(() => { location.hash = '#/'; });
await page.waitForFunction(() => location.hash === '#/' && window.__app.routeIdle(), null, { timeout: 60000 });
await page.waitForTimeout(2500);
await step('回星系');
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
await browser.close();
await server.close();

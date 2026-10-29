// 漫游时抬头看夜空（v2-sky）：站在「你的星球」顶上、面朝星球页月亮的方位，蓝调时刻、月夜各一张（1440×900，像素比 1）。
// node scripts/shot-sky-walk.mjs [输出目录]。WEBGL2=1：走 WebGL2
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? '.superpowers/sdd/2026-10-30-v2/sky-media/final';
mkdirSync(out, { recursive: true });
const tag = process.env.WEBGL2 === '1' ? 'webgl2' : 'webgpu';
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-sky' });
const browser = await launch();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  errors.push(...[watchErrors(page)]);
  if (tag === 'webgl2') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/?nolocal#/t/lumen-guild`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle(), null, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#app')?.dataset.planetReady === 'lumen-guild', null, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  // 月亮的方向（星球页：NIGHT_SKY 的方位角、高度角；站在星球顶上时标架就是世界坐标）
  const heading = await page.evaluate(async () => {
    const { NIGHT_SKY } = await import('/src/nature/nightSky.ts');
    const az = (NIGHT_SKY.moonAzimuth * Math.PI) / 180;
    return [Math.sin(az), 0, Math.cos(az)];
  });
  await page.evaluate((h) => window.__walk.teleport([0, 1, 0], h), heading);
  await page.waitForTimeout(2500);
  for (const sky of ['blue', 'moon']) {
    await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
    await page.waitForTimeout(2600);
    await page.screenshot({ path: join(out, `walk-${sky}-1440-${tag}.png`) });
  }
} finally {
  const all = errors.flat();
  if (all.length) console.log(`页面错误：\n${all.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
  await server.close();
}

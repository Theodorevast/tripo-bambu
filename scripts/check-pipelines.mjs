// 进星球时新建了哪些渲染管线（water 角色加的）：node scripts/check-pipelines.mjs [团队 id] [--webgl2]
// 开场（星系、预热完）记一遍管线缓存，进星球等作品挂好后再记一遍，按着色器名列出多出来的（第一次画时才同步编译的，就是卡顿的来源）
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const team = process.argv[2] ?? 'lumen-guild';
const webgl2 = process.argv.includes('--webgl2');
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal#/`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
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
const before = await names();
await page.evaluate((t) => { location.hash = `#/t/${t}`; }, team);
await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
await page.waitForTimeout(3000);
const after = await names();
const added = Object.keys(after).filter((k) => !(k in before));
console.log(`开场 ${Object.keys(before).length} 条管线；进星球后 ${Object.keys(after).length} 条；新增 ${added.length} 条：`);
const count = {};
for (const k of added) count[after[k]] = (count[after[k]] ?? 0) + 1;
for (const [n, c] of Object.entries(count)) console.log(`  ${c} × ${n}`);
const water = Object.values(before).filter((n) => /water|stream/.test(n));
console.log(`开场已有的水面、小溪管线：${water.join('；')}`);
if (errors.length) console.log(errors.join('\n'));
await browser.close();
await server.close();

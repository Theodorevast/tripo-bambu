// 截图自查：node scripts/shot.mjs <路径> <输出.png> [--wait ms] [--click 选择器] [--width px] [--height px]
// 路径不要以 / 开头（Git Bash 会改写），例：node scripts/shot.mjs "index.html#/t/lumen-guild" shots/planet.png
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const [route, out, ...rest] = process.argv.slice(2);
if (!route || !out || /^[A-Za-z]:[\\/]/.test(route)) {
  console.error('用法：node scripts/shot.mjs <路径> <输出.png> [--wait ms] [--click 选择器] [--width px] [--height px]（路径不要以 / 开头）');
  process.exit(2);
}
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: Number(opt('--width', 1440)), height: Number(opt('--height', 900)) } });
const errors = watchErrors(page);
await page.goto(`${base}/${route.replace(/^\/+/, '')}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const click = opt('--click');
if (click) await page.locator(click).first().click();
await page.waitForTimeout(Number(opt('--wait', 800)));
mkdirSync(path.dirname(out), { recursive: true });
await page.screenshot({ path: out });
console.log(errors.length ? `页面错误 ${errors.length} 条：\n${errors.join('\n')}` : '页面无报错');
await browser.close();
await server.close();
process.exitCode = errors.length ? 1 : 0;

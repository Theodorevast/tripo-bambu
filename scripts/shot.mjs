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
// 页面在设置 __ready 之前就报错（多半是启动时崩了）：立即判失败，不干等 30 秒
const crashed = new Promise((_, reject) => page.once('pageerror', () => reject(new Error('页面在就绪前报错'))));
crashed.catch(() => {}); // 就绪之后才报错时没人等它；那条错误照样由 watchErrors 记下
try {
  await page.goto(`${base}/${route.replace(/^\/+/, '')}`);
  await Promise.race([page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 }), crashed]);
  const click = opt('--click');
  if (click) await page.locator(click).first().click();
  await page.waitForTimeout(Number(opt('--wait', 800)));
  mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
} catch (e) {
  // 没截成图：页面崩了、一直没就绪、--click 找不到元素……
  console.log(`截图失败：${e.message}`);
  process.exitCode = 1;
} finally {
  // 成不成功都把页面错误打出来，再关掉浏览器和服务器
  console.log(errors.length ? `页面错误 ${errors.length} 条：\n${errors.join('\n')}` : '页面无报错');
  if (errors.length) process.exitCode = 1;
  await browser.close();
  await server.close();
}

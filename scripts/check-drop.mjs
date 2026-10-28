// 拖放自查：编辑模式下拖入 GLB → 作品栏出现临时作品 → 摆上星球 → 存档里没有它；拖入 .txt 被拒绝
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeBoxGlb } from './lib/fixture.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const glb = Buffer.from(await makeBoxGlb()).toString('base64');
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
// ?nolocal：用仓库里的种子数据（占位作品），不换成本机的私有模型
await page.goto(`${base}/?nolocal#/t/${seed.you.teamId}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await page.locator('.topbar button.primary').click();

// 在页面里造一个 File，派发 drop 事件
const drop = (name, b64) => page.evaluate(([n, data]) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], n));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [name, b64]);

await drop('Dropped Sign.glb', glb);
await page.waitForTimeout(800);
const tempInTray = await page.locator('.tray-item .ti-temp').count();
// 近景取景下星球中心落在作品栏底下：往上 250 px 点在星球表面上，先确认那一点没有界面挡着
const center = await page.evaluate((id) => window.__app.planetScreenPos(id), seed.you.teamId);
const spot = { x: center.x, y: center.y - 250 };
const spotClear = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', spot);
await page.mouse.move(spot.x, spot.y);
await page.mouse.click(spot.x, spot.y);
await page.waitForTimeout(600);
const placed = await page.evaluate(() => window.__app.placedIds());
const saved = await page.evaluate((id) => window.__app.teamPlanet(id), seed.you.teamId);
await page.screenshot({ path: 'shots/drop.png' });
await drop('notes.txt', btoa('hello'));
await page.waitForTimeout(300);
const toastText = (await page.locator('.toast').textContent()) ?? '';

const results = [
  [tempInTray === 1, '作品栏出现 1 件临时作品'],
  [spotClear, '摆放点上没有界面遮挡'],
  [placed.some((id) => id.startsWith('tmp-')), '临时作品摆上了星球'],
  [!saved.placements.some((p) => p.workId.startsWith('tmp-')), '存档里没有临时作品'],
  [/Only \.glb/.test(toastText), '.txt 被拒绝并提示'],
];
for (const [ok, name] of results) console.log(`${ok ? '✓' : '✗'} ${name}`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every(([pass]) => pass) && errors.length === 0;
console.log(ok ? 'DROP OK' : 'DROP FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

// 编辑器自查：进入编辑 → 选中并删除一件作品 → 从作品栏摆回去 → 按 E 旋转 → 刷新后检查存档
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const target = team.works[0];
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
const ready = () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const planetOf = () => page.evaluate((id) => window.__app.teamPlanet(id), team.id);
const results = [];
const check = (name, ok) => results.push(`${ok ? '✓' : '✗'} ${name}`);

await page.goto(`${base}/#/t/${team.id}`);
await ready();
await page.evaluate(() => localStorage.removeItem('gbn:v1:planets'));
await page.reload();
await ready();
await page.locator('.topbar button.primary').click();
check('进入编辑后出现作品栏和外观面板', (await page.locator('.tray').isVisible()) && (await page.locator('.planet-panel').isVisible()));

const at = await page.evaluate((id) => window.__app.workScreenPos(id), target.id);
await page.mouse.click(at.x, at.y);
await page.waitForTimeout(200);
check('点作品后出现编辑条', await page.locator('.edit-bar').isVisible());
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
check('Delete 删除作品', !(await page.evaluate(() => window.__app.placedIds())).includes(target.id));

await page.locator('.tray-item', { hasText: target.title }).click();
await page.waitForTimeout(400);
// 近景取景下星球中心落在作品栏底下：往上 250 px 点在星球表面上，先确认那一点没有界面挡着
const center = await page.evaluate((id) => window.__app.planetScreenPos(id), team.id);
const drop = { x: center.x, y: center.y - 250 };
check('摆放点上没有界面遮挡', await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', drop));
await page.mouse.move(drop.x, drop.y);
await page.waitForTimeout(100);
await page.mouse.click(drop.x, drop.y);
await page.waitForTimeout(600);
check('从作品栏摆回星球', (await page.evaluate(() => window.__app.placedIds())).includes(target.id));

const before = (await planetOf()).placements.find((p) => p.workId === target.id).yaw;
await page.keyboard.press('e');
await page.waitForTimeout(200);
const after = (await planetOf()).placements.find((p) => p.workId === target.id).yaw;
const turned = Math.abs(after - before);
check('按 E 旋转 15°', Math.abs(turned - Math.PI / 12) < 1e-6 || Math.abs(turned - (2 * Math.PI - Math.PI / 12)) < 1e-6);
await page.screenshot({ path: 'shots/editor.png' });

await page.reload();
await ready();
const saved = (await planetOf()).placements.find((p) => p.workId === target.id);
check('刷新后摆放和旋转都还在', !!saved && Math.abs(saved.yaw - after) < 1e-9);

console.log(results.join('\n'));
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every((r) => r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'EDITOR OK' : 'EDITOR FAIL');
await page.evaluate(() => localStorage.removeItem('gbn:v1:planets'));
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

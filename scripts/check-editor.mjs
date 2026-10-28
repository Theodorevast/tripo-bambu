// 编辑器自查：进入编辑 → 选中并删除一件作品 → 从作品栏摆回去 → 按 E 旋转 → 刷新后检查存档；
// 再查编辑条的位置和可点性、拖动（阈值、抓取偏移、指针捕获）、Members 页下的快捷键、摆放中点 Done、临时作品回星系再回来。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeBoxGlb } from './lib/fixture.mjs';

const KEY = 'gbn:v1:planets';
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const [target, ref, spare, sheetWork] = team.works; // 删了再摆回去、拖动 / 参照 / 摆放中点 Done / Members 页下按键
const glb = Buffer.from(await makeBoxGlb()).toString('base64');
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
// 数存档被写了几次：点选、Members 页下按键都不该写
await page.addInitScript((key) => {
  const set = Storage.prototype.setItem;
  window.__writes = 0;
  Storage.prototype.setItem = function (k, v) {
    if (k === key) window.__writes++;
    return set.call(this, k, v);
  };
}, KEY);
const ready = () => page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const planetOf = () => page.evaluate((id) => window.__app.teamPlanet(id), team.id);
const placementOf = async (id) => (await planetOf()).placements.find((p) => p.workId === id);
const workPos = (id) => page.evaluate((i) => window.__app.workScreenPos(i), id);
const placedIds = () => page.evaluate(() => window.__app.placedIds());
const writes = () => page.evaluate(() => window.__writes);
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const results = [];
const check = (name, ok) => results.push(`${ok ? '✓' : '✗'} ${name}`);

// 编辑条的状态：整条在视口里、顶栏下面、作品栏上面；滑块中心点得到；work 那一点（作品身上）没被界面挡住
const barState = (work) => page.evaluate((w) => {
  const bar = document.querySelector('.edit-bar');
  const r = bar.getBoundingClientRect();
  const topbar = document.querySelector('.topbar').getBoundingClientRect().bottom;
  const tray = document.querySelector('.tray');
  const trayTop = tray.hidden ? innerHeight : tray.getBoundingClientRect().top;
  const slider = bar.querySelector('input[type=range]');
  const s = slider.getBoundingClientRect();
  const visible = !bar.hidden && getComputedStyle(bar).visibility === 'visible';
  return {
    inside: visible && r.left >= 0 && r.right <= innerWidth && r.top >= topbar && r.bottom <= trayTop,
    sliderHit: visible && document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2) === slider,
    workClear: document.elementFromPoint(w.x, w.y)?.id === 'stage',
  };
}, work);

// 拿到应用里的 PlanetView（看摆放预览、拖动中的摆放、渲染后端）：开发服务器上同一个模块地址就是同一个模块实例，
// 改原型上的 pick、topOf 和 planet getter，应用用到一次就记下 this
const grabView = () => page.evaluate(async () => {
  const { PlanetView } = await import('/src/scenes/planetView.ts');
  const proto = PlanetView.prototype;
  for (const name of ['pick', 'topOf']) {
    const fn = proto[name];
    proto[name] = function (...args) {
      window.__view = this;
      return fn.apply(this, args);
    };
  }
  const planet = Object.getOwnPropertyDescriptor(proto, 'planet');
  Object.defineProperty(proto, 'planet', { configurable: true, get() { window.__view = this; return planet.get.call(this); } });
});
// 星球上不属于任何已摆作品的东西 = 摆放预览（幽灵）
const ghosts = () => page.evaluate(() => {
  const v = window.__view;
  const roots = new Set([...v.placed.values()].map((pw) => pw.root));
  return v.planet ? v.planet.planet.works.children.filter((c) => !roots.has(c)).length : 0;
});
// 在页面里造一个 GLB 文件，派发 drop 事件
const dropGlb = (name) => page.evaluate(([n, data]) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], n));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [name, glb]);
const stageAt = (p) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', p);

// ?nolocal：按仓库里的种子数据（占位作品）核对，不换成本机的私有模型（src/assets/localWorks.ts）
await page.goto(`${base}/?nolocal#/t/${team.id}`);
await ready();
await page.evaluate((key) => localStorage.removeItem(key), KEY);
await page.reload();
await ready();
await page.locator('.topbar button.primary').click();
check('进入编辑后出现作品栏和外观面板', (await page.locator('.tray').isVisible()) && (await page.locator('.planet-panel').isVisible()));

// 不先转镜头，点默认视角里最靠画面正中的作品：编辑条不能压到顶栏底下（顶栏 z-index 6，压住了滑块就点到「← Galaxy」）
const front = await page.evaluate((ids) => {
  let best = null;
  for (const id of ids) {
    const p = window.__app.workScreenPos(id);
    if (p && (!best || Math.abs(p.x - innerWidth / 2) < Math.abs(best.p.x - innerWidth / 2))) best = { id, p };
  }
  return best;
}, team.planet.placements.map((p) => p.workId));
await page.mouse.click(front.p.x, front.p.y);
await page.waitForTimeout(200);
const barFront = await barState(front.p);
check('默认视角正中间的作品：旋转滑块中心点到的就是滑块，编辑条在顶栏下面', barFront.sliderHit && barFront.inside);
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

// 最上面一排的种子作品：编辑条在它旁边，整条在顶栏和作品栏之间，滑块点得到，作品本身没被挡住
const at = await workPos(target.id);
await page.mouse.click(at.x, at.y);
await page.waitForTimeout(200);
check('点作品后出现编辑条', await page.locator('.edit-bar').isVisible());
const barTop = await barState(at);
check('编辑条在视口里、顶栏下面、作品栏上面', barTop.inside);
check('编辑条上的旋转滑块点得到', barTop.sliderHit);
check('编辑条没挡住选中的作品', barTop.workClear);
await page.screenshot({ path: 'shots/editor-bar-top.png' });
await page.keyboard.press('Delete');
await page.waitForTimeout(200);
check('Delete 删除作品', !(await placedIds()).includes(target.id));

await page.locator('.tray-item', { hasText: target.title }).click();
await page.waitForTimeout(400);
// 摆在画面下半部分（后面要查下半部分的作品的编辑条）。V5 的星球视图从斜上方看、星球更大：星球中心投在画面中下部
// （1440×900 下约 y = 575），星球表面上下各有四百多像素；取中心往上 60 px，夹在画面中线以下、作品栏以上。先确认那一点没有界面挡着
const center = await page.evaluate((id) => window.__app.planetScreenPos(id), team.id);
const trayTop0 = await page.evaluate(() => document.querySelector('.tray').getBoundingClientRect().top);
const spot = { x: center.x, y: Math.min(Math.max(center.y - 60, 480), trayTop0 - 40) };
check('摆放点上没有界面遮挡', await stageAt(spot));
await page.mouse.move(spot.x, spot.y);
await page.waitForTimeout(100);
await page.mouse.click(spot.x, spot.y);
await page.waitForTimeout(600);
check('从作品栏摆回星球', (await placedIds()).includes(target.id));
// 摆回去的位置在画面中线以下：编辑条照样在旁边，不挡作品，滑块点得到
const low = await workPos(target.id);
const barLow = await barState(low);
check('画面下半部分的作品：编辑条在旁边、不挡作品、滑块点得到', low.y > 450 && barLow.inside && barLow.sliderHit && barLow.workClear);
await page.screenshot({ path: 'shots/editor-bar-low.png' });

const before = (await placementOf(target.id)).yaw;
await page.keyboard.press('e');
await page.waitForTimeout(200);
const after = (await placementOf(target.id)).yaw;
const turned = Math.abs(after - before);
check('按 E 旋转 15°', Math.abs(turned - Math.PI / 12) < 1e-6 || Math.abs(turned - (2 * Math.PI - Math.PI / 12)) < 1e-6);
await page.screenshot({ path: 'shots/editor.png' });

await page.reload();
await ready();
const saved = await placementOf(target.id);
check('刷新后摆放和旋转都还在', !!saved && Math.abs(saved.yaw - after) < 1e-9);

// —— 刷新之后：手抖的点选、拖动、Members 页、摆放中点 Done、临时作品 ——
// 每一段开头都把编辑模式摆到要的状态、等待都有时限：前面哪一项没过，后面照样查完，只记 ✗ 不中断
const until = (fn, arg, ms = 10000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const setEditing = async (on) => {
  const b = page.locator('.topbar button.primary');
  if (((await b.textContent()) === 'Done') !== on) await b.click();
  await page.waitForTimeout(150);
};
const closeSheet = async () => {
  if (!(await page.locator('.sheet.members').isVisible())) return;
  await page.keyboard.press('Escape');
  await page.locator('.sheet.members').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
};
await grabView();
await setEditing(true);
await page.mouse.move(1380, 160); // 编辑模式下鼠标一动，编辑器就会读 view.planet
await until(() => !!window.__view, null, 5000);
const backend = await page.evaluate(() => (window.__view?.world.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'));

// 手抖 1px 的点选只是选中：作品不动，不写存档
const r0 = await workPos(ref.id);
const refDir0 = JSON.stringify((await placementOf(ref.id)).dir);
const w0 = await writes();
await page.mouse.move(r0.x, r0.y);
await page.mouse.down();
await page.mouse.move(r0.x + 1, r0.y);
await page.mouse.up();
await page.waitForTimeout(200);
const r1 = await workPos(ref.id);
check('手抖 1px 的点选：选中了，作品不动、不写存档',
  (await page.locator('.edit-bar').isVisible()) && JSON.stringify((await placementOf(ref.id)).dir) === refDir0 && Math.hypot(r1.x - r0.x, r1.y - r0.y) < 0.5 && (await writes()) === w0);

// 拖动画面下半部分的作品：拖动时编辑条藏起来；松手后方向变了并存档；参照作品在屏幕上不动（镜头没跟着转）
await page.keyboard.press('Escape');
const from = await workPos(target.id);
const refBefore = await workPos(ref.id);
const dirBefore = (await placementOf(target.id)).dir;
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + 15 * i, from.y - 5 * i);
const barHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.edit-bar')).visibility === 'hidden');
await page.mouse.up();
await page.waitForTimeout(200);
const refAfter = await workPos(ref.id);
const dirAfter = (await placementOf(target.id))?.dir ?? dirBefore;
check('拖动作品：方向变了并存档，拖动时编辑条藏起来', angle(dirBefore, dirAfter) > 0.05 && barHidden);
check('拖动时镜头不跟着转（参照作品在屏幕上不动）', Math.hypot(refAfter.x - refBefore.x, refAfter.y - refBefore.y) < 1);

// 拖到作品栏上面：指针被画布抓住，作品照样跟着走
await setEditing(true);
// 拿不到应用里的 PlanetView 时返回 null，这一项记 ✗，不让两个 [0,0,0] 的夹角（π/2）蒙混过关
const liveDir = () => page.evaluate((id) => window.__view?.placed.get(id)?.placement.dir ?? null, target.id);
const trayTop = await page.evaluate(() => document.querySelector('.tray').getBoundingClientRect().top);
const a = await workPos(target.id);
let dragOverTray = false;
if (a) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let y = a.y + 10; y < trayTop - 12; y += 10) await page.mouse.move(a.x, y);
  await page.mouse.move(a.x, trayTop - 12);
  const dirEdge = await liveDir();
  const overTray = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.tray'), [a.x, trayTop + 50]);
  for (let y = trayTop; y <= trayTop + 50; y += 10) await page.mouse.move(a.x, y);
  const dirOver = await liveDir();
  await page.mouse.up();
  await page.waitForTimeout(200);
  dragOverTray = overTray && !!dirEdge && !!dirOver && angle(dirEdge, dirOver) > 0.02;
}
check('拖到作品栏上面时作品照样跟着走（指针捕获）', dragOverTray);

// Members 页打开时退出编辑：Delete、Backspace、Q、E 都不改动作品，也不写存档
await setEditing(true);
await page.keyboard.press('Escape');
const sw = await workPos(sheetWork.id);
await page.mouse.click(sw.x, sw.y);
await page.waitForTimeout(150);
const plan = JSON.stringify((await planetOf()).placements);
const wSheet = await writes();
await page.locator('.topbar button', { hasText: 'Members' }).click();
await page.locator('.sheet.members').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
for (const key of ['Delete', 'Backspace', 'q', 'e']) await page.keyboard.press(key);
await page.waitForTimeout(200);
check('Members 页下按 Delete / Backspace / Q / E 不改动作品、不写存档',
  JSON.stringify((await planetOf()).placements) === plan && (await placedIds()).includes(sheetWork.id) && (await writes()) === wSheet);
// 这时拖进 GLB：不进入摆放，星球上不出预览
await dropGlb('Behind Sheet.glb');
await page.waitForTimeout(400);
check('Members 页开着时拖进来的 GLB 不进入摆放', (await ghosts()) === 0 && /Open Edit/.test((await page.locator('.toast').textContent()) ?? ''));
// 顶栏压在 Members 页上面：开着页面点 Edit，页面关掉、进入编辑
await page.locator('.topbar button.primary').click();
const sheetClosed = await page.locator('.sheet.members').waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
check('Members 页开着时点 Edit：页面关掉、进入编辑',
  sheetClosed && (await page.locator('.tray').isVisible()) && (await page.locator('.topbar button.primary').textContent()) === 'Done');
await closeSheet();

// 连点两次同一件没摆的作品只出一个预览；摆放中点 Done，预览收走
await setEditing(true);
await page.keyboard.press('Escape');
const sp = await workPos(spare.id);
if (sp) {
  await page.mouse.click(sp.x, sp.y);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
}
await page.evaluate((title) => {
  const b = [...document.querySelectorAll('.tray-item')].find((x) => x.title === title);
  b?.click();
  b?.click(); // 同一个任务里连点两次：第一次的模型还没加载完
}, spare.title);
await page.waitForTimeout(300);
const ghostsPlacing = await ghosts();
await setEditing(false); // Done
check('连点两次同一件作品只有一个预览；摆放中点 Done 不留预览', ghostsPlacing === 1 && (await ghosts()) === 0);

// 拖进来的临时作品摆上星球 → 回星系再回来：还在星球上，存档里没有它
await setEditing(true);
await dropGlb('Round Trip.glb');
await until(() => !!document.querySelector('.tray-item .ti-temp'), null);
await page.waitForTimeout(200);
const tmpSpot = { x: center.x - 120, y: center.y - 230 };
const tmpSpotClear = await stageAt(tmpSpot);
await page.mouse.move(tmpSpot.x, tmpSpot.y);
await page.waitForTimeout(100);
await page.mouse.click(tmpSpot.x, tmpSpot.y);
await until(() => window.__app.placedIds().some((id) => id.startsWith('tmp-')), null);
const tmpId = (await placedIds()).find((id) => id.startsWith('tmp-'));
await page.locator('.topbar button', { hasText: 'Galaxy' }).click();
await until(() => window.__app.placedIds().length === 0, null, 15000);
await page.evaluate((id) => { location.hash = `#/t/${id}`; }, team.id);
const back = !!tmpId && (await until((id) => window.__app.placedIds().includes(id), tmpId, 15000));
const stored = await page.evaluate((key) => localStorage.getItem(key) ?? '', KEY);
check('临时作品回星系再回来还在星球上，存档里没有它',
  tmpSpotClear && back && !stored.includes('tmp-') && !(await planetOf()).placements.some((p) => p.workId.startsWith('tmp-')));

// 在作品栏点已经摆上的作品：镜头飞过去从正上方看它（不抬头），画面下半部分的作品「顶」朝屏幕下方。
// 这时点画面下半部分的作品：编辑条照样在旁边、不挡它、滑块点得到。重新载入种子数据，和前面的步骤无关
await page.evaluate((key) => localStorage.removeItem(key), KEY);
await page.reload();
await ready();
await setEditing(true);
await page.locator('.tray-item', { hasText: ref.title }).click();
await page.waitForTimeout(1300); // 0.8 秒的飞行
await page.keyboard.press('Escape'); // 取消选中：它的编辑条不挡着下面要找的作品
await page.waitForTimeout(100);
const lower = await page.evaluate((ids) => {
  let best = null;
  for (const id of ids) {
    const p = window.__app.workScreenPos(id);
    if (!p || p.y < innerHeight / 2 + 40 || document.elementFromPoint(p.x, p.y)?.id !== 'stage') continue;
    if (!best || p.y > best.p.y) best = { id, p };
  }
  return best;
}, (await placedIds()).filter((id) => id !== ref.id));
let lowerState = null;
if (lower) {
  await page.mouse.click(lower.p.x, lower.p.y);
  await page.waitForTimeout(200);
  lowerState = await barState(lower.p);
  await page.screenshot({ path: 'shots/editor-bar-below.png' });
}
const lowerOk = !!lowerState && lowerState.inside && lowerState.sliderHit && lowerState.workClear;
check('镜头从正上方看时，点画面下半部分的作品：编辑条不挡它、滑块点得到', lowerOk);
if (!lowerOk) console.log(`  画面下半部分的作品：${JSON.stringify(lower)} 编辑条：${JSON.stringify(lowerState)}`);

console.log(`backend: ${backend}`);
console.log(results.join('\n'));
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every((r) => r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'EDITOR OK' : 'EDITOR FAIL');
await page.evaluate((key) => localStorage.removeItem(key), KEY);
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

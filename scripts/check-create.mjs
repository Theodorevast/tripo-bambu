// 「建一颗星球」自查（P3）：走一遍完整流程，每一步截图到 shots/create-NN-<步骤>.png，最后统计页面错误。
// 主流程（1440×900、DPR 2）：首页标题卡片的 Create a planet → 四步造星窗口（名字校验、选样子、Reroll、复制邀请链接、加好友）→ Launch
// （量 Launch 以后到进星球就绪的每一帧间隔，要求最长 ≤ 50 ms）→ 刷新后星球还在、首页里它是你的星球、Create 按钮藏起来、#/create 带你回去
// → 进编辑模式摆一件作品（拖一个 GLB 进来摆上；再换一次外观，刷新后还在）→ Reset demo 以后星球被删掉、一切回到初始。
// 另开几页：减少动态效果（淡入淡出，镜头不飞）、只用键盘走完、手机竖屏（390 × 844）能用、Esc / 关闭按钮能关。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备；HEADED=1：有界面的 Chrome。DPR=<n>：设备像素比（默认 2）
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeBoxGlb } from './lib/fixture.mjs';

const KEY = 'gbn:v1:planets';
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const WEBGL2 = process.env.WEBGL2 === '1';
const DPR = Number(process.env.DPR ?? 2);
const QUERY = '?nolocal';
const NAME = 'Pebble Party';
const ID = 'pebble-party';
const glb = Buffer.from(await makeBoxGlb()).toString('base64');
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
const results = [];
const errorLists = [];
const numbers = [];
let shots = 0;

const { server, base } = await startServer();
const browser = await launch();
mkdirSync('shots', { recursive: true });

const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const until = (p, what, fn, arg = null, timeout = 30000) => p.waitForFunction(fn, arg, { timeout }).catch((err) => { throw new Error(`等不到${what}（${firstLine(err)}）`); });
const shot = async (p, name) => {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await p.screenshot({ path: `shots/create-${String(++shots).padStart(2, '0')}-${name}.png` });
};
// 一步：出错记 ✗ 和原因，接着走后面的（后面的步骤可能也跟着失败，但能看到更多信息）
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, firstLine(err));
  }
}

async function open(name, { viewport = { width: 1440, height: 900 }, reduced = false, dpr = DPR } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  errorLists.push([name, watchErrors(page)]);
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  page.on('dialog', (d) => d.accept()); // Reset demo 的确认框
  // 每帧记帧间隔（rAF）：startGaps 以后的都算
  await page.addInitScript(() => {
    window.__gaps = null;
    let last = 0;
    const tick = (t) => {
      if (window.__gaps && last) window.__gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { context, page };
}
const ready = (p) => until(p, '页面就绪', () => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, 90000);
const planetReady = (p, id) => until(p, ` ${id} 的星球视图就绪`, (x) => location.hash === `#/t/${x}` && window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === x, id, 90000);
const creatorOpen = (p) => until(p, '造星窗口打开、预览就绪', () => window.__create?.state().open && window.__create.state().previewReady && !document.querySelector('section.creator')?.hidden, null, 60000);
const stepIs = (p, id) => until(p, `第 ${id} 步`, (x) => window.__create.state().step === x && !document.querySelector(`.cp-page[data-page="${x}"]`).hidden, id);

try {
  // —— 主流程 ——
  const { context, page } = await open('主流程');
  await step('打开首页：标题卡片里有 Create a planet；点它进 #/create，窗口打开、3D 预览画出一颗星球', async () => {
    await page.goto(`${base}/${QUERY}`);
    await ready(page);
    const btn = page.locator('.topbar .tb-create');
    check('首页有 Create a planet 按钮', await btn.isVisible());
    await btn.click();
    await creatorOpen(page);
    check('点了以后地址是 #/create、窗口打开、预览画好', await page.evaluate(() => location.hash === '#/create'));
    const pv = await page.evaluate(() => window.__create.preview());
    numbers.push(`预览：${pv.backend}，第一颗编译 ${pv.compileMs[0]} ms`);
    await shot(page, 'open');
  });

  await step('第一步：空名字点 Next 不让过（提示、标红）；填好名字和口号，回车进下一步，名牌跟着变', async () => {
    await page.locator('.cp-next').click();
    const bad = await page.evaluate(() => ({ step: window.__create.state().step, invalid: document.querySelector('#cp-name').getAttribute('aria-invalid'), hint: document.querySelector('#cp-name-hint').dataset.tone }));
    check('空名字不让过：停在第一步，输入框标红、提示变成错误', bad.step === 'name' && bad.invalid === 'true' && bad.hint === 'error', JSON.stringify(bad));
    await page.locator('#cp-name').fill('Lumen Guild');
    await page.locator('.cp-next').click();
    check('和已有团队重名也不让过', await page.evaluate(() => window.__create.state().step === 'name' && /already/.test(document.querySelector('#cp-name-hint').textContent)));
    await page.locator('#cp-name').fill(NAME);
    await page.locator('#cp-motto').fill('Small rocks, big dreams.');
    const plate = await page.locator('.cp-plate-name').textContent();
    check('预览下面的名牌跟着名字变', plate === NAME, plate);
    check('字数提示', (await page.locator('.cp-page[data-page="name"] .cp-count').first().textContent()) === `${NAME.length}/24`);
    await shot(page, 'name');
    await page.locator('#cp-motto').press('Enter');
    await stepIs(page, 'look');
  });

  await step('第二步：选 Volcanic、团队色 Tide、关掉石头带、Reroll：预览每次都平滑换好', async () => {
    const builds0 = (await page.evaluate(() => window.__create.preview())).builds;
    await page.locator('.cp-preset', { hasText: 'Volcanic' }).click();
    await until(page, '换成 Volcanic 后预览就绪', () => window.__create.state().previewReady);
    await page.locator('.cp-color[title="Tide"]').click();
    await page.locator('.cp-switch').click();
    await until(page, '关掉石头带后预览就绪', () => window.__create.state().previewReady);
    await page.locator('.cp-reroll').click();
    await page.waitForTimeout(150);
    await shot(page, 'reroll');
    await until(page, 'Reroll 后预览就绪', () => window.__create.state().previewReady);
    const pv = await page.evaluate(() => window.__create.preview());
    check('预览换了几次样子（建了新的星球）', pv.builds > builds0, `${builds0} → ${pv.builds}`);
    await shot(page, 'look');
    await page.locator('.cp-next').click();
    await stepIs(page, 'crew');
  });

  await step('第三步：邀请链接指向这颗星球，复制后按钮变成 Copied!；加一个好友', async () => {
    const link = await page.locator('.cp-link-input').inputValue();
    check('邀请链接带 #/t/<新团队 id>', link.endsWith(`#/t/${ID}`) && /\?invite=[A-Z0-9]{6}#/.test(link), link);
    await page.locator('.cp-copy').click();
    await until(page, '复制后的反馈', () => document.querySelector('.cp-copy')?.dataset.copied === 'true');
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('剪贴板里是邀请链接', clip === link);
    await page.locator('#cp-friend').fill('Pixel Pete');
    await page.locator('#cp-friend').press('Enter');
    await page.locator('#cp-friend').fill('pixel pete');
    await page.locator('#cp-friend').press('Enter');
    const crew = await page.locator('.cp-crew .cp-member').count();
    check('加了一个好友（重复的不收）：成员 2 个', crew === 2, String(crew));
    await shot(page, 'crew');
    await page.locator('.cp-next').click();
    await stepIs(page, 'launch');
    check('第四步的登机牌写着团队名', (await page.locator('.cp-ticket-name').textContent()) === NAME);
    // 进第三步时主画面里开始备这颗星球的着色器（替身，见 createPlanetLaunch.ts 的 LaunchWarmer）：真人在第三、四步会停几秒，这里等它备好再点 Launch
    await until(page, '替身备好', () => window.__create.state().twinReady, null, 30000);
    await shot(page, 'launch-step');
  });

  await step('Launch：窗口收起 → 对准落点 → 蓄力（云打旋、原来的你的星球让开）→ 冲出来 → 落定 → 回首页停在新星球上；最长帧间隔 ≤ 33 ms', async () => {
    await page.evaluate(() => {
      window.__gaps = [];
      window.__phases = [];
      const tick = () => {
        const s = window.__create.state().launch.phase;
        if (window.__phases.at(-1) !== s) window.__phases.push(s);
        if (!(s === 'home' && !window.__world.rig.flying)) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const t0 = Date.now();
    await page.locator('.cp-next').click();
    // 量帧期间不截图（DPR 2 的截图本身会让页面停一下）：冲出来的样子看录像（scripts/record-create.mjs）
    await until(page, '冲出来、落定、回到首页', () => window.__create.state().launch.phase === 'home' && !window.__world.rig.flying && !window.__world.rig.drive && location.hash === '#/' && window.__app.routeIdle(), null, 60000);
    const total = Date.now() - t0;
    const r = await page.evaluate(() => ({ gaps: window.__gaps, phases: window.__phases }));
    await page.evaluate(() => { window.__gaps = null; });
    const max = Math.max(...r.gaps);
    numbers.push(`Launch → 回到首页 ${total} ms，${r.gaps.length} 帧，帧间隔 p50 ${pct(r.gaps, 0.5).toFixed(1)} / p95 ${pct(r.gaps, 0.95).toFixed(1)} / 最长 ${max.toFixed(1)} ms（${WEBGL2 ? 'WebGL2' : 'WebGPU'}，DPR ${DPR}）`);
    check('Launch 以后最长帧间隔 ≤ 33 ms（两帧）', max <= 33.5, `${max.toFixed(1)} ms`);
    const order = ['aim', 'charge', 'burst', 'settle', 'home'].map((x) => r.phases.indexOf(x));
    check('依次经过：对准 → 蓄力 → 冲出来 → 落定 → 回首页', order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), r.phases.join(' → '));
    const h = await page.evaluate((id) => {
      const w = window.__world;
      const e = w.planets.get(id);
      const slot = w.slotOf(e);
      const old = w.planets.get('lumen-guild');
      return {
        you: window.__home.state().you,
        tag: window.__home.state().tags.find((t) => t.id === id)?.you ?? false,
        tier: slot?.tier,
        atSlot: slot ? e.planet.group.position.distanceTo(e.home.clone().set(...slot.pos)) : -1,
        oldTier: old ? w.slotOf(old)?.tier : null,
        created: JSON.parse(localStorage.getItem('gbn:v1:planets') ?? '{}').created?.team?.id,
      };
    }, ID);
    check('落在你的位置上：名牌写 You、停在自己那一格；原来的你的星球让开了；存进了本地', h.you === ID && h.tag && h.tier === 'you' && h.atSlot >= 0 && h.atSlot < 1 && h.oldTier !== 'you' && h.created === ID, JSON.stringify(h));
    await page.waitForTimeout(600);
    await shot(page, 'landed-home');
    // 从首页进这颗星球：Visit your planet
    await page.locator('.topbar .tb-visit').click();
    await planetReady(page, ID);
    const s = await page.evaluate(() => ({ title: document.querySelector('.tb-name')?.textContent, edit: !document.querySelector('.topbar button.primary')?.hidden }));
    check('Visit your planet 进了新星球：标题是团队名、能编辑', s.title === NAME && s.edit, JSON.stringify(s));
    await page.waitForTimeout(400);
    await shot(page, 'landed');
  });

  await step('刷新以后星球还在；回首页：它在你的位置上（名牌写 You），Create a planet 藏起来了，#/create 直接带你回这颗星球', async () => {
    await page.reload();
    await ready(page);
    await planetReady(page, ID);
    check('刷新后还在新星球上', (await page.evaluate((id) => window.__app.teamPlanet(id), ID)) !== null);
    await page.getByRole('button', { name: '← Galaxy', exact: true }).click();
    await until(page, '回到首页', () => location.hash === '#/' && window.__app.routeIdle() && !window.__world.focused);
    await page.waitForTimeout(600);
    const h = await page.evaluate((id) => ({ you: window.__home.state().you, tag: window.__home.state().tags.find((t) => t.id === id), create: document.querySelector('.topbar .tb-create')?.hidden, visit: !document.querySelector('.topbar .tb-visit')?.hidden }), ID);
    check('首页：新星球是你的星球、名牌写 You', h.you === ID && h.tag?.you === true, JSON.stringify(h.tag ?? null));
    check('Create a planet 藏起来，Visit your planet 还在', h.create === true && h.visit === true);
    await shot(page, 'home-after');
    await page.evaluate(() => { location.hash = '#/create'; });
    await planetReady(page, ID);
    check('#/create（每个浏览器只能建一颗）直接带你去这颗星球', true);
  });

  await step('编辑模式摆一件作品：拖一个 GLB 进来、点星球摆上；再换一次外观，刷新后还在', async () => {
    await page.locator('.topbar button.primary').click();
    await until(page, '进入编辑（作品栏、外观面板）', () => document.querySelector('.tray')?.hidden === false && document.querySelector('.planet-panel')?.hidden === false);
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'pebble.glb'));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, glb);
    await until(page, '拖进来的作品进了作品栏、进入摆放', () => [...document.querySelectorAll('.tray-item')].some((b) => b.title === 'pebble' && b.getAttribute('aria-pressed') === 'true'));
    const center = await page.evaluate((id) => window.__app.planetScreenPos(id), ID);
    let placed = false;
    for (const dy of [250, 200, 300, 150]) {
      const at = { x: center.x, y: center.y - dy };
      if (!(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', at))) continue;
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
      placed = await page.waitForFunction(() => window.__app.placedIds().some((w) => w.startsWith('tmp-')), null, { timeout: 8000 }).then(() => true, () => false);
      if (placed) break;
    }
    check('拖进来的 GLB 摆在了新星球上', placed);
    await page.waitForTimeout(800);
    await shot(page, 'edit-placed');
    await page.locator('.planet-panel button', { hasText: 'Glacier' }).click();
    await until(page, '外观换成 Glacier 并存档', (id) => window.__app.teamPlanet(id)?.preset === 'glacier' && JSON.parse(localStorage.getItem('gbn:v1:planets') ?? '{}').created?.team?.planet?.preset === 'glacier', ID);
    await page.reload();
    await ready(page);
    await planetReady(page, ID);
    check('刷新后新星球的外观还是 Glacier', (await page.evaluate((id) => window.__app.teamPlanet(id)?.preset, ID)) === 'glacier');
  });

  await step('Reset demo：确认后刷新，新星球被删掉，本地存档清空，首页回到初始（Create a planet 回来了）', async () => {
    await page.locator('.topbar button.primary').click();
    await until(page, '进入编辑', () => document.querySelector('.planet-panel')?.hidden === false);
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('.planet-panel button', { hasText: 'Reset demo' }).click()]);
    await ready(page);
    await until(page, '找不到团队、回到首页', () => location.hash === '#/' && window.__app.routeIdle(), null, 60000);
    const s = await page.evaluate((id) => ({ team: window.__app.teamPlanet(id), saved: localStorage.getItem('gbn:v1:planets'), you: window.__home.state().you, create: !document.querySelector('.topbar .tb-create')?.hidden, n: window.__world.planets.size }), ID);
    check('Reset 以后新星球没了、存档清空、你的星球回到种子里的那颗、Create a planet 又能点', s.team === null && s.saved === null && s.you === seed.you.teamId && s.create && s.n === seed.teams.length, JSON.stringify(s));
    await shot(page, 'reset');
  });
  await context.close();

  // —— 减少动态效果：淡入淡出，镜头不飞 ——
  await step('减少动态效果：窗口淡入淡出，Launch 以后不飞、不冲、不抖：云色的幕淡入淡出，回到首页；最长帧间隔 ≤ 33 ms', async () => {
    const { context: c, page: p } = await open('减少动态效果', { reduced: true });
    await p.goto(`${base}/${QUERY}#/create`);
    await ready(p);
    await creatorOpen(p);
    await p.locator('#cp-name').fill('Quiet Comets');
    await p.locator('#cp-name').press('Enter');
    await p.locator('#cp-motto').press('Enter');
    await stepIs(p, 'look');
    for (const id of ['crew', 'launch']) {
      await p.locator('.cp-next').click();
      await stepIs(p, id);
    }
    await until(p, '替身备好', () => window.__create.state().twinReady, null, 30000);
    await p.evaluate(() => {
      window.__gaps = [];
      window.__veil = false;
      window.__phases = [];
      const tick = () => {
        if (document.querySelector('.cp-veil')) window.__veil = true;
        const s = window.__create.state().launch.phase;
        if (window.__phases.at(-1) !== s) window.__phases.push(s);
        if (!(s === 'home' && !document.querySelector('.cp-veil'))) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await p.locator('.cp-next').click();
    await until(p, '幕淡入淡出以后回到首页', () => window.__create.state().launch.phase === 'home' && !document.querySelector('.cp-veil') && location.hash === '#/' && window.__app.routeIdle(), null, 60000);
    const r = await p.evaluate(() => ({ gaps: window.__gaps, veil: window.__veil, phases: window.__phases }));
    const max = Math.max(...r.gaps);
    numbers.push(`减少动态效果：Launch → 回到首页最长帧间隔 ${max.toFixed(1)} ms（${r.phases.join(' → ')}）`);
    check('减少动态效果：云色的幕淡入淡出，没有蓄力、冲出来、落定', r.veil && !r.phases.some((x) => x === 'charge' || x === 'burst' || x === 'settle'), r.phases.join(' → '));
    check('减少动态效果：最长帧间隔 ≤ 33 ms（两帧）', max <= 33.5, `${max.toFixed(1)} ms`);
    await p.waitForTimeout(1200); // 首页加星球时的镜头飞行（0.9 秒）要是没被接管住，会在这时把镜头带走：等一下再看
    const cam = await p.evaluate(() => ({ drive: !!window.__world.rig.drive, flying: window.__world.rig.flying, you: window.__home.state().you }));
    check('减少动态效果：镜头交回首页、新星球是你的星球', !cam.drive && !cam.flying && cam.you === 'quiet-comets', JSON.stringify(cam));
    await c.close();
  });

  // —— 只用键盘 ——
  await step('只用键盘：Tab 到 Create a planet、回车打开；打字、回车、方向键、空格、Tab 走完四步并 Launch；Esc 能关窗口', async () => {
    const { context: c, page: p } = await open('键盘', { dpr: 1 });
    await p.goto(`${base}/${QUERY}`);
    await ready(p);
    await p.locator('.topbar .tb-create').focus();
    await p.keyboard.press('Enter');
    await creatorOpen(p);
    check('打开时焦点在名字输入框', await p.evaluate(() => document.activeElement?.id === 'cp-name'));
    await p.keyboard.press('Escape');
    await until(p, 'Esc 关掉窗口、回到首页', () => !window.__create.state().open && location.hash === '#/');
    await p.locator('.topbar .tb-create').focus();
    await p.keyboard.press('Enter');
    await creatorOpen(p);
    await p.keyboard.type('Key Board Club');
    await p.keyboard.press('Enter'); // 名字填了、口号空着：先跳到口号
    await p.keyboard.press('Enter'); // 口号回车：下一步
    await stepIs(p, 'look');
    check('第二步焦点在选中的星球类型上', await p.evaluate(() => document.activeElement?.name === 'cp-preset'), await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 60)));
    const before = await p.evaluate(() => document.activeElement.value);
    await p.keyboard.press('ArrowRight');
    const after = await p.evaluate(() => document.activeElement.value);
    check('方向键换星球类型', before !== after, `${before} → ${after}`);
    // Tab 到 Next，回车
    for (let i = 0; i < 12 && !(await p.evaluate(() => document.activeElement?.classList.contains('cp-next'))); i++) await p.keyboard.press('Tab');
    await p.keyboard.press('Enter');
    await stepIs(p, 'crew');
    check('第三步焦点在复制按钮上', await p.evaluate(() => document.activeElement?.classList.contains('cp-copy')));
    await p.keyboard.press('Enter'); // 焦点在复制按钮上
    await until(p, '键盘复制邀请链接', () => document.querySelector('.cp-copy')?.dataset.copied === 'true');
    await p.keyboard.press('Tab');
    await p.keyboard.type('nova');
    await p.keyboard.press('Enter');
    await p.keyboard.press('Enter'); // 空着回车：下一步
    await stepIs(p, 'launch');
    // Tab 在窗口里循环：按 30 次焦点还在窗口里
    for (let i = 0; i < 30; i++) await p.keyboard.press('Tab');
    check('Tab 一直在窗口里循环', await p.evaluate(() => !!document.activeElement?.closest('section.creator')));
    for (let i = 0; i < 30 && !(await p.evaluate(() => document.activeElement?.classList.contains('cp-next'))); i++) await p.keyboard.press('Tab');
    await p.keyboard.press('Enter');
    await until(p, '只用键盘 Launch：冲出来以后回到首页', () => window.__create.state().launch.phase === 'home' && !window.__world.rig.flying && window.__home.state().you === 'key-board-club', null, 60000);
    check('只用键盘建好了新星球（冲出来、回到首页，它是你的星球）', true);
    await c.close();
  });

  // —— 手机竖屏 ——
  await step('手机竖屏 390 × 844：窗口铺满不出屏，预览、按钮都看得见点得到，能走到第二步', async () => {
    const { context: c, page: p } = await open('手机', { viewport: { width: 390, height: 844 }, dpr: 2 });
    await p.goto(`${base}/${QUERY}#/create`);
    await ready(p);
    await creatorOpen(p);
    const fit = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const card = r('.cp-card');
      const next = r('.cp-next');
      const hole = r('.cp-porthole');
      const inView = (b) => b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight;
      return { card: inView(card), next: inView(next) && document.elementFromPoint(next.left + next.width / 2, next.top + next.height / 2)?.closest('.cp-next') !== null, hole: inView(hole) && hole.width > 100, scroll: document.documentElement.scrollWidth <= innerWidth };
    });
    check('手机：窗口、Next、预览都在屏幕里，没有横向滚动', fit.card && fit.next && fit.hole && fit.scroll, JSON.stringify(fit));
    await shot(p, 'phone-name');
    await p.locator('#cp-name').fill('Pocket Moons');
    await p.locator('.cp-next').click();
    await stepIs(p, 'look');
    await shot(p, 'phone-look');
    await p.locator('.cp-close').click();
    await until(p, '关闭按钮关掉窗口', () => !window.__create.state().open && location.hash === '#/');
    await c.close();
  });
} catch (err) {
  check('脚本中断', false, err?.stack ?? String(err));
} finally {
  const errors = errorLists.flatMap(([name, list]) => list.map((e) => `[${name}] ${e}`));
  console.log(`base: ${base} · ${WEBGL2 ? 'WebGL2' : 'WebGPU'} · DPR ${DPR}`);
  for (const n of numbers) console.log(n);
  console.log(results.join('\n'));
  if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.join('\n')}`);
  const ok = results.length > 0 && !results.some((r) => r.startsWith('✗')) && errors.length === 0;
  console.log(ok ? 'CHECK-CREATE OK' : 'CHECK-CREATE FAIL');
  process.exitCode = ok ? 0 : 1;
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

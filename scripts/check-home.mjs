// 首页（H2）自查：版式和名牌、标题区、悬停和进星球、右下角的翠宝和领券窗口（Claim、Esc、点外面、关闭按钮、冷却）、减少动态效果。
// node scripts/check-home.mjs。WEBGL2=1：藏起 navigator.gpu 走 WebGL2；HEADED=1：有界面的 Chrome（无头模式可能拿不到 WebGPU）；
// SIZE=390x844：手机竖屏。翠宝那几项连做 ROUNDS 轮（默认 3）：点翠宝 → 窗口出来 → 用不同的方式关掉 → 冷却中再点只摇头
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const built = seed.teams.filter((t) => t.status !== 'under-construction');
const WEBGL2 = process.env.WEBGL2 === '1';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const errors = [];

async function open({ reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
  const page = await ctx.newPage();
  errors.push(watchErrors(page));
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.addInitScript(() => {
    window.__rec = null;
    const tick = (t) => {
      const r = window.__rec;
      if (r) {
        r.frames.push(t - r.last);
        r.last = t;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${base}/?nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  return { ctx, page };
}

const homeState = (page) => page.evaluate(() => window.__home.state());
const tribooAt = async (page) => {
  await until(page, () => !!window.__home.state().triboo?.at, null, 15000);
  return (await homeState(page)).triboo?.at ?? null;
};

try {
  const { ctx, page } = await open();
  const backend = await page.evaluate(() => window.__app.backend());
  // —— 1. 标题区 ——
  const title = await page.evaluate(() => ({
    name: document.querySelector('.tb-name')?.textContent,
    tagline: document.querySelector('.tb-tagline')?.textContent,
    visit: document.querySelector('.tb-visit')?.textContent?.trim(),
    create: document.querySelector('.tb-create')?.textContent?.trim(),
    oldLine: [...document.querySelectorAll('.tb-title .mono')].map((e) => e.textContent).join(' '),
  }));
  check('标题区：Community Planets、一句说明、Visit your planet、Create a planet；没有原来那行灰色小字',
    title.name === 'Community Planets' && /Build a planet with friends/.test(title.tagline ?? '') && title.visit === 'Visit your planet' && title.create === 'Create a planet' && !title.oldLine,
    `${title.name} / ${title.tagline} / ${title.visit} / ${title.create}`);

  // —— 1b. 联名标志（Tripo × MakerWorld）：本机有品牌图时是图，没有时是文字；活动名照活动页的标题 ——
  await until(page, () => !!document.querySelector('.cb-head .cobrand')?.hasAttribute('data-art'), null, 5000);
  const brand = await page.evaluate(() => {
    const head = document.querySelector('.cb-head');
    const imgs = [...(head?.querySelectorAll('img') ?? [])].map((i) => ({ w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, ok: i.complete && i.naturalWidth > 0 }));
    const lockup = head?.querySelector('.cobrand');
    const name = document.querySelector('.tb-name');
    return {
      art: lockup?.hasAttribute('data-art') ?? false,
      label: lockup?.getAttribute('aria-label'),
      text: lockup?.textContent?.replace(/s+/g, ' ').trim(),
      imgs,
      event: head?.querySelector('.cb-event')?.textContent?.trim(),
      above: !!head && !!name && head.getBoundingClientRect().bottom <= name.getBoundingClientRect().top + 1,
      opacity: head ? getComputedStyle(head).opacity : null,
    };
  });
  const sameHeight = brand.imgs.length === 2 && Math.abs(brand.imgs[0].h - brand.imgs[1].h) < 1 && brand.imgs.every((i) => i.ok);
  check('联名：标题上面 Tripo（左）× MakerWorld，两边一样高；下面一行活动名 GBN · Great Benchy Nations',
    brand.label === 'Tripo × MakerWorld' && (brand.art ? sameHeight : /Tripo × MakerWorld/.test(brand.text ?? '')) && /GBN · Great Benchy Nations/.test(brand.event ?? '') && brand.above && brand.opacity === '1',
    brand.art ? `图：${brand.imgs.map((i) => `${Math.round(i.w)}×${Math.round(i.h)}`).join(' × ')}；${brand.event}` : `没有品牌图，文字：${brand.text}`);

  // —— 2. 名牌 ——
  await until(page, () => !window.__home.state().intro, null, 10000);
  await page.waitForTimeout(600);
  let st = await homeState(page);
  const shownTags = st.tags.filter((t) => t.shown);
  const youTag = st.tags.find((t) => t.id === you.id);
  // 螺旋星系（H2）：你的星球的名牌一直在，建设中的平时不显示；显示着的名牌两两不叠
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.planet-tag:not(.is-off) .pt-card')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }).filter((r) => r[2] > r[0]));
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a0, a1, a2, a3] = boxes[i];
    const [b0, b1, b2, b3] = boxes[j];
    if (a0 < b2 && b0 < a2 && a1 < b3 && b1 < a3) overlaps++;
  }
  const buildingShown = shownTags.filter((t) => seed.teams.find((x) => x.id === t.id)?.status === 'under-construction').length;
  check('名牌：你的星球写 You、一直显示；显示着的名牌两两不叠；建设中的平时不显示', !!youTag?.you && youTag.shown && overlaps === 0 && buildingShown === 0,
    `显示 ${shownTags.length}/${st.tags.length} 张，叠在一起的 ${overlaps} 对`);
  // 你的星球在星系正中、最大；整个星系在画面里（没有星球出画、没有星球被标题卡片盖住）
  const lay = await page.evaluate(() => {
    const w = window.__world;
    const you = w.planets.get(window.__home.state().you);
    const card = document.querySelector('.tb-title')?.getBoundingClientRect();
    let biggest = true;
    let out = 0;
    let underCard = 0;
    for (const e of w.planets.values()) {
      if (e !== you && e.planet.group.scale.x >= you.planet.group.scale.x) biggest = false;
      const p = window.__app.planetScreenPos(e.team.id);
      if (!p || p.x < 0 || p.x > innerWidth || p.y < 0 || p.y > innerHeight) out++;
      else if (card && p.x < card.right && p.y < card.bottom) underCard++;
    }
    return { center: you.home.length() < 1e-3, biggest, out, underCard };
  });
  check('版式：你的星球在螺旋星系正中、最大；所有星球都在画面里、没有被标题卡片盖住', lay.center && lay.biggest && lay.out === 0 && lay.underCard === 0, JSON.stringify(lay));
  const youAt = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);

  // —— 3. 悬停：星球放大、名牌弹起来、光标是手形 ——
  const before = await page.evaluate((id) => window.__world.planets.get(id).planet.group.scale.x, you.id);
  await page.mouse.move(youAt.x, youAt.y);
  await page.waitForTimeout(700);
  const hover = await page.evaluate((id) => ({ scale: window.__world.planets.get(id).planet.group.scale.x, rot: window.__world.planets.get(id).planet.group.rotation.y, cursor: document.querySelector('#stage').style.cursor, tag: document.querySelector('.planet-tag.is-hover .pt-name')?.textContent }), you.id);
  check('悬停星球：轻轻放大、慢慢转、名牌弹起来、手形光标', hover.scale > before * 1.03 && Math.abs(hover.rot) > 0.05 && hover.tag === you.name && hover.cursor === 'pointer',
    `大小 ${before.toFixed(3)} → ${hover.scale.toFixed(3)}，转了 ${hover.rot.toFixed(2)} rad，名牌 ${hover.tag}`);
  await page.mouse.move(W * 0.5, 40);
  await page.waitForTimeout(400);

  // —— 4. 右下角的翠宝：探头、靠近、悬停 ——
  const t0 = await tribooAt(page);
  check('翠宝：开场打完招呼以后在右下角露出一小半，看得到、点得到', !!t0 && t0.x > W * 0.8 && t0.y > H * 0.55, t0 ? `(${Math.round(t0.x)}, ${Math.round(t0.y)})` : '没有');
  await page.mouse.move(t0.x - 120, t0.y - 20);
  const near = await until(page, () => window.__home.state().triboo.phase === 'near', null, 3000);
  await page.mouse.move(t0.x, t0.y);
  await page.waitForTimeout(500);
  st = await homeState(page);
  const cursor = await page.evaluate(() => document.querySelector('#stage').style.cursor);
  check('翠宝：指针靠近时探出来挥手，悬停时手形光标', near && st.triboo.hover && cursor === 'pointer', `phase ${st.triboo.phase}，hover ${st.triboo.hover}，cursor ${cursor}`);

  // —— 5. 点翠宝 → 领券窗口（ROUNDS 轮）——
  const closers = [
    ['Esc', async () => page.keyboard.press('Escape')],
    ['点窗口外面', async () => page.mouse.click(60, H * 0.5)],
    ['关闭按钮', async () => page.locator('.coupon-card .cc-close').click()],
  ];
  let firstMax = null;
  for (let round = 0; round < ROUNDS; round++) {
    await until(page, () => window.__home.state().triboo.cooldown === 0 && !window.__home.state().card.open, null, 10000);
    const at = await tribooAt(page);
    if (!at) {
      check(`第 ${round + 1} 轮：点翠宝`, false, '翠宝不在画面里');
      continue;
    }
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(300);
    const spitsBefore = (await page.evaluate(() => window.__coupons.state().counts.spits));
    await page.evaluate(() => { window.__rec = { frames: [], last: performance.now() }; });
    await page.mouse.click(at.x, at.y);
    const shown = await until(page, () => window.__home.state().card.shown, null, 6000);
    await page.waitForTimeout(800);
    const frames = await page.evaluate(() => { const r = window.__rec; window.__rec = null; return r.frames.slice(1); });
    const max = Math.max(...frames);
    if (round === 0) firstMax = max;
    const card = await page.evaluate(() => {
      const a = document.querySelector('.coupon-card .cc-claim');
      const r = a?.getBoundingClientRect();
      return {
        mode: document.querySelector('.coupon-card')?.dataset.mode,
        title: document.querySelector('.coupon-card .cc-title')?.textContent,
        value: document.querySelector('.coupon-card .cc-value')?.textContent,
        blurb: document.querySelector('.coupon-card .cc-blurb')?.textContent,
        claim: a ? { tag: a.tagName, href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim(), visible: !!r && r.width > 100 } : null,
        code: getComputedStyle(document.querySelector('.coupon-card .cc-code-row')).display,
        dialog: document.querySelector('.coupon-card')?.getAttribute('role'),
      };
    });
    const spits = (await page.evaluate(() => window.__coupons.state().counts.spits)) - spitsBefore;
    const cardBrand = await page.evaluate(() => {
      const c = document.querySelector('.coupon-card .cc-cobrand');
      return !!c && !c.hidden && c.getBoundingClientRect().height > 10;
    });
    check(`第 ${round + 1} 轮：点翠宝 → 吐一张券 → 展开成领券窗口（顶上联名小标志、标题、面额、说明、大的 Claim on Tripo 链接）`,
      shown && cardBrand && spits === 1 && card.mode === 'claim' && !!card.title && !!card.value && !!card.blurb && card.code === 'none' && card.dialog === 'dialog'
      && card.claim?.tag === 'A' && card.claim.href.startsWith('https://www.tripo3d.ai') && card.claim.target === '_blank' && /noopener/.test(card.claim.rel) && card.claim.text.startsWith('Claim on Tripo') && card.claim.visible,
      `${card.title} · ${card.value}；最长帧间隔 ${max.toFixed(1)} ms`);
    if (round === 0) {
      // Claim on Tripo：新标签页打开 tripo3d.ai（拦下来回一个空页面），窗口留着
      const popupP = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
      await page.locator('.coupon-card .cc-claim').click();
      const popup = await popupP;
      if (popup) await popup.waitForLoadState().catch(() => {});
      check('Claim on Tripo：新标签页打开 tripo3d.ai（<a target=_blank rel=noopener>），领券窗口留着', !!popup && popup.url().startsWith('https://www.tripo3d.ai') && (await homeState(page)).card.open, popup?.url() ?? '没打开');
      await popup?.close();
      await page.bringToFront();
    }
    // 冷却中（窗口开着时）点不到翠宝：先关窗口
    const [how, close] = closers[round % closers.length];
    await close();
    // 等收起的动画放完（放完之前背景那层还在，点不到翠宝）
    const closed = await until(page, () => !window.__home.state().card.open && document.querySelector('#app > .coupon-layer')?.hidden === true, null, 3000);
    check(`第 ${round + 1} 轮：${how}关掉领券窗口`, closed);
    // 冷却中再点：只摇头，不吐券
    st = await homeState(page);
    if (st.triboo.cooldown > 0.5) {
      const at2 = await tribooAt(page);
      const shakesBefore = await page.evaluate(() => window.__coupons.state().counts.shakes);
      if (at2) await page.mouse.click(at2.x, at2.y);
      const shook = await until(page, (n) => window.__coupons.state().counts.shakes > n, shakesBefore, 2000);
      await page.waitForTimeout(300);
      st = await homeState(page);
      check(`第 ${round + 1} 轮：冷却中再点只摇头（和星球页共用冷却）`, shook && !st.card.open, `冷却还剩 ${st.triboo.cooldown.toFixed(1)} 秒`);
    }
  }
  check('第一次点翠宝：最长帧间隔 ≤ 33 ms', firstMax !== null && firstMax <= 33.4, `${backend}，${firstMax?.toFixed(1)} ms`);

  // —— 5b. 螺旋星系随便转：左右拖 180° 以后，照样能悬停名牌、点进星球；回首页时回到正面的取景 ——
  {
    const azimuth = () => page.evaluate(() => {
      const w = window.__world;
      const c = w.rig.camera.position;
      const t = w.rig.controls.target;
      return (Math.atan2(c.x - t.x, c.z - t.z) * 180) / Math.PI;
    });
    await until(page, () => window.__home.state().card.open === false && document.querySelector('#app > .coupon-layer')?.hidden !== false, null, 5000);
    const a0 = await azimuth();
    // 在画面右上方的空地上横着拖（OrbitControls：拖一个画面高度转 360°）。拖完等惯性停下来
    const y = Math.round(H * 0.16);
    await page.mouse.move(Math.round(W * 0.8), y);
    await page.mouse.down();
    const span = Math.round(H * 0.5);
    for (let i = 1; i <= 20; i++) await page.mouse.move(Math.round(W * 0.8) - (span * i) / 20, y);
    await page.mouse.up();
    await page.waitForTimeout(1800);
    const a1 = await azimuth();
    const turned = Math.abs(((a1 - a0 + 540) % 360) - 180);
    check('首页左右随便转：横着拖半个画面高转了 180° 左右（不再卡在 ±14° / ±45°）', turned > 150, `转了 ${turned.toFixed(0)}°`);
    // 转过去以后：挑一张显示着的、建好的星球的名牌，悬停、点进去
    await page.mouse.move(W * 0.5, 30);
    await page.waitForTimeout(600);
    st = await homeState(page);
    const pick = st.tags.find((t) => t.shown && !t.you && built.some((b) => b.id === t.id));
    let entered180 = false;
    let hovered180 = false;
    if (pick) {
      await page.mouse.move(pick.x, pick.y + 12);
      hovered180 = await until(page, (name) => document.querySelector('.planet-tag.is-hover .pt-name')?.textContent === name, pick.text, 3000);
      await page.mouse.click(pick.x, pick.y + 12);
      entered180 = await until(page, (id) => location.hash === `#/t/${id}` && window.__app.routeIdle(), pick.id, 30000);
    }
    check('转了 180° 以后：悬停名牌弹起来，点名牌直接飞进那颗星球（从当前角度飞过去）', !!pick && hovered180 && entered180, pick ? `${pick.text}` : '没有显示着的名牌');
    if (entered180) {
      await page.locator('.topbar button', { hasText: 'Galaxy' }).click();
      await until(page, () => window.__app.routeIdle() && (location.hash === '#/' || location.hash === ''), null, 30000);
      await page.waitForTimeout(800);
      const a2 = await azimuth();
      check('从星球回首页：回到正面的取景', Math.abs(((a2 + 540) % 360) - 180) < 8, `方位角 ${a2.toFixed(0)}°`);
    }
  }

  // —— 6. Visit your planet：先弹一下，再穿云进你的星球；星球页上翠宝缩走、名牌收起 ——
  await page.mouse.move(W * 0.5, 40);
  await page.locator('.tb-visit').click();
  const entered = await until(page, (id) => location.hash === `#/t/${id}` && window.__app.routeIdle(), you.id, 30000);
  // 翠宝缩走（弹簧）、名牌收起要一小会儿：等一下再看
  await until(page, () => !window.__home.state().triboo.shown && window.__home.state().tags.every((t) => !t.shown), null, 4000);
  st = await homeState(page);
  const hashNow = await page.evaluate(() => location.hash);
  check('Visit your planet：进到你的星球；星球页上右下角的翠宝缩走、名牌收起来', entered && !st.triboo.shown && st.tags.every((t) => !t.shown),
    `地址 ${hashNow}，翠宝 ${st.triboo.shown ? '还在' : '缩走了'}（${st.triboo.phase}），名牌显示 ${st.tags.filter((t) => t.shown).length} 张`);
  await page.locator('.topbar button', { hasText: 'Galaxy' }).click();
  const back = await until(page, () => window.__app.routeIdle() && (location.hash === '#/' || location.hash === ''), null, 20000);
  const tagsBack = await until(page, () => window.__home.state().tags.some((t) => t.shown) && !!window.__home.state().triboo.shown, null, 6000);
  check('回首页：名牌、翠宝回来', back && tagsBack);

  // —— 7. 名牌是按钮：Tab 选到、回车进星球 ——
  const other = built.find((t) => t.id !== you.id);
  await page.locator('.planet-tag', { hasText: other.name }).focus();
  await page.keyboard.press('Enter');
  const keyEnter = await until(page, (id) => location.hash === `#/t/${id}` && window.__app.routeIdle(), other.id, 20000);
  check(`键盘：选中 ${other.name} 的名牌按回车进星球`, keyEnter);

  // —— 7b. 演示里每颗星球都能编辑：别人的、建设中的星球也有 Edit，点了进编辑（作品栏、外观面板） ——
  const building = seed.teams.find((t) => t.status === 'under-construction');
  for (const team of [other, building]) {
    if (!team) continue;
    if (!(await page.evaluate(() => location.hash)).endsWith(team.id)) {
      await page.evaluate((id) => { location.hash = `#/t/${id}`; }, team.id);
      await until(page, (id) => location.hash === `#/t/${id}` && window.__app.routeIdle(), team.id, 20000);
    }
    const editVisible = await page.evaluate(() => {
      const b = document.querySelector('.topbar button.primary');
      return !!b && !b.hidden && b.textContent === 'Edit';
    });
    if (editVisible) await page.locator('.topbar button.primary').click();
    const editing = await until(page, () => document.querySelector('.tray')?.hidden === false && document.querySelector('.planet-panel')?.hidden === false
      && document.querySelector('.topbar button.primary')?.textContent === 'Done', null, 5000);
    check(`每颗星球都能编辑：${team.name}（${team.status === 'under-construction' ? '建设中' : '别人的'}）有 Edit，点了进编辑`, editVisible && editing);
    if (editing) await page.locator('.topbar button.primary').click();
  }
  await ctx.close();

  // —— 8. 减少动态效果：券不飞，窗口直接淡入；翠宝不探头 ——
  const r = await open({ reduced: true });
  await r.page.waitForTimeout(800);
  const rAt = await tribooAt(r.page);
  const rIntro = (await homeState(r.page)).intro;
  if (rAt) await r.page.mouse.click(rAt.x, rAt.y);
  let flew = false;
  const rShown = await until(r.page, () => window.__home.state().card.shown, null, 6000);
  flew = await r.page.evaluate(() => window.__coupons.state().coupons.some((c) => c.phase === 'pickup'));
  check('减少动态效果：不打招呼、点了翠宝券不飞，领券窗口直接淡入', !!rAt && !rIntro && rShown && !flew);
  await r.ctx.close();
  // —— 9. Tune（先不开放）：地址不带 ?tune 时标题卡片上没有 Tune 按钮、不下载调参面板（localStorage 记着开也不开）；
  //        带 ?tune 时开页就打开面板，标题卡片上有 Tune 按钮，点了能关上 ——
  {
    const t = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const tp = await t.newPage();
    errors.push(watchErrors(tp));
    if (WEBGL2) await tp.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    const tweakpane = [];
    tp.on('request', (r) => { if (/tweakpane/i.test(r.url())) tweakpane.push(r.url()); });
    const loaded = () => until(tp, () => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, 90000);
    await tp.addInitScript(() => { try { localStorage.setItem('community-planets:tune-open', '1'); } catch {} });
    await tp.goto(`${base}/?nolocal`);
    await loaded();
    await tp.waitForTimeout(800);
    const plain = await tp.evaluate(() => {
      const b = document.querySelector('.tb-title .tb-tune');
      const p = document.querySelector('.tune-pane');
      return { button: !!b && !b.hidden && b.getBoundingClientRect().width > 0, pane: !!p && !p.hidden };
    });
    check('Tune 先不开放：地址不带 ?tune 时没有 Tune 按钮、不打开调参面板、不下载 Tweakpane（记着开也不开）', !plain.button && !plain.pane && tweakpane.length === 0, JSON.stringify({ ...plain, tweakpane: tweakpane.length }));
    await tp.goto(`${base}/?nolocal&tune`);
    await loaded();
    const forced = await until(tp, () => document.querySelector('.tune-pane')?.hidden === false && document.querySelector('.tb-title .tb-tune')?.getAttribute('aria-pressed') === 'true', null, 20000);
    await tp.locator('.tb-title .tb-tune').click();
    const closed = await until(tp, () => document.querySelector('.tune-pane')?.hidden === true, null, 3000);
    check('地址带 ?tune：开页就打开调参面板，标题卡片上有 Tune 按钮，点了能关上', forced && closed);
    await t.close();
  }

  console.log(`backend: ${backend}；${W}×${H}`);
} catch (e) {
  results.push(`✗ 脚本出错：${e.message}`);
} finally {
  console.log(results.join('\n'));
  const errs = errors.flat();
  if (errs.length) console.log(`页面错误：\n${errs.join('\n')}`);
  const ok = results.length > 0 && results.every((x) => x.startsWith('✓')) && errs.length === 0;
  console.log(ok ? 'HOME OK' : 'HOME FAIL');
  await browser.close();
  await server.close();
  process.exitCode = ok ? 0 : 1;
}

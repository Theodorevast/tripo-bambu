// 第二版界面（v2-ui）的样张：node scripts/shot-v2ui.mjs [只截哪几张，逗号分开]
// 两种尺寸各一套（1440×900、390×844；SIZES=1440x900 只截一种）：启动画面三个阶段、首页（标题卡片和名牌）、领券窗口、
// 造星窗口（第一步、第二步）、星球页顶栏、Members（正面、翻到背面）、Museum、查看器、编辑模式、漫游。
// 输出到 .superpowers/sdd/2026-10-30-v2/ui-media/<名字>-<宽>.png（OUT 可改）。依赖缓存默认 .tmp/vite-v2ui（VITE_CACHE_DIR 可改）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.env.OUT ?? '.superpowers/sdd/2026-10-30-v2/ui-media';
const ONLY = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const SIZES = (process.env.SIZES ?? '1440x900,390x844').split(',').map((s) => s.split('x').map(Number));
const REDUCED = process.env.REDUCED === '1';
mkdirSync(OUT, { recursive: true });
const want = (name) => !ONLY || ONLY.has(name);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-v2ui' });
const browser = await launch();
const errors = [];
const log = [];

const until = (p, what, fn, arg = null, timeout = 30000) =>
  p.waitForFunction(fn, arg, { timeout }).catch((err) => { throw new Error(`等不到${what}（${String(err?.message ?? err).split('\n')[0]}）`); });

for (const [W, H] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: W < 600 ? 2 : 1, reducedMotion: REDUCED ? 'reduce' : 'no-preference' });
  await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
  const p = await ctx.newPage();
  errors.push(watchErrors(p));
  const shot = async (name) => {
    if (!want(name)) return;
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
    const file = join(OUT, `${name}-${W}.png`);
    await p.screenshot({ path: file });
    log.push(file);
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      log.push(`✗ ${name} @${W}: ${String(err?.message ?? err).split('\n')[0]}`);
    }
  };
  await p.addInitScript(() => {
    window.__bootHold = (phase) => new Promise((go) => {
      window.__bootAt = phase;
      window.__bootGo = () => {
        window.__bootAt = null;
        go();
      };
    });
  });
  await p.goto(`${base}/?nolocal`);
  for (const phase of ['sky', 'warm', 'land']) {
    await until(p, `启动画面 ${phase}`, (x) => window.__bootAt === x, phase, 90000);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(phase === 'sky' ? 900 : 400);
    await shot(`boot-${phase}`);
    await p.evaluate(() => window.__bootGo());
  }
  if (want('boot-leaving')) {
    await until(p, '启动画面散开', () => document.querySelector('#boot')?.dataset.state === 'leaving');
    await p.evaluate(() => { for (const a of document.getAnimations()) if (a.constructor.name === 'CSSTransition') { a.pause(); a.currentTime = 450; } });
    await shot('boot-leaving');
    await p.evaluate(() => { for (const a of document.getAnimations()) if (a.constructor.name === 'CSSTransition') a.play(); });
  }
  await until(p, '首页就绪', () => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, 90000);
  await step('home', async () => {
    await until(p, '开场演完', () => !window.__home.state().intro, null, 20000);
    await p.waitForTimeout(1600);
    await shot('home');
  });
  await step('coupon', async () => {
    if (!want('coupon')) return;
    await until(p, '翠宝露出来', () => !!window.__home.state().triboo?.at && window.__home.state().triboo.cooldown === 0, null, 15000);
    const at = (await p.evaluate(() => window.__home.state().triboo.at));
    await p.mouse.move(at.x, at.y);
    await p.waitForTimeout(350);
    await p.mouse.click(at.x, at.y);
    await until(p, '领券窗口', () => window.__home.state().card.shown, null, 8000);
    await p.waitForTimeout(1100);
    await shot('coupon');
    await p.keyboard.press('Escape');
    await until(p, '领券窗口关掉', () => !window.__home.state().card.open && document.querySelector('#app > .coupon-layer')?.hidden === true, null, 5000);
    await p.mouse.move(W / 2, 20);
  });
  await step('create', async () => {
    if (!want('create-name') && !want('create-look') && !want('create-crew') && !want('create-launch')) return;
    await p.locator('.topbar .tb-create').click();
    await until(p, '造星窗口', () => window.__create?.state().open && window.__create.state().previewReady, null, 60000);
    await p.waitForTimeout(900);
    await shot('create-name');
    await p.locator('#cp-name').fill('Quiet Comets');
    await p.locator('#cp-motto').fill('We chart the slow stars.');
    await p.locator('.cp-next').click();
    await until(p, '第二步', () => window.__create.state().step === 'look');
    await p.waitForTimeout(900);
    await shot('create-look');
    if (want('create-crew') || want('create-launch')) {
      await p.locator('.cp-next').click();
      await until(p, '第三步', () => window.__create.state().step === 'crew');
      await p.locator('#cp-friend').fill('Nova');
      await p.locator('#cp-friend').press('Enter');
      await p.waitForTimeout(800);
      await shot('create-crew');
      await p.locator('.cp-next').click();
      await until(p, '第四步', () => window.__create.state().step === 'launch');
      await p.waitForTimeout(800);
      await shot('create-launch');
    }
    await p.keyboard.press('Escape');
    await until(p, '造星窗口关掉', () => !window.__create.state().open && location.hash === '#/', null, 8000);
    await p.waitForTimeout(600);
  });
  await step('planet', async () => {
    await p.locator('.topbar .tb-visit').click();
    await until(p, '你的星球', () => !!document.querySelector('#app')?.dataset.planetReady && window.__app.routeIdle(), null, 90000);
    await p.waitForTimeout(1800);
    await shot('planet');
    if (want('label') || want('workcard')) {
      const at = await p.evaluate(() => {
        for (const id of window.__app.placedIds()) {
          const q = window.__app.workScreenPos(id);
          if (q && q.x > 80 && q.x < innerWidth - 80 && q.y > 150 && q.y < innerHeight - 90) return q;
        }
        return null;
      });
      if (at) {
        await p.mouse.move(at.x, at.y, { steps: 4 });
        await p.waitForTimeout(700);
        await shot('label');
        await p.mouse.click(at.x, at.y);
        await p.waitForTimeout(900);
        await shot('workcard');
        await p.locator('.work-card .wc-close').click().catch(() => {});
        await p.mouse.move(W / 2, 20);
        await p.waitForTimeout(400);
      }
    }
  });
  await step('members', async () => {
    await p.getByRole('button', { name: 'Members', exact: true }).click();
    await until(p, 'Members', () => document.querySelector('.sheet.members')?.hidden === false && window.__app.routeIdle());
    await p.waitForTimeout(1500);
    await shot('members');
    if (want('members-back')) {
      await p.locator('.sheet.members .mcard-hit').first().click();
      await p.waitForTimeout(1000);
      await shot('members-back');
    }
  });
  await step('museum', async () => {
    await p.getByRole('button', { name: 'Museum', exact: true }).click();
    await until(p, 'Museum', () => document.querySelector('section.museum')?.dataset.ready === 'true' && document.querySelector('.sheet.members')?.hidden === true, null, 60000);
    await p.waitForTimeout(1400);
    await shot('museum');
  });
  await step('viewer', async () => {
    await p.locator('.museum-card').first().click();
    await until(p, '查看器', () => !!document.querySelector('.viewer-stage.ready') && window.__app.routeIdle(), null, 60000);
    await p.waitForTimeout(1200);
    await shot('viewer');
    await p.keyboard.press('Escape');
    await until(p, '查看器关掉', () => document.querySelector('.viewer')?.hidden === true, null, 5000);
    await p.keyboard.press('Escape');
    await until(p, 'Museum 关掉', () => document.querySelector('section.museum')?.hidden === true, null, 5000);
    await p.waitForTimeout(800);
  });
  await step('toast', async () => {
    if (!want('toast')) return;
    // 地址里的作品不在这个 Museum：Museum 打开、底部一条提示条
    await p.evaluate(() => { location.hash = `#/t/${location.hash.split('/')[2]}/museum/nope`; });
    await until(p, '提示条', () => !!document.querySelector('#app > .toast.show'), null, 15000);
    await p.waitForTimeout(700);
    await shot('toast');
    await p.keyboard.press('Escape');
    await until(p, 'Museum 关掉', () => document.querySelector('section.museum')?.hidden === true, null, 5000);
    await p.waitForTimeout(600);
  });
  await step('edit', async () => {
    if (!want('edit')) return;
    await p.locator('.topbar button.primary').click();
    await until(p, '编辑', () => document.querySelector('.tray')?.hidden === false);
    await p.waitForTimeout(1200);
    const pos = await p.evaluate(() => {
      const id = window.__app.placedIds()[0];
      return id ? window.__app.workScreenPos(id) : null;
    });
    if (pos) {
      await p.mouse.click(pos.x, pos.y);
      await p.waitForTimeout(700);
    }
    await shot('edit');
    await p.keyboard.press('Escape');
    await p.locator('.topbar button.primary').click();
    await p.waitForTimeout(800);
  });
  await step('walk', async () => {
    if (!want('walk')) return;
    await until(p, '角色', () => window.__walk?.state().ready === true, null, 60000);
    await p.locator('.topbar button.walk').click();
    await until(p, '漫游', () => window.__walk.state().phase === 'walk');
    await p.waitForTimeout(1800);
    await shot('walk');
    await p.keyboard.press('Escape');
  });
  await step('tune', async () => {
    if (!want('tune')) return;
    const t = await ctx.newPage();
    errors.push(watchErrors(t));
    await t.goto(`${base}/?nolocal&tune#/t/lumen-guild`);
    await until(t, '调参面板', () => window.__ready === true && document.querySelector('.tune-pane')?.hidden === false && !!document.querySelector('#app')?.dataset.planetReady, null, 90000);
    await t.waitForTimeout(1500);
    const file = join(OUT, `tune-${W}.png`);
    await t.screenshot({ path: file });
    log.push(file);
    await t.close();
  });
  await step('launch', async () => {
    if (!want('launch')) return;
    const l = await ctx.newPage();
    errors.push(watchErrors(l));
    await l.goto(`${base}/?nolocal#/create`);
    await until(l, '造星窗口', () => window.__ready === true && window.__create?.state().open && window.__create.state().previewReady, null, 90000);
    await l.locator('#cp-name').fill('Quiet Comets');
    for (const s of ['look', 'crew', 'launch']) {
      await l.locator('.cp-next').click();
      await until(l, s, (x) => window.__create.state().step === x, s);
    }
    await until(l, '替身备好', () => window.__create.state().twinReady, null, 30000);
    await l.locator('.cp-next').click();
    for (const [phase, wait] of [['charge', 380], ['burst', 140], ['settle', 260]]) {
      await l.waitForFunction((x) => window.__create.state().launch.phase === x, phase, { timeout: 30000, polling: 'raf' });
      await l.waitForTimeout(wait);
      const file = join(OUT, `launch-${phase}-${W}.png`);
      await l.screenshot({ path: file });
      log.push(file);
    }
    await l.close();
  });
  await step('focus', async () => {
    if (!want('focus')) return;
    const f = await ctx.newPage();
    errors.push(watchErrors(f));
    await f.goto(`${base}/?nolocal`);
    await until(f, '首页就绪', () => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, 90000);
    await until(f, '开场演完', () => !window.__home.state().intro, null, 20000);
    await f.waitForTimeout(800);
    // Tab 到「Visit your planet」截一张，再 Tab 到第一张名牌截一张
    for (let i = 0; i < 12 && !(await f.evaluate(() => document.activeElement?.classList.contains('tb-visit'))); i++) await f.keyboard.press('Tab');
    await f.waitForTimeout(400);
    await f.screenshot({ path: join(OUT, `focus-visit-${W}.png`) });
    for (let i = 0; i < 12 && !(await f.evaluate(() => document.activeElement?.classList.contains('planet-tag'))); i++) await f.keyboard.press('Tab');
    await f.waitForTimeout(700);
    await f.screenshot({ path: join(OUT, `focus-tag-${W}.png`) });
    log.push(join(OUT, `focus-visit-${W}.png`), join(OUT, `focus-tag-${W}.png`));
    await f.close();
  });
  await ctx.close();
}
const errs = errors.flat();
console.log(log.join('\n'));
if (errs.length) console.log(`页面错误 ${errs.length} 条：\n${errs.slice(0, 12).join('\n')}`);
await browser.close();
await server.close();

// 首页（星系视图，H2）的样张：node scripts/shot-home.mjs [输出目录]（默认 shots/home）
// 桌面 1440×900、手机竖屏 390×844 各一张首页；首页做完以后（有 window.__home 时）再加：悬停名牌、翠宝探头、领券窗口。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2；HEADED=1：有界面的 Chrome（无头模式可能拿不到 WebGPU）。
// 依赖缓存默认 .tmp/vite-home（VITE_CACHE_DIR 可改），不碰各个 worktree 共用的 node_modules/.vite
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? 'shots/home';
mkdirSync(out, { recursive: true });
const WEBGL2 = process.env.WEBGL2 === '1';
const TEAMS = Number(process.env.TEAMS ?? 0);
const ACTIVE = Number(process.env.ACTIVE ?? 0);
const tag = (WEBGL2 ? 'webgl2' : 'webgpu') + (TEAMS ? `-t${TEAMS}` : '') + (ACTIVE ? `-a${ACTIVE}` : '');
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const errors = [];

async function open(viewport, dpr) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  errors.push(watchErrors(page)); // 数组之后还会被填：最后再 flat
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  // TEAMS=n：团队数换成 n 个；ACTIVE=n：前 n 个团队都算建好了（看版式能不能跟着团队数、建好的数量变）。
  // 种子 JSON 模块换成改过的版本（不改 seed.json 本身）
  if (TEAMS || ACTIVE) await page.route(/\/src\/data\/seed\.json/, (route) => {
    const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
    if (TEAMS) seed.teams = seed.teams.slice(0, TEAMS);
    seed.teams.forEach((t, i) => { if (i < ACTIVE) t.status = 'active'; });
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: `export default ${JSON.stringify(seed)};` });
  });
  await page.goto(`${base}/?nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  // 开场的探头（旧版在星球后面，新版在右边缘）演完、名牌出场完
  await page.waitForFunction(() => !window.__trans?.state().peek && !(window.__home?.state().intro ?? false), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { ctx, page };
}

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

try {
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, 1);
    await frames(page);
    await page.screenshot({ path: join(out, `home-1440-${tag}.png`) });
    // ADD=1：运行时加一颗星球（「Create a planet」建好以后 World.addPlanet）：挪到一半、挪完各截一张
    if (process.env.ADD === '1') {
      await page.evaluate(() => {
        const w = window.__world;
        const src = [...w.planets.values()][0].team;
        w.addPlanet({ ...structuredClone(src), id: 'new-planet', name: 'Brand New Crew', status: 'active', color: '#e7799f' });
      });
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(out, `home-add-mid-${tag}.png`) });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: join(out, `home-add-${tag}.png`) });
    }
    const home = await page.evaluate(() => !!window.__home);
    if (home) {
      // 悬停「你的星球」：名牌弹出来、星球放大慢慢转
      const you = await page.evaluate(() => window.__home.state().you);
      const at = await page.evaluate((id) => window.__app.planetScreenPos(id), you);
      if (at) {
        await page.mouse.move(at.x, at.y);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(out, `home-hover-${tag}.png`) });
        await page.mouse.move(720, 120);
      }
      // 翠宝探头：指针靠近右边缘
      await page.waitForFunction(() => !!window.__home.state().triboo?.at, null, { timeout: 15000 }).catch(() => {});
      const t = await page.evaluate(() => window.__home.state().triboo?.at ?? null);
      if (t) {
        await page.mouse.move(t.x - 60, t.y);
        await page.waitForTimeout(1300);
        await page.screenshot({ path: join(out, `home-triboo-${tag}.png`) });
        await page.mouse.click(t.x, t.y);
        await page.waitForFunction(() => window.__home.state().card.open && window.__home.state().card.shown, null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(out, `home-claim-${tag}.png`) });
      }
    }
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ width: 390, height: 844 }, 2);
    await frames(page);
    await page.screenshot({ path: join(out, `home-390-${tag}.png`) });
    await ctx.close();
  }
} finally {
  const all = errors.flat();
  if (all.length) console.log(`页面错误：\n${all.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
  await server.close();
}

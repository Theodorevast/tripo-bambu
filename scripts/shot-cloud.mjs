// 首页「云里探头的翠宝」（H2）的样张：1440×900 和 390×844 各一组——云面鼓起来、探出来、停着（挥手那一下）。
// node scripts/shot-cloud.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/home-media/cloud）。
// WEBGL2=1：藏起 navigator.gpu 走 WebGL2；HEADED=1：有界面的 Chrome；TURN=90：先把镜头转 90° 再让它冒出来；MODE=guide：悬停时带路（指针停在星球上）。
// 用 window.__home.peekCloud() 叫它出来，时间停住（__trans.timeScale(0)）逐张往前走，每张的姿势确定
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/home-media/cloud';
mkdirSync(out, { recursive: true });
const tag = process.env.WEBGL2 === '1' ? 'webgl2' : 'webgpu';
const turn = Number(process.env.TURN ?? 0);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const errors = [];

const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => {
  let i = 0;
  const step = () => (++i >= k ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

// 时间停着往前走 seconds 秒（每帧 1/60）
const advance = async (page, seconds) => {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => window.__trans.advance(1 / 60));
    await frames(page, 1);
  }
  await frames(page, 2);
};

try {
  for (const [w, h, dpr] of [[1440, 900, 1], [390, 844, 2]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    errors.push(watchErrors(page));
    if (tag === 'webgl2') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    await page.goto(`${base}/?nolocal`);
    await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
    await page.waitForFunction(() => !(window.__home?.state().intro ?? false), null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => window.__home?.state().cloud?.ready === true, null, { timeout: 20000 });
    await page.mouse.move(w * 0.5, 12);
    if (turn) {
      await page.evaluate((deg) => {
        const wd = window.__world;
        const cam = wd.rig.camera;
        const t = wd.rig.controls.target;
        const off = cam.position.clone().sub(t);
        off.applyAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, (deg * Math.PI) / 180);
        cam.position.copy(t).add(off);
        wd.rig.controls.update();
      }, turn);
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(600);
    if (process.env.MODE === 'guide') {
      // 悬停时带路：指针停在几颗星球上（你的星球、外圈的一颗），翠宝从旁边冒出来指着它
      await page.evaluate(async () => { (await import('/src/fun/cloudPeek.ts')).CLOUD_PEEK.enabled = false; });
      const ids = await page.evaluate(() => {
        const s = window.__home.state();
        const shown = s.tags.filter((t) => t.shown && !t.you).map((t) => t.id);
        return [s.you, shown[shown.length - 1]].filter(Boolean);
      });
      await page.evaluate(() => window.__trans.timeScale(0));
      for (const id of ids) {
        const pos = await page.evaluate((i) => window.__app.planetScreenPos(i), id);
        await page.mouse.move(pos.x, pos.y);
        await advance(page, 2.2); // 停 0.6 秒 → 右下角那只缩走 → 鼓起来、探出来、指着、点头
        await page.screenshot({ path: join(out, `guide-${w}-${id}-${tag}.png`) });
        console.log(w, id, JSON.stringify(await page.evaluate(() => window.__home.state().cloud)));
        await page.mouse.move(w * 0.5, 12);
        await advance(page, 1.6); // 沉回去、合上
      }
      await page.evaluate(() => window.__trans.timeScale(1));
      await ctx.close();
      continue;
    }
    const ok = await page.evaluate(() => window.__home.peekCloud());
    if (!ok) throw new Error(`${w}×${h}: 云里的翠宝冒不出来（peekCloud 返回 false）`);
    await page.evaluate(() => window.__trans.timeScale(0));
    const name = (s) => join(out, `cloud-${w}-${turn ? `turn${turn}-` : ''}${s}-${tag}.png`);
    await advance(page, 0.5); // 右下角那只先缩走，云面鼓起来
    await page.screenshot({ path: name('1-bulge') });
    await advance(page, 0.45); // 正在探出来
    await page.screenshot({ path: name('2-rise') });
    await advance(page, 0.75); // 停着、左右看
    await page.screenshot({ path: name('3-look') });
    await advance(page, 1.05); // 挥手
    await page.screenshot({ path: name('4-wave') });
    console.log(w, JSON.stringify(await page.evaluate(() => window.__home.state().cloud)));
    await page.evaluate(() => window.__trans.timeScale(1));
    await ctx.close();
  }
} finally {
  const all = errors.flat();
  if (all.length) console.log(`页面错误：\n${all.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
  await server.close();
}

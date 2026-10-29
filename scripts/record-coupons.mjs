// 录屏（逐帧拼接）：点翠宝吐券、捡券展开卡片。时间停住（window.__trans.timeScale(0)），每帧往前走 1/60 秒再截图，
// 卡片的 Web Animations 也按同样的步子往前拨（它们走的是墙上时间），截完用 ffmpeg 拼成 60 帧的 MP4，再挑几张关键帧。
// 三段：spit-planet（星球视图点站桩翠宝）、pickup-card（捡一张券、卡片翻开、点 Copy code）、spit-walk（漫游时按 E）。
// node scripts/record-coupons.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/coupons-media）。WEBGL2=1 走 WebGL2
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/coupons-media';
const TMP = '.tmp/coupons-record';
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { server, base } = await startServer({ cacheDir: '.tmp/vite-coupons' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/${process.env.LOCAL === '0' ? '?nolocal' : ''}#/t/${team.id}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
await page.waitForFunction(() => window.__coupons?.state().ready && window.__coupons.state().stand.at, null, { timeout: 30000 });
await page.waitForTimeout(2500);
const state = () => page.evaluate(() => window.__coupons.state());

// 往前走一帧：3D 走 1/60 秒；Web Animations 第一次见到时从 0 开始，之后每帧 +1/60 秒
const step = () => page.evaluate(() => new Promise((resolve) => {
  window.__trans.advance(1 / 60);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const seen = (window.__stepped ??= new WeakSet());
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) {
        seen.add(a);
        a.pause();
        a.currentTime = 0;
      } else {
        a.currentTime = (Number(a.currentTime) || 0) + 1000 / 60;
      }
    }
    resolve();
  }));
}));

// 录一段：seconds 秒；at[帧号] = 这一帧之前要做的事（点、按键）；keys = { 名字: 帧号 } 存成关键帧
async function record(name, seconds, at = {}, keys = {}) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => window.__trans.timeScale(0));
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    if (at[i]) await at[i]();
    await step();
    await page.screenshot({ path: path.join(dir, `f-${String(i).padStart(4, '0')}.png`) });
  }
  await page.evaluate(() => {
    window.__trans.timeScale(1);
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
  });
  const out = path.join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
  for (const [label, frame] of Object.entries(keys)) copyFileSync(path.join(dir, `f-${String(frame).padStart(4, '0')}.png`), path.join(OUT, `${name}-${label}.png`));
  console.log(`${out}（${frames} 帧）`);
}

// —— 1. 星球视图：悬停一下、点站桩翠宝 ——
let s = await state();
const at = s.stand.at;
await record('spit-planet', 2.8, {
  1: () => page.mouse.move(at.x, at.y),
  20: () => page.mouse.click(at.x, at.y),
}, { hover: 16, charge: 34, spit: 42, fly: 60, land: 110, rest: 160 });

// —— 2. 捡一张券、卡片翻开、点 Copy code ——
await page.waitForTimeout(300);
s = await state();
const c = s.coupons.filter((x) => x.at && x.phase === 'rest').sort((a, b) => Math.abs(a.at.x - 720) - Math.abs(b.at.x - 720))[0];
await record('pickup-card', 2.4, {
  4: () => page.mouse.move(c.at.x, c.at.y),
  16: () => page.mouse.click(c.at.x, c.at.y),
  110: () => page.locator('.coupon-card .cc-copy').click(),
}, { hover: 14, lift: 24, fly: 36, arrive: 48, unfold: 62, open: 100, copied: 120 });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// —— 3. 漫游：按 E ——
await page.evaluate(() => window.__coupons.clear());
await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
await page.locator('.topbar button.walk').click();
await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
await page.waitForTimeout(1500);
await page.waitForFunction(() => window.__coupons.state().cooldown === 0, null, { timeout: 8000 });
await record('spit-walk', 3, {
  10: () => page.keyboard.press('e'),
}, { turn: 22, charge: 36, spit: 50, fly: 70, land: 120, rest: 175 });

console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
await browser.close();
await server.close();

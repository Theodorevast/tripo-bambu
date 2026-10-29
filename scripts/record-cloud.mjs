// 首页「云里探头的翠宝」（H2）的录屏（逐帧拼接，同 record-home.mjs）：首页 → 云面鼓起来、翠宝探出来、左右看、挥手
// → 指针移过去（手形光标、身子一缩）→ 点它（蓄力、弹起来吐券）→ 券飞到画面中间展开成领券窗口
// → 关掉窗口，再叫它出来，再点（冷却中：摇头）。
// 时间停住（window.__trans.timeScale(0)），每帧往前走 1/60 秒再截图；名牌、卡片的 Web Animations 也按同样的步子往前拨。
// node scripts/record-cloud.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/home-media/cloud）。
// WEBGL2=1 走 WebGL2；SIZE=390x844 录手机竖屏；SHAKE=0 不录后面摇头那一段
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/home-media/cloud';
const TMP = '.tmp/cloud-record';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const tag = `${W}x${H}${process.env.WEBGL2 === '1' ? '-webgl2' : ''}`;
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal`);
await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
await page.waitForFunction(() => window.__home?.state().cloud?.ready && !window.__home.state().intro, null, { timeout: 30000 });
await page.mouse.move(W * 0.5, 14);
await page.waitForTimeout(800);

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
  const out = path.join(OUT, `${name}-${tag}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out]);
  for (const [label, frame] of Object.entries(keys)) copyFileSync(path.join(dir, `f-${String(frame).padStart(4, '0')}.png`), path.join(OUT, `${name}-${tag}-${label}.png`));
  rmSync(dir, { recursive: true, force: true });
  console.log(`${out}（${frames} 帧）`);
}

const cloud = () => page.evaluate(() => window.__home.state().cloud);
const glide = (at, start, from, to, n) => {
  for (let i = 0; i < n; i++) at[start + i] = () => page.mouse.move(from.x + ((to.x - from.x) * (i + 1)) / n, from.y + ((to.y - from.y) * (i + 1)) / n);
};

// 冷却拉长到 30 秒（只在这一页）：第二段关掉窗口、再叫它出来的时候还在冷却中
await page.evaluate(async () => { (await import('/src/fun/couponsMath.ts')).COUPONS.cooldown = 30; });

// 第一段：冒出来 → 左右看 → 挥手 → 指针移过去 → 点 → 吐券 → 领券窗口展开
let target = null;
const at = {};
at[18] = async () => {
  if (!(await page.evaluate(() => window.__home.peekCloud()))) throw new Error('云里的翠宝冒不出来（peekCloud 返回 false）');
};
at[175] = async () => {
  target = (await cloud()).at;
  if (!target) throw new Error(`翠宝没露头：${JSON.stringify(await cloud())}`);
  // 指针从它左下方（空的云海上）移过去：从星球、名牌上面经过的话它会沉回去（指着星球时不露头）
  const from = { x: target.x - 140, y: Math.min(H - 12, target.y + 110) };
  await page.mouse.move(from.x, from.y);
  glide(at, 176, from, target, 34);
};
at[222] = () => page.mouse.click(target.x, target.y);
await record('cloud-claim', 6.4, at, { bulge: 32, rise: 62, look: 110, wave: 168, hover: 214, charge: 232, spit: 244, fly: 262, open: 330 });
const card = await page.evaluate(() => window.__home.state().card);
console.log(`领券窗口：${JSON.stringify(card)}`);

// 第二段：关掉窗口，再叫它出来，冷却中点它：摇头
if (process.env.SHAKE !== '0') {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__home.state().card.open, null, { timeout: 8000 });
  await page.mouse.move(W * 0.5, 14);
  await page.waitForTimeout(1500);
  const at2 = {};
  let t2 = null;
  at2[6] = async () => {
    if (!(await page.evaluate(() => window.__home.peekCloud()))) throw new Error('第二次冒不出来');
  };
  at2[80] = async () => {
    t2 = (await cloud()).at;
    if (!t2) throw new Error(`翠宝没露头：${JSON.stringify(await cloud())}`);
    const from2 = { x: t2.x - 140, y: Math.min(H - 12, t2.y + 110) };
    await page.mouse.move(from2.x, from2.y);
    glide(at2, 81, from2, t2, 20);
  };
  at2[108] = () => page.mouse.click(t2.x, t2.y);
  await record('cloud-cooldown', 3.4, at2, { shake: 130 });
  console.log(`冷却中点了以后：${JSON.stringify(await cloud())}`);
}
console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
await browser.close();
await server.close();

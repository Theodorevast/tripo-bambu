// 首页（H2）的操作录屏（逐帧拼接，同 record-coupons.mjs）：首页 → 指针靠近右下角的翠宝（探出来挥手）→ 点它（蓄力、弹起来吐券）
// → 券飞到画面中间展开成领券窗口 → 点「Claim on Tripo」（新标签页打开 tripo3d.ai：这里拦下来，回一个空页面）。
// 时间停住（window.__trans.timeScale(0)），每帧往前走 1/60 秒再截图；名牌、卡片的 Web Animations 也按同样的步子往前拨。
// 截完用 ffmpeg 拼成 60 帧的 MP4，再挑几张关键帧。
// node scripts/record-home.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/home-media）。WEBGL2=1 走 WebGL2；SIZE=390x844 录手机竖屏
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/home-media';
const TMP = '.tmp/home-record';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const tag = `${W}x${H}${process.env.WEBGL2 === '1' ? '-webgl2' : ''}`;
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal`);
await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
await page.waitForFunction(() => window.__home?.state().triboo?.ready && !window.__home.state().intro && window.__home.state().triboo.at, null, { timeout: 30000 });
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

const t = (await page.evaluate(() => window.__home.state().triboo)).at;
let claimAt = null;
let popup = null;
ctx.on('page', (p) => { popup = p; }); // 逐帧录得慢（一帧一张截图），不用 waitForEvent 的超时
// 首页停一下 → 指针从画面中间慢慢移到翠宝附近（探出来挥手）→ 悬停 → 点 → 吐券、券飞过来、窗口展开 → 指到 Claim on Tripo → 点
const glide = (from, to, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, () => page.mouse.move(from.x + ((to.x - from.x) * (i + 1)) / n, from.y + ((to.y - from.y) * (i + 1)) / n)]));
const moves = glide({ x: W * 0.55, y: H * 0.6 }, { x: t.x - 70, y: t.y - 10 }, 30);
const at = {};
for (const [k, fn] of Object.entries(moves)) at[Number(k) + 30] = fn;
at[95] = () => page.mouse.move(t.x, t.y);
at[110] = () => page.mouse.click(t.x, t.y);
at[215] = async () => {
  const box = await page.locator('.coupon-card .cc-claim').boundingBox();
  claimAt = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: W / 2, y: H / 2 };
  await page.mouse.move(claimAt.x, claimAt.y);
};
at[250] = () => page.mouse.click(claimAt.x, claimAt.y);
await record('home-claim', 4.8, at, { home: 20, wave: 80, hover: 104, charge: 122, spit: 132, fly: 145, unfold: 168, open: 210, claim: 252 });
for (let i = 0; i < 50 && !popup; i++) await page.waitForTimeout(100);
if (popup) await popup.waitForLoadState().catch(() => {});
console.log(popup ? `Claim on Tripo 打开了新标签页：${popup.url()}` : '没有打开新标签页');
const card = await page.evaluate(() => window.__home.state().card);
console.log(`领券窗口：${JSON.stringify(card)}`);
console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
await browser.close();
await server.close();

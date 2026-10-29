// 界面（U1）的样张、慢放胶片条和一段操作录屏：node scripts/shot-ui.mjs [输出目录]（默认 shots/ui）
// 样张（1440×900）：调参面板展开 / 收起 / 抽屉 / 复制成功、Members、悬停倾斜、翻面、Museum、悬停、查看器；手机竖屏（390×844）几张
// 胶片条：用 CDP 把页面上所有 CSS / WAAPI 动画放慢 10 倍（Animation.setPlaybackRate，3D 画面不受影响），
//   按动画时间截几帧拼成一张：面板收起 → 展开、Members 进场、Museum 进场、卡片放大成查看器、查看器缩回卡片
// 录屏：1280×800，大约 12 秒走一遍（Playwright recordVideo）；装了 ffmpeg 时剪掉前面加载的那段、转成 mp4，没装就留原始的 webm
// 依赖缓存默认用 .tmp/vite-ui（VITE_CACHE_DIR 可改），不碰各个 worktree 共用的 node_modules/.vite
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? 'shots/ui';
mkdirSync(out, { recursive: true });
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-ui' });
const browser = await launch();
const errors = [];
const URL0 = `${base}/?nolocal&tune#/t/lumen-guild`;
const SLOW = 0.1;

async function openPage(ctxOpts, prep) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  errors.push(watchErrors(page));
  await page.addInitScript((s) => { localStorage.setItem('community-planets:tune', JSON.stringify(s)); }, prep ?? { collapsed: false });
  await page.goto(URL0);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === 'lumen-guild', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  return { ctx, page };
}

// 慢放：动画时间 times（毫秒）各截一帧，拼成 3 列的胶片条，每格左上角写上时间
async function film(page, name, start, times, clip) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW });
  const t0 = Date.now();
  await start();
  const frames = [];
  for (const t of times) {
    const wait = t / SLOW - (Date.now() - t0);
    if (wait > 0) await page.waitForTimeout(wait);
    frames.push([t, await page.screenshot({ clip })]);
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  await cdp.detach();
  const w = 720;
  const h = Math.round((clip?.height ?? 900) * (w / (clip?.width ?? 1440)));
  const cols = 3;
  const rows = Math.ceil(frames.length / cols);
  const tiles = await Promise.all(frames.map(async ([t, buf], i) => {
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="34"><rect width="150" height="34" rx="10" fill="#4a4058"/><text x="14" y="23" font-family="Nunito, sans-serif" font-size="17" font-weight="800" fill="#fbf5e8">t = ${t} ms</text></svg>`);
    const img = await sharp(buf).resize({ width: w, height: h }).composite([{ input: label, left: 10, top: 10 }]).toBuffer();
    return { input: img, left: (i % cols) * (w + 8), top: Math.floor(i / cols) * (h + 8) };
  }));
  await sharp({ create: { width: cols * w + (cols - 1) * 8, height: rows * h + (rows - 1) * 8, channels: 3, background: '#2d2734' } }).composite(tiles).png().toFile(join(out, `film-${name}.png`));
  console.log(`film-${name}.png`);
}

try {
  // —— 桌面样张 + 胶片条 ——
  {
    const { ctx, page } = await openPage({ viewport: { width: 1440, height: 900 } });
    const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) }).then(() => console.log(`${name}.png`));
    await shot('tune-expanded');
    await page.locator('.tune-page:not([hidden]) > .tp-rotv > .tp-rotv_c > .tp-fldv > .tp-fldv_b').nth(1).click();
    await page.waitForTimeout(700);
    await shot('tune-drawer');
    await page.locator('.tune-tab').nth(4).click();
    await page.waitForTimeout(600);
    await page.locator('.tune-tab').nth(4).hover();
    await page.waitForTimeout(300);
    await shot('tune-sky-tab');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.tune-copy').click();
    await page.waitForTimeout(380);
    await shot('tune-copied');
    await page.waitForTimeout(2200);
    await page.locator('.tune-min').click();
    await page.waitForTimeout(900);
    await shot('tune-collapsed');
    await film(page, 'tune-expand', () => page.locator('.tune-fab').click(), [0, 60, 120, 200, 320, 600], { x: 960, y: 40, width: 480, height: 300 });
    await page.waitForTimeout(300);

    // Members：进场（慢放）→ 停好 → 悬停倾斜 → 翻面
    await film(page, 'members-enter', () => page.evaluate(() => { location.hash = '#/t/lumen-guild/members'; }), [0, 120, 240, 360, 520, 760, 1000, 1250, 1600]);
    await page.waitForTimeout(500);
    await shot('members');
    const card = page.locator('.member').nth(2);
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
    await page.waitForTimeout(500);
    await shot('members-hover');
    await card.locator('.mcard-hit').click();
    await page.waitForTimeout(250);
    await shot('members-flipping');
    await page.waitForTimeout(900);
    await shot('members-flipped');

    // Museum：进场（慢放；模型是 3D 的，不跟着慢放）→ 停好 → 悬停 → 卡片放大成查看器（慢放）→ 缩回卡片（慢放）
    await film(page, 'museum-enter', () => page.evaluate(() => { location.hash = '#/t/lumen-guild/museum'; }), [0, 120, 260, 420, 640, 900, 1200, 1500, 1900]);
    await page.waitForFunction(() => document.querySelector('section.museum')?.dataset.ready === 'true', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await shot('museum');
    await page.locator('.museum-card').nth(1).hover({ position: { x: 70, y: 70 } });
    await page.waitForTimeout(700);
    await shot('museum-hover');
    await page.mouse.move(700, 860);
    await page.waitForTimeout(500);
    await film(page, 'card-to-viewer', () => page.locator('.museum-card').nth(0).click(), [0, 50, 110, 180, 280, 420, 600, 850, 1200]);
    await page.waitForFunction(() => !!document.querySelector('.viewer-stage.ready'), null, { timeout: 60000 });
    await page.waitForTimeout(800);
    await shot('viewer');
    await film(page, 'viewer-to-card', () => page.keyboard.press('Escape'), [0, 60, 130, 220, 330, 450, 600]);
    await page.waitForTimeout(600);
    await ctx.close();
  }

  // —— 手机竖屏 ——
  {
    const { ctx, page } = await openPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { collapsed: true });
    const shot = (name) => page.screenshot({ path: join(out, `phone-${name}.png`) }).then(() => console.log(`phone-${name}.png`));
    await shot('planet');
    await page.locator('.tune-fab').tap();
    await page.waitForTimeout(900);
    await shot('tune');
    await page.locator('.tune-min').tap();
    await page.waitForTimeout(600);
    await page.evaluate(() => { location.hash = '#/t/lumen-guild/members'; });
    await page.waitForTimeout(1800);
    await shot('members');
    await page.locator('.member').nth(2).locator('.mcard-hit').tap();
    await page.waitForTimeout(1000);
    await shot('members-flipped');
    await page.evaluate(() => { location.hash = '#/t/lumen-guild/museum'; });
    await page.waitForFunction(() => document.querySelector('section.museum')?.dataset.ready === 'true', null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await shot('museum');
    await page.locator('.museum-card').nth(0).tap();
    await page.waitForFunction(() => !!document.querySelector('.viewer-stage.ready'), null, { timeout: 60000 });
    await page.waitForTimeout(900);
    await shot('viewer');
    await ctx.close();
  }

  // —— 录屏：大约 12 秒 ——
  {
    const dir = join(out, 'video-tmp');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
    const recordAt = Date.now();
    const page = await ctx.newPage();
    errors.push(watchErrors(page));
    await page.addInitScript(() => localStorage.setItem('community-planets:tune', JSON.stringify({ collapsed: false })));
    await page.goto(URL0);
    await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === 'lumen-guild', null, { timeout: 90000 });
    await page.waitForTimeout(800);
    const startAt = Date.now();
    const glide = async (x, y, steps = 14) => { await page.mouse.move(x, y, { steps }); };
    for (const i of [4, 6, 0]) {
      const t = await page.locator('.tune-tab').nth(i).boundingBox();
      await glide(t.x + t.width / 2, t.y + t.height / 2);
      await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
      await page.waitForTimeout(450);
    }
    const min = await page.locator('.tune-min').boundingBox();
    await glide(min.x + 16, min.y + 16);
    await page.mouse.click(min.x + 16, min.y + 16);
    await page.waitForTimeout(700);
    const fab = await page.locator('.tune-fab').boundingBox();
    await glide(fab.x + 26, fab.y + 26);
    await page.mouse.click(fab.x + 26, fab.y + 26);
    await page.waitForTimeout(700);
    const mb = await page.getByRole('button', { name: 'Members', exact: true }).boundingBox();
    await glide(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await page.waitForTimeout(1500);
    const c = await page.locator('.member').nth(1).boundingBox();
    await glide(c.x + 30, c.y + 40, 10);
    await glide(c.x + c.width - 30, c.y + c.height - 50, 24);
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    await page.waitForTimeout(1100);
    const mu = await page.getByRole('button', { name: 'Museum', exact: true }).boundingBox();
    await glide(mu.x + mu.width / 2, mu.y + mu.height / 2);
    await page.mouse.click(mu.x + mu.width / 2, mu.y + mu.height / 2);
    await page.waitForFunction(() => document.querySelector('section.museum')?.dataset.ready === 'true', null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const k = await page.locator('.museum-card').nth(2).boundingBox();
    await glide(k.x + 40, k.y + 50, 10);
    await glide(k.x + k.width - 40, k.y + k.height / 2, 18);
    await page.waitForTimeout(300);
    await page.mouse.click(k.x + k.width / 2, k.y + k.height / 2);
    await page.waitForTimeout(1600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    console.log(`录屏操作 ${((Date.now() - startAt) / 1000).toFixed(1)} 秒（片头是页面加载）`);
    const video = page.video();
    await ctx.close();
    const raw = join(out, 'ui-tour-raw.webm');
    renameSync(await video.path(), raw);
    rmSync(dir, { recursive: true, force: true });
    const skip = Math.max(0, (startAt - recordAt) / 1000 - 0.4).toFixed(2);
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip, '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-an', join(out, 'ui-tour.mp4')]);
    if (ff.status === 0) {
      rmSync(raw);
      console.log(`ui-tour.mp4（剪掉前面 ${skip} 秒加载）`);
    } else console.log(`没有 ffmpeg（或转码失败），留下原始录屏 ui-tour-raw.webm：${String(ff.error ?? ff.stderr)}`);
  }
  const all = errors.flat();
  console.log(all.length ? `页面报错：${all.join(' | ')}` : '页面没有报错');
} finally {
  await browser.close();
  await server.close();
}

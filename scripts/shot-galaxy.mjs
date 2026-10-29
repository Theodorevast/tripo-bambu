// 首页螺旋星系（H2）的样张：正面、侧面（转 90°）、背面（转 180°）、俯视（最高仰角）四张，1440×900 和 390×844 各一组。
// node scripts/shot-galaxy.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/home-media/spiral）。
// WEBGL2=1：藏起 navigator.gpu 走 WebGL2；HEADED=1：有界面的 Chrome。截图时停掉星系的慢慢自转（每张角度确定）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/home-media/spiral';
mkdirSync(out, { recursive: true });
const tag = process.env.WEBGL2 === '1' ? 'webgl2' : 'webgpu';
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await launch();
const errors = [];

// 把镜头绕星系中心转到方位角 turn 度（0 = 正面）、仰角 elevation 度（null = 默认取景的仰角）
const view = (page, turn, elevation) => page.evaluate(([turnDeg, el]) => {
  const w = window.__world;
  const cam = w.rig.camera;
  const t = w.rig.controls.target;
  const off = cam.position.clone().sub(t);
  const dist = off.length();
  const cur = Math.asin(off.y / dist);
  const elev = el === null ? cur : (el * Math.PI) / 180;
  const az = (turnDeg * Math.PI) / 180;
  cam.position.set(t.x + Math.sin(az) * Math.cos(elev) * dist, t.y + Math.sin(elev) * dist, t.z + Math.cos(az) * Math.cos(elev) * dist);
  w.rig.controls.update();
}, [turn, elevation]);

const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => {
  let i = 0;
  const step = () => (++i >= k ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

try {
  for (const [w, h, dpr] of [[1440, 900, 1], [390, 844, 2]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    errors.push(watchErrors(page));
    if (tag === 'webgl2') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    await page.goto(`${base}/?nolocal`);
    await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
    await page.waitForFunction(() => !(window.__home?.state().intro ?? false), null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => {
      const { SHOTS } = await import('/src/scenes/shots.ts');
      SHOTS.galaxy.spin = 0;
    });
    await page.mouse.move(w * 0.5, 20);
    await page.waitForTimeout(800);
    const maxEl = await page.evaluate(async () => (await import('/src/scenes/shots.ts')).SHOTS.galaxy.maxElevation);
    for (const [name, turn, el] of [['front', 0, null], ['side', 90, null], ['back', 180, null], ['top', 0, maxEl]]) {
      await view(page, turn, el);
      await frames(page, 4);
      await page.waitForTimeout(700); // 名牌淡入淡出
      await page.screenshot({ path: join(out, `galaxy-${w}-${name}-${tag}.png`) });
    }
    await ctx.close();
  }
} finally {
  const all = errors.flat();
  if (all.length) console.log(`页面错误：\n${all.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
  await server.close();
}

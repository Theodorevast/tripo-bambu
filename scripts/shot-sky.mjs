// 天空、光照、后期（v2-sky）的样张：1440×900（像素比 1）和 390×844（像素比 2）各一组：
//   home-front / home-side（首页正面、侧面转 90°）、home-low（首页压到最低仰角，看得到地平线和夜空）、
//   enter-mid（星系进星球的穿云转场正中间那一帧）、planet-<预设>（星球视图，每个天空预设一张）、hop-mid（跳星球时扫过的那道光）。
// node scripts/shot-sky.mjs [输出目录] [--sky blue,moon] [--only 1440,390]。WEBGL2=1：走 WebGL2；HEADED=1：有界面的 Chrome
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const valued = new Set(['--sky', '--only']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const out = positional[0] ?? '.superpowers/sdd/2026-10-30-v2/sky-media';
const skies = opt('--sky', 'blue,moon').split(',');
const only = opt('--only', '1440,390').split(',');
mkdirSync(out, { recursive: true });
const tag = process.env.WEBGL2 === '1' ? 'webgl2' : 'webgpu';
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const other = seed.teams.find((t) => t.id !== you.id && t.works.length > 0);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-sky' });
const browser = await launch();
const errors = [];

const frames = (page, n = 3) => page.evaluate((k) => new Promise((r) => {
  let i = 0;
  const step = () => (++i >= k ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

// 把镜头绕环绕中心转到方位角 turn 度、仰角 elevation 度（null = 现在的仰角）
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

// 时间停住、逐帧往前走 seconds 秒（转场的中间帧）
const stepFor = async (page, seconds) => {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => { window.__trans.advance(1 / 60); requestAnimationFrame(() => requestAnimationFrame(r)); }));
};

const planetReady = (page, id) => page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, id, { timeout: 90000 });

try {
  for (const [w, h, dpr] of [[1440, 900, 1], [390, 844, 2]]) {
    if (!only.includes(String(w))) continue;
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
    await page.waitForTimeout(1200);
    const minEl = await page.evaluate(async () => (await import('/src/scenes/shots.ts')).SHOTS.galaxy.minElevation);
    for (const [name, turn, el] of [['home-front', 0, null], ['home-side', 90, null], ['home-low', 0, minEl]]) {
      await view(page, turn, el);
      await frames(page, 4);
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `${name}-${w}-${tag}.png`) });
    }
    await view(page, 0, null);
    await frames(page, 4);
    // 穿云：走到云层正浓的时候（进星球 1.55 秒，云在 0.52 全遮住、0.6 开始散）
    await page.evaluate(() => window.__trans.timeScale(0));
    await page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id);
    await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
    await stepFor(page, 1.55 * 0.47);
    await page.screenshot({ path: join(out, `enter-mid-${w}-${tag}.png`) });
    await stepFor(page, 1.55 * 0.08);
    await page.screenshot({ path: join(out, `enter-full-${w}-${tag}.png`) });
    await page.evaluate(() => window.__trans.timeScale(1));
    await planetReady(page, you.id);
    await page.waitForTimeout(2500);
    for (const sky of skies) {
      await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
      await page.waitForTimeout(2600);
      await page.screenshot({ path: join(out, `planet-${sky}-${w}-${tag}.png`) });
    }
    await page.evaluate((s) => window.__world.setSkyPreset(s), skies[0]);
    await page.waitForTimeout(2300);
    // 跳星球：走到那道光扫过的时候（跳星球 1.4 秒，光在 0.4）
    await page.evaluate(() => window.__trans.timeScale(0));
    await page.evaluate((id) => { location.hash = `#/t/${id}`; }, other.id);
    await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
    await stepFor(page, 1.4 * 0.42);
    await page.screenshot({ path: join(out, `hop-mid-${w}-${tag}.png`) });
    await page.evaluate(() => window.__trans.timeScale(1));
    await planetReady(page, other.id);
    await ctx.close();
  }
} finally {
  const all = errors.flat();
  if (all.length) console.log(`页面错误：\n${all.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
  await server.close();
}

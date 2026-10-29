// coupons 的 GPU 开销：1440×900、像素比 2（画布 2880×1800），星球视图里量每帧的 GPU 时间（同 perf-gpu.mjs 的做法：
// ?gputime 打开渲染器的时间戳查询，每帧把所有渲染加起来）。四种情况：
//   1. 没有站桩翠宝、没有券（藏起翠宝） 2. 站桩翠宝 3. 翠宝 + 地上 5 张券（发光的光斑、偶尔的小星星） 4. 吐券的那两秒（彩屑在飞）
// 差值就是这一块占的 GPU 时间。node scripts/perf-coupons.mjs [--webgl2] [--frames 180]
// --webgl2 要开有界面的 Chrome（HEADED=1）：无头模式下 ANGLE 的计时查询拿不到结果，脚本会一直等（实测 400 秒没跑完）
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const frames = Number(args[args.indexOf('--frames') + 1] || 180);
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);

const { server, base } = await startServer({ cacheDir: '.tmp/vite-coupons' });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

const measure = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  const calls = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        calls.push(w.renderer.info.render.drawCalls);
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((ms) => { pending--; if (typeof ms === 'number' && ms > 0) gpu.push(ms); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), max: Math.max(...gpu), samples: gpu.length, calls: pct(calls, 0.5) };
}, n);

// 站桩翠宝：星球组里名叫 walker 的那个（星球视图里漫游的角色不在场景里）
const setStand = (on) => page.evaluate((v) => {
  window.__world.focused.planet.group.traverse((o) => { if (o.name === 'walker') o.visible = v; });
}, on);

await page.goto(`${base}/?gputime&nolocal#/t/${team.id}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
await page.waitForFunction(() => window.__coupons?.state().ready && window.__coupons.state().stand.at, null, { timeout: 30000 });
await page.waitForTimeout(3000);
const backend = await page.evaluate(() => window.__app.backend());
// renderer.info 的绘制调用在后处理那一串 render() 里每次清零，数不到场景那一遍，这里不报
const fmt = (r) => `GPU p50 ${r.p50.toFixed(3)} ms，p95 ${r.p95.toFixed(3)} ms（${r.samples} 帧）`;

await setStand(false);
await page.waitForTimeout(300);
const none = await measure(frames);
await setStand(true);
await page.waitForTimeout(300);
const stand = await measure(frames);
// 吐 5 张：吐的那两秒量一次，落地以后量一次（券浮 10 秒）
await page.evaluate(async () => {
  const { COUPONS } = await import('/src/fun/couponsMath.ts');
  COUPONS.countMin = 5;
  COUPONS.countMax = 5;
});
const at = (await page.evaluate(() => window.__coupons.state())).stand.at;
await page.mouse.click(at.x, at.y);
const spit = await measure(110);
await page.waitForFunction(() => window.__coupons.state().coupons.filter((c) => c.phase === 'rest').length >= 5, null, { timeout: 8000 });
const rest = await measure(Math.min(frames, 300));

console.log(`backend: ${backend}，画布 2880×1800`);
console.log(`1. 没有站桩翠宝、没有券：${fmt(none)}`);
console.log(`2. 站桩翠宝：${fmt(stand)}  → 翠宝 +${(stand.p50 - none.p50).toFixed(3)} ms`);
console.log(`3. 翠宝 + 地上 5 张券：${fmt(rest)}  → 券 +${(rest.p50 - stand.p50).toFixed(3)} ms`);
console.log(`4. 吐券那两秒（彩屑在飞）：${fmt(spit)}，最长 ${spit.max.toFixed(3)} ms`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
await browser.close();
await server.close();

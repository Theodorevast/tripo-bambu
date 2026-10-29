// 夜空、后期（v2-sky）的性能：1440×900、像素比 2（画布 2880×1800）。
//   1. 首页静止 4 秒：帧间隔（中位、p95、最长、超过 33 ms 的帧数）
//   2. 首页每帧 GPU 时间：白天预设、关泛光（≈ 第一版）→ 蓝调时刻、关泛光（夜空多出来的）→ 蓝调时刻 + 泛光 + 颗粒（后期多出来的）
//   3. 进星球（穿云）、跳星球的最长帧间隔
//   4. 星球页每帧 GPU 时间：白天 / 蓝调时刻 / 月夜，泛光开关
// GPU 时间用 ?gputime 的时间戳查询（每帧所有渲染加起来）。node scripts/perf-sky.mjs [--webgl2] [--frames 240]。
// --webgl2 要开有界面的 Chrome（HEADED=1）：无头模式下 ANGLE 的计时查询拿不到结果。LOCAL=1：本机的私有真实模型
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const frames = Number(args[args.indexOf('--frames') + 1] || 240);
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const other = seed.teams.find((t) => t.id !== you.id && t.works.length > 0);

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-sky' });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.addInitScript(() => {
  window.__rec = null;
  const tick = (t) => {
    const r = window.__rec;
    if (r) {
      r.frames.push(t - r.last);
      r.last = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const startRec = () => page.evaluate(() => { window.__rec = { frames: [], last: performance.now() }; });
const stopRec = () => page.evaluate(() => { const r = window.__rec; window.__rec = null; return r.frames.slice(1); });
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const frameLine = (name, f) => `${name}：${f.length} 帧，中位 ${pct(f, 0.5).toFixed(1)} ms，p95 ${pct(f, 0.95).toFixed(1)} ms，最长 ${Math.max(...f).toFixed(1)} ms，超过 33 ms 的 ${f.filter((x) => x > 33.4).length} 帧`;

const gpu = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const ms = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((v) => { pending--; if (typeof v === 'number' && v > 0) ms.push(v); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  const p = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : NaN);
  return { p50: p(ms, 0.5), p95: p(ms, 0.95), samples: ms.length };
}, n);
const fmt = (r) => `p50 ${r.p50.toFixed(3)} ms，p95 ${r.p95.toFixed(3)} ms（${r.samples} 帧）`;

// 换预设、开关泛光和颗粒、空气里的星屑（NIGHT_SKY 表）
const setup = (preset, post, dust = post) => page.evaluate(async ([p, on, d]) => {
  const { NIGHT_SKY } = await import('/src/nature/nightSky.ts');
  window.__skySaved ??= { bloom: NIGHT_SKY.bloom, grain: NIGHT_SKY.grain, dust: NIGHT_SKY.dust };
  NIGHT_SKY.bloom = on ? window.__skySaved.bloom : 0;
  NIGHT_SKY.grain = on ? window.__skySaved.grain : 0;
  NIGHT_SKY.dust = d ? window.__skySaved.dust : 0;
  window.__world.setSkyPreset(p);
}, [preset, post, dust]);
// 同一组配置轮流量 ROUNDS 遍、取每组 p50 的中位数：同一台机器上别的进程也在用 GPU，单量一次起伏很大
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const measureAll = async (title, configs) => {
  const runs = configs.map(() => []);
  for (let k = 0; k < ROUNDS; k++) {
    for (let i = 0; i < configs.length; i++) {
      const [, preset, post, dust] = configs[i];
      await setup(preset, post, dust ?? post);
      await page.waitForTimeout(2600);
      runs[i].push(await gpu(frames));
    }
  }
  console.log(`${title}（每组 ${ROUNDS} 遍 × ${frames} 帧，取 p50 的中位数）：`);
  return configs.map(([label], i) => {
    const r = { p50: median(runs[i].map((x) => x.p50)), p95: median(runs[i].map((x) => x.p95)), samples: runs[i].reduce((n, x) => n + x.samples, 0) };
    console.log(`  ${label}：${fmt(r)}（各遍 p50：${runs[i].map((x) => x.p50.toFixed(3)).join(' / ')}）`);
    return r;
  });
};

try {
  await page.goto(`${base}/?gputime${process.env.LOCAL === '1' ? '' : '&nolocal'}`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForFunction(() => !(window.__home?.state().intro ?? false), null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(async () => {
    const { HOME_TRIBOO } = await import('/src/fun/homeTribooMath.ts');
    Object.assign(HOME_TRIBOO, { peekMin: 999, peekMax: 999 });
  });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(2500);
  const backend = await page.evaluate(() => window.__app.backend());
  console.log(`backend: ${backend}，画布 2880×1800（1440×900 × 2）`);

  await startRec();
  await page.waitForTimeout(4000);
  console.log(frameLine('首页静止 4 秒（默认：蓝调时刻 + 后期）', await stopRec()));

  const [h0, h1, h1b, h2] = await measureAll('首页 GPU', [
    ['a. 白天、关泛光、颗粒、星屑（≈ 第一版）', 'day', false],
    ['b. 蓝调时刻（夜空），关泛光、颗粒、星屑', 'blue', false],
    ['c. 蓝调时刻 + 空气里的星屑', 'blue', false, true],
    ['d. 蓝调时刻 + 星屑 + 泛光 + 颗粒（默认）', 'blue', true],
  ]);
  console.log(`  → 夜空 +${(h1.p50 - h0.p50).toFixed(3)} ms，星屑 +${(h1b.p50 - h1.p50).toFixed(3)} ms，后期 +${(h2.p50 - h1b.p50).toFixed(3)} ms，合计 +${(h2.p50 - h0.p50).toFixed(3)} ms`);

  // 进星球、跳星球：最长帧间隔
  await startRec();
  await page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id);
  await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
  await page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, you.id, { timeout: 90000 });
  await page.waitForTimeout(500);
  console.log(frameLine(`进星球（星系 → ${you.id}）`, await stopRec()));
  await page.waitForTimeout(1500);
  const [p0, p1, p2, p3] = await measureAll('星球页 GPU', [
    ['a. 白天、关泛光和颗粒（≈ 第一版）', 'day', false],
    ['b. 蓝调时刻、关泛光和颗粒', 'blue', false],
    ['c. 蓝调时刻 + 泛光 + 颗粒（默认）', 'blue', true],
    ['d. 月夜 + 泛光 + 颗粒', 'moon', true],
  ]);
  console.log(`  → 夜空 +${(p1.p50 - p0.p50).toFixed(3)} ms，后期 +${(p2.p50 - p1.p50).toFixed(3)} ms，合计 +${(p2.p50 - p0.p50).toFixed(3)} ms（月夜合计 +${(p3.p50 - p0.p50).toFixed(3)} ms）`);
  await setup('blue', true);
  await page.waitForTimeout(2600);
  // 转场的云层（含金线、月光银边）：时间停在跳星球的金线扫过时，量 GPU（逐帧往前走 0 秒，画面不动）
  if (process.env.FROZEN === '1') {
    await page.evaluate(() => window.__trans.timeScale(0));
    await page.evaluate((id) => { location.hash = `#/t/${id}`; }, other.id);
    await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
    for (let i = 0; i < Math.round(1.4 * 0.443 * 60); i++) await page.evaluate(() => new Promise((r) => { window.__trans.advance(1 / 60); requestAnimationFrame(() => requestAnimationFrame(r)); }));
    const veil = await gpu(frames);
    console.log(`跳星球停在金线扫过的那一刻（云层全遮住）：GPU ${fmt(veil)}`);
    await page.evaluate(() => window.__trans.timeScale(1));
    await page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, other.id, { timeout: 90000 });
    await page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id);
    await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
    await page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, you.id, { timeout: 90000 });
    await page.waitForTimeout(1500);
  }
  await startRec();
  await page.evaluate((id) => { location.hash = `#/t/${id}`; }, other.id);
  await page.waitForFunction(() => !!window.__trans.state().transition, null, { timeout: 5000 });
  await page.waitForFunction((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, other.id, { timeout: 90000 });
  await page.waitForTimeout(500);
  console.log(frameLine(`跳星球（${you.id} → ${other.id}）`, await stopRec()));
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

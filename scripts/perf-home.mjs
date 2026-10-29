// 首页（H2）的性能：1440×900、像素比 2（画布 2880×1800）。
//   1. 首页静止 4 秒：帧间隔（中位、p95、最长、超过 33 ms 的帧数）——要求稳定 60 帧
//   2. 每帧 GPU 时间（?gputime：WebGPU 走 timestamp-query，WebGL2 走 EXT_disjoint_timer_query_webgl2；每帧所有渲染加起来）：
//      a. 翠宝藏起来 b. 翠宝露出来（平时的样子）c. 翠宝探出来挥手 —— 差值就是右下角翠宝多出来的 GPU 时间
//      d. 云海不放安静（calm = 0，原来的样子）：对比放安静以后省了多少
//   3. 第一次点翠宝：从点下去到领券窗口完全展开，最长帧间隔（要求 ≤ 33 ms）
//   4. 云里探头的翠宝：冒出来那一下、露着时的 GPU 时间、点它到领券窗口展开；悬停带路冒出来那一下（最长帧间隔都要求 ≤ 33 ms）
// node scripts/perf-home.mjs [--webgl2] [--frames 240] [--no-gpu]。--webgl2 要开有界面的 Chrome（HEADED=1）：无头模式下 ANGLE 的计时查询拿不到结果
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const webgl2 = args.includes('--webgl2');
const frames = Number(args[args.indexOf('--frames') + 1] || 240);
const noGpu = args.includes('--no-gpu'); // 只量帧间隔（不开 ?gputime）

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-home' });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
// 每帧记帧间隔（rAF），开页就开始
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
const log = (msg) => { if (process.env.VERBOSE === '1') console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); };
const fmt = (r) => `GPU p50 ${r.p50.toFixed(3)} ms，p95 ${r.p95.toFixed(3)} ms（${r.samples} 帧）`;
// 翠宝的参数（fun/homeTribooMath.ts 的 HOME_TRIBOO）：量的时候不让它自己探头
const setTriboo = (patch) => page.evaluate(async (p) => {
  const { HOME_TRIBOO } = await import('/src/fun/homeTribooMath.ts');
  Object.assign(HOME_TRIBOO, p);
}, patch);

try {
  await page.goto(`${base}/?${noGpu ? '' : 'gputime&'}nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForFunction(() => window.__home?.state().triboo?.ready && !window.__home.state().intro, null, { timeout: 30000 });
  await setTriboo({ peekMin: 999, peekMax: 999 });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1500);
  const backend = await page.evaluate(() => window.__app.backend());

  log('开页完成');
  // 1. 首页静止 4 秒
  await startRec();
  await page.waitForTimeout(4000);
  const idle = await stopRec();
  const idleLine = `首页静止 4 秒：${idle.length} 帧，中位 ${pct(idle, 0.5).toFixed(1)} ms，p95 ${pct(idle, 0.95).toFixed(1)} ms，最长 ${Math.max(...idle).toFixed(1)} ms，超过 33 ms 的 ${idle.filter((f) => f > 33.4).length} 帧`;

  // 2. GPU 时间
  const skip = { p50: NaN, p95: NaN, samples: 0 };
  let off = skip;
  let on = skip;
  let near = skip;
  let busy = skip;
  let calm = skip;
  if (!noGpu) {
  const hideSaved = await page.evaluate(async () => (await import('/src/fun/homeTribooMath.ts')).HOME_TRIBOO.hide);
  await setTriboo({ hide: -0.5 });
  await page.waitForTimeout(1200);
  log('a 翠宝藏起来');
  off = await gpu(frames);
  await setTriboo({ hide: hideSaved });
  await page.waitForTimeout(1200);
  log('b 翠宝露出来');
  on = await gpu(frames);
  // 探出来挥手：指针靠近
  const at = (await page.evaluate(() => window.__home.state().triboo)).at;
  await page.mouse.move(at.x - 80, at.y);
  await page.waitForTimeout(1200);
  log('c 翠宝挥手');
  near = await gpu(frames);
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
  // 云海不放安静（原来的样子）
  await page.evaluate(async () => {
    const { SKY } = await import('/src/scenes/world.ts');
    SKY.galaxyCalm = 0;
    window.__world.applySky();
  });
  await page.waitForTimeout(1800);
  log('d 云海 calm 0');
  busy = await gpu(frames);
  await page.evaluate(async () => {
    const { SKY } = await import('/src/scenes/world.ts');
    SKY.galaxyCalm = 1;
    window.__world.applySky();
  });
  await page.waitForTimeout(1800);
  log('d 云海 calm 1');
  calm = await gpu(frames);
  }

  console.log(`backend: ${backend}，画布 2880×1800（1440×900 × 2）`);
  console.log(idleLine);
  if (!noGpu) {
    console.log(`a. 翠宝藏起来：${fmt(off)}`);
    console.log(`b. 翠宝露出来（平时）：${fmt(on)}  → 翠宝 +${(on.p50 - off.p50).toFixed(3)} ms`);
    console.log(`c. 翠宝探出来挥手：${fmt(near)}  → 翠宝 +${(near.p50 - off.p50).toFixed(3)} ms`);
    console.log(`d. 云海原来的样子（calm 0）：${fmt(busy)}；放安静（calm 1）：${fmt(calm)}  → ${(calm.p50 - busy.p50).toFixed(3)} ms`);
  }
  log('3 第一次点翠宝');
  // 3. 第一次点翠宝：蓄力、弹起、吐券、券飞到中间、窗口展开（再多记 400 ms）
  await page.waitForFunction(() => !!window.__home.state().triboo?.at, null, { timeout: 10000 });
  const t = (await page.evaluate(() => window.__home.state().triboo)).at;
  await page.mouse.move(t.x, t.y);
  await page.waitForTimeout(500);
  await startRec();
  await page.mouse.click(t.x, t.y);
  const shown = await page.waitForFunction(() => window.__home.state().card.shown, null, { timeout: 10000 }).then(() => true, () => false);
  if (!shown) {
    const dump = await page.evaluate(() => ({ home: window.__home.state().triboo, card: window.__home.state().card, coupons: window.__coupons.state().counts, field: window.__coupons.state().coupons }));
    throw new Error(`点了翠宝 10 秒，领券窗口没出来：${JSON.stringify(dump)}`);
  }
  await page.waitForTimeout(1000); // 纸翻开的动画（约 0.73 秒）放完
  const click = await stopRec();
  const clickMax = Math.max(...click);
  const card = await page.evaluate(() => window.__home.state().card);

  console.log(`第一次点翠宝 → 领券窗口展开：${click.length} 帧，最长 ${clickMax.toFixed(1)} ms，p95 ${pct(click, 0.95).toFixed(1)} ms，超过 33 ms 的 ${click.filter((f) => f > 33.4).length} 帧（${clickMax <= 33.4 ? '✓ ≤ 33 ms' : '✗ 超过 33 ms'}）；窗口 ${JSON.stringify(card)}`);

  // 4. 云里探头的翠宝（cloudPeek.ts）：第一次冒出来那一下（右下角那只缩走、云面鼓起来、探出来）→ 露着时的 GPU 时间 → 点它 → 领券窗口；
  //    悬停时带路（指针停在你的星球上 0.6 秒 → 从旁边冒出来）
  const line = (name, f) => `${name}：${f.length} 帧，最长 ${Math.max(...f).toFixed(1)} ms，p95 ${pct(f, 0.95).toFixed(1)} ms，超过 33 ms 的 ${f.filter((x) => x > 33.4).length} 帧（${Math.max(...f) <= 33.4 ? '✓ ≤ 33 ms' : '✗ 超过 33 ms'}）`;
  const closed = () => page.waitForFunction(() => !window.__home.state().card.open && document.querySelector('#app > .coupon-layer')?.hidden !== false, null, { timeout: 8000 });
  await page.keyboard.press('Escape');
  await closed();
  await page.evaluate(async () => { (await import('/src/fun/cloudPeek.ts')).CLOUD_PEEK.enabled = false; });
  await page.mouse.move(720, 10);
  await page.waitForTimeout(3600); // 冷却过去、右下角那只回来
  log('4 云里的翠宝冒出来');
  await startRec();
  if (!(await page.evaluate(() => window.__home.peekCloud()))) throw new Error('云里的翠宝冒不出来');
  await page.waitForFunction(() => window.__home.state().cloud?.phase === 'stay' && !!window.__home.state().cloud.at, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const peekF = await stopRec();
  const cAt = (await page.evaluate(() => window.__home.state().cloud)).at;
  await page.mouse.move(cAt.x, cAt.y); // 指着它：一直露着
  await page.waitForTimeout(400);
  const cloudGpu = noGpu ? skip : await gpu(frames);
  await startRec();
  await page.mouse.click(cAt.x, cAt.y);
  await page.waitForFunction(() => window.__home.state().card.shown, null, { timeout: 10000 });
  await page.waitForTimeout(1000);
  const cloudClickF = await stopRec();
  await page.keyboard.press('Escape');
  await closed();
  await page.mouse.move(720, 10);
  await page.waitForTimeout(2500);
  log('4 悬停带路');
  const youPos = await page.evaluate(() => window.__app.planetScreenPos(window.__home.state().you));
  await startRec();
  await page.mouse.move(youPos.x, youPos.y);
  const guided = await page.waitForFunction(() => window.__home.state().cloud?.mode === 'guide' && window.__home.state().cloud.phase === 'stay', null, { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(400);
  const guideF = await stopRec();
  await page.mouse.move(720, 10);
  console.log(line('云里的翠宝冒出来（右下角那只缩走 → 鼓起来 → 探出来 → 停着）', peekF));
  if (!noGpu) console.log(`云里的翠宝露着：${fmt(cloudGpu)}  → 比 b +${(cloudGpu.p50 - on.p50).toFixed(3)} ms`);
  console.log(line('点云里的翠宝 → 领券窗口展开', cloudClickF));
  console.log(guided ? line('悬停带路（指针停在星球上 → 从旁边冒出来、指着它）', guideF) : '✗ 悬停带路：没冒出来');
} catch (err) {
  console.log(`✗ 脚本出错：${err.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

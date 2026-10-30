// 鼠标跟随层（ui/cursor.ts）的开销：首页 1440×900、像素比 2，指针在画布上一直画圈（约 800 px/s），
// 跟随层开（A）、关（B）交替各量 ROUNDS 轮（默认 3），每段 SECONDS 秒（默认 4）：
//   帧间隔（rAF：中位、p95、最长、超过 20 ms 的帧数）、主画面每帧的 CPU 时间（World.frame：更新 + 提交 WebGPU 命令）、
//   每帧 GPU 时间（?gputime 的 timestamp-query）、跟随层自己每帧的 JS 时间（ui/cursor.ts 自己记的）
// 别的 agent、别的项目的测试浏览器可能同时在跑：交替量、多量几轮再下结论
// node scripts/perf-cursor.mjs。HEADED=1：有界面的 Chrome
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const SECONDS = Number(process.env.SECONDS ?? 4);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-cursor' });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = watchErrors(page);
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
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);

try {
  await page.goto(`${base}/?gputime&nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForFunction(() => !window.__home?.state().intro, null, { timeout: 30000 }).catch(() => {});
  // 翠宝不自己探头（不然两段里多出来的动画不一样）
  await page.evaluate(async () => {
    const { HOME_TRIBOO } = await import('/src/fun/homeTribooMath.ts');
    Object.assign(HOME_TRIBOO, { peekMin: 999, peekMax: 999 });
  });
  const backend = await page.evaluate(() => window.__app.backend());
  // 每帧记 World.frame 的 CPU 时间、GPU 时间
  await page.evaluate(() => {
    const w = window.__world;
    const frame = w.frame.bind(w);
    window.__cpu = null;
    w.frame = (t) => {
      const t0 = performance.now();
      frame(t);
      if (window.__cpu) window.__cpu.push(performance.now() - t0);
    };
    window.__gpu = null;
    window.__gpuPending = 0;
    w.renderHooks.add(() => {
      if (!window.__gpu) return;
      window.__gpuPending++;
      w.renderer.resolveTimestampsAsync('render').then((v) => { window.__gpuPending--; if (window.__gpu && typeof v === 'number' && v > 0) window.__gpu.push(v); }, () => { window.__gpuPending--; });
    });
  });
  // 画圈的中心：画布正中偏上，避开标题卡片和右下角的翠宝
  const cx = 860;
  const cy = 380;
  let moving = true;
  const t0 = Date.now();
  const mover = (async () => {
    while (moving) {
      const a = ((Date.now() - t0) / 1000) * 5;
      await page.mouse.move(cx + Math.cos(a) * 200, cy + Math.sin(a) * 120);
      await new Promise((r) => setTimeout(r, 6));
    }
  })();
  await page.waitForTimeout(1500);

  const rows = [];
  const measure = async (on) => {
    await page.evaluate((v) => { window.__cursorFx.setEnabled(v); window.__cursorFx.setTiming(true); }, on);
    await page.waitForTimeout(600);
    const s0 = await page.evaluate(() => window.__cursorFx.state());
    await page.evaluate(() => {
      window.__rec = { frames: [], last: performance.now() };
      window.__cpu = [];
      window.__gpu = [];
    });
    await page.waitForTimeout(SECONDS * 1000);
    const r = await page.evaluate(async () => {
      const frames = window.__rec.frames.slice(1);
      const cpu = window.__cpu;
      const gpu = window.__gpu;
      window.__rec = null;
      window.__cpu = null;
      window.__gpu = null;
      return { frames, cpu, gpu };
    });
    const s1 = await page.evaluate(() => window.__cursorFx.state());
    const fxFrames = s1.frames - s0.frames;
    rows.push({
      on,
      n: r.frames.length,
      p50: pct(r.frames, 0.5),
      p95: pct(r.frames, 0.95),
      max: Math.max(...r.frames),
      over20: r.frames.filter((f) => f > 20).length,
      cpu50: pct(r.cpu, 0.5),
      cpu95: pct(r.cpu, 0.95),
      gpu50: pct(r.gpu, 0.5),
      gpu95: pct(r.gpu, 0.95),
      gpuN: r.gpu.length,
      fxFrames,
      fxMs: fxFrames ? (s1.busyMs - s0.busyMs) / fxFrames : 0,
    });
  };
  for (let i = 0; i < ROUNDS; i++) {
    await measure(true);
    await measure(false);
  }
  // 每帧有没有新建对象：跟随层开着、指针一直动，用 V8 的采样堆分析连记两段 SECONDS 秒，数 cursor.ts / cursorMath.ts 里的函数分配了多少。
  // 第一段紧接着「关」那段：tick 停了好几秒，V8 可能把它降回没优化的版本（解释执行时每个小数都装箱），要跑一会儿才重新优化；第二段是稳定以后
  await page.evaluate(() => { window.__cursorFx.setEnabled(true); window.__cursorFx.setTiming(false); }); // 平时的路径：不记时间
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const sample = async () => {
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); // 被回收掉的也算
    const a0 = await page.evaluate(() => window.__cursorFx.state().frames);
    await page.waitForTimeout(SECONDS * 1000);
    const a1 = await page.evaluate(() => window.__cursorFx.state().frames);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const alloc = { frames: a1 - a0, cursor: 0, total: 0, fns: new Map() };
    const walk = (n) => {
      const size = n.selfSize;
      alloc.total += size;
      if (/\/src\/ui\/cursor(Math)?\.ts/.test(n.callFrame.url)) {
        alloc.cursor += size;
        const k = `${n.callFrame.functionName || '(匿名)'}:${n.callFrame.lineNumber + 1}`;
        alloc.fns.set(k, (alloc.fns.get(k) ?? 0) + size);
      }
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    return alloc;
  };
  const allocs = [await sample(), await sample()];
  moving = false;
  await mover;

  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  console.log(`backend: ${backend}，画布 2880×1800（1440×900 × 2），指针一直在画圈；每段 ${SECONDS} 秒，A = 跟随层开，B = 关`);
  console.log('段  帧数  帧间隔 p50 / p95 / 最长（ms）  >20ms  World.frame CPU p50 / p95  GPU p50 / p95（帧数）  跟随层 JS 每帧（跑了几帧）');
  for (const r of rows) {
    console.log(`${r.on ? 'A' : 'B'}   ${String(r.n).padStart(4)}  ${f(r.p50, 1)} / ${f(r.p95, 1)} / ${f(r.max, 1)}  ${String(r.over20).padStart(4)}   ${f(r.cpu50, 3)} / ${f(r.cpu95, 3)}   ${f(r.gpu50, 3)} / ${f(r.gpu95, 3)}（${r.gpuN}）   ${r.on ? `${f(r.fxMs, 4)} ms（${r.fxFrames}）` : `—（${r.fxFrames}）`}`);
  }
  const avg = (on, k) => {
    const xs = rows.filter((r) => r.on === on).map((r) => r[k]).filter(Number.isFinite);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  console.log(`平均：帧间隔 p50 A ${f(avg(true, 'p50'))} / B ${f(avg(false, 'p50'))} ms；p95 A ${f(avg(true, 'p95'))} / B ${f(avg(false, 'p95'))} ms；`
    + `World.frame CPU p50 A ${f(avg(true, 'cpu50'), 3)} / B ${f(avg(false, 'cpu50'), 3)} ms；GPU p50 A ${f(avg(true, 'gpu50'), 3)} / B ${f(avg(false, 'gpu50'), 3)} ms；跟随层 JS ${f(avg(true, 'fxMs'), 4)} ms/帧`);
  // 行号是 Vite 转换后的 JS（tick、readMode、pointermove 的处理函数……），和 .ts 源文件差几行
  allocs.forEach((alloc, i) => {
    const top = [...alloc.fns].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, v]) => `${k} ${v} B`).join('，');
    console.log(`堆分配第 ${i + 1} 段（采样 ${SECONDS} 秒，跟随层跑了 ${alloc.frames} 帧）：cursor.ts / cursorMath.ts 里 ${alloc.cursor} B（${top || '没有'}）；整页 JS 共 ${(alloc.total / 1024).toFixed(0)} KB`);
  });
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) console.log(`页面报错：${errors.slice(0, 3).join(' | ')}`);

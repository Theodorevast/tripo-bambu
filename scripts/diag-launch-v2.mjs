// 造星 Launch 卡在哪（v2-ui 查「等待」阶段的长帧用）：
//   1. 页面里直接 new 一颗 PlanetObject（每个预设各一次），量构造本身占主线程多久、precompile 期间有哪些 long task（> 50 ms 的主线程任务）
//   2. 走一遍真的流程：造星窗口走到第三步、等替身备好，记下渲染器里已有的管线；点 Launch，回到首页后再看新建了哪些管线、
//      Launch 期间有哪些 long task（按阶段）
// 只数东西、不比帧间隔，机器忙的时候跑也大致准。node scripts/diag-launch-v2.mjs [--webgl2]
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const webgl2 = process.argv.includes('--webgl2');
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-perf' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = watchErrors(p);
if (webgl2) await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await p.addInitScript(() => {
  window.__lt = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__lt.push({ at: e.startTime, ms: Math.round(e.duration), phase: window.__create?.state().launch.phase ?? '-' });
  }).observe({ type: 'longtask', buffered: true });
});
await p.goto(`${base}/?nolocal`);
await p.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
await p.waitForTimeout(2500);

// —— 1. 单独建一颗：构造多久、precompile 期间的 long task ——
const solo = await p.evaluate(async () => {
  const { PlanetObject } = await import('/src/planet/planetObject.ts');
  const w = window.__world;
  const out = [];
  for (const preset of ['verdant', 'desert', 'glacier', 'volcanic', 'coral']) {
    window.__lt.length = 0;
    const t0 = performance.now();
    const planet = new PlanetObject({ seed: 4242, preset, ring: true, atmosphere: true, placements: [] }, '#5f8f8c', false);
    const t1 = performance.now();
    const n0 = w.renderer._pipelines?.caches?.size ?? -1;
    await w.stage.precompile(planet.group).catch(() => {});
    const t2 = performance.now();
    const n1 = w.renderer._pipelines?.caches?.size ?? -1;
    await new Promise((r) => setTimeout(r, 300));
    out.push({ preset, constructMs: Math.round(t1 - t0), precompileMs: Math.round(t2 - t1), newPipelines: n1 - n0, longTasks: window.__lt.map((e) => e.ms) });
  }
  return out;
});
console.log(`${webgl2 ? 'WebGL2' : 'WebGPU'} · 单独建一颗星球（构造 / precompile / 新管线 / 期间的 long task ms）`);
for (const s of solo) console.log(`  ${s.preset.padEnd(9)} 构造 ${String(s.constructMs).padStart(4)} ms · precompile ${String(s.precompileMs).padStart(5)} ms · 新管线 ${s.newPipelines} · long task [${s.longTasks.join(', ')}]`);

// —— 2. 真的流程 ——
await p.evaluate(() => { location.hash = '#/create'; });
await p.waitForFunction(() => window.__create?.state().open && window.__create.state().previewReady, null, { timeout: 60000 });
await p.locator('#cp-name').fill('Diag Comets');
for (const s of ['look', 'crew', 'launch']) {
  await p.locator('.cp-next').click();
  await p.waitForFunction((x) => window.__create.state().step === x, s);
}
await p.waitForFunction(() => window.__create.state().twinReady, null, { timeout: 30000 });
await p.waitForTimeout(1500);
const keys0 = await p.evaluate(() => {
  window.__lt.length = 0;
  window.__gaps = [];
  let last = -1;
  const tick = (t) => {
    const s = window.__create.state().launch.phase;
    if (last >= 0) window.__gaps.push({ at: last, ms: t - last, phase: s });
    last = t;
    if (!(s === 'home' && !window.__world.rig.flying)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return [...(window.__world.renderer._pipelines?.caches?.keys() ?? [])];
});
const cdp = await p.context().newCDPSession(p);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await p.locator('.cp-next').click();
// 「对准」那一段（新星球加进来的那一下）单独看：点 Launch 以后 1.5 秒
await p.waitForTimeout(1500);
const early = (await cdp.send('Profiler.stop')).profile;
await cdp.send('Profiler.start');
await p.waitForFunction(() => window.__create.state().launch.phase === 'home' && !window.__world.rig.flying && !window.__world.rig.drive && window.__app.routeIdle(), null, { timeout: 60000 });
const late = (await cdp.send('Profiler.stop')).profile;
const byName = (prof) => {
  const node = new Map(prof.nodes.map((n) => [n.id, n.callFrame.functionName || '(anonymous)']));
  const ms = {};
  prof.samples.forEach((id, i) => { const n = node.get(id); ms[n] = (ms[n] ?? 0) + (prof.timeDeltas[i] ?? 0) / 1000; });
  return ms;
};
const fmtProf = (prof) => {
  const ms = byName(prof);
  const total = (prof.endTime - prof.startTime) / 1000;
  const busy = total - (ms['(idle)'] ?? 0);
  return `共 ${Math.round(total)} ms，主线程忙 ${Math.round(busy)} ms，其中 (program) ${Math.round(ms['(program)'] ?? 0)} ms、(garbage collector) ${Math.round(ms['(garbage collector)'] ?? 0)} ms`;
};
const after = await p.evaluate((k0) => {
  const r = window.__world.renderer;
  const seen = new Set(k0);
  const added = [];
  for (const [key, pipe] of r._pipelines?.caches ?? []) {
    if (seen.has(key)) continue;
    added.push(`${pipe.vertexProgram?.name ?? ''} | ${pipe.fragmentProgram?.name ?? pipe.computeProgram?.name ?? ''}`);
  }
  // 长帧（> 33 ms）：那一帧里有没有 long task 盖着（主线程被占）
  const long = window.__gaps.filter((g) => g.ms > 33.5).map((g) => {
    const lt = window.__lt.find((e) => e.at < g.at + g.ms && e.at + e.ms > g.at);
    return `${Math.round(g.ms)}@${g.phase}${lt ? `（主线程 long task ${lt.ms} ms）` : '（主线程空着）'}`;
  });
  const max = Math.max(...window.__gaps.map((g) => g.ms));
  return { added, longTasks: window.__lt.map((e) => `${e.ms}@${e.phase}`), long, max: Math.round(max), frames: window.__gaps.length, usedTwin: window.__create.state().usedTwin };
}, keys0);
const count = {};
for (const n of after.added) count[n] = (count[n] ?? 0) + 1;
console.log(`这次 Launch ${after.usedTwin ? '直接用了预热好的替身' : '没用替身（新建了一颗）'}`);
console.log(`CPU profile：点 Launch 后 1.5 秒 ${fmtProf(early)}；之后到回首页 ${fmtProf(late)}`);
console.log(`Launch 期间新建的管线 ${after.added.length} 条${after.added.length ? '：' : ''}`);
for (const [n, c] of Object.entries(count)) console.log(`  ${c} × ${n}`);
console.log(`Launch 期间的 long task：${after.longTasks.join(' ') || '没有'}`);
console.log(`Launch 期间 ${after.frames} 帧，最长 ${after.max} ms；长帧：${after.long.join(' ') || '没有'}`);
if (errors.length) console.log(`页面错误 ${errors.length} 条：${errors.slice(0, 3).join(' / ')}`);
await browser.close();
await server.close();

// 造星 Launch 时主线程上的长任务是谁（v2-ui 帮 main 诊断用，只读不改）：
// CDP Profiler（100 µs 采样）录整个 Launch，从样本里切出「连续不空闲超过 30 ms」的一段段（主线程被占着、画不了帧），
// 每段列出自身耗时最多的 5 个函数（函数名、文件:行；文件是开发服务器上转换过的模块，行号和源码基本对得上），标上当时 Launch 的阶段；
// 最后按「对准 / 等待」「冲出来」「落定 / 停一拍 / 回首页」三组合计。--no-tags：开页后把首页的名牌整层藏起来（排除名牌样式的影响）。
// 开始、结束各数一次机器上有几个无头 Chrome（不算这个脚本自己开的），别的 agent 在跑脚本时看得出来。
// node scripts/profile-launch-v2.mjs [--runs 2] [--no-tags] [--settle 15]；WEBGL2=1 走 WebGL2
import { execSync } from 'node:child_process';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const RUNS = opt('--runs', 2);
const SETTLE = opt('--settle', 15);
const NOTAGS = args.includes('--no-tags');
const WEBGL2 = process.env.WEBGL2 === '1';
const LONG = 30; // ms

// 机器上的无头 Chrome 浏览器进程（主进程：命令行带 --headless、不带 --type=）
function headlessBrowsers() {
  try {
    const ps = "(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*--headless*' -and $_.CommandLine -notlike '*--type=*' } | Measure-Object).Count";
    return Number(execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim());
  } catch {
    return -1;
  }
}

const short = (url) => {
  if (!url) return '';
  const u = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  return u.replace(/^\/\.tmp\/[^/]+\/deps\//, 'deps/');
};
const GROUP = { aim: '对准/等待', wait: '对准/等待', charge: '冲出来', burst: '冲出来', settle: '落定/停一拍/回首页', hold: '落定/停一拍/回首页', home: '落定/停一拍/回首页' };

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-perf' });
const browser = await launch();
const lines = [];
const totals = {}; // 组 → 函数 → ms
const before = headlessBrowsers() - 1;
for (let run = 0; run < RUNS; run++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = watchErrors(p);
  if (WEBGL2) await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await p.goto(`${base}/?nolocal`);
  await p.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  if (SETTLE > 0) await p.waitForTimeout(SETTLE * 1000);
  if (NOTAGS) await p.addStyleTag({ content: '.planet-tags { display: none !important; }' });
  await p.evaluate(() => { location.hash = '#/create'; });
  await p.waitForFunction(() => window.__create?.state().open && window.__create.state().previewReady, null, { timeout: 90000 });
  await p.locator('#cp-name').fill(`Profile Run ${run + 1}`);
  for (const s of ['look', 'crew', 'launch']) {
    await p.locator('.cp-next').click();
    await p.waitForFunction((x) => window.__create.state().step === x, s);
  }
  await p.waitForFunction(() => window.__create.state().twinReady, null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
  const t0 = await p.evaluate(() => {
    window.__ph = [];
    const tick = () => {
      const s = window.__create.state().launch.phase;
      if (window.__ph.at(-1)?.[1] !== s) window.__ph.push([performance.now(), s]);
      if (!(s === 'home' && !window.__world.rig.flying)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return performance.now();
  });
  await p.locator('.cp-next').click();
  await p.waitForFunction(() => window.__create.state().launch.phase === 'home' && !window.__world.rig.flying && !window.__world.rig.drive && window.__app.routeIdle(), null, { timeout: 60000 });
  const { profile } = await cdp.send('Profiler.stop');
  const ph = await p.evaluate(() => window.__ph);
  const twin = await p.evaluate(() => window.__create.state().usedTwin);
  await ctx.close();

  // 样本 → 时间轴；连续不空闲的一段 = 主线程被占着
  const node = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
  let t = profile.startTime;
  const samples = profile.samples.map((id, i) => {
    t += profile.timeDeltas[i] ?? 0;
    return { t, id, dt: (profile.timeDeltas[i + 1] ?? 100) / 1000 };
  });
  const segs = [];
  let cur = null;
  for (const s of samples) {
    const cf = node.get(s.id);
    const idle = cf?.functionName === '(idle)';
    if (idle) {
      if (cur) { segs.push(cur); cur = null; }
      continue;
    }
    cur ??= { start: s.t, end: s.t, self: new Map() };
    cur.end = s.t + s.dt * 1000;
    const key = cf.url ? `${cf.functionName || '(anonymous)'} ${short(cf.url)}:${cf.lineNumber + 1}` : cf.functionName;
    cur.self.set(key, (cur.self.get(key) ?? 0) + s.dt);
  }
  if (cur) segs.push(cur);
  const phaseAt = (us) => {
    const pageT = t0 + (us - profile.startTime) / 1000;
    let name = ph[0]?.[1] ?? '?';
    for (const [at, s] of ph) if (at <= pageT) name = s;
    return name;
  };
  const long = segs.filter((g) => (g.end - g.start) / 1000 > LONG);
  lines.push(`—— 第 ${run + 1} 次（${twin ? '用了替身' : '新建'}${NOTAGS ? '，名牌藏起来' : ''}）：主线程连续被占超过 ${LONG} ms 的 ${long.length} 段${errors.length ? `；页面错误 ${errors.length}` : ''}`);
  for (const g of long) {
    const phase = phaseAt(g.start);
    const top = [...g.self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    lines.push(`  ${phase.padEnd(6)} ${((g.end - g.start) / 1000).toFixed(0).padStart(4)} ms：${top.map(([k, ms]) => `${k}（${ms.toFixed(1)}）`).join('；')}`);
    const grp = GROUP[phase] ?? phase;
    totals[grp] ??= new Map();
    for (const [k, ms] of g.self) totals[grp].set(k, (totals[grp].get(k) ?? 0) + ms);
  }
}
const after = headlessBrowsers() - 1;
console.log(`${WEBGL2 ? 'WebGL2' : 'WebGPU'} · 1440×900 @2x · 开页后先等 ${SETTLE} 秒${NOTAGS ? ' · 名牌藏起来' : ''} · 机器上别的无头 Chrome：开始 ${before} 个、结束 ${after} 个`);
console.log(lines.join('\n'));
console.log('—— 合计（这些长任务里自身耗时最多的 8 个函数，按阶段分组）');
for (const [grp, m] of Object.entries(totals)) {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  ${grp}：${top.map(([k, ms]) => `${k}（${ms.toFixed(0)}）`).join('；')}`);
}
await browser.close();
await server.close();

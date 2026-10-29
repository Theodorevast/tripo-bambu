// 转场自查（T2）：开页 → 翠宝探头 → 星系进星球（穿云）→ 跳到另一颗星球 → 回星系 → 再进一颗（模型已缓存）→ 跳到建设中的星球 → 回星系；
// 再开一页「减少动态效果」走一遍（退化成淡入淡出）；最后查角落的「Made with Tripo」徽章。
// 每段都用 requestAnimationFrame 逐帧记帧间隔（要求最长 < 50 ms），同时逐帧采样转场的状态：云层有没有画、翠宝黄光带闪了多久、
// 作品是不是在云散开时已经准备好（排着等出场）、出场的间隔是不是约 60 ms、旧星球的作品是不是全遮住以后才撤。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备；HEADED=1：有界面的 Chrome（无头模式可能拿不到 WebGPU）。
// DPR=<n>：设备像素比（默认 2，章程的 1440×900、DPR 2；录像默认 1）；LOCAL=1：「你的星球」用本机的私有真实模型（默认用种子数据的占位作品，?nolocal）。
// SKY=sunset：录像前把天空换成日落（看转场的云跟着换色）。
// 原来是 T2（卡通分支）的自查脚本，搬到 int/v6（motion）：云层改成全屏网格（director.ts、style/veil.ts），检查项不变。
// --record <目录>：不量帧时间，改成「时间停住、一帧一帧往前走」逐帧截图，用 ffmpeg 拼成每个转场一段 MP4，再挑几张关键帧
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const withWorks = seed.teams.filter((t) => t.works.length > 0);
const other = withWorks.find((t) => t.id !== you.id);
const third = withWorks.find((t) => t.id !== you.id && t.id !== other.id) ?? other;
const building = seed.teams.find((t) => t.status === 'under-construction');
const WEBGL2 = process.env.WEBGL2 === '1';
const recordAt = process.argv.indexOf('--record');
const RECORD = recordAt >= 0 ? process.argv[recordAt + 1] : null;
const tag = (WEBGL2 ? 'webgl2' : 'webgpu') + (process.env.SKY ? `-${process.env.SKY}` : '');
const DPR = Number(process.env.DPR ?? (RECORD ? 1 : 2));
const QUERY = process.env.LOCAL === '1' ? '' : '?nolocal';
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (x) => `${x.toFixed(1)} ms`;

const { server, base } = await startServer();
const browser = await launch();
const errors = [];
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const table = [];

async function openPage({ reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const pageErrors = watchErrors(page);
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  // 每帧记帧间隔和转场状态（开页就开始记，开场探头也量得到）
  await page.addInitScript(() => {
    window.__rec = null;
    const tick = (t) => {
      const r = window.__rec;
      if (r) {
        r.frames.push(t - r.last);
        r.last = t;
        const s = window.__trans?.state();
        if (s) r.samples.push({ at: t, kind: s.transition?.kind ?? null, t: s.transition?.t ?? null, veil: s.veil, flash: s.flash, queued: s.queued, holding: s.holding, peek: s.peek || (window.__home?.state().intro ?? false), placed: window.__app?.placedIds().length ?? 0 });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { context, page, pageErrors };
}

const startRec = (page) => page.evaluate(() => { window.__rec = { frames: [], samples: [], last: performance.now() }; });
const stopRec = (page) => page.evaluate(() => {
  const r = window.__rec;
  window.__rec = null;
  return r;
});
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
// 先等转场真的开始（hashchange 是异步派发的：刚改完地址时路由队列还空着，直接等「空闲」会立刻通过），再等处理完
const started = (page) => until(page, () => !!window.__trans.state().transition, null, 5000);
const planetReady = async (page, id) => (await started(page)) && until(page, (t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, id, 60000);
const galaxyIdle = async (page) => (await started(page)) && until(page, () => window.__app.routeIdle() && (location.hash === '' || location.hash === '#/'), null, 20000);
const releasesNow = (page) => page.evaluate(() => window.__trans.state().releases);
// 出场间隔：每件在 60 ms ± 一帧以内，平均约 60 ms（按帧对齐，60 Hz 下是 50 / 67 交替）
const gapsOk = (gaps) => gaps.every((g) => g >= 60 - 17.5 && g <= 60 + 17.5) && (gaps.length === 0 || Math.abs(gaps.reduce((a, b) => a + b, 0) / gaps.length - 60) <= 9);

// 量一段转场：trigger 触发，done 等到路由处理完（星球页还要等模型挂好），再多记 300 ms
async function measure(page, name, { trigger, done, kind }) {
  const before = (await releasesNow(page)).at(-1) ?? -1;
  await startRec(page);
  await trigger();
  const ok = await done();
  await page.waitForTimeout(300);
  const rec = await stopRec(page);
  const frames = rec.frames.slice(1); // 第一个间隔里有开始记录的那一下
  const max = Math.max(...frames);
  const s = rec.samples;
  // 最长的那一帧落在转场的哪个时刻（采样和帧间隔在同一个回调里记，下标对得上）
  const worst = s[frames.indexOf(max) + 1];
  const worstAt = worst?.kind ? `${worst.kind} t=${worst.t.toFixed(2)}` : '转场外';
  const mine = s.filter((x) => x.kind !== null);
  const kinds = [...new Set(mine.map((x) => x.kind))];
  const flashFrames = s.filter((x) => x.flash > 0);
  const flashMs = flashFrames.length ? flashFrames.at(-1).at - flashFrames[0].at : 0;
  const releases = (await releasesNow(page)).filter((r) => r > before);
  const gaps = releases.slice(1).map((r, i) => (r - releases[i]) * 1000);
  const row = { name, kind: kinds.join('+') || '-', frames: frames.length, max, worstAt, p95: pct(frames, 0.95), p50: pct(frames, 0.5), over33: frames.filter((f) => f > 33.4).length, flashMs, gaps };
  table.push(row);
  check(`${name}：转场跑完、路由处理完`, ok && (kind ? kinds.length === 1 && kinds[0] === kind : true), `${kinds.join('+') || '没有转场'}`);
  check(`${name}：最长帧间隔 < 50 ms`, max < 50, `${tag}，最长 ${ms(max)}（${worstAt}），p95 ${ms(row.p95)}，中位 ${ms(row.p50)}，${frames.length} 帧`);
  return { rec, row, mine, releases, gaps, s };
}

let shotIndex = 0;
async function snap(page, label) {
  if (!RECORD) return;
  await page.screenshot({ path: path.join(RECORD, `${tag}-${String(++shotIndex).padStart(2, '0')}-${label}.png`) });
}

// —— 逐帧录像 ——
async function record(page, name, trigger, seconds, keys = {}) {
  const dir = path.join(RECORD, `${tag}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => window.__trans.timeScale(0));
  await trigger();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    await page.screenshot({ path: path.join(dir, `f-${String(i).padStart(4, '0')}.png`) });
    await page.evaluate(() => new Promise((r) => { window.__trans.advance(1 / 60); requestAnimationFrame(() => requestAnimationFrame(r)); }));
  }
  await page.evaluate(() => window.__trans.timeScale(1));
  const out = path.join(RECORD, `${tag}-${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-vf', 'scale=1440:-2', out]);
  for (const [label, frame] of Object.entries(keys)) copyFileSync(path.join(dir, `f-${String(frame).padStart(4, '0')}.png`), path.join(RECORD, `${tag}-key-${label}.png`));
  rmSync(dir, { recursive: true, force: true }); // 逐帧的截图拼好就删（每段上百张）
  console.log(`录好 ${out}（${n} 帧）`);
}

try {
  if (RECORD) {
    mkdirSync(RECORD, { recursive: true });
    const { context, page, pageErrors } = await openPage();
    await page.goto(`${base}/${QUERY}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    if (process.env.SKY) {
      await page.evaluate((p) => window.__world.setSkyPreset(p), process.env.SKY);
      await page.waitForFunction(() => !window.__trans.state().peek && !window.__home?.state().intro, null, { timeout: 8000 });
      await page.waitForTimeout(2200); // 天空预设 2 秒过渡完
      await page.evaluate(() => window.__trans.peek());
    }
    // 开场探头：开页就停住时间（探头前有 0.2 秒的等待，停住时还没开始）
    await record(page, 'peek', async () => {}, 2.5, { 'peek-wave': 70 });
    await page.waitForTimeout(400);
    const at = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
    await record(page, 'enter', () => page.mouse.click(at.x, at.y), 2.0, { 'enter-clouds-in': 34, 'enter-flash': 52, 'enter-reveal': 64, 'enter-pop': 80 });
    await planetReady(page, you.id);
    await page.waitForTimeout(500);
    await record(page, 'hop', () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, other.id), 1.9, { 'hop-whip': 10, 'hop-band': 22 });
    await planetReady(page, other.id);
    await page.waitForTimeout(500);
    await record(page, 'leave', () => page.locator('.topbar button', { hasText: 'Galaxy' }).click(), 1.3, { 'leave-puff': 8 });
    await galaxyIdle(page);
    errors.push(...pageErrors);
    await context.close();
    const reduced = await openPage({ reduced: true });
    await reduced.page.goto(`${base}/${QUERY}`);
    await reduced.page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await reduced.page.waitForTimeout(400);
    await record(reduced.page, 'reduced-enter', () => reduced.page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id), 1.0, { 'reduced-mid': 24 });
    errors.push(...reduced.pageErrors);
    await reduced.context.close();
  } else {
    // —— 1. 开页：开场飞行，落定后翠宝探头 ——
    const { context, page, pageErrors } = await openPage();
    await page.goto(`${base}/${QUERY}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const backend = await page.evaluate(() => window.__app.backend());
    await startRec(page);
    // H2：开场的探头从「星球后面」改到首页右下角躲着的翠宝（fun/couponsHome.ts 接过 director.peekIntro）：看 window.__home.state().intro
    const peeking = () => window.__trans.state().peek || window.__home?.state().intro === true;
    const peeked = await until(page, peeking, null, 3000);
    const peekEnded = await until(page, () => !window.__trans.state().peek && !window.__home?.state().intro, null, 6000);
    const peekRec = await stopRec(page);
    const peekFrames = peekRec.frames.slice(1);
    const peekMax = Math.max(...peekFrames);
    table.push({ name: '开场：翠宝探头', kind: 'peek', frames: peekFrames.length, max: peekMax, worstAt: '探头', p95: pct(peekFrames, 0.95), p50: pct(peekFrames, 0.5), over33: peekFrames.filter((f) => f > 33.4).length, flashMs: 0, gaps: [] });
    check('开场：飞行落定后翠宝从右下角探出来、挥手、缩回去', peeked && peekEnded && peekRec.samples.some((x) => x.peek), `${peekRec.samples.filter((x) => x.peek).length} 帧`);
    check('开场探头期间最长帧间隔 < 50 ms', peekMax < 50, `${backend}，最长 ${ms(peekMax)}，p95 ${ms(pct(peekFrames, 0.95))}`);

    // —— 2. 星系 → 星球：穿云（真的点星球）——
    const at = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
    const enter = await measure(page, `星系 → ${you.id}（穿云，第一次）`, {
      kind: 'enter',
      trigger: () => page.mouse.click(at.x, at.y),
      done: () => planetReady(page, you.id),
    });
    const enterSamples = enter.mine.filter((x) => x.kind === 'enter');
    const cloudOutT = 0.6; // TRANSITIONS.enter.cloudOut（分镜表的默认值）
    const atReveal = enterSamples.find((x) => x.t >= cloudOutT);
    check('穿云：中途画了云层、闪过翠宝黄光带（≤ 150 ms）', enterSamples.some((x) => x.veil) && enter.row.flashMs > 0 && enter.row.flashMs <= 150 + 17, `光带 ${ms(enter.row.flashMs)}`);
    // int/v6：模型在转场一开始就预取（下载、解码），展台在云层全遮住时才摆（第一次画展台、编译作品的那一帧藏在云里）
    const cloudFullT = 0.52; // TRANSITIONS.enter.cloudFull
    const atCover = enterSamples.find((x) => x.t >= cloudFullT + 0.02);
    // 作品开始弹出的前一帧（TRANSITIONS.enter.popAt）：都准备好在排队
    const popT = 0.78;
    const atPop = enterSamples.filter((x) => x.t < popT).at(-1);
    check('穿云：开头不摆展台，云层全遮住时摆上，开始弹出时作品都准备好在排队', !!atPop && enterSamples[0].placed === 0 && atCover?.placed === you.planet.placements.length && atPop.queued === you.planet.placements.length,
      `第一帧已摆 ${enterSamples[0]?.placed}，全遮住后 ${atCover?.placed}，云散开时排着 ${atReveal?.queued}，开始弹出前排着 ${atPop?.queued}/${you.planet.placements.length}`);
    check('穿云：作品依次弹出来，间隔约 60 ms', enter.releases.length === you.planet.placements.length && gapsOk(enter.gaps), `${enter.gaps.map((g) => g.toFixed(0)).join('、')} ms`);
    await page.waitForTimeout(400);

    // —— 3. 星球 → 另一颗星球：甩镜 + 云带 + 弧线 ——
    const hop = await measure(page, `${you.id} → ${other.id}（跳星球）`, {
      kind: 'hop',
      trigger: () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, other.id),
      done: () => planetReady(page, other.id),
    });
    const hopSamples = hop.mine.filter((x) => x.kind === 'hop');
    const coverT = 0.36; // TRANSITIONS.hop.cloudFull
    const beforeCover = hopSamples.filter((x) => x.t < coverT - 0.02);
    check('跳星球：旧星球的作品在云层全遮住之前一直在，没有一开头就消失', beforeCover.length > 3 && beforeCover.every((x) => x.placed === you.planet.placements.length || x.placed > 0),
      `全遮住前 ${beforeCover.length} 帧，作品数 ${[...new Set(beforeCover.map((x) => x.placed))].join('/')}`);
    check('跳星球：中途没有回星系全景（一直是 hop 一段），云带盖住、闪过光带，作品依次弹出来', hop.row.kind === 'hop' && hopSamples.some((x) => x.veil) && hop.row.flashMs > 0 && gapsOk(hop.gaps),
      `光带 ${ms(hop.row.flashMs)}，出场间隔 ${hop.gaps.map((g) => g.toFixed(0)).join('、')} ms`);
    await page.waitForTimeout(400);

    // —— 4. 星球 → 星系：更短、更轻快 ——
    const leave = await measure(page, `${other.id} → 星系（回星系）`, {
      kind: 'leave',
      trigger: () => page.locator('.topbar button', { hasText: 'Galaxy' }).click(),
      done: () => galaxyIdle(page),
    });
    const leaveSecs = (leave.mine.at(-1)?.at - leave.mine[0]?.at) / 1000;
    check('回星系：比进星球短（约 1 秒），没有光带', leave.row.flashMs === 0 && leaveSecs > 0.5 && leaveSecs < 1.3, `${leaveSecs.toFixed(2)} 秒`);
    await page.waitForTimeout(400);

    // —— 5. 再进一颗（模型已经在缓存里）、跳到建设中的星球、再回星系 ——
    await measure(page, `星系 → ${third.id}（穿云）`, { kind: 'enter', trigger: () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, third.id), done: () => planetReady(page, third.id) });
    await page.waitForTimeout(300);
    await measure(page, `${third.id} → ${building.id}（跳到建设中的星球）`, { kind: 'hop', trigger: () => page.evaluate((id) => { location.hash = `#/t/${id}`; }, building.id), done: () => planetReady(page, building.id) });
    const note = await page.locator('.center-note').isVisible();
    check('建设中的星球：落地后显示提示', note);
    await page.waitForTimeout(300);
    await measure(page, `${building.id} → 星系`, { kind: 'leave', trigger: () => page.evaluate(() => { location.hash = '#/'; }), done: () => galaxyIdle(page) });

    // —— 6. 角落的「Made with Tripo」徽章：新标签页打开 tripo3d.ai ——
    await context.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
    const badge = await page.evaluate(() => {
      const a = document.querySelector('#app > a.made-with');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim(), left: r.left, bottom: innerHeight - r.bottom, width: r.width, height: r.height, font: getComputedStyle(a).fontFamily };
    });
    const popupP = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await page.locator('#app > a.made-with').click();
    const popup = await popupP;
    if (popup) await popup.waitForLoadState().catch(() => {});
    check('角落徽章：Made with Tripo，圆体字，点了在新标签页打开 tripo3d.ai', !!badge && /Made with Tripo/.test(badge.text) && badge.href.startsWith('https://www.tripo3d.ai') && badge.target === '_blank' && /noopener/.test(badge.rel) && /Nunito/.test(badge.font) && !!popup && popup.url().startsWith('https://www.tripo3d.ai'),
      badge ? `${Math.round(badge.width)}×${Math.round(badge.height)} px，左下角 (${Math.round(badge.left)}, ${Math.round(badge.bottom)})，新标签页 ${popup?.url() ?? '没打开'}` : '没找到');
    await popup?.close();
    // 编辑时让位
    await page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id);
    await planetReady(page, you.id);
    await page.locator('.topbar button.primary').click();
    await page.waitForTimeout(200);
    const hiddenWhileEditing = await page.evaluate(() => getComputedStyle(document.querySelector('#app > a.made-with')).display === 'none');
    check('编辑时徽章让位（作品栏在底下）', hiddenWhileEditing);
    await page.locator('.topbar button.primary').click();
    errors.push(...pageErrors);
    await context.close();

    // —— 7. 减少动态效果：转场退化成淡入淡出，没有探头、没有光带 ——
    const reduced = await openPage({ reduced: true });
    await reduced.page.goto(`${base}/${QUERY}`);
    await reduced.page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await reduced.page.waitForTimeout(500);
    const noPeek = !(await reduced.page.evaluate(() => window.__trans.state().peek || window.__home?.state().intro === true));
    const rEnter = await measure(reduced.page, `减少动态效果：星系 → ${you.id}`, { kind: 'fade', trigger: () => reduced.page.evaluate((id) => { location.hash = `#/t/${id}`; }, you.id), done: () => planetReady(reduced.page, you.id) });
    const rLeave = await measure(reduced.page, '减少动态效果：回星系', { kind: 'fade', trigger: () => reduced.page.evaluate(() => { location.hash = '#/'; }), done: () => galaxyIdle(reduced.page) });
    check('减少动态效果：转场都是淡入淡出（不飞、不闪、不探头）', noPeek && rEnter.row.kind === 'fade' && rLeave.row.kind === 'fade' && rEnter.row.flashMs === 0 && rLeave.row.flashMs === 0);
    errors.push(...reduced.pageErrors);
    await reduced.context.close();
    console.log(`backend: ${backend}；DPR ${DPR}；${QUERY ? '占位作品' : '本机真实模型'}`);
  }
} catch (e) {
  results.push(`✗ 脚本出错：${e.message}`);
} finally {
  if (table.length) {
    console.log('\n| 段落 | 转场 | 帧数 | 最长 | 最长那帧在 | p95 | 中位 | > 33 ms | 光带 | 出场间隔 |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of table) console.log(`| ${r.name} | ${r.kind} | ${r.frames} | ${ms(r.max)} | ${r.worstAt} | ${ms(r.p95)} | ${ms(r.p50)} | ${r.over33} | ${r.flashMs ? ms(r.flashMs) : '-'} | ${r.gaps.length ? r.gaps.map((g) => g.toFixed(0)).join('/') : '-'} |`);
    if (process.env.FRAMES_OUT) writeFileSync(process.env.FRAMES_OUT, JSON.stringify({ backend: tag, table }, null, 2));
  }
  console.log(results.join('\n'));
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  const ok = results.length > 0 && results.every((r) => r.startsWith('✓')) && errors.length === 0;
  console.log(RECORD ? (ok || results.length === 0 ? 'RECORDED' : 'RECORD FAIL') : ok ? 'TRANSITIONS OK' : 'TRANSITIONS FAIL');
  await browser.close();
  await server.close();
  process.exitCode = ok || (RECORD && results.length === 0 && errors.length === 0) ? 0 : 1;
}

// 点翠宝吐优惠券的自查（fun/coupons*.ts）：
// 1. 星球视图「你的星球」上站着翠宝：悬停手形光标、轻轻一缩 → 第一次点：吐 3–5 张券、落在草上（量帧间隔：第一次点不能卡）
// 2. 冷却中再点只摇头、不吐 → 冷却过了再点又吐
// 3. 悬停券手形 → 捡一张：飞到镜头前、卡片展开（量帧间隔）；卡片上券名、面额、兑换码、Copy code、Use on Tripo（新标签页）
// 4. Copy code 复制成功、按钮变 Copied! → Esc 关卡片
// 5. 没捡的券落地 10 秒后淡出（9 秒时还在、11.5 秒时没了）
// 6. 漫游：附近没有作品时按 E 吐券（量帧间隔）；冷却中点翠宝摇头、角色不走过去；点券开卡片、不走过去；靠近作品按 E 还是作品卡
// 7. 离开星球：券、站桩翠宝都收掉
// 8. 减弱动效（prefers-reduced-motion）：券不飞不翻，直接在翠宝身边淡入
// 页面没有报错。WEBGL2=1：走 WebGL2。DPR（默认 2）：1440×900 下的像素比。截图存到 shots/coupons-*.png
// 开发服务器用自己的缓存目录（.tmp/vite-coupons）
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const WEBGL2 = process.env.WEBGL2 === '1';
const DPR = Number(process.env.DPR ?? 2);
const FRAME_LIMIT = 33; // 最长帧间隔（毫秒）
const tag = WEBGL2 ? 'webgl2' : 'webgpu';
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

mkdirSync('shots', { recursive: true });
const { server, base } = await startServer({ cacheDir: '.tmp/vite-coupons' });
const browser = await launch();
const errors = [];

async function openPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  errors.push(watchErrors(page));
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  // 逐帧记录 requestAnimationFrame 的间隔（不受主循环里 dt 封顶的影响）
  await page.addInitScript(() => {
    window.__frameLog = null;
    let last = 0;
    const tick = (t) => {
      if (window.__frameLog) window.__frameLog.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${base}/?nolocal#/t/${team.id}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
  await page.waitForFunction(() => window.__coupons?.state().ready === true && window.__coupons.state().stand.shown && window.__coupons.state().stand.at, null, { timeout: 30000 });
  // 飞到星球后 OrbitControls 的阻尼还会让镜头慢慢漂一两秒：等它停稳
  await page.waitForTimeout(2500);
  return { ctx, page };
}

const state = (p) => p.evaluate(() => window.__coupons.state());
const until = (p, fn, arg = null, ms = 8000) => p.waitForFunction(fn, arg, { timeout: ms, polling: 'raf' }).then(() => true, () => false);
const startFrames = (p) => p.evaluate(() => { window.__frameLog = []; });
const stopFrames = (p) => p.evaluate(() => { const f = window.__frameLog ?? []; window.__frameLog = null; return f.slice(1); });
const frameNote = (f) => `${tag}、DPR ${DPR}：最长 ${Math.max(...f).toFixed(1)} ms，p95 ${[...f].sort((a, b) => a - b)[Math.floor(f.length * 0.95)].toFixed(1)} ms，${f.length} 帧`;
const restAll = (p, min) => until(p, (n) => { const c = window.__coupons.state().coupons; return c.length >= n && c.every((x) => x.phase === 'rest'); }, min, 8000);
const landed = (p, ids) => until(p, (list) => { const c = window.__coupons.state().coupons; return list.every((id) => c.find((x) => x.id === id)?.phase === 'rest'); }, ids, 8000);
const frameMaxes = [];

let backend = '?';
try {
  const { page } = await openPage();
  backend = await page.evaluate(() => window.__app.backend());

  // —— 1. 悬停站桩翠宝、第一次点 ——
  let s = await state(page);
  const at = s.stand.at;
  check('「你的星球」上站着翠宝（在画面里、没被挡住），星球视图里按地标放大', !!at && s.stand.scale > 1.5, `画面 (${Math.round(at?.x)}, ${Math.round(at?.y)})，放大 ${s.stand.scale.toFixed(2)} 倍`);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(350);
  s = await state(page);
  check('悬停翠宝：手形光标、轻轻一缩', s.cursor === 'pointer' && s.hover && s.squash > 0.6, `cursor=${s.cursor}，缩 ${s.squash.toFixed(2)}`);
  await page.screenshot({ path: `shots/coupons-${tag}-1-hover.png` });
  await startFrames(page);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(60);
  const s1 = await state(page);
  const spitOk = s1.mode === 'spit' && s1.actor === 'stand';
  const rested = await restAll(page, 3);
  const f1 = await stopFrames(page);
  frameMaxes.push(Math.max(...f1));
  s = await state(page);
  const firstIds = s.coupons.map((c) => c.id);
  check('点翠宝：蓄力、弹起、吐出 3–5 张券，落在草上', spitOk && rested && s.coupons.length >= 3 && s.coupons.length <= 5 && s.counts.spits === 1, `${s.coupons.length} 张`);
  check('第一次点（吐券到落地）最长帧间隔 < 33 ms', Math.max(...f1) < FRAME_LIMIT, frameNote(f1));
  check('点过页面以后才出声（AudioContext 开场时建好、不出声，第一次按下时才唤醒）', s.audio === true);
  await page.screenshot({ path: `shots/coupons-${tag}-2-landed.png` });

  // —— 2. 冷却中再点：摇头 ——
  check('吐完以后在冷却中', s.cooldown > 0.3, `还剩 ${s.cooldown.toFixed(2)} 秒`);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(80);
  s = await state(page);
  check('冷却中再点：只摇头，不吐券', s.mode === 'shake' && s.counts.shakes === 1 && s.counts.spits === 1 && s.coupons.length === firstIds.length);
  await until(page, () => window.__coupons.state().cooldown === 0 && window.__coupons.state().mode === 'idle', null, 5000);
  await page.mouse.click(at.x, at.y);
  await restAll(page, firstIds.length + 3);
  s = await state(page);
  const secondIds = s.coupons.map((c) => c.id).filter((id) => !firstIds.includes(id));
  const secondLanded = s.clock; // 游戏时间（截图时主循环停住，墙上时间会多走）
  check('冷却过了再点：又吐一次', s.counts.spits === 2 && secondIds.length >= 3, `第二次 ${secondIds.length} 张`);

  // —— 3. 悬停券、捡一张 ——
  const pickable = s.coupons.filter((c) => c.at && secondIds.includes(c.id));
  const target = pickable[Math.floor(pickable.length / 2)];
  await page.mouse.move(target.at.x, target.at.y);
  await page.waitForTimeout(200);
  s = await state(page);
  check('悬停券：手形光标', s.cursor === 'pointer' && s.hover);
  await startFrames(page);
  await page.mouse.click(target.at.x, target.at.y);
  const opened = await until(page, () => window.__coupons.state().card.title !== null, null, 4000);
  await page.waitForTimeout(800); // 纸往下翻开
  const f2 = await stopFrames(page);
  frameMaxes.push(Math.max(...f2));
  s = await state(page);
  const card = await page.evaluate(() => {
    const q = (sel) => document.querySelector(`.coupon-card ${sel}`);
    const a = q('.cc-use');
    const r = q('.cc-ticket')?.getBoundingClientRect();
    return {
      title: q('.cc-title')?.textContent, value: q('.cc-value')?.textContent, blurb: q('.cc-blurb')?.textContent, code: q('.cc-code')?.textContent,
      copy: q('.cc-copy')?.textContent, href: a?.href, target: a?.target, rel: a?.rel, linkText: a?.textContent,
      ticket: r ? { w: r.width, h: r.height } : null, focus: document.activeElement?.className ?? '',
      visible: getComputedStyle(document.querySelector('.coupon-layer')).visibility === 'visible',
    };
  });
  check('点券：飞到镜头前，展开成卡片（共享元素：卡片上同一张券）', opened && card.visible && card.ticket?.w > 300 && Math.abs(card.ticket.w / card.ticket.h - 2) < 0.05, `券 ${Math.round(card.ticket?.w)}×${Math.round(card.ticket?.h)}`);
  check('捡券到卡片展开最长帧间隔 < 33 ms', Math.max(...f2) < FRAME_LIMIT, frameNote(f2));
  check('卡片：券名、面额、说明、兑换码', !!card.title && !!card.value && !!card.blurb && /^TRIBOO-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(card.code ?? '') && card.code === target.code, `${card.title} · ${card.value} · ${card.code}`);
  check('卡片：「Copy code」按钮（打开时焦点在它上面）', card.copy === 'Copy code' && card.focus.includes('cc-copy'));
  check('卡片：「Use on Tripo」在新标签页打开 tripo3d.ai', card.href === 'https://www.tripo3d.ai/' && card.target === '_blank' && card.rel.includes('noopener') && card.linkText.includes('Use on Tripo'), card.href);
  await page.screenshot({ path: `shots/coupons-${tag}-3-card.png` });

  // —— 4. 复制、关卡片 ——
  await page.locator('.coupon-card .cc-copy').click();
  await page.waitForTimeout(150);
  const copied = await page.evaluate(async () => ({ text: await navigator.clipboard.readText().catch(() => null), button: document.querySelector('.coupon-card .cc-copy')?.textContent, status: document.querySelector('.coupon-card .cc-status')?.textContent }));
  check('Copy code：兑换码进了剪贴板，按钮变成 Copied!、读屏有提示', copied.text === card.code && copied.button === 'Copied!' && !!copied.status, `剪贴板「${copied.text}」`);
  await page.screenshot({ path: `shots/coupons-${tag}-4-copied.png` });
  await page.keyboard.press('Escape');
  const closed = await until(page, () => !window.__coupons.state().card.open, null, 2000);
  check('Esc 关卡片', closed);

  // —— 5. 没捡的 10 秒后淡出 ——
  const rest = secondIds.filter((id) => id !== target.id);
  await until(page, (t) => window.__coupons.state().clock >= t + 9, secondLanded, 20000);
  s = await state(page);
  const stillThere = rest.filter((id) => s.coupons.some((c) => c.id === id)).length;
  await until(page, (t) => window.__coupons.state().clock >= t + 10 + 0.8, secondLanded, 20000);
  s = await state(page);
  const goneLater = rest.every((id) => !s.coupons.some((c) => c.id === id));
  check('没捡的券：落地 9 秒时还在，10 秒后淡出消失', stillThere === rest.length && goneLater, `9 秒时 ${stillThere}/${rest.length} 张，10.8 秒时 ${s.coupons.length} 张`);

  // —— 6. 漫游 ——
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.locator('.topbar button.walk').click();
  await until(page, () => window.__walk.state().phase === 'walk', null, 8000);
  await page.evaluate(() => window.__walk.teleport([0, 0, -1], [1, 0, 0])); // 赤道上一处空地（同 check-walk）
  await page.waitForTimeout(700);
  s = await state(page);
  const w0 = await page.evaluate(() => window.__walk.state());
  check('漫游时站桩的翠宝让位（漫游的角色就是翠宝）', !s.stand.shown);
  await until(page, () => window.__coupons.state().cooldown === 0 && window.__coupons.state().mode === 'idle', null, 5000);
  const before = (await state(page)).coupons.length;
  await startFrames(page);
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  const s6 = await state(page);
  const restedW = await restAll(page, before + 3);
  const f3 = await stopFrames(page);
  frameMaxes.push(Math.max(...f3));
  s = await state(page);
  check('漫游、附近没有作品时按 E：翠宝转身对着镜头、吐券', w0.near === null && s6.mode === 'spit' && s6.actor === 'walker' && restedW && s.coupons.length >= before + 3, `${s.coupons.length - before} 张`);
  check('漫游中吐券最长帧间隔 < 33 ms', Math.max(...f3) < FRAME_LIMIT, frameNote(f3));
  await page.screenshot({ path: `shots/coupons-${tag}-5-walk.png` });
  // 冷却中点翠宝：摇头，不走过去
  const wa = s.walker.at;
  await page.mouse.click(wa.x, wa.y);
  await page.waitForTimeout(100);
  s = await state(page);
  let ws = await page.evaluate(() => window.__walk.state());
  check('漫游中点翠宝（冷却中）：摇头，角色不走过去', s.mode === 'shake' && s.actor === 'walker' && !ws.moving && ws.target === null);
  // 点券：卡片，不走过去
  await until(page, () => window.__coupons.state().mode === 'idle', null, 3000);
  s = await state(page);
  const wc = s.coupons.filter((c) => c.at && c.phase === 'rest').sort((a, b) => Math.abs(a.at.x - 720) - Math.abs(b.at.x - 720))[0];
  await page.mouse.click(wc.at.x, wc.at.y);
  const openedW = await until(page, () => window.__coupons.state().card.title !== null, null, 4000);
  ws = await page.evaluate(() => window.__walk.state());
  check('漫游中点券：卡片展开，角色不走过去', openedW && !ws.moving && ws.target === null);
  await page.screenshot({ path: `shots/coupons-${tag}-6-walk-card.png` });
  await page.keyboard.press('Escape');
  await until(page, () => !window.__coupons.state().card.open, null, 2000);
  ws = await page.evaluate(() => window.__walk.state());
  check('卡片开着时按 Esc 只关卡片，还在漫游', ws.phase === 'walk');
  // 靠近作品按 E：还是作品卡
  const obstacles = await page.evaluate(() => window.__walk.obstacles());
  const near = obstacles[0];
  await page.evaluate(([d, minAngle]) => {
    const n = Math.hypot(...d);
    const c = d.map((x) => x / n);
    const north = [0, 1, 0].map((x, i) => x - c[1] * c[i]);
    const nl = Math.hypot(...north);
    const back = north.map((x) => -x / nl);
    const a = minAngle + 0.6 / 30; // 作品圆柱外 0.6 米（同 check-walk）
    const pos = c.map((x, i) => x * Math.cos(a) + back[i] * Math.sin(a));
    const head = c.map((x, i) => x - pos[i] * (c[0] * pos[0] + c[1] * pos[1] + c[2] * pos[2]));
    window.__walk.teleport(pos, head);
  }, [near.dir, near.minAngle]);
  await page.waitForTimeout(500);
  const nearState = await page.evaluate(() => window.__walk.state());
  const spitsBefore = (await state(page)).counts.spits;
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  const workCard = await page.evaluate(() => { const c = document.querySelector('.work-card'); return c && !c.hidden; });
  check('靠近作品按 E：照旧打开作品卡，不吐券', nearState.near !== null && workCard && (await state(page)).counts.spits === spitsBefore, `附近的作品 ${nearState.near}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await until(page, () => window.__walk.state().phase === 'off', null, 4000);

  // —— 7. 离开星球 ——
  await page.evaluate(() => { location.hash = '#/'; });
  await until(page, () => window.__app.routeIdle() && location.hash === '#/', null, 10000);
  s = await state(page);
  check('回星系：地上的券、站桩翠宝都收掉', s.coupons.length === 0 && !s.stand.shown);
  await page.close();

  // —— 8. 减弱动效 ——
  const { page: rp } = await openPage({ reducedMotion: 'reduce' });
  s = await state(rp);
  await rp.evaluate(() => {
    window.__phases = new Set();
    const tick = () => {
      for (const c of window.__coupons.state().coupons) window.__phases.add(c.phase);
      if (window.__phases) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await rp.mouse.click(s.stand.at.x, s.stand.at.y);
  const restedR = await restAll(rp, 3);
  const phases = await rp.evaluate(() => [...window.__phases]);
  s = await state(rp);
  check('减弱动效：券不飞不翻，直接在翠宝身边淡入', restedR && !phases.includes('fly') && phases.includes('appear') && s.coupons.length >= 3, phases.join(' → '));
  await rp.screenshot({ path: `shots/coupons-${tag}-7-reduced.png` });
  const rc = s.coupons.find((c) => c.at);
  await rp.mouse.click(rc.at.x, rc.at.y);
  const openedR = await until(rp, () => window.__coupons.state().card.title !== null, null, 3000);
  check('减弱动效：点券，卡片直接淡入', openedR);
} catch (err) {
  check('脚本跑完', false, firstLine(err));
}

const allErrors = errors.flat();
console.log(`backend: ${backend}；DPR ${DPR}；最长帧间隔 ${frameMaxes.map((x) => x.toFixed(1)).join(' / ')} ms`);
console.log(results.join('\n'));
if (allErrors.length) console.log(`页面错误：\n${allErrors.join('\n')}`);
const ok = results.length > 0 && results.every((r) => r.startsWith('✓')) && allErrors.length === 0;
console.log(ok ? 'COUPONS OK' : 'COUPONS FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

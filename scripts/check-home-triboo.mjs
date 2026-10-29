// 首页翠宝元素自查（云朵翠宝、开场星尘拼标志）：
// 1. 开场：星尘拼标志的进度从 0 涨到 1、停、回到 0；右边的翠宝探头在它放完以后才开始（两个不同时出现）
// 2. 云朵翠宝聚好以后：截默认视角；它在画面里、不压星球（连名牌）、不压标题卡片；一次绘制
// 3. 更俯视的角度：镜头往上抬 18° 截一张（Replay 让它按新角度重新聚）
// 4. 开销：?gputime 量云朵翠宝开着 / 关掉时主画面每帧的 GPU 时间（差值就是它的开销）；首页 12 秒里的最长帧
// 5. 手机竖屏（390 × 844）：截一张
// WEBGL2=1：走 WebGL2。截图放 team/home-triboo/
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const OUT = '.superpowers/sdd/2026-10-27-community-planets/team/home-triboo';
mkdirSync(OUT, { recursive: true });
const WEBGL2 = process.env.WEBGL2 === '1';
const tag = WEBGL2 ? 'webgl2' : 'webgpu';
const results = [];
const numbers = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const errorLists = [];

async function open(viewport, query = '') {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.width < 700 ? 2 : 1 });
  errorLists.push(watchErrors(page));
  if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.addInitScript(() => {
    window.__gaps = null;
    window.__events = [];
    let last = 0;
    const tick = (t) => {
      if (window.__gaps && last) window.__gaps.push(t - last);
      last = t;
      const s = window.__world?.galaxy?.shapeState;
      const p = s ? s.progress : 0;
      const greet = window.__home?.state().intro ?? false;
      const ev = window.__events;
      const prev = ev.at(-1);
      const cur = `${p > 0.01 ? 'shape' : '-'}|${greet ? 'greet' : '-'}`;
      if (!prev || prev.s !== cur) ev.push({ s: cur, at: Math.round(t), p });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${base}/?nolocal${query}`);
  return page;
}
const cloudState = (page) => page.evaluate(async () => (await import('/src/scenes/homeCloudTriboo.ts')).cloudTriboo()?.state ?? null);
const waitShown = (page) => page.waitForFunction(async () => (await import('/src/scenes/homeCloudTriboo.ts')).cloudTriboo()?.state.phase === 'show', null, { timeout: 60000 });

// 云在屏幕上的圆，和星球（连名牌）、标题卡片有没有压到
const overlap = (page) => page.evaluate(async () => {
  const m = await import('/src/scenes/homeCloudTriboo.ts');
  const ct = m.cloudTriboo();
  const w = window.__world;
  const st = ct.state;
  const cam = w.rig.camera;
  const v = cam.position.clone().set(...st.center).project(cam);
  const x = ((v.x + 1) / 2) * innerWidth;
  const y = ((1 - v.y) / 2) * innerHeight;
  const d = cam.position.distanceTo(cam.position.clone().set(...st.center));
  const r = ((st.scale * 1.6) / d / Math.tan((cam.fov * Math.PI) / 360)) * (innerHeight / 2);
  const hits = [];
  const c = { x: 0, y: 0, r: 0 };
  for (const e of w.planets.values()) {
    if (!w.planetOnScreen(e, c)) continue;
    const nx = Math.max(c.x - c.r, Math.min(x, c.x + c.r));
    const ny = Math.max(c.y - c.r, Math.min(y, c.y + c.r + 34));
    if (Math.hypot(nx - x, ny - y) < r) hits.push(e.team.id);
  }
  const card = document.querySelector('#app .tb-title')?.getBoundingClientRect();
  const onCard = card ? x + r > card.left && x - r < card.right && y + r > card.top && y - r < card.bottom : false;
  return { x: Math.round(x), y: Math.round(y), r: Math.round(r), inView: x - r >= 0 && x + r <= innerWidth && y - r >= 0 && y + r <= innerHeight, hits, onCard };
});

try {
  // —— 1、2：开场、默认视角 ——
  const page = await open({ width: 1440, height: 900 }, '&gputime');
  await page.waitForFunction(() => window.__ready === true && !document.querySelector('#boot'), null, { timeout: 90000 });
  await page.waitForFunction(() => (window.__home?.state().intro ?? false) || (window.__events ?? []).some((e) => e.s.endsWith('greet')), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const ev = await page.evaluate(() => window.__events);
  const shapeOn = ev.find((e) => e.s.startsWith('shape'));
  const shapeOff = ev.find((e, i) => i > 0 && !e.s.startsWith('shape') && ev.slice(0, i).some((x) => x.s.startsWith('shape')));
  const greetOn = ev.find((e) => e.s.endsWith('greet'));
  const both = ev.some((e) => e.s === 'shape|greet');
  check('开场：星尘拼了标志（进度涨到 1 又回到 0）', !!shapeOn && !!shapeOff, ev.map((e) => `${e.s}@${e.at}`).join(' '));
  check('开场：右边的翠宝在星尘放完以后才探头（两个不同时出现）', !!greetOn && !both && (!shapeOff || greetOn.at >= shapeOff.at), greetOn ? `探头 @${greetOn.at}，星尘结束 @${shapeOff?.at}` : '没有探头');
  await waitShown(page);
  await page.waitForTimeout(400);
  const o = await overlap(page);
  check('云朵翠宝：在画面里，不压星球（连名牌）、标题卡片', o.inView && o.hits.length === 0 && !o.onCard, JSON.stringify(o));
  const calls = await page.evaluate(() => window.__world.renderer.info.render.drawCalls);
  numbers.push(`首页每帧绘制调用 ${calls}`);
  await page.screenshot({ path: `${OUT}/cloud-triboo-default-${tag}.png` });

  // —— 4：开销 ——
  const gpu = (n) => page.evaluate(async (count) => {
    const w = window.__world;
    const out = [];
    let pending = 0;
    await new Promise((resolve) => {
      let seen = 0;
      const after = () => {
        seen++;
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((ms) => { pending--; if (typeof ms === 'number' && ms > 0) out.push(ms); }, () => { pending--; });
        if (seen >= count) {
          w.renderHooks.delete(after);
          resolve();
        }
      };
      w.renderHooks.add(after);
    });
    for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
    return out;
  }, n);
  const on = await gpu(180);
  await page.evaluate(async () => { (await import('/src/scenes/homeCloudTriboo.ts')).CLOUD_TRIBOO.on = 0; });
  await page.waitForTimeout(1500);
  const off = await gpu(180);
  await page.evaluate(async () => { (await import('/src/scenes/homeCloudTriboo.ts')).CLOUD_TRIBOO.on = 1; });
  const dGpu = pct(on, 0.5) - pct(off, 0.5);
  numbers.push(`GPU（${tag}）：云朵翠宝开着 p50 ${pct(on, 0.5).toFixed(3)} ms / 关掉 ${pct(off, 0.5).toFixed(3)} ms，差 ${dGpu.toFixed(3)} ms（${on.length}/${off.length} 个样本）`);
  check('云朵翠宝的 GPU 开销 ≤ 0.1 ms', !(dGpu > 0.1), `${dGpu.toFixed(3)} ms`);
  // 首页 12 秒：中间让云散开、换地方再聚一次（Replay），量最长帧
  await page.evaluate(() => { window.__gaps = []; });
  await page.evaluate(async () => (await import('/src/scenes/homeCloudTriboo.ts')).cloudTriboo()?.replay());
  await page.waitForTimeout(12000);
  const gaps = await page.evaluate(() => { const g = window.__gaps; window.__gaps = null; return g; });
  const maxGap = Math.max(...gaps);
  numbers.push(`首页 12 秒（含云散开、换地方再聚）：帧间隔 p50 ${pct(gaps, 0.5).toFixed(1)} / p95 ${pct(gaps, 0.95).toFixed(1)} / 最长 ${maxGap.toFixed(1)} ms（${tag}，1440×900 DPR 1）`);
  check('首页最长帧 ≤ 33 ms', maxGap <= 33.5, `${maxGap.toFixed(1)} ms`);
  await waitShown(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/cloud-triboo-regathered-${tag}.png` });

  // —— 3：更俯视 ——
  await page.evaluate(() => {
    const w = window.__world;
    const c = w.rig.controls;
    c.minPolarAngle = 0.05;
    const off = w.rig.camera.position.clone().sub(c.target);
    const sph = { r: off.length(), phi: Math.acos(off.y / off.length()), theta: Math.atan2(off.x, off.z) };
    sph.phi = Math.max(0.12, sph.phi - (18 * Math.PI) / 180);
    w.rig.camera.position.set(Math.sin(sph.phi) * Math.sin(sph.theta), Math.cos(sph.phi), Math.sin(sph.phi) * Math.cos(sph.theta)).multiplyScalar(sph.r).add(c.target);
    c.update();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/cloud-triboo-topdown-asis-${tag}.png` });
  await page.evaluate(async () => (await import('/src/scenes/homeCloudTriboo.ts')).cloudTriboo()?.replay());
  await waitShown(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/cloud-triboo-topdown-${tag}.png` });
  const ot = await overlap(page);
  check('更俯视的角度：重新聚的云也在画面里、不压星球', ot.inView && ot.hits.length === 0, JSON.stringify(ot));
  await page.close();

  // —— 5：手机竖屏 ——
  const phone = await open({ width: 390, height: 844 });
  await phone.waitForFunction(() => window.__ready === true && !document.querySelector('#boot'), null, { timeout: 90000 });
  // 手机上标题卡片量好以后镜头会重新取景：云发现压到星球会提前散开、换个地方再聚。等它安定下来再看
  let shown = await waitShown(phone).then(() => true, () => false);
  await phone.waitForTimeout(1500);
  shown = await waitShown(phone).then(() => true, () => false);
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: `${OUT}/cloud-triboo-phone-${tag}.png` });
  const op = shown ? await overlap(phone) : null;
  check('手机竖屏：云朵翠宝聚起来了、在画面里、不压星球', shown && op.inView && op.hits.length === 0, JSON.stringify(op ?? (await cloudState(phone))));
  await phone.close();
} catch (err) {
  check('脚本中断', false, String(err?.stack ?? err).split('\n')[0]);
} finally {
  const errors = errorLists.flat();
  console.log(`${tag}`);
  for (const n of numbers) console.log(n);
  console.log(results.join('\n'));
  if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.join('\n')}`);
  const ok = !results.some((r) => r.startsWith('✗')) && errors.length === 0;
  console.log(ok ? 'HOME-TRIBOO OK' : 'HOME-TRIBOO FAIL');
  process.exitCode = ok ? 0 : 1;
  await browser.close();
  await server.close();
}

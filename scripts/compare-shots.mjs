// 第一版 / 第二版对比截图（v2-compare）：给一个地址，按同样的步骤、在同样的时刻截同样的画面。
// node scripts/compare-shots.mjs <base> <输出目录> <前缀 v1|v2> [--only 1440,390]
//   base：构建版的地址（第一版 http://127.0.0.1:4173、第二版 http://127.0.0.1:4174），都带 ?nolocal（种子里的占位作品，两边一样）
// 1440×900（像素比 1）：启动画面（停在「预热」那一段）、首页正面、首页侧面（转 90°）、领券窗口（点右下角的翠宝）、星球页、
//   跳星球的转场中间（时间停住、逐帧走到光扫过的那一刻）、漫游近景、Members、Museum、作品查看器、造星窗口第 2 步、造星冲出来的那一刻
// 390×844（像素比 2）：首页、星球页、Museum
// 用到的都是两版都有的调试接口：window.__bootHold、__home、__trans、__walk、__create、__app、__world（构建版里也有）
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
const [base, out, tag] = positional;
if (!base || !out || !tag) {
  console.log('用法：node scripts/compare-shots.mjs <base> <输出目录> <前缀> [--only 1440,390]');
  process.exit(1);
}
const only = opt('--only', '1440,390').split(',');
mkdirSync(out, { recursive: true });
const you = 'lumen-guild';
const other = 'quiet-vertex';
const browser = await launch();
const problems = [];

const frames = (p, n = 2) => p.evaluate((k) => new Promise((r) => {
  let i = 0;
  const step = () => (++i >= k ? r() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);
const until = (p, fn, arg = null, timeout = 60000) => p.waitForFunction(fn, arg, { timeout });
const ready = (p) => until(p, () => window.__ready === true && !document.querySelector('#boot') && window.__app?.routeIdle(), null, 120000);
const planetReady = (p, id) => until(p, (x) => document.querySelector('#app')?.dataset.planetReady === x && window.__app.routeIdle(), id, 120000);
const galaxyIdle = (p) => until(p, () => (location.hash === '' || location.hash === '#/') && window.__app.routeIdle() && !window.__trans.state().transition, null, 60000);
const go = (p, hash) => p.evaluate((h) => { location.hash = h; }, hash);

// 一张：出错只记下来，接着截后面的
async function step(p, name, fn) {
  try {
    await fn();
    if (name !== '04-claim') await p.mouse.move(4, 450); // 指针挪到边上：不让顶栏的按钮停在悬停的样子
    await frames(p, 2);
    await p.waitForTimeout(250);
    await p.screenshot({ path: join(out, `${tag}-${name}.png`) });
    console.log(`✓ ${tag}-${name}`);
  } catch (err) {
    problems.push(`${tag}-${name}：${String(err?.message ?? err).split('\n')[0]}`);
    console.log(`✗ ${tag}-${name}`);
  }
}

// 镜头绕环绕中心转到方位角 turn 度（保持仰角）
const turnTo = (p, turnDeg) => p.evaluate((deg) => {
  const w = window.__world;
  const cam = w.rig.camera;
  const t = w.rig.controls.target;
  const off = cam.position.clone().sub(t);
  const dist = off.length();
  const el = Math.asin(off.y / dist);
  const az = (deg * Math.PI) / 180;
  cam.position.set(t.x + Math.sin(az) * Math.cos(el) * dist, t.y + Math.sin(el) * dist, t.z + Math.cos(az) * Math.cos(el) * dist);
  w.rig.controls.update();
}, turnDeg);

// 时间停住、逐帧往前走 seconds 秒（转场的中间帧）
const stepFor = async (p, seconds) => {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) await p.evaluate(() => new Promise((r) => { window.__trans.advance(1 / 60); requestAnimationFrame(() => requestAnimationFrame(r)); }));
};

async function wide() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
  const p = await ctx.newPage();
  const errors = watchErrors(p);
  // 启动画面只在「预热」那一段停住（两版的这一段都有：建天空 → 预热 → 落地）
  await p.addInitScript(() => {
    window.__bootHold = (phase) => (phase === 'warm' ? new Promise((done) => { window.__bootAt = phase; window.__bootGo = () => { window.__bootAt = null; done(); }; }) : Promise.resolve());
  });
  await p.goto(`${base}/?nolocal`);

  await step(p, '01-boot', async () => {
    await until(p, () => window.__bootAt === 'warm' && !!document.querySelector('#boot'), null, 60000);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(1200);
  });
  await p.evaluate(() => window.__bootGo?.());
  await ready(p);
  // 开场：飞进星系、星尘拼标志、右下角翠宝打招呼，等它们都放完
  await p.waitForTimeout(8000);
  await p.mouse.move(720, 40);
  await step(p, '02-home', async () => {
    await turnTo(p, 0);
    await p.waitForTimeout(1200);
  });
  await step(p, '03-home-side', async () => {
    await turnTo(p, 90);
    await p.waitForTimeout(1500);
  });
  await turnTo(p, 0);
  await p.waitForTimeout(800);
  await step(p, '04-claim', async () => {
    await until(p, () => !!window.__home?.state().triboo?.at && window.__home.state().triboo.cooldown === 0 && !window.__home.state().card.open, null, 20000);
    const at = await p.evaluate(() => window.__home.state().triboo.at);
    await p.mouse.move(at.x, at.y);
    await p.waitForTimeout(300);
    await p.mouse.click(at.x, at.y);
    await until(p, () => window.__home.state().card.shown, null, 8000);
    await p.waitForTimeout(1200);
  });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(800);
  await p.mouse.move(720, 40);

  await go(p, `#/t/${you}`);
  await step(p, '05-planet', async () => {
    await planetReady(p, you);
    await p.waitForTimeout(2500);
  });
  // 跳星球：时间停住，走到光扫过的那一刻（跳星球 1.4 秒，光在 0.4、约 120 ms；两版的分镜表一样）
  await step(p, '06-hop', async () => {
    await p.evaluate(() => window.__trans.timeScale(0));
    await go(p, `#/t/${other}`);
    await until(p, () => !!window.__trans.state().transition, null, 8000);
    await stepFor(p, 1.4 * 0.443);
  });
  await p.evaluate(() => window.__trans.timeScale(1));
  await planetReady(p, other).catch(() => {});
  await p.waitForTimeout(800);
  await go(p, `#/t/${you}`);
  await planetReady(p, you);
  await p.waitForTimeout(1500);

  // 漫游近景：站在 fantasy-sorcerer 正面 3.2 米、往旁边偏 0.6 米，面朝它（同 shot-planet 的 walkNear）
  await step(p, '07-walk', async () => {
    await until(p, () => window.__walk?.state().ready === true, null, 30000);
    await p.locator('.topbar button.walk').click();
    await until(p, () => window.__walk.state().phase === 'walk', null, 8000);
    await p.evaluate(([d, sd]) => {
      // 两版都挑同一件作品（第二版的中古点缀里有一座矮石塔正好挡在另几件前面）
      const all = window.__walk.obstacles();
      const o = all.find((x) => x.id === 'fantasy-sorcerer') ?? all[1] ?? all[0];
      const c = o.dir;
      const R = window.__walk.state().radius;
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
      const north = norm([0, 1, 0].map((u, k) => u - c[k] * dot(c, [0, 1, 0])));
      const east = norm([c[1] * north[2] - c[2] * north[1], c[2] * north[0] - c[0] * north[2], c[0] * north[1] - c[1] * north[0]]);
      const a = (o.minAngle * R + d) / R;
      const q = norm(c.map((x, k) => x * Math.cos(a) - north[k] * Math.sin(a) + east[k] * (sd / R)));
      const h = norm(c.map((x, k) => x - q[k] * dot(q, c)));
      window.__walk.teleport(q, h);
    }, [3.2, 0.6]);
    await p.waitForTimeout(2600);
  });
  await p.keyboard.press('Escape');
  await until(p, () => window.__walk.state().phase === 'off', null, 8000).catch(() => {});
  await p.waitForTimeout(800);

  await go(p, `#/t/${you}/members`);
  await step(p, '08-members', async () => {
    await until(p, () => location.hash.endsWith('/members') && window.__app.routeIdle());
    await p.waitForTimeout(1800);
  });
  await go(p, `#/t/${you}/museum`);
  await step(p, '09-museum', async () => {
    await until(p, () => document.querySelector('section.museum')?.dataset.ready === 'true' && window.__app.routeIdle());
    await p.waitForTimeout(1500);
  });
  const work = await p.evaluate(() => window.__app.placedIds()[0] ?? null);
  if (work) {
    await go(p, `#/t/${you}/museum/${work}`);
    await step(p, '10-viewer', async () => {
      await until(p, () => !!document.querySelector('.viewer-stage.ready') && window.__app.routeIdle());
      await p.waitForTimeout(1500);
    });
  } else problems.push(`${tag}-10-viewer：星球上没有摆着的作品`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  await go(p, '#/');
  await galaxyIdle(p);
  await p.waitForTimeout(1500);

  // 造星：第 1 步填名字 → 第 2 步（选样子）截一张 → 第 3、4 步 → Launch，冲出来的那一刻时间停住截一张
  await go(p, '#/create');
  await step(p, '11-create-look', async () => {
    await until(p, () => window.__create?.state().open && window.__create.state().previewReady && !document.querySelector('section.creator')?.hidden, null, 60000);
    await p.locator('#cp-name').fill('Pebble Party');
    await p.locator('#cp-motto').fill('Small rocks, big dreams.');
    await p.locator('.cp-next').click();
    await until(p, () => window.__create.state().step === 'look' && !document.querySelector('.cp-page[data-page="look"]').hidden);
    await until(p, () => window.__create.state().previewReady);
    await p.waitForTimeout(1200);
  });
  await step(p, '12-create-burst', async () => {
    await p.locator('.cp-next').click();
    await until(p, () => window.__create.state().step === 'crew');
    await p.locator('.cp-next').click();
    await until(p, () => window.__create.state().step === 'launch');
    await until(p, () => window.__create.state().twinReady !== false, null, 30000).catch(() => {});
    await p.waitForTimeout(600);
    // 冲出来的那一帧：页面里每帧看阶段，一到 burst 就把时间停住（两版的 Launch 都按主循环的 dt 走）
    await p.evaluate(() => {
      window.__burstSeen = 0;
      const tick = () => {
        const ph = window.__create.state().launch.phase;
        if (ph === 'burst') window.__burstSeen++;
        if (window.__burstSeen >= 6) { window.__trans.timeScale(0); return; }
        if (ph === 'home') return;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await p.locator('.cp-next').click();
    await until(p, () => window.__burstSeen >= 6, null, 30000);
    await p.waitForTimeout(400);
  });
  await p.evaluate(() => window.__trans.timeScale(1));
  if (errors.length) problems.push(...errors.map((e) => `${tag} 1440：${e}`));
  await ctx.close();
}

async function tall() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = watchErrors(p);
  await p.goto(`${base}/?nolocal`);
  await ready(p);
  await p.waitForTimeout(8000);
  await step(p, 'm1-home', async () => {
    await turnTo(p, 0);
    await p.waitForTimeout(1200);
  });
  await go(p, `#/t/${you}`);
  await step(p, 'm2-planet', async () => {
    await planetReady(p, you);
    await p.waitForTimeout(2500);
  });
  await go(p, `#/t/${you}/museum`);
  await step(p, 'm3-museum', async () => {
    await until(p, () => document.querySelector('section.museum')?.dataset.ready === 'true' && window.__app.routeIdle());
    await p.waitForTimeout(1500);
  });
  if (errors.length) problems.push(...errors.map((e) => `${tag} 390：${e}`));
  await ctx.close();
}

try {
  if (only.includes('1440')) await wide();
  if (only.includes('390')) await tall();
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  console.log(`样张在 ${out}`);
  await browser.close();
}

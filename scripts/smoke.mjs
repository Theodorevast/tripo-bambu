// 冒烟测试：把整个流程走一遍，每一步截图到 shots/smoke-NN-<步骤>.png，最后统计页面错误。
// 开发服务器：node scripts/smoke.mjs（自己起服务器，跑完关掉）；构建预览或线上：SMOKE_BASE=<地址> node scripts/smoke.mjs
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备。HEADED=1：开有界面的 Chrome（无头模式下可能拿不到 WebGPU）
// 流程：启动画面三个阶段 → 打开星系 → 点进自己的星球 → Members → Museum → 打开一件作品 → 回到星球 → 编辑模式摆一件作品
// → Reset demo → 进入漫游、按住 W 走一秒 → 退出 → 回星系；再另开两页：手机尺寸的启动画面、做不了 3D 的浏览器。
// （B1 的 db0ca1e 搬到 int/v6：开页带 ?nolocal；转场在 int/v6 上，进出星球都等路由空闲和就绪信号，步骤不变）
// 等待都用页面上现有的就绪信号，不用固定的 sleep（只有「按住 W 一秒」本身要按一秒）：
// 启动画面 #boot（挂上 window.__bootHold 时每个阶段停住；撤掉后 #boot 不在了）；路由 window.__ready、window.__app.routeIdle()；
// 星球 #app[data-planet-ready="<id>"]；Museum section.museum[data-ready="true"]；查看器 .viewer-stage.ready；
// 编辑：作品栏、编辑条、placedIds / teamPlanet（同 check-editor）；漫游：window.__walk.state()（同 check-walk）
import { mkdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
// 开发服务器上「你的星球」默认换成本机的私有真实模型（作品名和种子数据对不上）：带 ?nolocal 按种子数据走（构建预览、线上本来就不换）
const QUERY = '?nolocal';
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const target = you.works[0]; // 编辑时拿下来、再从作品栏摆回去的作品；Museum 里打开的也是它
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const results = [];
const errorLists = []; // [页面名, watchErrors 收集的数组]
let local = null;
let browser = null;
let base = '';
let backend = '?';
let art = '?';
let numbers = '';
let fatal = null;
let shotCount = 0;
let main = null; // 主流程的页面：步骤没返回别的页面时截它

// 等页面里的条件成立；超时时说清楚等的是什么
const until = (p, what, fn, arg = null, timeout = 30000) =>
  p.waitForFunction(fn, arg, { timeout }).catch((err) => { throw new Error(`等不到${what}（${firstLine(err)}）`); });
// 截图前等两帧：画面赶上刚做的改动
const shot = async (p, name) => {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await p.screenshot({ path: `shots/smoke-${String(++shotCount).padStart(2, '0')}-${name}.png` });
};
// 点之前先确认：那一点在画面里，而且是画布（没有顶栏、作品栏这些界面挡着）
const clickable = async (p, what, at) => {
  if (!at) throw new Error(`${what}不在画面里`);
  if (!(await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', at))) throw new Error(`${what}（${Math.round(at.x)}, ${Math.round(at.y)}）被界面挡住`);
  return at;
};
// 星球视图就绪：地址对、路由空闲、这次进入的模型都挂好、团队的作品全部摆上（按 id 比）
const planetReady = (p, team) => until(p, ` ${team.id} 的星球视图就绪`, ([id, ids]) => {
  const placed = window.__app.placedIds();
  return location.hash === `#/t/${id}` && window.__app.routeIdle()
    && document.querySelector('#app')?.dataset.planetReady === id && ids.every((w) => placed.includes(w));
}, [team.id, team.works.map((w) => w.id)], 60000);

async function open(name, viewport = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport });
  errorLists.push([name, watchErrors(p)]);
  if (process.env.WEBGL2 === '1') await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  return p;
}

// 启动画面每进一个阶段就停住（window.__bootHold），脚本调 window.__bootGo() 放行
async function holdBoot(p) {
  await p.addInitScript(() => {
    window.__bootHold = (phase) => new Promise((go) => {
      window.__bootAt = phase;
      window.__bootGo = () => {
        window.__bootAt = null;
        go();
      };
    });
  });
}
const bootAt = (p, phase) => until(p, `启动画面停在 ${phase}`, (x) => {
  const boot = document.querySelector('#boot');
  return window.__bootAt === x && boot?.dataset.phase === x && !!boot.dataset.art && boot.querySelector('.boot-steps .is-now')?.getAttribute('aria-current') === 'step';
}, phase);
// 截启动画面之前：字体下好、翠宝动图的淡入放完（没有动图时直接过）
const bootSettled = (p) => p.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(document.querySelector('#boot .boot-gif')?.getAnimations().map((a) => a.finished.catch(() => {})) ?? []);
});

// 每一步：成功记 ✓、失败记 ✗ 和原因；name 给了就截一张图（fn 返回别的页面时截那一页，截完关掉）。
// 这一步期间新冒出来的页面错误记在这一步下面（最后还会汇总一遍）
const errorLengths = () => errorLists.map(([, list]) => list.length);
async function step(name, shotName, fn) {
  let target = null;
  const before = errorLengths();
  try {
    target = (await fn()) ?? null;
    results.push(`✓ ${name}`);
  } catch (err) {
    results.push(`✗ ${name}：${firstLine(err)}`);
  }
  const p = target ?? main;
  if (shotName && p) await shot(p, shotName).catch(() => {});
  if (target && target !== main) await target.close().catch(() => {});
  const fresh = errorLists.flatMap(([, list], i) => list.slice(before[i] ?? 0));
  if (fresh.length) results.push(`  （这一步期间的页面错误 ${fresh.length} 条，第一条：${firstLine(fresh[0])}）`);
}

try {
  mkdirSync('shots', { recursive: true });
  local = process.env.SMOKE_BASE ? null : await startServer();
  base = (process.env.SMOKE_BASE ?? local.base).replace(/\/$/, '');
  browser = await launch();

  await step('启动画面：建天空 → 预热 → 落地，每段的进度都对；之后云散开、撤掉', null, async () => {
    const p = await open('启动画面');
    try {
      await holdBoot(p);
      await p.goto(`${base}/${QUERY}`);
      for (const [i, phase] of ['sky', 'warm', 'land'].entries()) {
        await bootAt(p, phase);
        const states = await p.evaluate(() => [...document.querySelectorAll('.boot-steps li')].map((li) => li.className));
        const want = [0, 1, 2].map((j) => (j < i ? 'is-done' : j === i ? 'is-now' : 'is-todo'));
        if (!isDeepStrictEqual(states, want)) throw new Error(`${phase} 阶段的进度是 ${states.join(' ')}`);
        await bootSettled(p);
        await shot(p, `boot-${phase}`);
        await p.evaluate(() => window.__bootGo());
      }
      art = await p.evaluate(() => document.querySelector('#boot')?.dataset.art ?? '?');
      // 散开到一半：把散开的过渡都停住、拨到 400 ms 截一张，再接着放
      await until(p, '启动画面开始散开', () => document.querySelector('#boot')?.dataset.state === 'leaving');
      await p.evaluate(() => { for (const a of document.getAnimations()) if (a.constructor.name === 'CSSTransition') { a.pause(); a.currentTime = 400; } });
      await shot(p, 'boot-leaving');
      await p.evaluate(() => { for (const a of document.getAnimations()) if (a.constructor.name === 'CSSTransition') a.play(); });
      await until(p, '启动画面撤掉、首页就绪', () => !document.querySelector('#boot') && window.__ready === true);
    } finally {
      await p.close();
    }
  });

  // 主流程的页面：开页时不停，量真实的启动耗时
  const page = await open('主流程');
  main = page;
  page.on('dialog', (d) => d.accept()); // Reset demo 的确认框
  await page.addInitScript(() => {
    // 记下 window.__ready 变成 true 的时刻
    let ready;
    Object.defineProperty(window, '__ready', { configurable: true, get: () => ready, set: (v) => { ready = v; if (v) performance.mark('smoke:ready'); } });
  });

  await step('打开星系：启动画面撤掉，开场飞完；Nunito 500/600/700/800 都已经下好', 'galaxy', async () => {
    await page.goto(`${base}/${QUERY}`);
    await until(page, '首页就绪', () => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, 60000);
    await until(page, '星系标题', () => document.querySelector('.tb-name')?.textContent === 'Community Planets');
    backend = await page.evaluate(() => window.__app.backend());
    const t = await page.evaluate(() => {
      const at = (name) => Math.round(performance.getEntriesByName(name)[0]?.startTime ?? NaN);
      const fonts = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Nunito' && f.status === 'loaded' && f.unicodeRange.startsWith('U+0-FF')).map((f) => Number(f.weight));
      return { fcp: at('first-contentful-paint'), sky: at('boot:sky'), warm: at('boot:warm'), land: at('boot:land'), leave: at('boot:leave'), done: at('boot:done'), fonts: at('boot:fonts'), ready: at('smoke:ready'), weights: fonts.sort() };
    });
    numbers = `首帧（启动画面）${t.fcp} ms · 建天空 ${t.sky} · 预热 ${t.warm} · 落地 ${t.land} · 开始散开 ${t.leave} · 撤掉 ${t.done} · 字体到齐 ${t.fonts} · __ready ${t.ready}`;
    for (const w of [500, 600, 700, 800]) if (!t.weights.includes(w)) throw new Error(`Nunito ${w} 没下载（已有 ${t.weights.join('/')}）`);
    // 首帧画的就是启动画面（散开之前）；构建版的脚本很快，可能比首帧还早开始，所以不比首帧和「建天空」谁先
    if (!(t.fcp < t.leave && t.sky < t.warm && t.warm < t.land && t.land <= t.leave && t.leave < t.done)) throw new Error(`阶段顺序不对：${numbers}`);
  });

  await step(`点进自己的星球（${you.id}）：作品全部摆上`, 'planet', async () => {
    const at = await clickable(page, `${you.id} 星球`, await page.evaluate((id) => window.__app.planetScreenPos(id), you.id));
    // 先悬停：标签显示的是这颗星球，才点（前面有别的星球挡着时不会点进别人家）
    await page.mouse.move(at.x, at.y);
    await until(page, `悬停标签显示 ${you.name}`, (name) => {
      const label = document.querySelector('.float-label');
      return !!label && !label.hidden && label.querySelector('.display')?.textContent === name;
    }, you.name);
    await page.mouse.click(at.x, at.y);
    await planetReady(page, you);
  });

  await step('Members：列出全部成员', 'members', async () => {
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await until(page, ' Members 页', ([id, n]) => location.hash === `#/t/${id}/members` && window.__app.routeIdle()
      && document.querySelector('.sheet.members')?.hidden === false && document.querySelectorAll('.sheet.members .member').length === n, [you.id, you.members.length]);
  });

  await step('Museum：每张卡片的模型都挂好', 'museum', async () => {
    await page.getByRole('button', { name: 'Museum', exact: true }).click();
    await until(page, ' Museum 网格就绪', ([id, n]) => {
      const sheet = document.querySelector('section.museum');
      return location.hash === `#/t/${id}/museum` && window.__app.routeIdle() && sheet?.hidden === false && sheet.dataset.ready === 'true'
        && sheet.querySelectorAll('.museum-card').length === n && document.querySelector('.sheet.members')?.hidden === true;
    }, [you.id, you.works.length], 60000);
  });

  await step(`打开一件作品（${target.title}）：查看器画出模型`, 'viewer', async () => {
    await page.locator('.museum-card', { hasText: target.title }).click();
    await until(page, '查看器画好模型', (id) => location.hash.endsWith(`/museum/${id}`) && window.__app.routeIdle()
      && document.querySelector('.viewer')?.hidden === false && !!document.querySelector('.viewer-stage.ready'), target.id, 60000);
  });

  await step('回到星球：Esc 关查看器，再 Esc 关 Museum', 'back-to-planet', async () => {
    await page.keyboard.press('Escape');
    await until(page, '查看器关掉、回到网格', (id) => location.hash === `#/t/${id}/museum` && window.__app.routeIdle()
      && document.querySelector('.viewer')?.hidden === true && document.querySelector('section.museum')?.hidden === false, you.id);
    await page.keyboard.press('Escape');
    await until(page, ' Museum 关掉', () => document.querySelector('section.museum')?.hidden === true);
    await planetReady(page, you);
  });

  await step(`编辑模式摆一件作品：拿下 ${target.id}，再从作品栏摆回星球并存档`, 'edit-place', async () => {
    await page.locator('.topbar button.primary').click();
    await until(page, '进入编辑（作品栏、外观面板）', () => document.querySelector('.tray')?.hidden === false
      && document.querySelector('.planet-panel')?.hidden === false && document.querySelector('.topbar button.primary')?.textContent === 'Done');
    const at = await clickable(page, `作品 ${target.id}`, await page.evaluate((id) => window.__app.workScreenPos(id), target.id));
    await page.mouse.click(at.x, at.y);
    await until(page, '选中作品、出现编辑条', (title) => {
      const bar = document.querySelector('.edit-bar');
      return !!bar && !bar.hidden && bar.querySelector('.eb-title')?.textContent === title;
    }, target.title);
    await page.keyboard.press('Delete');
    await until(page, '作品拿下来并存档', ([team, id]) => !window.__app.placedIds().includes(id)
      && !window.__app.teamPlanet(team).placements.some((p) => p.workId === id), [you.id, target.id]);
    await page.locator('.tray-item', { hasText: target.title }).click();
    await until(page, '作品栏进入摆放', (title) => [...document.querySelectorAll('.tray-item')]
      .some((b) => b.title === title && b.getAttribute('aria-pressed') === 'true'), target.title);
    // 近景取景下星球中心落在作品栏底下：往上 250 px 点在星球表面上（同 check-editor）
    const center = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
    const spot = await clickable(page, '摆放点', center && { x: center.x, y: center.y - 250 });
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.click(spot.x, spot.y);
    await until(page, '作品摆回星球并存档', ([team, id]) => window.__app.placedIds().includes(id)
      && window.__app.teamPlanet(team).placements.some((p) => p.workId === id), [you.id, target.id]);
  });

  await step('Reset demo：确认后刷新，恢复初始数据、清掉本地存档', 'reset', async () => {
    await Promise.all([
      page.waitForEvent('load', { timeout: 60000 }),
      page.locator('.planet-panel button', { hasText: 'Reset demo' }).click(),
    ]);
    await until(page, '刷新后就绪、启动画面撤掉', () => window.__ready === true && !document.querySelector('#boot'), null, 60000);
    await planetReady(page, you);
    const planet = await page.evaluate((id) => window.__app.teamPlanet(id), you.id);
    if (!isDeepStrictEqual(planet, you.planet)) throw new Error(`配方和 seed.json 不一样：${JSON.stringify(planet).slice(0, 160)}`);
    const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.endsWith(':v1:planets')));
    if (saved.length) throw new Error(`本地存档没清掉：${saved.join(', ')}`);
  });

  await step('进入漫游、按住 W 走一秒：角色走了、仍贴在地上', 'walk', async () => {
    await until(page, '角色模型准备好', () => window.__walk?.state().ready === true, null, 60000);
    await page.locator('.topbar button.walk').click();
    await until(page, '进入漫游', () => window.__walk.state().phase === 'walk' && document.querySelector('.topbar button.walk')?.textContent === 'Done');
    const before = await page.evaluate(() => window.__walk.state());
    await page.keyboard.down('w');
    await page.waitForTimeout(1000); // 按住一秒本身，不是在等什么
    await page.keyboard.up('w');
    await until(page, '松开 W 后角色停下', () => window.__walk.state().speed < 0.05);
    const after = await page.evaluate(() => window.__walk.state());
    const walked = angle(before.dir, after.dir) * after.radius;
    if (walked < 1) throw new Error(`一秒只走了 ${walked.toFixed(2)} 个单位`);
    if (Math.abs(after.feet - after.ground) > 0.01) throw new Error(`脚底离地面 ${Math.abs(after.feet - after.ground).toFixed(3)}`);
  });

  await step('退出漫游：Esc，镜头交回轨道镜头', 'walk-exit', async () => {
    await page.keyboard.press('Escape');
    await until(page, '退出漫游', () => {
      const s = window.__walk.state();
      return s.phase === 'off' && s.camera.controls && !s.camera.drive && document.querySelector('.topbar button.walk')?.textContent === 'Walk';
    });
  });

  await step('回星系', 'galaxy-again', async () => {
    await page.getByRole('button', { name: '← Galaxy', exact: true }).click();
    await until(page, '回到星系', () => location.hash === '#/' && window.__app.routeIdle()
      && document.querySelector('.tb-name')?.textContent === 'Community Planets' && window.__app.placedIds().length === 0);
  });

  await step('手机尺寸（390 × 844）：启动画面排得下，能正常进到星系', null, async () => {
    const p = await open('手机', { width: 390, height: 844 });
    try {
      await holdBoot(p);
      await p.goto(`${base}/${QUERY}`);
      await bootAt(p, 'sky');
      await p.evaluate(() => window.__bootGo());
      await bootAt(p, 'warm');
      await bootSettled(p);
      const fits = await p.evaluate(() => [...document.querySelectorAll('.boot-title, .boot-steps')].every((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      }));
      await shot(p, 'boot-phone');
      if (!fits) throw new Error('标题或进度超出屏幕宽度');
      await p.evaluate(() => window.__bootGo());
      await bootAt(p, 'land');
      await p.evaluate(() => window.__bootGo());
      await until(p, '启动画面撤掉、首页就绪', () => !document.querySelector('#boot') && window.__ready === true, null, 60000);
    } finally {
      await p.close();
    }
  });

  // 另开一页：藏起 WebGPU，WebGL 也拿不到上下文，渲染器两个后端都起不来
  await step('浏览器做不了 3D：启动画面留着，提示换浏览器或设备（不报错）', 'no-3d', async () => {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const crashes = [];
    p.on('pageerror', (e) => crashes.push(`JS: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') crashes.push(`console: ${m.text()}`); });
    await p.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined });
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /^(webgl2?|experimental-webgl|webgpu)$/.test(type) ? null : getContext.call(this, type, ...rest);
      };
    });
    try {
      await p.goto(`${base}/${QUERY}`);
      await until(p, '不支持 3D 的提示', () => {
        const boot = document.querySelector('#boot');
        return boot?.dataset.state === 'unsupported' && !!boot.dataset.art
          && /Chrome, Edge, Firefox or Safari/.test(boot.querySelector('.boot-msg[role="alert"]')?.textContent ?? '');
      });
      await bootSettled(p);
      if (await p.evaluate(() => window.__ready === true)) throw new Error('做不了 3D 也设了 __ready');
      if (crashes.length) throw new Error(`页面报错：${crashes[0]}`);
      return p;
    } catch (err) {
      await shot(p, 'no-3d').catch(() => {});
      await p.close();
      throw err;
    }
  });
} catch (err) {
  fatal = err;
} finally {
  // 中途抛错也走到这里：把已有的结果和收集到的页面错误都打出来，再关掉浏览器和服务器
  const errors = errorLists.flatMap(([name, list]) => list.map((e) => `[${name}] ${e}`));
  console.log(`base: ${base} · backend: ${backend} · 翠宝动图: ${art === 'gif' ? '有（本机品牌素材）' : art === 'dots' ? '没有，用圆点' : art}`);
  if (numbers) console.log(numbers);
  console.log(results.join('\n'));
  if (fatal) console.log(`✗ 脚本中断：${fatal?.stack ?? fatal}`);
  if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.join('\n')}`);
  const ok = !fatal && results.some((r) => r.startsWith('✓')) && !results.some((r) => r.startsWith('✗')) && errors.length === 0;
  console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
  process.exitCode = ok ? 0 : 1;
  await browser?.close().catch(() => {});
  await local?.server.close().catch(() => {});
}

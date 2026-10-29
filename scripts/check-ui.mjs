// 界面（U1）自查：node scripts/check-ui.mjs（WEBGL2=1 走 WebGL2 后备；DPR=1 用像素比 1，默认 2）
// 1440×900，查：
// - 界面动画只动 transform / opacity（每帧收集 document.getAnimations()：CSS 过渡看 transitionProperty，其余看关键帧里的属性）
// - 3D 画面的帧间隔：星球视图空闲、Members 打开（进场动画 + 悬停倾斜 + 翻面）、调参面板操作（换页、展开抽屉、收起展开、拖动）各量一段，
//   报 p50 / p95 / 最长、超过 50 ms 的帧数（Members 开着时 3D 照常在画，Museum 开着时主画面停画，不量）
// - 调参面板：分组齐全、每组一页；收起 / 展开；拖动后刷新还在原处、收起状态也记住；双击头部回到右上角；Members 打开时自动收起、关掉后回来
// - Members：键盘 Tab 到成员卡、回车翻面（焦点到背面的「翻回去」）、再回车翻回来；Esc 关掉（放完退场动画才藏起来）
// - Museum：卡片点开查看器（舞台从卡片放大出来：有一段 transform 动画）、Esc 关掉回网格、再 Esc 关掉 Museum
// 依赖缓存默认用 .tmp/vite-ui（VITE_CACHE_DIR 可改），不碰各个 worktree 共用的 node_modules/.vite
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const dpr = Number(process.env.DPR ?? 2);
const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-ui' });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
const results = [];
const check = (ok, name) => {
  results.push([ok, name]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const until = (fn, arg = null, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

// 每一帧：记帧间隔；收集正在跑的动画动了哪些属性（只收 #app 和调参面板里的）
await page.addInitScript(() => {
  const props = new Map();
  const frames = [];
  let last = 0;
  const skip = new Set(['offset', 'easing', 'composite', 'computedOffset']);
  const tick = (t) => {
    if (last) frames.push(t - last);
    last = t;
    for (const a of document.getAnimations()) {
      const target = a.effect?.target;
      if (!target || !(target.closest?.('#app') || target.closest?.('.tune-pane'))) continue;
      const names = a.transitionProperty ? [a.transitionProperty] : [...new Set((a.effect.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k).filter((p) => !skip.has(p))))];
      const who = `${target.tagName.toLowerCase()}.${String(target.className?.baseVal ?? target.className).split(' ')[0]}${a.effect.pseudoElement ?? ''}`;
      for (const n of names) {
        if (!props.has(n)) props.set(n, new Set());
        props.get(n).add(who);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__uiCheck = {
    props: () => Object.fromEntries([...props].map(([k, v]) => [k, [...v].slice(0, 6)])),
    mark: () => frames.length,
    since: (i) => frames.slice(i),
  };
  // 只在第一次打开时清掉面板的存档（后面刷新要看存档还原）
  if (!sessionStorage.getItem('ui-check')) {
    localStorage.removeItem('community-planets:tune');
    sessionStorage.setItem('ui-check', '1');
  }
});

const stats = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? NaN, long: s.filter((x) => x > 50).length };
};
const fmt = (o) => `${o.n} 帧，p50 ${o.p50.toFixed(1)} ms、p95 ${o.p95.toFixed(1)} ms、最长 ${o.max.toFixed(1)} ms、>50 ms ${o.long} 帧`;
const segment = async (fn) => {
  const i = await page.evaluate(() => window.__uiCheck.mark());
  await fn();
  return stats(await page.evaluate((k) => window.__uiCheck.since(k), i));
};
const tuneState = () => page.evaluate(() => ({
  card: !document.querySelector('.tune-card').hidden,
  fab: !document.querySelector('.tune-fab').hidden,
  translate: document.querySelector('.tune-pane').style.translate,
}));

try {
  await page.goto(`${base}/?nolocal&tune#/t/lumen-guild`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle(), null, { timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#app')?.dataset.planetReady === 'lumen-guild', null, { timeout: 90000 });
  console.log(`backend: ${await page.evaluate(() => window.__app.backend())} · DPR ${dpr}`);
  await page.waitForTimeout(1500);

  const idle = await segment(() => page.waitForTimeout(2500));
  console.log(`  星球视图空闲：${fmt(idle)}`);

  // —— 调参面板 ——
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tune-tab .tune-sr')].map((e) => e.textContent));
  const text = await page.evaluate(() => document.querySelector('.tune-pane').textContent);
  check(['Planet', 'Grass', 'Sky & light', 'Life', 'Camera', 'Performance'].every((t) => tabs.includes(t)) && text.includes('Copy parameters'), `调参面板每组一页（${tabs.length} 组：${tabs.join('、')}），有 Copy parameters`);
  check(await page.evaluate(() => document.querySelectorAll('.tune-page').length === document.querySelectorAll('.tune-tab').length && document.querySelectorAll('.tune-page:not([hidden])').length === 1), '同一时间只显示一页');
  const tuneOps = await segment(async () => {
    for (const i of [4, 6, 1, 0]) {
      await page.locator('.tune-tab').nth(i).click();
      await page.waitForTimeout(250);
    }
    await page.locator('.tune-page:not([hidden]) > .tp-rotv > .tp-rotv_c > .tp-fldv > .tp-fldv_b').nth(1).click();
    await page.waitForTimeout(400);
    await page.locator('.tune-min').click();
    await page.waitForTimeout(700);
    await page.locator('.tune-fab').click();
    await page.waitForTimeout(700);
    const head = await page.locator('.tune-title').boundingBox();
    await page.mouse.move(head.x + 10, head.y + 8);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(head.x + 10 - k * 20, head.y + 8 + k * 10);
    await page.mouse.up();
    await page.waitForTimeout(600);
  });
  console.log(`  调参面板操作（换页、抽屉、收起展开、拖动）：${fmt(tuneOps)}`);
  const dragged = await tuneState();
  check(dragged.card && /^-2\d\dpx 1\d\dpx$/.test(dragged.translate), `拖动头部：面板跟着走（translate ${dragged.translate}）`);
  await page.locator('.tune-min').click();
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => window.__ready === true && !!document.querySelector('.tune-pane'), null, { timeout: 90000 });
  await page.waitForTimeout(800);
  const restored = await tuneState();
  check(!restored.card && restored.fab && restored.translate === dragged.translate, `刷新后还原：收起着、位置不变（${restored.translate}）`);
  await page.locator('.tune-fab').click();
  await page.waitForTimeout(700);
  await page.locator('.tune-title').dblclick();
  await page.waitForTimeout(700);
  check(['0px', '0px 0px'].includes((await tuneState()).translate), '双击头部：回到右上角'); // 0px 0px 会被写成 0px

  // —— Members ——
  await page.waitForFunction(() => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === 'lumen-guild', null, { timeout: 90000 });
  const members = await segment(async () => {
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await page.waitForTimeout(1400);
    const card = page.locator('.member').nth(2);
    const box = await card.boundingBox();
    for (let k = 0; k <= 16; k++) await page.mouse.move(box.x + 20 + (box.width - 40) * (k / 16), box.y + 30 + (box.height - 60) * (k / 16));
    await card.locator('.mcard-hit').click();
    await page.waitForTimeout(900);
  });
  console.log(`  Members（进场 + 悬停倾斜 + 翻面），3D 照常在画：${fmt(members)}`);
  check(await page.evaluate(() => document.querySelectorAll('.sheet.members .member').length === 6 && document.querySelectorAll('.member .mcard[data-flipped="true"]').length === 1), 'Members：6 张成员卡，点一张翻到背面');
  check(!(await tuneState()).card, 'Members 打开时调参面板自动收成小按钮');
  // 键盘：从面板开始 Tab 到第一张卡，回车翻面，焦点到「翻回去」，再回车翻回来
  await page.evaluate(() => document.querySelector('.sheet-panel').focus());
  let reached = false;
  for (let k = 0; k < 6 && !reached; k++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.classList.contains('mcard-hit') && document.activeElement.matches(':focus-visible'));
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const flipped = await page.evaluate(() => ({ cls: document.activeElement?.className, n: document.querySelectorAll('.mcard[data-flipped="true"]').length }));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => document.activeElement?.className);
  check(reached && flipped.cls === 'mcard-flipback' && flipped.n === 2 && back === 'mcard-hit', `键盘：Tab 到成员卡（焦点框看得见）、回车翻面、焦点到「翻回去」、再回车翻回来`);
  await page.keyboard.press('Escape');
  const stillShown = await page.evaluate(() => document.querySelector('.sheet.members').hidden === false);
  const closed = await until(() => document.querySelector('.sheet.members').hidden === true);
  check(stillShown && closed, 'Esc 关 Members：先放退场动画，放完才藏起来');
  check(await until(() => !document.querySelector('.tune-card').hidden, null, 5000), 'Members 关掉后调参面板自己回来');

  // —— Museum 和查看器 ——
  await page.getByRole('button', { name: 'Museum', exact: true }).click();
  check(await until(() => document.querySelector('section.museum')?.dataset.ready === 'true', null, 60000), 'Museum：每张卡片的模型都挂好');
  await page.waitForTimeout(800);
  await page.locator('.museum-card').nth(1).hover();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__flip = false;
    const stage = document.querySelector('.viewer-stage');
    const orig = stage.animate.bind(stage);
    stage.animate = (frames, opts) => {
      const first = String(Array.isArray(frames) ? frames[0]?.transform ?? '' : '');
      if (first.includes('translate(') && first.includes('scale(')) window.__flip = true;
      return orig(frames, opts);
    };
  });
  await page.locator('.museum-card').nth(1).click();
  check(await until(() => !!document.querySelector('.viewer-stage.ready') && document.querySelector('.viewer').hidden === false, null, 60000), '点卡片：查看器打开、画出模型');
  check(await page.evaluate(() => window.__flip), '查看器的舞台从卡片的位置放大出来（共用元素过渡）');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  check(await until(() => document.querySelector('.viewer').hidden === true && document.querySelector('section.museum').hidden === false), 'Esc：查看器缩回卡片、回到网格');
  check(await page.evaluate(() => document.activeElement?.classList.contains('museum-card')), '查看器关掉后焦点回到那张卡片');
  await page.keyboard.press('Escape');
  check(await until(() => document.querySelector('section.museum').hidden === true), '再 Esc：Museum 关掉');

  // —— 动画属性 ——
  const props = await page.evaluate(() => window.__uiCheck.props());
  const allowed = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate', 'transformOrigin', 'transform-origin']);
  const bad = Object.keys(props).filter((p) => !allowed.has(p));
  // Tweakpane 的抽屉、取色器展开还靠高度过渡结束的事件收尾，压成了 1ms（看不出来），单独列出来
  const tiny = bad.filter((p) => /^(height|padding|margin)/.test(p) && props[p].every((w) => /tp-(fldv|colv|p2dv)_[cp]/.test(w)));
  const real = bad.filter((p) => !tiny.includes(p));
  check(real.length === 0, `界面动画只动 transform / opacity（见到的：${Object.keys(props).join('、')}${tiny.length ? `；Tweakpane 抽屉 1ms 的 ${tiny.join('、')} 不算` : ''}）${real.length ? ` 多出来的：${JSON.stringify(Object.fromEntries(real.map((p) => [p, props[p]])))}` : ''}`);
  check(errors.length === 0, `页面没有报错${errors.length ? `：${errors.slice(0, 3).join(' | ')}` : ''}`);
} catch (err) {
  check(false, `中途出错：${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter(([ok]) => !ok).length;
console.log(failed ? `UI FAILED（${failed} 项）` : 'UI OK');
process.exit(failed ? 1 : 0);

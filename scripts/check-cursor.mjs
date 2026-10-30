// 鼠标光标自查（ui/cursor.ts、ui/cursor.css）：
//   光标图：平时、按钮上、画布上指着星球、在画布上拖动（data-cursor-drag）、文字框（系统 I 形）；
//   跟随层：动起来才露出、停下收住并停掉 rAF、移出窗口和切走标签页时藏起来、Typed OM 写入；
//   减弱动效：光标图照旧、没有跟随层；触屏（粗指针、不能悬停）：不换光标、不建跟随层。
//   再按 2 倍像素比截各个状态的图：平时、能点（按钮、星球）、拖动中、跟随层移动中。
// 截图里没有系统光标：脚本在指针的位置贴一张光标的 2x 图（读指针下面元素的光标计算值，按热点对齐），看到的就是系统会画出来的样子。
// node scripts/check-cursor.mjs [截图目录，默认 .tmp/cursor-media]。HEADED=1：有界面的 Chrome
import { mkdirSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = (process.argv[2] ?? '.tmp/cursor-media').replace(/\/$/, '');
mkdirSync(OUT, { recursive: true });
const W = 1440;
const H = 900;
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const errors = [];

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-cursor' });
const browser = await launch();

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, ...opts });
  await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
  const page = await ctx.newPage();
  errors.push(watchErrors(page));
  await page.goto(`${base}/?nolocal`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  return { ctx, page };
}

// 截图用：在指针位置贴系统光标的 2x 图（冒泡阶段跟着 pointermove 走：画布自己的处理先把行内光标改好）
const installShotCursor = (page) => page.evaluate(() => {
  const img = document.createElement('img');
  img.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;display:none';
  document.body.append(img);
  const draw = (x, y) => {
    window.__ptr = { x, y };
    const el = document.elementFromPoint(x, y);
    const cur = el ? getComputedStyle(el).cursor : '';
    img.dataset.kind = cur.slice(cur.lastIndexOf(',') + 1).trim();
    const m = /url\("([^"]+)"\) 2dppx\) ([\d.]+) ([\d.]+)/.exec(cur);
    if (!m) {
      img.style.display = 'none';
      return;
    }
    if (img.getAttribute('src') !== m[1]) img.src = m[1];
    img.style.display = 'block';
    img.style.transform = `translate(${x - Number(m[2])}px, ${y - Number(m[3])}px)`;
  };
  window.__shotCursor = { draw, hide: () => { img.style.display = 'none'; } };
  addEventListener('pointermove', (e) => draw(e.clientX, e.clientY), { passive: true });
});

const cursorAt = (page, x, y) => page.evaluate(([px, py]) => {
  const el = document.elementFromPoint(px, py);
  return el ? getComputedStyle(el).cursor : '';
}, [x, y]);
const tail = (c) => c.slice(c.lastIndexOf(',') + 1).trim();
const styled = (c, kw) => c.startsWith('image-set(') && tail(c) === kw;
const ring = (page) => page.evaluate(() => {
  const r = document.querySelector('.cursor-fx-ring');
  if (!r) return null;
  const st = getComputedStyle(r);
  return { opacity: Number(st.opacity), transform: st.transform, typed: r.attributeStyleMap.get('transform') instanceof CSSTransformValue, state: window.__cursorFx?.state() };
});
const shot = async (page, name, cx, cy, w = 260, h = 180) => {
  const clip = { x: Math.max(0, Math.round(cx - w / 2)), y: Math.max(0, Math.round(cy - h / 2)), width: w, height: h };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
};
// 指针按时间画圈（每秒 rate 弧度），直到 stop() 被调用；down = 按着拖
function circler(page, cx, cy, rx, ry, rate) {
  let on = true;
  const t0 = Date.now();
  const done = (async () => {
    while (on) {
      const a = ((Date.now() - t0) / 1000) * rate;
      await page.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      await new Promise((r) => setTimeout(r, 8));
    }
  })();
  return async () => {
    on = false;
    await done;
  };
}
// 首页画布上的一块空地方：画圈（120 × 70）经过的地方都没有名牌、星球、标题卡片（平时、移动中、拖动都在这里）
const emptySpot = (page) => page.evaluate(() => {
  const w = window.__world;
  const d = { x: 0, y: 0, r: 0 };
  const discs = [];
  for (const e of w.planets.values()) if (w.planetOnScreen(e, d)) discs.push({ x: d.x, y: d.y, r: d.r + 24 });
  const free = (x, y) => document.elementFromPoint(x, y)?.id === 'stage' && !discs.some((c) => Math.hypot(c.x - x, c.y - y) < c.r) && !w.pickPlanet(x, y);
  let best = null;
  for (let y = 160; y < innerHeight - 160; y += 20) {
    for (let x = 200; x < innerWidth - 200; x += 20) {
      if (!free(x, y)) continue;
      let ok = true;
      for (let a = 0; a < Math.PI * 2 && ok; a += Math.PI / 12) ok = free(x + Math.cos(a) * 130, y + Math.sin(a) * 80) && free(x + Math.cos(a) * 60, y + Math.sin(a) * 36);
      if (ok) {
        best = { x, y };
        break;
      }
    }
    if (best) break;
  }
  return best ?? { x: innerWidth * 0.6, y: innerHeight * 0.3, fallback: true };
});

try {
  const { ctx, page } = await open();
  await installShotCursor(page);
  const backend = await page.evaluate(() => window.__app.backend());
  const spot = await emptySpot(page);

  // —— 1. 平时：画布空地上，自己的箭头；跟随层停下后收进指针尖、淡掉，rAF 停掉 ——
  await page.mouse.move(spot.x - 40, spot.y - 30);
  await page.mouse.move(spot.x, spot.y, { steps: 6 });
  await page.waitForTimeout(900);
  const cDefault = await cursorAt(page, spot.x, spot.y);
  check('平时：画布上是自己的箭头（image-set 1x/2x，后备 default）', styled(cDefault, 'default'), cDefault.slice(0, 90));
  check('平时：html 上也是', styled(await page.evaluate(() => getComputedStyle(document.documentElement).cursor), 'default'));
  const idle = await ring(page);
  const f0 = idle?.state.frames ?? 0;
  await page.waitForTimeout(500);
  const idle2 = await ring(page);
  check('停下以后跟随层收住：淡掉、rAF 停掉、不再跑帧', !!idle && idle.opacity === 0 && idle.state.running === false && idle2.state.frames === f0, `opacity ${idle?.opacity}，running ${idle?.state.running}，0.5 秒里多跑 ${idle2.state.frames - f0} 帧`);
  check('跟随层用 Typed OM 写 transform（每帧不拼字符串）', !!idle?.typed);
  await page.evaluate(([x, y]) => window.__shotCursor.draw(x, y), [spot.x, spot.y]);
  await shot(page, '1-default', spot.x + 40, spot.y + 30);

  // —— 2. 跟随层移动中：画圈，中途截图 ——
  const stop = circler(page, spot.x, spot.y, 120, 70, 7);
  await page.waitForTimeout(450);
  const moving = await ring(page);
  await shot(page, '2-follower-moving', spot.x, spot.y, 340, 240);
  await stop();
  check('移动中跟随层露出来、rAF 在跑', !!moving && moving.opacity > 0.15 && moving.state.running, `opacity ${moving?.opacity}`);
  const motes = await page.evaluate(() => [...document.querySelectorAll('.cursor-fx-mote')].filter((m) => Number(getComputedStyle(m).opacity) > 0).length);
  await page.mouse.move(spot.x, spot.y, { steps: 3 });
  await page.waitForTimeout(900);
  const settled = await ring(page);
  check('停下 0.9 秒后又收住', settled.opacity === 0 && !settled.state.running, `opacity ${settled.opacity}，mode ${settled.state.mode}，移动中露出的小点 ${motes} 颗`);

  // —— 3. 能点：按钮（Visit your planet） ——
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.tb-visit').getBoundingClientRect();
    return { x: b.left + b.width * 0.6, y: b.top + b.height / 2 };
  });
  await page.mouse.move(btn.x - 30, btn.y + 40);
  await page.mouse.move(btn.x, btn.y, { steps: 8 });
  await page.waitForTimeout(700);
  const cBtn = await cursorAt(page, btn.x, btn.y);
  const rBtn = await ring(page);
  check('按钮上：自己的「能点」光标', styled(cBtn, 'pointer'), cBtn.slice(0, 80));
  check('按钮上：跟随圈张开、停着也看得见，rAF 停掉', rBtn.state.mode === 'pointer' && rBtn.opacity >= 0.75 && !rBtn.state.running, `mode ${rBtn.state.mode}，opacity ${rBtn.opacity}`);
  await shot(page, '3-hover-button', btn.x + 30, btn.y + 20);

  // —— 4. 能点：画布上指着星球（JS 写行内 cursor: pointer，CSS 换成自己的图） ——
  const pid = await page.evaluate(() => {
    const w = window.__world;
    const d = { x: 0, y: 0, r: 0 };
    let best = null;
    for (const [id, e] of w.planets) {
      if (!w.planetOnScreen(e, d)) continue;
      if (document.elementFromPoint(d.x, d.y)?.id !== 'stage' || !w.pickPlanet(d.x, d.y)) continue;
      if (!best || d.r > best.r) best = { id, x: d.x, y: d.y, r: d.r };
    }
    return best;
  });
  if (pid) {
    await page.mouse.move(pid.x - 60, pid.y - 40);
    await page.mouse.move(pid.x, pid.y, { steps: 8 });
    await page.waitForTimeout(700);
    const inline = await page.evaluate(() => document.querySelector('#stage').style.cursor);
    const cPlanet = await cursorAt(page, pid.x, pid.y);
    const rPlanet = await ring(page);
    check('画布上指着星球：行内是 pointer，显示自己的「能点」光标', inline === 'pointer' && styled(cPlanet, 'pointer'), `行内 ${inline}`);
    check('指着星球：跟随圈张开（读画布行内光标的变化）', rPlanet.state.mode === 'pointer' && rPlanet.opacity >= 0.75, `mode ${rPlanet.state.mode}`);
    await page.evaluate(([x, y]) => window.__shotCursor.draw(x, y), [pid.x, pid.y]);
    await shot(page, '4-hover-planet', pid.x + 30, pid.y + 20);
  } else check('画布上指着星球', false, '画面上找不到能指的星球');

  // —— 5. 拖动：在画布空地上按住画圈（转镜头）——
  await page.mouse.move(spot.x, spot.y);
  await page.waitForTimeout(300);
  await page.mouse.down();
  const stopDrag = circler(page, spot.x, spot.y, 70, 40, 6);
  await page.waitForTimeout(450);
  const drag = await page.evaluate(() => ({ attr: document.documentElement.hasAttribute('data-cursor-drag'), cursor: getComputedStyle(document.querySelector('#stage')).cursor }));
  const rDrag = await ring(page);
  await shot(page, '5-dragging', spot.x, spot.y, 260, 180);
  await stopDrag();
  await page.mouse.up();
  check('画布上拖动：<html data-cursor-drag>，光标换成「拖着」那张', drag.attr && styled(drag.cursor, 'grabbing'), tail(drag.cursor));
  check('拖动时跟随圈收紧、拉长', rDrag.state.dragging && rDrag.opacity > 0.5, `transform ${rDrag.transform}`);
  const after = await page.evaluate(() => document.documentElement.hasAttribute('data-cursor-drag'));
  check('松开后去掉 data-cursor-drag', !after);
  // 拖动停下不动时的样子（光标图 + 收紧的圈）
  await page.mouse.down();
  await page.mouse.move(spot.x + 30, spot.y + 10, { steps: 6 });
  await page.waitForTimeout(600);
  await page.evaluate(([x, y]) => window.__shotCursor.draw(x, y), [spot.x + 30, spot.y + 10]);
  await shot(page, '5b-dragging-still', spot.x + 50, spot.y + 30);
  await page.mouse.up();

  // —— 6. 文字框：系统的 I 形光标 ——
  const cText = await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'text';
    i.style.cssText = 'position:fixed;left:20px;bottom:20px;width:200px;z-index:50';
    document.querySelector('#app').append(i);
    const t = document.createElement('textarea');
    document.querySelector('#app').append(t);
    const out = [getComputedStyle(i).cursor, getComputedStyle(t).cursor];
    i.remove();
    t.remove();
    return out;
  });
  check('文字框、多行文字框：系统的 I 形光标', cText.every((c) => c === 'text'), cText.join(' / '));

  // —— 7. 移出窗口、切走标签页：藏起来 ——
  const stop2 = circler(page, spot.x, spot.y, 100, 60, 7);
  await page.waitForTimeout(250);
  await stop2();
  await page.mouse.move(-20, H / 2);
  await page.waitForTimeout(800);
  const out = await ring(page);
  check('指针移出窗口：认出移出（away）、跟随层淡掉', out.state.away && out.opacity === 0, `away ${out.state.away}，opacity ${out.opacity}`);
  await page.mouse.move(btn.x, btn.y, { steps: 4 });
  await page.waitForTimeout(500);
  const back = await ring(page);
  const hidden = await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const o = Number(getComputedStyle(document.querySelector('.cursor-fx-ring')).opacity);
    delete document.hidden;
    return o;
  });
  check('移回来又出现；切走标签页马上藏起来', back.opacity > 0.5 && hidden === 0, `回来 ${back.opacity}，切走 ${hidden}`);

  // —— 8. setEnabled(false)（测性能的 A/B）：跟随层不跑 ——
  await page.evaluate(() => window.__cursorFx.setEnabled(false));
  const fOff = (await ring(page)).state.frames;
  const stop3 = circler(page, spot.x, spot.y, 100, 60, 7);
  await page.waitForTimeout(400);
  await stop3();
  const off = await ring(page);
  check('关掉跟随层：动指针也不跑帧，光标图照旧', off.state.frames === fOff && !off.state.active && styled(await cursorAt(page, spot.x, spot.y), 'default'));
  await page.evaluate(() => window.__cursorFx.setEnabled(true));

  // —— 9. 减弱动效：光标图照旧，没有跟随层 ——
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const stop4 = circler(page, spot.x, spot.y, 100, 60, 7);
  await page.waitForTimeout(400);
  const red = await ring(page);
  await stop4();
  check('减弱动效：没有跟随层、光标图照旧', !red.state.active && red.opacity === 0 && styled(await cursorAt(page, btn.x, btn.y), 'pointer'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  console.log(`backend: ${backend}`);
  await ctx.close();

  // —— 10. 触屏：不换光标、不建跟随层 ——
  const touch = await open({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const t = await touch.page.evaluate(() => ({
    fine: matchMedia('(hover: hover) and (pointer: fine)').matches,
    cursor: getComputedStyle(document.documentElement).cursor,
    layer: !!document.querySelector('.cursor-fx'),
  }));
  check('触屏：不换光标、不建跟随层', !t.fine && !t.cursor.startsWith('image-set') && !t.layer, `cursor ${t.cursor}`);
  await touch.ctx.close();
} catch (e) {
  check('脚本跑完', false, e.message);
} finally {
  await browser.close();
  await server.close();
}
const errs = errors.flat();
check('页面没有报错', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(results.join('\n'));
console.log(`截图：${OUT}/`);
process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0);

// 「建一颗星球」（P3）的操作录屏（逐帧拼接，同 record-home.mjs）：首页 → 点 Create a planet → 起名 → 选样子（换预设、颜色、Reroll）
// → 邀请（复制链接、加好友）→ Launch：窗口收起、预览掉进云里，新星球从云海升起来飞进你的位置，镜头跟过去，穿云进星球。
// 时间停住（window.__trans.timeScale(0)），每帧往前走 1/60 秒再截图；界面的 Web Animations 也按同样的步子往前拨；
// 3D 预览和升起来的动画都按主画面的 dt 走（ui/createPlanetPreview.ts、createPlanetLaunch.ts），一起一帧一帧走。
// 着色器编译、模型加载是真实时间：等的时候不截图（画面停着），录出来是连续的。
// 截完用 ffmpeg 拼成 60 帧的 MP4，再按阶段挑关键帧。
// node scripts/record-create.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/create-media）。WEBGL2=1 走 WebGL2；SIZE=390x844 录手机竖屏
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/create-media';
const TMP = '.tmp/create-record';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const tag = `${W}x${H}${process.env.WEBGL2 === '1' ? '-webgl2' : ''}`;
const phone = W < 700;
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-create' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal`);
await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
await page.waitForFunction(() => !window.__home?.state().intro, null, { timeout: 30000 });
await page.waitForTimeout(800);

// 往前走一帧：3D 走 1/60 秒；Web Animations 第一次见到时从 0 开始，之后每帧 +1/60 秒
const step = () => page.evaluate(() => new Promise((resolve) => {
  window.__trans.advance(1 / 60);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const seen = (window.__stepped ??= new WeakSet());
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) {
        seen.add(a);
        a.pause();
        a.currentTime = 0;
      } else {
        a.currentTime = (Number(a.currentTime) || 0) + 1000 / 60;
      }
    }
    resolve();
  }));
}));

const dir = path.join(TMP, 'frames');
mkdirSync(dir, { recursive: true });
let frame = 0;
const marks = {}; // 关键帧：名字 → 第几帧
const phases = []; // 每帧的阶段（挑 Launch 以后的关键帧）
async function shoot(n = 1) {
  for (let i = 0; i < n; i++) {
    await step();
    await page.screenshot({ path: path.join(dir, `f-${String(frame).padStart(4, '0')}.png`) });
    const s = await page.evaluate(() => ({ launch: window.__create?.state().launch.phase ?? '', trans: window.__trans.state().transition?.kind ?? '', ready: document.querySelector('#app')?.dataset.planetReady ?? '', flying: window.__world.rig.flying }));
    phases.push(s);
    frame++;
  }
}
const mark = (name) => { marks[name] = frame; };
// 等某个条件（真实时间：编译、加载）：不截图，画面停着
const waitFor = (fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 90000 });
// 一边一帧一帧往前走一边等（预览换样子的动画按主画面的时间走，不往前走就永远到不了）：编译的那段录成画面里的 Shaping…
async function shootUntil(fn, max = 900) {
  for (let i = 0; i < max && !(await page.evaluate(fn)); i++) await shoot();
}
// 指针从 from 慢慢移到 to，n 帧
async function glide(from, to, n) {
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n);
    await shoot();
  }
}
const center = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
let mouse = { x: W * 0.6, y: H * 0.55 };
async function clickOn(sel, glideFrames = 18, after = 6) {
  const to = await center(sel);
  await glide(mouse, to, glideFrames);
  mouse = to;
  await shoot(4);
  await page.mouse.click(to.x, to.y);
  await shoot(after);
}
async function typeSlowly(text, every = 3) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await shoot(every);
  }
}

await page.evaluate(() => window.__trans.timeScale(0));
await page.mouse.move(mouse.x, mouse.y);
mark('home');
await shoot(30);
await clickOn('.topbar .tb-create', 24, 2);
await waitFor(() => window.__create?.state().open);
mark('open');
await shoot(30);
await shootUntil(() => window.__create.state().previewReady);
await shoot(30);
await typeSlowly('Pebble Party');
await shoot(10);
await page.keyboard.press('Tab');
await typeSlowly('Small rocks, big dreams.', 2);
mark('name');
await shoot(20);
await clickOn('.cp-next', 20, 30);
await waitFor(() => window.__create.state().step === 'look');
mark('look');
await shoot(10);
for (const preset of ['Coral', 'Glacier']) {
  await clickOn(`.cp-preset:has-text("${preset}")`, 16, 8);
  await shootUntil(() => window.__create.state().previewReady);
  await shoot(30);
}
await clickOn('.cp-color[title="Berry"]', 16, 30);
mark('colour');
await clickOn('.cp-reroll', 18, 4);
mark('reroll');
await shoot(8);
await shootUntil(() => window.__create.state().previewReady);
await shoot(40);
await clickOn('.cp-next', 20, 30);
await waitFor(() => window.__create.state().step === 'crew');
await clickOn('.cp-copy', 16, 24);
mark('copied');
await clickOn('#cp-friend', 14, 4);
await typeSlowly('Pixel Pete');
await page.keyboard.press('Enter');
await shoot(30);
mark('crew');
await clickOn('.cp-next', 20, 36);
await waitFor(() => window.__create.state().step === 'launch');
await shootUntil(() => window.__create.state().twinReady);
mark('launch-step');
await shoot(20);
await clickOn('.cp-next', 20, 0);
mark('launch');
// Launch 以后：一直录到进了星球、作品摆好以后再停一秒
for (let i = 0; i < 900; i++) {
  await shoot();
  const s = phases.at(-1);
  if (s.ready && !(await page.evaluate(() => window.__trans.state().transition))) break;
  if (s.launch === 'home' && !s.flying) break; // 回首页的那一下飞完了
}
await shoot(60);
mark('end');
await page.evaluate(() => {
  window.__trans.timeScale(1);
  for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
});

// 关键帧：界面那几步按标记；Launch 以后按阶段（第一次进到这个阶段再过几帧）
const firstOf = (fn, offset = 0) => {
  const i = phases.findIndex((p, k) => k >= marks.launch && fn(p));
  return i < 0 ? null : Math.min(frame - 1, i + offset);
};
const keys = {
  start: marks.home + 20,
  open: marks.open + 20,
  name: marks.name + 10,
  look: marks.colour + 10,
  reroll: marks.reroll + 4,
  crew: marks.crew,
  'launch-step': marks['launch-step'] + 10,
  collapse: marks.launch + 16,
  aim: firstOf((p) => p.launch === 'aim', 40),
  charge: firstOf((p) => p.launch === 'charge', 22),
  burst: firstOf((p) => p.launch === 'burst', 6),
  'burst-2': firstOf((p) => p.launch === 'burst', 18),
  settle: firstOf((p) => p.launch === 'settle', 14),
  hold: firstOf((p) => p.launch === 'hold', 20),
  'back-home': firstOf((p) => p.launch === 'home', 40),
  landed: frame - 20,
};
const out = path.join(OUT, `create-${tag}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out]);
for (const [label, f] of Object.entries(keys)) {
  if (f === null || f === undefined) continue;
  copyFileSync(path.join(dir, `f-${String(f).padStart(4, '0')}.png`), path.join(OUT, `create-${tag}-${String(Object.keys(keys).indexOf(label) + 1).padStart(2, '0')}-${label}.png`));
}
rmSync(dir, { recursive: true, force: true });
console.log(`${out}（${frame} 帧，${(frame / 60).toFixed(1)} 秒）${phone ? '，手机竖屏' : ''}`);
console.log(`关键帧：${JSON.stringify(keys)}`);
console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
await browser.close();
await server.close();

// 上传、Tripo 生成的操作录屏（真实时间，Playwright 的 recordVideo，最后用 ffmpeg 转成 MP4），顺便截几张关键画面：
// 1. 编辑模式 → Upload → 选一个 GLB → 处理、预览（拖动转一转）→ 改名 → Add to planet → 摆上星球
// 2. Create with Tripo → 文字：打一句提示词 → Generate → 排队、生成中、百分比 → 结果转着看 → Add to planet → 摆上
// 3. 单图：选一张图 → Generate → 关掉窗口，后台做完弹提示 → 点 View → Add to planet → 摆上
// 4. 多视图：前视图 + 背面 → Generate → 结果 → Add to planet → 摆上
// 和 check-genai 一样绝对不花额度：启动开发服务器前设 TRIPO_MOCK=1，页面加载后 /api/tripo/health 的 mock 不是 true 就中止；REAL=1 才放行（平时不要用）。
// node scripts/record-genai.mjs [输出目录]（默认 shots/genai-video）。WEBGL2=1 走 WebGL2；SIZE=390x844 录手机竖屏
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const REAL = process.env.REAL === '1';
// 模拟开关（中转里优先级最高）：平时一律 1；只有 REAL=1 才显式设 0（scripts/lib/browser.mjs 没设时默认也是 1）
process.env.TRIPO_MOCK = REAL ? '0' : '1';
const OUT = process.argv[2] ?? 'shots/genai-video';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const tag = `${W}x${H}${process.env.WEBGL2 === '1' ? '-webgl2' : ''}`;
const TMP = path.join('.tmp', `genai-video-${tag}`);
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-genai-video' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: TMP, size: { width: W, height: H } } });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}-${tag}.png`) });
const until = (fn, arg = null, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });
const pause = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__genai.state());

// 进入摆放后点星球摆上。每件作品一个位置，都在星球朝着镜头的那一面（避开中间的池塘、在作品栏上面），录出来看得清；
// 那一点被界面挡住、或者没摆上时再试后面几个备用的位置。dy 是从星球中心往下（正）、往上（负）的像素
const SPOTS = [[-230, -70], [230, -60], [-170, 70], [190, 80]];
const SPARE = [[-150, -230], [150, -230], [0, -260], [-60, -180]];
let spot = 0;
async function place(before) {
  const center = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
  const mine = SPOTS[spot++ % SPOTS.length];
  for (const [dx, dy] of [mine, ...SPARE]) {
    const at = { x: center.x + dx, y: center.y + dy };
    if (!(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', at))) continue;
    await page.mouse.move(at.x - 40, at.y - 30);
    await page.mouse.move(at.x, at.y, { steps: 12 });
    await pause(300);
    await page.mouse.click(at.x, at.y);
    const ok = await page.waitForFunction((b) => window.__app.placedIds().some((x) => x.startsWith('u-') && !b.includes(x)), before, { timeout: 8000 }).then(() => true, () => false);
    if (ok) return true;
  }
  return false;
}

// 在舞台上拖一下，让结果转起来
async function spin() {
  const box = await page.locator('.ga-stage').boundingBox();
  if (!box) return;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(box.x + box.width * 0.35, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y - 20, { steps: 30 });
  await page.mouse.up();
  await pause(900);
}

async function addAndPlace() {
  const before = await page.evaluate(() => window.__app.placedIds());
  await page.locator('.ga-add').click();
  await until(() => !window.__genai.state().open);
  await pause(500);
  const ok = await place(before);
  await pause(1600);
  return ok;
}

try {
  await page.goto(`${base}/?nolocal#/t/${you.id}`);
  await until(() => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle());
  await until((id) => document.querySelector('#app')?.dataset.planetReady === id, you.id);
  const health = await page.evaluate(() => fetch('/api/tripo/health').then((r) => r.json()));
  if (!REAL && health.mock !== true) throw new Error(`/api/tripo/health 返回 ${JSON.stringify(health)}：不是模拟模式，中止（不能花真实额度）`);
  await pause(1200);

  // 1. 上传
  await page.locator('.topbar button.primary').click();
  await pause(900);
  await page.locator('.tray-add', { hasText: 'Upload' }).hover();
  await pause(400);
  await page.locator('.tray-add', { hasText: 'Upload' }).click();
  await pause(1000);
  await page.locator('.ga-file-model').setInputFiles('public/models/pumpkin-girl.glb');
  await until(() => { const s = window.__genai.state(); return s.upload?.phase === 'ready' && s.stageReady; });
  await pause(1200);
  await spin();
  await shot('upload-preview');
  await page.locator('.ga-name').click();
  await page.locator('.ga-name').fill('');
  await page.keyboard.type('Pumpkin Friend', { delay: 60 });
  await pause(500);
  const up = await addAndPlace();
  await shot('upload-placed');

  // 2. 文字
  await page.locator('.tray-add', { hasText: 'Create with' }).click();
  await pause(900);
  await page.locator('#ga-prompt').click();
  await page.keyboard.type('A tiny robot gardener holding a watering can', { delay: 35 });
  await pause(500);
  await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
  await until(() => window.__genai.jobs()[0]?.phase === 'running' && window.__genai.jobs()[0].progress > 20);
  await shot('text-running');
  await until(() => window.__genai.jobs()[0]?.phase === 'done' && window.__genai.state().stageReady);
  await pause(1200);
  await spin();
  await shot('text-result');
  const text = await addAndPlace();

  // 3. 单图：关掉窗口，后台生成
  await page.locator('.tray-add', { hasText: 'Create with' }).click();
  await pause(700);
  await page.locator('.ga-tab[data-tab="image"]').click();
  await pause(600);
  await page.locator('.ga-file-image').setInputFiles('public/thumbs/jade-guardian-lion.webp');
  await pause(900);
  await page.locator('.ga-panel[data-panel="image"] .ga-generate').click();
  await until(() => window.__genai.jobs()[0]?.mode === 'image' && ['queued', 'running'].includes(window.__genai.jobs()[0].phase));
  await pause(1500);
  await page.locator('.ga-close').click();
  await until(() => window.__genai.jobs()[0]?.phase === 'done' && !document.querySelector('.ga-notice')?.hidden);
  await pause(900);
  await shot('image-notice');
  await page.locator('.ga-notice-go').click();
  await until(() => window.__genai.state().open && window.__genai.state().stageReady);
  await pause(1000);
  await spin();
  await shot('image-result');
  const image = await addAndPlace();

  // 4. 多视图
  await page.locator('.tray-add', { hasText: 'Create with' }).click();
  await pause(700);
  await page.locator('.ga-tab[data-tab="multiview"]').click();
  await pause(600);
  for (const [slot, file] of [[0, 'public/thumbs/fantasy-castle.webp'], [2, 'public/thumbs/castle.webp']]) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(`.ga-view[data-slot="${slot}"] .ga-view-pick`).click()]);
    await chooser.setFiles(file);
    await pause(600);
  }
  await page.locator('.ga-panel[data-panel="multiview"] .ga-generate').click();
  await until(() => window.__genai.jobs()[0]?.mode === 'multiview' && window.__genai.jobs()[0].phase === 'done' && window.__genai.state().stageReady);
  await pause(1000);
  await spin();
  await shot('multiview-result');
  const views = await addAndPlace();
  await page.locator('.topbar button.primary').click(); // Done
  await pause(1200);
  await shot('planet-after');
  console.log(`摆上：上传 ${up} · 文字 ${text} · 单图 ${image} · 多视图 ${views}`);
} catch (err) {
  console.log(`✗ 录屏中断：${String(err?.message ?? err).split('\n')[0]}`);
  await page.screenshot({ path: path.join(OUT, `error-${tag}.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  const video = page.video();
  await ctx.close();
  await browser.close();
  await server.close();
  if (video) {
    const webm = await video.path();
    const mp4 = path.join(OUT, `genai-${tag}.mp4`);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4]);
      console.log(`录屏：${mp4}`);
    } catch {
      const keep = path.join(OUT, `genai-${tag}.webm`);
      renameSync(webm, keep);
      console.log(`ffmpeg 转换失败，留下 webm：${keep}`);
    }
  }
  console.log(`截图：${readdirSync(OUT).filter((f) => f.endsWith('.png')).length} 张，在 ${OUT}`);
  if (errors.length) console.log(`页面错误 ${errors.length} 条：\n${errors.join('\n')}`);
}

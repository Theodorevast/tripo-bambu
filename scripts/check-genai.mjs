// 上传、Tripo 生成自查（T2）：在模拟模式下走一遍，每一步截图到 shots/genai-NN-<步骤>[-webgl2].png，最后统计页面错误。
// 1. 编辑模式 → 作品栏「Upload」→ 选文件上传 public/models/ 里的一个 GLB → 预览、改名 → Add to planet → 摆上星球
// 2. 刷新以后还在（星球上、作品栏里），Museum 里也有；Museum 有 5 件（两排）时，滚动前后每张卡片的 3D 预览都落在自己的卡片框里（逐像素查）
// 3. 文字、单图（public/thumbs/ 里的 WebP：上传前转成 PNG）、多视图各生成一次：进度走完，作品加进来；单图那次关掉窗口在后台生成，完成提示点进去；
//    之后 Museum 有 8 件，再查一遍滚动前后的 3D 预览
// 4. 提示词带 #fail：任务大约 60% 时失败，窗口里、任务列表里有清楚的提示；带 #quota：额度用完的提示
// 5. 生成到一半刷新：任务接着轮询，做完照样加进作品
// 6. Reset demo 以后全部清空（用户作品、生成任务）
// 上传预览、文字生成的结果出来时，在 1440 × 900、1366 × 768、1280 × 720 各量一次右栏：舞台不压 Name 标签和输入框，右栏的子元素互不重叠
//
// 绝对不花额度：启动开发服务器之前设 TRIPO_MOCK=1（中转的模拟开关，优先级最高）；页面加载后先问一次 /api/tripo/health，
// mock 不是 true 就立刻中止。只有显式加 REAL=1 才允许真实模式（留给最后经用户同意的真实测试，平时不要用）。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备；HEADED=1：有界面的 Chrome
import { mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const REAL = process.env.REAL === '1';
// 模拟开关（中转里优先级最高）：平时一律 1；只有 REAL=1 才显式设 0（scripts/lib/browser.mjs 没设时默认也是 1）
process.env.TRIPO_MOCK = REAL ? '0' : '1';
// 模拟模式下一次自查要建十几个任务：放宽每小时、每天的上限（只在模拟时；真实模式照用 .env.local 和中转的默认上限）
if (!REAL) { process.env.TRIPO_MAX_TASKS_PER_IP_PER_HOUR ??= '500'; process.env.TRIPO_MAX_TASKS_PER_DAY ??= '5000'; }
const WEBGL2 = process.env.WEBGL2 === '1';
const SUFFIX = WEBGL2 ? '-webgl2' : '';
const QUERY = '?nolocal';
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const you = seed.teams.find((t) => t.id === seed.you.teamId);
const MODEL = 'public/models/tufted-armchair.glb';
const IMAGE = 'public/thumbs/jade-guardian-lion.webp';
const VIEWS = ['public/thumbs/fantasy-castle.webp', 'public/thumbs/castle.webp'];
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const results = [];
const numbers = [];
let shots = 0;
let quotaStep = false;

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-genai' });
const browser = await launch();
mkdirSync('shots', { recursive: true });

const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const until = (p, what, fn, arg = null, timeout = 30000) => p.waitForFunction(fn, arg, { timeout }).catch((err) => { throw new Error(`等不到${what}（${firstLine(err)}）`); });
const shot = async (p, name) => {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  await p.screenshot({ path: `shots/genai-${String(++shots).padStart(2, '0')}-${name}${SUFFIX}.png` });
};
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, firstLine(err));
  }
}
// 右栏（舞台 + 结果栏）不重叠：以前舞台按 aspect-ratio 撑高，比右栏 grid 里那一行高，压住下面的「Name」（1440 × 900 上就有）。
// 结果栏出来时按几个桌面尺寸各量一次：舞台的框不碰 Name 标签、Name 输入框，它们的中心点最上层就是它们自己（点得到）；
// 右栏的直接子元素两两不重叠、都在右栏里。量完换回 1440 × 900
const SIDE_SIZES = [[1440, 900], [1366, 768], [1280, 720]];
async function sideLayout(label) {
  for (const [width, height] of SIDE_SIZES) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const l = await page.evaluate(() => {
      const box = (n) => n.getBoundingClientRect();
      const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      const show = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
      const side = document.querySelector('.ga-side');
      const s = box(side);
      const stage = box(document.querySelector('.ga-stage'));
      const bad = [];
      for (const [n, what] of [[document.querySelector('label[for="ga-name"]'), 'Name 标签'], [document.querySelector('#ga-name'), 'Name 输入框']]) {
        const r = box(n);
        if (hit(stage, r)) bad.push(`舞台 ${show(stage)} 压住${what} ${show(r)}`);
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top || !n.contains(top)) bad.push(`${what}的中心点被 ${top ? top.className || top.tagName : '空'} 盖住`);
      }
      const kids = [...side.children].filter((n) => !n.hidden && n.getClientRects().length > 0);
      for (let i = 0; i < kids.length; i++) {
        const a = box(kids[i]);
        if (a.left < s.left - 1 || a.top < s.top - 1 || a.right > s.right + 1 || a.bottom > s.bottom + 1) bad.push(`${kids[i].className} ${show(a)} 出了右栏 ${show(s)}`);
        for (let j = i + 1; j < kids.length; j++) if (hit(a, box(kids[j]))) bad.push(`右栏的 ${kids[i].className} 和 ${kids[j].className} 重叠`);
      }
      if (kids.length < 2) bad.push(`右栏只看得见 ${kids.length} 个子元素（结果栏没出来？）`);
      return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : `舞台 ${show(stage)}，右栏 ${show(s)}` };
    });
    check(`${label} ${width}×${height}：舞台不压 Name 标签和输入框，右栏的子元素互不重叠`, l.ok, l.detail);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = watchErrors(page);
if (WEBGL2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
page.on('dialog', (d) => d.accept()); // Reset demo 的确认框

const ready = () => until(page, '页面就绪', () => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, 90000);
const planetReady = (id) => until(page, ` ${id} 的星球就绪`, (x) => location.hash === `#/t/${x}` && window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === x, id, 90000);
const state = () => page.evaluate(() => window.__genai.state());
const jobs = () => page.evaluate(() => window.__genai.jobs());
const editing = async (on) => {
  const b = page.locator('.topbar button.primary');
  if (((await b.textContent()) === 'Done') !== on) await b.click();
  await until(page, on ? '进入编辑' : '退出编辑', (want) => (document.querySelector('.tray')?.hidden === false) === want, on);
};
const dialogOpen = (tab) => until(page, `窗口打开在 ${tab}`, (t) => { const s = window.__genai.state(); return s.open && s.tab === t && !document.querySelector('section.genai')?.hidden; }, tab);
const jobDone = (id, timeout = 90000) => until(page, `任务 ${id} 做完`, (x) => window.__genai.jobs().find((j) => j.id === x)?.phase === 'done', id, timeout);
const newestJob = async () => (await jobs())[0];
// 点星球摆上（进入摆放以后）：从星球中心往上找一个没被界面挡住的点。workId 给了就等它摆上；
// 没给（不知道 id）就等「before 里没有的 u- 作品」摆上
async function placeOnPlanet(workId, before = []) {
  // 窗口收起的动画放完（section.genai 藏起来）再点：不然 elementFromPoint 打到的是正在淡出的窗口
  await until(page, '窗口完全收起', () => document.querySelector('section.genai')?.hidden === true, null, 5000);
  const center = await page.evaluate((id) => window.__app.planetScreenPos(id), you.id);
  for (const [dx, dy] of [[0, 250], [-120, 220], [120, 220], [0, 200], [-60, 300], [80, 160]]) {
    const at = { x: center.x + dx, y: center.y - dy };
    if (!(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'stage', at))) continue;
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(80);
    await page.mouse.click(at.x, at.y);
    const ok = await page.waitForFunction(([id, b]) => {
      const placed = window.__app.placedIds();
      return id ? placed.includes(id) : placed.some((x) => x.startsWith('u-') && !b.includes(x));
    }, [workId, before], { timeout: 8000 }).then(() => true, () => false);
    if (ok) return true;
  }
  return false;
}
// Museum 的 3D 预览都落在自己的卡片框里（逐像素）：卡片入场都放完、模型都挂好以后，把页面上别的东西（卡片、顶栏、主画面、页面底色）藏起来，
// 只截盖在最上层的预览画布：每个不透明的像素都得在某张卡片的 .mc-preview 框里（放宽 2 像素），屏幕里每个框里都要有模型。
// 预览按每帧的 getBoundingClientRect 定视口，查的是画出来的结果和卡片此刻的位置对不对得上（入场途中、滚动以后）
async function museumPreviewsInCards(label) {
  await until(page, 'Museum 卡片入场放完、预览都挂好', () => {
    const cards = [...document.querySelectorAll('.museum-card')];
    return document.querySelector('section.museum')?.dataset.ready === 'true' && cards.length > 0
      && cards.every((c) => c.getAnimations().length === 0 && getComputedStyle(c).opacity === '1' && c.querySelector('.mc-preview.ready'));
  }, null, 90000);
  await page.waitForTimeout(800); // 模型挂上时从 0「蹦」到原大（约 0.6 秒）
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rects = await page.evaluate(() => [...document.querySelectorAll('.museum-card .mc-preview')].map((p) => {
    const r = p.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }));
  await page.addStyleTag({ content: 'html, body { background: transparent !important; } body > *:not(#app), #app > *:not(.museum-canvas) { visibility: hidden !important; }' }).then((h) => h.evaluate((n) => n.setAttribute('data-probe', '')));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const png = await page.screenshot({ omitBackground: true });
  await page.evaluate(() => document.querySelector('style[data-probe]')?.remove());
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pad = 2;
  const visible = rects.map((r) => r.y + r.h > 0 && r.y < info.height && r.x + r.w > 0 && r.x < info.width && r.h > 20);
  const inside = rects.map(() => 0);
  let opaque = 0;
  let outside = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] < 64) continue;
      opaque++;
      const i = rects.findIndex((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad);
      if (i < 0) outside++;
      else inside[i]++;
    }
  }
  const empty = rects.map((_, i) => i).filter((i) => visible[i] && inside[i] < 150);
  const ok = opaque > 0 && outside <= Math.max(20, opaque * 0.002) && empty.length === 0;
  check(`Museum ${label}：每张卡片的 3D 预览都在自己的卡片框里`, ok, `${rects.length} 张卡片，屏幕里 ${visible.filter(Boolean).length} 张；框外像素 ${outside} / ${opaque}${empty.length ? `；没画出模型的卡片 ${empty.map((i) => i + 1).join(', ')}` : ''}`);
}
// Museum 滚到最底，等两帧（预览跟上新的卡片位置）
const scrollMuseum = () => page.evaluate(() => new Promise((r) => {
  const s = document.querySelector('section.museum');
  s.scrollTop = s.scrollHeight;
  requestAnimationFrame(() => requestAnimationFrame(r));
}));
const openMuseum = async () => {
  await page.getByRole('button', { name: 'Museum', exact: true }).click();
  await until(page, 'Museum 网格就绪', () => document.querySelector('section.museum')?.dataset.ready === 'true', null, 90000);
};
const closeMuseum = async () => {
  await page.keyboard.press('Escape');
  await until(page, 'Museum 关掉', () => document.querySelector('section.museum')?.hidden === true);
  await planetReady(you.id);
};
const placingNow = (title) => until(page, `${title} 进入摆放`, (t) => [...document.querySelectorAll('.tray-item')].some((b) => b.title === t && b.getAttribute('aria-pressed') === 'true'), title);
const genTab = async (tab) => {
  await page.locator(`.ga-tab[data-tab="${tab}"]`).click();
  await dialogOpen(tab);
};

try {
  await step('打开你的星球；中转是模拟模式（不花额度）', async () => {
    await page.goto(`${base}/${QUERY}#/t/${you.id}`);
    await ready();
    await planetReady(you.id);
    const health = await page.evaluate(() => fetch('/api/tripo/health').then((r) => r.json()));
    if (!REAL && health.mock !== true) throw new Error(`/api/tripo/health 返回 ${JSON.stringify(health)}：不是模拟模式，中止（不能花真实额度）`);
    check('中转在模拟模式', health.mock === true || REAL, JSON.stringify(health));
  });
  if (!REAL && results.some((r) => r.startsWith('✗'))) throw new Error('中转不在模拟模式或页面没起来：中止');

  // —— 1. 上传 ——
  let uploadId = null;
  await step('上传：作品栏 Upload → 选文件 → Worker 处理完、预览画好 → 改名 → Add to planet → 摆上星球', async () => {
    await editing(true);
    check('作品栏有 Upload 和 Create with Tripo 两个按钮', (await page.locator('.tray-add').count()) === 2);
    await page.locator('.tray-add', { hasText: 'Upload' }).click();
    await dialogOpen('upload');
    await shot(page, 'upload-open');
    const t0 = Date.now();
    // 处理期间量主画面的帧间隔：导入在 Worker 里，主画面不该卡
    await page.evaluate(() => {
      window.__gaps = [];
      let last = 0;
      const tick = (t) => {
        if (!window.__gaps) return; // 量完了（脚本把它设成 null）：停
        if (last) window.__gaps.push(t - last);
        last = t;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.locator('.ga-file-model').setInputFiles(MODEL);
    await until(page, '上传处理完、预览画好', () => { const s = window.__genai.state(); return s.upload?.phase === 'ready' && s.stageReady && s.stage === 'model'; }, null, 90000);
    const gaps = await page.evaluate(() => { const g = window.__gaps; window.__gaps = null; return g; });
    const s = await state();
    numbers.push(`上传处理 + 预览 ${Date.now() - t0} ms，${s.upload.triangles?.toLocaleString('en-US')} 面；期间主画面最长帧间隔 ${Math.max(...gaps).toFixed(1)} ms（${gaps.length} 帧）`);
    check('上传处理完：显示三角面数', s.upload.triangles > 0 && /triangles/.test(await page.locator('.ga-facts').textContent()), `${s.upload.triangles} tris`);
    await shot(page, 'upload-preview');
    await sideLayout('上传预览');
    await page.locator('.ga-name').fill('Comfy Armchair');
    await page.locator('.ga-add').click();
    await until(page, '窗口关掉', () => !window.__genai.state().open);
    await placingNow('Comfy Armchair');
    // 上传的作品 id（u- 开头）：存进 IndexedDB 时定的，从窗口的调试信息里拿不到，按「新摆上的 u- 作品」认
    const before = await page.evaluate(() => window.__app.placedIds());
    const ok = await placeOnPlanet(null, before);
    uploadId = ok ? (await page.evaluate(() => window.__app.placedIds())).find((id) => id.startsWith('u-') && !before.includes(id)) ?? null : null;
    check('上传的作品出现在作品栏里，摆上了星球', ok && !!uploadId, uploadId ?? '没摆上');
    // 缩略图是离屏渲染截的（预览舞台的画布）：作品栏里那张图不能是空的（透明像素占绝大多数就算空）
    const thumb = await page.evaluate(async () => {
      const img = [...document.querySelectorAll('.tray-item')].find((b) => b.title === 'Comfy Armchair')?.querySelector('img');
      if (!img) return { ok: false, why: 'no <img>' };
      await img.decode().catch(() => {});
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let solid = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 200) solid++;
      return { ok: solid > data.length / 4 / 20, size: `${c.width}×${c.height}`, solid: +(solid / (data.length / 4)).toFixed(3), src: img.src.slice(0, 5) };
    });
    check('缩略图截出来了（不是空图）', thumb.ok, JSON.stringify(thumb));
    await page.waitForTimeout(600);
    await shot(page, 'upload-placed');
  });

  // —— 2. 刷新以后还在，Museum 里也有 ——
  await step('刷新以后上传的作品还在（星球上、作品栏里）；Museum 里也有', async () => {
    await page.reload();
    await ready();
    await planetReady(you.id);
    const placed = await page.evaluate(() => window.__app.placedIds());
    check('刷新后还摆在星球上', !!uploadId && placed.includes(uploadId), placed.join(', '));
    await editing(true);
    check('刷新后作品栏里还有它', (await page.locator('.tray-item', { hasText: 'Comfy Armchair' }).count()) === 1);
    await editing(false);
    await openMuseum();
    check('Museum 里有这件作品', (await page.locator('.museum-card', { hasText: 'Comfy Armchair' }).count()) === 1);
    await museumPreviewsInCards('5 件（第一屏）');
    await shot(page, 'museum-5');
    await scrollMuseum();
    await museumPreviewsInCards('5 件（滚到底）');
    await shot(page, 'museum-5-scrolled');
    await closeMuseum();
  });

  // —— 3. 文字生成 ——
  let textWork = null;
  await step('文字生成：Create with Tripo → 写提示词 → Generate → 排队、生成中、百分比 → 做完预览 → Add to planet → 摆上星球', async () => {
    await editing(true);
    await page.locator('.tray-add', { hasText: 'Create with' }).click();
    await dialogOpen('text');
    await page.locator('#ga-prompt').fill('A tiny robot gardener holding a watering can');
    // 模型选择器：中转放行的三个 H 版本，每行有长处、大概多久、多少积分；默认 H3.1（Recommended）+ 快速贴图；Generate 不用滚就看得见
    await until(page, '模型列表到了', () => window.__genai.state().models?.state === 'ready', null, 20000);
    const picker = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.ga-panel[data-panel="text"] .ga-model')].map((r) => ({
        id: r.dataset.model, blurb: r.querySelector('.ga-model-blurb')?.textContent ?? '', eta: r.querySelector('.ga-model-eta')?.textContent ?? '', credits: r.querySelector('.ga-model-credits')?.textContent ?? '', tag: !!r.querySelector('.ga-model-tag'),
      }));
      const go = document.querySelector('.ga-panel[data-panel="text"] .ga-generate').getBoundingClientRect();
      const card = document.querySelector('.ga-card').getBoundingClientRect();
      const s = window.__genai.state();
      return { rows, model: s.model, texture: s.texture, goVisible: go.bottom <= card.bottom && go.top >= card.top, summary: document.querySelector('.ga-panel[data-panel="text"] .ga-cost')?.textContent ?? '' };
    });
    check('模型选择器：三个版本，每行有长处、≈ 时间、积分，H3.1 标着 Recommended', picker.rows.length === 3 && picker.rows.every((r) => r.blurb && /^≈ /.test(r.eta) && /credits$/.test(r.credits)) && picker.rows.find((r) => r.tag)?.id === 'v3.1-20260211', picker.rows.map((r) => `${r.id} ${r.eta} ${r.credits}`).join('；'));
    check('默认 H3.1 + 快速贴图，Generate 旁边写着这一次的预计', picker.model === 'v3.1-20260211' && picker.texture === 'fast' && /^≈ .* · 20 credits/.test(picker.summary), `${picker.model} ${picker.texture} 「${picker.summary}」`);
    check('Generate 不用滚就看得见（贴在左栏底下）', picker.goVisible);
    await shot(page, 'text-prompt');
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const job = await newestJob();
    check('建了一个文字任务', job?.mode === 'text', job?.phase);
    check('任务带着预计耗时和模型名', job?.etaSec > 0 && job?.modelLabel === 'H3.1' && job?.options?.textureQuality === 'fast', `${job?.etaSec} ${job?.modelLabel}`);
    await until(page, '生成中有百分比', (id) => { const j = window.__genai.jobs().find((x) => x.id === id); return j?.phase === 'running' && j.progress > 0 && /\d+%/.test(document.querySelector('.ga-busy-label')?.textContent ?? ''); }, job.id, 60000);
    const eta = await page.evaluate(() => ({ eta: document.querySelector('.ga-eta')?.textContent ?? '', note: document.querySelector('.ga-busy-note')?.textContent ?? '' }));
    check('生成中有倒计时和用的模型', /left|Almost done|longer than usual/.test(eta.eta) && eta.note === 'H3.1 · fast texture', `「${eta.eta}」「${eta.note}」`);
    await shot(page, 'text-running');
    await jobDone(job.id);
    await until(page, '结果预览画好', () => { const s = window.__genai.state(); return s.stage === 'model' && s.stageReady; }, null, 60000);
    const done = (await jobs()).find((j) => j.id === job.id);
    check('任务成功时记下了 Tripo 的预览图（下载、导入期间先放在舞台上）', /\/preview\//.test(done?.previewUrl ?? ''), done?.previewUrl);
    textWork = done.workId;
    check('做完以后作品加进来（有作品 id）', typeof textWork === 'string' && textWork.startsWith('u-'), textWork);
    check('结果旁边写着 Made with Tripo 和提示词', /Made with Tripo/.test(await page.locator('.ga-note').textContent()) && /robot gardener/.test(await page.locator('.ga-note').textContent()));
    await shot(page, 'text-result');
    await sideLayout('文字生成的结果');
    await page.locator('.ga-add').click();
    await until(page, '窗口关掉', () => !window.__genai.state().open);
    check('Add to planet 以后摆上了星球', await placeOnPlanet(textWork));
    await page.waitForTimeout(500);
    await shot(page, 'text-placed');
  });

  // —— 3b. 单图：关掉窗口在后台生成，完成提示点进去 ——
  await step('单图生成（WebP 转成 PNG 再上传）：Generate 后关掉窗口，后台做完弹提示，点提示打开结果，加进作品', async () => {
    await editing(true);
    await page.locator('.tray-add', { hasText: 'Create with' }).click();
    await dialogOpen('text');
    await genTab('image');
    await page.locator('.ga-file-image').setInputFiles(IMAGE);
    await until(page, '图片预览出来', () => !!document.querySelector('.ga-drop-image .ga-picked'));
    await shot(page, 'image-picked');
    await page.locator('.ga-panel[data-panel="image"] .ga-generate').click();
    await until(page, '图片任务建好', () => window.__genai.jobs()[0]?.mode === 'image');
    const job = await newestJob();
    await page.locator('.ga-close').click();
    await until(page, '窗口关掉', () => !window.__genai.state().open);
    await until(page, '后台做完、右下角弹出完成提示', (id) => window.__genai.jobs().find((j) => j.id === id)?.phase === 'done' && !document.querySelector('.ga-notice')?.hidden, job.id, 90000);
    await shot(page, 'image-notice');
    await page.locator('.ga-notice-go').click();
    await until(page, '点提示打开结果', (id) => { const s = window.__genai.state(); return s.open && s.tab === 'image' && s.selected.image === id && s.stageReady; }, job.id, 60000);
    await shot(page, 'image-result');
    const done = (await jobs()).find((j) => j.id === job.id);
    check('单图生成的作品加进来了（作品栏里有它）', typeof done.workId === 'string' && (await page.locator('.tray-item', { hasText: done.title }).count()) >= 1, done.title);
    await page.locator('.ga-close').click();
  });

  // —— 3c. 多视图 ——
  await step('多视图生成：前视图 + 另一个角度 → Generate → 做完加进作品', async () => {
    await editing(true);
    await page.locator('.tray-add', { hasText: 'Create with' }).click();
    await dialogOpen('text');
    await genTab('multiview');
    const generate = page.locator('.ga-panel[data-panel="multiview"] .ga-generate');
    for (const [slot, file] of [[0, VIEWS[0]], [2, VIEWS[1]]]) {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(`.ga-view[data-slot="${slot}"] .ga-view-pick`).click()]);
      await chooser.setFiles(file);
      await until(page, `第 ${slot} 格有图`, (s) => document.querySelector(`.ga-view[data-slot="${s}"]`)?.dataset.filled === 'true', slot);
      if (slot === 0) check('只放前视图时 Generate 按不了（至少两张）', await generate.isDisabled());
    }
    await shot(page, 'multiview-picked');
    await generate.click();
    await until(page, '多视图任务建好', () => window.__genai.jobs()[0]?.mode === 'multiview');
    const job = await newestJob();
    await jobDone(job.id);
    await until(page, '结果预览画好', () => { const s = window.__genai.state(); return s.stage === 'model' && s.stageReady; }, null, 60000);
    await shot(page, 'multiview-result');
    const done = (await jobs()).find((j) => j.id === job.id);
    check('多视图生成的作品加进来了', typeof done.workId === 'string' && done.workId.startsWith('u-'));
  });

  // —— 3d. Museum 有 8 件 ——
  await step('Museum 有 8 件作品（种子 4 + 上传 1 + 生成 3）：滚动前后 3D 预览都在自己的卡片里，生成的卡片标着 Made with Tripo', async () => {
    await page.locator('.ga-close').click();
    await until(page, '窗口完全收起', () => document.querySelector('section.genai')?.hidden === true);
    await openMuseum();
    const n = await page.locator('.museum-card').count();
    check('Museum 里有 8 件作品', n === 8, String(n));
    const tripoCards = await page.locator('.museum-card .tripo-tag').count();
    check('3 张生成的卡片标着 Made with Tripo，文字生成的那张有提示词', tripoCards === 3 && (await page.locator('.museum-card .tripo-prompt', { hasText: 'robot gardener' }).count()) === 1, `${tripoCards} 张`);
    await museumPreviewsInCards('8 件（第一屏）');
    await shot(page, 'museum-8');
    await scrollMuseum();
    await museumPreviewsInCards('8 件（滚到底）');
    await shot(page, 'museum-8-scrolled');
    await closeMuseum();
    await editing(true);
    await page.locator('.tray-add', { hasText: 'Create with' }).click();
    await dialogOpen('text');
  });

  // —— 4. 出错 ——
  await step('#fail：任务大约 60% 时失败，窗口里有清楚的提示、任务列表标红；#quota：额度用完的提示', async () => {
    await genTab('text');
    await page.locator('#ga-prompt').fill('A wobbly teapot #fail');
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const job = await newestJob();
    await until(page, '任务失败', (id) => window.__genai.jobs().find((j) => j.id === id)?.phase === 'failed', job.id, 90000);
    await until(page, '舞台显示出错', () => window.__genai.state().stage === 'error');
    const text = (await page.locator('.ga-stage-error').textContent()) ?? '';
    check('失败的提示是一句英文（不是错误码）', /[A-Za-z]{3,} [a-z]+/.test(text) && !/upstream|模拟/.test(text), text.trim().slice(0, 80));
    check('任务列表里这一条标成失败', (await page.locator(`.ga-job[data-phase="failed"]`).count()) >= 1);
    await shot(page, 'fail');
    quotaStep = true;
    await page.locator('#ga-prompt').fill('A golden crown #quota');
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const q = await newestJob();
    await until(page, '额度不够的任务失败', (id) => window.__genai.jobs().find((j) => j.id === id)?.phase === 'failed', q.id, 30000);
    const qj = (await jobs()).find((j) => j.id === q.id);
    const qtext = (await page.locator('.ga-stage-error').textContent()) ?? '';
    check('额度用完：错误码 quota，提示里说清楚是额度', qj.error?.code === 'quota' && /credit/i.test(qtext), `${qj.error?.code}: ${qtext.trim().slice(0, 80)}`);
    await shot(page, 'quota');
  });

  // —— 5. 刷新以后接着轮询 ——
  await step('生成到一半刷新：任务还在，接着轮询，做完照样加进作品', async () => {
    await page.locator('#ga-prompt').fill('A paper lantern with a moon pattern');
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const job = await newestJob();
    await until(page, '任务开始生成', (id) => window.__genai.jobs().find((j) => j.id === id)?.phase === 'running', job.id, 60000);
    await page.reload();
    await ready();
    await planetReady(you.id);
    const after = (await jobs()).find((j) => j.id === job.id);
    check('刷新后任务还在列表里，带着任务号', !!after?.taskId && ['queued', 'running', 'downloading', 'importing', 'done'].includes(after.phase), after ? `${after.phase} ${after.progress}%` : '没了');
    await jobDone(job.id);
    const done = (await jobs()).find((j) => j.id === job.id);
    await editing(true);
    const title = done.title;
    check('刷新后接着做完，作品加进作品栏', (await page.locator('.tray-item', { hasText: title }).count()) === 1, title);
    await shot(page, 'resume-done');
  });

  // —— 6. Reset demo ——
  await step('Reset demo：用户作品、生成任务全部清空', async () => {
    await editing(true);
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.locator('.planet-panel button', { hasText: 'Reset demo' }).click()]);
    await ready();
    await planetReady(you.id);
    const s = await page.evaluate(async () => {
      const count = await new Promise((resolve) => {
        const req = indexedDB.open('gbn-user-works');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('works')) { db.close(); resolve(0); return; }
          const r = db.transaction('works', 'readonly').objectStore('works').count();
          r.onsuccess = () => { db.close(); resolve(r.result); };
          r.onerror = () => { db.close(); resolve(-1); };
        };
        req.onerror = () => resolve(-1);
      });
      return { count, jobs: window.__genai.jobs().length, key: localStorage.getItem('gbn:v1:tripo-jobs'), placed: window.__app.placedIds() };
    });
    check('IndexedDB 里没有用户作品、生成任务清空、星球上只剩种子作品', s.count === 0 && s.jobs === 0 && !s.key && s.placed.every((id) => !id.startsWith('u-')), JSON.stringify(s));
    await editing(true);
    check('作品栏里只剩种子作品', (await page.locator('.tray-item').count()) === you.works.length);
    await shot(page, 'reset');
  });

  // —— 7. 只用键盘 + 减少动态效果（另开一页）——
  await step('只用键盘、减少动态效果：回车打开窗口，方向键换标签，打字、Ctrl+Enter 生成，Esc 关掉、焦点回到按钮；窗口只淡入淡出', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const p = await ctx.newPage();
    const errs = watchErrors(p);
    if (WEBGL2) await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    try {
      await p.goto(`${base}/${QUERY}#/t/${you.id}`);
      await p.waitForFunction(() => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, { timeout: 90000 });
      await p.waitForFunction((id) => document.querySelector('#app')?.dataset.planetReady === id, you.id, { timeout: 90000 });
      await p.locator('.topbar button.primary').click();
      await p.locator('.tray-tripo').focus();
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => window.__genai.state().open && window.__genai.state().tab === 'text');
      const motion = await p.evaluate(() => document.querySelector('.ga-card').getAnimations().every((a) => a.effect.getKeyframes().every((k) => !k.transform || k.transform === 'none')));
      check('减少动态效果：窗口打开只淡入（没有位移、缩放）', motion);
      check('打开时焦点在选中的标签上', await p.evaluate(() => document.activeElement?.id === 'ga-tab-text'));
      await p.keyboard.press('ArrowRight');
      check('方向键换到 Image 标签', await p.evaluate(() => window.__genai.state().tab === 'image' && document.activeElement?.id === 'ga-tab-image'));
      await p.keyboard.press('ArrowLeft');
      await p.keyboard.press('Tab');
      check('Tab 进到这一页的提示词输入框', await p.evaluate(() => document.activeElement?.id === 'ga-prompt'));
      await p.keyboard.type('A small wooden boat');
      await p.keyboard.press('Control+Enter');
      await p.waitForFunction(() => window.__genai.jobs()[0]?.prompt === 'A small wooden boat', null, { timeout: 10000 });
      check('Ctrl+Enter 生成', true);
      for (let i = 0; i < 25; i++) await p.keyboard.press('Tab');
      check('Tab 一直在窗口里循环', await p.evaluate(() => !!document.activeElement?.closest('section.genai')));
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !window.__genai.state().open);
      check('Esc 关掉窗口，焦点回到 Create with Tripo 按钮', await p.evaluate(() => document.activeElement?.classList.contains('tray-tripo')));
      await p.screenshot({ path: `shots/genai-${String(++shots).padStart(2, '0')}-keyboard-closed${SUFFIX}.png` });
      if (errs.length) check('键盘页没有页面错误', false, errs[0]);
    } finally {
      await ctx.close();
    }
  });

  // —— 8. 手机竖屏（另开一页）——
  await step('手机竖屏 390 × 844：窗口铺满不出屏，上传以后预览、名字、Add to planet 都看得见点得到', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    const errs = watchErrors(p);
    if (WEBGL2) await p.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
    try {
      await p.goto(`${base}/${QUERY}#/t/${you.id}`);
      await p.waitForFunction(() => window.__ready === true && !document.querySelector('#boot') && window.__app.routeIdle(), null, { timeout: 90000 });
      await p.waitForFunction((id) => document.querySelector('#app')?.dataset.planetReady === id, you.id, { timeout: 90000 });
      await p.locator('.topbar button.primary').click();
      await p.locator('.tray-add', { hasText: 'Upload' }).click();
      await p.waitForFunction(() => window.__genai.state().open);
      await p.locator('.ga-file-model').setInputFiles('public/models/pumpkin-girl.glb');
      await p.waitForFunction(() => { const s = window.__genai.state(); return s.upload?.phase === 'ready' && s.stageReady; }, null, { timeout: 90000 });
      const fit = await p.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const card = r('.ga-card');
        const stage = r('.ga-stage');
        const status = r('.ga-status');
        const tag = r('.ga-tag');
        // 上下排：右边那一栏（舞台 + 名字 + Add to planet）整个在表单上面，不压住表单；头上的额度标记不压住团队名牌
        const stacked = r('.ga-side').bottom <= r('.ga-panel[data-panel="upload"]').top + 1;
        const head = status.top >= tag.bottom - 1 || status.right <= tag.left || status.left >= tag.right;
        return { card: card.left >= 0 && card.right <= innerWidth, stage: stage.width > 200 && stage.top >= 0 && stage.bottom <= innerHeight, scroll: document.documentElement.scrollWidth <= innerWidth, stacked, head };
      });
      await p.locator('.ga-add').scrollIntoViewIfNeeded();
      const add = await p.evaluate(() => {
        const b = document.querySelector('.ga-add').getBoundingClientRect();
        return b.bottom <= innerHeight && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.ga-add') !== null;
      });
      await p.screenshot({ path: `shots/genai-${String(++shots).padStart(2, '0')}-phone${SUFFIX}.png` });
      check('手机：窗口不出屏、预览看得见、没有横向滚动，结果栏不压住表单、额度标记不压住名牌，Add to planet 点得到', fit.card && fit.stage && fit.scroll && fit.stacked && fit.head && add, JSON.stringify({ ...fit, add }));
      await p.locator('.ga-close').click();
      await p.waitForFunction(() => !window.__genai.state().open);
      if (errs.length) check('手机页没有页面错误', false, errs[0]);
    } finally {
      await ctx.close();
    }
  });
} catch (err) {
  check('脚本中断', false, err?.stack ?? String(err));
} finally {
  // #quota 那一步故意让中转回 402：这条响应和浏览器记的「Failed to load resource」不算页面错误
  const expected = (e) => quotaStep && /402/.test(e) && (/\/api\/tripo\/task/.test(e) || /Failed to load resource/.test(e));
  const real = errors.filter((e) => !expected(e));
  console.log(`base: ${base} · ${WEBGL2 ? 'WebGL2' : 'WebGPU'} · ${REAL ? '真实模式（REAL=1）' : '模拟模式'}`);
  for (const n of numbers) console.log(n);
  console.log(results.join('\n'));
  if (real.length) console.log(`页面错误 ${real.length} 条：\n${real.join('\n')}`);
  const ok = results.length > 0 && !results.some((r) => r.startsWith('✗')) && real.length === 0;
  console.log(ok ? 'CHECK-GENAI OK' : 'CHECK-GENAI FAIL');
  process.exitCode = ok ? 0 : 1;
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

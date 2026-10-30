// 上传、Tripo 生成自查（T2）：在模拟模式下走一遍，每一步截图到 shots/genai-NN-<步骤>[-webgl2].png，最后统计页面错误。
// 1. 编辑模式 → 作品栏「Upload」→ 选文件上传 public/models/ 里的一个 GLB → 预览、改名 → Add to planet → 摆上星球
// 2. 刷新以后还在（星球上、作品栏里），Museum 里也有
// 3. 文字、单图（public/thumbs/ 里的 WebP：上传前转成 PNG）、多视图各生成一次：进度走完，作品加进来；单图那次关掉窗口在后台生成，完成提示点进去
// 4. 提示词带 #fail：任务大约 60% 时失败，窗口里、任务列表里有清楚的提示；带 #quota：额度用完的提示
// 5. 生成到一半刷新：任务接着轮询，做完照样加进作品
// 6. Reset demo 以后全部清空（用户作品、生成任务）
//
// 绝对不花额度：启动开发服务器之前设 TRIPO_MOCK=1（中转的模拟开关，优先级最高）；页面加载后先问一次 /api/tripo/health，
// mock 不是 true 就立刻中止。只有显式加 REAL=1 才允许真实模式（留给最后经用户同意的真实测试，平时不要用）。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备；HEADED=1：有界面的 Chrome
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const REAL = process.env.REAL === '1';
if (!REAL) process.env.TRIPO_MOCK = '1';
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
    await page.getByRole('button', { name: 'Museum', exact: true }).click();
    await until(page, 'Museum 网格就绪', () => document.querySelector('section.museum')?.dataset.ready === 'true', null, 90000);
    check('Museum 里有这件作品', (await page.locator('.museum-card', { hasText: 'Comfy Armchair' }).count()) === 1);
    await page.locator('.museum-card', { hasText: 'Comfy Armchair' }).scrollIntoViewIfNeeded();
    await shot(page, 'museum-upload');
    await page.keyboard.press('Escape');
    await until(page, 'Museum 关掉', () => document.querySelector('section.museum')?.hidden === true);
    await planetReady(you.id);
  });

  // —— 3. 文字生成 ——
  let textWork = null;
  await step('文字生成：Create with Tripo → 写提示词 → Generate → 排队、生成中、百分比 → 做完预览 → Add to planet → 摆上星球', async () => {
    await editing(true);
    await page.locator('.tray-add', { hasText: 'Create with' }).click();
    await dialogOpen('text');
    await page.locator('#ga-prompt').fill('A tiny robot gardener holding a watering can');
    await shot(page, 'text-prompt');
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const job = await newestJob();
    check('建了一个文字任务', job?.mode === 'text', job?.phase);
    await until(page, '生成中有百分比', (id) => { const j = window.__genai.jobs().find((x) => x.id === id); return j?.phase === 'running' && j.progress > 0 && /\d+%/.test(document.querySelector('.ga-busy-label')?.textContent ?? ''); }, job.id, 60000);
    await shot(page, 'text-running');
    await jobDone(job.id);
    await until(page, '结果预览画好', () => { const s = window.__genai.state(); return s.stage === 'model' && s.stageReady; }, null, 60000);
    const done = (await jobs()).find((j) => j.id === job.id);
    textWork = done.workId;
    check('做完以后作品加进来（有作品 id）', typeof textWork === 'string' && textWork.startsWith('u-'), textWork);
    check('结果旁边写着 Made with Tripo 和提示词', /Made with Tripo/.test(await page.locator('.ga-note').textContent()) && /robot gardener/.test(await page.locator('.ga-note').textContent()));
    await shot(page, 'text-result');
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

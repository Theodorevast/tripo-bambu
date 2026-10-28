// 草的自查：node dev/grass.check.mjs [输出目录]
// 1440×900、DPR 2，WebGPU 和 WebGL2 各跑一遍：
// - 每个视角（贴地、整屏近草、逆光、斜上方）：草关着、开着交替量 4 轮，每轮各 ~22 帧取中位数相减，再取 4 轮的中位数 = 草本身的 GPU 时间（时间戳查询）；
// - 实例数、三角形数、绘制调用；
// - 不闪：镜头不动、关风时连拍 5 张逐像素比（不同的像素数、最大差几级；另拍一组藏起草的作对照）；开风时两帧不同；
// - 贴地走 3 秒的帧间隔；用 CDP 采样堆分配，看 update() 有没有新建 three 对象；
// - 截图：n1-ground / n1-orbit / n1-backlit（WebGPU）、n1-webgl2；给了 REFS_DIR（参考图目录，含 F/4.jpg、G/5.jpg）时再拼一张 n1-compare.png。
// 环境变量：HEADED=1 用有界面的 Chrome；ONLY=webgpu|webgl2 只跑一个后端；VIEWS=ground,fill 只量这几个视角
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from '../scripts/lib/browser.mjs';

const outDir = process.argv[2] ?? 'shots';
mkdirSync(outDir, { recursive: true });
const { server, base } = await startServer();
// --enable-webgpu-developer-features：时间戳不再取整到 100 µs 左右，量得出零点几毫秒的差别
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const results = { date: new Date().toISOString(), backends: {} };
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function run(backend) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = watchErrors(page);
  const q = backend === 'webgl2' ? '&webgl' : '';
  await page.goto(`${base}/dev/grass.html?nopane${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const info = await page.evaluate(() => ({ backend: window.__grass.backend, canvas: `${window.__grass.renderer.domElement.width}×${window.__grass.renderer.domElement.height}`, adapter: window.__grass.adapter }));
  const r = { ...info, views: {}, errors };
  for (const view of (process.env.VIEWS ?? 'ground,fill,backlit,orbit').split(',').filter(Boolean)) {
    await page.evaluate((v) => window.__grass.view(v), view);
    await page.waitForTimeout(1500); // 新瓦片淡入完
    const m = await page.evaluate(() => window.__grass.measure(90));
    const st = await page.evaluate(() => window.__grass.stats());
    r.views[view] = { gpu: m, instances: st.instances, flowers: st.flowerInstances, triangles: st.triangles, drawCalls: st.drawCalls, tiles: st.tiles, bands: st.bands };
    console.log(backend, view, JSON.stringify(r.views[view]));
    const shot = backend === 'webgpu' ? { ground: 'n1-ground.png', backlit: 'n1-backlit.png', orbit: 'n1-orbit.png' }[view] : view === 'ground' ? 'n1-webgl2.png' : null;
    if (shot) await page.screenshot({ path: path.join(outDir, shot) });
  }
  // 不闪：镜头不动、关掉风，连拍 5 张（隔 0.3 秒），和第一张逐像素比：报告最多有几个像素不同、最大差几级（0–255）。
  // 草跳格、闪烁会是成片的像素、几十级的差；只有末位的舍入差（1 级）看不出来。
  // 对照组：把草藏起来再连拍一组。最后打开风，两帧应该不同（草在动）
  const burst = async () => {
    const shots = [];
    for (let i = 0; i < 5; i++) {
      shots.push((await page.screenshot()).toString('base64'));
      await page.waitForTimeout(300);
    }
    const cmp = await browser.newPage();
    const res = await cmp.evaluate(async (list) => {
      const load = (b64) => new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.src = `data:image/png;base64,${b64}`;
      });
      const px = (im) => {
        const c = document.createElement('canvas');
        c.width = im.width;
        c.height = im.height;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0);
        return x.getImageData(0, 0, im.width, im.height).data;
      };
      const imgs = await Promise.all(list.map(load));
      const a = px(imgs[0]);
      let pixels = 0;
      let maxDiff = 0;
      for (let k = 1; k < imgs.length; k++) {
        const b = px(imgs[k]);
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          if (d > 0) {
            n++;
            maxDiff = Math.max(maxDiff, d);
          }
        }
        pixels = Math.max(pixels, n);
      }
      return { maxPixels: pixels, of: a.length / 4, maxDiff };
    }, shots);
    await cmp.close();
    return res;
  };
  await page.evaluate(() => window.__grass.view('ground'));
  await page.evaluate(() => Object.assign(window.__grass.field.settings, { windStrength: 0, windSpeed: 0 }));
  await page.waitForTimeout(1200);
  const withGrass = await burst();
  await page.evaluate(() => window.__grass.setVisible(false));
  await page.waitForTimeout(300);
  const grassHidden = await burst();
  await page.evaluate(() => window.__grass.setVisible(true));
  await page.evaluate(() => Object.assign(window.__grass.field.settings, { windStrength: 0.55, windSpeed: 1 }));
  await page.waitForTimeout(600);
  const w1 = await page.screenshot();
  await page.waitForTimeout(500);
  const w2 = await page.screenshot();
  r.still = { withGrass, grassHidden, movesWithWind: Buffer.compare(w1, w2) !== 0 };
  console.log(backend, 'still', JSON.stringify(r.still));
  // 贴地走 3 秒：帧间隔（不开堆采样，采样本身会让帧变慢）
  await page.evaluate(() => window.__grass.view('ground'));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      if (!window.__frames) return;
      window.__frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  const frames = await page.evaluate(() => {
    const f = window.__frames ?? [];
    window.__frames = null;
    return f;
  });
  // 接着再走 3 秒，这次做堆分配采样：grass.ts 的 update 下面有没有构造 three 对象
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await page.waitForTimeout(3000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await page.keyboard.up('w');
  const CTORS = new Set(['Vector2', 'Vector3', 'Vector4', 'Quaternion', 'Matrix3', 'Matrix4', 'Color', 'Sphere', 'Frustum', 'Box3', 'clone', 'Float32Array', 'Int32Array', 'Array']);
  let grassBytes = 0;
  let allBytes = 0;
  const ctors = new Set();
  const byFn = {};
  const visit = (node, underGrass) => {
    const inGrass = node.callFrame.url.includes('/src/nature/grass');
    allBytes += node.selfSize;
    if (inGrass) {
      grassBytes += node.selfSize;
      const key = `${node.callFrame.functionName || "(anon)"}:${node.callFrame.lineNumber + 1}`;
      byFn[key] = (byFn[key] ?? 0) + node.selfSize;
    }
    if ((underGrass || inGrass) && CTORS.has(node.callFrame.functionName) && node.selfSize > 0) ctors.add(node.callFrame.functionName);
    for (const c of node.children) visit(c, underGrass || inGrass);
  };
  visit(profile.head, false);
  const steady = frames.slice(10);
  r.walk = {
    frames: steady.length,
    p50: pct(steady, 0.5),
    p95: pct(steady, 0.95),
    max: Math.max(...steady),
    over25: steady.filter((f) => f > 25).length,
    heapGrassKiB: grassBytes / 1024,
    heapAllKiB: allBytes / 1024,
    threeCtorsUnderGrass: [...ctors],
    grassTop: Object.entries(byFn).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)} KiB`),
  };
  console.log(backend, 'walk', JSON.stringify(r.walk));
  console.log(backend, errors.length ? `页面错误 ${errors.length} 条：\n${errors.join('\n')}` : '页面无报错');
  await page.close();
  return r;
}

try {
  for (const b of ['webgpu', 'webgl2']) {
    if (process.env.ONLY && process.env.ONLY !== b) continue;
    results.backends[b] = await run(b);
  }
  writeFileSync(path.join(outDir, 'n1-check.json'), JSON.stringify(results, null, 2));
  // 对比图：REFS_DIR 指向参考图目录（里面有 F/4.jpg 和 G/5.jpg）时，把参考图和我们的截图拼成 2×2
  if (process.env.REFS_DIR && results.backends.webgpu) {
    const url = (p) => pathToFileURL(path.resolve(p)).href;
    const cell = (src, caption) => `<figure><img src="${src}"><figcaption>${caption}</figcaption></figure>`;
    const html = `<!doctype html><meta charset="utf-8"><style>
      body { margin: 0; background: #15171a; color: #e8e6e1; font: 15px/1.3 system-ui, sans-serif; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px; }
      figure { margin: 0; } img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; border-radius: 4px; }
      figcaption { padding: 4px 2px 0; opacity: 0.85; }
    </style><div class="grid">
      ${cell(url(path.join(process.env.REFS_DIR, 'F', '4.jpg')), 'Reference F4: The Little Prince: Among the Stars (backlit meadow)')}
      ${cell(url(path.join(outDir, 'n1-backlit.png')), 'Ours: backlit, WebGPU, 1440×900 DPR 2')}
      ${cell(url(path.join(process.env.REFS_DIR, 'G', '5.jpg')), 'Reference G5: Grow: Song of the Evertree (stylized blades, low sun)')}
      ${cell(url(path.join(outDir, 'n1-ground.png')), 'Ours: ground view, front-lit, WebGPU, 1440×900 DPR 2')}
    </div>`;
    const file = path.join(outDir, 'n1-compare.html');
    writeFileSync(file, html);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1060 } });
    await page.goto(url(file));
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    await page.screenshot({ path: path.join(outDir, 'n1-compare.png'), fullPage: true });
    await page.close();
    console.log('对比图', path.join(outDir, 'n1-compare.png'));
  }
  console.log('写入', path.join(outDir, 'n1-check.json'));
} finally {
  await browser.close();
  await server.close();
}

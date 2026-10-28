// 草的自查：node dev/grass.check.mjs [输出目录]
// 1440×900、DPR 2，WebGPU 和 WebGL2 各跑一遍：
// - 每个视角：草开着、关着各画 90 帧，GPU 时间（时间戳查询）取中位数相减 = 草本身的 GPU 时间；
// - 实例数、三角形数、绘制调用；
// - 贴地走 3 秒的帧间隔；用 CDP 采样堆分配，看 update() 有没有新建 three 对象；
// - 截图：n1-ground / n1-orbit / n1-backlit（WebGPU）、n1-webgl2。
// 环境变量：HEADED=1 用有界面的 Chrome；ONLY=webgpu|webgl2 只跑一个后端
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  // 贴地走 3 秒：帧间隔
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
  // 堆分配采样：走路时 grass.ts 的 update 下面有没有构造 three 对象
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await page.waitForTimeout(3000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await page.keyboard.up('w');
  const frames = await page.evaluate(() => {
    const f = window.__frames ?? [];
    window.__frames = null;
    return f;
  });
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
  console.log('写入', path.join(outDir, 'n1-check.json'));
} finally {
  await browser.close();
  await server.close();
}

// 天空、云海和光照的自查：GPU 计时 + 截图。用法：node dev/sky.check.mjs [--shots] [--perf] [--only webgpu|webgl2]
// 计时：1440×900、DPR 2（画布 2880×1800），页面带 ?timing，渲染器开 trackTimestamp，每帧读回整帧所有渲染通道的 GPU 时间。
//   同一个镜头量两次：天空 + 云海 + 远处积云 + 雾都开着（on），再把它们关掉、背景换成纯色（off），差值就是这几样的开销。
//   每次先等 150 帧（着色器编译、环境贴图烘焙都在这之前做完），再取 240 帧的中位数。
//   Chrome 加 --enable-webgpu-developer-features：WebGPU 的时间戳默认量化到 100 µs，开了才是原始精度。
// 截图：1440×900、DPR 1，存到 shots/：n2-overview、n2-ground、n2-sunset、n2-webgl2，和参考图并排的 n2-compare
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { CHROME, startServer } from '../scripts/lib/browser.mjs';

const args = process.argv.slice(2);
const doShots = args.includes('--shots') || !args.includes('--perf');
const doPerf = args.includes('--perf') || !args.includes('--shots');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const REF = fileURLToPath(new URL('../.tmp/refs', import.meta.url)); // 参考图在仓库的 .tmp/refs（不入库）

mkdirSync('shots', { recursive: true });
const { server, base } = await startServer();
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'],
});
const errors = [];
const results = [];

async function open(query, dpr) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(`${query}: ${m.text()}`);
  });
  await page.goto(`${base}/dev/sky.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  return page;
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { median: q(0.5), p10: q(0.1), p90: q(0.9), n: s.length };
};

async function perf(backend, view, preset) {
  const q = `timing&nopane&view=${view}&preset=${preset}${backend === 'webgl2' ? '&webgl' : ''}`;
  const page = await open(q, 2);
  const actual = await page.evaluate(() => window.__sky.backend);
  const canvas = await page.evaluate(() => `${document.querySelector('#c').width}x${document.querySelector('#c').height}`);
  await page.evaluate(() => window.__sky.waitFrames(150));
  const burst = backend === 'webgl2' ? 8 : 1;
  const on = await page.evaluate((k) => window.__sky.measure(240, k), burst);
  await page.evaluate(() => window.__sky.showAtmosphere(false));
  await page.evaluate(() => window.__sky.waitFrames(150));
  const off = await page.evaluate((k) => window.__sky.measure(240, k), burst);
  await page.evaluate(() => window.__sky.showAtmosphere(true));
  const a = stats(on.gpu);
  const b = stats(off.gpu);
  const row = { backend: actual, view, preset, canvas, burst, on: a.median, off: b.median, delta: a.median - b.median, onP90: a.p90, offP90: b.p90, samples: [a.n, b.n] };
  results.push(row);
  console.log(`${actual.padEnd(7)} ${view.padEnd(6)} ${preset.padEnd(6)} ${canvas}  on ${a.median.toFixed(3)} ms (p90 ${a.p90.toFixed(3)})  off ${b.median.toFixed(3)} ms  → sky+sea ${(a.median - b.median).toFixed(3)} ms  [${a.n}/${b.n} samples, burst ${burst}]`);
  await page.close();
}

async function shot(query, out, wait = 1500) {
  const page = await open(`nopane&${query}`, 1);
  await page.evaluate(() => window.__sky.waitFrames(30));
  await page.waitForTimeout(wait);
  await page.screenshot({ path: out });
  await page.close();
  console.log(`saved ${out}`);
}

try {
  if (doPerf) {
    for (const backend of ['webgpu', 'webgl2']) {
      if (only && only !== backend) continue;
      for (const view of ['orbit', 'ground']) for (const preset of ['day', 'sunset']) await perf(backend, view, preset);
    }
    writeFileSync('shots/n2-perf.json', JSON.stringify(results, null, 2));
  }
  if (doShots) {
    await shot('view=orbit&preset=day', 'shots/n2-overview.png');
    await shot('view=ground&preset=day', 'shots/n2-ground.png');
    await shot('view=ground&preset=sunset', 'shots/n2-sunset.png');
    await shot('view=orbit&preset=sunset', 'shots/n2-sunset-overview.png');
    await shot('view=ground&preset=day&webgl', 'shots/n2-webgl2.png');
    // 和参考图并排：每行左边参考、右边演示页，都缩到 720 宽
    const W = 720;
    const row = async (ref, ours, label) => {
      const a = await sharp(ref).resize({ width: W }).toBuffer();
      const b = await sharp(ours).resize({ width: W }).toBuffer();
      const ha = (await sharp(a).metadata()).height;
      const hb = (await sharp(b).metadata()).height;
      const h = Math.max(ha, hb) + 28;
      const text = Buffer.from(`<svg width="${W * 2}" height="28"><rect width="100%" height="100%" fill="#1d1f24"/><text x="10" y="19" font-family="sans-serif" font-size="15" fill="#e8e4da">${label}</text></svg>`);
      return sharp({ create: { width: W * 2, height: h, channels: 3, background: '#1d1f24' } })
        .composite([{ input: text, top: 0, left: 0 }, { input: a, top: 28, left: 0 }, { input: b, top: 28, left: W }])
        .png()
        .toBuffer();
    };
    const rows = [
      await row(`${REF}/F/2.jpg`, 'shots/n2-overview.png', 'F2 (reference, overview)  |  demo: orbit, day'),
      await row(`${REF}/F/5.jpg`, 'shots/n2-ground.png', 'F5 (reference, ground)  |  demo: ground, day'),
      await row(`${REF}/F/9.jpg`, 'shots/n2-sunset.png', 'F9 (reference, sunset)  |  demo: ground, sunset'),
    ];
    const heights = await Promise.all(rows.map(async (r) => (await sharp(r).metadata()).height));
    let top = 0;
    const layers = rows.map((r, i) => {
      const l = { input: r, top, left: 0 };
      top += heights[i];
      return l;
    });
    await sharp({ create: { width: W * 2, height: top, channels: 3, background: '#1d1f24' } }).composite(layers).png().toFile('shots/n2-compare.png');
    console.log('saved shots/n2-compare.png');
  }
} finally {
  console.log(errors.length ? `页面错误 ${errors.length} 条：\n${errors.join('\n')}` : '页面无报错');
  await browser.close();
  await server.close();
}

// 导入管线的浏览器自查：打开 dev/import.html，几个模型依次交给 importModelFile（真的模块 Worker），
// 看结果对不对（三角面、简化、缩贴图、用页面同款的 GLTFLoader 读回来的三角面数一致），以及导入期间主线程是否一直流畅：
// 不能有超过 50 ms 的长任务（Long Tasks API），最长帧间隔 < 50 ms。
// 无头 Chrome 在机器忙（别的浏览器、开发服务器同时开着）时偶尔会无缘无故掉一两帧：只有帧间隔超了、又没有长任务时，这一项重跑一次，两次都打出来。
// 大模型（约 120 万面、4096 贴图、32 MB）第一次跑时生成到 .tmp/import-check/（scripts/make-import-fixture.mjs 的球）。
// 另外：读不了的文件报 parse；Worker 加载失败时退回主线程照样导入；同一个大模型在主线程上导入作对照（应该测得出卡顿，证明这套测量有效）。
// 用法：VITE_CACHE_DIR=<自己的目录> node scripts/check-import.mjs
// BUILD=1：先用 vite build 把 dev/import.html 打包到 .tmp/import-build（Worker 单独成块），用 vite preview 打开打包后的页面再测一遍
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { build, preview } from 'vite';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeSphereDocument } from './make-import-fixture.mjs';

const MAX_GAP = 50;
const BUILD = process.env.BUILD === '1';
const OUT = '.tmp/import-build';
const BIG = '.tmp/import-check/big-sphere.glb';
if (!existsSync(BIG)) {
  mkdirSync('.tmp/import-check', { recursive: true });
  const glb = await new NodeIO().writeBinary(await makeSphereDocument({ textureSize: 4096, segments: 1000, rings: 600 }));
  writeFileSync(BIG, glb);
  console.log(`生成 ${BIG}：${(glb.byteLength / 1048576).toFixed(1)} MB`);
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const FIXTURE = 'tests/fixtures/import-small.glb';
// src：仓库里的文件。public/ 下的两种模式都在根路径；别的文件开发服务器按原路径给，打包模式先拷到输出目录根下
// smooth：要不要看流畅（Worker 里做的才看）
const cases = [
  { id: '小夹具（12,096 面，不用简化）', src: FIXTURE, smooth: true, ok: (r) => r.ok && r.triangles === 12_096 && !r.simplified },
  { id: '真实作品 pumpkin-girl（meshopt + WebP）', src: 'public/models/pumpkin-girl.glb', smooth: true, ok: (r) => r.ok && !r.simplified && r.maxTexture === 2048 },
  {
    id: '真实作品 vintage-luggage-cart：限 10 万面、贴图 1024（Worker 里用 OffscreenCanvas 缩 WebP）',
    src: 'public/models/vintage-luggage-cart.glb',
    extra: 'maxTriangles=100000&maxTextureSize=1024',
    smooth: true,
    ok: (r) => r.ok && r.simplified && r.triangles <= 100_000 && r.maxTexture === 1024 && r.warnings.includes('Resized 3 textures to 1024 px.'),
  },
  { id: '大模型（约 120 万面、4096 贴图）：简化到 30 万以内、贴图缩到 2048', src: BIG, smooth: true, ok: (r) => r.ok && r.simplified && r.triangles <= 300_000 && r.triangles > 250_000 && r.maxTexture === 2048 },
  { id: '读不了的文件（JSON 但不是 glTF）：报 parse', src: 'package.json', extra: 'name=broken.glb', smooth: true, ok: (r) => !r.ok && r.error?.code === 'parse' },
  { id: 'Worker 加载失败：退回主线程照样导入', src: FIXTURE, extra: 'brokenworker', smooth: false, ok: (r) => r.ok && r.triangles === 12_096 },
  // 对照：同一个大模型放在主线程上做，应该测得出长任务 / 大的帧间隔（测不出来说明这套测量没用）
  { id: '对照：大模型在主线程上导入（应该卡）', src: BIG, extra: 'brokenworker', smooth: false, ok: (r) => r.ok && r.triangles <= 300_000 && (r.longTasks > 0 || r.maxGap > 200) },
];
const urlOf = (src) => (src.startsWith('public/') ? `/${src.slice('public/'.length)}` : BUILD ? `/${path.basename(src)}` : `/${src}`);

let base;
let close;
if (BUILD) {
  await build({ logLevel: 'warn', build: { outDir: OUT, emptyOutDir: true, rollupOptions: { input: { import: 'dev/import.html' } } } });
  for (const src of new Set(cases.map((c) => c.src).filter((s) => !s.startsWith('public/')))) copyFileSync(src, path.join(OUT, path.basename(src)));
  const workers = readdirSync(path.join(OUT, 'assets')).filter((f) => /^importWorker-.*\.js$/.test(f));
  console.log(`打包：${OUT}，Worker 块 ${workers.join('、') || '（没找到！）'}`);
  if (!workers.length) process.exitCode = 1;
  const server = await preview({ logLevel: 'warn', build: { outDir: OUT }, preview: { host: '127.0.0.1', port: 4199, strictPort: false } });
  base = (server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:4199/').replace(/\/$/, '');
  close = () => server.close();
} else {
  const { server, base: b } = await startServer();
  base = b;
  close = () => server.close();
}
const browser = await launch();
const results = [];
const errors = [];

async function runCase(c) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errs = watchErrors(page);
  await page.goto(`${base}/dev/import.html?url=${encodeURIComponent(urlOf(c.src))}${c.extra ? `&${c.extra}` : ''}`);
  await page.waitForFunction(() => window.__import?.done === true, null, { timeout: 180_000 });
  const r = await page.evaluate(() => window.__import);
  await page.close();
  return { r, errs };
}

const line = (r) => {
  const what = r.ok
    ? `${fmt(r.trianglesBefore)} → ${fmt(r.triangles)} 面（GLTFLoader 读回 ${fmt(r.threeTriangles)}），${kb(r.bytesBefore)} → ${kb(r.bytes)}，贴图最长边 ${r.maxTexture}，`
    : `失败 ${r.error?.code}：${r.error?.message}，`;
  const tasks = r.longTasks < 0 ? '浏览器不报长任务' : `长任务 ${r.longTasks} 个${r.longTasks ? `（最长 ${r.longestTask} ms）` : ''}`;
  return `${what}导入 ${fmt(r.ms)} ms，${r.frames} 帧，最长帧间隔 ${r.maxGap} ms（p95 ${r.p95Gap}），${tasks}`;
};

try {
  // 预热：开发服务器第一次转换 Worker 和依赖、浏览器第一次编译它们，不算进测量（线上是打好包的静态文件，有缓存）
  await runCase(cases[0]);
  for (const c of cases) {
    let { r, errs } = await runCase(c);
    const smoothOk = (x) => !c.smooth || !x.ok || (x.longTasks <= 0 && x.maxGap < MAX_GAP);
    const notes = [];
    if (c.smooth && r.ok && r.longTasks <= 0 && r.maxGap >= MAX_GAP) {
      notes.push(`第一次：${line(r)}（没有长任务，帧间隔超了：重跑一次）`);
      if (r.slow?.length) notes.push(`第一次的时间线：\n${r.slow.map((s) => `      ${s}`).join('\n')}`);
      ({ r, errs } = await runCase(c));
    }
    const sameInThree = !r.ok || r.threeTriangles === r.triangles;
    const pass = c.ok(r) && sameInThree && smoothOk(r) && errs.length === 0;
    results.push(`${pass ? '✓' : '✗'} ${c.id}\n    ${line(r)}${c.smooth ? '' : '（主线程上做，不看流畅）'}${r.warnings?.length ? `\n    提示：${r.warnings.join(' | ')}` : ''}`);
    for (const n of notes) results.push(`    ${n}`);
    // 有慢帧（> 25 ms）时打出时间线：慢帧、长任务夹在进度事件中间，看是哪一步
    if (c.smooth && r.slow?.length) results.push(`    时间线：\n${r.slow.map((s) => `      ${s}`).join('\n')}`);
    if (errs.length) errors.push(...errs.map((e) => `[${c.id}] ${e}`));
  }
} finally {
  await browser.close();
  await close();
}
console.log(`${BUILD ? '打包后的页面' : '开发服务器'}：${base}`);
console.log(results.join('\n'));
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = process.exitCode !== 1 && results.every((r) => !/^[✓✗]/.test(r) || r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'IMPORT OK' : 'IMPORT FAIL');
process.exitCode = ok ? 0 : 1;

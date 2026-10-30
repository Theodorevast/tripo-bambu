// 生成结果「下载 → 导入 → 窗口里出模型」量时间（模拟模式，不花额度）。两部分：
// A. Node 里直接跑导入管线（src/works/importModel.ts，和 Worker 里同一份代码，用 Vite 的 SSR 加载），按阶段计时：哪一步最慢
// B. 浏览器里走一遍真的流程（TRIPO_MOCK=1，模拟中转下载的是下面的样本）：任务 success → 下载完 → 导入完（作品存好）→ 窗口里画出模型
// 样本两个：Tripo 默认输出那么大的（SAMPLE=某个真实结果的 GLB；不给就生成一个 143 万面、约 40 MB 的球），
// 和同一个模型限到 30 万面（模拟中转加了 face_limit 以后 Tripo 给的大小），第一次跑时生成到 .tmp/perf-genai/
// 用法：VITE_CACHE_DIR=<自己的目录> node scripts/perf-genai-import.mjs   [SAMPLE=…glb] [ONLY=A|B] [HEADED=1]
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { createServer } from 'vite';
import { launch, startServer, watchErrors } from './lib/browser.mjs';
import { makeSphereDocument } from './make-import-fixture.mjs';

const DIR = path.resolve('.tmp/perf-genai');
const ONLY = (process.env.ONLY ?? '').toUpperCase();
mkdirSync(DIR, { recursive: true });
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const s = (ms) => `${(ms / 1000).toFixed(2)} s`;

async function io() {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

// —— 样本 ——
let big = process.env.SAMPLE ? path.resolve(process.env.SAMPLE) : path.join(DIR, 'tripo-like-1.4m.glb');
if (!existsSync(big)) {
  if (process.env.SAMPLE) throw new Error(`没有 ${big}`);
  // 143 万面、73 万顶点（Tripo v3.1 默认输出的量级），2048 的贴图
  const glb = await (await io()).writeBinary(await makeSphereDocument({ textureSize: 2048, segments: 1190, rings: 600 }));
  writeFileSync(big, glb);
  console.log(`生成 ${big}：${mb(glb.byteLength)}`);
}
const limited = path.join(DIR, `${path.basename(big, '.glb')}-300k.glb`);
if (!existsSync(limited)) {
  // 模拟 face_limit = 30 万：同一个模型简化到 30 万面，不压缩（Tripo 不加 compress 时给的是不压缩的 GLB）
  const nio = await io();
  const doc = await nio.read(big);
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 290_000 / tris, error: 0.02 }));
  writeFileSync(limited, await nio.writeBinary(doc));
  console.log(`生成 ${limited}：${mb(statSync(limited).size)}`);
}
const samples = [
  { id: '默认输出（不限面数）', file: big },
  { id: 'face_limit 30 万', file: limited },
];

// —— A. Node 里按阶段计时 ——
const partA = [];
if (ONLY !== 'B') {
  const vite = await createServer({ cacheDir: process.env.VITE_CACHE_DIR, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
  const { importModel } = await vite.ssrLoadModule('/src/works/importModel.ts');
  for (const sample of samples) {
    const bytes = new Uint8Array(readFileSync(sample.file));
    // 先跑一次热身（WASM 编译、JIT），再量一次
    for (const round of ['热身', '计时']) {
      const marks = [];
      const t0 = performance.now();
      const r = await importModel(bytes, 'model.glb', { maxBytes: 200 * 1048576 }, { onProgress: (p) => { if (marks.at(-1)?.stage !== p.stage) marks.push({ stage: p.stage, t: performance.now() - t0 }); } });
      const total = performance.now() - t0;
      if (round === '热身') continue;
      const stages = marks.map((m, i) => ({ stage: m.stage, ms: (marks[i + 1]?.t ?? total) - m.t })).filter((x) => x.stage !== 'done');
      partA.push({ sample: sample.id, bytes: bytes.byteLength, trianglesBefore: r.trianglesBefore, triangles: r.triangles, out: r.bytes, total, stages });
    }
  }
  await vite.close();
  console.log('\nA. 导入管线按阶段（Node，同一份代码）：');
  for (const a of partA) {
    console.log(`  ${a.sample}：${mb(a.bytes)}、${a.trianglesBefore.toLocaleString('en-US')} 面 → ${a.triangles.toLocaleString('en-US')} 面、${mb(a.out)}，共 ${s(a.total)}`);
    for (const st of a.stages) console.log(`      ${st.stage.padEnd(12)} ${s(st.ms).padStart(8)}  ${'█'.repeat(Math.max(1, Math.round((st.ms / a.total) * 40)))}`);
  }
}

// —— B. 浏览器里：success → 窗口里出模型 ——
const partB = [];
if (ONLY !== 'A') {
  process.env.TRIPO_MAX_TASKS_PER_IP_PER_HOUR ??= '500';
  const browser = await launch();
  for (const sample of samples) {
    process.env.TRIPO_MOCK = '1';
    process.env.TRIPO_MOCK_MODEL_FILE = sample.file;
    const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR ?? '.tmp/vite-perf-genai' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = watchErrors(page);
    await page.goto(`${base}/?nolocal`);
    await page.waitForFunction(() => !!window.__genai, null, { timeout: 60000 });
    const mock = await page.evaluate(async () => (await (await fetch('/api/tripo/health')).json()).mock);
    if (mock !== true) throw new Error('中转不是模拟模式，停下');
    await page.evaluate(() => window.__genai.open('text'));
    await page.fill('#ga-prompt', 'a small wooden treasure chest');
    // 在页面里每 16 ms 看一次任务和窗口，记下每一步第一次出现的时间
    const watch = page.evaluate(() => new Promise((resolve) => {
      const t = {};
      const started = performance.now();
      const tick = () => {
        const job = window.__genai.jobs()[0];
        const st = window.__genai.state();
        const at = performance.now();
        if (job) {
          if (job.phase === 'downloading' && t.success === undefined) t.success = at;
          if (job.phase === 'importing' && t.downloaded === undefined) t.downloaded = at;
          if (job.phase === 'done' && t.imported === undefined) t.imported = at;
          if (st.preview && t.preview === undefined) t.preview = at;
          if (job.phase === 'done' && st.stage === 'model' && st.stageReady && t.shown === undefined) t.shown = at;
          if (job.phase === 'failed') return resolve({ failed: job.error });
        }
        if (t.shown !== undefined || at - started > 180000) return resolve(t);
        setTimeout(tick, 16);
      };
      tick();
    }));
    await page.locator('.ga-panel[data-panel="text"] .ga-generate').click();
    const t = await watch;
    if (t.failed) throw new Error(`任务失败：${JSON.stringify(t.failed)}`);
    partB.push({
      sample: sample.id,
      bytes: statSync(sample.file).size,
      download: t.downloaded - t.success,
      importing: t.imported - t.downloaded,
      show: t.shown - t.imported,
      total: t.shown - t.success,
      preview: t.preview !== undefined ? t.preview - t.success : null,
      errors: errors.length,
    });
    await page.close();
    await server.close();
  }
  await browser.close();
  console.log('\nB. 浏览器里（模拟中转，本机下载）：任务 success 以后');
  for (const b of partB) {
    console.log(`  ${b.sample}（${mb(b.bytes)}）：下载 ${s(b.download)} · 导入 + 缩略图 + 存进本地 ${s(b.importing)} · 窗口里画出来 ${s(b.show)} · 合计 ${s(b.total)}${b.preview !== null ? ` · 预览图 ${s(b.preview)} 就在舞台上` : ''}${b.errors ? ` · 页面错误 ${b.errors} 个` : ''}`);
  }
  // 真实网络上下载要多久（本机下载几乎不花时间）：按 20 / 50 / 100 Mbps 估
  for (const b of partB) console.log(`  下载 ${mb(b.bytes)} 在 20 / 50 / 100 Mbps 上约 ${[20, 50, 100].map((m) => s((b.bytes * 8) / (m * 1e6) * 1000)).join(' / ')}`);
}

writeFileSync(path.join(DIR, 'result.json'), JSON.stringify({ partA, partB }, null, 2));
console.log(`\n结果：${path.join(DIR, 'result.json')}`);
process.exit(0);

// 处理社区作品：压缩 GLB（不减面）、截缩略图、写 works.json 和处理报告
// 默认读 models-in/（GLB + works.csv），输出到 public/models、public/thumbs、src/data/works.json
// 测试时可用环境变量换目录：PREP_IN、PREP_OUT、WORKS_OUT
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dedup, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { parseCsv, slugify } from '../src/lib/csv.ts';
import { launch, startServer } from './lib/browser.mjs';
import { countTris, createIO } from './lib/gltf.mjs';

const IN = process.env.PREP_IN ?? 'models-in';
const OUT = process.env.PREP_OUT ?? 'public';
const WORKS = process.env.WORKS_OUT ?? 'src/data/works.json';
const MAX_TRIS = 500_000;
const MAX_MB = 15;
const MB = 1024 * 1024;

// 给报告里的一件作品记一个问题；同一件可能有好几个问题，用分号连起来
function addProblem(entry, error) {
  entry.flag = true;
  entry.error = entry.error ? `${entry.error}; ${error}` : error;
}

const io = await createIO();
const csv = path.join(IN, 'works.csv');
const rows = parseCsv(readFileSync(csv, 'utf8'));
// 没有一行填了 file（比如表头写成了 File,Title,…）：直接停下，不能拿空清单覆盖 works.json
if (!rows.some((row) => row.file)) {
  console.error(`错误：${csv} 里没有任何一行有 file 值（表头要写成小写的 file,title,author,description）。已停止，没有写任何文件。`);
  process.exit(1);
}
mkdirSync(path.join(OUT, 'models'), { recursive: true });
mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
const works = [];
const report = [];
const used = new Set();

for (const row of rows) {
  const src = path.join(IN, row.file ?? '');
  if (!row.file || !existsSync(src)) {
    console.warn(`跳过：找不到 ${row.file}`);
    report.push({ file: row.file ?? '', error: 'file not found', flag: true });
    continue;
  }
  let id = slugify(row.file);
  while (used.has(id)) id = `${id}-2`;
  used.add(id);
  let doc;
  try {
    doc = await io.read(src);
    await doc.transform(
      dedup(),
      prune(),
      weld(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048] }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
  } catch (err) {
    // Draco 压缩的文件需要先 npm i -D draco3dgltf（先核实版本和许可），再在 scripts/lib/gltf.mjs 里注册 'draco3d.decoder'
    console.warn(`跳过：${row.file} 处理失败：${err.message}`);
    report.push({ id, file: row.file, error: err.message, flag: true });
    continue;
  }
  const out = path.join(OUT, 'models', `${id}.glb`);
  await io.write(out, doc);
  const tris = countTris(doc);
  const before = statSync(src).size;
  const after = statSync(out).size;
  const entry = { id, file: row.file, tris, mbBefore: +(before / MB).toFixed(2), mbAfter: +(after / MB).toFixed(2), flag: tris > MAX_TRIS || after > MAX_MB * MB };
  // spec 6 要求贴图一律 WebP；textureCompress 不认识的格式（比如 KTX2）会原样留下
  const notWebp = [...new Set(doc.getRoot().listTextures().map((t) => t.getMimeType()).filter((m) => m !== 'image/webp'))];
  if (notWebp.length) addProblem(entry, `texture not converted to webp (${notWebp.join(', ')})`);
  report.push(entry);
  works.push({ id, title: row.title || id, author: row.author || 'unknown', file: `${id}.glb`, thumb: `${id}.webp`, tris, ...(row.description ? { description: row.description } : {}) });
  console.log(`${entry.flag ? '⚠' : '✓'} ${row.file} → ${id}.glb  ${tris.toLocaleString('en-US')} tris  ${(before / MB).toFixed(1)} → ${(after / MB).toFixed(1)} MB${entry.error ? `  ${entry.error}` : ''}`);
}

// 缩略图：Vite 开发服务器把 OUT 当作 public 目录，逐个打开 dev/thumb.html 截图
if (works.length) {
  const { server, base } = await startServer({ publicDir: path.resolve(OUT) });
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  for (const w of works) {
    await page.goto(`${base}/dev/thumb.html?file=${encodeURIComponent(w.file)}`);
    await page.waitForFunction(() => window.__thumbReady === true, null, { timeout: 60000 });
    const canvas = page.locator('#c');
    if ((await canvas.getAttribute('data-failed')) === 'true') {
      const entry = report.find((r) => r.id === w.id);
      addProblem(entry, 'browser could not load model');
      console.warn(`⚠ ${entry.file} → ${w.file}  browser could not load model（缩略图是灰色占位方块）`);
    }
    const dest = path.join(OUT, 'thumbs', w.thumb);
    await sharp(await canvas.screenshot()).webp({ quality: 82 }).toFile(dest);
    const meta = await sharp(dest).metadata();
    console.log(`缩略图 ${w.thumb} ${meta.width}×${meta.height}`);
  }
  await browser.close();
  await server.close();
}

writeFileSync(WORKS, `${JSON.stringify(works, null, 2)}\n`);
writeFileSync(path.join(IN, 'prep-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const flagged = report.filter((r) => r.flag);
console.log(`works.json：${works.length} 件；需要留意 ${flagged.length} 件${flagged.length ? `（${flagged.map((r) => r.file).join('、')}）` : ''}`);

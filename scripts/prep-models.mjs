// 处理社区作品：压缩 GLB（默认不减面）、截缩略图、写 works.json 和处理报告
// 默认读 models-in/（GLB + works.csv），输出到 public/models、public/thumbs、src/data/works.json
// 测试时可用环境变量换目录：PREP_IN、PREP_OUT、WORKS_OUT
// 可选减面：npm run prep -- --max-tris=300000，面数超过这个值的模型按比例减到它附近（spec 6 默认不减面，用户同意后才开）
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { parseCsv, slugify } from '../src/lib/csv.ts';
import { launch, startServer } from './lib/browser.mjs';
import { countTris, createIO } from './lib/gltf.mjs';

const IN = process.env.PREP_IN ?? 'models-in';
const OUT = process.env.PREP_OUT ?? 'public';
const WORKS = process.env.WORKS_OUT ?? 'src/data/works.json';
const MAX_TRIS = 500_000;
const MAX_MB = 15;
const WEBP_QUALITY = 90; // 模型贴图（缩略图另算，见下面的 82）
const MB = 1024 * 1024;
const maxTrisArg = process.argv.find((a) => a.startsWith('--max-tris='));
const TARGET_TRIS = maxTrisArg ? Number(maxTrisArg.slice('--max-tris='.length)) : Infinity;
if (!(TARGET_TRIS > 0)) {
  console.error('错误：--max-tris 要写成正整数，比如 --max-tris=300000。已停止，没有写任何文件。');
  process.exit(1);
}
if (Number.isFinite(TARGET_TRIS)) await MeshoptSimplifier.ready;

// 标题转成 id：只留小写字母和数字，其余连续字符换成 -（不像 slugify 那样去掉结尾的「.扩展名」）
const slugTitle = (title) => (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// 给报告里的一件作品记一个问题；同一件可能有好几个问题，用分号连起来
function addProblem(entry, error) {
  entry.flag = true;
  entry.error = entry.error ? `${entry.error}; ${error}` : error;
}

const io = await createIO();
const csv = path.join(IN, 'works.csv');
let rows;
try {
  rows = parseCsv(readFileSync(csv, 'utf8'));
} catch (err) {
  // 引号、编码、列数这类错误：只打印说明，不打印 Node 的堆栈
  console.error(`错误：${csv}：${err.message}。已停止，没有写任何文件。`);
  process.exit(1);
}
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

// 文件夹里有、works.csv 里没写的 GLB：多半是漏了一行，或者那一行被并进了上一格（引号没闭合）。不处理，在报告里标出来
const listed = new Set(rows.map((row) => row.file).filter(Boolean));
for (const f of readdirSync(IN).filter((name) => name.toLowerCase().endsWith('.glb') && !listed.has(name))) {
  console.warn(`跳过：${f} 没有写进 works.csv`);
  report.push({ file: f, error: 'GLB not listed in works.csv', flag: true });
}

for (const row of rows) {
  const src = path.join(IN, row.file ?? '');
  if (!row.file || !existsSync(src)) {
    console.warn(`跳过：找不到 ${row.file}`);
    report.push({ file: row.file ?? '', error: 'file not found', flag: true });
    continue;
  }
  // 作品 id 出现在分享链接里（#/t/<团队>/museum/<id>）：优先用英文标题，标题转不出字母数字（比如中文）时退回文件名。
  // tmp- 开头的 id 留给拖进来的临时作品；重名时依次加 -2、-3
  let id = slugTitle(row.title) || slugify(row.file);
  if (id.startsWith('tmp-')) id = `w-${id}`;
  for (let n = 2, base = id; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  let doc;
  let trisIn = 0;
  try {
    doc = await io.read(src);
    trisIn = countTris(doc);
    // 误差上限是模型尺寸的 1%：减不到目标面数时宁可多留一些，也不让轮廓变形
    const reduce = trisIn > TARGET_TRIS ? [simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIS / trisIn, error: 0.01 })] : [];
    await doc.transform(
      dedup(),
      prune(),
      weld(),
      ...reduce,
      // WebP 质量：quality 是 textureCompress 自己的选项，它原样转给 sharp 的 webp()；不写时 sharp 用默认的 80
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: WEBP_QUALITY }),
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
  const entry = { id, file: row.file, tris, ...(tris < trisIn ? { trisBefore: trisIn } : {}), mbBefore: +(before / MB).toFixed(2), mbAfter: +(after / MB).toFixed(2), flag: tris > MAX_TRIS || after > MAX_MB * MB };
  // spec 6 要求贴图一律 WebP；textureCompress 不认识的格式（比如 KTX2）会原样留下
  const notWebp = [...new Set(doc.getRoot().listTextures().map((t) => t.getMimeType()).filter((m) => m !== 'image/webp'))];
  if (notWebp.length) addProblem(entry, `texture not converted to webp (${notWebp.join(', ')})`);
  report.push(entry);
  works.push({ id, title: row.title || id, author: row.author || 'unknown', file: `${id}.glb`, thumb: `${id}.webp`, tris, ...(row.description ? { description: row.description } : {}) });
  console.log(`${entry.flag ? '⚠' : '✓'} ${row.file} → ${id}.glb  ${tris < trisIn ? `${trisIn.toLocaleString('en-US')} → ` : ''}${tris.toLocaleString('en-US')} tris  ${(before / MB).toFixed(1)} → ${(after / MB).toFixed(1)} MB${entry.error ? `  ${entry.error}` : ''}`);
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
    // 透明背景：omitBackground 去掉浏览器默认的白底，截出来的 PNG 带 alpha，sharp 转 WebP 时保留。
    // exact：透明像素的颜色原样保留；不加的话 libwebp 压缩前会先改写透明区域的颜色，测试方片上出现了一列糊掉的色块
    await sharp(await canvas.screenshot({ omitBackground: true })).webp({ quality: 82, exact: true }).toFile(dest);
    const meta = await sharp(dest).metadata();
    console.log(`缩略图 ${w.thumb} ${meta.width}×${meta.height}${meta.hasAlpha ? ' 透明背景' : ''}`);
  }
  await browser.close();
  await server.close();
}

writeFileSync(WORKS, `${JSON.stringify(works, null, 2)}\n`);
writeFileSync(path.join(IN, 'prep-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const flagged = report.filter((r) => r.flag);
console.log(`works.json：${works.length} 件；需要留意 ${flagged.length} 件${flagged.length ? `（${flagged.map((r) => r.file).join('、')}）` : ''}`);

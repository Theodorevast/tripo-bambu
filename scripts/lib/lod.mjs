// 星球视图用的轻量模型（LOD）：只减面，贴图原样保留（图片字节不动，所以不会糊），输出到 <models>/lod/<同名>.glb。
// 主画面（星球视图、编辑、漫游）和 Museum 的卡片预览用它；大图查看器（Museum 里点开一件）用原文件（src/assets/models.ts）。
//
// 误差上限 LOD_ERROR 是模型最长边的比例（meshoptimizer 的相对误差）：作品归一化到最长边 1.6 米，0.001 就是 1.6 毫米。
// - 星球视图镜头最近（离星球中心 1.35 个半径，离作品约 10 米，视角 45°，DPR 2、窗口 900 高）：约 217 像素/米，误差 0.35 像素；
// - 漫游镜头贴着作品（跟随镜头最近 2.5 米，作品在角色前面一点，约 3 米）：约 720 像素/米，误差约 1 像素。
// 只拿掉看不出来的面；UV 接缝两边的点只沿接缝合并，贴图不会错位。
// 原来就不重的（省不到 MIN_SAVING 的字节，比如两三万面的模型）不出 LOD，加载时用原文件。
// 编码和 prep-models 一样（meshopt medium，几何量化），所以 LOD 和原文件的差别只有面数
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { meshopt, simplify, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { countTris, createIO } from './gltf.mjs';

export const LOD_ERROR = 0.001;
export const MIN_SAVING = 0.25; // LOD 至少比原文件小这么多（比例）才留下
const MB = 1024 * 1024;

// 给 dir（public/models）下每个 GLB 出一份 LOD；不再需要的旧 LOD 删掉。返回每件的结果
export async function makeLods(dir, log = console.log) {
  await MeshoptSimplifier.ready;
  const io = await createIO();
  const out = path.join(dir, 'lod');
  mkdirSync(out, { recursive: true });
  const results = [];
  const keep = new Set();
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.glb')).sort()) {
    const src = readFileSync(path.join(dir, file));
    const doc = await io.readBinary(new Uint8Array(src));
    const trisIn = countTris(doc);
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0, error: LOD_ERROR }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const bytes = await io.writeBinary(doc);
    const tris = countTris(doc);
    const saving = 1 - bytes.byteLength / src.byteLength;
    const entry = { file, trisIn, tris, mbIn: +(src.byteLength / MB).toFixed(2), mb: +(bytes.byteLength / MB).toFixed(2), lod: saving >= MIN_SAVING };
    results.push(entry);
    if (entry.lod) {
      writeFileSync(path.join(out, file), bytes);
      keep.add(file);
    }
    log(`${entry.lod ? '✓' : '·'} ${file}  ${trisIn.toLocaleString('en-US')} → ${tris.toLocaleString('en-US')} 面  ${entry.mbIn} → ${entry.mb} MB${entry.lod ? '' : `（只省 ${Math.round(saving * 100)}%，不出 LOD，用原文件）`}`);
  }
  for (const f of readdirSync(out)) {
    if (!keep.has(f) && statSync(path.join(out, f)).isFile()) rmSync(path.join(out, f));
  }
  return results;
}

// 命令行：node scripts/make-lods.mjs [models 目录，默认 public/models]
export async function main(argv = process.argv.slice(2)) {
  const dir = argv[0] ?? 'public/models';
  if (!existsSync(dir)) throw new Error(`找不到 ${dir}`);
  const results = await makeLods(dir);
  const sum = (k) => results.reduce((n, r) => n + (r.lod ? r[k] : r.mbIn), 0);
  console.log(`LOD：${results.filter((r) => r.lod).length} / ${results.length} 件，星球视图要下载的合计 ${sum('mbIn').toFixed(1)} → ${sum('mb').toFixed(1)} MB`);
}

// 导入管线：用户上传的 .glb / 内嵌资源的 .gltf、Tripo 生成下载下来的 GLB，都走这里变成「能放上星球」的 GLB。
// 和 scripts/prep-models.mjs 一个做法（gltf-transform + meshoptimizer），换成 WebIO：Worker（importWorker.ts）、主线程的后备、vitest 里都能跑。
// 模块顶层不碰 DOM；浏览器专用的只有 browserResizeImage（OffscreenCanvas），调用时才用到。
//
// 步骤：读文件（.glb / .gltf，按内容判断）→ 检查（glTF 1.0、Draco、KTX2、外部文件、不认识的必需扩展）→ 只留默认场景
// → dedup、prune、weld → 三角面超过上限（默认 30 万）就简化 → 边长超过上限（默认 2048）的贴图缩小 → meshopt 压缩 → 写成 GLB。
// 贴图不换格式（PNG 还是 PNG，WebP 还是 WebP），只缩尺寸。
//
// 三角面按「画出来的」算：默认场景里每个节点的网格都算一遍（同一个网格被几个节点用就算几遍，EXT_mesh_gpu_instancing 乘实例数），
// 这才是星球上实际要画的量。简化按比例作用在每个网格上，画出来的总数跟着按比例降。
// 简化分四级，前一级降不到上限才走下一级，结果一定不超过上限：
// 1. gltf-transform 的 simplify（保拓扑），误差上限 1% → 5% → 20% → 100% 逐级放宽；
// 2. meshoptimizer 的 Permissive：允许跨法线、UV 的断开处合并（平面着色、硬边多的模型第 1 级几乎降不动）；
// 3. simplifySloppy：不管拓扑（最后的办法，细节会粗糙，结果里给提示）；
// 4. 兜底：按比例截掉多出来的三角形（实测走不到这里，只为保证上限）
import { ImageUtils, Logger, WebIO, type Accessor, type Document, type GLTF, type Primitive, type TypedArray } from '@gltf-transform/core';
import { ALL_EXTENSIONS, type InstancedMesh } from '@gltf-transform/extensions';
import { compactPrimitive, convertPrimitiveToTriangles, dedup, meshopt, prune, simplify, unpartition, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { checkImportFile, IMPORT_MESSAGES } from './importCheck';
import { IMPORT_LIMITS, ImportError, type ImportOptions, type ImportProgress, type ImportResult, type ImportStage } from './importTypes';

export { checkImportFile } from './importCheck';

// 贴图缩小：给原图的字节和类型、最长边上限，返回缩小后的字节和类型（类型可以变，比如浏览器编不了 WebP 时给 PNG）；做不了返回 null
export type ImageResizer = (image: Uint8Array, mimeType: string, maxSize: number) => Promise<{ image: Uint8Array; mimeType: string } | null>;

export interface PipelineHooks {
  resizeImage?: ImageResizer; // 不给：大贴图原样留着，结果里给提示
  onProgress?: (p: ImportProgress) => void;
}

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const SIMPLIFY_ERRORS = [0.01, 0.05, 0.2, 1]; // 第 1 级的误差上限（模型尺寸的比例），逐级放宽
const TARGET_MARGIN = 0.98; // 简化的目标比上限再低一点：每个网格各自取整、有的降不满，总数也落在上限以内
const DRACO = 'KHR_draco_mesh_compression';
const BASISU = 'KHR_texture_basisu';
const REFUSED = new Set(['KHR_mesh_primitive_restart']); // gltf-transform 认识，但简化、压缩做不了的
const KNOWN = new Set(ALL_EXTENSIONS.map((e) => e.EXTENSION_NAME));

const fmt = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// 读写器整个模块共用一个：meshoptimizer 的三个 WASM 模块准备好以后才建
let ioReady: Promise<WebIO> | null = null;
function getIO(): Promise<WebIO> {
  ioReady ??= Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]).then(() =>
    new WebIO()
      .setLogger(new Logger(Logger.Verbosity.WARN)) // 只要警告和错误：prune 等步骤的 info 日志太吵（同 scripts/lib/gltf.mjs）
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder }),
  );
  return ioReady;
}

// —— 读文件 ——

// GLB 的 JSON 块（头 12 字节 + 块头 8 字节 + JSON）；版本不是 2、块不对时抛 ImportError
function glbJson(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version === 1) throw new ImportError('parse', IMPORT_MESSAGES.oldVersion);
  if (version !== 2 || bytes.byteLength < 20) throw new ImportError('parse', IMPORT_MESSAGES.parse);
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + length > bytes.byteLength) throw new ImportError('parse', IMPORT_MESSAGES.parse);
  return parseJson(bytes.subarray(20, 20 + length));
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, ''));
  } catch {
    throw new ImportError('parse', IMPORT_MESSAGES.parse);
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const hasExternalUri = (list: unknown): boolean =>
  Array.isArray(list) && list.some((r) => isRecord(r) && typeof r.uri === 'string' && !r.uri.startsWith('data:'));

// 交给 gltf-transform 之前先看一眼 JSON：读不了的情况给能看懂的提示，不让用户看到库里的报错
function inspect(json: unknown): void {
  if (!isRecord(json) || !isRecord(json.asset)) throw new ImportError('parse', IMPORT_MESSAGES.parse);
  if (String(json.asset.version ?? '').startsWith('1')) throw new ImportError('parse', IMPORT_MESSAGES.oldVersion);
  const used = new Set([...strings(json.extensionsUsed), ...strings(json.extensionsRequired)]);
  if (used.has(DRACO)) throw new ImportError('draco', IMPORT_MESSAGES.draco);
  if (used.has(BASISU)) throw new ImportError('ktx2', IMPORT_MESSAGES.ktx2);
  const refused = [...used].find((name) => REFUSED.has(name)) ?? strings(json.extensionsRequired).find((name) => !KNOWN.has(name));
  if (refused) throw new ImportError('parse', `This model needs a glTF extension we can't read yet (${refused}). Try exporting it again without it.`);
  // GLB 的第一个 buffer 没有 uri（就是 BIN 块）；有 uri 又不是 data: 的，都是另外的文件
  if (hasExternalUri(json.buffers) || hasExternalUri(json.images)) throw new ImportError('external', IMPORT_MESSAGES.external);
}

// 按内容判断：开头是 glTF 魔数就当 GLB，否则当 .gltf 的 JSON（改错了后缀也读得出来）
async function readDocument(io: WebIO, bytes: Uint8Array): Promise<Document> {
  const binary = bytes.byteLength >= 12 && new DataView(bytes.buffer, bytes.byteOffset, 12).getUint32(0, true) === GLB_MAGIC;
  const json = binary ? glbJson(bytes) : parseJson(bytes);
  inspect(json);
  try {
    return binary ? await io.readBinary(bytes) : await io.readJSON({ json: json as GLTF.IGLTF, resources: {} });
  } catch (err) {
    console.warn('import: glTF read failed', err);
    throw new ImportError('parse', IMPORT_MESSAGES.parse);
  }
}

// —— 场景和三角面 ——

// 页面只画默认场景（three 的 GLTFLoader 取 scenes[scene ?? 0]），可它会把每个场景都建出来：
// 没有场景时用没有父节点的节点建一个（没有节点就给每个网格建一个节点），其余场景去掉
function keepDefaultScene(doc: Document, warnings: string[]): void {
  const root = doc.getRoot();
  let scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  if (!scene) {
    scene = doc.createScene('Scene');
    const tops = root.listNodes().filter((n) => !n.getParentNode());
    if (tops.length) for (const n of tops) scene.addChild(n);
    else for (const mesh of root.listMeshes()) scene.addChild(doc.createNode(mesh.getName()).setMesh(mesh));
  }
  root.setDefaultScene(scene);
  const others = root.listScenes().filter((s) => s !== scene);
  for (const s of others) s.dispose();
  if (others.length) warnings.push('Only the main scene of this file was kept.');
}

function primitiveTriangles(prim: Primitive): number {
  const position = prim.getAttribute('POSITION');
  if (!position) return 0;
  const count = prim.getIndices()?.getCount() ?? position.getCount();
  const mode = prim.getMode();
  if (mode === TRIANGLES) return Math.floor(count / 3);
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, count - 2);
  return 0; // 点、线不算
}

// 画出来的三角面数（默认场景，算上同一网格的多次引用和 GPU 实例）
export function countTriangles(doc: Document): number {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return 0;
  let total = 0;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const instanced = node.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
    const copies = instanced ? Math.max(1, ...instanced.listAttributes().map((a) => a.getCount())) : 1;
    for (const prim of mesh.listPrimitives()) total += primitiveTriangles(prim) * copies;
  });
  return total;
}

// —— 简化 ——

const ratioFor = (current: number, max: number): number => Math.min(1, (max * TARGET_MARGIN) / current);

// 量化过的位置（KHR_mesh_quantization）先解成浮点：meshoptimizer 只认 Float32Array
function floatPositions(position: Accessor): Float32Array {
  const array = position.getArray();
  if (array instanceof Float32Array && position.getElementSize() === 3) return array;
  const out = new Float32Array(position.getCount() * 3);
  const el = [0, 0, 0];
  for (let i = 0; i < position.getCount(); i++) out.set(position.getElement(i, el), i * 3);
  return out;
}

// 三角形图元的索引（Uint32）；没有索引时按顺序编。个数不是 3 的倍数（坏数据）时去掉多出来的零头，meshoptimizer 才收
function indexArray(prim: Primitive): Uint32Array {
  const indices = prim.getIndices()?.getArray();
  if (indices) {
    const all = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    return all.length % 3 ? all.subarray(0, all.length - (all.length % 3)) : all;
  }
  const n = prim.getAttribute('POSITION')?.getCount() ?? 0;
  return Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
}

// 换上新的索引，去掉用不到的顶点；一个三角形都不剩的图元整个去掉（顶点数据最后由 prune 收走）
function replaceIndices(doc: Document, prim: Primitive, next: Uint32Array): void {
  if (next.length === 0) {
    prim.dispose();
    return;
  }
  const old = prim.getIndices();
  // meshoptimizer 给的数组类型带 ArrayBufferLike，gltf-transform 的 TypedArray 要 ArrayBuffer：数据一样，只是类型标注
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(next as TypedArray).setBuffer(old?.getBuffer() ?? doc.getRoot().listBuffers()[0] ?? null));
  if (old && old.listParents().length === 1) old.dispose();
  compactPrimitive(prim); // 顶点数 ≤ 65534 时索引换成 Uint16
}

export type ReducePass = 'permissive' | 'sloppy' | 'truncate';

// 第 2–4 级：每个三角形图元按同一个比例直接调 meshoptimizer（gltf-transform 的 simplify 不开放这些选项）。
// 导出给单元测试：真实模型几乎走不到 sloppy、truncate，测试直接调它们
export function reducePrimitives(doc: Document, ratio: number, pass: ReducePass): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode();
      if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) convertPrimitiveToTriangles(prim);
      else if (mode !== TRIANGLES) continue;
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      const indices = indexArray(prim);
      const target = Math.floor((ratio * indices.length) / 3) * 3;
      if (target >= indices.length) continue;
      let next: Uint32Array;
      if (pass === 'truncate') next = indices.slice(0, target);
      else if (pass === 'permissive') [next] = MeshoptSimplifier.simplify(indices, floatPositions(position), 3, target, 1, ['Permissive']);
      else [next] = MeshoptSimplifier.simplifySloppy(indices, floatPositions(position), 3, null, target, 1);
      replaceIndices(doc, prim, next);
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
}

// 降到 max 以内；返回降完的三角面数，rough：用了不管拓扑的办法（细节会粗糙）
async function reduceTriangles(doc: Document, max: number, report: (k: number) => void): Promise<{ triangles: number; rough: boolean }> {
  const steps = SIMPLIFY_ERRORS.length + 3;
  let done = 0;
  let triangles = countTriangles(doc);
  for (const error of SIMPLIFY_ERRORS) {
    if (triangles <= max) break;
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: ratioFor(triangles, max), error }));
    triangles = countTriangles(doc);
    report(++done / steps);
  }
  let rough = false;
  for (const pass of ['permissive', 'sloppy', 'truncate'] as const) {
    if (triangles <= max) break;
    if (pass !== 'permissive') rough = true;
    reducePrimitives(doc, ratioFor(triangles, max), pass);
    triangles = countTriangles(doc);
    report(++done / steps);
  }
  return { triangles, rough };
}

// —— 贴图 ——

const fitInside = (w: number, h: number, max: number): [number, number] => {
  const s = max / Math.max(w, h);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
};

async function resizeTextures(doc: Document, maxSize: number, resize: ImageResizer | undefined, warnings: string[], report: (k: number) => void): Promise<void> {
  const big = doc.getRoot().listTextures().filter((t) => {
    const size = t.getSize();
    return !!size && Math.max(size[0], size[1]) > maxSize;
  });
  if (!big.length) return;
  if (!resize) {
    warnings.push(`${plural(big.length, 'texture is', 'textures are')} larger than ${maxSize} px and ${big.length === 1 ? 'was' : 'were'} kept at full size.`);
    return;
  }
  let resized = 0;
  for (const [i, texture] of big.entries()) {
    const image = texture.getImage();
    const mimeType = texture.getMimeType();
    let out: Awaited<ReturnType<ImageResizer>> = null;
    try {
      out = image ? await resize(image, mimeType, maxSize) : null;
    } catch (err) {
      console.warn('import: texture resize failed', err);
    }
    const size = out ? ImageUtils.getSize(out.image, out.mimeType) : null;
    // 缩出来还是太大（或者读不出尺寸又是空的）就不换，原图留着
    if (out && out.image.byteLength > 0 && (!size || Math.max(size[0], size[1]) <= maxSize)) {
      texture.setImage(out.image).setMimeType(out.mimeType);
      if (out.mimeType !== mimeType) texture.setURI(''); // GLB 里用不到 uri；留着旧的扩展名会误导
      resized++;
    }
    report((i + 1) / big.length);
  }
  if (resized) warnings.push(`Resized ${plural(resized, 'texture', 'textures')} to ${maxSize} px.`);
  const failed = big.length - resized;
  if (failed) warnings.push(`${plural(failed, 'texture', 'textures')} couldn't be resized and ${failed === 1 ? 'was' : 'were'} kept at full size.`);
}

// 浏览器里缩贴图（Worker 里也行）：createImageBitmap 按目标尺寸解码（高质量缩放、不做颜色空间转换，法线贴图的数值不变），
// 画到 OffscreenCanvas 上再编码。JPEG、WebP 按原格式（质量 0.9），其余编成 PNG；浏览器编不了 WebP 时给的是 PNG，按实际类型返回。
// 注意：2D 画布内部是预乘透明度的，完全透明的像素颜色会丢（基础色贴图上看不出来）
export const browserResizeImage: ImageResizer = async (image, mimeType, maxSize) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const blob = new Blob([image.slice()], { type: mimeType });
  const decode: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
  const size = ImageUtils.getSize(image, mimeType);
  let bitmap: ImageBitmap;
  if (size) {
    const [w, h] = fitInside(size[0], size[1], maxSize);
    bitmap = await createImageBitmap(blob, { ...decode, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  } else {
    const full = await createImageBitmap(blob, decode);
    const [w, h] = fitInside(full.width, full.height, maxSize);
    bitmap = await createImageBitmap(full, { ...decode, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    full.close();
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const type = mimeType === 'image/jpeg' || mimeType === 'image/webp' ? mimeType : 'image/png';
    const out = await canvas.convertToBlob({ type, quality: 0.9 });
    return { image: new Uint8Array(await out.arrayBuffer()), mimeType: out.type || type };
  } finally {
    bitmap.close();
  }
};

// —— 整条管线 ——

// 进度：每一段在整体里占的区间，ratio 只增不减
const SPANS: Record<ImportStage, [number, number]> = {
  reading: [0, 0.15],
  cleaning: [0.15, 0.35],
  simplifying: [0.35, 0.7],
  textures: [0.7, 0.85],
  compressing: [0.85, 0.99],
  done: [1, 1],
};

function progressReporter(onProgress?: (p: ImportProgress) => void): (stage: ImportStage, k: number) => void {
  let last = -1;
  return (stage, k) => {
    if (!onProgress) return;
    const [a, b] = SPANS[stage];
    const ratio = Math.max(last, a + (b - a) * Math.min(1, Math.max(0, k)));
    last = ratio;
    onProgress({ stage, ratio });
  };
}

// bytes：文件内容；fileName 只用来查后缀（内容按魔数判断）。失败时抛 ImportError（code + 给人看的 message）
export async function importModel(bytes: Uint8Array, fileName: string, options: ImportOptions = {}, hooks: PipelineHooks = {}): Promise<ImportResult> {
  const check = checkImportFile({ name: fileName, size: bytes.byteLength }, options);
  if (!check.ok) throw check.error;
  const maxTriangles = Math.max(1, Math.floor(options.maxTriangles ?? IMPORT_LIMITS.maxTriangles));
  const maxTextureSize = Math.max(1, Math.floor(options.maxTextureSize ?? IMPORT_LIMITS.maxTextureSize));
  const progress = progressReporter(hooks.onProgress);
  const warnings: string[] = [];
  progress('reading', 0.1);
  const io = await getIO();
  const doc = await readDocument(io, bytes);
  try {
    keepDefaultScene(doc, warnings);
    const trianglesBefore = countTriangles(doc);
    if (trianglesBefore === 0) throw new ImportError('empty', IMPORT_MESSAGES.noTriangles);
    progress('cleaning', 0);
    // keepSolidTextures：不检查「纯色贴图」（prune 默认会把每张贴图按原尺寸解码、逐像素看是不是一个颜色）。
    // 4096 的贴图解码再读回像素，Worker 里做也会让主画面掉两帧（scripts/check-import.mjs 量到 50 ms 的帧间隔，关掉后 16.8 ms），还多花几百毫秒
    await doc.transform(dedup(), prune({ keepSolidTextures: true }), weld());
    progress('cleaning', 1);
    let triangles = countTriangles(doc);
    let simplified = false;
    if (triangles > maxTriangles) {
      progress('simplifying', 0);
      const before = triangles;
      const r = await reduceTriangles(doc, maxTriangles, (k) => progress('simplifying', k));
      triangles = r.triangles;
      simplified = true;
      warnings.push(`Simplified from ${fmt(before)} to ${fmt(triangles)} triangles.`);
      if (r.rough) warnings.push('This model was hard to simplify, so some fine detail may look rough.');
    }
    progress('textures', 0);
    await resizeTextures(doc, maxTextureSize, hooks.resizeImage, warnings, (k) => progress('textures', k));
    progress('compressing', 0);
    // 简化、去掉图元以后剩下的顶点数据、材质、贴图由 prune 收走（同样不逐像素检查纯色贴图）；GLB 只能有一个 buffer（.gltf 常有好几个），合成一个
    if (!doc.getRoot().listBuffers().length) doc.createBuffer();
    await doc.transform(prune({ keepSolidTextures: true }), unpartition(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    triangles = countTriangles(doc);
    const glb = await io.writeBinary(doc);
    progress('done', 1);
    return { glb, triangles, trianglesBefore, bytes: glb.byteLength, bytesBefore: bytes.byteLength, simplified, warnings };
  } catch (err) {
    if (err instanceof ImportError) throw err;
    console.error('import: optimizing failed', err);
    throw new ImportError('unknown', IMPORT_MESSAGES.unknown);
  }
}

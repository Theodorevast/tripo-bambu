import { readFileSync } from 'node:fs';
import { Document, WebIO, type GLTF } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { checkImportFile, IMPORT_MESSAGES } from '../src/works/importCheck';
import { countTriangles, importModel, reducePrimitives, type ImageResizer } from '../src/works/importModel';
import { IMPORT_LIMITS, ImportError, type ImportProgress } from '../src/works/importTypes';
import { makeSphereDocument as sphereDoc } from '../scripts/make-import-fixture.mjs';

// 导入管线（src/works/importModel.ts）：夹具是 tests/fixtures/import-small.glb（scripts/make-import-fixture.mjs 生成：12,096 面的 UV 球、64 px 棋盘格贴图）
const FIXTURE_TRIS = 12_096;
const fixture = (): Uint8Array => new Uint8Array(readFileSync(new URL('./fixtures/import-small.glb', import.meta.url)));

let readerIO: Promise<WebIO> | null = null;
// 输出读回来：带 meshopt 解码器（输出一律是 EXT_meshopt_compression）
async function reread(glb: Uint8Array): Promise<Document> {
  readerIO ??= MeshoptDecoder.ready.then(() => new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }));
  return (await readerIO).readBinary(glb);
}

const glbOf = (doc: Document): Promise<Uint8Array> => new WebIO().registerExtensions(ALL_EXTENSIONS).writeBinary(doc);

// 期望 importModel 以某个 code 失败
async function failsWith(bytes: Uint8Array, name: string, code: ImportError['code'], options = {}): Promise<ImportError> {
  const err = await importModel(bytes, name, options).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ImportError);
  expect((err as ImportError).code).toBe(code);
  return err as ImportError;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

// 一个 .gltf：把 writeJSON 写出来的外部 .bin、贴图都换成 data: URI
async function embeddedGltf(doc: Document): Promise<Uint8Array> {
  const { json, resources } = await new WebIO().writeJSON(doc);
  const dataUri = (uri: string, mime: string) => `data:${mime};base64,${Buffer.from(resources[uri]).toString('base64')}`;
  for (const b of json.buffers ?? []) if (b.uri) b.uri = dataUri(b.uri, 'application/octet-stream');
  for (const img of json.images ?? []) if (img.uri) img.uri = dataUri(img.uri, img.mimeType ?? 'image/png');
  return text(JSON.stringify(json));
}

// 全是平面法线的球（每个三角形三个独立顶点，weld 合并不了）：保拓扑的 simplify 几乎降不动
function facetedDoc(segments = 128, rings = 80): Document {
  const doc = new Document();
  const grid: number[][] = [];
  for (let y = 0; y <= rings; y++) for (let x = 0; x <= segments; x++) {
    const th = (x / segments) * Math.PI * 2;
    const ph = (y / rings) * Math.PI;
    grid.push([Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)]);
  }
  const tris: number[][] = [];
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const a = y * (segments + 1) + x;
    if (y > 0) tris.push([a, a + segments + 1, a + 1]);
    if (y < rings - 1) tris.push([a + 1, a + segments + 1, a + segments + 2]);
  }
  const pos = new Float32Array(tris.length * 9);
  const nor = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    const [p, q, r] = t.map((k) => grid[k]);
    const e1 = q.map((v, k) => v - p[k]);
    const e2 = r.map((v, k) => v - p[k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    [p, q, r].forEach((v, j) => {
      pos.set(v, i * 9 + j * 3);
      nor.set(n.map((c) => c / l), i * 9 + j * 3);
    });
  });
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nor).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return doc;
}

// 棋盘格：只有「黑格」有面（每格两个三角形），格子之间只在角上相连。每个内部顶点都是两个格子的「蝴蝶结」顶点（非流形），
// meshoptimizer 把它们锁住不动：保拓扑的简化、Permissive 都降不下去
function checkerboardDoc(n = 200): Document {
  const doc = new Document();
  const pos = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) pos.set([x / n, 0, y / n], (y * n + x) * 3);
  const idx: number[] = [];
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    if ((x + y) % 2) continue;
    const a = y * n + x;
    idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
  }
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
  return doc;
}

// 测试里用 sharp 缩贴图（浏览器里是 browserResizeImage）
const sharpResize: ImageResizer = async (image, _mime, max) => ({
  image: new Uint8Array(await sharp(Buffer.from(image)).resize(max, max, { fit: 'inside' }).png().toBuffer()),
  mimeType: 'image/png',
});

describe('checkImportFile：读文件之前的检查', () => {
  it('收 .glb、.gltf（不分大小写），50 MB 以内', () => {
    expect(checkImportFile({ name: 'Robot.GLB', size: 1000 })).toEqual({ ok: true });
    expect(checkImportFile({ name: 'scene.gltf', size: IMPORT_LIMITS.maxBytes })).toEqual({ ok: true });
  });
  it('别的后缀：bad_type', () => {
    for (const name of ['model.obj', 'model.fbx', 'glb', 'model.glb.zip']) {
      const r = checkImportFile({ name, size: 10 });
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('bad_type');
    }
  });
  it('超过 50 MB：too_big，提示里写着大小和上限；空文件：parse', () => {
    const big = checkImportFile({ name: 'a.glb', size: IMPORT_LIMITS.maxBytes + 1 });
    expect(big.ok).toBe(false);
    if (!big.ok) {
      expect(big.error.code).toBe('too_big');
      expect(big.error.message).toMatch(/50 MB/);
    }
    const empty = checkImportFile({ name: 'a.glb', size: 0 });
    expect(empty.ok || empty.error.code).toBe('parse');
  });
});

describe('importModel：小模型', () => {
  it('不用简化：三角面照数，输出是 meshopt 压缩的 GLB，读得回来；进度按顺序走到 1', async () => {
    const input = fixture();
    const steps: ImportProgress[] = [];
    const r = await importModel(input, 'import-small.glb', {}, { onProgress: (p) => steps.push(p) });
    expect(r.triangles).toBe(FIXTURE_TRIS);
    expect(r.trianglesBefore).toBe(FIXTURE_TRIS);
    expect(r.simplified).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.bytes).toBe(r.glb.byteLength);
    expect(r.bytesBefore).toBe(input.byteLength);
    expect(r.bytes).toBeLessThan(r.bytesBefore);
    const back = await reread(r.glb);
    expect(countTriangles(back)).toBe(FIXTURE_TRIS);
    expect(back.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');
    expect(back.getRoot().listTextures()).toHaveLength(1);
    const stages = steps.map((s) => s.stage).filter((s, i, a) => a.indexOf(s) === i);
    expect(stages).toEqual(['reading', 'cleaning', 'textures', 'compressing', 'done']);
    expect(steps.every((s, i) => i === 0 || s.ratio >= steps[i - 1].ratio)).toBe(true);
    expect(steps.at(-1)).toEqual({ stage: 'done', ratio: 1 });
  });

  it('超过上限时自动简化到上限以内，并给提示', async () => {
    const steps: ImportProgress[] = [];
    const r = await importModel(fixture(), 'import-small.glb', { maxTriangles: 2000 }, { onProgress: (p) => steps.push(p) });
    expect(r.simplified).toBe(true);
    expect(r.triangles).toBeLessThanOrEqual(2000);
    expect(r.triangles).toBeGreaterThan(1000); // 降到上限附近，不是降光
    expect(r.trianglesBefore).toBe(FIXTURE_TRIS);
    expect(r.warnings).toContain(`Simplified from 12,096 to ${r.triangles.toLocaleString('en-US')} triangles.`);
    expect(steps.some((s) => s.stage === 'simplifying')).toBe(true);
    expect(countTriangles(await reread(r.glb))).toBe(r.triangles);
  });

  it('平面着色（法线全断开）的模型：保拓扑的简化降不动，换 Permissive 也能降到上限以内', async () => {
    const doc = facetedDoc();
    const before = countTriangles(doc);
    expect(before).toBeGreaterThan(20_000);
    const r = await importModel(await glbOf(doc), 'faceted.glb', { maxTriangles: 2000 });
    expect(r.triangles).toBeLessThanOrEqual(2000);
    expect(r.triangles).toBeGreaterThan(1000);
    expect(countTriangles(await reread(r.glb))).toBe(r.triangles);
  });

  it('非流形的棋盘格（格子只在角上相连）：保拓扑的简化降不动，Permissive 照样降到上限以内', async () => {
    const doc = checkerboardDoc();
    expect(countTriangles(doc)).toBeGreaterThan(30_000);
    const r = await importModel(await glbOf(doc), 'checkerboard.glb', { maxTriangles: 2000 });
    expect(r.triangles).toBeLessThanOrEqual(2000);
    expect(r.triangles).toBeGreaterThan(1000);
    expect(r.warnings.some((w) => /rough/.test(w))).toBe(false);
    expect(countTriangles(await reread(r.glb))).toBe(r.triangles);
  });

  it('三角面按画出来的算：一个网格被三个节点用，算三遍；简化后画出来的总数在上限以内', async () => {
    const doc = await sphereDoc();
    const mesh = doc.getRoot().listMeshes()[0];
    const scene = doc.getRoot().listScenes()[0];
    for (const x of [1, 2]) scene.addChild(doc.createNode(`copy-${x}`).setMesh(mesh).setTranslation([x * 1.2, 0, 0]));
    expect(countTriangles(doc)).toBe(FIXTURE_TRIS * 3);
    const r = await importModel(await glbOf(doc), 'three-balls.glb', { maxTriangles: 30_000 });
    expect(r.trianglesBefore).toBe(FIXTURE_TRIS * 3);
    expect(r.simplified).toBe(true);
    expect(r.triangles).toBeLessThanOrEqual(30_000);
    const back = await reread(r.glb);
    expect(back.getRoot().listMeshes()).toHaveLength(1); // 还是共用一个网格
    expect(countTriangles(back)).toBe(r.triangles);
  });

  it('贴图边长超过上限：用注入的缩图函数缩到上限；没有缩图函数时原样留着并提示', async () => {
    const glb = await glbOf(await sphereDoc({ textureSize: 1024 }));
    const r = await importModel(glb, 'big-texture.glb', { maxTextureSize: 512 }, { resizeImage: sharpResize });
    expect(r.warnings).toContain('Resized 1 texture to 512 px.');
    expect((await reread(r.glb)).getRoot().listTextures()[0].getSize()).toEqual([512, 512]);
    const kept = await importModel(glb, 'big-texture.glb', { maxTextureSize: 512 });
    expect(kept.warnings).toContain('1 texture is larger than 512 px and was kept at full size.');
    expect((await reread(kept.glb)).getRoot().listTextures()[0].getSize()).toEqual([1024, 1024]);
  });

  it('缩图函数失败（抛错、给出的图还是太大）：原图留着，提示没缩成', async () => {
    const glb = await glbOf(await sphereDoc({ textureSize: 1024 }));
    const r = await importModel(glb, 'big-texture.glb', { maxTextureSize: 512 }, { resizeImage: async () => { throw new Error('no canvas'); } });
    expect(r.warnings).toContain("1 texture couldn't be resized and was kept at full size.");
    const tooBig: ImageResizer = async (image, mimeType) => ({ image, mimeType });
    const r2 = await importModel(glb, 'big-texture.glb', { maxTextureSize: 512 }, { resizeImage: tooBig });
    expect(r2.warnings).toContain("1 texture couldn't be resized and was kept at full size.");
  });
});

describe('reducePrimitives：简化的第 2–4 级（真实模型几乎走不到后两级，直接测）', () => {
  const ball = async (): Promise<Document> => {
    await MeshoptSimplifier.ready;
    const doc = await sphereDoc();
    await doc.transform(weld());
    return doc;
  };
  const prim = (doc: Document) => doc.getRoot().listMeshes()[0].listPrimitives()[0];

  it('permissive、sloppy：降到比例以内，用不到的顶点去掉，索引换成 Uint16', async () => {
    for (const [pass, ratio] of [['permissive', 0.25], ['sloppy', 0.1]] as const) {
      const doc = await ball();
      const vertsBefore = prim(doc).getAttribute('POSITION')!.getCount();
      reducePrimitives(doc, ratio, pass);
      const n = countTriangles(doc);
      expect(n, pass).toBeLessThanOrEqual(Math.floor(FIXTURE_TRIS * ratio));
      expect(n, pass).toBeGreaterThan(0);
      expect(prim(doc).getAttribute('POSITION')!.getCount(), pass).toBeLessThan(vertsBefore);
      expect(prim(doc).getIndices()!.getArray(), pass).toBeInstanceOf(Uint16Array);
      expect(countTriangles(await reread(await glbOf(doc))), pass).toBe(n);
    }
  });

  it('truncate：正好截到比例；比例是 0 时图元、网格都去掉', async () => {
    const doc = await ball();
    reducePrimitives(doc, 0.5, 'truncate');
    expect(countTriangles(doc)).toBe(FIXTURE_TRIS / 2);
    reducePrimitives(doc, 0, 'truncate');
    expect(countTriangles(doc)).toBe(0);
    expect(doc.getRoot().listMeshes()).toHaveLength(0);
  });
});

describe('importModel：.gltf', () => {
  it('资源都内嵌（data: URI）的 .gltf：照常导入', async () => {
    const r = await importModel(await embeddedGltf(await sphereDoc()), 'ball.gltf');
    expect(r.triangles).toBe(FIXTURE_TRIS);
    expect((await reread(r.glb)).getRoot().listTextures()).toHaveLength(1);
  });

  it('引用外部文件（.bin、贴图）的 .gltf：external', async () => {
    const { json } = await new WebIO().writeJSON(await sphereDoc());
    const err = await failsWith(text(JSON.stringify(json)), 'ball.gltf', 'external');
    expect(err.message).toBe(IMPORT_MESSAGES.external);
  });

  it('按内容判断格式：.gltf 的 JSON 存成了 .glb 也读得出来', async () => {
    const r = await importModel(await embeddedGltf(await sphereDoc()), 'renamed.glb');
    expect(r.triangles).toBe(FIXTURE_TRIS);
  });
});

describe('importModel：读不了的文件给能看懂的提示', () => {
  it('随机字节：parse', async () => {
    const junk = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251);
    const err = await failsWith(junk, 'junk.glb', 'parse');
    expect(err.message).toBe(IMPORT_MESSAGES.parse);
  });

  it('GLB 魔数后面是坏数据：parse', async () => {
    const glb = fixture();
    const broken = glb.slice(0, 200);
    await failsWith(broken, 'cut.glb', 'parse');
    const badJson = glb.slice();
    badJson.fill(0x7b, 20, 60); // JSON 块开头换成一串 {
    await failsWith(badJson, 'bad-json.glb', 'parse');
  });

  it('后缀不对：bad_type；超过 maxBytes：too_big', async () => {
    await failsWith(fixture(), 'ball.obj', 'bad_type');
    await failsWith(fixture(), 'ball.glb', 'too_big', { maxBytes: 1000 });
  });

  it('没有网格（或者只有点、线）：empty', async () => {
    const doc = new Document();
    doc.createBuffer();
    doc.createScene().addChild(doc.createNode('empty'));
    await failsWith(await glbOf(doc), 'nothing.glb', 'empty');
    const points = new Document();
    const buffer = points.createBuffer();
    const prim = points.createPrimitive().setMode(0).setAttribute('POSITION', points.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 1, 1, 2, 0, 1])).setBuffer(buffer));
    points.createScene().addChild(points.createNode().setMesh(points.createMesh().addPrimitive(prim)));
    await failsWith(await glbOf(points), 'points.glb', 'empty');
  });

  it('Draco、KTX2、glTF 1.0、不认识的必需扩展：各有各的提示', async () => {
    const base: GLTF.IGLTF = { asset: { version: '2.0' }, scenes: [{ nodes: [] }] };
    await failsWith(text(JSON.stringify({ ...base, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] })), 'd.gltf', 'draco');
    await failsWith(text(JSON.stringify({ ...base, extensionsUsed: ['KHR_texture_basisu'] })), 'k.gltf', 'ktx2');
    const old = await failsWith(text(JSON.stringify({ asset: { version: '1.0' } })), 'old.gltf', 'parse');
    expect(old.message).toBe(IMPORT_MESSAGES.oldVersion);
    const unknown = await failsWith(text(JSON.stringify({ ...base, extensionsUsed: ['ACME_magic'], extensionsRequired: ['ACME_magic'] })), 'u.gltf', 'parse');
    expect(unknown.message).toMatch(/ACME_magic/);
  });
});

describe('importModel：场景', () => {
  it('没有场景（只有节点）：用顶层节点建一个，照常导入', async () => {
    const { json, resources } = await new WebIO().writeJSON(await sphereDoc());
    delete json.scenes;
    delete json.scene;
    for (const b of json.buffers ?? []) if (b.uri) b.uri = `data:application/octet-stream;base64,${Buffer.from(resources[b.uri]).toString('base64')}`;
    for (const img of json.images ?? []) if (img.uri) img.uri = `data:image/png;base64,${Buffer.from(resources[img.uri]).toString('base64')}`;
    const r = await importModel(text(JSON.stringify(json)), 'no-scene.gltf');
    expect(r.triangles).toBe(FIXTURE_TRIS);
    const back = await reread(r.glb);
    expect(back.getRoot().getDefaultScene()?.listChildren()).toHaveLength(1);
  });

  it('好几个场景：只留默认场景（页面只画它），给提示', async () => {
    const doc = await sphereDoc();
    const extra = doc.createScene('extra');
    extra.addChild(doc.createNode('other').setMesh(doc.getRoot().listMeshes()[0].clone()));
    doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
    const r = await importModel(await glbOf(doc), 'two-scenes.glb');
    expect(r.warnings).toContain('Only the main scene of this file was kept.');
    const back = await reread(r.glb);
    expect(back.getRoot().listScenes()).toHaveLength(1);
    expect(back.getRoot().listMeshes()).toHaveLength(1);
  });
});

describe('importModel：真实模型', () => {
  it('public/models 里的作品（meshopt + WebP 贴图）：读得进、写得出、读得回来；按上限简化也行', async () => {
    const input = new Uint8Array(readFileSync(new URL('../public/models/pumpkin-girl.glb', import.meta.url)));
    const r = await importModel(input, 'pumpkin-girl.glb');
    expect(r.simplified).toBe(false);
    expect(r.triangles).toBe(r.trianglesBefore);
    expect(r.triangles).toBeGreaterThan(40_000);
    const back = await reread(r.glb);
    expect(countTriangles(back)).toBe(r.triangles);
    expect(back.getRoot().listTextures().every((t) => t.getMimeType() === 'image/webp')).toBe(true);
    const small = await importModel(input, 'pumpkin-girl.glb', { maxTriangles: 20_000 });
    expect(small.triangles).toBeLessThanOrEqual(20_000);
    expect(small.triangles).toBeGreaterThan(10_000);
    expect(countTriangles(await reread(small.glb))).toBe(small.triangles);
  }, 60_000);
});

// 生成导入管线单元测试的夹具：tests/fixtures/import-small.glb（提交进仓库）。
// 一个 UV 球：96 段 × 64 圈 = 12,096 个三角形，带法线、UV 和一张 64 px 的棋盘格 PNG 贴图（不是纯色：纯色贴图会被 prune 并进材质颜色）。
// 不压缩、不带任何扩展：测的是最普通的 GLB；带 meshopt、WebP 的真实模型由测试直接读 public/models/ 里的。
// 用法：node scripts/make-import-fixture.mjs [输出路径]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';

const OUT = process.argv[2] ?? 'tests/fixtures/import-small.glb';
const SEGMENTS = 96;
const RINGS = 64;

// 球面网格：(SEGMENTS + 1) × (RINGS + 1) 个顶点（接缝处重复一列，UV 才连得上），两极各少一个退化三角形
export function sphere(segments = SEGMENTS, rings = RINGS) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let y = 0; y <= rings; y++) {
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const v = y / rings;
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(n[0] * 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5); // 半径 0.5，底部在 y = 0
      normals.push(...n);
      uvs.push(u, v);
    }
  }
  const indices = [];
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      if (y > 0) indices.push(a, c, b);
      if (y < rings - 1) indices.push(b, c, d);
    }
  }
  const vertexCount = positions.length / 3;
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices) };
}

// 8×8 的棋盘格，放大到 size × size（最近邻）
async function checker(size) {
  const cells = Buffer.from(Array.from({ length: 64 }, (_, i) => (((i % 8) + Math.floor(i / 8)) % 2 ? [44, 110, 143] : [242, 183, 5])).flat());
  return new Uint8Array(await sharp(cells, { raw: { width: 8, height: 8, channels: 3 } }).resize(size, size, { kernel: 'nearest' }).png().toBuffer());
}

export async function makeSphereDocument({ textureSize = 64, segments = SEGMENTS, rings = RINGS } = {}) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const { positions, normals, uvs, indices } = sphere(segments, rings);
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const texture = doc.createTexture('checker').setImage(await checker(textureSize)).setMimeType('image/png');
  const material = doc.createMaterial('ball').setBaseColorTexture(texture).setRoughnessFactor(0.7).setMetallicFactor(0);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', positions))
    .setAttribute('NORMAL', accessor('VEC3', normals))
    .setAttribute('TEXCOORD_0', accessor('VEC2', uvs))
    .setIndices(accessor('SCALAR', indices))
    .setMaterial(material);
  doc.createScene('scene').addChild(doc.createNode('ball').setMesh(doc.createMesh('ball').addPrimitive(prim)));
  return doc;
}

// 直接运行时写文件；被别的脚本 import（check-import.mjs 借 makeSphereDocument 造大模型）时不写
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const glb = await new NodeIO().writeBinary(await makeSphereDocument());
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, glb);
  console.log(`${OUT}：${(glb.byteLength / 1024).toFixed(0)} KB，${(SEGMENTS * (2 * RINGS - 2)).toLocaleString('en-US')} 个三角形`);
}

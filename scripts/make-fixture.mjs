// 生成模型处理脚本的测试数据：.tmp/fixture/ 下两个 GLB（一个带 4096 贴图）+ works.csv（含一行找不到的文件）
import { mkdirSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { makeBoxGlb } from './lib/fixture.mjs';

// 把 GLB 的贴图换成同尺寸的 8×8 棋盘格：纯色贴图会被 prune() 并进材质颜色，就测不到缩到 2048 和转 WebP 了
async function withCheckerTexture(glb) {
  const io = new NodeIO();
  const doc = await io.readBinary(glb);
  const texture = doc.getRoot().listTextures()[0];
  const [size] = texture.getSize();
  const cells = Buffer.from(Array.from({ length: 64 }, (_, i) => ((i % 8) + Math.floor(i / 8)) % 2 ? [44, 110, 143] : [200, 120, 60]).flat());
  const png = await sharp(cells, { raw: { width: 8, height: 8, channels: 3 } }).resize(size, size, { kernel: 'nearest' }).png().toBuffer();
  texture.setImage(new Uint8Array(png));
  return io.writeBinary(doc);
}

mkdirSync('.tmp/fixture', { recursive: true });
writeFileSync('.tmp/fixture/big-texture.glb', await withCheckerTexture(await makeBoxGlb({ textureSize: 4096 })));
writeFileSync('.tmp/fixture/small.glb', await makeBoxGlb({ textureSize: 64 }));
writeFileSync('.tmp/fixture/works.csv', 'file,title,author,description\nbig-texture.glb,"Big Texture, Test",tester,Fixture with a 4096 texture\nsmall.glb,Small,tester2,\nmissing.glb,Missing,nobody,\n');
console.log('测试数据写到 .tmp/fixture/');

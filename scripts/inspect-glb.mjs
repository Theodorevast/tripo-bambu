// 查看 GLB：文件大小、三角面数、每张贴图的格式和尺寸。node scripts/inspect-glb.mjs <file.glb>
import { statSync } from 'node:fs';
import sharp from 'sharp';
import { countTris, createIO } from './lib/gltf.mjs';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/inspect-glb.mjs <file.glb>');
  process.exit(2);
}
const doc = await (await createIO()).read(file);
console.log(`${file}  ${(statSync(file).size / 1048576).toFixed(2)} MB  ${countTris(doc).toLocaleString('en-US')} tris`);
for (const tex of doc.getRoot().listTextures()) {
  const meta = await sharp(Buffer.from(tex.getImage())).metadata();
  console.log(`  texture ${tex.getMimeType()} ${meta.width}×${meta.height}`);
}

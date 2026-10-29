// 改之前、改之后的走路录屏并排比较（scripts/record-walk.mjs 录的两份，路线、按键、帧数一样）：
// 每段一个左右并排的 MP4（左 before、右 after），再拼一张总览图：每段两行，上面一行改之前、下面一行改之后，同一列是同一帧。
// node scripts/compare-walk.mjs [before 目录] [after 目录] [输出目录]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const MEDIA = '.superpowers/sdd/2026-10-27-community-planets/team/walk-media';
const BEFORE = process.argv[2] ?? path.join(MEDIA, 'before');
const AFTER = process.argv[3] ?? path.join(MEDIA, 'after');
const OUT = process.argv[4] ?? path.join(MEDIA, 'compare');
mkdirSync(OUT, { recursive: true });

const before = JSON.parse(readFileSync(path.join(BEFORE, 'segments.json'), 'utf8'));
const after = JSON.parse(readFileSync(path.join(AFTER, 'segments.json'), 'utf8'));
const names = after.segments.map((s) => s.name).filter((n) => before.segments.some((b) => b.name === n));

// 并排的 MP4：两边各缩到 960×600
const videos = [];
for (const name of names) {
  const a = path.join(BEFORE, `${name}.mp4`);
  const b = path.join(AFTER, `${name}.mp4`);
  if (!existsSync(a) || !existsSync(b)) continue;
  const out = path.join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-i', b, '-filter_complex', '[0:v]scale=960:600[l];[1:v]scale=960:600[r];[l][r]hstack=inputs=2[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', out]);
  videos.push(out);
  console.log(out);
}
const list = path.join(OUT, 'list.txt');
writeFileSync(list, videos.map((v) => `file '${path.resolve(v).replace(/\\/g, '/')}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(OUT, 'all.mp4')]);

// 总览图
const W = 360;
const H = 225;
const label = (text, color) => Buffer.from(`<svg width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="22" fill="${color}"/><text x="6" y="16" font-family="Segoe UI, Arial" font-size="14" fill="#fff">${text}</text></svg>`);
const tiles = [];
let row = 0;
let cols = 0;
for (const name of names) {
  const keys = after.segments.find((s) => s.name === name).keys;
  cols = Math.max(cols, keys.length);
  for (const [which, dir, color] of [['before', BEFORE, 'rgba(120,40,40,0.75)'], ['after', AFTER, 'rgba(30,90,50,0.75)']]) {
    for (let c = 0; c < keys.length; c++) {
      const file = path.join(dir, `${name}-${keys[c]}.jpg`);
      if (!existsSync(file)) continue;
      const img = await sharp(file).resize(W, H, { fit: 'cover' }).composite([{ input: label(`${which} · ${name} · ${keys[c]}`, color), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
      tiles.push({ input: img, left: c * W, top: row * H });
    }
    row++;
  }
}
const contact = path.join(OUT, 'contact.jpg');
await sharp({ create: { width: cols * W, height: row * H, channels: 3, background: '#202020' } }).composite(tiles).jpeg({ quality: 84 }).toFile(contact);
console.log(`并排总览图 ${contact}`);

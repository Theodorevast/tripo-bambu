// 生成光标图（ui/cursor.css 用）：每种光标一张 32×32（1x）、一张 64×64（2x）的 PNG，写到 src/ui/cursors/
// 图是下面的 SVG（32×32 的坐标），用 sharp（librsvg）按 1 倍、2 倍栅格化：高分屏上系统直接用 2x 那张，不放大、不糊。
// 热点（指针的尖）写在 cursor.css 里，和这里的坐标对应：箭头的尖在 (4, 3)，拖动的圈在正中 (16, 16)。
// node scripts/make-cursors.mjs
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = fileURLToPath(new URL('../src/ui/cursors/', import.meta.url));

// —— 第一版：玩具贴纸。墨色（--ink）圆角箭头、白边，底下一道「厚度」（同按钮）；能点的变成翠宝黄 ——
const INK = '#4a4058';
const YOLK = '#f2b705';
const LEDGE = 'rgba(60, 45, 30, 0.34)';
// 经典箭头：尖 (4, 3)、左边竖直、右边约 45°、尾巴一截
const ARROW = 'M4 3 L4 21.5 L8.6 17.4 L11.5 24.2 L14.8 22.8 L11.9 16.1 L17.6 16.1 Z';
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;

const v1 = {
  // 平时：墨色箭头，2px 白边，左边一道淡淡的高光
  default: svg(`
    <path d="${ARROW}" transform="translate(0 1.5)" fill="${LEDGE}" stroke="${LEDGE}" stroke-width="4" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="${INK}" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round"/>
    <path d="M5.9 8.2 V14.6" stroke="#fff" stroke-opacity="0.32" stroke-width="1.1" stroke-linecap="round"/>`),
  // 能点：翠宝黄的箭头，细墨边、白边，高光亮一点
  pointer: svg(`
    <path d="${ARROW}" transform="translate(0 1.5)" fill="${LEDGE}" stroke="${LEDGE}" stroke-width="5" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="#fff" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="${YOLK}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${ARROW}" fill="${YOLK}"/>
    <path d="M6.1 8.6 V14.2" stroke="#fff" stroke-opacity="0.85" stroke-width="1.2" stroke-linecap="round"/>`),
  // 能拖：白边的墨色圆圈，中间空着一圈，正中一颗翠宝黄的小点
  grab: svg(`
    <circle cx="16" cy="17.4" r="7" fill="none" stroke="${LEDGE}" stroke-width="5"/>
    <circle cx="16" cy="17.4" r="3" fill="${LEDGE}"/>
    <circle cx="16" cy="16" r="7" fill="none" stroke="#fff" stroke-width="5"/>
    <circle cx="16" cy="16" r="7" fill="none" stroke="${INK}" stroke-width="2.4"/>
    <circle cx="16" cy="16" r="3" fill="#fff"/>
    <circle cx="16" cy="16" r="2.3" fill="${INK}"/>
    <circle cx="16" cy="16" r="1.5" fill="${YOLK}"/>`),
  // 拖着：按下去的翠宝黄圆钮（厚度只剩一点，同按钮按下），左上一点高光
  grabbing: svg(`
    <circle cx="16" cy="16.7" r="7.8" fill="${LEDGE}"/>
    <circle cx="16" cy="16" r="7.8" fill="#fff"/>
    <circle cx="16" cy="16" r="5.6" fill="${YOLK}" stroke="${INK}" stroke-width="2.2"/>
    <circle cx="14.2" cy="14.2" r="1.15" fill="#fff" fill-opacity="0.85"/>`),
};

const SETS = { v1 };

mkdirSync(OUT, { recursive: true });
for (const [set, cursors] of Object.entries(SETS)) {
  for (const [name, src] of Object.entries(cursors)) {
    for (const scale of [1, 2]) {
      const file = `${OUT}${set}-${name}${scale === 2 ? '@2x' : ''}.png`;
      // density 72 = SVG 的 1 个单位画 1 个像素
      await sharp(Buffer.from(src), { density: 72 * scale }).png({ compressionLevel: 9 }).toFile(file);
      console.log(file);
    }
  }
}

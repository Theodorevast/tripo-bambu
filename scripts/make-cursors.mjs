// 生成光标图（ui/cursor.css 用）：每种光标一张 32×32（1x）、一张 64×64（2x）的 PNG，写到 src/ui/cursors/
// 图是下面的 SVG（32×32 的坐标），用 sharp（librsvg）按 1 倍、2 倍栅格化：高分屏上系统直接用 2x 那张，不放大、不糊。
// 热点（指针的尖）写在 cursor.css（第二版在 theme-v2.css）里，和这里的坐标对应：第一版箭头的尖在 (4, 3)，第二版指针的尖在 (5, 3)，拖动的圈在正中 (16, 16)。
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

// —— 第二版：午夜天文台。细长的星图指针（星光白、右半面暗一档、中间一道金色的脊线，像天体仪上的指针），
//    能点时镀金、右上角一颗四角小星；能拖、拖着是一圈香槟金的天体仪刻度（拖着时圈收紧、刻度转到斜角）。
//    线 1.3px、圆头；底下垫一道半透明的午夜蓝描边：象牙白的作品卡片上也看得见 ——
const MID = '#0f1530';
const GOLD = '#d8c08e';
const DEEP = '#a8894f';
const STAR = '#f6f1e7';
const NEEDLE = 'M5 3 L5 21.6 L8.4 16.2 L13.9 19.3 Z'; // 尖 (5, 3)，左边竖直，背后一个凹口
const LEFT = 'M5 3 L5 21.6 L8.4 16.2 Z';
const RIGHT = 'M5 3 L8.4 16.2 L13.9 19.3 Z';
const SPARK = 'M17 2.6 L17.85 5.65 L20.9 6.5 L17.85 7.35 L17 10.4 L16.15 7.35 L13.1 6.5 L16.15 5.65 Z';
const TICKS = 'M16 3.6V6.4 M28.4 16H25.6 M16 28.4V25.6 M3.6 16H6.4';
const DIAG = 'M21.09 10.91L23.07 8.93 M10.91 10.91L8.93 8.93 M21.09 21.09L23.07 23.07 M10.91 21.09L8.93 23.07';

const v2 = {
  // 平时：星光白的指针，右半面暗一档，脊线是深一点的金
  default: svg(`
    <path d="${NEEDLE}" fill="${MID}" fill-opacity="0.85" stroke="${MID}" stroke-opacity="0.85" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="${LEFT}" fill="${STAR}"/>
    <path d="${RIGHT}" fill="#d6c9ae"/>
    <path d="M5 3 L8.4 16.2" stroke="${DEEP}" stroke-width="0.8" stroke-linecap="round"/>`),
  // 能点：镀金的指针（脊线换成星光白），右上角一颗四角小星
  pointer: svg(`
    <path d="${NEEDLE}" fill="${MID}" fill-opacity="0.85" stroke="${MID}" stroke-opacity="0.85" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="${LEFT}" fill="#efdcab"/>
    <path d="${RIGHT}" fill="#bf9e5e"/>
    <path d="M5 3 L8.4 16.2" stroke="${STAR}" stroke-width="0.8" stroke-linecap="round"/>
    <path d="${SPARK}" fill="${MID}" fill-opacity="0.8" stroke="${MID}" stroke-opacity="0.8" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="${SPARK}" fill="${STAR}"/>`),
  // 能拖：一圈金线，外面四道刻度，正中一颗星光白的小点
  grab: svg(`
    <g fill="none" stroke-linecap="round">
      <g stroke="${MID}" stroke-opacity="0.75" stroke-width="3"><circle cx="16" cy="16" r="7"/><path d="${TICKS}"/></g>
      <g stroke="${GOLD}" stroke-width="1.3"><circle cx="16" cy="16" r="7"/><path d="${TICKS}"/></g>
    </g>
    <circle cx="16" cy="16" r="2.1" fill="${MID}" fill-opacity="0.75"/>
    <circle cx="16" cy="16" r="1.25" fill="${STAR}"/>`),
  // 拖着：圈收紧，刻度转到斜角，正中的小点换成金色
  grabbing: svg(`
    <g fill="none" stroke-linecap="round">
      <g stroke="${MID}" stroke-opacity="0.75" stroke-width="3"><circle cx="16" cy="16" r="5"/><path d="${DIAG}"/></g>
      <g stroke="${GOLD}" stroke-width="1.3"><circle cx="16" cy="16" r="5"/><path d="${DIAG}"/></g>
    </g>
    <circle cx="16" cy="16" r="2.6" fill="${MID}" fill-opacity="0.75"/>
    <circle cx="16" cy="16" r="1.8" fill="${GOLD}"/>`),
};

const SETS = { v1, v2 };

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

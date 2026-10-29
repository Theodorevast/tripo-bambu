// 星球页作品区域的平均亮度（v2-sky 验收：作品和展台不能比第一版暗太多）：node scripts/lum-works.mjs <截图.png> [更多截图…]
// 截图是 shot-sky.mjs / shot-planet.mjs 的 1440×900 星球视图（像素比 1、同一个机位）。量四个展台连同作品那一块的显示亮度
// （sRGB 0..255 → 线性 → Rec.709 亮度 → 再转回 0..255 的感知值），每张一行
import sharp from 'sharp';

// 你的星球（lumen-guild）四个展台在 1440×900 星球视图里的位置（作品 + 展台顶面）
const BOXES = [
  [345, 290, 110, 110],
  [555, 195, 100, 100],
  [785, 195, 100, 100],
  [985, 295, 110, 100],
];
const toLin = (c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const toSrgb = (y) => Math.round(255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055));

for (const file of process.argv.slice(2)) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const per = BOXES.map(([x0, y0, w, h]) => {
    let sum = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * info.width + x) * info.channels;
      sum += 0.2126 * toLin(data[i]) + 0.7152 * toLin(data[i + 1]) + 0.0722 * toLin(data[i + 2]);
    }
    return sum / (w * h);
  });
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  console.log(`${file}：平均 ${toSrgb(mean)}（线性 ${mean.toFixed(4)}）；四个展台 ${per.map((v) => toSrgb(v)).join(' / ')}`);
}

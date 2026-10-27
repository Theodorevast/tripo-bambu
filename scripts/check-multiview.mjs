// 验证「一个 canvas 分区画多个视口」：三个格子中心应分别是红、绿、蓝
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
const errors = watchErrors(page);
await page.goto(`${base}/dev/multiview.html`);
await page.waitForFunction(() => window.__mv !== undefined, null, { timeout: 15000 });
await page.waitForTimeout(500);
const backend = await page.evaluate(() => window.__mv.backend);
const { data, info } = await sharp(await page.screenshot()).raw().toBuffer({ resolveWithObject: true });
let ok = true;
for (const [id, channel] of Object.entries({ a: 0, b: 1, c: 2 })) {
  const box = await page.locator(`#${id}`).boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const i = (y * info.width + x) * info.channels;
  const rgb = [data[i], data[i + 1], data[i + 2]];
  const pass = rgb[channel] > 120 && rgb.every((v, k) => k === channel || v < 80);
  ok &&= pass;
  console.log(`${id}: rgb(${rgb.join(',')}) ${pass ? 'OK' : 'FAIL'}`);
}
console.log(`backend: ${backend}`);
if (errors.length) { ok = false; console.log(errors.join('\n')); }
console.log(ok ? 'MULTIVIEW OK' : 'MULTIVIEW FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

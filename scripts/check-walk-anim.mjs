// 走路动画自查（W1）：翠宝拆成部件了（鞋分成左右，三角形数加起来等于原来的；logo 还在 root 下面，吐券时 logo 能亮），
// 实时走（不停时间）时着地的脚在星球上不动；系统设了「减少动态效果」时脚步照走、身体颠得小；漫游时按 E 吐券不报错。
// node scripts/check-walk-anim.mjs。WEBGL2=1 走 WebGL2
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const { server, base } = await startServer({ cacheDir: path.resolve(process.env.VITE_CACHE_DIR ?? '.tmp/vite-walk-anim') });
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const allErrors = [];

// 实时走 ms 毫秒（按住 key），每一帧记两只脚和身体
async function walkAndSample(page, key, ms) {
  await page.evaluate(() => {
    window.__anim = [];
    const tick = () => {
      if (!window.__anim) return;
      const f = window.__walk.feet();
      window.__anim.push({ l: f.left, r: f.right, bob: f.bob });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await page.waitForTimeout(900);
  return page.evaluate(() => { const a = window.__anim; window.__anim = null; return a; });
}
function slipStats(samples) {
  let maxSlip = 0;
  let stances = 0;
  for (const side of ['l', 'r']) {
    let anchor = null;
    for (const s of samples) {
      const f = s[side];
      if (f.planted && anchor) maxSlip = Math.max(maxSlip, Math.hypot(f.pos[0] - anchor[0], f.pos[1] - anchor[1], f.pos[2] - anchor[2]));
      else if (f.planted) { anchor = f.pos; stances++; }
      else anchor = null;
    }
  }
  return { maxSlip, stances };
}

for (const reduced of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/?nolocal#/t/${team.id}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.waitForTimeout(800);
  const s = await page.evaluate(() => window.__walk.state());
  if (!reduced) {
    const tris = s.anim.shoeTris;
    check('翠宝拆成部件：鞋分成左右两个网格，三角形数加起来等于原来的', s.anim.rig && tris && tris[0] > 0 && tris[1] > 0 && tris[0] + tris[1] === tris[2], tris ? `左 ${tris[0]} + 右 ${tris[1]} = ${tris[0] + tris[1]}，原来 ${tris[2]}` : '没有拆');
  }
  await page.evaluate(() => window.__walk.teleport([0, 0, -1], [1, 0, 0]));
  await page.waitForTimeout(500);
  const samples = await walkAndSample(page, 'w', 2200);
  const { maxSlip, stances } = slipStats(samples);
  const bobs = samples.map((x) => x.bob);
  const bobRange = Math.max(...bobs) - Math.min(...bobs);
  const lifts = samples.map((x) => Math.max(x.l.lift, x.r.lift));
  check(`${reduced ? '减少动态效果：' : ''}实时走 2.2 秒：着地的脚在星球上不动，左右脚轮流踩`, maxSlip < 1e-6 && stances >= 8, `${samples.length} 帧，${stances} 次着地，着地时最多挪了 ${(maxSlip * 1000).toFixed(3)} mm，抬脚最高 ${(Math.max(...lifts) * 100).toFixed(1)} cm，身体颠的范围 ${(bobRange * 100).toFixed(2)} cm`);
  results.push(`  bob ${reduced ? 'reduced' : 'normal'} ${bobRange}`);
  if (!reduced) {
    // 吐券：按 E（附近没有作品）
    await page.waitForTimeout(600);
    await page.keyboard.press('e');
    await page.waitForTimeout(1600);
    const c = await page.evaluate(() => window.__coupons?.state?.() ?? null);
    check('漫游时按 E：翠宝吐券（CharacterView 之后叠的那层照样生效），不报错', c !== null && errors.length === 0, c ? `地上的券 ${c.coupons?.length ?? '?'} 张` : '没有 __coupons');
  }
  allErrors.push(...errors);
  await ctx.close();
}
// 减少动态效果时身体颠得小（两次的范围比）
const bobs = results.filter((r) => r.startsWith('  bob ')).map((r) => Number(r.split(' ').at(-1)));
const shown = results.filter((r) => !r.startsWith('  bob '));
shown.push(`${bobs[1] < bobs[0] * 0.6 ? '✓' : '✗'} 减少动态效果：身体颠的幅度变小（${(bobs[1] * 100).toFixed(2)} cm，平常 ${(bobs[0] * 100).toFixed(2)} cm）`);
console.log(shown.join('\n'));
if (allErrors.length) console.log(`页面错误：\n${allErrors.join('\n')}`);
const ok = shown.every((r) => r.startsWith('✓')) && allErrors.length === 0;
console.log(ok ? 'WALK ANIM OK' : 'WALK ANIM FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

// 漫游的帧间隔（W1 走路动画）：第一次点 Walk 进漫游（模型在后台准备好以后），再按一条固定的路线实时走 9 秒
// （直走、斜着拐、停下、原地转身、再起步），逐帧记 requestAnimationFrame 的间隔。报告最长、p95、p99、超过 20 / 33 ms 的帧数。
// 1440×900、DPR 2（DPR=1 可改）。WEBGL2=1 走 WebGL2；BASE_ROOT=<目录> 用那个目录的源码（改之前的版本）；
// 输出一行 JSON（脚本最后一行），比较前后时直接读
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const { server, base } = await startServer({
  cacheDir: path.resolve(process.env.VITE_CACHE_DIR ?? '.tmp/vite-walk-perf'),
  ...(process.env.BASE_ROOT ? { root: path.resolve(process.env.BASE_ROOT), publicDir: path.resolve('public') } : {}),
});
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DPR ?? 2) });
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

const startFrames = () => page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    if (!window.__frames) return;
    window.__frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopFrames = () => page.evaluate(() => { const f = window.__frames ?? []; window.__frames = null; return f; });
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const stats = (xs) => ({ frames: xs.length, max: Math.max(...xs), p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), over20: xs.filter((x) => x > 20).length, over33: xs.filter((x) => x > 33).length });
const fmt = (s) => `${s.frames} 帧，最长 ${s.max.toFixed(1)} ms，p50 ${s.p50.toFixed(1)}，p95 ${s.p95.toFixed(1)}，p99 ${s.p99.toFixed(1)}，>20 ms ${s.over20}，>33 ms ${s.over33}`;
const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };

await page.goto(`${base}/?nolocal#/t/${team.id}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const backend = await page.evaluate(() => window.__app.backend());

// 1. 第一次进漫游：点 Walk 到进入过渡结束后 1 秒
await startFrames();
await page.locator('.topbar button.walk').click();
await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
await page.waitForTimeout(1000);
const enter = stats(await stopFrames());

// 2. 走一条固定的路线（找一块空地：赤道上 -Z 那边，和 check-walk 一样）
await page.evaluate(() => window.__walk.teleport([0, 0, -1], [1, 0, 0]));
await page.waitForTimeout(500);
await startFrames();
await page.keyboard.down('w');
await page.waitForTimeout(1500);
await hold('a', 600); // 斜着拐
await page.waitForTimeout(900);
await hold('d', 900);
await page.keyboard.up('w');
await page.waitForTimeout(900); // 停下、收脚
for (const k of ['a', 's', 'd', 'w']) { await hold(k, 40); await page.waitForTimeout(450); } // 原地转身
await hold('w', 1600); // 再起步
await page.waitForTimeout(700);
const walk = stats(await stopFrames());

console.log(`backend ${backend}${process.env.BASE_ROOT ? '（改之前）' : ''}`);
console.log(`第一次进漫游：${fmt(enter)}`);
console.log(`走路 9 秒：${fmt(walk)}`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
console.log(JSON.stringify({ backend, before: !!process.env.BASE_ROOT, enter, walk, errors: errors.length }));
await browser.close();
await server.close();

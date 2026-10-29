// V5 样张：node scripts/shot-v5.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets）
// 1440×900，WebGPU（v5-webgl2 用 WebGL2）。用本机的私有真实模型（.tmp/local-models，没有就是占位作品）和翠宝（public/brand/triboo.glb）。
// 草、天空和云海换成正式实现（src/nature/）以后重跑一遍就是新的样张。
// 出：v5-walk、v5-planet、v5-close（像素比 2，证明作品不糊）、v5-sunset、v5-radius-15/30/60（同一取景、不同半径）、v5-webgl2、
//     v5-vs-ref（和参考图 F4、F2 并排：参考图只在本机，有 .tmp/refs/F/ 才拼）
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const out = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets';
mkdirSync(out, { recursive: true });
const team = 'lumen-guild';
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open({ webgl2 = false, dpr = 1, radius = null, sky = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  if (radius !== null) {
    await page.evaluate(async (r) => (await import('/src/planet/presets.ts')).setPlanetRadius(r), radius);
    await page.waitForTimeout(800);
  }
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  await page.waitForTimeout(1500);
  return { page, errors };
}

// 漫游：角色站在作品 workId 正面 dist 米处、往旁边偏 side 米，面朝作品
async function walkNear(page, workId, dist, side) {
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate(([id, d, sd]) => {
    const o = window.__walk.obstacles().find((x) => x.id === id) ?? window.__walk.obstacles()[0];
    const c = o.dir;
    const R = window.__walk.state().radius;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const north = norm([0, 1, 0].map((u, k) => u - c[k] * dot(c, [0, 1, 0])));
    const east = norm([c[1] * north[2] - c[2] * north[1], c[2] * north[0] - c[0] * north[2], c[0] * north[1] - c[1] * north[0]]);
    const a = (o.minAngle * R + d) / R;
    const p = norm(c.map((x, k) => x * Math.cos(a) - north[k] * Math.sin(a) + east[k] * (sd / R)));
    const h = norm(c.map((x, k) => x - p[k] * dot(p, c)));
    window.__walk.teleport(p, h);
  }, [workId, dist, side]);
  await page.waitForTimeout(1800);
}

// 轨道镜头贴近一件作品：从它正面斜上方 dist 米看它的中部
async function closeTo(page, workId, dist) {
  await page.evaluate(([id, d]) => {
    const w = window.__world;
    const e = w.planets.get('lumen-guild');
    const V = w.rig.camera.position.constructor;
    const p = e.team.planet.placements.find((x) => x.workId === id);
    const dir = new V(...p.dir).normalize();
    const ground = Math.max(e.planet.height(dir.x, dir.y, dir.z), e.planet.sea);
    const target = dir.clone().multiplyScalar(ground + 0.75).add(e.home);
    // 作品正面：展示方向在切平面上的投影（种子里的作品都朝它）
    const front = new V(0.139, -0.035, 0.99).addScaledVector(dir, -dir.dot(new V(0.139, -0.035, 0.99))).normalize();
    const pos = target.clone().addScaledVector(front, d).addScaledVector(dir, d * 0.35);
    w.rig.jump({ target, position: pos, minDistance: 0.5, maxDistance: 200, autoRotate: false });
  }, [workId, dist]);
  await page.waitForTimeout(1200);
}

async function shot(name, setup, opts = {}) {
  const { page, errors } = await open(opts);
  try {
    await setup(page);
    await page.screenshot({ path: path.join(out, name) });
    console.log(`✓ ${name}`);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log(`✗ ${name}: ${e.message}`);
  } finally {
    if (errors.length) problems.push(`${name} 页面错误：${errors.join(' | ')}`);
    await page.close();
  }
}

try {
  await shot('v5-planet.png', async () => {});
  await shot('v5-walk.png', (p) => walkNear(p, 'ph-02', 9, 2.2));
  await shot('v5-close.png', (p) => closeTo(p, 'ph-03', 2.4), { dpr: 2 });
  await shot('v5-sunset.png', (p) => walkNear(p, 'ph-11', 7, -2), { sky: 'sunset' });
  for (const r of [15, 30, 60]) await shot(`v5-radius-${r}.png`, async () => {}, { radius: r });
  await shot('v5-webgl2.png', (p) => walkNear(p, 'ph-02', 9, 2.2), { webgl2: true });
  // 和参考图并排：左边我们的，右边参考图（F4 漫游、F2 星球全景），各缩到 960 宽
  const refs = process.env.REFS ?? '.tmp/refs/F';
  if (existsSync(path.join(refs, '4.jpg')) && existsSync(path.join(refs, '2.jpg'))) {
    const cell = async (file, w, h) => sharp(file).resize({ width: w, height: h, fit: 'cover' }).toBuffer();
    const W = 960;
    const H = 600;
    await sharp({ create: { width: W * 2, height: H * 2, channels: 3, background: '#ffffff' } })
      .composite([
        { input: await cell(path.join(out, 'v5-walk.png'), W, H), left: 0, top: 0 },
        { input: await cell(path.join(refs, '4.jpg'), W, H), left: W, top: 0 },
        { input: await cell(path.join(out, 'v5-planet.png'), W, H), left: 0, top: H },
        { input: await cell(path.join(refs, '2.jpg'), W, H), left: W, top: H },
      ])
      .png()
      .toFile(path.join(out, 'v5-vs-ref.png'));
    console.log('✓ v5-vs-ref.png');
  } else {
    console.log('（本机没有 .tmp/refs/F，跳过 v5-vs-ref.png）');
  }
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

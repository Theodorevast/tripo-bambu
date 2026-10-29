// I1 样张（草、天空、生机接进来以后）：node scripts/shot-i1.mjs [输出目录] [--only a,b] [--webgl2]
// 1440×900，WebGPU（--webgl2 走 WebGL2）。用本机的私有真实模型（.tmp/local-models，没有就是占位）和翠宝（public/brand/triboo.glb）。
// 出：i1-walk（漫游，白天，朝着作品）、i1-walk-backlit（漫游，逆光）、i1-planet（星球视图）、i1-close（贴近作品，像素比 2）、
//     i1-sunset（日落漫游，朝着太阳）、i1-rain（下雨漫游）、i1-galaxy（星系全景，云海压在星球下面）、
//     i1-vs-ref（和参考图 F4、F2、F9 并排：参考图只在本机，REFS 或 .tmp/refs/F）
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : '.superpowers/sdd/2026-10-27-community-planets';
const only = opt('--only', null)?.split(',') ?? null;
const webgl2 = flag('--webgl2');
mkdirSync(out, { recursive: true });
const team = 'lumen-guild';
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open({ dpr = 1, sky = null, query = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/${query}#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  await page.waitForTimeout(1500);
  return { page, errors };
}

// 天气：雨、风（0..1）
async function weather(page, w) {
  await page.evaluate(async (ww) => Object.assign((await import('/src/scenes/world.ts')).WEATHER, ww), w);
}

// 漫游：角色站在作品 workId 正面 dist 米处、往旁边偏 side 米，面朝作品
async function walkNear(page, workId, dist, side, wait = 1800) {
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
  await page.waitForTimeout(wait);
}

// 漫游中原地转身：镜头朝太阳在切平面上的方向，再往左转 offsetDeg 度（太阳落在画面右边一点）。逆光时草尖透光
async function faceSun(page, offsetDeg, wait = 1500) {
  await page.evaluate((off) => {
    const s = window.__walk.state();
    const d = s.dir;
    const sun = window.__world.light.sunDir;
    const dot = sun.x * d[0] + sun.y * d[1] + sun.z * d[2];
    const t = [sun.x - d[0] * dot, sun.y - d[1] * dot, sun.z - d[2] * dot];
    const l = Math.hypot(...t);
    const f = t.map((v) => v / l);
    const side = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]]; // d × f：左手边
    const a = (off * Math.PI) / 180;
    window.__walk.teleport(d, f.map((v, k) => v * Math.cos(a) + side[k] * Math.sin(a)));
  }, offsetDeg);
  await page.waitForTimeout(wait);
}

// 漫游中往前走几秒（扬尘、踩出草痕）
async function stroll(page, ms) {
  await page.keyboard.down('w');
  await page.waitForTimeout(ms);
  await page.keyboard.up('w');
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
    const front = new V(0.139, -0.035, 0.99).addScaledVector(dir, -dir.dot(new V(0.139, -0.035, 0.99))).normalize();
    const pos = target.clone().addScaledVector(front, d).addScaledVector(dir, d * 0.35);
    w.rig.jump({ target, position: pos, minDistance: 0.5, maxDistance: 200, autoRotate: false });
  }, [workId, dist]);
  await page.waitForTimeout(1500);
}

async function shot(name, setup, opts = {}) {
  if (only && !only.includes(name.replace(/\.png$/, ''))) return;
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
  await shot('i1-planet.png', async () => {});
  await shot('i1-walk.png', (p) => walkNear(p, 'ph-02', 9, 2.2));
  await shot('i1-close.png', (p) => closeTo(p, 'ph-03', 2.4), { dpr: 2 });
  // 逆光漫游（对照 F4：太阳在画面右上方，草尖透光）
  await shot('i1-walk-backlit.png', async (p) => { await walkNear(p, 'ph-02', 9, 2.2, 800); await faceSun(p, 28); });
  // 日落：朝着太阳（对照 F9：太阳挂在云海上方）
  await shot('i1-sunset.png', async (p) => { await walkNear(p, 'ph-11', 7, -2, 800); await faceSun(p, 14, 2500); }, { sky: 'sunset' });
  await shot('i1-rain.png', async (p) => {
    await weather(p, { rain: 1, wind: 0.7 });
    await walkNear(p, 'ph-02', 9, 2.2, 600);
    await stroll(p, 1200);
    await p.waitForTimeout(5000);
  });
  await shot('i1-galaxy.png', async (p) => {
    await p.evaluate(() => { location.hash = '#/'; });
    await p.waitForFunction(() => window.__app.routeIdle() && location.hash === '#/', null, { timeout: 15000 });
    await p.waitForTimeout(2500);
  });
  // 和参考图并排：左边我们的，右边参考图（F4 漫游、F2 星球全景、F9 日落），各缩到 960 × 600
  const refs = process.env.REFS ?? '.tmp/refs/F';
  const pairs = [['i1-walk-backlit.png', '4.jpg'], ['i1-planet.png', '2.jpg'], ['i1-sunset.png', '9.jpg']];
  if (!only || only.includes('i1-vs-ref')) {
    if (pairs.every(([a, b]) => existsSync(path.join(out, a)) && existsSync(path.join(refs, b)))) {
      const cell = async (file, w, h) => sharp(file).resize({ width: w, height: h, fit: 'cover' }).toBuffer();
      const W = 960;
      const H = 600;
      const composite = [];
      for (let i = 0; i < pairs.length; i++) {
        composite.push({ input: await cell(path.join(out, pairs[i][0]), W, H), left: 0, top: H * i });
        composite.push({ input: await cell(path.join(refs, pairs[i][1]), W, H), left: W, top: H * i });
      }
      await sharp({ create: { width: W * 2, height: H * pairs.length, channels: 3, background: '#ffffff' } })
        .composite(composite)
        .png()
        .toFile(path.join(out, 'i1-vs-ref.png'));
      console.log('✓ i1-vs-ref.png');
    } else {
      console.log('（缺样张或参考图，跳过 i1-vs-ref.png）');
    }
  }
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

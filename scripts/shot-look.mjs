// look 角色的样张（调色、接触阴影、日落光束、镜头）：node scripts/shot-look.mjs [输出目录] [--prefix after-] [--query look=0] [--only a,b] [--webgl2]
// 1440×900，WebGPU（--webgl2 走 WebGL2）。用本机的私有真实模型（.tmp/local-models）和翠宝（.tmp/triboo），没有就是占位。
// 出：walk（漫游，白天，朝着城堡）、walk-backlit（漫游，逆光）、sunset（日落漫游，朝着太阳）、planet（星球视图）、
//     galaxy（星系全景）、close（贴近作品，像素比 2：看贴图清不清楚）。
// --query 加在地址上（例如 look=0 关掉后处理拍对照组）；--prefix 加在文件名前面
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : '.superpowers/sdd/2026-10-27-community-planets/team/look-shots';
const only = opt('--only', null)?.split(',') ?? null;
const prefix = opt('--prefix', '');
const query = opt('--query', '');
const webgl2 = flag('--webgl2');
mkdirSync(out, { recursive: true });
const team = 'lumen-guild';
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open({ dpr = 1, sky = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/${query ? `?${query}` : ''}#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  await page.waitForTimeout(1500);
  return { page, errors };
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

// 漫游中原地转身：镜头朝太阳在切平面上的方向，再往左转 offsetDeg 度
async function faceSun(page, offsetDeg, wait = 1500) {
  await page.evaluate((off) => {
    const s = window.__walk.state();
    const d = s.dir;
    const sun = window.__world.light.sunDir;
    const dot = sun.x * d[0] + sun.y * d[1] + sun.z * d[2];
    const t = [sun.x - d[0] * dot, sun.y - d[1] * dot, sun.z - d[2] * dot];
    const l = Math.hypot(...t);
    const f = t.map((v) => v / l);
    const side = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]];
    const a = (off * Math.PI) / 180;
    window.__walk.teleport(d, f.map((v, k) => v * Math.cos(a) + side[k] * Math.sin(a)));
  }, offsetDeg);
  await page.waitForTimeout(wait);
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
  if (only && !only.includes(name)) return;
  const { page, errors } = await open(opts);
  try {
    await setup(page);
    await page.screenshot({ path: path.join(out, `${prefix}${name}.png`) });
    console.log(`✓ ${prefix}${name}.png`);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log(`✗ ${name}: ${e.message}`);
  } finally {
    if (errors.length) problems.push(`${name} 页面错误：${errors.join(' | ')}`);
    await page.close();
  }
}

try {
  await shot('planet', async () => {});
  await shot('walk', (p) => walkNear(p, 'ph-02', 9, 2.2));
  await shot('walk-backlit', async (p) => { await walkNear(p, 'ph-02', 9, 2.2, 800); await faceSun(p, 28); });
  await shot('sunset', async (p) => { await walkNear(p, 'ph-11', 7, -2, 800); await faceSun(p, 14, 2500); }, { sky: 'sunset' });
  await shot('sunset-planet', async (p) => { await p.waitForTimeout(1500); }, { sky: 'sunset' });
  await shot('close', (p) => closeTo(p, 'ph-03', 2.4), { dpr: 2 });
  await shot('galaxy', async (p) => {
    await p.evaluate(() => { location.hash = '#/'; });
    await p.waitForFunction(() => window.__app.routeIdle() && location.hash === '#/', null, { timeout: 15000 });
    await p.waitForTimeout(2500);
  });
} finally {
  await browser.close();
  await server.close();
  if (problems.length) {
    console.log(`问题：\n${problems.join('\n')}`);
    process.exitCode = 1;
  }
}

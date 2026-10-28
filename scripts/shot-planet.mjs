// 星球外观（planet 角色）的样张：node scripts/shot-planet.mjs <前缀> [输出目录] [--only a,b] [--webgl2] [--sky sunset]
// 1440×900、像素比 1（close 那张像素比 2），WebGPU（--webgl2 走 WebGL2）。用本机的私有真实模型（.tmp/local-models），没有就是占位。
// 出：<前缀>-galaxy（星系全景，停住自转）、<前缀>-galaxy-near（镜头凑近几颗星球）、<前缀>-planet（你的星球，星球视图）、
//     <前缀>-planet-coral / -glacier / -desert（别的预设的星球视图）、<前缀>-ground（漫游，朝作品）、<前缀>-ground-rim（漫游，站在外沿看出去）
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const valued = new Set(['--only', '--sky']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const prefix = positional[0] ?? 'planet';
const out = positional[1] ?? '.superpowers/sdd/2026-10-27-community-planets/team';
const only = opt('--only', null)?.split(',') ?? null;
const webgl2 = flag('--webgl2');
const sky = opt('--sky', null);
mkdirSync(out, { recursive: true });
const you = 'lumen-guild';
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open(hash, { dpr = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/${hash}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__app.routeIdle(), null, { timeout: 60000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  return { page, errors };
}

async function planetView(page, team) {
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForTimeout(2500);
}

// 漫游：角色站在作品正面 dist 米处、往旁边偏 side 米，面朝作品（同 shot-i1）
async function walkNear(page, dist, side, wait = 1800) {
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate(([d, sd]) => {
    const o = window.__walk.obstacles()[1] ?? window.__walk.obstacles()[0];
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
  }, [dist, side]);
  await page.waitForTimeout(wait);
}

// 漫游：站在方向 dir（星球本地）上，面朝 heading（切平面里的方向）
async function walkAt(page, dir, heading, wait = 2000) {
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate(([d, h]) => {
    const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const p = norm(d);
    const dt = h[0] * p[0] + h[1] * p[1] + h[2] * p[2];
    window.__walk.teleport(p, norm(h.map((x, k) => x - p[k] * dt)));
  }, [dir, heading]);
  await page.waitForTimeout(wait);
}

async function shot(name, hash, setup, opts = {}) {
  const key = name.replace(/\.png$/, '');
  if (only && !only.includes(key)) return;
  const file = `${prefix}-${key}.png`;
  let page;
  let errors = [];
  try {
    ({ page, errors } = await open(hash, opts));
    await setup(page);
    await page.screenshot({ path: path.join(out, file) });
    console.log(`✓ ${file}`);
  } catch (e) {
    problems.push(`${file}: ${e.message}`);
    console.log(`✗ ${file}: ${e.message}`);
  } finally {
    if (errors.length) problems.push(`${file} 页面错误：${errors.join(' | ')}`);
    await page?.close();
  }
}

// 星系：停住自转再拍（不然每次拍到的角度不一样）
const stopSpin = (page) => page.evaluate(() => { window.__world.rig.controls.autoRotate = false; });

try {
  await shot('galaxy', '#/', async (p) => { await p.waitForTimeout(3200); await stopSpin(p); await p.waitForTimeout(600); });
  // 凑近：镜头放在第 i 颗星球斜上方，看它和它身后的几颗
  await shot('galaxy-near', '#/', async (p) => {
    await p.waitForTimeout(3000);
    await stopSpin(p);
    await p.evaluate(() => {
      const w = window.__world;
      const e = [...w.planets.values()][3];
      const V = w.rig.camera.position.constructor;
      const R = e.planet.radius;
      const target = e.home.clone().add(new V(-R * 2.5, 0, -R * 4));
      const pos = e.home.clone().add(new V(R * 2.2, R * 2.4, R * 5.5));
      w.rig.jump({ target, position: pos, minDistance: 1, maxDistance: 1e5, autoRotate: false });
    });
    await p.waitForTimeout(1500);
  });
  await shot('planet', `#/t/${you}`, (p) => planetView(p, you));
  await shot('planet-coral', '#/t/moss-and-mesh', (p) => planetView(p, 'moss-and-mesh'));
  await shot('planet-glacier', '#/t/quiet-vertex', (p) => planetView(p, 'quiet-vertex'));
  await shot('planet-desert', '#/t/kiln-collective', (p) => planetView(p, 'kiln-collective'));
  await shot('ground', `#/t/${you}`, async (p) => { await planetView(p, you); await walkNear(p, 9, 2.2); });
  // 外沿：站在展示方向偏下（纬度约 12°）的地方，朝外看
  await shot('ground-rim', `#/t/${you}`, async (p) => {
    await planetView(p, you);
    await walkAt(p, [0.1, 0.24, 0.96], [0.2, -0.35, 0.9]);
  });
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

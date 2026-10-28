// 水面样张：node scripts/shot-water.mjs [输出目录] [--team id] [--only a,b] [--webgl2] [--sky sunset]
// 1440×900，WebGPU（--webgl2 走 WebGL2）。在星球上找最大的水塘（按高度函数扫一遍），从远处和贴着水边各拍几张：
//   water-planet（星球视图）、water-orbit（轨道镜头斜看水塘，约 9 米外）、water-low（轨道镜头贴着水面看过去，太阳在对面：看反光和闪光）、
//   water-walk（漫游：翠宝站在岸边、面朝水塘）、water-wade（翠宝走进水里）、water-galaxy（星系全景）
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : '.tmp/water/shots';
const only = opt('--only', null)?.split(',') ?? null;
const webgl2 = flag('--webgl2');
const team = opt('--team', 'moss-and-mesh');
const sky = opt('--sky', null);
const dpr = Number(opt('--dpr', 1));
mkdirSync(out, { recursive: true });
const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  await page.waitForTimeout(sky ? 2600 : 1200);
  return { page, errors };
}

// 在页面里找最大的水塘：等距柱状网格（0.5°）上取高度，低于水面的格子按四邻接连成块，取面积最大的一块。
// 返回水塘中心方向（单位向量，星球本地）、等效半径（米）、最深处（米）
const findPond = (page) => page.evaluate((t) => {
  const e = window.__world.planets.get(t);
  const p = e.planet;
  if (!(p.sea > 0)) return null;
  const W = 720;
  const H = 360;
  const wet = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const x = Math.cos(lat) * Math.cos(lon);
      const y = Math.sin(lat);
      const z = Math.cos(lat) * Math.sin(lon);
      wet[j * W + i] = Math.max(0, p.sea - p.height(x, y, z));
    }
  }
  const seen = new Uint8Array(W * H);
  let best = null;
  for (let k = 0; k < W * H; k++) {
    if (!(wet[k] > 0) || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let area = 0;
    let deep = 0;
    const c = [0, 0, 0];
    while (stack.length) {
      const q = stack.pop();
      const i = q % W;
      const j = (q - i) / W;
      const lat = ((j + 0.5) / H - 0.5) * Math.PI;
      const lon = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const a = Math.cos(lat);
      area += a;
      deep = Math.max(deep, wet[q]);
      c[0] += a * Math.cos(lat) * Math.cos(lon);
      c[1] += a * Math.sin(lat);
      c[2] += a * Math.cos(lat) * Math.sin(lon);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = (i + di + W) % W;
        const nj = j + dj;
        if (nj < 0 || nj >= H) continue;
        const nk = nj * W + ni;
        if (wet[nk] > 0 && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    if (!best || area > best.area) best = { area, deep, c };
  }
  if (!best) return null;
  const l = Math.hypot(...best.c);
  const R = p.radius;
  const cell = (2 * Math.PI / W) * (Math.PI / H) * R * R; // 赤道处一个格子的面积（乘过 cos 纬度了）
  return { dir: best.c.map((v) => v / l), radius: Math.sqrt((best.area * cell) / Math.PI), deep: best.deep, sea: p.sea };
}, team);

// 切平面基底：dir 处的「北」和「东」
function basis(d) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const north = norm([0, 1, 0].map((u, k) => u - d[k] * dot(d, [0, 1, 0])));
  const east = norm([d[1] * north[2] - d[2] * north[1], d[2] * north[0] - d[0] * north[2], d[0] * north[1] - d[1] * north[0]]);
  return { north, east };
}

// 镜头看水塘：从水塘中心沿 heading（切平面里的单位向量）退 dist 米、抬高 up 米，看着水面中心。
// 用 rig.drive 接管镜头（和漫游一样）：镜头的「上」是水塘处的球面法线，水塘在星球侧面时画面也是正的，天空、云海跟着这个「上」
async function orbitAt(page, pond, dist, up, heading) {
  await page.evaluate(([t, pd, d, u, h]) => {
    const w = window.__world;
    const e = w.planets.get(t);
    const cam = w.rig.camera;
    const V = cam.position.constructor;
    const dir = new V(...pd.dir);
    const target = dir.clone().multiplyScalar(pd.sea).add(e.home);
    const pos = target.clone().addScaledVector(new V(...h), -d).addScaledVector(dir, u);
    w.rig.drive = () => {
      cam.position.copy(pos);
      cam.up.copy(dir);
      cam.lookAt(target);
    };
  }, [team, pond, dist, up, heading]);
  await page.waitForTimeout(1500);
}

// 太阳在切平面里的方向（单位向量）
const sunHeading = (page, d) => page.evaluate((dir) => {
  const s = window.__world.light.sunDir;
  const dot = s.x * dir[0] + s.y * dir[1] + s.z * dir[2];
  const t = [s.x - dir[0] * dot, s.y - dir[1] * dot, s.z - dir[2] * dot];
  const l = Math.hypot(...t);
  return t.map((v) => v / l);
}, d);

// 漫游：角色站在水塘中心沿 -heading 方向 back 米处（负数就是走进水里），面朝 heading
async function walkAt(page, pond, back, heading, wait = 2200) {
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate(([pd, b, h]) => {
    const R = window.__walk.state().radius;
    const a = b / R;
    const p = pd.dir.map((x, k) => x * Math.cos(a) - h[k] * Math.sin(a));
    const l = Math.hypot(...p);
    window.__walk.teleport(p.map((x) => x / l), h);
  }, [pond, back, heading]);
  await page.waitForTimeout(wait);
}

async function shot(name, setup) {
  if (only && !only.includes(name)) return;
  const { page, errors } = await open();
  try {
    const pond = await findPond(page);
    if (!pond && name !== 'water-planet' && name !== 'water-galaxy') throw new Error('这颗星球上没有水');
    if (pond && name === 'water-planet') {
      const backend = await page.evaluate(() => window.__app.backend());
      console.log(`  ${backend}；水塘：等效半径 ${pond.radius.toFixed(1)} 米，最深 ${pond.deep.toFixed(2)} 米，方向 ${pond.dir.map((v) => v.toFixed(3)).join(', ')}`);
    }
    await setup(page, pond);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
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
  await shot('water-planet', async () => {});
  await shot('water-orbit', async (page, pond) => {
    const sun = await sunHeading(page, pond.dir);
    // 顺光斜看：太阳在镜头背后偏一点，水色和浪花看得清
    const { east } = basis(pond.dir);
    const h = sun.map((v, k) => -v * 0.8 + east[k] * 0.6);
    const l = Math.hypot(...h);
    await orbitAt(page, pond, Math.max(6, pond.radius * 2.2), Math.max(3.5, pond.radius * 1.2), h.map((v) => v / l));
  });
  await shot('water-low', async (page, pond) => {
    // 逆光贴着水面：太阳在水塘对面，看天空的反光和闪光
    const sun = await sunHeading(page, pond.dir);
    await orbitAt(page, pond, Math.max(4, pond.radius * 1.6), 1.1, sun);
  });
  await shot('water-walk', async (page, pond) => {
    const sun = await sunHeading(page, pond.dir);
    const { east } = basis(pond.dir);
    const h = sun.map((v, k) => v * 0.7 + east[k] * 0.7);
    const l = Math.hypot(...h);
    await walkAt(page, pond, pond.radius + 1.6, h.map((v) => v / l));
  });
  await shot('water-wade', async (page, pond) => {
    const sun = await sunHeading(page, pond.dir);
    const { east } = basis(pond.dir);
    const h = sun.map((v, k) => v * 0.5 + east[k] * 0.85);
    const l = Math.hypot(...h);
    await walkAt(page, pond, pond.radius * 0.25, h.map((v) => v / l), 1200);
    await page.keyboard.down('w');
    await page.waitForTimeout(700);
    await page.keyboard.up('w');
    await page.waitForTimeout(500);
  });
  await shot('water-galaxy', async (page) => {
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForFunction(() => window.__app.routeIdle() && location.hash === '#/', null, { timeout: 15000 });
    await page.waitForTimeout(2500);
  });
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

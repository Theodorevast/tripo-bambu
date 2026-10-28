// 水面的 GPU 开销：node scripts/perf-water.mjs [--team id] [--webgl2] [--dpr 2] [--frames 180]
// 1440×900、像素比 2（画布 2880×1800）。同一个镜头下把水面开着、关着各量一遍（交替量两轮取中位数），差值就是水面的开销：
//   星球视图（默认镜头）、贴近水塘（轨道镜头 6 米外斜看，水面占大半个画面：最坏情况）、涉水（漫游，角色站在水里）。
// GPU 时间用渲染器的时间戳查询（地址带 ?gputime，同 perf-gpu.mjs）
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const dpr = Number(opt('--dpr', 2));
const frames = Number(opt('--frames', 180));
const team = opt('--team', 'moss-and-mesh');

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));

// 量 n 帧的 GPU 时间（中位数，毫秒）
const measure = (n) => page.evaluate(async (count) => {
  const w = window.__world;
  const gpu = [];
  let pending = 0;
  await new Promise((resolve) => {
    let seen = 0;
    const after = () => {
      seen++;
      if (seen > 5) {
        pending++;
        w.renderer.resolveTimestampsAsync('render').then((ms) => { pending--; if (typeof ms === 'number' && ms > 0) gpu.push(ms); }, () => { pending--; });
      }
      if (seen >= count + 5) {
        w.renderHooks.delete(after);
        resolve();
      }
    };
    w.renderHooks.add(after);
  });
  for (let i = 0; i < 100 && pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
  gpu.sort((a, b) => a - b);
  return gpu.length ? gpu[Math.floor(gpu.length / 2)] : NaN;
}, n);

const setWater = (on) => page.evaluate((v) => { window.__world.scene.traverse((o) => { if (o.name === 'water') o.visible = v; }); }, on);

// 水开、关交替各量两轮，取每种的中位数
async function compare(label) {
  const on = [];
  const off = [];
  for (let k = 0; k < 2; k++) {
    await setWater(true);
    await page.waitForTimeout(300);
    on.push(await measure(frames));
    await setWater(false);
    await page.waitForTimeout(300);
    off.push(await measure(frames));
  }
  await setWater(true);
  const m = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const a = Math.min(...on);
  const b = Math.min(...off);
  console.log(`${label}：整帧 GPU ${a.toFixed(2)} ms（水面关掉 ${b.toFixed(2)} ms）→ 水面 ${(a - b).toFixed(2)} ms；两轮 开 ${on.map((x) => x.toFixed(2)).join(' / ')}，关 ${off.map((x) => x.toFixed(2)).join(' / ')}`);
  void m;
}

try {
  await page.goto(`${base}/?gputime&nolocal#/t/${team}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  const backend = await page.evaluate(() => window.__app.backend());
  await page.waitForTimeout(2000);
  // 最大的水塘（同 shot-water.mjs，网格粗一点）
  const pond = await page.evaluate((t) => {
    const e = window.__world.planets.get(t);
    const p = e.planet;
    let best = null;
    for (let j = 0; j < 180; j++) {
      const lat = ((j + 0.5) / 180 - 0.5) * Math.PI;
      for (let i = 0; i < 360; i++) {
        const lon = ((i + 0.5) / 360 - 0.5) * 2 * Math.PI;
        const d = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
        const depth = p.sea - p.height(...d);
        if (!best || depth > best.depth) best = { depth, dir: d };
      }
    }
    const tris = e.planet.group.getObjectByName('water')?.geometry.index.count / 3;
    return { ...best, sea: p.sea, tris };
  }, team);
  console.log(`backend ${backend}，像素比 ${dpr}，团队 ${team}；聚焦星球的水面 ${pond.tris} 个三角形`);
  await compare('星球视图');
  // 贴近水塘：镜头接管（同 shot-water.mjs 的 orbitAt），离最深处 6 米、高 3 米斜看
  await page.evaluate(([t, pd]) => {
    const w = window.__world;
    const e = w.planets.get(t);
    const cam = w.rig.camera;
    const V = cam.position.constructor;
    const dir = new V(...pd.dir);
    const target = dir.clone().multiplyScalar(pd.sea).add(e.home);
    const side = new V(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const pos = target.clone().addScaledVector(side, -6).addScaledVector(dir, 3);
    w.rig.drive = () => { cam.position.copy(pos); cam.up.copy(dir); cam.lookAt(target); };
  }, [team, pond]);
  await page.waitForTimeout(1500);
  await compare('贴近水塘（水面占大半个画面）');
  await page.evaluate(() => { window.__world.rig.drive = null; });
  // 涉水：漫游，角色站在最深处
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.evaluate((pd) => {
    const d = pd.dir;
    const h = [0, 1, 0].map((u, k) => u - d[k] * d[1]);
    const l = Math.hypot(...h);
    window.__walk.teleport(d, h.map((v) => v / l));
  }, pond);
  await page.waitForTimeout(2000);
  await compare('涉水（漫游，角色在水里）');
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  await browser.close();
  await server.close();
}

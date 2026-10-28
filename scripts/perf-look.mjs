// look 的 GPU 开销（成对对比）：1440×900、像素比 2，同一个场景分别量「后处理开」和「?look=0」，差值就是后处理占的 GPU 时间。
// 场景：星球视图（白天）、漫游（白天）、日落漫游朝着太阳（光束在画）、星系全景。
// 用法：node scripts/perf-look.mjs [--webgl2] [--local] [--frames 180] [--only planet,sunset] [--repeat 2]
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const webgl2 = args.includes('--webgl2');
const local = args.includes('--local');
const frames = Number(opt('--frames', 180));
const only = opt('--only', null)?.split(',') ?? null;
const repeat = Number(opt('--repeat', 1));
const team = 'lumen-guild';

const { server, base } = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features'] });

// 量 n 帧的 GPU 时间（和 perf-gpu.mjs 一样：每帧画完发起一次时间戳回读）
const measure = (page, n) => page.evaluate(async (count) => {
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
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
  return { p50: pct(gpu, 0.5), p95: pct(gpu, 0.95), n: gpu.length, calls: w.renderer.info.render.drawCalls };
}, n);

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
  await page.waitForTimeout(1500);
}

async function faceSun(page, off) {
  await page.evaluate((o) => {
    const d = window.__walk.state().dir;
    const sun = window.__world.light.sunDir;
    const dt = sun.x * d[0] + sun.y * d[1] + sun.z * d[2];
    const t = [sun.x - d[0] * dt, sun.y - d[1] * dt, sun.z - d[2] * dt];
    const l = Math.hypot(...t);
    const f = t.map((v) => v / l);
    const side = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]];
    const a = (o * Math.PI) / 180;
    window.__walk.teleport(d, f.map((v, k) => v * Math.cos(a) + side[k] * Math.sin(a)));
  }, off);
  await page.waitForTimeout(2500);
}

const scenes = {
  planet: async () => {},
  walk: (page) => walkNear(page, 'ph-02', 9, 2.2),
  sunset: async (page) => {
    await page.evaluate(() => window.__world.setSkyPreset('sunset'));
    await page.waitForTimeout(2500);
    await walkNear(page, 'ph-11', 7, -2);
    await faceSun(page, 14);
  },
  galaxy: async (page) => {
    await page.evaluate(() => { location.hash = '#/'; });
    await page.waitForFunction(() => window.__app.routeIdle() && location.hash === '#/', null, { timeout: 15000 });
    await page.waitForTimeout(2500);
  },
};

async function run(scene, look) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  try {
    const q = ['gputime', local ? '' : 'nolocal', look ? '' : 'look=0'].filter(Boolean).join('&');
    await page.goto(`${base}/?${q}#/t/${team}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team, { timeout: 120000 });
    await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await scenes[scene](page);
    const r = await measure(page, frames);
    if (errors.length) console.log(`  页面错误：${errors.join(' | ')}`);
    return r;
  } finally {
    await page.close();
  }
}

try {
  const backend = webgl2 ? 'webgl2' : 'webgpu';
  console.log(`backend ${backend}，像素比 2（画布 2880×1800），${local ? '本机真实模型' : '占位作品'}，每组 ${frames} 帧`);
  for (const scene of Object.keys(scenes)) {
    if (only && !only.includes(scene)) continue;
    for (let k = 0; k < repeat; k++) {
    const on = await run(scene, true);
    const off = await run(scene, false);
    const d50 = on.p50 - off.p50;
    console.log(`${scene}：后处理开 p50 ${on.p50.toFixed(2)} / p95 ${on.p95.toFixed(2)} ms（${on.calls} 次绘制）；?look=0 p50 ${off.p50.toFixed(2)} / p95 ${off.p95.toFixed(2)} ms（${off.calls} 次绘制）；差 p50 ${d50 >= 0 ? '+' : ''}${d50.toFixed(2)} ms`);
    }
  }
} catch (e) {
  console.log(`没量完：${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

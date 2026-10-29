// 第二版 [v2-world] 的样张：五个预设的星球近景、首页正面 / 侧面（天体仪环、星座线）、星座翠宝、烫金券卡。
// node scripts/shot-world-v2.mjs <输出目录> [--only a,b] [--webgl2] [--size 390x844] [--dpr 2] [--tag 前缀] [--sky sunset]
// 默认 1440×900、像素比 1。用一个开发服务器，每张图开一页（互不影响）。VITE_CACHE_DIR 指向自己的依赖缓存
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const valued = new Set(['--only', '--size', '--dpr', '--tag', '--sky']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const out = positional[0] ?? '.superpowers/sdd/2026-10-30-v2/world-media';
const only = opt('--only', null)?.split(',') ?? null;
const webgl2 = flag('--webgl2');
const [W, H] = opt('--size', '1440x900').split('x').map(Number);
const dpr = Number(opt('--dpr', '1'));
const sky = opt('--sky', null);
const tag = opt('--tag', `${W}x${H}${webgl2 ? '-gl2' : ''}`);
mkdirSync(out, { recursive: true });

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open(hash) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/?nolocal${hash}`);
  await page.waitForFunction(() => window.__ready === true && window.__app.routeIdle() && !document.querySelector('#boot'), null, { timeout: 90000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  return { ctx, page, errors };
}

const planetReady = (page, team) => page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t && window.__app.routeIdle(), team, { timeout: 120000 });
const stopSpin = (page) => page.evaluate(() => { window.__world.rig.controls.autoRotate = false; });

async function shot(key, hash, setup) {
  if (only && !only.includes(key)) return;
  const file = `${key}-${tag}.png`;
  let ctx;
  let errors = [];
  try {
    let page;
    ({ ctx, page, errors } = await open(hash));
    await setup(page);
    await page.screenshot({ path: path.join(out, file) });
    console.log(`✓ ${file}`);
  } catch (e) {
    problems.push(`${file}: ${e.message.split('\n')[0]}`);
    console.log(`✗ ${file}: ${e.message.split('\n')[0]}`);
  } finally {
    if (errors.length) problems.push(`${file} 页面错误：${errors.join(' | ')}`);
    await ctx?.close();
  }
}

// 五个预设：各挑一颗有作品的星球（seed.json）
const PRESET_TEAMS = [
  ['verdant', 'lumen-guild'],
  ['glacier', 'quiet-vertex'],
  ['desert', 'kiln-collective'],
  ['coral', 'moss-and-mesh'],
  ['volcanic', 'ember-forge'],
];

try {
  for (const [preset, team] of PRESET_TEAMS) {
    await shot(`planet-${preset}`, `#/t/${team}`, async (p) => {
      await planetReady(p, team);
      await p.waitForTimeout(2800);
    });
  }
  // 凑近一件作品（看石座和那一圈金线）：镜头在作品斜前上方几米
  await shot('plinth', '#/t/lumen-guild', async (p) => {
    await planetReady(p, 'lumen-guild');
    await p.waitForTimeout(1500);
    await p.evaluate(() => {
      const w = window.__world;
      const pv = [...window.__app.placedIds()];
      const view = window.__planetView ?? null;
      void view;
      void pv;
      const e = w.focused;
      const works = e.planet.works.children;
      const root = works[1] ?? works[0];
      const at = root.getWorldPosition(w.rig.camera.position.clone());
      const up = at.clone().sub(e.home).normalize();
      const side = new (at.constructor)(0, 1, 0).cross(up).normalize();
      const pos = at.clone().addScaledVector(up, 3.2).addScaledVector(side, 3.6).addScaledVector(up.clone().cross(side).normalize(), 2.2);
      w.rig.jump({ target: at.clone().addScaledVector(up, 0.6), position: pos, minDistance: 0.5, maxDistance: 1e5, autoRotate: false });
    });
    await p.waitForTimeout(1800);
  });
  // 中古点缀：镜头凑到星球上一样点缀（kind：tower / arch / lamp / menhir）旁边
  for (const kind of ['tower', 'arch', 'lamp']) {
    await shot(`props-${kind}`, '#/t/lumen-guild', async (p) => {
      await planetReady(p, 'lumen-guild');
      await p.waitForTimeout(1200);
      await p.evaluate((k) => {
        const w = window.__world;
        const e = w.focused;
        const it = window.__v2world.props().find((x) => x.kind === k) ?? window.__v2world.props()[0];
        if (!it) return;
        const V = w.rig.camera.position.constructor;
        const d = new V(...it.dir).normalize();
        const at = d.clone().multiplyScalar(e.planet.radius).add(e.home);
        const side = new V(0, 1, 0).cross(d).normalize();
        const fwd = d.clone().cross(side).normalize();
        const pos = at.clone().addScaledVector(d, 2.4).addScaledVector(side, 5.5).addScaledVector(fwd, 3);
        w.rig.jump({ target: at.clone().addScaledVector(d, 1.2), position: pos, minDistance: 0.5, maxDistance: 1e5, autoRotate: false });
      }, kind);
      await p.waitForTimeout(1800);
    });
  }
  // 首页正面：开场放完、停住自转
  await shot('home-front', '#/', async (p) => {
    await p.waitForTimeout(4200);
    await stopSpin(p);
    await p.waitForTimeout(800);
  });
  // 首页侧面：绕着看的点转 70°、压低一点（天体仪环从侧面看是一圈圈椭圆）
  await shot('home-side', '#/', async (p) => {
    await p.waitForTimeout(4200);
    await stopSpin(p);
    await p.evaluate(() => {
      const w = window.__world;
      const c = w.rig.controls;
      const t = c.target.clone();
      const off = w.rig.camera.position.clone().sub(t);
      const r = off.length();
      const az = Math.atan2(off.x, off.z) + 1.2;
      const el = 0.2;
      const pos = t.clone().set(t.x + Math.sin(az) * Math.cos(el) * r, t.y + Math.sin(el) * r, t.z + Math.cos(az) * Math.cos(el) * r);
      w.rig.jump({ target: t, position: pos, minDistance: 1, maxDistance: 1e6, autoRotate: false });
    });
    await p.waitForTimeout(1200);
  });
  // 首页凑近你的星球（看天体仪环的刻度）
  await shot('home-you', '#/', async (p) => {
    await p.waitForTimeout(4200);
    await stopSpin(p);
    await p.evaluate(() => {
      const w = window.__world;
      const e = w.planets.get('lumen-guild');
      const R = e.planet.radius * e.planet.group.scale.x;
      const V = w.rig.camera.position.constructor;
      const target = e.home.clone();
      const pos = e.home.clone().add(new V(R * 1.6, R * 1.3, R * 5.2));
      w.rig.jump({ target, position: pos, minDistance: 1, maxDistance: 1e6, autoRotate: false });
    });
    await p.waitForTimeout(1200);
  });
  // 星座翠宝：开场以后等它亮起来（__v2world.constellation 可以直接叫它出来）
  await shot('constellation', '#/', async (p) => {
    await p.waitForTimeout(4200);
    await stopSpin(p);
    await p.evaluate(() => window.__v2world?.showConstellation?.());
    await p.waitForFunction(() => window.__v2world?.constellationState?.()?.phase === 'show', null, { timeout: 30000 });
    await p.waitForTimeout(600);
  });
  // 烫金券卡：首页右下角的翠宝吐一张券（等卡片飞出来、停住）
  await shot('card', '#/', async (p) => {
    await p.waitForTimeout(4500);
    await stopSpin(p);
    await p.evaluate(() => window.__v2world?.showCard?.());
    await p.waitForTimeout(2600);
  });
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

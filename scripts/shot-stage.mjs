// stage 角色的样张：node scripts/shot-stage.mjs [输出目录] [--only a,b] [--webgl2]
// 1440×900，WebGPU（--webgl2 走 WebGL2）。用本机的私有真实模型（.tmp/local-models）和翠宝（.tmp/triboo），没有就是占位。
// 出：stage-overview（星球视图，作品当地标）、stage-close（贴近一件作品：展台、花园、路牌，像素比 2）、
//     stage-garden（斜后方看一件作品的小花园）、stage-walk（漫游时路过作品）、
//     stage-drop-1..4（编辑器里摆一件作品：落下、扬尘、花草长出来，按时间顺序）
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : '.superpowers/sdd/2026-10-27-community-planets/team/stage-shots';
const only = opt('--only', null)?.split(',') ?? null;
const webgl2 = flag('--webgl2');
const nolocal = flag('--nolocal'); // 用仓库里的占位作品（主目录没有私有模型时看到的样子）
const suffix = (webgl2 ? '-webgl2' : '') + (nolocal ? '-placeholder' : '');
mkdirSync(out, { recursive: true });
const team = 'lumen-guild';
// 自己的 Vite 依赖缓存：主目录的 node_modules/.vite 是各个 worktree 共用的（node_modules 是链接），
// 用共用的那份，这边重新预构建依赖会让别的开发服务器（包括用户正在看的 5173）报 Outdated Optimize Dep、整页刷新
const { server, base } = await startServer({ cacheDir: '.tmp/vite-stage' });
const browser = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADED !== '1', args: ['--ignore-gpu-blocklist'] });
const problems = [];

async function open({ dpr = 1, query = nolocal ? '?nolocal' : '', at = team, sky = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
  const errors = watchErrors(page);
  if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  await page.goto(`${base}/${query}#/t/${at}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, at, { timeout: 120000 });
  if (sky) await page.evaluate((s) => window.__world.setSkyPreset(s), sky);
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(2200);
  return { page, errors };
}

// 轨道镜头看一件作品：从它正面（front 度：0 正面，90 左侧，180 背后）、离作品中心 dist 米、仰角 elev 度看它中部
async function lookAt(page, workId, dist, front = 0, elev = 20, aimY = 0.75) {
  await page.evaluate(([id, d, f, el, ay]) => {
    const w = window.__world;
    const e = w.planets.get('lumen-guild');
    const V = w.rig.camera.position.constructor;
    const p = e.team.planet.placements.find((x) => x.workId === id);
    const dir = new V(...p.dir).normalize();
    const ground = Math.max(e.planet.height(dir.x, dir.y, dir.z), e.planet.sea);
    const target = dir.clone().multiplyScalar(ground + ay).add(e.home);
    // 作品正面（模型 +Z 转到星球上）：和 placementTransform 一样，先把 +Y 转到法线，再绕法线转 yaw
    const Q = w.rig.camera.quaternion.constructor;
    const q = new Q().setFromUnitVectors(new V(0, 1, 0), dir);
    q.premultiply(new Q().setFromAxisAngle(dir, p.yaw));
    const fwd = new V(0, 0, 1).applyQuaternion(q);
    const side = new V().crossVectors(dir, fwd);
    const a = (f * Math.PI) / 180;
    const horiz = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
    const e2 = (el * Math.PI) / 180;
    const pos = target.clone().addScaledVector(horiz, d * Math.cos(e2)).addScaledVector(dir, d * Math.sin(e2));
    // 地平线放平：镜头的「上」取作品脚下的法线（只在样张里这么做，拍完就关页面）
    w.rig.camera.up.copy(dir);
    w.rig.jump({ target, position: pos, minDistance: 0.5, maxDistance: 400, autoRotate: false });
  }, [workId, dist, front, elev, aimY]);
  await page.waitForTimeout(1200);
}

// 漫游：角色站在作品 workId 正面 dist 米处、往旁边偏 side 米，面朝作品（同 shot-i1）
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

async function shot(name, setup, opts = {}) {
  if (only && !only.includes(name.replace(/\.png$/, ''))) return;
  const { page, errors } = await open(opts);
  try {
    await setup(page);
    if (name.endsWith('.png')) await page.screenshot({ path: path.join(out, name.replace(/.png$/, `${suffix}.png`)) });
    console.log(`✓ ${name}`);
  } catch (e) {
    problems.push(`${name}: ${e.message}`);
    console.log(`✗ ${name}: ${e.message}`);
  } finally {
    if (errors.length) problems.push(`${name} 页面错误：${errors.join(' | ')}`);
    await page.close();
  }
}

// 拿到应用里的 PlanetView：开发服务器上同一个模块地址就是同一个模块实例，改原型上的 pick / topOf，应用用到一次就记下 this（同 check-editor）
const grabView = (page) => page.evaluate(async () => {
  const { PlanetView } = await import('/src/scenes/planetView.ts');
  const proto = PlanetView.prototype;
  for (const name of ['pick', 'topOf']) {
    const fn = proto[name];
    proto[name] = function (...args) {
      window.__view = this;
      return fn.apply(this, args);
    };
  }
  const desc = Object.getOwnPropertyDescriptor(proto, 'planet');
  Object.defineProperty(proto, 'planet', { configurable: true, get() { window.__view = this; return desc.get.call(this); } });
});

// 作品脚下地面的屏幕坐标
const groundPos = (page, id) => page.evaluate((i) => {
  const pw = window.__view.placed.get(i);
  const V = window.__world.rig.camera.position.constructor;
  return window.__world.toScreen(pw.root.getWorldPosition(new V()));
}, id);

// 摆放的反馈：编辑模式里删掉一件作品（尘土一扬、花园缩回去）、从作品栏摆回去（从半空落下、压扁回弹、扬尘、花园一圈圈长出来）、
// 再拖起来（悬在半空、花园收起）。放慢 4 倍拍，按时间顺序出 stage-remove、stage-drop-1..5、stage-lift
async function feedback(page) {
  const id = 'ph-03';
  await page.evaluate(async () => { (await import('/src/scenes/planetView.ts')).STAGE.slowmo = 0.25; });
  await grabView(page);
  await page.locator('.topbar button.primary').click();
  await page.waitForTimeout(300);
  await lookAt(page, id, 7.5, 18, 30, 0.6);
  await page.mouse.move(700, 450);
  await page.waitForFunction(() => !!window.__view, null, { timeout: 5000 });
  const ground = await groundPos(page, id);
  const at = await page.evaluate((i) => window.__app.workScreenPos(i), id);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(250);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(out, 'stage-remove.png') });
  await page.waitForTimeout(2500);
  const title = await page.evaluate((i) => window.__view.findWork(i)?.title, id);
  await page.locator('.tray-item', { hasText: title }).click();
  await page.waitForTimeout(600);
  await page.mouse.move(ground.x, ground.y);
  await page.waitForTimeout(400);
  await page.mouse.click(ground.x, ground.y);
  await page.waitForFunction((i) => !!window.__view.placed.get(i)?.model, id, { timeout: 15000 });
  const t0 = Date.now();
  const marks = [0.5, 1.45, 2.3, 3.4, 6.5];
  for (let k = 0; k < marks.length; k++) {
    const wait = t0 + marks[k] * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(out, `stage-drop-${k + 1}.png`) });
    console.log(`  stage-drop-${k + 1} @ ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  }
  await page.keyboard.press('Escape');
  const w = await page.evaluate((i) => window.__app.workScreenPos(i), id);
  await page.mouse.move(w.x, w.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(w.x + 6 * i, w.y - 2 * i);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(out, 'stage-lift.png') });
  await page.mouse.up();
  await page.waitForTimeout(3000);
}

try {
  await shot('stage-feedback', feedback);
  await shot('stage-overview.png', async () => {});
  await shot('stage-close.png', (p) => lookAt(p, 'ph-03', 3.2, 12, 14, 0.8), { dpr: 2 });
  await shot('stage-garden.png', (p) => lookAt(p, 'ph-02', 5.5, 150, 28, 0.6), { dpr: 2 });
  await shot('stage-walk.png', (p) => walkNear(p, 'ph-02', 5, 1.6));
  await shot('stage-sunset.png', (p) => lookAt(p, 'ph-02', 5.5, 160, 20, 0.7), { dpr: 2, sky: 'sunset' });
  await shot('stage-other.png', async () => {}, { at: 'kiln-collective' });
} finally {
  if (problems.length) console.log(`问题：\n${problems.join('\n')}`);
  process.exitCode = problems.length ? 1 : 0;
  await browser.close();
  await server.close();
}

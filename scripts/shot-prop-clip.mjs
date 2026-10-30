// 漫游穿模的前后对比样张（第二版的点缀道具挡不挡路）：翠宝正面走向灯柱、立石的扁面、拱门的一根柱子，再从拱门中间穿过去。
// 每一段：瞬移到离目标 3 米处、朝着它按住 W，走到目标中心（穿进去了）或走满 2.2 秒就松开；停稳后拍一张身后的，再把镜头拖到侧面拍一张。
// 同时打出每一段离目标中心最近到过多远（米）。灯柱、拱门柱子的位置按点缀的摆放（方向、yaw、大小）现算，改代码前后都能跑。
// node scripts/shot-prop-clip.mjs <标签> [--webgl2]：存到 .superpowers/sdd/2026-10-30-v2/clip-media/<段>-<视角>-<标签>.png。VITE_CACHE_DIR 指向自己的依赖缓存
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--')) ?? 'now';
const webgl2 = args.includes('--webgl2');
const out = '.superpowers/sdd/2026-10-30-v2/clip-media';
mkdirSync(out, { recursive: true });

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
// 先看「你的星球」，没有拱门、灯柱、立石齐全的话依次看别的团队
const order = [seed.you.teamId, ...seed.teams.map((t) => t.id).filter((id) => id !== seed.you.teamId)];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map((x) => x * s);
const add = (a, b, s = 1) => a.map((x, i) => x + b[i] * s);
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));
const toward = (from, to) => norm(add(to, from, -dot(from, to))); // from 处指向 to 的切向
const turn = (c, t, a) => norm(add(scale(c, Math.cos(a)), t, Math.sin(a))); // c 朝切向 t 转过 a 弧度

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
const page = await ctx.newPage();
const errors = watchErrors(page);
if (webgl2) await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
const until = (fn, arg, ms = 10000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// 点缀的摆放（星球本地坐标）；拱门的两根柱子、正面（局部 +Z）按 props-v2.ts 的 fill 同样的变换现算
const UP = new Vector3(0, 1, 0);
const propsNow = async () => {
  const list = await page.evaluate(async () => {
    const { propsV2 } = await import('/src/scenes/propsV2Install.ts');
    return propsV2()?.items.map((it) => ({ kind: it.kind, dir: it.dir.toArray(), yaw: it.yaw, size: it.size })) ?? null;
  });
  return list?.map((it) => {
    const q = new Quaternion().setFromUnitVectors(UP, new Vector3(...it.dir)).multiply(new Quaternion().setFromAxisAngle(UP, it.yaw));
    const axis = (x, y, z) => new Vector3(x, y, z).applyQuaternion(q).toArray();
    return { ...it, x: axis(1, 0, 0), z: axis(0, 0, 1) };
  }) ?? null;
};

let team = null;
let items = null;
await page.goto(`${base}/?nolocal#/t/${order[0]}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
for (const id of order) {
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, id);
  await until((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, id, 60000);
  await until(() => (window.__v2world?.props?.() ?? []).length > 0, null, 10000);
  await page.waitForTimeout(300);
  const list = await propsNow();
  const kinds = new Set((list ?? []).map((p) => p.kind));
  console.log(`${id}：${list ? list.map((p) => p.kind).join(' ') : '读不到点缀'}`);
  if (kinds.has('lamp') && kinds.has('arch') && kinds.has('menhir')) {
    team = id;
    items = list;
    break;
  }
}
if (!team) throw new Error('没有一颗星球同时有灯柱、拱门、立石');
await until(() => window.__walk?.state().ready === true, null, 30000);
const R = await page.evaluate(async () => (await import('/src/planet/presets.ts')).PLANET_RADIUS);
await page.waitForTimeout(2500); // 轨道镜头的阻尼停稳
await page.locator('.topbar button.walk').click();
await until(() => window.__walk.state().phase === 'walk', null, 8000);
await page.waitForTimeout(400);

const lamp = items.find((p) => p.kind === 'lamp');
const menhir = items.find((p) => p.kind === 'menhir');
const arch = items.find((p) => p.kind === 'arch');
// 拱门：柱子中心在局部 x = ±0.83（× 大小），正面朝局部 +Z
const pier = norm(add(arch.dir, arch.x, (0.83 * arch.size) / R));
const runs = [
  { name: 'lamp', target: lamp.dir, from: turn(lamp.dir, toward(lamp.dir, [0, 1, 0]), 3 / R), through: false },
  { name: 'menhir', target: menhir.dir, from: turn(menhir.dir, menhir.z, 3 / R), through: false },
  { name: 'arch-pier', target: pier, from: turn(pier, arch.z, 3 / R), through: false },
  { name: 'arch-opening', target: arch.dir, from: turn(arch.dir, arch.z, 3 / R), through: true },
];

const report = [];
for (const run of runs) {
  await page.evaluate(([d, h]) => window.__walk.teleport(d, h), [run.from, toward(run.from, run.target)]);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__walk.trace(true));
  await page.keyboard.down('w');
  const t0 = Date.now();
  // 穿过拱门那一段走到中心就停（拍角色正站在门洞里）；别的走到中心（穿进去了）或走满 2.2 秒
  while (Date.now() - t0 < 2200) {
    const s = await page.evaluate(() => window.__walk.state());
    if (angle(s.dir, run.target) * s.radius < 0.12) break;
    await page.waitForTimeout(16);
  }
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  const trace = await page.evaluate(() => window.__walk.trace(false));
  const end = await page.evaluate(() => window.__walk.state());
  const closest = Math.min(...trace.map((s) => angle(s.dir, run.target) * s.ground));
  const line = `${run.name}：离目标中心最近 ${closest.toFixed(3)} 米，停在 ${(angle(end.dir, run.target) * end.radius).toFixed(3)} 米处（大小 ${(run.name.startsWith('arch') ? arch : run.name === 'lamp' ? lamp : menhir).size.toFixed(2)}）`;
  report.push(line);
  console.log(line);
  await page.screenshot({ path: path.join(out, `${run.name}-back-${tag}.png`) });
  // 镜头拖到侧后方（往左拖：镜头往右绕约 60°），看得出角色和道具的前后
  await page.mouse.move(900, 420);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(900 - i * 17, 420 + i * 2);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${run.name}-side-${tag}.png`) });
}

console.log(`星球 ${team}；${await page.evaluate(() => window.__app.backend())}`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
await browser.close();
await server.close();

// 录屏（逐帧）：漫游时翠宝的走路动画。时间停住（window.__trans.timeScale(0)），每帧往前走 1/60 秒再截图，ffmpeg 拼成 60 帧的 MP4。
// 跟随镜头 1440×900，路线按顺序：直走 → 停下 → 原地转身 → 绕圈 → 起步加速 → 涉水；最后一段是近景侧面镜头（看脚着地时打不打滑）。
// 每段挑几张关键帧，拼成一张总览图（contact.png）。按键都按帧数按下、松开，同一份代码前后录出来的路线一样，可以并排比较（scripts/compare-walk.mjs）。
// 有 window.__walk.feet()（新的走路动画）时，逐帧记下两只脚在星球上的位置，算着地期间脚滑了多远，写进 feet.json。
// node scripts/record-walk.mjs [输出目录]（默认 .superpowers/sdd/2026-10-27-community-planets/team/walk-media/after）。WEBGL2=1 走 WebGL2，HEADED=1 开有界面的 Chrome（WebGPU）。
// BASE_ROOT=<目录>：开发服务器用那个目录里的源码（改之前的版本：从提交里导出的 src、index.html、vite.config.ts），public/ 照旧用这里的
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const OUT = process.argv[2] ?? '.superpowers/sdd/2026-10-27-community-planets/team/walk-media/after';
const TMP = path.join('.tmp', `walk-record-${path.basename(OUT)}`);
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
mkdirSync(OUT, { recursive: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { server, base } = await startServer({
  cacheDir: path.resolve(process.env.VITE_CACHE_DIR ?? '.tmp/vite-walk-record'),
  ...(process.env.BASE_ROOT ? { root: path.resolve(process.env.BASE_ROOT), publicDir: path.resolve('public') } : {}),
});
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await page.goto(`${base}/?nolocal#/t/${team.id}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 90000 });
await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const backend = await page.evaluate(() => window.__app.backend());

// —— 找地方：一块开阔的平地（直走、转身、绕圈、侧面），一处岸边（往前走就下水）——
const spots = await page.evaluate(async (id) => {
  const { makeHeightFn, seaRadius } = await import('/src/planet/noise.ts');
  const { PLANET_RADIUS } = await import('/src/planet/presets.ts');
  const recipe = window.__app.teamPlanet(id);
  const height = makeHeightFn(recipe.seed, recipe.preset);
  const sea = seaRadius(recipe.preset);
  const R = PLANET_RADIUS;
  const obs = window.__walk.obstacles();
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const h = (d) => height(d[0], d[1], d[2]);
  // d 处沿切向 t 走 s 米
  const go = (d, t, s) => norm(d.map((x, i) => x * Math.cos(s / R) + t[i] * Math.sin(s / R)));
  const tangent = (d, k) => { const a = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); const b = cross(d, a); return a.map((x, i) => x * Math.cos(k) + b[i] * Math.sin(k)); };
  const clear = (d, m) => obs.every((o) => Math.acos(Math.min(1, dot(d, o.dir))) * R > m + o.minAngle * R);
  const land = (d) => sea <= 0 || h(d) > sea + 0.08;
  // 斐波那契球面上取点
  const N = 4000;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963229728653;
    pts.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  // 平地：周围 6 米一圈都是陆地、离作品远、坡度小（一圈的高度差小）
  let flat = null;
  let best = Infinity;
  for (const d of pts) {
    if (!land(d) || !clear(d, 9)) continue;
    let lo = Infinity;
    let hi = -Infinity;
    let ok = true;
    for (let k = 0; k < 12 && ok; k++) {
      const t = tangent(d, (k / 12) * Math.PI * 2);
      for (const s of [2, 4, 6]) {
        const p = go(d, t, s);
        if (!land(p)) { ok = false; break; }
        lo = Math.min(lo, h(p));
        hi = Math.max(hi, h(p));
      }
    }
    if (ok && hi - lo < best) { best = hi - lo; flat = d; }
  }
  // 岸边：水深超过 0.25 的点，沿某个方向 1.5–4 米外就上岸；起点在岸上再往里 1.5 米，朝着水走
  let shore = null;
  if (sea > 0) {
    let bestScore = Infinity;
    for (const w of pts) {
      if (sea - h(w) < 0.25 || !clear(w, 6)) continue;
      for (let k = 0; k < 12; k++) {
        const t = tangent(w, (k / 12) * Math.PI * 2);
        let s = 0.25;
        while (s < 4.5 && !land(go(w, t, s))) s += 0.25;
        if (s < 1.5 || s >= 4.5) continue;
        const start = go(w, t, s + 1.5);
        if (!land(start) || !clear(start, 4)) continue;
        // 起点切向朝着水（w 方向）
        const back = norm(w.map((x, i) => x - start[i] * dot(start, w)));
        if (s < bestScore) { bestScore = s; shore = { start, heading: back, toWater: s + 1.5 }; }
      }
    }
  }
  const heading = tangent(flat, 0);
  return { flat, heading, flatness: best, shore, sea, R };
}, team.id);
console.log(`backend ${backend}；平地高差 ${spots.flatness.toFixed(3)} m；岸边 ${spots.shore ? `${spots.shore.toWater.toFixed(1)} m 到水边` : '没有'}`);

// 往前走一帧：3D 走 1/60 秒
const step = () => page.evaluate(() => new Promise((resolve) => {
  window.__trans.advance(1 / 60);
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));
const hasFeet = await page.evaluate(() => typeof window.__walk.feet === 'function');
const feetLog = [];
// 角色胸口在屏幕上的位置：关键帧围着它裁一块，翠宝在总览图里不至于太小
const charAt = () => page.evaluate(() => {
  const s = window.__walk.state();
  const cam = window.__world.rig.camera;
  const V = cam.position.constructor;
  const r = s.radius + 0.45;
  return window.__world.toScreen(new V(s.home[0] + s.dir[0] * r, s.home[1] + s.dir[1] * r, s.home[2] + s.dir[2] * r));
});

// 录一段：frames 帧；at[帧号] = 这一帧之前要做的事（按键、拖动）；keys = { 名字: 帧号 } 存成关键帧
// ONLY=1,7：只给这几段截图（别的段照样按键、走帧，后面的段起点不变），调试时快一些
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const segments = [];
async function record(name, frames, at = {}, keys = {}, crop = [560, 350]) {
  const shoot = !ONLY || ONLY.has(name.split('-')[0]);
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(Object.values(keys));
  const centers = {};
  for (let i = 0; i < frames; i++) {
    if (at[i]) await at[i]();
    await step();
    if (hasFeet) feetLog.push({ seg: name, i, ...(await page.evaluate(() => window.__walk.feet())) });
    if (!shoot) continue;
    if (wanted.has(i)) centers[i] = await charAt();
    await page.screenshot({ path: path.join(dir, `f-${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 88 });
  }
  if (!shoot) return;
  const out = path.join(OUT, `${name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '60', '-i', path.join(dir, 'f-%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
  const keyFiles = [];
  for (const [label, frame] of Object.entries(keys)) {
    const file = path.join(OUT, `${name}-${label}.jpg`);
    const src = path.join(dir, `f-${String(frame).padStart(4, '0')}.jpg`);
    // 围着角色裁一块（整帧的就直接拷）
    const c = centers[frame];
    const [cw, ch] = crop;
    if (c && cw < 1440) {
      const left = Math.round(Math.min(1440 - cw, Math.max(0, c.x - cw / 2)));
      const top = Math.round(Math.min(900 - ch, Math.max(0, c.y - ch * 0.55)));
      await sharp(src).extract({ left, top, width: cw, height: ch }).jpeg({ quality: 90 }).toFile(file);
    } else {
      copyFileSync(src, file);
    }
    keyFiles.push({ label, file });
  }
  segments.push({ name, out, frames, keyFiles });
  console.log(`${out}（${frames} 帧）`);
}

const teleport = (d, hd) => page.evaluate(([a, b]) => window.__walk.teleport(a, b), [d, hd]);
const tap = (key, frames = 2) => ({ down: () => page.keyboard.down(key), up: () => page.keyboard.up(key), frames });

await page.locator('.topbar button.walk').click();
await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__trans.timeScale(0));
await teleport(spots.flat, spots.heading);
for (let i = 0; i < 40; i++) await step(); // 站稳、镜头就位

// 1. 直走（先站 0.5 秒，再按住 W 2.5 秒）
await record('1-straight', 180, { 30: () => page.keyboard.down('w') }, { stand: 20, start: 36, accel: 44, walk1: 120, walk2: 126, walk3: 132 });
// 2. 停下（松开 W，再录 1.5 秒）
await record('2-stop', 90, { 0: () => page.keyboard.up('w') }, { release: 4, brake: 10, last: 18, settle: 30, rest: 80 });
// 3. 原地转身：轻点 A、S、D、W（各 2 帧），每次之间停 50 帧
{
  const at = {};
  let f = 2;
  for (const k of ['a', 's', 'd', 'w']) {
    at[f] = () => page.keyboard.down(k);
    at[f + 2] = () => page.keyboard.up(k);
    f += 52;
  }
  await record('3-turn', f + 10, at, { a1: 8, a2: 20, s1: 60, s2: 74, d1: 112, d2: 126, w1: 164, w2: 178 });
}
// 4. 绕圈：按住 W，同时往右拖（镜头转，W 的方向跟着转）
await teleport(spots.flat, spots.heading);
for (let i = 0; i < 20; i++) await step();
{
  const at = { 0: async () => { await page.mouse.move(400, 600); await page.mouse.down(); await page.mouse.move(410, 600); }, 2: () => page.keyboard.down('w') };
  let x = 410;
  for (let i = 3; i < 300; i++) at[i] = () => page.mouse.move((x += 4), 600);
  at[300] = async () => { await page.keyboard.up('w'); await page.mouse.up(); };
  await record('4-circle', 340, at, { c1: 60, c2: 120, c3: 180, c4: 240, end: 330 });
}
// 5. 起步加速：站 40 帧，按住 W 2 秒，再停
await teleport(spots.flat, spots.heading);
for (let i = 0; i < 30; i++) await step();
await record('5-start', 220, { 40: () => page.keyboard.down('w'), 160: () => page.keyboard.up('w') }, { still: 36, go1: 42, go2: 46, go3: 50, go4: 56, run: 100, stop: 180 });
// 6. 涉水：从岸上朝水里走 4 秒
if (spots.shore) {
  await teleport(spots.shore.start, spots.shore.heading);
  for (let i = 0; i < 30; i++) await step();
  await record('6-wade', 330, { 20: () => page.keyboard.down('w'), 260: () => page.keyboard.up('w') }, { shore: 40, enter: 90, wade1: 160, wade2: 168, wade3: 176, stop: 300 });
}
// 7. 近景侧面：镜头定住不跟（每帧在漫游摆完镜头以后改回固定的位置），放在角色要走的那条线的侧面 3 米、略高一点；
// 按住 D 横着走过画面（侧面看），停下，再按 A 走回来。镜头不动，着地的鞋在画面里就该一动不动
await teleport(spots.flat, spots.heading);
for (let i = 0; i < 10; i++) await step();
await page.evaluate(() => {
  const s = window.__walk.state();
  const cam = window.__world.rig.camera;
  const V = cam.position.constructor;
  const up = new V(...s.dir);
  const fwd = new V(...s.heading);
  const right = new V().crossVectors(fwd, up); // 镜头的右（D 往这边走）
  const feet = new V(...s.dir).multiplyScalar(s.radius).add(new V(...s.home));
  const mid = feet.clone().addScaledVector(right, 1.1);
  const pos = mid.clone().addScaledVector(fwd, 3.1).addScaledVector(up, 0.75);
  const look = mid.clone().addScaledVector(up, 0.32);
  const z = pos.clone().sub(look).normalize();
  const x = new V().crossVectors(up, z).normalize();
  const y = new V().crossVectors(z, x);
  const q = new cam.quaternion.constructor().setFromRotationMatrix(new cam.matrix.constructor().makeBasis(x, y, z));
  window.__sideCam = () => { cam.position.copy(pos); cam.quaternion.copy(q); cam.up.copy(up); };
  window.__world.frameHooks.add(window.__sideCam);
  // 草比鞋高，侧面看不见脚：这一段先藏起草，看地面的纹理就知道脚有没有跟着地面走
  if (window.__world.dressing.grass) window.__world.dressing.grass.object.visible = false;
});
for (let i = 0; i < 10; i++) await step();
await record('7-side', 330, { 20: () => page.keyboard.down('d'), 80: () => page.keyboard.up('d'), 170: () => page.keyboard.down('a'), 230: () => page.keyboard.up('a') },
  { stand: 15, s1: 22, s2: 25, s3: 28, s4: 31, w1: 50, w2: 53, w3: 56, w4: 59, stop1: 86, stop2: 96, back: 200, end: 300 }, [1440, 900]);
await page.evaluate(() => {
  window.__world.frameHooks.delete(window.__sideCam);
  if (window.__world.dressing.grass) window.__world.dressing.grass.object.visible = true;
});

await page.evaluate(() => window.__trans.timeScale(1));

// —— 着地时脚滑了多远（有 __walk.feet() 时）——
let slip = null;
if (hasFeet && feetLog.length) {
  const stats = { maxSlip: 0, stances: 0, frames: feetLog.length };
  for (const side of ['left', 'right']) {
    let anchor = null;
    let seg = null;
    for (const s of feetLog) {
      const f = s[side];
      if (!f) continue;
      if (f.planted && anchor && seg === s.seg) {
        const d = Math.hypot(f.pos[0] - anchor[0], f.pos[1] - anchor[1], f.pos[2] - anchor[2]);
        stats.maxSlip = Math.max(stats.maxSlip, d);
      } else if (f.planted) {
        anchor = f.pos;
        seg = s.seg;
        stats.stances++;
      } else {
        anchor = null;
      }
    }
  }
  slip = stats;
  writeFileSync(path.join(OUT, 'feet.json'), JSON.stringify({ slip: stats, frames: feetLog }, null, 0));
  console.log(`着地期间脚滑动最大 ${(stats.maxSlip * 1000).toFixed(2)} mm（${stats.stances} 次着地，${stats.frames} 帧）`);
}

// —— 总览图：每段一行，关键帧缩成 360×225，左上角写段名和帧名 ——
const W = 360;
const H = 225;
const cols = Math.max(...segments.map((s) => s.keyFiles.length));
const rows = segments.length;
const label = (text) => Buffer.from(`<svg width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="22" fill="rgba(0,0,0,0.55)"/><text x="6" y="16" font-family="Segoe UI, Arial" font-size="14" fill="#fff">${text}</text></svg>`);
const tiles = [];
for (let r = 0; r < rows; r++) {
  const seg = segments[r];
  for (let c = 0; c < seg.keyFiles.length; c++) {
    const k = seg.keyFiles[c];
    const img = await sharp(k.file).resize(W, H).composite([{ input: label(`${seg.name} · ${k.label}`), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
    tiles.push({ input: img, left: c * W, top: r * H });
  }
}
const contact = path.join(OUT, 'contact.jpg');
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#202020' } }).composite(tiles).jpeg({ quality: 85 }).toFile(contact);
// 全程一个 MP4
const list = path.join(TMP, 'list.txt');
writeFileSync(list, segments.map((s) => `file '${path.resolve(s.out).replace(/\\/g, '/')}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(OUT, 'all.mp4')]);
writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify({ backend, spots, slip, segments: segments.map((s) => ({ name: s.name, frames: s.frames, keys: s.keyFiles.map((k) => k.label) })) }, null, 2));
console.log(`总览图 ${contact}`);
console.log(errors.length ? `页面错误：\n${errors.join('\n')}` : '没有页面错误');
await browser.close();
await server.close();

// 量穿模（不靠眼睛看）：每颗示例星球上的每件作品，从 24 个方向让翠宝正对着作品中心走过去（页面里用真正的 Walker 和漫游现在的碰撞体，60 帧逐帧走），
// 停下以后量：作品的网格顶点（展台 + 模型，只算翠宝身高范围里的）离翠宝的竖轴最近多远，减去翠宝的半径 = 间隙（负数是穿进去了）。
// 翠宝的半径两种：碰撞半径 CHAR_RADIUS（圆柱），和翠宝模型每一层高度上实际的最大水平半径（站姿，按高度分 10 层）。
// 同时打出翠宝模型实际的最大水平半径、有点缀道具（第二版）时每样道具同样量一遍（道具的网格按实例矩阵和「自己那一样」的顶点算）。
// 每个方向量两种站法：正对着撞上去停下（身体正面朝着作品），和在那里原地转 90°（左右各一次，手臂朝着作品；碰撞体按朝向重新推一次）。
// node scripts/measure-clip.mjs [团队 id …] [--json 输出文件] [--no-side]。不给团队就量全部有作品的团队。
// --no-side：碰撞体不算手臂（Obstacle.side 当 0，和加手臂之前一样），对比用。VITE_CACHE_DIR 指向自己的依赖缓存
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const picked = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json');
const noSide = args.includes('--no-side');
const teams = picked.length ? picked : seed.teams.filter((t) => t.works.length > 0).map((t) => t.id);

const { server, base } = await startServer({ cacheDir: process.env.VITE_CACHE_DIR });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.route('https://www.tripo3d.ai/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Tripo</title>' }));
const page = await ctx.newPage();
const errors = watchErrors(page);
const until = (fn, arg, ms = 10000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

await page.goto(`${base}/?nolocal#/t/${teams[0]}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

// 页面里跑：翠宝的身体剖面、每件作品（和道具）从各个方向走过去以后的间隙
const measure = () => page.evaluate(async (noSide) => {
  const { PlanetView } = await import('/src/scenes/planetView.ts');
  const { CHAR_HEIGHT, CHAR_RADIUS, WALK } = await import('/src/play/params.ts');
  const { walkGround } = await import('/src/play/sphere.ts');
  const { Walker, setObstacle } = await import('/src/play/walker.ts');
  const view = PlanetView.active;
  const entry = view?.planet;
  if (!entry) return null;
  const planet = entry.planet;
  const V = planet.group.position.constructor; // three 的 Vector3（页面里拿不到裸模块名）
  planet.group.updateMatrixWorld(true);
  const inv = planet.group.matrixWorld.clone().invert();
  const tmp = new V();
  // 一个物体底下所有看得见的网格的顶点（星球本地坐标）；每个网格最多取 maxPer 个（均匀跳着取）
  const cloud = (root, maxPer = 40000, skip = () => false) => {
    const pts = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh || skip(o)) return;
      for (let p = o; p; p = p.parent) if (!p.visible) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;
      const m = inv.clone().multiply(o.matrixWorld);
      const step = Math.max(1, Math.ceil(pos.count / maxPer));
      for (let i = 0; i < pos.count; i += step) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(m);
        pts.push(tmp.x, tmp.y, tmp.z);
      }
    });
    return pts;
  };
  // 翠宝的身体剖面：模型（站姿）每 0.1 米高一层的最大水平半径（相对脚底的竖轴）
  const walker3d = window.__world.scene.getObjectByName('walker');
  let body = null;
  if (walker3d) {
    const pts = [];
    walker3d.updateMatrixWorld(true);
    const wInv = walker3d.matrixWorld.clone().invert();
    walker3d.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.getAttribute('position');
      const m = wInv.clone().multiply(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i).applyMatrix4(m);
        pts.push(tmp.x, tmp.y, tmp.z);
      }
    });
    const scale = walker3d.scale.x || 1;
    const bands = new Array(10).fill(0);
    const sectors = Array.from({ length: 10 }, () => new Array(16).fill(0)); // 每层 16 个方位（0 = 正前方，顺时针往右）
    let top = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const h = pts[i + 1] * scale;
      const r = Math.hypot(pts[i], pts[i + 2]) * scale;
      top = Math.max(top, h);
      const b = Math.min(9, Math.max(0, Math.floor((h / CHAR_HEIGHT) * 10)));
      bands[b] = Math.max(bands[b], r);
      const s = Math.floor(((Math.atan2(pts[i], pts[i + 2]) / (Math.PI * 2)) + 1) * 16 + 0.5) % 16;
      sectors[b][s] = Math.max(sectors[b][s], r);
    }
    body = { bands, sectors, max: Math.max(...bands), top, verts: pts.length / 3,
      front: Math.max(...sectors.map((x) => Math.max(x[15], x[0], x[1]))), side: Math.max(...sectors.map((x) => Math.max(x[3], x[4], x[5], x[11], x[12], x[13]))) };
  }
  const bodyAt = (h) => (body ? body.bands[Math.min(9, Math.max(0, Math.floor((h / CHAR_HEIGHT) * 10)))] : CHAR_RADIUS);
  // 漫游现在用的碰撞体（全部：作品，和第二版的道具）
  const all = window.__walk.colliders ? window.__walk.colliders() : window.__walk.obstacles().map((o) => ({ ...o, kind: 'work' }));
  const obstacles = all.map((o) => {
    const ob = { center: new V(), minAngle: 0, cosMin: 1 };
    setObstacle(ob, new V(...o.dir), o.minAngle, noSide ? 0 : o.side ?? 0);
    return ob;
  });
  const ground = (d) => walkGround(d, planet.height, planet.sea);
  // 从离 c 中心 start 米、方位角 a 处朝 c 走 3 秒（每帧想要的速度都朝着 c，和点作品自动走一样），返回停下的方向
  const approach = (c, a, start) => {
    const n = c.clone().normalize();
    const t = new V(0, 1, 0).addScaledVector(n, -n.y);
    if (t.lengthSq() < 1e-8) t.set(1, 0, 0).addScaledVector(n, -n.x);
    t.normalize();
    const b = new V().crossVectors(n, t);
    const side = t.clone().multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
    const ang = start / planet.radius;
    const from = n.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    const w = new Walker();
    w.ground = ground;
    w.place(from, side.clone().negate(), obstacles);
    const wish = new V();
    for (let f = 0; f < 180; f++) {
      wish.copy(n).addScaledVector(w.dir, -n.dot(w.dir));
      if (wish.lengthSq() < 1e-12) break;
      wish.normalize().multiplyScalar(WALK.speed);
      w.step(1 / 60, wish, obstacles);
    }
    return w;
  };
  // 停在 w 时，点云 pts 里翠宝身高范围内的点离翠宝竖轴最近多远：减碰撞半径、减模型这一层的实际半径
  // 朝向感知：点在翠宝的哪个方位（相对 facing），按那一层那个方位的实际半径算；turn = 把翠宝原地转 90°（贴着作品侧着滑过去时手臂朝着作品）
  const sectorAt = (h, lx, lz) => {
    if (!body) return CHAR_RADIUS;
    const b = Math.min(9, Math.max(0, Math.floor((h / CHAR_HEIGHT) * 10)));
    const s = Math.floor(((Math.atan2(lx, lz) / (Math.PI * 2)) + 1) * 16 + 0.5) % 16;
    return Math.max(body.sectors[b][s], body.sectors[b][(s + 1) % 16], body.sectors[b][(s + 15) % 16]);
  };
  const gapAt = (w, pts) => {
    const up = w.dir;
    const fx = up.x * w.radius;
    const fy = up.y * w.radius;
    const fz = up.z * w.radius;
    const fw = w.facing;
    const rt = new V().crossVectors(fw, up); // 翠宝的右（facing × up）
    let cyl = Infinity;
    let real = Infinity;
    let facing = Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const rx = pts[i] - fx;
      const ry = pts[i + 1] - fy;
      const rz = pts[i + 2] - fz;
      const h = rx * up.x + ry * up.y + rz * up.z;
      if (h < 0.005 || h > CHAR_HEIGHT) continue; // 脚底以下（地面、埋进地里的展台根部）不算
      const hx = rx - up.x * h;
      const hy = ry - up.y * h;
      const hz = rz - up.z * h;
      const d = Math.hypot(hx, hy, hz);
      cyl = Math.min(cyl, d - CHAR_RADIUS);
      real = Math.min(real, d - bodyAt(h));
      const lz = hx * fw.x + hy * fw.y + hz * fw.z;
      const lx = hx * rt.x + hy * rt.y + hz * rt.z;
      facing = Math.min(facing, d - sectorAt(h, lx, lz));
    }
    return { cyl, real, facing, side: Infinity };
  };
  const dirs = 24;
  const report = (name, center, pts, startR) => {
    let worstCyl = Infinity;
    let worstReal = Infinity;
    let worstFacing = Infinity;
    let worstSide = Infinity;
    let worstAt = 0;
    let wall = -Infinity;
    const gaps = [];
    for (let k = 0; k < dirs; k++) {
      const a = (k / dirs) * Math.PI * 2;
      const w = approach(center, a, startR);
      const g = gapAt(w, pts);
      if (!Number.isFinite(g.cyl)) continue;
      // 原地转 90°（左右各一次）：碰撞体按新的朝向推一次，量手臂朝着作品时的间隙
      const stop = w.dir.clone();
      const right = new V().crossVectors(w.facing, w.dir);
      for (const s of [1, -1]) {
        w.place(stop, right.clone().multiplyScalar(s), obstacles);
        g.side = Math.min(g.side, gapAt(w, pts).facing);
      }
      gaps.push(g.cyl);
      if (g.cyl < worstCyl) { worstCyl = g.cyl; worstAt = k; }
      worstReal = Math.min(worstReal, g.real);
      worstFacing = Math.min(worstFacing, g.facing);
      worstSide = Math.min(worstSide, g.side);
      wall = Math.max(wall, g.cyl);
    }
    gaps.sort((x, y) => x - y);
    return { name, worstCyl, worstReal, worstFacing, worstSide, worstAt: (worstAt * 360) / dirs, median: gaps[gaps.length >> 1] ?? NaN, wall, n: gaps.length };
  };
  const works = [];
  for (const pw of view.placed.values()) {
    if (!pw.model) continue;
    const pts = cloud(pw.root, 40000, (o) => o === pw.proxy);
    const r = Math.max(pw.plinth.scale.x, pw.model.footprint) * pw.placement.scale;
    works.push(report(pw.work.id, pw.root.position.clone(), pts, r + CHAR_RADIUS + 2.5));
  }
  // 第二版的点缀道具：实例化网格，每个实例只取「自己那一样」的顶点
  const props = [];
  let field = null;
  if (window.__v2world) field = (await import('/src/scenes/propsV2Install.ts')).propsV2(); // 只有第二版有
  if (field && field.mesh.parent && field.items.length) {
    const mesh = field.mesh;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const kindAttr = geo.getAttribute('kind');
    const KINDS = ['lamp', 'menhir', 'arch', 'tower'];
    mesh.updateMatrixWorld(true);
    const m = new mesh.matrixWorld.constructor();
    field.items.forEach((it, i) => {
      mesh.getMatrixAt(i, m);
      const full = inv.clone().multiply(mesh.matrixWorld).multiply(m);
      const want = KINDS.indexOf(it.kind);
      const pts = [];
      for (let v = 0; v < pos.count; v++) {
        if (Math.abs(kindAttr.getX(v) - want) > 0.5) continue;
        tmp.fromBufferAttribute(pos, v).applyMatrix4(full);
        pts.push(tmp.x, tmp.y, tmp.z);
      }
      const center = it.dir.clone().multiplyScalar(planet.height(it.dir.x, it.dir.y, it.dir.z));
      props.push(report(`${it.kind}#${i}`, center, pts, 3));
    });
  }
  return { body, charRadius: CHAR_RADIUS, works, props, colliders: all.length };
}, noSide);

// 走路时翠宝现在的姿势：正前方（±22.5°）、两侧（左右各 ±45°）在身高范围里伸得最远多少米
const poseExtent = () => page.evaluate(() => {
  const w = window.__world.scene.getObjectByName('walker');
  if (!w) return { front: 0, side: 0 };
  w.updateMatrixWorld(true);
  const inv = w.matrixWorld.clone().invert();
  const k = w.scale.x || 1;
  const p = w.position.clone();
  let front = 0;
  let side = 0;
  w.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    const m = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      const r = Math.hypot(p.x, p.z) * k;
      const a = Math.abs(Math.atan2(p.x, p.z)); // 0 正前，π/2 正侧面
      if (a < Math.PI / 8) front = Math.max(front, r);
      if (Math.abs(a - Math.PI / 2) < Math.PI / 4) side = Math.max(side, r);
    }
  });
  return { front, side };
});

const results = [];
for (const id of teams) {
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, id);
  await until((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, id, 60000);
  await until(() => window.__walk?.state().ready === true, null, 30000);
  // 进一下漫游再出来：翠宝的模型挂上（量身体剖面），碰撞体按这颗星球取好
  await page.waitForTimeout(1500);
  await page.locator('.topbar button.walk').click();
  await until(() => window.__walk.state().phase === 'walk', null, 8000);
  await page.waitForTimeout(500);
  // 按住 W 走一会儿，逐次量走路姿势伸得多远（手臂前后摆、走快时往外张）
  let walkFront = 0;
  let walkSide = 0;
  await page.keyboard.down('w');
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(110);
    const e = await poseExtent();
    walkFront = Math.max(walkFront, e.front);
    walkSide = Math.max(walkSide, e.side);
  }
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  const r = await measure();
  if (r) Object.assign(r, { walkFront, walkSide });
  await page.keyboard.press('Escape');
  await until(() => window.__walk.state().phase === 'off', null, 5000);
  if (!r) {
    console.log(`${id}：量不到（没有星球视图）`);
    continue;
  }
  results.push({ team: id, ...r });
  const f = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '  —');
  if (results.length === 1 && r.body) {
    console.log(`翠宝模型：高 ${r.body.top.toFixed(3)} 米，最大水平半径 ${r.body.max.toFixed(3)} 米（碰撞半径 ${r.charRadius.toFixed(3)}），正前方最远 ${r.body.front.toFixed(3)}、两侧最远 ${r.body.side.toFixed(3)}；每 10% 身高一层：${r.body.bands.map((b) => b.toFixed(2)).join(' ')}`);
  }
  console.log(`走路姿势：正前方最远 ${r.walkFront.toFixed(3)} 米，两侧最远 ${r.walkSide.toFixed(3)} 米`);
  console.log(`${id}（碰撞体 ${r.colliders} 个）：间隙，厘米；圆柱 = 按碰撞半径，模型 = 按翠宝这一层实际的半径；最差 / 中位 / 最大（离得最远的方向）`);
  for (const w of [...r.works, ...r.props]) {
    console.log(`  ${w.name.padEnd(22)} 圆柱 最差 ${f(w.worstCyl)}（${w.worstAt}°）中位 ${f(w.median)} 最大 ${f(w.wall)}   模型：正对 ${f(w.worstFacing)} 侧着 ${f(w.worstSide)}   ${w.n} 个方向`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
const worst = results.flatMap((r) => [...r.works, ...r.props].map((w) => ({ team: r.team, ...w }))).sort((a, b) => a.worstSide - b.worstSide);
console.log(`穿得最深（翠宝实际的外形，侧着）：${worst.slice(0, 5).map((w) => `${w.team}/${w.name} ${(w.worstSide * 100).toFixed(1)} cm`).join('，')}`);
const worstCyl = Math.min(...worst.map((w) => w.worstCyl));
console.log(`碰撞圆柱最差间隙 ${(worstCyl * 100).toFixed(1)} cm；正对着走过去最差 ${(Math.min(...worst.map((w) => w.worstFacing)) * 100).toFixed(1)} cm`);
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
await browser.close();
await server.close();

// 漫游自查：进入漫游 → 按住 W 一秒（位置变了、仍贴地）→ 撞作品（正面穿不过去、斜着能滑过去）→ 走到星球背面、翻过北极（镜头上方向连续）
// → 靠近作品（标签、按 E 和点标签打开作品卡）→ 点地面自动走 → 拖动转镜头 → Esc 退出（镜头回到进入前）→ 和编辑互斥
// → 别人的星球、建设中的星球也能走，漫游中回星系 → 页面没有报错。
// 同时量：进入漫游时的最长帧间隔、走路时的帧间隔；用 CDP 采样堆分配，看走路时 src/play/ 的代码有没有新建对象。
// WEBGL2=1：藏起 navigator.gpu，走 WebGL2 后备。截图存到 shots/w1-*.png
import { mkdirSync, readFileSync } from 'node:fs';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const team = seed.teams.find((t) => t.id === seed.you.teamId);
const other = seed.teams.find((t) => t.id !== team.id && t.works.length > 0);
const building = seed.teams.find((t) => t.status === 'under-construction');
const R = 10; // 星球基础半径

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => a.map((x) => x * s);
const add = (a, b, s = 1) => a.map((x, i) => x + b[i] * s);
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));
const toward = (from, to) => norm(add(to, from, -dot(from, to))); // from 处指向 to 的切向
const turn = (c, t, a) => norm(add(scale(c, Math.cos(a)), t, Math.sin(a))); // c 朝切向 t 转过 a 弧度
const deg = (r) => (r * 180) / Math.PI;
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

mkdirSync('shots', { recursive: true });
const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
const results = [];
const check = (name, ok, detail = '') => results.push(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
const until = (fn, arg, ms = 10000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const state = () => page.evaluate(() => window.__walk.state());
const walkButton = () => page.locator('.topbar button.walk');
const phaseIs = (p, ms = 5000) => until((x) => window.__walk.state().phase === x, p, ms);
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};
// 逐帧记录 requestAnimationFrame 的间隔（不受主循环里 dt 封顶的影响）
const startFrames = () => page.evaluate(() => {
  window.__frames = [];
  let last = performance.now();
  const tick = (t) => {
    if (!window.__frames) return;
    window.__frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopFrames = () => page.evaluate(() => {
  const f = window.__frames ?? [];
  window.__frames = null;
  return f;
});
// 地面高度：在页面里按星球配方重新算一遍（不经过漫游代码），和渲染出来的脚底比
const terrainAt = (teamId, dir) => page.evaluate(async ([id, d]) => {
  const { makeHeightFn, seaRadius } = await import('/src/planet/noise.ts');
  const { WADE_DEPTH } = await import('/src/play/params.ts');
  const recipe = window.__app.teamPlanet(id);
  const h = makeHeightFn(recipe.seed, recipe.preset)(d[0], d[1], d[2]);
  const sea = seaRadius(recipe.preset);
  return sea > 0 ? Math.max(h, sea - WADE_DEPTH) : h;
}, [teamId, dir]);
// 逐帧轨迹里的镜头连续性：相邻两帧上、右方向的最大夹角；镜头的上和角色脚下法线的最小点积；穿进圆柱的最深处
const traceStats = (trace) => {
  let maxTurn = 0;
  let minUpDot = 1;
  let minClear = Infinity;
  let maxFloat = 0;
  for (let i = 0; i < trace.length; i++) {
    const s = trace[i];
    if (i > 0) maxTurn = Math.max(maxTurn, angle(s.up, trace[i - 1].up), angle(s.right, trace[i - 1].right));
    minUpDot = Math.min(minUpDot, dot(s.up, s.dir));
    minClear = Math.min(minClear, s.clearance);
    if (Number.isFinite(s.feet)) maxFloat = Math.max(maxFloat, Math.abs(s.feet - s.ground));
  }
  return { maxTurn, minUpDot, minClear, maxFloat, frames: trace.length };
};
const walkTrace = async (key, ms) => {
  await page.evaluate(() => window.__walk.trace(true));
  await hold(key, ms);
  return page.evaluate(() => window.__walk.trace(false));
};
const openPlanet = async (id) => {
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, id);
  await until((t) => window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, id, 60000);
};

await page.goto(`${base}/#/t/${team.id}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await until((t) => document.querySelector('#app')?.dataset.planetReady === t, team.id, 60000);
const charReady = await until(() => window.__walk?.state().ready === true, null, 30000);
const backend = await page.evaluate(() => window.__app.backend());
// 飞到星球后 OrbitControls 的阻尼还会让镜头慢慢漂一两秒（星系自转留下的余量）：等它停稳，像真人看一会儿再点 Walk
await page.waitForTimeout(2500);
const s0 = await state();
check('角色模型在后台准备好了', charReady, s0.triboo ? '翠宝 GLB' : '胶囊体占位');
const orbitCam = s0.camera.position;

// —— 1. 进入漫游 ——
await startFrames();
await page.evaluate(() => window.__walk.trace(true));
await walkButton().click();
const entered = await phaseIs('walk', 5000);
await page.waitForTimeout(300);
const enterTrace = await page.evaluate(() => window.__walk.trace(false));
const enterFrames = await stopFrames();
const s1 = await state();
const enterMax = Math.max(...enterFrames);
check('点 Walk 进入漫游：镜头由漫游接管，按钮变成 Done', entered && s1.camera.drive && !s1.camera.controls && (await walkButton().textContent()) === 'Done');
// 出生点：离进入前的镜头最近的地面，即星球中心指向镜头的方向（落在作品圆柱里时会被推到圆柱边上）
const spawnOff = angle(s1.dir, add(orbitCam, s1.home, -1)) * s1.radius;
check('角色出现在离镜头最近的地面上', spawnOff < 0.05 || (enterTrace[0]?.clearance ?? 1) < 0.05, `离镜头正下方 ${spawnOff.toFixed(3)} 个单位`);
check('进入时最长帧间隔 < 100 ms', enterMax < 100, `${backend}，${enterMax.toFixed(1)} ms，${enterFrames.length} 帧`);
const enterStats = traceStats(enterTrace);
check('进入过渡平滑：镜头每帧转动 < 6°', enterStats.maxTurn < (6 * Math.PI) / 180, `最大 ${deg(enterStats.maxTurn).toFixed(2)}°/帧，${enterStats.frames} 帧`);

// —— 2. 按住 W 一秒 ——
const before = await state();
const wTrace = await walkTrace('w', 1000);
await page.waitForTimeout(400);
const after = await state();
const walked = angle(before.dir, after.dir) * after.radius;
const groundNow = await terrainAt(team.id, after.dir);
const wStats = traceStats(wTrace);
check('按住 W 一秒：角色走了', walked > 1.5, `${walked.toFixed(2)} 个单位`);
check('走完仍贴在地面上（脚底半径 = 按星球配方重算的地面高度）', Math.abs(after.feet - groundNow) < 0.01 && wStats.maxFloat < 1e-6, `差 ${Math.abs(after.feet - groundNow).toExponential(1)}，逐帧最大 ${wStats.maxFloat.toExponential(1)}`);
await page.screenshot({ path: `shots/w1-walk${backend === 'webgl2' ? '-webgl2' : ''}.png` });

// —— 3. 作品挡路 ——
const obstacles = await page.evaluate(() => window.__walk.obstacles());
const target = obstacles[0];
const c = target.dir;
const north = toward(c, [0, 1, 0]);
const east = norm([c[1] * north[2] - c[2] * north[1], c[2] * north[0] - c[0] * north[2], c[0] * north[1] - c[1] * north[0]]);
// 正面：从作品南边 3 个单位外朝它走
const head = turn(c, scale(north, -1), target.minAngle + 3 / R);
await page.evaluate(([d, h]) => window.__walk.teleport(d, h), [head, toward(head, c)]);
const hitTrace = await walkTrace('w', 2500);
const hitStats = traceStats(hitTrace);
const hitEnd = await state();
const gapEnd = (angle(hitEnd.dir, c) - target.minAngle) * hitEnd.radius;
check('正面撞上作品：任何一帧都没穿进圆柱，最后停在圆柱边上', hitStats.minClear > -1e-3 && gapEnd < 0.3, `最近 ${hitStats.minClear.toFixed(4)}，停在边外 ${gapEnd.toFixed(3)}`);
// 斜着：往东偏半个碰撞半径，往北走，应该贴着圆柱滑到作品北边
const sideStart = turn(head, east, (target.minAngle * 0.5));
await page.evaluate(([d, h]) => window.__walk.teleport(d, h), [sideStart, toward(sideStart, add(c, north, target.minAngle + 0.4))]);
const slideTrace = await walkTrace('w', 3200);
const slideStats = traceStats(slideTrace);
const slideEnd = await state();
const past = dot(slideEnd.dir, north) - dot(c, north);
check('斜着撞上去：贴着圆柱滑过去，到了作品另一边', slideStats.minClear > -1e-3 && past > 0, `最近 ${slideStats.minClear.toFixed(4)}，越过作品 ${(past * R).toFixed(2)} 个单位`);

// —— 4. 走到星球背面、翻过北极：镜头的上方向逐帧连续 ——
await startFrames();
// 背面：沿赤道从正面（+Z，进入时镜头那一侧）往 +X 走，走过 -Z
await page.evaluate(() => window.__walk.teleport([0, 0, 1], [1, 0, 0]));
const backTrace = await walkTrace('w', 11000);
const backStats = traceStats(backTrace);
const reachedBack = backTrace.some((s) => s.dir[2] < -0.5);
check('沿赤道走到星球背面：镜头上方向逐帧连续（< 1°/帧），从不倒过来', reachedBack && backStats.maxTurn < (1 * Math.PI) / 180 && backStats.minUpDot > 0.3,
  `最大 ${deg(backStats.maxTurn).toFixed(3)}°/帧，上·法线最小 ${backStats.minUpDot.toFixed(3)}，${backStats.frames} 帧`);
// 两极：沿 z = 0 的经线从 +X 往北走，翻过北极到 -X
await page.evaluate(() => window.__walk.teleport([1, 0, 0], [0, 1, 0]));
const poleTrace = await walkTrace('w', 11000);
const walkFrames = await stopFrames();
const poleStats = traceStats(poleTrace);
const crossedPole = poleTrace.some((s) => s.dir[1] > 0.995) && poleTrace.at(-1).dir[0] < -0.5;
check('翻过北极走到另一边：镜头上方向逐帧连续（< 1°/帧），从不倒过来', crossedPole && poleStats.maxTurn < (1 * Math.PI) / 180 && poleStats.minUpDot > 0.3,
  `最大 ${deg(poleStats.maxTurn).toFixed(3)}°/帧，上·法线最小 ${poleStats.minUpDot.toFixed(3)}`);
const steady = walkFrames.slice(10);
const over = steady.filter((f) => f > 25).length;
check('走路时帧间隔稳定（60 帧：p95 < 20 ms，超过 25 ms 的帧 < 1%）', pct(steady, 0.95) < 20 && over / steady.length < 0.01,
  `p50 ${pct(steady, 0.5).toFixed(1)} ms，p95 ${pct(steady, 0.95).toFixed(1)} ms，最大 ${Math.max(...steady).toFixed(1)} ms，>25 ms ${over}/${steady.length}`);

// —— 5. 堆分配采样（连被回收的也算）：走路时 src/play/ 的代码不新建对象 ——
// JS 里浮点数跨函数传递、存进 three 的 Vector3 字段都会装箱（V8 的 HeapNumber，引擎自己分配，不是代码 new 出来的；
// three 的 WebGPU 渲染器画过一帧后，往任何 Vector3 的 x/y/z 存浮点数都会装箱），所以不要求零字节，而是查：
// 采样里没有在 src/play/ 的调用下面构造 three 的对象（Vector3、Quaternion、Matrix4…）或 clone，src/play/ 的分配只占全页的一小部分
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await page.evaluate(() => window.__walk.teleport([0, -1, 0], [1, 0, 0]));
await page.keyboard.down('w');
await page.waitForTimeout(300);
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await page.waitForTimeout(3000);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
await page.keyboard.up('w');
const CTORS = new Set(['Vector2', 'Vector3', 'Vector4', 'Quaternion', 'Matrix3', 'Matrix4', 'Euler', 'Color', 'Box3', 'Sphere', 'Ray', 'Object3D', 'Group', 'Mesh', 'clone']);
const byFile = {};
let allBytes = 0;
let playBytes = 0;
let ctorBytes = 0;
const ctorWhere = new Set();
const visit = (node, underPlay) => {
  const url = node.callFrame.url;
  const inPlay = url.includes('/src/play/');
  allBytes += node.selfSize;
  if (inPlay) playBytes += node.selfSize;
  if (underPlay && !inPlay && CTORS.has(node.callFrame.functionName) && node.selfSize > 0) {
    ctorBytes += node.selfSize;
    ctorWhere.add(node.callFrame.functionName);
  }
  const file = url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '') || '(引擎内部)';
  byFile[file] = (byFile[file] ?? 0) + node.selfSize;
  for (const child of node.children) visit(child, underPlay || inPlay);
};
visit(profile.head, false);
const kib = (b) => `${(b / 1024).toFixed(0)} KiB`;
const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f, b]) => `${f} ${kib(b)}`).join('，');
check('走路 3 秒：src/play/ 的调用下面没有构造 three 对象，src/play/ 的分配（浮点装箱）不到全页的 10%', ctorBytes === 0 && playBytes < allBytes * 0.1,
  `src/play ${kib(playBytes)} / 全页 ${kib(allBytes)}（${((100 * playBytes) / allBytes).toFixed(1)}%）；最多的：${top}${ctorBytes ? `；构造了 ${[...ctorWhere].join('、')}` : ''}`);

// —— 6. 靠近作品：标签、按 E、点标签 ——
const near = obstacles[1] ?? obstacles[0];
const nearStart = turn(near.dir, scale(toward(near.dir, [0, 1, 0]), -1), near.minAngle + 0.6 / R);
await page.evaluate(([d, h]) => window.__walk.teleport(d, h), [nearStart, toward(nearStart, near.dir)]);
await page.waitForTimeout(500);
const work = [...team.works].find((w) => w.id === near.id);
const author = team.members.find((m) => m.id === work.authorId)?.handle;
const nearState = await state();
check('走到作品旁边：上方出现作品名和作者的标签', nearState.near === near.id && nearState.label.visible && nearState.label.text.includes(work.title) && nearState.label.text.includes(`@${author}`), nearState.label.text);
await page.screenshot({ path: `shots/w1-near-work${backend === 'webgl2' ? '-webgl2' : ''}.png` });
const cardTitle = () => page.evaluate(() => { const c = document.querySelector('.work-card'); return c && !c.hidden ? c.querySelector('h2')?.textContent ?? '' : null; });
await page.keyboard.press('e');
await page.waitForTimeout(150);
check('按 E 打开作品卡', (await cardTitle()) === work.title);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('作品卡开着时按 Esc 先关卡片，还在漫游', (await cardTitle()) === null && (await state()).phase === 'walk');
const lab = (await state()).label;
await page.mouse.click(lab.x, lab.y);
await page.waitForTimeout(150);
check('点标签打开作品卡', (await cardTitle()) === work.title);
await page.locator('.work-card .wc-close').click();

// —— 7. 点地面自动走、拖动转镜头 ——
// 从赤道上一处空地开始；点角色右前方的地面
await page.evaluate(() => window.__walk.teleport([0, 0, -1], [1, 0, 0]));
await page.waitForTimeout(400);
const c0 = await state();
await page.mouse.click(1010, 560);
await page.waitForTimeout(100);
const c1 = await state();
const stopped = await until(() => !window.__walk.state().moving && window.__walk.state().speed < 0.05, null, 8000);
const c2 = await state();
const goal = c1.target ?? c0.dir;
check('点地面：角色自己走到点的地方停下', c1.moving && stopped && angle(c0.dir, goal) * c2.radius > 1 && angle(c2.dir, goal) * c2.radius < 0.15,
  `目标 ${(angle(c0.dir, goal) * c2.radius).toFixed(2)} 个单位外，停在离目标 ${(angle(c2.dir, goal) * c2.radius).toFixed(3)}`);
const d0 = await state();
await page.mouse.move(800, 400);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(800 + i * 20, 400 + i * 4);
await page.mouse.up();
await page.waitForTimeout(200);
const d1 = await state();
// 角色刚停下时速度还在指数衰减，会再滑几毫米：只要求拖动没让它走起来
const dragMoved = angle(d0.dir, d1.dir) * d1.radius;
check('拖动画面：镜头绕角色转，角色不动', angle(d0.heading, d1.heading) > 0.5 && dragMoved < 0.05 && !d1.moving,
  `镜头转了 ${deg(angle(d0.heading, d1.heading)).toFixed(1)}°，角色移动 ${dragMoved.toFixed(3)}`);

// —— 8. Esc 退出：镜头回到进入前的轨道镜头 ——
const saved = (await state()).orbit;
await page.keyboard.press('Escape');
const left = await phaseIs('off', 4000);
await page.waitForTimeout(300);
const s8 = await state();
const back = Math.hypot(...add(s8.camera.position, saved, -1));
const sinceEntry = Math.hypot(...add(saved, orbitCam, -1));
check('Esc 退出：过渡回到进入前的轨道镜头，OrbitControls 接回，按钮变回 Walk', left && !s8.camera.drive && s8.camera.controls && back < 1e-3 && sinceEntry < 1e-2 && (await walkButton().textContent()) === 'Walk',
  `离进入时的镜头 ${back.toExponential(1)}`);

// —— 8b. 漫游中打开 Members：立刻退出漫游；关掉后是轨道镜头 ——
await walkButton().click();
await phaseIs('walk', 5000);
await page.locator('.topbar button', { hasText: 'Members' }).click();
const sheetOpen = await page.locator('.sheet.members').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
const s8b = await state();
await page.keyboard.press('Escape');
await page.locator('.sheet.members').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
check('漫游中打开 Members：立刻退出漫游、镜头交回 OrbitControls', sheetOpen && s8b.phase === 'off' && !s8b.camera.drive && s8b.camera.controls && (await walkButton().textContent()) === 'Walk');

// —— 9. 和编辑互斥 ——
const edit = page.locator('.topbar button.primary');
await edit.click();
await page.waitForTimeout(200);
const editing = await page.locator('.tray').isVisible();
await walkButton().click();
await page.waitForTimeout(200);
const swapped = !(await page.locator('.tray').isVisible()) && (await edit.textContent()) === 'Edit' && (await state()).phase !== 'off';
await edit.click();
await page.waitForTimeout(200);
const s9 = await state();
check('编辑和漫游互斥：编辑中点 Walk 退出编辑；漫游中点 Edit 立刻回轨道镜头再进编辑', editing && swapped && s9.phase === 'off' && !s9.camera.drive && (await page.locator('.tray').isVisible()) && (await edit.textContent()) === 'Done');
await edit.click(); // Done
await page.waitForTimeout(200);

// —— 10. 别人的星球、建设中的星球都能走；漫游中回星系 ——
for (const t of [other, building]) {
  await openPlanet(t.id);
  await walkButton().click();
  const ok = await phaseIs('walk', 5000);
  const a = await state();
  await hold('w', 700);
  await page.waitForTimeout(300);
  const b = await state();
  const g = await terrainAt(t.id, b.dir);
  check(`${t.status === 'active' ? '别人的星球' : '建设中的星球'}（${t.id}）也能走`, ok && a.teamId === t.id && angle(a.dir, b.dir) * b.radius > 0.8 && Math.abs(b.feet - g) < 0.01);
  if (t === building) {
    await page.locator('.topbar button', { hasText: 'Galaxy' }).click();
    const off = await phaseIs('off', 3000);
    const galaxy = await until(() => window.__app.routeIdle() && location.hash === '#/', null, 8000);
    check('漫游中点 ← Galaxy：立刻退出漫游，镜头飞回星系', off && galaxy && !(await state()).camera.drive);
  } else {
    await page.keyboard.press('Escape');
    await phaseIs('off', 4000);
  }
}

// —— 11. 触屏：点 Walk、点地面就走过去 ——
const touch = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
const tp = await touch.newPage();
const touchErrors = watchErrors(tp); // 触屏页的错误最后并进 errors
if (process.env.WEBGL2 === '1') await tp.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
await tp.goto(`${base}/#/t/${other.id}`);
await tp.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
await tp.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
await tp.waitForTimeout(1500);
const wb = await tp.locator('.topbar button.walk').boundingBox();
await tp.touchscreen.tap(wb.x + wb.width / 2, wb.y + wb.height / 2);
const tWalk = await tp.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 5000 }).then(() => true, () => false);
await tp.evaluate(() => window.__walk.teleport([0, 0, -1], [1, 0, 0]));
await tp.waitForTimeout(400);
const t0 = await tp.evaluate(() => window.__walk.state());
await tp.touchscreen.tap(760, 650); // 角色右前方的地面（这个视角下地平线在 y ≈ 490）
await tp.waitForTimeout(100);
const t1 = await tp.evaluate(() => window.__walk.state());
await tp.waitForTimeout(1200);
const t2 = await tp.evaluate(() => window.__walk.state());
const hintTouch = await tp.locator('.walk-hint').textContent();
check('触屏：点 Walk 进入，点地面角色就走过去', tWalk && t1.moving && angle(t0.dir, t2.dir) * t2.radius > 0.5, `提示「${hintTouch}」，走了 ${(angle(t0.dir, t2.dir) * t2.radius).toFixed(2)}`);
errors.push(...touchErrors);
await touch.close();

console.log(`backend: ${backend}；角色：${s0.triboo ? '翠宝 GLB' : '胶囊体占位'}`);
console.log(results.join('\n'));
if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
const ok = results.every((r) => r.startsWith('✓')) && errors.length === 0;
console.log(ok ? 'WALK OK' : 'WALK FAIL');
await browser.close();
await server.close();
process.exitCode = ok ? 0 : 1;

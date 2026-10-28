// I1 接线自查：node scripts/check-i1.mjs（WEBGL2=1 走 WebGL2 后备）
// 查 check-walk / check-editor / check-drop 不管的那些接线：
// - ?tune 面板能打开，分组齐全（Planet、Grass、Sky & light、Life、Camera），「Copy parameters」导出的 JSON 里有草、天空、天气
// - 主渲染器的色调映射是 AgX，曝光跟着 atmosphere.params.exposure
// - 星系视图：云海压在所有星球下面；进星球后云海回到星球上，草场只建一次（换星球不新建）
// - 漫游：生机层收到角色（影响球半径 > 0），走路时踩踏图有被踩的像素；草在画
// - 下雨：雨量平滑上升，天空收到（atmosphere.rain），太阳变暗
// - 换到别的星球再走：草跟着换星球（setPlanet），草根贴在新星球的地面上
// - 拖半径滑块（setPlanetRadius 45）：草按新半径重建，页面不报错；再拖回 30
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const { server, base } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = watchErrors(page);
if (process.env.WEBGL2 === '1') await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
const results = [];
const check = (ok, name) => {
  results.push([ok, name]);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
};
const you = 'lumen-guild';
const other = 'quiet-vertex';

try {
  await page.goto(`${base}/?nolocal&tune#/`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__app.routeIdle(), null, { timeout: 30000 });
  console.log(`backend: ${await page.evaluate(() => window.__app.backend())}`);
  await page.waitForTimeout(1500);

  // ?tune 面板
  await page.waitForSelector('.tune-pane', { timeout: 15000 });
  const paneText = await page.evaluate(() => document.querySelector('.tune-pane')?.textContent ?? '');
  for (const t of ['Planet', 'Grass', 'Sky & light', 'Life', 'Camera', 'Copy parameters']) check(paneText.includes(t), `?tune 有「${t}」`);
  const json = await page.evaluate(async () => (await import('/src/tune.ts')).tuneJson(window.__world));
  const parsed = JSON.parse(json);
  check(['grass', 'grassGround', 'sky', 'weather', 'palette', 'shots'].every((k) => k in parsed) && 'exposure' in parsed.sky, 'Copy parameters 的 JSON 里有草、天空（含曝光）、天气、配色、镜头');

  // 色调映射和曝光归 atmosphere
  const tone = await page.evaluate(async () => {
    const w = window.__world;
    const p = w.atmosphere.params;
    const before = w.renderer.toneMappingExposure;
    p.exposure = 1.5;
    await new Promise((r) => setTimeout(r, 200));
    const after = w.renderer.toneMappingExposure;
    p.exposure = 1;
    return { agx: w.renderer.toneMapping === 6, before, after }; // THREE.AgXToneMapping = 6
  });
  check(tone.agx, '主渲染器的色调映射是 AgX');
  check(Math.abs(tone.after / tone.before - 1.5) < 0.02, `曝光跟着 atmosphere.params.exposure（${tone.before.toFixed(2)} → ${tone.after.toFixed(2)}）`);

  // 星系视图：云海在所有星球下面
  const galaxy = await page.evaluate(() => {
    const w = window.__world;
    const sea = w.atmosphere.objects.sea;
    let lowest = Infinity;
    for (const e of w.planets.values()) lowest = Math.min(lowest, e.home.y - e.planet.radius);
    return { seaY: sea.position.y, lowest, visible: sea.visible };
  });
  check(galaxy.visible && galaxy.seaY < galaxy.lowest, `星系视图：云海（圆盘顶 y = ${galaxy.seaY.toFixed(1)}）压在所有星球（最低 ${galaxy.lowest.toFixed(1)}）下面`);

  // 进「你的星球」
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, you);
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, you, { timeout: 120000 });
  await page.waitForFunction(() => window.__walk?.state().ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(1800);
  const grassA = await page.evaluate(() => {
    const w = window.__world;
    const g = w.dressing.grass;
    window.__grassRef = g;
    const e = w.planets.get('lumen-guild');
    const sea = w.atmosphere.objects.sea;
    // 圆盘顶相对星球中心（沿 +Y）：应该回到星球附近（云顶在星球中心上下几十米以内）
    return { has: !!g, inScene: !!g?.object.parent, life: w.life.object.visible, seaRel: sea.position.y - e.home.y, R: e.planet.radius };
  });
  check(grassA.has && grassA.inScene, '进星球：草场挂在场景里');
  check(grassA.life, '进星球：生机层显示');
  check(Math.abs(grassA.seaRel) < grassA.R, `进星球：云海回到星球上（圆盘顶比星球中心高 ${grassA.seaRel.toFixed(1)} 米）`);

  // 漫游、走路：影响球、踩踏图、草在画
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.keyboard.down('w');
  await page.waitForTimeout(2500);
  const walking = await page.evaluate(() => {
    const w = window.__world;
    return { influence: w.life.influence.value.w, grass: w.dressing.grass.stats.instances, passes: w.life.stats().tramplePasses };
  });
  await page.keyboard.up('w');
  check(walking.influence > 0.5, `漫游：生机层收到角色（影响球半径 ${walking.influence.toFixed(2)} 米）`);
  check(walking.grass > 10000, `漫游：草在画（${walking.grass.toLocaleString('en-US')} 根）`);
  check(walking.passes > 5, `漫游：走路时踩踏图在盖章（累计 ${walking.passes} 个离屏 pass）`);
  const trampled = await page.evaluate(async () => {
    const w = window.__world;
    const rt = w.life.debug.trampleTarget;
    const px = await w.renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 40) n++;
    return n;
  });
  check(trampled > 3, `踩踏图上有被踩的像素（${trampled} 个）`);

  // 下雨：雨量平滑上升，天空收到，太阳变暗
  const sun0 = await page.evaluate(() => window.__world.atmosphere.sun.intensity);
  await page.evaluate(async () => { (await import('/src/scenes/world.ts')).WEATHER.rain = 1; });
  await page.waitForTimeout(1200);
  const rain1 = await page.evaluate(() => window.__world.atmosphere.rain);
  await page.waitForTimeout(5000);
  const rain2 = await page.evaluate(() => ({ rain: window.__world.atmosphere.rain, sun: window.__world.atmosphere.sun.intensity, life: window.__world.life.rain }));
  check(rain1 > 0.05 && rain1 < 0.9 && rain2.rain > 0.9, `下雨：雨量慢慢上来，天空收到（1.2 秒 ${rain1.toFixed(2)}，6.2 秒 ${rain2.rain.toFixed(2)}）`);
  check(rain2.sun < sun0 * 0.7, `下雨：太阳变暗（强度 ${sun0.toFixed(2)} → ${rain2.sun.toFixed(2)}）`);
  await page.evaluate(async () => { (await import('/src/scenes/world.ts')).WEATHER.rain = 0; });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__walk.state().phase === 'off', null, { timeout: 8000 });

  // 换到别的星球：草场还是同一个（setPlanet），走一走，草根贴在新星球的地面上
  await page.evaluate((t) => { location.hash = `#/t/${t}`; }, other);
  await page.waitForFunction((t) => document.querySelector('#app')?.dataset.planetReady === t, other, { timeout: 120000 });
  await page.waitForTimeout(1500);
  const same = await page.evaluate(() => window.__world.dressing.grass === window.__grassRef);
  check(same, '换星球：草场是同一个（只换星球数据，不新建网格和材质）');
  await page.locator('.topbar button.walk').click();
  await page.waitForFunction(() => window.__walk.state().phase === 'walk', null, { timeout: 8000 });
  await page.keyboard.down('w');
  await page.waitForTimeout(2000);
  await page.keyboard.up('w');
  await page.waitForTimeout(800);
  // 草场的中心在新星球上，画着的瓦片都在角色附近（瓦片中心方向和角色方向的夹角 < 草的半径 / 星球半径 + 余量）
  const rooted = await page.evaluate(() => {
    const w = window.__world;
    const g = w.dressing.grass;
    const e = w.planets.get('quiet-vertex');
    const V = w.rig.camera.position.constructor;
    const me = new V().copy(w.rig.camera.position).sub(e.home).normalize();
    let far = 0;
    const list = g.inspect();
    for (const t of list) {
      const f = t.frame;
      const p = new V(f[0] + 0.5 * f[3] + 0.5 * f[6], f[1] + 0.5 * f[4] + 0.5 * f[7], f[2] + 0.5 * f[5] + 0.5 * f[8]).normalize();
      far = Math.max(far, Math.acos(Math.min(1, p.dot(me))) * e.planet.radius);
    }
    return { n: list.length, centerOff: g.object.position.distanceTo(e.home), far, grass: g.stats.instances };
  });
  check(rooted.n > 0 && rooted.centerOff < 1e-3 && rooted.far < 45 && rooted.grass > 10000, `换星球后漫游：草跟着新星球（中心偏差 ${rooted.centerOff.toExponential(1)}，${rooted.n} 块瓦片都在镜头 ${rooted.far.toFixed(1)} 米以内，${rooted.grass.toLocaleString('en-US')} 根）`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__walk.state().phase === 'off', null, { timeout: 8000 });

  // 半径滑块：45 → 草按新半径重建；再拖回 30
  const rebuilt = await page.evaluate(async () => {
    const presets = await import('/src/planet/presets.ts');
    const before = window.__world.dressing.grass;
    presets.setPlanetRadius(45);
    await new Promise((r) => setTimeout(r, 1500));
    const after = window.__world.dressing.grass;
    const ok = after !== before && Math.abs(after.radius - 45) < 1e-6;
    presets.setPlanetRadius(30);
    await new Promise((r) => setTimeout(r, 1500));
    return { ok, back: Math.abs(window.__world.dressing.grass.radius - 30) < 1e-6 };
  });
  check(rebuilt.ok && rebuilt.back, '拖半径滑块：草按新半径重建（45），拖回 30 也一样');
} catch (e) {
  check(false, `没跑完：${e.message}`);
} finally {
  if (errors.length) console.log(`页面错误：\n${errors.join('\n')}`);
  const ok = results.every(([pass]) => pass) && errors.length === 0;
  console.log(ok ? 'I1 OK' : 'I1 FAIL');
  await browser.close();
  await server.close();
  process.exitCode = ok ? 0 : 1;
}

// LOD 有没有糊（A/B）：同一个机位、DPR 2、星球视图镜头离得最近（离星球中心 1.35 个半径，OrbitControls 的 minDistance，
// 离作品约 10 米），原文件（地址带 ?lod=0）和 LOD 各截一张，裁出作品那一块，左右拼在一起，再算逐像素差。
// 默认看有 LOD 的最重的三件 + 减得最多的一件；也可以写在参数里：node scripts/shot-lod.mjs ice-golem castle
// 输出 shots/lod-ab/<作品>-full.png、<作品>-lod.png、<作品>-ab.png（左原文件、右 LOD）
import { mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { launch, startServer, watchErrors } from './lib/browser.mjs';

const seed = JSON.parse(readFileSync('src/data/seed.json', 'utf8'));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['vintage-luggage-cart', 'ice-golem', 'vintage-car', 'weathered-rocket'];
const DPR = Number(process.env.DPR ?? 2);
const VIEW = { width: 1440, height: 900 };
const OUT = 'shots/lod-ab';
mkdirSync(OUT, { recursive: true });

// 开页进那颗星球，镜头放到离星球中心 1.35 个半径、大致正对这件作品（稍微往默认机位那边斜一点，像平时看的角度），截图并裁出作品
async function shoot(browser, base, team, id, lodOff) {
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: DPR });
  const errors = watchErrors(page);
  const models = [];
  page.on('request', (r) => { if (/\/models\//.test(r.url())) models.push(new URL(r.url()).pathname.replace(/^.*\/models\//, '')); });
  await page.goto(`${base}/?nolocal${lodOff ? '&lod=0' : ''}#/t/${team.id}`);
  await page.waitForFunction((t) => window.__ready === true && window.__app.routeIdle() && document.querySelector('#app')?.dataset.planetReady === t, team.id, { timeout: 120000 });
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4);
  const at = await page.evaluate(([t, w]) => {
    const world = window.__world;
    const entry = world.planets.get(t);
    const p = window.__app.teamPlanet(t).placements.find((x) => x.workId === w);
    const home = entry.home.clone();
    const dir = home.clone().set(...p.dir).normalize();
    const view = world.rig.camera.position.clone().sub(home).normalize();
    const camDir = dir.clone().multiplyScalar(0.8).addScaledVector(view, 0.2).normalize();
    const R = entry.planet.radius;
    world.rig.jump({ target: home, position: home.clone().addScaledVector(camDir, 1.35 * R), minDistance: 1.35 * R, maxDistance: 4 * R, autoRotate: false, minPolar: 0, maxPolar: Math.PI });
    return { R };
  }, [team.id, id]);
  await page.waitForTimeout(2500); // 地标放大跟着镜头高度慢慢变：等它停稳
  const pos = await page.evaluate((w) => window.__app.workScreenPos(w), id);
  const dist = await page.evaluate((w) => {
    const world = window.__world;
    const s = window.__app.workScreenPos(w);
    return s ? world.rig.camera.position.distanceTo(world.rig.controls.target) : null;
  }, id);
  const png = await page.screenshot();
  await page.close();
  const size = 760; // 裁多大（设备像素）
  const left = Math.max(0, Math.min(VIEW.width * DPR - size, Math.round(pos.x * DPR - size / 2)));
  const top = Math.max(0, Math.min(VIEW.height * DPR - size, Math.round(pos.y * DPR - size * 0.6)));
  const crop = await sharp(png).extract({ left, top, width: size, height: size }).png().toBuffer();
  return { crop, models, errors, dist, R: at.R };
}

const { server, base } = await startServer();
const browser = await launch();
try {
  for (const id of ids) {
    const team = seed.teams.find((t) => t.works.some((w) => w.id === id));
    if (!team) throw new Error(`种子数据里没有 ${id}`);
    const full = await shoot(browser, base, team, id, true);
    const lod = await shoot(browser, base, team, id, false);
    await sharp(full.crop).toFile(`${OUT}/${id}-full.png`);
    await sharp(lod.crop).toFile(`${OUT}/${id}-lod.png`);
    const meta = await sharp(full.crop).metadata();
    await sharp({ create: { width: meta.width * 2 + 8, height: meta.height, channels: 3, background: '#ffffff' } })
      .composite([{ input: full.crop, left: 0, top: 0 }, { input: lod.crop, left: meta.width + 8, top: 0 }])
      .png().toFile(`${OUT}/${id}-ab.png`);
    // 逐像素差（整块裁图；草、云在动，所以不会是 0）
    const a = await sharp(full.crop).removeAlpha().raw().toBuffer();
    const b = await sharp(lod.crop).removeAlpha().raw().toBuffer();
    let sum = 0;
    let big = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > 32) big++;
    }
    const usedFull = full.models.filter((m) => m.endsWith(`${id}.glb`));
    const usedLod = lod.models.filter((m) => m.endsWith(`${id}.glb`));
    console.log(`${id}（${team.id}）：镜头离星球中心 ${(full.dist / full.R).toFixed(2)} 个半径；原文件请求 ${usedFull.join(',')}；LOD 请求 ${usedLod.join(',')}；平均差 ${(sum / a.length).toFixed(2)} / 255，差 > 32 的通道 ${((100 * big) / a.length).toFixed(2)}%；页面错误 ${full.errors.length + lod.errors.length}`);
  }
} finally {
  await browser.close();
  await server.close();
}

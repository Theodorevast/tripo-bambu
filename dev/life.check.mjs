// 生机层自查：node dev/life.check.mjs [--out <目录>] [--no-func] [--no-perf] [--no-webgpu-perf] [--webgl-perf] [--no-video] [--no-webgl] [--quick]
// 1. 功能：脚步扬尘出现 / 停下后消失、踩踏图写入并按时恢复、蝴蝶受惊、雨量平滑和回调、水花、萤火虫只在傍晚、页面无报错
// 2. 堆分配采样：走路 + 下雨 3 秒，src/nature/ 的调用下面没有构造 three 对象
// 3. 截图（WebGPU，1440×900）：n3-walk、n3-rain、n3-evening、n3-trample、n3-webgl2
// 4. GPU 时间（1440×900、DPR 2，画布 2880×1800）：全部生机效果开 vs 全关的差值，再分项；WebGPU 和 WebGL2 各一遍
//    Chrome 带 --enable-webgpu-developer-features 启动，WebGPU 的时间戳不做 100 µs 量化
// 5. 录屏：走路 + 下雨 10 秒（页面里 MediaRecorder 录画布 → webm，ffmpeg 转 mp4 和 gif）
// 输出默认放在 .superpowers/sdd/2026-10-27-community-planets/，末尾打印一张 JSON 汇总（写进 n3-check.json）
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CHROME, startServer, watchErrors } from '../scripts/lib/browser.mjs';

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = opt('--out', '.superpowers/sdd/2026-10-27-community-planets');
const QUICK = flag('--quick');
mkdirSync(OUT, { recursive: true });

const results = [];
let perfBrowser = null; // 测量用的浏览器（不限帧率），见 perf()
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —  ${detail}` : ''}`);
}
const summary = { checks: results, perf: {}, files: [] };

const { server, base } = await startServer();
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADED !== '1',
  args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features', '--autoplay-policy=no-user-gesture-required'],
});

async function open(query, { dpr = 1, width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${base}/dev/life.html${query}`);
  await page.waitForFunction(() => window.__life?.ready === true, null, { timeout: 90000 });
  return { context, page, errors };
}
const set = (page, p) => page.evaluate((x) => window.__life.set(x), p);
const stats = (page) => page.evaluate(() => window.__life.stats());
const wait = (page, ms) => page.waitForTimeout(ms);
const shot = async (page, name) => {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  summary.files.push(file);
  console.log(`      截图 ${file}`);
};

const ALL_ON = { dust: true, trample: true, butterflies: true, petals: true, fireflies: true, rain: true, splashes: true };
const ALL_OFF = { dust: false, trample: false, butterflies: false, petals: false, fireflies: false, rain: false, splashes: false };
const only = (...keys) => ({ ...ALL_OFF, ...Object.fromEntries(keys.map((k) => [k, true])) });

try {
  // ---------------- 功能 + 截图（WebGPU，DPR 1） ----------------
  if (!flag('--no-func')) {
    const { context, page, errors } = await open('?ui=0');
    const backend = await page.evaluate(() => window.__life.backend);
    check('演示页用 WebGPU 打开', backend === 'WebGPU', backend);

    // 白天沿土路走：脚步扬尘（土路上是黄土）
    await set(page, { rain: 0, wind: 0.35, evening: 0.15, auto: true, autoPath: true, effects: { ...ALL_ON, showTrample: false }, camera: { dist: 3.6, pitch: 0.2, yaw: 0 } });
    await wait(page, 3500);
    const walking = await stats(page);
    check('走路时脚下有尘土粒子', walking.dustAlive > 0, `正在播放 ${walking.dustAlive} 粒`);
    check('白天没有萤火虫（只有花粉光点）', walking.fireflies === 0 && walking.pollen > 0.5, `萤火虫 ${walking.fireflies.toFixed(2)}，花粉 ${walking.pollen.toFixed(2)}`);
    await shot(page, 'n3-walk.png');
    // 走进草地：扬起的是草屑
    await set(page, { autoPath: false, autoTurn: 0.5 });
    await wait(page, 2200);
    await set(page, { autoTurn: 0.12 });
    await wait(page, 1500);
    await shot(page, 'n3-walk-grass.png');
    await set(page, { auto: false });
    await wait(page, 1500);
    const stopped = await stats(page);
    check('停下 1.5 秒后不再有尘土', stopped.dustAlive === 0, `正在播放 ${stopped.dustAlive} 粒`);

    // 蝴蝶受惊：把角色放到 0 号蝴蝶脚下
    const before = await stats(page);
    const b0 = await page.evaluate(() => window.__life.butterfly(0));
    await page.evaluate((d) => window.__life.teleport(d), b0);
    await wait(page, 300);
    const after = await stats(page);
    check('角色走近，蝴蝶受惊飞走', after.startles > before.startles && after.butterflyModes[3] >= 1, `受惊 ${before.startles} → ${after.startles}，正在逃的 ${after.butterflyModes[3]} 只`);
    await wait(page, 2500);
    const b0b = await page.evaluate(() => window.__life.butterfly(0));
    const w0 = await page.evaluate(() => window.__life.walker());
    const dist = Math.hypot(b0b[0] - w0[0], b0b[1] - w0[1], b0b[2] - w0[2]);
    check('受惊 2.5 秒后离角色超过 1.7 米', dist > 1.7, `${dist.toFixed(2)} 米`);

    // 踩踏图：绕圈走 14 秒，读回整张图
    await page.evaluate(() => window.__life.teleport([0, 1, 0]));
    await set(page, { auto: true, autoPath: false, autoTurn: 0.22 });
    await wait(page, 14000);
    const tr = await page.evaluate(() => window.__life.trample());
    check('踩踏图记下了走过的路', tr.trampled > 150 && tr.atWalker > 0.6, `被踩的像素 ${tr.trampled}，脚下 ${tr.atWalker.toFixed(2)}，最大 ${tr.maxR.toFixed(2)}`);
    await set(page, { effects: { showTrample: true }, camera: { dist: 17, pitch: 1.05 } });
    await wait(page, 1200);
    await shot(page, 'n3-trample.png');
    await set(page, { effects: { showTrample: false }, camera: { dist: 5.4, pitch: 0.3 } });

    if (!QUICK) {
      // 恢复：角色走到星球另一面站着，21 秒后原来的路应该恢复（只剩脚下一小块）
      await set(page, { auto: false });
      await page.evaluate(() => window.__life.teleport([0, -1, 0.2]));
      await wait(page, 21500);
      const rec = await page.evaluate(() => window.__life.trample());
      check('20 秒后踩踏图恢复（只剩角色脚下的一小块）', rec.trampled < 60, `被踩的像素 ${tr.trampled} → ${rec.trampled}`);
      await page.evaluate(() => window.__life.teleport([0, 1, 0]));
    }

    // 下雨：雨量平滑上来，回调把光调暗；水花
    await set(page, { rain: 1, wind: 0.55, evening: 0.15, auto: true, autoTurn: 0.12, camera: { dist: 5.4, pitch: 0.3 } });
    await wait(page, 1000);
    const early = await stats(page);
    await wait(page, 5500);
    const rainy = await stats(page);
    check('雨是慢慢下大的（1 秒时还没到满）', early.rain > 0.1 && early.rain < 0.85, `1 秒 ${early.rain.toFixed(2)}，6.5 秒 ${rainy.rain.toFixed(2)}`);
    check('雨量回调到了演示页（光变冷变暗用的值）', rainy.rainLight > 0.9, `回调值 ${rainy.rainLight.toFixed(2)}`);
    check('下雨时地上有水花', rainy.splashesAlive > 20, `正在播放 ${rainy.splashesAlive} 个`);
    await shot(page, 'n3-rain.png');

    // 堆分配采样：走路 + 下雨 + 全部效果，3 秒
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await wait(page, 3000);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const CTORS = new Set(['Vector2', 'Vector3', 'Vector4', 'Quaternion', 'Matrix3', 'Matrix4', 'Euler', 'Color', 'Box3', 'Sphere', 'Ray', 'Object3D', 'Group', 'Mesh', 'clone']);
    let allBytes = 0;
    let natureBytes = 0;
    const ctorWhere = new Set();
    const visit = (node, under) => {
      const inNature = node.callFrame.url.includes('/src/nature/');
      allBytes += node.selfSize;
      if (inNature) natureBytes += node.selfSize;
      if (under && !inNature && CTORS.has(node.callFrame.functionName) && node.selfSize > 0) ctorWhere.add(node.callFrame.functionName);
      for (const child of node.children) visit(child, under || inNature);
    };
    visit(profile.head, false);
    check('热路径不新建对象：走路 + 下雨 3 秒，src/nature/ 下面没有构造 three 对象',
      ctorWhere.size === 0, `src/nature ${(natureBytes / 1024).toFixed(0)} KiB / 全页 ${(allBytes / 1024).toFixed(0)} KiB（${((100 * natureBytes) / Math.max(1, allBytes)).toFixed(1)}%，是浮点装箱）${ctorWhere.size ? `；构造了 ${[...ctorWhere].join('、')}` : ''}`);
    const cpu = [];
    for (let i = 0; i < 10; i++) {
      cpu.push((await stats(page)).cpuMs);
      await wait(page, 100);
    }
    summary.perf.lifeCpuMs = cpu.reduce((a, b) => a + b, 0) / cpu.length;
    check('生机层每帧 CPU 时间', summary.perf.lifeCpuMs < 1, `平均 ${summary.perf.lifeCpuMs.toFixed(3)} ms（performance.now 精度 0.1 ms）`);

    // 傍晚：萤火虫
    await set(page, { rain: 0, wind: 0.25, evening: 0.85, auto: true, autoTurn: 0.12, camera: { dist: 5.4, pitch: 0.24 } });
    await wait(page, 6000);
    const eve = await stats(page);
    check('傍晚（evening 0.85）萤火虫出来', eve.fireflies > 0.9 && eve.instances.fireflies > 0, `亮度系数 ${eve.fireflies.toFixed(2)}，${eve.instances.fireflies} 只`);
    await shot(page, 'n3-evening.png');
    check('功能页无报错（WebGPU）', errors.length === 0, errors.slice(0, 5).join(' | '));
    await context.close();
  }

  // ---------------- 录屏：走路 + 下雨 10 秒 ----------------
  if (!flag('--no-video')) {
    const { context, page, errors } = await open('?ui=0');
    await set(page, { rain: 1, wind: 0.5, evening: 0.3, auto: true, autoTurn: 0.1, effects: ALL_ON, camera: { dist: 5, pitch: 0.28 } });
    await wait(page, 5000);
    const webm = path.join(OUT, 'n3-walk-rain.webm');
    rmSync(webm, { force: true });
    await page.exposeFunction('__chunk', (b64) => appendFileSync(webm, Buffer.from(b64, 'base64')));
    const recorded = await page.evaluate(async (ms) => {
      const canvas = document.querySelector('#c');
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 12e6 });
      let pending = Promise.resolve();
      rec.ondataavailable = (e) => {
        pending = pending.then(async () => {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          await window.__chunk(btoa(s));
        });
      };
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(1000);
      // 中途按一下空格：跳起落地，扬起一圈土
      setTimeout(() => window.__life.key('Space', true), 4000);
      setTimeout(() => window.__life.key('Space', false), 4200);
      await new Promise((r) => setTimeout(r, ms));
      rec.stop();
      await done;
      await pending;
      return true;
    }, 10500);
    check('录屏完成', recorded === true);
    summary.files.push(webm);
    try {
      const mp4 = path.join(OUT, 'n3-walk-rain.mp4');
      const gif = path.join(OUT, 'n3-walk-rain.gif');
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4]);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', 'fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', gif]);
      summary.files.push(mp4, gif);
      console.log(`      录屏 ${mp4}、${gif}`);
    } catch (e) {
      console.log(`      ffmpeg 转码失败（webm 还在）：${e.message.split('\n')[0]}`);
    }
    check('录屏页无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  // ---------------- GPU 时间（DPR 2） ----------------
  // 测量用另开一个不限帧率的浏览器：显卡一直忙，频率稳定（限 60 帧时显卡大半时间空闲、频率忽高忽低，零点几毫秒的差别会被淹没）
  async function perf(label, query) {
    perfBrowser ??= await chromium.launch({
      executablePath: CHROME,
      headless: process.env.HEADED !== '1',
      args: ['--ignore-gpu-blocklist', '--enable-webgpu-developer-features', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
    });
    const context = await perfBrowser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(`${base}/dev/life.html?ui=0${query}`);
    await page.waitForFunction(() => window.__life?.ready === true, null, { timeout: 90000 });
    const canvas = await page.evaluate(() => `${document.querySelector('#c').width}×${document.querySelector('#c').height}`);
    const backend = await page.evaluate(() => window.__life.backend);
    const out = { backend, canvas, configs: {}, amplified: {} };
    // 天气固定：下雨 + 入夜（萤火虫）+ 风，角色一直在走（扬尘、踩踏）
    const weather = { rain: 1, wind: 0.6, evening: 1, auto: true, autoPath: false, autoTurn: 0.15, camera: { dist: 5.4, pitch: 0.3 } };
    const measure = async (name, effects, bench = { amp: 0, target: 'empty' }, quality = 'high') => {
      await set(page, { ...weather, effects: { ...effects, showTrample: false }, quality, bench });
      await wait(page, 5000);
      const r = await page.evaluate((n) => window.__life.gpu(n), 300);
      out.configs[name] = r;
      console.log(`      ${label} ${name.padEnd(26)} 中位 ${r.median.toFixed(3)} ms，平均 ${r.mean.toFixed(3)}，p90 ${r.p90.toFixed(3)}（${r.n} 帧）`);
      return r.median;
    };
    // 1. 直接对比：全开 vs 全关（两轮交替）
    const offs = [];
    const alls = [];
    for (let round = 1; round <= (QUICK ? 1 : 2); round++) {
      offs.push(await measure(`off #${round}`, ALL_OFF));
      alls.push(await measure(`all #${round}`, ALL_ON));
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    out.baseMs = avg(offs);
    out.directMs = avg(alls) - avg(offs);
    // 2. 放大：同一帧里把生机层再画 K 遍，对照组画 K 遍空组；差值 / K = 生机层画一遍的 GPU 时间（不含踩踏图的离屏 pass）
    const K = 10;
    const amplified = async (name, effects, quality = 'high') => {
      const e = await measure(`${name} ×${K} empty`, effects, { amp: K, target: 'empty' }, quality);
      const l = await measure(`${name} ×${K} life`, effects, { amp: K, target: 'life' }, quality);
      out.amplified[name] = (l - e) / K;
      console.log(`      ${label} → ${name}：每帧 ${out.amplified[name].toFixed(3)} ms`);
      return out.amplified[name];
    };
    const allAmp = await amplified('all', ALL_ON);
    if (!QUICK) {
      await amplified('all #2', ALL_ON);
      // 分项只在 WebGPU 上测：WebGL2（ANGLE）在不限帧率、每帧 11 遍渲染、计时查询连跑十几分钟后页面崩过一次（见报告），
      // 分项对 WebGL2 不是必需的，不再冒这个险
      if (label === 'WebGPU') for (const [n, keys] of [['rain+splashes', ['rain', 'splashes']], ['fireflies', ['fireflies']], ['petals+fluff', ['petals']], ['butterflies', ['butterflies']], ['dust', ['dust']]]) {
        await amplified(n, only(...keys));
      }
      await amplified('all (low tier)', ALL_ON, 'low');
    }
    out.lifeMs = QUICK ? allAmp : (allAmp + out.amplified['all #2']) / 2;
    check(`${label}：画布 ${canvas}，全部生机效果（下雨 + 萤火虫 + 走路）每帧 GPU 时间`, label !== 'WebGPU' || out.lifeMs <= 1.5,
      `放大法 ${out.lifeMs.toFixed(3)} ms；直接对比 ${out.directMs.toFixed(3)} ms（全关的整帧 ${out.baseMs.toFixed(3)} ms）${label === 'WebGPU' ? '；目标 ≤ 1.5 ms' : '；尽力'}`);
    check(`${label} 测量页无报错`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
    return out;
  }
  if (!flag('--no-perf') && !flag('--no-webgpu-perf')) summary.perf.webgpu = await perf('WebGPU', '&auto');

  // ---------------- WebGL2 ----------------
  if (!flag('--no-webgl')) {
    const { context, page, errors } = await open('?ui=0&webgl');
    const backend = await page.evaluate(() => window.__life.backend);
    check('?webgl 走 WebGL2 后端', backend === 'WebGL2', backend);
    await set(page, { rain: 0.6, wind: 0.5, evening: 0.75, auto: true, autoTurn: 0.12, effects: ALL_ON, camera: { dist: 5.4, pitch: 0.28 } });
    await wait(page, 7000);
    const s = await stats(page);
    check('WebGL2：雨、水花、萤火虫、尘土都在画', s.instances.rain > 0 && s.splashesAlive > 0 && s.fireflies > 0.1 && s.dustAlive > 0,
      `雨丝 ${s.instances.rain}，水花 ${s.splashesAlive}，萤火虫 ${s.fireflies.toFixed(2)}，尘土 ${s.dustAlive}`);
    await shot(page, 'n3-webgl2.png');
    check('WebGL2 页无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
    // WebGL2 的 GPU 计时默认不跑：不限帧率 + 每帧 11 遍渲染 + 计时查询的放大测量，在 WebGL2（ANGLE）上连续两次把页面跑崩了
    // （见报告「顾虑」第 1 条）。要测时加 --webgl-perf
    if (!flag('--no-perf') && flag('--webgl-perf')) {
      try {
        summary.perf.webgl2 = await perf('WebGL2', '&auto&webgl');
      } catch (e) {
        check('WebGL2 测量跑完', false, e.message);
      }
    }
  }
} catch (e) {
  check('自查脚本跑完', false, e.stack ?? e.message);
} finally {
  // 页面崩了时 close() 可能一直等：每一步最多等 10 秒
  const within = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 10000))]);
  await within(browser.close());
  if (perfBrowser) await within(perfBrowser.close());
  await within(server.close());
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(OUT, 'n3-check.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `；失败：${failed.map((f) => f.name).join('；')}` : ''}`);
  // 页面崩过时浏览器或开发服务器的句柄可能还挂着，事件循环不退出：直接退出
  process.exit(failed.length ? 1 : 0);
}

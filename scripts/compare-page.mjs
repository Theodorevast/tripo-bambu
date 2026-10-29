// 第一版 / 第二版对比页（v2-compare）：把 compare-shots.mjs 截的两组图配上说明，生成一个自包含的 HTML（图片、字体都在同一个文件夹里，相对路径）。
// node scripts/compare-page.mjs <截图目录> <输出目录 compare> [性能 json]
//   截图目录里是 v1-*.png、v2-*.png（compare-shots.mjs 的输出）；转成 JPEG 放进 <输出目录>/img/，字体从 src/assets/fonts 复制到 <输出目录>/fonts/
//   性能 json 是 compare-perf.mjs 的输出（{ v1: …, v2: … }）；没有的数字写「待测」，不编
// 页面本身用第二版的样子：深色底（Midnight → Indigo）、细香槟金线、Cinzel 标题、Cormorant Garamond 正文、Inter 小字和数字
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const [shotDir, outDir, perfFile] = process.argv.slice(2);
if (!shotDir || !outDir) {
  console.log('用法：node scripts/compare-page.mjs <截图目录> <输出目录> [性能 json]');
  process.exit(1);
}
mkdirSync(join(outDir, 'img'), { recursive: true });
mkdirSync(join(outDir, 'fonts'), { recursive: true });
for (const f of ['Cinzel-var.woff2', 'CormorantGaramond-var.woff2', 'CormorantGaramond-italic-var.woff2', 'Inter-var.woff2', 'OFL-cinzel.txt', 'OFL-cormorantgaramond.txt', 'OFL-inter.txt']) {
  copyFileSync(join('src/assets/fonts', f), join(outDir, 'fonts', f));
}

// 每一组：截图的名字、标题（英文用 Cinzel、中文副标题）、一句说明（这一处改了什么、为什么，方向见 art-direction.md）
const GROUPS = [
  { key: '01-boot', en: 'Loading', zh: '启动画面', text: '奶油色的卡通云和像素翠宝，换成夜空渐变和满天细星：正中是一个细金色的天体仪环（里面是 Tripo 的标志），标题用 Cinzel 大写、字距拉开，「Gathering planets…」用 Cormorant 斜体，三个阶段前面的小图标是月相。打开页面的第一眼就是「午夜的天文台」，不再是玩具感。' },
  { key: '02-home', en: 'Galaxy · Front', zh: '首页正面', text: '星系浮在夜空里：云海压成一层冷灰紫、低对比的月光云（只做舞台），云缝里透出满天细星，空气里飘着很稀的星屑，右上角一弯月牙。旋臂的星尘换成香槟金和星光白；你的星球周围三圈细金的天体仪环，同一条旋臂上的星球连成淡淡的星座线；云朵翠宝换成用星点和细线画的「星座翠宝」。标题卡片是深靛蓝半透明面板配细金边，名牌去掉了胶囊底，Cinzel 的星球名。用户说第一版「太幼稚」：去掉奶油色的云和饱和的暖黄，换成成熟、克制的夜色和细金线。' },
  { key: '03-home-side', en: 'Galaxy · Turned', zh: '首页侧面（转 90°）', text: '镜头绕星系转过去：星空跟着转，月亮钉在画面上的一个位置、不挡星系。星球降了饱和、更哑光，背光一侧带一道冷色边光，从夜色里跳出来；天体仪环跟着你的星球慢慢转。' },
  { key: '04-claim', en: 'Coupon', zh: '领券窗口', text: '点右下角的翠宝吐券：卡通票根换成一张烫金卡片，深色底配金线，面额用衬线字；Tripo 黄只留在品牌标志和「Claim on Tripo」按钮上，面积很小。品牌要露出，但要体面。（券是随机的，两边抽到的不是同一张。）' },
  { key: '05-planet', en: 'Planet', zh: '星球页', text: '默认的光换成「蓝调时刻」：主光冷白、天光偏冷，背光一侧一道冷色补光让星球的轮廓从云海里跳出来，近处不起雾。地表换成大地色（Sage、Moss、Stone），草不再是荧光绿，水偏灰蓝；展台换成石座加一圈细金，路边立着几盏石灯柱。作品区域的平均亮度约是第一版的九成，作品依然是主角。' },
  { key: '06-hop', en: 'Hop', zh: '跳星球的转场（中间那一刻）', text: '甩镜跳星球时盖住画面的云是月光下的冷灰紫；第一版扫过的一宽一窄两道翠宝黄光带，改成一条扫过的香槟金细线，后面跟着一串一闪一闪的星屑。节奏、时长、时刻都没变。' },
  { key: '07-walk', en: 'Walk', zh: '漫游近景', text: '走在星球上抬头是有星星和月牙的夜空，云海在月光下泛一圈很淡的银边；草是灰绿，土路上铺着磨圆的踏石，萤火虫是贴着草飞的细小暖白光点。轻中古只做点缀（石灯柱、立石、矮石塔），不要城堡。' },
  { key: '08-members', en: 'Members', zh: 'Members', text: '成员页从奶油色的卷轴换成画廊：深靛蓝面板、一圈细金边和四角的小星点，Cinzel 的标题；成员卡片是 Ivory 的底，头像框是克制的尖拱，名字用衬线字。没有厚投影、粗圆角和波浪下划线。' },
  { key: '09-museum', en: 'Museum', zh: 'Museum', text: '作品墙换成画廊：深色面板上一排 Ivory 的作品卡，顶上尖拱，作品名用 Cormorant，编号和面数用很小的 Inter，像一本精装画册的排版。' },
  { key: '10-viewer', en: 'Viewer', zh: '作品查看器', text: '查看器跟着画廊的样子：作品放在一块 Ivory 的展板上，旁边是深靛蓝、细金边的说明卡，作品名用 Cormorant，操作提示用 Inter 小字。' },
  { key: '11-create-look', en: 'Create · Step 2', zh: '造星窗口第 2 步（选样子）', text: '造星的四个步骤用月相表示（新月 → 上弦 → 满月 → 下弦）；选样子这一步的五种星球是大地色，色块、开关、按钮都是细线和小圆角，预览框是一圈细金的环，不是糖果色。' },
  { key: '12-create-burst', en: 'Create · Launch', zh: '造星：冲出来的那一刻', text: '新星球从月光下的云海里冲出来，星尘是香槟金，远处挂着月亮；动作的节奏和第一版一样。' },
];
const MOBILE = [
  { key: 'm1-home', zh: '首页' },
  { key: 'm2-planet', zh: '星球页' },
  { key: 'm3-museum', zh: 'Museum' },
];

async function toJpeg(name) {
  const out = [];
  for (const v of ['v1', 'v2']) {
    const src = join(shotDir, `${v}-${name}.png`);
    const file = `img/${v}-${name}.jpg`;
    // 没有新截的图、但页面文件夹里已经有转好的：照用（只想更新性能数字时，不用重新截图）
    if (!existsSync(src)) { out.push(existsSync(join(outDir, file)) ? file : null); continue; }
    await sharp(src).jpeg({ quality: 84, mozjpeg: true }).toFile(join(outDir, file));
    out.push(file);
  }
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cell = (file, label) => (file ? `<figure><figcaption>${esc(label)}</figcaption><img src="${file}" alt="${esc(label)}" loading="lazy"></figure>` : `<figure class="missing"><figcaption>${esc(label)}</figcaption><div>待截</div></figure>`);

const perf = perfFile && existsSync(perfFile) ? JSON.parse(readFileSync(perfFile, 'utf8')) : {};
const num = (v, unit = ' ms') => (v === null || v === undefined || Number.isNaN(v) ? '<span class="tbd">待测</span>' : `${v}${unit}`);
const med = (xs) => (Array.isArray(xs) && xs.filter((x) => typeof x === 'number').length ? Math.round([...xs].filter((x) => typeof x === 'number').sort((a, b) => a - b)[Math.floor(xs.filter((x) => typeof x === 'number').length / 2)] * 1000) / 1000 : null);
const tr = (p, kind) => p?.transitions?.find((t) => t.label === kind) ?? null;
const g1 = med(perf.v1?.homeGpu);
const g2 = med(perf.v2?.homeGpu);
const delta = g1 !== null && g2 !== null ? `+${Math.round((g2 - g1) * 1000) / 1000}` : null;

const rows = [];
for (const g of GROUPS) {
  const [a, b] = await toJpeg(g.key);
  rows.push(`<section class="pair">
  <header><span class="no">${esc(g.key.slice(0, 2))}</span><h2>${esc(g.en)}</h2><p class="zh">${esc(g.zh)}</p></header>
  <div class="two">${cell(a, '第一版')}${cell(b, '第二版')}</div>
  <p class="note">${esc(g.text)}</p>
</section>`);
}
const mobile = [];
for (const m of MOBILE) {
  const [a, b] = await toJpeg(m.key);
  mobile.push(`<div class="mob"><p class="zh">${esc(m.zh)}</p><div class="two">${cell(a, '第一版')}${cell(b, '第二版')}</div></div>`);
}

const gl1 = perf.v1?.homeGpuWebgl2 ?? null;
const gl2 = perf.v2?.homeGpuWebgl2 ?? null;
const perfRows = [
  ['首页每帧 GPU 时间（p50，WebGPU）', num(g1), num(g2), delta ? `第二版多 ${delta} ms` : '每帧所有渲染加起来的 GPU 时间戳，取中位数'],
  ['首页每帧 GPU 时间（p50，WebGL2）', num(gl1), num(gl2), gl1 !== null && gl2 !== null ? `第二版多 +${Math.round((gl2 - gl1) * 1000) / 1000} ms` : ''],
  ['首页静止帧间隔（中位 / 最长）', perf.v1?.homeIdle ? `${perf.v1.homeIdle.p50} / ${perf.v1.homeIdle.max} ms` : num(null), perf.v2?.homeIdle ? `${perf.v2.homeIdle.p50} / ${perf.v2.homeIdle.max} ms` : num(null), '要求：平时 ≤ 17 ms，最长 ≤ 33 ms'],
  ['进星球（穿云）最长帧', num(tr(perf.v1, 'enter')?.max ?? null), num(tr(perf.v2, 'enter')?.max ?? null), '要求 ≤ 33 ms'],
  ['跳星球最长帧', num(tr(perf.v1, 'hop')?.max ?? null), num(tr(perf.v2, 'hop')?.max ?? null), '要求 ≤ 33 ms'],
  ['回星系最长帧', num(tr(perf.v1, 'leave')?.max ?? null), num(tr(perf.v2, 'leave')?.max ?? null), ''],
];
const when = perf.v2?.at ?? perf.v1?.at ?? null;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Community Planets · 第一版 / 第二版</title>
<style>
@font-face { font-family: 'Cinzel'; src: url('fonts/Cinzel-var.woff2') format('woff2'); font-weight: 400 900; font-display: swap; }
@font-face { font-family: 'Cormorant Garamond'; src: url('fonts/CormorantGaramond-var.woff2') format('woff2'); font-weight: 300 700; font-display: swap; }
@font-face { font-family: 'Cormorant Garamond'; src: url('fonts/CormorantGaramond-italic-var.woff2') format('woff2'); font-weight: 300 700; font-style: italic; font-display: swap; }
@font-face { font-family: 'Inter'; src: url('fonts/Inter-var.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
:root { --midnight: #0f1530; --indigo: #1b2348; --dusk: #3a3866; --gold: #d8c08e; --gold-deep: #a8894f; --star: #f6f1e7; --ivory: #efe8db; --mauve: #6f6488; }
* { box-sizing: border-box; }
html { background: var(--midnight); }
body { margin: 0; color: var(--star); font-family: 'Cormorant Garamond', Georgia, serif; font-size: 19px; line-height: 1.6;
  background: radial-gradient(ellipse at 50% -10%, rgba(58, 56, 102, 0.55), transparent 60%), linear-gradient(180deg, var(--midnight) 0%, var(--indigo) 55%, var(--midnight) 100%); min-height: 100vh; }
.wrap { max-width: 1680px; margin: 0 auto; padding: 72px 48px 96px; }
.hero { text-align: center; margin-bottom: 72px; }
.hero .kicker { font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.32em; text-transform: uppercase; color: var(--gold); }
.hero h1 { font-family: 'Cinzel', serif; font-weight: 500; font-size: 44px; letter-spacing: 0.16em; text-transform: uppercase; margin: 18px 0 10px; }
.hero .tag { font-style: italic; font-size: 24px; color: rgba(246, 241, 231, 0.82); margin: 0; }
.rule { display: flex; align-items: center; gap: 14px; justify-content: center; margin: 28px auto 0; max-width: 520px; }
.rule::before, .rule::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--gold), transparent); opacity: 0.7; }
.rule span { color: var(--gold); font-size: 14px; }
.legend { display: flex; justify-content: center; gap: 40px; margin-top: 26px; font-family: 'Inter', sans-serif; font-size: 13px; letter-spacing: 0.12em; color: rgba(246, 241, 231, 0.7); }
.pair { margin: 0 0 84px; }
.pair header { display: flex; align-items: baseline; gap: 18px; border-bottom: 1px solid rgba(216, 192, 142, 0.35); padding-bottom: 10px; margin-bottom: 18px; }
.pair .no { font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 0.2em; color: var(--gold-deep); }
.pair h2 { font-family: 'Cinzel', serif; font-weight: 500; font-size: 22px; letter-spacing: 0.16em; text-transform: uppercase; margin: 0; }
.pair .zh, .mob .zh { margin: 0; font-size: 18px; color: rgba(246, 241, 231, 0.75); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
figure { margin: 0; position: relative; border: 1px solid rgba(216, 192, 142, 0.32); border-radius: 4px; overflow: hidden; background: rgba(15, 21, 48, 0.6); }
figure img { display: block; width: 100%; height: auto; }
figcaption { display: block; padding: 7px 12px; font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 0.22em; color: var(--gold); background: rgba(15, 21, 48, 0.9); border-bottom: 1px solid rgba(216, 192, 142, 0.3); }
figure.missing div { aspect-ratio: 16 / 10; display: grid; place-items: center; color: var(--mauve); font-family: 'Inter', sans-serif; letter-spacing: 0.2em; }
.note { max-width: 1100px; margin: 16px 0 0; color: rgba(246, 241, 231, 0.88); }
.mobiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; }
.mob .two { gap: 10px; margin-top: 10px; }
h3.section { font-family: 'Cinzel', serif; font-weight: 500; font-size: 26px; letter-spacing: 0.18em; text-transform: uppercase; text-align: center; margin: 96px 0 8px; }
p.section-sub { text-align: center; font-style: italic; margin: 0 0 36px; color: rgba(246, 241, 231, 0.75); }
table { width: 100%; border-collapse: collapse; font-family: 'Inter', sans-serif; font-size: 14px; }
th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid rgba(216, 192, 142, 0.22); vertical-align: top; }
th { font-weight: 500; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); }
td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.d { color: rgba(246, 241, 231, 0.7); }
.tbd { color: var(--mauve); letter-spacing: 0.1em; }
.foot { margin-top: 22px; font-family: 'Inter', sans-serif; font-size: 12px; line-height: 1.7; color: rgba(246, 241, 231, 0.6); }
@media (max-width: 900px) { .wrap { padding: 40px 16px 64px; } .two { grid-template-columns: 1fr; } .mobiles { grid-template-columns: 1fr; } .hero h1 { font-size: 30px; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div class="kicker">Version One · Version Two</div>
    <h1>Community Planets</h1>
    <p class="tag">第一版 · 第二版 —— 从绘本里的白天，到午夜的天文台</p>
    <div class="rule"><span>✦</span></div>
    <div class="legend"><span>左：第一版（int/v6）</span><span>右：第二版（v2-medieval）</span><span>同样的画面、同样的时刻 · ?nolocal</span></div>
  </div>
${rows.join('\n')}
  <h3 class="section">On a Phone</h3>
  <p class="section-sub">390 × 844</p>
  <div class="mobiles">
${mobile.join('\n')}
  </div>
  <h3 class="section">Performance</h3>
  <p class="section-sub">1440 × 900、像素比 2（画布 2880 × 1800）</p>
  <table>
    <thead><tr><th>项目</th><th>第一版</th><th>第二版</th><th>说明</th></tr></thead>
    <tbody>
${perfRows.map(([a, b, c, d]) => `      <tr><td>${a}</td><td class="n">${b}</td><td class="n">${c}</td><td class="d">${d}</td></tr>`).join('\n')}
    </tbody>
  </table>
  <p class="foot">两版都是构建版（第一版 int/v6，第二版 v2-medieval），开页带 ?nolocal（种子里的占位作品）。${when ? `量的时间：${esc(when.replace('T', ' ').slice(0, 16))}（UTC）。` : ''}
  同一台机器上别的进程也在用 GPU、CPU：帧间隔偶尔会有一两帧长帧，出现的时刻每次不一样；GPU 时间是每帧所有渲染加起来的时间戳，取中位数。没量到的数字写「待测」。</p>
  <p class="foot">另外，天空和后期（v2-sky）在同一个第二版构建里开关量过自己加的那部分（首页，2880 × 1800，每组 3 遍取中位数）：WebGPU 夜空 +0.179 ms、空气里的星屑 +0.002 ms、泛光 + 胶片颗粒 +0.058 ms，合计 +0.239 ms；WebGL2 合计 +0.250 ms。</p>
</div>
</body>
</html>
`;
writeFileSync(join(outDir, 'index.html'), html);
console.log(`对比页：${join(outDir, 'index.html')}`);

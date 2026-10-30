// Tripo 生成测速（真实额度！）：通过本地的 /api/tripo 中转，一个一个地建文字任务，记下每个任务
// 从提交到 success 的时间、Tripo 的进度时间线、结果文件大小（和面数、glTF 扩展）、下载耗时、预览图、扣了多少积分（每个任务前后各查一次余额），
// 最后在终端打一张表，并把 JSON 和 Markdown 表写到 .tmp/bench/。测出来的中位数填进 server/tripo/handler.mjs 的 ETA_SEC。
//
// 这个脚本自己没有密钥：密钥只在中转里（中转从 .env.local 读），脚本只和中转说话，也不会打印任何环境变量。
// 中转是模拟模式（health 的 mock: true）时照样能跑：数字是假的，用来先把脚本走一遍。
//
// 安全：
// - 中转是真实模式时，必须同时有 REAL=1 和 --yes，否则只打印计划就退出
// - 任务一个一个建（不并发，免得互相拖慢）；最多 --max-tasks 个（默认、上限都是 8）
// - 计划的积分合计超过 --max-credits（默认、上限都是 200）就不开始；每个任务开始前再算一次：已经花的 + 这个任务的预计超了就停；
//   余额比开始时少了超过上限也立刻停
// - 默认只连本机（localhost / 127.0.0.1）的中转：不会误打到线上的站点
//
// 用法（在主目录，先起一个真实模式、放宽了每 IP 上限的本地中转，见 docs/TRIPO.md 10.10）：
//   node scripts/bench-tripo.mjs --base http://127.0.0.1:8790/api/tripo --dry-run      只看计划和预计积分
//   REAL=1 node scripts/bench-tripo.mjs --base http://127.0.0.1:8790/api/tripo --yes   真的跑
// 选项：--only 1,4,6（只跑这几行）、--max-tasks N、--max-credits N、--prompt "…"、--poll-ms 1000、--timeout-s 600、
//       --save-glb（结果文件也存到 .tmp/bench/）、--out DIR、--allow-remote（允许连非本机的中转，一般不要）
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HARD_MAX_TASKS = 8; // 用户同意的上限：最多 8 个任务
const HARD_MAX_CREDITS = 200; // 最多 200 积分（2 美元）
const PROMPT = 'a small wooden treasure chest with brass corners';
// 中转没有 /models、或者目录里没有这个版本的积分时用的价目（Tripo 价目表，文字生成；1 积分 = 0.01 美元）
const FALLBACK_CREDITS = { none: 10, fast: 20, standard: 20 };
const FALLBACK_CREDITS_P1 = { none: 30, standard: 40 };

// 默认的测速矩阵：8 个文字任务，预计 170 积分。顺序按重要性排（中途停了也先拿到最要紧的几个）：
// 默认的路子（v3.1 + 快速贴图）→ 标准贴图（带 PBR）→ 以前的做法（不限面数）→ 不带贴图 → 另外两个 H 版本 → 压缩几何 → P1
// texture：none / fast / standard；faceLimit 不写 = 中转的默认（30 万），0 = 不限；compress: true = compress: geometry
export const MATRIX = [
  { id: 1, model: 'v3.1-20260211', texture: 'fast', note: '默认：H3.1 + 快速贴图（不带 PBR），30 万面' },
  { id: 2, model: 'v3.1-20260211', texture: 'standard', note: '标准贴图（带 PBR）' },
  { id: 3, model: 'v3.1-20260211', texture: 'standard', faceLimit: 0, note: '以前的做法：标准贴图、不限面数（对照下载大小）' },
  { id: 4, model: 'v3.1-20260211', texture: 'none', note: '不带贴图' },
  { id: 5, model: 'v3.0-20250812', texture: 'fast', note: 'H3.0 + 快速贴图' },
  { id: 6, model: 'v2.5-20250123', texture: 'fast', note: 'H2.5 + 不带 PBR 的贴图' },
  { id: 7, model: 'v3.1-20260211', texture: 'fast', compress: true, note: '压缩几何（meshopt）：看扩展名、大小' },
  { id: 8, model: 'P1-20260311', texture: 'standard', note: 'P1 低模（中转要放行 P1-20260311）' },
];

// —— 参数 ——
function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) out.values[k] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['base', 'only', 'max-tasks', 'max-credits', 'prompt', 'poll-ms', 'timeout-s', 'out'].includes(k)) out.values[k] = argv[++i];
    else out.flags.add(k);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = String(args.values.base ?? 'http://127.0.0.1:8790/api/tripo').replace(/\/+$/, '');
const DRY = args.flags.has('dry-run');
const YES = args.flags.has('yes');
const REAL = process.env.REAL === '1';
const SAVE_GLB = args.flags.has('save-glb');
const OUT_DIR = String(args.values.out ?? '.tmp/bench');
const POLL_MS = Math.max(500, Number(args.values['poll-ms'] ?? 1000) || 1000);
const TIMEOUT_MS = Math.max(60, Number(args.values['timeout-s'] ?? 600) || 600) * 1000;
const MAX_TASKS = Math.min(HARD_MAX_TASKS, Math.max(1, Math.floor(Number(args.values['max-tasks'] ?? HARD_MAX_TASKS) || HARD_MAX_TASKS)));
const MAX_CREDITS = Math.min(HARD_MAX_CREDITS, Math.max(1, Number(args.values['max-credits'] ?? HARD_MAX_CREDITS) || HARD_MAX_CREDITS));
const PROMPT_TEXT = String(args.values.prompt ?? PROMPT);
const ONLY = args.values.only ? new Set(String(args.values.only).split(',').map((s) => Number(s.trim())).filter(Number.isFinite)) : null;

if (Number(args.values['max-tasks']) > HARD_MAX_TASKS) console.warn(`--max-tasks 最多 ${HARD_MAX_TASKS}（改脚本里的 HARD_MAX_TASKS 才能更多），按 ${HARD_MAX_TASKS} 算`);
if (Number(args.values['max-credits']) > HARD_MAX_CREDITS) console.warn(`--max-credits 最多 ${HARD_MAX_CREDITS}，按 ${HARD_MAX_CREDITS} 算`);

const local = (() => {
  try {
    const h = new URL(BASE).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
})();
if (!local && !args.flags.has('allow-remote')) {
  console.error(`只连本机的中转（--base ${BASE} 不是 localhost / 127.0.0.1）。确实要连别处就加 --allow-remote`);
  process.exit(2);
}

// —— 小工具 ——
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n == null ? '—' : `${(n / 1048576).toFixed(1)} MB`);
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const now = () => performance.now();

async function call(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

async function balance() {
  const r = await call('GET', '/balance');
  if (r.status !== 200 || !r.json?.ok) throw new Error(`查余额失败：HTTP ${r.status} ${r.json?.code ?? ''} ${r.json?.message ?? ''}`);
  return { balance: Number(r.json.balance), frozen: Number(r.json.frozen) || 0 };
}

// 中转的请求体：texture 档换成中转认的字段
function taskBody(row) {
  const body = { mode: 'text', prompt: PROMPT_TEXT, modelVersion: row.model };
  if (row.texture === 'none') body.texture = false;
  else {
    body.texture = true;
    if (row.texture === 'fast') body.textureQuality = 'fast';
  }
  if (row.faceLimit !== undefined) body.faceLimit = row.faceLimit;
  if (row.compress !== undefined) body.compress = row.compress;
  return body;
}

// GLB 的 JSON 块：面数（三角形图元的索引数 / 3，没有索引按顶点数）、扩展、贴图格式。只读头，不用 gltf-transform
function inspectGlb(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) return { error: '不是 GLB' };
    const len = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
    let triangles = 0;
    for (const mesh of json.meshes ?? []) {
      for (const p of mesh.primitives ?? []) {
        if ((p.mode ?? 4) !== 4) continue;
        const acc = p.indices !== undefined ? json.accessors?.[p.indices] : json.accessors?.[p.attributes?.POSITION];
        triangles += Math.floor((acc?.count ?? 0) / 3);
      }
    }
    return {
      triangles,
      extensions: json.extensionsUsed ?? [],
      required: json.extensionsRequired ?? [],
      images: (json.images ?? []).map((i) => i.mimeType ?? '?'),
      generator: json.asset?.generator ?? '',
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function download(route, saveAs) {
  const t0 = now();
  const res = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) return { ok: false, status: res.status, ms: now() - t0 };
  const chunks = [];
  let bytes = 0;
  for await (const c of res.body) {
    chunks.push(c);
    bytes += c.byteLength;
  }
  const ms = now() - t0;
  const all = Buffer.concat(chunks);
  if (saveAs) writeFileSync(saveAs, all);
  return { ok: true, status: res.status, ms, bytes, type: res.headers.get('content-type') ?? '', data: all };
}

// 任务做完以后余额要过一会儿才从冻结转成扣掉：等 frozen 回到任务前的数（最多 20 秒）
async function settledBalance(frozenBefore) {
  let b = await balance();
  for (let i = 0; i < 10 && b.frozen > frozenBefore + 0.001; i++) {
    await sleep(2000);
    b = await balance();
  }
  return b;
}

// —— 开始 ——
const health = await call('GET', '/health').catch((err) => ({ status: 0, json: null, err }));
if (health.status !== 200 || !health.json?.ok) {
  console.error(`连不上中转 ${BASE}/health（HTTP ${health.status}${health.err ? `，${health.err.message}` : ''}）。先按 docs/TRIPO.md 10.10 起本地中转`);
  process.exit(2);
}
const MOCK = health.json.mock === true;
const modelsRes = await call('GET', '/models').catch(() => null);
const catalog = modelsRes?.status === 200 && Array.isArray(modelsRes.json?.models) ? modelsRes.json.models : null;

function expectedCredits(row) {
  const m = catalog?.find((x) => x.id === row.model);
  const fromCatalog = m?.credits?.text?.[row.texture];
  if (typeof fromCatalog === 'number') return fromCatalog;
  return (row.model.startsWith('P1') ? FALLBACK_CREDITS_P1 : FALLBACK_CREDITS)[row.texture] ?? 20;
}

// 计划：只留中转放行了的版本（/models 拿不到时都留着），再按 --only、--max-tasks 截
const skipped = [];
let plan = MATRIX.filter((r) => !ONLY || ONLY.has(r.id)).filter((r) => {
  if (catalog && !catalog.some((m) => m.id === r.model)) {
    skipped.push(`${r.id}（${r.model} 没在中转的放行列表里：起中转时把它加进 TRIPO_MODEL_VERSIONS）`);
    return false;
  }
  return true;
});
plan = plan.slice(0, MAX_TASKS).map((r) => ({ ...r, credits: expectedCredits(r) }));
const planned = plan.reduce((s, r) => s + r.credits, 0);

console.log(`\nTripo 测速 · 中转 ${BASE} · ${MOCK ? '模拟模式（数字是假的）' : '真实模式（花真的积分）'}`);
console.log(`提示词：「${PROMPT_TEXT}」 · 轮询 ${POLL_MS} ms · 每个任务最多等 ${TIMEOUT_MS / 1000} s`);
console.log('\n计划（一个一个跑）：');
for (const r of plan) {
  const opts = [r.texture === 'none' ? '不带贴图' : r.texture === 'fast' ? '快速贴图' : '标准贴图', r.faceLimit === 0 ? '不限面数' : r.faceLimit ? `face_limit ${r.faceLimit}` : r.model.startsWith('P') ? '版本自己的面数' : '默认 face_limit', r.compress ? 'compress' : ''].filter(Boolean).join(' · ');
  console.log(`  ${String(r.id).padStart(2)}. ${r.model.padEnd(14)} ${opts.padEnd(34)} 预计 ${String(r.credits).padStart(3)} 积分  ${r.note}`);
}
for (const s of skipped) console.log(`  跳过 ${s}`);
console.log(`合计 ${plan.length} 个任务，预计 ${planned} 积分（上限 ${MAX_CREDITS}）\n`);

if (!plan.length) {
  console.error('没有要跑的任务');
  process.exit(2);
}
if (planned > MAX_CREDITS) {
  console.error(`预计 ${planned} 积分超过上限 ${MAX_CREDITS}：不开始。用 --only 少跑几行`);
  process.exit(2);
}
if (DRY) {
  console.log('--dry-run：只看计划，不建任务');
  process.exit(0);
}
if (!MOCK && !(REAL && YES)) {
  console.error('中转是真实模式：要同时设 REAL=1 并加 --yes 才会建任务（会花上面算的积分）');
  process.exit(2);
}
if (REAL && MOCK) console.warn('设了 REAL=1，但中转是模拟模式：照样跑，数字是假的');

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const start = await balance();
console.log(`开始时余额 ${start.balance}（冻结 ${start.frozen}）\n`);

const results = [];
let stopReason = '';
for (const row of plan) {
  const spentSoFar = results.reduce((s, r) => s + (r.creditsUsed ?? r.credits ?? 0), 0);
  if (spentSoFar + row.credits > MAX_CREDITS) {
    stopReason = `再跑第 ${row.id} 行（预计 ${row.credits}）会超过上限：已经花了 ${spentSoFar}`;
    break;
  }
  const before = await balance();
  if (start.balance - before.balance > MAX_CREDITS) {
    stopReason = `余额比开始时少了 ${(start.balance - before.balance).toFixed(2)}，超过上限 ${MAX_CREDITS}`;
    break;
  }
  const r = { ...row, prompt: PROMPT_TEXT, balanceBefore: before.balance, timeline: [] };
  results.push(r);
  console.log(`[${row.id}] ${row.model} ${row.texture}${row.faceLimit === 0 ? ' 不限面数' : ''}${row.compress ? ' compress' : ''} …`);
  const t0 = now();
  const created = await call('POST', '/task', taskBody(row)).catch((err) => ({ status: 0, json: null, err }));
  r.submitMs = Math.round(now() - t0);
  if (created.status !== 200 || !created.json?.taskId) {
    r.outcome = `建任务失败：HTTP ${created.status} ${created.json?.code ?? ''} ${created.json?.message ?? created.err?.message ?? ''}`.trim();
    console.log(`    ${r.outcome}`);
    if (created.json?.code === 'rate_limited' || created.json?.code === 'daily_cap') {
      stopReason = `中转限流（${created.json.code}）：起中转时调大 TRIPO_MAX_TASKS_PER_IP_PER_HOUR`;
      break;
    }
    continue;
  }
  r.taskId = created.json.taskId;
  // 轮询：状态或进度一变就记一笔（相对提交的毫秒数）
  let last = '';
  let info = null;
  while (now() - t0 < TIMEOUT_MS) {
    await sleep(POLL_MS);
    const s = await call('GET', `/task/${encodeURIComponent(r.taskId)}`).catch(() => null);
    if (!s || s.status !== 200 || !s.json?.ok) continue; // 暂时的错误：接着问
    info = s.json;
    const key = `${info.status}:${info.progress}`;
    if (key !== last) {
      last = key;
      r.timeline.push({ t: Math.round(now() - t0), status: info.status, progress: info.progress });
      process.stdout.write(`    ${sec(now() - t0).padStart(7)}  ${info.status} ${info.progress}%\n`);
    }
    if (['success', 'failed', 'cancelled'].includes(info.status)) break;
  }
  r.totalMs = Math.round(now() - t0);
  if (info?.status !== 'success') {
    r.outcome = info ? `${info.status}${info.error ? `：${info.error}` : ''}` : '超时';
    if (now() - t0 >= TIMEOUT_MS) r.outcome = `超时（${TIMEOUT_MS / 1000} s 还没完）`;
    console.log(`    ${r.outcome}`);
  } else {
    r.outcome = 'success';
    r.successMs = r.timeline.find((x) => x.status === 'success')?.t ?? r.totalMs;
    const firstRunning = r.timeline.find((x) => x.status === 'running');
    r.queuedMs = firstRunning ? firstRunning.t : null;
    if (typeof info.credits === 'number') r.tripoCredits = info.credits;
    // 下载结果（量大小、下载耗时、看 GLB 的头），再拿预览图
    const glb = await download(`/download/${encodeURIComponent(r.taskId)}`, SAVE_GLB ? path.join(OUT_DIR, `${stamp}-${row.id}.glb`) : null).catch((err) => ({ ok: false, error: err.message }));
    if (glb.ok) {
      r.glbBytes = glb.bytes;
      r.downloadMs = Math.round(glb.ms);
      r.glb = inspectGlb(glb.data);
    } else r.downloadError = glb.error ?? `HTTP ${glb.status}`;
    const pv = await download(`/preview/${encodeURIComponent(r.taskId)}`, null).catch(() => ({ ok: false }));
    if (pv.ok) r.preview = { bytes: pv.bytes, type: pv.type, ms: Math.round(pv.ms) };
    console.log(`    成功 ${sec(r.successMs)} · GLB ${mb(r.glbBytes)}（下载 ${sec(r.downloadMs)}）· ${r.glb?.triangles?.toLocaleString('en-US') ?? '?'} 面 · 扩展 ${(r.glb?.extensions ?? []).join(', ') || '无'}`);
  }
  const after = await settledBalance(before.frozen);
  r.balanceAfter = after.balance;
  r.creditsUsed = Math.round((before.balance - after.balance) * 100) / 100;
  console.log(`    扣了 ${r.creditsUsed} 积分${r.tripoCredits !== undefined ? `（Tripo 报 ${r.tripoCredits}）` : ''} · 余额 ${after.balance}\n`);
  if (start.balance - after.balance > MAX_CREDITS) {
    stopReason = `余额比开始时少了 ${(start.balance - after.balance).toFixed(2)}，超过上限 ${MAX_CREDITS}`;
    break;
  }
}

const end = await balance().catch(() => null);
const spent = end ? Math.round((start.balance - end.balance) * 100) / 100 : null;

// —— 表 ——
const header = ['#', '模型', '贴图', '面数限制', '压缩', '排队', '到 success', '下载', 'GLB', '面数', '扩展', '积分', '结果'];
const rows = results.map((r) => [
  r.id,
  r.model,
  r.texture,
  r.faceLimit === 0 ? '不限' : r.faceLimit ? String(r.faceLimit) : '默认',
  r.compress ? 'geometry' : '',
  sec(r.queuedMs),
  sec(r.successMs),
  sec(r.downloadMs),
  mb(r.glbBytes),
  r.glb?.triangles != null ? r.glb.triangles.toLocaleString('en-US') : '—',
  (r.glb?.extensions ?? []).join(' ') || '—',
  r.creditsUsed ?? '—',
  r.outcome ?? '—',
]);
const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((row) => String(row[i]).length)));
const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
console.log(line(header));
for (const row of rows) console.log(line(row));
console.log(`\n开始 ${start.balance} → 结束 ${end?.balance ?? '?'}，共花 ${spent ?? '?'} 积分${stopReason ? `\n提前停下：${stopReason}` : ''}${MOCK ? '\n（模拟模式：时间、积分都是假的）' : ''}`);

const md = [
  `# Tripo 测速 ${stamp}${MOCK ? '（模拟模式，数字是假的）' : ''}`,
  '',
  `中转 \`${BASE}\` · 提示词「${PROMPT_TEXT}」· 轮询 ${POLL_MS} ms · 开始余额 ${start.balance} → 结束 ${end?.balance ?? '?'}，共花 ${spent ?? '?'} 积分${stopReason ? ` · 提前停下：${stopReason}` : ''}`,
  '',
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
  '',
  '「到 success」是从提交到轮询第一次看到 success（精度约一个轮询间隔）；「积分」是任务前后余额的差。',
  '把每行的「到 success」秒数填进 server/tripo/handler.mjs 的 ETA_SEC（对应模型、text、贴图档），measured 改成 true。',
].join('\n');
const base = path.join(OUT_DIR, `bench-${stamp}`);
writeFileSync(`${base}.json`, JSON.stringify({ base: BASE, mock: MOCK, prompt: PROMPT_TEXT, pollMs: POLL_MS, start, end, spent, stopReason, results }, null, 2));
writeFileSync(`${base}.md`, `${md}\n`);
console.log(`\n写好了 ${base}.json 和 ${base}.md`);

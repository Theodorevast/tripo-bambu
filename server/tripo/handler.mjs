// Tripo API 中转：一个 Web 标准的处理函数 handle(request, env, info?) → Response，零依赖。
// 网页只调 /api/tripo/*；Tripo 的 API 密钥只在服务端，从环境变量 TRIPO_API_KEY 读，不进前端包、不进日志、不进任何响应。
// 三个外壳共用这一份逻辑：vite-plugin.mjs（npm run dev / vite preview）、node-server.mjs（独立 Node 服务）、worker.mjs（Cloudflare Worker）。
// 接的是 Tripo API v3（v2 在 2026-10-31 16:00 UTC 停用）。查到的接口细节和来源见 docs/TRIPO.md。
//
// 接口约定（前端按这个调）：
//   GET  /api/tripo/health        → { ok, mock }
//   GET  /api/tripo/balance       → { ok, balance, frozen }
//   POST /api/tripo/upload        multipart，字段 file，一张 PNG / JPEG → { ok, token, type }
//   POST /api/tripo/task          JSON { mode: 'text' | 'image' | 'multiview', ... } → { ok, taskId }
//   GET  /api/tripo/task/:id      → { ok, status, progress, modelUrl?, previewUrl?, error? }
//   GET  /api/tripo/download/:id  → 结果 GLB（流式，带 Content-Type 和长度）
//   GET  /api/tripo/preview/:id   → 结果预览图（同源，方便画到画布上）
//   出错一律 { ok: false, code, message }，code 取 rate_limited / daily_cap / quota / bad_request / upstream / not_found

const API_PREFIX = '/api/tripo';
const DEFAULT_API_BASE = 'https://openapi.tripo3d.ai/v3'; // 中国区账号用 https://openapi.tripo3d.com/v3
const MB = 1024 * 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// H 系列 10–30 积分一个任务；P 系列贵得多（P2 带贴图 110 积分），默认不放行，要用就在 TRIPO_MODEL_VERSIONS 里加
const DEFAULT_MODEL_VERSIONS = ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123'];
const DEFAULT_MODEL_VERSION = 'v3.1-20260211';
// 结果文件只从这些域名（及其子域名）拉。阿里云文档里的样例是 openapi.cdn.tripo3d.com；国际区的实际主机待确认，
// 不在名单里时报错信息会写出主机名，确认是 Tripo 的就加进 TRIPO_DOWNLOAD_HOSTS
const DEFAULT_DOWNLOAD_HOSTS = ['tripo3d.ai', 'tripo3d.com'];
const VIEWS = ['front', 'left', 'back', 'right'];
const TASK_FIELDS = {
  text: ['mode', 'prompt', 'texture', 'pbr', 'modelVersion'],
  image: ['mode', 'token', 'type', 'texture', 'pbr', 'modelVersion'],
  multiview: ['mode', 'views', 'texture', 'pbr', 'modelVersion'],
};
const UPSTREAM_ROUTES = {
  text: '/generation/text-to-model',
  image: '/generation/image-to-model',
  multiview: '/generation/multiview-to-model',
};
const IMAGE_TYPES = ['png', 'jpeg', 'jpg'];
const MAX_PROMPT_CHARS = 1024; // Tripo 文档：prompt 最多 1024 个字符
const MAX_JSON_BYTES = 16 * 1024;
const MULTIPART_OVERHEAD = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 60_000;
// 任务 id：Tripo 文档里是 UUID；这里只限定字符和长度（防止拼进上游路径时出事），格式本身待确认
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
// 上传后拿到的 file_token：文档里是 file_abc123，多视图样例里是 UUID。只放行这些字符，挡掉 URL 和 task_id 以外的东西
const FILE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const MOCK_TASK = /^mock_([0-9a-z]{1,11})_([0-9a-z]{1,4})_([sf])_[0-9a-f]{8}$/;
const MOCK_QUEUED_MS = 1500;
const STATUS_KNOWN = new Set(['queued', 'running', 'success', 'failed', 'cancelled']);
const ERROR_STATUS = { rate_limited: 429, daily_cap: 429, quota: 402, bad_request: 400, upstream: 502, not_found: 404 };

class TripoError extends Error {
  constructor(code, message, status = ERROR_STATUS[code] ?? 500, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterSec = extra.retryAfterSec ?? null;
    // 建任务时请求可能已经到了 Tripo（超时、5xx）：这种不退还限流名额，免得重复扣费时还多放一次
    this.indeterminate = extra.indeterminate ?? false;
  }
}
const fail = (code, message, status, extra) => new TripoError(code, message, status, extra);

// 路径里有 /api/tripo 就归这里管（站点部署在子路径下时前面会多一段，比如 /gbn/api/tripo/...）
export function matchTripoPath(pathname) {
  const at = String(pathname ?? '').indexOf(API_PREFIX);
  if (at < 0) return null;
  const rest = pathname.slice(at + API_PREFIX.length);
  if (rest !== '' && !rest.startsWith('/')) return null;
  return { prefix: pathname.slice(0, at), route: rest || '/' };
}
export const isTripoPath = (pathname) => matchTripoPath(pathname) !== null;

// ---------- 配置 ----------

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
// 空字符串当没设（照抄 .env.example 不会把上限变成 0）；0 是有效值，表示关掉
function count(v, fallback) {
  const s = str(v);
  if (!s) return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
function list(v) {
  return str(v).split(',').map((x) => x.trim()).filter(Boolean);
}

export function readConfig(env = {}) {
  const key = str(env.TRIPO_API_KEY);
  const mockFlag = str(env.TRIPO_MOCK).toLowerCase();
  const apiBase = (str(env.TRIPO_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, '');
  const versions = list(env.TRIPO_MODEL_VERSIONS);
  const modelVersions = versions.length ? versions : DEFAULT_MODEL_VERSIONS;
  const preferred = str(env.TRIPO_DEFAULT_MODEL_VERSION);
  return {
    key,
    mock: !key || mockFlag === '1' || mockFlag === 'true',
    apiBase,
    tasksPerIpPerHour: count(env.TRIPO_MAX_TASKS_PER_IP_PER_HOUR, 5),
    tasksPerDay: count(env.TRIPO_MAX_TASKS_PER_DAY, 50),
    uploadsPerIpPerHour: count(env.TRIPO_MAX_UPLOADS_PER_IP_PER_HOUR, 30),
    // 所有接口合计（轮询、下载也算）。会场多人共用一个出口 IP 时要调大
    requestsPerIpPerMinute: count(env.TRIPO_MAX_REQUESTS_PER_IP_PER_MINUTE, 300),
    // Tripo 自己的上限是 20 MB；这里默认 10 MB，最大也只能调到 20
    maxImageBytes: Math.min(count(env.TRIPO_MAX_IMAGE_MB, 10), 20) * MB,
    maxDownloadBytes: count(env.TRIPO_MAX_DOWNLOAD_MB, 200) * MB,
    origins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    modelVersions,
    defaultModel: modelVersions.includes(preferred) ? preferred
      : modelVersions.includes(DEFAULT_MODEL_VERSION) ? DEFAULT_MODEL_VERSION : modelVersions[0],
    downloadHosts: [...DEFAULT_DOWNLOAD_HOSTS, ...list(env.TRIPO_DOWNLOAD_HOSTS).map((h) => h.toLowerCase().replace(/^\*?\./, ''))],
  };
}

// ---------- 密钥不外泄 ----------

// 所有对外的文字（错误信息、日志）都过一遍：把密钥本身和长得像密钥的串换掉
function redactor(key) {
  return (text) => {
    let s = String(text ?? '');
    if (key && key.length >= 6) s = s.split(key).join('***');
    return s.replace(/tsk_[A-Za-z0-9_-]{6,}/g, 'tsk_***');
  };
}

// ---------- 限流 ----------

// 内存里的滑动窗口计数。只在单个进程 / 单个 Worker 实例里有效；多实例上线要换成 KV、Durable Objects 或 Redis，
// 接口照这个写：hit(key, limit, windowMs, now) → { ok, retryAfterMs, release() }，可以是异步的
export function createMemoryStore({ maxKeys = 50_000 } = {}) {
  const buckets = new Map(); // key → 时间戳数组（升序）
  let hits = 0;
  const prune = (arr, since) => {
    let i = 0;
    while (i < arr.length && arr[i] <= since) i++;
    if (i) arr.splice(0, i);
  };
  return {
    async hit(key, limit, windowMs, now) {
      if (limit <= 0) return { ok: false, retryAfterMs: null, release() {} };
      const arr = buckets.get(key) ?? [];
      buckets.delete(key); // 重新插入到末尾：Map 的顺序就是最近使用的顺序
      prune(arr, now - windowMs);
      if (arr.length >= limit) {
        buckets.set(key, arr);
        return { ok: false, retryAfterMs: Math.max(1000, arr[0] + windowMs - now), release() {} };
      }
      arr.push(now);
      buckets.set(key, arr);
      // 偶尔清一遍过期的，键太多时丢掉最久没用的
      if (++hits % 1000 === 0) {
        for (const [k, a] of buckets) {
          prune(a, now - DAY);
          if (!a.length) buckets.delete(k);
        }
      }
      while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value);
      let released = false;
      return {
        ok: true,
        retryAfterMs: 0,
        release() {
          if (released) return;
          released = true;
          const i = arr.lastIndexOf(now);
          if (i >= 0) arr.splice(i, 1);
        },
      };
    },
  };
}

// IPv6 按 /64 计（一个用户通常整段都能用）；IPv4 映射地址还原成 IPv4
export function ipKey(ip) {
  let s = str(ip).toLowerCase();
  if (!s) return 'unknown';
  if (s.startsWith('::ffff:') && s.includes('.')) return s.slice(7);
  if (!s.includes(':')) return s;
  s = s.split('%')[0];
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// ---------- 小工具 ----------

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function errorResponse(err, redact) {
  const headers = {};
  if (err.retryAfterSec) headers['retry-after'] = String(err.retryAfterSec);
  const body = { ok: false, code: err.code, message: redact(err.message) };
  if (err.retryAfterSec) body.retryAfter = err.retryAfterSec;
  return json(err.status, body, headers);
}

// 读请求体，超过上限立刻停（不信 Content-Length，分块上传也照样数）
async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail('bad_request', `请求太大（上限 ${Math.round(maxBytes / MB * 10) / 10} MB）`, 413);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail('bad_request', `请求太大（上限 ${Math.round(maxBytes / MB * 10) / 10} MB）`, 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// 只认 PNG 和 JPEG（Tripo 上传接口文档只写了这两种；WebP 在生成接口的文档里有，上传接口没写，待确认）
function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

// 进度条随时间平滑上升（模拟模式）
function mockProgress(elapsed, duration) {
  const t = Math.min(1, Math.max(0, (elapsed - MOCK_QUEUED_MS) / (duration - MOCK_QUEUED_MS)));
  const eased = 1 - (1 - t) * (1 - t);
  return Math.min(99, Math.max(1, Math.round(eased * 99)));
}

function parseMockTask(id, now) {
  const m = MOCK_TASK.exec(id);
  if (!m) return null;
  const start = parseInt(m[1], 36);
  const duration = parseInt(m[2], 36);
  if (!Number.isFinite(start) || start > now + MINUTE || duration < 2000 || duration > 120_000) return null;
  const fails = m[3] === 'f';
  const elapsed = now - start;
  if (elapsed < MOCK_QUEUED_MS) return { status: 'queued', progress: 0 };
  const failAt = duration * 0.6;
  if (fails && elapsed >= failAt) return { status: 'failed', progress: mockProgress(failAt, duration), error: '模拟失败：提示词或图片文件名里带了 #fail' };
  if (elapsed >= duration) return { status: 'success', progress: 100 };
  return { status: 'running', progress: mockProgress(elapsed, duration) };
}

function mockPreviewSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
    + '<rect width="512" height="512" fill="#1d2433"/><circle cx="256" cy="230" r="120" fill="#e8c27a"/>'
    + '<text x="256" y="430" fill="#f4efe6" font-family="sans-serif" font-size="44" text-anchor="middle">Tripo mock</text></svg>';
}

// 默认的模拟资源加载：按 MOCK_MODEL_URL / MOCK_PREVIEW_URL 去取（相对地址按当前请求解析）。Node 外壳会换成读本地文件
async function fetchMockAsset(url, request, fetchImpl) {
  if (!url) return null;
  const res = await fetchImpl(new URL(url, request.url), { redirect: 'follow' });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const size = Number(res.headers.get('content-length'));
  return { body: res.body, size: Number.isFinite(size) && size > 0 ? size : undefined, contentType: res.headers.get('content-type') ?? undefined };
}

function hostAllowed(host, allowed) {
  const h = host.toLowerCase();
  return allowed.some((s) => h === s || h.endsWith(`.${s}`));
}

// 结果链接只能是 https、默认端口、主机在白名单里、不带账号密码
function checkResultUrl(raw, cfg) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail('upstream', 'Tripo 返回的结果链接不是合法地址');
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) throw fail('upstream', `结果链接不是 Tripo 的 https 地址（${url.protocol}//${url.host}），已拒绝`);
  if (!hostAllowed(url.hostname, cfg.downloadHosts)) throw fail('upstream', `结果文件的主机 ${url.hostname} 不在白名单里，已拒绝。确认是 Tripo 的主机后加到 TRIPO_DOWNLOAD_HOSTS`);
  return url;
}

// 流式转发时数字节，超过上限就断
function limitStream(max) {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error('结果文件超过大小上限'));
      else controller.enqueue(chunk);
    },
  });
}

function upstreamModelUrl(output) {
  const o = output && typeof output === 'object' ? output : {};
  for (const k of ['model_url', 'pbr_model_url', 'model', 'pbr_model']) {
    if (typeof o[k] === 'string' && o[k]) return o[k];
  }
  return null;
}
function upstreamPreviewUrl(output) {
  const o = output && typeof output === 'object' ? output : {};
  for (const k of ['rendered_image_url', 'rendered_image']) {
    if (typeof o[k] === 'string' && o[k]) return o[k];
  }
  return null;
}

// Tripo 的错误码 → 我们的错误码。表见 https://developers.tripo3d.ai/en/docs/error-handling
function mapUpstreamError(status, payload, retryAfter, redact) {
  const code = payload && typeof payload === 'object' ? Number(payload.code) : NaN;
  const msg = payload && typeof payload === 'object' && typeof payload.message === 'string' ? redact(payload.message).slice(0, 200) : '';
  const tag = Number.isFinite(code) ? `（Tripo ${code}）` : `（HTTP ${status}）`;
  const retryAfterSec = Number(retryAfter) > 0 ? Math.ceil(Number(retryAfter)) : null;
  if (code === 2010) return fail('quota', `Tripo 账户积分不足，暂时不能生成${tag}`);
  if (code === 1007 || code === 2000 || status === 429) return fail('rate_limited', `Tripo 当前繁忙（频率或并发上限），请稍后再试${tag}`, 429, { retryAfterSec: retryAfterSec ?? 30 });
  if (code === 2008) return fail('bad_request', `内容没有通过 Tripo 的审核，请换个描述或图片${tag}`);
  if (code === 2 || code === 1002 || status === 401) return fail('upstream', `服务端的 Tripo 密钥无效或没配置，请检查 TRIPO_API_KEY${tag}`);
  // 找不到任务时 Tripo 回什么业务码待确认，以 HTTP 404 为准
  if (status === 404) return fail('not_found', `Tripo 上找不到这个任务${tag}`);
  if ([1003, 1004, 2002, 2003, 2004, 2015, 2018].includes(code) || status === 400) return fail('bad_request', `Tripo 拒绝了这个请求${tag}${msg ? `：${msg}` : ''}`);
  if (status === 403) return fail('upstream', `Tripo 拒绝访问${tag}${msg ? `：${msg}` : ''}`);
  return fail('upstream', `Tripo 服务出错，请稍后再试${tag}`, 502, { indeterminate: true });
}

function describeTaskError(data, status) {
  const raw = typeof data?.error_message === 'string' ? data.error_message : typeof data?.error_msg === 'string' ? data.error_msg : '';
  const code = data?.error_code != null ? `（Tripo 错误码 ${data.error_code}）` : '';
  if (raw) return `${raw.slice(0, 300)}${code}`;
  return status === 'cancelled' ? `任务已取消${code}` : `生成失败${code}`;
}

// ---------- 请求校验 ----------

function onlyFields(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw fail('bad_request', `${where}不认识字段 ${JSON.stringify(k).slice(0, 40)}，只接受：${allowed.join('、')}`);
  }
}
function optionalBool(v, name) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw fail('bad_request', `${name} 必须是 true 或 false`);
  return v;
}
function checkToken(v, where) {
  if (typeof v !== 'string' || !FILE_TOKEN.test(v)) throw fail('bad_request', `${where}的 token 不对：要用 /api/tripo/upload 返回的 token`);
  return v;
}
function checkImageType(v, where) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !IMAGE_TYPES.includes(v.toLowerCase())) throw fail('bad_request', `${where}的 type 只能是 ${IMAGE_TYPES.join(' / ')}`);
  return v.toLowerCase();
}

// 把前端的请求整理成发给 Tripo 的请求体；不在白名单里的一律拒绝
export function buildTask(body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('bad_request', '请求体要是 JSON 对象');
  const mode = body.mode;
  if (!Object.hasOwn(TASK_FIELDS, mode)) throw fail('bad_request', 'mode 只能是 text、image、multiview');
  onlyFields(body, TASK_FIELDS[mode], '');
  const model = body.modelVersion ?? cfg.defaultModel;
  if (typeof model !== 'string' || !cfg.modelVersions.includes(model)) throw fail('bad_request', `modelVersion 只能是 ${cfg.modelVersions.join('、')}`);
  let texture = optionalBool(body.texture, 'texture');
  let pbr = optionalBool(body.pbr, 'pbr');
  // Tripo 的 pbr 默认是 true，而 pbr=true 会强制带贴图：只传 texture=false 还是会出贴图，所以一并关掉 pbr
  if (texture === false) pbr = false;
  if (pbr === true) texture = true;
  const payload = {};
  const mockTriggers = { fail: false, quota: false, upstream: false };
  if (mode === 'text') {
    if (typeof body.prompt !== 'string') throw fail('bad_request', '缺少 prompt（文字描述）');
    const prompt = body.prompt.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
    if (!prompt) throw fail('bad_request', 'prompt 不能为空');
    if ([...prompt].length > MAX_PROMPT_CHARS) throw fail('bad_request', `prompt 最多 ${MAX_PROMPT_CHARS} 个字`);
    payload.prompt = prompt;
    const lower = prompt.toLowerCase();
    mockTriggers.fail = lower.includes('#fail');
    mockTriggers.quota = lower.includes('#quota');
    mockTriggers.upstream = lower.includes('#upstream');
  } else if (mode === 'image') {
    payload.input = checkToken(body.token, '图片');
    checkImageType(body.type, '图片');
    mockTriggers.fail = payload.input.startsWith('mock_file_fail_');
  } else {
    const views = body.views;
    if (!Array.isArray(views) || views.length !== 4) throw fail('bad_request', 'views 要正好 4 项，顺序是前、左、后、右，没有的填 null');
    const inputs = [];
    views.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const where = `${['前', '左', '后', '右'][i]}视图`;
      if (typeof v !== 'object' || Array.isArray(v)) throw fail('bad_request', `${where}要是 { token, type } 或 null`);
      onlyFields(v, ['token', 'type'], `${where}里`);
      const token = checkToken(v.token, where);
      checkImageType(v.type, where);
      if (token.startsWith('mock_file_fail_')) mockTriggers.fail = true;
      // view-key 写法（Tripo 文档推荐）：[{ front: token }, { back: token }, ...]，服务端自己排成前左后右
      inputs.push({ [VIEWS[i]]: token });
    });
    if (!views[0]) throw fail('bad_request', '多视图必须有正面（第 1 张）');
    if (inputs.length < 2) throw fail('bad_request', '多视图至少要 2 张图（含正面）');
    payload.inputs = inputs;
  }
  payload.model = model;
  if (texture !== undefined) payload.texture = texture;
  if (pbr !== undefined) payload.pbr = pbr;
  return { mode, route: UPSTREAM_ROUTES[mode], payload, mockTriggers };
}

// ---------- 处理函数 ----------

export function createHandler(options = {}) {
  const store = options.store ?? createMemoryStore();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? console;
  // 每次调用时再取 fetch：测试里 vi.stubGlobal('fetch', ...) 能生效
  const getFetch = () => options.fetch ?? globalThis.fetch;

  async function limit(key, max, windowMs, what) {
    const r = await store.hit(key, max, windowMs, now());
    if (r.ok) return r;
    const retryAfterSec = r.retryAfterMs ? Math.ceil(r.retryAfterMs / 1000) : null;
    throw what(retryAfterSec);
  }

  async function callTripo(cfg, redact, method, path, { json: body, form, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
    const headers = { authorization: `Bearer ${cfg.key}`, accept: 'application/json' };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (form) payload = form;
    let res;
    try {
      res = await getFetch()(`${cfg.apiBase}${path}`, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      log.warn?.(redact(`[tripo] ${method} ${path} 网络错误：${err?.name ?? ''} ${err?.message ?? err}`));
      throw fail('upstream', timedOut ? 'Tripo 响应超时，请稍后再试' : '连不上 Tripo，请稍后再试', timedOut ? 504 : 502, { indeterminate: true });
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const bad = res.status >= 300 || !data || typeof data !== 'object' || (data.code !== undefined && data.code !== 0) || data.status === 'error';
    if (bad) {
      const err = mapUpstreamError(res.status, data, res.headers.get('retry-after'), redact);
      log.warn?.(redact(`[tripo] ${method} ${path} → HTTP ${res.status} code=${data?.code ?? '-'} request_id=${data?.request_id ?? '-'}`));
      throw err;
    }
    return 'data' in data ? data.data : data;
  }

  // 下载结果：每次都重新查任务拿新链接（链接带签名，几分钟就过期），只拉白名单主机，跳转也逐跳检查
  async function fetchResult(cfg, redact, rawUrl, accept) {
    let url = checkResultUrl(rawUrl, cfg);
    for (let hop = 0; hop < 4; hop++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      let res;
      try {
        // 不带 Authorization：结果链接自己带签名，密钥不能发给存储主机
        // 要原始字节（identity）：fetch 会自动解压 gzip，但 Content-Length 还是压缩后的大小，转发出去长度就对不上了
        res = await getFetch()(url.toString(), { redirect: 'manual', signal: ac.signal, headers: { accept, 'accept-encoding': 'identity' } });
      } catch (err) {
        log.warn?.(redact(`[tripo] 拉结果失败 ${url.hostname}：${err?.name ?? ''} ${err?.message ?? err}`));
        throw fail('upstream', '从 Tripo 拉结果文件失败，请稍后再试');
      } finally {
        clearTimeout(timer); // 只管到收到响应头；之后的流式传输不限时
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        if (!loc) throw fail('upstream', 'Tripo 的结果链接跳转没有目标地址');
        url = checkResultUrl(new URL(loc, url).toString(), cfg);
        continue;
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        log.warn?.(`[tripo] 拉结果 ${url.hostname} → HTTP ${res.status}`);
        throw fail('upstream', res.status === 403 ? 'Tripo 的结果链接已过期或被拒绝，请重新生成' : `从 Tripo 拉结果文件失败（HTTP ${res.status}）`);
      }
      return res;
    }
    throw fail('upstream', 'Tripo 的结果链接跳转次数太多');
  }

  function streamResponse(cfg, body, size, contentType, extra = {}) {
    const headers = {
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      // 转发的是别人的文件：就算内容被换成网页也不让它当网页跑
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=600',
      ...extra,
    };
    if (Number.isFinite(size) && size > 0) {
      if (size > cfg.maxDownloadBytes) throw fail('upstream', '结果文件超过大小上限');
      headers['content-length'] = String(size);
      return new Response(body, { status: 200, headers });
    }
    const stream = body instanceof ReadableStream ? body.pipeThrough(limitStream(cfg.maxDownloadBytes)) : body;
    return new Response(stream, { status: 200, headers });
  }

  function checkTaskId(id, cfg) {
    if (!TASK_ID.test(id)) throw fail('bad_request', '任务 id 格式不对');
    const isMock = id.startsWith('mock_');
    if (isMock !== cfg.mock) throw fail('not_found', cfg.mock ? '模拟模式下只认模拟任务' : '没有这个任务');
  }

  async function getRealTask(cfg, redact, id) {
    const data = await callTripo(cfg, redact, 'GET', `/tasks/${encodeURIComponent(id)}`);
    if (!data || typeof data !== 'object') throw fail('upstream', 'Tripo 返回的任务数据不对');
    return data;
  }

  // ----- 各个接口 -----

  async function health(cfg) {
    return json(200, { ok: true, mock: cfg.mock });
  }

  async function balance(cfg, redact) {
    if (cfg.mock) return json(200, { ok: true, balance: 1000, frozen: 0 });
    const data = await callTripo(cfg, redact, 'GET', '/account/balance');
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return json(200, { ok: true, balance: num(data?.balance), frozen: num(data?.frozen) });
  }

  async function upload(cfg, redact, request, ip) {
    const type = request.headers.get('content-type') ?? '';
    if (!/^multipart\/form-data/i.test(type)) throw fail('bad_request', '上传要用 multipart/form-data，字段名 file', 415);
    // 先占名额再读请求体：超了的直接拒，不用先收下 10 MB；后面校验没过（明确的失败）就退回名额
    const slot = await limit(`upload:${ip}`, cfg.uploadsPerIpPerHour, HOUR, (s) => fail('rate_limited', `上传太频繁：每个 IP 每小时最多 ${cfg.uploadsPerIpPerHour} 张图，请稍后再试`, 429, { retryAfterSec: s }));
    try {
      const bytes = await readBody(request, cfg.maxImageBytes + MULTIPART_OVERHEAD);
      let form;
      try {
        form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
      } catch {
        throw fail('bad_request', '上传的表单解析不了');
      }
      for (const k of form.keys()) {
        if (k !== 'file') throw fail('bad_request', `上传表单只接受字段 file，不认识 ${JSON.stringify(k).slice(0, 40)}`);
      }
      const files = form.getAll('file');
      if (files.length !== 1 || typeof files[0] === 'string') throw fail('bad_request', '一次上传正好一张图，字段名 file');
      const file = files[0];
      if (file.size === 0) throw fail('bad_request', '图片是空的');
      if (file.size > cfg.maxImageBytes) throw fail('bad_request', `单张图最大 ${cfg.maxImageBytes / MB} MB`, 413);
      const data = new Uint8Array(await file.arrayBuffer());
      const kind = sniffImage(data);
      if (!kind) throw fail('bad_request', '只支持 PNG 或 JPEG 图片', 415);

      if (cfg.mock) {
        const failing = String(file.name ?? '').toLowerCase().includes('#fail');
        return json(200, { ok: true, token: `mock_file_${failing ? 'fail_' : ''}${randomHex(8)}`, type: kind });
      }
      const out = new FormData();
      out.append('file', new Blob([data], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }), kind === 'png' ? 'image.png' : 'image.jpg');
      const res = await callTripo(cfg, redact, 'POST', '/files', { form: out, timeoutMs: UPLOAD_TIMEOUT_MS });
      const token = res?.file_token;
      if (typeof token !== 'string' || !FILE_TOKEN.test(token)) throw fail('upstream', 'Tripo 上传成功但没返回可用的 file_token');
      return json(200, { ok: true, token, type: kind });
    } catch (err) {
      if (!err?.indeterminate) slot.release();
      throw err;
    }
  }

  async function createTask(cfg, redact, request, ip) {
    if (!/^application\/json/i.test(request.headers.get('content-type') ?? '')) throw fail('bad_request', '请求要用 application/json', 415);
    const bytes = await readBody(request, MAX_JSON_BYTES);
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw fail('bad_request', '请求体不是合法的 JSON');
    }
    const task = buildTask(body, cfg);

    // 先占名额再调 Tripo；Tripo 明确拒绝时退回名额，结果不明（超时、5xx）时不退
    const perIp = await limit(`task:${ip}`, cfg.tasksPerIpPerHour, HOUR, (s) => fail('rate_limited', `生成太频繁：每个 IP 每小时最多 ${cfg.tasksPerIpPerHour} 个任务，请稍后再试`, 429, { retryAfterSec: s }));
    let perDay;
    try {
      perDay = await limit('task:all', cfg.tasksPerDay, DAY, (s) => fail('daily_cap', cfg.tasksPerDay > 0 ? `今天的生成额度（${cfg.tasksPerDay} 个）已经用完，请明天再来` : '生成功能已关闭', 429, { retryAfterSec: s }));
    } catch (err) {
      perIp.release();
      throw err;
    }
    try {
      if (cfg.mock) {
        if (task.mockTriggers.quota) throw fail('quota', '模拟：Tripo 账户积分不足（提示词里带了 #quota）');
        if (task.mockTriggers.upstream) throw fail('upstream', '模拟：Tripo 服务出错（提示词里带了 #upstream）');
        const duration = 8000 + Math.floor(Math.random() * 4000); // 8–12 秒
        const taskId = `mock_${now().toString(36)}_${duration.toString(36)}_${task.mockTriggers.fail ? 'f' : 's'}_${randomHex(4)}`;
        return json(200, { ok: true, taskId });
      }
      const data = await callTripo(cfg, redact, 'POST', task.route, { json: task.payload });
      const taskId = data?.task_id;
      if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw fail('upstream', 'Tripo 没有返回任务 id', 502, { indeterminate: true });
      return json(200, { ok: true, taskId });
    } catch (err) {
      if (!err?.indeterminate) {
        perIp.release();
        perDay.release();
      }
      throw err;
    }
  }

  async function taskStatus(cfg, redact, id, prefix) {
    checkTaskId(id, cfg);
    const base = `${prefix}${API_PREFIX}`;
    if (cfg.mock) {
      const s = parseMockTask(id, now());
      if (!s) throw fail('not_found', '没有这个任务');
      const out = { ok: true, status: s.status, progress: s.progress };
      if (s.status === 'success') {
        out.modelUrl = `${base}/download/${id}`;
        out.previewUrl = `${base}/preview/${id}`;
      }
      if (s.error) out.error = s.error;
      return json(200, out);
    }
    const data = await getRealTask(cfg, redact, id);
    const raw = String(data.status ?? '').toLowerCase();
    // banned / expired 是旧写法，v3 一般已经报成 failed；其他没见过的值一律 unknown，前端接着轮询
    const status = STATUS_KNOWN.has(raw) ? raw : raw === 'banned' || raw === 'expired' ? 'failed' : 'unknown';
    const p = Number(data.progress);
    const progress = status === 'success' ? 100 : Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
    const out = { ok: true, status, progress };
    if (status === 'success') {
      if (upstreamModelUrl(data.output)) out.modelUrl = `${base}/download/${id}`;
      else out.error = 'Tripo 说任务成功了，但没有返回模型文件';
      if (upstreamPreviewUrl(data.output)) out.previewUrl = `${base}/preview/${id}`;
    }
    if (status === 'failed' || status === 'cancelled') out.error = redact(describeTaskError(data, status));
    return json(200, out);
  }

  async function result(cfg, redact, request, env, id, kind) {
    checkTaskId(id, cfg);
    if (cfg.mock) {
      const s = parseMockTask(id, now());
      if (!s) throw fail('not_found', '没有这个任务');
      if (s.status !== 'success') throw fail('not_found', '任务还没有成功完成，没有结果可下载');
      const loader = kind === 'model' ? options.loadMockModel : options.loadMockPreview;
      const fallbackUrl = kind === 'model' ? str(env.MOCK_MODEL_URL) : str(env.MOCK_PREVIEW_URL);
      let asset = null;
      try {
        asset = loader ? await loader(env, request) : await fetchMockAsset(fallbackUrl, request, getFetch());
      } catch (err) {
        log.warn?.(redact(`[tripo] 读模拟${kind === 'model' ? '模型' : '预览图'}失败：${err?.message ?? err}`));
      }
      if (!asset && kind === 'preview') return new Response(mockPreviewSvg(), { status: 200, headers: { ...BASE_HEADERS, 'content-type': 'image/svg+xml' } });
      if (!asset) throw fail('upstream', '模拟模式没有可用的模型文件：Node 下检查 public/models/，Worker 下设 MOCK_MODEL_URL');
      const type = kind === 'model' ? 'model/gltf-binary' : asset.contentType ?? 'image/webp';
      return streamResponse(cfg, asset.body, asset.size, type, kind === 'model' ? { 'content-disposition': `inline; filename="tripo-${id}.glb"` } : {});
    }
    const data = await getRealTask(cfg, redact, id);
    if (String(data.status ?? '').toLowerCase() !== 'success') throw fail('not_found', '任务还没有成功完成，没有结果可下载');
    const raw = kind === 'model' ? upstreamModelUrl(data.output) : upstreamPreviewUrl(data.output);
    if (!raw) throw fail('not_found', kind === 'model' ? 'Tripo 没有返回模型文件' : 'Tripo 没有返回预览图');
    const res = await fetchResult(cfg, redact, raw, kind === 'model' ? 'model/gltf-binary, application/octet-stream;q=0.9, */*;q=0.1' : 'image/*');
    // 存储主机还是压缩了的话，fetch 拿到的是解压后的字节，Content-Length 不能照抄
    const encoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase();
    const size = encoding && encoding !== 'identity' ? NaN : Number(res.headers.get('content-length'));
    const upstreamType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    let type;
    if (kind === 'model') {
      const path = new URL(res.url || raw).pathname.toLowerCase();
      // 我们不传 quad，结果应该总是 GLB；万一不是，就照实际格式给（文件名后缀待确认）
      type = path.endsWith('.fbx') ? 'application/octet-stream' : 'model/gltf-binary';
    } else {
      type = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(upstreamType) ? upstreamType : 'application/octet-stream';
    }
    if (Number.isFinite(size) && size > cfg.maxDownloadBytes) {
      await res.body.cancel().catch(() => {});
      throw fail('upstream', '结果文件超过大小上限');
    }
    return streamResponse(cfg, res.body, size, type, kind === 'model' ? { 'content-disposition': `inline; filename="tripo-${id}.glb"` } : {});
  }

  // ----- 跨域 -----

  function corsHeaders(request, cfg) {
    const origin = request.headers.get('origin');
    if (!origin) return {}; // 同源的 GET、curl 之类不带 Origin
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return null;
    }
    // 只比主机和端口，不比协议：反向代理后面拿到的请求地址常常是 http
    const same = originHost === new URL(request.url).host;
    if (!same && !cfg.origins.includes('*') && !cfg.origins.includes(origin)) return null;
    if (same) return {};
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': 'Content-Length, Content-Type, Retry-After' };
  }

  return async function handle(request, env, info) {
    env = env ?? {};
    const cfg = readConfig(env);
    const redact = redactor(cfg.key);
    const url = new URL(request.url);
    const match = matchTripoPath(url.pathname);
    const cors = corsHeaders(request, cfg);
    const withCors = (res) => {
      if (!cors || !Object.keys(cors).length) return res;
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    };
    try {
      if (!cors) throw fail('bad_request', '这个网页来源不在允许的名单里（ALLOWED_ORIGINS）', 403);
      if (request.method === 'OPTIONS') {
        return withCors(new Response(null, {
          status: 204,
          headers: { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '600' },
        }));
      }
      if (!match) throw fail('not_found', '没有这个接口');
      if (!cfg.mock && !/^https:\/\//.test(cfg.apiBase) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(cfg.apiBase)) {
        throw fail('upstream', 'TRIPO_API_BASE 必须是 https 地址', 500);
      }
      const ip = ipKey(info?.ip);
      await limit(`req:${ip}`, cfg.requestsPerIpPerMinute, MINUTE, (s) => fail('rate_limited', '请求太频繁，请稍后再试', 429, { retryAfterSec: s }));

      const { route, prefix } = match;
      const method = request.method;
      const seg = route.split('/').filter(Boolean);
      let res;
      if (seg.length === 1 && seg[0] === 'health' && method === 'GET') res = await health(cfg);
      else if (seg.length === 1 && seg[0] === 'balance' && method === 'GET') res = await balance(cfg, redact);
      else if (seg.length === 1 && seg[0] === 'upload' && method === 'POST') res = await upload(cfg, redact, request, ip);
      else if (seg.length === 1 && seg[0] === 'task' && method === 'POST') res = await createTask(cfg, redact, request, ip);
      else if (seg.length === 2 && seg[0] === 'task' && method === 'GET') res = await taskStatus(cfg, redact, seg[1], prefix);
      else if (seg.length === 2 && seg[0] === 'download' && method === 'GET') res = await result(cfg, redact, request, env, seg[1], 'model');
      else if (seg.length === 2 && seg[0] === 'preview' && method === 'GET') res = await result(cfg, redact, request, env, seg[1], 'preview');
      else if (['health', 'balance', 'upload', 'task', 'download', 'preview'].includes(seg[0]) && seg.length <= 2) throw fail('bad_request', `这个接口不支持 ${method}`, 405);
      else throw fail('not_found', '没有这个接口');
      return withCors(res);
    } catch (err) {
      if (err instanceof TripoError) return withCors(errorResponse(err, redact));
      log.error?.(redact(`[tripo] 处理 ${request.method} ${url.pathname} 时出错：${err?.stack ?? err}`));
      return withCors(errorResponse(fail('upstream', '服务端出错，请稍后再试', 500), redact));
    }
  };
}

// 默认实例：模块级的内存限流；Node 外壳会另建一个带本地文件加载的实例
export const handle = createHandler();

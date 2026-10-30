import type { StorageLike } from '../data/store';
import { hashString } from '../planet/rng';
import type { GenMode } from './types';

// 前端的模拟中转：一个 fetch 适配器，接口和服务端中转（T1，/api/tripo/*）一模一样，地址带 ?tripo=mock 时用（api.ts 的 tripoApiForPage）。
// 不发任何真实的 Tripo 请求：生成的「模型」是 public/models/ 里现成的几件作品。规则和 T1 服务端的模拟模式对齐：
// - 上传只收 PNG、JPEG（看文件头，不看扩展名），10 MB 以内，否则 400 bad_request（界面在上传前把 WebP、HEIC 转成 PNG / JPEG）
// - 多视图：前视图必须有，总共至少 2 张，否则 400 bad_request
// - 任务按时间推进（刷新页面也接得上）：先排队约 1.5 秒（progress 0），再生成约 6 秒（0 → 99），然后 success；
//   时长都除以 speed（选项，或者地址里的 ?mockspeed=4）
// - 额度：开始 2000 点（选项 startBalance，或者 ?mockcredits=100），文字 30、单图 40、多视图 60；排队、生成中的冻结着（frozen），
//   成功了扣掉，失败了退回。余额不够时建任务回 402 quota。余额是小数（和真的中转一样，客户端用 Number() 读）
// - 测试用的记号：提示词里写
//     #fail      任务照常建好，生成到 60% 左右失败
//     #quota     建任务时回 402 quota
//     #upstream  建任务时回 502 upstream
//     #cap       建任务时回 429 daily_cap（带 retryAfter：到 UTC 零点还有多少秒）
//     #rate      建任务时回 429 rate_limited（带 retryAfter：12 秒）
//   上传的图片文件名里带 #fail：用这张图（单图、多视图）建的任务生成到 60% 左右失败（记在这张图的 token 上）
// - 状态存在 localStorage 的 gbn:mock:tripo（任务、已经花掉的额度），刷新以后照样往下走

export const MOCK_KEY = 'gbn:mock:tripo';
export const MOCK_START_BALANCE = 2000;
export const MOCK_COSTS: Readonly<Record<GenMode, number>> = { text: 30, image: 40, multiview: 60 };
export const MOCK_QUEUE_MS = 1500; // 排队多久
export const MOCK_RUN_MS = 6000; // 生成多久（0 → 99%）
export const MOCK_FAIL_AT = 60; // #fail 的任务在这个百分比失败
export const MOCK_FAIL_ERROR = 'Mock failure requested with #fail';
export const MOCK_RATE_RETRY_AFTER = 12; // #rate 的 429 让客户端等几秒
export const MOCK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 文字生成按提示词的哈希挑一件（同一句提示词总是同一件）；单图、多视图各固定一件
export const MOCK_TEXT_MODELS = ['pumpkin-girl.glb', 'tufted-armchair.glb', 'dinosaur-skeleton.glb', 'jade-guardian-lion.glb'] as const;
export const MOCK_IMAGE_MODEL = 'jade-guardian-lion.glb';
export const MOCK_MULTIVIEW_MODEL = 'tufted-armchair.glb';

const MAX_TASKS = 50; // 存档里最多留几个任务（多了删最早结束的）
const MAX_PROMPT = 1024;
const REF_TYPES = ['png', 'jpg', 'jpeg']; // 建任务时图片引用里的 type（可以不带，带了就要是这几种）
const PROMPT_FLAGS = ['fail', 'quota', 'upstream', 'cap', 'rate'] as const;
type Flag = (typeof PROMPT_FLAGS)[number];

export interface MockOptions {
  base: string; // 和 createTripoApi 用同一个地址；只接这个地址下面的请求，别的照常发出去
  storage?: StorageLike | null; // 不给：浏览器的 localStorage；null：只存在内存里
  now?: () => number;
  speed?: number; // 时间流速：2 = 两倍快。不给时读地址里的 ?mockspeed=，再没有就是 1
  startBalance?: number; // 开始时的额度。不给时读地址里的 ?mockcredits=，再没有就是 2000
  latency?: number; // 每个请求多等几毫秒（除以 speed）。不给：60–200 毫秒随机；单元测试给 0
  fetchModel?: (file: string) => Promise<Blob>; // 读 public/models/ 下的一件作品；不给时用 fetch 读静态文件
}

interface MockTask {
  id: string;
  mode: GenMode;
  createdAt: number;
  cost: number;
  fail: boolean;
  model: string; // public/models/ 下的文件名
}

interface MockState {
  v: 1;
  seq: number;
  spent: number; // 已经从存档里删掉的成功任务花掉的额度
  tasks: MockTask[];
}

type MockStatus = { status: 'queued' | 'running' | 'success' | 'failed'; progress: number; error?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isMode = (v: unknown): v is GenMode => v === 'text' || v === 'image' || v === 'multiview';
const money = (v: number): number => Math.round(v * 100) / 100;

function toTask(v: unknown): MockTask | null {
  if (!isRecord(v)) return null;
  const { id, mode, createdAt, cost, fail, model } = v;
  if (typeof id !== 'string' || !id || !isMode(mode) || !isCount(createdAt) || !isCount(cost) || typeof fail !== 'boolean' || typeof model !== 'string' || !/^[\w.-]+\.glb$/.test(model)) return null;
  return { id, mode, createdAt, cost, fail, model };
}

function fresh(): MockState {
  return { v: 1, seq: 0, spent: 0, tasks: [] };
}

function parseState(raw: string | null): MockState {
  if (!raw) return fresh();
  try {
    const v: unknown = JSON.parse(raw);
    if (!isRecord(v) || !Array.isArray(v.tasks)) return fresh();
    return {
      v: 1,
      seq: isCount(v.seq) ? Math.floor(v.seq) : 0,
      spent: isCount(v.spent) ? v.spent : 0,
      tasks: v.tasks.map(toTask).filter((t): t is MockTask => t !== null),
    };
  } catch {
    return fresh();
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    s.getItem(MOCK_KEY);
    return s;
  } catch {
    return null;
  }
}

// 地址里的数字参数（?mockspeed=4、?mockcredits=100）：没有、不是正数时返回 null
function searchNumber(name: string): number | null {
  if (typeof location === 'undefined') return null;
  const v = Number(new URLSearchParams(location.search).get(name) ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// 提示词里的记号（#fail、#quota、#upstream、#cap、#rate）
function flagsIn(text: string): Flag[] {
  return PROMPT_FLAGS.filter((f) => new RegExp(`#${f}\\b`, 'i').test(text));
}

// 上传的图片：文件名里带 #fail 时记在 token 上（mock-img-<随机>.fail），建任务时从 token 读出来，不用另外存
const failsByToken = (token: string): boolean => token.split('.').slice(1).includes('fail');

// 看文件头认图片：PNG 是 89 50 4E 47 0D 0A 1A 0A，JPEG 是 FF D8 FF
async function sniffImage(file: Blob): Promise<'png' | 'jpg' | null> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= 8 && png.every((b, i) => head[i] === b)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  return null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });
// 429：回复体带 retryAfter（秒），头里带 Retry-After（和真的中转一样）
const busy = (code: 'rate_limited' | 'daily_cap', message: string, retryAfter: number): Response =>
  json(429, { ok: false, code, message, retryAfter }, { 'Retry-After': String(retryAfter) });

// 建任务的请求体核对：不对时给一句原因（中转回 400 bad_request 时也是这样）
type Checked = { ok: true; mode: GenMode; flags: Flag[]; fail: boolean; prompt: string } | { ok: false; message: string };

// 图片引用：token 必须是这个模拟中转发的；type 可以不带，带了就要是 png / jpg
function checkRef(v: unknown): { token: string } | null {
  if (!isRecord(v) || typeof v.token !== 'string' || !v.token.startsWith('mock-img-')) return null;
  if (v.type !== undefined && (typeof v.type !== 'string' || !REF_TYPES.includes(v.type.toLowerCase()))) return null;
  return { token: v.token };
}

function checkTask(body: unknown): Checked {
  if (!isRecord(body)) return { ok: false, message: 'Send the task as a JSON object.' };
  const { mode, texture, pbr, modelVersion, textureQuality, faceLimit } = body;
  if ((texture !== undefined && typeof texture !== 'boolean') || (pbr !== undefined && typeof pbr !== 'boolean')) return { ok: false, message: 'texture and pbr must be true or false.' };
  if (modelVersion !== undefined && typeof modelVersion !== 'string') return { ok: false, message: 'modelVersion must be a string.' };
  if (textureQuality !== undefined && textureQuality !== 'standard' && textureQuality !== 'fast') return { ok: false, message: 'textureQuality must be standard or fast.' };
  if (faceLimit !== undefined && !Number.isInteger(faceLimit)) return { ok: false, message: 'faceLimit must be a whole number.' };
  if (mode === 'text') {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return { ok: false, message: 'Describe the model you want.' };
    if (prompt.length > MAX_PROMPT) return { ok: false, message: `Prompts can be up to ${MAX_PROMPT} characters.` };
    const flags = flagsIn(prompt);
    return { ok: true, mode, flags, fail: flags.includes('fail'), prompt };
  }
  if (mode === 'image') {
    const ref = checkRef(body);
    if (!ref) return { ok: false, message: 'Upload a PNG or JPEG image first, then send its token.' };
    return { ok: true, mode, flags: [], fail: failsByToken(ref.token), prompt: '' };
  }
  if (mode === 'multiview') {
    const views = body.views;
    if (!Array.isArray(views) || views.length !== 4) return { ok: false, message: 'Send four views in this order: front, left, back, right.' };
    if (!checkRef(views[0])) return { ok: false, message: 'The front view is required.' };
    const refs = views.map((v) => (v === null ? null : checkRef(v)));
    if (refs.some((r, i) => r === null && views[i] !== null)) return { ok: false, message: 'Each view must be an uploaded image or null.' };
    const given = refs.filter((r): r is { token: string } => r !== null);
    if (given.length < 2) return { ok: false, message: 'Add at least one more view besides the front.' };
    return { ok: true, mode, flags: [], fail: given.some((r) => failsByToken(r.token)), prompt: '' };
  }
  return { ok: false, message: 'Unknown generation mode.' };
}

function modelFor(mode: GenMode, prompt: string): string {
  if (mode === 'image') return MOCK_IMAGE_MODEL;
  if (mode === 'multiview') return MOCK_MULTIVIEW_MODEL;
  return MOCK_TEXT_MODELS[hashString(prompt.toLowerCase()) % MOCK_TEXT_MODELS.length];
}

// 到下一个 UTC 零点还有多少秒（#cap 的 retryAfter），至少 60
function secondsToMidnight(t: number): number {
  const next = new Date(t);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - t) / 1000));
}

// 把一个 fetch 换成模拟中转：base 下面的请求在这里回答，别的照常交给真的 fetch
export function createMockFetch(opts: MockOptions): typeof fetch {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = opts.now ?? (() => Date.now());
  const wantSpeed = opts.speed ?? searchNumber('mockspeed') ?? 1;
  const speed = Number.isFinite(wantSpeed) && wantSpeed > 0 ? Math.min(1000, wantSpeed) : 1;
  const start = opts.startBalance ?? searchNumber('mockcredits') ?? MOCK_START_BALANCE;
  const latency = (): number => (opts.latency ?? 60 + Math.random() * 140) / speed;
  const fetchModel = opts.fetchModel ?? (async (file: string): Promise<Blob> => {
    const res = await globalThis.fetch(`${import.meta.env.BASE_URL}models/${file}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: models/${file}`);
    return res.blob();
  });
  let memory: MockState = fresh(); // 没有存储（或者存储坏了）时的状态

  const load = (): MockState => {
    if (!storage) return memory;
    try {
      return parseState(storage.getItem(MOCK_KEY));
    } catch {
      return memory;
    }
  };
  const save = (state: MockState): void => {
    memory = state;
    try {
      storage?.setItem(MOCK_KEY, JSON.stringify(state));
    } catch {
      // 写不进去（配额满）：只留在内存里
    }
  };

  // 任务现在到哪一步：按建好以后过了多久算（所以刷新以后接得上）
  const statusOf = (task: MockTask, t: number): MockStatus => {
    const elapsed = Math.max(0, (t - task.createdAt) * speed);
    if (elapsed < MOCK_QUEUE_MS) return { status: 'queued', progress: 0 };
    const run = (elapsed - MOCK_QUEUE_MS) / MOCK_RUN_MS;
    if (task.fail && run * 99 >= MOCK_FAIL_AT) return { status: 'failed', progress: MOCK_FAIL_AT, error: MOCK_FAIL_ERROR };
    if (run < 1) return { status: 'running', progress: Math.min(99, Math.floor(run * 99)) };
    return { status: 'success', progress: 100 };
  };

  // 额度：排队、生成中的冻结着；成功的扣掉；失败的退回
  const totals = (state: MockState, t: number): { balance: number; frozen: number } => {
    let used = state.spent;
    let frozen = 0;
    for (const task of state.tasks) {
      const s = statusOf(task, t).status;
      if (s === 'queued' || s === 'running') frozen += task.cost;
      else if (s === 'success') used += task.cost;
    }
    return { balance: money(Math.max(0, start - used - frozen)), frozen: money(frozen) };
  };

  // 存档太长时删最早结束的任务；成功的那些花掉的额度记进 spent
  const prune = (state: MockState, t: number): void => {
    while (state.tasks.length > MAX_TASKS) {
      const i = state.tasks.findIndex((task) => {
        const s = statusOf(task, t).status;
        return s === 'success' || s === 'failed';
      });
      if (i < 0) break;
      const [gone] = state.tasks.splice(i, 1);
      if (statusOf(gone, t).status === 'success') state.spent += gone.cost;
    }
  };

  async function readForm(input: RequestInfo | URL, init?: RequestInit): Promise<FormData | null> {
    if (init?.body instanceof FormData) return init.body;
    try {
      if (input instanceof Request) return await input.clone().formData();
    } catch {
      // 读不出来：当作没带
    }
    return null;
  }

  async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
    try {
      if (typeof init?.body === 'string') return JSON.parse(init.body);
      if (input instanceof Request) return await input.clone().json();
    } catch {
      // 不是 JSON
    }
    return undefined;
  }

  async function upload(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const form = await readForm(input, init);
    const file = form?.get('file');
    if (!(file instanceof Blob)) return fail(400, 'bad_request', 'Attach the image in a field named "file".');
    if (file.size > MOCK_MAX_IMAGE_BYTES) return fail(400, 'bad_request', 'Images must be 10 MB or smaller.');
    const type = await sniffImage(file);
    if (!type) return fail(400, 'bad_request', 'Only PNG and JPEG images can be used.');
    const fails = /#fail\b/i.test((file as File).name ?? '');
    const id = `${now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}`;
    return json(200, { ok: true, token: `mock-img-${id}${fails ? '.fail' : ''}`, type });
  }

  async function createTask(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const checked = checkTask(await readBody(input, init));
    if (!checked.ok) return fail(400, 'bad_request', checked.message);
    const t = now();
    if (checked.flags.includes('quota')) return fail(402, 'quota', 'Not enough credits (mock #quota).');
    if (checked.flags.includes('upstream')) return fail(502, 'upstream', 'Tripo had a problem starting this task (mock #upstream).');
    if (checked.flags.includes('cap')) return busy('daily_cap', 'Daily generation limit reached (mock #cap).', secondsToMidnight(t));
    if (checked.flags.includes('rate')) return busy('rate_limited', 'Too many requests (mock #rate).', MOCK_RATE_RETRY_AFTER);
    const state = load();
    const cost = MOCK_COSTS[checked.mode];
    if (totals(state, t).balance < cost) return fail(402, 'quota', 'Not enough credits for this generation.');
    state.seq += 1;
    const task: MockTask = { id: `mock-${t.toString(36)}-${state.seq.toString(36)}`, mode: checked.mode, createdAt: t, cost, fail: checked.fail, model: modelFor(checked.mode, checked.prompt) };
    state.tasks.push(task);
    prune(state, t);
    save(state);
    return json(200, { ok: true, taskId: task.id });
  }

  function getTask(id: string): Response {
    const task = load().tasks.find((x) => x.id === id);
    if (!task) return fail(404, 'not_found', 'No task with that id.');
    const s = statusOf(task, now());
    const body: Record<string, unknown> = { ok: true, status: s.status, progress: s.progress };
    if (s.status === 'success') {
      body.modelUrl = `${opts.base.replace(/\/+$/, '')}/download/${encodeURIComponent(id)}`;
      // 预览图用静态文件的地址：页面上 <img> 直接加载，不经过这个 fetch 适配器
      body.previewUrl = `${import.meta.env.BASE_URL}thumbs/${task.model.replace(/\.glb$/, '.webp')}`;
    }
    if (s.error) body.error = s.error;
    return json(200, body);
  }

  async function download(id: string): Promise<Response> {
    const task = load().tasks.find((x) => x.id === id);
    if (!task) return fail(404, 'not_found', 'No task with that id.');
    const s = statusOf(task, now()).status;
    if (s === 'failed') return fail(404, 'not_found', 'This task has no model.');
    if (s !== 'success') return fail(400, 'bad_request', "That model isn't ready yet.");
    let blob: Blob;
    try {
      blob = await fetchModel(task.model);
    } catch (err) {
      return fail(502, 'upstream', `Could not read the mock model (${err instanceof Error ? err.message : String(err)}).`);
    }
    return new Response(blob, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
  }

  // 模型列表和服务端中转用同一份目录（server/tripo/handler.mjs 的 MODEL_CATALOG、ETA_SEC），按默认放行的版本列：
  // 动态加载，只有模拟模式下问到模型列表时才拉这一块，平时不进页面的包
  async function models(): Promise<Response> {
    const { modelsInfo, readConfig } = await import('../../server/tripo/handler.mjs');
    return json(200, { ok: true, ...modelsInfo(readConfig({})) });
  }

  async function route(method: string, parts: string[], input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const [head, id, ...rest] = parts;
    const allow = (m: string, run: () => Response | Promise<Response>): Response | Promise<Response> => (method === m ? run() : fail(405, 'bad_request', `Use ${m} for this endpoint.`));
    if (head === 'health' && !id) return allow('GET', () => json(200, { ok: true, mock: true }));
    if (head === 'models' && !id) return allow('GET', models);
    if (head === 'balance' && !id) return allow('GET', () => json(200, { ok: true, ...totals(load(), now()) }));
    if (head === 'upload' && !id) return allow('POST', () => upload(input, init));
    if (head === 'task' && !id) return allow('POST', () => createTask(input, init));
    if (head === 'task' && id && !rest.length) return allow('GET', () => getTask(id));
    if (head === 'download' && id && !rest.length) return allow('GET', () => download(id));
    return fail(404, 'not_found', 'Unknown endpoint.');
  }

  return async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const page = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/';
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, page);
    const baseUrl = new URL(opts.base || '/', page);
    const basePath = baseUrl.pathname.replace(/\/+$/, '');
    const inside = url.origin === baseUrl.origin && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
    if (!inside) return globalThis.fetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const parts = url.pathname.slice(basePath.length).split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const wait = latency();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await route(method, parts, input, init);
    } catch (err) {
      return fail(500, 'upstream', `Mock server error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// 清掉模拟中转的状态（任务、额度回到开始的样子）。Reset demo 不会动它（真的中转也不会跟着重置）；自查脚本、手动重来时用
export function clearMockState(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(MOCK_KEY);
  } catch {
    // 删不掉也没关系
  }
}

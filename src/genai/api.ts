import { describeError } from './messages';
import { createMockFetch } from './mock';
import type { GenErrorCode, ImageRef, TaskInfo, TaskRequest, TaskStatus, TripoApi, TripoErrorCode } from './types';

// 调服务端中转（T1，/api/tripo/*）的客户端。密钥只在服务端，这里只发请求、把回复和错误整理成 types.ts 里的样子。
// 失败一律抛 TripoError：code 是错误码（中转给的，或者按 HTTP 状态、连不上、回的不是 JSON 推出来的），
// message 已经是给人看的英文句子（messages.ts 的 describeError），serverMessage 是中转的原话（调试、细节用）

const SERVER_CODES: readonly TripoErrorCode[] = ['rate_limited', 'daily_cap', 'quota', 'bad_request', 'upstream', 'not_found'];
const STATUSES: readonly TaskStatus[] = ['queued', 'running', 'success', 'failed', 'cancelled', 'unknown'];
const ACCEPT_JSON = { Accept: 'application/json' };

export class TripoError extends Error {
  readonly code: GenErrorCode;
  readonly status?: number; // HTTP 状态（连不上时没有）
  readonly serverMessage?: string; // 中转回复里的 message 原话
  readonly retryAfter?: number; // 多少秒以后再试（429 回复的 retryAfter 字段或 Retry-After 头）

  constructor(code: GenErrorCode, opts: { status?: number; serverMessage?: string; retryAfter?: number; message?: string } = {}) {
    super(opts.message ?? describeError(code, opts.serverMessage, opts.retryAfter));
    this.name = 'TripoError';
    this.code = code;
    this.status = opts.status;
    this.serverMessage = opts.serverMessage;
    this.retryAfter = opts.retryAfter;
  }
}

// 任何异常 → TripoError：已经是就原样返回；别的（fetch 本身抛的 TypeError、代码错误）当作连不上
export function toTripoError(err: unknown): TripoError {
  if (err instanceof TripoError) return err;
  return new TripoError('network', { serverMessage: err instanceof Error ? err.message : undefined });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// 没有错误码时按 HTTP 状态推：401 / 403 / 405 / 501 多半是中转没部署好、不让用（静态托管收到 POST 回 405）
function codeForStatus(status: number): GenErrorCode {
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 409 || status === 413 || status === 415 || status === 422) return 'bad_request';
  if (status === 401 || status === 403 || status === 405 || status === 501) return 'unavailable';
  return 'upstream';
}

// 回复体按 JSON 读；读不出来（空的、HTML 错误页、静态托管回的 index.html）返回 undefined
async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text.trim()) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (!/json/i.test(type) && !/^\s*[{[]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// 多少秒以后再试：回复体的 retryAfter（秒，数字或数字字符串）优先，其次 Retry-After 头（秒数或 HTTP 日期）。没有时 undefined
export function retryAfterOf(res: Response, body: unknown, now = Date.now()): number | undefined {
  const fromBody = isRecord(body) ? toNumber(body.retryAfter) : null;
  if (fromBody !== null && fromBody >= 0) return fromBody;
  const header = res.headers.get('retry-after')?.trim();
  if (!header) return undefined;
  const seconds = toNumber(header);
  if (seconds !== null) return seconds >= 0 ? seconds : undefined;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

// 失败的回复 → TripoError。回复里有认识的 code 就用它；没有时按状态推。
// missing：404 而且回的不是中转的 JSON（路由根本不存在）时算什么——JSON 接口算中转没部署（unavailable），下载算模型没了（not_found）
function failure(res: Response, body: unknown, missing: GenErrorCode): TripoError {
  const rec = isRecord(body) ? body : null;
  const serverMessage = rec && typeof rec.message === 'string' ? rec.message : undefined;
  const retryAfter = retryAfterOf(res, body);
  const code = rec && typeof rec.code === 'string' && (SERVER_CODES as readonly string[]).includes(rec.code) ? (rec.code as TripoErrorCode) : null;
  if (code) return new TripoError(code, { status: res.status, serverMessage, retryAfter });
  if (res.status === 404 && !rec) return new TripoError(missing, { status: 404 });
  return new TripoError(codeForStatus(res.status), { status: res.status, serverMessage, retryAfter });
}

function malformed(what: string): TripoError {
  return new TripoError('upstream', { serverMessage: `The Tripo service sent a malformed ${what} reply` });
}

// base：中转地址（不带结尾的 /），例如 /api/tripo、https://example.com/api/tripo。
// fetch：换掉发请求的函数（模拟模式、单元测试）；不给时用浏览器的 fetch
export function createTripoApi(opts: { base: string; fetch?: typeof fetch }): TripoApi {
  const base = opts.base.replace(/\/+$/, '');
  // 不存成对象的方法：浏览器的 fetch 用别的 this 调会报 Illegal invocation
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, init);
    } catch (err) {
      throw new TripoError('network', { serverMessage: err instanceof Error ? err.message : undefined });
    }
  }

  // JSON 接口：失败抛 TripoError；成功时返回回复体（一定是对象）
  async function json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await send(path, init);
    const body = await readJson(res);
    if (!res.ok) throw failure(res, body, 'unavailable');
    // 200 但不是 JSON：多半是静态托管把 /api/tripo/... 回成了 index.html（中转没部署）
    if (!isRecord(body)) throw new TripoError('unavailable', { status: res.status });
    if (body.ok === false) throw failure(res, body, 'unavailable');
    return body;
  }

  const enc = encodeURIComponent;

  return {
    base,

    async health() {
      try {
        const body = await json('/health', { cache: 'no-store', headers: ACCEPT_JSON });
        return { ok: body.ok !== false, mock: body.mock === true };
      } catch (err) {
        // 健康检查都 404：中转没部署
        if (err instanceof TripoError && err.code === 'not_found') throw new TripoError('unavailable', { status: err.status, serverMessage: err.serverMessage });
        throw err;
      }
    },

    async balance() {
      const body = await json('/balance', { cache: 'no-store', headers: ACCEPT_JSON });
      const balance = toNumber(body.balance);
      if (balance === null) throw malformed('balance');
      return { balance, frozen: toNumber(body.frozen) ?? 0 };
    },

    async upload(file: Blob, name: string): Promise<ImageRef> {
      const form = new FormData();
      form.append('file', file, name);
      // 不设 Content-Type：浏览器自己写 multipart 的分隔符
      const body = await json('/upload', { method: 'POST', body: form, headers: ACCEPT_JSON });
      if (typeof body.token !== 'string' || !body.token) throw malformed('upload');
      // type 可以没有（中转按 token 自己判断）：有才带上
      return typeof body.type === 'string' && body.type ? { token: body.token, type: body.type } : { token: body.token };
    },

    async createTask(req: TaskRequest) {
      const body = await json('/task', { method: 'POST', headers: { ...ACCEPT_JSON, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
      const taskId = typeof body.taskId === 'string' ? body.taskId : typeof body.task_id === 'string' ? body.task_id : '';
      if (!taskId) throw malformed('task');
      return { taskId };
    },

    async getTask(taskId: string): Promise<TaskInfo> {
      const body = await json(`/task/${enc(taskId)}`, { cache: 'no-store', headers: ACCEPT_JSON });
      const status = typeof body.status === 'string' && (STATUSES as readonly string[]).includes(body.status) ? (body.status as TaskStatus) : 'unknown';
      const progress = Math.min(100, Math.max(0, toNumber(body.progress) ?? 0));
      const info: TaskInfo = { status, progress };
      if (typeof body.modelUrl === 'string') info.modelUrl = body.modelUrl;
      if (typeof body.previewUrl === 'string') info.previewUrl = body.previewUrl;
      if (typeof body.error === 'string') info.error = body.error;
      else if (isRecord(body.error) && typeof body.error.message === 'string') info.error = body.error.message;
      return info;
    },

    async download(taskId: string): Promise<Blob> {
      const res = await send(`/download/${enc(taskId)}`, { headers: { Accept: 'model/gltf-binary, application/octet-stream, */*' } });
      if (!res.ok) throw failure(res, await readJson(res), 'not_found');
      const type = res.headers.get('content-type') ?? '';
      if (/text\/html/i.test(type)) throw new TripoError('unavailable', { status: res.status });
      // 回的是 JSON 不是模型：当作出错（有 code 用 code，没有算 upstream）
      if (/json/i.test(type)) throw failure(res, await readJson(res), 'not_found');
      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (err) {
        throw new TripoError('network', { serverMessage: err instanceof Error ? err.message : undefined });
      }
      if (!blob.size) throw new TripoError('upstream', { serverMessage: 'The model file was empty' });
      return blob;
    },
  };
}

// 中转地址：构建时的 VITE_TRIPO_PROXY（例如 https://example.com/api/tripo），不设时用同源的 /api/tripo。不带结尾的 /
export function defaultTripoBase(): string {
  const raw: unknown = import.meta.env.VITE_TRIPO_PROXY;
  const base = typeof raw === 'string' && raw.trim() ? raw.trim() : '/api/tripo';
  return base.replace(/\/+$/, '');
}

// 地址带 ?tripo=mock：用前端的模拟中转（mock.ts），不发任何真实请求
export function isMockMode(search: string = typeof location !== 'undefined' ? location.search : ''): boolean {
  return new URLSearchParams(search).get('tripo') === 'mock';
}

// 页面用的客户端：模拟模式走 mock.ts 的假 fetch，平时走浏览器的 fetch
export function tripoApiForPage(): TripoApi {
  const base = defaultTripoBase();
  return createTripoApi(isMockMode() ? { base, fetch: createMockFetch({ base }) } : { base });
}

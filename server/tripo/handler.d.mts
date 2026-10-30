// handler.mjs 的类型：接口约定（/api/tripo/*）和处理函数

export type TripoEnv = Record<string, string | undefined>;

export type TripoErrorCode = 'rate_limited' | 'daily_cap' | 'quota' | 'bad_request' | 'upstream' | 'not_found';
export type TripoTaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';

// ---------- 接口约定 ----------
export interface TripoError { ok: false; code: TripoErrorCode; message: string; retryAfter?: number }
export interface TripoHealth { ok: true; mock: boolean }
export interface TripoBalance { ok: true; balance: number; frozen: number }
export interface TripoUploaded { ok: true; token: string; type: 'png' | 'jpeg' }
export interface TripoView { token: string; type?: string }
// 三种任务共用的可选字段。textureQuality：fast 是快速贴图（不加钱，只有目录里写了 fast 的版本能用）；
// faceLimit：0 = 不发 face_limit，不传用中转的默认（TRIPO_FACE_LIMIT，默认 30 万）
export interface TripoTaskOptions { texture?: boolean; pbr?: boolean; modelVersion?: string; textureQuality?: 'standard' | 'fast'; faceLimit?: number; compress?: boolean }
export type TripoTaskRequest =
  | ({ mode: 'text'; prompt: string } & TripoTaskOptions)
  | ({ mode: 'image'; token: string; type?: string } & TripoTaskOptions)
  // 顺序：前、左、后、右；正面必须有，至少 2 张
  | ({ mode: 'multiview'; views: [TripoView | null, TripoView | null, TripoView | null, TripoView | null] } & TripoTaskOptions);
// GET /models：放行的模型版本和它们的说明。eta、credits 按 [生成方式][贴图档] 查，这个版本不支持的贴图档没有键
export type TripoTextureChoice = 'none' | 'fast' | 'standard';
export type TripoModeTable = Record<'text' | 'image' | 'multiview', Partial<Record<TripoTextureChoice, number | null>>>;
export interface TripoModelInfo {
  id: string;
  label: string;
  blurb: string;
  textures: TripoTextureChoice[];
  eta: TripoModeTable | null; // 秒，从建任务到 success
  measured: boolean; // eta 是实测的（scripts/bench-tripo.mjs）还是估的
  credits: TripoModeTable | null;
}
export interface TripoModels { ok: true; defaultModel: string; defaultTexture: TripoTextureChoice; models: TripoModelInfo[] }
export interface TripoTaskCreated { ok: true; taskId: string }
export interface TripoTaskState {
  ok: true;
  status: TripoTaskStatus;
  progress: number;
  modelUrl?: string;
  previewUrl?: string;
  credits?: number; // success 时 Tripo 报的扣费（credits_consumed）；模拟模式没有
  error?: string;
}

// ---------- 处理函数 ----------
export interface RateLimitHit { ok: boolean; retryAfterMs: number | null; release(): void }
export interface RateLimitStore {
  hit(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitHit> | RateLimitHit;
}
export interface MockAsset { body: ReadableStream<Uint8Array> | Uint8Array; size?: number; contentType?: string }
export interface TripoHandlerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  store?: RateLimitStore;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
  loadMockModel?: (env: TripoEnv, request: Request) => Promise<MockAsset | null>;
  loadMockPreview?: (env: TripoEnv, request: Request) => Promise<MockAsset | null>;
}
export interface TripoRequestInfo { ip?: string | null }
export type TripoHandle = (request: Request, env?: TripoEnv | null, info?: TripoRequestInfo | null) => Promise<Response>;

export interface TripoConfig {
  key: string;
  mock: boolean;
  apiBase: string;
  tasksPerIpPerHour: number;
  tasksPerDay: number;
  uploadsPerIpPerHour: number;
  requestsPerIpPerMinute: number;
  maxImageBytes: number;
  maxDownloadBytes: number;
  origins: string[];
  modelVersions: string[];
  defaultModel: string;
  downloadHosts: string[];
  faceLimit: number; // 0 = 不发 face_limit
  compress: boolean; // TRIPO_COMPRESS=geometry
}

export function createHandler(options?: TripoHandlerOptions): TripoHandle;
export const handle: TripoHandle;
export function readConfig(env?: TripoEnv): TripoConfig;
export function createMemoryStore(options?: { maxKeys?: number }): RateLimitStore;
// 滑动窗口的纯逻辑（内存版和 Durable Objects 版共用）：stamps 升序，原地修改
export interface WindowResult { ok: boolean; retryAfterMs: number | null }
export const RATE_WINDOW_MAX_MS: number;
export function pruneStamps(stamps: number[], since: number): void;
export function windowHit(stamps: number[], limit: number, windowMs: number, now: number): WindowResult;
export function windowRelease(stamps: number[], stamp: number): boolean;
export function ipKey(ip: string | null | undefined): string;
export function matchTripoPath(pathname: string): { prefix: string; route: string } | null;
export function isTripoPath(pathname: string): boolean;
export function buildTask(body: unknown, cfg: TripoConfig): {
  mode: 'text' | 'image' | 'multiview';
  route: string;
  payload: Record<string, unknown>;
  mockTriggers: { fail: boolean; quota: boolean; upstream: boolean };
  optional: string[]; // payload 里加速用的可选字段（被 Tripo 拒时去掉重试）
};
export function modelsInfo(cfg: TripoConfig): Omit<TripoModels, 'ok'>;
export const MODEL_CATALOG: Record<string, { label: string; blurb: string; textures: TripoTextureChoice[]; fastQuality?: boolean; compress?: boolean; maxFaces?: number; credits: TripoModeTable }>;
export const ETA_SEC: Record<string, TripoModeTable & { measured: boolean }>;
export const FAST_TEXTURE_VERSION: string;
export const DEFAULT_TEXTURE: TripoTextureChoice;

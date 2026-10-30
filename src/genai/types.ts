// Tripo 生成（src/genai/）的类型：和服务端中转（T1，/api/tripo/*）约定的接口 + 本地的生成任务。
// 密钥只在服务端；前端只调中转。中转地址：import.meta.env.VITE_TRIPO_PROXY，默认同源的 /api/tripo。
//
// 中转接口（成功时 ok: true；失败时 HTTP 4xx/5xx + { ok: false, code, message }）：
//   GET  /health        → { ok, mock }
//   GET  /models        → { ok, defaultModel, models }（模型选择器：说明、预计耗时、积分）
//   GET  /balance       → { ok, balance, frozen }
//   POST /upload        （multipart，字段 file）→ { ok, token, type }
//   POST /task          （JSON，TaskRequest）→ { ok, taskId }
//   GET  /task/:id      → { ok, status, progress, modelUrl?, previewUrl?, error? }
//   GET  /download/:id  → GLB 文件

export type GenMode = 'text' | 'image' | 'multiview';

// 中转返回的错误码
export type TripoErrorCode = 'rate_limited' | 'daily_cap' | 'quota' | 'bad_request' | 'upstream' | 'not_found';
// 前端自己补的：network 连不上；unavailable 中转没部署（404、返回的不是 JSON）；import_failed 下载的模型导入失败；
// interrupted 页面在任务建好之前关掉了（刷新以后接不上）
export type GenErrorCode = TripoErrorCode | 'network' | 'unavailable' | 'import_failed' | 'interrupted';

export interface GenError {
  code: GenErrorCode;
  message: string; // 给人看的英文句子（messages.ts 的 describeError）
  retryAfter?: number; // 429（rate_limited、daily_cap）：中转说多少秒以后再试
  detail?: string; // 中转、Tripo 的原话（多半是中文）、导入管线的报错：只给控制台、日志看，不显示给用户
}

// 上传图片后拿到的引用
export interface ImageRef {
  token: string;
  type?: string; // 文件类型：png / jpg（中转回了才有；没有时中转按 token 自己判断）
}

export interface GenOptions {
  texture?: boolean; // 生成贴图（默认 true）
  pbr?: boolean; // 生成 PBR 材质（默认 true）
  modelVersion?: string; // 不给就用中转的默认版本
  textureQuality?: 'standard' | 'fast'; // 贴图档：fast 是快速贴图（同价，只有模型目录里写了 fast 的版本能用）
}

// —— 模型选择器（GET /models，中转是唯一的来源）——
// 贴图档：none 不带贴图、fast 快速贴图、standard 标准贴图
export type TextureChoice = 'none' | 'fast' | 'standard';
// 按 [生成方式][贴图档] 查的表（秒、积分）；这个模型不支持的贴图档没有键（或者是 null）
export type ModeTable = Record<GenMode, Partial<Record<TextureChoice, number | null>>>;

export interface ModelInfo {
  id: string; // 发给中转的 modelVersion，例如 v3.1-20260211
  label: string; // 界面上的名字，例如 H3.1
  blurb: string; // 一句话的长处（英文）
  textures: TextureChoice[];
  eta: ModeTable | null; // 预计耗时（秒，从建任务到完成）；中转的 ETA_SEC 表
  measured: boolean; // eta 是实测的还是估的
  credits: ModeTable | null;
}

export interface ModelList {
  defaultModel: string;
  defaultTexture: TextureChoice; // 界面上默认选中的贴图档（中转的 DEFAULT_TEXTURE）
  models: ModelInfo[];
}

export type TaskRequest =
  | ({ mode: 'text'; prompt: string } & GenOptions)
  | ({ mode: 'image' } & ImageRef & GenOptions)
  | ({ mode: 'multiview'; views: Array<ImageRef | null> } & GenOptions); // 4 个，顺序：前、左、后、右；前视图必须有

export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';

export interface TaskInfo {
  status: TaskStatus;
  progress: number; // 0–100
  modelUrl?: string;
  previewUrl?: string;
  credits?: number; // success 时这个任务扣了多少积分（真实模式才有）
  error?: string;
}

// 下载进度：loaded 已收到的字节，total 总字节（中转给了 Content-Length 才有）
export interface DownloadProgress {
  loaded: number;
  total?: number;
}

// 调中转的客户端（api.ts）。失败时抛 TripoError（code、message、status）
export interface TripoApi {
  readonly base: string;
  health(): Promise<{ ok: boolean; mock: boolean }>;
  models(): Promise<ModelList>;
  balance(): Promise<{ balance: number; frozen: number }>;
  upload(file: Blob, name: string): Promise<ImageRef>;
  createTask(req: TaskRequest): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<TaskInfo>;
  download(taskId: string, onProgress?: (p: DownloadProgress) => void): Promise<Blob>;
  resolve(url: string): string; // 中转回的相对地址（previewUrl）→ 能放进 <img> 的地址（中转和网页分开部署时按中转的地址解析）
}

// —— 本地的生成任务（jobs.ts）——
// 状态机：uploading（只有图片模式）→ submitting → queued → running → downloading → importing → done；
// 提交时出错、任务找不到（not_found）、Tripo 说任务失败、导入失败 → failed；轮询、下载时 Tripo 忙、连不上不算失败（stalled，接着重试）；
// 用户取消 → cancelled（只停止轮询，中转没有取消接口）
export type JobPhase = 'uploading' | 'submitting' | 'queued' | 'running' | 'downloading' | 'importing' | 'done' | 'failed' | 'cancelled';

export const ACTIVE_PHASES: readonly JobPhase[] = ['uploading', 'submitting', 'queued', 'running', 'downloading', 'importing'];

export interface GenJob {
  id: string; // 本地 id（job- 开头）
  mode: GenMode;
  prompt?: string; // 文字模式的提示词
  inputNames?: string[]; // 图片模式：上传的文件名（只用来显示）
  title: string; // 作品名（默认从提示词、文件名来）
  teamId: string; // 在哪颗星球上发起的：作品归这个团队
  options: GenOptions;
  taskId?: string; // Tripo 任务 id：有了它，刷新以后才能接着轮询
  phase: JobPhase;
  progress: number; // 0–100
  createdAt: number;
  updatedAt: number;
  error?: GenError;
  workId?: string; // done 以后：加进去的作品 id
  seen?: boolean; // 用户看过结果（点过完成提示，或者在窗口里打开过）
  stalled?: boolean; // 轮询、下载暂时出错正在重试（Tripo 忙、连不上）：不存档，刷新以后重新判断
  // —— 速度和预计时间 ——
  etaSec?: number; // 提交时按模型目录估的耗时（秒，从建任务到完成）：倒计时、轮询收尾都按它
  modelLabel?: string; // 用的模型（H3.1 之类，只用来显示）
  startedAt?: number; // 拿到 taskId 的时间（倒计时从这里算）
  runningAt?: number; // 第一次看到 running 的时间（按进度推剩余时间）
  previewUrl?: string; // Tripo 渲染的预览图（任务成功就有）：下载、导入模型期间先显示它
  download?: DownloadProgress; // 下载进度：不存档
}

// 提交一个生成任务
export type GenInput =
  | { mode: 'text'; prompt: string }
  | { mode: 'image'; image: File }
  | { mode: 'multiview'; views: Array<File | null> }; // 前、左、后、右

export type GenSubmit = GenInput & { title: string; teamId: string; options: GenOptions; etaSec?: number; modelLabel?: string };

// 任务变了（状态、进度）：from 是变之前的阶段（新建的任务是 null）
export interface JobEvent {
  job: GenJob;
  from: JobPhase | null;
}

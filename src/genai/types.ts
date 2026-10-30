// Tripo 生成（src/genai/）的类型：和服务端中转（T1，/api/tripo/*）约定的接口 + 本地的生成任务。
// 密钥只在服务端；前端只调中转。中转地址：import.meta.env.VITE_TRIPO_PROXY，默认同源的 /api/tripo。
//
// 中转接口（成功时 ok: true；失败时 HTTP 4xx/5xx + { ok: false, code, message }）：
//   GET  /health        → { ok, mock }
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
}

// 上传图片后拿到的引用
export interface ImageRef {
  token: string;
  type: string; // 文件类型：jpg / png / webp
}

export interface GenOptions {
  texture?: boolean; // 生成贴图（默认 true）
  pbr?: boolean; // 生成 PBR 材质（默认 true）
  modelVersion?: string; // 不给就用中转的默认版本
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
  error?: string;
}

// 调中转的客户端（api.ts）。失败时抛 TripoError（code、message、status）
export interface TripoApi {
  readonly base: string;
  health(): Promise<{ ok: boolean; mock: boolean }>;
  balance(): Promise<{ balance: number; frozen: number }>;
  upload(file: Blob, name: string): Promise<ImageRef>;
  createTask(req: TaskRequest): Promise<{ taskId: string }>;
  getTask(taskId: string): Promise<TaskInfo>;
  download(taskId: string): Promise<Blob>;
}

// —— 本地的生成任务（jobs.ts）——
// 状态机：uploading（只有图片模式）→ submitting → queued → running → downloading → importing → done；
// 任何一步出错 → failed；用户取消 → cancelled（只停止轮询，中转没有取消接口）
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
}

// 提交一个生成任务
export type GenInput =
  | { mode: 'text'; prompt: string }
  | { mode: 'image'; image: File }
  | { mode: 'multiview'; views: Array<File | null> }; // 前、左、后、右

export type GenSubmit = GenInput & { title: string; teamId: string; options: GenOptions };

// 任务变了（状态、进度）：from 是变之前的阶段（新建的任务是 null）
export interface JobEvent {
  job: GenJob;
  from: JobPhase | null;
}

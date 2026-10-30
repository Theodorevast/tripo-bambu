// 主线程这一头的导入：importModelFile(文件, 文件名) → 优化好的 GLB 和三角面数、大小、提示。
// 真正的活在 Worker（importWorker.ts）里做，主画面照常跑：主线程只把 Blob 交过去（只传引用，文件在 Worker 里读）、等结果（GLB 用 transfer 交回来）。
// 整个页面一个 Worker，第一次用时才建；请求排队，一次处理一个。空闲一分钟就关掉（WASM 的内存不会自己缩回去），下次用时再建。
// Worker 建不起来（浏览器不支持模块 Worker、脚本加载失败）：退回主线程（动态加载 importModel.ts，期间画面会卡），控制台留一条警告。
// 这个文件不能静态引用 importModel.ts：那样 gltf-transform、meshoptimizer 会打进主线程的包里
import { checkImportFile, IMPORT_MESSAGES } from './importCheck';
import { ImportError, type ImportOptions, type ImportProgress, type ImportReply, type ImportRequest, type ImportResult } from './importTypes';

export interface ImportFileOptions {
  options?: ImportOptions;
  onProgress?: (p: ImportProgress) => void;
}

const IDLE_MS = 60_000; // 空闲多久关掉 Worker
const SILENCE_MS = 180_000; // Worker 这么久一点消息都没有：当它卡死了（进度在每一段开头、每一轮简化后都会来）

let worker: Worker | null = null;
let heard = false; // 现在这个 Worker 回过消息（说明脚本加载好了）：之后再出错算崩溃，不算加载失败
let broken = false; // Worker 起不来过：之后都在主线程做
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

// Worker 本身出了问题（加载失败、崩了），不是文件的问题：heard = 这次请求之前已经收到过它的消息
class WorkerFailure extends Error {
  readonly heard: boolean;

  constructor(message: string, heard: boolean) {
    super(message);
    this.heard = heard;
  }
}

// 失败时 reject 一个 ImportError（code、给人看的 message）
export function importModelFile(file: Blob, name: string, opts: ImportFileOptions = {}): Promise<ImportResult> {
  const check = checkImportFile({ name, size: file.size }, opts.options);
  if (!check.ok) return Promise.reject(check.error);
  pending++;
  clearTimeout(idleTimer);
  const run = queue.then(() => runOne(file, name, opts));
  queue = run.catch(() => {});
  void run.finally(() => {
    pending--;
    if (pending === 0 && worker) idleTimer = setTimeout(disposeImportWorker, IDLE_MS);
  }).catch(() => {});
  return run;
}

// 关掉 Worker（空闲时自动调；测试、页面想马上收回内存时也可以调）。正在处理的请求会失败
export function disposeImportWorker(): void {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
}

function getWorker(): Worker | null {
  if (worker || broken) return worker;
  if (typeof Worker === 'undefined') {
    broken = true;
    return null;
  }
  try {
    // 必须原样写成 new Worker(new URL(..., import.meta.url))：Vite 认这个写法，把 Worker 单独打包
    worker = new Worker(new URL('./importWorker.ts', import.meta.url), { type: 'module' });
    heard = false;
  } catch (err) {
    console.warn('import: worker unavailable, preparing models on the main thread', err);
    broken = true;
  }
  return worker;
}

async function runOne(file: Blob, name: string, opts: ImportFileOptions): Promise<ImportResult> {
  const w = getWorker();
  if (!w) return runOnMainThread(file, name, opts);
  try {
    return await runInWorker(w, file, name, opts);
  } catch (err) {
    if (!(err instanceof WorkerFailure)) throw err;
    disposeImportWorker();
    // 一条消息都没收到就出错：Worker 脚本没加载起来，换主线程做，以后也不再建
    if (!err.heard) {
      console.warn('import: worker failed to start, preparing models on the main thread', err.message);
      broken = true;
      return runOnMainThread(file, name, opts);
    }
    console.error('import: worker crashed', err.message);
    throw new ImportError('unknown', IMPORT_MESSAGES.unknown);
  }
}

function runInWorker(w: Worker, file: Blob, name: string, opts: ImportFileOptions): Promise<ImportResult> {
  const id = nextId++;
  return new Promise<ImportResult>((resolve, reject) => {
    let silence: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      clearTimeout(silence);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      w.removeEventListener('messageerror', onMessageError);
    };
    const watch = (): void => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        finish();
        disposeImportWorker(); // 卡死的 Worker 关掉，下一次新建一个
        reject(new ImportError('unknown', IMPORT_MESSAGES.slow));
      }, SILENCE_MS);
    };
    const onMessage = (e: MessageEvent<ImportReply>): void => {
      const reply = e.data;
      if (!reply || reply.id !== id) return;
      heard = true;
      if (reply.type === 'progress') {
        watch();
        opts.onProgress?.(reply.progress);
        return;
      }
      finish();
      if (reply.type === 'done') resolve(reply.result);
      else reject(new ImportError(reply.code, reply.message));
    };
    const onError = (e: ErrorEvent): void => {
      e.preventDefault?.();
      finish();
      reject(new WorkerFailure(e.message || 'import worker error', heard));
    };
    const onMessageError = (): void => {
      finish();
      reject(new ImportError('unknown', IMPORT_MESSAGES.unknown));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.addEventListener('messageerror', onMessageError);
    watch();
    // 交的是 Blob 本身（只传引用）：文件在 Worker 里读，主线程不分配、不拷贝那几十 MB
    const request: ImportRequest = { id, file, name, options: opts.options ?? {} };
    w.postMessage(request);
  });
}

// 后备：主线程上做（动态加载，平时不下载这一块）
async function runOnMainThread(file: Blob, name: string, opts: ImportFileOptions): Promise<ImportResult> {
  const [{ importModel, browserResizeImage }, buffer] = await Promise.all([
    import('./importModel'),
    file.arrayBuffer().catch(() => {
      throw new ImportError('parse', IMPORT_MESSAGES.read);
    }),
  ]);
  return importModel(new Uint8Array(buffer), name, opts.options, { resizeImage: browserResizeImage, onProgress: opts.onProgress });
}

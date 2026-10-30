// 导入管线的 Worker（importClient.ts 建它）：读文件、解析、简化、缩贴图、压缩都在这里做，不占主画面的线程。
// 一次只处理一个请求（importClient 排队发），收到 ImportRequest（文件是 Blob，在这里读），回 progress（若干次）和 done / error 各一次。
// done 里的 GLB 用 transfer 交回去，不拷贝
import { IMPORT_MESSAGES } from './importCheck';
import { browserResizeImage, importModel } from './importModel';
import { ImportError, type ImportReply, type ImportRequest } from './importTypes';

// tsconfig 只带了 DOM 的类型：self 按 Window 算，postMessage 用带 options 的写法（Worker 里同样有效）
function post(reply: ImportReply, transfer: Transferable[] = []): void {
  self.postMessage(reply, { transfer });
}

async function handle({ id, file, name, options }: ImportRequest): Promise<void> {
  try {
    post({ id, type: 'progress', progress: { stage: 'reading', ratio: 0 } }); // 先回一声：说明 Worker 加载好了、开始读文件
    const bytes = await file.arrayBuffer().catch(() => {
      throw new ImportError('parse', IMPORT_MESSAGES.read);
    });
    const result = await importModel(new Uint8Array(bytes), name, options, {
      resizeImage: browserResizeImage,
      onProgress: (progress) => post({ id, type: 'progress', progress }),
    });
    // 交出去的必须是整块 ArrayBuffer：GLB 是别的缓冲里的一段时先拷出来
    const glb = result.glb.byteOffset === 0 && result.glb.byteLength === result.glb.buffer.byteLength ? result.glb : result.glb.slice();
    post({ id, type: 'done', result: { ...result, glb } }, [glb.buffer as ArrayBuffer]);
  } catch (err) {
    if (err instanceof ImportError) post({ id, type: 'error', code: err.code, message: err.message });
    else {
      console.error('import worker:', err);
      post({ id, type: 'error', code: 'unknown', message: IMPORT_MESSAGES.unknown });
    }
  }
}

self.addEventListener('message', (e: MessageEvent<ImportRequest>) => {
  void handle(e.data);
});

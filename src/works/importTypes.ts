// 导入管线（importModel.ts、importWorker.ts、importClient.ts）对外的类型：主线程、Worker、单元测试共用，不依赖 DOM 和 three

export const IMPORT_LIMITS = {
  maxBytes: 50 * 1024 * 1024, // 单个文件最大 50 MB
  maxTriangles: 300_000, // 超过就自动简化到它以内
  maxTextureSize: 2048, // 贴图边长超过就缩到它
} as const;

// 处理到哪一步（界面上的进度文字）：读文件 → 清理（dedup、weld）→ 简化 → 贴图 → 压缩输出 → 完成
export type ImportStage = 'reading' | 'cleaning' | 'simplifying' | 'textures' | 'compressing' | 'done';

export interface ImportProgress {
  stage: ImportStage;
  ratio: number; // 整体进度 0–1（估算）
}

export interface ImportOptions {
  maxTriangles?: number;
  maxTextureSize?: number;
  maxBytes?: number;
}

export interface ImportResult {
  glb: Uint8Array; // 优化后的 GLB（EXT_meshopt_compression，three 的 GLTFLoader 配了 MeshoptDecoder 就能读）
  triangles: number; // 优化后的三角面数
  trianglesBefore: number;
  bytes: number; // = glb.byteLength
  bytesBefore: number; // 原文件大小
  simplified: boolean; // 做过减面
  warnings: string[]; // 给人看的英文提示（例：Textures were resized to 2048 px.）
}

// 失败的种类：界面按它给提示，message 是给人看的英文句子
export type ImportErrorCode =
  | 'too_big' // 超过 maxBytes
  | 'bad_type' // 不是 .glb / .gltf
  | 'parse' // 读不了（文件坏了、不是 glTF）
  | 'external' // .gltf 引用了外部文件（.bin、贴图），没有内嵌
  | 'draco' // Draco 压缩（没有解码器）
  | 'ktx2' // KTX2 / Basis 贴图（页面的加载器没配）
  | 'empty' // 没有三角面
  | 'unknown';

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

// Worker 和主线程之间的消息
// 交给 Worker 的是 Blob（结构化克隆只传引用，不拷贝数据）：几十 MB 的文件在 Worker 里读，主线程不用分配、拷贝那块内存
export type ImportRequest = { id: number; file: Blob; name: string; options: ImportOptions };
export type ImportReply =
  | { id: number; type: 'progress'; progress: ImportProgress }
  | { id: number; type: 'done'; result: ImportResult }
  | { id: number; type: 'error'; code: ImportErrorCode; message: string };

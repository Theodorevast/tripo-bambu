// 导入前的快速检查和给人看的提示文字：主线程（界面、importClient.ts）、Worker、单元测试共用。
// 这个文件只能引用 ./importTypes：界面直接引用它，不能把 gltf-transform、meshoptimizer 带进主线程的包（importModel.ts 才引用它们）
import { IMPORT_LIMITS, ImportError, type ImportOptions } from './importTypes';

// <input type="file" accept>：.glb，或者把贴图、二进制都内嵌了的 .gltf
export const IMPORT_ACCEPT = '.glb,.gltf,model/gltf-binary,model/gltf+json';

// 失败时的英文提示（code 见 importTypes.ts 的 ImportErrorCode）
export const IMPORT_MESSAGES = {
  badType: 'Please choose a .glb file, or a .gltf file with its textures embedded.',
  empty: 'That file is empty. Try exporting the model again as .glb.',
  read: "We couldn't open that file. Try choosing it again.",
  parse: "We couldn't read this file. It may be damaged or not a glTF model. Try exporting it again as .glb.",
  oldVersion: 'This file uses glTF 1.0, which is too old to read. Export it again as glTF 2.0 (.glb).',
  external: 'This .gltf file points to separate files (textures or a .bin). Export it as a single .glb instead, or embed everything in the .gltf.',
  draco: "This model uses Draco compression, which we can't read here yet. Export it again without Draco (Meshopt compression is fine).",
  ktx2: "This model uses KTX2 (Basis) textures, which we can't show yet. Export it again with PNG, JPEG or WebP textures.",
  noTriangles: 'This model has nothing to show: no triangles were found. Make sure its meshes are included when you export.',
  unknown: 'Something went wrong while preparing this model. Try exporting it again as .glb, or try another file.',
  slow: 'Preparing this model took too long. Try a smaller file.',
} as const;

// 文件名后缀：.glb / .gltf（不分大小写）
export function importFormat(name: string): 'glb' | 'gltf' | null {
  const m = /\.(glb|gltf)$/i.exec(name.trim());
  return m ? (m[1].toLowerCase() as 'glb' | 'gltf') : null;
}

const mb = (bytes: number): string => {
  const v = bytes / (1024 * 1024);
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
};

// 读文件之前先查：后缀（.glb / .gltf）和大小（默认最大 50 MB）。界面选好文件、拖进来时就调，不用等 Worker
export function checkImportFile(file: { name: string; size: number }, options: ImportOptions = {}): { ok: true } | { ok: false; error: ImportError } {
  if (!importFormat(file.name)) return { ok: false, error: new ImportError('bad_type', IMPORT_MESSAGES.badType) };
  const max = options.maxBytes ?? IMPORT_LIMITS.maxBytes;
  if (file.size > max) return { ok: false, error: new ImportError('too_big', `That file is ${mb(file.size)} MB. Files can be up to ${mb(max)} MB.`) };
  if (file.size === 0) return { ok: false, error: new ImportError('parse', IMPORT_MESSAGES.empty) };
  return { ok: true };
}

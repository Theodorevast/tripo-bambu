// 生成用的图片在上传之前先整理好（中转只收 PNG 和 JPEG，单张 ≤ 10 MB，按文件头判断格式）：
// - 本来就是 PNG / JPEG、不超过 10 MB、边长不超过 4096：原样上传
// - 别的格式（WebP、GIF、AVIF……浏览器解得开的）、太大的图：用 canvas 重画成 PNG（有透明部分时）或 JPEG，长边缩到 2048
// - 浏览器解不开（比如 HEIC）：抛出给人看的错误
// 文件名保留（只换扩展名）：模拟模式下文件名里的 #fail 要带到中转

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 中转收的上限
export const PICK_MAX_BYTES = 40 * 1024 * 1024; // 选图时的上限（再大就先别读了，缩小也太慢）
const KEEP_MAX_SIDE = 4096; // PNG / JPEG 边长不超过它就原样上传
const RESIZE_SIDE = 2048; // 要重画时长边缩到它

export class ImagePrepError extends Error {}

// 文件头：PNG 是 89 50 4E 47，JPEG 是 FF D8 FF
export function sniffImage(head: Uint8Array): 'png' | 'jpeg' | null {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

// 要不要重画：不是 PNG / JPEG、太大、边太长
export function needsRedraw(kind: 'png' | 'jpeg' | null, bytes: number, width: number, height: number): boolean {
  return kind === null || bytes > UPLOAD_MAX_BYTES || Math.max(width, height) > KEEP_MAX_SIDE;
}

function rename(name: string, ext: 'png' | 'jpg'): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'picture';
  return `${base}.${ext}`;
}

function encode(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new ImagePrepError('Could not convert this picture.'))), type, quality));
}

export async function prepareUploadImage(file: File): Promise<File> {
  if (file.size > PICK_MAX_BYTES) throw new ImagePrepError('That picture is too big. Use one under 10 MB.');
  const kind = sniffImage(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImagePrepError("This picture format can't be read here. Use a PNG or JPG.");
  }
  try {
    if (!needsRedraw(kind, file.size, bitmap.width, bitmap.height)) return file;
    const scale = Math.min(1, RESIZE_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new ImagePrepError('Could not convert this picture.');
    ctx.drawImage(bitmap, 0, 0, w, h);
    // 有透明部分（去了背景的图）就存 PNG，不然 JPEG（小得多）
    const alpha = ctx.getImageData(0, 0, w, h).data;
    let transparent = false;
    for (let i = 3; i < alpha.length; i += 4) {
      if (alpha[i] < 250) {
        transparent = true;
        break;
      }
    }
    let blob = transparent ? await encode(canvas, 'image/png') : await encode(canvas, 'image/jpeg', 0.92);
    if (blob.size > UPLOAD_MAX_BYTES) blob = await encode(canvas, 'image/jpeg', 0.8); // PNG 还是太大：退成 JPEG
    if (blob.size > UPLOAD_MAX_BYTES) throw new ImagePrepError('That picture is too big even after shrinking it. Try a smaller one.');
    const png = blob.type === 'image/png';
    return new File([blob], rename(file.name, png ? 'png' : 'jpg'), { type: png ? 'image/png' : 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}

import { describe, expect, it } from 'vitest';
import { needsRedraw, sniffImage, UPLOAD_MAX_BYTES } from '../src/genai/images';

// 生成用的图片上传前的整理（中转只收 PNG、JPEG，≤ 10 MB，按文件头判断）：哪些原样上传、哪些要重画
describe('sniffImage：按文件头认 PNG、JPEG', () => {
  it('PNG 是 89 50 4E 47，JPEG 是 FF D8 FF；别的（WebP 的 RIFF、GIF、空的）认不出', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF....WEBP'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });
});

describe('needsRedraw：要不要用 canvas 重画（转格式、缩小）', () => {
  it('PNG / JPEG、不超过 10 MB、边长不超过 4096：原样上传', () => {
    expect(needsRedraw('png', 2_000_000, 1024, 1024)).toBe(false);
    expect(needsRedraw('jpeg', UPLOAD_MAX_BYTES, 4096, 3000)).toBe(false);
  });
  it('别的格式、超过 10 MB、边太长：重画', () => {
    expect(needsRedraw(null, 100_000, 512, 512)).toBe(true);
    expect(needsRedraw('jpeg', UPLOAD_MAX_BYTES + 1, 1024, 1024)).toBe(true);
    expect(needsRedraw('png', 1_000_000, 5000, 800)).toBe(true);
  });
});

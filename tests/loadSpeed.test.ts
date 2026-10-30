import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Downloads, HOVER, IDLE, lodUrl, modelUrl, NOW } from '../src/assets/models';
import { byVisibility } from '../src/scenes/planetView';
import { planetViewDir } from '../src/scenes/shots';
import { headersFor, parseHeadersFile } from '../scripts/lib/headersFile.mjs';
import { hashPublicAssets } from '../scripts/lib/assetVersions.mjs';

type Rules = ReturnType<typeof parseHeadersFile>;
const cacheControl = (rules: Rules, path: string): string | undefined => headersFor(rules, path).set.get('cache-control')?.[1];

// 加载速度（public/_headers 的长缓存、地址里的内容指纹、星球视图的 LOD、主画面的下载队列）
describe('public/_headers（Cloudflare Workers Static Assets）', () => {
  const rules: Rules = parseHeadersFile(readFileSync('public/_headers', 'utf8'));
  const YEAR = 'public, max-age=31536000, immutable';

  it('带指纹的打包文件、模型（含 LOD）、缩略图、品牌素材缓存一年不再询问；一条地址只命中一条规则（不会拼出两个 Cache-Control）', () => {
    for (const p of ['/assets/index-DwnGwJu1.js', '/assets/index-HfoTAYOF.css', '/models/castle.glb', '/models/lod/castle.glb', '/thumbs/castle.webp', '/brand/triboo.glb', '/brand/tripo-logo.png']) {
      expect(cacheControl(rules, p), p).toBe(YEAR);
    }
  });

  it('index.html 和其余文件不写：用 Cloudflare 的默认值（每次询问），新版本一部署就生效', () => {
    for (const p of ['/', '/index.html', '/favicon.svg', '/api/tripo/health']) expect(cacheControl(rules, p), p).toBeUndefined();
  });

  it('规则解析：* 匹配任意一段、:名字 匹配一段路径，同名头按 Cloudflare 的规矩用逗号连起来，! 去掉', () => {
    const r: Rules = parseHeadersFile('# 注释\n/a/*\n  X-A: 1\n/a/:name/c\n  X-A: 2\n  ! X-B\n');
    expect(headersFor(r, '/a/b/c').set.get('x-a')?.[1]).toBe('1, 2');
    expect([...headersFor(r, '/a/b/c').unset]).toEqual(['x-b']);
    expect(headersFor(r, '/b').set.size).toBe(0);
  });
});

describe('内容指纹和 LOD 清单（vite.config.ts 的 assetVersions）', () => {
  const versions: Record<string, string> = hashPublicAssets('public');

  it('模型、LOD、缩略图、品牌素材都有指纹；指纹跟着内容变', () => {
    expect(versions['models/castle.glb']).toMatch(/^[0-9a-f]{10}$/);
    expect(versions['models/lod/castle.glb']).toMatch(/^[0-9a-f]{10}$/);
    expect(versions['thumbs/castle.webp']).toMatch(/^[0-9a-f]{10}$/);
    expect(versions['brand/triboo.glb']).toMatch(/^[0-9a-f]{10}$/);
    expect(versions['models/lod/castle.glb']).not.toBe(versions['models/castle.glb']);
  });

  it('单元测试里没有指纹表：地址不加指纹，也当作没有 LOD（用原文件）', () => {
    expect(modelUrl('castle.glb')).toBe('/models/castle.glb');
    expect(lodUrl('castle.glb')).toBe('/models/castle.glb');
    expect(lodUrl('blob:abc')).toBe('blob:abc');
  });
});

// GLB 里每张贴图的字节（按 images[].bufferView 从 BIN 块里切出来）：LOD 只减面，贴图必须和原文件一模一样（不会糊）
function glbImages(file: string): string[] {
  const buf = readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  return (json.images ?? []).map((img: { bufferView: number }) => {
    const view = json.bufferViews[img.bufferView];
    return createHash('md5').update(buf.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength)).digest('hex');
  }).sort();
}

describe('星球视图的 LOD（public/models/lod/，scripts/lib/lod.mjs）', () => {
  const lods = existsSync('public/models/lod') ? readdirSync('public/models/lod').filter((f) => f.endsWith('.glb')) : [];

  it('每个 LOD 都有同名的原文件，而且明显更小', () => {
    expect(lods.length).toBeGreaterThan(10);
    for (const f of lods) {
      expect(existsSync(`public/models/${f}`), f).toBe(true);
      expect(readFileSync(`public/models/lod/${f}`).length, f).toBeLessThan(readFileSync(`public/models/${f}`).length * 0.75);
    }
  });

  it('贴图和原文件逐字节相同：只减面，不缩贴图', () => {
    for (const f of lods) expect(glbImages(`public/models/lod/${f}`), f).toEqual(glbImages(`public/models/${f}`));
  });
});

describe('主画面的下载队列（Downloads）', () => {
  // 假的下载：记下开始的顺序，手动结束
  function fake() {
    const started: string[] = [];
    const pending = new Map<string, () => void>();
    const downloads = new Downloads((url) => new Promise<ArrayBuffer>((resolve) => {
      started.push(url);
      pending.set(url, () => resolve(new ArrayBuffer(1)));
    }));
    const finish = async (url: string) => {
      pending.get(url)!();
      pending.delete(url);
      await new Promise((r) => setTimeout(r, 0));
    };
    return { downloads, started, finish };
  }

  it('现在要用的一次一件、先来先下；预取等它们都下完', async () => {
    const { downloads, started, finish } = fake();
    downloads.get('a', NOW);
    downloads.get('b', NOW);
    downloads.get('idle', IDLE);
    expect(started).toEqual(['a']);
    await finish('a');
    expect(started).toEqual(['a', 'b']);
    await finish('b');
    expect(started).toEqual(['a', 'b', 'idle']);
  });

  it('预取正在下的时候来了急件：急件不等，马上开始；预取排在急件后面', async () => {
    const { downloads, started, finish } = fake();
    downloads.get('p1', IDLE);
    downloads.get('p2', HOVER);
    downloads.get('a', NOW);
    expect(started).toEqual(['p1', 'a']);
    await finish('p1');
    expect(started).toEqual(['p1', 'a']); // 急件还在下：p2 等着
    await finish('a');
    expect(started).toEqual(['p1', 'a', 'p2']);
  });

  it('同一个地址只下一次；排队中的预取被要成急件时提前（排在已经在等的急件后面）', async () => {
    const { downloads, started, finish } = fake();
    const first = downloads.get('a', NOW);
    downloads.get('p', IDLE);
    downloads.get('b', NOW);
    expect(downloads.get('a', IDLE)).toBe(first);
    downloads.bump('p', NOW);
    await finish('a');
    expect(started).toEqual(['a', 'b']);
    await finish('b');
    expect(started).toEqual(['a', 'b', 'p']);
    downloads.release('a');
    downloads.bump('a', NOW); // 交出去以后不在队列里：不会重新下
    expect(started).toEqual(['a', 'b', 'p']);
  });
});

describe('byVisibility', () => {
  it('最正对星球视图镜头的作品排在前面，背面的最后', () => {
    const v = planetViewDir();
    const front = { workId: 'front', dir: [v.x, v.y, v.z] as [number, number, number] };
    const back = { workId: 'back', dir: [-v.x, -v.y, -v.z] as [number, number, number] };
    const side = { workId: 'side', dir: [v.z, 0, -v.x] as [number, number, number] };
    expect(byVisibility([back, side, front]).map((p) => p.workId)).toEqual(['front', 'side', 'back']);
  });
});

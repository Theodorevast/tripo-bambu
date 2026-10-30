import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportProgress, ImportReply, ImportRequest, ImportResult } from '../src/works/importTypes';

// importClient：node 里没有 Worker，换成一个假的。每个用例重新加载模块（模块里记着 Worker、排队的状态）

type Listener = (e: unknown) => void;
type Behavior = (w: FakeWorker, req: ImportRequest) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static onPost: Behavior = () => {};
  static onCreate: (w: FakeWorker) => void = () => {};
  readonly url: string;
  readonly posted: ImportRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: URL | string) {
    this.url = String(url);
    FakeWorker.instances.push(this);
    FakeWorker.onCreate(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(req: ImportRequest): void {
    this.posted.push(req);
    FakeWorker.onPost(this, req);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: ImportReply): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn({ data });
  }

  fail(message: string): void {
    for (const fn of [...(this.listeners.get('error') ?? [])]) fn({ message, preventDefault: () => {} });
  }

  get listening(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

const result = (id: number): ImportResult => ({ glb: new Uint8Array([id]), triangles: 10 * id, trianglesBefore: 10 * id, bytes: 1, bytesBefore: 4, simplified: false, warnings: [] });
const blob = (n = 4): Blob => new Blob([new Uint8Array(n)]);
const later = (fn: () => void): void => void setTimeout(fn, 0);

async function load() {
  vi.resetModules();
  return import('../src/works/importClient');
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.onCreate = () => {};
  // 默认：先报一次进度，再给结果
  FakeWorker.onPost = (w, req) => later(() => {
    w.reply({ id: req.id, type: 'progress', progress: { stage: 'cleaning', ratio: 0.3 } });
    later(() => w.reply({ id: req.id, type: 'done', result: result(req.id) }));
  });
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(async () => {
  (await import('../src/works/importClient')).disposeImportWorker();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('importModelFile', () => {
  it('交给 Worker：交的是 Blob 本身（主线程不读文件），进度、结果按请求 id 对上；Worker 只建一个', async () => {
    const { importModelFile } = await load();
    const steps: ImportProgress[] = [];
    const r = await importModelFile(blob(8), 'a.glb', { options: { maxTriangles: 5000 }, onProgress: (p) => steps.push(p) });
    expect(r.triangles).toBe(10);
    expect(steps).toEqual([{ stage: 'cleaning', ratio: 0.3 }]);
    const [w] = FakeWorker.instances;
    expect(w.url).toMatch(/importWorker\.ts$/);
    expect(w.posted[0]).toMatchObject({ id: 1, name: 'a.glb', options: { maxTriangles: 5000 } });
    expect(w.posted[0].file).toBeInstanceOf(Blob);
    expect(w.posted[0].file.size).toBe(8);
    await importModelFile(blob(), 'b.glb');
    expect(FakeWorker.instances).toHaveLength(1);
    expect(w.listening).toBe(0); // 每次处理完都把监听拿掉
  });

  it('同时来好几个：排队，一次只交一个给 Worker', async () => {
    const { importModelFile } = await load();
    const order: string[] = [];
    FakeWorker.onPost = (w, req) => {
      order.push(`start ${req.name}`);
      later(() => {
        order.push(`done ${req.name}`);
        w.reply({ id: req.id, type: 'done', result: result(req.id) });
      });
    };
    const rs = await Promise.all(['a.glb', 'b.glb', 'c.glb'].map((n) => importModelFile(blob(), n)));
    expect(order).toEqual(['start a.glb', 'done a.glb', 'start b.glb', 'done b.glb', 'start c.glb', 'done c.glb']);
    expect(rs.map((r) => r.triangles)).toEqual([10, 20, 30]);
  });

  it('Worker 回 error：reject 成 ImportError（code、message 原样），后面的请求照常', async () => {
    const { importModelFile } = await load();
    const { ImportError } = await import('../src/works/importTypes');
    FakeWorker.onPost = (w, req) => later(() => w.reply(req.name === 'bad.glb'
      ? { id: req.id, type: 'error', code: 'draco', message: 'No Draco here.' }
      : { id: req.id, type: 'done', result: result(req.id) }));
    const err = await importModelFile(blob(), 'bad.glb').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err).toMatchObject({ code: 'draco', message: 'No Draco here.' });
    expect((await importModelFile(blob(), 'ok.glb')).triangles).toBe(20);
  });

  it('后缀不对、太大：马上 reject，不读文件、不建 Worker', async () => {
    const { importModelFile } = await load();
    await expect(importModelFile(blob(), 'model.obj')).rejects.toMatchObject({ code: 'bad_type' });
    await expect(importModelFile(blob(), 'big.glb', { options: { maxBytes: 2 } })).rejects.toMatchObject({ code: 'too_big' });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('Worker 脚本加载失败（一条消息都没回就出错）：退回主线程照样导入，以后也不再建 Worker', async () => {
    const { importModelFile } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    FakeWorker.onPost = (w) => later(() => w.fail('Failed to fetch a worker script'));
    const fixture = readFileSync(new URL('./fixtures/import-small.glb', import.meta.url));
    const r = await importModelFile(new Blob([fixture]), 'import-small.glb');
    expect(r.triangles).toBe(12_096);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(warn).toHaveBeenCalled();
    const again = await importModelFile(new Blob([fixture]), 'import-small.glb', { options: { maxTriangles: 3000 } });
    expect(again.triangles).toBeLessThanOrEqual(3000);
    expect(FakeWorker.instances).toHaveLength(1);
    warn.mockRestore();
  }, 30_000);

  it('Worker 处理到一半崩了：这次失败（unknown），下次新建一个 Worker', async () => {
    const { importModelFile } = await load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    FakeWorker.onPost = (w, req) => later(() => {
      w.reply({ id: req.id, type: 'progress', progress: { stage: 'reading', ratio: 0.1 } });
      later(() => w.fail('out of memory'));
    });
    await expect(importModelFile(blob(), 'a.glb')).rejects.toMatchObject({ code: 'unknown' });
    FakeWorker.onPost = (w, req) => later(() => w.reply({ id: req.id, type: 'done', result: result(req.id) }));
    expect((await importModelFile(blob(), 'b.glb')).triangles).toBe(20);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    error.mockRestore();
  });

  it('Worker 太久没有消息：当它卡死了，关掉、提示太慢；空闲一分钟自动关掉 Worker', async () => {
    vi.useFakeTimers();
    const { importModelFile } = await load();
    FakeWorker.onPost = () => {}; // 一直不回
    const stuck = importModelFile(blob(), 'stuck.glb').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await stuck).toMatchObject({ code: 'unknown', message: expect.stringMatching(/too long/) });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    FakeWorker.onPost = (w, req) => later(() => w.reply({ id: req.id, type: 'done', result: result(req.id) }));
    const ok = importModelFile(blob(), 'ok.glb');
    await vi.advanceTimersByTimeAsync(10);
    expect((await ok).triangles).toBe(20);
    const second = FakeWorker.instances[1];
    expect(second.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(second.terminated).toBe(true);
  });
});

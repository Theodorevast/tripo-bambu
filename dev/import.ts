import type { Mesh, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { importModelFile } from '../src/works/importClient';
import type { ImportProgress } from '../src/works/importTypes';

// 导入管线在真浏览器里跑一遍（scripts/check-import.mjs 打开它）：拿一个模型交给 importModelFile（真的 Worker），
// 同时每帧记主线程的帧间隔，看导入期间画面卡不卡；导完用页面同款的 GLTFLoader + MeshoptDecoder 读回输出，数三角面、看贴图尺寸。
// 地址参数：?url=<模型地址>（或 ?file=<public/models 下的文件名>）&name=<当作什么文件名>&maxTriangles=&maxTextureSize=；
// &brokenworker：把 Worker 换成一加载就出错的假货，走主线程的后备
// 结果写在 window.__import

interface ImportReport {
  done: boolean;
  ok: boolean;
  error?: { code?: string; message: string };
  name: string;
  ms: number; // importModelFile 从调用到拿到结果
  frames: number;
  maxGap: number; // 导入期间最长的帧间隔（毫秒）
  p95Gap: number;
  stages: string[];
  triangles?: number;
  trianglesBefore?: number;
  bytes?: number;
  bytesBefore?: number;
  simplified?: boolean;
  warnings?: string[];
  threeTriangles?: number; // GLTFLoader 读回来数的三角面
  maxTexture?: number; // 读回来的贴图最长边
  parseMs?: number;
  slow: string[]; // 超过 25 ms 的帧（离开始多少毫秒、多长）和这期间的长任务、进度事件：查是哪一步卡了主线程
  longTasks: number; // 导入期间主线程上超过 50 ms 的任务（Long Tasks API）；-1 = 浏览器不支持
  longestTask: number;
}

declare global {
  interface Window {
    __import?: ImportReport;
  }
}

const params = new URLSearchParams(location.search);
const file = params.get('file');
const url = params.get('url') ?? (file ? `${import.meta.env.BASE_URL}models/${file}` : '');
const name = params.get('name') ?? decodeURIComponent(url.split('/').pop() ?? 'model.glb');
const num = (key: string): number | undefined => (params.has(key) ? Number(params.get(key)) : undefined);
const options = { maxTriangles: num('maxTriangles'), maxTextureSize: num('maxTextureSize') };
const out = document.querySelector<HTMLPreElement>('#out')!;
const dot = document.querySelector<HTMLElement>('#dot')!;

if (params.has('brokenworker')) {
  // 模拟 Worker 脚本加载失败：交东西给它时报 error，一条消息都不回
  class BrokenWorker extends EventTarget {
    postMessage(): void {
      setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'simulated: worker script failed to load' })), 0);
    }

    terminate(): void {}
  }
  Object.defineProperty(window, 'Worker', { configurable: true, value: BrokenWorker });
}

// 每帧记帧间隔；超过 25 ms 的记下时刻，和长任务（PerformanceObserver longtask）、进度事件一起放进 slow
const gaps: number[] = [];
const events: Array<[number, string]> = [];
let measuring = false;
let last = 0;
let t0 = 0;
let tEnd = 0;
const tick = (t: number): void => {
  if (measuring && last) {
    gaps.push(t - last);
    if (t - last > 25) events.push([last - t0, `frame gap ${(t - last).toFixed(1)} ms`]);
  }
  last = t;
  dot.style.transform = `translateY(${Math.round(Math.sin(t / 300) * 40)}px)`;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
// 长任务：观察者的回调晚一点才送到（可能已经量完了），所以全部记下、量完时用 takeRecords 收齐，再按开始时刻筛
const longTaskEntries: PerformanceEntry[] = [];
const longTaskApi = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
const longTaskObserver = longTaskApi ? new PerformanceObserver((list) => void longTaskEntries.push(...list.getEntries())) : null;
longTaskObserver?.observe({ type: 'longtask', buffered: false });

function threeStats(root: Object3D): { triangles: number; maxTexture: number } {
  let triangles = 0;
  let maxTexture = 0;
  root.traverse((o) => {
    const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number };
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    triangles += n * (mesh.isInstancedMesh ? mesh.count ?? 1 : 1);
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) {
        const tex = v as Texture | null;
        const img = tex?.isTexture ? (tex.image as { width?: number; height?: number } | null) : null;
        if (img) maxTexture = Math.max(maxTexture, img.width ?? 0, img.height ?? 0);
      }
    }
  });
  return { triangles, maxTexture };
}

async function run(): Promise<ImportReport> {
  const report: ImportReport = { done: false, ok: false, name, ms: 0, frames: 0, maxGap: 0, p95Gap: 0, stages: [], slow: [], longTasks: 0, longestTask: 0 };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  await frame();
  await frame();
  measuring = true;
  t0 = performance.now();
  try {
    const result = await importModelFile(blob, name, {
      options,
      onProgress: (p: ImportProgress) => {
        events.push([performance.now() - t0, `progress ${p.stage} ${p.ratio.toFixed(2)}`]);
        if (report.stages.at(-1) !== p.stage) report.stages.push(p.stage);
        out.textContent = `${name}: ${p.stage} ${(p.ratio * 100).toFixed(0)}%`;
      },
    });
    report.ms = Math.round(performance.now() - t0);
    await frame(); // 拿到结果以后那一帧也算
    measuring = false;
    tEnd = performance.now();
    Object.assign(report, { ok: true, triangles: result.triangles, trianglesBefore: result.trianglesBefore, bytes: result.bytes, bytesBefore: result.bytesBefore, simplified: result.simplified, warnings: result.warnings });
    // 页面同款的加载器读回输出
    const t1 = performance.now();
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(result.glb.buffer.slice(result.glb.byteOffset, result.glb.byteOffset + result.glb.byteLength) as ArrayBuffer, '');
    report.parseMs = Math.round(performance.now() - t1);
    const stats = threeStats(gltf.scene);
    report.threeTriangles = stats.triangles;
    report.maxTexture = stats.maxTexture;
  } catch (err) {
    report.ms = Math.round(performance.now() - t0);
    measuring = false;
    tEnd = performance.now();
    const e = err as { code?: string; message?: string };
    report.error = { code: e.code, message: e.message ?? String(err) };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  report.frames = gaps.length;
  report.maxGap = Math.round((sorted.at(-1) ?? 0) * 10) / 10;
  report.p95Gap = Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10;
  await new Promise((r) => setTimeout(r, 50));
  longTaskEntries.push(...(longTaskObserver?.takeRecords() ?? []));
  const longTasks = longTaskEntries.filter((e) => e.startTime + e.duration > t0 && e.startTime < tEnd);
  for (const e of longTasks) events.push([e.startTime - t0, `long task ${e.duration.toFixed(0)} ms`]);
  // 只在有慢帧、长任务时留时间线（进度事件夹在中间，看是哪一步）
  if (events.some(([, what]) => !what.startsWith('progress'))) report.slow = events.sort((a, b) => a[0] - b[0]).map(([at, what]) => `${at.toFixed(0)} ms: ${what}`);
  report.longTasks = longTaskApi ? longTasks.length : -1;
  report.longestTask = Math.round(Math.max(0, ...longTasks.map((e) => e.duration)));
  report.done = true;
  return report;
}

run().then(
  (r) => {
    window.__import = r;
    out.textContent = JSON.stringify(r, null, 2);
  },
  (err: unknown) => {
    window.__import = { done: true, ok: false, error: { message: String(err) }, name, ms: 0, frames: 0, maxGap: 0, p95Gap: 0, stages: [], slow: [], longTasks: 0, longestTask: 0 };
    out.textContent = String(err);
  },
);

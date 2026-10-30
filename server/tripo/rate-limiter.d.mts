// rate-limiter.mjs 的类型：只写用到的部分，不依赖 @cloudflare/workers-types
import type { RateLimitStore, WindowResult } from './handler.mjs';

// Durable Object 存储里用到的部分：SQLite 后端的同步 KV 接口和闹钟
export interface RateLimiterStorage {
  kv: {
    get(key: string): unknown;
    put(key: string, value: unknown): void;
    delete(key: string): boolean;
    list(): Iterable<[string, unknown]>;
  };
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
}
export interface RateLimiterState { storage: RateLimiterStorage }

export declare class RateLimiter {
  constructor(ctx: RateLimiterState, env: unknown);
  hit(key: string, limit: number, windowMs: number, now: number): Promise<WindowResult>;
  release(key: string, stamp: number): Promise<void>;
  alarm(): Promise<void>;
}

// 绑定（DurableObjectNamespace）里用到的部分
export interface RateLimiterStub {
  hit(key: string, limit: number, windowMs: number, now: number): Promise<WindowResult>;
  release(key: string, stamp: number): Promise<void>;
}
export interface RateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RateLimiterStub;
}

export function createDurableStore(
  namespace: RateLimiterNamespace,
  options?: { waitUntil?: (promise: Promise<unknown>) => void; log?: { warn?: (msg: string) => void } },
): RateLimitStore;

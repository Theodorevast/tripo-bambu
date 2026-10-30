// worker.mjs 的类型
import type { RateLimiterNamespace } from './rate-limiter.mjs';

export interface WorkerEnv {
  [name: string]: unknown;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  RATE_LIMITER?: RateLimiterNamespace;
}
export interface WorkerContext { waitUntil(promise: Promise<unknown>): void }

declare const worker: { fetch(request: Request, env: WorkerEnv, ctx?: WorkerContext): Promise<Response> };
export default worker;
export { RateLimiter } from './rate-limiter.mjs';

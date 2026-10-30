import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// cloudflare:workers 是 Worker 运行时自带的模块，Node 里没有：单元测试换成只有 DurableObject 基类的替身（server/tripo/rate-limiter.mjs 用）
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/cloudflareWorkersStub.mjs', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});

// 单元测试里替代 Worker 运行时自带的 cloudflare:workers 模块（vitest.config.ts 的 alias 指过来）：只有 rate-limiter.mjs 用到的 DurableObject 基类
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

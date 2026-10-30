// Durable Objects 版的限流计数（Cloudflare Worker 用，worker.mjs 按请求创建）：所有实例、所有机房看到的是同一份计数，挡得住分散的盗刷。
// - 每个限流 key 一个对象（RATE_LIMITER.idFromName(key)）：task:<ip>、upload:<ip>、req:<ip> 各一个；
//   task:all（全站每日上限）全球只有一个对象，所以是全局一致的。第二版（wrangler.toml 的 [env.v2]）绑到第一版的这个类，两版共用同一份计数。
// - 一次限流检查 = 一次 RPC 往返；退名额（少见）在响应发出后用 ctx.waitUntil 做完。
// - 滑动窗口的规则和内存版共用 handler.mjs 的 windowHit / windowRelease / pruneStamps，这里只管存取和清理。
// - 存储用 SQLite 后端（wrangler.toml 的 new_sqlite_classes），Workers 免费版也能用；用的是同步的 ctx.storage.kv。
import { DurableObject } from 'cloudflare:workers';
import { pruneStamps, RATE_WINDOW_MAX_MS, windowHit, windowRelease } from './handler.mjs';

// 清理闹钟比最长的窗口再晚一点响：那时对象里的时间戳多半都过期了，整个删掉，不占存储
const SWEEP_SLACK_MS = 60_000;

export class RateLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.stampsByKey = new Map(); // 对象醒着时时间戳留在内存里，只在第一次用到时读存储
    this.alarmSet = null; // 有没有排过清理闹钟；null = 还不知道（对象刚醒）
  }

  load(key) {
    let stamps = this.stampsByKey.get(key);
    if (!stamps) {
      const saved = this.ctx.storage.kv.get(key);
      stamps = Array.isArray(saved) ? saved : [];
      this.stampsByKey.set(key, stamps);
    }
    return stamps;
  }

  save(key, stamps) {
    if (stamps.length) this.ctx.storage.kv.put(key, stamps);
    else this.ctx.storage.kv.delete(key);
  }

  // RPC：占一个名额，返回 { ok, retryAfterMs }，和内存版一样。读、算、写之间没有 await，同一个对象里的请求不会互相穿插
  async hit(key, limit, windowMs, now) {
    const stamps = this.load(key);
    const r = windowHit(stamps, limit, windowMs, now);
    // 被拒时不写：窗口里过期的时间戳下次读出来再清，不值得为它多写一行
    if (r.ok) {
      this.save(key, stamps);
      await this.armSweep();
    }
    return r;
  }

  // RPC：退回名额（Tripo 明确拒绝、校验没过时），stamp 是占名额时的 now
  async release(key, stamp) {
    const stamps = this.load(key);
    if (windowRelease(stamps, stamp)) this.save(key, stamps);
  }

  async armSweep() {
    if (this.alarmSet === null) this.alarmSet = (await this.ctx.storage.getAlarm()) !== null;
    if (this.alarmSet) return;
    await this.ctx.storage.setAlarm(Date.now() + RATE_WINDOW_MAX_MS + SWEEP_SLACK_MS);
    this.alarmSet = true;
  }

  // 清理闹钟：和内存版的定期清理一样，比最长的窗口还旧的时间戳都扔掉；什么都不剩就整个删掉，否则等最新的那个过期了再来
  async alarm() {
    this.alarmSet = false;
    const now = Date.now();
    let newest = 0;
    for (const [key, saved] of [...this.ctx.storage.kv.list()]) {
      const stamps = this.stampsByKey.get(key) ?? (Array.isArray(saved) ? saved : []);
      const before = stamps.length;
      pruneStamps(stamps, now - RATE_WINDOW_MAX_MS);
      if (stamps.length !== before) this.save(key, stamps);
      if (stamps.length) {
        this.stampsByKey.set(key, stamps);
        newest = Math.max(newest, stamps[stamps.length - 1]);
      } else this.stampsByKey.delete(key);
    }
    if (!newest) {
      this.stampsByKey.clear();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(newest + RATE_WINDOW_MAX_MS + SWEEP_SLACK_MS);
    this.alarmSet = true;
  }
}

// Worker 这边的 store（传给 createHandler({ store })）：按 key 找到对象，一次限流检查一次 RPC 往返。
// waitUntil：退名额发生在出错的路上，响应发出去时不一定做完，交给 ctx.waitUntil 保证做完
export function createDurableStore(namespace, { waitUntil, log = console } = {}) {
  const stub = (key) => namespace.get(namespace.idFromName(key));
  return {
    async hit(key, limit, windowMs, now) {
      const r = await withRetry(() => stub(key).hit(key, limit, windowMs, now));
      if (!r.ok) return { ok: false, retryAfterMs: r.retryAfterMs ?? null, release() {} };
      let released = false;
      return {
        ok: true,
        retryAfterMs: 0,
        release() {
          if (released) return;
          released = true;
          const done = withRetry(() => stub(key).release(key, now)).catch((err) => {
            // 日志里只写是哪类计数，不写 IP
            log.warn?.(`[tripo] 退回限流名额失败（${key.split(':')[0]}）：${err?.message ?? err}`);
          });
          waitUntil?.(done);
        },
      };
    },
  };
}

// Cloudflare 的建议：异常带 retryable、又不是 overloaded（对象忙不过来）时可以重试，稍等一下，并且换一个新的 stub（比如部署新版本时对象被重置）。
// 只重试一次。占名额时重试可能多记一次，只会更严，不会放过；还是失败就抛出去，中转回 500，不调 Tripo
async function withRetry(call) {
  try {
    return await call();
  } catch (err) {
    if (!err?.retryable || err?.overloaded) throw err;
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));
    return call();
  }
}

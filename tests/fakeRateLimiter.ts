// Durable Objects 的替身（server/tripo/rate-limiter.mjs 的单元测试用）：假的 RATE_LIMITER 绑定，按名字建 RateLimiter 对象。
// RPC 的参数和返回值都过一遍 structuredClone（和真的一样只能传可序列化的值），每次调用都记下来；
// restart() 模拟对象被回收、wrangler dev 重启：对象重新建，存储还在。failNext 里放的错误会让接下来的调用依次失败
import { RateLimiter, type RateLimiterNamespace, type RateLimiterStub } from '../server/tripo/rate-limiter.mjs';

export function fakeDurableState() {
  const data = new Map<string, unknown>();
  const stats = { reads: 0, writes: 0 };
  let alarm: number | null = null;
  const storage = {
    kv: {
      get(key: string): unknown {
        stats.reads++;
        return data.has(key) ? structuredClone(data.get(key)) : undefined;
      },
      put(key: string, value: unknown) {
        stats.writes++;
        data.set(key, structuredClone(value));
      },
      delete(key: string) {
        stats.writes++;
        return data.delete(key);
      },
      *list(): Generator<[string, unknown]> {
        for (const [k, v] of [...data]) yield [k, structuredClone(v)];
      },
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time: number) {
      alarm = time;
    },
    async deleteAll() {
      data.clear();
      alarm = null;
    },
  };
  return { storage, data, stats, alarm: () => alarm };
}
export type FakeDurableState = ReturnType<typeof fakeDurableState>;

export type FakeRpcError = Error & { retryable?: boolean; overloaded?: boolean };

export interface FakeNamespace extends RateLimiterNamespace {
  calls: string[]; // 形如 'hit task:all'、'release task:198.51.100.1'
  states: Map<string, FakeDurableState>;
  failNext: FakeRpcError[];
  restart(): void;
  stamps(name: string): number[];
}

export function fakeLimiterNamespace(): FakeNamespace {
  const states = new Map<string, FakeDurableState>();
  const objects = new Map<string, RateLimiter>();
  const calls: string[] = [];
  const failNext: FakeRpcError[] = [];
  const objectFor = (name: string) => {
    let obj = objects.get(name);
    if (!obj) {
      let state = states.get(name);
      if (!state) states.set(name, (state = fakeDurableState()));
      obj = new RateLimiter(state, {});
      objects.set(name, obj);
    }
    return obj;
  };
  async function rpc<T>(method: string, name: string, run: (obj: RateLimiter) => Promise<T>): Promise<T> {
    calls.push(`${method} ${name}`);
    await Promise.resolve();
    const err = failNext.shift();
    if (err) throw err;
    return structuredClone(await run(objectFor(name)));
  }
  return {
    calls,
    states,
    failNext,
    restart: () => objects.clear(),
    stamps: (name) => {
      const saved = states.get(name)?.data.get(name);
      return Array.isArray(saved) ? [...saved] : [];
    },
    idFromName: (name) => ({ name }),
    get(id): RateLimiterStub {
      const name = (id as { name: string }).name;
      return {
        hit: (key, limit, windowMs, now) => {
          const [k, l, w, n] = structuredClone([key, limit, windowMs, now] as const);
          return rpc('hit', name, (o) => o.hit(k, l, w, n));
        },
        release: (key, stamp) => rpc('release', name, (o) => o.release(key, stamp)),
      };
    },
  };
}

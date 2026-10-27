import { describe, expect, it } from 'vitest';
import { LatestQueue } from '../src/lib/latestQueue';

// 手动控制的任务：开始时记一笔，测试调 finish / fail 才结束
function harness() {
  const log: string[] = [];
  const errors: unknown[] = [];
  const running = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  const queue = new LatestQueue<string>(
    (item) => {
      log.push(`start ${item}`);
      return new Promise<void>((resolve, reject) => {
        running.set(item, { resolve: () => { log.push(`end ${item}`); resolve(); }, reject });
      });
    },
    (err) => errors.push(err),
  );
  return {
    queue, log, errors,
    finish: (item: string) => running.get(item)!.resolve(),
    fail: (item: string, err: unknown) => running.get(item)!.reject(err),
  };
}

// 等排队的 Promise 回调都跑完
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LatestQueue', () => {
  it('空闲时立即执行；执行中来的任务等它结束才开始，不并发', async () => {
    const { queue, log, finish } = harness();
    void queue.push('a');
    expect(log).toEqual(['start a']);
    void queue.push('b');
    await settle();
    expect(log).toEqual(['start a']);
    finish('a');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    finish('b');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('执行中连来几个任务：只留最新的一个，中间的直接跳过', async () => {
    const { queue, log, finish } = harness();
    void queue.push('a');
    void queue.push('b');
    void queue.push('c');
    void queue.push('d');
    finish('a');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start d']);
    finish('d');
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start d', 'end d']);
  });

  it('push 返回的 Promise：任务执行完时 resolve；被跳过的，等取代它的那个执行完', async () => {
    const { queue, finish } = harness();
    const done: string[] = [];
    for (const item of ['a', 'b', 'c']) void queue.push(item).then(() => done.push(item));
    finish('a');
    await settle();
    expect(done).toEqual(['a']); // b 被 c 取代；c 还在执行，b 也还不算处理完
    finish('c');
    await settle();
    expect(done).toEqual(['a', 'b', 'c']);
  });

  it('任务出错交给 onError，push 的 Promise 照样 resolve；排着的和之后来的都照常执行', async () => {
    const { queue, log, errors, fail, finish } = harness();
    const a = queue.push('a');
    void queue.push('b');
    fail('a', new Error('boom'));
    await a;
    expect(errors.map((e) => (e as Error).message)).toEqual(['boom']);
    expect(log).toEqual(['start a', 'start b']);
    finish('b');
    await settle();
    void queue.push('c');
    expect(log).toEqual(['start a', 'start b', 'end b', 'start c']);
  });

  it('同步抛错的任务也接得住', async () => {
    const errors: unknown[] = [];
    const ran: string[] = [];
    const queue = new LatestQueue<string>((item) => {
      if (item === 'bad') throw new Error('sync');
      ran.push(item);
    }, (err) => errors.push(err));
    await queue.push('bad');
    await queue.push('ok');
    expect(errors).toHaveLength(1);
    expect(ran).toEqual(['ok']);
  });

  it('任务执行中自己又放进一个（比如重定向）：等它结束后执行', async () => {
    const ran: string[] = [];
    const queue: LatestQueue<string> = new LatestQueue<string>(async (item) => {
      ran.push(item);
      if (item === 'bad') void queue.push('home');
    }, () => {});
    await queue.push('bad');
    await settle();
    expect(ran).toEqual(['bad', 'home']);
  });
});

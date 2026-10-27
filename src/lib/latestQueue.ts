interface Batch<T> {
  item: T;
  waiters: Array<() => void>; // 等这一项（和被它取代的那些项）处理完的 push 调用
}

// 只执行最新一项的串行队列（路由用）：同一时间只处理一项；处理期间又来了新的，只留最新的一个，
// 等当前这项结束后处理它，中间来的直接跳过。处理出错交给 onError，队列照常往下走
export class LatestQueue<T> {
  private readonly run: (item: T) => Promise<void> | void;
  private readonly onError: (err: unknown) => void;
  private running = false;
  private pending: Batch<T> | null = null;

  constructor(run: (item: T) => Promise<void> | void, onError: (err: unknown) => void) {
    this.run = run;
    this.onError = onError;
  }

  // 有一项正在处理（可能还有一项在排队）
  get busy(): boolean {
    return this.running;
  }

  // 放进一项：空闲时立即开始处理。返回的 Promise 在这一项处理完时 resolve（出错也 resolve）；
  // 被后来的项取代而跳过的，等取代它的那一项处理完
  push(item: T): Promise<void> {
    return new Promise((resolve) => {
      if (this.running) {
        this.pending = { item, waiters: [...(this.pending?.waiters ?? []), resolve] };
        return;
      }
      void this.drain({ item, waiters: [resolve] });
    });
  }

  private async drain(first: Batch<T>): Promise<void> {
    this.running = true;
    let batch: Batch<T> | null = first;
    while (batch) {
      try {
        await this.run(batch.item);
      } catch (err) {
        this.report(err);
      }
      for (const resolve of batch.waiters) resolve();
      batch = this.pending;
      this.pending = null;
    }
    this.running = false;
  }

  // onError 自己再出错也不能把队列卡住
  private report(err: unknown): void {
    try {
      this.onError(err);
    } catch (again) {
      console.error(again);
    }
  }
}

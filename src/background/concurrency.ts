/**
 * 固定并发上限的异步工作池。
 *
 * 用于公开名片补全：串行时 50 个账号最多 100 次网络往返，会把整轮扫描
 * 拖到几十秒；一次性全部并发又容易打满对方接口。这里保证同时最多
 * `limit` 个任务在跑，并且不一次性创建全部 Promise。
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        await task(item);
      }
    }
  });
  await Promise.all(workers);
}

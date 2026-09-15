/**
 * 按键串行化的互斥闸。库存落盘、分片暂存与写入幂等记录三处共用同一份实现——
 * 这类「先读后写」的临界区自己各写一份是本仓反复出现的缺陷形状，
 * 一处修好另一处照旧丢更新，收敛成单一实现比补 if 可靠。
 *
 * 语义：同一 key 的 task 串行执行，不同 key 并发；前一个 task 抛错不阻塞后一个
 * （catch 后继续排队），队尾清空时自动删除 map 条目，避免长期运行进程里 key 无限增长。
 */
export async function withSerializedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  let release: (() => void) | undefined;
  const currentTurn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.catch(() => undefined).then(() => currentTurn);
  locks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release?.();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

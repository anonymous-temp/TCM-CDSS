import { createHash } from "node:crypto";

/**
 * 小任务结果的进程内缓存与并发合流（2026-09-27，提速）。
 *
 * 方名召回改写、证候重排这类 temperature 0 的闭集小任务，输入相同则结论相同；M02 路由按
 * 同一份病例预取它们（stage-prefetch.server.ts），M03 路由原样调用时命中，省掉两半开跑前
 * 串行等待的约 1.7–2.6s。
 *
 * 纪律：
 *  · 键是实际发给模型的请求内容（模型名 + 消息），不是调用方的推测——输入变了只会未命中；
 *  · 只缓存「模型确实作答」的结果（compute 自己声明 cacheable），降级值（超时、未配置、异常）不入缓存；
 *  · 共享计算不绑定任何一个调用方的中止信号；调用方中止时自己先按降级值返回。
 */
type MemoEntry<T> = { storedAt: number; value: T };

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 128;
const stores = new Map<string, { cache: Map<string, MemoEntry<unknown>>; inFlight: Map<string, Promise<unknown>> }>();

function storeFor(namespace: string) {
  let store = stores.get(namespace);
  if (!store) {
    store = { cache: new Map(), inFlight: new Map() };
    stores.set(namespace, store);
  }
  return store;
}

export function smallTaskMemoKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function memoizedSmallTask<T>(
  namespace: string,
  key: string,
  compute: () => Promise<{ value: T; cacheable: boolean }>,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  if (process.env.CDSS_SMALL_TASK_MEMO === "false") return (await compute()).value;
  if (signal?.aborted) return fallback;
  const store = storeFor(namespace);
  const hit = store.cache.get(key) as MemoEntry<T> | undefined;
  if (hit && Date.now() - hit.storedAt < DEFAULT_TTL_MS) return hit.value;
  if (hit) store.cache.delete(key);
  let pending = store.inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = compute()
      .then((result) => {
        if (result.cacheable) {
          store.cache.set(key, { storedAt: Date.now(), value: result.value });
          while (store.cache.size > DEFAULT_MAX_ENTRIES) {
            const oldest = store.cache.keys().next().value;
            if (oldest === undefined) break;
            store.cache.delete(oldest);
          }
        }
        return result.value;
      })
      .catch(() => fallback)
      .finally(() => store.inFlight.delete(key));
    store.inFlight.set(key, pending);
  }
  if (!signal) return pending;
  return new Promise<T>((resolve) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    pending!.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      () => { signal.removeEventListener("abort", onAbort); resolve(fallback); },
    );
  });
}

/** 测试用：清空全部小任务缓存。 */
export function resetSmallTaskMemoForTests(): void {
  stores.clear();
}

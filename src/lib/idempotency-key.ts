/**
 * `Idempotency-Key` 请求头的**唯一**格式判据。
 *
 * 此前这条正则只存在于 customer-registry.server.ts 里，于是「格式合法」只在 JIT 客户登记
 * 那条路径上成立；库存写入路径读了同一个请求头却不按同一份判据判定。两处各写各的正是
 * 本仓的头号缺陷形状，这里收敛成单一导出谓词，新增消费方一律走它。
 *
 * 8–200 位可打印 ASCII（\x21-\x7e，不含空格），与对外接口文档 §3.2 一致。
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;

/** 合法则返回去空白后的键，非法（含缺失）返回空串——调用方以空串判定「无有效幂等键」。 */
export function normalizeIdempotencyKey(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return IDEMPOTENCY_KEY_PATTERN.test(raw) ? raw : "";
}

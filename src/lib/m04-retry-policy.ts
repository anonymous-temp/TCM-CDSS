/**
 * M04「重新生成候选方药」的跨请求重试策略（甲方生产实测 2026-08-04 缺陷3）。
 *
 * 生产实证（BASE_URL=https://82.156.128.153/tcm-cdss，2026-08-04）：
 * 风寒病例「气虚外感风寒证」首轮 M04 合同拒绝、0 味，医生按提示点「重新生成候选方药」，
 * 第二次返回的正文与第一次 **byte-identical**（`diff` 无输出），reasonCode 同为
 * `final_contract_rejected`，M05 因而始终不可达。
 *
 * 根因不在某一个驳回码，而在**重试的性质**：同一份 caseState + 同一份已签名 M03 → 同一段提示词
 * → 结构化阶段固定 `temperature: 0` → 同一份模型输出 → 同一个确定性驳回 → 由驳回码确定性派生的
 * 同一段修复提示 → 同一个结局。编排层自己的信条是「同一修复提示重复注入(fixpoint) = 同一张失败
 * 彩票，必须早退并转入带批注受理」——这条信条在**一次请求内部**执行，跨请求却完全失效：
 * 第二次请求的修复计数、fixpoint 标志、时限全部归零，于是把已经证明走不通的那条路又走了一遍。
 * 结果是：产品给了医生一个「重新生成」的恢复动作，而引擎保证它不可能产生不同结果。
 *
 * 本模块把「上一次同输入已经失败」这件事变成下一次请求的输入：
 *   · repairExhaustedOnEntry —— 上一次已经证明修复轮无效，本轮不再重复烧同一轮，直接让既有的
 *     透明降级/带批注受理判定可达（该判定的安全前提一条不减：逐味剂量边界、十八反十九畏、
 *     特殊人群门禁、君臣结构、独立复核仍全部执行，只有「修复机会是否用尽」这一个前提被承接）；
 *   · samplingTemperature —— 首轮仍是 0（确定性、可复现）；重试轮小幅升温，让它成为**另一张**
 *     彩票而不是同一张。签名绑定的是最终产出内容，不依赖采样温度，因此可复现性边界不变。
 *
 * 账本是进程内的、有界的、可过期的——与限流桶同样的单实例假设。丢失账本的后果只是退回今天的
 * 行为（重试 = 同一张彩票），不会放宽任何安全判定，因此是 fail-safe 而非 fail-open。
 */

export type M04RetryPolicy = {
  priorContractRejections: number;
  /** 上一次同输入已证明修复轮无效：本轮按「修复机会已用尽」参与既有受理判定。 */
  repairExhaustedOnEntry: boolean;
  /** 结构化阶段采样温度。首轮 0；重试轮升温以脱离同一张失败彩票。 */
  samplingTemperature: number;
};

/** 重试轮温度阶梯。上限刻意保守：目标是换一张彩票，不是让模型自由发挥。 */
const RETRY_TEMPERATURE_LADDER = [0, 0.3, 0.5, 0.7] as const;

export function m04RetryPolicyForAttempt(priorContractRejections: number): M04RetryPolicy {
  const prior = Number.isFinite(priorContractRejections) && priorContractRejections > 0
    ? Math.floor(priorContractRejections)
    : 0;
  return {
    priorContractRejections: prior,
    repairExhaustedOnEntry: prior >= 1,
    samplingTemperature: RETRY_TEMPERATURE_LADDER[Math.min(prior, RETRY_TEMPERATURE_LADDER.length - 1)],
  };
}

/**
 * 同一次「重新生成」的判据：同一个病例 + 同一份已签名 M03。
 * 两者都变了就是另一次诊疗，不该继承上一次的失败结论。签名本身已绑定病历内容与辨证结论，
 * 因此不需要再对病历正文另做指纹。
 */
export function m04AttemptKey(input: {
  caseId?: unknown;
  m03ContractSignature?: unknown;
}): string | undefined {
  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  const signature = typeof input.m03ContractSignature === "string" ? input.m03ContractSignature.trim() : "";
  if (!caseId || !signature) return undefined;
  return `${caseId}|${signature}`;
}

const LEDGER_TTL_MS = 30 * 60_000;
const LEDGER_MAX_ENTRIES = 512;
type LedgerEntry = { contractRejections: number; updatedAt: number };
// 与限流桶同构的进程内存储：用 Symbol.for 挂在 globalThis 上，避免开发期模块重载导致账本分裂。
const LEDGER_STORE = Symbol.for("tcm-cdss.m04-retry-ledger.v1");
function ledger(): Map<string, LedgerEntry> {
  const host = globalThis as unknown as Record<symbol, Map<string, LedgerEntry> | undefined>;
  const existing = host[LEDGER_STORE];
  if (existing) return existing;
  const created = new Map<string, LedgerEntry>();
  host[LEDGER_STORE] = created;
  return created;
}

function pruneLedger(now: number): void {
  const store = ledger();
  for (const [key, entry] of store) {
    if (now - entry.updatedAt > LEDGER_TTL_MS) store.delete(key);
  }
  while (store.size > LEDGER_MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

export function priorM04ContractRejections(key: string | undefined, now = Date.now()): number {
  if (!key) return 0;
  const entry = ledger().get(key);
  if (!entry) return 0;
  if (now - entry.updatedAt > LEDGER_TTL_MS) {
    ledger().delete(key);
    return 0;
  }
  return entry.contractRejections;
}

/**
 * 记录一次 M04 的结局。只有「合同驳回/0 味」才累计——出方（含带批注受理）立即清账，
 * 否则一次历史失败会永久改变后续同病例的采样行为。
 */
export function recordM04AttemptOutcome(
  key: string | undefined,
  outcome: "contract_rejected" | "delivered",
  now = Date.now(),
): void {
  if (!key) return;
  const store = ledger();
  if (outcome === "delivered") {
    store.delete(key);
    return;
  }
  const entry = store.get(key);
  store.set(key, { contractRejections: (entry?.contractRejections || 0) + 1, updatedAt: now });
  pruneLedger(now);
}

/** 测试用：清空账本。 */
export function resetM04AttemptLedger(): void {
  ledger().clear();
}

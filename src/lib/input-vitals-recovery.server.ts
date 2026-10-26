/**
 * 生命体征字段读不出时，从同一病例最近一次请求补回（用户 2026-10-26 决定 D2）。
 *
 * 为什么：甲方两个诊所调用红旗检查接口时，caseState.vitals 每一项都是 .NET 的序列化残留 {"ValueKind":3}
 * （System.Text.Json 的 JsonElement 被另一个序列化器当普通对象输出，数值本身没有传来）。10/13 起 34 次，
 * 同一病例几秒前的追问请求、之后的辨证/开方请求里生命体征都是正常数值。这些红旗检查等于没有体温、心率。
 *
 * 做法：
 * - 每个带可读生命体征的临床请求，按「租户 + 调用方病例编号」记住最近一次的数值（只在进程内，30 分钟过期，有上限）；
 * - 某次请求的生命体征有读不出的项时，只补这些项，已读到的不覆盖；补回的数值与来源记遥测（不含内容）；
 * - 补不回的项写进 state.inputDiagnostics.unreadableVitals，安全门据此在 advisories 里提示「这几项未能读取」。
 * 没有调用方病例编号时不补（无法确认是同一病人）。
 */
import type { CaseState } from "./diagnosis-types";

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 5_000;
const memo = new Map<string, { vitals: Record<string, string | number>; at: number }>();

function memoKey(tenant: string, caseId: string): string {
  return `${tenant}\u0000${caseId}`;
}

/** 调用方 vitals 里传来但读不出的项：值是对象或数组（序列化残留），sourceConflicts 除外。 */
export function unreadableVitalKeys(rawVitals: unknown): string[] {
  if (!rawVitals || typeof rawVitals !== "object" || Array.isArray(rawVitals)) return [];
  return Object.entries(rawVitals as Record<string, unknown>)
    .filter(([key, value]) => key !== "sourceConflicts" && value != null && typeof value === "object")
    .map(([key]) => key);
}

function readableVitals(vitals: CaseState["vitals"]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vitals || {})) {
    if (key === "sourceConflicts" || key === "detail") continue;
    if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

function prune(now: number): void {
  if (memo.size <= MAX_ENTRIES) return;
  for (const [key, entry] of memo) {
    if (now - entry.at > TTL_MS || memo.size > MAX_ENTRIES) memo.delete(key);
    if (memo.size <= MAX_ENTRIES * 0.9) break;
  }
}

export function recoverUnreadableVitals(
  state: CaseState,
  rawCaseState: unknown,
  tenant: string,
  now = Date.now(),
): CaseState {
  const raw = rawCaseState && typeof rawCaseState === "object" && !Array.isArray(rawCaseState)
    ? rawCaseState as Record<string, unknown>
    : {};
  const rawVitals = Object.entries(raw).find(([key]) => key.toLowerCase() === "vitals")?.[1];
  const rawId = Object.entries(raw).find(([key]) => key.toLowerCase() === "id")?.[1];
  const caseId = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
  const unreadable = unreadableVitalKeys(rawVitals);
  const readable = readableVitals(state.vitals);
  const key = caseId ? memoKey(tenant, caseId) : undefined;
  let next = state;
  const missing = unreadable.filter((name) => readable[name] === undefined);
  if (missing.length > 0) {
    const remembered = key ? memo.get(key) : undefined;
    const fresh = remembered && now - remembered.at <= TTL_MS ? remembered : undefined;
    const recovered = Object.fromEntries(missing.flatMap((name) => fresh?.vitals[name] !== undefined ? [[name, fresh.vitals[name]]] : []));
    const stillMissing = missing.filter((name) => recovered[name] === undefined);
    if (Object.keys(recovered).length > 0) {
      next = { ...next, vitals: { ...(next.vitals || {}), ...recovered } };
      console.warn("[tcm-cdss:telemetry] input_vitals_recovered", {
        keys: Object.keys(recovered), source: "same_case_recent_request", ageMs: fresh ? now - fresh.at : undefined,
      });
    }
    if (stillMissing.length > 0) {
      next = { ...next, inputDiagnostics: { ...(next.inputDiagnostics || {}), unreadableVitals: stillMissing } };
      console.warn("[tcm-cdss:telemetry] input_vitals_unreadable", { keys: stillMissing, hasCaseId: Boolean(caseId) });
    }
  }
  if (key && Object.keys(readable).length > 0) {
    const previous = memo.get(key);
    const base = previous && now - previous.at <= TTL_MS ? previous.vitals : {};
    memo.delete(key);
    memo.set(key, { vitals: { ...base, ...readable }, at: now });
    prune(now);
  }
  return next;
}

/** 测试用。 */
export function resetVitalsRecoveryForTests(): void {
  memo.clear();
}

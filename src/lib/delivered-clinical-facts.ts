import type { CaseState } from "./diagnosis-types";

type GateView = { status?: string; redFlags?: readonly string[] } | undefined;

/**
 * 接口调用方拿到的 `clinicalFacts.redFlags`（2026-10-31 第三十二轮，用户定「直接改」）。
 *
 * 这个数组内部是语义复核的工作记录：否认项（「否认疫区旅居史」）、需优先评估项、待澄清项都在里面。甲方面板只要它非空就亮
 * 「患者情况危急」横幅：10/26–10/30 共 49 次红旗响应亮了 19 次，真正 `red_flag` 只有 1 次；反过来，只由确定性规则判出的红旗
 * （危急生命体征）这里可能是空的或整个 clinicalFacts 为 null，又亮不起来。
 *
 * 接口上保证：**`clinicalFacts.redFlags` 非空当且仅当 `safetyGate.status === "red_flag"`**，其余线索仍在 `advisories`。
 * 内部判断与页面的回传不受影响：页面要回传带签名的完整记录，所以只投影接口调用方的响应；调用方若回传这份投影，签名对不上，
 * 服务端按病历重新取事实（缓存/留存命中），不会把投影当成复核结论。
 */
export function deliveredClinicalFactsForApiCaller<T extends NonNullable<CaseState["clinicalFacts"]>>(
  facts: T | null | undefined,
  gate: GateView,
): (Omit<T, "redFlags"> & { redFlags: unknown[] }) | { redFlags: unknown[] } | null {
  if (gate?.status !== "red_flag") return facts ? { ...facts, redFlags: [] } : null;
  const emergencies = (facts?.redFlags || []).filter((finding) =>
    finding.subject === "patient" && finding.status === "positive" && finding.urgency === "emergency");
  const redFlags: unknown[] = emergencies.length > 0
    ? emergencies
    : (gate.redFlags || []).map((quote) => ({
        category: "other_critical",
        subject: "patient",
        status: "positive",
        urgency: "emergency",
        triageBasis: "other_immediate_threat",
        quote,
      }));
  return facts ? { ...facts, redFlags } : { redFlags };
}

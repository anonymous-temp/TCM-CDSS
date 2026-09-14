import { normalizeReasoningV2, reasoningV2SchemaIssueCode, type ClinicalReasoningResultV2 } from "./diagnosis-types";
import { synchronizeVisibleClinicalSummary } from "./diagnosis-visible-summary";
import { sanitizeDiagnoseStreamingDraft } from "./diagnosis-stream-safety";
import { sanitizeUngroundedRedFlagNegations } from "./diagnosis-safety";
import type { CaseState } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
export const M03_PROVISIONAL_DRAFT_HEADING = "## 未签名工作草稿（未通过校验，仅供医生参考）";

/**
 * M03 的「未签名工作草稿」（owner 决策 2026-09-14）。
 *
 * 222 例实测里 7 例走了有限结果兜底：模型流中已经出现完整的辨证模块，最终页只剩
 * 「症状级工作判断」——草稿因为没过合同被整份丢弃。与 M04 的候选保留同一条道理：
 * 通过 schema 但没过合同的最后一版，作为**可见 Markdown** 附在有限页里，列出未通过的码。
 *
 * 与 M04 不同的硬约束：M03 的签名是阶段间的信任锚（M04 只认签名合同），所以这里
 *   · 永远不输出 sentinel、永远不签名——客户端解析的仍是有限合同，M04 照常 m03_unstable；
 *   · 只从**最后一次结构完整**的内容取草稿，schema 不过的原始 JSON 不是医生可读草稿；
 *   · 走与正式 M03 同一套可见投影与净化（synchronizeVisibleClinicalSummary、
 *     流式草稿净化、未接地否定句清理），不另写一份渲染。
 */
export function schemaValidDiagnoseDraft(content: string): ClinicalReasoningResultV2 | undefined {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return undefined;
  try {
    const raw = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    if (reasoningV2SchemaIssueCode(raw)) return undefined;
    const reasoning = normalizeReasoningV2(raw);
    return reasoning && reasoning.stage === "diagnose" ? reasoning : undefined;
  } catch {
    return undefined;
  }
}

/** 渲染草稿段；没有可读正文时返回空串。输出保证不含 sentinel。 */
export function renderM03ProvisionalDraftSection(
  draft: ClinicalReasoningResultV2 | undefined,
  rejectionReasons: ReadonlyArray<string | undefined>,
  clinicalContext = "",
  caseState?: CaseState,
): string {
  if (!draft) return "";
  const wrapped = `${START_MARKER}\n${JSON.stringify(draft)}\n${END_MARKER}`;
  const projected = synchronizeVisibleClinicalSummary(wrapped, "diagnose", clinicalContext, caseState ?? null);
  const sentinelAt = projected.indexOf(START_MARKER);
  let body = (sentinelAt >= 0 ? projected.slice(0, sentinelAt) : projected).trim();
  if (!body) return "";
  body = sanitizeDiagnoseStreamingDraft(body);
  if (caseState) body = sanitizeUngroundedRedFlagNegations(body, caseState);
  // 草稿正文里的一级标题降为三级，避免与有限页自己的分节混成一张报告。
  body = body.replace(/^##\s+/gm, "### ");
  const codes = [...new Set(rejectionReasons.map((reason) => (reason || "").trim()).filter(Boolean))];
  return [
    M03_PROVISIONAL_DRAFT_HEADING,
    "本次模型已形成下列辨证分析，但**未通过服务端校验、未经独立复核、未签名**，不进入候选方药生成；重新运行辨病辨证时会以此为基础定向修复。",
    codes.length > 0 ? `未通过项：${codes.map((code) => `\`${code}\``).join("、")}` : "未通过项：本轮未记录具体原因码",
    "",
    body,
  ].join("\n");
}

/** 把草稿段插在有限页的 sentinel 之前；幂等，空段原样返回。 */
export function insertM03ProvisionalDraft(page: string, section: string): string {
  if (!section || page.includes(M03_PROVISIONAL_DRAFT_HEADING)) return page;
  const at = page.indexOf(START_MARKER);
  return at >= 0 ? `${page.slice(0, at)}${section}\n\n${page.slice(at)}` : `${page}\n\n${section}`;
}

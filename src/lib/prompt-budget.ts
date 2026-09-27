const EVIDENCE_OMISSION_MARKER = "\n\n【证据上下文预算裁剪】中间的低优先级检索文本已省略；仅可引用本提示中仍完整可见的条目。\n\n";

export type PromptEvidenceBudget = {
  text: string;
  truncated: boolean;
  omittedChars: number;
};

function lineBoundaryBefore(text: string, target: number): number {
  const boundary = text.lastIndexOf("\n", target);
  return boundary >= Math.floor(target / 2) ? boundary : target;
}

function lineBoundaryAfter(text: string, target: number): number {
  const boundary = text.indexOf("\n", target);
  return boundary >= 0 && boundary - target <= Math.max(200, Math.floor((text.length - target) / 2))
    ? boundary + 1
    : target;
}

/**
 * 按证据段优先级裁剪（2026-09-27）。
 *
 * 原先只按位置保头 60%、尾 40%。M04 证据的实际排布是：官方依据 → 院内合理用药/中药标准资料
 * （剂量与配伍索引，约 8k 字）→ 本地方剂出处库 → 本地中成药说明书候选 → EviMed 检索 → 决策卡片 →
 * 规划器西药说明书记录。9/27 抓取的真实 M04 提示词里，被整段裁掉的恰恰是中间的方剂出处与本地中成药
 * 候选（M04 要用的），留下的尾部却是与本例无关的 EviMed 条目（胃痛病例拿到黄褐斑、脓疱疮共识）。
 *
 * 现在按段裁：段落以 `## ` 或 `【` 开头的行切分；病例绑定的受控材料（方剂出处、本地中成药候选、
 * 规划器说明书记录、配伍预检、诊断参考、决策卡片、官方依据）整段保留；超预算时先从大块的通用索引
 * （院内合理用药/中药标准资料）段尾逐行裁，再裁 EviMed 检索段。识别不出分段时退回原位置裁剪。
 * `CDSS_EVIDENCE_PRIORITY_COMPACTION=false` 回退原行为。
 */
const EVIDENCE_TRIM_FIRST = /^## 院内合理用药\/中药标准资料支持/;
const EVIDENCE_TRIM_SECOND = /^## (?:外部证据检索支持|EviMed)/;
const EVIDENCE_SECTION_START = /^(?:## |【)/;

function compactEvidenceBySectionPriority(source: string, limit: number): PromptEvidenceBudget | undefined {
  const lines = source.split("\n");
  const sections: Array<{ lines: string[]; rank: number }> = [];
  for (const line of lines) {
    if (sections.length === 0 || EVIDENCE_SECTION_START.test(line)) {
      sections.push({
        lines: [line],
        rank: EVIDENCE_TRIM_FIRST.test(line) ? 1 : EVIDENCE_TRIM_SECOND.test(line) ? 2 : 3,
      });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  if (!sections.some((section) => section.rank < 3)) return undefined;
  const marker = "【证据上下文预算裁剪】本段其余条目已按预算省略；仅可引用本提示中仍完整可见的条目。";
  const size = () => sections.reduce((sum, section) => sum + section.lines.join("\n").length + 1, -1);
  for (const rank of [1, 2]) {
    for (let index = sections.length - 1; index >= 0 && size() > limit; index -= 1) {
      const section = sections[index];
      if (section.rank !== rank) continue;
      let trimmed = false;
      // 保留段标题与首行（检索词/用途说明），其余条目从段尾逐行裁；裁时预留说明行长度。
      while (section.lines.length > 2 && size() + marker.length + 1 > limit) {
        section.lines.pop();
        trimmed = true;
      }
      if (trimmed) section.lines.push(marker);
    }
    if (size() <= limit) break;
  }
  const text = sections.map((section) => section.lines.join("\n")).join("\n");
  if (text.length > limit) return undefined;
  return { text, truncated: true, omittedChars: Math.max(0, source.length - text.length) };
}

/**
 * Keep evidence inside the model prompt budget without silently discarding an entire authority tier.
 *
 * Evidence is ordered with official/local rules first and external case-bound results later. Keeping
 * both ends preserves those two independent trust anchors. Cuts prefer newline boundaries so an ID,
 * title or URL is not normally split into a misleading partial citation. The returned text is also
 * the only text that may be used to build the output citation whitelist.
 */
export function compactEvidenceContextForPrompt(
  evidenceContext: string,
  maxChars: number,
): PromptEvidenceBudget {
  const source = String(evidenceContext || "");
  const limit = Math.max(0, Math.floor(maxChars));
  if (source.length <= limit) return { text: source, truncated: false, omittedChars: 0 };
  if (limit === 0) return { text: "", truncated: true, omittedChars: source.length };
  if (process.env.CDSS_EVIDENCE_PRIORITY_COMPACTION !== "false") {
    const prioritized = compactEvidenceBySectionPriority(source, limit);
    if (prioritized) return prioritized;
  }
  if (limit <= EVIDENCE_OMISSION_MARKER.length + 40) {
    const text = source.slice(0, limit);
    return { text, truncated: true, omittedChars: source.length - text.length };
  }

  const contentBudget = limit - EVIDENCE_OMISSION_MARKER.length;
  const desiredHead = Math.floor(contentBudget * 0.6);
  const desiredTail = contentBudget - desiredHead;
  const headEnd = lineBoundaryBefore(source, desiredHead);
  const tailStart = lineBoundaryAfter(source, source.length - desiredTail);

  if (headEnd >= tailStart) {
    const text = source.slice(0, limit);
    return { text, truncated: true, omittedChars: source.length - text.length };
  }
  const head = source.slice(0, headEnd).trimEnd();
  const tail = source.slice(tailStart).trimStart();
  const text = `${head}${EVIDENCE_OMISSION_MARKER}${tail}`.slice(0, limit);
  return { text, truncated: true, omittedChars: source.length - head.length - tail.length };
}

/**
 * M04 证据块总预算（字符）。默认 15_000 ≈ 9k token；可用 PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS
 * 调整，钳制 4_000–40_000。此前无总量上限，证据总是填满到 60k 提示词上限。
 * Exported for unit tests.
 */
export function m04EvidencePromptBudgetChars(): number {
  const value = Number(process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS || 15_000);
  return Number.isFinite(value) && value >= 4_000 && value <= 40_000 ? Math.round(value) : 15_000;
}

/**
 * M03 证据块预算。
 *
 * M04 在 2026-08-25 因「平均 35.6k token、缓存命中 13%、prefill 每轮重付」加过同款预算，
 * M03 一直裸拼到总提示词上限——而 M03 的证据块要被生成两半 + 复核 + 每个修复轮反复重付，
 * 放大倍数比 M04 更高。两处用同一套钳制规则，避免同一判据两处各写各的。
 */
export function m03EvidencePromptBudgetChars(): number {
  const value = Number(process.env.PRIMARY_DIAGNOSE_EVIDENCE_MAX_CHARS || 15_000);
  return Number.isFinite(value) && value >= 4_000 && value <= 40_000 ? Math.round(value) : 15_000;
}

/**
 * M04 外部检索软等待（从 M04 路由开始计，毫秒）。默认 2000：与规划器腿（线上 1.7–2.2s）齐平，
 * 让 EviMed 不再单独拉长 M04 前置。`PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS=off`
 * 恢复「等到检索返回为止」。钳制 500–15000。
 */
export function m04ExternalEvidenceSoftDeadlineMs(): number | undefined {
  const raw = (process.env.PRIMARY_PRESCRIBE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS || "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "none") return undefined;
  const value = Number(raw || 2_000);
  return Number.isFinite(value) ? Math.min(15_000, Math.max(500, Math.round(value))) : 2_000;
}

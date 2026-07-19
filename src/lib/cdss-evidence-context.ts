import type { CaseState } from "./diagnosis-types";
import { EVIDENCE_LEVELS } from "./cdss-vocab";
import { buildExternalEvidenceContext } from "./evimed-guide";
import { buildFormulaProvenanceContext } from "./tcm-formula-provenance";
import { buildTcmKnowledgeContext } from "./tcm-knowledge";
import { sanitizeCustomerEvidenceDocument, sanitizeInlineEvidenceClaims, sanitizeLabeledEvidenceLines } from "./customer-evidence";
import { buildEvidenceScope, sanitizeEvidenceObject, sourceAllowed, sourceSupportsMedicine, type EvidenceScope } from "./evidence-source-validation";

export type EvidenceStage = "diagnose" | "prescribe" | "assess";

const BASELINE_OFFICIAL_EVIDENCE = [
  "- [OFFICIAL-RX-REVIEW] 国家卫生健康委等《医疗机构处方审核规范》（国卫办医发〔2018〕14号）：处方审核信息化可辅助药师，规则应有明确临床用药依据来源。https://www.nhc.gov.cn/wjw/c100175/201807/1774578ad7ad410491c060f684947639.shtml",
  "- [OFFICIAL-CPM-GUIDE] 国家中医药管理局/原卫生部《中成药临床应用指导原则》：中成药应辨证辨病施治，具体使用以说明书、药典和临床用药须知为准。https://www.natcm.gov.cn/yizhengsi/gongzuodongtai/2018-03-24/3071.html",
  "- [OFFICIAL-CHP-2025] 国家药典委员会《中华人民共和国药典》2025年版：首页仅用于确认现行版本；未接入逐条目结构化数据前，不得用该通用ID证明具体药味、剂量、炮制或禁忌。https://2025.chp.org.cn/",
].join("\n");

export async function buildCdssEvidenceContext(
  caseState: CaseState,
  stage: EvidenceStage,
): Promise<string> {
  const localContext = buildTcmKnowledgeContext(caseState, stage);
  const externalEvidenceContext = await buildExternalEvidenceContext(caseState, stage);
  const formulaProvenanceContext = stage === "prescribe" ? buildFormulaProvenanceContext(caseState) : "";

  return [
    "【外部证据与院内知识支持】",
    "使用要求：以下资料只能作为医生辅助决策证据源；资料未覆盖时不得伪造来源，也不得把内部检索状态写进客户正文。请省略客户侧引用字段，并在结构化 evidence 中使用 insufficient 供后台审计。",
    "## 官方基础依据",
    BASELINE_OFFICIAL_EVIDENCE,
    localContext,
    formulaProvenanceContext,
    externalEvidenceContext,
  ].join("\n\n");
}

export function appendEvidenceContext(prompt: string, evidenceContext: string): string {
  return `${prompt}\n\n${evidenceContext}\n\n证据引用强约束：输出中的“证据依据/引用来源/依据”只能引用上方资料中的方括号ID、真实题名、真实URL、真实说明书/药典来源或本地知识库已给出的来源字段。未命中时省略客户正文里的来源字段，结构化 evidence 使用 evidenceLevel=insufficient、source=内部证据缺口；严禁向客户输出“证据不足/待检索/检索失败/未配置”等内部状态，也不得编造指南、文献题名、说明书、批准文号、年份、链接、DOI或不存在的院内规则。`;
}

function sanitizeSentinelJsonBlocks(content: string, scope: EvidenceScope): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        const hideInternalEvidenceSources = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(hideInternalEvidenceSources);
          if (!value || typeof value !== "object") return value;
          const output = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, hideInternalEvidenceSources(raw)]));
          if (output.evidenceLevel === "insufficient") output.source = "";
          return output;
        };
        const sanitized = sanitizeEvidenceObject(parsed, scope, EVIDENCE_LEVELS);
        if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
          const formula = (sanitized as { formula?: unknown }).formula;
          if (formula && typeof formula === "object" && !Array.isArray(formula)) {
            const record = formula as { patentAndWestern?: unknown };
            if (Array.isArray(record.patentAndWestern)) {
              record.patentAndWestern = record.patentAndWestern.filter((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return false;
                const evidence = (item as { evidence?: unknown }).evidence;
                if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
                const ref = evidence as { evidenceLevel?: unknown; source?: unknown };
                const name = (item as { name?: unknown }).name;
                return ["guideline", "instruction", "drug_label", "literature"].includes(String(ref.evidenceLevel || "")) &&
                  typeof ref.source === "string" && ref.source.trim().length > 0 &&
                  typeof name === "string" && sourceSupportsMedicine(ref.source, name, scope);
              });
            }
          }
        }
        // Evidence cleanup must never rewrite clinical reasoning strings. The previous recursive
        // narrative scrub removed phrases such as “资料不足” from syndrome bases, resolution
        // reasons and differentials after independent review, changing the signed clinical payload
        // and forcing a second stochastic review. sanitizeEvidenceObject owns evidence claims;
        // this pass only hides the internal source of an insufficient evidence object.
        const customerSafe = hideInternalEvidenceSources(sanitized);
        if (customerSafe && typeof customerSafe === "object" && !Array.isArray(customerSafe)) {
          const formula = (customerSafe as { formula?: { modifications?: unknown } }).formula;
          if (formula && Array.isArray(formula.modifications)) {
            // Optional IF-THEN modifications must never invalidate a complete core candidate after
            // evidence redaction removes an unverified phrase. Keep only fully usable rows; the
            // current prescription, doses and audit object are unchanged.
            formula.modifications = formula.modifications.filter((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return false;
              const row = item as Record<string, unknown>;
              return [row.trigger, row.targetPathogenesis, row.action, row.reason]
                .every((value) => typeof value === "string" && value.trim().length > 0);
            });
          }
        }
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(customerSafe, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

function stripMarkdownEvidenceClaims(text: string, scope: EvidenceScope): string {
  const sanitizedReferences = text
    .replace(/\[([A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+)\]/g, (match, id: string) => scope.ids.has(id) ? match : "")
    // Stop-set includes quotes/angle-brackets so the URL match never swallows a JSON string's closing
    // quote or an HTML boundary (which would corrupt structure).
    .replace(/https?:\/\/[^\s)）\]"'<>，。；;]+/g, (url) => {
      const clean = url.replace(/[.,，。；;]+$/, "");
      return scope.urls.has(clean) ? url : "";
    });
  const withoutUnverifiedAuthorityClaims = sanitizeInlineEvidenceClaims(
    sanitizedReferences,
    (source) => sourceAllowed(source, undefined, scope),
  );
  return sanitizeLabeledEvidenceLines(
    withoutUnverifiedAuthorityClaims,
    (source) => sourceAllowed(source, undefined, scope),
  );
}

const SENTINEL_BLOCK = /<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g;

function sanitizeMarkdownEvidenceClaims(content: string, scope: EvidenceScope): string {
  // 绝不在 sentinel JSON 块内做基于文本的剥离：URL/括号ID 正则会吃掉 JSON 的引号/括号，破坏结构化块，
  // 使下游 JSON.parse 失败、反伪造与结构化解析双双失效。块内证据交由 sanitizeSentinelJsonBlocks 结构化处理。
  let result = "";
  let last = 0;
  SENTINEL_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTINEL_BLOCK.exec(content)) !== null) {
    result += stripMarkdownEvidenceClaims(content.slice(last, match.index), scope) + match[0];
    last = match.index + match[0].length;
  }
  result += stripMarkdownEvidenceClaims(content.slice(last), scope);
  return result;
}

function hideCustomerEvidencePlaceholders(content: string): string {
  return sanitizeCustomerEvidenceDocument(content)
    .replace(/\[?\s*(?:证据不足\s*[/／]\s*待检索|依据待检索|引用待检索|证据来源待核验|证据URL待核验)\s*\]?/g, "")
    .replace(/[（(]\s*(?:证据不足|待检索|待核验)(?:\s*[/／]\s*(?:证据不足|待检索|待核验))*\s*[）)]/g, "")
    .replace(
      /^\s*(?:[-*]\s*)?\*\*(?:证据依据|来源依据|参考依据|引用来源|方剂出处或依据)\*\*[：:]\s*$/gm,
      "",
    )
    .replace(/\n{3,}/g, "\n\n");
}

export function buildEvidenceOutputTransform(
  evidenceContext: string,
  priorTransform?: (content: string) => string,
): (content: string) => string {
  const scope = buildEvidenceScope(evidenceContext);
  return (content: string) => {
    const transformed = priorTransform ? priorTransform(content) : content;
    return hideCustomerEvidencePlaceholders(
      sanitizeSentinelJsonBlocks(sanitizeMarkdownEvidenceClaims(transformed, scope), scope),
    );
  };
}

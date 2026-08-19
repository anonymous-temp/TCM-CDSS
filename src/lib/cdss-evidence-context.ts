import { ageValue, type CaseState } from "./diagnosis-types";
import { EVIDENCE_LEVELS } from "./cdss-vocab";
import { buildExternalEvidenceContext } from "./evimed-guide";
import { buildFormulaProvenanceContext } from "./tcm-formula-provenance";
import { buildTcmKnowledgeContext } from "./tcm-knowledge";
import { sanitizeCustomerEvidenceDocument, sanitizeInlineEvidenceClaims, sanitizeLabeledEvidenceLines } from "./customer-evidence";
import { buildEvidenceScope, governedEvidenceCitation, medicineEvidenceBindingValid, medicineProblemMatchesCase, sanitizeEvidenceObject, sourceAllowed, sourceSupportsMedicine, type EvidenceScope } from "./evidence-source-validation";
import { buildLocalPatentMedicineContext } from "./local-patent-medicine-candidates";
import { buildClinicalDecisionCardContext } from "./tcm-clinical-decision-cards";
import type { AssistedNegationClauses } from "./clinical-polarity";
import { matchesPopulationScope } from "./clinical-vocabulary";
import { matchingMedicineClinicalProblemTerms } from "./medicine-clinical-concepts";
import { recordCdssKnowledgeTrace } from "./cdss-knowledge-telemetry";
import { localDiagnosticReferenceContext } from "./diagnostic-reference-catalog";

export type EvidenceStage = "diagnose" | "prescribe" | "assess";

const BASELINE_OFFICIAL_EVIDENCE = [
  "- [OFFICIAL-RX-REVIEW] 国家卫生健康委等《医疗机构处方审核规范》（国卫办医发〔2018〕14号）：处方审核信息化可辅助药师，规则应有明确临床用药依据来源。https://www.nhc.gov.cn/wjw/c100175/201807/1774578ad7ad410491c060f684947639.shtml",
  "- [OFFICIAL-CPM-GUIDE] 国家中医药管理局/原卫生部《中成药临床应用指导原则》：中成药应辨证辨病施治，具体使用以说明书、药典和临床用药须知为准。https://www.natcm.gov.cn/yizhengsi/gongzuodongtai/2018-03-24/3071.html",
  "- [OFFICIAL-CHP-2025] 国家药典委员会《中华人民共和国药典》2025年版：首页仅用于确认现行版本；未接入逐条目结构化数据前，不得用该通用ID证明具体药味、剂量、炮制或禁忌。https://2025.chp.org.cn/",
].join("\n");

export async function buildCdssEvidenceContext(
  caseState: CaseState,
  stage: EvidenceStage,
  // M03 会先算出增补否定子句（口语否定的语义兜底），M04 此前不传，于是同一句「胸口不疼」
  // 在 M03 判否定、在 M04 的中成药说明书召回里又变回阳性事实——M04 会拿 M03 已经排除的
  // 症状去召回中成药。兜底层建对了但只铺了一个阶段，这里把它接到 M04。
  assistedNegations?: AssistedNegationClauses,
): Promise<string> {
  const localContext = buildTcmKnowledgeContext(caseState, stage);
  const externalEvidenceContext = await buildExternalEvidenceContext(caseState, stage);
  const formulaProvenanceContext = stage === "prescribe" ? buildFormulaProvenanceContext(caseState) : "";
  // 方剂检索段由阶段提示词自己拼（buildDiagnosePrompt / buildPrescribePrompt），这里不再重复。
  // 曾经两处各拼一份，而提示词那份**不带 recallHint**：口语主诉下它返回「未命中受控经典方主治索引，
  // 必须说明未采用经典方」，随后证据段又附上 5 个候选——模型先读到前者，口语召回改写层被自己的
  // 提示词抵消，结论降级为自拟方。同一段内容出现两次且指令相反，是这条链路上最难查的一类缺陷。
  const formulaIndicationContext = "";
  const localPatentMedicineContext = stage === "prescribe"
    ? buildLocalPatentMedicineContext(caseState, 10, assistedNegations)
    : "";
  // 甲方决策卡片：**专家参考，不是证据来源**。它带参考文献但无 DOI/PMID，机器不可核验，
  // 按项目「结论可追溯」原则不能升格为指南/共识。所以它只在 M03/M04 作辨证思路提示注入，
  // 且每行都带 CLINICAL_DECISION_CARD_LINE_MARKER —— buildEvidenceScope 逐行跳过这些行，
  // 卡片里的题名/年份/URL 都进不了可引用白名单。M05 是确定性汇总，不注入。
  const clinicalDecisionCardContext = stage === "assess" ? "" : buildClinicalDecisionCardContext(caseState);
  const localDiagnosticReferences = stage === "diagnose"
    ? localDiagnosticReferenceContext([
        caseState.chiefComplaint,
        ...Object.values(caseState.symptoms || {}).map((value) => String(value ?? "")),
        caseState.hisRecord?.fields.xianbingshi,
      ].filter(Boolean).join("；"))
    : "";

  return [
    "【外部证据与院内知识支持】",
    "使用要求：以下资料只能作为医生辅助决策证据源；资料未覆盖时不得伪造来源，也不得把内部检索状态写进客户正文。请省略客户侧引用字段，并在结构化 evidence 中使用 insufficient 供后台审计。",
    "## 官方基础依据",
    BASELINE_OFFICIAL_EVIDENCE,
    localContext,
    formulaIndicationContext,
    formulaProvenanceContext,
    localPatentMedicineContext,
    externalEvidenceContext,
    localDiagnosticReferences,
    clinicalDecisionCardContext,
  ].join("\n\n");
}

export function appendEvidenceContext(prompt: string, evidenceContext: string): string {
  return `${prompt}\n\n${evidenceContext}\n\n证据引用强约束：输出中的“证据依据/引用来源/依据”只能引用上方资料中的方括号ID、真实题名、真实URL、真实说明书/药典来源或本地知识库已给出的来源字段。未命中时省略客户正文里的来源字段，结构化 evidence 使用 evidenceLevel=insufficient、source=内部证据缺口；严禁向客户输出“证据不足/待检索/检索失败/未配置”等内部状态，也不得编造指南、文献题名、说明书、批准文号、年份、链接、DOI或不存在的院内规则。`;
}

/**
 * 指南/文献依据的**回写契约**（甲方 2026-08-10 ⑩）。
 *
 * 检索侧一直是通的：`[EVID-GUIDE-002] 中国咳嗽基层诊疗与管理指南（2024年）（中华医学会
 * 呼吸病学分会，2024）` 就摆在同一次调用的 prompt 里。缺的是**回写**：模型只会写
 * `{"evidenceLevel":"model_inference","source":"病例内推理"}`——而那正是提示词模板预填给它的值，
 * 也正是呈现层 governedGuidelineReferences 第一个排除掉的值。模板在教模型填一个
 * 呈现层保证会丢掉的东西，于是「指南/文献依据」栏自诞生起产出 0 条。
 *
 * 修法照搬已跑通的 EVID-INST 形状：模型只回 evidenceId + 一句 appliesTo，
 * 服务端在这里按 id 反查条目、渲染题名/机构/年份/URL，然后**删掉模型侧字段**——
 * 模型无法引入任何新字符串。集外 id 直接丢弃；M03 模型漏填时只从本轮真实 scope
 * 里补入首条人群适用的指南/文献，没有真实条目仍保持空，绝不回落到自撰题名。
 */
function diagnosticReferenceAppliesToPatient(
  evidenceId: string,
  scope: EvidenceScope,
  caseState?: CaseState,
): boolean {
  if (!caseState) return true;
  const evidenceRecord = scope.records.find((candidate) => candidate.ids.has(evidenceId));
  if (!evidenceRecord) return false;
  const age = ageValue(caseState.patient.age);
  const spansBroadPopulation = matchesPopulationScope(evidenceRecord.text, "broad");
  if (age != null && age >= 18 && matchesPopulationScope(evidenceRecord.text, "pediatric") && !spansBroadPopulation) return false;
  if (age != null && age < 18 && matchesPopulationScope(evidenceRecord.text, "geriatric") && !spansBroadPopulation) return false;
  const patientText = [
    caseState.patient.sex,
    caseState.pastHistory,
    caseState.hisRecord?.fields.jiwangshi,
  ].filter(Boolean).join("；");
  const reproductiveScopeExcluded = caseState.patient.sex === "男" ||
    (age != null && age >= 60) ||
    /绝经|否认妊娠|无妊娠|不可能妊娠/.test(patientText);
  if (reproductiveScopeExcluded && (
    matchesPopulationScope(evidenceRecord.text, "maternal") ||
    matchesPopulationScope(evidenceRecord.text, "obstetric")
  )) return false;
  return true;
}

function diagnosticReferenceAnchors(payload: Record<string, unknown>, caseState?: CaseState): string[] {
  const western = payload.westernDiagnosis;
  const primary = western && typeof western === "object" && !Array.isArray(western)
    ? (western as { primary?: unknown }).primary
    : undefined;
  const primaryName = primary && typeof primary === "object" && !Array.isArray(primary)
    ? String((primary as { name?: unknown }).name || "").trim()
    : "";
  const normalizedPrimary = primaryName
    .replace(/[，,（(]?(?:病因待查|待查|症状性)[）)]?$/g, "")
    .replace(/^(?:急性|亚急性|慢性|反复性)/, "")
    .trim();
  const caseText = [primaryName, caseState?.chiefComplaint].filter(Boolean).join("；");
  return [...new Set([
    normalizedPrimary,
    ...matchingMedicineClinicalProblemTerms(caseText),
  ].map((item) => item.trim()).filter((item) => item.length >= 2))];
}

function preferredDiagnosticCitation(
  payload: Record<string, unknown>,
  scope: EvidenceScope,
  caseState?: CaseState,
): ReturnType<typeof governedEvidenceCitation> {
  return preferredDiagnosticCitationForAnchors(diagnosticReferenceAnchors(payload, caseState), scope, caseState);
}

function preferredDiagnosticCitationForAnchors(
  anchors: readonly string[],
  scope: EvidenceScope,
  caseState?: CaseState,
): ReturnType<typeof governedEvidenceCitation> {
  const candidates = scope.records.flatMap((evidenceRecord, recordIndex) =>
    [...evidenceRecord.ids].flatMap((evidenceId) => {
      if (!/^EVID-(?:GUIDE|PAPER)-\d{3}$/.test(evidenceId) ||
        !diagnosticReferenceAppliesToPatient(evidenceId, scope, caseState)) return [];
      const citation = governedEvidenceCitation(evidenceId, scope);
      if (!citation || !westernDiagnosticEvidenceApplies(evidenceId, scope)) return [];
      let relevance = 0;
      for (const anchor of anchors) {
        const titleIndex = citation.citation.indexOf(anchor);
        if (titleIndex >= 0) relevance = Math.max(relevance, 100 - Math.min(60, titleIndex));
        else if (evidenceRecord.text.includes(anchor)) relevance = Math.max(relevance, 20);
      }
      if (relevance === 0) return [];
      // 9xx 是逐条联网核验并在本地冻结的症状层诊断依据；只在病例命中对应模式时进入 scope。
      // 它们优先于供应商偶发返回的窄病因/窄部位文献（如“卒中后呃逆”用于普通呃逆）。
      const curatedPriority = /^EVID-(?:GUIDE|PAPER)-9\d{2}$/.test(evidenceId) ? 100 : 0;
      const sourcePriority = evidenceId.startsWith("EVID-GUIDE-") ? 10 : 0;
      return [{ citation, score: relevance + sourcePriority + curatedPriority, recordIndex }];
    }));
  candidates.sort((left, right) => right.score - left.score || left.recordIndex - right.recordIndex);
  return candidates[0]?.citation;
}

function citationSourceType(evidenceId: string): "guideline" | "literature" {
  return evidenceId.startsWith("EVID-PAPER-") ? "literature" : "guideline";
}

function diagnosticEvidenceRecord(evidenceId: string, scope: EvidenceScope) {
  return scope.records.find((candidate) => candidate.ids.has(evidenceId));
}

function tcmDiagnosticEvidenceApplies(evidenceId: string, scope: EvidenceScope): boolean {
  const record = diagnosticEvidenceRecord(evidenceId, scope);
  return Boolean(record && /(?:中医|中西医结合|中药|针灸|经方)/.test(record.text));
}

function westernDiagnosticEvidenceApplies(evidenceId: string, scope: EvidenceScope): boolean {
  return !tcmDiagnosticEvidenceApplies(evidenceId, scope);
}

function resolveGovernedTcmDiseaseReferences(
  payload: Record<string, unknown>,
  scope: EvidenceScope,
  caseState?: CaseState,
): void {
  const overview = payload.overview;
  if (!overview || typeof overview !== "object" || Array.isArray(overview)) return;
  const record = overview as Record<string, unknown>;
  const diseaseName = typeof record.tcmDiseaseName === "string" ? record.tcmDiseaseName.trim() : "";
  if (!diseaseName) return;
  const citation = scope.records.flatMap((evidenceRecord, recordIndex) =>
    [...evidenceRecord.ids].flatMap((evidenceId) => {
      if (!/^EVID-(?:GUIDE|PAPER)-\d{3}$/.test(evidenceId) ||
        !tcmDiagnosticEvidenceApplies(evidenceId, scope) ||
        !diagnosticReferenceAppliesToPatient(evidenceId, scope, caseState)) return [];
      const governed = governedEvidenceCitation(evidenceId, scope);
      if (!governed || !evidenceRecord.text.includes(diseaseName)) return [];
      const titleMatch = governed.citation.includes(diseaseName) ? 100 : 0;
      return [{ governed, score: titleMatch + 10, recordIndex }];
    }))
    .sort((left, right) => right.score - left.score || left.recordIndex - right.recordIndex)[0]?.governed;
  record.tcmDiseaseReferences = citation
    ? [{ ...citation, sourceType: citationSourceType(citation.evidenceId) }]
    : [];
}

function resolveGovernedGuidelineReferences(
  payload: Record<string, unknown>,
  scope: EvidenceScope,
  caseState?: CaseState,
): void {
  resolveGovernedTcmDiseaseReferences(payload, scope, caseState);
  const western = payload.westernDiagnosis;
  if (!western || typeof western !== "object" || Array.isArray(western)) return;
  const primary = (western as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return;
  const record = primary as Record<string, unknown>;
  // **必须幂等**：本转换会在同一份内容上被多次调用（流式草稿、最终输出、截断兜底各一次）。
  // 只读 guidelineRefs 而无条件 delete guidelineReferences，会让第二遍把第一遍解析好的引用删掉——
  // 正是本轮在修的那一类缺陷。因此已解析的条目也参与本轮重解析：它们照样要按 evidenceId
  // 反查得到、且 citation 必须与服务端此刻渲染的结果逐字一致，伪造插入的条目通不过。
  const claimed = [
    ...(Array.isArray(record.guidelineRefs) ? record.guidelineRefs : []),
    ...(Array.isArray(record.guidelineReferences) ? record.guidelineReferences : []),
  ];
  const resolved: Array<{ evidenceId: string; citation: string; url?: string; appliesTo?: string }> = [];
  const seen = new Set<string>();
  for (const entry of claimed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as { evidenceId?: unknown; appliesTo?: unknown };
    const citation = governedEvidenceCitation(item.evidenceId, scope);
    if (!citation || seen.has(citation.evidenceId) ||
      !diagnosticReferenceAppliesToPatient(citation.evidenceId, scope, caseState) ||
      !westernDiagnosticEvidenceApplies(citation.evidenceId, scope)) continue;
    seen.add(citation.evidenceId);
    // appliesTo 是模型唯一能写的字段，且只是「这条支持本例哪一点」的一句话；
    // 它不承载题名/机构/年份，因此不构成伪造引用的通道。超长即截断。
    const appliesTo = typeof item.appliesTo === "string" ? item.appliesTo.trim().slice(0, 120) : "";
    resolved.push({ ...citation, ...(appliesTo ? { appliesTo } : {}) });
    if (resolved.length >= 3) break;
  }
  // 甲方要求诊断终稿必须携带本轮参考的指南/共识或文献依据。M03 统一采用服务端
  // 检索排序中首条人群适用的 GUIDE（没有才用 PAPER），而不是让模型任意跳到更窄病因。
  // 模型只在恰好选中同一条时贡献 appliesTo；题名、年份、URL 与排序权均不交给模型。
  // 没有真实检索记录就保持空，绝不自造。
  if (payload.stage === "diagnose") {
    const authoritative = preferredDiagnosticCitation(payload, scope, caseState);
    if (authoritative) {
      const sameClaim = resolved.find((item) => item.evidenceId === authoritative?.evidenceId);
      resolved.splice(0, resolved.length, {
        ...authoritative,
        ...(sameClaim?.appliesTo ? { appliesTo: sameClaim.appliesTo } : {}),
      });
    }
  }
  delete record.guidelineRefs;
  if (resolved.length > 0) record.guidelineReferences = resolved;
  else delete record.guidelineReferences;

  const differentials = (western as { differentials?: unknown }).differentials;
  if (!Array.isArray(differentials)) return;
  for (const differential of differentials) {
    if (!differential || typeof differential !== "object" || Array.isArray(differential)) continue;
    const item = differential as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      delete item.guidelineReferences;
      continue;
    }
    const anchors = [...new Set([
      name,
      ...matchingMedicineClinicalProblemTerms(name),
    ].map((value) => value.trim()).filter((value) => value.length >= 2))];
    const citation = preferredDiagnosticCitationForAnchors(anchors, scope, caseState);
    item.guidelineReferences = citation
      ? [{ ...citation, sourceType: citationSourceType(citation.evidenceId) }]
      : [];
  }
}

function restoreSignedM03ClinicalSections(
  payload: Record<string, unknown>,
  caseState?: CaseState,
): void {
  if (payload.stage !== "prescribe") return;
  const prior = caseState?.reasoningDiagnose;
  if (!prior || prior.stage !== "diagnose") return;
  // M04 is allowed to add formula, non-pharmacological care and management content. The M03
  // diagnosis, TCM disease/syndrome, pathogenesis and therapy are signed inputs to that stage and
  // must remain byte-for-byte stable. Restoring from the trusted case state also prevents a reused
  // stage-local evidence id from rebinding an M03 citation to a different M04 retrieval record.
  for (const key of ["overview", "westernDiagnosis", "pathogenesis", "therapy"] as const) {
    payload[key] = structuredClone(prior[key]);
  }
}

function sanitizeSentinelJsonBlocks(content: string, scope: EvidenceScope, medicineCaseText = "", medicineCaseState?: CaseState): string {
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
          resolveGovernedGuidelineReferences(sanitized as Record<string, unknown>, scope, medicineCaseState);
          const formula = (sanitized as { formula?: unknown }).formula;
          if (formula && typeof formula === "object" && !Array.isArray(formula)) {
            const record = formula as { patentAndWestern?: unknown };
            if (Array.isArray(record.patentAndWestern)) {
              const filteredMedicines = record.patentAndWestern.filter((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return false;
                const medicine = item as {
                  name?: unknown;
                  specification?: unknown;
                  correspondingProblem?: unknown;
                  evidenceId?: unknown;
                  evidenceFingerprint?: unknown;
                  evidence?: unknown;
                };
                const evidence = medicine.evidence;
                if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
                const ref = evidence as { evidenceLevel?: unknown; source?: unknown };
                const name = medicine.name;
                const problem = medicine.correspondingProblem;
                return ["guideline", "instruction", "drug_label", "literature"].includes(String(ref.evidenceLevel || "")) &&
                  typeof ref.source === "string" && ref.source.trim().length > 0 &&
                  typeof name === "string" && typeof problem === "string" &&
                  typeof medicine.evidenceId === "string" && typeof medicine.evidenceFingerprint === "string" &&
                  sourceSupportsMedicine(ref.source, name, scope) &&
                  medicineEvidenceBindingValid(
                    medicine.evidenceId,
                    medicine.evidenceFingerprint,
                    name,
                    problem,
                    typeof medicine.specification === "string" ? medicine.specification : null,
                    scope,
                  ) &&
                  (!medicineCaseText || medicineProblemMatchesCase(problem, medicineCaseText));
              });
              record.patentAndWestern = filteredMedicines;
              (record as { medicineCandidateStatus?: unknown }).medicineCandidateStatus = filteredMedicines.length > 0
                ? { status: "available", reason: "已形成与本例问题匹配并绑定真实说明书条目的候选。" }
                : { status: "no_evidence_match", reason: "未检索到与本例诊断或证候匹配、且可核验到具体说明书条目的西药或中成药候选。" };
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
          restoreSignedM03ClinicalSections(customerSafe as Record<string, unknown>, medicineCaseState);
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
  medicineCaseState?: CaseState,
): (content: string) => string {
  const scope = buildEvidenceScope(evidenceContext);
  let knowledgeTraceRecorded = false;
  const medicineCaseText = medicineCaseState ? [
    medicineCaseState.chiefComplaint,
    ...Object.entries(medicineCaseState.symptoms || {}).map(([key, value]) => `${key}：${String(value ?? "")}`),
    medicineCaseState.reasoningDiagnose?.westernDiagnosis?.primary?.name,
    ...(medicineCaseState.reasoningDiagnose?.westernDiagnosis?.primary?.supportingFacts || []),
    medicineCaseState.reasoningDiagnose?.overview?.primarySyndrome,
    ...(medicineCaseState.reasoningDiagnose?.overview?.primarySyndromeBasis || []),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；") : "";
  return (content: string) => {
    const transformed = priorTransform ? priorTransform(content) : content;
    const finalContent = hideCustomerEvidencePlaceholders(
      sanitizeSentinelJsonBlocks(sanitizeMarkdownEvidenceClaims(transformed, scope), scope, medicineCaseText, medicineCaseState),
    );
    if (!knowledgeTraceRecorded && /"contractSignature"\s*:\s*"hmac-sha256:/.test(finalContent)) {
      const stage = finalContent.match(/"stage"\s*:\s*"(diagnose|prescribe|assess)"/)?.[1];
      if (stage === "diagnose" || stage === "prescribe" || stage === "assess") {
        recordCdssKnowledgeTrace({ stage, evidenceContext, finalContent });
        knowledgeTraceRecorded = true;
      }
    }
    return finalContent;
  };
}

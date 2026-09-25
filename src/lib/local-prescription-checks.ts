// 处方的本地确定性核对（原 rxaudit.ts 在外部审方停用时仍在工作的那一半）。
//
// 灵犀合理用药审方已按 owner 裁定（2026-09-25）永久停用并整体删除：远端客户端、送审载荷、
// 供应商响应归一、配伍查询与审方呈现开关都不再存在。生产上它一直是显式停用档
// （RXAI_AUDIT_ENABLED=false），每一次 M05 都只走下面这些本地判据，所以删除不改变任何对外输出
// ——scripts/test-rxaudit-removal-equivalence.mjs 用删除前捕获的逐字节基线钉住这一点。
//
// 留在这里的都是本地安全/病历质量内容，与谁来审方无关：
//   · 十八反（强提示）与十九畏（提示档）的生成前配伍预检段；
//   · 候选药味缺单次剂量、每日频次/疗程不可核验的提交前问题；
//   · 现用药记录只写了「本次/局部未用药」或明确「不详」时的待核对提示（未提及 ≠ 阴性）；
//   · 已由服务端签名证明的严重风险版本在改方后继续保留的提示。
// 药典剂量上限、特殊人群等其余确定性底线在 diagnosis-safety / diagnosis-stage-contract，不在此处。

import { sanitizeFreeTextForExternalClinicalService } from "./diagnosis-safety";
import { parseReasoningV2, prescribeReasoningFromState } from "./diagnosis-parse";
import type { CaseState } from "./diagnosis-types";
import { prescriptionRegimenFromDecoction } from "./prescription-regimen-contract";
import { affirmedCurrentMedicationText, canonicalMedicationIdentity, clinicalClausePolarity, medicationContinuationOnly, medicationNameFromEventText } from "./clinical-polarity";
import { findTcmHerbPairCautions, findTcmHerbPairIncompatibilities, isKnownTcmHerbName } from "./tcm-knowledge";
import { findLocalPatentMedicineEntry } from "./local-patent-medicine-candidates";

// ── 候选定位 ─────────────────────────────────────────────────────────────────

function candidateFromState(state: CaseState, candidateIndex?: number) {
  const activeReasoning = prescribeReasoningFromState(state) || state.reasoningV2;
  const structured = candidateIndex == null
    ? activeReasoning?.formula?.candidates?.find((item) => item.herbs.length > 0)
    : activeReasoning?.formula?.candidates?.[candidateIndex];
  if (structured) return structured;
  const recovered = parseReasoningV2(state.prescription || "");
  return candidateIndex == null
    ? recovered?.formula?.candidates?.find((item) => item.herbs.length > 0)
    : recovered?.formula?.candidates?.[candidateIndex];
}

/** 未显式选定候选时，取第一张带药味的候选方（结构化优先，其次从处方 Markdown 恢复）。 */
export function resolvePrescriptionCandidateIndex(state: CaseState, candidateIndex?: number): number | undefined {
  if (candidateIndex != null) return candidateFromState(state, candidateIndex) ? candidateIndex : undefined;
  const activeReasoning = prescribeReasoningFromState(state) || state.reasoningV2;
  const structuredIndex = activeReasoning?.formula?.candidates?.findIndex((item) => item.herbs.length > 0) ?? -1;
  if (structuredIndex >= 0) return structuredIndex;
  const recovered = parseReasoningV2(state.prescription || "");
  const recoveredIndex = recovered?.formula?.candidates?.findIndex((item) => item.herbs.length > 0) ?? -1;
  return recoveredIndex >= 0 ? recoveredIndex : undefined;
}

// ── 剂量与服法的提交前核对 ───────────────────────────────────────────────────

/** 只认「数字 + g/克/mg/毫克」的单一剂量，且折算后在 0.001–500 g 之间。 */
function parsedSingleDose(dose: string | null | undefined): number | undefined {
  const text = dose?.trim();
  if (!text) return undefined;
  const normalized = text
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".")
    .replace(/－|—|–|~|～/g, "-");
  const single = normalized.match(/^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i);
  if (!single) return undefined;
  const value = Number(single[1]);
  const grams = /mg|毫克/i.test(single[2]) ? value / 1000 : value;
  return Number.isFinite(value) && grams >= 0.001 && grams <= 500 ? value : undefined;
}

export type PrescriptionSubmissionIssue =
  | "candidate_missing"
  | "regimen_incomplete"
  | "herb_dose_incomplete";

/** 候选方是否具备可核验的完整药味、每味单次剂量与每日频次/疗程。 */
export function prescriptionSubmissionIssue(state: CaseState, candidateIndex?: number): PrescriptionSubmissionIssue | undefined {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate || (candidate.herbs.length === 0 && (state.reasoningPrescribe?.formula?.patentAndWestern || []).length === 0)) {
    return "candidate_missing";
  }
  if (!prescriptionRegimenFromDecoction(candidate.decoction)) return "regimen_incomplete";
  if (candidate.herbs.some((herb) => parsedSingleDose(herb.dose) == null)) return "herb_dose_incomplete";
  return undefined;
}

type HerbDoseRow = { itemNo: number; drugName: string; hasDose: boolean };

/** undefined = 没有任何结构化条目（可回落读 Markdown）；[] = 有结构化候选但饮片行为空。 */
function structuredHerbDoseRows(state: CaseState, candidateIndex?: number): HerbDoseRow[] | undefined {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return undefined;
  const rows = candidate.herbs
    .filter((herb) => herb.name?.trim())
    .slice(0, 50)
    .map((herb, index) => {
      const processing = herb.processing?.trim() || "";
      const baseName = herb.name.trim();
      const drugName = !processing || baseName.includes(processing)
        ? baseName
        : /^[炙炒制生酒醋蜜盐姜煅]$/.test(processing)
          ? `${processing}${baseName}`
          : `${baseName}（${processing}）`;
      return { itemNo: index + 1, drugName, hasDose: parsedSingleDose(herb.dose) != null };
    });
  // 只有中成药/西药、没有饮片的候选同样算「有结构化候选」，不得回落去解析处方 Markdown。
  const hasStructuredMedicine = rows.length < 50 && (state.reasoningPrescribe?.formula?.patentAndWestern || [])
    .some((item) => item?.name?.trim() && (item.type === "中成药" || item.type === "西药"));
  return rows.length > 0 || hasStructuredMedicine ? rows : undefined;
}

function extractSection(text: string, titles: string[]): string {
  if (!text.trim()) return "";
  const escaped = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`^##\\s*(?:${escaped})\\s*$`, "im").exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start).replace(/^\s*\n/, "");
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")));
}

function cleanHerbName(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/^[\d一二三四五六七八九十]+[.、]\s*/, "")
    .trim();
}

function rowLooksLikeHerb(name: string, dose: string): boolean {
  if (!/[一-龥]{2,}/.test(name)) return false;
  if (/(提示强度|风险|依据|医生动作|角色|处方角色|对应病机|配伍意义|安全提示|序号|药名|剂量)/.test(name)) return false;
  if (!dose.trim()) return true;
  return /(\d+(?:\.\d+)?\s*(?:g|克|mg|毫克)|先煎|后下|包煎|烊化|冲服|待医生确认|剂量待定)/i.test(dose);
}

/** 没有结构化候选时（旧病历），从处方 Markdown 的饮片表里读出药名与剂量，只用于提示缺剂量。 */
function markdownHerbDoseRows(prescriptionText: string): HerbDoseRow[] {
  const herbalSection = extractSection(prescriptionText, ["中药饮片处方", "候选治疗方案", "候选方药方案", "推荐处方", "方药建议", "治疗方案"]);
  if (!herbalSection) return [];
  const lines = herbalSection.split(/\r?\n/);
  const rows: HerbDoseRow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) continue;
    const header = splitMarkdownRow(line);
    if (!header.some((cell) => /药名/.test(cell)) || !header.some((cell) => /剂量/.test(cell))) continue;
    const nameIndex = header.findIndex((cell) => /药名/.test(cell));
    const doseIndex = header.findIndex((cell) => /剂量/.test(cell));
    const maxRows = Math.min(lines.length, index + 80);
    for (let rowIndex = index + 1; rowIndex < maxRows; rowIndex += 1) {
      const rowLine = lines[rowIndex];
      if (!rowLine.trim().startsWith("|")) {
        if (rows.length > 0) break;
        continue;
      }
      const cells = splitMarkdownRow(rowLine);
      if (isSeparatorRow(cells)) continue;
      const name = cleanHerbName(cells[nameIndex] || "");
      const doseText = (cells[doseIndex] || "").trim();
      if (!rowLooksLikeHerb(name, doseText)) continue;
      rows.push({ itemNo: rows.length + 1, drugName: name, hasDose: parsedSingleDose(doseText) != null });
      if (rows.length >= 50) return rows;
    }
    if (rows.length > 0) break;
  }

  return rows;
}

// ── 现用药记录的范围核对 ─────────────────────────────────────────────────────
//
// 只判两件事，都是「未提及 ≠ 阴性」的病历质量提示，不做任何药物身份或相互作用结论：
//   · 现用药明确写了不详/未核实；
//   · 只记录了本次或局部未用药（发病后未服药、未自行用药……），又没有可证明的具体现用药，
//     不能据此排除长期或其他现用药。

const MAX_MEDICATION_SCOPE_CHARS = 4000;

// 修饰组不收「规律」：「无规律用药/未规律服药」是依从性记录（吃了但乱吃），不是无用药——
// 把它吞成确定性阴性会漏报联用风险。「未提及」同理永不短路（未提及 ≠ 否认）。
// 尾部收「史/记录/情况」是为了把「否认用药史」整句剥干净——此前剥完剩个「史」字，
// 被 medicationCandidatesFromSource 当成药名候选。
const EXPLICIT_NO_CURRENT_MEDICATION = /(?:截至目前|本次|当前|目前|现阶段|迄今|至今)?(?:否认|无|没有|从未|未曾|并未|尚未|未)(?:当前|目前|现阶段|本次)?(?:使用|服用|口服|应用|在用|吃药|服|用|吃)?(?:任何|其他|其它|长期|常用|现用|当前|特殊)?(?:药物|用药|药品|药)(?:治疗|史|记录|情况)?/gu;

// 「发病后未服药」只否定本次自行治疗，不能排除长期处方药；「目前用药不详」
// 则是明确 unknown。二者都不得借同段的局部否定短路成全局无现用药。
const LOCAL_MEDICATION_ABSENCE_SCOPE = /(?:(?:本次|此次)?(?:发病|起病|症状出现|出现症状|不适出现)(?:后|以来|至今)|(?:本次|此次)?(?:就诊|入院|住院|来诊)(?:前|后|以来)|(?:近|最近)(?:约|大约|大概)?(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百半两]+)(?:小时|天|日|周|月|年)(?:以来|内)?)[^\n，,；;。]{0,12}(?:否认|无|没有|从未|未曾|并未|尚未|未)/u;
const LOCAL_SELF_TREATMENT_NEGATION = /(?:未|无|没有|并未|尚未)(?:自行|擅自)[^\n，,；;。]{0,8}(?:药|用药)|(?:未|无|没有|并未|尚未)(?:予(?:以)?|接受|进行)药物治疗/u;
const CURRENT_MEDICATION_UNKNOWN = /(?:不详|未详|未知|不清楚|不明确|未提供|未提及|未记录|未询问|待核实)/u;
const GLOBAL_NO_CURRENT_MEDICATION = /^(?:(?:当前|目前|现阶段|截至目前|迄今|至今)(?:否认|无|没有|从未|未曾|并未|尚未|未)(?:使用|服用|口服|应用|在用|吃药|服|用|吃)?(?:任何)?(?:现用|当前|在用)?(?:任何)?(?:药物|用药|药品|药)(?:治疗|史|记录|情况)?|(?:否认|无|没有)(?:任何)?(?:当前|目前|现阶段|现用|在用)?(?:任何)?(?:药物|用药|药品)(?:治疗)?(?:史|记录|情况)?|(?:从未|未曾)(?:使用|服用|口服|应用|吃药|服|用|吃)?任何(?:药物|用药|药品|药))(?:[.!！。])?$/u;
const NON_SPECIFIC_MEDICATION_IDENTITY = /^(?:(?:未|无|没有|并未|尚未)(?:自行|擅自)?(?:使用|服用|口服|应用|在用|吃药|予(?:以)?|接受|进行|服|用|吃)?(?:任何|其他|其它|长期|常用|现用|当前|特殊)?(?:药物|用药|药品|药)(?:治疗|史|记录|情况)?|(?:任何|其他|其它|长期|常用|现用|当前|特殊)?(?:药物|用药|药品|药)(?:治疗|史|记录|情况)?|(?:治疗|史|记录|情况)(?:药物|用药|药品|药)?|(?:药物|用药|药品|药)?(?:治疗|史|记录|情况))$/u;
const MEDICATION_GENERIC_CORE = /药/gu;
const MEDICATION_FIELD_METADATA_ONLY = /^(?:(?:当前|目前|现阶段|现用|在用|现有|现|长期|常用|特殊|任何|其他|其它|治疗|处方|服用|服|使用|应用|口服|吃|史|记录|情况|信息|名称|清单|列表|目录|汇总|档案|概况|一览|摘要|方案|明细|详情|数据|资料|项目|条目|内容|状态|备注|说明|描述|字段|栏目|品种|种类|类别|库存|医嘱|表|项))+$/u;
const CONTROLLED_CONCRETE_MEDICATION_NAMES = new Set([
  "阿司匹林",
  "阿莫西林",
  "华法林",
  "布洛芬",
  "二甲双胍",
  "利伐沙班",
  "氯吡格雷",
  "美托洛尔",
  "普萘洛尔",
  "心得安",
  "恩格列净",
  "西地那非",
  "药用炭",
  "药用炭片",
  "复方丹参滴丸",
  "中药复方丹参滴丸",
]);
// 目录正式名与日常类别说法完全同形时，自由文本本身不能证明患者指的是该批准制剂。
const AMBIGUOUS_FREE_TEXT_MEDICATION_NAMES = new Set([
  "感冒药片",
  "感冒胶囊",
  "消炎片",
]);
// 这是「允许旧药退出 current 集合」的授权条件，必须使用正向闭集而不是在自由文本上
// 枚举未生效措辞。纯随访可放行；复查/监测只接受受治理指标。
const MEDICATION_FOLLOWUP_CLAUSE = /^(?:(?:明日|明天|后天|下周(?:一|二|三|四|五|六|日|天)?|下月|未来)\s*)?(?:随访|(?:复查|监测)\s*(?:INR|PT|APTT|凝血功能|凝血指标|肝功能|肾功能|肝肾功能|血压|血糖|血常规|电解质|药物浓度)(?:结果|指标|数值)?)$/iu;
const STOP_VERB_PATTERN = /(?:停用|停服|停药|停掉|停止服用|停止使用|停了|停止)/u;
const STOP_PROHIBITION_BEFORE_PATTERN = /(?:请勿|勿|不要|不能|不可|不应|不宜|避免|暂缓|暂不考虑|不建议|不推荐|没有必要)[^。；;！？!?\n]{0,8}$/u;

function firstField(state: CaseState, key: keyof NonNullable<CaseState["hisRecord"]>["fields"]): string {
  return state.hisRecord?.fields?.[key] ?? "";
}

/** 用药史原文（HIS 栏优先），去标识与控制字符后截到上限；这一预处理决定参与判定的分句。 */
function medicationScopeText(state: CaseState): string | undefined {
  const medicationHistory = firstField(state, "yongyaoshi").trim() || state.medicationHistory?.trim() || undefined;
  if (!medicationHistory) return undefined;
  const explicitNames = [state.patient.name, firstField(state, "patientName")]
    .filter((value): value is string => Boolean(value?.trim()));
  const deidentified = sanitizeFreeTextForExternalClinicalService(medicationHistory, explicitNames)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  return deidentified ? deidentified.slice(0, MAX_MEDICATION_SCOPE_CHARS) : undefined;
}

function normalizedSemanticToken(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 剂型后缀表与受控别名表只在 clinical-polarity 一处（MEDICATION_DOSAGE_FORM_SUFFIXES）；
// 此处只做本模块特有的前置归一（NFKC + 空身份回落原文）。
function normalizedMedicationIdentity(value: string): string {
  const raw = medicationNameFromEventText(value) || value;
  return canonicalMedicationIdentity(raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
}

function hasGlobalNoCurrentMedicationClause(value: string): boolean {
  return value.split(/[，,；;。\n]+/).some((clause) => GLOBAL_NO_CURRENT_MEDICATION.test(clause));
}

/** 只接受服务端能正向证明的具体药物身份：中药材、精确命中的本地中成药条目、受控西药名。 */
function isSpecificMedicationIdentity(value: string): boolean {
  const extractedIdentity = medicationNameFromEventText(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const rawIdentity = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const identity = normalizedMedicationIdentity(value);
  // 同时检查原文和抽取后的身份：字段标签「当前用药记录」会被抽取剥成「记录」。
  const isFieldMetadata = (candidate: string): boolean => {
    if (!candidate || NON_SPECIFIC_MEDICATION_IDENTITY.test(candidate)) return true;
    if (MEDICATION_FIELD_METADATA_ONLY.test(candidate)) return true;
    const withoutGenericCore = candidate.replace(MEDICATION_GENERIC_CORE, "");
    return withoutGenericCore !== candidate &&
      (!withoutGenericCore || MEDICATION_FIELD_METADATA_ONLY.test(withoutGenericCore));
  };
  if (!identity || isFieldMetadata(rawIdentity) || isFieldMetadata(identity)) return false;
  const governedPatent = findLocalPatentMedicineEntry(extractedIdentity);
  const exactGovernedPatent = governedPatent?.name.normalize("NFKC").replace(/\s/g, "") === extractedIdentity
    && !AMBIGUOUS_FREE_TEXT_MEDICATION_NAMES.has(extractedIdentity);
  return isKnownTcmHerbName(extractedIdentity)
    || exactGovernedPatent
    || CONTROLLED_CONCRETE_MEDICATION_NAMES.has(extractedIdentity)
    || CONTROLLED_CONCRETE_MEDICATION_NAMES.has(identity);
}

function containsExplicitNoCurrentMedicationStatement(value: string): boolean {
  EXPLICIT_NO_CURRENT_MEDICATION.lastIndex = 0;
  const matched = EXPLICIT_NO_CURRENT_MEDICATION.test(value.normalize("NFKC").replace(/\s+/g, ""));
  EXPLICIT_NO_CURRENT_MEDICATION.lastIndex = 0;
  return matched;
}

function withoutExplicitNoCurrentMedicationStatement(value: string): string {
  EXPLICIT_NO_CURRENT_MEDICATION.lastIndex = 0;
  const remainder = value.normalize("NFKC").replace(EXPLICIT_NO_CURRENT_MEDICATION, " ");
  EXPLICIT_NO_CURRENT_MEDICATION.lastIndex = 0;
  return remainder.trim();
}

/** 原文中可能是患者本人用药的药名候选（保守抽取，不做药物身份判断）。 */
function medicationCandidatesFromSource(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const normalized = value
    .normalize("NFKC")
    .replace(/\[[^\]]*脱敏[^\]]*\]/g, " ")
    .replace(/\s*(?:以及|和|及|与)\s*/g, "；");
  const candidates = new Map<string, string>();
  for (const raw of normalized.split(/[，,；;、。\n]+/)) {
    const segment = raw
      .replace(/^\s*(?:但|但是|而|其后|随后|后来)\s*/, "")
      .replace(/^\s*(?:已)?(?:改为|换成|更换为)\s*/, "改用")
      .trim();
    if (!segment || medicationContinuationOnly(segment) || MEDICATION_FOLLOWUP_CLAUSE.test(segment.normalize("NFKC").trim())) continue;
    const negatedStop = /(?:未|没有|否认|不曾|并未|尚未)[^，,；;。\n]{0,12}(?:停用|停服|停药|停止)/.test(segment);
    // 「未使用其他药物」只否定剩余集合：先剔除闭集否定短语，再对剩余子句做极性与药名抽取。
    // 「未停用阿司匹林」肯定现用，因此否定停用的子句仍保留。
    const candidateSegment = withoutExplicitNoCurrentMedicationStatement(segment);
    if (!candidateSegment && !negatedStop) continue;
    if (clinicalClausePolarity(candidateSegment || segment) !== "affirmed" && !negatedStop) continue;
    if (/^(?:家属|父亲|母亲|配偶|子女|陪同者|监护人)[^，,；;。\n]*(?:服用|使用|在吃)/.test(candidateSegment || segment)) continue;
    const candidate = medicationNameFromEventText(candidateSegment || segment)
      .replace(/^(?:已)?(?:改为|换成|更换为)\s*/, "")
      .trim();
    const identity = normalizedMedicationIdentity(candidate);
    if (!identity || identity.length > 120) continue;
    if (/^(?:药物|用药|现用药|当前用药|这个药|那个药|该药|此药|其后|不详|无|姓名|患者|mrn|手机号(?:码)?|电话|就诊号|门诊号|住院号|病案号|病历号|病例号|医疗记录号|患者编号)$/.test(identity)) continue;
    candidates.set(identity, candidate);
  }
  return [...candidates.values()];
}

function clauseNegatesMedicationUse(clause: string, drugName: string): boolean {
  const text = clause.normalize("NFKC");
  const drug = escapedPattern(drugName.normalize("NFKC"));
  const beforeDrug = new RegExp(`(?:否认|未|没有|从未|不曾|并未)[^。；;！？!?\\n]{0,18}${drug}`, "iu").exec(text);
  const afterDrug = new RegExp(`${drug}[^。；;！？!?\\n]{0,12}(?:未曾?|没有|从未|不曾|并未)(?:服用|口服|使用|应用|吃|用)`, "iu").exec(text);
  return [beforeDrug, afterDrug].some((match) => Boolean(match && !STOP_VERB_PATTERN.test(match[0])));
}

type MedicationStatusAssertion = { status: "current" | "stopped" | "historical"; index: number };

function collectStatusMatches(
  sourceText: string,
  patterns: readonly RegExp[],
  status: MedicationStatusAssertion["status"],
  assertions: MedicationStatusAssertion[],
  drugName: string,
  skipProtectedStop = false,
): void {
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      if (skipProtectedStop) {
        const stopOffset = match[0].search(STOP_VERB_PATTERN);
        if (stopOffset >= 0) {
          const beforeStop = sourceText.slice(Math.max(0, index + stopOffset - 16), index + stopOffset);
          if (STOP_PROHIBITION_BEFORE_PATTERN.test(beforeStop)) continue;
          // 停用动词与药名之间隔着「改为/换成」时，停的是被替换的旧药，不是本药。
          const matchText = match[0].normalize("NFKC").toLowerCase();
          const drugOffset = matchText.lastIndexOf(drugName.normalize("NFKC").toLowerCase());
          if (drugOffset >= 0) {
            const between = matchText.slice(Math.min(stopOffset, drugOffset), Math.max(stopOffset, drugOffset));
            if (/(?:改为|改用|改成|换成|换用|更换为|替换为)/u.test(between)) continue;
          }
        }
      }
      assertions.push({ status, index });
    }
  }
}

/**
 * 原文是否明确反驳「该药为现用」：所有提到它的分句都是否定用药，或按时间线最后一次
 * 明示的状态是停用/既往。裸药名、长期用药、无动词的 HIS 栏值都没有反驳，默认须按现用对待。
 */
function sourceContradictsCurrentUse(source: string, drugName: string): boolean {
  const input = source.normalize("NFKC").trim();
  if (!input) return false;
  const identity = normalizedSemanticToken(drugName);
  const clauses = source
    .split(/[，,；;。！？!?\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause && normalizedSemanticToken(clause).includes(identity));
  if (clauses.length > 0 && clauses.every((clause) => clauseNegatesMedicationUse(clause, drugName))) return true;
  if (!identity) return false;
  const drug = escapedPattern(drugName.normalize("NFKC"));
  const scope8 = "[^。；;！？!?\\n]{0,8}";
  const scope18 = "[^。；;！？!?\\n]{0,18}";
  const scope40 = "[^。；;！？!?\\n]{0,40}";
  const assertions: MedicationStatusAssertion[] = [];
  collectStatusMatches(input, [
    new RegExp(`(?:目前|当前|现在|现正|正在|正用着|现用|现服)${scope18}${drug}`, "giu"),
    new RegExp(`(?:目前|当前|现在|现)(?:仍|还|一直)?${scope8}(?:服用|口服|使用|应用|吃|用着|注射|吸入)${scope8}${drug}`, "giu"),
    new RegExp(`${drug}${scope18}(?:仍在|还在|继续|照旧|一直)(?:服用|口服|使用|应用|吃|用着)?`, "giu"),
    new RegExp(`${drug}${scope40}(?:至今未停用|一直服用至今|迄今没有停过)`, "giu"),
    new RegExp(`(?:恢复|重新|再次|继续|复服|续服|启用|新启用|用回|改回)(?:口服|服用|使用|吃|用)?${scope8}${drug}`, "giu"),
    new RegExp(`(?:请勿|勿|不要|不能|不可|不应|不宜|避免|暂缓|暂不考虑|不建议|不推荐|没有必要)${scope8}(?:停用|停服|停药|停掉|停止服用|停止使用)${scope8}${drug}`, "giu"),
    new RegExp(`${drug}${scope8}(?:不能|不可|不应|不宜|不要|无需|暂缓)${scope8}(?:停用|停服|停药|停掉|停止服用|停止使用)`, "giu"),
  ], "current", assertions, drugName);
  collectStatusMatches(input, [
    new RegExp(`(?:已|已经|现已|目前已|当前已|今日已|今天已)?(?:明确)?(?:停用|停服|停药|停掉|停止服用|停止使用)${scope8}${drug}`, "giu"),
    new RegExp(`${drug}${scope18}(?:已|已经|现已|目前已|当前已|今日已|今天已)?(?:明确)?(?:停用|停服|停药|停掉|停止服用|停止使用|停了)`, "giu"),
  ], "stopped", assertions, drugName, true);
  collectStatusMatches(input, [
    new RegExp(`(?:既往|此前|之前|曾经|曾|过去|以前|去年|年轻时|儿时|小时候|\\d+年前|[一二两三四五六七八九十]+年前)${scope40}(?:服用|口服|使用|应用|吃过|用过|服过)${scope8}${drug}`, "giu"),
  ], "historical", assertions, drugName);
  const latestAssertion = assertions.sort((left, right) => right.index - left.index)[0];
  return latestAssertion?.status === "stopped" || latestAssertion?.status === "historical";
}

function hasProvenCurrentMedication(sourceText: string | undefined): boolean {
  if (medicationCandidatesFromSource(affirmedCurrentMedicationText(sourceText)).some(isSpecificMedicationIdentity)) return true;
  const source = sourceText?.trim();
  if (!source) return false;
  return medicationCandidatesFromSource(sourceText)
    .some((candidate) => isSpecificMedicationIdentity(candidate) && !sourceContradictsCurrentUse(source, candidate));
}

export type MedicationScopeReason = "medication_current_scope_unknown" | "medication_current_scope_incomplete";

export function localMedicationScopeReason(state: CaseState): MedicationScopeReason | undefined {
  const sourceText = medicationScopeText(state);
  const normalizedSource = sourceText?.normalize("NFKC").replace(/\s+/g, "").trim() || "";
  if (CURRENT_MEDICATION_UNKNOWN.test(normalizedSource)) return "medication_current_scope_unknown";
  const hasGlobalAbsence = hasGlobalNoCurrentMedicationClause(normalizedSource);
  const hasScopedAbsence = LOCAL_MEDICATION_ABSENCE_SCOPE.test(normalizedSource) ||
    LOCAL_SELF_TREATMENT_NEGATION.test(normalizedSource) ||
    (containsExplicitNoCurrentMedicationStatement(normalizedSource) && !hasGlobalAbsence);
  return hasScopedAbsence && !hasProvenCurrentMedication(sourceText) ? "medication_current_scope_incomplete" : undefined;
}

// ── 处方信息待核对 ───────────────────────────────────────────────────────────

export type PrescriptionInputAdvisory = {
  code: "missing_dose" | "medication_semantics_incomplete";
  itemNo: number;
  drugName: string;
  message: string;
};

/**
 * 病历质量提示：候选饮片缺单次剂量、现用药范围不能确定。二者对处方决策都成立，与是否审方无关；
 * 撤掉它们等于把「现用药不明」当成无风险。code 取值是对外 JSON（audit.inputAdvisories）的一部分。
 */
export function buildPrescriptionInputAdvisories(state: CaseState, candidateIndex?: number): PrescriptionInputAdvisory[] {
  const rows = structuredHerbDoseRows(state, candidateIndex)
    ?? (candidateIndex == null
      ? markdownHerbDoseRows(state.prescription || "")
      : []);
  const advisories: PrescriptionInputAdvisory[] = rows.flatMap((row) => !row.hasDose && row.drugName
    ? [{ code: "missing_dose" as const, itemNo: row.itemNo, drugName: row.drugName, message: `${row.drugName}未标注单次剂量` }]
    : []);
  const scopeReason = localMedicationScopeReason(state);
  if (scopeReason) {
    const problem = scopeReason === "medication_current_scope_unknown"
      ? "现用药信息明确不详或尚未核实"
      : "已记录本次或局部未用药，但不能据此排除长期或其他现用药";
    advisories.push({
      code: "medication_semantics_incomplete",
      itemNo: 0,
      drugName: "现用药",
      message: `${problem}，联用风险必须结合原文人工核对`,
    });
  }
  return advisories;
}

export function buildPrescriptionInputAdvisorySection(advisories: readonly PrescriptionInputAdvisory[]): string {
  if (advisories.length === 0) return "";
  return [
    "## 处方信息待核对",
    ...advisories.map((item) => `- ${item.message}。请结合原始病历人工核对；在核实前不得视为已排除相关用药风险。`),
  ].join("\n");
}

// ── 配伍预检（十八反 / 十九畏）───────────────────────────────────────────────

/**
 * 十八反走强提示，十九畏走提示档（强度低于十八反，且不进 diagnosis-stage-contract 的驳回码路径，
 * 那条路只读 findTcmHerbPairIncompatibilities）。配伍禁忌属本地安全内容，任何档位都照出。
 */
export function buildLocalHighRiskHerbPairSection(state: CaseState, candidateIndex?: number): string {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return "";
  const herbNames = candidate.herbs.map((herb) => herb.name);
  const tiered = [
    ...findTcmHerbPairIncompatibilities(herbNames).map((conflict) => ({ conflict, high: true })),
    ...findTcmHerbPairCautions(herbNames).map((conflict) => ({ conflict, high: false })),
  ];
  if (tiered.length === 0) return "";
  const inline = (value: string): string => value
    .normalize("NFKC")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_{}\[\]()#+.!|<>-])/g, "\\$1");
  return [
    "## 生成前配伍预检提示",
    ...tiered.map(({ conflict, high }) => {
      const description = high
        ? `命中${conflict.category || "高风险配伍"}，请医生或药师重点复核。`
        : `命中${conflict.category || "配伍相畏"}（强度低于十八反），请医生或药师确认是否确需同用。`;
      return `- **${inline(`${conflict.leftDrug}—${conflict.rightDrug}`)}**：${inline(description)}依据：${inline(conflict.basis || "本地结构化配伍规则")}。本提示不阻断诊疗流程。`;
    }),
  ].join("\n");
}

// ── 已证明的严重风险版本 ─────────────────────────────────────────────────────

/** Routes pass only a revision already verified for the current patient, tenant and exact hash. */
export function buildRetainedPrescriptionRiskSection(revision: CaseState["prescriptionRevision"]): string {
  return revision && (revision.auditResult === "BLOCK" || revision.highestRiskLevel === "CRITICAL")
    ? "## 处方风险提示\n**强提示**：当前精确处方版本已有经确认的严重风险，仍需保留该风险提示；本次没有新的外部复核结果。"
    : "";
}

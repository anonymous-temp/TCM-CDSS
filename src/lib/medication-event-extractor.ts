import { z } from "zod";
import { createTextModelClient, getPrimaryTextModelConfig } from "./text-model";

const MedicationEventSchema = z.object({
  drugName: z.string().min(1).max(120),
  status: z.enum(["current", "stopped", "historical", "uncertain"]),
  doseText: z.string().max(160).nullable().optional(),
  frequency: z.string().max(160).nullable().optional(),
  administrationTiming: z.string().max(160).nullable().optional(),
  sourceQuotes: z.array(z.string().min(1).max(500)).min(1).max(4),
  confidence: z.number().min(0).max(1),
});

const MedicationExtractionSchema = z.object({
  events: z.array(MedicationEventSchema).max(30),
  unresolvedReferences: z.array(z.string().min(1).max(300)).max(10).default([]),
});

export type MedicationSemanticEvent = z.infer<typeof MedicationEventSchema>;

export type MedicationSemanticExtraction = {
  source: "model" | "not_needed" | "unavailable";
  events: MedicationSemanticEvent[];
  unresolvedReferences: string[];
  needsManualReview: boolean;
  reason?: string;
};

function normalizedEvidenceText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/[，,。；;：:]/g, "");
}

function normalizedSemanticToken(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ExplicitMedicationStatus = "current" | "stopped" | "historical";

type MedicationStatusAssertion = {
  status: ExplicitMedicationStatus;
  index: number;
};

const FAMILY_SUBJECT_PATTERN = /(?:家属|父亲|母亲|丈夫|妻子|配偶|儿子|女儿|哥哥|姐姐|弟弟|妹妹|陪同者|监护人)/gu;
const PATIENT_SUBJECT_PATTERN = /(?:患者本人|患者|本人|本例)/gu;
const STOP_VERB_PATTERN = /(?:停用|停服|停药|停掉|停止服用|停止使用|停了|停止)/u;
const STOP_PROHIBITION_BEFORE_PATTERN = /(?:请勿|勿|不要|不能|不可|不应|不宜|避免|暂缓|暂不考虑|不建议|不推荐|没有必要)[^。；;！？!?\n]{0,8}$/u;
const ADMINISTRATION_TIMING_PATTERN = /(?:(?:饭|餐)(?:前|后)(?:(?:约|大约)?(?:半(?:个)?小时|一刻钟|\d+(?:\.\d+)?\s*(?:分钟|小时)))?\s*(?:服用|口服|使用|用药|吃药)|(?:随餐|空腹|睡前|晨起|早晨|早上|晚上|夜间)\s*(?:服用|口服|使用|用药|吃药))/gu;
// 这是“允许旧药退出 current 集合”的授权条件，必须使用正向闭集而不是在自由文本上
// 枚举未生效措辞。纯随访可放行；复查/监测只接受受治理指标，任何额外动作或未知尾部
// （例如“复查后开始服用”）都默认拒绝并交人工核对。
const MEDICATION_FOLLOWUP_CLAUSE = /^(?:(?:明日|明天|后天|下周(?:一|二|三|四|五|六|日|天)?|下月|未来)\s*)?(?:随访|(?:复查|监测)\s*(?:INR|PT|APTT|凝血功能|凝血指标|肝功能|肾功能|肝肾功能|血压|血糖|血常规|电解质|药物浓度)(?:结果|指标|数值)?)$/iu;

export function isMedicationFollowupClause(value: string): boolean {
  return MEDICATION_FOLLOWUP_CLAUSE.test(value.normalize("NFKC").trim());
}

function normalizedAdministrationTiming(value: string): string {
  return normalizedSemanticToken(value).replace(/(?:服用|口服|使用|用药|吃药)$/u, "");
}

/**
 * Preserve explicit administration timing even when the semantic model extracts the drug and dose
 * but drops a trailing clause such as “饭后半小时服用”. Association is deterministic: a timing
 * phrase belongs only to the nearest named drug in the same sentence, so a multi-drug list cannot
 * leak one drug's timing onto another.
 */
export function recoverGroundedAdministrationTimings(
  sourceText: string,
  events: MedicationSemanticEvent[],
): MedicationSemanticEvent[] {
  const input = sourceText.normalize("NFKC");
  if (!input.trim() || events.length === 0) return events;

  const occurrences = events.flatMap((event, eventIndex) => {
    const drugName = event.drugName.normalize("NFKC");
    const found: Array<{ eventIndex: number; index: number; end: number }> = [];
    let fromIndex = 0;
    while (fromIndex < input.length) {
      const index = input.toLowerCase().indexOf(drugName.toLowerCase(), fromIndex);
      if (index < 0) break;
      found.push({ eventIndex, index, end: index + drugName.length });
      fromIndex = index + Math.max(1, drugName.length);
    }
    return found;
  });
  if (occurrences.length === 0) return events;

  const recovered = new Map<number, string[]>();
  for (const match of input.matchAll(ADMINISTRATION_TIMING_PATTERN)) {
    const timing = match[0].trim();
    const timingIndex = match.index ?? -1;
    if (timingIndex < 0 || !timing) continue;
    const immediatePrefix = input.slice(Math.max(0, timingIndex - 10), timingIndex);
    if (/(?:不是|并非|未|勿|无需|避免|否认)\s*$/u.test(immediatePrefix)) continue;

    const clauseStart = Math.max(
      input.lastIndexOf("。", timingIndex - 1),
      input.lastIndexOf("；", timingIndex - 1),
      input.lastIndexOf(";", timingIndex - 1),
      input.lastIndexOf("！", timingIndex - 1),
      input.lastIndexOf("？", timingIndex - 1),
      input.lastIndexOf("\n", timingIndex - 1),
    ) + 1;
    const clauseEndCandidates = ["。", "；", ";", "！", "？", "\n"]
      .map((delimiter) => input.indexOf(delimiter, timingIndex + timing.length))
      .filter((index) => index >= 0);
    const clauseEnd = clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : input.length;
    const preceding = occurrences
      .filter((item) => item.end <= timingIndex && item.index >= clauseStart && timingIndex - item.end <= 96)
      .sort((left, right) => right.index - left.index)[0];
    const following = occurrences
      .filter((item) => item.index >= timingIndex + timing.length && item.end <= clauseEnd && item.index - (timingIndex + timing.length) <= 48)
      .sort((left, right) => left.index - right.index)[0];
    const owner = preceding || following;
    if (!owner) continue;
    const list = recovered.get(owner.eventIndex) || [];
    const timingKey = normalizedAdministrationTiming(timing);
    if (timingKey && !list.some((item) => normalizedAdministrationTiming(item) === timingKey)) list.push(timing);
    recovered.set(owner.eventIndex, list);
  }

  return events.map((event, eventIndex) => {
    const timings = recovered.get(eventIndex) || [];
    if (timings.length === 0) return event;
    const existingValues = [event.doseText, event.frequency, event.administrationTiming]
      .filter((value): value is string => Boolean(value?.trim()));
    const additions = timings.filter((timing) => {
      const timingKey = normalizedAdministrationTiming(timing);
      return timingKey && !existingValues.some((value) => normalizedAdministrationTiming(value) === timingKey);
    });
    if (additions.length === 0) return event;
    return {
      ...event,
      administrationTiming: [event.administrationTiming, ...additions]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("、")
        .slice(0, 160),
    };
  });
}

function lastPatternIndex(value: string, pattern: RegExp, beforeIndex: number): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) {
    if ((match.index ?? -1) < beforeIndex) index = match.index ?? index;
  }
  return index;
}

function namedEvidenceClauses(event: MedicationSemanticEvent): string[] {
  const identity = normalizedSemanticToken(event.drugName);
  return event.sourceQuotes
    .flatMap((quote) => quote.split(/[，,；;。！？!?\n]+/u))
    .map((clause) => clause.trim())
    .filter((clause) => clause && normalizedSemanticToken(clause).includes(identity));
}

function hasPatientSubjectConflict(event: MedicationSemanticEvent): boolean {
  const subjectJudgements = namedEvidenceClauses(event).map((clause) => {
    const drugIndex = clause.normalize("NFKC").toLowerCase().indexOf(event.drugName.normalize("NFKC").toLowerCase());
    if (drugIndex < 0) return "neutral";
    const patientIndex = lastPatternIndex(clause, PATIENT_SUBJECT_PATTERN, drugIndex);
    const familyIndex = lastPatternIndex(clause, FAMILY_SUBJECT_PATTERN, drugIndex);
    if (familyIndex > patientIndex) return "family";
    if (patientIndex >= 0) return "patient";
    return "neutral";
  });
  return subjectJudgements.length > 0 && subjectJudgements.every((judgement) => judgement === "family");
}

function clauseNegatesMedicationUse(clause: string, drugName: string): boolean {
  const text = clause.normalize("NFKC");
  const drug = escapedPattern(drugName.normalize("NFKC"));
  const beforeDrug = new RegExp(`(?:否认|未|没有|从未|不曾|并未)[^。；;！？!?\\n]{0,18}${drug}`, "iu").exec(text);
  const afterDrug = new RegExp(`${drug}[^。；;！？!?\\n]{0,12}(?:未曾?|没有|从未|不曾|并未)(?:服用|口服|使用|应用|吃|用)`, "iu").exec(text);
  return [beforeDrug, afterDrug].some((match) => Boolean(match && !STOP_VERB_PATTERN.test(match[0])));
}

function collectStatusMatches(
  sourceText: string,
  patterns: readonly RegExp[],
  status: ExplicitMedicationStatus,
  assertions: MedicationStatusAssertion[],
  skipProtectedStop = false,
  eventTarget?: { drugName: string; otherDrugNames: string[] },
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
        }
        if (eventTarget && stopOffset >= 0) {
          const matchText = match[0].normalize("NFKC").toLowerCase();
          const drugName = eventTarget.drugName.normalize("NFKC").toLowerCase();
          const drugOffset = matchText.lastIndexOf(drugName);
          if (drugOffset >= 0) {
            const between = matchText.slice(Math.min(stopOffset, drugOffset), Math.max(stopOffset, drugOffset));
            const crossesReplacement = /(?:改为|改用|改成|换成|换用|更换为|替换为)/u.test(between);
            const crossesOtherDrug = eventTarget.otherDrugNames.some((name) => {
              const normalizedName = name.normalize("NFKC").toLowerCase();
              if (between.includes(normalizedName)) return true;
              if (stopOffset >= drugOffset) return false;
              const beforeStop = sourceText
                .slice(Math.max(0, index + stopOffset - 36), index + stopOffset)
                .split(/[，,；;。！？!?\n]+/u)
                .at(-1)
                ?.normalize("NFKC")
                .toLowerCase() || "";
              return beforeStop.includes(normalizedName);
            });
            if (crossesReplacement || crossesOtherDrug) continue;
          }
        }
      }
      if (eventTarget && status === "current") {
        const matchText = match[0].normalize("NFKC").toLowerCase();
        const drugName = eventTarget.drugName.normalize("NFKC").toLowerCase();
        if (matchText.startsWith(drugName)) {
          const afterDrug = matchText.slice(drugName.length);
          const crossesOtherDrug = eventTarget.otherDrugNames.some((name) =>
            afterDrug.includes(name.normalize("NFKC").toLowerCase()));
          if (crossesOtherDrug) continue;
        }
      }
      assertions.push({ status, index });
    }
  }
}

/**
 * Return only high-certainty source/event contradictions. The model remains responsible for semantic
 * extraction; this guard enforces evidence fidelity and explicit event-state invariants.
 */
export function medicationSemanticConsistencyReasons(
  sourceText: string | undefined,
  events: MedicationSemanticEvent[],
): string[] {
  const input = sourceText?.normalize("NFKC").trim();
  if (!input || events.length === 0) return [];
  const normalizedInput = normalizedEvidenceText(input);
  const reasons = new Set<string>();
  const replacedEvents = new Set<MedicationSemanticEvent>();
  for (const previousEvent of events) {
    for (const nextEvent of events) {
      if (previousEvent === nextEvent) continue;
      const previousIdentity = normalizedSemanticToken(previousEvent.drugName);
      const nextIdentity = normalizedSemanticToken(nextEvent.drugName);
      if (!previousIdentity || !nextIdentity || previousIdentity === nextIdentity) continue;
      if (!hasMedicationReplacementClaim(
        input,
        previousEvent.drugName,
        nextEvent.drugName,
        events.filter((candidate) => candidate !== previousEvent && candidate !== nextEvent)
          .map((candidate) => candidate.drugName),
      )) continue;
      if (!hasGroundedMedicationReplacement(
        input,
        previousEvent.drugName,
        nextEvent.drugName,
        events.filter((candidate) => candidate !== previousEvent && candidate !== nextEvent)
          .map((candidate) => candidate.drugName),
      )) {
        // Provider 将一条计划中、未执行或生效状态不明的“改用”关系解释成
        // old=stopped/new=current 时，不能因为两端药名均已抽取就视为覆盖完成。
        reasons.add("medication_replacement_timeline_conflict");
        continue;
      }
      replacedEvents.add(previousEvent);
      if (previousEvent.status !== "stopped" || nextEvent.status !== "current") {
        reasons.add("medication_replacement_timeline_conflict");
      }
    }
  }

  for (const event of events) {
    const identity = normalizedSemanticToken(event.drugName);
    const normalizedQuotes = event.sourceQuotes.map(normalizedEvidenceText).filter(Boolean);
    const quoteTokens = event.sourceQuotes.map(normalizedSemanticToken).filter(Boolean);
    const quotesGrounded = normalizedQuotes.length > 0
      && normalizedQuotes.every((quote) => normalizedInput.includes(quote));
    const identityGrounded = Boolean(identity) && quoteTokens.some((quote) => quote.includes(identity));
    if (!quotesGrounded || !identityGrounded) reasons.add("medication_event_identity_conflict");

    const evidenceTokens = normalizedSemanticToken(event.sourceQuotes.join(" "));
    const dataGrounded = [event.doseText, event.frequency]
      .filter((value): value is string => Boolean(value?.trim()))
      .every((value) => evidenceTokens.includes(normalizedSemanticToken(value)))
      && (!event.administrationTiming
        || normalizedSemanticToken(input).includes(normalizedSemanticToken(event.administrationTiming)));
    if (!dataGrounded) reasons.add("medication_event_data_not_grounded");

    if (hasPatientSubjectConflict(event)) reasons.add("medication_patient_subject_conflict");

    const clauses = namedEvidenceClauses(event);
    if (clauses.length > 0 && clauses.every((clause) => clauseNegatesMedicationUse(clause, event.drugName))) {
      reasons.add("medication_polarity_conflict");
    }

    if (!identity) continue;
    const drug = escapedPattern(event.drugName.normalize("NFKC"));
    const scope8 = "[^。；;！？!?\\n]{0,8}";
    const scope18 = "[^。；;！？!?\\n]{0,18}";
    const scope40 = "[^。；;！？!?\\n]{0,40}";
    const assertions: MedicationStatusAssertion[] = [];
    const eventTarget = {
      drugName: event.drugName,
      otherDrugNames: events
        .filter((candidate) => normalizedSemanticToken(candidate.drugName) !== identity)
        .map((candidate) => candidate.drugName),
    };
    collectStatusMatches(input, [
      new RegExp(`(?:目前|当前|现在|现正|正在|正用着|现用|现服)${scope18}${drug}`, "giu"),
      new RegExp(`(?:目前|当前|现在|现)(?:仍|还|一直)?${scope8}(?:服用|口服|使用|应用|吃|用着|注射|吸入)${scope8}${drug}`, "giu"),
      new RegExp(`${drug}${scope18}(?:仍在|还在|继续|照旧|一直)(?:服用|口服|使用|应用|吃|用着)?`, "giu"),
      new RegExp(`${drug}${scope40}(?:至今未停用|一直服用至今|迄今没有停过)`, "giu"),
      new RegExp(`(?:恢复|重新|再次|继续|复服|续服|启用|新启用|用回|改回)(?:口服|服用|使用|吃|用)?${scope8}${drug}`, "giu"),
      new RegExp(`(?:请勿|勿|不要|不能|不可|不应|不宜|避免|暂缓|暂不考虑|不建议|不推荐|没有必要)${scope8}(?:停用|停服|停药|停掉|停止服用|停止使用)${scope8}${drug}`, "giu"),
      new RegExp(`${drug}${scope8}(?:不能|不可|不应|不宜|不要|无需|暂缓)${scope8}(?:停用|停服|停药|停掉|停止服用|停止使用)`, "giu"),
    ], "current", assertions, false, eventTarget);
    collectStatusMatches(input, [
      new RegExp(`(?:已|已经|现已|目前已|当前已|今日已|今天已)?(?:明确)?(?:停用|停服|停药|停掉|停止服用|停止使用)${scope8}${drug}`, "giu"),
      new RegExp(`${drug}${scope18}(?:已|已经|现已|目前已|当前已|今日已|今天已)?(?:明确)?(?:停用|停服|停药|停掉|停止服用|停止使用|停了)`, "giu"),
    ], "stopped", assertions, true, eventTarget);
    collectStatusMatches(input, [
      new RegExp(`(?:既往|此前|之前|曾经|曾|过去|以前|去年|年轻时|儿时|小时候|\\d+年前|[一二两三四五六七八九十]+年前)${scope40}(?:服用|口服|使用|应用|吃过|用过|服过)${scope8}${drug}`, "giu"),
    ], "historical", assertions);
    const latestAssertion = assertions.sort((left, right) => right.index - left.index)[0];
    const incompatible = latestAssertion?.status === "current"
      ? event.status === "stopped" || event.status === "historical"
      : latestAssertion?.status === "stopped" || latestAssertion?.status === "historical"
        ? event.status === "current"
        : false;
    const supersededCurrent = latestAssertion?.status === "current"
      && event.status === "stopped"
      && replacedEvents.has(event);
    if (incompatible && !supersededCurrent) reasons.add("medication_temporal_status_conflict");
  }

  return [...reasons];
}

type MedicationReplacementClaim = {
  input: string;
  relation: RegExpExecArray;
  connectorOffset: number;
  connectorIndex: number;
};

function medicationReplacementClaim(
  sourceText: string | undefined,
  previousDrugName: string,
  nextDrugName: string,
  otherDrugNames: readonly string[] = [],
): MedicationReplacementClaim | null {
  const input = sourceText?.normalize("NFKC").trim();
  if (!input || !previousDrugName.trim() || !nextDrugName.trim()) return null;
  const previousIdentity = normalizedSemanticToken(previousDrugName);
  const nextIdentity = normalizedSemanticToken(nextDrugName);
  if (!previousIdentity || !nextIdentity || previousIdentity === nextIdentity) return null;
  const replacementConnector = "(?:改为|改用|改成|换成|换用|更换为|替换为)";
  const relation = new RegExp(
    `${escapedPattern(previousDrugName.normalize("NFKC"))}[^。；;！？!?\\n]{0,60}${replacementConnector}[^。；;！？!?\\n]{0,24}${escapedPattern(nextDrugName.normalize("NFKC"))}`,
    "giu",
  ).exec(input);
  if (!relation) return null;
  const connectorOffset = relation[0].search(new RegExp(replacementConnector, "u"));
  const connectorIndex = (relation.index ?? 0) + Math.max(0, connectorOffset);
  const beforeReplacement = relation[0].slice(previousDrugName.length, Math.max(0, connectorOffset));
  if (otherDrugNames.some((name) => beforeReplacement.normalize("NFKC").toLowerCase()
    .includes(name.normalize("NFKC").toLowerCase()))) return null;
  return { input, relation, connectorOffset, connectorIndex };
}

function hasMedicationReplacementClaim(
  sourceText: string | undefined,
  previousDrugName: string,
  nextDrugName: string,
  otherDrugNames: readonly string[] = [],
): boolean {
  return medicationReplacementClaim(sourceText, previousDrugName, nextDrugName, otherDrugNames) !== null;
}

/** Single deterministic predicate for an explicit old-drug -> new-drug replacement relation. */
export function hasGroundedMedicationReplacement(
  sourceText: string | undefined,
  previousDrugName: string,
  nextDrugName: string,
  otherDrugNames: readonly string[] = [],
): boolean {
  const claim = medicationReplacementClaim(sourceText, previousDrugName, nextDrugName, otherDrugNames);
  if (!claim) return false;
  const { input, relation, connectorOffset, connectorIndex } = claim;
  const beforeReplacement = relation[0].slice(previousDrugName.length, Math.max(0, connectorOffset));
  const beforeConnector = input.slice(Math.max(0, connectorIndex - 18), connectorIndex);
  if (/(?:未|不|勿|不要|不能|不可|不应|计划|拟|考虑|建议|若|如需)[^。；;！？!?\n]{0,10}$/u.test(beforeConnector)) {
    return false;
  }
  // 默认拒绝：自由文本出现「改用」并不能证明状态已切换。只接受与替换动词直接绑定的
  // 完成体，或同一关系中旧药已明确停用；其余（包括无时态的普通「改用」）交人工。
  const completedReplacement = /(?:^|[，,\s])(?:(?:今日|今天|目前|当前|现|随后|后来|其后)(?:已经|已)|(?:已经|已))\s*$/u.test(beforeConnector)
    || /(?:^|[，,])(?:后|随后|后来|其后)\s*$/u.test(beforeConnector)
    || /^(?:已经|已)$/u.test(beforeReplacement.trim())
    || /(?:已经|已|现已|目前已|当前已)[^。；;！？!?\n]{0,10}(?:停用|停服|停药|停止服用|停止使用)[，,]\s*$/u.test(beforeConnector);
  if (!completedReplacement) return false;
  const relationEnd = (relation.index ?? 0) + relation[0].length;
  const hardEnds = ["。", "；", ";", "！", "!", "？", "?", "\n"]
    .map((mark) => ({ mark, offset: input.indexOf(mark, relationEnd) }))
    .filter((item) => item.offset >= 0)
    .sort((left, right) => left.offset - right.offset);
  // 疑问句只表达待确认，不能作为“旧药已停、新药已启”的正向授权证据。
  // 检查连续终止标点整段，避免「！？」「。？」用前一个字符掩掉问号。
  const terminatorRun = hardEnds[0]
    ? input.slice(hardEnds[0].offset).match(/^[\p{P}\p{Z}\s]+/u)?.[0] || ""
    : "";
  if (/[？?]/u.test(terminatorRun)) return false;
  const clauseEnd = hardEnds[0]?.offset ?? input.length;
  const trailing = input.slice(relationEnd, clauseEnd).normalize("NFKC").trim();
  // 完成关系必须覆盖整条事件。新药后的自由文本不再靠“未生效词表”逐个否决；仅允许
  // 可结构化的剂量/频次/给药方式，或明确的复查/随访/监测说明，其他尾部一律拒绝。
  const regimen = /^(?:(?:\s|[()（）、]|[\d.\/\\~～-]|[零〇一二两三四五六七八九十百千万半点]+|mg|mcg|ug|μg|kg|ml|iu|u|g|毫克|微克|克|公斤|毫升|升|国际单位|单位|片|粒|丸|袋|支|喷|揿|滴|每日|每天|每晚|每次|一日|早晚|晨起|睡前|饭前|饭后|餐前|餐后|随餐|空腹|必要时|按需|每周|每月|每隔|小时|天|日|周|月|次|口服|服用|使用|注射|静滴|肌注|皮下|吸入|qd|bid|tid|q\d+h))+$/iu;
  const pieces = trailing.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  const currentClauseSafe = pieces.length === 0
    ? true
    : pieces.length === 1
    ? regimen.test(pieces[0]) || isMedicationFollowupClause(pieces[0])
    : regimen.test(pieces[0]) && pieces.slice(1).every((item) => isMedicationFollowupClause(item));
  if (!currentClauseSafe) return false;

  // 正向授权必须覆盖同一 owner 字段的剩余分句，不能只读到首个句号就停止。
  // 后续仅允许受治理随访。第三方药名的字符串出现不能证明整句都属于该药；要自动
  // 接受多药后续事件，未来必须传入结构化 source-quote/status 绑定，当前一律交人工。
  const remainingText = hardEnds[0]
    ? input.slice(hardEnds[0].offset + terminatorRun.length).trim()
    : "";
  if (!remainingText) return true;
  return remainingText
    .split(/[。；;！!？?\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .every((clause) => isMedicationFollowupClause(clause));
}

function evidenceBackedEvents(input: string, events: MedicationSemanticEvent[]): MedicationSemanticEvent[] {
  const normalizedInput = normalizedEvidenceText(input);
  return events.filter((event) => {
    const quotes = event.sourceQuotes.map(normalizedEvidenceText).filter(Boolean);
    const drugName = normalizedEvidenceText(event.drugName);
    return quotes.length > 0 && quotes.every((quote) => normalizedInput.includes(quote)) && quotes.some((quote) => quote.includes(drugName));
  });
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function extractMedicationEventsWithModel(
  medicationHistory: string | undefined,
  requestSignal?: AbortSignal,
): Promise<MedicationSemanticExtraction> {
  const input = medicationHistory?.trim();
  if (!input) {
    return { source: "not_needed", events: [], unresolvedReferences: [], needsManualReview: false };
  }

  const config = getPrimaryTextModelConfig();
  if (!config.configured) {
    return {
      source: "unavailable",
      events: [],
      unresolvedReferences: [],
      needsManualReview: true,
      reason: config.disabledReason || "model_not_configured",
    };
  }

  const client = createTextModelClient(config);
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort();
  if (requestSignal?.aborted) controller.abort();
  else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const systemPrompt = [
      "你是临床用药事件语义抽取器。只输出一个 JSON 对象，不解释。",
      "按患者本人、时间轴和最新事件判断每个药物是 current、stopped、historical 或 uncertain。",
      "必须理解替换、恢复、停药禁令、指代、家属主体、既往用药和口语表达，不得靠单个关键词截断句义。",
      "请勿停药/不能停药/暂缓停药表示仍在用；已停/换掉表示停用；换成新药时旧药 stopped、新药 current。",
      "家属使用的药物不是患者用药。无法可靠消解的‘这个药/两者之一’写入 unresolvedReferences，不猜药名。",
      "先逐个核对原文中患者本人的所有药名；多药列表中的每个药都必须有独立事件，不能只抽第一项。",
      "sourceQuotes 必须逐字复制输入中的1至4个最小证据片段，不得规范化或改写原文；至少一个片段包含 drugName。",
      "遇到‘前一种/后一种/这个药’等指代时，sourceQuotes 同时列出包含药名的先行片段和包含最新状态的指代片段。",
      "二分之一片、1又1/2片、每7天一次等剂量频次必须原样保留，不得并入药名或遗漏。",
      "doseText、frequency 和 administrationTiming 只提取原文明确内容；未提及填 null。餐前/餐后及具体间隔、随餐、空腹、睡前、晨起等服药时机必须原样写入 administrationTiming，不得因为没有频次而遗漏。",
      "输出结构：{\"events\":[{\"drugName\":\"\",\"status\":\"current\",\"doseText\":null,\"frequency\":null,\"administrationTiming\":null,\"sourceQuotes\":[\"原文片段\"],\"confidence\":0.0}],\"unresolvedReferences\":[]}",
    ].join("\n");
    let lastResult: MedicationSemanticExtraction | null = null;
    let repairReason = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const completion = await client.chat.completions.create({
          model: config.model,
          temperature: 0,
          max_tokens: 1600,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: attempt === 0
                ? input.slice(0, 4000)
                : [
                    `原始用药史：${input.slice(0, 4000)}`,
                    `上一轮结果未通过服务端契约：${repairReason}`,
                    "请重新阅读整段原文，重新输出完整 JSON。不得解释，也不要沿用被拒的错误引文。",
                  ].join("\n"),
            },
          ],
        }, { signal: controller.signal });
        const content = completion.choices[0]?.message?.content || "";
        const parsed = MedicationExtractionSchema.safeParse(parseJsonObject(content));
        if (!parsed.success) {
          repairReason = "JSON 结构无效或字段缺失";
          continue;
        }
        const events = recoverGroundedAdministrationTimings(
          input,
          evidenceBackedEvents(input, parsed.data.events),
        );
        const droppedEventCount = parsed.data.events.length - events.length;
        const unresolvedReferences = parsed.data.unresolvedReferences;
        const consistencyReasons = medicationSemanticConsistencyReasons(input, events);
        const needsManualReview = droppedEventCount > 0
          || unresolvedReferences.length > 0
          || events.some((event) => event.status === "uncertain" || event.confidence < 0.7)
          || consistencyReasons.length > 0;
        const reasons = [
          droppedEventCount > 0 ? "event_evidence_not_grounded" : "",
          ...consistencyReasons,
        ].filter(Boolean);
        lastResult = {
          source: "model",
          events,
          unresolvedReferences,
          needsManualReview,
          ...(reasons.length > 0 ? { reason: [...new Set(reasons)].join(",") } : {}),
        };
        if (!needsManualReview) return lastResult;
        repairReason = [
          droppedEventCount > 0 ? `${droppedEventCount} 个事件的 sourceQuotes 未逐字锚定原文或未包含药名` : "",
          unresolvedReferences.length > 0 ? `仍有 ${unresolvedReferences.length} 个未消解指代` : "",
          events.some((event) => event.status === "uncertain" || event.confidence < 0.7) ? "存在低置信或 uncertain 事件" : "",
          consistencyReasons.length > 0 ? `存在事件一致性冲突：${consistencyReasons.join(",")}` : "",
        ].filter(Boolean).join("；");
      } catch (error) {
        if (requestSignal?.aborted || controller.signal.aborted) throw error;
        repairReason = error instanceof Error ? `模型请求失败：${error.name}` : "模型请求失败";
      }
    }
    return lastResult || {
      source: "unavailable",
      events: [],
      unresolvedReferences: [],
      needsManualReview: true,
      reason: "model_request_or_contract_failed_after_retry",
    };
  } catch (error) {
    return {
      source: "unavailable",
      events: [],
      unresolvedReferences: [],
      needsManualReview: true,
      reason: error instanceof Error && error.name === "AbortError" ? "model_timeout" : "model_request_failed",
    };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

export function currentMedicationsFromSemanticExtraction(
  extraction: MedicationSemanticExtraction,
): Array<{ drug_name: string; dose_daily?: string }> {
  const seen = new Set<string>();
  return extraction.events.flatMap((event) => {
    if (event.status !== "current" || event.confidence < 0.7) return [];
    const key = event.drugName.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return [];
    seen.add(key);
    const doseDaily = [event.doseText, event.frequency, event.administrationTiming]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("，");
    return [{ drug_name: event.drugName.trim(), ...(doseDaily ? { dose_daily: doseDaily } : {}) }];
  });
}

export function currentMedicationSummaryFromSemanticExtraction(extraction: MedicationSemanticExtraction): string {
  return extraction.events
    .filter((event) => event.status === "current" && event.confidence >= 0.7)
    .flatMap((event) => event.sourceQuotes.map((quote) => quote.trim()))
    .filter(Boolean)
    .filter((quote, index, all) => all.indexOf(quote) === index)
    .join("；");
}

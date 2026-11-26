import processingFormsSource from "../data/tcm-herb-processing-forms.source.json";
import selectionSource from "../data/herb-function-selection.source.json";
import { assessPregnancyState, recordExcludesPregnancyPotential } from "./clinical-state";
import textbookJson from "../data/tcm-herb-textbook-references.json";
import verifiedJson from "../data/tcm-herb-verified-functions.json";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { verifiedHerbFunctionEntry } from "./tcm-knowledge";
import { withoutPreparationPrefix } from "./formula-original-composition";
import { formulaAnalysisUseOfHerb } from "./formula-analysis-review";
import { contentDigest } from "./m04-content-fingerprint";
import { asRecord, asRecords, asText, type SourceSpan } from "./m04-final-content-types";

type HerbText = { function?: string; line?: number; property?: string; propertyLine?: number; parent?: string };
const TEXTBOOK = textbookJson as unknown as { source: { sha256: string }; herbs: Record<string, HerbText> };
type Verified = { kind?: string; canonicalName?: string; functions?: string[]; evidence?: { source: string; text: string; line?: number | null }[] };
const VERIFIED = verifiedJson.herbs as Record<string, Verified>;

/** Exact form first. A preparation prefix is never permission to inherit a parent's effects. */
export function preciseHerbSourceName(name: string): string | undefined {
  if (TEXTBOOK.herbs[name] || VERIFIED[name]) return name;
  const resolved = resolveGovernedTcmHerbIdentity(name);
  const canonical = resolved.canonicalName;
  if (!canonical || resolved.status === "ambiguous") return undefined;
  const protectedForm = withoutPreparationPrefix(name) !== name || Boolean(resolved.preparation) || Boolean(resolved.medicinalPart && name !== canonical);
  const verified = Object.keys(VERIFIED).find((key) => resolveGovernedTcmHerbIdentity(key).canonicalName === canonical &&
    (!protectedForm || VERIFIED[key].kind === "processed_form" && VERIFIED[key].canonicalName === canonical));
  if (verified) return verified;
  if (protectedForm) return undefined;
  return TEXTBOOK.herbs[canonical] ? canonical : undefined;
}

export function functionClauses(text: string): string[] {
  return text.split(/[，,；;。]/u).map((clause) => clause.trim()).filter(Boolean);
}

/** Route labels delimit source domains, not merely individual comma clauses. */
function oralFunctionParts(raw: string): string[] {
  const labels = [...raw.matchAll(/外用|内服/gu)];
  if (!labels.length) return [raw];
  const parts = labels[0].index! > 0 ? [raw.slice(0, labels[0].index)] : [];
  labels.forEach((label, index) => {
    if (label[0] === "内服") parts.push(raw.slice(label.index! + label[0].length, labels[index + 1]?.index ?? raw.length).replace(/^[:：]/u, ""));
  });
  return parts;
}

export function herbFunctionSourceClauses(name: string): readonly SourceSpan[] {
  // A preparation with its own recorded function domain never borrows the raw drug's effects.
  type FunctionDomain = { form: string; quote: string; source: string; functionClauses?: string[] };
  const processing = processingFormsSource as { rules: FunctionDomain[]; functionDomains?: FunctionDomain[] };
  const processed = [...processing.rules, ...(processing.functionDomains || [])].find((row) => row.form === name && row.functionClauses?.length);
  if (processed) return (processed.functionClauses || []).filter((text) => processed.quote.includes(text)).map((text) => ({
    id: `function:${contentDigest([name, processed.source, text])}`, kind: "verified" as const, herbKey: name, text,
    sourceRef: processed.source, sourceDigest: contentDigest(processed), start: processed.quote.indexOf(text), end: processed.quote.indexOf(text) + text.length,
  }));
  const key = preciseHerbSourceName(name);
  // The unqualified name does not settle the生/制 use domain.
  const shouwu = /^(生|制)何首乌$/u.exec(name);
  if (name === "何首乌") return [];
  const entry = TEXTBOOK.herbs[shouwu ? "何首乌" : key || ""];
  const unsupported = verifiedHerbFunctionEntry(name)?.unsupported || [];
  const spans: SourceSpan[] = [];
  const add = (raw: string, kind: SourceSpan["kind"], ref: string, digest: string, line?: number, originalText = raw) => {
    // Unknown labeled form domains are withheld as a whole. Only the explicit
    // 生/制何首乌 adapter above supplies a proven single domain.
    if (/[:：]/u.test(raw)) return;
    const clauses = oralFunctionParts(raw).flatMap((part) => part.includes("用于") ? [part.trim().replace(/。$/u, "")] : functionClauses(part));
    for (const text of clauses) {
      if (/[:：]/u.test(text) || unsupported.some((term) => text.includes(term))) continue;
      if (spans.some((span) => span.text === text)) continue;
      const start = originalText.indexOf(text);
      spans.push({ id: `function:${contentDigest([name,ref,text])}`, kind, herbKey: name, text,
        sourceRef: ref, sourceDigest: digest, lineStart: line, lineEnd: line, start, end: start + text.length });
    }
  };
  const verified = VERIFIED[key || ""];
  for (const evidence of verified?.evidence || []) {
    for (const text of verified?.functions || []) {
      // A dictionary label is selectable only when its own cited original actually contains it.
      if (oralFunctionParts(evidence.text).some((part) => part.includes(text))) add(text, "verified", `${evidence.source}:${key}:${evidence.line ?? ""}`, contentDigest(evidence), evidence.line ?? undefined, evidence.text);
    }
  }
  // A base monograph may explicitly name a preparation. That exact sentence can
  // support it; an unlabeled base-drug function cannot (煅牡蛎 vs 生牡蛎).
  const base = withoutPreparationPrefix(name);
  if (!key && base !== name) for (const evidence of VERIFIED[base]?.evidence || []) {
    if (!evidence.text.startsWith(name)) continue;
    const ownText = evidence.text.slice(name.length);
    for (const text of VERIFIED[base]?.functions || []) if (oralFunctionParts(ownText).some((part) => part.includes(text))) {
      add(text, "verified", `${evidence.source}:${name}:${evidence.line ?? ""}`, contentDigest(evidence), evidence.line ?? undefined, evidence.text);
    }
  }
  let raw = entry?.function || "";
  if (shouwu) raw = raw.match(new RegExp(`${shouwu[0]}：([^。]+)`, "u"))?.[1] || "";
  if (entry && (shouwu || key && TEXTBOOK.herbs[key])) {
    add(raw, "textbook_function", `《中药学》${shouwu ? "何首乌" : key}【功效】:${entry.line}`, TEXTBOOK.source.sha256, entry.line, entry.function);
    const toxicity = entry.property?.match(/有(?:大|小)?毒/u)?.[0];
    if (toxicity) add(toxicity, "textbook_function", `《中药学》${key}【药性】:${entry.propertyLine}`, TEXTBOOK.source.sha256, entry.propertyLine);
  }
  // 炮制品没有自己的功效原文时（炒酸枣仁、酒白芍、炒香附、大蓟炭…，第四十七轮实测功效栏被留空），用《中药学》原药条目的功效原文；
  // 毒性药、何首乌这类生制功效分域的药不借（见上）。来源仍逐字可查，标出取自原药。
  // 只借「炮制前缀＋原药名」（炒/酒/盐/蜜/醋/焦/土炒…）或「原药名＋炭」；药用部位（当归尾、当归身）功效本就不同，不借。
  const charredBase = name.endsWith("炭") ? name.slice(0, -1) : "";
  const parentName = base !== name && name.endsWith(base) ? base : charredBase && TEXTBOOK.herbs[charredBase] ? charredBase : "";
  if (!spans.length && !shouwu && parentName && TEXTBOOK.herbs[parentName]?.function && !TEXTBOOK.herbs[parentName].property?.match(/有(?:大|小)?毒/u)) {
    const parent = TEXTBOOK.herbs[parentName];
    add(parent.function!, "textbook_function", `《中药学》${parentName}【功效】（原药条目）:${parent.line}`, TEXTBOOK.source.sha256, parent.line, parent.function);
  }
  // Broad KB category/TCMSP amalgams and role descriptions are intentionally not verbatim evidence.
  return spans;
}

export type HerbFunctionPatient = { sex?: string; ageYears?: number; recordText?: string };

function applicableFunction(text: string, patient: HerbFunctionPatient): boolean {
  const record = patient.recordText || "";
  // Exact labels supplied by clinicalGroundingText; no age/sex inference from narrative or relatives.
  const sex = patient.sex || /^患者性别：([男女])$/mu.exec(record)?.[1];
  const ageLabel = /^患者年龄：(\d+(?:\.\d+)?)岁$/mu.exec(record)?.[1];
  const age = patient.ageYears ?? (ageLabel ? Number(ageLabel) : undefined);
  const excluded = (!sex && age === undefined && !record) || sex === "男" || (age !== undefined && age < 12) || recordExcludesPregnancyPotential(record, age);
  const reproductiveText = selectionSource.reproductiveExclusions.reduce((value, phrase) => value.split(phrase).join(""), text);
  if (excluded && selectionSource.reproductiveTerms.some((term) => reproductiveText.includes(term))) return false;
  return !selectionSource.pregnancyTerms.some((term) => text.includes(term)) || (!excluded && assessPregnancyState(record).status === "positive");
}

/** Retrieval only: original whole clauses are the sole output. Local targets outrank the overall therapy. */
function functionRelevance(clause: string, context: string): number {
  const groups = selectionSource.concepts.filter((terms) => terms.some((term) => clause.includes(term)) && terms.some((term) => context.includes(term)));
  const literal = functionClauses(context).some((part) => part.includes(clause));
  return groups.length + (literal ? 2 : 0);
}

/**
 * 方义里对这味药的说明与一条功效原文的贴合度（第六十轮，r1077 样张：沙参麦冬汤里桑叶的功效栏是「疏散风热」、方义写的是「清肺润燥」；
 * 疏风清热汤里防风是「胜湿止痛」、四妙丸里牛膝是「逐瘀通经」）。只用来在同一味药的几条原文小句之间选，不生成功效：
 * 小句按两个字一段切开，看有几段在说明里站得住——原字出现，或与说明里的说法落在同一概念组（「祛风」对「疏风」、「引血下行」对「引药下行」；
 * 概念组与仅用于方义的同义组见 herb-function-selection.source.json）。站得住的段数占一半以上才算贴合；
 * 贴合度并列的几条再按病机靶点与总治法分先后（四妙丸里薏苡仁「利湿健脾、舒筋缓急」：「利水渗湿」「健脾止泻」各有一段站得住，治法清热利湿，取前者）。
 */
const ANALYSIS_USE_MINIMUM = 0.5;
const ANALYSIS_CONCEPTS: readonly string[][] = [...selectionSource.concepts, ...((selectionSource as { analysisConcepts?: string[][] }).analysisConcepts || [])];
function analysisUseRelevance(clause: string, use: string): number {
  if (!use || !clause) return 0;
  const groupsInUse = ANALYSIS_CONCEPTS.filter((terms) => terms.some((term) => use.includes(term)));
  // 整条小句本身就是某个概念组里的说法（「引血下行」）：说明里有同组说法即整条站得住。
  if (use.includes(clause) || groupsInUse.some((terms) => terms.includes(clause))) return 1;
  const pieces = clause.length <= 3 ? [clause] : [...new Set([...Array.from({ length: Math.floor(clause.length / 2) }, (_, index) => clause.slice(index * 2, index * 2 + 2)), clause.slice(-2)])];
  const supported = pieces.filter((piece) => use.includes(piece) || groupsInUse.some((terms) => terms.some((term) => term === piece || (term.length >= 3 && term.includes(piece)) || piece.includes(term))));
  return supported.length / pieces.length;
}

/** 选出的两条原文小句有两个连续的字相同时是同一层意思（「健脾益气」「补气健脾」；「散风清热」「疏散风热」），只留前一条。 */
function withoutOverlappingClause(sources: readonly SourceSpan[]): SourceSpan[] {
  const kept: SourceSpan[] = [];
  for (const source of sources) {
    const pairs = Array.from({ length: Math.max(0, source.text.length - 1) }, (_, index) => source.text.slice(index, index + 2));
    if (kept.some((item) => pairs.some((pair) => item.text.includes(pair)))) continue;
    kept.push(source);
  }
  return kept;
}

export function selectGroundedHerbFunction(input: {
  name: string; role: string; target: string; therapy: string;
  modelText?: string; preferredSourceIds?: readonly string[]; patient?: HerbFunctionPatient;
  /** 方义里以这味药为主语的说明（formulaAnalysisUseOfHerb）；有时优先于病机靶点与总治法。 */
  analysisUse?: string;
}): { text: string; sources: readonly SourceSpan[]; status: "grounded" | "missing"; relevant: boolean } {
  const available = herbFunctionSourceClauses(input.name);
  // 无独立功效原文仍标记缺口；只筛选既有模型小句，不借原药来源，不保留人群不适用句。
  if (!available.length) {
    const clauses = functionClauses(input.modelText || "").filter((text) => applicableFunction(text, input.patient || {}));
    const scored = clauses.map((text) => ({ text, score: functionRelevance(text, `${input.target}；${input.role}`) * 4 + functionRelevance(text, input.therapy) }));
    const max = Math.max(0, ...scored.map((item) => item.score));
    const selected = max > 0 ? scored.filter((item) => item.score === max).slice(0, 1).map((item) => item.text) : clauses.slice(0, 1);
    const existingToxicity = clauses.filter((text) => /^有(?:大|小)?毒$/u.test(text));
    return { text: [...new Set([...selected, ...existingToxicity])].join("，"), sources: [], status: "missing", relevant: max > 0 };
  }
  const applicable = available.filter((source) => applicableFunction(source.text, input.patient || {}));
  const eligible = applicable.filter((source) => !/^有(?:大|小)?毒$/u.test(source.text));
  const byContext = eligible.map((source) => ({ source, score: functionRelevance(source.text, `${input.target}；${input.role}`) * 4 + functionRelevance(source.text, input.therapy) }));
  // 方义讲到了这味药、且有原文小句与它贴合时，先按贴合度取最贴合的几条，其间再按病机靶点与总治法排；否则全部按后者。
  const byAnalysis = byContext.map((item) => ({ ...item, fit: analysisUseRelevance(item.source.text, input.analysisUse || "") }));
  const bestFit = Math.max(0, ...byAnalysis.map((item) => item.fit));
  const ranked = bestFit >= ANALYSIS_USE_MINIMUM
    ? byAnalysis.filter((item) => item.fit === bestFit).map((item) => ({ source: item.source, score: item.score + 1 }))
    : byContext;
  const max = Math.max(0, ...ranked.map((item) => item.score));
  // A model's verbatim list cannot override this case's use or population. No relevant clause: first applicable clause only.
  // 并列的几条里，方义原字写到的排前面（「补脾益气」对「补脾益肺」，先于同组近义的「健脾益肺」）；随后意思重叠的只留一条。
  const literalPieces = (text: string) => !input.analysisUse ? 0 : Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2))
    .filter((pair) => input.analysisUse!.includes(pair)).length;
  const top = ranked.filter((item) => item.score === max).map((item) => item.source);
  const ordered = bestFit >= ANALYSIS_USE_MINIMUM ? [...top].sort((left, right) => literalPieces(right.text) - literalPieces(left.text)) : top;
  const chosen = max > 0 ? withoutOverlappingClause(ordered.slice(0, 2)) : eligible.slice(0, 1);
  const toxicity = available.filter((source) => /^有(?:大|小)?毒$/u.test(source.text));
  const sources = [...new Map([...chosen, ...toxicity].map((source) => [source.id, source])).values()];
  return { text: sources.map((source) => source.text).join("，"), sources, status: "grounded", relevant: max > 0 };
}

/** 功效栏是「原文前三条」兜底显示（模型句无一对上原文）时为 true：交付层不拿它当本方用途去改炮制（四妙丸里薏苡仁→炒薏苡仁）。 */
export function isSourceFallbackFunctionDisplay(name: string, functionText: string): boolean {
  const text = String(functionText || "").trim();
  if (!text) return false;
  const available = herbFunctionSourceClauses(name);
  const fallback = available.slice(0, 3).map((source) => source.text);
  const withToxicity = [...new Set([...fallback, ...available.filter((source) => /^有(?:大|小)?毒$/u.test(source.text)).map((source) => source.text)])];
  return fallback.length > 0 && (text === fallback.join("，") || text === withToxicity.join("，"));
}

/** Explicit pure projection, independent of global switches. Does not change admission knowledge. */
export function projectGroundedHerbFunctions<T>(reasoning: T, patient: HerbFunctionPatient = {}): T {
  const projected = structuredClone(reasoning);
  const root = asRecord(projected), formula = asRecord(root.formula);
  for (const candidate of asRecords(formula.candidates)) for (const herb of asRecords(candidate.herbs)) {
    herb.function = selectGroundedHerbFunction({ name: asText(herb.name), role: asText(herb.role),
      target: [asText(herb.targetPathogenesis), asText(herb.prescriptionRole), ...asRecords(asRecord(root.pathogenesis).chain).filter((node) => node.nodeId === herb.targetRef).map((node) => [asText(node.pathogenesis), asText(node.therapyDirection)].join("；"))].join("；"),
      therapy: [asText(asRecord(root.therapy).overallMethod), asText(asRecord(root.overview).primarySyndrome)].join("；"), modelText: asText(herb.function), patient,
      analysisUse: formulaAnalysisUseOfHerb(asText(candidate.formulaAnalysis), asText(herb.name)) }).text;
  }
  return projected;
}

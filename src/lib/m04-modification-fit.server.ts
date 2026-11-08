import "server-only";

import { parseConfirmed, proposeTwiceThenVerifyAll } from "./cross-model-small-task.server";
import { herbClaimReferenceText } from "./m04-formula-analysis-claim-check.server";
import { distinctModificationConditions, topUpModificationRow, withoutOrphanPartnerRows } from "./m04-proposal-compiler";
import { quoteGroundedInText } from "./verbatim-quote";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import modificationRelevance from "../data/tcm-modification-relevance.source.json" with { type: "json" };

const MECHANISM_HALVES = new Set((modificationRelevance as { mechanismHalvesNotFindings?: string[] }).mechanismHalvesNotFindings || []);

/**
 * 随证加减每一行与本例对不对得上（2026-10-31 起；第三十三轮扩到教材条目和条件与病历的关系）。
 * 条件与病历相反，规则判不完：舌脉那几个维度之外，便溏对大便干结、口不渴对口渴、痰白对痰黄、多食对食少都要读懂，22 组相反条件字面规则只抓到 6 组；
 * 药对不对症按功效字面比对错删居多（离线 563 张处方）。一个模型逐行列两次判断取并集（教材本证条目只判条件，模型自写的和借别的病的行连药一起判），每条由另一厂商的模型只对被点名的那一行答对错，说对才删。条件相反的一定删；药不对症的只在删后还剩至少两行时删，免得加减一栏被删空。
 * 超时、失败按原样交付。开关：CDSS_M04_MODIFICATION_FIT=false。
 */
const TIMEOUT_MS = 4_000;
const MIN_ROWS_AFTER_FIT = 2;
const MIN_DISTINCT_CONDITIONS = 2;
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

export function modificationFitEnabled(): boolean {
  return process.env.CDSS_M04_MODIFICATION_FIT !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const SYSTEM = [
  "你是中医主治医师，逐行核对随证加减。每行是「若某情况，加某药」，「若」说的是本例现在没有、之后可能出现的变化。",
  "每行写 verdict：",
  "contradicts：这个条件与病历已记录的情况相反，本例在现在的证候下不会这样（病历便溏对“若大便干结”、舌淡脉弱对“若舌红脉数”、口不渴对“若口渴”、多食易饥对“若食少”）。病历没提到的症状不算相反；quote 摘病历逐字原文。",
  "misfit：只在 kind 为 model 的行判。这味药的主要功效管不到这个症，或与本证方向相反（虚寒证单加苦寒药、阴虚证单加温燥药），或这个条件不是本病会出现的变化。不因为有更好的选择就判 misfit。",
  "unrelated：两种 kind 都判。条件说的情况与本例已记录的表现都无关——不是本例已有某个症状的加重或演变，也不是主诉主症的变化，而是另一组本例一条相关表现都没有的情况（如胃痛病例「若兼头晕目眩」而病历没有头晕；咳嗽病例「若兼有瘀血」而病历没有任何瘀象）。条件里的症状本例已有（程度不同也算）、或是本例主症常见的加重，不算 unrelated。quote 留空。",
  "ok：其余。",
  "只输出 JSON：{\"rows\":[{\"line\":0,\"verdict\":\"ok\",\"quote\":\"\"}]}",
].join("\n");

const VERIFY_SYSTEM = [
  "你是中医主治医师。有人认为下面这条随证加减不该留给本例，理由在 verdict 里（contradicts：条件与病历已记录的情况相反；misfit：这味药管不到这个症或与本证方向相反；unrelated：条件说的情况与本例已记录的表现都无关，既不是已有症状的加重或演变，也不是主诉主症的变化）。",
  "只判这一条。理由成立答 true。条件只是病历没提到、或者只是另有更好的药，答 false。",
  "先在 why 里写这条理由依据的病历原文或药的功效（不超过20字），再下结论。",
  "只输出 JSON：{\"why\":\"…\",\"confirmed\":true} 或 {\"why\":\"…\",\"confirmed\":false}",
].join("\n");

type Finding = { line: number; verdict: "contradicts" | "misfit" | "unrelated"; quote: string };

function parse(content: unknown): Finding[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.rows;
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((entry) => {
      const row = record(entry);
      const verdict = text(row?.verdict);
      return row && Number.isInteger(row.line) && (verdict === "contradicts" || verdict === "misfit" || verdict === "unrelated")
        ? [{ line: row.line as number, verdict: verdict as Finding["verdict"], quote: text(row.quote) }]
        : [];
    });
  } catch {
    return undefined;
  }
}

/** 教材本证条目只判条件；模型自写的和借别的病的行连药一起判。 */
const isModelWritten = (row: Json, disease = "") => {
  const evidence = record(row.evidence);
  if (evidence?.evidenceLevel !== "kb_entry") return true;
  const source = /》([^·]+)·/u.exec(text(evidence.source))?.[1] || "";
  return Boolean(disease && source && !source.includes(disease) && !disease.includes(source));
};

/** 提名是否合格（纯函数）：行号在表内；说条件相反的要有病历逐字摘录；misfit 只看模型自写的「加」行。 */
export function modificationFindingQualifies(finding: Finding, rows: readonly Json[], recordText: string, disease = ""): boolean {
  const row = rows[finding.line];
  if (!row || row.action !== "加") return false;
  if (finding.verdict === "misfit") return isModelWritten(row, disease);
  // 与本例记录无关的条件（第三十七轮甲方 11.05 病历13「随症加减与患者病情无关…偶尔也能遇到根据疾病本身推荐」、病历10「香附、艾叶与患者病症不符」）：
  // 教材条目也判。条件里有本例已记录的症状时不算（「若恶寒甚」之于恶寒）。
  if (finding.verdict === "unrelated") return !conditionMentionsRecordedFinding(text(row.trigger), recordText);
  return Boolean(finding.quote) && quoteGroundedInText(finding.quote, recordText, { minChars: 2 });
}

/**
 * 条件里是否点到了病历已记录的表现（两字以上的症状词，按逗号顿号切开、去掉「若/兼/见/较甚/明显/者」这类外壳后逐字在病历里）。
 * 点到了就不判「无关」：「无关」只给条件里一条本例表现都没有的行。纯函数，供测试。
 */
export function conditionMentionsRecordedFinding(trigger: string, recordText: string): boolean {
  const parts = String(trigger || "").replace(/^(?:本例已见|若|如|兼见|兼有|兼|伴)/u, "").split(/[，,、；;或及与和]/u)
    .map((part) => part.replace(/^(?:兼见|兼有|兼|伴有|伴|见|出现|症见|若)/u, "").replace(/(?:较甚|较重|甚者|甚|明显|加重|较多|多|重|者)$/u, "").trim())
    .filter((part) => part.length >= 2);
  // 四字以上的条件也看头两字、末两字（「鼻塞流涕」之于「鼻塞、流清涕」）；病机词（内蕴、凝滞、郁热这类）不算症状。
  return parts.some((part) => recordText.includes(part) || (part.length >= 4 && [part.slice(0, 2), part.slice(-2)].some((half) => !MECHANISM_HALVES.has(half) && recordText.includes(half))));
}

/** 交付前去掉复核确认不该留的行。 */
export async function dropMisfitModifications(content: string, context: { recordText: string }, signal?: AbortSignal): Promise<string> {
  if (!modificationFitEnabled()) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const overview = record(root?.overview);
  const rows = Array.isArray(formula?.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  if (!root || !formula || rows.length === 0) return content;
  const syndrome = text(overview?.primarySyndrome);
  const method = text(record(root.therapy)?.overallMethod);
  const disease = text(overview?.tcmDiseaseName);
  const payload = (row: Json, line: number) => ({ line, kind: isModelWritten(row, disease) ? "model" : "textbook", condition: text(row.trigger), herb: text(row.herbName), reference: herbClaimReferenceText(text(row.herbName)).slice(0, 160) });
  const findings = await proposeTwiceThenVerifyAll<Finding>("m04_modification_fit", "prescribe", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, record: context.recordText.slice(0, 2_400), rows: rows.map((row, line) => payload(row, line)) }) },
    ],
    maxTokens: 400,
    parse,
  }, (finding) => `${finding.line}:${finding.verdict}`, (finding) => modificationFindingQualifies(finding, rows, context.recordText, disease) ? {
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, record: context.recordText.slice(0, 2_400), row: payload(rows[finding.line], finding.line), verdict: finding.verdict, quote: finding.quote }) },
    ],
    maxTokens: 90,
    parse: parseConfirmed,
  } : undefined, rows.length, TIMEOUT_MS, signal, {
    // 「药管不到这个症」比「条件与病历相反」更看读法：两次提名都这么说才去问复核（第三十五轮：病历有大便干，「大便秘结→玄参」因一次提名被删）。
    needsBothSamples: (finding) => finding.verdict === "misfit" || finding.verdict === "unrelated",
  });
  if (findings.length === 0) return content;
  const contradicted = new Set(findings.filter((finding) => finding.verdict === "contradicts" || finding.verdict === "unrelated").map((finding) => finding.line));
  const bad = new Set(contradicted);
  for (const finding of findings) {
    if (finding.verdict === "misfit" && rows.length - bad.size > MIN_ROWS_AFTER_FIT) bad.add(finding.line);
  }
  const candidateHerbs = Array.isArray(record(Array.isArray(formula.candidates) ? formula.candidates[0] : undefined)?.herbs)
    ? (record((formula.candidates as unknown[])[0])?.herbs as unknown[]).map((herb) => text(record(herb)?.name)).filter(Boolean)
    : [];
  formula.modifications = withoutOrphanPartnerRows(rows.filter((_, index) => !bad.has(index)), candidateHerbs);
  console.info("[tcm-cdss:telemetry] m04_modification_fit", { dropped: bad.size, checked: rows.length, verdicts: findings.map((finding) => finding.verdict) });
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
}

/** 把 source 里核对后的加减行放进 target（两份来自同一份内容、各改一处）。解析不了时返回 target。 */
export function withModificationsFrom(target: string, source: string): string {
  if (target === source) return target;
  const read = (content: string) => {
    const start = content.indexOf(START_MARKER);
    const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
    if (start < 0 || end < 0) return undefined;
    try { return { start, end, root: record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())) }; } catch { return undefined; }
  };
  const to = read(target);
  const from = read(source);
  const toFormula = record(to?.root?.formula);
  const fromFormula = record(from?.root?.formula);
  if (!to || !toFormula || !fromFormula || !Array.isArray(fromFormula.modifications)) return target;
  toFormula.modifications = fromFormula.modifications;
  return `${target.slice(0, to.start + START_MARKER.length)}\n${JSON.stringify(to.root, null, 2)}\n${target.slice(to.end)}`;
}

const TOP_UP_SYSTEM = [
  "你是中医主治医师。证型、治法、方药已定，现在写备用的随证加减。",
  "写 3 条不同的条件，每条一味药：trigger 写「若+具体症状」，是本例已记录的某个症状加重、或主诉主症常见的进一步变化（不写与本例记录无关的另一组证候，不写舌脉，不写「气虚」「阴虚」这类证候名）；herbName 是不在 herbs 里的一味常用饮片；dose 写克数（如 10g），在药典常用量内；reason 说这味药怎样管这个症。",
  "药的寒热补泻要与证型一致。不要写病历已经否认的症状，也不要写 existing 里已有的条件。",
  "只输出 JSON：{\"rows\":[{\"trigger\":\"\",\"herbName\":\"\",\"dose\":\"\",\"reason\":\"\"}]}",
].join("\n");

const TOP_UP_VERIFY_SYSTEM = [
  "你是中医主治医师。下面这条随证加减要留给本例备用。默认答 true，只有这味药管不到这个症、或与本证方向相反、或这个条件与病历相反时答 false。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

type TopUpRow = { trigger: string; herbName: string; dose: string; reason: string };

function parseTopUp(content: unknown): TopUpRow[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const list = record(JSON.parse(content))?.rows;
    if (!Array.isArray(list)) return undefined;
    return list.flatMap((entry) => {
      const row = record(entry);
      const trigger = text(row?.trigger);
      const herbName = text(row?.herbName);
      return trigger && herbName ? [{ trigger, herbName, dose: text(row?.dose), reason: text(row?.reason) }] : [];
    }).slice(0, 6);
  } catch {
    return undefined;
  }
}

/**
 * 不同的条件不足两个时补写（第三十四轮）。甲方 10.29 测评「仅生成 1 个不足以满足临床」；教材没有这一证（中性证名、自拟方）、模型又没写时，编译阶段没东西可补：
 * 接口 142 份里 12 份不足两个条件，3 份一条都没有。其余病例不发请求。一个模型写，另一厂商的模型复核，每行再过编译阶段同一套判据（topUpModificationRow）。
 */
export async function topUpModificationConditions(
  content: string,
  context: { recordText: string; prior: ClinicalReasoningResultV2 | null | undefined; caseState?: CaseState },
  signal?: AbortSignal,
): Promise<string> {
  if (!modificationFitEnabled() || !context.prior) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content.slice(start + START_MARKER.length, end).trim())); } catch { return content; }
  const formula = record(root?.formula);
  const candidate = record(Array.isArray(formula?.candidates) ? formula.candidates[0] : undefined);
  if (!root || !formula || !candidate || !Array.isArray(candidate.herbs)) return content;
  const rows = Array.isArray(formula.modifications) ? formula.modifications.map(record).filter((row): row is Json => Boolean(row)) : [];
  const existing = rows.map((row) => text(row.trigger));
  if (distinctModificationConditions(rows) >= MIN_DISTINCT_CONDITIONS) return content;
  const herbs = candidate.herbs.map((herb) => text(record(herb)?.name)).filter(Boolean);
  const syndrome = text(record(root.overview)?.primarySyndrome);
  const method = text(record(root.therapy)?.overallMethod);
  const added = await proposeTwiceThenVerifyAll<TopUpRow>("m04_modification_top_up", "prescribe", {
    messages: [
      { role: "system", content: TOP_UP_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, herbs, existing, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 400,
    parse: parseTopUp,
  }, (row) => `${row.trigger}|${row.herbName}`, (row) => ({
    messages: [
      { role: "system", content: TOP_UP_VERIFY_SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, herbs, row, record: context.recordText.slice(0, 1_500) }) },
    ],
    maxTokens: 40,
    parse: parseConfirmed,
  }), 8, TIMEOUT_MS, signal);
  const delivered = [...rows];
  const triggers = [...existing];
  const taken = [...herbs, ...rows.map((row) => text(row.herbName))];
  for (const row of added) {
    if (distinctModificationConditions(delivered) >= MIN_DISTINCT_CONDITIONS + 1 || delivered.length >= 4) break;
    const compiled = topUpModificationRow(row, { prior: context.prior, caseState: context.caseState, candidateHerbNames: taken, existingTriggers: triggers });
    if (!compiled) continue;
    delivered.push(compiled);
    triggers.push(row.trigger);
    taken.push(row.herbName);
  }
  if (delivered.length === rows.length) return content;
  formula.modifications = delivered;
  console.info("[tcm-cdss:telemetry] m04_modification_top_up", { before: rows.length, after: delivered.length });
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(root, null, 2)}\n${content.slice(end)}`;
}

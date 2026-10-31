import "server-only";

import { parseConfirmed, proposeThenVerifyFirst } from "./cross-model-small-task.server";
import { formulaCompilationReferences } from "./tcm-formula-provenance";
import { getTcmHerbFunctionText } from "./tcm-knowledge";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { quoteGroundedInText } from "./verbatim-quote";

/**
 * 治法漏掉成组主症（2026-10-31，甲方 10.29 测评：风寒袭肺证咳嗽痰多，治法「疏风散寒，宣肺止咳」，方义却在讲降气化痰）。
 * 教材这一证的治法是原文，模型照抄；证型相同的病人有的痰多有的痰少，教材那一行写不到。
 * 一个模型提名：病历里有没有成组、属这次要治的表现，现有治法没有一项管到（要交两条以上病历逐字摘录和一个治法短语），短语里的功效须是
 * 教材这张方的药味确实具备的（知识库功效里有这个词）；另一厂商的模型只答这一项该不该补，说该补才加，至多一项。
 * 加在总治法末尾，不动教材原有的项。开关：CDSS_M03_METHOD_COVERAGE=false。
 */
const TIMEOUT_MS = 4_000;

export function methodCoverageEnabled(): boolean {
  return process.env.CDSS_M03_METHOD_COVERAGE !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const SYSTEM = [
  "你是中医主治医师。证型与治法已定。把病历里这次的现症按组列出来（主诉主症一组，它本身的性质如痰量痰色、反酸单算一组；其余伴随症状各一组；舌脉不列）。",
  "每组写：findings 病历逐字摘录（至少两条，只有一条就照抄那一条）；coveredBy 现有治法里管这一组的那一项，治法里没有一项管它就写 null；item 只在 coveredBy 为 null 时写，是 2–4 字的治法功效（如“化痰”“止呕”“利水”）。",
  "按与主诉主症的关系排序，主症本身的性质放最前。只输出 JSON：{\"groups\":[{\"findings\":[\"\"],\"coveredBy\":null,\"item\":\"\"}]}",
].join("\n");

type Uncovered = { item: string; quotes: string[] };

export function parseUncoveredGroups(content: unknown): Uncovered[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    const list = Array.isArray(parsed) ? parsed : record(parsed)?.groups;
    if (!Array.isArray(list)) return undefined;
    // 先逐组列、再看哪一组没人管，比直接问「有没有没管到的」召回高：同一份咳嗽痰多病历，直接问时有的回合答「通窍」有的答没有。
    return list.flatMap((entry) => {
      const group = record(entry);
      const item = text(group?.item);
      if (!group || !item || text(group.coveredBy)) return [];
      return [{ item, quotes: Array.isArray(group.findings) ? group.findings.map(text).filter(Boolean) : [] }];
    }).slice(0, 3);
  } catch {
    return undefined;
  }
}

const VERIFY_SYSTEM = [
  "你是中医主治医师。证型与治法已定，有人提议在治法后面补一项。判断两点，都成立才答 true：",
  "一、这些表现病历确实记录了，且现有治法的每一项都没有管到（「止咳」不管痰，痰量多要「化痰」；「和胃」管恶心，不必再写「止呕」）。",
  "二、这组表现在这个病里需要单独用药（痰量多、呕吐频、水肿、便血这类），不是顺带一提、主证治好自然会好的（偶有失眠、注意力差、纳差）。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

/** 这张方（教材行的代表方）的药味功效里有没有这个治法词：防止补一项方药管不到的治法。 */
function methodSupportedByFormula(item: string, formulaNames: readonly string[], rowComposition: readonly string[]): boolean {
  const herbs = [...rowComposition, ...formulaCompilationReferences([...formulaNames]).flatMap((reference) => reference.ingredients)];
  return herbs.some((herb) => getTcmHerbFunctionText(herb).includes(item));
}

/** 提名是否合格（纯函数，供测试）：2–4 字的功效词、现有治法没写、两条以上逐字摘录、方中药味具备这项功效。 */
export function methodItemQualifies(
  proposal: { item: string; quotes: string[] },
  context: { method: string; recordText: string; formulaNames: readonly string[]; rowComposition: readonly string[] },
): boolean {
  if (!/^[一-龥]{2,4}$/u.test(proposal.item) || context.method.includes(proposal.item)) return false;
  // 模型常把同一组写成一条（「咯痰色白质稀，量多易咯」）：按句读切开数。
  const findings = proposal.quotes.flatMap((quote) => quote.split(/[，,、；;]/u)).map((part) => part.trim()).filter((part) => part.length >= 2);
  if (findings.filter((quote) => quoteGroundedInText(quote, context.recordText, { minChars: 2 })).length < 2) return false;
  return methodSupportedByFormula(proposal.item, context.formulaNames, context.rowComposition);
}

export async function completeMethodCoverage(content: string, context: { recordText: string }, signal?: AbortSignal): Promise<string> {
  if (!methodCoverageEnabled()) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  const overview = record(root?.overview);
  const therapy = record(root?.therapy);
  const method = text(therapy?.overallMethod);
  if (!root || !overview || !therapy || !method) return content;
  const row = textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome));
  if (!row) return content;
  const qualifyContext = { method, recordText: context.recordText, formulaNames: row.formulas, rowComposition: row.composition };
  // 提名按与主症的关系排序，第一项不合格或被复核否掉时看下一项：只问第一项时「通窍」挡在前面，痰量多就永远问不到。
  const verifyOne = (candidate: Uncovered) => ({
    messages: [
      { role: "system" as const, content: VERIFY_SYSTEM },
      { role: "user" as const, content: JSON.stringify({ syndrome: text(overview.primarySyndrome), method, proposed: candidate.item, findings: candidate.quotes, chiefComplaint: context.recordText.split("\n").slice(0, 2).join(" ").slice(0, 120) }) },
    ],
    maxTokens: 40,
    parse: parseConfirmed,
  });
  const proposal = await proposeThenVerifyFirst<Uncovered>("m03_method_coverage", "diagnose", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome: text(overview.primarySyndrome), method, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 420,
    parse: parseUncoveredGroups,
  }, (candidate) => (methodItemQualifies(candidate, qualifyContext) ? verifyOne(candidate) : undefined), TIMEOUT_MS, signal);
  if (!proposal) return content;
  const item = proposal.item;
  therapy.overallMethod = `${method.replace(/[，,。；;\s]+$/u, "")}，${item}`;
  // 教材锚定随后会把治法换回教材原文，这一项要带过去（tcm-formula-provenance 接上后，交付面去掉这个键）。
  therapy.verifiedMethodItem = item;
  if (typeof overview.overallTherapy === "string") overview.overallTherapy = therapy.overallMethod;
  console.info("[tcm-cdss:telemetry] m03_method_coverage", { item });
  return JSON.stringify(root);
}

/**
 * 把 source 上复核过的那一项接到 target 的治法后面（两份来自同一份内容，并行各改一处）。target 的治法可能已被别的核对改过
 *（撤兼证去掉一项），所以只接这一项，不整句覆盖。
 */
export function withVerifiedMethodItemFrom(target: string, source: string): string {
  if (target === source) return target;
  try {
    const to = record(JSON.parse(target));
    const item = text(record(record(JSON.parse(source))?.therapy)?.verifiedMethodItem);
    const toTherapy = record(to?.therapy);
    if (!to || !toTherapy || !item) return target;
    toTherapy.verifiedMethodItem = item;
    const method = text(toTherapy.overallMethod);
    if (method && !method.includes(item)) toTherapy.overallMethod = `${method.replace(/[，,。；;\s]+$/u, "")}，${item}`;
    const toOverview = record(to.overview);
    if (toOverview && typeof toOverview.overallTherapy === "string") toOverview.overallTherapy = toTherapy.overallMethod;
    return JSON.stringify(to);
  } catch {
    return target;
  }
}

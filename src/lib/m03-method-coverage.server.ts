import "server-only";

import { parseConfirmed, proposeTwiceThenVerifyAll, verifyProposals } from "./cross-model-small-task.server";
import { methodItemAlreadyCovered, textbookAnchorableMethod } from "./tcm-formula-provenance";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";
import { quoteGroundedInText } from "./verbatim-quote";

/**
 * 治法漏掉成组主症（2026-10-31，甲方 10.29 测评：风寒袭肺证咳嗽痰多，治法「疏风散寒，宣肺止咳」，方义却在讲降气化痰）。
 * 教材这一证的治法是原文，证型相同的病人有的痰多有的痰少，教材那一行写不到；教材锚定随后又会把模型写的治法整句换掉。
 * 第三十三轮量到的：模型原写的治法项被锚定丢掉 55/155 份（制酸降逆、温化寒饮、清胃泻火、益气健脾…），此前这里对着模型原文问「有没有漏」，
 * 模型写了「化痰」就答不漏，锚定再把它盖掉。现在对着**将要交付的治法**问（有教材行且会锚定时是教材治法，否则是模型写的）：
 * 一个模型逐组列两次现症、指出哪一组没人管，提名取并集，每条由另一厂商的模型答该不该补（至多两项）；模型原写的项单独问（只有写错才去掉，见 VERIFY_OWN_SYSTEM）。合计不超过五项。
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
  "每组写：findings 病历逐字摘录（至少两条，只有一条就照抄那一条）；coveredBy 只能从 method 里选一项，这一项的功效要直接针对这组表现（解表散寒不管痰，止咳不管痰，痰量多要化痰一类），没有就写 null；item 只在 coveredBy 为 null 时写，是 2–6 字的治法（如“化痰”“制酸降逆”“温化寒饮”），modelMethod 里有合适的项就用它的原话。",
  "按与主诉主症的关系排序，主症本身的性质放最前。只输出 JSON：{\"groups\":[{\"findings\":[\"\"],\"coveredBy\":null,\"item\":\"\"}]}",
].join("\n");

type Uncovered = { item: string; quotes: string[]; fromModel?: boolean };

export function parseUncoveredGroups(content: unknown): Array<{ item: string; quotes: string[]; coveredBy?: string }> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    const list = Array.isArray(parsed) ? parsed : record(parsed)?.groups;
    if (!Array.isArray(list)) return undefined;
    // 先逐组列、再看哪一组没人管，比直接问「有没有没管到的」召回高：同一份咳嗽痰多病历，直接问时有的回合答「通窍」有的答没有。
    return list.flatMap((entry) => {
      const group = record(entry);
      if (!group) return [];
      const quotes = Array.isArray(group.findings) ? group.findings.map(text).filter(Boolean) : [];
      const coveredBy = text(group.coveredBy);
      const item = coveredBy ? "" : text(group.item);
      return item || coveredBy ? [{ item, quotes, coveredBy }] : [];
    }).slice(0, 6);
  } catch {
    return undefined;
  }
}

const VERIFY_SYSTEM = [
  "你是中医主治医师。证型与治法已定，有人提议在治法后面补一项。默认答 true，只有下面几种情况答 false：",
  "一、现有治法里已有一项说的是同一件事（同义或被包含；「止咳」不管痰，痰量多补「化痰」不算重复）；",
  "二、这项治法针对的表现病历没有记录，或只是顺带一提、主证治好自然会好（偶有失眠、注意力差）；",
  "三、与证型的寒热虚实方向相反；",
  "四、是在另立一个证候的治法，而病历没有成组的相应表现。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

/**
 * 模型自己写的项另一种问法（第三十四轮）。第三十三轮量到：提名与模型原写的项共用一个问法时，复核答 false 六成（145/234），丢掉的有 化痰（主诉痰多）、
 * 疏肝理气（方含香附、脉弦）、利咽（主诉咽中梗阻）、行气开结——方药是照着这些项开的，治法没了，方义与药味反而对不上治法。
 * 这些项是模型看完整份病历写的，举证责任反过来：只有写错才去掉，不问「值不值得补」。
 */
const VERIFY_OWN_SYSTEM = [
  "你是中医主治医师。证型与治法已定，现在核对初拟治法里的一项该不该留下。默认答 true，只有下面几种情况答 false：",
  "一、现有治法里已有一项说的是同一件事（同义或被包含）；",
  "二、与证型的寒热虚实方向相反；",
  "三、是在治另一个证候，而病历没有成组的相应表现；",
  "四、针对的表现病历根本没有。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

const METHOD_ITEM = /^[一-龥]{2,6}$/u;
/** 总共至多补三项，其中模型没写、由提名补的至多两项。 */
const MAX_ADDED_ITEMS = 3;
const MAX_NAMED_ITEMS = 2;
const MAX_METHOD_ITEMS = 5;
const methodItems = (method: string) => method.split(/[，,、；;。]/u).map((item) => item.trim()).filter(Boolean);

/**
 * 待复核的项：模型原写而将要交付的治法没有的项（排最前），加上逐组列出来没人管的项；模型把「管这一组的」写成了 method 之外的项，也算没人管。
 * 模型自己写的项不要摘录，由复核对着病历判。
 */
export function methodCoverageCandidates(groups: readonly { item: string; quotes: string[]; coveredBy?: string }[], method: string, modelMethod: string): Uncovered[] {
  const own = methodItems(modelMethod).filter((item) => METHOD_ITEM.test(item) && !method.includes(item)).map((item) => ({ item, quotes: [], fromModel: true }));
  const named = groups.flatMap((group) => {
    if (group.item) return [{ item: group.item, quotes: group.quotes }];
    const covered = group.coveredBy || "";
    return covered && !method.includes(covered) && METHOD_ITEM.test(covered) ? [{ item: covered, quotes: group.quotes }] : [];
  });
  return [...own, ...named];
}

/**
 * 提名是否合格（纯函数，供测试）：2–6 字的治法短语、将要交付的治法没写、至少一条逐字摘录。方药管不管得到由复核回答，开方阶段照治法组方。
 * 模型自己没写、由提名补的项，还要成组：至少两条表现，或一条写得具体的，或这条表现就在主诉里。只有一条顺带表现（大便干 → 清热通便）补进去，方里多半没有对应的药（第三十三轮 A02、D03）。
 */
export function methodItemQualifies(
  proposal: Uncovered,
  context: { method: string; recordText: string; chiefComplaint?: string },
): boolean {
  if (!METHOD_ITEM.test(proposal.item) || methodItemAlreadyCovered(proposal.item, context.method)) return false;
  if (proposal.fromModel) return true;
  // 模型常把同一组写成一条（「咯痰色白质稀，量多易咯」）：按句读切开数。
  const findings = proposal.quotes.flatMap((quote) => quote.split(/[，,、；;]/u)).map((part) => part.trim()).filter((part) => part.length >= 2)
    .filter((quote) => quoteGroundedInText(quote, context.recordText, { minChars: 2 }));
  if (findings.length === 0) return false;
  // 一条写得具体的也算成组（「痰多色白质稀」）。
  return new Set(findings).size >= 2 || findings.some((quote) => quote.length >= 5 || (context.chiefComplaint || "").includes(quote));
}

/**
 * 将要交付的治法：有教材行且能锚定时是教材治法，否则是模型写的。兼证此刻还在也一样（并行的兼证核对可能撤掉它，撤掉后照样锚定；
 * 胁痛·肝郁气滞证兼瘀血阻络证，撤兼证后治法只剩「疏肝理气」）。
 */
function methodToDeliver(disease: string, syndrome: string, modelMethod: string): string {
  const row = textbookRowForSyndrome(disease, syndrome);
  return (row && textbookAnchorableMethod(row.therapy)) || modelMethod;
}

function verifyRequest(candidate: Uncovered, syndrome: string, method: string, context: { recordText: string; chiefComplaint?: string }) {
  return {
    messages: [
      { role: "system" as const, content: candidate.fromModel ? VERIFY_OWN_SYSTEM : VERIFY_SYSTEM },
      { role: "user" as const, content: JSON.stringify({ syndrome, method, proposed: candidate.item, findings: candidate.quotes, chiefComplaint: context.chiefComplaint || "", record: context.recordText.slice(0, 1_500) }) },
    ],
    maxTokens: 40,
    parse: parseConfirmed,
  };
}

/** 逐组提名并复核，只看将要交付的治法（不看模型原写的项，那些单独问）。输入不含模型的治法，所以证名一写出来就能先发，见 prefetchMethodCoverage。 */
function namedCoverage(syndrome: string, method: string, room: number, context: { recordText: string; chiefComplaint?: string }, signal?: AbortSignal): Promise<Uncovered[]> {
  const qualifyContext = { method, recordText: context.recordText, chiefComplaint: context.chiefComplaint };
  return proposeTwiceThenVerifyAll<Uncovered>("m03_method_coverage", "diagnose", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ syndrome, method, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 420,
    parse: (value) => {
      const groups = parseUncoveredGroups(value);
      return groups && methodCoverageCandidates(groups, method, "");
    },
    // 提名按与主症的关系排序，第一项不合格或被复核否掉时看下一项：只问第一项时「通窍」挡在前面，痰量多就永远问不到。
  }, (candidate) => candidate.item, (candidate) => (methodItemQualifies(candidate, qualifyContext) ? verifyRequest(candidate, syndrome, method, context) : undefined), Math.min(room, MAX_NAMED_ITEMS), TIMEOUT_MS, signal, { recheckAgreed: true });
}

const roomFor = (method: string) => Math.min(MAX_ADDED_ITEMS, Math.max(0, MAX_METHOD_ITEMS - methodItems(method).length));

/**
 * 中医半的 overview 一闭合（证名、病名写出来，后面还有约六成要写）就先发提名与复核，收口时同一请求直接命中（2026-11-01，第三十三轮这一步让 M03 多等约 2.3 秒）。
 * 只有能从教材行定下治法时才发；证名后来变了只是未命中。纯增益，失败静默，不绑定任何调用方的中止信号。
 */
export function prefetchMethodCoverage(overview: Record<string, unknown>, context: { recordText: string; chiefComplaint?: string }): void {
  if (!methodCoverageEnabled()) return;
  const disease = text(overview.tcmDiseaseName);
  const syndrome = text(overview.primarySyndrome);
  if (!disease || !syndrome) return;
  const method = methodToDeliver(disease, syndrome, "");
  const room = method ? roomFor(method) : 0;
  if (room > 0) void namedCoverage(syndrome, method, room, context).catch(() => undefined);
}

export async function completeMethodCoverage(content: string, context: { recordText: string; chiefComplaint?: string }, signal?: AbortSignal): Promise<string> {
  if (!methodCoverageEnabled()) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  const overview = record(root?.overview);
  const therapy = record(root?.therapy);
  const modelMethod = text(therapy?.overallMethod);
  if (!root || !overview || !therapy || !modelMethod) return content;
  const syndrome = text(overview.primarySyndrome);
  const method = methodToDeliver(text(overview.tcmDiseaseName), syndrome, modelMethod);
  const room = roomFor(method);
  if (room === 0) return content;
  const qualifyContext = { method, recordText: context.recordText, chiefComplaint: context.chiefComplaint };
  const own = methodCoverageCandidates([], method, modelMethod).filter((candidate) => methodItemQualifies(candidate, qualifyContext));
  const [named, ownVerdicts] = await Promise.all([
    namedCoverage(syndrome, method, room, context, signal),
    verifyProposals("m03_method_coverage", "diagnose", own, (candidate) => verifyRequest(candidate, syndrome, method, context), TIMEOUT_MS, signal),
  ]);
  // 模型自己写的排前面；同一件事提名又说了一遍（「化痰止咳」与「化痰」）只留前一个。
  const items = [...own.filter((_, index) => ownVerdicts[index] === true), ...named].slice(0, room)
    .reduce<string[]>((kept, { item }) => (methodItemAlreadyCovered(item, kept.join("，")) ? kept : [...kept, item]), []);
  if (items.length === 0) return content;
  // 教材锚定随后会把治法换回教材原文，这几项要带过去（tcm-formula-provenance 接上后，交付面去掉这个键）。
  therapy.verifiedMethodItem = items.join("，");
  const absent = items.filter((item) => !modelMethod.includes(item));
  if (absent.length > 0) therapy.overallMethod = `${modelMethod.replace(/[，,。；;\s]+$/u, "")}，${absent.join("，")}`;
  if (typeof overview.overallTherapy === "string") overview.overallTherapy = therapy.overallMethod;
  console.info("[tcm-cdss:telemetry] m03_method_coverage", { items, against: method === modelMethod ? "model" : "textbook" });
  return JSON.stringify(root);
}

/**
 * 把 source 上复核过的几项接到 target 的治法后面（两份来自同一份内容，并行各改一处）。target 的治法可能已被别的核对改过
 *（撤兼证去掉一项），所以只接这几项，不整句覆盖。
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
    const merged = methodItems(item).reduce((text_, one) => (!text_ || methodItemAlreadyCovered(one, text_) ? text_ : `${text_.replace(/[，,。；;\s]+$/u, "")}，${one}`), method);
    if (merged !== method) toTherapy.overallMethod = merged;
    const toOverview = record(to.overview);
    if (toOverview && typeof toOverview.overallTherapy === "string") toOverview.overallTherapy = toTherapy.overallMethod;
    return JSON.stringify(to);
  } catch {
    return target;
  }
}

import "server-only";

import { parseConfirmed, proposeThenVerify } from "./cross-model-small-task.server";
import { isLineageLensSentence } from "./tcm-lineages";
import { quoteGroundedInText } from "./verbatim-quote";

/**
 * 流派视角句不得另下诊断、不得与病历相反（2026-10-31，甲方 10.29 测评）。
 *
 * 暑湿伤表证的依据末句写「本例…湿重于热、津液未伤，属湿温初起之轻证」：主证是暑湿伤表，湿温却列在鉴别里，病历又写着苔黄腻、脉数、
 * 口渴、小便短黄。这一句是模型按流派眼目加的，判别式规则看不了「湿重于热」对不对，分两层：
 *   · 确定性：句中肯定地落到鉴别项或主证以外的病名、证名，删这一分句（foreignLensClauseRemoved）；
 *   · 窄核对：一个模型提名「这句里哪几个字与病历相反」（逐字摘录这句与病历），另一厂商的模型只答这一处是否属实，属实才删那一分句，其余原样。
 * 删不是改写：视角句本来只是补充，剩下的句子仍然成立；整句删空就不留。开关：CDSS_M03_LENS_CONSISTENCY=false。
 */
const TIMEOUT_MS = 4_000;

export function lensConsistencyEnabled(): boolean {
  return process.env.CDSS_M03_LENS_CONSISTENCY !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function lensSentenceOf(rationale: string): string | undefined {
  return rationale.split(/(?<=[。；;])/u).map((part) => part.trim()).find(isLineageLensSentence);
}

const NEGATED_BEFORE = /(?:非|不属|不归|不是|未|无|不考虑|排除)[^，,。；;]{0,6}$/u;

/** 视角句里肯定地落到别的病名、证名的分句去掉。names：鉴别项病名与证名（主证、兼证不在其中）。 */
export function foreignLensClauseRemoved(lens: string, names: readonly string[]): string {
  const clauses = lens.split(/(?<=[，,；;。])/u);
  const kept = clauses.filter((clause) => !names.some((name) => {
    const at = clause.indexOf(name);
    return at >= 0 && !NEGATED_BEFORE.test(clause.slice(0, at));
  }));
  if (kept.length === clauses.length) return lens;
  return kept.join("").replace(/[，,；;]\s*$/u, "。").trim();
}

function differentialNames(overview: Json): string[] {
  const primary = text(overview.primarySyndrome);
  const secondary = Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes.map(text) : [];
  const names = [
    ...(Array.isArray(overview.tcmDiseaseDifferentials) ? overview.tcmDiseaseDifferentials.map((item) => text(record(item)?.diseaseName)) : []),
    ...(Array.isArray(overview.tcmDifferentials) ? overview.tcmDifferentials.map((item) => text(record(item)?.syndrome)) : []),
  ];
  return [...new Set(names)].filter((name) => name.length >= 2 && name !== primary && !secondary.includes(name) && name !== text(overview.tcmDiseaseName));
}

const SYSTEM = [
  "你是中医主治医师，核对一句流派视角的辨证小结是否与病历相反。主证与治法已定，不要评价它们。",
  "先把这句里对本例下的每个判断逐条列出来（寒热虚实孰重、津液伤没伤、气血伤没伤、邪在哪一层），每条写：claim 从这句逐字摘最短的判断片段；against 从病历逐字摘反驳它的已记录表现，没有写 null。",
  "「未见/未伤/无」这类判断也要列：说未伤津而病历有渴、尿黄少，说寒重而舌红苔黄、脉数，都算有反驳。只是说得不全、要靠推断的不算。",
  "只输出 JSON：{\"claims\":[{\"claim\":\"\",\"against\":null}]}",
].join("\n");

type Contradiction = { lensQuote: string; recordQuote: string };

export function parseLensClaims(content: unknown): Contradiction | null | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    const list = Array.isArray(parsed) ? parsed : record(parsed)?.claims;
    if (!Array.isArray(list)) return undefined;
    // 字段顺序就是推理顺序：先列判断、再找反驳，比直接问「有没有相反」漏得少（同一句「湿重于热」直接问时两次都答没有）。
    const first = list.map(record).find((item) => text(item?.claim) && text(item?.against));
    return first ? { lensQuote: text(first.claim), recordQuote: text(first.against) } : null;
  } catch {
    return undefined;
  }
}

const VERIFY_SYSTEM = [
  "你是中医主治医师。下面是对一例病人的一句辨证小结中的一个判断，和病历里的一处记录。",
  "问：病历这处记录是否直接反驳这个判断（比如判断说湿重于热，而舌红苔黄腻、脉数、尿黄都是明显的热象；判断说津液未伤，而记录了口渴、尿短黄）。",
  "只是不完全一致、或要靠推断的，答 false。只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

/**
 * 这条判断在视角句里对应的片段。模型摘录常换几个字（句子是「未见营血分或津伤重证」，摘成「未见津伤重证」）：
 * 逐字在就用它；否则取共有二字片段占比最高的分句（≥0.6），都不够就算没摘到。
 */
export function lensClauseOfClaim(lens: string, claim: string): string | undefined {
  if (!claim) return undefined;
  if (lens.includes(claim)) return claim;
  const grams = [...claim].slice(0, -1).map((char, index) => char + claim[index + 1]);
  if (grams.length === 0) return undefined;
  const scored = lens.split(/[，,；;。]/u).map((clause) => clause.trim()).filter(Boolean)
    .map((clause) => ({ clause, score: grams.filter((gram) => clause.includes(gram)).length / grams.length }))
    .sort((left, right) => right.score - left.score)[0];
  return scored && scored.score >= 0.6 ? scored.clause : undefined;
}

export function lensWithoutQuotes(lens: string, quotes: readonly string[]): string {
  const clauses = lens.split(/(?<=[，,；;。])/u);
  const kept = clauses.filter((clause) => !quotes.some((quote) => clause.includes(quote) || quote.includes(clause.replace(/[，,；;。]/gu, ""))));
  if (kept.length === clauses.length) return lens;
  // 只剩「从…看」这种引子，没有判断了，整句不留。
  const body = kept.join("").replace(/[，,；;]\s*$/u, "。").trim();
  return kept.length <= 1 && /^从[^，,。]{1,16}看/u.test(body) ? "" : body;
}

/** 中医半上做两层核对，返回改写后的内容；不是流派病例、没有视角句或没有问题时逐字节原样返回。 */
export async function checkLineageLensInContent(content: string, context: { recordText: string; lineage?: string }, signal?: AbortSignal): Promise<string> {
  if (!lensConsistencyEnabled() || !context.lineage || context.lineage === "unrestricted") return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  const overview = record(root?.overview);
  const rationale = text(overview?.tcmDiagnosticRationale);
  if (!root || !overview || !rationale) return content;
  // 模型有时不写学派名、只写结论（「湿重于热，未见津伤之象，治当轻清宣化」）：选了流派的病例，末句就是视角句。
  const lens = lensSentenceOf(rationale) || rationale.split(/(?<=[。；;])/u).map((part) => part.trim()).filter(Boolean).at(-1);
  if (!lens) return content;
  let next = foreignLensClauseRemoved(lens, differentialNames(overview));
  const finding = next ? await proposeThenVerify<Contradiction | null>("m03_lens_consistency", "diagnose", {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ primarySyndrome: text(overview.primarySyndrome), lens: next, record: context.recordText.slice(0, 2_400) }) },
    ],
    maxTokens: 300,
    parse: parseLensClaims,
  }, (proposal) => {
    // 舌脉常是两个字（脉数），摘录里的片段放宽到两字。
    if (!lensClauseOfClaim(next, proposal.lensQuote) || !quoteGroundedInText(proposal.recordQuote, context.recordText, { minPartChars: 2 })) return undefined;
    return {
      messages: [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: JSON.stringify({ judgement: lensClauseOfClaim(next, proposal.lensQuote), sentence: next, recordEvidence: proposal.recordQuote, primarySyndrome: text(overview.primarySyndrome) }) },
      ],
      maxTokens: 40,
      parse: parseConfirmed,
    };
  }, TIMEOUT_MS, signal) : undefined;
  const claimClause = finding ? lensClauseOfClaim(next, finding.lensQuote) : undefined;
  if (claimClause) next = lensWithoutQuotes(next, [claimClause]);
  if (next === lens) return content;
  overview.tcmDiagnosticRationale = rationale.replace(lens, next).replace(/\s+$/u, "");
  console.info("[tcm-cdss:telemetry] m03_lens_consistency", { removedChars: lens.length - next.length });
  return JSON.stringify(root);
}

/**
 * 把核对前后视角句的差别落到 target 上（三份来自同一份内容，并行各改一处）。target 的依据已被别的核对改过时，
 * 视角句原样还在才替换；不在就不动。
 */
export function withLensFrom(target: string, before: string, checked: string): string {
  if (before === checked) return target;
  try {
    const rationaleOf = (content: string) => text(record(record(JSON.parse(content))?.overview)?.tcmDiagnosticRationale);
    const [was, now] = [rationaleOf(before), rationaleOf(checked)];
    const root = record(JSON.parse(target));
    const overview = record(root?.overview);
    const current = text(overview?.tcmDiagnosticRationale);
    if (!root || !overview || !current || !was || !now || was === now) return target;
    // 两句的公共前缀之后才是视角句（只改了末尾这一句）。
    let at = 0;
    while (at < was.length && was[at] === now[at]) at += 1;
    const start = Math.max(was.lastIndexOf("。", at - 1), was.lastIndexOf("；", at - 1)) + 1;
    const oldSentence = was.slice(start).trim();
    const newSentence = now.slice(start).trim();
    if (!oldSentence || !current.includes(oldSentence)) return target;
    overview.tcmDiagnosticRationale = current.replace(oldSentence, newSentence).replace(/\s+$/u, "");
    return JSON.stringify(root);
  } catch {
    return target;
  }
}

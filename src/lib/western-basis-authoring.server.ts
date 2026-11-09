import "server-only";

import { primaryModelJsonTask } from "./cross-model-small-task.server";
import { recordMentionPolarityAt } from "./diagnosis-safety";
import { alignQuoteToSource, normalizedQuoteText } from "./source-quote-alignment";
import { quoteGroundedInText } from "./verbatim-quote";
import { westernCriteriaEntry, type WesternCriteriaEntry } from "./western-diagnostic-criteria.server";
import { listedWesternDiagnosisNames } from "./western-name-evidence-check.server";

/**
 * 西医诊断依据在病名定稿之后、按该病的诊断要点单独写（2026-11-09 第三十九轮）。
 *
 * 为什么：交付给甲方的依据（primary.supportingFacts 唯一一句，10.26 起）原是西医半顺手写的 clinicalRationale。
 *  · 写法顺序本身是复述在前：提示词要先「点名关键已记录事实」，结构里又紧跟逐条抄病历的 supportingFacts，限 100 字——
 *    复述占掉篇幅，推理只剩「符合X」四五个字；甲方面板把这一栏标作「症状依据」，读起来就是症状罗列（10.12 甲方点名）。
 *  · 模型看不到诊断要点表（只给病名核对用），说不出满足的是哪条；
 *  · 写在病名定稿之前：名称核对降级、就诊原因核对、确定性改名之后，依据还在说原来的病（第十五轮实测 74 条改名里 28 条仍写「符合缺铁性贫血」），
 *    只能靠正则改句式；
 *  · 写完没有任何核对。
 * 参照：首次病程记录要求「病例特点」是归纳不是罗列、拟诊讨论要有诊断依据与鉴别分析；Revised-IDEA（JGIM 2021）先用定性词概括问题、
 * 再解释主诊断；ConfiDx / EGDR / DiReCT 把诊断标准逐条对到病历原文片段。
 *
 * 做法：deepseek-flash 按推理顺序填提纲（概括 → 满足的要点及原文 → 阴性所见 → 为什么写到这一级 → 需排除 → 成句），
 * 服务端逐项核对（引文出自病历、要点取自要点表、成句覆盖各项且写着最终病名、数字出自病历、不写中医证候、不是复述病历），
 * 过了才换掉 clinicalRationale；任何一项不过、超时或失败，保留模型原来那句（与今天一样）。
 * 时延：用病名核对之前的病名先起一次（与核对并行），病名没变就直接用；变了按最终病名再写一次。整段在西医半，与中医半并行。
 * 开关：CDSS_WESTERN_BASIS_AUTHORING=false 关闭。
 */
const TIMEOUT_MS = 6_000;
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function westernBasisAuthoringEnabled(): boolean {
  return process.env.CDSS_WESTERN_BASIS_AUTHORING !== "false";
}

export type WesternBasisItem = { point: string; quote: string };
export type WesternBasisProposal = {
  summary: string;
  criteria: WesternBasisItem[];
  negatives: WesternBasisItem[];
  level: string;
  exclude: string[];
  text: string;
};
export type WesternBasisContext = {
  /** 最终主诊断名。 */
  name: string;
  recordText: string;
  /** 本例候选与鉴别里的病名（不含主诊断）。 */
  listedNames: readonly string[];
  /** 要点表里这个病的条目（没有时不限定要点来源）。 */
  criteria?: WesternCriteriaEntry;
};
export type AuthoredWesternBasis = { name: string; proposal: WesternBasisProposal };

/** 去掉「待查」「可能」后的病名核心（「消化不良待查」→「消化不良」）。 */
export function westernNameCore(name: string): string {
  return compact(name).replace(/(?:待[查排]|可能)$/u, "");
}

/** 要点表条目：先按病名，「待查」写法再按核心名查。 */
export function westernBasisCriteriaEntry(name: string): WesternCriteriaEntry | undefined {
  return westernCriteriaEntry(name) || (westernNameCore(name) !== compact(name) ? westernCriteriaEntry(westernNameCore(name)) : undefined);
}

function bigrams(value: string): Set<string> {
  const source = compact(value).replace(/[，,；;。、：:（）()“”「」\s]/gu, "");
  const out = new Set<string>();
  for (let index = 0; index + 2 <= source.length; index += 1) out.add(source.slice(index, index + 2));
  return out;
}

function sharedBigrams(left: string, right: string, ignore?: Set<string>): number {
  const b = bigrams(right);
  let count = 0;
  for (const gram of bigrams(left)) if (b.has(gram) && !ignore?.has(gram)) count += 1;
  return count;
}

/** 依据句里有多大比例是逐字照抄病历（连续 6 字以上的片段）。 */
export function westernBasisRecitalRatio(sentence: string, recordText: string): number {
  const s = compact(sentence);
  const source = compact(recordText);
  if (!s) return 0;
  let covered = 0;
  let index = 0;
  while (index < s.length) {
    let length = 0;
    for (let size = Math.min(s.length - index, 60); size >= 6; size -= 1) {
      if (source.includes(s.slice(index, index + size))) { length = size; break; }
    }
    if (length > 0) { covered += length; index += length; } else index += 1;
  }
  return covered / s.length;
}

/** 句中的数字都出自病历（计量单位前的中文数词按阿拉伯数字比，同一归一化）。 */
function numbersGrounded(sentence: string, recordText: string, allowed = ""): boolean {
  const source = `${normalizedQuoteText(recordText)}｜${normalizedQuoteText(allowed)}`;
  const numbers = normalizedQuoteText(sentence).match(/\d+(?:\.\d+)?/gu) || [];
  return numbers.every((number) => source.includes(number));
}

/** 中医证候（「…证」，证据/证实/证明、确证/佐证/验证除外）或「中医」字样。 */
function namesTcmSyndrome(sentence: string): boolean {
  return sentence.includes("中医") || /[一-龥](?<![确佐验])证(?![据实明])/u.test(sentence);
}

/**
 * 要点的原文：逐字出自病历，且不是被否认或别人的那一处（「腹痛」对在「无腹痛」里不算）。
 * 读法看引文起点：引文自己以否认开头（「双肺呼吸音清，未闻及…」「无腹痛及阴道流血」）是一条完整的病历原句，算数。
 */
function quoteAffirmedInRecord(quote: string, recordText: string): boolean {
  const aligned = alignQuoteToSource(quote, recordText);
  if (aligned) return recordMentionPolarityAt(recordText, aligned.start) === "affirmed";
  // 用「；」「，」拼起来的两段原文：逐段逐字出自病历即可（verbatim-quote 同一判据）。
  return quoteGroundedInText(quote, recordText, { minChars: 2, maxChars: 60, minPartChars: 2 });
}

function quoteInRecord(quote: string, recordText: string): boolean {
  return Boolean(alignQuoteToSource(quote, recordText)) || quoteGroundedInText(quote, recordText, { minChars: 2, maxChars: 60, minPartChars: 2 });
}

function criteriaTableText(entry: WesternCriteriaEntry): string {
  return [...entry.definingFeatures, ...entry.requiredTests, entry.durationThreshold, entry.featureRule || "", entry.requiredHistory || ""].join("；");
}

/**
 * 提纲里出自病历的那几条：要点原文逐字在病历且不是被否认的那一处，有要点表时要点取自表；阴性所见原文逐字在病历。
 * 不合格的单条去掉（模型把阳性症状填进阴性所见、或摘录拼了生命体征行），不因一条作废整份；要点一条不剩才作废。
 */
export function groundedWesternBasisItems(proposal: WesternBasisProposal, context: WesternBasisContext): { criteria: WesternBasisItem[]; negatives: WesternBasisItem[] } {
  const table = context.criteria ? criteriaTableText(context.criteria) : undefined;
  return {
    criteria: proposal.criteria.filter((item) => item.point && item.quote && quoteAffirmedInRecord(item.quote, context.recordText) &&
      (!table || sharedBigrams(item.point, table) > 0)),
    negatives: proposal.negatives.filter((item) => item.point && item.quote && quoteInRecord(item.quote, context.recordText)),
  };
}

/**
 * 提纲与成句的核对。返回不合格的原因码，合格返回 undefined。
 * 每一项都只核对「形」与出处（引文在不在病历、要点是不是表里的、成句有没有写到各项），不改写内容。
 */
export function westernBasisIssue(proposal: WesternBasisProposal, context: WesternBasisContext): string | undefined {
  const sentence = compact(proposal.text);
  if (sentence.length < 30 || sentence.length > 160) return "text_length";
  const core = westernNameCore(context.name);
  if (!core || !sentence.includes(core)) return "text_misses_name";
  if (!/待查|待排/u.test(compact(context.name)) && /待查|待排/u.test(sentence)) return "text_contradicts_name";
  const { criteria, negatives } = groundedWesternBasisItems(proposal, context);
  if (criteria.length === 0) return "no_grounded_criteria";
  const nameGrams = bigrams(core);
  if (criteria.some((item) => sharedBigrams(sentence, `${item.point}${item.quote}`, nameGrams) === 0)) return "text_misses_criteria";
  if (!proposal.level || sharedBigrams(sentence, proposal.level, nameGrams) < 2) return "text_misses_level";
  if (proposal.exclude.some((name) => compact(name) === compact(context.name) || compact(name) === core)) return "exclude_is_primary";
  if (proposal.exclude.some((name) => !sentence.includes(compact(name)))) return "text_misses_exclude";
  const declared = new Set([compact(context.name), core, ...proposal.exclude.map(compact)]);
  // 病历自己否认的病（「否认高血压、甲状腺疾病史」）出现在阴性所见里不算另提一个病。
  const deniedText = compact(negatives.map((item) => item.quote).join("；"));
  if (context.listedNames.some((name) => {
    const listed = compact(name);
    return listed.length >= 3 && sentence.includes(listed) && !declared.has(listed) && !core.includes(listed) &&
      ![...declared].some((item) => item.includes(listed)) && !deniedText.includes(listed);
  })) return "text_names_undeclared_disease";
  if (namesTcmSyndrome(proposal.text)) return "text_names_tcm";
  // 给医生读的临床表述不讲病历本身（「病历载」「病历未记录相关阴性」，v2 盲评 16 份新依据的硬伤里 7 份是这种说明腔）。
  if (sentence.includes("病历")) return "text_meta";
  // 数字出自病历；诊断名本身（2型糖尿病）与要点表的门槛（≥5次、4周）里的数字也算。
  if (!numbersGrounded(proposal.text, context.recordText, `${context.name}｜${context.criteria ? criteriaTableText(context.criteria) : ""}`)) return "number_not_in_record";
  if (westernBasisRecitalRatio(proposal.text, context.recordText) > 0.6) return "recital";
  return undefined;
}

function items(value: unknown, limit: number): WesternBasisItem[] {
  return (Array.isArray(value) ? value : []).slice(0, limit).map((item) => ({ point: text(record(item)?.point), quote: text(record(item)?.quote) }))
    .filter((item) => item.point || item.quote);
}

export function parseWesternBasisProposal(content: unknown): WesternBasisProposal | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed = record(JSON.parse(content));
    if (!parsed) return undefined;
    const proposal: WesternBasisProposal = {
      summary: text(parsed.summary),
      criteria: items(parsed.criteria, 3),
      negatives: items(parsed.negatives, 2),
      level: text(parsed.level),
      exclude: (Array.isArray(parsed.exclude) ? parsed.exclude : []).map(text).filter(Boolean).slice(0, 2),
      text: text(parsed.text),
    };
    return proposal.text ? proposal : undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM = `你给一个西医诊断写诊断依据，给医生看。给你 name（诊断名）、criteria（该病的诊断要点，可能为空；clinicallyDiagnosable=false 表示确诊必须靠 requiredTests 里的检查）、listed（本例列过的候选与鉴别病名）、chiefComplaint（主诉）、record（病历）、redFlag（是否有急危重征象）。
依据要如实：支持这个诊断的是什么，还缺什么。确诊必需的检查病历里没有时，写明「尚缺…，需…确认」，不要说依据临床表现即可诊断。
按下面的顺序填，前面几项是最后那句话的提纲：
1. summary：一句话概括本例问题的特点（≤25字），用急性/慢性、反复/持续、诱因、部位这类定性说法，不要逐条罗列症状。定性词要有病历依据：病程不足3个月不写「慢性」，只写了一次发作不写「反复」，病历没写年龄性别就不写。
2. criteria：本例满足的诊断要点，1–3条。point 写要点本身（criteria 不为空时只能用其中的要点，沿用它的说法；为空时写该病公认的诊断要点）；quote 是病历里支持这一点的一段原文，逐字照抄、不增不减（≤30字）。
3. negatives：病历里写明的、有鉴别意义的否认或正常结果，0–2条，quote 逐字照抄病历里那句否认或正常结果（如「无呕血、黑便」「心电图未见异常」）。病历没写否认就留空数组，不要把阳性症状放进来。
4. level：诊断为什么写到这一级（≤40字）：是哪项检查或客观所见确立的；按临床表现即可诊断的病写明依据临床表现诊断；还缺确诊检查或病程未满的，写缺什么。
5. exclude：还需排除的病，0–2个，写规范病名。
6. text：把上面各项写成一句话（60–120字），这就是医生读到的诊断依据：先写 summary，再点出满足的要点，再写阴性所见（没有就不写这一部分），再写 level，最后写「需与/需排除…」。句中要逐字出现诊断名 name。
text 是临床表述：不逐条复述病史，不用「」引病历原文，不写「病历载」「病历未记录相关阴性」「无明确否认项」这类讲病历本身的话，不写病历里没有的检查结果或数字，不写中医证候。name 不带「待查」时句中不出现「待查」。
只输出 JSON：{"summary":"","criteria":[{"point":"","quote":""}],"negatives":[{"point":"","quote":""}],"level":"","exclude":[""],"text":""}`;

function westernPrimaryOf(westernContent: string): { name: string; listed: string[] } | undefined {
  try {
    const western = record(record(JSON.parse(westernContent))?.westernDiagnosis);
    const name = text(record(western?.primary)?.name);
    return name ? { name, listed: listedWesternDiagnosisNames(western) } : undefined;
  } catch {
    return undefined;
  }
}

/** 按西医半当前的主诊断写一份提纲与成句（不核对，核对在落到最终内容时做）。 */
export async function authorWesternBasis(
  westernContent: string,
  context: { recordText: string; chiefComplaint: string; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<AuthoredWesternBasis | undefined> {
  if (!westernBasisAuthoringEnabled()) return undefined;
  const primary = westernPrimaryOf(westernContent);
  if (!primary) return undefined;
  const entry = westernBasisCriteriaEntry(primary.name);
  const criteria = entry ? {
    clinicallyDiagnosable: entry.clinicallyDiagnosable,
    definingFeatures: entry.definingFeatures,
    requiredTests: entry.requiredTests,
    durationThreshold: entry.durationThreshold,
    ...(entry.featureRule ? { featureRule: entry.featureRule } : {}),
    ...(entry.requiredHistory ? { requiredHistory: entry.requiredHistory } : {}),
  } : null;
  const proposal = await primaryModelJsonTask("western_basis_authoring", "diagnose", [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify({
      name: primary.name,
      criteria,
      listed: primary.listed,
      chiefComplaint: context.chiefComplaint,
      record: context.recordText.slice(0, 3_000),
      redFlag: Boolean(context.redFlag),
    }) },
  ], { maxTokens: 500, timeoutMs: TIMEOUT_MS }, parseWesternBasisProposal, signal);
  return proposal ? { name: primary.name, proposal } : undefined;
}

/**
 * 落到最终西医内容上：提纲是按最终病名写的、核对全过，才换掉 clinicalRationale；否则原样返回。
 * draft 是用核对前的病名先起的那一份：病名没变就直接用，变了按最终病名再写一次。
 */
export async function withAuthoredWesternBasis(
  westernContent: string,
  context: { recordText: string; chiefComplaint: string; redFlag?: boolean },
  draft: Promise<AuthoredWesternBasis | undefined> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!westernBasisAuthoringEnabled()) return westernContent;
  const primary = westernPrimaryOf(westernContent);
  if (!primary) return westernContent;
  let authored = draft ? await draft.catch(() => undefined) : undefined;
  const reused = Boolean(authored && compact(authored.name) === compact(primary.name));
  if (!reused) authored = await authorWesternBasis(westernContent, context, signal).catch(() => undefined);
  if (!authored) {
    console.info("[tcm-cdss:telemetry] western_basis_authoring", { accepted: false, reason: "unavailable" });
    return westernContent;
  }
  const entry = westernBasisCriteriaEntry(primary.name);
  const issue = westernBasisIssue(authored.proposal, { name: primary.name, recordText: context.recordText, listedNames: primary.listed, criteria: entry });
  console.info("[tcm-cdss:telemetry] western_basis_authoring", { accepted: !issue, reason: issue || null, criteriaTable: Boolean(entry), reusedDraft: reused });
  if (issue) return westernContent;
  try {
    const root = record(JSON.parse(westernContent));
    const western = record(root?.westernDiagnosis);
    const target = record(western?.primary);
    if (!root || !target) return westernContent;
    target.clinicalRationale = authored.proposal.text.replace(/\s+/gu, " ").trim();
    return JSON.stringify(root);
  } catch {
    return westernContent;
  }
}

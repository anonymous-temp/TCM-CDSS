import "server-only";

import type { CaseState } from "./diagnosis-types";
import { clinicalClausePolarity, type AssistedNegationClauses, type AssistedPolarityDecisions } from "./clinical-polarity";
import { affirmativeNegationFormsIn } from "./clinical-vocabulary";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";

/**
 * 口语否定增补：确定性正则判为阳性、但实际是口语否定的分句，交模型判一次。
 *
 * 实测确定性层的缺口（clinical-polarity.ts 的 71 条正则）：
 *   否认胸痛 / 无胸痛            → 正确判否定
 *   胸口不疼 / 早就不疼了         → 误判阳性
 *   哪有什么胸痛 / 胸痛这个倒是没有 → 误判阳性
 * 口语否定和口语症状一样穷举不完，继续加正则只是重走概念表的老路。
 *
 * 2026-08-10 起是**双向**的：另一半见 affirmativeNegationCandidates——中医里「无汗」「不渴」
 * 「不恶寒」是证候的定义性指征而非「没有该症状」，确定性层按语言学规则会把它们整条剥掉。
 *
 * ★ 三条安全边界 ★
 * 1. 阳性方向被关进**受治理闭集**：只有含 tcm-affirmative-negation-forms.json 那 68 条词的
 *    分句才进候选，候选生成与结果采纳各校验一次；模型只能返回候选序号，无法引入任何新文本。
 *    否定方向仍无闭集限制——那一侧的失败方向是「多判一条否定」，本就更严格。
 * 2. 限 scope：只作用于 affirmed（检索/依据/grounding）。审方与方剂禁忌用的是
 *    affirmed_or_uncertain——那些调用点故意保留未消解表述以免漏警告，在那里补否定
 *    等于少一条警告，方向相反，因此增补集在该 scope 下被完全忽略。
 * 3. 失败即维持现状：不可用/超时/未配置/解析失败一律返回空集，等于今天的行为。
 *
 * 只把「已被判为阳性且含否定语气词」的分句送模型，候选量小、延迟可控，
 * 也避免把整份病历重新交给模型判一遍。
 */

const ASSIST_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 12;
const CLAUSE_SPLIT = /[，,、。；;\n]+/;
/** 口语否定的语气标记；命中才值得问模型，没命中的分句连候选都不是。 */
const COLLOQUIAL_NEGATION_CUE = /(?:不|没|无|甭|别|哪有|谈不上|说不上|算不上|用不着)/;

function enabled(): boolean {
  return process.env.POLARITY_NEGATION_ASSIST !== "false";
}

/**
 * 候选 = 分句 + **它所在的原文**。
 *
 * 只把孤立分句发给模型是不够的：线上实测，单独一条「无汗」模型答 none，
 * 而把同一条放进「无汗 / 无胸闷 / 既往无汗证」的对比里就正确答 1——
 * 「无汗」脱离原文时人也判不了它是四诊指征还是逐项否认，这正是本层要判的东西。
 * 缺语境会让本层在最需要它的场景（主诉里只有一个受治理词）静默失效。
 */
type PolarityCandidate = { clause: string; context: string };

/** 两个方向共用同一份取材范围，避免一侧加了字段另一侧忘了加。 */
function polarityCandidateSources(caseState: CaseState): string[] {
  return [
    caseState.chiefComplaint,
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    ...Object.values(caseState.symptoms || {}).map((value) => (typeof value === "string" ? value : "")),
    ...(caseState.conversation || [])
      .filter((item) => item.role === "user")
      .map((item) => item.content),
  ].filter((value): value is string => Boolean(value && value.trim()));
}

/** 确定性层判为阳性、但带否定语气词的分句——只有这些需要模型裁决。 */
function collectCandidates(
  caseState: CaseState,
  accept: (clause: string) => boolean,
): PolarityCandidate[] {
  const seen = new Set<string>();
  const out: PolarityCandidate[] = [];
  for (const source of polarityCandidateSources(caseState)) {
    const normalizedSource = source.normalize("NFKC");
    for (const raw of normalizedSource.split(CLAUSE_SPLIT)) {
      const clause = raw.trim();
      if (clause.length < 2 || clause.length > 40) continue;
      if (!accept(clause) || seen.has(clause)) continue;
      seen.add(clause);
      out.push({ clause, context: normalizedSource.slice(0, 160) });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/** 确定性层判为阳性、但带否定语气词的分句——只有这些需要模型裁决。 */
export function colloquialNegationCandidates(caseState: CaseState): string[] {
  return colloquialNegationCandidatePairs(caseState).map((item) => item.clause);
}

function colloquialNegationCandidatePairs(caseState: CaseState): PolarityCandidate[] {
  return collectCandidates(caseState, (clause) =>
    COLLOQUIAL_NEGATION_CUE.test(clause)
    // 确定性层已经判为否定的分句无需再问；只补它漏掉的。
    && clinicalClausePolarity(clause) !== "negative");
}

/**
 * 阳性方向的候选：确定性层判为**否定**、但含受治理「阴性形式阳性体征」词的分句。
 *
 * 闭集是这一侧唯一的安全阀。模型不能把任意否认读成阳性——只有分句里出现了
 * tcm-affirmative-negation-forms.json 收录的 68 条词（无汗/不渴/不恶寒/小便不利/
 * 不得卧…，由鉴别图 + 古方主治原文派生）才进候选。这些词在中医里本就是证候的
 * 定义性指征，问题只在于「这一处到底是指征还是患者否认」——那才是交给模型的判断。
 */
export function affirmativeNegationCandidates(caseState: CaseState): string[] {
  return affirmativeNegationCandidatePairs(caseState).map((item) => item.clause);
}

function affirmativeNegationCandidatePairs(caseState: CaseState): PolarityCandidate[] {
  return collectCandidates(caseState, (clause) =>
    // 只看确定性层判否定的——判阳性的本来就没丢，不需要救。
    clinicalClausePolarity(clause) === "negative"
    // 闭集门：分句必须含受治理的阴性形式阳性体征词。
    && affirmativeNegationFormsIn(clause).length > 0);
}

const AFFIRMATIVE_SYSTEM_PROMPT = [
  "你判断中文中医病历里的分句，是【患者具有该体征】还是【患者否认该症状】。",
  "中医里「无汗」「不渴」「不恶寒」「小便不利」「不得卧」这类以否定词表达的说法，",
  "在四诊描述里往往是证候的**定义性指征**（患者确实无汗，这是表实证的依据），",
  "但在系统回顾式否认里就是真否认（「无汗出、无心悸、无胸闷」= 逐项排除）。",
  "逐条回答，只输出【属于阳性体征】的分句序号，用英文逗号分隔，例如：1,3。",
  "若没有任何一条是阳性体征，只输出 none。不要解释、不要复述原文。",
  "判为阳性体征的例子：恶寒发热无汗（表实证指征）；口不渴（寒证指征）；小便不利（水湿内停指征）。",
  "判为否认的例子：无汗出、无心悸、无胸闷（逐项排除）；否认口渴、多饮、多尿；既往无汗证。",
].join("\n");

const SYSTEM_PROMPT = [
  "你判断中文病历分句是否在【否认或排除】某个症状/体征/病史。",
  "逐条回答，只输出被否认的分句序号，用英文逗号分隔，例如：1,3。若没有任何一条是否认，只输出 none。",
  "不要解释、不要复述原文、不要输出其他任何内容。",
  "判为否认的例子：胸口不疼；早就不疼了；哪有什么胸痛；胸痛这个倒是没有；谈不上头晕。",
  "不判为否认的例子：没精神（这是症状本身）；没力气；没胃口；不欲食；夜不能寐；食少纳呆。",
].join("\n");

/**
 * 双向语义极性裁决：否定方向（口语否定）+ 阳性方向（阴性形式阳性体征）。
 *
 * 两侧独立请求、独立失败：任一侧不可用只损失该侧，不影响另一侧，也不影响确定性层。
 */
export async function assistedPolarityDecisions(
  caseState: CaseState,
  signal?: AbortSignal,
): Promise<AssistedPolarityDecisions> {
  const [negated, affirmed] = await Promise.all([
    assistedNegationClauses(caseState, signal),
    assistedAffirmativeClauses(caseState, signal),
  ]);
  return {
    negated: negated instanceof Set ? negated : new Set<string>(),
    affirmed,
  };
}

/**
 * 返回「确定性层判否定、实为阳性体征」的分句集合；不可用时返回空集（等于今天的行为）。
 */
export async function assistedAffirmativeClauses(
  caseState: CaseState,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const empty = new Set<string>();
  if (!enabled() || signal?.aborted) return empty;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return empty;
  const candidates = affirmativeNegationCandidatePairs(caseState);
  if (candidates.length === 0) return empty;
  const picked = await askClauseSelection(candidates, AFFIRMATIVE_SYSTEM_PROMPT, signal);
  // 二次闭集校验：即便模型返回的序号合法，被选中的分句也必须仍然含受治理词。
  // 候选生成与结果采纳各校验一次，中间任何改动让两者分叉时都会在这里被挡住。
  return new Set([...picked].filter((clause) => affirmativeNegationFormsIn(clause).length > 0));
}

/**
 * 返回被判定为口语否定的分句集合；不可用时返回空集（等于今天的确定性行为）。
 */
export async function assistedNegationClauses(
  caseState: CaseState,
  signal?: AbortSignal,
): Promise<AssistedNegationClauses> {
  const candidates = colloquialNegationCandidatePairs(caseState);
  if (candidates.length === 0) return new Set<string>();
  return askClauseSelection(candidates, SYSTEM_PROMPT, signal);
}

/**
 * 「从候选分句里挑出符合某个判据的那些」——两个方向共用的唯一一次模型调用实现。
 *
 * 提出来是因为两侧的调用形状完全相同，只有 system prompt 不同；各写一份就是本仓库
 * 最常复发的那个形状（同一判据两处各写各的），改超时/改解析只改一处会静默半失效。
 *
 * 三条边界与原实现逐字一致：
 *  · 模型只能返回**候选序号**，越界与重复一律丢弃——它无法引入任何新文本；
 *  · 未启用/未配置/超时/异常/解析失败一律返回空集，等于确定性层今天的行为；
 *  · 送模型前过 sanitizeFreeTextForModel。
 */
async function askClauseSelection(
  candidates: readonly PolarityCandidate[],
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<ReadonlySet<string>> {
  const empty = new Set<string>();
  if (!enabled() || signal?.aborted) return empty;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    // 每条候选都带上它所在的原文。不带语境时模型判不了「无汗」是指征还是否认（实测答 none）。
    const numbered = candidates
      .map(({ clause, context }, index) => {
        const safeClause = sanitizeFreeTextForModel(clause);
        const safeContext = sanitizeFreeTextForModel(context);
        return safeContext && safeContext !== safeClause
          ? `${index + 1}. ${safeClause}　（原文：${safeContext}）`
          : `${index + 1}. ${safeClause}`;
      })
      .join("\n");
    const client = createTextModelClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 64,
      ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: numbered },
      ],
    }, { signal: controller.signal });
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || /none/i.test(raw)) return empty;
    const picked = new Set<string>();
    for (const token of raw.match(/\d+/g) || []) {
      const candidate = candidates[Number(token) - 1];
      // 越界或重复的序号直接丢弃：模型返回值只能选中候选，不能引入任何新文本。
      if (candidate) picked.add(candidate.clause);
    }
    return picked;
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

import "server-only";

import type { CaseState } from "./diagnosis-types";
import { clinicalClausePolarity, type AssistedNegationClauses } from "./clinical-polarity";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { createTextModelClient, getControlledTerminologyModelConfig } from "./text-model";

/**
 * 口语否定增补：确定性正则判为阳性、但实际是口语否定的分句，交模型判一次。
 *
 * 实测确定性层的缺口（clinical-polarity.ts 的 71 条正则）：
 *   否认胸痛 / 无胸痛            → 正确判否定
 *   胸口不疼 / 早就不疼了         → 误判阳性
 *   哪有什么胸痛 / 胸痛这个倒是没有 → 误判阳性
 * 口语否定和口语症状一样穷举不完，继续加正则只是重走概念表的老路。
 *
 * ★ 三条安全边界 ★
 * 1. 单向：模型只能把「阳性」降为「否定」，不能把否定改成阳性。返回集合被
 *    affirmedClinicalText 当作否定覆盖层使用，反向改写在类型上就不存在。
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

/** 确定性层判为阳性、但带否定语气词的分句——只有这些需要模型裁决。 */
export function colloquialNegationCandidates(caseState: CaseState): string[] {
  const sources = [
    caseState.chiefComplaint,
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    ...Object.values(caseState.symptoms || {}).map((value) => (typeof value === "string" ? value : "")),
    ...(caseState.conversation || [])
      .filter((item) => item.role === "user")
      .map((item) => item.content),
  ].filter((value): value is string => Boolean(value && value.trim()));

  const seen = new Set<string>();
  for (const source of sources) {
    for (const raw of source.normalize("NFKC").split(CLAUSE_SPLIT)) {
      const clause = raw.trim();
      if (clause.length < 2 || clause.length > 40) continue;
      if (!COLLOQUIAL_NEGATION_CUE.test(clause)) continue;
      // 确定性层已经判为否定的分句无需再问；只补它漏掉的。
      if (clinicalClausePolarity(clause) === "negative") continue;
      seen.add(clause);
      if (seen.size >= MAX_CANDIDATES) return [...seen];
    }
  }
  return [...seen];
}

const SYSTEM_PROMPT = [
  "你判断中文病历分句是否在【否认或排除】某个症状/体征/病史。",
  "逐条回答，只输出被否认的分句序号，用英文逗号分隔，例如：1,3。若没有任何一条是否认，只输出 none。",
  "不要解释、不要复述原文、不要输出其他任何内容。",
  "判为否认的例子：胸口不疼；早就不疼了；哪有什么胸痛；胸痛这个倒是没有；谈不上头晕。",
  "不判为否认的例子：没精神（这是症状本身）；没力气；没胃口；不欲食；夜不能寐；食少纳呆。",
].join("\n");

/**
 * 返回被判定为口语否定的分句集合；不可用时返回空集（等于今天的确定性行为）。
 */
export async function assistedNegationClauses(
  caseState: CaseState,
  signal?: AbortSignal,
): Promise<AssistedNegationClauses> {
  const empty: AssistedNegationClauses = new Set<string>();
  if (!enabled() || signal?.aborted) return empty;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return empty;
  const candidates = colloquialNegationCandidates(caseState);
  if (candidates.length === 0) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const numbered = candidates
      .map((clause, index) => `${index + 1}. ${sanitizeFreeTextForModel(clause)}`)
      .join("\n");
    const client = createTextModelClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 64,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: numbered },
      ],
    }, { signal: controller.signal });
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || /none/i.test(raw)) return empty;
    const negated = new Set<string>();
    for (const token of raw.match(/\d+/g) || []) {
      const clause = candidates[Number(token) - 1];
      // 越界或重复的序号直接丢弃：模型返回值只能选中候选，不能引入任何新文本。
      if (clause) negated.add(clause);
    }
    return negated;
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

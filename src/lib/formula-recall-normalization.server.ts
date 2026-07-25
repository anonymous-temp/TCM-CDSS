import "server-only";

import type { CaseState } from "./diagnosis-types";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { affirmedClinicalText } from "./clinical-polarity";
import { createTextModelClient, getControlledTerminologyModelConfig } from "./text-model";

/**
 * 口语主诉 → 标准中医临床术语（仅用于候选召回的检索查询）。
 *
 * 为什么需要这一层：受控目录自带主治原文，确定性倒排索引已经能把「腰痛」「耳鸣」「水肿」
 * 召回到对证方（见 tcm-formula-indications.ts）。但主治原文写的是术语，医生和患者说的是口语——
 * 实测「睡不着觉」「腰杆子疼」「耳朵里嗡嗡响」「腿肿得厉害」全部零候选。临床口语无法穷举，
 * 手写同义词表只会重复概念表 39 条正则的老路，所以这一步交给模型做，而不是继续堆关键词。
 *
 * 安全边界（本模块的全部风险都收敛在这三条上）：
 *  1. 输出只当作**检索查询**。它不进入病历、不进入病历事实边界、不呈现给医生、不参与任何
 *     诊断或处方结论。模型即使编造术语，也只是多一个在受控主治语料里匹配不到的字符串。
 *  2. 召回是并集语义。多召回一个候选不会让任何方剂绕过身份锁——锁在下游独立校验主证候关联。
 *  3. 失败即降级为纯确定性召回（也就是今天的行为），绝不阻断 M03。因此这里是 fail-open 而非
 *     fail-closed：召回不是安全层，少给候选只是少给参考，不会放行任何不该放行的东西。
 *
 * 送模型前经 sanitizeFreeTextForModel 脱敏，且只取阳性表述——否定式主诉不应被翻译成阳性术语。
 */

const RECALL_TIMEOUT_MS = 6_000;
const MAX_INPUT_CHARS = 600;
const MAX_OUTPUT_CHARS = 200;

function enabled(): boolean {
  return process.env.FORMULA_RECALL_NORMALIZATION !== "false";
}

/** 阳性自由文本的紧凑拼接，与检索使用的事实口径一致。 */
function affirmedCaseText(caseState: CaseState): string {
  const parts = [
    caseState.chiefComplaint,
    caseState.tongue,
    caseState.pulse,
    ...(caseState.conversation || [])
      .filter((item) => item.role === "user")
      .map((item) => item.content),
  ]
    .map((value) => affirmedClinicalText(value))
    .filter((value): value is string => Boolean(value));
  return [...new Set(parts)].join("；").slice(0, MAX_INPUT_CHARS);
}

const SYSTEM_PROMPT = [
  "你是中医术语检索助手，只做一件事：把口语化的症状描述改写成《方剂学》主治条文使用的标准中医术语。",
  "只输出术语本身，用「、」分隔，不超过 12 个词；不要解释、不要辨证、不要给病名、不要给方名、不要输出任何标点以外的内容。",
  "只改写原文明确出现的阳性症状；原文没有的症状一律不得补充。原文否定或未提及的内容不得出现在输出中。",
  "示例：睡不着觉，老忘事 → 失眠、健忘；腰杆子疼，蹲下起来费劲 → 腰痛、腰膝酸软；耳朵里嗡嗡响 → 耳鸣。",
].join("\n");

/**
 * 返回可直接并入检索事实的标准术语串；不可用、超时、未配置或被禁用时返回空串（纯确定性召回）。
 */
export async function normalizeCaseTextForFormulaRecall(
  caseState: CaseState,
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled() || signal?.aborted) return "";
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return "";
  const source = affirmedCaseText(caseState);
  if (source.length < 4) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const client = createTextModelClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 128,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: sanitizeFreeTextForModel(source) },
      ],
    }, { signal: controller.signal });
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return "";
    // 只保留中文词与分隔符：模型若违反格式输出解释性文字，这里会把它压回术语串，
    // 匹配不到受控主治语料的内容自然不产生任何候选。
    return raw
      .replace(/[^一-龥、，,；;\s]/g, "")
      .replace(/[，,；;\s]+/g, "、")
      .slice(0, MAX_OUTPUT_CHARS)
      .trim();
  } catch {
    // 召回增强不可用时静默降级为确定性召回，不影响 M03 主链路。
    return "";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

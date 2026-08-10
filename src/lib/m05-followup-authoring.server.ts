import "server-only";

import type { CaseState } from "./diagnosis-types";
import { SIX_HEALTH_FOLLOWUP_DIMENSIONS } from "./tcm-followup-dimensions";
import { patientInstructionProhibitionsIn } from "./clinical-vocabulary";
import { PRECAUTION_DOSE_LIKE } from "./m04-proposal-compiler";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { createTextModelClient, getControlledTerminologyModelConfig, isDeepseekModel } from "./text-model";

/**
 * M05 临床内容的作者是模型，不是模板。
 *
 * 【改之前是什么样】M05 整段是拼出来的：
 *   · 「生活管理」是**一句写死的话**——「按本例非药物建议安排饮食、作息、情志和活动；
 *     不要自行叠加中药或中成药…」——寒证与湿热证的病人拿到的逐字相同；
 *   · 六维复评表 sixHealthFollowupTable() **无参数**，所有病人一模一样的六行；
 *   · 「评级依据」是三选一的三元式。
 * 逐例变化的只有从 M03/M04 事实里取的槽位（coreMetrics / firstReview / efficacyTrigger）。
 * 一个辨证论治系统，给风寒表实和湿热下注的病人发同一份调护，本身就是错的：
 * 寒证忌生冷、湿热忌肥甘、肝郁重情志、阴虚忌辛燥——这些恰恰是中医随访的价值所在。
 *
 * 【改之后谁拍板】
 *   · **安全结论仍是确定性的**：最高提示强度、综合风险判断、评级依据、医生需确认事项，
 *     全部来自灵犀处方后审方，模型碰不到。风险 verdict 不许模型写，这条不动。
 *   · **临床内容交给模型**：复诊评估重点、疗效评价口径、生活管理、六维里挑哪几维——
 *     这些要理解本例的证候与方药，是模型的活。
 *
 * 【模型说错了会怎样，谁接住】
 *   · 写出剂量/药名/指南引用 ⇒ 确定性校验驳回，整体回落今天的模板（逐字不变）。
 *   · 挑的维度不在受治理六维里 ⇒ 丢弃越界项；一个都不剩就回落全六维。
 *   · 超时/未配置/解析失败 ⇒ 返回 null，调用方使用原模板。
 *   · 模型只能**补充**这几个槽位，改不了安全总评、改不了随访时间轴、
 *     也删不掉「不要自行叠加中药或中成药，复诊时携带全部药物清单」这条固定安全句。
 */

const AUTHORING_TIMEOUT_MS = 12_000;
const GOVERNED_DIMENSIONS = SIX_HEALTH_FOLLOWUP_DIMENSIONS.map((item) => item.dimension);

/** 引用标记：证据绑定要求引用必须有 KB 条目背书。纯格式判据。 */
const CITATION_LIKE = /(?:doi|DOI|PMID|指南|共识|《[^》]{2,40}》\s*\d{4})/;

export type AuthoredFollowupContent = {
  reviewFocus: string;
  efficacyCriteria: string;
  lifestyle: string;
  dimensions: string[];
};

function clinicalContextForAuthoring(
  state: CaseState,
  syndrome: string,
  pathogenesis: string,
  therapy: string,
  herbs: readonly string[],
): string {
  return [
    `主诉：${sanitizeFreeTextForModel(state.chiefComplaint || "")}`,
    syndrome ? `证候：${sanitizeFreeTextForModel(syndrome)}` : "",
    pathogenesis ? `病机：${sanitizeFreeTextForModel(pathogenesis)}` : "",
    therapy ? `治法：${sanitizeFreeTextForModel(therapy)}` : "",
    herbs.length > 0 ? `处方药味：${herbs.map((herb) => sanitizeFreeTextForModel(herb)).join("、")}` : "",
    `可选复评维度（只能从中挑选，不得新增）：${GOVERNED_DIMENSIONS.join("、")}`,
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT = [
  "你是中医门诊随访方案的撰写者。根据本例的证候、病机、治法与处方，写出**针对这一例**的随访内容。",
  "只输出 JSON，字段固定为：",
  '{"reviewFocus":"复诊重点评估什么","efficacyCriteria":"疗效怎么判定算有效","lifestyle":"饮食/作息/情志/活动的调护","dimensions":["从可选复评维度里挑3到4个"]}',
  "",
  "写作要求：",
  "· 必须体现本例证候特点。寒证与湿热证的调护不该相同——寒证忌生冷、湿热忌肥甘厚味、",
  "  肝郁重情志疏导、阴虚忌辛燥熬夜、气虚忌过劳。写出这一例真正该注意的。",
  "· reviewFocus 与 efficacyCriteria 要指向本例的主症与舌脉，不要写放之四海皆准的话。",
  "· 每字段 30–120 字，中文，不分条不加标题。",
  "",
  "严禁：写任何剂量或药量；写让患者自行加减药、换方、停药；引用指南或文献；",
  "承诺疗效或给出预后断言；提及处方之外的药物。这些一经出现，整份输出会被服务端丢弃。",
].join("\n");

function validAuthoredText(value: unknown, min = 10, max = 200): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length < min || text.length > max) return "";
  // 剂量写法复用 M04 那条已导出的判据，不写第二份。
  if (PRECAUTION_DOSE_LIKE.test(text) || CITATION_LIKE.test(text)) return "";
  // 处方级动作与疗效承诺走**受治理禁述表**，不在代码里手写：
  // 这一层漏收一个词等于放行「可自行减量」，失败方向不安全，必须可审核可回归。
  if (patientInstructionProhibitionsIn(text).length > 0) return "";
  return text;
}

export async function authorFollowupClinicalContent(
  state: CaseState,
  input: {
    syndrome?: string;
    pathogenesis?: string;
    therapy?: string;
    herbs?: readonly string[];
  },
  signal?: AbortSignal,
): Promise<AuthoredFollowupContent | null> {
  if (process.env.M05_FOLLOWUP_AUTHORING === "false" || signal?.aborted) return null;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return null;
  const syndrome = String(input.syndrome || "").trim();
  // 证候是本层唯一的立足点：没有签名过的证候就写不出「针对这一例」的调护，
  // 那就没有比模板更好的输出，直接回落。
  if (!syndrome) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTHORING_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const client = createTextModelClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: "json_object" },
      ...(isDeepseekModel(config.model) ? {
        reasoning_effort: "low" as const,
        thinking: { type: "disabled" as const },
      } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: clinicalContextForAuthoring(
            state, syndrome,
            String(input.pathogenesis || ""), String(input.therapy || ""),
            (input.herbs || []).slice(0, 30),
          ),
        },
      ],
    }, { signal: controller.signal });
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const reviewFocus = validAuthoredText(parsed.reviewFocus, 12, 200);
    const efficacyCriteria = validAuthoredText(parsed.efficacyCriteria, 12, 200);
    const lifestyle = validAuthoredText(parsed.lifestyle, 12, 240);
    // 维度是受治理闭集：越界项直接丢弃，模型无法引入新维度。
    const dimensions = Array.isArray(parsed.dimensions)
      ? [...new Set(parsed.dimensions
        .map((item) => String(item || "").trim())
        .filter((item) => GOVERNED_DIMENSIONS.includes(item as (typeof GOVERNED_DIMENSIONS)[number])))]
      : [];

    // 三段临床内容缺任何一段都不采纳：半份模型内容 + 半份模板会读起来自相矛盾
    // （模板那半句「按本例非药物建议安排饮食作息」与模型那半段具体调护并列）。
    if (!reviewFocus || !efficacyCriteria || !lifestyle) return null;
    return {
      reviewFocus,
      efficacyCriteria,
      lifestyle,
      // 维度挑不出来就用全六维——那只是少一层裁剪，不影响正确性。
      dimensions: dimensions.length >= 2 ? dimensions : [...GOVERNED_DIMENSIONS],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

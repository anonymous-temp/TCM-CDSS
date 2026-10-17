import "server-only";

import { parseM02PlanFromContent } from "./m02-question-contract";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 模型写的追问题出题前再核一次：它要问的内容病历是不是已经写明了（2026-10-17）。
 *
 * 甲方标准病历 4 两次生成都问了一半已知的题（「胃脘部疼痛对冷热的反应及大便性状」，病历写着「大便溏结不调」；
 * 「疼痛的性质与按压反应」，病历写着「以胃脘胀痛为主」），留出例 S078、S079、S128 问的是病历已经写明的内容。
 * 甲方口径：追问不重复病历已写内容才算合格。
 *
 * 为什么用模型：选项与病历的字面重合判不出来——离线 289 道题里，评审判重复的几道与病历的字二元组包含率多为 0～0.4，
 * 与不重复的题混在一起（~/runlogs/deliver1017/qred）。做法与急症筛查题的可答性核对相同（MediQ：只提示「别重复」
 * 不够，要在出题后过滤）：让小模型只判这一件事，并交出病历原文，服务端逐字核对。
 *
 * 边界：
 *  · 只核模型写的题；服务端自有的兜底题、基本问诊题、急症筛查题不经这里（急症筛查题另有 m02-risk-question-answerability）；
 *  · 判 answered（病历已写明）或 partly（题干问了几件事、其中一件病历已写明）且每条引文都逐字在病历里，才删这道题，
 *    之后与确定性删题同一条路：计划删空时按「不需要再问」处理（允许 proceed 时直接 proceed，否则出服务端的基本问诊题）；
 *  · 超时、未配置、输出非法都当没有重复（照常出题），失败结果不缓存。
 * 开关：CDSS_M02_QUESTION_REDUNDANCY_CHECK=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M02_QUESTION_REDUNDANCY_TIMEOUT_MS || 4_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 4_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_M02_QUESTION_REDUNDANCY_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

const SYSTEM = [
  "你是追问题与病历的重复核对器，不负责评价这道题问得好不好。",
  "给你一份门诊病历和一道准备让医生问患者的追问题（题干与各选项）。只判断一件事：这道题要问的内容，病历里是不是已经写明了。",
  "- answered：题干要问的内容病历已经写明（包括写明没有、写明相反情况）；或某个选项基本就是病历已经写过的话，医生照病历就能直接选出答案。",
  "- partly：题干同时问了两件以上的事，其中至少一件病历已经写明，另一件没有。",
  "- not_answered：题干要问的内容病历没有写，或只写了与之无关的内容。",
  "注意：病历写了“主症是什么”不等于写了“主症在冷热、按压、时间等方面的特点”；只看题干实际问的那几件事。",
  // 2026-10-17 第四轮复测：病历 5「平时最困扰的是气短自汗，还是食少胃胀」（两组都是病历原话）、病历 9「风团颜色偏鲜红还是淡白」
  //（病历写着红色风团）独立评审判重复，第一版判 not_answered。离线 329 题新增 4 处判 partly，均合理（~/runlogs/deliver1017/qred/v2.json）。
  "以下也算 partly：各选项列的表现病历里都已经写了、题干只问哪一组更突出或以哪一组为主；题干同时问的几项特征里，有一项病历已经写明（如问风团颜色，病历写着红色风团）。",
  "拿不准时判 not_answered。",
  "answered 或 partly 时给出 quotes：病历里写明该内容的原文片段（逐字复制，每条不超过40字，1–3条）和 reason（≤30字）。",
  "只输出 JSON：{\"verdict\":\"answered|partly|not_answered\",\"quotes\":[\"…\"],\"reason\":\"…\"}",
].join("\n");

/** 模型输出 → 这道题是否复述了病历。只有 answered / partly、1–3 条引文且每条都逐字在病历里时为 true。 */
export function recordRepeatsQuestion(content: unknown, recordText: string): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const { verdict, quotes } = parsed as { verdict?: unknown; quotes?: unknown };
  if (verdict !== "answered" && verdict !== "partly") return false;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 3) return false;
  const record = compact(recordText);
  return quotes.every((quote) => {
    const text = typeof quote === "string" ? compact(quote) : "";
    return text.length >= 2 && text.length <= 60 && record.includes(text);
  });
}

async function questionRepeatsRecord(
  input: { recordText: string; question: string; options: string[] },
  signal?: AbortSignal,
): Promise<boolean> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return false;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim() || !input.question.trim()) return false;
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify({ record: recordText, question: input.question, options: input.options }) },
  ];
  return memoizedSmallTask<boolean>("m02_question_redundancy", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m02_question_redundancy", stage: "question", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 200,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: recordRepeatsQuestion(content, recordText), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: false, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, false, signal);
}

/**
 * 计划里复述病历的模型题的 id。serverOwnedText 是本轮服务端自有题的全文（兜底题、基本问诊题），
 * 题干出现在其中的不核。
 */
export async function questionIdsRepeatingRecord(
  content: string,
  recordText: string,
  serverOwnedText: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!enabled() || signal?.aborted) return [];
  const plan = parseM02PlanFromContent(content);
  if (!plan || plan.decision !== "ask") return [];
  const owned = compact(serverOwnedText);
  const ids: string[] = [];
  for (const question of plan.questions.slice(0, 2)) {
    const stem = compact(question.question);
    if (!stem || owned.includes(stem)) continue;
    const options = question.options.filter((option) => option.kind === "clinical_fact").map((option) => option.answer);
    if (await questionRepeatsRecord({ recordText, question: question.question, options }, signal)) ids.push(question.id);
  }
  return ids;
}

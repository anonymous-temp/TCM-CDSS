import "server-only";

import source from "../data/redflag-discriminators.source.json";
import { quoteHasCurrentOccurrence } from "./clinical-facts";
import { clauseLocalMentionPolarityAt } from "./diagnosis-safety";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { discriminatorTextConceptsForPatient, type DiscriminatorPatient, type DiscriminatorScreen } from "./redflag-discriminators";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { alignQuoteToSource } from "./source-quote-alignment";
import { allergenScreenConcepts } from "./allergen-profile";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelConfigForModel, textModelRequestTuning, type TextModelConfig } from "./text-model";

/**
 * 指南红旗判别项的读病历小任务（2026-10-26 第二十一轮；判别项表与闸门处置见 redflag-discriminators.ts）。
 *
 * 只做一件事：给出这一年龄段要判的判别项（每项带中文定义与「不算」的写法），模型逐项判病历里有没有，有的给逐字引文。
 * 两家模型同时发（deepseek-flash 与 qwen3.8-flash，不同厂商），有一家答了就算完成，阳性取并集——一家超时或漏读，另一家补上；
 * 两家都失败才是 unavailable，闸门据此给医生列当面核对清单。引文要能对回病历原文，而且是患者本人此刻的肯定提及，否则丢弃。
 * 结果只会让闸门多报红旗或多一项当天评估，从不撤销任何已有判断。开关 CDSS_REDFLAG_DISCRIMINATOR_SCREEN=false。
 */
const SCREEN_TIMEOUT_MS = (() => {
  const value = Number(process.env.REDFLAG_DISCRIMINATOR_SCREEN_TIMEOUT_MS || 9_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 20_000 ? Math.round(value) : 9_000;
})();
const SECOND_MODEL = (process.env.REDFLAG_DISCRIMINATOR_SECOND_MODEL || "qwen3.8-flash").trim();

export function redflagDiscriminatorScreenEnabled(): boolean {
  return process.env.CDSS_REDFLAG_DISCRIMINATOR_SCREEN !== "false";
}

type ConceptDefinition = { conceptId: string; labelZh: string; definitionZh: string; notCountZh?: string };
const DEFINITIONS = (() => {
  const map = new Map<string, ConceptDefinition>();
  for (const item of (source as { contextConcepts: ConceptDefinition[] }).contextConcepts) map.set(item.conceptId, item);
  for (const row of (source as { discriminators: Array<ConceptDefinition & { kind: string }> }).discriminators) {
    if (row.kind !== "text" || map.has(row.conceptId)) continue;
    map.set(row.conceptId, { conceptId: row.conceptId, labelZh: row.labelZh, definitionZh: row.definitionZh, notCountZh: row.notCountZh });
  }
  return map;
})();

const QUOTE_ANCHORS = new Map(Object.entries((source as { quoteAnchors?: { byConcept?: Record<string, string[]> } }).quoteAnchors?.byConcept || {}));
const NEGATION_INTRINSIC = new Set((source as { negationIntrinsicConcepts?: { conceptIds?: string[] } }).negationIntrinsicConcepts?.conceptIds || []);

export function buildRedflagDiscriminatorRequest(recordText: string, patient: DiscriminatorPatient): {
  messages: Array<{ role: "system" | "user"; content: string }>;
  concepts: string[];
} | undefined {
  if (!recordText.trim()) return undefined;
  // 同一次读病历顺带读过敏（患者约束档案，第二十一轮）：每类一个「对X过敏」概念，不另开一次模型调用。
  const allergyConcepts = allergenScreenConcepts();
  const concepts = [...discriminatorTextConceptsForPatient(patient).filter((id) => DEFINITIONS.has(id)), ...allergyConcepts.map((item) => item.id)];
  const items = [
    ...concepts.filter((id) => DEFINITIONS.has(id)).map((id) => {
      const item = DEFINITIONS.get(id)!;
      return { id, 名称: item.labelZh, 算: item.definitionZh, ...(item.notCountZh ? { 不算: item.notCountZh } : {}) };
    }),
    ...allergyConcepts.map((item) => ({ id: item.id, 名称: item.labelZh, 算: item.definitionZh, 不算: item.notCountZh })),
  ];
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是门诊病历的判别项核对器，只判断清单里每一项在病历里有没有，不做诊断、不给建议。",
        "规则：",
        "1. 只看患者本人、本次病程中此刻存在的情况；被否认的（无、否认、未见）、既往已好的、只是问过还没回答的（是否…、有无…、尚未询问）、别人的情况，都不算有。家属、家长或陪诊者转述的患者情况（家属诉患者…、家长说孩子…）算患者本人的。",
        "2. 舌象、脉象是中医四诊记录：舌有瘀斑、舌边瘀点、舌质紫暗不算皮肤的瘀斑瘀点或发绀。",
        "3. 「算」「不算」按清单里写的定义判；病历没写到或写得不足以判断的，不要列出。",
        "4. 列出的每一项都给 quote：从病历里逐字复制最短的一段连续原文，能单独说明这一项。",
        "只输出 JSON：{\"present\":[{\"id\":\"清单里的 id\",\"quote\":\"病历原文\"}]}；一项都没有时 present 为空数组。不要解释。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { ageMonths: patient.ageMonths ?? null, pregnant: Boolean(patient.pregnant) },
        record: recordText,
        checklist: items,
      }),
    },
  ];
  return { messages, concepts };
}

/** 解析并落地：id 必须在清单里；引文对回病历原文、是患者本人此刻的肯定提及。 */
export function parseRedflagDiscriminatorScreen(content: unknown, concepts: readonly string[], recordText: string): Array<{ conceptId: string; quote: string }> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  const list = parsed && typeof parsed === "object" ? (parsed as { present?: unknown }).present : undefined;
  if (!Array.isArray(list)) return undefined;
  const allowed = new Set(concepts);
  const out: Array<{ conceptId: string; quote: string }> = [];
  for (const raw of list.slice(0, 30)) {
    const item = raw && typeof raw === "object" ? raw as { id?: unknown; quote?: unknown } : undefined;
    const conceptId = typeof item?.id === "string" ? item.id.trim() : "";
    const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
    if (!allowed.has(conceptId) || quote.length < 2 || quote.length > 120) continue;
    // 语境判在引文终点（中文短语的中心词在尾部：「家属诉患者此刻仍在抽搐」判「抽搐」，不判「家属」），只看所在分句。
    // 「无尿」「叫不醒」「对呼唤无反应」这类本身就是「没有」的发现，否认词是发现的一部分：源表 negationIntrinsicConcepts 里的只排除未问及与他人。
    const absenceFinding = NEGATION_INTRINSIC.has(conceptId);
    const aligned = alignQuoteToSource(quote, recordText);
    if (!aligned) continue;
    // 界限能落在字面上的判别项（源表 quoteAnchors）：引文须出现规定字样之一。
    const anchors = QUOTE_ANCHORS.get(conceptId);
    if (anchors && !anchors.some((anchor) => aligned.span.includes(anchor))) continue;
    const polarity = clauseLocalMentionPolarityAt(recordText, Math.max(aligned.start, aligned.end - 1));
    if (polarity === "excluded" || (polarity === "negated" && !absenceFinding)) continue;
    if (!absenceFinding && !quoteHasCurrentOccurrence(recordText, aligned.span)) continue;
    if (!out.some((existing) => existing.conceptId === conceptId)) out.push({ conceptId, quote: aligned.span });
  }
  return out;
}

async function screenWithModel(
  config: TextModelConfig,
  request: NonNullable<ReturnType<typeof buildRedflagDiscriminatorRequest>>,
  recordText: string,
  signal?: AbortSignal,
): Promise<Array<{ conceptId: string; quote: string }> | undefined> {
  if (!config.configured) return undefined;
  return memoizedSmallTask<Array<{ conceptId: string; quote: string }> | undefined>(
    "redflag_discriminator_screen",
    smallTaskMemoKey([config.model, request.messages]),
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SCREEN_TIMEOUT_MS);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await observeModelTask({ task: "redflag_discriminator_screen", stage: "shared", model: config.model }, () =>
          createTextModelClient(config).chat.completions.create({
            model: config.model,
            temperature: 0,
            max_tokens: 400,
            stream: false,
            response_format: { type: "json_object" },
            ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
            messages: request.messages,
          }, { signal: controller.signal }));
        const value = parseRedflagDiscriminatorScreen(response.choices[0]?.message?.content, request.concepts, recordText);
        return { value, cacheable: value !== undefined };
      } catch {
        return { value: undefined, cacheable: false };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    undefined,
  );
}

/** 两家同发、取并集。recordText 用事实层同一份投影（已脱敏）。 */
export async function runRedflagDiscriminatorScreen(
  recordText: string,
  patient: DiscriminatorPatient,
  signal?: AbortSignal,
): Promise<DiscriminatorScreen | undefined> {
  if (!redflagDiscriminatorScreenEnabled()) return undefined;
  const request = buildRedflagDiscriminatorRequest(recordText, patient);
  if (!request) return undefined;
  const configs = [getControlledTerminologyModelConfig(), textModelConfigForModel(SECOND_MODEL)]
    .filter((config, index, all) => config.configured && all.findIndex((other) => other.model === config.model) === index);
  if (configs.length === 0) return { status: "unavailable", present: [] };
  const results = await Promise.all(configs.map((config) => screenWithModel(config, request, recordText, signal)));
  const answered = results.filter((value): value is Array<{ conceptId: string; quote: string }> => value !== undefined);
  if (answered.length === 0) return { status: "unavailable", present: [], models: configs.map((config) => config.model) };
  const present: Array<{ conceptId: string; quote: string }> = [];
  for (const item of answered.flat()) {
    if (!present.some((existing) => existing.conceptId === item.conceptId)) present.push(item);
  }
  console.info("[tcm-cdss:telemetry] redflag_discriminator_screen", {
    models: configs.map((config) => config.model),
    answered: answered.length,
    present: present.map((item) => item.conceptId),
  });
  return { status: "checked", present, models: configs.map((config) => config.model) };
}

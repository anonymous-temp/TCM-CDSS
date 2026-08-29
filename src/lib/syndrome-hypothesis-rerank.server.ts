import "server-only";

import type { AssistedNegationClauses } from "./clinical-polarity";
import type { CaseState } from "./diagnosis-types";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import {
  formulaSyndromeHypothesisPool,
  SYNDROME_HYPOTHESIS_RERANK_POOL_LIMIT,
} from "./tcm-formula-indications";
import {
  parseClosedSetSyndromeHypothesisRerank,
  type SyndromeHypothesisRerankDecision,
} from "./tcm-syndrome-hypothesis";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

const RERANK_TIMEOUT_MS = 6_000;
const MAX_FACT_CHARS = 600;
const MAX_RERANK_DECISIONS = 8;

function enabled(): boolean {
  return process.env.SYNDROME_HYPOTHESIS_RERANK !== "false";
}

export function getSyndromeHypothesisRerankStatus() {
  const config = getControlledTerminologyModelConfig();
  return {
    layer: "L1b",
    enabled: enabled(),
    configured: config.configured,
    provider: config.providerLabel,
    model: config.model,
    candidatePoolLimit: SYNDROME_HYPOTHESIS_RERANK_POOL_LIMIT,
    maximumScoreBoost: 0.2,
    timeoutMs: RERANK_TIMEOUT_MS,
    failurePolicy: "fallback_to_deterministic_l1a",
  };
}

/**
 * L1b：只在 L1a 已生成的受控证候 ID 闭集内判断“哪些假设更值得优先检索”。
 *
 * 输出不会写入病历、不会展示给医生，也不能直接锁方；下游只把有效相关度换算成最多 +20%
 * 的检索分加权。超时、未配置、候选为空或输出非法时返回空数组，严格保持 L1a 原行为。
 */
export async function rerankSyndromeHypothesesForFormulaRecall(
  caseState: CaseState,
  assistedNegations?: AssistedNegationClauses,
  signal?: AbortSignal,
): Promise<SyndromeHypothesisRerankDecision[]> {
  if (!enabled() || signal?.aborted) return [];
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return [];

  const { facts, hypotheses } = formulaSyndromeHypothesisPool(caseState, assistedNegations);
  if (facts.length === 0 || hypotheses.length < 2) return [];
  const candidateIds = new Set(hypotheses.map((item) => item.syndromeId));
  const source = sanitizeFreeTextForModel([...new Set(facts)].join("；").slice(0, MAX_FACT_CHARS));
  if (source.length < 4) return [];

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  try {
    const response = await observeModelTask({ task: "syndrome_rerank", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
      model: config.model,
      temperature: 0,
      max_tokens: 500,
      stream: false,
      response_format: { type: "json_object" },
      ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
      messages: [
        {
          role: "system",
          content: [
            "你是中医检索候选闭集重排器，不负责诊断、处方或安全判断。",
            "只能复制候选中的 syndromeId；不得生成候选外术语，不得添加患者事实，不得给方名。",
            "relevance 仅表示该候选与已给阳性事实的检索相关度，范围 0 到 1；不确定时省略该候选。",
            `按相关度从高到低最多返回 ${MAX_RERANK_DECISIONS} 条，不得把全部候选照抄进结果。`,
            "只输出 JSON：{\"rankings\":[{\"syndromeId\":\"候选ID\",\"relevance\":0.0}]}，不要解释。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            affirmedFacts: source,
            candidates: hypotheses.map((item) => ({
              syndromeId: item.syndromeId,
              canonical: item.canonical,
              deterministicMatchedAxes: item.matchedAxes,
              deterministicCoverage: Number(item.coverage.toFixed(4)),
            })),
          }),
        },
      ],
    }, { signal: controller.signal }));
    return parseClosedSetSyndromeHypothesisRerank(
      response.choices[0]?.message?.content,
      candidateIds,
    )
      .sort((left, right) => right.relevance - left.relevance || left.syndromeId.localeCompare(right.syndromeId))
      .slice(0, MAX_RERANK_DECISIONS);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

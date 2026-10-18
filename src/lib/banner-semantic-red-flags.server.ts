import "server-only";

import { maybeAttachClinicalFactsBackstop } from "./clinical-facts-runtime";
import { withSafetyGate } from "./diagnosis-safety";

/**
 * 确定性红旗病例的横幅补充：语义事实层判出的红旗（中毒、循环灌注不足…）。不绑在请求的中止信号上（算完写进事实缓存，开方阶段还要用），
 * 等待上限 1.5 秒；超时、失败一律返回空数组，横幅照旧只列确定性红旗。
 */
const BANNER_SEMANTIC_WAIT_MS = 1_500;
export async function semanticRedFlagsForBanner(state: Parameters<typeof withSafetyGate>[0]): Promise<string[]> {
  const pending = maybeAttachClinicalFactsBackstop(state)
    .then((withFacts) => withSafetyGate(withFacts).safetyGate?.redFlags || [])
    .catch(() => [] as string[]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), BANNER_SEMANTIC_WAIT_MS); });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

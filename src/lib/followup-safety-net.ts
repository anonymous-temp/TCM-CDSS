const FOLLOWUP_ACTION = /(?:复诊|就诊|急诊|转诊|现场评估|联系(?:医生|医疗机构)|拨打急救电话|复评|复查)/;
const FOLLOWUP_TRIGGER = /(?:若|如|一旦|当|出现|发生|持续|加重|恶化|不缓解|无改善|复发|改变|变化|突发|完成|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:小时|天|日|周|月|剂)后?)/;

export const DEFAULT_ACTIONABLE_FOLLOWUP_SAFETY_NET =
  "若主要症状持续不缓解、明显加重或出现新的异常表现，请及时复诊；如出现突发剧烈症状、意识改变、呼吸困难、活动性出血或新发神经功能异常，应立即急诊评估。";

/**
 * A safety net is only actionable when it contains both a patient-facing action and a concrete
 * trigger or time boundary. A restatement such as “病历已记录头痛阳性” is clinical context, not a
 * follow-up plan.
 */
export function isActionableFollowupSafetyNet(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length >= 10 && FOLLOWUP_ACTION.test(text) && FOLLOWUP_TRIGGER.test(text);
}

export function ensureActionableFollowupSafetyNet(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (isActionableFollowupSafetyNet(text)) return text;
  return [text, DEFAULT_ACTIONABLE_FOLLOWUP_SAFETY_NET].filter(Boolean).join(" ");
}

/**
 * M03 safety-net wording is a server-owned care boundary, not a diagnostic inference. Normalize it
 * before structural validation and independent review so an otherwise valid diagnosis cannot burn
 * repeated model repairs merely because a follow-up sentence omitted its action or trigger. The
 * transform is sentinel-scoped, preserves every other clinical field and is idempotent.
 */
export function applyActionableFollowupSafetyNetContract(content: string): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        const rawManagement = parsed.management;
        const management = rawManagement && typeof rawManagement === "object" && !Array.isArray(rawManagement)
          ? rawManagement as Record<string, unknown>
          : {};
        parsed.management = {
          ...management,
          followupSafetyNet: ensureActionableFollowupSafetyNet(management.followupSafetyNet),
        };
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

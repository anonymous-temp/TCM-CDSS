import { isDisplayableClinicalText } from "./diagnosis-client-guards";

/**
 * 展示层的临床依据排序（甲方 2026-08-10 ②）。
 *
 * 这段判据此前**整段写在 DiagnosisClient.tsx 里**，只被一张 React 卡片消费；
 * 服务端可见 Markdown 与 HIS 方案两个出口读的是同一份签名载荷，却各自把原始
 * syndromeEvidence 直接印出去。同一件事在一处做对、在另外两处没做——
 * 这是本仓库反复出现的缺陷形状（见 CLAUDE.md 的「同一判据两处各写各的」）。
 *
 * 上提到 lib 后三个出口消费同一个导出函数。函数本身一个字未改：它只**排序与筛选**
 * 已签名载荷里已经选定的事实，从不创造新的临床事实。
 */
const TCM_DISCRIMINATING_EVIDENCE =
  /(?:舌|苔|脉|痰(?:白|黄|清|稀|稠|黏|粘|泡沫|带血)|(?:白|黄|清|稀|稠|黏|粘|泡沫|带血)[^，,。；;]{0,3}痰|流清涕|流黄涕|鼻涕清|鼻涕黄|无汗|自汗|盗汗|恶寒|寒战|口渴|口不渴|咽痒|咽痛|胸闷|喘鸣|便溏|便秘|尿黄|夜尿|经量|带下|喜按|拒按|刺痛|灼痛|冷痛|浮紧|浮数|弦细|滑数)/;
const GENERIC_COMPLAINT_WITH_DURATION =
  /^(?:反复|持续|间断|阵发)?(?:咳嗽|头痛|头晕|失眠|腹痛|腹胀|乏力|心悸|胸闷|纳差|便秘|腹泻|发热|疼痛)(?:伴[^，,。；;]{0,6})?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)?(?:余)?(?:天|日|周|月|年)?$/;
const NONDISCRIMINATING_DISPLAY_FACT_PART =
  /^(?:(?:患者|本例|目前|当前)?(?:一般情况|生命体征)(?:平稳|正常|无异常)|神清|精神可|面色正常|纳可|纳眠可|食欲正常|睡眠正常|二便正常|大小便正常|大便正常|小便正常|饮食睡眠(?:可|正常)|无特殊不适|未见明显异常|不限定)$/;

export function clinicalEvidenceFingerprint(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。；;：:、+（）()[\]【】"'“”‘’]+/g, "").toLowerCase();
}


function isNondiscriminatingDisplayFact(value: string): boolean {
  const parts = value.split(/[，,、；;。]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => NONDISCRIMINATING_DISPLAY_FACT_PART.test(part));
}

/**
 * Presentation-only prioritization of facts the signed M03 result already selected.
 * It never creates a new clinical fact: candidates must come from primarySyndromeBasis,
 * grounded symptom clusters, or grounded pathogenesis-chain facts. A generic chief complaint
 * such as “咳嗽3天” remains available only when no more discriminating selected fact exists.
 */
export function prioritizeTcmEvidenceForDisplay(
  primaryFacts: readonly string[],
  alternativeFacts: readonly string[],
  chiefComplaint: string,
  limit = 5,
): string[] {
  const chiefFingerprint = clinicalEvidenceFingerprint(chiefComplaint);
  const seen = new Set<string>();
  const ranked = [...primaryFacts, ...alternativeFacts].flatMap((raw, order) => {
    const fact = raw.trim();
    const fingerprint = clinicalEvidenceFingerprint(fact);
    if (
      !fact ||
      !fingerprint ||
      seen.has(fingerprint) ||
      !isDisplayableClinicalText(fact) ||
      isNondiscriminatingDisplayFact(fact)
    ) return [];
    seen.add(fingerprint);
    const isChiefRestatement = Boolean(chiefFingerprint) &&
      (fingerprint === chiefFingerprint || (fingerprint.length >= 4 && chiefFingerprint === fingerprint.replace(/(?:余)?(?:天|日|周|月|年)$/, "")));
    const score =
      (TCM_DISCRIMINATING_EVIDENCE.test(fact) ? 120 : 0) +
      (/[，,。；;+]/.test(fact) ? 20 : 0) +
      Math.min(fingerprint.length, 30) -
      (isChiefRestatement ? 300 : 0) -
      (GENERIC_COMPLAINT_WITH_DURATION.test(fact) ? 100 : 0);
    return [{ fact, fingerprint, order, score, isChiefRestatement }];
  });
  if (ranked.length === 0) return [];
  const hasSpecificAlternative = ranked.some((item) => !item.isChiefRestatement && item.score > 0);
  return ranked
    .filter((item) => !hasSpecificAlternative || !item.isChiefRestatement)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.max(1, limit))
    .map((item) => item.fact);
}

export function prioritizeWesternEvidenceForDisplay(facts: readonly string[], limit = 5): string[] {
  const seen = new Set<string>();
  return facts.flatMap((raw) => {
    const fact = raw.trim();
    const fingerprint = clinicalEvidenceFingerprint(fact);
    if (
      !fact ||
      !fingerprint ||
      seen.has(fingerprint) ||
      !isDisplayableClinicalText(fact) ||
      isNondiscriminatingDisplayFact(fact)
    ) return [];
    seen.add(fingerprint);
    return [fact];
  }).slice(0, Math.max(1, limit));
}

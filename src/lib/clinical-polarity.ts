export type ClinicalClausePolarity = "affirmed" | "negative" | "uncertain";
export type ClinicalEventTemporalScope = "current" | "historical" | "historical_resolved";

const NEGATIVE_PREFIX = /^(?:(?:患者|病人|本人|既往|目前|当前|现阶段|本次|既往史|过敏史|用药史)\s*[：:]?\s*)?(?:否认|不是(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|并非(?!很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|不曾|没有|并无|未见|未发现|未提示|未诊断|未患|未(?:服用|使用|口服|应用)|暂(?:不|未)(?:服用|使用|口服|应用|吃)|没(?:有)?(?:服用|使用|吃)|从未|无(?!菌性|痛性|症状性|创性|脉性|意识性)|暂无(?:明确)?|已排除|已除外)/;
// Colloquial history commonly uses the aspect marker “过” instead of a formal “否认/未见”,
// for example “没吐过血” or “没有晕厥过”. Requiring the aspect marker keeps this boundary
// narrow enough that affirmative negative-form symptoms such as “没精神/没力气/没胃口” remain
// symptoms rather than being silently discarded as denials.
const COLLOQUIAL_PAST_EVENT_NEGATION = /^(?:(?:患者|病人|本人|既往|目前|当前|现阶段|本次)\s*[：:]?\s*)?(?:没|没有)[^，,。；;\n]{1,32}过[^，,。；;\n]{0,16}$/;
const BARE_NO_HISTORY = /^无(?!菌性|痛性|症状性|创性|脉性|意识性)[^。；;\n]{0,48}(?:病史|过敏史|用药史|功能不全|功能异常|异常|过敏|用药|服药)$/;
const NEGATIVE_SUFFIX = /(?:已排除|已除外|检查阴性|未见(?:明显)?异常|未发现(?:明显)?异常|不支持|不考虑)$/;
const POSTFIX_NEGATIVE = /(?:病史|过敏史|用药史|功能不全|功能异常|过敏|用药|服药)\s*[：:]?\s*(?:无|否认|没有|并无|未见|未发现|未患)$/;
const UNCERTAIN_CUE = /(?:待排(?:除)?|待查|待明确|待核实|可能|疑似|不能排除|无法排除|尚不明确|不详|未知|未提供|未采集|未询问|说不清)/;
const DISCOURSE_PREFIX = /^(?:但|但是|然而|不过|而|另有|同时)\s*/;
const AFFIRMED_ASSERTION_PREFIX = /^(?:(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:小时|天|日|周|月|年)前\s*)?(?:既往|当前|目前|现阶段|本次|今日|今天|今晨|今早|昨夜|昨晚|昨日|近来|近期)?\s*(?:有|是|转为|突发|新发|出现|发生|排出|患有|确诊|诊断为|现服|正在服用|开始服用|开始口服|开始使用|新启用|新开|启用|加用|改用|服用|使用|口服|应用|对)/;
const AFFIRMED_PREDICATE = /(?:不是|并非)(?:很|太|特别|十分|非常|明显|严重|剧烈|轻|重|持续|一直)|(?:持续|反复|仍有|仍感|依然|存在|加重|恶化|发作|出现|发生|阳性|异常|过敏|服用|口服|使用)|以[^，,。；;\n]{1,16}为主|(?:已|约)?\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半数几多]+)\s*(?:分钟|分|小时|天|日|周|月|年)/;

function normalizedClinicalText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

const HISTORICAL_TEMPORAL_CUE_SOURCE = String.raw`(?:既往|曾经|曾有|此前|过去|当时|小时候|幼时|上次|入院时|术前|治疗前|发作时|一度|昨日|昨天|前天|上周|上月|去年|前年|多年前|(?:\d+|[一二两三四五六七八九十半数几多]+)\s*(?:年|个月|月|周|天|日)前|(?<!现)病史)`;
const CURRENT_TEMPORAL_CUE_SOURCE = String.raw`(?:本次|本轮|当前|目前|现在|今日|今天|今晨|今早|刚刚|刚才|方才|昨日起|昨日(?:起|开始)|昨天(?:起|开始)|昨夜开始|昨晚开始|新发|再发|复发|又发|又有)`;

function lastMatchIndex(value: string, source: string): number {
  let last = -1;
  for (const match of value.matchAll(new RegExp(source, "g"))) last = match.index ?? last;
  return last;
}

function hasAffirmedCurrentRecurrence(value: string): boolean {
  for (const match of value.matchAll(new RegExp(`${CURRENT_TEMPORAL_CUE_SOURCE}[^。；;\\n]{0,14}(?:再次|再度|又)?(?:再发|复发|发作|出现|发生)`, "g"))) {
    if (!/(?:无|未|否认|没有)[^。；;\n]{0,6}(?:再发|复发|发作|出现|发生)/.test(match[0])) return true;
  }
  if (/(?:持续至今|至今仍|目前仍|当前仍|现在仍|仍在持续|尚未缓解|仍未缓解|没有缓解|无缓解)/.test(value)) return true;
  return false;
}

/**
 * Classifies the patient event at `index` without letting a historical cue leak across a hard clause.
 * `eventLength` lets callers recognize postfix forms such as “胸痛发生在上周”.
 */
export function clinicalEventTemporalScopeAt(
  value: string,
  index: number,
  eventLength = 0,
): ClinicalEventTemporalScope {
  const normalized = value.normalize("NFKC").replace(/\r\n?/g, "\n");
  const safeIndex = Math.max(0, Math.min(index, normalized.length));
  const hardStart = Math.max(
    normalized.lastIndexOf("。", safeIndex - 1),
    normalized.lastIndexOf("；", safeIndex - 1),
    normalized.lastIndexOf(";", safeIndex - 1),
    normalized.lastIndexOf("\n", safeIndex - 1),
  ) + 1;
  const endCandidates = ["。", "；", ";", "\n"]
    .map((mark) => normalized.indexOf(mark, safeIndex + Math.max(0, eventLength)))
    .filter((position) => position >= 0);
  const hardEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : normalized.length;
  const before = normalized.slice(hardStart, safeIndex);
  const afterEvent = normalized.slice(Math.min(hardEnd, safeIndex + Math.max(0, eventLength)), hardEnd);

  const lastHistorical = lastMatchIndex(before, HISTORICAL_TEMPORAL_CUE_SOURCE);
  const lastCurrent = lastMatchIndex(before, CURRENT_TEMPORAL_CUE_SOURCE);
  const postfixHistorical = new RegExp(
    `^(?:\\s*(?:发生|发作|出现|起病|开始)?\\s*(?:于|在|是)?\\s*)${HISTORICAL_TEMPORAL_CUE_SOURCE}`,
  ).test(afterEvent);
  const historical = lastHistorical > lastCurrent || postfixHistorical;
  if (!historical) return "current";

  if (hasAffirmedCurrentRecurrence(afterEvent)) return "current";

  const resolved =
    /(?:(?:之后|以后|随后|后来)|(?:(?:经[^，,。；;\n]{0,12})?(?:治疗|处理|休息|用药|吸氧)后))?\s*(?:现已|目前已|当前已|已经|已)?\s*(?:完全|明显|基本|逐渐|自行)?\s*(?:缓解|消失|好转|改善|恢复|稳定|痊愈)/.test(afterEvent) ||
    /(?:无再发|未再发|没有再发|不再发作|未再出现)/.test(afterEvent) ||
    /(?:目前|当前|现在|今日|今天|现)[^。；;\n]{0,20}(?:否认|无|没有|未见|无再发|未再发|未出现|无不适)/.test(afterEvent) ||
    /(?:本次|当前|现在|今日|今天|复测|复查|再测)[^。；;\n]{0,28}(?:复测|复查|测得|测量|结果|为)?[^。；;\n]{0,12}\d/.test(afterEvent);
  return resolved ? "historical_resolved" : "historical";
}

export function clinicalClausePolarity(value: string): ClinicalClausePolarity {
  const clause = normalizedClinicalText(value)
    .replace(DISCOURSE_PREFIX, "")
    .trim();
  if (!clause) return "uncertain";
  if (NEGATIVE_PREFIX.test(clause) || COLLOQUIAL_PAST_EVENT_NEGATION.test(clause) || BARE_NO_HISTORY.test(clause) || NEGATIVE_SUFFIX.test(clause) || POSTFIX_NEGATIVE.test(clause)) return "negative";
  if (UNCERTAIN_CUE.test(clause)) return "uncertain";
  return "affirmed";
}

/**
 * Returns affirmed text as exact substrings of the supplied clinical source. This companion to
 * `affirmedClinicalText` deliberately preserves the caller's punctuation and wording, so patient
 * evidence can be projected into signed/visible contracts without presenting a normalized or
 * provider-joined reconstruction as a verbatim chart quote.
 */
export function affirmedClinicalSourceClauses(value: string | null | undefined): string[] {
  const source = value?.replace(/\r\n?/g, "\n").trim() || "";
  if (!source) return [];

  const parts = source.split(/([，,、。；;\n]+)/);
  const clauses: string[] = [];
  let inheritedPolarity: ClinicalClausePolarity | undefined;
  let previousWasAffirmed = false;

  for (let index = 0; index < parts.length; index += 2) {
    const separator = index === 0 ? "" : parts[index - 1];
    const hardBoundary = index === 0 || /[。；;\n]/.test(separator);
    if (hardBoundary) inheritedPolarity = undefined;

    const rawClause = parts[index].trim();
    if (!rawClause) {
      previousWasAffirmed = false;
      continue;
    }
    const discourseMatch = rawClause.match(DISCOURSE_PREFIX);
    const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
    if (!clause) continue;

    const explicitPolarity = clinicalClausePolarity(clause);
    let polarity = explicitPolarity;
    if (!hardBoundary && explicitPolarity === "affirmed" && inheritedPolarity &&
        !hasIndependentAffirmedAssertion(clause, Boolean(discourseMatch))) {
      polarity = inheritedPolarity;
    }

    if (polarity === "affirmed") {
      if (!hardBoundary && previousWasAffirmed && clauses.length > 0) {
        clauses[clauses.length - 1] += `${separator}${clause}`;
      } else {
        clauses.push(clause);
      }
    }
    inheritedPolarity = polarity;
    previousWasAffirmed = polarity === "affirmed";
  }

  return [...new Set(clauses)];
}

function hasIndependentAffirmedAssertion(clause: string, hasDiscourseBoundary: boolean): boolean {
  return hasDiscourseBoundary || AFFIRMED_ASSERTION_PREFIX.test(clause) || AFFIRMED_PREDICATE.test(clause);
}

/**
 * Which clause polarities a caller wants back.
 *
 * `affirmed` (the default) suits recall-style callers: retrieving a formula from a hedged "可能有
 * 心衰" would be over-reach. It is the WRONG default for contraindication and audit callers, where
 * dropping an uncertain comorbidity silently removes the very fact that would have raised a
 * warning. Those callers must opt into `affirmed_or_uncertain` so an unresolved finding fails
 * safe (included) instead of failing silent (dropped alongside explicit negatives).
 *
 * `negative` is never returned by either policy — an explicit denial must not become a positive
 * fact anywhere.
 */
export type ClinicalPolarityScope = "affirmed" | "affirmed_or_uncertain";

function polarityInScope(polarity: ClinicalClausePolarity, scope: ClinicalPolarityScope): boolean {
  return polarity === "affirmed" || (scope === "affirmed_or_uncertain" && polarity === "uncertain");
}

/**
 * 由语义否定增补层（polarity-negation-assist.server）判定为否定的分句原文集合。
 *
 * 确定性正则覆盖不到口语否定——实测「胸口不疼」「早就不疼了」「哪有什么胸痛」「胸痛这个倒是没有」
 * 全部被判为阳性。口语否定与口语症状一样穷举不完，因此这一步交给模型，但只允许它把阳性降为否定，
 * 不允许反向。
 *
 * ★ 只作用于 scope === "affirmed" ★
 * 这不是实现细节，是安全边界。两类消费者的失败方向相反：
 *   - affirmed（检索/依据/grounding）：把否定当阳性会伪造依据，补上否定更严格。
 *   - affirmed_or_uncertain（审方 rxaudit / 方剂禁忌）：这些调用点故意保留未消解的表述，
 *     以免漏掉本该触发的警告；在这里补否定 = 少一条警告，方向恰好相反。
 * 因此增补集在 affirmed_or_uncertain 下被完全忽略。
 */
export type AssistedNegationClauses = ReadonlySet<string>;

export function affirmedClinicalText(
  value: string | null | undefined,
  scope: ClinicalPolarityScope = "affirmed",
  assistedNegations?: AssistedNegationClauses,
): string | undefined {
  const normalized = value ? normalizedClinicalText(value) : "";
  if (!normalized) return undefined;

  const parts = normalized.split(/([，,、。；;\n]+)/);
  const clauses: string[] = [];
  let inheritedPolarity: ClinicalClausePolarity | undefined;
  let previousWasAffirmed = false;

  for (let index = 0; index < parts.length; index += 2) {
    const separator = index === 0 ? "" : parts[index - 1];
    const hardBoundary = index === 0 || /[。；;\n]/.test(separator);
    if (hardBoundary) inheritedPolarity = undefined;

    const rawClause = parts[index].trim();
    if (!rawClause) {
      previousWasAffirmed = false;
      continue;
    }
    const discourseMatch = rawClause.match(DISCOURSE_PREFIX);
    const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
    if (!clause) continue;

    const explicitPolarity = clinicalClausePolarity(clause);
    let polarity = explicitPolarity;
    if (!hardBoundary && explicitPolarity === "affirmed" && inheritedPolarity &&
        !hasIndependentAffirmedAssertion(clause, Boolean(discourseMatch))) {
      polarity = inheritedPolarity;
    }
    // 语义否定增补：只在证据类 scope 下、确定性层未判为否定时生效，且只能朝否定方向改写。
    if (scope === "affirmed" && explicitPolarity !== "negative" && assistedNegations?.has(clause)) {
      polarity = "negative";
    }

    if (polarityInScope(polarity, scope)) {
      if (!hardBoundary && previousWasAffirmed && clauses.length > 0) {
        clauses[clauses.length - 1] += `${separator}${clause}`;
      } else {
        clauses.push(clause);
      }
    }
    inheritedPolarity = polarity;
    previousWasAffirmed = polarityInScope(polarity, scope);
  }

  const uniqueClauses = [...new Set(clauses)];
  return uniqueClauses.length > 0 ? uniqueClauses.join("；") : undefined;
}

function commaScopedAffirmedText(value: string | null | undefined): string | undefined {
  const normalized = value ? normalizedClinicalText(value) : "";
  if (!normalized) return undefined;
  const clauses = normalized
    .replace(/[，,]/g, "；")
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && clinicalClausePolarity(clause) === "affirmed");
  return clauses.length > 0 ? [...new Set(clauses)].join("；") : undefined;
}

export function affirmedAllergyText(value: string | null | undefined): string | undefined {
  return commaScopedAffirmedText(value);
}

type ActiveMedicationEvent = { identity: string; text: string };

const MEDICATION_STOP_EVENT = /(?:现已|目前已|当前已|已经|已)\s*(?:停止服用|停止|停用|停服|停药|停)(?!车|电|水)|(?:不再服用|未再服用|停止服用|停止|停用|停服|停药|停了)(?!车|电|水)/;
const NEGATED_MEDICATION_STOP_EVENT = /(?:(?:医生|医师|大夫|医嘱)\s*)?(?:(?:建议|推荐)\s*)?(?:(?:并未|并没有|没有|没|不曾|尚未|暂未|未|不|不要|不得|切勿|避免)\s*(?:(?:考虑|建议|推荐|需要|必要|应该|应当|应|宜|可|能|得)\s*)?|(?:不宜|不应|不建议|不推荐|无需|无须|不必|不可|不能|不得|切勿|避免|暂不考虑|没有必要|没必要)\s*)(?:立即|马上|轻易|擅自|自行|贸然|随意|随便|突然|骤然|骤)?\s*(?:停止服用|停止|停用|停服|停药|停)(?:过)?(?!车|电|水)/;
const MEDICATION_ACTIVE_CUE = /(?:目前|当前|现在|现|仍在|仍|继续|正在|长期|规律|持续|一直|至今|今日|今天|新启用|重新启用|重新服用|再次启用|再次服用|恢复服用|开始服用|开始口服|开始使用|新开|启用|加用|改用)?\s*(?:服用|服|口服|使用|在吃|吃|用)/;
const MEDICATION_RESTART_CUE = /(?:再|又|重新|再次|恢复)(?:开始)?(?:启用|服用|口服|使用|吃)|复服|续服|恢复吃|改回(?:服用|口服|使用|吃)|接着(?:服用|口服|使用|吃|服)|(?:新行|新)(?:启用|服用|口服|使用)/;
const MEDICATION_CURRENT_TRANSITION_CUE = /(?:目前|当前|现在|现服|正在|仍在|继续|续服|接着|一直|至今|迄今|新启用|重新启用|重新服用|再次启用|再次服用|复服|恢复(?:服用|口服|使用|吃)|改回(?:服用|口服|使用|吃)|开始服用|开始口服|开始使用|新开|启用|加用|改用)/;
const MEDICATION_CURRENT_CONTINUATION = /(?:至今|目前|当前|现在)[^。；;\n]{0,12}(?:未|没有|并未|尚未)?(?:停用|停服|停药)|(?:一直|持续|仍)[^。；;\n]{0,12}(?:服用|口服|使用)(?:至今)?/;
const MEDICATION_HISTORY_ONLY_PREFIX = /^(?:(?:在|于)\s*)?(?:(?:约|大约|大概)?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半两]+|好几|十多|几十|几|多|数|若干)\s*(?:余|来|多)?\s*(?:小时|天|日|周|月|年)(?:余|来|多)?前|(?:19|20)\d{2}年|[零〇一二三四五六七八九]{4}年|(?:几|多|数|若干)年前|前几年|去年|前年|上世纪|小时候|儿童期|青少年时|青年时期|年轻时|大学期间|退休前|很久以前|早些年|早年|既往|曾经|曾|此前|之前|过去|原来|原先|以往|以前|从前|(?:服用过|服过|吃过|用过))/;
const MEDICATION_LIST_DECLARATION = /^(?:目前|当前|现在|现)?\s*(?:用药|服药|药物)(?:情况)?\s*(?:包括|有|为|是)?\s*[：:]?\s*/;
const MEDICATION_FIRST_REFERENT = /(?:前者|第一种|前一种|第一个|首种)/;
const MEDICATION_LAST_REFERENT = /(?:后者|第二种|后一种|第二个|末种)/;
const MEDICATION_ALL_REFERENT = /(?:两者|二者|均|都|全部|上述(?:药物|用药)?)/;
const MEDICATION_REFERENT = /^(?:前者|后者|第一种|第二种|前一种|后一种|第一个|第二个|首种|末种|两者|二者|均|都|全部|上述(?:药物|用药)?)$/;
const MEDICATION_REPLACEMENT_EVENT = /^(?:后|后来|之后|随后)?\s*(?:改用|换用|替换为|更换为)/;
const MEDICATION_CONTINUATION_ONLY = /^(?:(?:(?:每日|每天|每晚|每次|一日|每晨|每周|每月|早晚|晨起|睡前)\s*)?(?:各\s*)?(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*次(?:\s*(?:服用|口服|使用))?|(?:每周|每月|每隔(?:一|二|三|四|五|六|七|八|九|十|\d+)天)\s*(?:一|二|三|四|五|六|七|八|九|十|\d+)?\s*次|(?:每晨|晨起|睡前)(?:服用|口服|使用)?|(?:饭前|饭后|餐前|餐后|随餐|空腹|必要时|按需)(?:立即|同时|一起)?(?:服用|口服|使用)?)$/i;

export function medicationContinuationOnly(value: string): boolean {
  return MEDICATION_CONTINUATION_ONLY.test(normalizedClinicalText(value));
}

const MEDICATION_NAME_PREFIX = /^(?:(?:患者本人|患者|本人|医生|医师|大夫|医嘱|建议|推荐)\s*|(?:(?:当前用药|现用药|用药|既往用药|药物)(?:情况)?\s*(?:包括|有|为|是)?\s*[：:]?\s*)|(?:在|于|从|自)?\s*(?:约|大约|大概)?(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百半两]+|好几|十多|几十|几|多|数|若干)\s*(?:余|来|多)?\s*(?:小时|天|日|周|月|年)(?:余|来|多)?前\s*|(?:在|于|从|自)?\s*(?:19|20)\d{2}年(?:开始|起)?\s*|(?:在|于|从|自)?\s*[零〇一二三四五六七八九]{4}年(?:开始|起)?\s*|(?:几|多|数|若干)年前\s*|前几年\s*|(?:去年|前年|上世纪|小时候|儿童期|青少年时|青年时期|年轻时|大学期间|退休前|很久以前|早些年|早年|既往|曾经|曾|此前|之前|过去|原来|原先|以往|以前|从前|目前|当前|现在|现|后来|之后|随后|后|仍在|仍|继续|续服|接着|正在|长期|规律|持续|一直在|一直|迄今|至今|今日|今天|新启用|重新开始服用|重新开始口服|重新启用|重新服用|再次启用|再次服用|复服|恢复服用|恢复口服|恢复使用|恢复吃|改回服用|改回口服|改回使用|改回吃|又开始服用|又开始口服|现又吃|再服用|再口服|开始服用|开始口服|开始使用|开始|新开|启用|加用|改用|换用|替换为|更换为)\s*|(?:服用过|服过|吃过|用过|服用|续服|服|口服|舌下含服|皮下注射|皮下|肌内注射|肌注|静脉注射|静脉滴注|静滴|注射|外用|吸入|鼻饲|直肠给药|使用|在吃|吃|用)\s*)/;

/** Canonical drug-name extraction shared by current-medication filtering and audit payloads. */
export function medicationNameFromEventText(value: string): string {
  let candidate = normalizedClinicalText(value).replace(DISCOURSE_PREFIX, "").trim();
  let previous = "";
  while (candidate && candidate !== previous) {
    previous = candidate;
    candidate = candidate.replace(MEDICATION_NAME_PREFIX, "").trim();
  }
  candidate = candidate
    .replace(NEGATED_MEDICATION_STOP_EVENT, "")
    .replace(MEDICATION_STOP_EVENT, "")
    .replace(/\s*(?:(?:目前|当前|现在)?(?:均|都|仍)?(?:在)?(?:服用|口服|使用)(?:至今)?|至今(?:未|没有|尚未)?(?:停用|停服|停药))\s*$/, "")
    .trim();
  const doseStart = candidate.search(/\s*(?:(?:\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:-|~|至)\s*\d+(?:\.\d+)?)|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万半]+)\s*(?:毫克|微克|毫升|国际单位|单位|mcg|μg|ug|mg|kg|mL|ml|IU|U|g|克|片|粒|丸|袋|支|喷|揿|滴)/i);
  if (doseStart > 0) candidate = candidate.slice(0, doseStart).trim();
  const result = candidate
    .replace(/\s*(?:每日|每天|每晚|每次|一日|早晚|晨起|睡前|必要时|按需|qd|bid|tid|q\d+h).*$/i, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return MEDICATION_REFERENT.test(result) ? "" : result;
}

function medicationEventIdentity(value: string): string {
  let identity = medicationNameFromEventText(value)
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
  const dosageForms = ["缓释胶囊", "肠溶胶囊", "软胶囊", "薄膜衣片", "糖衣片", "泡腾片", "口腔崩解片", "缓释片", "控释片", "肠溶片", "分散片", "咀嚼片", "舌下片", "混悬滴剂", "胶囊", "片剂", "颗粒剂", "胶囊剂", "片", "颗粒"];
  let previous = "";
  while (identity && identity !== previous) {
    previous = identity;
    const suffix = dosageForms.find((item) => identity.endsWith(item) && identity.length > item.length + 1);
    if (suffix) identity = identity.slice(0, -suffix.length);
  }
  const controlledAliases: Record<string, string> = {
    盐酸二甲双胍: "二甲双胍",
    华法林钠: "华法林",
    硫酸氢氯吡格雷: "氯吡格雷",
    枸橼酸西地那非: "西地那非",
  };
  return controlledAliases[identity] || identity;
}

function sameMedicationIdentity(left: string, right: string): boolean {
  return left === right;
}

export function affirmedCurrentMedicationText(value: string | null | undefined): string | undefined {
  const normalized = value
    ? normalizedClinicalText(value).replace(new RegExp(`后\\s*(?=${MEDICATION_RESTART_CUE.source})`, "g"), "，")
    : "";
  if (!normalized) return undefined;
  const activeEvents: ActiveMedicationEvent[] = [];
  let scopedEvents: ActiveMedicationEvent[] = [];
  let listContinuation = false;
  const upsert = (text: string): ActiveMedicationEvent | undefined => {
    const identity = medicationEventIdentity(text);
    if (!identity) return undefined;
    const existing = activeEvents.findIndex((event) => sameMedicationIdentity(event.identity, identity));
    if (existing >= 0) activeEvents.splice(existing, 1);
    const event = { identity, text };
    activeEvents.push(event);
    return event;
  };
  const removeScoped = (events: ActiveMedicationEvent[]) => {
    for (const event of events) {
      for (let index = activeEvents.length - 1; index >= 0; index -= 1) {
        if (sameMedicationIdentity(activeEvents[index].identity, event.identity)) activeEvents.splice(index, 1);
      }
    }
  };
  for (const sentence of normalized.split(/[。；;\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const sentenceKeepsHistoricalMedicationCurrent = MEDICATION_CURRENT_CONTINUATION.test(sentence);
    const sentenceHasScopedEvent = /(?:前者|后者|两者|二者|均|都|全部|上述(?:药物|用药)?)[^。；;\n]{0,10}(?:停用|停服|停药|服用|口服|使用)/.test(sentence);
    // Keep the Chinese list delimiter inside a clause so "否认A、B" retains one negation scope.
    for (const rawClause of sentence.split(/[，,]+/).map((item) => item.trim()).filter(Boolean)) {
      const clause = rawClause.replace(DISCOURSE_PREFIX, "").trim();
      if (medicationContinuationOnly(clause)) {
        const previous = activeEvents.at(-1);
        if (previous) previous.text += `，${clause}`;
        continue;
      }

      const negatedStop = clause.match(NEGATED_MEDICATION_STOP_EVENT);
      if (negatedStop) {
        const refersToAll = MEDICATION_ALL_REFERENT.test(clause);
        const refersToLast = MEDICATION_LAST_REFERENT.test(clause);
        const refersToFirst = MEDICATION_FIRST_REFERENT.test(clause);
        const referred = refersToAll
          ? scopedEvents
          : refersToLast
            ? scopedEvents.slice(-1)
            : refersToFirst
              ? scopedEvents.slice(0, 1)
              : [];
        if (referred.length > 0) {
          for (const event of referred) upsert(event.text);
          continue;
        }
        const residual = clause.replace(negatedStop[0], "").replace(/^(?:从|至今|迄今|暂时|一直)\s*/, "").replace(/过\s*$/, "").trim();
        if (!medicationEventIdentity(residual)) continue;
        const activeClause = clause.replace(negatedStop[0], "仍在服用");
        const event = upsert(activeClause.replace(/^(?:从|暂时)\s*/, ""));
        if (event) scopedEvents = [event];
        continue;
      }

      const stop = clause.match(MEDICATION_STOP_EVENT);
      if (stop) {
        const refersToAll = MEDICATION_ALL_REFERENT.test(clause);
        const refersToLast = MEDICATION_LAST_REFERENT.test(clause);
        const refersToFirst = MEDICATION_FIRST_REFERENT.test(clause);
        const referred = refersToAll
          ? scopedEvents
          : refersToLast
            ? scopedEvents.slice(-1)
            : refersToFirst
              ? scopedEvents.slice(0, 1)
              : [];
        if (referred.length > 0) {
          removeScoped(referred);
          continue;
        }
        const residual = clause
        .replace(stop[0], "")
        .replace(/(?:\d+|[一二两三四五六七八九十半]+)\s*(?:天|日|周|月|年)前/g, "")
        .replace(/后\s*$/, "")
        .replace(/^(?:此前|之前|当时|现时|目前|当前|现在|后来|之后|随后|后|药物|用药)?\s*/, "")
        .replace(/了\s*$/, "")
        .trim();
        const stoppedIdentity = medicationEventIdentity(residual.replace(/^(?:前者|后者|第一种|第二种|前一种|后一种|两者|二者|均|都|全部)\s*/, ""));
        if (stoppedIdentity) {
          removeScoped([{ identity: stoppedIdentity, text: residual }]);
        } else {
          activeEvents.pop();
        }
        continue;
      }

      if (clinicalClausePolarity(clause) !== "affirmed") continue;
      if (
        MEDICATION_HISTORY_ONLY_PREFIX.test(clause) &&
        !MEDICATION_CURRENT_TRANSITION_CUE.test(clause) &&
        !sentenceKeepsHistoricalMedicationCurrent
      ) continue;

      const normalizedClause = clause.replace(/^(?:今日|今天)\s*(?=(?:重新(?:启用|服用)|再次(?:启用|服用)|新启用|新开|启用|加用|改用|恢复服用|开始(?:服用|口服|使用)))/, "");
      const declaresList = MEDICATION_LIST_DECLARATION.test(normalizedClause);
      const clauseHasActiveCue = MEDICATION_ACTIVE_CUE.test(normalizedClause) || MEDICATION_CURRENT_TRANSITION_CUE.test(normalizedClause);
      const allowBareMedication = declaresList || listContinuation || sentenceHasScopedEvent || clauseHasActiveCue;
      if (MEDICATION_REPLACEMENT_EVENT.test(normalizedClause)) {
        const previous = activeEvents.at(-1);
        if (previous) removeScoped([previous]);
      }
      const clauseEvents: ActiveMedicationEvent[] = [];
      for (const part of normalizedClause.split(/\s*(?:以及|及|与|和|、)\s*/).map((item) => item.trim()).filter(Boolean)) {
        const identity = medicationEventIdentity(part);
        if (!identity || !allowBareMedication && !MEDICATION_ACTIVE_CUE.test(part) && !/\d+(?:\.\d+)?\s*(?:mg|g|毫克|克|片|粒|丸|袋|支|IU|U|单位)/i.test(part)) continue;
        const event = upsert(part);
        if (event) clauseEvents.push(event);
      }
      if (clauseEvents.length > 0) scopedEvents = [...scopedEvents, ...clauseEvents];
      listContinuation = declaresList || (listContinuation && clauseEvents.length > 0);
    }
  }
  const unique = [...new Map(activeEvents.map((event) => [event.identity, event.text])).values()];
  return unique.length > 0 ? unique.join("；") : undefined;
}

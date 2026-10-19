import "server-only";

import type { CaseState } from "./diagnosis-types";
import { affirmedClinicalSourceClauses } from "./clinical-polarity";
import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { REPRODUCTIVE_RECORD_KEYS } from "./followup-conversation";
import {
  JINGFANG_GENERIC_SYMPTOMS,
  JINGFANG_MIN_SPECIFICITY,
  jingfangClosedSetForPick,
  jingfangPatternByName,
  jingfangSymptomSpecificity,
  type JingfangEvidence,
  type JingfangPattern,
  type JingfangPick,
} from "./jingfang-patterns";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 经方方证闭集选择（2026-10-19，第八轮 WP-A；与 textbook-disease-pick.server.ts 同一模式，多一道证据对核对）。
 *
 * 做什么：从受治理的《伤寒论》《金匮要略》方证表里，选出病历主症逐字可见的 0–2 个方证，作为 M03 中医半的「经方方证候选」。
 *
 * 为什么用模型：病历的说法是口语（「怕风」「出汗多」「肚子胀」），方证主症是古文（恶风、汗出、腹满）；词表对不上，
 * 而「就近套教材行」恰恰是 X 集 17 例经方答案被答错的原因。
 *
 * 为什么要两次调用：第一次同时看着方证清单和病历，会为凑够条数把不相干的原话硬对到主症上。本机探针（2026-10-19，真实
 * deepseek-flash）：甲方 10 例里 9 例、留出 32 例里 26 例选出了方证，几乎全是这样凑出来的——「头痛较前加重」对「腹中痛」，
 * 「常因情绪波动诱发」对「胸胁苦满」。所以第二次只把（病历原话，症状）这些对子单独拿出来、不给方证名，只问「这句原话是不是就在说这个症状」。
 *
 * 边界（都在服务端逐条核对，模型只出选择与对应判断）：
 *  · 只在闭集里选——方证名必须逐字等于表里的方证名（或别名），其余丢弃；
 *  · 证据 = 病历原文里逐字出现的一小段（quote）+ 它对应的该方证主症（symptom，须取自该方证的症状清单）；引文不在病历里的丢弃；
 *  · 被病历否认的表现不能当证据（引文落在否认分句里时丢弃；主症本身就是「无汗」「不渴」这类否定写法时，引文须同样带这个否定字）；
 *  · 第二次核对判「否」或没有回答的证据对丢弃（不放行没被确认的证据）；
 *  · 剩下的证据要同时满足：不同主症的条数够（默认 2，第二个方证 3）、至少一条不是泛化症状（发热、恶寒、头痛…）、
 *    特异度之和不低于 JINGFANG_MIN_SPECIFICITY（人人都有的症状凑不出方证），或者确认的不同主症有 4 条以上；
 *  · 结果只决定「把哪几个方证的原文写进提示词」，不产生诊断，不写病历，不参与任何安全判断；
 *  · 超时、未配置、输出非法、核对调用失败都返回空数组（提示词与此前逐字相同）；temperature 0，按实际请求内容缓存（M02 预取，M03 命中）。
 * 开关：CDSS_JINGFANG_PATTERN_PICK=false 关闭。
 */
const PICK_TIMEOUT_MS = (() => {
  const value = Number(process.env.JINGFANG_PATTERN_PICK_TIMEOUT_MS || 9_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 20_000 ? Math.round(value) : 9_000;
})();
const MAX_RECORD_CHARS = 900;
const MAX_PICKS = 2;
const MAX_CANDIDATES = 4;
const MAX_QUOTE_CHARS = 30;
const MIN_QUOTES_FOR_SECOND_PICK = 3;
const STRONG_EVIDENCE_COUNT = 4;

function enabled(): boolean {
  return process.env.CDSS_JINGFANG_PATTERN_PICK !== "false";
}

/** 比对用：去掉空白与标点（引文里模型可能带逗号）。 */
const squash = (text: string): string => String(text || "").replace(/[\s，。、；：:;,.！!？?（）()“”"'《》　]+/gu, "");
const NEGATOR_START = /^[无没未不]/u;
const NEGATOR_ANY = /[无没未不]/u;

export interface JingfangCandidate { pattern: JingfangPattern; evidence: JingfangEvidence[] }

/**
 * 第一次调用的结果：只做闭集与病历核对（方证名在表里；症状取自该方证；引文逐字在病历里；没有落在否认分句里）。
 * 条数与特异度的要求放在第二次核对之后（finalizeJingfangPicks）。纯函数。
 * recordText 必须是发给模型的那份（已脱敏）病历文本。
 */
export function parseJingfangCandidates(content: unknown, recordText: string): JingfangCandidate[] {
  if (typeof content !== "string" || !content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const list = parsed && typeof parsed === "object" ? (parsed as { patterns?: unknown }).patterns : undefined;
  if (!Array.isArray(list)) return [];
  const rawRecord = squash(recordText);
  const affirmedRecord = squash(affirmedClinicalSourceClauses(recordText).join("，"));
  if (!rawRecord) return [];
  const out: JingfangCandidate[] = [];
  for (const item of list.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { pattern?: unknown; evidence?: unknown };
    const pattern = typeof entry.pattern === "string" ? jingfangPatternByName(entry.pattern) : undefined;
    if (!pattern || out.some((candidate) => candidate.pattern.id === pattern.id) || !Array.isArray(entry.evidence)) continue;
    const symptomSet = new Set(pattern.symptoms);
    const evidence: JingfangEvidence[] = [];
    for (const raw of entry.evidence.slice(0, 8)) {
      if (!raw || typeof raw !== "object") continue;
      const quote = typeof (raw as { quote?: unknown }).quote === "string" ? (raw as { quote: string }).quote.trim() : "";
      const symptom = typeof (raw as { symptom?: unknown }).symptom === "string" ? (raw as { symptom: string }).symptom.trim() : "";
      if (!quote || !symptomSet.has(symptom)) continue;
      const squashedQuote = squash(quote);
      if (squashedQuote.length < 2 || squashedQuote.length > MAX_QUOTE_CHARS) continue;
      // 逐字：引文必须原样出现在病历里（连标点一并忽略后比较）。
      if (!rawRecord.includes(squashedQuote)) continue;
      // 否认：引文自己带否定（没有出汗、不口渴）而症状不是否定写法时，不能当证据；引文落在被否认的分句里时也不能。
      // 主症本身就是否定写法（无汗而喘、不渴、不得眠）时，引文须同样带否定字，才算对上。
      const quoteNegated = NEGATOR_START.test(squashedQuote);
      const symptomNegated = NEGATOR_ANY.test(symptom);
      if (quoteNegated && !symptomNegated) continue;
      if (!affirmedRecord.includes(squashedQuote) && !(quoteNegated && symptomNegated)) continue;
      if (evidence.some((existing) => existing.symptom === symptom || squash(existing.quote) === squashedQuote)) continue;
      evidence.push({ symptom, quote });
    }
    if (evidence.length > 0) out.push({ pattern, evidence });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** 候选的证据对，按候选顺序展平（核对调用的输入，也是 verdicts 的顺序）。 */
export function jingfangEvidencePairs(candidates: readonly JingfangCandidate[]): Array<{ quote: string; symptom: string }> {
  return candidates.flatMap((candidate) => candidate.evidence.map(({ quote, symptom }) => ({ quote, symptom })));
}

/**
 * 一个方证的证据够不够（纯函数）：不同主症的条数、非泛症、特异度之和。第二个方证要求更高的条数
 *（本机探针 20 例口语化病历里第二个方证出现 4 次，4 次都是凑出来的：四逆汤、葛根芩连汤、小建中汤、小柴胡汤）。
 */
export function jingfangEvidenceSufficient(pattern: JingfangPattern, evidence: readonly JingfangEvidence[], isFirst: boolean): boolean {
  const required = isFirst ? pattern.minQuotes : Math.max(MIN_QUOTES_FOR_SECOND_PICK, pattern.minQuotes);
  const symptoms = [...new Set(evidence.map((item) => item.symptom))];
  if (symptoms.length < required) return false;
  if (!symptoms.some((symptom) => !JINGFANG_GENERIC_SYMPTOMS.has(symptom))) return false;
  // 特异度之和够，或者核对确认的不同主症有 4 条以上：桂枝汤证的「发热、汗出、恶风、头痛、脉浮缓」每个症状都出现在许多方证里，
  // 特异度之和低，但五条互相印证的全是它的主症——条数多本身就是证据（本机探针里，被核对确认的证据最多的非目标方证是 3 条）。
  if (symptoms.length >= STRONG_EVIDENCE_COUNT) return true;
  return symptoms.reduce((sum, symptom) => sum + jingfangSymptomSpecificity(symptom), 0) >= JINGFANG_MIN_SPECIFICITY;
}

/** 核对判「否」的证据对丢弃后，按要求定最终入选的方证（最多 MAX_PICKS 个）。same 与 jingfangEvidencePairs 同序。 */
export function finalizeJingfangPicks(candidates: readonly JingfangCandidate[], same: readonly boolean[]): JingfangPick[] {
  const picks: JingfangPick[] = [];
  let offset = 0;
  for (const candidate of candidates) {
    const verified = candidate.evidence.filter((_, index) => same[offset + index] === true);
    offset += candidate.evidence.length;
    if (!jingfangEvidenceSufficient(candidate.pattern, verified, picks.length === 0)) continue;
    picks.push({ patternName: candidate.pattern.patternName, evidence: verified });
    if (picks.length >= MAX_PICKS) break;
  }
  return picks;
}

/** 发给模型的病历文本：主诉、现病史、舌脉，必要时带经带胎产。与教材病名闭集选择同一份脱敏口径。 */
export function jingfangRecordText(caseState: CaseState): string {
  const present = [caseState.hisRecord?.fields?.xianbingshi, caseState.symptoms?.presentHistory]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim())) || "";
  const reproductive = Object.entries(caseState.symptoms || {})
    .filter(([key, value]) => REPRODUCTIVE_RECORD_KEYS.includes(key) && typeof value === "string" && value.trim())
    .map(([key, value]) => `${key}：${String(value).slice(0, 120)}`)
    .join("\n");
  const tonguePulse = [caseState.tongue ? `舌象：${caseState.tongue}` : "", caseState.pulse ? `脉象：${caseState.pulse}` : ""].filter(Boolean).join("\n");
  return sanitizeFreeTextForModel(
    [`主诉：${caseState.chiefComplaint || ""}`, `现病史：${present}`.slice(0, MAX_RECORD_CHARS), tonguePulse, reproductive].filter(Boolean).join("\n"),
  );
}

export function buildJingfangPickMessages(caseState: CaseState, record: string) {
  const ageYears = typeof caseState.patient?.age === "number" ? caseState.patient.age : undefined;
  return [
    {
      role: "system" as const,
      content: [
        "你是中医经方方证检索器，不负责诊断、处方或安全判断。",
        "任务：根据病历文本，从给定的《伤寒论》《金匮要略》方证清单里，选出病历主症确实出现、且彼此能互相印证的方证。每个方证附有它的原文主症短语。",
        "规则：",
        "1. 只能逐字复制清单里的方证名；不得改写，不得给清单外的名字。",
        `2. 最多 ${MAX_PICKS} 个，最贴合的排第一。病历通常只对应一个方证；只有第二个方证也有 3 条以上互相印证的主症时才给第二个。清单里没有合适的方证、或病历只有发热、恶寒、头痛、咳嗽等泛化症状时，返回空数组；宁缺毋滥。`,
        "3. 每个方证必须给出至少 2 条证据（清单标注“单症”的至少 1 条）。每条证据 = quote（病历原文里逐字出现的一小段，不超过 20 字，不得改写、不得拼接不相邻的两处）+ symptom（它对应的该方证主症，必须逐字取自该方证的症状清单）。两条证据必须对应不同的主症、使用不同的原文片段。",
        "4. quote 说的必须就是 symptom 那个表现本身（同义或口语说法可以），不是相关的、伴随的、可能由它引起的另一个表现；对不上就不要凑。",
        "5. 病历写了“无”“否认”“未见”的表现不能作为证据；只有主症本身就是否定写法（如“无汗”“不渴”）时，quote 才取病历里同样带否定字的那一小段。",
        "6. 同一个症状在不同方证里区分意义不同（有汗/无汗、口渴/不渴、下利清谷/热利下重、脉浮/脉沉）：病历与方证的区分点相反的，不要选。",
        "7. 病历用日常说法时（怕风=恶风，出汗=汗出，肚子胀=腹满），symptom 取清单里的写法，quote 仍取病历原话。",
        "只输出 JSON：{\"patterns\":[{\"pattern\":\"方证名\",\"evidence\":[{\"quote\":\"…\",\"symptom\":\"…\"},{\"quote\":\"…\",\"symptom\":\"…\"}]}]}，不要解释。",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: caseState.patient?.sex || null, age: ageYears ?? null },
        record,
        patterns: jingfangClosedSetForPick().map((item) => {
          const pattern = jingfangPatternByName(item.pattern);
          return { pattern: item.pattern, ...(pattern?.minQuotes === 1 ? { note: "单症" } : {}), symptoms: item.symptoms };
        }),
      }),
    },
  ];
}

/** 证据对核对（第二次窄调用）的消息：不给方证名，只问（病历原话，症状）是否就是同一个表现。 */
export function buildJingfangEvidenceCheckMessages(pairs: ReadonlyArray<{ quote: string; symptom: string }>) {
  return [
    {
      role: "system" as const,
      content: [
        "你是中医病历症状对应核对器，只做语言对应判断，不诊断、不开方。",
        "输入是若干对（病历原话 quote，症状 symptom）。逐对判断：病历原话本身是否就是在说这个症状。",
        "规则：",
        "1. 同义或口语说法算（怕风=恶风，出汗多=汗出，肚子胀=腹满，手脚冰凉=手足逆冷，拉完还想拉=里急后重）。",
        "2. 症状带有时间或程度限定时，原话的时间、程度大致相当就算（下午发热明显≈日晡所发潮热，5天没大便≈不大便五六日）；原话明显更轻、更泛或没有这个限定的不算（原话只说“发热”，症状是“日晡所发潮热”→否）。",
        "3. 只是相关、常伴随、可能由它引起、或同属一个系统但不是同一个表现的，不算（头痛≠腹痛，咳嗽≠喘，心烦≠失眠，情绪诱发≠胸胁苦满，口苦≠心烦喜呕，食欲减退≠嘿嘿不欲饮食）。",
        "4. 原话里被否认的表现不算（原话“无汗”对症状“汗出”→否）；症状本身是否定写法（“无汗而喘”“不渴”）时，原话要有同样的否定。",
        "5. 脉象、舌象症状要原话也是同类的脉象、舌象才算；拿不准的判否。",
        "只输出 JSON：{\"verdicts\":[{\"id\":1,\"same\":true}]}，id 与输入顺序一致，不要解释。",
      ].join("\n"),
    },
    { role: "user" as const, content: JSON.stringify({ pairs: pairs.map((pair, index) => ({ id: index + 1, quote: pair.quote, symptom: pair.symptom })) }) },
  ];
}

/** 解析核对结果：返回与输入等长的布尔数组；缺项、非法输出一律按「否」（不放行没被确认的证据）。 */
export function parseJingfangEvidenceVerdicts(content: unknown, count: number): boolean[] {
  const verdicts = new Array<boolean>(count).fill(false);
  if (typeof content !== "string" || !content.trim()) return verdicts;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return verdicts; }
  const list = parsed && typeof parsed === "object" ? (parsed as { verdicts?: unknown }).verdicts : undefined;
  if (!Array.isArray(list)) return verdicts;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    const same = (item as { same?: unknown }).same;
    if (typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= count && same === true) verdicts[id - 1] = true;
  }
  return verdicts;
}

export async function pickJingfangPatternsForCase(caseState: CaseState, signal?: AbortSignal): Promise<JingfangPick[]> {
  if (!enabled() || signal?.aborted) return [];
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return [];
  if (!(caseState.chiefComplaint || "").trim()) return [];
  const record = jingfangRecordText(caseState);
  const messages = buildJingfangPickMessages(caseState, record);
  return memoizedSmallTask<JingfangPick[]>("jingfang_pattern_pick", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PICK_TIMEOUT_MS);
    const ask = async (task: string, chatMessages: ReturnType<typeof buildJingfangPickMessages>, maxTokens: number) => {
      const response = await observeModelTask({ task, stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages: chatMessages,
      }, { signal: controller.signal }));
      return response.choices[0]?.message?.content;
    };
    try {
      const picked = await ask("jingfang_pattern_pick", messages, 500);
      const candidates = parseJingfangCandidates(picked, record);
      const answered = typeof picked === "string" && picked.trim().length > 0;
      if (candidates.length === 0) return { value: [], cacheable: answered };
      const pairs = jingfangEvidencePairs(candidates);
      const checked = await ask("jingfang_evidence_check", buildJingfangEvidenceCheckMessages(pairs), 80 + pairs.length * 24);
      if (typeof checked !== "string" || !checked.trim()) return { value: [], cacheable: false };
      return { value: finalizeJingfangPicks(candidates, parseJingfangEvidenceVerdicts(checked, pairs.length)), cacheable: true };
    } catch {
      return { value: [], cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, [], signal);
}

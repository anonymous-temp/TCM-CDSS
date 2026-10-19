import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { herbFunctionKnowledgeForDisplay } from "./tcm-knowledge";
import { compositionIdentityName } from "./tcm-formula-provenance";
import { combinedEffectMarkerPattern, contradictedHerbClaims, removeVerifiedHerbClaims, type FormulaAnalysisHerbClaim } from "./formula-analysis-review";
import textbookReferencesJson from "../data/tcm-herb-textbook-references.json";

/**
 * M04 方义里「药物功效写错」的核对（2026-10-19，两道）。
 *
 * 甲方标准病历 10 的方义写「青蒿清透伏热并生津除烦」「黄柏苦寒清下焦、泄肝火」，病历 6 写「鹿胶珠、龟胶珠…滋阴养血兼退虚热」，
 * 独立评审判药物功效写错；验收集里还有麦冬「清化中焦湿热」、火麻仁「润养脾胃」、淡竹叶「降胃气以止呕」。药味表那一栏
 * 由知识库对照与交付面去伪管着，方义是模型写的整段话，此前没有任何核对。
 * 纯规则核不了：离线试过按概念组逐句比对，714 段方义标出 441 处、读了 30 处只有 0–1 处是真错（几味药合说、配伍关系、
 * 同义写法都被误标）；只认单味主语的版本 66 处里约 12% 是真错，且 13 处已知错误只抓到 3 处。
 *
 * 做法（与西医病名核对、追问题重复核对同一路数）：
 *   第一道（小模型，deepseek-flash、json_object、温度 0）：给它本方药味与各自的参考功效、方义原文，只报「把某药不具备的功效
 *     安在它身上」的说法，交出药名、方义原文片段与错的那几个字；
 *   第二道（确定性，唯一能删字的一道，formula-analysis-review.removeVerifiedHerbClaims）：片段逐字在方义里、药在本方、
 *     错说法落在功效概念组且这味药的参考功效（知识库功用 + 核对词典 + 《中药学》功效行 + 《方剂学》方解里紧跟这味药的半句）
 *     不支持、且确实是在说这味药，才删那一小段。
 * 超时、未配置、输出非法、第二道不认，都按原文交付；失败结果不缓存。开关：CDSS_M04_FORMULA_ANALYSIS_CLAIM_CHECK=false。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M04_FORMULA_ANALYSIS_CLAIM_CHECK_TIMEOUT_MS || 4_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 4_000;
})();
const MAX_ANALYSIS_CHARS = 1_400;
const MAX_CLAIMS = 6;
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

export function formulaAnalysisClaimCheckEnabled(): boolean {
  return process.env.CDSS_M04_FORMULA_ANALYSIS_CLAIM_CHECK !== "false";
}

type TextbookReferences = {
  herbs?: Record<string, { function?: string; parent?: string }>;
  formulaCommentaries?: Record<string, { commentary?: string; features?: string }>;
};
const TEXTBOOK = textbookReferencesJson as unknown as TextbookReferences;
const COMMENTARIES = Object.values(TEXTBOOK.formulaCommentaries || {})
  .map((entry) => `${entry.commentary || ""}${entry.features || ""}`)
  .filter(Boolean);

function identityOf(name: string): string {
  const cleaned = String(name || "").replace(/[（(][^）)]*[）)]/gu, "").replace(/\s+/gu, "").trim();
  return compositionIdentityName(cleaned) || cleaned;
}

/**
 * 《方剂学》方解里提到这味药的那一句（从药名起，到分号、句号或「两药相配」这类合说为止）。按句而不是按逗号取：真武汤方解「配伍酸收之白芍，其意有四：一者利小便以行水气」
 * 里白芍的利水在逗号后面，按逗号取会把教材明写的作用当成没有依据（离线核对时白芍「利水而不伤阴」两次被误删）。
 */
// 句子里讲到几味药合起来的作用就停（青蒿鳖甲汤方解「青蒿…清热透络，引邪外出，两药相配，滋阴清热」：滋阴清热是两药相配，不是青蒿）。
// 合说的写法在 tcm-herb-claim-concepts.source.json 的 combinedEffectMarkers（方义一侧的判据用同一张表）。
const COMBINED_EFFECT_MARKER = combinedEffectMarkerPattern();
function commentaryClausesFor(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const commentary of COMMENTARIES) {
    for (const sentence of commentary.split(/[。；;]/u)) {
      for (const name of names) {
        if (name.length < 2) continue;
        const at = sentence.indexOf(name);
        if (at < 0) continue;
        const rest = sentence.slice(at + name.length);
        // 几味药并列写在一起（「鹿角胶、菟丝子温润之品补阳益阴」）：说的是这几味合起来，不算这一味自己的作用。
        if (/^[、和与及]/u.test(rest) || /[、和与及]$/u.test(sentence.slice(0, at))) continue;
        const stop = rest.search(COMBINED_EFFECT_MARKER);
        out.push(`${name}${stop >= 0 ? rest.slice(0, stop) : rest}`);
      }
    }
  }
  return out;
}

const referenceCache = new Map<string, string>();
/** 第二道用的参考功效（只用来挡住删除，越全越少删）。 */
export function herbClaimReferenceText(herb: string): string {
  const identity = identityOf(herb);
  const cached = referenceCache.get(identity);
  if (cached !== undefined) return cached;
  // 附药连同所附的正药（龟甲胶 → 龟甲、鹿角胶 → 鹿茸）：教材附药只写一两句，正药的功效也算参考（只会让删得更少）。
  const parents = [herb, identity].map((name) => TEXTBOOK.herbs?.[name]?.parent || "").filter(Boolean);
  const names = [...new Set([herb, identity, ...parents].filter(Boolean))];
  const reference = [
    ...names.map((name) => herbFunctionKnowledgeForDisplay(name)),
    ...names.map((name) => TEXTBOOK.herbs?.[name]?.function || ""),
    ...commentaryClausesFor(names),
  ].filter(Boolean).join("；");
  referenceCache.set(identity, reference);
  return reference;
}

/**
 * 判「方向正相反」用的参考功效（contradictedHerbClaims）：只取这味药自己的功效——知识库功用与《中药学》功效行，不取《方剂学》方解：
 * 方解里提到这味药的那一句常连着别的药说（左金丸「吴茱萸…又能制黄连之寒，使泻火而不凉遏，苦寒而不伤胃」），
 * 拿它当吴茱萸的功效，吴茱萸就成了「泻火」「苦寒」。
 */
export function herbOwnFunctionReferenceText(herb: string): string {
  const identity = identityOf(herb);
  const parents = [herb, identity].map((name) => TEXTBOOK.herbs?.[name]?.parent || "").filter(Boolean);
  const names = [...new Set([herb, identity, ...parents].filter(Boolean))];
  return [
    ...names.map((name) => herbFunctionKnowledgeForDisplay(name)),
    ...names.map((name) => TEXTBOOK.herbs?.[name]?.function || ""),
  ].filter(Boolean).join("；");
}

/** 给模型看的参考功效：教材功效行优先，没有时用知识库功用（去掉「…药」分类标签）。 */
function promptReference(herb: string): string {
  const identity = identityOf(herb);
  const textbook = TEXTBOOK.herbs?.[herb]?.function || TEXTBOOK.herbs?.[identity]?.function || "";
  const knowledge = herbFunctionKnowledgeForDisplay(identity)
    .split(/[；;]/u).map((item) => item.trim()).filter((item) => item && !/药$/u.test(item)).join("；");
  return [textbook.replace(/。$/u, ""), knowledge].filter(Boolean).join("；").slice(0, 120);
}

const SYSTEM = [
  "你是中药方义（方解）里药物功效说法的核对器，不负责评价方子开得对不对。",
  "给你本方的药味（每味附参考功效：教材功效与常用功用）和一段方义。只找一种错误：方义把某味药不具备的功效安在这味药身上——参考功效里没有、教材也不这么说的功效，如“青蒿生津”“黄柏泄肝火”“麦冬清化中焦湿热”“火麻仁润养脾胃”“淡竹叶降胃气止呕”“桔梗载药下行”。",
  "以下都不算错误，不要报：与参考功效同义或下位的写法（参考“补血”写“养血”，参考“清热泻火”写“清胃热”）；配伍关系与制约（“防…”“制…”“使…而不伤正”“助君药…”）；对病机、病位、症状的描述；全方或几味药配合起来才有的作用；炮制、煎法、用量。",
  "几味药并列写在一句里、各自被说成有某功效时，其中某味药没有这一功效就报这一味（如“鹿角胶、龟甲胶…滋阴”：鹿角胶温补肝肾、益精养血，性温，不滋阴）。",
  "拿不准就不报。只报你确定的，最多6条。",
  "每条给出：herb（药名，照方义里的写法）、clause（方义里含这一说法的连续原文片段，逐字复制，不超过40字）、claim（错的那几个字，逐字复制，2–10字）、reason（不超过20字）。",
  "只输出 JSON：{\"claims\":[{\"herb\":\"…\",\"clause\":\"…\",\"claim\":\"…\",\"reason\":\"…\"}]}；没有错误时输出 {\"claims\":[]}。",
].join("\n");

/** 模型输出 → 结构合格的条目（不在这里判对错，第二道判）。 */
export function parseFormulaAnalysisClaims(content: unknown): FormulaAnalysisHerbClaim[] {
  if (typeof content !== "string" || !content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const claims = parsed && typeof parsed === "object" ? (parsed as { claims?: unknown }).claims : undefined;
  if (!Array.isArray(claims)) return [];
  return claims.slice(0, MAX_CLAIMS).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { herb, clause, claim } = item as Record<string, unknown>;
    return typeof herb === "string" && typeof clause === "string" && typeof claim === "string" && herb.trim() && clause.trim() && claim.trim()
      ? [{ herb: herb.trim(), clause: clause.trim(), claim: claim.trim() }]
      : [];
  });
}

/** 第一道：小模型报出可疑的说法。超时、未配置、出错一律当没有。 */
export async function suspectedFormulaAnalysisClaims(
  input: { formulaName: string; herbs: readonly string[]; analysis: string },
  signal?: AbortSignal,
): Promise<FormulaAnalysisHerbClaim[]> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured || !input.analysis.trim() || input.herbs.length === 0) return [];
  const messages = [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content: JSON.stringify({
        formula: input.formulaName,
        herbs: input.herbs.map((name) => ({ name, reference: promptReference(name) })),
        analysis: input.analysis.slice(0, MAX_ANALYSIS_CHARS),
      }),
    },
  ];
  return memoizedSmallTask<FormulaAnalysisHerbClaim[]>("m04_formula_analysis_claims", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await observeModelTask({ task: "m04_formula_analysis_claims", stage: "prescribe", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 500,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: parseFormulaAnalysisClaims(content), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: [], cacheable: false };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }, [], signal);
}

/**
 * M04 内容（带 DIAGNOSIS_JSON 哨兵的已编译结果）里每张候选方的方义过两道核对，返回改写后的内容；没有可删的说法时逐字节原样返回。
 * 由 prescribe 路由经 callDiagnosisStream 的 m04CandidateTransform 注入（签名与合同核对之前）。
 */
export async function checkFormulaAnalysisClaimsInContent(content: string, signal?: AbortSignal): Promise<string> {
  if (!formulaAnalysisClaimCheckEnabled() || signal?.aborted) return content;
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let reasoning: { stage?: unknown; formula?: { candidates?: Array<Record<string, unknown>> } };
  try { reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()); } catch { return content; }
  if (reasoning?.stage !== "prescribe") return content;
  let changed = false;
  for (const candidate of reasoning.formula?.candidates || []) {
    const analysis = typeof candidate.formulaAnalysis === "string" ? candidate.formulaAnalysis : "";
    const herbs = (Array.isArray(candidate.herbs) ? candidate.herbs : [])
      .map((herb) => (herb && typeof herb === "object" ? String((herb as { name?: unknown }).name || "").trim() : ""))
      .filter(Boolean);
    if (!analysis.trim() || herbs.length === 0) continue;
    const claims = await suspectedFormulaAnalysisClaims({ formulaName: String(candidate.name || ""), herbs, analysis }, signal);
    // 与参考功效方向正相反的说法（contradictedHerbClaims，确定性）另走一遍第二道，参考功效只取这味药自己的
    //（herbOwnFunctionReferenceText）；小模型超时、未配置或没报时照常起作用。
    const modelReview = claims.length > 0 ? removeVerifiedHerbClaims(analysis, herbs, claims, herbClaimReferenceText) : undefined;
    const afterModel = modelReview && modelReview.removals.length > 0 ? modelReview.text : analysis;
    const contradicted = contradictedHerbClaims(afterModel, herbs, herbOwnFunctionReferenceText, herbClaimReferenceText);
    if (claims.length === 0 && contradicted.length === 0) continue;
    const contradictionReview = contradicted.length > 0 ? removeVerifiedHerbClaims(afterModel, herbs, contradicted, herbOwnFunctionReferenceText) : undefined;
    const review = {
      text: contradictionReview && contradictionReview.removals.length > 0 ? contradictionReview.text : afterModel,
      removals: [...(modelReview?.removals || []), ...(contradictionReview?.removals || [])],
      rejected: [...(modelReview?.rejected || []), ...(contradictionReview?.rejected || [])],
    };
    console.info("[tcm-cdss:telemetry] formula_analysis_claim_check", {
      flagged: claims.length + contradicted.length,
      removed: review.removals.length,
      actions: review.removals.map((item) => item.action).join(",") || "none",
      rejected: review.rejected.map((item) => item.reason).join(",") || "none",
    });
    if (review.removals.length > 0 && review.text !== analysis) {
      candidate.formulaAnalysis = review.text;
      changed = true;
    }
  }
  if (!changed) return content;
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
}

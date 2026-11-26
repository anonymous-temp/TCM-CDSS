/**
 * 开方保底：最后一道安全检查仍不通过时，不再整页退成「不给剂量」，而是按不合格原因处理出问题的那一小块，再完整重跑同一道检查（2026-11-23 第五十七轮）。
 *
 * 为什么要有这一层：开方合同的不合格原因有一百多种，修复轮修不好时此前只有白名单里的几种带提示放行，其余整页不给剂量。
 * 每一轮冒出来的都是一种不在白名单里的新原因（一味药剂量超限、一条加减方向不对、药味指向被删掉的病机节点），每次补一种，补不完。
 * 现在倒过来：默认保住处方，只动出问题的那一块。
 *
 * 三条不变量：
 *   1) **只删不加**。处理只有这几种：去掉那味药/那条加减、补上规则要求的特殊煎法、
 *      记账字段（药味指向哪个病机节点、君臣标签、服法算术、方名身份、M03 归属字段）由服务端按已签名的 M03 重算。不新增药味、不放宽剂量。
 *   2) 每处理一步都完整重跑调用方给的那道检查（issueOf）；处理不了的原因、处理后没有变化、或步数用完，一律返回 undefined，调用方照旧不给剂量。
 *   3) **唯一君药出问题时**，先由臣药接任，或升任原已针对 P1 且满足君药方向要求的佐药，否则不动——君药决定全方走向，没有合适药味可接时交还原有路径。
 *      删后不足 3 味不删。
 *
 * 原因 → 处理方式是一张登记表（M04_SALVAGE_RULES）。scripts/test-r1075-salvage.mjs 逐个扫开方安全合同的返回码，
 * 没有登记的原因测试不通过——新增检查时必须同时写明「这一项不合格时去掉什么」，不会再默认整页作废。
 */
import { selectGroundedHerbFunction } from "./herb-function-display-source";
import { canonicalTcmHerbIdentity, herbShortlistDirectionEligible, m04GenerationSpecialPopulationIssue } from "./diagnosis-stage-contract";
import { enforceM04PriorStageOwnership } from "./diagnosis-structured-repair";
import { formulaAnalysisAfterHerbRemoval } from "./formula-analysis-review";
import { appendCaseSafetyNote } from "./candidate-boundary-text";
import { specialPopulationConflictLabel } from "./special-population-labels";
import { withoutModificationsOnAbsentHerbs } from "./m04-proposal-compiler";
import { withoutPrecautionsNamingAbsentHerbs } from "./m04-modification-safety";
import { clinicianDoseHerbClass, findTcmHerbPairIncompatibilities, getTcmHerbFunctionText } from "./tcm-knowledge";
import { requiredDecoctionRequirement } from "./herb-decoction-rules";
import { identifyKnownFormulaNames } from "./tcm-formula-provenance";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const MIN_RETAINED_HERBS = 3;
const MAX_SALVAGE_STEPS = 12;
const ROLE_RANK: Readonly<Record<string, number>> = { 君: 0, 臣: 1, 佐: 2, 使: 3 };

export type M04SalvageAction =
  | "repoint_target"
  | "repair_function"
  | "remove_herb"
  | "fill_decoction_requirement"
  | "remove_lower_of_pair"
  | "dedupe_herb"
  | "fix_regimen"
  | "fix_administration"
  | "drop_modification"
  | "rebind_prior"
  | "align_therapy_match"
  | "demote_extra_emperors"
  | "promote_emperor"
  | "declassify_identity"
  | "keep_first_candidate"
  | "none";

/**
 * 原因码（去掉 m04_ / finalized_prescription_ 前缀后）→ 处理方式。按顺序取第一条命中的。
 * `none` 是登记过的「不保底」：给出理由，交还原有路径（不给剂量）。
 */
export const M04_SALVAGE_RULES: ReadonlyArray<{ pattern: RegExp; action: M04SalvageAction; why: string }> = [
  // ── 记账字段：药味指向的病机节点（M03 节点被撤回后模型仍写 P2，f06）、方内结构角色、君药指向 P1 ──
  {
    pattern: /^candidate_\d+_herb_\d+_(?:target_ref_(?:invalid|mismatch|missing)|structure_(?:ref_invalid|role_forbidden|type_invalid|target_mismatch)|emperor_not_primary)$/,
    action: "repoint_target",
    why: "药味指向哪个病机节点是记账字段：按已签名 M03 的节点重算（君药指 P1，其余按功效与节点文字最接近者）",
  },
  { pattern: /^candidate_\d+_herb_\d+_function(?:_ungrounded)?$/, action: "repair_function", why: "按该规格的功效原文订正功效说明，保留剂量，重新核对整方" },
  // ── 单味药不合格：去掉这一味 ──
  // 合同只在「编译器压不了」时才按剂量驳回（普通药味超上沿由 ordinaryHistoricalDoseDeviation 放行、编译器压到上沿）：
  // 走到这里的是有毒、医师定量或缺少可核对上限的药味，系统不自动减量，去掉这一味。
  { pattern: /^candidate_\d+_herb_\d+_dose_outside_conservative_range$/, action: "remove_herb", why: "有毒、医师定量或缺少可核对上限的药味超出范围：系统不自动减量，去掉这一味" },
  { pattern: /^candidate_\d+_herb_\d+_decoction_missing_required$/, action: "fill_decoction_requirement", why: "补上药典/教材规定的特殊煎法（先煎、后下、包煎…）" },
  { pattern: /^candidate_\d+_herb_\d+_(?:name|unknown|dose|route_not_decoction|dose_sanity_ceiling)$/, action: "remove_herb", why: "药名认不出、没写剂量、不能同煎或须医生单独定量的这一味去掉" },
  { pattern: /^candidate_\d+_herb_\d+_special_population_.+$/, action: "remove_herb", why: "与本例人群/过敏/出血/抗凝边界冲突的这一味去掉" },
  { pattern: /^(?:candidate_\d+_)?(?:transparent_therapy_)?herb_\d+_unsupported_high_impact_.+$/, action: "remove_herb", why: "药性方向与本例治法相反的这一味去掉" },
  { pattern: /^candidate_\d+_herb_\d+_pathogenesis_unaligned_.+$/, action: "remove_herb", why: "与本例病机对立的这一味去掉" },
  { pattern: /^candidate_\d+_herb_\d+_emperor_(?:therapy_mismatch|knowledge_missing)$/, action: "none", why: "君药功效词表覆盖属质量项：终审按批注受理，不会作为安全底线原因出现" },
  // ── 方内两味之间 ──
  { pattern: /^candidate_\d+_high_risk_pair_incompatibility$/, action: "remove_lower_of_pair", why: "十八反十九畏：去掉两味中地位较低的一味" },
  { pattern: /^candidate_\d+_duplicate_herb$/, action: "dedupe_herb", why: "同一味药写了两次：留地位高的一行" },
  // ── 服法算术与君臣标签（记账字段）──
  { pattern: /^candidate_\d+_(?:dose_count|course|doses_per_day|course_inconsistent)$/, action: "fix_regimen", why: "剂数、疗程、每日剂数按受控格式重算（剂数不明时 7 剂，每日 1 剂）" },
  { pattern: /^candidate_\d+_administration_times_per_day$/, action: "fix_administration", why: "每日服药次数按每日剂数重算（每剂分 2 次）" },
  { pattern: /^candidate_\d+_emperor_excess$/, action: "demote_extra_emperors", why: "君药多于两味：留指向 P1 的前两味，其余改臣药" },
  { pattern: /^candidate_\d+_emperor_missing$/, action: "promote_emperor", why: "没有君药：指向 P1 的第一味臣药升为君药" },
  { pattern: /^candidate_\d+_therapy_unaligned$/, action: "align_therapy_match", why: "候选的治法对应字段改为已签名 M03 的总治法原文" },
  // ── 随证加减：一条不合格就去掉这一条 ──
  { pattern: /^modification_\d+_.+$/, action: "drop_modification", why: "随证加减是可选建议，不合格的这一条去掉" },
  // ── 归属 M03 的字段被改写：逐字回绑 ──
  { pattern: /^(?:primary_syndrome_drift|pathogenesis_drift|therapy_drift)$/, action: "rebind_prior", why: "证候、病机、治则归 M03 所有，按已签名 M03 逐字回绑" },
  // ── 方名身份：剥离为自拟方，组成照留 ──
  { pattern: /^(?:named_formula_positive_sufficiency_missing.*|formula_(?:selection_missed_lockable|reference_missing|reference_display_mismatch|direction_drift|reference_contract_missing|reference_ambiguous|reference_selection_drift|compilation_composition_drift|compilation_contract_missing|reference_declassified|name_requires_modified_suffix|component_.+_unverified))$/, action: "declassify_identity", why: "方名对不上组成或证候：剥离方名按自拟方交付，药味照留" },
  { pattern: /^candidate_count$/, action: "keep_first_candidate", why: "只交付第一个候选方" },
  // ── 登记过的不保底 ──
  { pattern: /^(?:candidates_empty|candidate_\d+_herbs_empty)$/, action: "none", why: "没有药味可保" },
  { pattern: /^candidate_\d+_classic_contraindication_.+$/, action: "none", why: "整首方剂在本例属禁忌（不是某一味），去掉方名药味仍在，不能保底" },
  { pattern: /^(?:candidate_\d+_)?transparent_therapy_(?:contract_missing|herbs_missing|unresolved)$/, action: "none", why: "候选或 M03 结构本身缺失，无从处理" },
  { pattern: /^(?:candidate_\d+_)?transparent_therapy_(?:coverage|herb_support|herb_knowledge_missing)$/, action: "none", why: "治法词表覆盖属质量项：受理判据本就带批注放行，不会作为不合格原因出现" },
  { pattern: /^stage$/, action: "none", why: "不是开方结果" },
];

/** 原因码归一：去掉调用方各自加的前缀。 */
export function normalizeM04SalvageCode(code: string): string {
  return String(code || "").trim()
    .replace(/^finalized_prescription_/u, "")
    .replace(/^m04_/u, "");
}

export function m04SalvageRuleFor(code: string): { action: M04SalvageAction; why: string } | undefined {
  const normalized = normalizeM04SalvageCode(code);
  const rule = M04_SALVAGE_RULES.find((item) => item.pattern.test(normalized));
  return rule ? { action: rule.action, why: rule.why } : undefined;
}

export type M04SalvageStep = { code: string; action: M04SalvageAction; herb?: string; note?: string };

export type M04SalvageContext = {
  prior: ClinicalReasoningResultV2;
  clinicalContext: string;
  /** 调用方的那道检查：返回仍不合格的原因码，合格返回 undefined/空串。每一步之后都会重跑。 */
  issueOf: (content: string) => string | undefined;
  /** 剥离方名身份（diagnosis-api 的 markTransparentFormulaDeclassification；避免循环依赖由调用方传入）。 */
  declassify?: (content: string) => string;
  /** 去掉药味之后的收尾（重写煎服行等）；缺省只去掉注意事项里点名已不在方中的药。 */
  afterHerbRemoval?: (content: string) => string;
};

type Json = Record<string, unknown>;
function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function withParsed(content: string, edit: (reasoning: Json) => boolean): string | undefined {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return undefined;
  let reasoning: Json;
  try {
    reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Json;
  } catch {
    return undefined;
  }
  if (!edit(reasoning)) return undefined;
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
}

function firstCandidate(reasoning: Json): Json | undefined {
  const candidates = record(reasoning.formula)?.candidates;
  return Array.isArray(candidates) ? record(candidates[0]) : undefined;
}

function herbIndexOf(code: string): number | undefined {
  const match = normalizeM04SalvageCode(code).match(/(?:^|_)herb_(\d+)_/u);
  return match ? Number(match[1]) : undefined;
}

function modificationIndexOf(code: string): number | undefined {
  const match = normalizeM04SalvageCode(code).match(/^modification_(\d+)_/u);
  return match ? Number(match[1]) : undefined;
}

type PriorNode = { id: string; text: string; therapy: string };
function priorNodes(prior: ClinicalReasoningResultV2): PriorNode[] {
  return (prior.pathogenesis?.chain || []).map((node, index) => {
    const raw = node as unknown as Json;
    const id = typeof raw.nodeId === "string" && /^P\d{1,2}$/.test(raw.nodeId) ? raw.nodeId : `P${index + 1}`;
    return {
      id,
      text: String(raw.pathogenesis || raw.syndromeEvidence || "").trim(),
      therapy: String(raw.therapy || raw.treatment || "").trim(),
    };
  }).filter((node) => node.text);
}

function bigrams(text: string): Set<string> {
  const clean = String(text || "").replace(/[^\p{Script=Han}]/gu, "");
  const out = new Set<string>();
  for (let index = 0; index + 1 < clean.length; index += 1) out.add(clean.slice(index, index + 2));
  return out;
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) if (right.has(item)) count += 1;
  return count;
}

/** 药味该指向的节点：君药指第一节点；其余按「药的功效 + 模型写的靶点」与「节点病机 + 节点治法」的字面重合取最高，打平取第一节点。 */
function bestNodeForHerb(herb: Json, nodes: PriorNode[]): PriorNode {
  if (herb.role === "君") return nodes[0];
  const name = String(herb.name || "");
  const herbText = [herb.function, herb.targetPathogenesis, herb.prescriptionRole, getTcmHerbFunctionText(canonicalTcmHerbIdentity(name) || name)]
    .filter((value): value is string => typeof value === "string").join("；");
  const herbGrams = bigrams(herbText);
  let best = nodes[0];
  let bestScore = 0;
  for (const node of nodes) {
    const score = overlap(herbGrams, bigrams(`${node.text}；${node.therapy}`));
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

function pointHerbAt(herb: Json, node: PriorNode): void {
  herb.targetKind = "pathogenesis_node";
  herb.targetRef = node.id;
  herb.targetPathogenesis = node.text;
  delete herb.structureRole;
}

function roleOf(herb: unknown): string {
  return String(record(herb)?.role || "").trim();
}
function nameOf(herb: unknown): string {
  return String(record(herb)?.name || "").trim();
}

function promoteToEmperor(herb: Json, nodes: PriorNode[]): void {
  herb.role = "君";
  if (typeof herb.prescriptionRole === "string") herb.prescriptionRole = herb.prescriptionRole.replace(/^[臣佐使]药/u, "君药");
  if (nodes[0]) pointHerbAt(herb, nodes[0]);
}

/** 唯一君药被去掉时接任的臣药：先取指向第一节点的臣药，其次第一味臣药；跳过自身就与本例安全边界冲突或须医生单独定量的。 */
function emperorHeir(herbs: unknown[], removedIndex: number, clinicalContext: string, nodes: PriorNode[], prior: ClinicalReasoningResultV2): Json | undefined {
  const eligible = herbs
    .map((value, index) => ({ herb: record(value), index }))
    .filter((item): item is { herb: Json; index: number } => Boolean(item.herb) && item.index !== removedIndex)
    .filter(({ herb }) => !clinicianDoseHerbClass(nameOf(herb)) && !m04GenerationSpecialPopulationIssue([{ name: nameOf(herb), role: "君" }], clinicalContext));
  const first = nodes[0]?.id;
  const ministers = eligible.filter(({ herb }) => roleOf(herb) === "臣");
  return (ministers.find(({ herb }) => herb.targetRef === first) || ministers[0] ||
    eligible.find(({ herb }) => roleOf(herb) === "佐" && first && herb.targetRef === first && herbShortlistDirectionEligible(nameOf(herb), prior)))?.herb;
}

/** Used in the existing candidate repair draw, before deterministic salvage. */
export function uniqueEmperorRepairHint(herbs: readonly unknown[], reason: string): string | undefined {
  const code = normalizeM04SalvageCode(reason);
  const index = herbIndexOf(code);
  if (index === undefined || !/_special_population_high_risk_/u.test(code) || roleOf(herbs[index]) !== "君" ||
      herbs.filter((herb) => roleOf(herb) === "君").length !== 1) return undefined;
  return `原定君药${nameOf(herbs[index])}不适合本例（${specialPopulationConflictLabel(code)}）。重拟处方时去掉此药，也避开因同一原因不宜使用的药。在本例可任君药的候选中，选有教材功效、可核用量并能承担主要治法的药接任。若由方中臣佐药接任，说明其为何适合；每味药均须重新过剂量和配伍核对。`;
}

function removalReason(code: string, herbName: string): string {
  const normalized = normalizeM04SalvageCode(code);
  if (/_special_population_/u.test(normalized)) return specialPopulationConflictLabel(normalized.replace(/^.*?(?=herb_\d+_special_population_)/u, ""));
  if (/_unsupported_high_impact_/u.test(normalized)) return "药性方向与本例治法相反";
  if (/_pathogenesis_unaligned_/u.test(normalized)) return "与本例病机对立";
  if (/_(?:unknown|name)$/u.test(normalized)) return "未查到这一味的规范药名，无法核对用量与配伍；如需使用请医生另行开具";
  if (/_dose$/u.test(normalized)) return "未写明可核对的剂量；如需使用请医生另定用量";
  if (/_route_not_decoction$/u.test(normalized)) return "不能与他药同煎；如需使用请医生另行开具（冲服或溶化）";
  if (/_dose_sanity_ceiling$/u.test(normalized)) return "须由医生单独定量或用量明显超出常用范围；如需使用请医生另行开具";
  if (/_dose_outside_conservative_range$/u.test(normalized)) {
    return `用量超出可核对的范围，${clinicianDoseHerbClass(herbName) ? "须由医生单独定量" : "有毒或缺少可压的上限，系统不自动减量"}；如需使用请医生另定用量`;
  }
  return "本例不宜";
}

/** 去掉第 index 味药（唯一君药时由臣药接任）。返回去掉的药名与写给医生的说明；不能去时 undefined。 */
function removeHerb(reasoning: Json, index: number, reason: string, ctx: M04SalvageContext): { herb: string; note: string } | undefined {
  const candidate = firstCandidate(reasoning);
  const herbs = candidate?.herbs;
  if (!candidate || !Array.isArray(herbs) || index < 0 || index >= herbs.length) return undefined;
  if (herbs.length - 1 < MIN_RETAINED_HERBS) return undefined;
  const target = record(herbs[index]);
  if (!target) return undefined;
  const nodes = priorNodes(ctx.prior);
  const removedName = nameOf(target);
  let heirNote = "";
  if (roleOf(target) === "君" && herbs.filter((value) => roleOf(value) === "君").length <= 1) {
    const heir = emperorHeir(herbs, index, ctx.clinicalContext, nodes, ctx.prior);
    if (!heir) return undefined;
    promoteToEmperor(heir, nodes);
    heirNote = `，${nameOf(heir)}改作君药`;
  }
  const retained = herbs.filter((_, position) => position !== index);
  candidate.herbs = retained;
  const retainedNames = retained.map(nameOf).filter(Boolean);
  if (typeof candidate.formulaAnalysis === "string") {
    candidate.formulaAnalysis = formulaAnalysisAfterHerbRemoval(candidate.formulaAnalysis, retainedNames);
  }
  const formula = record(reasoning.formula);
  if (formula && Array.isArray(formula.modifications)) {
    formula.modifications = withoutModificationsOnAbsentHerbs(formula.modifications, retainedNames);
  }
  const note = `按本例情况已去除：${removedName}（${reason}）${heirNote}`;
  candidate.notApplicable = appendCaseSafetyNote(typeof candidate.notApplicable === "string" ? candidate.notApplicable.trim() : "", note);
  return { herb: removedName, note };
}

type ApplyResult = { content: string; herb?: string; note?: string } | undefined;

function applyRule(content: string, code: string, action: M04SalvageAction, ctx: M04SalvageContext): ApplyResult {
  const herbIndex = herbIndexOf(code);
  const nodes = priorNodes(ctx.prior);
  let herbName: string | undefined;
  let note: string | undefined;
  const finishRemoval = (next: string | undefined): ApplyResult => {
    if (!next) return undefined;
    const cleaned = (ctx.afterHerbRemoval || withoutPrecautionsNamingAbsentHerbs)(next);
    return { content: cleaned, herb: herbName, note };
  };
  switch (action) {
    case "repoint_target": {
      if (herbIndex == null || nodes.length === 0) return undefined;
      const next = withParsed(content, (reasoning) => {
        const herb = record(firstCandidate(reasoning)?.herbs && (firstCandidate(reasoning)!.herbs as unknown[])[herbIndex]);
        if (!herb) return false;
        herbName = nameOf(herb);
        pointHerbAt(herb, bestNodeForHerb(herb, nodes));
        return true;
      });
      return next ? { content: next, herb: herbName } : undefined;
    }
    case "repair_function": {
      if (herbIndex == null) return undefined;
      const next = withParsed(content, (reasoning) => {
        const herbs = firstCandidate(reasoning)?.herbs;
        const herb = record(Array.isArray(herbs) ? herbs[herbIndex] : undefined);
        if (!herb) return false;
        const selected = selectGroundedHerbFunction({ name: nameOf(herb), role: roleOf(herb),
          target: String(herb.targetPathogenesis || ""), therapy: String(ctx.prior.therapy?.overallMethod || ""),
          patient: { recordText: ctx.clinicalContext } });
        const source = selected.sources.find((row) => !/^有(?:大|小)?毒$/u.test(row.text));
        if (!source || !selected.text || selected.text === herb.function) return false;
        herb.function = selected.text;
        const note = `${nameOf(herb)}在本方取${source.text}之用（${source.sourceRef}）。`;
        const reasons = Array.isArray(herb.verificationReasons) ? herb.verificationReasons : [];
        if (reasons.length < 8) herb.verificationReasons = [...new Set([...reasons, note])];
        else {
          const candidate = firstCandidate(reasoning)!;
          candidate.notApplicable = appendCaseSafetyNote(String(candidate.notApplicable || ""), note);
        }
        return true;
      });
      return next ? { content: next } : undefined;
    }
    case "remove_herb": {
      if (herbIndex == null) return undefined;
      const next = withParsed(content, (reasoning) => {
        const candidate = firstCandidate(reasoning);
        const herb = record(Array.isArray(candidate?.herbs) ? candidate!.herbs[herbIndex] : undefined);
        if (!herb) return false;
        const removed = removeHerb(reasoning, herbIndex, removalReason(code, nameOf(herb)), ctx);
        if (!removed) return false;
        herbName = removed.herb;
        note = removed.note;
        return true;
      });
      return finishRemoval(next);
    }
    case "fill_decoction_requirement": {
      if (herbIndex == null) return undefined;
      const next = withParsed(content, (reasoning) => {
        const herb = record(firstCandidate(reasoning)?.herbs && (firstCandidate(reasoning)!.herbs as unknown[])[herbIndex]);
        if (!herb) return false;
        herbName = nameOf(herb);
        const required = requiredDecoctionRequirement(herbName);
        if (!required) return false;
        const previous = typeof herb.decoctionRequirement === "string" ? herb.decoctionRequirement.trim() : "";
        if (previous.includes(required)) return false;
        herb.decoctionRequirement = previous ? `${required}；${previous}` : required;
        return true;
      });
      return next ? { content: next, herb: herbName } : undefined;
    }
    case "remove_lower_of_pair": {
      const next = withParsed(content, (reasoning) => {
        const herbs = firstCandidate(reasoning)?.herbs;
        if (!Array.isArray(herbs)) return false;
        const names = herbs.map(nameOf);
        const pair = findTcmHerbPairIncompatibilities(names)[0];
        if (!pair) return false;
        const indexOf = (drug: string) => names.findIndex((name) => name === drug ||
          canonicalTcmHerbIdentity(name) === canonicalTcmHerbIdentity(drug) || name.includes(drug) || drug.includes(name));
        const left = indexOf(String(pair.leftDrug || ""));
        const right = indexOf(String(pair.rightDrug || ""));
        if (left < 0 || right < 0 || left === right) return false;
        const rank = (index: number) => ROLE_RANK[roleOf(herbs[index])] ?? 2;
        const drop = rank(left) === rank(right) ? Math.max(left, right) : rank(left) > rank(right) ? left : right;
        const keep = drop === left ? right : left;
        const removed = removeHerb(reasoning, drop, `与${names[keep]}属${pair.category || "十八反十九畏"}`, ctx);
        if (!removed) return false;
        herbName = removed.herb;
        note = removed.note;
        return true;
      });
      return finishRemoval(next);
    }
    case "dedupe_herb": {
      const next = withParsed(content, (reasoning) => {
        const herbs = firstCandidate(reasoning)?.herbs;
        if (!Array.isArray(herbs)) return false;
        const identities = herbs.map((value) => canonicalTcmHerbIdentity(nameOf(value)) || nameOf(value));
        for (let later = 1; later < identities.length; later += 1) {
          const earlier = identities.indexOf(identities[later]);
          if (earlier < 0 || earlier === later) continue;
          const rank = (index: number) => ROLE_RANK[roleOf(herbs[index])] ?? 2;
          const drop = rank(later) >= rank(earlier) ? later : earlier;
          const removed = removeHerb(reasoning, drop, "与方中同一味药重复", ctx);
          if (!removed) return false;
          herbName = removed.herb;
          note = removed.note;
          return true;
        }
        return false;
      });
      return finishRemoval(next);
    }
    case "fix_regimen":
    case "fix_administration": {
      const next = withParsed(content, (reasoning) => {
        const candidate = firstCandidate(reasoning);
        if (!candidate) return false;
        const decoction = record(candidate.decoction) || {};
        const before = JSON.stringify(decoction);
        const dosesPerDay = Number.isInteger(decoction.dosesPerDay) && (decoction.dosesPerDay as number) >= 1 && (decoction.dosesPerDay as number) <= 3
          ? decoction.dosesPerDay as number : 1;
        const countMatch = String(decoction.doseCount || "").match(/(\d+)/u);
        const writtenCount = countMatch ? Number(countMatch[1]) : NaN;
        const doseCount = Number.isInteger(writtenCount) && writtenCount >= 1 && writtenCount <= 30 ? writtenCount : 7;
        const days = Math.max(1, Math.round(doseCount / dosesPerDay));
        decoction.dosesPerDay = dosesPerDay;
        decoction.doseCount = `${days * dosesPerDay}剂`;
        decoction.course = `${days}日`;
        const times = decoction.administrationTimesPerDay;
        if (!Number.isInteger(times) || (times as number) < dosesPerDay || (times as number) < 1 || (times as number) > 6) {
          decoction.administrationTimesPerDay = Math.min(6, dosesPerDay * 2);
        }
        candidate.decoction = decoction;
        return JSON.stringify(decoction) !== before;
      });
      return next ? { content: next } : undefined;
    }
    case "drop_modification": {
      const modificationIndex = modificationIndexOf(code);
      if (modificationIndex == null) return undefined;
      const next = withParsed(content, (reasoning) => {
        const formula = record(reasoning.formula);
        const rows = formula?.modifications;
        if (!formula || !Array.isArray(rows) || modificationIndex >= rows.length) return false;
        herbName = String(record(rows[modificationIndex])?.herbName || "") || undefined;
        formula.modifications = rows.filter((_, index) => index !== modificationIndex);
        return true;
      });
      return next ? { content: next, herb: herbName } : undefined;
    }
    case "rebind_prior": {
      const next = enforceM04PriorStageOwnership(content, ctx.prior as unknown as Record<string, unknown>);
      return next !== content ? { content: next } : undefined;
    }
    case "align_therapy_match": {
      // 编译器本就按已签名 M03 的 overallPrinciple 写 therapyMatch（合同按原文受理），这里同一取值。
      const locked = String(ctx.prior.therapy?.overallPrinciple || ctx.prior.therapy?.overallMethod || "").trim();
      if (!locked) return undefined;
      const next = withParsed(content, (reasoning) => {
        const candidate = firstCandidate(reasoning);
        if (!candidate || candidate.therapyMatch === locked) return false;
        candidate.therapyMatch = locked;
        return true;
      });
      return next ? { content: next } : undefined;
    }
    case "demote_extra_emperors": {
      const next = withParsed(content, (reasoning) => {
        const herbs = firstCandidate(reasoning)?.herbs;
        if (!Array.isArray(herbs)) return false;
        const emperors = herbs.map(record).filter((herb): herb is Json => Boolean(herb) && herb!.role === "君");
        if (emperors.length <= 2) return false;
        const first = nodes[0]?.id;
        const keep = [...emperors].sort((left, right) => Number(right.targetRef === first) - Number(left.targetRef === first)).slice(0, 2);
        for (const herb of emperors) {
          if (keep.includes(herb)) continue;
          herb.role = "臣";
          if (typeof herb.prescriptionRole === "string") herb.prescriptionRole = herb.prescriptionRole.replace(/^君药/u, "臣药");
        }
        return true;
      });
      return next ? { content: next } : undefined;
    }
    case "promote_emperor": {
      const next = withParsed(content, (reasoning) => {
        const herbs = firstCandidate(reasoning)?.herbs;
        if (!Array.isArray(herbs) || herbs.some((value) => roleOf(value) === "君")) return false;
        const heir = emperorHeir(herbs, -1, ctx.clinicalContext, nodes, ctx.prior);
        if (!heir) return false;
        promoteToEmperor(heir, nodes);
        herbName = nameOf(heir);
        return true;
      });
      return next ? { content: next, herb: herbName } : undefined;
    }
    case "declassify_identity": {
      // 先按调用方的剥离方式（能记成「X加减」的记成加减）。它没有改动、或改完同一个原因还在时，直接剥成自拟方、组成与剂量照留
      //（第六十二轮实链 f23：月经过少·肾阳虚证开出归肾丸原方，「方名与本证的正向依据不足」，调用方的剥离认为组成与目录相符不必改，
      // 于是这一步没有任何动作，整页退成不给剂量）。
      const first = ctx.declassify ? ctx.declassify(content) : content;
      if (first !== content && normalizeM04SalvageCode(ctx.issueOf(first) || "") !== code) return { content: first };
      const stripped = deliveredFormDeclassification(content, ctx.prior);
      return stripped !== content ? { content: stripped } : undefined;
    }
    case "keep_first_candidate": {
      const next = withParsed(content, (reasoning) => {
        const formula = record(reasoning.formula);
        if (!formula || !Array.isArray(formula.candidates) || formula.candidates.length <= 1) return false;
        formula.candidates = formula.candidates.slice(0, 1);
        return true;
      });
      return next ? { content: next } : undefined;
    }
    case "none":
    default:
      return undefined;
  }
}

/**
 * 按原因逐步处理，直到调用方的检查通过。通过时返回处理后的内容与步骤（steps 可能为空：一开始就合格）；
 * 遇到登记为不保底的原因、未登记的原因、处理后内容不变或步数用完时返回 undefined（每一步都是删除或把字段改成确定值，步数上限只是兜底）。
 */
export function salvageM04Content(content: string, ctx: M04SalvageContext): { content: string; steps: M04SalvageStep[] } | undefined {
  let current = content;
  const steps: M04SalvageStep[] = [];
  for (let step = 0; step <= MAX_SALVAGE_STEPS; step += 1) {
    const code = normalizeM04SalvageCode(ctx.issueOf(current) || "");
    if (!code) return { content: current, steps };
    if (step === MAX_SALVAGE_STEPS) return undefined;
    const rule = m04SalvageRuleFor(code);
    if (!rule || rule.action === "none") return undefined;
    const applied = applyRule(current, code, rule.action, ctx);
    if (!applied || applied.content === current) return undefined;
    steps.push({ code, action: rule.action, ...(applied.herb ? { herb: applied.herb } : {}), ...(applied.note ? { note: applied.note } : {}) });
    current = applied.content;
  }
  return undefined;
}

/** 遥测：只有原因码、处理方式与药名（药名不是 PHI）。 */
export function m04SalvageTelemetry(steps: readonly M04SalvageStep[]): Array<{ code: string; action: M04SalvageAction; herb?: string }> {
  return steps.map(({ code, action, herb }) => ({ code, action, ...(herb ? { herb } : {}) }));
}

/**
 * 交付形态的剥离方名（交付闸门里用）：交付面已经投影过，不能再走内部写法「本例辨证组方」（之后不会再投影，医生会看到内部写法）。
 * 已呈现为自拟（方名表为空）的只补服务端剥离标记、方名照留；仍自称某方的写交付形态——方名「自拟方」、方名表清空、标上标记
 *（合同凭这个标记认作已剥离，isDeclassifiedSelfDevisedCandidate）。
 */
export function deliveredFormDeclassification(content: string, prior?: ClinicalReasoningResultV2 | null): string {
  const next = withParsed(content, (reasoning) => {
    const candidate = firstCandidate(reasoning);
    if (!candidate) return false;
    if (candidate.identityDeclassified === true && (candidate.name === "自拟方" || candidate.name === "本例辨证组方")) return false;
    // 交付面已经把它呈现为不沿用方名身份的方（自拟、方名表为空）、方名栏写的是「X加减」这类给医生看的写法：只补服务端剥离标记，方名照留
    //（第五十七轮回放 C012：「茵陈蒿汤加减」被改成「自拟方」，医生少了「以茵陈蒿汤为基础」这一信息）。
    if (candidate.identityDeclassified !== true && candidate.constructionType === "self_devised" && Array.isArray(candidate.formulaNames) && candidate.formulaNames.length === 0) {
      candidate.identityDeclassified = true;
      return true;
    }
    const previous = [
      ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
      ...(typeof candidate.name === "string" ? identifyKnownFormulaNames(candidate.name) : []),
      ...(Array.isArray(prior?.overview?.recommendedFormulaNames) ? prior!.overview!.recommendedFormulaNames as unknown[] : []),
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    candidate.name = "自拟方";
    candidate.constructionType = "self_devised";
    candidate.formulaNames = [];
    candidate.baseFormulas = [];
    candidate.identityDeclassified = true;
    if (previous.length > 0 && !Array.isArray(candidate.declassifiedFromFormulaNames)) candidate.declassifiedFromFormulaNames = [...new Set(previous.map((value) => value.trim()))].slice(0, 4);
    return true;
  });
  return next || content;
}


/** Recover only a retained rejection which the current checkpoint contract reproduces.
 * A new checkpoint has to pass the route transform and the entire continuity contract. */
export function repairRetainedM04<T extends { content: string; contractIssues?: readonly string[] }>(
  previous: T, ctx: Omit<M04SalvageContext, "issueOf">, inspect: (content: string) => T | undefined,
  transform: (content: string) => string,
): T | undefined {
  const originalIssues = previous.contractIssues || [];
  if (!originalIssues.length || originalIssues.some((code) => !m04SalvageRuleFor(code) || m04SalvageRuleFor(code)?.action === "none")) return undefined;
  try {
    const reproduced = inspect(previous.content)?.contractIssues || [];
    if (!originalIssues.every((code) => reproduced.includes(code))) return undefined;
    const repaired = salvageM04Content(previous.content, { ...ctx, issueOf(content) {
      const checked = inspect(content);
      return checked ? checked.contractIssues?.[0] : "stage";
    } });
    if (!repaired?.steps.length) return undefined;
    const checked = inspect(transform(repaired.content));
    return checked && !checked.contractIssues?.length ? checked : undefined;
  } catch { return undefined; }
}

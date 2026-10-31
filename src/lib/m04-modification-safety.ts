import { canonicalTcmHerbIdentity, finalModificationTriggerGrounded, textbookModificationsThin, m04CandidateOpposingDirectionIndices, m04HerbOpposingDirectionIssue, m04ModificationSafetyIssue, signedTextbookFormulaIngredients, m04GenerationSpecialPopulationIssue, normalizeComparableDose } from "./diagnosis-stage-contract";
import { executableFormulaCompilationReferences } from "./tcm-formula-provenance";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { normalizedFormulaModificationFields } from "./formula-modification";
import { formulaAnalysisAfterHerbRemoval } from "./formula-analysis-review";
import { clinicianDoseHerbClass, findTcmHerbPairIncompatibilities, getTcmHerbFunctionCategories, isKnownTcmHerbName } from "./tcm-knowledge";
import { precautionWithoutAbsentHerbs } from "./m04-proposal-compiler";
import { formulaTextbookCommentary } from "./formula-textbook-commentary";
import sameSourceHerbs from "../data/tcm-same-source-herbs.source.json" with { type: "json" };
import { herbAnyRecordCautionConflict, herbRecordCautionIsHard } from "./herb-record-caution";

const SAME_SOURCE_HERB_GROUPS = (sameSourceHerbs as { groups: ReadonlyArray<{ id: string; herbs: string[]; reason: string }> }).groups;

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const TRANSIENT_SLEEP_TRIGGER = /(?:睡眠欠佳|睡眠不佳|眠差|失眠|入睡困难|夜寐不安|多梦易醒)/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTransientAcuteExteriorSleepModification(
  modification: Record<string, unknown>,
  prior: ClinicalReasoningResultV2,
): boolean {
  const trigger = typeof modification.trigger === "string" ? modification.trigger.trim() : "";
  if (!TRANSIENT_SLEEP_TRIGGER.test(trigger)) return false;
  const syndrome = String(prior.overview?.primarySyndrome || "");
  if (!/(?:风寒|风热)(?:束表|犯表|袭表)|太阳伤寒/.test(syndrome)) return false;
  const factText = [
    ...(prior.overview?.primarySyndromeBasis || []),
    ...(prior.pathogenesis?.chain || []).flatMap((node) => [node.patientFact, node.syndromeEvidence]),
    ...(prior.westernDiagnosis?.primary?.supportingFacts || []),
  ].filter((value): value is string => typeof value === "string").join("；");
  if (!/(?:半日|[1-7一二三四五六七两]\+?\s*(?:天|日))/.test(factText)) return false;
  // 睡眠本身有月/年级病程或长期反复时是独立治疗目标，不按急性外感伴随表现删除。
  const chronicSleep = new RegExp(
    `(?:${TRANSIENT_SLEEP_TRIGGER.source})[^。；]{0,16}(?:月|年|长期|反复)|(?:月|年|长期|反复)[^。；]{0,16}(?:${TRANSIENT_SLEEP_TRIGGER.source})`,
  );
  return !chronicSleep.test(factText);
}

/**
 * Conditional modifications are optional decision support, not part of the current audited dose
 * candidate. The proposal compiler already drops an `add` row whose herb introduces a high-impact
 * direction absent from signed M03. Providers can nevertheless return a legacy full reasoning-v2
 * envelope, so apply the same invariant to every completed M04 envelope before review/signing.
 *
 * Only the unsupported optional row is removed. The candidate prescription and every other field
 * remain unchanged and still pass the complete M04 contract, independent review and external audit.
 */
export function dropUnsupportedM04ModificationDirections(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): string {
  if (!prior || prior.stage !== "diagnose") return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const modifications = formula?.modifications;
    if (!formula || !Array.isArray(modifications) || modifications.length === 0) return content;
    const firstCandidate = Array.isArray(formula.candidates) ? recordValue(formula.candidates[0]) : undefined;
    const candidateHerbIdentities = new Set((Array.isArray(firstCandidate?.herbs) ? firstCandidate.herbs : [])
      .map((herb) => canonicalTcmHerbIdentity(recordValue(herb)?.name))
      .filter(Boolean));
    const retained = modifications.filter((value, modificationIndex) => {
      const modification = recordValue(value);
      if (!modification) return true;
      if (isTransientAcuteExteriorSleepModification(modification, prior)) return false;
      // Conditional rows are optional advice, not part of the audited current-dose candidate.
      // A trigger that is not already present in signed M03 cannot be made true by wording; drop
      // that row before review instead of spending a model round repairing non-clinical metadata.
      // Rows the safety floor would reject (dose text, unknown herb, unsupported high-impact
      // direction) are dropped below by the floor's own predicate — deletion only, never accepted.
      const trigger = typeof modification.trigger === "string" ? modification.trigger.trim() : "";
      const candidateHerbNames = (Array.isArray(firstCandidate?.herbs) ? firstCandidate.herbs : [])
        .map((herb) => String(recordValue(herb)?.name || "").trim()).filter(Boolean);
      if (!trigger || !finalModificationTriggerGrounded(trigger, prior, candidateHerbNames, { textbookThin: textbookModificationsThin(modifications.map((row) => recordValue(row) || {}), prior) })) return false;
      const fields = normalizedFormulaModificationFields(modification);
      // 最终出口再核一次「加的药已在方中 / 减的药不在方中」（2026-09-29 甲方测评 2.2：腰痛例建议加熟地黄，
      // 而熟地黄已在原方）。编译期 normalizeModifications 按**当时**的药味核过，但 candidate 定向修复会
      // 改写药味、却把加减从上一版原样拼回——那一版核对就过期了。这里按最终药味删行，只删不增。
      if (fields && candidateHerbIdentities.size > 0) {
        const identity = canonicalTcmHerbIdentity(fields.herbName);
        if (fields.action === "加" && candidateHerbIdentities.has(identity)) return false;
        if (fields.action !== "加" && identity && !candidateHerbIdentities.has(identity)) return false;
      }
      // 开方安全底线会拒的行在这里就去掉（与底线同一判据 m04ModificationSafetyIssue：剂量文字、未收载药味、方向未成立的高影响药；
      // 教材条件式加减不核方向）。此前这里只删「方向对立」的，「方向未成立」的留到底线被拒，一条加减让整方退成不给剂量（第三十一轮）。
      return !m04ModificationSafetyIssue(modification, modificationIndex, prior, isKnownTcmHerbName);
    });
    if (retained.length === modifications.length) return content;
    formula.modifications = retained;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

function forceDirectionPruningDeclassification(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const candidates = formula?.candidates;
    if (!formula || !Array.isArray(candidates) || candidates.length !== 1) return content;
    const candidate = recordValue(candidates[0]);
    if (!candidate) return content;
    if (candidate.identityDeclassified === true && candidate.constructionType === "self_devised") return content;
    const priorNames = Array.isArray(prior?.overview?.recommendedFormulaNames)
      ? prior.overview.recommendedFormulaNames
      : [];
    const originalNames = [
      ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
      ...(typeof candidate.name === "string" && !/本例辨证组方/.test(candidate.name) ? [candidate.name] : []),
      ...priorNames,
    ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const hadModifiedLabel = typeof candidate.name === "string" && /(?:加减|化裁|加味)/.test(candidate.name);
    formula.candidates = [{
      ...candidate,
      name: hadModifiedLabel ? "本例辨证组方加减" : "本例辨证组方",
      formulaNames: [],
      baseFormulas: [],
      constructionType: "self_devised",
      identityDeclassified: true,
      identityDeclassificationReason: "opposing_direction_pruned",
      declassifiedFromFormulaNames: [...new Set(originalNames.map((value) => value.trim()))].slice(0, 4),
    }];
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

function hasExplicitSelfDevisedDeclassification(content: string): boolean {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return false;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const candidates = formula?.candidates;
    const candidate = Array.isArray(candidates) && candidates.length === 1 ? recordValue(candidates[0]) : undefined;
    return candidate?.identityDeclassified === true && candidate?.constructionType === "self_devised";
  } catch {
    return false;
  }
}

/**
 * A true opposing-direction deletion changes the claimed formula composition. Remove the named
 * identity first, then delete, and keep the original bytes unless the deletion can complete without
 * emptying the therapeutic plan. This makes the ordering an invariant at every caller instead of a
 * convention that can be skipped by one finalizer.
 */
export function declassifyAndDropOpposingM04CandidateHerbs(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): string {
  if (hasExplicitSelfDevisedDeclassification(content)) {
    return dropUnsupportedM04CandidateHerbs(content, prior, false);
  }
  // A governed classic baseline may intentionally contain a controlled counter-direction herb
  // (for example 左金丸中的吴茱萸). First ask the existing named-identity predicate whether a
  // removable *non-baseline* opposing addition exists. If not, do not declassify the formula at all.
  const prunableWhileNamed = dropUnsupportedM04CandidateHerbs(content, prior, true);
  if (prunableWhileNamed === content) return content;
  const declassified = forceDirectionPruningDeclassification(content, prior);
  const pruned = dropUnsupportedM04CandidateHerbs(declassified, prior, false);
  return pruned === declassified ? content : pruned;
}

/**
 * 类的另一半：**实际药味**里方向未成立的加味，按单味剔除而不是让整张方作废。
 *
 * 上面那个函数已经确定性剔除「方向未成立的加减建议」；同一条不变量此前没有覆盖
 * candidate.herbs。后果是单味缺陷被放大成整方级作废：M03 锁定的经典方基准本身完全合格，
 * 只因模型多加了一味方向不成立的药，整张方连同基准药味一起被丢弃，医生拿到 0 味。
 *
 * 实测（甲方 10 例，flash 生产构建）两例同类：
 *   · 感冒-风寒束表锁麻黄汤，基准 4/4 达标，方中多出川芎（blood_move，治法「辛温解表」无活血）；
 *   · 牙痛-胃火炽盛锁清胃散，基准 4/5 达标，方中多出大黄（purge，治法「清胃泻火」无泻下）。
 * 两例修复轮都没删该味，最终 fixpoint 退化成非剂量输出。
 *
 * 四条剔除边界，缺一不可（不满足即原样返回，回到既有驳回行为，安全面一条未放宽）：
 *   1) 只剔除与 M03 锁定治法直接对立的药味——词表未成立只批注、不删药；
 *   2) **唯一合格君药不剔除**：君药决定全方走向。只有模型给出两味君药、其中一味方向不成立，
 *      且删除后仍有另一味直接承接 P1 的合格君药时，才剔除坏的非基准君药；否则必须重选；
 *   3) **基准组成不剔除**：锁定经典方的法定组成本就享受身份豁免，不会走到这里；显式排除以防
 *      别名/饮片名解析差异误删基准药；
 *   4) 剔除后必须仍剩至少一味治疗性药味，且每个锁定基准的保留数仍达标——否则剔除会把一张
 *      合格的经典方削到身份下限以下，那是比原驳回更糟的结果。
 *
 * 剔除后的候选仍走完整既有链路：君臣佐使、剂量边界、P 节点引用、独立临床复核、灵犀审方
 * 一条不减。本函数只做减法，绝不新增药味、剂量或病机节点。
 */
export function dropUnsupportedM04CandidateHerbs(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
  /**
   * 是否仍需守住经典方基准的最低保留数。正常 finalize 路径为 true（候选还在声称方名，
   * 削到身份下限以下比原驳回更糟）。**透明降级路径必须传 false**：方名已被确定性剥离，
   * 候选不再声称任何经典身份，基准保留数不再是它的约束——继续套用会让「基准本就不满足」的
   * 候选放弃剔除，问题药留在方里，降级验证随即失败，最终仍是 0 味
   *（实测感冒-风寒束表：前胡 heat_clear 未成立，基准不满足 → 放弃剔除 → 降级被拒）。
   */
  enforceBaselineFloor = true,
): string {
  if (!prior || prior.stage !== "diagnose") return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const candidates = formula?.candidates;
    if (!formula || !Array.isArray(candidates) || candidates.length === 0) return content;
    const candidate = recordValue(candidates[0]);
    const herbs = candidate?.herbs;
    if (!candidate || !Array.isArray(herbs) || herbs.length === 0) return content;
    const candidateStillClaimsClassicIdentity = candidate.identityDeclassified !== true &&
      candidate.constructionType !== "self_devised" &&
      Array.isArray(candidate.formulaNames) &&
      candidate.formulaNames.some((name) => typeof name === "string" && Boolean(name.trim()));

    const lockedNames = [
      ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
      ...(Array.isArray(prior.overview?.recommendedFormulaNames) ? prior.overview.recommendedFormulaNames : []),
    ].filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    const baselines = executableFormulaCompilationReferences([...new Set(lockedNames)]);
    // 教材给本证配的代表方（M03 推荐方向里写着、目录锁不住或目录里没有这个名字，如痛风·湿热阻痹「四妙散合宣痹汤」）的原方药味同样是基准：
    // 合同的方向核对早已按它豁免（signedTextbookFormulaIngredients），这里的剔除不能再把它的药（四妙散的苍术）当方向对立的加味删掉
    //（2026-10-20 第八轮，留出例 S145：方义写「黄柏、苍术二药共为君」而药味表没有苍术）。
    const baselineIdentities = new Set([
      ...baselines.flatMap((reference) => reference.ingredients),
      ...signedTextbookFormulaIngredients(prior),
    ].map((name) => canonicalTcmHerbIdentity(name)));
    const supportedPrimaryEmperorCount = herbs.filter((value) => {
      const herb = recordValue(value);
      return herb?.role === "君" && herb.targetKind === "pathogenesis_node" && herb.targetRef === "P1" &&
        !m04HerbOpposingDirectionIssue(herb as Parameters<typeof m04HerbOpposingDirectionIssue>[0], prior);
    }).length;

    // 终审会按方向对立拒的那几味（与终审同一判据）。基准保护只给终审自己也豁免的药：候选已不再声称方名时，
    // M03 锁定方的原方药味不再豁免，留着它只会让终审把整张方拒成非剂量页（第二十七轮 C068）。
    const contractOpposing = m04CandidateOpposingDirectionIndices(
      herbs.map((value) => recordValue(value) || {}) as Parameters<typeof m04CandidateOpposingDirectionIndices>[0],
      prior,
      candidate.formulaNames,
    );
    const retained = herbs.filter((value, index) => {
      const herb = recordValue(value);
      if (!herb) return true;
      const name = typeof herb.name === "string" ? herb.name.trim() : "";
      if (!name) return true;
      // A baseline ingredient is protected only while the candidate still retains that classic
      // identity. The transparent path first makes the identity decision, then calls this function
      // with `false`: a verified classic/modified identity remains protected, while a truly
      // declassified self-devised candidate no longer grants direction immunity to former baseline
      // herbs (production modern-16911: 左金丸 identity removed, but 吴茱萸 remained in a pure
      // heat-clearing plan and the final safety-floor check correctly rejected it).
      if ((enforceBaselineFloor || candidateStillClaimsClassicIdentity) &&
        baselineIdentities.has(canonicalTcmHerbIdentity(name)) && !contractOpposing.has(index)) return true;
      // 与门禁同一入口、同一入参形态：拼接功用串再判会落到 function 分支，与门禁读
      // prescriptionRole/targetPathogenesis 的口径不一致，导致「该剔的没剔、门禁照旧驳回」。
      const directionIssue = m04HerbOpposingDirectionIssue(
        herb as Parameters<typeof m04HerbOpposingDirectionIssue>[0],
        prior,
      );
      if (!directionIssue) return true;
      // A malformed extra emperor must not make a fully supported P1 emperor and every safe herb
      // disappear with it. This is deletion-only and the complete emperor/coverage contract runs
      // again after the transform. With no supported P1 emperor, preserve the row and fail closed.
      if (herb.role === "君") return supportedPrimaryEmperorCount === 0;
      return false;
    });
    if (retained.length === herbs.length) return content;

    const retainedTherapeutic = retained.filter((value) => recordValue(value)?.targetKind !== "formula_structure");
    if (retainedTherapeutic.length === 0) return content;
    const retainedIdentities = new Set(
      retained
        .map((value) => recordValue(value)?.name)
        .filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
        .map((name) => canonicalTcmHerbIdentity(name)),
    );
    // 身份下限只约束仍声称方名的候选：已是自拟方的候选没有「削到身份下限以下」这回事。
    const baselineStillSatisfied = !enforceBaselineFloor || !candidateStillClaimsClassicIdentity || baselines.every((reference) =>
      reference.ingredients.filter((ingredient) => retainedIdentities.has(canonicalTcmHerbIdentity(ingredient))).length
        >= reference.minimumPreservedIngredientCount);
    if (!baselineStillSatisfied) return content;

    candidate.herbs = retained;
    // 方义随删掉的药一起改：按剩下的药味再审一遍，讲被删药味的分句随之删去（2026-10-19；X-G-1785 删了薤白、半夏、天南星、橘红，
    // X-G-2919 删了皂角刺，方义却还在讲它们）。
    if (typeof candidate.formulaAnalysis === "string") {
      candidate.formulaAnalysis = formulaAnalysisAfterHerbRemoval(
        candidate.formulaAnalysis,
        retained.map((value) => recordValue(value)?.name).filter((name): name is string => typeof name === "string" && Boolean(name.trim())),
      );
    }
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

const SAFETY_PRUNE_POPULATION_LABELS: Readonly<Record<string, string>> = {
  pregnancy: "孕期不宜", lactation: "哺乳期不宜", pediatric: "儿童不宜", bleeding_anticoagulation: "出血或抗凝状态不宜",
  older_adult: "老年人不宜", hepatic_impairment: "肝功能不全不宜", renal_impairment: "肾功能不全不宜",
  cardiovascular_disease: "心血管病不宜", cardio_glaucoma_prostate: "心血管病、青光眼或前列腺增生不宜", diabetes: "糖尿病不宜",
  frailty_gastric_weakness: "体虚胃弱不宜", athlete: "运动员不宜", allergy: "与病历记录的过敏原同源",
};
/** 开方核对人群冲突码（herb_N_special_population_high_risk_<code>）→ 写给医生的原因。 */
export function specialPopulationConflictLabel(issue: string): string {
  const code = issue.replace(/^herb_\d+_special_population_high_risk_/u, "");
  return SAFETY_PRUNE_POPULATION_LABELS[code] || "本例特殊人群不宜";
}
const SAFETY_PRUNE_ROLE_RANK: Readonly<Record<string, number>> = { 君: 0, 臣: 1, 佐: 2, 使: 3 };
const SAFETY_PRUNE_MIN_RETAINED = 3;

/**
 * 剂量一致化（用户 2026-10-26 决定 D4）：候选里与本例安全边界冲突的药按单味剔除，剂量照常给，不再让一味药把整张方拖成非剂量页。
 * 剔除三类（判据都是开方核对自己的那一个，不另写）：
 *   1) 人群/过敏/活动性出血冲突：m04GenerationSpecialPopulationIssue 对单味判 HIGH；
 *   2) 方内十八反：findTcmHerbPairIncompatibilities，删两味中地位较低的一味；
 *   3) 须由医生单独定量的管制或濒危药材（dosePassesSafetySanityCeiling 对这两类一律不放行）：还有别的君药时连君药也拿出。
 * 唯一的君药不删（君药决定全方走向，交给修复轮重选），还有别的君药时与其余药味同样剔除；删后不足 3 味不删（交给修复轮）。方义随删掉的药改写，删了什么写进「慎用与不适用」。
 * 必须排在核对与签名之前（finalizeM04CandidateContent）：签名绑定的是剔除后的最终候选。
 */
export function dropSafetyConflictingM04CandidateHerbs(content: string, clinicalContext: string): string {
  if (!clinicalContext.trim()) return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const candidates = recordValue(reasoning.formula)?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return content;
    const candidate = recordValue(candidates[0]);
    const herbs = candidate?.herbs;
    if (!candidate || !Array.isArray(herbs) || herbs.length === 0) return content;
    const nameOf = (value: unknown) => String(recordValue(value)?.name || "").trim();
    const roleOf = (value: unknown) => String(recordValue(value)?.role || "").trim();
    const removed: Array<{ name: string; reason: string }> = [];
    // 须由医生单独定量的管制或濒危药材（羚羊角、麝香、生川乌…，clinicianDoseHerbClass）：合同不许系统给它们剂量，
    // 模型写了剂量整方就退成非剂量页（第二十三轮红旗集：羚角钩藤汤 2 例）。单味拿出、写明请医生另行开具；
    // 它是唯一的君药时不拿（交给修复轮重选）。
    let emperorsLeft = herbs.filter((value) => roleOf(value) === "君").length;
    const overview = recordValue(reasoning.overview);
    const syndromeText = [overview?.primarySyndrome, ...(Array.isArray(overview?.secondarySyndromes) ? overview.secondarySyndromes : [])]
      .filter((value): value is string => typeof value === "string").join("；");
    let retained = herbs.filter((value) => {
      const name = nameOf(value);
      if (!name) return true;
      const regulatory = clinicianDoseHerbClass(name);
      // 药引/辅料（竹沥、姜汁、黄酒、白蜜…，clinicianDoseHerbClass = food_or_vehicle）写成「30ml」「适量」时没有克数，合同按缺剂量整方驳回
      //（第二十五轮甲方 100 例 C048：双合汤带竹沥，整页退成非剂量）。不是君药就单味拿出、写明用量由医师另定；写了克数的照留。
      if (regulatory === "food_or_vehicle" && roleOf(value) !== "君" && !normalizeComparableDose(String(recordValue(value)?.dose || ""))) {
        removed.push({ name, reason: "药引/辅料，如需使用请医生另定用量（多为兑服）" });
        return false;
      }
      if ((regulatory === "controlled_or_toxic" || regulatory === "endangered_or_banned") && (roleOf(value) !== "君" || emperorsLeft > 1)) {
        if (roleOf(value) === "君") emperorsLeft -= 1;
        removed.push({ name, reason: "须由医生单独定量的管制或濒危药材，未列入本方，如需使用请医生另行开具" });
        return false;
      }
      // 教材【使用注意】写明「忌用、不宜」而病历正是这种情况（脾胃虚寒、食少便溏…，herb-record-caution）：原方药味也单味拿出、写明依据
      //（第二十七轮：甲方 10.26 测评病历 3 血虚头痛「黄芩不宜」，病历记便溏、小便清长，三次生成都带黄芩）。君药同下面的规则。
      const recordCaution = herbAnyRecordCautionConflict(name, clinicalContext, syndromeText);
      if (recordCaution && herbRecordCautionIsHard(recordCaution) && (roleOf(value) !== "君" || emperorsLeft > 1)) {
        if (roleOf(value) === "君") emperorsLeft -= 1;
        removed.push({ name, reason: `《中药学》「${recordCaution.condition}者${recordCaution.verb}」，本例${recordCaution.recordFindings.join("、")}` });
        return false;
      }
      const issue = m04GenerationSpecialPopulationIssue([{ name }], clinicalContext);
      if (!issue) return true;
      // 君药与管制药材同一口径：还有别的君药时拿掉这一味，它是唯一的君药时不拿（交给修复轮重选）。生产探针 C098（疑似肺栓塞、
      // 病历记录咯血丝）：丹参与桔梗同为君，丹参因活动性出血不入方，此前整方退成非剂量页（2026-10-27 第二十四轮）。
      if (roleOf(value) === "君") {
        if (emperorsLeft <= 1) return true;
        emperorsLeft -= 1;
      }
      const code = issue.replace(/^herb_\d+_special_population_high_risk_/u, "");
      removed.push({ name, reason: SAFETY_PRUNE_POPULATION_LABELS[code] || "本例特殊人群不宜" });
      return false;
    });
    for (let guard = 0; guard < 6; guard += 1) {
      const names = retained.map(nameOf);
      const pair = findTcmHerbPairIncompatibilities(names)[0];
      if (!pair) break;
      const indexOf = (drug: string) => names.findIndex((name) => name === drug ||
        canonicalTcmHerbIdentity(name) === canonicalTcmHerbIdentity(drug) || name.includes(drug) || drug.includes(name));
      const left = indexOf(String(pair.leftDrug || ""));
      const right = indexOf(String(pair.rightDrug || ""));
      if (left < 0 || right < 0 || left === right) break;
      const rank = (index: number) => SAFETY_PRUNE_ROLE_RANK[roleOf(retained[index])] ?? 2;
      const drop = rank(left) === rank(right) ? Math.max(left, right) : rank(left) > rank(right) ? left : right;
      if (roleOf(retained[drop]) === "君") break;
      removed.push({ name: names[drop], reason: `与${names[drop === left ? right : left]}属${pair.category || "十八反"}` });
      retained = retained.filter((_, index) => index !== drop);
    }
    // 同属补气药的「参」（人参、党参、太子参、西洋参…）只留一味：甲方 10.12 测评「不要人参党参同用这类重复」，此前只有提示词，
    // 第二十七轮回放 3 份仍同用（C032、C040 人参＋党参，C013 太子参＋西洋参）。留地位高的一味（君＞臣＞佐＞使，同级留先写的），君药不拿。
    const ginsengLike = (value: unknown) => {
      const name = nameOf(value);
      return /参$/u.test(name) && getTcmHerbFunctionCategories(canonicalTcmHerbIdentity(name) || name).includes("补气药");
    };
    const ginsengs = retained.filter(ginsengLike);
    if (ginsengs.length > 1) {
      const rank = (value: unknown) => SAFETY_PRUNE_ROLE_RANK[roleOf(value)] ?? 2;
      const keep = [...ginsengs].sort((a, b) => rank(a) - rank(b))[0];
      const drops = ginsengs.filter((value) => value !== keep && roleOf(value) !== "君");
      for (const value of drops) removed.push({ name: nameOf(value), reason: `与${nameOf(keep)}同属补气的参类，不重复使用` });
      retained = retained.filter((value) => !drops.includes(value));
    }
    // 同一来源、同一方向的药只留一味（tcm-same-source-herbs.source.json），方剂目录原方本来就含两味的不动。
    {
      const baseName = String(candidate.name || "").replace(/(?:加减|加味|化裁)$/u, "");
      const baseIngredients = new Set(executableFormulaCompilationReferences([baseName]).flatMap((reference) => reference.ingredients).map((item) => canonicalTcmHerbIdentity(item)));
      for (const group of SAME_SOURCE_HERB_GROUPS) {
        const inGroup = retained.filter((value) => group.herbs.includes(canonicalTcmHerbIdentity(nameOf(value)) || nameOf(value)));
        // 目录组成常不列煎时加的姜（厚朴温中汤目录只有干姜，方解写「干姜、生姜温脾暖胃」），方解写了也算原方有。
        const commentary = formulaTextbookCommentary(baseName) || "";
        const inBase = inGroup.filter((value) => baseIngredients.has(canonicalTcmHerbIdentity(nameOf(value))) || commentary.includes(nameOf(value)));
        if (inGroup.length < 2 || inBase.length >= 2) continue;
        const rank = (value: unknown) => (SAFETY_PRUNE_ROLE_RANK[roleOf(value)] ?? 2) * 10 + group.herbs.indexOf(canonicalTcmHerbIdentity(nameOf(value)) || nameOf(value));
        const keep = [...inGroup].sort((a, b) => rank(a) - rank(b))[0];
        const drops = inGroup.filter((value) => value !== keep && roleOf(value) !== "君");
        for (const value of drops) removed.push({ name: nameOf(value), reason: `与${nameOf(keep)}${group.reason}` });
        retained = retained.filter((value) => !drops.includes(value));
      }
    }
    if (removed.length === 0 || retained.length < SAFETY_PRUNE_MIN_RETAINED) return content;
    candidate.herbs = retained;
    if (typeof candidate.formulaAnalysis === "string") {
      candidate.formulaAnalysis = formulaAnalysisAfterHerbRemoval(candidate.formulaAnalysis, retained.map(nameOf).filter(Boolean));
    }
    const note = `按本例情况已去除：${removed.map((item) => `${item.name}（${item.reason}）`).join("；")}`;
    const previous = typeof candidate.notApplicable === "string" ? candidate.notApplicable.trim() : "";
    candidate.notApplicable = previous ? `${previous.replace(/[。；;]+$/u, "")}；${note}` : note;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 定稿剔药之后（方向相反的药、无病机支撑的药、本例安全边界冲突的药）注意事项里仍点名已不在方中的药：按最终药味与随证加减去掉那一小句
 *（第二十四轮甲方 100 例 C018：「方中含吴茱萸有小毒」，吴茱萸已剔出本方）。交付面投影也做同一件事，但「保留已签名候选」的交付连续性
 * 路径不经过投影，所以在定稿、签名之前做一次。判据就是编译器与交付面那一个（precautionWithoutAbsentHerbs）。
 */
export function withoutPrecautionsNamingAbsentHerbs(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const candidate = recordValue(Array.isArray(formula?.candidates) ? formula?.candidates[0] : undefined);
    const nonPharma = recordValue(reasoning.nonPharma);
    if (!candidate || !nonPharma || !Array.isArray(nonPharma.precautions) || !Array.isArray(candidate.herbs)) return content;
    const identities = new Set([
      ...candidate.herbs.map((herb) => canonicalTcmHerbIdentity(String(recordValue(herb)?.name || ""))),
      ...(Array.isArray(formula?.modifications) ? formula.modifications : []).map((item) => canonicalTcmHerbIdentity(String(recordValue(item)?.herbName || ""))),
    ].filter(Boolean));
    if (identities.size === 0) return content;
    const cleaned = nonPharma.precautions
      .map((line) => typeof line === "string" ? precautionWithoutAbsentHerbs(line, identities) : line)
      .filter((line) => typeof line !== "string" || line.trim().length > 0);
    if (JSON.stringify(cleaned) === JSON.stringify(nonPharma.precautions)) return content;
    nonPharma.precautions = cleaned;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

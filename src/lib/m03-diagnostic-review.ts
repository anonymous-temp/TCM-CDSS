import { createHash } from "node:crypto";

import { parseClinicalReviewJson } from "./clinical-review-contract";
import { m03SemanticIssue } from "./diagnosis-stage-contract";

export type M03DiagnosticReview =
  | { status: "accepted"; issueCode: "none" }
  | { status: "repair"; issueCode: M03DiagnosticRepairIssue; repairInstruction?: string }
  | { status: "unavailable"; issueCode: "review_unavailable" };

export type M03DiagnosticRepairIssue =
  | "criteria_not_met"
  | "diagnostic_label_overstated"
  | "supporting_fact_mismatch"
  | "tcm_reasoning_unsupported"
  | "formula_indication_mismatch";

const REPAIR_ISSUES = new Set([
  "criteria_not_met",
  "diagnostic_label_overstated",
  "supporting_fact_mismatch",
  "tcm_reasoning_unsupported",
  "formula_indication_mismatch",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEvidence);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(Object.entries(source)
    .filter(([key, item]) => key !== "evidence" && item !== undefined)
    .map(([key, item]) => [key, withoutEvidence(item)]));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = record(value);
  if (!source) return value;
  return Object.fromEntries(Object.entries(source)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]));
}

/**
 * Project only the diagnostic decisions owned by the independent M03 reviewer. Evidence
 * provenance, signatures, display synchronization, treatment projects and workflow metadata are
 * governed elsewhere and must not turn one accepted diagnosis into a second stochastic review.
 */
export function buildM03DiagnosticReviewPayload(reasoning: unknown): Record<string, unknown> {
  const source = record(reasoning) || {};
  return withoutEvidence({
    overview: source.overview,
    westernDiagnosis: source.westernDiagnosis,
    pathogenesis: source.pathogenesis,
    therapy: source.therapy,
  }) as Record<string, unknown>;
}

export function m03DiagnosticReviewSemanticHash(reasoning: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(buildM03DiagnosticReviewPayload(reasoning))))
    .digest("hex")}`;
}

export function canRebindM03DiagnosticReview(reviewedReasoning: unknown, finalReasoning: unknown): boolean {
  return m03DiagnosticReviewSemanticHash(reviewedReasoning) === m03DiagnosticReviewSemanticHash(finalReasoning);
}

export function m03DiagnosticReviewDiffPaths(reviewedReasoning: unknown, finalReasoning: unknown): string[] {
  const before = canonicalize(buildM03DiagnosticReviewPayload(reviewedReasoning));
  const after = canonicalize(buildM03DiagnosticReviewPayload(finalReasoning));
  const paths: string[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (paths.length >= 40 || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) paths.push(`${path}.length`);
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        visit(left[index], right[index], `${path}[${index}]`);
      }
      return;
    }
    if (record(left) && record(right)) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
        if (!(key in leftRecord) || !(key in rightRecord)) paths.push(`${path}.${key}`);
        else visit(leftRecord[key], rightRecord[key], `${path}.${key}`);
      }
      return;
    }
    paths.push(path);
  };
  visit(before, after, "m03Review");
  return [...new Set(paths)];
}

/**
 * Structural/fact invariants are deterministic reviewer preconditions, not stochastic clinical
 * judgements. Keeping this check in the review module lets health probes and live calibrations test
 * the same composite reviewer boundary used before an M03 result can be signed.
 */
export function preflightM03DiagnosticReview(
  reasoning: unknown,
  clinicalContext = "",
): M03DiagnosticReview | undefined {
  const issue = m03SemanticIssue(reasoning as Parameters<typeof m03SemanticIssue>[0], clinicalContext);
  if (!issue) return undefined;
  const issueCode: M03DiagnosticRepairIssue = issue.startsWith("western_")
    ? "supporting_fact_mismatch"
    : "tcm_reasoning_unsupported";
  return {
    status: "repair",
    issueCode,
    repairInstruction: `deterministic_contract:${issue}`,
  };
}

export function buildM03DiagnosticReviewPrompt(
  clinicalContext: string,
  reasoning: unknown,
  evidenceContext = "",
): string {
  const payload = buildM03DiagnosticReviewPayload(reasoning);
  return [
    "你是独立的中西医临床推理复核器，不负责重新生成整份报告。核对 westernDiagnosis.primary、中医证候与病机治法、以及候选经方方向是否被当前病例事实充分支持。",
    "先执行硬性完整性检查：pathogenesis.chain 为空，或主证候、总体病机、总治法以‘待辨、待定、资料不足、无法判断’等占位内容代替临床结论时，一律返回 tcm_reasoning_unsupported，绝不能 accepted。修复方向必须是基于已有阳性事实形成低置信度、最小且中性的非空闭环；不得要求清空病机链，也不得为了补全而推断阴虚、阳虚、寒热、痰湿、血瘀等未获事实支持的证型。病位或病性确实无法由现有事实归属时，允许 items 为空，但必须使用 resolution=unresolved 并说明原因；绝不能标记 bounded/resolved 后又留空。",
    "对于有正式诊断标准的疾病，逐项核对病程阈值、必备核心症状、必要排除条件和已有客观依据。缺少任何必备条件时必须返回 repair；不能因为疾病‘看起来像’就接受。",
    "症状性工作诊断只要准确反映主诉和病程即可接受；证据不足的疾病应放入 differentials，不能占用 primary。",
    "不得把尚未满足标准的病因或疾病藏进症状性诊断的括号、后缀或‘可能’限定中（例如‘某症状（某疾病可能）’）；这种写法仍属于过度诊断，必须返回 diagnostic_label_overstated，并把该疾病移入 differentials。",
    "检查 supportingFacts 是否来自病例且确实支持该主诊断。不要因为缺少非必需检查而否定合理的症状性工作诊断。",
    "supportingFacts 只保留与当前主诊断直接相关的现代医学患者事实：不得混入舌苔脉象、证候病机等中医推理，不得用年龄性别或一组正常生命体征充当诊断支持，也不得堆入与本次主诉无关的既往病名。",
    "严格区分当前问题与历史背景。既往稳定疾病、后遗症、已缓解事件或当前明确无新发症状，只能作为背景或鉴别边界；除非病例有当前活动性变化，不得把它们升级成本次 primary、主证候锚点或主要病机治疗目标。",
    "核对中医主证、病位病性、病机链和治法是否由阳性患者事实支撑。不能把未询问、未知、条件句或待鉴别方向当作已经存在的证候锚点。",
    "事实边界中同一观察项（舌象、脉象、面色、体征或检验）出现直接矛盾的多条记录时（如不同段落分别记录舌红与舌淡红、脉弦与脉细平），该观察项一律按不可靠证据处理：它既不能支持任何具体病位、病性或证型归属，也不能据此认定候选‘编造事实’。病机链、supportingFacts 与病位病性依据均不得引用矛盾观察项的任一条作为锚点；候选引用了其中一条时，应要求删除该引用并按其余一致事实降级，按无依据归属处理而不按编造处理。辨证深度只由其余一致的阳性事实判定：去掉矛盾观察项后若事实不再支持具体归属，情形一的有界中性形态可以接受，不得再以‘仍存在阳性舌脉’为由要求具体证型。矛盾本身必须要求候选写入 uncertainties 或 resolutionReason，绝不能由你或候选挑选某一条作为事实采信。",
    "同时核对辨证是否形成了足以指导后续组方的临床闭环，判定深度只能与患者事实支持的层级一致，按两种情形分别处理，不得混用。情形一（稀疏病例）：患者事实边界中除主诉外没有其他当前阳性发现时，有界的中性功能性病机形态是可以接受的安全降级——主证候为‘症状层中医病名+功能失调候’式的低置信度工作表述，病机链节点逐字锚定患者原文、节点机制只写该原文直接对应的功能异常（如某项调节失常、某项功能受扰），不额外引入脏腑、寒热虚实或气血津液结论，病位病性 items 为空且 resolution=unresolved 并附原因，不推荐命名方；此时不得要求升级为更具体证型，也不能反过来要求补出没有依据的阴虚、阳虚、寒热、痰湿或血瘀。情形二（主诉之外仍有当前阳性事实）：患者事实边界中除主诉外还存在其他当前阳性发现（如舌脉、伴随症状、异常体征或检验结果）时，主证候不得只是主诉、中医病名或‘某部位功能失调’的机械改写，必须形成由这些阳性事实锚定的证候结论；但要求的深度以事实实际支持的层级为限——现有事实能够支持具体病位、病性或证型归属时，不得退回中性降级形态，此时对中性降级形态一律返回 tcm_reasoning_unsupported，并要求围绕既有阳性事实重做低置信度、最小且中性的非空闭环；现有事实虽超出主诉、但不足以支持任何具体病位病性归属（如舌脉大致正常、仅提示功能层面异常）时，情形一的有界中性形态同样可以接受，绝不能要求超出事实支持的脏腑、寒热虚实或气血津液归属来显得具体。无论哪种情形：任何超出当前阳性患者事实具体支持的归属、典型证型或命名方都必须拒绝；总体病机和至少一个患者事实锚定的病机节点不得留空，空链必须返回 tcm_reasoning_unsupported，并要求按上述边界重做非空闭环，不得补造舌脉或阴性史。",
    "核对 recommendedFormulaNames 中每个命名方的核心适应证是否在阳性患者事实中成立。某命名方只在 uncertainties、假设句、‘若有则’或建议补问中出现，或者其定义性症状明确缺失时，必须返回 formula_indication_mismatch；此时应让生成模型改选有方证依据的命名方，或退回本例辨证组方，不能勉强套用经方名。",
    "只输出一个 JSON 对象，不要代码块或解释。格式：accepted 时 {\"status\":\"accepted\",\"issueCode\":\"none\"}；需修复时 status=repair，issueCode 只能是 criteria_not_met、diagnostic_label_overstated、supporting_fact_mismatch、tcm_reasoning_unsupported、formula_indication_mismatch 之一，并增加 repairInstruction。一次只返回最关键的问题。按上述规则可以接受的候选必须输出 accepted，绝不允许用 repair 表达‘应接受、请重新检查’；repair 只用于确实需要生成模型修改的候选。supportingFacts 的内容问题（混入舌苔脉象等中医推理、非患者事实、与主诊断无关）只能使用 supporting_fact_mismatch，不得并入 tcm_reasoning_unsupported；westernDiagnosis 的标签或依据问题也不得使用 tcm_reasoning_unsupported。",
    "repairInstruction 限 300 字：必须明确指出需改的结构路径、当前结论为什么超出阳性患者事实、应删除或降级的推理方向；不得给药味剂量，不得新增患者事实，不得要求绕过结构/事实/证据合同。它只是给生成模型的定向复核意见，最终结果仍会重新校验和复核。",
    `患者事实边界：${clinicalContext.slice(0, 12_000)}`,
    evidenceContext.trim()
      ? `本轮可用证据（仅用于核对诊断标准、方证和医学依据，绝不能当作患者事实）：${evidenceContext.slice(0, 12_000)}`
      : "本轮未提供额外外部证据；不得因此编造指南、文献或方剂出处。",
    `待复核M03临床投影：${JSON.stringify(payload).slice(0, 24_000)}`,
  ].join("\n\n");
}

/**
 * Reviewer prose is untrusted repair advice, not part of the signed clinical contract. For a TCM
 * semantic rejection the free-text instruction can contradict the mandatory non-empty bounded
 * reasoning contract (for example, asking the generator to clear the chain or invent a specific
 * deficiency pattern). The issue code still selects the server-owned repair policy; only the
 * narrower western/formula guidance is forwarded verbatim.
 *
 * The quarantine shape below is the same bounded neutral shape the reviewer prompt documents as
 * acceptable whenever the available facts cannot support deeper attribution (genuinely sparse
 * cases, and active cases whose positive findings are too shallow for any 病位/病性 归属):
 * symptom-level "病名+功能失调候" primary syndrome, verbatim-anchored neutral chain nodes,
 * unresolved/empty location and nature, and no named formulas. Reviewer and repair policy must
 * stay aligned on this single shape so the same candidate cannot flip accepted/rejected across
 * runs; matchesM03QuarantineShape is the code-level mirror used by the orchestrator.
 *
 * The policy mode is chosen by m03TcmRepairMode from the review's PHI-safe guidance codes:
 * overreach rejections take this quarantine mode even on active cases (unsupported attribution
 * must be deleted, not re-attempted); under-depth rejections on cases with current positive
 * facts take the fact-anchored minimal-syndrome mode (the same overreach bans stay in force for
 * unsupported concepts, but the generator is told to anchor the syndrome to the available
 * positive facts to the depth they support).
 */
export function boundedM03DiagnosticRepairGuidance(
  review: M03DiagnosticReview,
  opts: { hasCurrentPositiveFacts?: boolean } = {},
): string {
  if (review.status !== "repair") return "";
  if (review.issueCode !== "tcm_reasoning_unsupported") return review.repairInstruction || "";

  const codes = m03DiagnosticRepairGuidanceCodes(review);
  const prohibitedConcepts = [
    "阴虚、阳虚、气虚、血虚、津亏、阴阳两虚及对应补益治法",
    "寒、热、火、痰、湿、瘀、食积、水饮及对应祛邪治法",
    "未经患者事实直接支持的脏腑、经络、气血津液、营卫、卫气、心神归属",
  ];
  // The mode is selected from the review's PHI-safe guidance codes (overreach vs under-depth),
  // not from the context detector alone — see m03TcmRepairMode. An overreach rejection on an
  // active case still gets the quarantine policy: the unsupported attribution must be deleted,
  // not re-attempted. An under-depth rejection on a case with current positive facts gets the
  // fact-anchored policy instead of the neutral quarantine it would otherwise loop on.
  if (m03TcmRepairMode(review, Boolean(opts.hasCurrentPositiveFacts)) === "fact_anchored") {
    return [
      `独立复核的受控定位标签：${codes.length > 0 ? codes.join(",") : "generic_tcm_overreach"}。这些标签不是患者事实。`,
      `硬性删减：仅从主证候、病位病性、总体病机、病机链、总治法和方义方向中删除未获本例阳性事实直接支持的以下概念及同义改写：${prohibitedConcepts.join("；")}。有直接原文依据（舌脉、伴随症状、体征、检验）的结论可以保留，但保持低置信度并逐字标注依据；不得删除患者事实本身。`,
      "本例主诉之外仍有当前阳性事实，禁止退回到症状层‘病名+功能失调候’的中性隔离形态：overview.primarySyndrome 必须由这些阳性事实锚定，primarySyndromeBasis 逐字引用患者原文，形成最小、低置信度的非空闭环；只使用原文直接支持的最浅结论层级，拿不准的证型归属写入 uncertainties，不得补造未出现的事实、舌脉或阴性史。",
      "locationDifferentiation 与 natureDifferentiation 只填写有直接原文依据的分类；无依据的维度保持分类数组为空、resolution=unresolved 并填写 resolutionReason，不得为凑分类新增脏腑、经络或寒热虚实。",
      "pathogenesis.chain 至少一条并逐字锚定患者阳性原文；每个节点的 pathogenesis 与 therapyDirection 不得超出该原文直接支持的机制层级，不得把总体病机和治法原句机械复制到节点。",
      "recommendedFormulaNames 只保留方证定义性症状在阳性事实中成立的命名方；不成立则清空并保持 formulaSelectionMode=self_devised，recommendedFormulaDirection 只写本例症状功能调护的辨证组方方向。",
    ].join("\n");
  }

  // Once the independent reviewer rejects the TCM reasoning, replacing one unsupported named
  // pattern with another is not a valid repair. Enter a symptom-grounded quarantine mode with a
  // closed semantic vocabulary; later M03/M04 review can only add specificity from a fresh case,
  // never from this failed candidate. This neutral quarantine shape is only legitimate for
  // genuinely sparse cases (情形一); active cases take the fact-anchored branch above.
  const lines = [
    `独立复核的受控定位标签：${codes.length > 0 ? codes.join(",") : "generic_tcm_overreach"}。这些标签不是患者事实。`,
    `进入语义隔离模式。硬性删减：从主证候、病位病性、总体病机、病机链、总治法和方义方向中删除以下概念及同义改写：${prohibitedConcepts.join("；")}。不得删掉一种后换成另一种，待鉴别方向只能放入 uncertainties。`,
    "清空 recommendedFormulaNames，formulaSelectionMode 改为 self_devised，recommendedFormulaDirection 只写本例症状功能调护的辨证组方方向，不得推荐任何命名方。",
    "locationDifferentiation 与 natureDifferentiation 的分类数组全部置空，resolution 明确设为 unresolved，并分别填写 resolutionReason；不要用 bounded 配空数组，也不要为凑分类新增脏腑、经络或寒热虚实。",
    "pathogenesis.chain 仍须至少一条并逐字锚定患者阳性原文。每个节点的 pathogenesis 只能写该原文直接对应的症状功能异常（例如某项调节失常、某项功能受扰），therapyDirection 只能写对应的功能调护方向；不得引入上述禁用概念，不得把总体病机和治法原句机械复制到节点。",
    "overview.primarySyndrome 使用症状层中医病名加‘功能失调候’的低置信度工作表述，primarySyndromeResolution 设为 bounded；overview.overallPathogenesis、overallTherapy 与 therapy.overallPrinciple 同步为中性功能表述，不得出现待辨、资料不足等占位词。",
  ];
  return lines.join("\n");
}

const M03_REPAIR_GUIDANCE_CODE_RULES: Array<[string, RegExp]> = [
  ["empty_or_unresolved", /(?:清空|留空|删除)[^。；]{0,16}(?:病机链|chain|病位|病性)|待辨|待定|无法(?:完成|形成|判断)|资料不足/],
  ["symptom_restatement", /(?:重复|复述|改写)[^。；]{0,16}(?:主诉|症状|患者事实)|只是[^。；]{0,16}(?:主诉|症状)/],
  ["location_unsupported", /病位[^。；]{0,24}(?:无|缺乏|不足|超出|不能|不得)/],
  ["nature_unsupported", /病性[^。；]{0,24}(?:无|缺乏|不足|超出|不能|不得)/],
  ["chain_not_closed", /(?:病机链|pathogenesis\.chain|chain)[^。；]{0,28}(?:(?<!非)空|未|无|不足|缺乏|重复|不完整|未形成)/],
  ["yin_deficiency_overreach", /阴虚|津亏|滋阴|虚火/],
  ["yang_cold_overreach", /阳虚|温阳|寒证|散寒|畏寒|肢冷/],
  ["heat_overreach", /热证|实热|清热|泻火|火热/],
  ["phlegm_damp_overreach", /痰湿|痰浊|湿阻|化痰|祛湿/],
  ["blood_stasis_overreach", /血瘀|瘀阻|活血|化瘀/],
  ["qi_blood_deficiency_overreach", /气虚|血虚|气血(?:两)?虚|益气|养血/],
  ["ying_wei_overreach", /营卫|卫气/],
  ["heart_spirit_overreach", /心神|安神|宁心/],
  ["named_formula_overreach", /命名方|经方|方剂|方名/],
];

/** PHI-safe diagnostic labels for telemetry; never returns reviewer prose or patient facts. */
export function m03DiagnosticRepairGuidanceCodes(review: M03DiagnosticReview): string[] {
  if (review.status !== "repair" || !review.repairInstruction) return [];
  return M03_REPAIR_GUIDANCE_CODE_RULES
    .flatMap(([code, pattern]) => pattern.test(review.repairInstruction || "") ? [code] : []);
}

const M03_QUARANTINE_OVERREACH_CODES = new Set([
  "yin_deficiency_overreach",
  "yang_cold_overreach",
  "heat_overreach",
  "phlegm_damp_overreach",
  "blood_stasis_overreach",
  "qi_blood_deficiency_overreach",
  "ying_wei_overreach",
  "heart_spirit_overreach",
]);

function quarantineOverreachText(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return M03_REPAIR_GUIDANCE_CODE_RULES.some(([code, pattern]) =>
    M03_QUARANTINE_OVERREACH_CODES.has(code) && pattern.test(value));
}

/**
 * The quarantine repair policy (boundedM03DiagnosticRepairGuidance) can only produce one bounded
 * neutral shape: location/nature unresolved-or-empty, no named formulas, a non-empty chain whose
 * mechanisms stay within neutral functional language, and a symptom-level primary syndrome. When
 * the independent reviewer keeps rejecting that exact shape with the same issue code, re-injecting
 * the identical guidance redraws the same stochastic accept/reject lottery. The M03 orchestrator
 * uses this predicate to detect that fixpoint and exit early to the signed limited fallback
 * instead of burning another full model round. This is an orchestration-efficiency signal only;
 * it never weakens any deterministic contract check.
 */
export function matchesM03QuarantineShape(reasoning: unknown): boolean {
  const source = record(reasoning);
  const overview = record(source?.overview);
  const pathogenesis = record(source?.pathogenesis);
  if (!source || !overview || !pathogenesis) return false;
  const unresolvedOrEmpty = (value: unknown): boolean => {
    const differentiation = record(value);
    if (!differentiation) return false;
    if (differentiation.resolution === "unresolved") return true;
    const items = Array.isArray(differentiation.items) ? differentiation.items : [];
    return items.every((item) => typeof item !== "string" || !item.trim());
  };
  if (!unresolvedOrEmpty(pathogenesis.locationDifferentiation)) return false;
  if (!unresolvedOrEmpty(pathogenesis.natureDifferentiation)) return false;
  const formulaNames = Array.isArray(overview.recommendedFormulaNames) ? overview.recommendedFormulaNames : [];
  if (formulaNames.some((name) => typeof name === "string" && name.trim())) return false;
  const chain = Array.isArray(pathogenesis.chain) ? pathogenesis.chain : [];
  if (chain.length === 0) return false;
  if (quarantineOverreachText(overview.primarySyndrome)) return false;
  return chain.every((node) => {
    const item = record(node);
    if (!item) return false;
    return !quarantineOverreachText(item.pathogenesis) && !quarantineOverreachText(item.therapyDirection);
  });
}

const M03_HISTORY_LINE_PREFIX = /^(?:既往史|个人史|家族史|婚育史|月经史|孕产史|用药史|过敏史|药物过敏史|食物过敏史|手术史|外伤史|输血史|预防接种史|流行病学史)\s*[：:]/;
const M03_UNKNOWN_PLACEHOLDER_LINE = /^(?:[^：:]{0,16}[：:])?\s*(?:未提供|未记录|未询问|未采集|未提及|未诉|不详|未知|暂无|无)\s*[。．.]?$/;

function normalizeGroundingLine(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。；;：:、→\-—_（）()[\]【】.]+/g, "");
}

/**
 * Deterministic sparse/active signal for the reviewer 情形一/情形二 split, computed on the same
 * deidentified grounding text the reviewer sees. "Current positive facts beyond the chief
 * complaint" means at least one substantive line that is not a history-only entry, not an
 * unknown/placeholder entry, and not a restatement of the chief-complaint line. Both error
 * directions degrade safely: a false "sparse" sends quarantine guidance into one bounded
 * rejection plus the identical-guidance early exit; a false "active" only asks the generator to
 * anchor to whatever positive facts exist (possibly just the chief complaint).
 */
export function m03GroundingHasCurrentPositiveFacts(clinicalContext: string): boolean {
  const lines = clinicalContext.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return false;
  const chief = normalizeGroundingLine(lines[0]);
  return lines.slice(1).some((line) => {
    if (M03_HISTORY_LINE_PREFIX.test(line)) return false;
    if (M03_UNKNOWN_PLACEHOLDER_LINE.test(line)) return false;
    const normalized = normalizeGroundingLine(line);
    if (normalized.length < 4) return false;
    if (!chief) return true;
    return !normalized.includes(chief) && !chief.includes(normalized);
  });
}

const M03_REPAIR_UNDER_DEPTH_CODES = new Set([
  "symptom_restatement",
  "chain_not_closed",
  "empty_or_unresolved",
]);
const M03_REPAIR_OVERREACH_CODES = new Set([
  "location_unsupported",
  "nature_unsupported",
  "named_formula_overreach",
  ...M03_QUARANTINE_OVERREACH_CODES,
]);

/**
 * Selects which server-owned repair policy a tcm_reasoning_unsupported rejection gets. The
 * reviewer's free-text instruction is untrusted, but its PHI-safe guidance codes classify the
 * rejection direction: an overreach rejection (unsupported location/nature/concept/formula
 * attribution) always takes the quarantine policy — the unsupported attribution must be deleted,
 * not re-attempted, even on an active case. An under-depth rejection (the syndrome merely
 * restates symptoms or the chain is not closed) takes the fact-anchored policy only when the
 * case actually has current positive facts to anchor to. The grounding-context detector breaks
 * ties. This mirrors the depth-calibrated reviewer rule: depth is demanded only to the level the
 * facts support, so reviewer and repair policy stop pulling the candidate in opposite directions.
 */
export function m03TcmRepairMode(
  review: M03DiagnosticReview,
  hasCurrentPositiveFacts: boolean,
): "quarantine" | "fact_anchored" {
  if (review.status !== "repair" || review.issueCode !== "tcm_reasoning_unsupported") return "quarantine";
  const codes = new Set(m03DiagnosticRepairGuidanceCodes(review));
  for (const code of codes) {
    if (M03_REPAIR_OVERREACH_CODES.has(code)) return "quarantine";
  }
  for (const code of codes) {
    if (M03_REPAIR_UNDER_DEPTH_CODES.has(code)) return hasCurrentPositiveFacts ? "fact_anchored" : "quarantine";
  }
  return hasCurrentPositiveFacts ? "fact_anchored" : "quarantine";
}

export function parseM03DiagnosticReview(content: string): M03DiagnosticReview {
  const parsed = parseClinicalReviewJson(content);
  if (parsed) {
    if (parsed.status === "accepted" && parsed.issueCode === "none") {
      return { status: "accepted", issueCode: "none" };
    }
    if (parsed.status === "repair" && typeof parsed.issueCode === "string" && REPAIR_ISSUES.has(parsed.issueCode)) {
      const repairInstruction = typeof parsed.repairInstruction === "string"
        ? parsed.repairInstruction.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 800)
        : "";
      return {
        status: "repair",
        issueCode: parsed.issueCode as M03DiagnosticRepairIssue,
        ...(repairInstruction ? { repairInstruction } : {}),
      };
    }
  }
  return { status: "unavailable", issueCode: "review_unavailable" };
}

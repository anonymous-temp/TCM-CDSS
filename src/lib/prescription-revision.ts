import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { canonicalTcmHerbIdentity, m04SemanticIssue } from "./diagnosis-stage-contract";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { buildFormulaAnalysis } from "./herb-target-contract";

type Formula = NonNullable<ClinicalReasoningResultV2["formula"]>;
type Candidate = Formula["candidates"][number];
type Herb = Candidate["herbs"][number];

const EDIT_PLACEHOLDER = /(待医生|待填写|待补充|待确认|待核实|未填写|未说明|占位)/;
const EDIT_DOSE = /^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i;

export function isValidEditedHerbDose(value: unknown): boolean {
  const match = String(value ?? "").trim().match(EDIT_DOSE);
  if (!match) return false;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const grams = /^(?:mg|毫克)$/i.test(match[2]) ? amount / 1000 : amount;
  // Broad plausibility guard for a single herbal dose. Drug-specific limits remain advisory audit
  // rules, but impossible magnitudes must never reach audit/HIS when audit itself is non-blocking.
  return grams >= 0.001 && grams <= 500;
}

export function hasIncompleteEditedHerb(herb: Herb): boolean {
  const invalidTarget = herb.targetKind === "pathogenesis_node"
    ? !/^P\d{1,2}$/.test(herb.targetRef || "") || herb.structureRole != null
    : herb.targetKind === "formula_structure"
      ? herb.targetRef !== "FORMULA_STRUCTURE" || !herb.structureRole || (herb.role !== "佐" && herb.role !== "使")
      : true;
  return !herb.name.trim() ||
    !isValidEditedHerbDose(herb.dose) ||
    !herb.role ||
    invalidTarget ||
    !herb.targetPathogenesis.trim() ||
    !herb.function.trim() ||
    EDIT_PLACEHOLDER.test(`${herb.targetPathogenesis} ${herb.function}`);
}

export function editedPrescriptionSemanticIssue(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  candidateIndex: number,
  priorReasoning?: ClinicalReasoningResultV2 | null,
): string | undefined {
  const candidate = reasoning?.formula?.candidates?.[candidateIndex];
  if (!reasoning || reasoning.stage !== "prescribe" || !reasoning.formula || !candidate) return "candidate_missing";
  const names = candidate.herbs.map((herb) => canonicalTcmHerbIdentity(herb.name)).filter(Boolean);
  if (new Set(names).size !== names.length) return "duplicate_herb";
  const selectedReasoning: ClinicalReasoningResultV2 = {
    ...reasoning,
    formula: {
      ...reasoning.formula,
      candidates: [candidate],
      // Workbench additions are already represented in the selected candidate herbs. The model-only
      // contract must see an empty modifications list so every dose is validated and audited once.
      modifications: [],
    },
  };
  return m04SemanticIssue(selectedReasoning, "", priorReasoning, isKnownTcmHerbName, true, true, true);
}

export function editedPrescriptionIssueMessage(issue: string | undefined): string {
  if (!issue) return "";
  if (issue === "duplicate_herb") return "存在重复药味，请合并为一行并确认总剂量。";
  if (/unknown/.test(issue)) return "该药味不在当前标准药材资料的收录范围，不能提交审方。";
  if (/dose_(?:outside_knowledge|sanity_ceiling)|_dose$/.test(issue)) return "剂量格式不规范或达到明显异常的安全阈值，请复核。";
  // 正则里的 follow_up 必须保留：m04SemanticIssue 在 trustedWorkbenchEdit 路径下仍会返回
  // follow_up_inconsistent（复诊节点是服务端派生字段，未从数据契约中删除）。这里只改文案，
  // 不再把医生指向一个已经从处方界面移除、他也无法编辑的字段。
  if (/dose_count|course|method_daily_dose|follow_up/.test(issue)) return "剂数、疗程或每日剂次不规范或不一致；当前按每日1剂计算，请复核后重新审方。";
  if (/function_ungrounded/.test(issue)) return "药味功用与标准药材资料不一致，请按真实功用修正。";
  if (/pathogenesis|cross_stage|therapy|target_ref|structure_/.test(issue)) return "药味必须引用本例已确认的病机；仅佐使药可选择方内结构作用。";
  if (/decoction|route/.test(issue)) return "炮制或特殊煎服要求不符合当前药味规则，请复核。";
  return "编辑后处方未通过临床一致性核对，请复核药名、剂量、病机、功用和煎服要求。";
}

function editedFormulaAnalysis(herbs: Herb[]): string {
  // 与服务端共用 buildFormulaAnalysis：两条路径若各写一套，医生在工作台编辑前后会读到
  // 口径不同的方义。原实现同样是按角色分组，读不出组内每味药各自承担什么。
  const analysis = buildFormulaAnalysis(herbs);
  return [
    `编辑后方义（以当前${herbs.length}味药为准）`,
    analysis,
    "本段由当前结构化药味表确定性生成；药味再次增删改后须重新生成并获取审方提示。",
  ].filter(Boolean).join("\n");
}

function removeDeletedHerbClauses(value: string, deletedNames: string[]): string {
  if (!value || deletedNames.length === 0) return value;
  const remaining = value
    .split(/[；;。\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !deletedNames.some((name) => clause.includes(name)));
  return remaining.join("；");
}

function synchronizedDecoction(candidate: Candidate, herbs: Herb[], deletedNames: string[]): Candidate["decoction"] {
  const baseMethod = removeDeletedHerbClauses(candidate.decoction.method, deletedNames);
  const requirements = herbs
    .filter((herb) => herb.decoctionRequirement?.trim())
    .map((herb) => `${herb.name}${herb.decoctionRequirement}`)
    .filter((item, index, all) => all.indexOf(item) === index && !baseMethod.includes(item));
  return {
    ...candidate.decoction,
    method: [baseMethod, ...requirements].filter(Boolean).join("；"),
  };
}

export function synchronizeEditedCandidate(candidate: Candidate, herbs: Herb[]): Candidate {
  const originalByName = new Map(candidate.herbs.map((herb) => [canonicalTcmHerbIdentity(herb.name), herb]));
  const editComparable = (herb: Herb) => JSON.stringify({
    name: herb.name.trim(), processing: herb.processing, dose: herb.dose, role: herb.role,
    prescriptionRole: herb.prescriptionRole, targetKind: herb.targetKind, targetRef: herb.targetRef,
    structureRole: herb.structureRole, targetPathogenesis: herb.targetPathogenesis,
    function: herb.function, decoctionRequirement: herb.decoctionRequirement, isToxic: herb.isToxic,
  });
  const synchronizedHerbs = herbs.map((herb) => {
    const original = originalByName.get(canonicalTcmHerbIdentity(herb.name));
    const clinicallyChanged = !original || editComparable(original) !== editComparable(herb);
    return {
      ...herb,
      prescriptionRole: herb.prescriptionRole.replace(/(?:^|；)\s*知识库功用[：:][\s\S]*$/, "").trim()
        || `对应${herb.targetPathogenesis}`,
      // 医生改过的药味必须掉出「已核验」档：审方能识别处方风险，但替代不了药味身份与剂量来源核验。
      // 这段原先只活在 DiagnosisClient 的私有副本里——即服务端这份（被测试覆盖的那份）反而不降档。
      verificationTier: clinicallyChanged ? "unverified_dose" as const : herb.verificationTier,
      doseSource: clinicallyChanged ? "none" as const : herb.doseSource,
      verificationReasons: clinicallyChanged
        ? ["医生已编辑药味或剂量；本次审方可识别处方风险，但不能替代药味身份与剂量来源核验"]
        : herb.verificationReasons,
      evidence: clinicallyChanged ||
        EDIT_PLACEHOLDER.test(herb.evidence?.source || "") || /待重新审方/.test(herb.evidence?.source || "")
        ? { evidenceLevel: "model_inference" as const, source: "医生结构化编辑记录；已纳入本次编辑后审方版本", confidence: "中" as const }
        : herb.evidence,
    };
  });
  const currentNames = new Set(synchronizedHerbs.map((herb) => canonicalTcmHerbIdentity(herb.name)).filter(Boolean));
  const deletedNames = candidate.herbs
    .map((herb) => herb.name.trim())
    .filter((name) => name && !currentNames.has(canonicalTcmHerbIdentity(name)));
  const changedNames = synchronizedHerbs
    .filter((herb) => {
      const original = originalByName.get(canonicalTcmHerbIdentity(herb.name));
      return original && editComparable(original) !== editComparable(herb);
    })
    .map((herb) => herb.name.trim());
  const retainedOriginalCount = candidate.herbs.filter((herb) => currentNames.has(canonicalTcmHerbIdentity(herb.name))).length;
  const baseFormulas = candidate.baseFormulas?.length
    ? candidate.baseFormulas.map((base) => ({
        ...base,
        matchedIngredientCount: Math.min(base.matchedIngredientCount, retainedOriginalCount),
      }))
    : candidate.formulaSource?.source?.trim()
      ? [{
          name: candidate.name.replace(/(?:加减|化裁|合方|医生编辑版).*$/, "").trim() || candidate.name,
          source: candidate.formulaSource.source,
          matchedIngredientCount: retainedOriginalCount,
        }]
      : undefined;
  return {
    ...candidate,
    name: "本例辨证组方（医生编辑版）",
    constructionType: "self_devised",
    modificationStatus: "modified",
    baseFormulas,
    formulaSource: {
      evidenceLevel: "model_inference",
      source: "医生基于原候选方药完成结构化增删改；经典方信息仅作为原方案来源参考",
      confidence: "中",
    },
    herbs: synchronizedHerbs,
    formulaAnalysis: editedFormulaAnalysis(synchronizedHerbs),
    decoction: synchronizedDecoction(candidate, synchronizedHerbs, [...deletedNames, ...changedNames]),
    therapyMatch: removeDeletedHerbClauses(candidate.therapyMatch, deletedNames) || "以编辑后的药味组合对应当前治法与病机，需医生复核。",
    applicable: removeDeletedHerbClauses(candidate.applicable, deletedNames) || "以编辑后药味、当前证候和安全信息为准。",
    notApplicable: removeDeletedHerbClauses(candidate.notApplicable, deletedNames) || "证候或安全边界变化时不再适用。",
  };
}

export function filterModificationsForEditedHerbs(
  modifications: Formula["modifications"],
  originalHerbs: Herb[],
  editedHerbs: Herb[],
): Formula["modifications"] {
  const currentNames = new Set(editedHerbs.map((herb) => canonicalTcmHerbIdentity(herb.name)).filter(Boolean));
  const originalNames = new Set(originalHerbs.map((herb) => canonicalTcmHerbIdentity(herb.name)).filter(Boolean));
  const deletedNames = originalHerbs.map((herb) => herb.name.trim()).filter((name) => name && !currentNames.has(canonicalTcmHerbIdentity(name)));
  const retained = modifications.filter((item) => !deletedNames.some((name) =>
    `${item.action} ${item.doseOrHandling || ""} ${item.reason}`.includes(name),
  )).map((item) => {
    const edited = editedHerbs.find((herb) => item.action.includes(herb.name.trim()));
    const original = edited && originalHerbs.find((herb) => herb.name.trim() === edited.name.trim());
    if (!edited || !original || JSON.stringify(original) === JSON.stringify(edited)) return item;
    return {
      ...item,
      targetPathogenesis: edited.targetPathogenesis,
      doseOrHandling: [edited.dose, edited.decoctionRequirement].filter(Boolean).join("；") || null,
      reason: edited.function,
      riskNote: "该药味已由医生结构化编辑并进入当前审方版本，原加减说明不再适用。",
      evidence: { evidenceLevel: "model_inference" as const, source: "医生结构化编辑记录", confidence: "中" as const },
    };
  });
  const added = editedHerbs
    .filter((herb) => herb.name.trim() && !originalNames.has(canonicalTcmHerbIdentity(herb.name)))
    .filter((herb) => !retained.some((item) => `${item.action} ${item.doseOrHandling || ""}`.includes(herb.name.trim())))
    .map((herb): Formula["modifications"][number] => ({
      trigger: "医生结构化编辑",
      targetPathogenesis: herb.targetPathogenesis,
      action: `加${herb.name.trim()}`,
      doseOrHandling: [herb.dose, herb.decoctionRequirement].filter(Boolean).join("；") || null,
      reason: herb.function,
      riskNote: "新增药味已进入编辑后审方版本，采纳前仍需医生结合患者情况复核。",
      evidence: { evidenceLevel: "model_inference", source: "医生结构化编辑记录", confidence: "中" },
    }));
  return [...retained, ...added];
}

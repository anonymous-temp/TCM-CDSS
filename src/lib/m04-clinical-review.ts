import { createHash } from "node:crypto";

import { parseClinicalReviewJson } from "./clinical-review-contract";

export type M04ClinicalRepairIssue =
  | "formula_composition_mismatch"
  | "herb_plan_mismatch"
  | "dose_rationale_concern"
  | "patient_context_mismatch";

export type M04ClinicalRepairFocus =
  | "formula_core_composition"
  | "emperor_role"
  | "herb_direction"
  | "modification_logic"
  | "dose_strength"
  | "patient_dependency";

export type M04ClinicalReview =
  | { status: "accepted"; issueCode: "none" }
  | {
      status: "repair";
      issueCode: M04ClinicalRepairIssue;
      repairFocus?: M04ClinicalRepairFocus;
      candidateIndex?: number;
      implicatedHerbs?: string[];
    }
  | { status: "unavailable"; issueCode: "review_unavailable" };

/** An unavailable reviewer is an explicit safety state, never an implicit approval. */
export function m04ClinicalReviewRequiresNonDoseFallback(review: { status?: unknown } | undefined): boolean {
  return review?.status === "unavailable";
}

const REPAIR_ISSUES = new Set<M04ClinicalRepairIssue>([
  "formula_composition_mismatch",
  "herb_plan_mismatch",
  "dose_rationale_concern",
  "patient_context_mismatch",
]);

const REPAIR_FOCUS_BY_ISSUE: Record<M04ClinicalRepairIssue, ReadonlySet<M04ClinicalRepairFocus>> = {
  formula_composition_mismatch: new Set(["formula_core_composition"]),
  herb_plan_mismatch: new Set(["emperor_role", "herb_direction", "modification_logic"]),
  dose_rationale_concern: new Set(["dose_strength"]),
  patient_context_mismatch: new Set(["patient_dependency"]),
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Keep the second-opinion prompt focused on the fields the reviewer is responsible for. Sending
 * the complete M03 and M04 envelopes duplicated evidence, presentation and workflow metadata and
 * repeatedly consumed the reviewer's bounded output budget before it could emit the two-field
 * decision contract. The HMAC still covers the complete final envelope; this projection only
 * narrows the independent clinical task to syndrome/therapy, composition, dose and modifications.
 */
export function buildM04ClinicalReviewPayload(priorReasoning: unknown, reasoning: unknown): {
  prior: Record<string, unknown>;
  candidate: Record<string, unknown>;
} {
  const prior = record(priorReasoning) || {};
  const current = record(reasoning) || {};
  const priorOverview = record(prior.overview);
  const priorWestern = record(prior.westernDiagnosis);
  const priorWesternPrimary = record(priorWestern?.primary);
  const priorPathogenesis = record(prior.pathogenesis);
  const priorTherapy = record(prior.therapy);
  const currentFormula = record(current.formula);
  const compactCandidates = Array.isArray(currentFormula?.candidates)
    ? currentFormula.candidates.flatMap((value) => {
        const candidate = record(value);
        if (!candidate) return [];
        const decoction = record(candidate.decoction);
        const herbs = Array.isArray(candidate.herbs)
          ? candidate.herbs.flatMap((herbValue) => {
              const herb = record(herbValue);
              return herb ? [{
                name: herb.name,
                processing: herb.processing,
                dose: herb.dose,
                role: herb.role,
                targetKind: herb.targetKind,
                targetRef: herb.targetRef,
                targetPathogenesis: herb.targetPathogenesis,
                structureRole: herb.structureRole,
                function: herb.function,
                prescriptionRole: herb.prescriptionRole,
                isToxic: herb.isToxic,
                decoctionRequirement: herb.decoctionRequirement,
              }] : [];
            })
          : [];
        return [{
          name: candidate.name,
          formulaNames: candidate.formulaNames,
          constructionType: candidate.constructionType,
          identityDeclassified: candidate.identityDeclassified,
          // The independent reviewer requires a transparent rationale when M03 selected a
          // self-devised formula. Omitting this field made that requirement impossible to satisfy
          // and could trap otherwise coherent plans in a repair/fallback loop.
          applicable: candidate.applicable,
          herbs,
          decoction: decoction ? {
            doseCount: decoction.doseCount,
            course: decoction.course,
          } : undefined,
        }];
      })
    : [];
  return {
    prior: {
      overview: priorOverview ? {
        primarySyndrome: priorOverview.primarySyndrome,
        primarySyndromeBasis: priorOverview.primarySyndromeBasis,
        overallPathogenesis: priorOverview.overallPathogenesis,
        overallTherapy: priorOverview.overallTherapy,
        recommendedFormulaNames: priorOverview.recommendedFormulaNames,
        formulaSelectionMode: priorOverview.formulaSelectionMode,
      } : undefined,
      westernDiagnosis: priorWesternPrimary ? {
        primary: {
          name: priorWesternPrimary.name,
          status: priorWesternPrimary.status,
          supportingFacts: priorWesternPrimary.supportingFacts,
          limitations: priorWesternPrimary.limitations,
        },
      } : undefined,
      pathogenesis: priorPathogenesis
        ? {
            summary: priorPathogenesis.summary,
            chain: Array.isArray(priorPathogenesis.chain)
              ? priorPathogenesis.chain.flatMap((value) => {
                  const node = record(value);
                  return node ? [{
                    nodeId: node.nodeId,
                    patientFact: node.patientFact,
                    pathogenesis: node.pathogenesis,
                    therapyDirection: node.therapyDirection,
                  }] : [];
                })
              : [],
            uncertainties: priorPathogenesis.uncertainties,
          }
        : undefined,
      therapy: priorTherapy ? {
        overallPrinciple: priorTherapy.overallPrinciple,
        overallMethod: priorTherapy.overallMethod,
        subTherapies: priorTherapy.subTherapies,
      } : undefined,
      management: prior.management,
    },
    candidate: {
      formula: currentFormula
        ? {
            candidates: compactCandidates,
            patentAndWestern: Array.isArray(currentFormula.patentAndWestern)
              ? currentFormula.patentAndWestern.flatMap((value) => {
                  const item = record(value);
                  if (!item) return [];
                  const clinicalItem = { ...item };
                  delete clinicalItem.evidence;
                  return [clinicalItem];
                })
              : [],
            modifications: Array.isArray(currentFormula.modifications)
              ? currentFormula.modifications.flatMap((value) => {
                  const item = record(value);
                  if (!item) return [];
                  const clinicalItem = { ...item };
                  delete clinicalItem.evidence;
                  return [clinicalItem];
                })
              : [],
          }
        : null,
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]));
}

/**
 * Fingerprint only the clinical decisions delegated to the independent M04 reviewer. Provenance,
 * evidence metadata, visible markdown and server-owned standard decoction/follow-up rendering are
 * protected by separate deterministic contracts and the final HMAC; changing only those fields
 * must not turn one accepted prescription into a second stochastic review draw.
 */
export function m04ClinicalReviewSemanticHash(priorReasoning: unknown, reasoning: unknown): `sha256:${string}` {
  const payload = buildM04ClinicalReviewPayload(priorReasoning, reasoning);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function isCanonicalSubset(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const counts = new Map<string, number>();
  for (const item of before) {
    const key = canonicalJson(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const item of after) {
    const key = canonicalJson(item);
    const remaining = counts.get(key) || 0;
    if (remaining <= 0) return false;
    counts.set(key, remaining - 1);
  }
  return true;
}

/**
 * Final evidence governance may only remove an optional drug or IF-THEN branch whose evidence did
 * not survive the allowlist. That is a monotonic reduction of an already-reviewed plan. Any core
 * formula change, optional-row edit, or newly added row still requires a fresh review.
 */
export function canRebindM04ClinicalReview(
  priorReasoning: unknown,
  reviewedReasoning: unknown,
  finalReasoning: unknown,
): boolean {
  const before = buildM04ClinicalReviewPayload(priorReasoning, reviewedReasoning);
  const after = buildM04ClinicalReviewPayload(priorReasoning, finalReasoning);
  const beforeFormula = record(before.candidate.formula);
  const afterFormula = record(after.candidate.formula);
  if (!beforeFormula || !afterFormula) return canonicalJson(before) === canonicalJson(after);
  const { patentAndWestern: beforeMedicines, modifications: beforeModifications, ...beforeCoreFormula } = beforeFormula;
  const { patentAndWestern: afterMedicines, modifications: afterModifications, ...afterCoreFormula } = afterFormula;
  const beforeCore = { ...before, candidate: { ...before.candidate, formula: beforeCoreFormula } };
  const afterCore = { ...after, candidate: { ...after.candidate, formula: afterCoreFormula } };
  return canonicalJson(beforeCore) === canonicalJson(afterCore) &&
    isCanonicalSubset(beforeMedicines, afterMedicines) &&
    isCanonicalSubset(beforeModifications, afterModifications);
}

export function m04ClinicalReviewDiffPaths(
  priorReasoning: unknown,
  reviewedReasoning: unknown,
  finalReasoning: unknown,
): string[] {
  const before = canonicalize(buildM04ClinicalReviewPayload(priorReasoning, reviewedReasoning));
  const after = canonicalize(buildM04ClinicalReviewPayload(priorReasoning, finalReasoning));
  const paths: string[] = [];
  const visit = (left: unknown, right: unknown, path: string) => {
    if (paths.length >= 40 || Object.is(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) paths.push(`${path}.length`);
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) visit(left[index], right[index], `${path}[${index}]`);
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object") {
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
  visit(before, after, "m04Review");
  return [...new Set(paths)];
}

export function buildM04ClinicalReviewPrompt(
  clinicalContext: string,
  priorReasoning: unknown,
  reasoning: unknown,
  evidenceContext = "",
): string {
  const payload = buildM04ClinicalReviewPayload(priorReasoning, reasoning);
  const reviewEvidence = evidenceContext
    .split("\n")
    .filter((line) => /\[(?:(?:EVID|LOCAL)-INST|EVID-GUIDE|EVID-PAPER|EVID-LITERATURE)-\d{3}\]|\[TCM-FORMULA-[A-F0-9]+\]/.test(line))
    .join("\n")
    .slice(0, 12_000);
  return [
    "你是独立的中药候选处方临床复核器，不负责重新生成报告，也不替代外部合理用药审方。只判断当前 M04 候选是否与已签名 M03 和患者事实相符。",
    "先核对方名与实际药味组成：沿用命名方时，核心组成和方义必须与该方相符；加减后若已失去原方核心结构，应返回 formula_composition_mismatch。",
    "再逐味核对药物方向是否服务于 M03 的主证、病机节点和治法。不得用患者未提供、明确否认、仅在不确定项或条件句中出现的症状来证明药物必要性。明显偏离时返回 herb_plan_mismatch。",
    "重点复核君臣佐使层级，而不是只看药味是否常见：君药必须直接承担 P1 核心病机和总治法的中心作用，不能把山药、甘草等通用补益/调和药跨病种机械设为君药；自拟方若角色层级与核心治法不一致，返回 herb_plan_mismatch。待复核投影中的 targetPathogenesis、function 与 prescriptionRole 是服务端依据受控病机节点和药味知识库生成的逐味解释，必须与药名、role、targetRef 一并审查，不能因投影缺少自由文本解释而推定角色不成立。1–2 味并列君药均为合法结构：当一味或两味君药已直接覆盖 P1 中心治法时必须接受，不得仅因存在另一种同样合理的君药选择、偏好单君药或偏好其他层级而要求 repair。",
    "命名方优先由方证和受控方剂目录决定；自拟方必须说明为何命名方不适配，并维持可解释的药组层级。不得为了规避组成核验把一个实质上的经典方随意改称自拟方。",
    "西药/中成药候选必须逐项绑定本轮 EVID-INST 或 LOCAL-INST 的药名、条目ID与sha256指纹，且说明书适应证须覆盖本例当前阳性问题；集外药名、错配指纹或把说明书未返回的用法剂量补出来均返回 patient_context_mismatch。西药在本版本只能是无剂量的 discussion_only，中成药在说明书摘要没有完整用法时也不得生成剂量。",
    "复核随症加减是否只服务于本次病历已明确记录的当前伴随症状：trigger 必须能逐字回溯到已签名 M03 的 primarySyndromeBasis、pathogenesis.chain.patientFact 或 westernDiagnosis.supportingFacts；不得把当前处方药重复写成 add，也不得预设‘若出现、复诊时出现、接诊时核实’的未来症状。modifications 空数组是合法的保守方案，不得仅因没有加减而要求 repair。",
    "结合年龄、性别/生理状态、过敏史、现用药、生命体征和已知检查等已提供信息，检查剂量及配伍是否存在需要重新生成而非仅靠常规审方提示解决的临床不合理。剂量选择与证候强度明显不相称时返回 dose_rationale_concern；处方依赖未成立或相反的患者事实时返回 patient_context_mismatch。",
    "把婴幼儿、妊娠/备孕/哺乳、慢性肾病3-5期或eGFR降低、心力衰竭、抗凝/抗血小板治疗、免疫抑制治疗、糖尿病足/活动性感染、活动期自身免疫病视为剂量级高风险语义类别；只要患者事实提示同义或口语化等价状态，而方案没有专科/药师个体化复核前提，就必须返回 patient_context_mismatch。该清单是概念示例而非封闭关键词表。",
    "未知信息本身不阻断候选生成，但候选必须对重要未知状态保持保守鲁棒：若某药味或剂量只有在未确认的妊娠/哺乳、肝肾功能、现用药或过敏状态为阴性时才适合，而当前存在合理的更安全组方路径，应返回 patient_context_mismatch，要求改成不依赖该未知前提的候选。不得用一句‘采纳前复核’掩盖这种可避免的依赖。",
    "不要因为病例信息稀疏、缺少舌脉或外部审方尚未执行而拒绝；只评估现有信息范围内能否形成保守、连贯的候选。后续审方负责提示仍不可避免的常规禁忌、相互作用和配伍风险；本复核器负责先消除在生成阶段即可避免的明显风险。",
    "只输出一个 JSON 对象，不要代码块或解释。接受时输出 {\"status\":\"accepted\",\"issueCode\":\"none\"}。需重生成时除 status=repair 与 issueCode 外，还必须输出 repairFocus、candidateIndex 和 implicatedHerbs：formula_composition_mismatch 只能配 formula_core_composition；herb_plan_mismatch 只能配 emperor_role、herb_direction 或 modification_logic；dose_rationale_concern 只能配 dose_strength；patient_context_mismatch 只能配 patient_dependency。candidateIndex 从0开始；implicatedHerbs 只能逐字列出待复核候选中实际存在且需要调整的药名，无具体药味时用空数组。一次只返回最关键问题，不得输出自由文本修复指令。",
    `患者事实边界：${clinicalContext.slice(0, 8_000)}`,
    reviewEvidence
      ? `本轮可用证据摘要（仅用于核对方剂来源、适应证、药物与剂量依据，绝不能当作患者事实）：${reviewEvidence}`
      : "本轮未提供额外外部证据；不得因此编造方剂出处、药物依据或患者事实。",
    `已签名M03临床投影：${JSON.stringify(payload.prior).slice(0, 10_000)}`,
    `待复核M04临床投影：${JSON.stringify(payload.candidate).slice(0, 14_000)}`,
  ].join("\n\n");
}

export function m04ClinicalReviewNeedsAdjudication(review: M04ClinicalReview): boolean {
  return review.status === "repair" &&
    review.issueCode === "herb_plan_mismatch" &&
    review.repairFocus === "emperor_role";
}

export function buildM04ClinicalReviewAdjudicationPrompt(
  clinicalContext: string,
  priorReasoning: unknown,
  reasoning: unknown,
  evidenceContext: string,
  disputedReview: M04ClinicalReview,
): string {
  return [
    buildM04ClinicalReviewPrompt(clinicalContext, priorReasoning, reasoning, evidenceContext),
    "你是第二名独立裁决复核器。上一名复核器对君药角色提出了争议；不得盲从上一意见，也不得仅因自己偏好另一味同样合理的君药而要求重生成。",
    `上一复核器结构化意见：${JSON.stringify(disputedReview)}`,
    "请用待复核投影中服务端生成的 function、prescriptionRole、targetPathogenesis、role 与 targetRef 逐项裁决：若现有 1–2 味君药的知识库功用确实直接覆盖 P1 核心治法，且不存在患者事实冲突或明显方向漂移，必须 accepted；只有功用不覆盖 P1、依赖未成立事实或明显偏离总治法时才 repair。仍只输出原约定 JSON。",
  ].join("\n\n");
}

export function parseM04ClinicalReview(content: string): M04ClinicalReview {
  const parsed = parseClinicalReviewJson(content);
  if (parsed) {
    if (parsed.status === "accepted" && parsed.issueCode === "none") {
      return { status: "accepted", issueCode: "none" };
    }
    if (
      parsed.status === "repair" &&
      typeof parsed.issueCode === "string" &&
      REPAIR_ISSUES.has(parsed.issueCode as M04ClinicalRepairIssue)
    ) {
      const issueCode = parsed.issueCode as M04ClinicalRepairIssue;
      const repairFocus = typeof parsed.repairFocus === "string" &&
        REPAIR_FOCUS_BY_ISSUE[issueCode].has(parsed.repairFocus as M04ClinicalRepairFocus)
        ? parsed.repairFocus as M04ClinicalRepairFocus
        : undefined;
      const candidateIndex = Number.isInteger(parsed.candidateIndex) &&
        Number(parsed.candidateIndex) >= 0 && Number(parsed.candidateIndex) <= 4
        ? Number(parsed.candidateIndex)
        : undefined;
      const implicatedHerbs = Array.isArray(parsed.implicatedHerbs)
        ? [...new Set(parsed.implicatedHerbs.flatMap((value) => (
            typeof value === "string" && value.trim() && value.trim().length <= 24
              ? [value.trim()]
              : []
          )))].slice(0, 6)
        : undefined;
      return {
        status: "repair",
        issueCode,
        ...(repairFocus ? { repairFocus } : {}),
        ...(candidateIndex != null ? { candidateIndex } : {}),
        ...(implicatedHerbs ? { implicatedHerbs } : {}),
      };
    }
  }
  return { status: "unavailable", issueCode: "review_unavailable" };
}

/**
 * Translate only allowlisted reviewer coordinates into repair guidance. Herb names are intersected
 * with the exact reviewed candidate, so model-authored prose or invented medicines can never become
 * executable repair instructions.
 */
export function m04ClinicalRepairGuidance(review: M04ClinicalReview, reasoning: unknown): string {
  if (review.status !== "repair") return "";
  const current = record(reasoning);
  const formula = record(current?.formula);
  const candidates = Array.isArray(formula?.candidates) ? formula.candidates : [];
  const candidateIndex = review.candidateIndex != null && review.candidateIndex < candidates.length
    ? review.candidateIndex
    : 0;
  const candidate = record(candidates[candidateIndex]);
  const candidateHerbs = Array.isArray(candidate?.herbs)
    ? candidate.herbs.flatMap((value) => {
        const herb = record(value);
        return typeof herb?.name === "string" && herb.name.trim() ? [herb.name.trim()] : [];
      })
    : [];
  const implicated = (review.implicatedHerbs || []).filter((name) => candidateHerbs.includes(name));
  const focus = review.repairFocus;
  const implicatedEmperorGuidance = focus === "emperor_role" && implicated.length > 0
    ? `复核器已明确判定下列药味的当前君药归属不承担 P1：${implicated.join("、")}。修复稿中这些药味不得继续标为君药；仅在其确实服务于已签名 P2/P3 或受控方内结构作用时改为臣/佐/使保留，否则删除。必须从候选既有药味中选择直接覆盖 P1 中心治法者担任 1–2 味君药；若既有药味均不能承担 P1，则用提示中知识库已覆盖、直接服务 P1 的药味替换不匹配药味，不得新增病机或患者事实。`
    : "";
  const focusGuidance: Partial<Record<M04ClinicalRepairFocus, string>> = {
    formula_core_composition: "只核对所选命名方的核心组成；若核心结构已不成立，按合同透明改为本例辨证组方。",
    emperor_role: "只重新核对君臣佐使：君药必须直接承担 P1 中心治法，不能按药味顺序或通用补益作用指定；1–2 味分别覆盖 P1 组合治法时并列君药合法，不得为了单君药偏好改动合理层级。",
    herb_direction: "删除或替换不服务于已签名 P 节点与治法的药味，其余已通过药味和剂量保持不变。",
    modification_logic: "只修正条件性加减：不得重复当前方中药味，不得把未出现症状当作当前加药依据。",
    dose_strength: "只把涉及药味的剂量调整到已注入保守边界内并与患者已知情况相称，不改写病机与患者事实。",
    patient_dependency: "移除依赖未成立患者前提的药味或方案，改用对当前未知状态更鲁棒的候选，不新增患者事实。",
  };
  return [
    `受控复核定位：候选 ${candidateIndex + 1}；问题类别 ${review.issueCode}。`,
    focus ? `修复焦点 ${focus}：${focusGuidance[focus]}` : "复核器未返回有效细分焦点，只按问题类别做最小修复。",
    implicatedEmperorGuidance,
    implicated.length > 0 ? `仅重点核对候选中已存在的药味：${implicated.join("、")}。` : "复核器未指向具体药味，不得据此新增或猜测药味。",
  ].filter(Boolean).join("\n");
}

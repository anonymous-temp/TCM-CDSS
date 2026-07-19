import { createHash } from "node:crypto";

import { parseClinicalReviewJson } from "./clinical-review-contract";

export type M04ClinicalRepairIssue =
  | "formula_composition_mismatch"
  | "herb_plan_mismatch"
  | "dose_rationale_concern"
  | "patient_context_mismatch";

export type M04ClinicalReview =
  | { status: "accepted"; issueCode: "none" }
  | { status: "repair"; issueCode: M04ClinicalRepairIssue }
  | { status: "unavailable"; issueCode: "review_unavailable" };

const REPAIR_ISSUES = new Set<M04ClinicalRepairIssue>([
  "formula_composition_mismatch",
  "herb_plan_mismatch",
  "dose_rationale_concern",
  "patient_context_mismatch",
]);

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
                structureRole: herb.structureRole,
                isToxic: herb.isToxic,
                decoctionRequirement: herb.decoctionRequirement,
              }] : [];
            })
          : [];
        return [{
          name: candidate.name,
          formulaNames: candidate.formulaNames,
          identityDeclassified: candidate.identityDeclassified,
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
  return [
    "你是独立的中药候选处方临床复核器，不负责重新生成报告，也不替代外部合理用药审方。只判断当前 M04 候选是否与已签名 M03 和患者事实相符。",
    "先核对方名与实际药味组成：沿用命名方时，核心组成和方义必须与该方相符；加减后若已失去原方核心结构，应返回 formula_composition_mismatch。",
    "再逐味核对药物方向是否服务于 M03 的主证、病机节点和治法。不得用患者未提供、明确否认、仅在不确定项或条件句中出现的症状来证明药物必要性。明显偏离时返回 herb_plan_mismatch。",
    "重点复核君臣佐使层级，而不是只看药味是否常见：君药必须直接承担 P1 核心病机和总治法的中心作用，不能把山药、甘草等通用补益/调和药跨病种机械设为君药；自拟方若角色层级与核心治法不一致，返回 herb_plan_mismatch。",
    "命名方优先由方证和受控方剂目录决定；自拟方必须说明为何命名方不适配，并维持可解释的药组层级。不得为了规避组成核验把一个实质上的经典方随意改称自拟方。",
    "复核条件性加减是否形成高价值 IF-THEN 分支：不得把当前处方药重复写成 add，不得给未出现的症状直接加药；病例确有合理复诊分支却完全不给加减时，应结合整体完整性判断 herb_plan_mismatch。",
    "结合年龄、性别/生理状态、过敏史、现用药、生命体征和已知检查等已提供信息，检查剂量及配伍是否存在需要重新生成而非仅靠常规审方提示解决的临床不合理。剂量选择与证候强度明显不相称时返回 dose_rationale_concern；处方依赖未成立或相反的患者事实时返回 patient_context_mismatch。",
    "未知信息本身不阻断候选生成，但候选必须对重要未知状态保持保守鲁棒：若某药味或剂量只有在未确认的妊娠/哺乳、肝肾功能、现用药或过敏状态为阴性时才适合，而当前存在合理的更安全组方路径，应返回 patient_context_mismatch，要求改成不依赖该未知前提的候选。不得用一句‘采纳前复核’掩盖这种可避免的依赖。",
    "不要因为病例信息稀疏、缺少舌脉或外部审方尚未执行而拒绝；只评估现有信息范围内能否形成保守、连贯的候选。后续审方负责提示仍不可避免的常规禁忌、相互作用和配伍风险；本复核器负责先消除在生成阶段即可避免的明显风险。",
    "只输出一个 JSON 对象，不要代码块或解释。接受时输出 {\"status\":\"accepted\",\"issueCode\":\"none\"}；需重生成时 status=repair，issueCode 只能是 formula_composition_mismatch、herb_plan_mismatch、dose_rationale_concern、patient_context_mismatch 之一。一次只返回最关键问题。",
    `患者事实边界：${clinicalContext.slice(0, 8_000)}`,
    evidenceContext.trim()
      ? `本轮可用证据摘要（仅用于核对方剂来源、适应证、药物与剂量依据，绝不能当作患者事实）：${evidenceContext.slice(0, 3_000)}`
      : "本轮未提供额外外部证据；不得因此编造方剂出处、药物依据或患者事实。",
    `已签名M03临床投影：${JSON.stringify(payload.prior).slice(0, 10_000)}`,
    `待复核M04临床投影：${JSON.stringify(payload.candidate).slice(0, 14_000)}`,
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
      return { status: "repair", issueCode: parsed.issueCode as M04ClinicalRepairIssue };
    }
  }
  return { status: "unavailable", issueCode: "review_unavailable" };
}

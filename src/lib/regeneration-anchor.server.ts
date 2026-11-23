import { parseReasoningV2 } from "./diagnosis-parse";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";
import { readStageSidecar, stageRecordFingerprint, stageResultReuseEnabled, writeStageSidecar } from "./stage-result-coalescing.server";

/**
 * 重新生成的基准（2026-11-23 第五十八轮，「强制重生成时方名和药味仍有变化」）。
 *
 * 不强制时同一份病历走留存，逐字相同。强制重新生成（x-cdss-regenerate: force）是一次真实的模型抽样：温度 0 也不保证相同，
 * 同一份已签名辨证下三次开方，方名能稳住（第五十四轮锁定方），药味仍会 14/14/13、加减 2/4/4 条。
 *
 * 做法（用户 2026-11-23 定）：把之前的结果作为背景回传给模型。两层：
 *  1. 同一次模型调用上一次的完整输出（model-call-memo.server.ts）：请求内容相同就有，辨证两半、开方首轮、追问都走它；
 *  2. 本文件：同一份病历上一次**交付的处方**（方名、逐味药名剂量角色、加减、中成药）。辨证重新生成后文字有改动时，
 *     开方提示词随之不同、第 1 层对不上，这时用它兜底；同时它是线上核对「重新生成后变没变」的比对基准（辨证也留一份只作比对）。
 * 模型照基准写，文字可以重新组织；只有基准与病历明确冲突时才改，并写明原因。
 *
 *  · 只在强制重新生成时读；不强制时仍是留存回放，与此无关。
 *  · 基准按「租户 + 病历内容 + 代码版本」取（stageRecordFingerprint）：换了版本不认上一版的结论，修好的缺陷不会被旧结果带回来；
 *    病历改了一个字也不认。
 *  · 只留可复用的结果（降级页、中断页、上游故障页不留）；开方基准记着它是在哪一组辨证结论下开的，
 *    本次辨证结论（病名、主证、兼证、锁定方）不同就不用。
 *  · 不给剂量的页面不作基准（那一页没有剂量可沿用）。
 *
 * 与阶段结果留存同开同关（生产默认开，本机与测试默认关）；`CDSS_REGENERATION_ANCHOR=false` 单独关闭。
 */

const NAMESPACE = { diagnose: "regeneration-anchor-diagnose", prescribe: "regeneration-anchor-prescribe" } as const;

export type DiagnoseRegenerationAnchor = {
  v: 1;
  stage: "diagnose";
  tcmDiseaseName: string;
  primarySyndrome: string;
  secondarySyndromes: string[];
  overallMethod: string;
  formulaDirection: string;
  lockedFormulaNames: string[];
  formulaSelectionMode: string;
  westernName: string;
};

export type PrescribeAnchorBasis = {
  tcmDiseaseName: string;
  primarySyndrome: string;
  secondarySyndromes: string[];
  lockedFormulaNames: string[];
};

export type PrescribeRegenerationAnchor = {
  v: 1;
  stage: "prescribe";
  basis: PrescribeAnchorBasis;
  name: string;
  constructionType: string;
  formulaNames: string[];
  herbs: Array<{ name: string; dose: string; role: string; decoctionRequirement: string }>;
  doseCount: string;
  course: string;
  modifications: Array<{ trigger: string; action: string; herbName: string; doseOrHandling: string }>;
  medicines: string[];
};

export function regenerationAnchorEnabled(): boolean {
  if (process.env.CDSS_REGENERATION_ANCHOR === "false") return false;
  return stageResultReuseEnabled();
}

type Tenant = { clientId?: string; customerId?: string };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);

// ─── 取结论 ────────────────────────────────────────────────────────────────────────────────

export function diagnoseAnchorFromReasoning(reasoning: ClinicalReasoningResultV2 | null | undefined): DiagnoseRegenerationAnchor | undefined {
  if (!reasoning || reasoning.stage !== "diagnose") return undefined;
  const overview = reasoning.overview;
  const tcmDiseaseName = text(overview?.tcmDiseaseName);
  const primarySyndrome = text(overview?.primarySyndrome);
  // 有限结论（占位证候、没有病机链）不是一份可沿用的辨证。
  if (!tcmDiseaseName || !primarySyndrome || !(reasoning.pathogenesis?.chain || []).length) return undefined;
  return {
    v: 1,
    stage: "diagnose",
    tcmDiseaseName,
    primarySyndrome,
    secondarySyndromes: list(overview.secondarySyndromes),
    overallMethod: text(reasoning.therapy?.overallMethod) || text(overview.overallTherapy),
    formulaDirection: text(overview.recommendedFormulaDirection),
    lockedFormulaNames: list(overview.recommendedFormulaNames),
    formulaSelectionMode: text(overview.formulaSelectionMode) || "none",
    westernName: text(reasoning.westernDiagnosis?.primary?.name),
  };
}

export function prescribeAnchorBasis(prior: ClinicalReasoningResultV2 | null | undefined): PrescribeAnchorBasis | undefined {
  if (!prior) return undefined;
  const primarySyndrome = text(prior.overview?.primarySyndrome);
  if (!primarySyndrome) return undefined;
  return {
    tcmDiseaseName: text(prior.overview?.tcmDiseaseName),
    primarySyndrome,
    secondarySyndromes: list(prior.overview?.secondarySyndromes),
    lockedFormulaNames: list(prior.overview?.recommendedFormulaNames),
  };
}

export function prescribeAnchorFromReasoning(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  prior: ClinicalReasoningResultV2 | null | undefined,
): PrescribeRegenerationAnchor | undefined {
  const basis = prescribeAnchorBasis(prior);
  const candidate = reasoning?.formula?.candidates?.[0];
  if (!reasoning || reasoning.stage !== "prescribe" || !basis || !candidate) return undefined;
  const herbs = (candidate.herbs || []).map((herb) => ({
    name: text(herb.name),
    dose: text(herb.dose),
    role: text(herb.role),
    decoctionRequirement: text(herb.decoctionRequirement),
  }));
  // 每味都有药名和剂量才是一张可沿用的处方（不给剂量的页面进不来）。
  if (herbs.length === 0 || herbs.some((herb) => !herb.name || !herb.dose)) return undefined;
  return {
    v: 1,
    stage: "prescribe",
    basis,
    name: text(candidate.name),
    constructionType: text(candidate.constructionType),
    formulaNames: list(candidate.formulaNames),
    herbs,
    doseCount: text(candidate.decoction?.doseCount),
    course: text(candidate.decoction?.course),
    modifications: (reasoning.formula?.modifications || []).map((row) => ({
      trigger: text(row.trigger),
      action: text(row.action),
      herbName: text(row.herbName),
      doseOrHandling: text(row.doseOrHandling),
    })).filter((row) => row.trigger && row.herbName),
    medicines: (reasoning.formula?.patentAndWestern || []).map((row) => text((row as { name?: unknown }).name)).filter(Boolean),
  };
}

// ─── 留存 ──────────────────────────────────────────────────────────────────────────────────

/** 阶段真实算出可复用结果时调用：把结论留作下一次重新生成的基准。 */
export function rememberDiagnoseAnchor(tenant: Tenant, caseState: unknown, finalContent: string): void {
  if (!regenerationAnchorEnabled()) return;
  const anchor = diagnoseAnchorFromReasoning(parseReasoningV2(finalContent));
  if (anchor) void writeStageSidecar(NAMESPACE.diagnose, stageRecordFingerprint("diagnose", tenant, caseState), anchor);
}

export function rememberPrescribeAnchor(
  tenant: Tenant,
  caseState: unknown,
  finalContent: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): void {
  if (!regenerationAnchorEnabled()) return;
  const anchor = prescribeAnchorFromReasoning(parseReasoningV2(finalContent), prior);
  if (anchor) void writeStageSidecar(NAMESPACE.prescribe, stageRecordFingerprint("prescribe", tenant, caseState), anchor);
}

function isDiagnoseAnchor(value: unknown): value is DiagnoseRegenerationAnchor {
  const anchor = value as DiagnoseRegenerationAnchor | undefined;
  return Boolean(anchor && anchor.v === 1 && anchor.stage === "diagnose" && anchor.primarySyndrome && anchor.tcmDiseaseName);
}

function isPrescribeAnchor(value: unknown): value is PrescribeRegenerationAnchor {
  const anchor = value as PrescribeRegenerationAnchor | undefined;
  return Boolean(anchor && anchor.v === 1 && anchor.stage === "prescribe" && anchor.basis && Array.isArray(anchor.herbs) && anchor.herbs.length > 0);
}

export async function readDiagnoseAnchor(tenant: Tenant, caseState: unknown): Promise<DiagnoseRegenerationAnchor | undefined> {
  if (!regenerationAnchorEnabled()) return undefined;
  const stored = await readStageSidecar(NAMESPACE.diagnose, stageRecordFingerprint("diagnose", tenant, caseState));
  return isDiagnoseAnchor(stored) ? stored : undefined;
}

export async function readPrescribeAnchor(tenant: Tenant, caseState: unknown): Promise<PrescribeRegenerationAnchor | undefined> {
  if (!regenerationAnchorEnabled()) return undefined;
  const stored = await readStageSidecar(NAMESPACE.prescribe, stageRecordFingerprint("prescribe", tenant, caseState));
  return isPrescribeAnchor(stored) ? stored : undefined;
}

// ─── 适用与比对 ────────────────────────────────────────────────────────────────────────────

/** 上次的处方是在同一组辨证结论（病名、主证、兼证、锁定方）下开的，才作本次的基准。 */
export function prescribeAnchorApplies(anchor: PrescribeRegenerationAnchor | undefined, prior: ClinicalReasoningResultV2 | null | undefined): boolean {
  const current = prescribeAnchorBasis(prior);
  if (!anchor || !current) return false;
  return anchor.basis.tcmDiseaseName === current.tcmDiseaseName &&
    anchor.basis.primarySyndrome === current.primarySyndrome &&
    sameList(anchor.basis.secondarySyndromes, current.secondarySyndromes) &&
    sameList(anchor.basis.lockedFormulaNames, current.lockedFormulaNames);
}

export type PrescribeAnchorDifference = {
  nameChanged: boolean;
  herbsAdded: string[];
  herbsRemoved: string[];
  dosesChanged: number;
  rolesChanged: number;
  modificationsAdded: number;
  modificationsRemoved: number;
};

const modificationKey = (row: { trigger: string; action: string; herbName: string }) =>
  `${row.trigger.replace(/^本例已见/u, "")}|${row.action}|${row.herbName}`;

/** 本次结果与基准在「决定」上的差别（方名、药味、剂量、角色、加减行）；文字不比。 */
export function prescribeAnchorDifference(anchor: PrescribeRegenerationAnchor, current: PrescribeRegenerationAnchor | undefined): PrescribeAnchorDifference | undefined {
  if (!current) return undefined;
  const before = new Map(anchor.herbs.map((herb) => [herb.name, herb]));
  const after = new Map(current.herbs.map((herb) => [herb.name, herb]));
  const shared = [...after.keys()].filter((name) => before.has(name));
  const beforeRows = new Set(anchor.modifications.map(modificationKey));
  const afterRows = new Set(current.modifications.map(modificationKey));
  return {
    nameChanged: anchor.name !== current.name,
    herbsAdded: [...after.keys()].filter((name) => !before.has(name)),
    herbsRemoved: [...before.keys()].filter((name) => !after.has(name)),
    dosesChanged: shared.filter((name) => before.get(name)!.dose !== after.get(name)!.dose).length,
    rolesChanged: shared.filter((name) => before.get(name)!.role !== after.get(name)!.role).length,
    modificationsAdded: [...afterRows].filter((key) => !beforeRows.has(key)).length,
    modificationsRemoved: [...beforeRows].filter((key) => !afterRows.has(key)).length,
  };
}

export type DiagnoseAnchorDifference = {
  diseaseChanged: boolean;
  primaryChanged: boolean;
  secondaryChanged: boolean;
  methodChanged: boolean;
  lockChanged: boolean;
  westernChanged: boolean;
};

export function diagnoseAnchorDifference(anchor: DiagnoseRegenerationAnchor, current: DiagnoseRegenerationAnchor | undefined): DiagnoseAnchorDifference | undefined {
  if (!current) return undefined;
  return {
    diseaseChanged: anchor.tcmDiseaseName !== current.tcmDiseaseName,
    primaryChanged: anchor.primarySyndrome !== current.primarySyndrome,
    secondaryChanged: !sameList(anchor.secondarySyndromes, current.secondarySyndromes),
    methodChanged: anchor.overallMethod !== current.overallMethod,
    lockChanged: !sameList(anchor.lockedFormulaNames, current.lockedFormulaNames),
    westernChanged: anchor.westernName !== current.westernName,
  };
}

// ─── 写给模型的基准段 ──────────────────────────────────────────────────────────────────────

export function prescribeAnchorPromptSection(anchor: PrescribeRegenerationAnchor): string {
  const herbLine = anchor.herbs.map((herb) => `${herb.name} ${herb.dose} ${herb.role}`).join("；");
  const modificationLines = anchor.modifications.map((row) =>
    `${row.trigger}：${row.action}${row.herbName}${row.doseOrHandling ? ` ${row.doseOrHandling}` : ""}`);
  return [
    "【同一份病历上一次的处方（本次重新生成的基准）】",
    "这份病历在同一辨证结论下已经生成过处方，并通过了剂量、配伍与人群禁忌核对。本次是对同一份病历重新生成，病历与辨证结论都没有变化，处方应与上次保持一致：",
    `方名：${anchor.name}`,
    `药味（药名 剂量 君臣佐使，共${anchor.herbs.length}味）：${herbLine}`,
    anchor.doseCount || anchor.course ? `剂数与疗程：${[anchor.doseCount, anchor.course].filter(Boolean).join("，")}` : "",
    modificationLines.length > 0 ? `随证加减（共${modificationLines.length}条）：${modificationLines.join("；")}` : "随证加减：上次未列",
    anchor.medicines.length > 0 ? `中成药/西药：${anchor.medicines.join("、")}` : "中成药/西药：上次未推荐",
    `要求：candidate.name 与上面的方名相同；candidate.herbs 就是上面这${anchor.herbs.length}味，药名（含炮制写法）、剂量、君臣佐使逐味相同，不增不减、不换写法；modifications 与上面逐条相同（trigger、action、herbName、doseOrHandling 原样照写，上次未列就不写）；中成药/西药从本次给出的条目里选同样的药，上次未推荐就不推荐。方义、各药功效说明、注意事项与调护按这张处方来写。`,
  ].filter(Boolean).join("\n");
}

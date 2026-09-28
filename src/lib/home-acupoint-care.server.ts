import homeAcupointCareJson from "../data/tcm-home-acupoint-care.source.json" with { type: "json" };
import natureLexiconJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import type { ClinicalReasoningResultV2, SafetyGate } from "./diagnosis-types";

/**
 * 居家穴位保健（2026-09-28，甲方反馈：M04 调护「穴位保健」从未出现）。
 *
 * nonPharma.acupointCare 此前被服务端固定置空：受控项目目录只有需要医师操作的针刺、耳穴等，
 * 没有患者居家可做的穴位保健来源，又不能让模型自由书写穴位。这里从受治理清单
 * （tcm-home-acupoint-care.source.json，国家基本公共卫生服务规范配套技术规范原文）确定性选穴：
 *   已签名 M03 的病性（受控病性词表）→ 体质 → 该体质的保健穴与操作量；
 *   0～36 月龄儿童按月龄取摩腹/捏脊/穴位按揉；3～17 岁没有受治理来源，不输出。
 * 不调用模型、不增加耗时。禁忌由调用方复用项目级禁忌判定后传入（居家按揉按「推拿」、艾灸按「艾灸」），
 * 本模块不另写一套禁忌正则。
 *
 * 终审口径与 tcm-acupoint-syndrome-refinement-adjudications 相同：pending_clinician_review 的条目
 * 运行时不应用；CDSS_HOME_ACUPOINT_CARE=include_pending 可在中医师签字前临时启用，=off 整体关闭。
 */

type AdjudicationStatus = "approved" | "pending_clinician_review";
type ConstitutionKey = "qi_deficiency" | "yang_deficiency" | "yin_deficiency" | "phlegm_dampness" | "damp_heat" | "blood_stasis" | "qi_stagnation";
type AcupointEntry = { name: string; region: string; standardLocation: string; patientLocation: string };
type ConstitutionEntry = {
  label: string;
  adjudicationStatus: AdjudicationStatus;
  acupressure: { points: AcupointEntry[]; method: string; dose: string };
  moxibustion?: { points: string[]; method: string; dose: string };
  extraPoints?: AcupointEntry[];
};
type ChildBand = { minMonths: number; maxMonths: number; items: Array<{ name: string; text: string }> };
type HomeAcupointCareSource = {
  natureToConstitution: {
    adjudicationStatus: AdjudicationStatus;
    deficiencyPriority: Array<{ natures: string[]; constitution: ConstitutionKey }>;
    excessPriority: Array<{ natures?: string[]; allOf?: string[]; excludeWhenAny?: string[]; constitution: ConstitutionKey }>;
    suppressWhenAny: string[];
    syndromeTermAliases: Array<{ term: string; nature: string; alsoNature?: string }>;
  };
  constitutions: Record<ConstitutionKey, ConstitutionEntry>;
  children: { adjudicationStatus: AdjudicationStatus; bands: ChildBand[]; cautions: string };
  cautions: { acupressure: string; moxibustion: string };
  pregnancyUnresolved: { excludedPoints: string[]; excludedRegions: string[] };
};

const SOURCE = homeAcupointCareJson as unknown as HomeAcupointCareSource;
const NATURE_TERMS = (natureLexiconJson as { entries: Array<{ id: string; canonical: string; aliases?: string[] }> }).entries
  .flatMap((entry) => [entry.canonical, ...(entry.aliases || [])].map((term) => ({ id: entry.id, term })))
  // 长词先配：「气机郁滞」「湿热」这类复合写法不能先被单字「湿」「热」吃掉后丢了语义。
  .sort((a, b) => b.term.length - a.term.length);

export type HomeAcupointCareMode = "approved_only" | "include_pending" | "off";

export function homeAcupointCareMode(): HomeAcupointCareMode {
  const configured = process.env.CDSS_HOME_ACUPOINT_CARE?.trim();
  return configured === "off" || configured === "include_pending" ? configured : "approved_only";
}

function usable(status: AdjudicationStatus, mode: HomeAcupointCareMode): boolean {
  return status === "approved" || (mode === "include_pending" && status === "pending_clinician_review");
}

/** 从一段病性/证候文字里取出受控病性 id（含本表登记的证候简称，如「脾虚」→气虚）。 */
function naturesInText(text: string): Set<string> {
  const found = new Set<string>();
  let rest = text;
  for (const alias of SOURCE.natureToConstitution.syndromeTermAliases) {
    if (!rest.includes(alias.term)) continue;
    found.add(alias.nature);
    if (alias.alsoNature) found.add(alias.alsoNature);
    rest = rest.split(alias.term).join("｜");
  }
  for (const { id, term } of NATURE_TERMS) {
    if (!rest.includes(term)) continue;
    found.add(id);
    rest = rest.split(term).join("｜");
  }
  return found;
}

/**
 * 本例对应的体质。只看已签名 M03 的主证候与病性分类；外感病邪（风、暑、毒）、动风、气脱等
 * 急性状态不对应体质，命中即不输出。先本虚（阳虚 > 阴虚 > 气虚），再标实（湿热 > 血瘀 > 气滞 > 痰湿）。
 */
export function homeAcupointConstitution(prior: ClinicalReasoningResultV2 | null | undefined): ConstitutionKey | undefined {
  if (!prior) return undefined;
  const nature = prior.pathogenesis?.natureDifferentiation;
  const texts = [
    prior.overview?.primarySyndrome || "",
    ...(nature?.items || []),
    ...(nature?.rootDeficiency || []),
    ...(nature?.branchExcess || []),
  ].filter((text) => typeof text === "string" && text.trim());
  // 证候未形成（含急诊优先的有限诊断）用结构化判定，不看措辞。
  if (texts.length === 0 || prior.overview?.primarySyndromeResolution === "unresolved") return undefined;
  const natures = new Set(texts.flatMap((text) => [...naturesInText(text)]));
  const table = SOURCE.natureToConstitution;
  if (table.suppressWhenAny.some((id) => natures.has(id))) return undefined;
  for (const rule of table.deficiencyPriority) {
    if (rule.natures.some((id) => natures.has(id))) return rule.constitution;
  }
  for (const rule of table.excessPriority) {
    if ((rule.excludeWhenAny || []).some((id) => natures.has(id))) continue;
    if (rule.allOf ? rule.allOf.every((id) => natures.has(id)) : (rule.natures || []).some((id) => natures.has(id))) {
      return rule.constitution;
    }
  }
  return undefined;
}

export type HomeAcupointCareContext = {
  prior: ClinicalReasoningResultV2 | null | undefined;
  safetyGate: SafetyGate | undefined;
  ageYears: number | undefined;
  /** 项目级禁忌（tcmTreatmentProjectExclusionReason）：居家按揉按「推拿」、艾灸按「艾灸」。 */
  acupressureExclusion?: string;
  moxibustionExclusion?: string;
  /** 艾灸另加的烫伤风险：糖尿病、感觉减退、体温升高（调用方按本例事实与体征判定后传入）。 */
  moxibustionBurnRisk?: boolean;
  /** 本例已开出的医师操作项目里出现过的穴位与部位文字：同一穴不再重复给居家按揉。 */
  clinicianPointText?: string;
  clinicianMoxibustion?: boolean;
  /** 育龄女性、病历未写明是否妊娠：去掉孕期禁用穴与腹部、腰骶部穴位，不给艾灸（阳性/可疑由 acupressureExclusion 整段排除）。 */
  pregnancyUnresolved?: boolean;
};

/** 红旗、非全剂量方案、硬边界降级一律不给居家保健——那时患者要做的是先就医、先复核。 */
function gateAllowsHomeCare(gate: SafetyGate | undefined): boolean {
  if (!gate || gate.status === "red_flag" || gate.redFlags.length > 0) return false;
  return gate.candidateMode ? gate.candidateMode === "full_dose" : gate.allowDosePrescription === true;
}

function childBandText(ageMonths: number, mode: HomeAcupointCareMode): string | null {
  const children = SOURCE.children;
  if (!usable(children.adjudicationStatus, mode)) return null;
  const band = children.bands.find((item) => ageMonths >= item.minMonths && ageMonths <= item.maxMonths);
  if (!band) return null;
  const methods = band.items.map((item) => `${item.name}：${item.text}。`).join("");
  return `家长可以在家给孩子做：${methods}${children.cautions}`;
}

export function compileHomeAcupointCare(context: HomeAcupointCareContext): string | null {
  const mode = homeAcupointCareMode();
  if (mode === "off" || !gateAllowsHomeCare(context.safetyGate)) return null;
  // 居家按揉在「推拿」项目禁忌下（妊娠阳性/可疑、急性感染与炎症等）整段不给：选穴虽然确定，
  // 患者自行操作没有医师在场，禁忌方向一律从严。
  if (context.acupressureExclusion) return null;
  const ageYears = context.ageYears;
  if (ageYears == null) return null;
  const ageMonths = Math.round(ageYears * 12);
  if (ageMonths < 6) return null;
  if (ageMonths <= 36) return childBandText(ageMonths, mode);
  // 3～17 岁：技术规范只覆盖 0～36 月龄与成人体质保健，这一段没有受治理来源。
  if (ageYears < 18) return null;

  const constitution = homeAcupointConstitution(context.prior);
  if (!constitution || !usable(SOURCE.natureToConstitution.adjudicationStatus, mode)) return null;
  const entry = SOURCE.constitutions[constitution];
  if (!entry || !usable(entry.adjudicationStatus, mode)) return null;

  const clinicianText = context.clinicianPointText || "";
  const pregnancyRule = SOURCE.pregnancyUnresolved;
  const pregnancySafe = (point: AcupointEntry) => !context.pregnancyUnresolved ||
    (!pregnancyRule.excludedPoints.includes(point.name) && !pregnancyRule.excludedRegions.includes(point.region));
  const pressPoints = entry.acupressure.points.filter((point) => !clinicianText.includes(point.name) && pregnancySafe(point));
  const knownPoints = [...entry.acupressure.points, ...(entry.extraPoints || [])];
  const moxibustion = entry.moxibustion && !context.pregnancyUnresolved && !context.moxibustionExclusion &&
    !context.moxibustionBurnRisk && !context.clinicianMoxibustion
    ? entry.moxibustion
    : undefined;
  if (pressPoints.length === 0 && !moxibustion) return null;

  const located = (name: string) => {
    const point = knownPoints.find((item) => item.name === name);
    return point ? `${point.name}（${point.patientLocation}）` : name;
  };
  const parts: string[] = [];
  if (pressPoints.length > 0) {
    parts.push(`按揉${pressPoints.map((point) => located(point.name)).join("、")}：${entry.acupressure.method}，${entry.acupressure.dose}。`);
  }
  if (moxibustion) {
    const described = new Set(pressPoints.map((point) => point.name));
    const names = moxibustion.points.map((name) => (described.has(name) ? name : located(name))).join("、");
    parts.push(`也可以艾灸${names}：${moxibustion.method}，${moxibustion.dose}。`);
  }
  parts.push(SOURCE.cautions.acupressure);
  if (moxibustion) parts.push(SOURCE.cautions.moxibustion);
  return parts.join("");
}

/** 运维与测试可见的清单状态（不含任何病例数据）。 */
export function homeAcupointCareStatus() {
  const entries = Object.values(SOURCE.constitutions);
  return {
    mode: homeAcupointCareMode(),
    constitutions: entries.length,
    approved: entries.filter((entry) => entry.adjudicationStatus === "approved").length,
    mappingApproved: SOURCE.natureToConstitution.adjudicationStatus === "approved",
    childrenApproved: SOURCE.children.adjudicationStatus === "approved",
  };
}

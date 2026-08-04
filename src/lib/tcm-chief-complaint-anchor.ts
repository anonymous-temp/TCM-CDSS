import symptomAxisMapJson from "../data/tcm-symptom-axis-map.source.json" with { type: "json" };
import {
  canonicalTcmLocationTerm,
  governedTcmLocationsInText,
  governedTcmTermLabelById,
  governedTreatmentMethodOccurrencesInText,
  governedTreatmentMethodsInText,
  treatmentMethodFamilyId,
} from "./clinical-governance-tables";

/**
 * 主诉主症 → 受控病位锚（确定性，零模型）。
 *
 * ★ 为什么需要这一层 ★
 * 「主诉主症是全案锚点，病位必须包含主症所在部位」这条规则本来就写在 M03 提示词里
 * （diagnosis-prompts.ts「主诉主症是全案锚点」一段），也写在独立临床复核的审计指令里
 * （m03-diagnostic-review.ts「主诉主症锚定审计」一段）。但两处都是**说给模型听的话**：
 * 服务端从未确定性地核对过一次。确定性合同里只有反方向的检查
 * （location_classification_missing：证候文字里写了病位、items 却空着），
 * 没有正方向的检查（主症部位压根没进 items）。
 *
 * 实测后果（甲方 2026-08 复测第 3 例，产后血虚头痛）：病位输出「脾、心、清窍」——
 * 脾来自「神疲乏力」、心来自「心悸」，都是**伴随症状**；主诉「头痛2+月」所在的头部
 * 只以「清窍」这个未受治理的词出现，canonicalTcmLocationTerm 认不出，下游全部看不见。
 * 治法与选方随即跟着伴随症状走，落到归脾汤。
 *
 * ★ 受治理数据一直存在 ★
 * tcm-symptom-axis-map.source.json 就是症状→病位的受治理映射，61 条里却**只有伴随症状**：
 * 「头晕/眩晕/头昏 → liver, brain」在表内，而「头痛」不在。补齐主症词族（见该文件
 * chiefComplaintAnchorFamilyNote）后，主症→病位这条判断才第一次有数据可用。
 *
 * ★ 边界（与该表 usage.chiefComplaintAnchor 一致）★
 * 只做加法：断言主症病位必须出现，绝不删除模型给出的其它病位（肝脾肾等兼及病位照常保留），
 * 不指定病性，不参与证候成立与方名锁定。表里查不到主症时返回空锚——检查整体跳过（fail-open），
 * 因为「词表没收录」不等于「模型写错了」。
 */

type AxisEntry = { terms: string[]; locations: string[]; natures: string[]; chiefComplaintAnchor?: boolean };

/**
 * 只有显式标了 chiefComplaintAnchor 的条目才能用于**断言**病位，这是本层最要紧的边界。
 *
 * 本表 69 条里绝大多数是**证候轴召回**映射（失眠→heart、神疲乏力→spleen、盗汗→heart+kidney…）：
 * 它们回答的是「这个症状常见于哪些脏腑的证候」，属于召回用的先验，**不是**病位的必要条件。
 * 拿它们断言病位会直接判错临床上完全成立的辨证——不寐可辨为肾（心肾不交、肾阴虚），
 * 若因为"入睡困难映射到心、而病位写了肾"就发难，那正是本项目一贯反对的
 * 「用有限关键词表替独立临床复核做语义裁定」。
 *
 * 可断言的只有**部位性主症**：头痛必然涉及头、胃痛必然涉及胃、皮肤瘙痒必然涉及皮肤——
 * 这是解剖必然性，不是证候判断。这一族正是 2026-08-04 补进本表的 8 条
 * （见该文件 chiefComplaintAnchorFamilyNote），它们一律不赋 natures，只定位不定性。
 */
const AXIS_ENTRIES: readonly AxisEntry[] = (symptomAxisMapJson as { entries: AxisEntry[] }).entries
  .filter((entry) => entry.chiefComplaintAnchor === true);

export type ChiefComplaintAnchor = {
  /** 用于锚定的主诉原文（已剥字段标签）。 */
  chiefComplaint: string;
  /** 主诉中命中的受治理症状词。 */
  symptomTerms: string[];
  /** 这些症状词对应的受控病位 ID 闭集。 */
  locationIds: string[];
  /** 病位 ID 的规范中文名，用于修复提示与批注（从受治理词表读取，不在代码里写死）。 */
  locationLabels: string[];
};

const EMPTY_ANCHOR: ChiefComplaintAnchor = {
  chiefComplaint: "",
  symptomTerms: [],
  locationIds: [],
  locationLabels: [],
};

const CHIEF_COMPLAINT_FIELD = /^\s*(?:主诉|chiefComplaint|zhushu)\s*[：:]\s*(.+)$/i;

/**
 * 从接地语料里取主诉。两种传输形态都要认：
 *  - 带字段标签的「主诉：…」行（HIS / 提示词形态）；
 *  - clinicalGroundingText 的首行（该函数把 state.chiefComplaint 放在最前，且不带标签）。
 * 找不到标签行时只取首行，不做全文扫描——全文扫描会把现病史里的伴随症状也当成主症，
 * 那正是本层要修的病（伴随症状喧宾夺主）。
 */
export function chiefComplaintTextFromContext(clinicalContext: string): string {
  const lines = (clinicalContext || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const labeled = line.match(CHIEF_COMPLAINT_FIELD)?.[1];
    if (labeled?.trim()) return labeled.trim();
  }
  const first = lines[0] || "";
  // 序列化 HIS 快照（整行 JSON）不是主诉本身；从中取 zhushu/chiefComplaint 字段。
  if (first.startsWith("{") && first.endsWith("}")) {
    try {
      const parsed = JSON.parse(first) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!/^(?:zhushu|chiefComplaint|主诉)$/i.test(key)) continue;
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch {
      // 非 JSON 行按普通首行处理。
    }
    return "";
  }
  return first;
}

/** 主诉主症的受控病位锚。表内无对应主症时返回空锚（检查跳过）。 */
export function chiefComplaintAnchor(clinicalContext: string): ChiefComplaintAnchor {
  const chiefComplaint = chiefComplaintTextFromContext(clinicalContext);
  if (!chiefComplaint) return EMPTY_ANCHOR;
  const symptomTerms: string[] = [];
  const locationIds = new Set<string>();
  for (const entry of AXIS_ENTRIES) {
    if (entry.locations.length === 0) continue;
    const hit = entry.terms.find((term) => chiefComplaint.includes(term));
    if (!hit) continue;
    symptomTerms.push(hit);
    for (const id of entry.locations) locationIds.add(id);
  }
  if (locationIds.size === 0) return { ...EMPTY_ANCHOR, chiefComplaint };
  const ids = [...locationIds];
  return {
    chiefComplaint,
    symptomTerms,
    locationIds: ids,
    locationLabels: ids.map((id) => governedTcmTermLabelById(id)).filter((label): label is string => Boolean(label)),
  };
}

/** 一条病位条目落到哪些受控病位 ID（认规范名、别名，也认复合表述里内嵌的受控病位）。 */
function governedLocationIdsForItem(item: unknown): string[] {
  const exact = canonicalTcmLocationTerm(item);
  if (exact) return [exact.id];
  return governedTcmLocationsInText(item).map((entry) => entry.id);
}

/**
 * M03 的病位分类是否覆盖了主症锚。
 * 空锚（词表未收录该主症）与空 items（另有 location_classification_missing 负责）都判覆盖，
 * 保证本检查只对「有锚、有病位、却偏偏没有主症部位」这一种形态发火。
 */
export function locationItemsCoverChiefComplaintAnchor(
  items: readonly unknown[],
  anchor: ChiefComplaintAnchor,
): boolean {
  if (anchor.locationIds.length === 0) return true;
  // 空 items 判覆盖：那是「病位辨证整节缺失」，由 location_classification_missing 负责。
  // 本层只对「有锚、有病位、却偏偏没有主症部位」这一种形态发火，两条判据不重叠。
  if (items.length === 0) return true;
  const present = new Set(items.flatMap((item) => governedLocationIdsForItem(item)));
  return anchor.locationIds.some((id) => present.has(id));
}

/** 主症词是否出现在给定文本里（用于「主症必须被某个病机节点承接」的治法锚定检查）。 */
export function textCarriesChiefComplaintSymptom(value: unknown, anchor: ChiefComplaintAnchor): boolean {
  if (anchor.symptomTerms.length === 0) return true;
  const text = typeof value === "string" ? value : "";
  if (!text) return false;
  return anchor.symptomTerms.some((term) => text.includes(term));
}

// ─────────────────────────────────────────────────────────────────────────────
// 主症优先（2026-08-04）
//
// ★ 缺的不是检查，是「主次」这个维度本身 ★
// therapy_method_direction_unbound 只问「这个方向有没有病机节点撑着」。产后头痛例里
// 「安神」确实有节点撑着——病历真有心悸失眠，模型据此建了安神节点，所以那条检查放行是**对的**。
// 问题在于服务端把主症节点与兼症节点当成平权的两个节点：两条治法方向谁在前谁在后、
// 谁决定选方，此前没有任何一层看过。总治法于是写成「补益心脾，益气养血，和络止痛」——
// 兼症方向（补益心脾，来自心悸失眠/神疲）居首，主症方向（和络止痛）垫底，
// recommendedFormulaDirection 随之落到归脾汤（主治心脾两虚之心悸健忘失眠，不是头痛）。
//
// ★ 判据完全由受治理数据派生，不新写任何中文词表 ★
//   1) 谁是主症：tcm-symptom-axis-map 的 chiefComplaintAnchor 词族（与病位锚同一张表）；
//   2) 谁是主症节点：节点的 patientFact 逐字带主症词。**只认 patientFact，不认
//      syndromeEvidence**——实测模型会把主诉整句复制进兼症节点的 syndromeEvidence
//      （本例 P2 的 syndromeEvidence 就是「产后2月余，头痛反复发作1月」），
//      按两个字段取并集会把每个节点都判成主症节点，判据整体失效；
//   3) 治法方向的身份与族层级：GB/T 16751.3 的 standardNumber（treatmentMethodFamilyId），
//      与既有绑定检查同一口径；
//   4) 「居首」按**句序**判定，用 governedTreatmentMethodOccurrencesInText 的偏移量。
//
// ★ 边界：只判主次，不判对错 ★
// 兼症方向照常保留在总治法里（甲方原话「安神是次要的」，不是「安神不该有」）。
// 缺任一环（词表未收录主症、无主症节点、无兼症节点、任一侧无受治理治法命中、
// 总治法里两侧方向没有同时出现）一律 fail-open 跳过——「判不了」不等于「判错了」。
// ─────────────────────────────────────────────────────────────────────────────

type PathogenesisNodeLike = {
  patientFact?: unknown;
  syndromeEvidence?: unknown;
  therapyDirection?: unknown;
};

export type ChiefComplaintTherapyPrimacy = {
  /** 判据是否可用；false 时其余字段仅供诊断，不得据以判违规。 */
  applicable: boolean;
  /** 兼症治法方向在总治法中居首（主症方向被挤到其后）。 */
  secondaryLeads: boolean;
  /** 主症节点治法方向命中的受治理治法族。 */
  chiefFamilies: string[];
  /** 仅由兼症节点带来的治法族。 */
  secondaryOnlyFamilies: string[];
  /** 主症节点治法方向的受治理规范名（供修复提示逐字引用）。 */
  chiefMethodNames: string[];
  /** 总治法中居首的受治理治法规范名。 */
  leadingMethodName: string;
};

const EMPTY_PRIMACY: ChiefComplaintTherapyPrimacy = {
  applicable: false,
  secondaryLeads: false,
  chiefFamilies: [],
  secondaryOnlyFamilies: [],
  chiefMethodNames: [],
  leadingMethodName: "",
};

function therapyFamilySet(nodes: readonly PathogenesisNodeLike[]): { families: Set<string>; names: string[] } {
  const families = new Set<string>();
  const names: string[] = [];
  for (const node of nodes) {
    for (const entry of governedTreatmentMethodsInText(node.therapyDirection)) {
      families.add(treatmentMethodFamilyId(entry));
      if (!names.includes(entry.canonical)) names.push(entry.canonical);
    }
  }
  return { families, names };
}

/**
 * 总治法是否让主症方向居首。判据可用性与结论一并返回，调用方只在 applicable 时下结论。
 */
export function chiefComplaintTherapyPrimacy(
  chain: readonly PathogenesisNodeLike[],
  overallMethod: unknown,
  anchor: ChiefComplaintAnchor,
): ChiefComplaintTherapyPrimacy {
  if (anchor.symptomTerms.length === 0 || chain.length < 2) return EMPTY_PRIMACY;
  const chiefNodes = chain.filter((node) => textCarriesChiefComplaintSymptom(node.patientFact, anchor));
  const secondaryNodes = chain.filter((node) => !chiefNodes.includes(node));
  if (chiefNodes.length === 0 || secondaryNodes.length === 0) return EMPTY_PRIMACY;
  const chief = therapyFamilySet(chiefNodes);
  const secondary = therapyFamilySet(secondaryNodes);
  const secondaryOnly = [...secondary.families].filter((family) => !chief.families.has(family));
  if (chief.families.size === 0 || secondaryOnly.length === 0) return EMPTY_PRIMACY;

  const occurrences = governedTreatmentMethodOccurrencesInText(overallMethod)
    .map((hit) => ({ name: hit.entry.canonical, family: treatmentMethodFamilyId(hit.entry) }));
  const leading = occurrences[0];
  // 总治法里主症方向根本没出现，属于「主症无人负责」，由 therapy_chief_symptom_unaddressed
  // 与绑定检查各自负责；本判据只处理「两边都在、次序反了」这一种形态。
  const carriesChief = occurrences.some((hit) => chief.families.has(hit.family));
  const carriesSecondaryOnly = occurrences.some((hit) => secondaryOnly.includes(hit.family));
  if (!leading || !carriesChief || !carriesSecondaryOnly) return EMPTY_PRIMACY;
  return {
    applicable: true,
    secondaryLeads: !chief.families.has(leading.family),
    chiefFamilies: [...chief.families],
    secondaryOnlyFamilies: secondaryOnly,
    chiefMethodNames: chief.names,
    leadingMethodName: leading.name,
  };
}

import symptomAxisMapJson from "../data/tcm-symptom-axis-map.source.json" with { type: "json" };
import { canonicalTcmLocationTerm, governedTcmLocationsInText, governedTcmTermLabelById } from "./clinical-governance-tables";

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

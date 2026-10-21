/**
 * 医生页面的呈现口径（2026-10-21，用户：「ABC 返回什么字段，我们线上就呈现什么字段」「评测方案里没提到的、不参与测评的，
 * 线上也就都不体现了」「后台接口你先别动」）。
 *
 * 页面保留的内容，两个来源取并集：
 *   · ABC 诊所管家 AI 面板的六块——证型、辨证要点、治法、推荐处方（药味后跟功效）、加减建议、调护建议，外加外治处方；
 *     西医一块是初步诊断与支持依据（调研见 ~/runlogs/r1018/work/r1022/research/abc-format.txt）；
 *   · 甲方验收标准 1.1/1.2 与 10.12 测评八列里逐项打分的内容——红旗、病名与证候及其依据、西医诊断及依据、中医鉴别、
 *     治则治法、病机（病位、病性、总体病机）、选方与配伍、出处与方义、随证加减、中成药推荐、中医外治、健康调护、
 *     随访（复诊时间、观察指标、触发条件）、注意事项、流派一致性（选了流派时），以及追问。
 * 两边都没有的不再上屏：循证文献引用、ICD 编码、西医鉴别、症状群、子病机逐条卡片、待核实信息、分治方向、经典条文原文、
 * 方剂收载核验明细、库存标签、运动/穴位保健/节气调护、处方安全总评、整体状态复评表、生活管理（与调护重复）、
 * 需优先补充、风险复评、辨证充分度评分、质量批注、病例分级徽标。
 *
 * 只改页面呈现：签名载荷、接口出参、HIS 方案与下载报告一字不动。
 */

export type FollowupPlanItem = { label: string; value: string };

// M05 正文里保留上屏的三节：随访方案本身，以及与随访触发条件同属安全的转诊评估、患者须知的红旗预警。
const FOLLOWUP_SECTION_HEADINGS = ["随访管理方案", "转诊评估", "红旗预警"];
const HEADING = /^#{1,6}\s*(.+?)\s*$/;
const LABELED_LINE = /^\*\*([^*：:]{2,16})\*\*\s*[：:]\s*(.+)$/;
const TABLE_ROW = /^\|/;
// 随访方案里的「注意事项」与调护区的注意事项逐字重复，页面只在调护区列一次。
const DUPLICATED_ELSEWHERE = "注意事项";

/**
 * M05 正文里要上屏的随访内容（对应验收「随访建议临床可操作性：复诊时间有明确天数/节点、观察指标具体可测量、
 * 触发条件不模糊」）：「随访管理方案」「转诊评估」「红旗预警」三节的各项。「**标签**：内容」一行拆成标签与内容，
 * 无标签的段落 label 为空。同一份正文里的处方安全总评、整体状态复评表、生活管理（与调护重复）、康复管理不取。
 * 一节都没有时返回空数组，由调用方退回随访安全网。
 */
export function followupPlanItems(markdown: string | undefined): FollowupPlanItem[] {
  if (!markdown) return [];
  const items: FollowupPlanItem[] = [];
  let inside = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading) {
      inside = FOLLOWUP_SECTION_HEADINGS.some((name) => heading[1].startsWith(name));
      continue;
    }
    if (!inside || !line || line.startsWith("<!--") || TABLE_ROW.test(line)) continue;
    const match = LABELED_LINE.exec(line);
    const label = match ? match[1].trim() : "";
    const value = (match ? match[2] : line).replace(/^[-*]\s+/, "").trim();
    if (label === DUPLICATED_ELSEWHERE || !value) continue;
    items.push({ label, value });
  }
  return items;
}

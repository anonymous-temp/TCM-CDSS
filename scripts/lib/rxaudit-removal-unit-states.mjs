// 删除灵犀审方前后逐函数比对用的确定性病例生成器（种子固定，基线与比对两侧共用）。
const REGIMEN = { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日", method: "每日1剂，水煎服，每日分2次服", followUpNode: "完成5剂后复诊" };
const BAD_REGIMEN = { doseCount: "5剂", course: "", method: "水煎服", followUpNode: "" };
const MEDICINE = { type: "中成药", name: "示例中成药", specification: "每袋6g", usageBoundary: "仅作候选复核", course: "3日", positioning: "替代方案",
  correspondingProblem: "口苦", evidence: { evidenceLevel: "instruction", source: "示例说明书" }, relationship: "不默认与饮片联用", riskNote: "复核过敏史与现用药" };
const WESTERN = { ...MEDICINE, type: "西药", name: "阿司匹林肠溶片", specification: "100mg" };
const HERB_SETS = [
  [["黄芪", "15g"], ["茯苓", "12g"]],
  [["甘草", "6g"], ["海藻", "9g"]],
  [["乌头", "3g"], ["半夏", "9g"], ["瓜蒌", "12g"]],
  [["丁香", "3g"], ["郁金", "9g"]],
  [["人参", "9g"], ["五灵脂", "6g"], ["甘草", "6g"], ["甘遂", "1g"]],
  [["白术", null], ["黄芪", ""], ["当归", "剂量待定"]],
  [["甘草", "6g", "炙"], ["黄芪", "", "蜜炙"], ["半夏", "9g", "法"], ["附子", "0g", "制"]],
  [[" ", "3g"], ["", null]],
  [],
  [["细辛", "10g"], ["麻黄", "9g"], ["桂枝", "-3g"]],
  [["黄芪", "500mg"], ["党参", "１５g"], ["茯苓", "3-6g"]],
];
const MARKDOWNS = [
  "",
  ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 黄芪 | 15g |", "| 白术 | |"].join("\n"),
  ["## 候选治疗方案", "| 序号 | 药名 | 剂量 | 煎服 |", "|---|---|---|---|", "| 1 | **甘草** | 6g | 先煎 |", "| 2 | 海藻（洗） | 待医生确认 | |", "| 3 | 提示强度 | 高 | |"].join("\n"),
  "## 方药建议\n无表格，仅文字：黄芪15g、白术10g。",
];
const PATENTS = [[], [MEDICINE], [MEDICINE, WESTERN], [{ type: "中成药", name: "不完整条目" }]];

function herbsOf(set) {
  return set.map(([name, dose, processing = null]) => ({ name, dose, processing, decoctionRequirement: null }));
}

export function buildUnitStates() {
  const states = [];
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  for (const [setIndex, set] of HERB_SETS.entries()) {
    for (const [mdIndex, markdown] of MARKDOWNS.entries()) {
      for (const [patentIndex, patents] of PATENTS.entries()) {
        const second = HERB_SETS[next() % HERB_SETS.length];
        const withSecond = next() % 2 === 0;
        const badRegimen = next() % 5 === 0;
        const structured = next() % 6 !== 0;
        const candidates = [{ herbs: herbsOf(set), decoction: badRegimen ? BAD_REGIMEN : REGIMEN }];
        if (withSecond) candidates.push({ herbs: herbsOf(second), decoction: REGIMEN });
        const state = {
          id: `unit-${setIndex}-${mdIndex}-${patentIndex}`, patient: { sex: "男", age: 46 }, conversation: [],
          prescription: markdown,
          ...(structured ? { reasoningPrescribe: { stage: "prescribe", formula: { candidates, patentAndWestern: patents, modifications: [] } } } : {}),
          ...(next() % 4 === 0 ? { prescriptionRevision: { source: "herb_workbench", candidateIndex: withSecond ? 1 : 0, herbHash: "x", auditedAt: "2026-09-25T00:00:00.000Z",
            auditResult: ["BLOCK", "MANUAL_REVIEW", "NOT_SUBMITTED", "PASS"][next() % 4], highestRiskLevel: ["CRITICAL", "HIGH", undefined, "INFO"][next() % 4] } } : {}),
        };
        for (const candidateIndex of [undefined, 0, 1, 2]) states.push({ label: `${state.id}/${candidateIndex}`, state, candidateIndex });
      }
    }
  }
  return states;
}

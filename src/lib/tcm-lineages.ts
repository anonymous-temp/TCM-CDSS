// 对外发布的流派档。2026-08-07 由 13 张收敛到 5 张：
// 保留的依据是**线上真正可用的方剂条数**（可建基准 → 能锁进 M04 → 通过自核验），
// 不是流派史地位、也不是藏书量：
//   经方 133 / 温补扶阳 122 / 滋阴丹溪 60 / 温病 30，其余最高 31（攻邪），多数个位数或 0。
// 默认档 unrestricted 实测以时方为主（8 个典型证候的检索短名单里 59% 落在无流派标注的后世方），
// 因此删掉的「时方/验方」档在能力上由默认档覆盖，不是能力缺口。
// 删掉的 8 张（时方验方/脾胃/孟河/岭南/海派/院内优先/攻邪/寒凉）连同其问诊策略一并移除，
// 不留"仍可解析但不对外"的暗档——留着就会变成文档与实现各说各的。
// 带 .ts 后缀：本模块被 test:lineage-governance 以 node --experimental-strip-types 直载，
// 该加载器不解析无后缀说明符（同 evidence-source-validation.ts 的先例）。
import { SAFETY_DEFERENCE_TEXT } from "./cdss-vocab.ts";

export type LineageGroup = "default" | "classic" | "school";

export type LineageCardNature = "academic_lineage" | "source_preference" | "operational";

export type LineageCardStatus = "draft" | "in_review" | "active" | "retired";

export interface LineageGroupDefinition {
  label: string;
  definition: string;
}

export interface LineageProvenance {
  representativePhysicians: string[];
  representativeWorks: string[];
  lineageSummary: string;
}

export interface LineageGovernanceIdentity {
  id: string;
  displayName: string;
}

export interface LineageGovernance {
  schemaVersion: string;
  cardVersion: string;
  status: LineageCardStatus;
  author: LineageGovernanceIdentity;
  reviewedBy: LineageGovernanceIdentity[];
  reviewedAt: string;
  effectiveAt: string;
}

export const LINEAGE_GROUP_DEFINITIONS: Readonly<Record<LineageGroup, LineageGroupDefinition>> = {
  default: { label: "默认", definition: "不预设特定学术传统的安全优先入口。" },
  classic: { label: "经典辨治", definition: "以经典辨治体系或方书来源为选择入口，不等同于单一学术流派。" },
  school: { label: "学术流派", definition: "以明确医家、著作和学术传承为依据的诊疗传统。" },
};

export const LINEAGE_SAFETY_OBEDIENCE =
  "流派偏好仅用于组织问诊与辨治思路；急危重风险处置、特殊人群禁忌、药事审方和执业医师复核始终优先。";

const ACTIVE_GOVERNANCE = (cardVersion: string): LineageGovernance => ({
  schemaVersion: "1.0.0",
  cardVersion,
  status: "active",
  author: { id: "tcm-cdss-content-governance", displayName: "中医 CDSS 内容治理组" },
  reviewedBy: [
    { id: "tcm-clinical-safety-review", displayName: "中医临床安全审核角色" },
    { id: "medication-safety-review", displayName: "药事安全审核角色" },
  ],
  reviewedAt: "2026-07-12",
  effectiveAt: "2026-07-12",
});

export interface LineageCard {
  code: string;
  label: string;
  group: LineageGroup;
  cardNature: LineageCardNature;
  provenance: LineageProvenance;
  governance: LineageGovernance;
  safetyObedience: typeof LINEAGE_SAFETY_OBEDIENCE;
  aliases: string[];
  coreTheory: string;
  dxEmphasis: string[];
  formulaStyle: string;
  representativeFormulas: string[];
  herbTendency: string;
  modificationStyle: string;
  applicability: string;
  cautions: string[];
}

export type LineagePatchField =
  | "xianbingshi"
  | "jiwangshi"
  | "allergyHistory"
  | "medicationHistory"
  | "vitalsDetail"
  | "tcmFace"
  | "tcmPulse"
  | "tcmTongue"
  | "tcmDetail"
  | "fuzhuJiancha";

export interface LineageQuestionOption {
  label: string;
  answer: string;
  patch?: Partial<Record<LineagePatchField, string>>;
  guidance?: string;
}

export interface LineageQuestionTemplate {
  id: string;
  question: string;
  reason: string;
  fields: LineagePatchField[];
  options: LineageQuestionOption[];
  stage?: "followup" | "prescription";
}

export interface LineageQuestionStrategy {
  lineageCode: string;
  label: string;
  inquiryFocus: string[];
  syndromeAnchors: string[];
  contraindicationBoundaries: string[];
  templates: LineageQuestionTemplate[];
}

export const LINEAGE_CARDS: readonly LineageCard[] = [
  {
    code: "unrestricted",
    label: "不限定：循证安全优先",
    group: "default",
    cardNature: "operational",
    provenance: {
      representativePhysicians: [],
      representativeWorks: ["《中华人民共和国药典》", "国家及本机构现行诊疗、药事与审方规则"],
      lineageSummary: "不主张特定医家传承，以患者事实、可核查依据和药事安全要求作为默认工作路径。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["", "不限定", "循证安全优先"],
    coreTheory: "不预设流派，以患者事实、急危重风险处置、指南/药典/院内规则和审方结果优先。",
    dxEmphasis: ["病证依据匹配", "急危重风险处置", "依据可核查"],
    formulaStyle: "根据证候、病机和安全边界选择方药，不为贴合流派强行联想代表方。",
    representativeFormulas: [],
    herbTendency: "随证取舍，避免倾向性过强。",
    modificationStyle: "按主证、兼证、舌脉和安全复核加减。",
    applicability: "默认选项，适用于证据尚未明显指向某一诊疗传统的病例。",
    cautions: ["任何处方候选均需医生复核，不替代执业医师诊疗决策。"],
  },
  {
    code: "classical-formula",
    label: "经方思路",
    group: "classic",
    cardNature: "source_preference",
    provenance: {
      representativePhysicians: ["张仲景"],
      representativeWorks: ["《伤寒论》", "《金匮要略》"],
      lineageSummary: "源于仲景学术体系，以六经辨证和方证对应组织经典方剂的临床运用。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["经方", "经方思路", "经典方证", "经典方证对应"],
    coreTheory: "重视方证对应与六经/病位病性线索，先核对方证眼目，再考虑加减。",
    dxEmphasis: ["方证对应", "寒热虚实", "表里传变"],
    formulaStyle: "优先说明代表方证是否吻合，不吻合时不得套用经方名。",
    representativeFormulas: ["桂枝汤", "小柴胡汤", "半夏泻心汤", "苓桂术甘汤"],
    herbTendency: "药味精炼，重配伍结构与剂量比例。",
    modificationStyle: "小幅加减，强调保留主方结构。",
    applicability: "症状组合、舌脉和病势与经典方证高度吻合时适用。",
    cautions: ["不得把代表方未经证型核对直接转为剂量级候选处方。"],
  },
  {
    code: "warm-disease",
    label: "温病思路",
    group: "classic",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["叶天士", "薛生白", "吴鞠通", "王孟英"],
      representativeWorks: ["《温热论》", "《湿热病篇》", "《温病条辨》", "《温热经纬》"],
      lineageSummary: "明清温病学由多代医家发展成体系，以卫气营血和三焦辨证阐释温热、湿热病证。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["温病", "卫气营血", "三焦辨证"],
    coreTheory: "重视卫气营血、三焦辨证和湿热/热毒传变层次。",
    dxEmphasis: ["卫气营血", "三焦", "湿热热毒"],
    formulaStyle: "先辨热势、湿热、气营血分层，再定清解、透泄、养阴等法。",
    representativeFormulas: ["银翘散", "桑菊饮", "白虎汤", "三仁汤"],
    herbTendency: "轻清透达、清热化湿或养阴护津。",
    modificationStyle: "按热势、湿重、津伤和传变层次加减。",
    applicability: "发热、咽痛、咳嗽、湿热、暑湿或热病传变线索明确时适用。",
    cautions: ["寒凉清解需核对虚寒、阳虚和脾胃受损风险。"],
  },
  {
    code: "nourish-yin-danxi",
    label: "滋阴/丹溪思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["朱震亨"],
      representativeWorks: ["《格致余论》", "《丹溪心法》"],
      lineageSummary: "金元朱震亨以阳常有余、阴常不足及相火论为核心，发展滋阴降火并兼顾痰郁的辨治传统。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["滋阴", "丹溪", "朱丹溪", "相火", "阴虚"],
    coreTheory: "重视阴虚、相火、痰郁和清养并重。",
    dxEmphasis: ["阴虚", "相火", "痰郁"],
    formulaStyle: "以滋阴降火、清热化痰、调畅气机为常用方向。",
    representativeFormulas: ["知柏地黄丸", "大补阴丸", "二陈汤合越鞠丸", "滋阴降火汤"],
    herbTendency: "清养结合，避免纯温补助火。",
    modificationStyle: "按潮热盗汗、口干、舌红少苔、痰郁加减。",
    applicability: "阴虚火旺、痰郁互结或久病伤阴证据明确时适用。",
    cautions: ["滋腻碍胃、寒凉伤中风险需提示医生复核。"],
  },
  {
    code: "warm-tonify-yang",
    label: "温补/扶阳思路",
    group: "school",
    cardNature: "source_preference",
    provenance: {
      representativePhysicians: ["张景岳", "郑钦安"],
      representativeWorks: ["《景岳全书》", "《医理真传》", "《医法圆通》"],
      lineageSummary: "综合温补与扶阳传统形成的治法偏好，内部传承并不单一，使用前必须先确认阳虚寒证。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["温补", "扶阳", "温阳", "火神"],
    coreTheory: "仅在阳虚寒证证据充分时强调温阳扶正。",
    dxEmphasis: ["阳虚", "寒证", "虚寒夹湿"],
    formulaStyle: "以温阳散寒、补火助阳、扶正化湿为常用方向。",
    representativeFormulas: ["附子理中汤", "真武汤", "四逆汤", "金匮肾气丸"],
    herbTendency: "偏温热扶正，需严格核对热象和毒性药风险。",
    modificationStyle: "按畏寒肢冷、便溏、舌淡胖、脉沉迟加减。",
    applicability: "阳虚寒象明确且无明显热毒、阴虚火旺或红旗风险时适用。",
    cautions: ["含附子等毒性或强温药时必须遵守审方、炮制和剂量边界。"],
  },
];

export const LINEAGE_OPTIONS = LINEAGE_CARDS.map(({ code, label, group }) => ({ value: code, label, group }));

const defaultTemplate = (
  lineageCode: string,
  label: string,
  inquiryFocus: string[],
  syndromeAnchors: string[],
  contraindicationBoundaries: string[],
  templates: LineageQuestionTemplate[],
): LineageQuestionStrategy => ({
  lineageCode,
  label,
  inquiryFocus,
  syndromeAnchors,
  contraindicationBoundaries,
  templates,
});

export const LINEAGE_QUESTION_STRATEGIES: Record<string, LineageQuestionStrategy> = {
  unrestricted: defaultTemplate(
    "unrestricted",
    "不限定：循证安全优先",
    ["先补齐主诉、舌脉、寒热汗出、饮食二便、睡眠情志", "红旗和特殊人群优先"],
    ["主诉-舌脉-问诊证据一致", "病机链可解释", "安全边界清楚"],
    ["红旗未排除", "已提示过敏/当前用药但细节不清", "孕哺儿童等特殊人群信息影响处方"],
    [
      {
        id: "unrestricted-core",
        question: "请补齐最能改变辨证和处方边界的四诊信息。",
        reason: "不限定流派时，应优先让病证证据和安全边界本身决定后续分支。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "舌脉+问诊齐", answer: "已补齐舌象、脉象、寒热汗出、饮食二便和睡眠情志等关键问诊。", patch: { tcmDetail: "问诊：寒热汗出、饮食二便、睡眠情志已补齐" } },
          { label: "仍缺舌脉", answer: "舌象或脉象仍缺失，暂不进入剂量级候选方药。", guidance: "请先补齐实际舌象与脉象。" },
          { label: "安全优先", answer: "存在红旗或特殊人群/用药安全不确定，先补安全信息再继续。", guidance: "请补充红旗排查、过敏史、当前用药或特殊人群状态。" },
        ],
      },
    ],
  ),
  "classical-formula": defaultTemplate(
    "classical-formula",
    "经方思路",
    ["六经/表里寒热虚实", "方证眼目", "症状组合与病势传变"],
    ["方证主症吻合", "舌脉支持寒热虚实", "兼证不破坏主方结构"],
    ["方证不吻合不得套方", "急症红旗未排除", "孕哺儿童或毒性药风险未核清"],
    [
      {
        id: "classic-six-channel",
        question: "请按经方思路补充六经/方证眼目。",
        reason: "经方处方必须先确认表里、寒热、虚实和方证主症是否吻合。",
        fields: ["tcmDetail", "xianbingshi"],
        options: [
          { label: "少阳线索", answer: "经方问诊：见往来寒热或胸胁苦满、口苦咽干、心烦喜呕等少阳线索。", patch: { tcmDetail: "经方问诊：少阳线索需核实，包括寒热往来、胸胁苦满、口苦咽干、心烦喜呕" } },
          { label: "太阳表证", answer: "经方问诊：见恶风恶寒、汗出或无汗、头项强痛等太阳表证线索。", patch: { tcmDetail: "经方问诊：太阳表证线索需核实，包括恶寒恶风、汗出/无汗、头项强痛" } },
          { label: "方证不稳", answer: "经方问诊：方证眼目尚不稳定，需补充寒热、汗出、胸胁/胃脘、二便和舌脉。", guidance: "请补充能支持或反驳代表方证的症状组合。" },
        ],
      },
      {
        id: "classic-formula-boundary",
        stage: "prescription",
        question: "请确认经方加减是否仍保留主方结构。",
        reason: "经方加减应小幅调整，不能因零散症状破坏核心方证。",
        fields: ["tcmDetail"],
        options: [
          { label: "小幅加减", answer: "加减边界：只围绕兼症小幅加减，主方结构和主治病机基本保留。", patch: { tcmDetail: "经方加减边界：主方结构保留，仅围绕兼症小幅加减" } },
          { label: "需换方", answer: "当前症状组合与原拟经方不吻合，应重新辨证选方，不强行套用代表方。", patch: { tcmDetail: "经方边界：方证不吻合时需重新辨证选方" } },
        ],
      },
    ],
  ),
  "warm-disease": defaultTemplate(
    "warm-disease",
    "温病思路",
    ["卫气营血层次", "三焦传变", "湿热/热毒/津伤"],
    ["热势或湿热证据明确", "口渴汗出舌苔支持分层", "传变层次与治法一致"],
    ["虚寒阳虚不宜寒凉清解", "高热寒战或意识异常先排急症", "津伤明显需护津"],
    [
      {
        id: "warm-layer",
        question: "请按温病思路补充热势、湿热和津液状态。",
        reason: "温病辨证需要区分卫气营血/三焦层次，避免清解层级不当。",
        fields: ["tcmDetail", "tcmTongue"],
        options: [
          { label: "卫分偏表", answer: "温病问诊：发热恶风、咽痛咳嗽、口微渴等卫分偏表线索。", patch: { tcmDetail: "温病问诊：卫分偏表线索需核实，如发热恶风、咽痛咳嗽、口微渴" } },
          { label: "湿热偏重", answer: "温病问诊：胸闷脘痞、身重困倦、苔腻、便黏或小便黄等湿热线索。", patch: { tcmDetail: "温病问诊：湿热线索需核实，如胸闷脘痞、身重困倦、苔腻、便黏、小便黄" } },
          { label: "津伤热盛", answer: "温病问诊：高热、口渴喜冷饮、汗出、舌红苔黄燥等气分热盛或津伤线索。", patch: { tcmDetail: "温病问诊：热盛津伤线索需核实，如高热口渴、汗出、舌红苔黄燥" } },
        ],
      },
    ],
  ),
  "nourish-yin-danxi": defaultTemplate(
    "nourish-yin-danxi",
    "滋阴/丹溪思路",
    ["阴虚火旺", "相火妄动", "痰郁互结"],
    ["口干潮热盗汗", "舌红少苔或脉细数", "痰郁与情志互结"],
    ["脾虚便溏慎滋腻", "虚寒阳虚不宜寒凉滋阴", "实热毒盛需另辨"],
    [
      {
        id: "danxi-yin-fire",
        question: "请补充阴虚、相火和痰郁线索。",
        reason: "滋阴/丹溪思路需要确认阴虚火旺还是痰郁气结，避免滋腻或寒凉不当。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "阴虚火旺", answer: "丹溪问诊：潮热盗汗、五心烦热、口干咽燥、舌红少苔、脉细数线索已补问。", patch: { tcmDetail: "丹溪问诊：潮热盗汗、五心烦热、口干咽燥等阴虚火旺线索已补问" } },
          { label: "痰郁互结", answer: "丹溪问诊：胸闷痰多、情志郁结、口黏、苔腻等痰郁线索已补问。", patch: { tcmDetail: "丹溪问诊：胸闷痰多、情志郁结、口黏苔腻等痰郁线索已补问" } },
          { label: "脾胃不耐", answer: "存在纳差便溏或脘痞，滋腻药需谨慎并顾护脾胃。", patch: { tcmDetail: "滋阴边界：纳差便溏或脘痞时需顾护脾胃，慎用滋腻" } },
        ],
      },
    ],
  ),
  "warm-tonify-yang": defaultTemplate(
    "warm-tonify-yang",
    "温补/扶阳思路",
    ["畏寒肢冷", "便溏清长", "舌淡胖脉沉迟"],
    ["阳虚寒象充分", "无明显热毒/阴虚火旺", "温热药安全可控"],
    ["热象未排除不得扶阳", "附子等毒性药必须审方", "高血压心律异常需谨慎"],
    [
      {
        id: "yang-cold-proof",
        question: "请确认阳虚寒证是否充分，并排除明显热象。",
        reason: "温补/扶阳只应在寒证证据充分时使用，热象或红旗未排除时不能硬套。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "阳虚寒象", answer: "扶阳问诊：畏寒肢冷、喜热饮、便溏、小便清长、舌淡胖、脉沉迟等阳虚寒象已补问。", patch: { tcmDetail: "扶阳问诊：畏寒肢冷、喜热饮、便溏、小便清长等阳虚寒象已补问" } },
          { label: "有热象", answer: "存在口苦口渴、便秘尿黄、舌红苔黄或烦热等热象，暂不按扶阳思路出方。", patch: { tcmDetail: "扶阳禁忌边界：存在热象时暂不按扶阳思路出方" } },
          { label: "毒性药复核", answer: "若涉及附子等温热峻烈药，需医生/药师复核炮制、剂量、煎服法和禁忌。", patch: { tcmDetail: "扶阳安全边界：附子等毒性或峻烈药需审方复核炮制剂量煎服法" } },
        ],
      },
    ],
  ),
};

export function resolveLineageCode(raw?: string): string {
  const text = (raw || "").trim();
  if (!text) return "unrestricted";
  const exact = LINEAGE_CARDS.find((card) =>
    card.code === text ||
    card.label === text ||
    card.aliases.some((alias) => alias && alias === text)
  );
  if (exact) return exact.code;

  const normalized = text.toLowerCase();
  const fuzzy = LINEAGE_CARDS.find((card) =>
    card.aliases.some((alias) => alias && normalized.includes(alias.toLowerCase())) ||
    normalized.includes(card.label.toLowerCase())
  );
  if (fuzzy) return fuzzy.code;

  if (/温病|卫气营血|三焦/.test(text)) return "warm-disease";
  if (/温补|扶阳|温阳/.test(text)) return "warm-tonify-yang";
  if (/滋阴|丹溪|相火/.test(text)) return "nourish-yin-danxi";
  if (/经方|方证/.test(text)) return "classical-formula";
  // 已下线的流派（时方验方/脾胃/孟河/岭南/海派/院内优先/攻邪/寒凉）在此不做映射，
  // 落到默认档。**不要**在这里返回一个 LINEAGE_CARDS 里已经没有的 code——
  // getLineageCard 会静默兜回第 0 张卡，于是"归一结果"和"实际生效的卡"从此不是同一个东西。
  return "unrestricted";
}

export function getLineageCard(codeOrLegacy?: string): LineageCard {
  const code = resolveLineageCode(codeOrLegacy);
  return LINEAGE_CARDS.find((card) => card.code === code) || LINEAGE_CARDS[0];
}

export function lineageLabel(codeOrLegacy?: string): string {
  return getLineageCard(codeOrLegacy).label;
}

export function getLineageQuestionStrategy(codeOrLegacy?: string): LineageQuestionStrategy {
  const card = getLineageCard(codeOrLegacy);
  return LINEAGE_QUESTION_STRATEGIES[card.code] || LINEAGE_QUESTION_STRATEGIES.unrestricted;
}

/**
 * 流派适配记录的「可展示」判据——Markdown 摘要、医生页面、HIS 方案三个出口共用的唯一实现
 * （甲方基线 §10.2 要求报告说明流派特征；同一判据两处各写各的是本仓库头号缺陷形状，故收敛于此）。
 *
 * 返回 null 表示三个出口都不出现该段：未选具体流派（unrestricted）、模型未产出、
 * 或产出内容为空壳（无适配说明且无受影响决策）。safetyBoundary 永不为空——
 * 模型没写就用 SAFETY_DEFERENCE_TEXT 固定词条，流派段永远带着安全让位声明出现。
 */
export interface LineageAdaptationDisplay {
  label: string;
  applicability: "适用" | "部分适用" | "不适用";
  reason?: string;
  influencedDecisions: Array<{ aspect: string; detail: string }>;
  alternativeDirection?: string;
  safetyBoundary: string;
}

export function displayableLineageAdaptation(adaptation: unknown): LineageAdaptationDisplay | null {
  if (!adaptation || typeof adaptation !== "object") return null;
  const record = adaptation as Record<string, unknown>;
  const lineageCode = typeof record.lineageCode === "string" ? record.lineageCode.trim() : "";
  if (!lineageCode || lineageCode === "unrestricted") return null;
  const label = typeof record.label === "string" && record.label.trim()
    ? record.label.trim()
    : lineageLabel(lineageCode);
  if (!label) return null;
  const reason = typeof record.applicabilityReason === "string" ? record.applicabilityReason.trim() : "";
  const influencedDecisions = (Array.isArray(record.influencedDecisions) ? record.influencedDecisions : [])
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const aspect = typeof (item as Record<string, unknown>).aspect === "string"
        ? ((item as Record<string, unknown>).aspect as string).trim()
        : "";
      const detail = typeof (item as Record<string, unknown>).detail === "string"
        ? ((item as Record<string, unknown>).detail as string).trim()
        : "";
      return aspect && detail ? [{ aspect, detail }] : [];
    });
  if (!reason && influencedDecisions.length === 0) return null;
  const applicable = record.applicable === "applicable"
    ? "适用"
    : record.applicable === "not-applicable"
      ? "不适用"
      : "部分适用";
  const alternativeDirection = typeof record.alternativeDirection === "string" && record.alternativeDirection.trim()
    ? record.alternativeDirection.trim()
    : undefined;
  const safetyDeference = typeof record.safetyDeference === "string" ? record.safetyDeference.trim() : "";
  return {
    label,
    applicability: applicable,
    reason: reason || undefined,
    influencedDecisions,
    alternativeDirection: applicable === "不适用" ? alternativeDirection : undefined,
    safetyBoundary: safetyDeference || SAFETY_DEFERENCE_TEXT,
  };
}

export type LineageGroup = "default" | "classic" | "school" | "regional" | "institutional";

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
  regional: { label: "地域医派", definition: "在特定地域形成并延续的综合诊疗传统。" },
  institutional: { label: "机构策略", definition: "面向本机构目录、药事和工作流的运营策略，不属于教材学术流派。" },
};

export const LINEAGE_SAFETY_OBEDIENCE =
  "流派偏好仅用于组织问诊与辨治思路，必须服从患者证据、红旗门控、特殊人群禁忌、药事审方和执业医师复核。";

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
      lineageSummary: "不主张特定医家传承，以可核查证据和临床安全门控作为默认工作路径。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["", "不限定", "循证安全优先"],
    coreTheory: "不预设流派，以患者证据、红旗门控、指南/药典/院内规则和审方结果优先。",
    dxEmphasis: ["病证证据匹配", "安全门控", "证据可核查"],
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
    code: "empirical-formula",
    label: "时方/验方思路",
    group: "classic",
    cardNature: "source_preference",
    provenance: {
      representativePhysicians: [],
      representativeWorks: ["历代方书与公开医案", "经本机构审核的经验方或院内方案"],
      lineageSummary: "这是按方剂来源和临床可操作性形成的选方偏好，不对应单一医家或教材学术流派。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["时方", "验方", "时方/验方", "临床经验方"],
    coreTheory: "重视辨证加减、临床经验方和院内常用方案的可操作性。",
    dxEmphasis: ["主症分层", "兼证加减", "处方实用性"],
    formulaStyle: "可选用时方、经验方或院内常用方案，但必须解释证候匹配与安全边界。",
    representativeFormulas: ["归脾汤", "逍遥散", "温胆汤", "天麻钩藤饮"],
    herbTendency: "兼顾主病主证与症状改善。",
    modificationStyle: "围绕主症、兼症和舌脉进行分层加减。",
    applicability: "门诊常见慢病、亚急性症状和需要实用方案时适用。",
    cautions: ["经验方不得覆盖红旗、特殊人群和审方风险。"],
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
    code: "spleen-stomach",
    label: "脾胃学派",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["李杲"],
      representativeWorks: ["《脾胃论》", "《内外伤辨惑论》"],
      lineageSummary: "金元李杲立足脾胃内伤与升降失常，形成重视补益中气、升清降浊的学术传统。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["脾胃", "补土", "中焦", "东垣"],
    coreTheory: "重视中焦升降、脾胃运化和顾护胃气。",
    dxEmphasis: ["脾胃升降", "气机", "运化失司"],
    formulaStyle: "以健脾益气、升清降浊、和胃化湿为常用方向。",
    representativeFormulas: ["补中益气汤", "参苓白术散", "香砂六君子汤", "平胃散"],
    herbTendency: "顾护胃气，避免攻伐过猛。",
    modificationStyle: "围绕纳呆、腹胀、便溏、乏力、湿浊加减。",
    applicability: "脾胃虚弱、中焦湿阻、气机升降失常证据明确时适用。",
    cautions: ["滋腻、温燥或升提药需结合舌苔、热象和血压等复核。"],
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
  {
    code: "menghe",
    label: "孟河医派",
    group: "regional",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["费伯雄", "马培之", "巢崇山", "丁甘仁"],
      representativeWorks: ["《医醇賸义》", "《马培之医案》", "《丁甘仁医案》"],
      lineageSummary: "发端于江苏孟河并经费、马、巢、丁等医家传承，以平正和缓、兼收并蓄见长。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["孟河", "孟河医派", "轻灵平正"],
    coreTheory: "重视平正轻灵、和缓调治与兼顾体质。",
    dxEmphasis: ["体质", "虚实夹杂", "和缓调治"],
    formulaStyle: "处方平正，重视顾护正气和长期可随访性。",
    representativeFormulas: ["香砂六君子汤", "逍遥散", "归脾汤", "二陈汤"],
    herbTendency: "药性平和、层次清楚。",
    modificationStyle: "小步调整，避免大寒大热大攻大补。",
    applicability: "慢病、虚实夹杂、体质偏弱或需长期调治时适用。",
    cautions: ["和缓不等于忽视急症；红旗和强风险仍优先处理。"],
  },
  {
    code: "lingnan",
    label: "岭南医派",
    group: "regional",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["葛洪", "何梦瑶", "罗元恺"],
      representativeWorks: ["《肘后备急方》", "《医碥》", "《岭南卫生方》"],
      lineageSummary: "岭南医家在湿热暑湿环境与地方药物经验中逐步形成重视湿热、脾胃和地域体质的传统。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["岭南", "岭南医派", "湿热", "暑湿"],
    coreTheory: "重视湿热、暑湿、地域体质与轻清化湿。",
    dxEmphasis: ["湿热", "暑湿", "脾胃湿困"],
    formulaStyle: "以清热化湿、醒脾和中、轻清宣化为常用方向。",
    representativeFormulas: ["三仁汤", "藿朴夏苓汤", "甘露消毒丹", "藿香正气散"],
    herbTendency: "芳香化湿、清热利湿并顾护中焦。",
    modificationStyle: "按湿重热重、胸闷纳呆、苔腻和二便变化加减。",
    applicability: "湿热、暑湿、苔腻、困重、纳呆等线索明确时适用。",
    cautions: ["芳香化湿、苦寒清热均需注意津液和脾胃承受度。"],
  },
  {
    code: "haipai",
    label: "海派中医",
    group: "regional",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["丁甘仁", "张聿青", "陆渊雷"],
      representativeWorks: ["《丁甘仁医案》", "《张聿青医案》", "《陆氏论医集》"],
      lineageSummary: "近现代上海汇聚多地域传承并发展出兼容各家、病证结合和中西参证的海派中医学术生态。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["海派", "海派中医", "中西参证"],
    coreTheory: "重视中西参证、病证结合和处方实用性。",
    dxEmphasis: ["病证结合", "检查指标", "院内协同"],
    formulaStyle: "中医证候与现代医学风险并列呈现，强调复核与协同治疗。",
    representativeFormulas: ["天麻钩藤饮", "血府逐瘀汤", "半夏白术天麻汤", "丹参饮"],
    herbTendency: "结合症状、指标与安全审方调整。",
    modificationStyle: "围绕检查异常、慢病共病和药物联用风险加减。",
    applicability: "有明确现代医学诊断、检查指标或共病用药时适用。",
    cautions: ["不得用中医处方掩盖需要专科诊治或急诊处理的现代医学风险。"],
  },
  {
    code: "institution-first",
    label: "院内方案优先",
    group: "institutional",
    cardNature: "operational",
    provenance: {
      representativePhysicians: [],
      representativeWorks: ["本机构现行诊疗方案", "本机构药品目录、煎服规范与审方规则"],
      lineageSummary: "这是随部署机构更新的运营策略，不是历史医派，也不得据此推定任何教材学术传承。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["院内", "院内方案", "院内方案优先", "本院常用方案"],
    coreTheory: "同等安全与证据条件下优先参考院内常用方案和药事规则。",
    dxEmphasis: ["院内规范", "药事规则", "可落地性"],
    formulaStyle: "优先选择院内可用、可审方、可随访的候选方向。",
    representativeFormulas: [],
    herbTendency: "匹配本院目录和审方规则。",
    modificationStyle: "围绕院内可供药味、煎服标准和复诊路径调整。",
    applicability: "HIS 集成、院内药房和标准化写回场景适用。",
    cautions: ["院内便利性不能覆盖病证不匹配或安全禁忌。"],
  },
  {
    code: "gongxie",
    label: "攻邪思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["张从正"],
      representativeWorks: ["《儒门事亲》"],
      lineageSummary: "金元张从正强调病由邪生与汗、吐、下攻邪法，后世扩展为审证祛邪的学术思路。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["攻邪", "攻下", "祛邪", "急则治标"],
    coreTheory: "邪实证据明确时重视祛邪、通下、化瘀、清解等治标路径。",
    dxEmphasis: ["邪实", "痰瘀食积", "壅滞闭阻"],
    formulaStyle: "先辨邪实性质与正气承受度，再考虑攻邪强度。",
    representativeFormulas: ["大承气汤", "桃核承气汤", "抵当汤", "礞石滚痰丸"],
    herbTendency: "偏攻逐、通降或破瘀，必须严守适应证。",
    modificationStyle: "按邪实程度、腹证、二便、舌脉和体质调整力度。",
    applicability: "实邪壅滞、痰瘀食积或闭阻证据明确且无虚脱/孕哺等禁忌时适用。",
    cautions: ["过度攻下可能伤正；孕哺、老人、儿童、虚弱和急腹症风险需优先排除。"],
  },
  {
    code: "hanliang",
    label: "寒凉思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["刘完素"],
      representativeWorks: ["《素问玄机原病式》", "《黄帝素问宣明论方》"],
      lineageSummary: "金元刘完素以火热病机阐发寒凉清解治法，形成河间学派的重要学术传统。",
    },
    governance: ACTIVE_GOVERNANCE("1.0.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["寒凉", "清热", "清热解毒", "清热凉血"],
    coreTheory: "热毒、实热或营血热象明确时重视清热、泻火、凉血、解毒。",
    dxEmphasis: ["实热", "热毒", "营血热", "湿热"],
    formulaStyle: "先辨热在气分、营血、脏腑或湿热，再定清解层次。",
    representativeFormulas: ["黄连解毒汤", "白虎汤", "清营汤", "龙胆泻肝汤"],
    herbTendency: "偏寒凉清解，需核对脾胃、阳虚和津液状态。",
    modificationStyle: "按热势、口渴、便秘、小便黄、舌红苔黄等加减。",
    applicability: "实热、热毒、湿热或营血热证据明确时适用。",
    cautions: ["寒凉太过可能伤中败胃；虚寒、阳虚、腹泻和儿童老人需谨慎。"],
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
  "empirical-formula": defaultTemplate(
    "empirical-formula",
    "时方/验方思路",
    ["主症分层", "兼症加减", "门诊可操作性"],
    ["主病主证明确", "兼症与加减动作一一对应", "安全复核可执行"],
    ["经验方不得覆盖安全门控", "无证候锚点不得凭经验出方", "药味过多需说明取舍"],
    [
      {
        id: "empirical-main-symptom",
        question: "请补充主症、兼症和最需要改善的目标。",
        reason: "时方/验方强调可操作性，必须知道主症优先级和随症加减目标。",
        fields: ["xianbingshi", "tcmDetail"],
        options: [
          { label: "主症明确", answer: "主症优先级已明确，兼症与加减目标已补充。", patch: { xianbingshi: "现病史补充：主症优先级和兼症加减目标已明确" } },
          { label: "症状分散", answer: "症状分散，需先明确最困扰主症、伴随症状和治疗目标。", guidance: "请补充主症轻重、持续时间和最希望改善的问题。" },
          { label: "安全待核", answer: "经验方使用前需先核对过敏史、当前用药和特殊人群状态。", guidance: "请补全处方前安全信息。" },
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
  "spleen-stomach": defaultTemplate(
    "spleen-stomach",
    "脾胃学派",
    ["纳呆腹胀", "大便性状", "中焦升降与湿浊"],
    ["纳运失常", "便溏/腹胀/乏力与舌脉对应", "胃气可护"],
    ["实热便秘或急腹症需先排除", "滋腻碍胃/升提药风险需复核", "血压和眩晕等升提边界"],
    [
      {
        id: "spleen-middle-jiao",
        question: "请补充脾胃运化和中焦升降信息。",
        reason: "脾胃学派处方依赖纳食、腹胀、二便、乏力和苔腻等中焦证据。",
        fields: ["tcmDetail"],
        options: [
          { label: "纳呆腹胀", answer: "脾胃问诊：纳差、腹胀、食后加重、嗳气或脘痞情况已补问。", patch: { tcmDetail: "脾胃问诊：纳差、腹胀、食后加重、嗳气脘痞已补问" } },
          { label: "便溏乏力", answer: "脾胃问诊：大便溏薄、乏力少气、肢倦情况已补问。", patch: { tcmDetail: "脾胃问诊：便溏、乏力少气、肢倦已补问" } },
          { label: "湿浊苔腻", answer: "脾胃问诊：口黏、身重、苔腻、小便不利等湿浊线索已补问。", patch: { tcmDetail: "脾胃问诊：口黏身重、苔腻、小便不利等湿浊线索已补问" } },
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
  menghe: defaultTemplate(
    "menghe",
    "孟河医派",
    ["体质强弱", "虚实夹杂", "长期调治耐受性"],
    ["慢病或体弱背景清楚", "主证兼证分层", "方药平正可随访"],
    ["急症不因平和调治延误", "大寒大热大攻大补需避开", "虚弱老人儿童需降风险"],
    [
      {
        id: "menghe-constitution",
        question: "请补充体质、病程和虚实夹杂信息。",
        reason: "孟河医派强调平正轻灵和长期调治，需要确认体质承受度。",
        fields: ["xianbingshi", "tcmDetail"],
        options: [
          { label: "体质偏虚", answer: "孟河问诊：病程较久、体质偏弱、乏力纳差或睡眠情志影响已补问。", patch: { tcmDetail: "孟河问诊：病程、体质偏虚、乏力纳差、睡眠情志影响已补问" } },
          { label: "虚实夹杂", answer: "孟河问诊：主症与兼症虚实夹杂，需小步调整、避免大寒大热大攻大补。", patch: { tcmDetail: "孟河思路：虚实夹杂，宜小步调整，避免大寒大热大攻大补" } },
          { label: "急症优先", answer: "如有急性加重或红旗信号，不按慢病调治路径，先完成急诊/转诊评估。", guidance: "请补充急性加重、红旗排查和处置结果。" },
        ],
      },
    ],
  ),
  lingnan: defaultTemplate(
    "lingnan",
    "岭南医派",
    ["湿热暑湿", "胸闷纳呆", "苔腻与二便"],
    ["湿重热重可区分", "地域湿热体质线索", "芳香化湿与清热边界清楚"],
    ["津伤明显慎芳香苦燥", "虚寒便溏慎苦寒清热", "高热红旗先排急症"],
    [
      {
        id: "lingnan-damp-heat",
        question: "请补充湿热、暑湿和中焦湿困线索。",
        reason: "岭南医派处方需要区分湿重、热重和脾胃承受度。",
        fields: ["tcmDetail", "tcmTongue"],
        options: [
          { label: "湿重", answer: "岭南问诊：身重困倦、胸闷脘痞、纳呆、苔厚腻等湿重线索已补问。", patch: { tcmDetail: "岭南问诊：湿重线索已补问，包括身重困倦、胸闷脘痞、纳呆、苔厚腻" } },
          { label: "热重", answer: "岭南问诊：口苦口渴、小便黄赤、大便黏滞、苔黄腻等湿热热重线索已补问。", patch: { tcmDetail: "岭南问诊：热重线索已补问，包括口苦口渴、小便黄赤、大便黏滞、苔黄腻" } },
          { label: "脾胃偏虚", answer: "岭南边界：若便溏纳差明显，芳香化湿与苦寒清热需顾护中焦。", patch: { tcmDetail: "岭南安全边界：便溏纳差明显时需顾护中焦，慎用苦寒芳香太过" } },
        ],
      },
    ],
  ),
  haipai: defaultTemplate(
    "haipai",
    "海派中医",
    ["病证结合", "检查指标", "共病与当前用药"],
    ["现代医学风险已并行评估", "证候与检查/共病不冲突", "联用风险可复核"],
    ["急诊/专科风险不得被中医处方掩盖", "当前用药不清慎出联用方案", "检查异常需闭环"],
    [
      {
        id: "haipai-integrated",
        question: "请补充现代医学诊断、检查指标和当前用药。",
        reason: "海派中医强调病证结合，必须避免处方掩盖专科风险或联用风险。",
        fields: ["fuzhuJiancha", "medicationHistory", "xianbingshi"],
        options: [
          { label: "检查已补", answer: "海派问诊：相关检查指标、既往诊断和当前处置情况已补充。", patch: { fuzhuJiancha: "海派问诊：相关检查指标、既往诊断和当前处置情况已补充" } },
          { label: "当前用药已核", answer: "海派问诊：当前西药/中成药/保健品名称、剂量、频次已核对。", guidance: "请填写具体药名、剂量、频次后提交。" },
          { label: "需专科排查", answer: "现代医学风险或检查异常尚未闭环，需先完善专科/急诊评估。", patch: { xianbingshi: "海派安全边界：现代医学风险或检查异常需先闭环评估" } },
        ],
      },
    ],
  ),
  "institution-first": defaultTemplate(
    "institution-first",
    "院内方案优先",
    ["院内常用方案匹配", "药房可及性", "审方与写回规则"],
    ["证候匹配院内路径", "药味在院内目录可审", "随访节点清晰"],
    ["院内便利不能覆盖证候不合", "不可审方药味必须明确提示", "高风险必须医生或药师复核"],
    [
      {
        id: "institution-policy",
        stage: "prescription",
        question: "请确认是否需优先匹配院内可用方案和药事规则。",
        reason: "院内方案优先必须与证候、安全审方和药房目录同时匹配。",
        fields: ["fuzhuJiancha", "tcmDetail"],
        options: [
          { label: "院内优先", answer: "院内方案优先：同等证候和安全条件下，优先选择院内目录可供、可审方、可随访的药味。", patch: { tcmDetail: "院内方案优先：同等证候和安全条件下优先院内目录可供、可审方、可随访药味" } },
          { label: "目录待核", answer: "院内药房目录、煎服规范或审方规则待核，暂不标记为可采纳方案。", guidance: "请补充院内目录/药事规则或由药师复核。" },
          { label: "证候优先", answer: "若院内方案与证候不匹配，以证候和安全边界优先，不为便利强行套用院内方。", patch: { tcmDetail: "院内边界：院内便利不能覆盖证候不匹配或安全禁忌" } },
        ],
      },
    ],
  ),
  gongxie: defaultTemplate(
    "gongxie",
    "攻邪思路",
    ["邪实程度", "腹证和二便", "正气承受度"],
    ["实邪壅滞证据明确", "腹部拒按/便秘瘀阻等支持", "无虚脱孕哺等禁忌"],
    ["虚弱老人儿童孕哺慎攻", "急腹症先排外科急症", "过攻伤正风险需提示"],
    [
      {
        id: "gongxie-excess",
        question: "请补充邪实、腹证、二便和正气承受度。",
        reason: "攻邪法风险较高，必须确认邪实证据和禁忌边界。",
        fields: ["tcmDetail", "xianbingshi", "jiwangshi"],
        options: [
          { label: "邪实明确", answer: "攻邪问诊：腹部拒按、便秘或瘀阻、痰壅食积等邪实线索已补问。", patch: { tcmDetail: "攻邪问诊：腹部拒按、便秘瘀阻、痰壅食积等邪实线索已补问" } },
          { label: "正虚慎攻", answer: "存在体虚、老人儿童、孕哺、久病虚弱或脱水风险，暂不按攻邪强法推进。", patch: { jiwangshi: "攻邪禁忌边界：体虚、老人儿童、孕哺、久病虚弱或脱水风险需慎攻" } },
          { label: "急腹症待排", answer: "急腹痛、持续呕吐、便血或腹膜刺激征等急症未排除，先转诊/急诊评估。", patch: { xianbingshi: "攻邪安全边界：急腹症或外科急症未排除时先转诊/急诊评估" } },
        ],
      },
    ],
  ),
  hanliang: defaultTemplate(
    "hanliang",
    "寒凉思路",
    ["实热热毒", "气营血/脏腑热", "脾胃阳气承受度"],
    ["热势、口渴、便秘尿黄与舌脉相合", "无虚寒阳虚反证", "清热层次明确"],
    ["虚寒便溏慎寒凉", "阴液大伤需护津", "高热神昏等先急诊"],
    [
      {
        id: "hanliang-heat-proof",
        question: "请补充实热/热毒证据，并排除虚寒阳虚。",
        reason: "寒凉清解必须有明确热证证据，避免寒凉伤中或掩盖急症。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "实热明显", answer: "寒凉问诊：发热烦渴、口苦口臭、便秘、小便黄赤、舌红苔黄、脉数等实热线索已补问。", patch: { tcmDetail: "寒凉问诊：实热线索已补问，包括发热烦渴、口苦口臭、便秘、小便黄赤、舌红苔黄、脉数" } },
          { label: "虚寒反证", answer: "存在畏寒喜暖、便溏、舌淡胖或脉沉迟等虚寒反证，暂不按寒凉思路出方。", patch: { tcmDetail: "寒凉禁忌边界：虚寒反证存在时暂不按寒凉思路出方" } },
          { label: "高热急症", answer: "高热神昏、寒战、意识改变或严重感染风险未排除，先急诊/转诊评估。", patch: { xianbingshi: "寒凉安全边界：高热神昏、寒战、意识改变或严重感染风险未排除时先急诊/转诊" } },
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

  if (/攻邪|攻下|祛邪/.test(text)) return "gongxie";
  if (/寒凉|清热|泻火|凉血/.test(text)) return "hanliang";
  if (/温病|卫气营血|三焦/.test(text)) return "warm-disease";
  if (/温补|扶阳|温阳/.test(text)) return "warm-tonify-yang";
  if (/脾胃|中焦|东垣/.test(text)) return "spleen-stomach";
  if (/经方|方证/.test(text)) return "classical-formula";
  if (/时方|验方|经验方/.test(text)) return "empirical-formula";
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

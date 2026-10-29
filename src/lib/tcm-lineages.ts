// 对外发布的流派档。2026-08-28 将误合并的「温补/扶阳」拆为两张独立学术流派卡：
// 温补学派以明代薛己、孙一奎、赵献可、张景岳等脾肾命门、水火互济与温养补虚学说为主；
// 扶阳学派以清末郑钦安以来的「阳主阴从、扶阳抑阴」传承为主。两者有理论交集，但人物链、
// 著作链和诊疗侧重不同，不能再由一个 code/别名集合表示。
// 2026-08-07 曾由 13 张收敛到 5 张：
// 保留的依据是**线上真正可用的方剂条数**（可建基准 → 能锁进 M04 → 通过自核验），
// 不是流派史地位、也不是藏书量：
//   经方 133 / 原温补扶阳合并档 122 / 滋阴丹溪 60 / 温病 30，其余最高 31（攻邪），多数个位数或 0。
// 默认档 unrestricted 实测以时方为主（8 个典型证候的检索短名单里 59% 落在无流派标注的后世方），
// 因此删掉的「时方/验方」档在能力上由默认档覆盖，不是能力缺口。
// 删掉的 8 张（时方验方/脾胃/孟河/岭南/海派/院内优先/攻邪/寒凉）连同其问诊策略一并移除，
// 不留"仍可解析但不对外"的暗档——留着就会变成文档与实现各说各的。
// 2026-10-12：五张学派卡逐字段按本地古籍原文与联网教材/综述核对后重写（扶阳卡代表方原先全是仲景/宋代方、
// 丹溪卡四个代表方只有大补阴丸是丹溪方等），每个字段的出处在 src/data/tcm-lineage-card-evidence.source.json；
// 问诊策略的 templates 选项运行时没有消费方（M02 提示词只读 inquiryFocus/syndromeAnchors/contraindicationBoundaries），
// 只订正了措辞，未新增选项。
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

// 审核信息如实（2026-10-12）：此前每张卡都写着「中医临床安全审核角色 / 药事安全审核角色于 2026-07-12 审核」，
// 但从未有人以这两个角色审过（owner 2026-09-29：没有可签字的中医师）。现在写明真实的核对方式：
// 学派卡逐字段按本地古籍原文与联网教材/综述核对，每个字段的出处在 src/data/tcm-lineage-card-evidence.source.json，
// test:lineage-governance 钉住卡面文字与出处记录逐字一致。
const VERIFIED_AT = "2026-10-12";
const VERIFIED_GOVERNANCE = (cardVersion: string): LineageGovernance => ({
  schemaVersion: "1.0.0",
  cardVersion,
  status: "active",
  author: { id: "tcm-cdss-content-governance", displayName: "中医 CDSS 内容治理组" },
  reviewedBy: [
    { id: "evidence-verification-20261012", displayName: "原典与教材逐字段核对（本地古籍与联网来源；无执业医师签字）" },
  ],
  reviewedAt: VERIFIED_AT,
  effectiveAt: VERIFIED_AT,
});

// 默认档是运营入口卡，不主张任何学术出处，没有可逐字段核对的学术内容。
const OPERATIONAL_GOVERNANCE = (cardVersion: string): LineageGovernance => ({
  ...VERIFIED_GOVERNANCE(cardVersion),
  reviewedBy: [
    { id: "content-governance-self-check-20261012", displayName: "内容治理组自查（运营入口卡，不涉学术出处；无执业医师签字）" },
  ],
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
    governance: OPERATIONAL_GOVERNANCE("1.0.1"),
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
      lineageSummary: "源于东汉张仲景《伤寒杂病论》（后分为《伤寒论》《金匮要略》）。狭义经方即仲景书所载方剂；本思路取其“先辨六经病位或杂病病证，再按方证相应选方”的用法。后世研究《伤寒论》的医家合称伤寒学派，与经方思路不是同一概念。",
    },
    governance: VERIFIED_GOVERNANCE("1.1.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["经方", "经方思路", "经典方证", "经典方证对应"],
    coreTheory: "以方证相应为核心：先据脉证辨六经病位与表里寒热虚实，再核对代表方的主症与脉象；证变则方随证变，方证不符不套方，加减不破坏主方结构。",
    dxEmphasis: ["六经分证", "方证相应", "表里寒热虚实", "传变与合病并病"],
    formulaStyle: "优先说明代表方证是否吻合，不吻合时不得套用经方名。",
    representativeFormulas: ["桂枝汤", "小柴胡汤", "半夏泻心汤", "苓桂术甘汤", "白虎汤", "四逆汤"],
    herbTendency: "药味精炼，重配伍结构与药对关系（如桂枝配芍药、柴胡配黄芩、半夏配干姜黄连），不随意拆改主方；剂量不随流派调整，仍按药典执行。",
    modificationStyle: "小幅加减，强调保留主方结构。",
    applicability: "症状组合、舌脉和病势与经典方证高度吻合时适用。",
    cautions: ["不得把代表方未经证型核对直接转为剂量级候选处方。", "原书剂量与煎服法不作为本系统剂量依据，剂量只按药典及安全规则执行。"],
  },
  {
    code: "warm-disease",
    label: "温病思路",
    group: "classic",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["叶天士", "薛生白", "吴鞠通", "王孟英"],
      representativeWorks: ["《温热论》", "《湿热病篇》", "《温病条辨》", "《温热经纬》"],
      lineageSummary: "明清温病学以叶天士的卫气营血辨证和吴鞠通的三焦辨证为纲，薛生白详论湿热，王孟英汇编成《温热经纬》；吴又可《温疫论》为温疫学说先导。",
    },
    governance: VERIFIED_GOVERNANCE("1.1.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["温病", "卫气营血", "三焦辨证"],
    coreTheory: "以卫气营血（叶天士）和三焦（吴鞠通）判断外感热病的传变层次：初起辛凉透邪而非辛温发汗，入营透热转气、入血凉血散血；湿热重在分消宣化，热病重在顾护津液。",
    dxEmphasis: ["卫气营血", "三焦", "湿热/温毒", "察舌验齿辨斑疹", "津液存亡"],
    formulaStyle: "按卫、气、营、血和上、中、下焦分层立法：卫分辛凉轻解，气分清气或分消走泄，营分清营透热，血分凉血散血，湿热以轻开上焦、芳化淡渗为主，后期甘润存津。",
    representativeFormulas: ["银翘散", "桑菊饮", "三仁汤", "白虎汤", "清营汤", "增液汤"],
    herbTendency: "轻清透达、清热化湿或养阴护津。",
    modificationStyle: "按热势、湿重、津伤和传变层次加减。",
    applicability: "以急性外感热病为主：发热（多伴口渴、咽痛、咳嗽，舌红或苔腻）、湿热、暑湿、秋燥或热病传变线索明确时适用；内伤杂病为主者不以本思路为主。",
    cautions: ["寒凉清解需核对虚寒、阳虚和脾胃受损风险；面色白、湿盛者清凉不可过量。", "用白虎汤类方须核对口渴、汗出、脉象：不渴、无汗、脉沉或浮弦细者不宜。", "舌白滑、苔腻湿重时慎用清营、复脉等柔润滋腻之品。", "壮火未衰时不宜用滋阴潜镇（复脉、定风珠一类）；津伤者忌苦寒化燥。"],
  },
  {
    code: "nourish-yin-danxi",
    label: "滋阴/丹溪思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["朱震亨", "戴思恭", "王履", "王纶"],
      representativeWorks: ["《格致余论》", "《局方发挥》", "《金匮钩玄》（戴思恭校补）", "《丹溪心法》（门人辑录）"],
      lineageSummary: "元代朱震亨（丹溪）以「阳有余阴不足」「相火论」为核心，主张滋阴降火；杂病重气、血、痰、郁的辨治，并重视湿热与饮食情欲摄养；经戴思恭、王履等门人及王纶等私淑者传承，形成丹溪学派（又称养阴学派）。",
    },
    governance: VERIFIED_GOVERNANCE("1.1.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["滋阴", "丹溪", "朱丹溪", "相火", "阴虚"],
    coreTheory: "阳有余阴不足，阴气难成易亏；相火易动，煎熬真阴，故以滋阴降火为主；杂病以气、血、痰、郁为纲，兼重湿热；清与养并用，主张节欲、茹淡以养阴，反对以温热药佐补的「温补」。",
    dxEmphasis: ["阴虚火旺", "相火妄动", "气血痰郁", "湿热"],
    formulaStyle: "以黄柏、知母配龟板、熟地黄滋阴降火为主；杂病以四君子补气、四物补血、二陈治痰、越鞠丸解郁为基本四法，另有清肝火（左金丸）、清利湿热（二妙散）、消食和胃（保和丸）等；多作丸剂，常按气虚、血虚选不同汤使送服。",
    representativeFormulas: ["大补阴丸", "越鞠丸", "左金丸", "二妙散", "咳血方"],
    herbTendency: "黄柏、知母泻相火，龟板、熟地黄、白芍滋阴养血；解郁用苍术、香附、川芎、栀子、神曲；化痰以二陈为基础。反对以温热药佐补的「温补」和局方的香燥，但气虚、真阳不足者仍用人参、附子，并非一概寒凉。",
    modificationStyle: "按气血虚实选汤使（气虚以补气药、血虚以补血药送服大补丸）；补阴丸冬加干姜、夏加砂仁；六郁按气、湿、痰、热、血、食郁各加主药，并随季节加减（春加川芎，夏加苦参，秋冬加吴茱萸）；痰多以二陈为基础加减。",
    applicability: "阴虚火旺、相火妄动证据明确（午后潮热、盗汗、口干、脉数），或气、血、痰、湿、热、食诸郁久病不解，或湿热下注、肝火犯胃犯肺时适用；虚寒阳虚、脾虚便溏者不适用。",
    cautions: ["滋腻碍胃、寒凉伤中风险需提示医生复核。", "脾虚便溏、痰湿内阻者慎用滋阴降火；真阳不足、虚寒者不宜单用寒凉滋阴；实热毒盛应先泻其实。"],
  },
  {
    code: "warm-tonify",
    label: "温补学派思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["薛己", "孙一奎", "赵献可", "张景岳", "李中梓"],
      representativeWorks: ["《内科摘要》", "《赤水玄珠》", "《医贯》", "《景岳全书》", "《医宗必读》"],
      lineageSummary: "明代温补学派重视脾肾、命门水火与阴阳互根，治疗以温养补虚、兼顾阴阳互济为主要特色。",
    },
    governance: VERIFIED_GOVERNANCE("2.1.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["温补", "温补学派", "温补派", "肾命学派"],
    coreTheory: "重视脾肾、命门水火与阴阳互根，辨清阴虚、阳虚及先后天亏损后再施温养补虚。",
    dxEmphasis: ["脾肾亏虚", "命门水火", "阴阳互根"],
    formulaStyle: "先辨阴阳与脾肾亏损层次，再选择温阳、滋阴或阴阳互济的补虚方向，不以辛热药多寡代表流派。",
    representativeFormulas: ["补中益气汤", "六味地黄丸", "肾气丸", "壮原汤", "左归丸", "右归丸"],
    herbTendency: "善用甘温之味（如人参、黄芪、白术、熟地等）温养补虚，兼顾阴精与脾胃；附子、肉桂等辛热之品须以人参、熟地等大甘之品相配并先辨热象，避免把所有虚证都等同于阳虚寒证。",
    modificationStyle: "按脾肾、气血精亏损层次及寒热舌脉加减，强调阴阳互济。",
    applicability: "脾肾或气血精亏损证据明确，且阴阳属性与寒热虚实已经辨清时适用。",
    cautions: ["温补不等于一律扶阳或使用附子；热象、阴虚火旺及滋腻碍胃风险必须分别核对。", "不可概补概温：须先辨标本虚实与寒热真假，外感实邪未解、气滞食积或湿热未清时不宜径用壅补；辛热药须与人参、熟地等相配并随脉证增减。"],
  },
  {
    code: "support-yang",
    label: "扶阳学派思路",
    group: "school",
    cardNature: "academic_lineage",
    provenance: {
      representativePhysicians: ["郑钦安", "卢铸之", "吴佩衡", "唐步祺", "范中林", "祝味菊"],
      representativeWorks: ["《医理真传》", "《医法圆通》", "《伤寒恒论》"],
      lineageSummary: "清末四川郑钦安（《医理真传》《医法圆通》《伤寒恒论》）创立的医学流派，亦称扶阳学派、火神派；以阴阳为辨证总纲，视元阳（坎中真阳）为立命之本，须有「阴阳实据」确认阳虚阴盛后，方用扶阳抑阴之法。",
    },
    governance: VERIFIED_GOVERNANCE("1.1.0"),
    safetyObedience: LINEAGE_SAFETY_OBEDIENCE,
    aliases: ["扶阳", "扶阳学派", "扶阳派", "火神", "火神派", "郑钦安"],
    coreTheory: "以元阳（坎中真阳）为人身立命之本，阳虚则阴气上僭；先以「阴阳实据」（神色、声息、口渴、舌、二便、脉）辨明阳虚阴盛及阴盛格阳之假热，方立扶阳抑阴之法；阴虚火旺、实热则另用益阴清热之法，不可通用。",
    dxEmphasis: ["阴阳实据", "阳虚阴盛", "阴盛格阳之真寒假热（阴火）", "六经与上中下三部定位"],
    formulaStyle: "先以「阴阳实据」辨明阳虚阴盛及真假寒热，再按上、中、下三部取方：上焦扶阳多取桂枝类（如姜桂汤、桂枝龙骨牡蛎汤加附子），中焦取理中、建中类，下焦取四逆、白通类；虚阳上浮用潜阳丹、封髓丹一类收纳。各方均自四逆汤一方化裁而出；不得仅凭畏寒等单一表现套用。",
    representativeFormulas: ["潜阳丹", "补坎益离丹", "四逆汤", "白通汤", "附子理中汤", "封髓丹"],
    herbTendency: "以姜、桂、附为主：上焦扶阳多用桂枝，中焦多用干姜、砂仁，下焦多用附子，常以炙甘草相配；潜阳每配砂仁、龟甲，补心阳配肉桂、蛤粉。附子等有毒及温热药材必须服从药典、炮制、剂量、煎服和特殊人群审方边界。",
    modificationStyle: "在四逆汤、理中汤、潜阳丹、封髓丹等基础方上按上中下部位与兼症加减，如痰饮加半夏、茯苓，虚阳上浮加砂仁、肉桂，寒滞肝经加吴茱萸；轻重随病情斟酌，不以附子用量代表扶阳水平。",
    applicability: "「阴阳实据」支持阳虚阴盛（含阴盛格阳之假热），且实热、阴虚火旺已排除时适用；急危重征象先走急症处置。",
    cautions: ["阴虚火旺及实热证忌扶阳（郑氏自述「阴虚一切病证忌温补」）；面赤、咽痛、口疮等「火象」须与阴火逐项鉴别后方可按阳虚处理。", "扶阳偏好不得成为附子等毒性药的准入依据，不以附子用量论扶阳；任何姜桂附候选都必须经过独立药事安全核验。"],
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
    ["六经/表里寒热虚实", "方证主症与或然症", "症状组合与病势传变"],
    ["方证主症吻合", "舌脉支持寒热虚实", "兼证不破坏主方结构"],
    ["方证不吻合不得套方", "急症红旗未排除", "孕哺儿童或毒性药风险未核清"],
    [
      {
        id: "classic-six-channel",
        question: "请按经方思路补充六经/方证眼目。",
        reason: "经方处方必须先确认表里、寒热、虚实和方证主症是否吻合。",
        fields: ["tcmDetail", "xianbingshi"],
        options: [
          { label: "少阳线索", answer: "经方问诊：见往来寒热、胸胁苦满、嘿嘿不欲饮食、心烦喜呕，或口苦、咽干、目眩等少阳线索。", patch: { tcmDetail: "经方问诊：少阳线索需核实，包括往来寒热、胸胁苦满、嘿嘿不欲饮食、心烦喜呕、口苦、咽干、目眩" } },
          { label: "太阳表证", answer: "经方问诊：见恶寒或恶风、发热、头项强痛、身体疼痛，脉浮，汗出或无汗等太阳表证线索。", patch: { tcmDetail: "经方问诊：太阳表证线索需核实，包括恶寒/恶风、发热与否、汗出/无汗、头项强痛、身痛、脉浮" } },
          { label: "方证不稳", answer: "经方问诊：方证主症尚不稳定，需补充寒热、汗出、胸胁/胃脘、二便和舌脉。", guidance: "请补充能支持或反驳代表方证的症状组合。" },
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
    ["恶寒发热与口渴汗出（卫气分界）", "舌质舌苔、神志与斑疹（气营血分）", "脘痞身重、午后身热、二便（湿热及所在三焦）", "口渴尿少便干（津伤）", "咽肿颐肿（温毒）"],
    ["卫分：发热微恶风寒，伴头痛、咽痛或咳嗽、口渴", "气分热盛：不恶寒反恶热，口渴，汗出，舌黄，脉洪大", "湿热：身重、胸闷脘痞、舌白腻或黄腻、午后身热、口渴不欲多饮", "营血分线索：夜热、心烦少寐、舌绛、斑疹隐隐、神志改变（按急症线索处理）", "传变层次与治法一致"],
    ["虚寒阳虚、脾胃虚弱者不宜寒凉清解；面色白、湿盛者清凉不可过量", "高热伴寒战，或神昏、痉厥、斑疹出血等意识与出血征象，先排急症", "舌白滑、苔腻湿重不宜清营、复脉等柔润滋腻之剂", "津伤者慎用苦寒燥烈，宜甘寒养津；白虎汤类须核对口渴、汗出和脉象"],
    [
      {
        id: "warm-layer",
        question: "请按温病思路补充热势、湿热和津液状态。",
        reason: "温病辨证需要区分卫气营血/三焦层次，避免清解层级不当。",
        fields: ["tcmDetail", "tcmTongue"],
        options: [
          { label: "卫分偏表", answer: "温病问诊：发热恶风、咽痛咳嗽、口微渴等卫分偏表线索。", patch: { tcmDetail: "温病问诊：卫分偏表线索需核实，如发热恶风、咽痛咳嗽、口微渴" } },
          { label: "湿热偏重", answer: "温病问诊：胸闷脘痞、身重困倦、苔腻、午后身热、口渴不欲多饮、便黏或小便黄等湿热线索。", patch: { tcmDetail: "温病问诊：湿热线索需核实，如胸闷脘痞、身重困倦、苔腻、午后身热、口渴不欲多饮、便黏、小便黄" } },
          { label: "津伤热盛", answer: "温病问诊：高热、口渴喜冷饮、汗出、舌红苔黄燥等气分热盛线索；或口干咽燥、尿少便干、舌红少津等津伤线索。", patch: { tcmDetail: "温病问诊：热盛或津伤线索需核实，如高热口渴、汗出、舌红苔黄燥，或口干咽燥、尿少便干、舌红少津" } },
        ],
      },
    ],
  ),
  "nourish-yin-danxi": defaultTemplate(
    "nourish-yin-danxi",
    "滋阴/丹溪思路",
    ["阴虚火旺", "相火妄动", "气血痰郁", "湿热"],
    ["口干、午后潮热、盗汗", "舌红少苔，脉数（丹溪书：浮之洪大、沉之空虚）", "胸胁痛、动则喘痰多、嗳酸腹饱等郁证表现，且发病与情志、劳欲相关"],
    ["脾虚便溏、痰湿内阻慎滋腻", "虚寒阳虚不宜寒凉滋阴", "实火（热毒盛）先泻其实，不宜单用滋阴降火"],
    [
      {
        id: "danxi-yin-fire",
        question: "请补充阴虚、相火和气血痰郁线索。",
        reason: "滋阴/丹溪思路需要确认阴虚火旺还是气血痰郁，避免滋腻或寒凉不当。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "阴虚火旺", answer: "丹溪问诊：潮热盗汗、五心烦热、口干咽燥、舌红少苔、脉细数线索已补问。", patch: { tcmDetail: "丹溪问诊：潮热盗汗、五心烦热、口干咽燥等阴虚火旺线索已补问" } },
          { label: "气血痰郁", answer: "丹溪问诊：胸胁痛、痰多、嗳酸腹胀、情志郁结、口黏苔腻等气血痰郁线索已补问。", patch: { tcmDetail: "丹溪问诊：胸胁痛、痰多、嗳酸腹胀、情志郁结、口黏苔腻等气血痰郁线索已补问" } },
          { label: "脾胃不耐", answer: "存在纳差便溏或脘痞，滋腻药需谨慎并顾护脾胃。", patch: { tcmDetail: "滋阴边界：纳差便溏或脘痞时需顾护脾胃，慎用滋腻" } },
        ],
      },
    ],
  ),
  "warm-tonify": defaultTemplate(
    "warm-tonify",
    "温补学派思路",
    ["脾肾与先后天亏损", "阴阳水火偏衰", "气血精亏损层次", "寒热真假（假热、虚阳上浮）与虚人外感"],
    ["虚损证据充分", "阴阳属性已经辨清", "温养与滋填方向和舌脉一致"],
    ["不得把温补等同于一律扶阳", "热象与阴虚火旺需另辨", "滋腻碍胃与温燥伤阴风险需核对", "外感实邪、气滞食积或湿热未清时不宜径用壅补"],
    [
      {
        id: "warm-tonify-deficiency-layer",
        question: "请按温补学派思路辨清脾肾亏损层次及阴阳属性。",
        reason: "温补学派并非只论阳虚；需先区分脾肾、气血精及阴阳水火偏衰，避免把所有虚证都套成扶阳。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse"],
        options: [
          { label: "脾肾阳虚", answer: "温补问诊：已补问畏寒肢冷、饮食二便、腰膝状态及舌淡胖、脉沉迟等脾肾阳虚线索。", patch: { tcmDetail: "温补问诊：脾肾阳虚线索已补问，包括畏寒肢冷、饮食二便、腰膝及舌脉" } },
          { label: "阴精亏损", answer: "温补问诊：已补问口燥咽干、潮热盗汗、腰膝酸软、舌红少苔等阴精亏损线索。", patch: { tcmDetail: "温补问诊：阴精亏损线索已补问，包括口燥、潮热盗汗、腰膝及舌苔" } },
          { label: "脾胃不受补", answer: "存在纳差、脘痞或便溏，补益方向需兼顾脾胃受纳运化，避免温燥或滋腻碍胃。", patch: { tcmDetail: "温补边界：纳差脘痞便溏时需顾护脾胃，避免温燥或滋腻碍胃" } },
        ],
      },
    ],
  ),
  "support-yang": defaultTemplate(
    "support-yang",
    "扶阳学派思路",
    ["神色精神与声息（有无神、少气懒言）", "口渴及饮水喜冷喜热、有无口吐清水", "舌色、舌苔津液与二便", "面赤、咽痛、牙痛、口疮等「火象」有无外感或实热实据（真假寒热）", "上中下三部定位与危重边界"],
    ["神色无神、畏寒肢冷、舌淡青滑而津液满口、口不渴或喜热饮、二便自利、脉细微或浮空无力，彼此印证", "面赤、咽痛、口疮、身热等「火象」已与实热、阴虚火旺逐项鉴别", "附子等温热、有毒药材的使用边界已由独立审方确认"],
    ["热证或阴虚火旺未排除不得扶阳", "附子等毒性药必须审方", "循环不稳定或意识异常先走急症处置"],
    [
      {
        id: "support-yang-cold-proof",
        question: "请确认阳衰阴盛与真假寒热证据，并核对扶阳用药安全边界。",
        reason: "扶阳学派必须以完整的阳衰阴盛证据为前提；不能因医生选择流派就跳过热证、急症或毒性药核验。",
        fields: ["tcmDetail", "tcmTongue", "tcmPulse", "vitalsDetail"],
        options: [
          { label: "阳衰阴盛", answer: "扶阳问诊：畏寒肢冷、喜热饮、便溏、小便清长、舌淡胖、脉沉迟等线索已补问。", patch: { tcmDetail: "扶阳问诊：阳衰阴盛线索已补问，包括畏寒肢冷、喜热饮、饮食二便及舌脉" } },
          { label: "真假寒热待辨", answer: "寒热表现与舌脉或生命体征不一致，需先辨实热、假热与阳虚外寒，暂不按扶阳方向出方。", patch: { tcmDetail: "扶阳边界：寒热表现与舌脉或生命体征不一致，需先辨真假寒热" } },
          { label: "毒性药复核", answer: "若涉及附子等温热峻烈药，需医生/药师复核炮制、剂量、煎服法、禁忌与特殊人群风险。", patch: { tcmDetail: "扶阳安全边界：附子等毒性或峻烈药需审方复核炮制、剂量、煎服与禁忌" } },
        ],
      },
    ],
  ),
};

export function resolveLineageCode(raw?: string): string {
  const text = (raw || "").trim();
  if (!text) return "unrestricted";
  // 旧版公开 code 曾把温补/扶阳误并为一档。为避免既有客户端突然失效，仅保留输入兼容；
  // 其历史方剂归属绝大多数来自《景岳全书》，故明确迁移到温补学派。新接口不得再回显该旧 code。
  if (text === "warm-tonify-yang" || text === "温补/扶阳思路" || text === "温补／扶阳思路") {
    return "warm-tonify";
  }
  // 除上述已发布旧值外，同时声称两个流派的自由文本没有唯一语义，不能靠卡片顺序猜选。
  // code、中文标签与别名必须同口径；否则中英文混写会被下面的首个 fuzzy 命中静默选错。
  const normalized = text.toLowerCase();
  const claimsWarmTonify = /warm-tonify|温补|肾命/i.test(normalized);
  const claimsSupportYang = /support-yang|扶阳|火神|郑钦安/i.test(normalized);
  if (claimsWarmTonify && claimsSupportYang) return "unrestricted";
  const exact = LINEAGE_CARDS.find((card) =>
    card.code === text ||
    card.label === text ||
    card.aliases.some((alias) => alias && alias === text)
  );
  if (exact) return exact.code;

  const fuzzy = LINEAGE_CARDS.find((card) =>
    card.aliases.some((alias) => alias && normalized.includes(alias.toLowerCase())) ||
    normalized.includes(card.label.toLowerCase())
  );
  if (fuzzy) return fuzzy.code;

  if (/温病|卫气营血|三焦/.test(text)) return "warm-disease";
  if (/扶阳|火神|郑钦安/.test(text)) return "support-yang";
  if (/温补|肾命/.test(text)) return "warm-tonify";
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

/**
 * 辨证依据里流派视角那一句（第十八轮起，选了流派时提示词要求末尾写一句）的认法，收成这一处（2026-10-29 第三十轮）。
 * 此前两处各认各的：依据重写（m03-rationale-coverage）只认「以下按常规辨证处理」与「从…看」，不认「扶阳学派看阴阳实据，本例…」
 * 这种以派名起头、流派适用时不带「以下按常规辨证处理」的写法，重写稿按「不写流派」把它丢了（甲方 10/29 实测：选了扶阳的风寒感冒，
 * 依据里没有扶阳那一句）；去掉别派眼目句（tcm-formula-provenance）只认派名起头。
 */
export const LINEAGE_LENS_SUBJECT: Readonly<Record<string, string>> = {
  "classical-formula": "经方", "warm-disease": "温病", "nourish-yin-danxi": "丹溪", "warm-tonify": "温补", "support-yang": "扶阳",
};

/** 以派名起头的眼目句（「扶阳学派看…」「按温病思路重…」）的派名；不是这种写法时返回 undefined。 */
export function lineageLensSubject(sentence: string, subjects: readonly string[] = Object.values(LINEAGE_LENS_SUBJECT)): string | undefined {
  const match = new RegExp(`^(?:按|从)?(${subjects.join("|")})(?:学派|思路|派)?(?:看|重)`, "u").exec(String(sentence || "").trim());
  return match?.[1];
}

/** 流派视角那一句：派名起头的眼目句，或「从…看，…」「…，以下按常规辨证处理」。 */
export function isLineageLensSentence(sentence: string): boolean {
  const text = String(sentence || "").trim();
  return /以下按常规辨证处理|^从[^，,。]{1,16}看/u.test(text) || lineageLensSubject(text) !== undefined;
}


#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const dataRoot = join(projectRoot, "src/data");
const jiti = createJiti(import.meta.url, { alias: { "@": join(projectRoot, "src") } });
const { TCM_TREATMENT_PROJECTS } = await jiti.import("../src/lib/tcm-treatment-projects.ts");

const writeJson = (name, value) => writeFileSync(
  join(dataRoot, name),
  `${JSON.stringify(value, null, 2)}\n`,
  "utf8",
);

const localSource = (id, title, file, sourceType, scope) => {
  const absolute = join(projectRoot, file);
  return {
    id,
    title,
    publisher: "中医 CDSS 项目",
    sourceType,
    authorityTier: "project_governed_source",
    locator: file,
    sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    scope,
    accessedAt: "2026-07-22",
  };
};

const sources = [
  {
    id: "SRC-GBT-16751-2-2021",
    title: "中医临床诊疗术语 第2部分：证候",
    publisher: "国家市场监督管理总局、国家标准化管理委员会",
    sourceType: "national_recommended_standard",
    authorityTier: "regulatory_primary",
    locator: "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=C71A9DAD24CB1252F12439D1F045DA6A",
    publishedDate: "2021-11-26",
    scope: "证候规范名、同义词、英文名和分类；定义只保存指纹",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-GBT-16751-3-2023",
    title: "中医临床诊疗术语 第3部分：治则治法",
    publisher: "国家市场监督管理总局、国家标准化管理委员会",
    sourceType: "national_recommended_standard",
    authorityTier: "regulatory_primary",
    locator: "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=E8BBBAB76E1AF1498C5DA5DFBB2194EC",
    publishedDate: "2023-03-17",
    scope: "治则、治法和疗法规范名、同义词、英文名和分类；定义只保存指纹",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-TCM-CODE-MAPPING-2020",
    title: "4项中医临床诊疗术语标准新旧映射表",
    publisher: "国家卫生健康委员会、国家中医药管理局",
    sourceType: "official_mapping_attachment",
    authorityTier: "regulatory_primary",
    locator: "https://www.natcm.gov.cn/yizhengsi/zhengcewenjian/2020-11-23/18461.html",
    publishedDate: "2020-11-23",
    scope: "疾病、证候、治法和分类代码的新旧映射",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NHC-MEDICAL-RECORD-2010",
    title: "病历书写基本规范",
    publisher: "国家卫生健康委员会",
    sourceType: "departmental_normative_document",
    authorityTier: "regulatory_primary",
    locator: "https://www.nhc.gov.cn/wjw/c100175/201002/b1bec53d90f243e0861529723f00221a.shtml",
    publishedDate: "2010-02-04",
    scope: "门诊病历基本信息、主诉、病史、体格检查和辅助检查记录要求",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-BEIJING-TCM-RECORD-2025",
    title: "中医病历书写基本规范",
    publisher: "北京市中医药管理局",
    sourceType: "regional_normative_document",
    authorityTier: "government_primary",
    locator: "https://zyj.beijing.gov.cn/sy/tzgg/202511/t20251106_4263764.html",
    publishedDate: "2025-11-06",
    scope: "中医门诊病历的一般信息、主诉、现病史、四诊及辨证记录结构",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NHC-EMR-FUNCTION-2010",
    title: "电子病历系统功能规范（试行）",
    publisher: "国家卫生健康委员会",
    sourceType: "departmental_normative_document",
    authorityTier: "regulatory_primary",
    locator: "https://www.nhc.gov.cn/wjw/gfxwj/201101/a769b5f4b9ca4415a72fa9888bce0bc1.shtml",
    publishedDate: "2010-12-30",
    scope: "电子病历信息记录、修改留痕、权限与数据结构要求",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NHC-PRESCRIPTION-MANAGEMENT",
    title: "处方管理办法",
    publisher: "国家卫生健康委员会",
    sourceType: "departmental_rule",
    authorityTier: "regulatory_primary",
    locator: "https://www.nhc.gov.cn/wjw/c100221/202201/6a4ee53e4a3a407fbd9f520e1e2662c5.shtml",
    scope: "处方开具、调剂、审核和责任边界",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NHC-PRESCRIPTION-AUDIT-2018",
    title: "医疗机构处方审核规范",
    publisher: "国家卫生健康委员会",
    sourceType: "departmental_normative_document",
    authorityTier: "regulatory_primary",
    locator: "https://www.nhc.gov.cn/yzygj/c100068/201807/03df2450431348e18feb3701c199262d.shtml",
    publishedDate: "2018-06-29",
    scope: "真实处方审核的人员职责、审核内容和处置流程",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-SZJG-TCM-FORMULA-2011",
    title: "中药方剂编码规则及编码 第2部分：中药方剂编码（SZJG/T 38.2-2011）",
    publisher: "深圳市市场监督管理局",
    sourceType: "local_technical_standard",
    authorityTier: "government_primary",
    locator: "https://amr.sz.gov.cn/attachment/1/1620/1620360/9772233.pdf",
    publishedDate: "2011-02-01",
    scope: "方剂编码、方名、来源、组成、功效和主治；用于身份交叉核验，不提供患者级剂量依据",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NMPA-CHP-2025-INDEX",
    title: "中华人民共和国药典（2025年版）品种目录",
    publisher: "国家药品监督管理局",
    sourceType: "pharmacopoeia_index",
    authorityTier: "regulatory_primary",
    locator: "https://www.nmpa.gov.cn/directory/web/nmpa/images/1742899061887079524.pdf",
    publishedDate: "2025-03-25",
    scope: "药典收载品种名称索引；不能单独证明汤剂与丸剂身份相同",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NHC-EMERGENCY-DEPT-2009",
    title: "急诊科建设与管理指南（试行）",
    publisher: "国家卫生健康委员会",
    sourceType: "departmental_guideline",
    authorityTier: "regulatory_primary",
    locator: "https://www.nhc.gov.cn/zwgkzt/pyzgl1/200906/41146.shtml",
    publishedDate: "2009-05-25",
    scope: "胸痛、呼吸困难、休克、急腹症、出血、抽搐、晕厥等急症类别",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-BEIJING-EMERGENCY-TRIAGE-2019",
    title: "关于实施急救分级分类救护的办法",
    publisher: "北京市卫生健康委员会",
    sourceType: "regional_triage_rule",
    authorityTier: "government_primary",
    locator: "https://www.beijing.gov.cn/zhengce/gfxwj/sj/201911/t20191115_511747.html",
    publishedDate: "2019-11-15",
    scope: "急危、急重、急症和非急症分级及典型症状体征",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-SAMR-ACUPUNCTURE-OPS",
    title: "针灸技术操作规范系列国家标准",
    publisher: "国家市场监督管理总局、国家标准化管理委员会",
    sourceType: "national_standard_series",
    authorityTier: "regulatory_primary",
    locator: "https://std.samr.gov.cn/gb/search/gbDetailed?id=qP0EZu%2ByzEI%3D&mode=p",
    scope: "针灸类技术操作规范的标准入口；具体项目仍须核对分册和机构资质",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-GBT-40666-2021-MEDICATED-BATH",
    title: "中医技术操作规范 皮肤科 中药药浴",
    publisher: "国家市场监督管理总局、国家标准化管理委员会",
    sourceType: "national_guidance_standard",
    authorityTier: "regulatory_primary",
    locator: "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=FC50372571AB2AB1D5C8764390ED9DB8",
    publishedDate: "2021",
    scope: "中药药浴操作和安全边界",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-GBT-21709-22-2013-GUASHA",
    title: "针灸技术操作规范 第22部分：刮痧",
    publisher: "国家标准化管理委员会",
    sourceType: "national_recommended_standard",
    authorityTier: "regulatory_primary",
    locator: "https://zjjcmspublic.oss-cn-hangzhou-zwynet-d01-a.internet.cloud.zj.gov.cn/jcms_files/jcms1/web3462/site/attach/0/dcfdb77a81074e2bb135e1dd1102dc20.pdf",
    publishedDate: "2013",
    scope: "刮痧操作规范",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-TCM-INFECTION-CONTROL",
    title: "中医医疗技术相关感染预防与控制指南",
    publisher: "卫生健康行政部门公开镜像",
    sourceType: "infection_control_guideline",
    authorityTier: "government_mirror",
    locator: "https://zyk.bjhd.gov.cn/zwdt/xxgk/tzgg/201810/t20181009_3756979_hd.shtml",
    scope: "侵入性及接触性中医技术的消毒、无菌与感染控制边界",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-NATIONAL-MEDICAL-SERVICE-TCM",
    title: "全国医疗服务项目技术规范（中医项目公开说明）",
    publisher: "卫生健康行政部门公开页",
    sourceType: "medical_service_project_specification",
    authorityTier: "government_primary",
    locator: "https://ws.zibo.gov.cn/art/2023/10/31/art_812_2754211.html",
    publishedDate: "2023-10-31",
    scope: "中医医疗服务项目分类和项目边界",
    accessedAt: "2026-07-22",
  },
  {
    id: "SRC-HUNAN-INFLUENZA-TCM-2025",
    title: "湖南省冬春季流感中医药防治方案（2025年版）",
    publisher: "湖南省中医药管理局",
    sourceType: "provincial_tcm_treatment_plan",
    authorityTier: "government_primary",
    locator: "https://tcm.hunan.gov.cn/tcm/xxgk/tzgg/202501/t20250111_33561694.html",
    publishedDate: "2025-01-11",
    scope: "流感针刺、艾灸与拔罐的选穴、操作方向和频次",
    accessedAt: "2026-07-23",
  },
  {
    id: "SRC-BEIJING-TCM-DOUBLE-HEART",
    title: "话说双心",
    publisher: "北京市中医药管理局",
    sourceType: "government_clinical_health_guidance",
    authorityTier: "government_primary",
    locator: "https://zyj.beijing.gov.cn/ylfw/ysbj/201912/t20191223_1412285.html",
    publishedDate: "2011-07-04",
    scope: "失眠针刺主穴和辨证配穴；未提供固定治疗频次",
    accessedAt: "2026-07-23",
  },
  {
    id: "SRC-ZIBO-TCM-DAY-FREQUENCY-2022",
    title: "中医日间诊疗服务项目频次参考表",
    publisher: "淄博市医疗保障局、淄博市卫生健康委员会",
    sourceType: "regional_medical_service_frequency_reference",
    authorityTier: "government_primary",
    locator: "https://ybj.zibo.gov.cn/gongkai/channel_c_5f9fa491ab327f36e4c1305f_5fb3bcc7a40661f2aebb98a4/doc_61f342da93a456a2f282fe85.html",
    publishedDate: "2022-01-26",
    scope: "普通针刺、艾灸、推拿、耳针、放血、小针刀等门诊服务频次参考；仅作项目排程上限参考，不单独证明患者适应证或疗效",
    accessedAt: "2026-07-23",
  },
  {
    id: "SRC-BEIJING-COVID-TCM-REHAB-2020",
    title: "北京市新型冠状病毒肺炎恢复期中医康复指导建议（试行）",
    publisher: "北京市中医药管理局",
    sourceType: "regional_tcm_rehabilitation_guidance",
    authorityTier: "government_primary",
    locator: "https://zyj.beijing.gov.cn/sy/tzgg/202003/t20200314_1706179.html",
    publishedDate: "2020-03-13",
    scope: "恢复期针灸、耳针、艾灸、拔罐、经穴推拿、运动康复和心理疏导的选穴、频次与安全边界",
    accessedAt: "2026-07-23",
  },
  {
    id: "SRC-HORGOS-THREAD-EMBEDDING-2025",
    title: "中医特色疗法——穴位埋线",
    publisher: "霍尔果斯市人民政府",
    sourceType: "government_hospital_health_guidance",
    authorityTier: "government_primary",
    locator: "https://www.xjhegs.gov.cn/xjhegs/c114432/202502/59ed9d552f8c406fb08f48511b068e23.shtml",
    publishedDate: "2025-02-19",
    scope: "肥胖等适应证的穴位埋线项目介绍及两周一次、4至5次的门诊排程参考；必须由专科医生现场评估",
    accessedAt: "2026-07-23",
  },
  {
    id: "SRC-CAAM-EBM-ACUPUNCTURE-INSOMNIA-2014",
    title: "循证针灸临床实践指南：失眠（T/CAAM 011-2014）",
    publisher: "中国针灸学会",
    sourceType: "society_group_standard",
    authorityTier: "professional_society_standard",
    locator: "https://www.ndls.org.cn/standard/detail/e02e12e288c96b7f1792b04c8feea9c7",
    publishedDate: "2014-05-31",
    scope: "失眠的针灸治疗原则、主穴与心脾两虚/心肾不交/心胆气虚/肝火扰神等证型配穴；现行团体标准",
    accessedAt: "2026-08-10",
  },
  {
    id: "SRC-CAAM-DYSMENORRHEA-POINTS",
    title: "痛经（中国针灸学会科普条目）",
    publisher: "中国针灸学会",
    sourceType: "professional_society_clinical_reference",
    authorityTier: "professional_society_reference",
    locator: "https://www.caam.cn/article/688",
    publishedDate: "2024-01-01",
    scope: "痛经实证/虚证主穴与寒凝血瘀、气滞血瘀、气血虚弱、肾气亏损证型配穴",
    accessedAt: "2026-08-10",
  },
  {
    id: "SRC-TCM-GASTRALGIA-CONSENSUS-2024",
    title: "胃痛中医诊疗专家共识（2024）",
    publisher: "中华中医药学会脾胃病分会",
    sourceType: "professional_society_expert_consensus",
    // 专家共识**不等于**学会团体标准：它是一批专家的共识意见，没有标准编号与复审周期。
    // 单开一档而不是并进 professional_society_standard，是中医师 2026-08-11 终审时明确要求的
    //「政府指导 / 学会标准 / 专家共识 / 组合推导必须如实区分」。
    authorityTier: "professional_society_consensus",
    locator: "https://downloads.tcmjc.com/download/pdf?id=12345EEFF2FD4DCFAE5A1ED63461DACA",
    publishedDate: "2024-01-01",
    scope: "胃痛证型与针灸配穴：胃热加内庭；胃阴不足加三阴交、太溪；血瘀加血海、膈俞",
    accessedAt: "2026-08-11",
  },
  {
    id: "SRC-WFAS-COVID-ACUPUNCTURE-STAGED",
    title: "新型冠状病毒肺炎针灸干预分期指导意见（中国针灸学会 / WFAS）",
    publisher: "中国针灸学会",
    sourceType: "society_staged_intervention_opinion",
    authorityTier: "professional_society_reference",
    locator: "https://www.acupunctureresearch.org/assets/WFAS-COVID19-1.pdf",
    publishedDate: "2020-03-01",
    scope: "急性期与恢复期的分期针灸干预原则；恢复期证型不含风热犯肺",
    accessedAt: "2026-08-11",
  },
  {
    // 教材级证型配穴表。**authorityTier 如实标为 project_governed_source**：
    // 内容按公开的《针灸学》规划教材大纲多源交叉核对录入，但本项目没有版次页码级的可核验定位，
    // 因此它不冒充国标或团体标准。甲方权威方案核准后可升格并替换本条 —— 升格只需改这一条登记，
    // planTemplates 里的 sourceRefs 引用的是 id，不需要动数据。
    id: "SRC-TCM-ACUPUNCTURE-SYNDROME-POINT-TABLE",
    title: "《针灸学》规划教材证型配穴表（多源交叉核对录入）",
    publisher: "中医 CDSS 项目治理录入",
    sourceType: "textbook_syndrome_point_table",
    authorityTier: "project_governed_source",
    locator: "src/data/tcm-nondrug-treatment-evidence-catalog.json#planTemplates[].syndromeRefinements",
    publishedDate: "2026-08-10",
    scope: "感冒/咳嗽/不寐/胃痞胃痛/头痛/痛经/痹证/中风面瘫的证型配穴；仅作医师参考证据，executable=false 边界不变，待权威方案核准后升格",
    accessedAt: "2026-08-10",
  },
  localSource(
    "SRC-REFERENCE-NISHI-ACUPUNCTURE",
    "nihaisha-nishi-tcm 针灸课程证据索引",
    "参考/nihaisha-nishi-tcm-main/references/acupuncture.md",
    "user_supplied_educational_reference",
    "常见病证的穴位索引和明确安全警示；仅作辅助选穴线索，必须与政府方案、操作标准和现场医师复核共同使用",
  ),
  localSource(
    "SRC-PROJECT-DETERMINISTIC-SAFETY",
    "中医 CDSS 确定性安全规则",
    "src/lib/diagnosis-safety.ts",
    "project_runtime_rule",
    "红旗、生命体征和特殊人群的实际运行门禁；外部来源只做类别和阈值复核",
  ),
  localSource(
    "SRC-PROJECT-REASONING-CONTRACT",
    "中医 CDSS 结构化推理契约",
    "src/lib/diagnosis-types.ts",
    "project_runtime_contract",
    "M01-M05 当前实际字段与输出结构",
  ),
  localSource(
    "SRC-PROJECT-TREATMENT-CAPABILITY",
    "中医 CDSS 非药物项目能力目录",
    "src/lib/tcm-treatment-projects.ts",
    "project_runtime_catalog",
    "22类非药物/外治项目的风险、资质、药物审方与适用标签",
  ),
  localSource(
    "SRC-PROJECT-HERB-MAPPING",
    "中药饮片标准名别名炮制品映射表",
    "药学基础数据/重点整理数据表/中药饮片标准名别名炮制品映射表.csv",
    "project_governed_mapping",
    "中药标准名、别名、炮制品、置信度和歧义组",
  ),
  localSource(
    "SRC-PROJECT-FORMULA-SOURCES",
    "本地方剂来源汇编",
    "src/data/tcm-formula-sources.json",
    "project_compiled_source",
    "方名、古籍来源和组成的候选全集；同名记录不自动成为治理基线",
  ),
  localSource(
    "SRC-PROJECT-CLINICAL-ADJUDICATION-20260722",
    "甲方测评问题与临床术语裁定记录",
    "docs/灵犀中医CDSS问题-根因分析与整改方案-20260722.md",
    "customer_acceptance_and_clinical_adjudication",
    "测评钦定证型、临床常用锚词和项目扩展术语；扩展条目明确标注为非国标来源",
  ),
  localSource(
    "SRC-CLIENT-CLINICAL-REVIEW-20260805",
    "甲方医学评测点对点回复（2026-08-05）临床意见裁定",
    "docs/客户评测原件/甲方医学评测点对点回复-20260805.docx",
    "customer_acceptance_and_clinical_adjudication",
    // 条目 5.2：气血亏虚头痛宜取益气聪明汤合四物汤方向。
    // 需要裁定入库而非改代码的原因：益气聪明汤在本仓**全部**受治理数据中只收载
    // 「脾胃气虚所致内障目昏、耳鸣耳聋」（深圳标准 0600710156 /《东垣试效方》卷五），
    // 与头痛、气血亏虚没有任何关联记录，因此症状路、主治词路、证候假设路三条召回路
    // 均不可达——症状标注补到 100% 也召不回它。这是知识缺口，只能由临床裁定补入。
    "条目5.2：在高频方证关系表的「气血两虚」与「心脾两虚」两证下补入益气聪明汤、四物汤的 differential 关系；归脾汤 primary 地位不变，由医生按主症权重判断",
  ),
];

writeJson("clinical-governance-source-registry.json", {
  schemaVersion: "clinical-governance-source-registry-v1",
  governance: {
    status: "source_locator_and_scope_registry",
    evidencePolicy: "临床运行资格由表内状态和确定性规则决定；网页可证明来源存在，但不能替代患者级审方或机构资质。",
    reproductionPolicy: "标准全文和受版权保护定义不写入运行表，只登记定位信息与必要摘要。",
  },
  summary: {
    sourceCount: sources.length,
    regulatoryOrGovernmentCount: sources.filter((item) => item.authorityTier.includes("regulatory") || item.authorityTier.includes("government")).length,
    projectSourceCount: sources.filter((item) => item.authorityTier === "project_governed_source").length,
  },
  entries: sources,
});

const requiredFields = [
  {
    id: "chief_complaint",
    label: "主诉",
    casePaths: ["chiefComplaint", "hisRecord.fields.zhushu"],
    stagePolicy: { collect: "required", diagnose: "required", prescribe: "required" },
    currentEnforcement: "client_execution_gate_and_safety_gate",
    unknownPolicy: "not_allowed",
    rationale: "没有本次就诊目标就无法形成患者特异的分析。",
  },
  {
    id: "sex",
    label: "性别/生理状态",
    casePaths: ["patient.sex", "hisRecord.fields.sex"],
    stagePolicy: { collect: "required", diagnose: "required_state_may_be_explicit_unknown", prescribe: "resolved_biological_risk_state_required_for_dose_level_adoption" },
    currentEnforcement: "ui_required_and_collect_route_server_gate_and_dose_safety_gate",
    unknownPolicy: "其他或未明确_is_filled_but_blocks_dose_level_suggestion",
    rationale: "建案时必须记录；无法确认可选“其他或未明确”继续非剂量分析，但不得据此放开具体用量建议。",
  },
  {
    id: "age",
    label: "年龄",
    casePaths: ["patient.age", "hisRecord.fields.age"],
    stagePolicy: { collect: "recommended", diagnose: "conditional", prescribe: "required_for_pediatric_or_age_sensitive_decisions" },
    currentEnforcement: "conditional_safety_gate_for_invalid_conflicting_or_pediatric_age",
    unknownPolicy: "explicit_unknown",
    rationale: "儿童、老年及年龄相关鉴别和剂量边界需要；并非所有病例的通用拒答条件。",
  },
  {
    id: "present_illness",
    label: "现病史",
    casePaths: ["hisRecord.fields.xianbingshi", "symptoms.presentHistory"],
    m02TargetField: "xianbingshi",
    stagePolicy: { collect: "recommended", diagnose: "information_gain_driven", prescribe: "information_gain_driven" },
    currentEnforcement: "m02_target_field",
    unknownPolicy: "explicit_unknown",
    rationale: "病程、诱因、演变和伴随症状用于诊断与辨证，但稀疏病例仍需给出有界结论。",
  },
  {
    id: "past_history",
    label: "既往史",
    casePaths: ["pastHistory", "hisRecord.fields.jiwangshi"],
    m02TargetField: "jiwangshi",
    stagePolicy: { collect: "recommended", diagnose: "conditional", prescribe: "conditional" },
    currentEnforcement: "m02_target_field",
    unknownPolicy: "unknown_never_negative",
    rationale: "共病、既往事件和手术史按本次问题相关性补录。",
  },
  {
    id: "allergy_history",
    label: "过敏史",
    casePaths: ["allergyHistory", "hisRecord.fields.guomin"],
    m02TargetField: "allergyHistory",
    stagePolicy: { collect: "recommended", diagnose: "may_remain_unknown", prescribe: "explicit_state_required_for_dose_level_adoption" },
    currentEnforcement: "safety_missing_item_and_m02_target_field",
    unknownPolicy: "unknown_never_no_allergy",
    rationale: "未知时只能生成对未知状态更稳健的医生候选，不能视为无过敏。",
  },
  {
    id: "medication_history",
    label: "当前用药",
    casePaths: ["medicationHistory", "hisRecord.fields.yongyaoshi"],
    m02TargetField: "medicationHistory",
    stagePolicy: { collect: "recommended", diagnose: "may_remain_unknown", prescribe: "explicit_state_required_for_dose_level_adoption" },
    currentEnforcement: "safety_missing_item_and_m02_target_field",
    unknownPolicy: "unknown_never_no_medication",
    rationale: "影响重复用药、相互作用、停药风险和处方后审方。",
  },
  {
    id: "vitals",
    label: "生命体征",
    casePaths: ["vitals", "hisRecord.fields.vitalsT", "hisRecord.fields.vitalsP", "hisRecord.fields.vitalsR", "hisRecord.fields.vitalsBP", "hisRecord.fields.vitalsDetail"],
    m02TargetField: "vitalsDetail",
    stagePolicy: { collect: "conditional", diagnose: "required_for_red_flag_or_high_risk_context", prescribe: "required_for_red_flag_or_high_risk_context" },
    currentEnforcement: "deterministic_parse_and_conditional_safety_gate",
    unknownPolicy: "unknown_allowed_unless_risk_context_requires_measurement",
    rationale: "危急阈值必须确定性解析；普通稳定门诊不把全套生命体征当统一拒答条件。",
  },
  {
    id: "pediatric_weight",
    label: "儿童体重",
    casePaths: ["patient.weight", "symptoms.weight"],
    stagePolicy: { collect: "conditional", diagnose: "conditional", prescribe: "required_for_pediatric_dose" },
    currentEnforcement: "pediatric_dose_safety_gate",
    unknownPolicy: "unknown_blocks_pediatric_dose",
    rationale: "儿童剂量计算缺体重时必须关闭剂量级输出。",
  },
  {
    id: "reproductive_status",
    label: "妊娠/哺乳/备孕状态",
    casePaths: ["symptoms.pregnancy", "symptoms.lactation", "symptoms.conception"],
    stagePolicy: { collect: "conditional", diagnose: "conditional", prescribe: "explicit_state_required_when_applicable" },
    currentEnforcement: "special_population_safety_gate",
    unknownPolicy: "unknown_never_negative",
    rationale: "仅在生理状态适用时追问；药物风险不能因未提及而默认为阴性。",
  },
  {
    id: "tongue",
    label: "舌象",
    casePaths: ["tongue", "hisRecord.fields.tcmTongue", "tongueDx"],
    m02TargetField: "tcmTongue",
    stagePolicy: { collect: "recommended", diagnose: "confidence_affecting_not_global_gate", prescribe: "confidence_affecting" },
    currentEnforcement: "m02_target_and_completeness_dimension",
    unknownPolicy: "explicit_unknown",
    rationale: "舌象提高辨证分辨率，但稀疏资料必须返回有界而非编造的工作结论。",
  },
  {
    id: "pulse",
    label: "脉象",
    casePaths: ["pulse", "hisRecord.fields.tcmPulse"],
    m02TargetField: "tcmPulse",
    stagePolicy: { collect: "recommended", diagnose: "confidence_affecting_not_global_gate", prescribe: "confidence_affecting" },
    currentEnforcement: "m02_target_and_completeness_dimension",
    unknownPolicy: "explicit_unknown",
    rationale: "脉象为重要四诊事实，但缺失不能触发模型补造。",
  },
  {
    id: "face_and_other_tcm",
    label: "面色及其他四诊",
    casePaths: ["faceNote", "hisRecord.fields.tcmFace", "hisRecord.fields.tcmDetail"],
    m02TargetField: "tcmFace|tcmDetail",
    stagePolicy: { collect: "optional", diagnose: "information_gain_driven", prescribe: "information_gain_driven" },
    currentEnforcement: "m02_target_fields",
    unknownPolicy: "explicit_unknown",
    rationale: "仅在可能改变证候、病机或安全边界时补录。",
  },
  {
    id: "auxiliary_examinations",
    label: "辅助检查",
    casePaths: ["hisRecord.fields.fuzhuJiancha", "symptoms.exams"],
    m02TargetField: "fuzhuJiancha",
    stagePolicy: { collect: "optional", diagnose: "western_differential_driven", prescribe: "safety_driven" },
    currentEnforcement: "m02_target_field",
    unknownPolicy: "not_done_is_not_negative",
    rationale: "用于西医鉴别和安全边界，不应写成中医证候成立的必要前提。",
  },
  {
    id: "behavioral_osa_thyroid_screens",
    label: "精神安全/睡眠呼吸/甲状腺筛查",
    casePaths: ["conversation", "clinicalFacts", "symptoms"],
    stagePolicy: { collect: "conditional", diagnose: "required_when_triggered", prescribe: "required_when_triggered" },
    currentEnforcement: "semantic_trigger_to_required_question",
    unknownPolicy: "unknown_requires_clarification_when_triggered",
    rationale: "仅在对应线索命中时成为必须补问项。",
  },
  {
    id: "patient_name",
    label: "患者姓名",
    casePaths: ["patient.name", "hisRecord.fields.patientName"],
    stagePolicy: { collect: "optional_identifier", diagnose: "not_required", prescribe: "not_required" },
    currentEnforcement: "phi_scrubbed_before_model",
    unknownPolicy: "allowed",
    rationale: "用于院内身份关联，不属于诊断推理所需事实，送模型前脱敏。",
  },
];

writeJson("clinical-required-field-matrix.json", {
  schemaVersion: "clinical-required-field-matrix-v1",
  governance: {
    status: "current_contract_aligned",
    universalMinimum: ["chief_complaint", "sex"],
    safetyRule: "条件性必填由确定性风险、特殊人群和候选治疗共同触发；未知必须保持未知。",
    implementationDrift: [],
    sourceRefs: ["SRC-NHC-MEDICAL-RECORD-2010", "SRC-BEIJING-TCM-RECORD-2025", "SRC-PROJECT-DETERMINISTIC-SAFETY", "SRC-PROJECT-REASONING-CONTRACT"],
  },
  summary: {
    fieldPolicyCount: requiredFields.length,
    universalRequiredCount: 2,
    m02TargetedPolicyCount: requiredFields.filter((item) => item.m02TargetField).length,
  },
  entries: requiredFields,
});

const outputContracts = [
  ["red-flag-warning", "diagnose|prescribe|assess", "safetyGate.redFlags/reasons", "红旗预警", "required_when_red_flag_or_priority_evaluation", "deterministic_rule_and_patient_fact", "visible", "risk-summary-panel"],
  ["M01-case-summary", "collect", "caseState/hisRecord", "病例摘要", "required", "patient_facts_only", "visible", "case-record-panel"],
  ["M02-question-plan", "question", "M02Plan.questions", "集中追问", "conditional", "sourceEvidence_verbatim_binding", "visible", "question-plan-card"],
  ["M03-overview", "diagnose", "reasoningV2.overview", "中医诊断概览", "required", "evidence_ref_and_primary_syndrome_basis", "visible", "diagnosis-conclusion-section"],
  ["M03-western", "diagnose", "reasoningV2.westernDiagnosis", "西医诊断倾向", "required", "supporting_facts_only", "visible", "diagnosis-conclusion-section"],
  ["M03-pathogenesis", "diagnose", "reasoningV2.pathogenesis", "病机拆解", "required", "patient_fact_to_pathogenesis_chain", "visible", "pathogenesis-section"],
  ["M03-therapy", "diagnose", "reasoningV2.therapy", "治则治法", "required", "target_pathogenesis_and_evidence_ref", "visible", "therapy-section"],
  ["M04-formula", "prescribe", "reasoningV2.formula.candidates", "候选方药", "conditional", "formula_source_herb_evidence_and_target_ref", "visible", "formula-section"],
  ["M04-patent-western", "prescribe", "reasoningV2.formula.patentAndWestern", "中成药/西药候选", "nullable", "evidence_id_fingerprint_and_risk_note", "visible", "medicine-section"],
  ["M04-modifications", "prescribe", "reasoningV2.formula.modifications", "加减规则", "optional", "trigger_target_and_evidence_ref", "visible", "formula-modification-list"],
  ["M04-decoction", "prescribe", "reasoningV2.formula.candidates[].decoction", "煎服与复评节点", "required_when_formula_exists", "candidate_formula_binding", "visible", "decoction-panel"],
  // 需求9：中医治疗项目从「非药物调护」内部抽出，成为独立模块，排在健康调护之前。
  // 它与饮食/起居/情志不是同一类东西——前者是受控目录里的可开展治疗项目（有操作方案、
  // 部位穴位、术者资质与必查项），后者是生活方式建议。嵌在一起时医生要在调护文字里翻找
  // 可开的治疗项目，两类内容的决策权重也被拉平。
  ["M03-M04-tcm-treatment", "diagnose|prescribe", "reasoningV2.nonPharma.tcmTreatments", "中医治疗项目", "nullable", "pathogenesis_target_and_protocol_source", "visible", "tcm-treatment-section"],
  ["M03-M04-nonpharma", "diagnose|prescribe", "reasoningV2.nonPharma", "健康调护与注意事项", "nullable", "pathogenesis_target_and_protocol_source", "visible", "followup-care-section"],
  ["M03-M04-lineage", "diagnose|prescribe", "reasoningV2.lineageAdaptation", "流派适配记录", "nullable", "applicability_reason_and_safety_deference", "internal_only", null],
  ["M03-M04-management", "diagnose|prescribe", "reasoningV2.management", "管理与安全网", "nullable", "red_flag_loop_and_followup_trigger", "visible", "followup-care-section"],
  ["M05-assessment", "assess", "deterministic assessment markdown", "风险与随访汇总", "required", "structured_post_prescription_audit", "visible", "audit-followup-section"],
  // 「健康宣教 / management.healthEducation」已于 2026-08-06 删除：它是一条**幽灵契约**。
  //
  // 该条目声明 visibility=visible、有 rendererId，登记表读起来像是一个已交付模块，
  // 但 ClinicalReasoningResultV2.management 只有 redFlagLoop / mustCollect / followupSafetyNet，
  // 从来没有 healthEducation 这个字段——路径连其余条目都有的 `reasoningV2.` 前缀都没写，
  // 说明它从提出那天起就没接过线。DiagnosisClient 只是把这个 id 列进 contractIds，无任何渲染。
  //
  // 幽灵条目比缺条目更糟：登记表现在是 HIS 分节咬合（test:his-section-coupling）的事实来源，
  // 里面混着永远不会出现的模块，就没法再拿它判断「某模块该不该有」。
  // 患者宣教内容由 M03-M04-nonpharma（饮食/起居/情志/注意事项）承担，那也是甲方 I7 要的东西。
  // 新增条目前先确认字段真实存在——test:clinical-governance-tables 现在会逐条核对。
  ["internal-signature", "diagnose|prescribe", "contractSignature/contractSignatureVersion", "结构签名", "internal_required_when_configured", "signed_payload", "internal_only", null],
  ["internal-review-hash", "diagnose|prescribe", "clinicalReview.reviewedPayloadHash", "复核载荷哈希", "internal_optional", "sha256_payload_binding", "internal_only", null],
].map(([id, stage, path, label, requiredStatus, evidenceBinding, visibility, rendererId]) => ({
  id,
  stage,
  path,
  label,
  requiredStatus,
  evidenceBinding,
  visibility,
  ...(rendererId ? { rendererId } : {}),
  unknownPolicy: visibility === "visible" ? "show_boundary_never_fabricate" : "never_render_to_clinical_user",
}));

writeJson("clinical-output-contract-registry.json", {
  schemaVersion: "clinical-output-contract-registry-v2",
  governance: {
    status: "current_linear_m01_m05_contract",
    targetArchitectureExcluded: true,
    visibleOutputPolicy: "可见临床结论必须绑定患者事实、确定性规则或证据条目；内部签名、哈希和工程术语不得进入可见区。",
    sourceRefs: ["SRC-PROJECT-REASONING-CONTRACT", "SRC-PROJECT-DETERMINISTIC-SAFETY"],
  },
  summary: {
    contractCount: outputContracts.length,
    visibleContractCount: outputContracts.filter((item) => item.visibility === "visible").length,
    internalContractCount: outputContracts.filter((item) => item.visibility === "internal_only").length,
  },
  limitedStateCopy: {
    requiredParts: ["knownFacts", "unavailableConclusion", "nextAction"],
    templates: {
      knownFacts: "当前已确认：{knownFacts}",
      unavailableConclusion: "当前尚不能形成：{unavailableConclusion}；原因：{reason}",
      nextAction: "下一步：{nextAction}",
    },
    policy: "不得只写“信息不足”或“暂不生成”；必须同时说明已知事实、受限结论和可执行的补充/转诊动作。",
  },
  surfaces: [
    {
      id: "case_collection",
      label: "病例采集",
      sectionOrder: ["M01-case-summary"],
    },
    {
      id: "question_round",
      label: "集中追问",
      sectionOrder: ["M02-question-plan"],
    },
    {
      id: "comprehensive_clinical_scheme",
      label: "完整诊疗支持方案",
      sectionOrder: ["red-flag-warning", "M03-overview", "M03-western", "M03-pathogenesis", "M03-therapy", "M04-formula", "M04-decoction", "M04-modifications", "M04-patent-western", "M03-M04-tcm-treatment", "M03-M04-nonpharma", "M03-M04-management", "health-education", "M05-assessment"],
    },
    {
      id: "limited_clinical_scheme",
      label: "受限态诊疗支持方案",
      sectionOrder: ["red-flag-warning", "M03-overview", "M03-western", "M03-pathogenesis", "M03-M04-management", "health-education"],
      copyContract: "limitedStateCopy",
    },
    {
      id: "red_flag_escalation",
      label: "红旗处置方案",
      // 处置改「提示不拦截」后，红旗分面与完整方案**并存**：急诊警示置顶，其余各节照常渲染。
      // 此前本表只留 4 节（旧阻断契约下其余节不渲染），前端 sectionOrder 对缺失 id 回退到
      // 表长兜底值，结果候选方药被压到最后、健康调护被顶到中间——实测甲方反馈
      // 「最后一个健康调护模块不见了、随证加减变成最后一块」。分面排序必须覆盖全部会出现的节。
      sectionOrder: ["red-flag-warning", "M03-overview", "M03-western", "M03-pathogenesis", "M03-therapy", "M04-formula", "M04-decoction", "M04-modifications", "M04-patent-western", "M03-M04-tcm-treatment", "M03-M04-nonpharma", "M03-M04-management", "health-education", "M05-assessment"],
      copyContract: "limitedStateCopy",
    },
    {
      id: "non_dose_treatment_direction",
      label: "非剂量治疗方向",
      // 同上：非剂量分面下若仍渲染 M04 节（方名方向/中成药候选），排序不得回退兜底。
      sectionOrder: ["red-flag-warning", "M03-overview", "M03-western", "M03-pathogenesis", "M03-therapy", "M04-formula", "M04-decoction", "M04-modifications", "M04-patent-western", "M03-M04-tcm-treatment", "M03-M04-nonpharma", "M03-M04-management", "health-education", "M05-assessment"],
      copyContract: "limitedStateCopy",
    },
    {
      id: "post_prescription_followup",
      label: "处方后风险与随访",
      sectionOrder: ["red-flag-warning", "M05-assessment", "M03-M04-management", "health-education"],
    },
  ],
  entries: outputContracts,
});

const acupunctureFamily = new Set(["acupuncture", "moxibustion", "auricular", "thread_embedding", "bloodletting"]);
const exactStandard = new Map([
  ["acupuncture", ["SRC-SAMR-ACUPUNCTURE-OPS", "SRC-TCM-INFECTION-CONTROL"]],
  ["guasha", ["SRC-GBT-21709-22-2013-GUASHA", "SRC-TCM-INFECTION-CONTROL"]],
  ["medicated_bath", ["SRC-GBT-40666-2021-MEDICATED-BATH"]],
]);
/**
 * 证型配穴表（甲方 2026-08-10 ⑪ 第二步）。
 *
 * 录入前的实测状态：25 条 planTemplates 的 matchAny **无一含寒热虚实**，400 穴目录的
 * indications 里也没有性质词，于是甲流风寒/风热、不寐心脾两虚/肝火扰心、胃痞湿热中阻/脾胃虚寒、
 * 右膝痹寒湿/湿热——四组八例穴位逐字相同。命中判据当时就是病名字符串。
 *
 * 来源分层，如实标注、不混淆权威度：
 *  · 不寐  → T/CAAM 011-2014《循证针灸临床实践指南：失眠》（中国针灸学会团体标准，现行）
 *  · 痛经  → 中国针灸学会官网痛经条目
 *  · 其余  → 《针灸学》规划教材证型配穴表（多源公开交叉核对录入，authorityTier 为
 *            project_governed_source，**待甲方权威方案核准后升格**）
 *
 * 边界一条未动：executable=false，仍是证据层参考；补泻、深度、留针、禁忌由现场医师定。
 * 这里只把「凭什么是这几个穴」从「病名对上了」补成「病名对上了 + 本例证型对上了」。
 */
const TEXTBOOK_SYNDROME_POINTS = "SRC-TCM-ACUPUNCTURE-SYNDROME-POINT-TABLE";
const CAAM_INSOMNIA_GUIDE = "SRC-CAAM-EBM-ACUPUNCTURE-INSOMNIA-2014";
const CAAM_DYSMENORRHEA = "SRC-CAAM-DYSMENORRHEA-POINTS";
const GASTRALGIA_CONSENSUS_2024 = "SRC-TCM-GASTRALGIA-CONSENSUS-2024";
const BEIJING_COVID_REHAB = "SRC-BEIJING-COVID-TCM-REHAB-2020";
// SRC-WFAS-COVID-ACUPUNCTURE-STAGED 登记在来源表里但不被任何规则引用——它是
// 「恢复期不应有风热犯肺配穴」这条**删除决定**的依据（见下方 cough-wind-heat-lung 的删除注释）。
// 删除决定同样需要可追溯的出处，因此来源留在注册表里，不给它一个常量。

const governedPlanTemplates = new Map([
  ["acupuncture", [
    {
      id: "acupuncture-insomnia-government-guidance",
      indicationTag: "sleep_emotion",
      // 词表补齐至与同标签下其余模板一致（2026-08-06）。原为 ["失眠","不寐"] 两条，
      // 而耳穴/食疗/情志三条 sleep_emotion 模板早已收了「入睡困难/多梦/易醒」——
      // 同一适应证在同一张表里两种宽度，窄的那条静默失配：病历按最常见写法录「入睡困难、多梦」，
      // 针刺选穴整栏消失，医生反而拿不到建议。穴位与频次内容一字未动，只补匹配词。
      matchAny: ["失眠", "不寐", "入睡困难", "多梦", "易醒"],
      sitesOrPoints: ["安眠", "神门", "内关", "心俞"],
      techniqueBoundary: "留针用补法；实际取穴、进针和刺激参数由现场医师复核。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；实际间隔与疗程由面诊医生按耐受和复评结果确定。",
      sourceRefs: ["SRC-BEIJING-TCM-DOUBLE-HEART", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "points_and_government_frequency_reference_governed",
      syndromeRefinements: [
        { id: "insomnia-heart-spleen-deficiency", syndromeLabel: "心脾两虚", syndromeMatchAny: ["心脾两虚", "心脾气血两虚", "气血不足，心神失养"], addPoints: ["脾俞", "足三里"], sourceRefs: [CAAM_INSOMNIA_GUIDE, TEXTBOOK_SYNDROME_POINTS] },
        // removePoints 不设：教材不寐配穴表只讲「加什么」，没有「肝火扰心须去心俞」这条。
        // 第一版为了让两组结果更不一样而自行加了剔除——那是我方在临床数据上发挥，已按独立复核删除。
        { id: "insomnia-liver-fire", syndromeLabel: "肝火扰心", syndromeMatchAny: ["肝火扰心", "肝火扰神", "肝郁化火", "心肝火旺"], addPoints: ["行间", "侠溪"], sourceRefs: [CAAM_INSOMNIA_GUIDE, TEXTBOOK_SYNDROME_POINTS] },
        { id: "insomnia-heart-kidney-disharmony", syndromeLabel: "心肾不交", syndromeMatchAny: ["心肾不交", "阴虚火旺", "水火不济"], addPoints: ["太溪", "肾俞"], sourceRefs: [CAAM_INSOMNIA_GUIDE, TEXTBOOK_SYNDROME_POINTS] },
        { id: "insomnia-heart-gallbladder-timidity", syndromeLabel: "心胆气虚", syndromeMatchAny: ["心胆气虚", "胆虚"], addPoints: ["胆俞"], sourceRefs: [CAAM_INSOMNIA_GUIDE, TEXTBOOK_SYNDROME_POINTS] },
        { id: "insomnia-phlegm-heat", syndromeLabel: "痰热内扰", syndromeMatchAny: ["痰热内扰", "痰热扰心", "痰火扰心"], addPoints: ["丰隆", "内庭"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 独立复核（2026-08-10）纠正：教材不寐「脾胃不和」配的是足三里、内关，不是公孙。
        // 内关已在主穴里，不重复写进加减（否则医生会以为它是本证型特有的）。
        { id: "insomnia-spleen-stomach-disharmony", syndromeLabel: "脾胃不和", syndromeMatchAny: ["脾胃不和", "胃不和则卧不安", "食滞"], addPoints: ["足三里"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-influenza-hunan-2025",
      indicationTag: "respiratory",
      matchAny: ["流感", "流行性感冒"],
      sitesOrPoints: ["列缺", "合谷", "风池", "太阳", "外关"],
      techniqueBoundary: "针刺采用泻法；须先排除急危重症并由具备资质人员操作。",
      scheduleSuggestion: "每日1次，每次30分钟。",
      sourceRefs: ["SRC-HUNAN-INFLUENZA-TCM-2025", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "points_frequency_and_duration_governed",
      syndromeRefinements: [
        { id: "influenza-wind-cold", syndromeLabel: "风寒束表", syndromeMatchAny: ["风寒束表", "风寒犯表", "风寒袭表", "风寒证", "外感风寒"], addPoints: ["风门", "肺俞"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "influenza-wind-heat", syndromeLabel: "风热犯表", syndromeMatchAny: ["风热犯表", "风热袭表", "风热证", "外感风热", "热毒袭肺"], addPoints: ["曲池", "尺泽", "大椎"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "influenza-damp", syndromeLabel: "夹湿", syndromeMatchAny: ["湿邪", "夹湿", "暑湿", "寒湿束表"], addPoints: ["阴陵泉"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "influenza-deficiency", syndromeLabel: "体虚感冒", syndromeMatchAny: ["气虚感冒", "体虚感冒", "肺卫气虚", "正虚"], addPoints: ["足三里"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-post-infection-respiratory-rehab",
      indicationTag: "respiratory",
      matchAny: ["恢复期", "肺脾气虚", "肺胃阴虚", "气阴两伤"],
      sitesOrPoints: ["太渊", "足三里", "肺俞或膻中（按证型二选一）", "证型配穴由医师复核"],
      techniqueBoundary: "仅适用于已完成急性感染期处置后的恢复期；毫针操作、证型配穴和禁忌由具备资质的医师复核。",
      scheduleSuggestion: "每日或隔日1次，每次留针10-25分钟。",
      sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "syndrome_points_frequency_and_duration_governed",
      syndromeRefinements: [
        // 中医师终审（2026-08-11）#2：删掉重复的太渊——它是本方主穴，所有证型都取，
        // 写进证型加穴会让医生误以为是本证特有配穴。风门保留，但加表寒证据门槛：
        // 只有病历确有恶寒/无汗/清涕/白稀痰等表寒线索时才自动显示。
        { id: "cough-wind-cold-lung", syndromeLabel: "风寒袭肺", syndromeMatchAny: ["风寒袭肺", "风寒犯肺", "风寒"], addPoints: ["风门"], additionalEvidenceAny: ["恶寒", "畏寒", "无汗", "清涕", "白稀痰", "痰白稀", "鼻塞流清涕"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#3：**整条删除**。大椎、曲池对应发热/表热等急性阶段，
        // 而本模板是感染**恢复期**——官方恢复期证型集中在肺脾气虚、肺胃阴虚、余邪未尽气阴两伤。
        // 若患者仍有发热、咽痛、黄痰，应重新评估是否仍属急性期，届时才谈得上大椎、曲池。
        // 删除后本证走第三态（病种模板·未按证型加减），不再返回一个看似精准、病程阶段却不匹配的配穴。
        // 依据：北京市中医管理局恢复期指导建议、中国针灸学会分期干预意见。
        { id: "cough-phlegm-damp-lung", syndromeLabel: "痰湿阻肺", syndromeMatchAny: ["痰湿阻肺", "痰湿蕴肺", "痰浊阻肺"], addPoints: ["丰隆", "阴陵泉"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "cough-liver-fire-lung", syndromeLabel: "肝火灼肺", syndromeMatchAny: ["肝火灼肺", "肝火犯肺"], addPoints: ["行间", "鱼际"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "cough-lung-yin-deficiency", syndromeLabel: "肺阴亏虚", syndromeMatchAny: ["肺阴亏虚", "肺胃阴虚", "气阴两伤", "阴虚"], addPoints: ["膏肓", "太溪"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#4：脾俞 → 关元。北京市官方恢复期方案对肺脾气虚证列
        // 太渊、膻中、气海、关元、足三里；本模板主穴已覆盖太渊、足三里与肺俞/膻中，
        // 因此证型增量恰是气海、关元。脾俞系哮喘虚证表外推，不作本证默认（医生可个体化选用）。
        // 来源随之改挂北京指导建议——它才是这条的真实出处。
        { id: "cough-lung-spleen-qi-deficiency", syndromeLabel: "肺脾气虚", syndromeMatchAny: ["肺脾气虚", "肺气虚", "脾肺气虚"], addPoints: ["气海", "关元"], sourceRefs: [BEIJING_COVID_REHAB] },
      ],
    },
    {
      id: "acupuncture-digestive-common-outpatient",
      indicationTag: "digestive",
      matchAny: ["痞满", "胃痞", "胃脘痛", "胃痛", "功能性消化不良", "便秘", "泄泻", "腹胀"],
      // 关元从主穴里**移走**（甲方 2026-08-10 ⑪）。它此前挂着「（须结合寒热虚实复核）」的括注
      // 出现在每一个消化类病例上——包括湿热中阻例。那句括注等于把系统判不了的事写成一句免责，
      // 而关元在权威配穴表里本就只属于虚寒类加减。现在它只出现在 脾胃虚寒 那一条 refinement 里，
      // 湿热类另有 removePoints 显式剔除，闸门落在配穴表而不是我们自造的寒热词表上。
      sitesOrPoints: ["中脘", "双侧天枢", "足三里", "内关"],
      techniqueBoundary: "腹部急痛、腹膜刺激征、消化道出血等先按红旗处置；穴位仅为课程索引与门诊病种频次的组合参考。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；每次选穴和疗程须根据症状变化复评。",
      sourceRefs: ["SRC-REFERENCE-NISHI-ACUPUNCTURE", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "supplementary_points_and_government_frequency_reference_governed",
      syndromeRefinements: [
        { id: "digestive-spleen-stomach-deficiency-cold", syndromeLabel: "脾胃虚寒", syndromeMatchAny: ["脾胃虚寒", "中焦虚寒", "脾阳不足", "脾阳虚", "胃寒"], addPoints: ["关元", "脾俞", "胃俞"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "digestive-damp-heat", syndromeLabel: "湿热中阻", syndromeMatchAny: ["湿热中阻", "湿热内蕴", "脾胃湿热", "中焦湿热", "肠腑湿热"], addPoints: ["阴陵泉", "内庭"], removePoints: ["关元"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#5：组合成立、不删；但适用范围收紧为「胃痞/脘闷为主，
        // 兼苔腻、身重、纳呆等痰湿证据」，不能只因普通胃痛触发。来源如实标为组合推导——
        // 胃痛配穴表没有一条与之逐字相同的原文，丰隆+阴陵泉的教材原文出处在咳嗽痰湿阻肺。
        { id: "digestive-phlegm-damp", syndromeLabel: "痰湿中阻", syndromeMatchAny: ["痰湿中阻", "痰湿内停", "痰饮内停"], addPoints: ["丰隆", "阴陵泉"], removePoints: ["关元"], additionalEvidenceAny: ["苔腻", "身重", "纳呆", "脘闷", "痞满", "胸闷", "口黏"], sourceDerivation: "combination_inference", sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "digestive-liver-qi-invading-stomach", syndromeLabel: "肝气犯胃", syndromeMatchAny: ["肝气犯胃", "肝胃不和", "肝郁气滞", "肝气郁结"], addPoints: ["期门", "太冲"], removePoints: ["关元"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "digestive-food-retention", syndromeLabel: "饮食停滞", syndromeMatchAny: ["饮食停滞", "食滞胃脘", "食积", "宿食"], addPoints: ["梁门", "下脘"], removePoints: ["关元"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 教材胃痛「胃阴不足」配胃俞、三阴交、内庭；第一版漏了胃俞（独立复核 2026-08-10 指出）。
        // 中医师终审（2026-08-11）#6：内庭 → 太溪。2024 胃痛专家共识明确区分——
        // 胃热加内庭；胃阴不足加三阴交、太溪。内庭只在兼明显胃热时再选，不作本证默认。
        { id: "digestive-stomach-yin-deficiency", syndromeLabel: "胃阴不足", syndromeMatchAny: ["胃阴不足", "胃阴亏虚", "阴虚"], addPoints: ["胃俞", "三阴交", "太溪"], removePoints: ["关元"], sourceRefs: [GASTRALGIA_CONSENSUS_2024, TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#7：三阴交 → 血海。教材的膈俞、三阴交并非错误，
        // 但 2024 胃痛专家共识对血瘀胃痛直接给出血海、膈俞，针对性与来源等级都更高。
        { id: "digestive-blood-stasis", syndromeLabel: "瘀血停胃", syndromeMatchAny: ["瘀血停胃", "瘀血阻络", "胃络瘀阻"], addPoints: ["膈俞", "血海"], sourceRefs: [GASTRALGIA_CONSENSUS_2024, TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-headache-common-outpatient",
      indicationTag: "headache",
      matchAny: ["头痛", "偏头痛"],
      sitesOrPoints: ["百会", "合谷", "太阳或率谷（按疼痛部位复核）", "风池（仅由专业人员操作）"],
      techniqueBoundary: "突发剧烈头痛、神经功能缺损、发热颈强或外伤后头痛先行急诊评估；不输出进针方向和深度。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；急性期与维持期的具体间隔由面诊医生确定。",
      sourceRefs: ["SRC-REFERENCE-NISHI-ACUPUNCTURE", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "supplementary_points_and_government_frequency_reference_governed",
      syndromeRefinements: [
        { id: "headache-liver-yang", syndromeLabel: "肝阳上亢", syndromeMatchAny: ["肝阳上亢", "肝阳化风", "肝火上炎", "肝火"], addPoints: ["太冲", "太溪"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "headache-phlegm-turbidity", syndromeLabel: "痰浊上扰", syndromeMatchAny: ["痰浊上扰", "痰浊中阻", "痰湿"], addPoints: ["中脘", "丰隆"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "headache-blood-stasis", syndromeLabel: "瘀血阻络", syndromeMatchAny: ["瘀血阻络", "瘀血头痛", "血瘀"], addPoints: ["血海", "膈俞"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "headache-blood-deficiency", syndromeLabel: "气血亏虚", syndromeMatchAny: ["血虚", "气血亏虚", "气血不足"], addPoints: ["脾俞", "足三里"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "headache-wind-cold", syndromeLabel: "风寒外袭", syndromeMatchAny: ["风寒", "外感风寒"], addPoints: ["风门", "列缺"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "headache-wind-heat", syndromeLabel: "风热上扰", syndromeMatchAny: ["风热", "外感风热"], addPoints: ["曲池", "大椎"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 悬钟按独立复核（2026-08-10）删除：它来自眩晕「肾精不足」的配穴，被我方外推到头痛，
        // 而头痛肾虚的教材配穴只有肾俞、太溪。外推不是来源，删掉。
        { id: "headache-kidney-deficiency", syndromeLabel: "肾虚", syndromeMatchAny: ["肾精不足", "肾虚", "髓海不足"], addPoints: ["肾俞", "太溪"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-gynecology-common-outpatient",
      indicationTag: "gynecology",
      matchAny: ["痛经", "月经不调", "经期腹痛"],
      sitesOrPoints: ["三阴交", "血海", "关元"],
      techniqueBoundary: "妊娠可能、异常大量出血、急性腹痛或盆腔感染线索必须先复核；孕期禁忌穴位和操作由医师现场决定。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；是否围绕经期安排及疗程长度由妇科/针灸医师复评。",
      sourceRefs: ["SRC-REFERENCE-NISHI-ACUPUNCTURE", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "supplementary_points_and_government_frequency_reference_governed",
      syndromeRefinements: [
        // 中医师终审（2026-08-11）#8：删中极。归来、地机成立；中极与主穴关元同为下腹任脉近邻穴，
        // 系统默认同时给出会造成取穴过密。中极下沉为「痛经通用候选 / 查体后可选」，不进默认加穴。
        { id: "dysmenorrhea-cold-stasis", syndromeLabel: "寒凝血瘀", syndromeMatchAny: ["寒凝血瘀", "寒湿凝滞", "胞宫虚寒", "寒凝"], addPoints: ["归来", "地机"], sourceRefs: [CAAM_DYSMENORRHEA, TEXTBOOK_SYNDROME_POINTS] },
        { id: "dysmenorrhea-qi-stagnation", syndromeLabel: "气滞血瘀", syndromeMatchAny: ["气滞血瘀", "肝郁气滞"], addPoints: ["太冲", "次髎"], sourceRefs: [CAAM_DYSMENORRHEA, TEXTBOOK_SYNDROME_POINTS] },
        { id: "dysmenorrhea-qi-blood-deficiency", syndromeLabel: "气血虚弱", syndromeMatchAny: ["气血虚弱", "气血两虚", "气血不足"], addPoints: ["脾俞", "胃俞", "足三里"], sourceRefs: [CAAM_DYSMENORRHEA, TEXTBOOK_SYNDROME_POINTS] },
        { id: "dysmenorrhea-kidney-deficiency", syndromeLabel: "肾气亏损", syndromeMatchAny: ["肾气亏损", "肝肾亏虚", "肾虚"], addPoints: ["太溪", "肾俞"], sourceRefs: [CAAM_DYSMENORRHEA, TEXTBOOK_SYNDROME_POINTS] },
        // 不设 removePoints：关元是痛经主穴（任脉、调冲任），教材没有「湿热蕴结须去关元」这条。
        // 消化类模板的关元剔除有教材依据（关元本就只属虚寒类加减），痛经这里没有，不能照搬。
        // 中医师终审（2026-08-11）#9：证型规范名改「湿热瘀阻」（不再用「湿热蕴结」作痛经主标签）；
        // 次髎 → 曲池：阴陵泉清利湿热、曲池泄热，次髎下沉为痛经通用穴/腰骶坠痛时的对症可选穴。
        // 该证型本身成立，但现有配穴不是同等级指南的直接原文，故来源标为组合推导。
        { id: "dysmenorrhea-damp-heat", syndromeLabel: "湿热瘀阻", syndromeMatchAny: ["湿热瘀阻", "湿热蕴结", "湿热下注"], addPoints: ["阴陵泉", "曲池"], sourceDerivation: "combination_inference", sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-musculoskeletal-common-outpatient",
      indicationTag: "musculoskeletal_pain",
      matchAny: ["项痹", "肩痹", "膝痹", "腰痛", "颈肩", "膝关节"],
      sitesOrPoints: ["局部阿是穴（查体确认）", "循经远端穴（按疼痛部位选择）"],
      techniqueBoundary: "先排除骨折、感染、进行性神经损害及脊髓压迫；深刺、透刺和高风险解剖区域不由系统给出操作参数。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；每次治疗前复查疼痛、活动度和神经血管状态。",
      sourceRefs: ["SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS", "SRC-REFERENCE-NISHI-ACUPUNCTURE"],
      parameterCompleteness: "region_and_government_frequency_reference_governed_exact_points_require_exam",
      // 痹证配穴表（行痹/痛痹/着痹/热痹）。甲方实测的「右膝痹 寒湿 / 湿热」两侧此前逐字相同，
      // 差别正落在这四条上：寒湿取温散（肾俞、关元、阴陵泉、足三里），湿热取清泻（大椎、曲池）。
      syndromeRefinements: [
        { id: "bi-cold-damp", syndromeLabel: "寒湿痹阻", syndromeMatchAny: ["寒湿", "寒湿痹阻", "痛痹", "着痹", "风寒湿"], addPoints: ["肾俞", "关元", "阴陵泉", "足三里"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#10：保留。「湿热痹阻」作为复合证型成立——大椎、曲池来自热痹，
        // 阴陵泉处理湿重。但来源必须如实标为**组合推导**（热痹规则 + 湿邪配穴），
        // 不能写成教材里存在一条完全相同的原文。
        { id: "bi-damp-heat", syndromeLabel: "湿热痹阻", syndromeMatchAny: ["湿热痹阻", "湿热", "热痹"], addPoints: ["大椎", "曲池", "阴陵泉"], removePoints: ["关元"], sourceDerivation: "combination_inference", sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "bi-wandering", syndromeLabel: "风邪偏胜（行痹）", syndromeMatchAny: ["行痹", "风邪偏胜", "游走"], addPoints: ["膈俞", "血海"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#11：肝俞保留。它不是因「关节痛」这一单症状触发，而是针对
        // 已成立的肝肾亏虚证调补肝肾、濡养筋骨——不能只拿单穴主治表里有没有写关节痛来否定。
        // 但规则要限定：腰膝酸软、久病、劳则加重等肝肾亏虚证据成立时才显示。
        { id: "bi-liver-kidney-deficiency", syndromeLabel: "肝肾亏虚", syndromeMatchAny: ["肝肾亏虚", "肝肾不足", "肾虚"], addPoints: ["肝俞", "肾俞", "太溪"], additionalEvidenceAny: ["腰膝酸软", "腰膝", "久病", "劳则加重", "劳累后加重", "腰酸", "膝软", "五心烦热", "头晕耳鸣"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#12：保留膈俞、血海，不默认加委中、内关。
        // 与行痹同穴组不是抄录错误——行痹需治风先治血、瘀血阻络需活血通络，两条规则可因不同病机共享穴组。
        // 委中按腰背/膝后循经部位触发、内关按上肢或胸闷等兼症触发，均属现场医师个体化选用。
        { id: "bi-blood-stasis", syndromeLabel: "瘀血阻络", syndromeMatchAny: ["瘀血阻络", "血瘀"], addPoints: ["膈俞", "血海"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
      ],
    },
    {
      id: "acupuncture-neurologic-rehabilitation-outpatient",
      indicationTag: "neurologic_rehabilitation",
      matchAny: ["中风后遗症", "脑梗死恢复期", "偏瘫", "面瘫"],
      sitesOrPoints: ["百会", "曲池", "足三里", "阳陵泉（按功能缺损复核）"],
      techniqueBoundary: "仅用于病情稳定的康复期；新发无力、言语障碍、意识改变等按卒中急症流程处理，不以针刺替代现代康复。",
      scheduleSuggestion: "门诊项目频次参考为每日1次；与现代康复训练错峰安排并按功能量表复评。",
      sourceRefs: ["SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-SAMR-ACUPUNCTURE-OPS", "SRC-REFERENCE-NISHI-ACUPUNCTURE"],
      parameterCompleteness: "rehabilitation_points_and_government_frequency_reference_governed",
      syndromeRefinements: [
        { id: "stroke-liver-yang-surge", syndromeLabel: "肝阳暴亢", syndromeMatchAny: ["肝阳暴亢", "肝阳上亢", "风阳上扰"], addPoints: ["太冲", "太溪"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "stroke-wind-phlegm", syndromeLabel: "风痰阻络", syndromeMatchAny: ["风痰阻络", "风痰"], addPoints: ["丰隆", "合谷"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 中医师终审（2026-08-11）#13：删掉重复的曲池——它已在本方主穴内，所有证型都取。
        // 临床上痰热腑实的完整组合仍是曲池、内庭、丰隆，只是数据结构里不能把同一穴记两遍。
        { id: "stroke-phlegm-heat-fu", syndromeLabel: "痰热腑实", syndromeMatchAny: ["痰热腑实", "痰热"], addPoints: ["内庭", "丰隆"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "stroke-qi-deficiency-stasis", syndromeLabel: "气虚血瘀", syndromeMatchAny: ["气虚血瘀", "气虚"], addPoints: ["气海", "血海"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        { id: "stroke-yin-deficiency-wind", syndromeLabel: "阴虚风动", syndromeMatchAny: ["阴虚风动", "阴虚阳亢"], addPoints: ["太溪", "风池"], sourceRefs: [TEXTBOOK_SYNDROME_POINTS] },
        // 面瘫的「风寒外袭 → 风池、风府」「风热侵袭 → 外关、关冲」**刻意不放在这里**。
        // 独立复核（2026-08-10）指出：本模板的主穴是中风取穴（百会、曲池、足三里、阳陵泉），
        // 而面瘫的教材主穴是攒竹、阳白、四白、颧髎、颊车、地仓、合谷、太冲——两套完全不同。
        // 把面瘫配穴挂到中风主穴上会拼出一张临床上不成立的处方，正是本目录一直防的
        // 「跨适应证套用」。面瘫因此落到 governed_class_template_not_syndrome_tailored，
        // 如实标注「尚未按本例证型加减」；补面瘫独立模板需另立一条 planTemplate。
      ],
    },
  ]],
  ["moxibustion", [
    {
      id: "moxibustion-influenza-hunan-2025",
      indicationTag: "respiratory",
      matchAny: ["流感", "流行性感冒"],
      sitesOrPoints: ["按针刺方案中与当前证型匹配的穴位"],
      techniqueBoundary: "可用悬灸、灸盒灸或温针灸；内闭外脱虚证只灸不针。",
      scheduleSuggestion: "每日1次，每次30分钟。",
      sourceRefs: ["SRC-HUNAN-INFLUENZA-TCM-2025", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "frequency_and_duration_governed_points_require_syndrome_selection",
    },
    {
      id: "moxibustion-post-infection-respiratory-rehab",
      indicationTag: "respiratory",
      matchAny: ["恢复期", "畏寒", "肺脾气虚"],
      sitesOrPoints: ["膀胱经大杼至肾俞区域（现场定位）"],
      techniqueBoundary: "仅适用于恢复期且无皮肤破损、感觉障碍或热损伤高风险者；距离和热度由医师控制。",
      scheduleSuggestion: "隔日1次，每次约30分钟。",
      sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020", "SRC-SAMR-ACUPUNCTURE-OPS"],
      parameterCompleteness: "region_frequency_and_duration_governed",
    },
  ]],
  ["tuina", [{
    id: "tuina-post-infection-respiratory-rehab",
    indicationTag: "respiratory",
    matchAny: ["恢复期", "咳嗽", "乏力"],
    sitesOrPoints: ["咳嗽：天突、膻中、内关", "乏力：双侧膀胱经大杼至肾俞"],
    techniqueBoundary: "仅用于恢复期经穴推拿；胸痛、呼吸困难、低氧或急性发热先行急症评估。",
    scheduleSuggestion: "咳嗽点按每日1次；乏力背部经穴点按隔日1次。",
    sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020"],
    parameterCompleteness: "points_and_frequency_governed",
  }]],
  ["cupping", [
    {
    id: "cupping-influenza-hunan-2025",
    indicationTag: "respiratory",
    matchAny: ["流感", "流行性感冒"],
    sitesOrPoints: ["膀胱经相关背部区域"],
    techniqueBoundary: "按证型在闪罐、走罐、留罐或刺络拔罐中选择；不在本系统给出负压和留罐参数。",
    scheduleSuggestion: "每周2次。",
    sourceRefs: ["SRC-HUNAN-INFLUENZA-TCM-2025"],
    parameterCompleteness: "region_and_frequency_governed_technique_requires_clinician_selection",
    },
    {
      id: "cupping-post-infection-respiratory-rehab",
      indicationTag: "respiratory",
      matchAny: ["恢复期", "咳嗽", "乏力"],
      sitesOrPoints: ["双侧风门", "肺俞", "膈俞", "气海俞", "足三里（按症状选择）"],
      techniqueBoundary: "根据咳嗽、乏力选穴；出血风险、皮肤破损、感觉障碍或感染时不实施。",
      scheduleSuggestion: "每周2-3次，每次留罐5-10分钟。",
      sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020"],
      parameterCompleteness: "points_frequency_and_duration_governed",
    },
  ]],
  ["guasha", [{
    id: "guasha-influenza-hunan-2025",
    indicationTag: "respiratory",
    matchAny: ["流感", "流行性感冒"],
    sitesOrPoints: ["肺经", "膀胱经", "胃经", "大肠经（按证型选择）"],
    techniqueBoundary: "不强求出痧；出血风险、皮肤破损、感染或感觉障碍者不实施。",
    scheduleSuggestion: "每周1次，或痧退后再行下一次。",
    sourceRefs: ["SRC-HUNAN-INFLUENZA-TCM-2025", "SRC-GBT-21709-22-2013-GUASHA"],
    parameterCompleteness: "meridians_and_frequency_governed",
  }]],
  ["needle_knife", [{
    id: "needle-knife-musculoskeletal-specialist-assessment",
    indicationTag: "musculoskeletal_pain",
    matchAny: ["项痹", "肩痹", "膝痹", "腰痛", "软组织粘连"],
    sitesOrPoints: ["经影像、查体和专项评估确认的软组织病变靶点"],
    techniqueBoundary: "仅形成专科转介和排程参考；必须排除感染、肿瘤、骨折、凝血异常和进行性神经损害，不输出进刀层次或操作步骤。",
    scheduleSuggestion: "项目频次上限参考为每周1次；每次是否实施须由具备专项资质的医生重新评估。",
    sourceRefs: ["SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-TCM-INFECTION-CONTROL"],
    parameterCompleteness: "specialist_target_and_frequency_reference_governed_procedure_requires_exam",
  }]],
  ["auricular", [{
    id: "auricular-post-infection-respiratory-rehab",
    indicationTag: "respiratory",
    matchAny: ["恢复期", "咳嗽", "喘", "便秘"],
    sitesOrPoints: ["肺", "平喘", "神门", "大肠", "内分泌（按症状选择）"],
    techniqueBoundary: "皮肤破溃、过敏或瘢痕体质禁用；仅显示按压和更换频次，不输出侵入性埋针步骤。",
    scheduleSuggestion: "每日按压，每次1-2分钟；每3天更换。",
    sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020"],
    parameterCompleteness: "auricular_points_frequency_and_change_interval_governed",
  }, {
    id: "auricular-sleep-emotion-standard-points",
    indicationTag: "sleep_emotion",
    matchAny: ["失眠", "不寐", "入睡困难", "多梦", "易醒", "心悸", "焦虑"],
    sitesOrPoints: ["神门", "心", "皮质下", "枕", "脾（按证型加选）"],
    techniqueBoundary: "耳穴贴压为无创操作；耳廓皮肤破溃、冻疮、感染或过敏时禁用，妊娠期慎用。实际取穴由现场医师按辨证复核。",
    scheduleSuggestion: "单耳贴压、双耳交替；每日自行按压3-5次，每次1-2分钟；每3-5天更换一次。疗程由复评决定。",
    sourceRefs: ["SRC-SAMR-ACUPUNCTURE-OPS", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022"],
    parameterCompleteness: "auricular_points_and_press_frequency_governed",
  }, {
    id: "auricular-digestive-standard-points",
    indicationTag: "digestive",
    matchAny: ["胃脘", "腹胀", "纳差", "恶心", "呕吐", "便秘", "泄泻"],
    sitesOrPoints: ["脾", "胃", "神门", "交感", "大肠（便秘或泄泻时按症选择）"],
    techniqueBoundary: "先排除急腹症、消化道出血和腹膜刺激征等红旗；耳廓皮肤破损或感染时禁用。",
    scheduleSuggestion: "单耳贴压、双耳交替；每日按压3-5次，每次1-2分钟；每3-5天更换一次。",
    sourceRefs: ["SRC-SAMR-ACUPUNCTURE-OPS", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022"],
    parameterCompleteness: "auricular_points_and_press_frequency_governed",
  }, {
    id: "auricular-headache-standard-points",
    indicationTag: "headache",
    matchAny: ["头痛", "偏头痛", "头胀"],
    sitesOrPoints: ["神门", "皮质下", "枕", "额或颞（按疼痛部位选择）"],
    techniqueBoundary: "突发剧烈头痛、意识改变或局灶神经异常须先按神经急症处置，不得以耳穴替代评估。",
    scheduleSuggestion: "单耳贴压、双耳交替；每日按压3-5次，每次1-2分钟；每3-5天更换一次。",
    sourceRefs: ["SRC-SAMR-ACUPUNCTURE-OPS", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022"],
    parameterCompleteness: "auricular_points_and_press_frequency_governed",
  }]],
  ["diet_therapy", [{
    id: "diet-therapy-spleen-stomach-outpatient",
    indicationTag: "digestive",
    matchAny: ["纳差", "便溏", "腹胀", "脾虚", "食欲", "消化"],
    sitesOrPoints: [],
    techniqueBoundary: "食疗只作调护，不替代药物治疗；合并糖尿病、慢性肾病、吞咽障碍或食物过敏时须按专科饮食医嘱调整。",
    scheduleSuggestion: "随三餐日常调整，按复诊时症状变化复评；不设固定疗程。",
    sourceRefs: ["SRC-NATIONAL-MEDICAL-SERVICE-TCM"],
    parameterCompleteness: "dietary_scope_governed_no_invasive_parameter",
  }, {
    id: "diet-therapy-sleep-emotion-outpatient",
    indicationTag: "sleep_emotion",
    matchAny: ["失眠", "不寐", "入睡困难", "多梦", "心悸", "焦虑", "情志"],
    sitesOrPoints: [],
    techniqueBoundary: "以规律作息与晚间饮食节制为主；不得以食疗替代已判定需要的药物或专科干预。",
    scheduleSuggestion: "日常执行，复诊时按睡眠质量与伴随症状复评。",
    sourceRefs: ["SRC-NATIONAL-MEDICAL-SERVICE-TCM"],
    parameterCompleteness: "dietary_scope_governed_no_invasive_parameter",
  }]],
  ["mind_therapy", [{
    id: "mind-therapy-sleep-emotion-outpatient",
    indicationTag: "sleep_emotion",
    matchAny: ["失眠", "不寐", "入睡困难", "焦虑", "抑郁", "情志", "易怒", "紧张"],
    sitesOrPoints: [],
    techniqueBoundary: "情志调摄为辅助措施；出现自伤、自杀或严重行为危机线索时必须立即转精神科急诊，不得以意疗替代。",
    scheduleSuggestion: "日常执行；复诊时按情绪与睡眠变化复评，不设固定疗程。",
    sourceRefs: ["SRC-NATIONAL-MEDICAL-SERVICE-TCM"],
    parameterCompleteness: "counselling_scope_governed_no_invasive_parameter",
  }]],
  ["thread_embedding", [{
    id: "thread-embedding-obesity-specialist-assessment",
    indicationTag: "metabolic_rehabilitation",
    matchAny: ["肥胖", "体重管理"],
    sitesOrPoints: ["具体埋线穴位须经专科查体和辨证确认"],
    techniqueBoundary: "侵入性专科项目，仅形成适应证和转介评估；不得由系统给出埋线材料、深度或操作步骤。",
    scheduleSuggestion: "门诊排程参考为每2周1次，4-5次为一疗程；每次实施前均须专科复评。",
    sourceRefs: ["SRC-HORGOS-THREAD-EMBEDDING-2025", "SRC-SAMR-ACUPUNCTURE-OPS", "SRC-TCM-INFECTION-CONTROL"],
    parameterCompleteness: "specialist_frequency_reference_governed_points_require_exam",
  }]],
  ["bloodletting", [{
    id: "bloodletting-influenza-heat-excess-specialist",
    indicationTag: "respiratory",
    matchAny: ["流感", "热证", "实证"],
    sitesOrPoints: ["点刺或刺络部位须由专科医师按证型现场确定"],
    techniqueBoundary: "仅限热证、实证且完成出血风险、抗凝药和感染控制复核；不得用于替代高热、低氧或危重症处置。",
    scheduleSuggestion: "项目频次上限参考为每周2次至隔日1次；是否实施及实际间隔由专科医师决定。",
    sourceRefs: ["SRC-HUNAN-INFLUENZA-TCM-2025", "SRC-ZIBO-TCM-DAY-FREQUENCY-2022", "SRC-TCM-INFECTION-CONTROL"],
    parameterCompleteness: "specialist_indication_and_frequency_reference_governed_site_requires_exam",
  }]],
  ["qigong_daoyin", [{
    id: "qigong-post-infection-respiratory-rehab",
    indicationTag: "respiratory",
    matchAny: ["恢复期", "气短", "乏力", "呼吸康复"],
    sitesOrPoints: ["八段锦、太极拳、五禽戏或六字诀呼吸导引（按体能选择）"],
    techniqueBoundary: "遵循循序渐进；运动中出现胸痛、明显气促、头晕或血氧下降立即停止并评估。",
    scheduleSuggestion: "身体活动每日累计不少于30分钟；强度和分段方式按个体体能制定。",
    sourceRefs: ["SRC-BEIJING-COVID-TCM-REHAB-2020"],
    parameterCompleteness: "modality_frequency_and_daily_duration_governed",
  }]],
]);
// A plan template whose indicationTag is absent from its project's indicationTags is dead data:
// dominantIndicationTag() filters the tag out and the template can never surface. Declare the tag
// here rather than editing the generated catalog, and let the build assert the two stay consistent.
const indicationTagAugmentations = new Map([
  ["auricular", ["respiratory"]],
  ["bloodletting", ["respiratory"]],
]);
const treatmentEntries = TCM_TREATMENT_PROJECTS.map((project) => {
  const indicationTags = [...new Set([
    ...project.indicationTags,
    ...(indicationTagAugmentations.get(project.code) || []),
  ])];
  const protocolSourceRefs = exactStandard.get(project.code)
    || (acupunctureFamily.has(project.code)
      ? ["SRC-SAMR-ACUPUNCTURE-OPS", "SRC-TCM-INFECTION-CONTROL"]
      : ["SRC-NATIONAL-MEDICAL-SERVICE-TCM"]);
  const evidenceStatus = exactStandard.has(project.code)
    ? "official_standard_linked"
    : "category_governed_protocol_pending";
  const planTemplates = governedPlanTemplates.get(project.code) || [];
  const governedFrequencyTemplateAvailable = planTemplates.some((template) =>
    template.parameterCompleteness.includes("frequency") && Boolean(template.scheduleSuggestion.trim()));
  const patientSpecificParametersAllowed = planTemplates.length > 0 && !project.containsMedication;
  const coverageDisposition = planTemplates.length > 0
    ? project.containsMedication
      ? "source_template_registered_but_locked_pending_medication_audit"
      : project.risk === "specialist"
        ? "source_template_registered_for_specialist_assessment_only"
        : "source_template_registered_for_clinician_review"
    : project.containsMedication
      ? "medication_audit_required_no_unreviewed_patient_parameters"
      : project.risk === "specialist"
        ? "specialist_only_no_cross_indication_template"
        : project.code === "miscellaneous"
          ? "specific_project_identity_required"
          : "assessment_only_no_indication_protocol";
  return {
    projectCode: project.code,
    projectName: project.name,
    aliases: project.aliases,
    riskLevel: project.risk,
    indicationTags,
    containsMedication: project.containsMedication,
    requiresMedicationAudit: project.requiresMedicationAudit,
    operatorRequirement: project.operatorRequirement,
    safetyFocus: project.safetyFocus,
    evidenceStatus,
    protocolSourceRefs,
    recommendationMode: project.code === "miscellaneous"
      ? "not_recommendable_until_specific_project_identified"
      : project.risk === "specialist"
        ? "specialist_assessment_only"
        : "clinician_assessment_only",
    executable: false,
    governedParameterTemplateAvailable: planTemplates.length > 0,
    governedFrequencyTemplateAvailable,
    coverageDisposition,
    clinicianReviewRequired: true,
    patientSpecificParametersAllowed,
    parameterPolicy: patientSpecificParametersAllowed
      ? "仅在病例文字命中模板适应证且通过红旗、资质和禁忌复核时可显示治理过的穴位/部位与频次；不得跨适应证套用。"
      : project.containsMedication
        ? "含药外治即使存在来源模板，也必须先完成具体药物身份、处方和审方；未完成前不显示患者级操作参数。"
      : "无项目级适应证方案来源时仅输出评估方向，不显示患者级穴位、强度或疗程。",
    planTemplates,
  };
});

if (treatmentEntries.length !== 22 || new Set(treatmentEntries.map((item) => item.projectCode)).size !== 22) {
  throw new Error("T12 project coverage gate failed: runtime project-code contract must remain exactly 22");
}
if (treatmentEntries.some((item) => !item.coverageDisposition)) {
  throw new Error("T12 project coverage gate failed: every project requires an explicit coverage disposition");
}
const allPlanTemplates = treatmentEntries.flatMap((item) => item.planTemplates.map((template) => ({
  projectCode: item.projectCode,
  ...template,
})));
// 食疗/意疗 are governed modalities with no anatomical site and no fixed course; requiring a
// site or a frequency token would force fabricated parameters, which M04-08 forbids. They still
// must carry indication scope, an explicit review cadence and a registered source.
const siteFreeModalities = new Set(["diet_therapy", "mind_therapy"]);
if (allPlanTemplates.some((template) =>
  template.matchAny.length === 0 ||
  (!siteFreeModalities.has(template.projectCode) && template.sitesOrPoints.length === 0) ||
  (siteFreeModalities.has(template.projectCode) && template.sitesOrPoints.length > 0) ||
  !template.scheduleSuggestion.trim() ||
  template.sourceRefs.length === 0 ||
  !(template.parameterCompleteness.includes("frequency") || siteFreeModalities.has(template.projectCode)))) {
  throw new Error("T12 source template gate failed: every template requires indication, site/point, governed frequency and source");
}
// A template whose indicationTag is not declared by its project can never surface at runtime.
const deadTemplates = allPlanTemplates.filter((template) => {
  const entry = treatmentEntries.find((item) => item.projectCode === template.projectCode);
  return !entry?.indicationTags.includes(template.indicationTag);
});
if (deadTemplates.length > 0) {
  throw new Error(
    "T12 template reachability gate failed: indicationTag not declared by its project — "
    + deadTemplates.map((template) => `${template.projectCode}:${template.id}(${template.indicationTag})`).join("; "),
  );
}
const parameterizedProjects = treatmentEntries.filter((item) => item.patientSpecificParametersAllowed);
if (allPlanTemplates.length < 18 || parameterizedProjects.length < 10) {
  throw new Error(`T12 coverage gate failed: templates=${allPlanTemplates.length}, parameterizedProjects=${parameterizedProjects.length}`);
}
const acupunctureEntry = treatmentEntries.find((item) => item.projectCode === "acupuncture");
if (
  !acupunctureEntry ||
  acupunctureEntry.planTemplates.length < 8 ||
  acupunctureEntry.planTemplates.some((template) => !template.scheduleSuggestion.trim())
) {
  throw new Error("T12 acupuncture coverage gate failed");
}

const countBy = (values, key) => Object.fromEntries(
  [...new Set(values.map((item) => item[key]))].sort().map((value) => [value, values.filter((item) => item[key] === value).length]),
);
writeJson("tcm-nondrug-treatment-evidence-catalog.json", {
  schemaVersion: "tcm-nondrug-treatment-evidence-catalog-v2",
  governance: {
    status: "all_runtime_project_codes_governed",
    runtimePolicy: "有适应证级权威来源且病例文字命中时，可显示治理过的穴位/部位与频次并保持医生复核；无对应来源时仅生成评估卡片，不得套用患者级参数。",
    medicationPolicy: "含药外治项目必须同时通过中药身份与处方后审方。",
    sourceRefs: ["SRC-PROJECT-TREATMENT-CAPABILITY", "SRC-NATIONAL-MEDICAL-SERVICE-TCM", "SRC-TCM-INFECTION-CONTROL"],
  },
  summary: {
    projectCount: treatmentEntries.length,
    riskCounts: countBy(treatmentEntries, "riskLevel"),
    evidenceStatusCounts: countBy(treatmentEntries, "evidenceStatus"),
    medicationProjectCount: treatmentEntries.filter((item) => item.containsMedication).length,
    executableProjectCount: treatmentEntries.filter((item) => item.executable).length,
    planTemplateCount: treatmentEntries.reduce((total, item) => total + item.planTemplates.length, 0),
    parameterizedProjectCount: treatmentEntries.filter((item) => item.patientSpecificParametersAllowed).length,
    governedFrequencyProjectCount: treatmentEntries.filter((item) => item.governedFrequencyTemplateAvailable).length,
    explicitDispositionProjectCount: treatmentEntries.filter((item) => Boolean(item.coverageDisposition)).length,
    sourceTemplateProjectCount: treatmentEntries.filter((item) => item.planTemplates.length > 0).length,
  },
  entries: treatmentEntries,
});

console.log(JSON.stringify({
  sources: sources.length,
  requiredFieldPolicies: requiredFields.length,
  outputContracts: outputContracts.length,
  nonDrugProjects: treatmentEntries.length,
}));

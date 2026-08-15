// 甲方 2026-08 复测「临床四条」的确定性回归（2026-08-04）。
//
// 四条的共同形态是同一个病：**受治理数据一直躺在仓库里，运行时从来没读过它做判断**。
// 本项目此前已有两个同形铁证——方剂鉴别图 167 条边只喂提示词、中成药说明书 contraindication
// 字段召回层从不读取。本轮四条里有三条属于同一类：
//
//  ② 病名鉴别：tcm-disease-lexicon.json 1267 条每条都带 GB/T 15657-2021 层级编码，
//     这套编码**就是**「相邻病名」关系；clinical-terminology.ts 此前只用 canonical/aliases
//     建归一表，code 字段在运行时一次都没被读过 → 服务端无从要求也无从核验病名级鉴别。
//  ③ 病位主症锚：tcm-symptom-axis-map.source.json 是症状→病位的受治理映射，
//     61 条**全是伴随症状**，各科最高频的部位性主症（头痛/胃痛/腰痛/牙痛…）一条都没有
//     → 主症在受控词表里映射不到病位，病位只能由伴随症状反推。
//  ④ 治法病例绑定：tcm-treatment-principle-lexicon.json 1276 条里 956 条治法类术语的
//     relationPolicy 字面写着 method_requires_case_binding，而运行时唯一读取口
//     governedTreatmentPrinciplesInText **恰好把这 956 条全部过滤掉** → overallMethod
//     从来没有被任何受治理词表约束过，那句 requires_case_binding 从来没被核对过一次。
//
//  ① 西医依据混入病史叙述：不属于「数据没接入」，属于**判据缺一类**——
//     isNondiscriminatingWesternSupportingFact 是「什么可以充当西医诊断依据」的唯一判据，
//     它排除了中医四诊、人口学、正常生命体征三类，独缺「就诊经过」这一类。
//
// 本文件按**类**断言，不针对甲方那一个 case：每条都同时钉住正例（必须命中）、
// 反例（不得误伤）与 fail-open 边界（词表没收录时整条检查跳过）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { hasLocalArtifact } from "./lib/local-artifacts.mjs";

const { discriminatingWesternSupportClauses, isNondiscriminatingWesternSupportingFact, m03SemanticIssue } =
  await import("../src/lib/diagnosis-stage-contract.ts");
const { governedTcmDiseaseNeighbors, isGovernedTcmDiseaseName } = await import("../src/lib/clinical-terminology.ts");
const {
  governedTreatmentMethodsInText,
  governedTreatmentPrinciplesInText,
  treatmentMethodCoveredBy,
} = await import("../src/lib/clinical-governance-tables.ts");
const { chiefComplaintAnchor, locationItemsCoverChiefComplaintAnchor } =
  await import("../src/lib/tcm-chief-complaint-anchor.ts");
const { rejectionTier } = await import("../src/lib/diagnosis-rejection-tiers.ts");
const { structuredClinicalRepairHint } = await import("../src/lib/structured-clinical-repair.ts");

let checks = 0;
const check = (fn) => { fn(); checks += 1; };

// ─────────────────────────────────────────────────────────────────────────────
// ① 西医诊断依据不得是就诊经过 / 病史叙述
//
// 类边界（刻意划得窄而稳）：只覆盖「病人怎么来的」这一类整句与分句。
// 凡剥掉就诊过程与叙述框架后仍剩下症状、体征、数值、药名或疗效的句子，一律保留为有效依据——
// 这样它在结构上**不可能**删掉一条真实临床发现。主诉复述那一层由展示层去重负责，两层各管一类。
// ─────────────────────────────────────────────────────────────────────────────
const CARE_PROCESS_ONLY = [
  "患者未正规诊治",
  "未正规诊治",
  "遂来我院就诊",
  "为求进一步治疗来诊",
  "现患者及其家属为求进一步中医治疗，遂来我处",
  "医生建议患者精神科就诊",
  "患者于当地医院心内科门诊就诊完善相关检查后未见明显异常",
  "于外院门诊完善相关检查",
  "故来就诊",
  "今来我科门诊",
];
for (const fact of CARE_PROCESS_ONLY) {
  check(() => assert.equal(
    isNondiscriminatingWesternSupportingFact(fact),
    true,
    `纯就诊经过叙述不得充当西医诊断依据：${fact}`,
  ));
}

// 反例：临床发现、诊疗反应、检查数值、病程描述一律保留。诊疗反应（自服某药后缓解/无效）
// 尤其重要——那是有鉴别力的证据，不是就诊经过。
const CLINICAL_FINDING_FACTS = [
  "头痛隐隐，时发时止",
  "遇疲劳、遇风则加重",
  "伴头晕、心悸，神疲乏力",
  "小便清长，大便稀溏",
  "自服黄连上清丸及甲硝唑片后略有缓解，药效过后疼痛如故",
  "右侧下牙持续性胀痛，咀嚼时加剧",
  "近1年感冒约9次，感冒持续时间约10天左右",
  "血压160/100mmHg",
  "查血常规示血红蛋白 92g/L",
  "服用美托洛尔后心悸未见改善",
];
for (const fact of CLINICAL_FINDING_FACTS) {
  check(() => assert.equal(
    isNondiscriminatingWesternSupportingFact(fact),
    false,
    `有鉴别力的临床事实必须保留为西医诊断依据：${fact}`,
  ));
}

// 混合句：整句判据看到残余非空会整条放行，医生读到的仍是一段现病史。按分句剥离，
// 每个返回值仍是病历原文的**连续子串**（逐字可回溯不被破坏）。
check(() => assert.deepEqual(
  discriminatingWesternSupportClauses("发病后因患者自觉症状不重，未正规诊治，现患者觉头痛症状较前加重，故来就诊"),
  ["发病后因患者自觉症状不重", "现患者觉头痛症状较前加重"],
  "混合句里的就诊经过分句必须剥掉，临床分句必须逐字保留",
));
check(() => assert.deepEqual(
  discriminatingWesternSupportClauses("间断胸闷1年，加重3天，为求进一步治疗来诊"),
  ["间断胸闷1年", "加重3天"],
  "就诊经过缀在句尾时同样剥离",
));
check(() => assert.deepEqual(
  discriminatingWesternSupportClauses("反复咳嗽3天，遂来我院就诊"),
  ["反复咳嗽3天"],
  "两分句混合形态",
));
// 不含纯就诊经过分句的依据必须原样返回：拆分不得波及正常依据的粒度。
for (const intact of [
  "2+月前患者生产后出现头痛不适，头痛隐隐，时发时止，遇疲劳、遇风则加重，伴头晕、心悸，神疲乏力",
  "头痛2+月",
  "自服黄连上清丸及甲硝唑片后略有缓解，药效过后疼痛如故",
]) {
  check(() => assert.deepEqual(
    discriminatingWesternSupportClauses(intact),
    [intact],
    `不含就诊经过分句的依据必须原样返回，不得被拆细：${intact}`,
  ));
}
// 整条都是就诊经过时返回空——该条依据整体不可用。
check(() => assert.deepEqual(
  discriminatingWesternSupportClauses("现患者及其家属为求进一步中医治疗，遂来我处"),
  [],
  "整条都是就诊经过时不留任何依据",
));

// ─────────────────────────────────────────────────────────────────────────────
// ② 病名级鉴别（辨病再辨证）
//
// 类边界：相邻病名一律从 GB/T 15657 层级编码派生，不手写任何病名对照表。
// 取下位亚型 + 同级并列病名；**不取上位类目**（与自己所属的上位类目做鉴别是伪命题）。
// 同级按编码邻近度排序而非文件顺序——GB/T 在一个"系"下按临床亲缘成簇编号，
// 按文件顺序取前 N 条会拿到同系但毫无鉴别价值的病名。
// ─────────────────────────────────────────────────────────────────────────────
const NEIGHBOR_EXPECTATIONS = [
  // [病名, 必须出现的相邻病名, 说明]
  ["头痛", ["外感头痛", "内伤头痛", "厥头痛"], "头风病下位亚型：外感/内伤分流与真头痛急症排查"],
  ["头风病", ["外感头痛", "内伤头痛"], "正名与别名必须给出同一组相邻病名"],
  ["不寐", ["多寐病", "神劳病"], "睡眠病症簇，而不是同属心系病的胸痹心痛"],
  ["感冒", ["伤风", "时行感冒"], "普通感冒与时行感冒的分流直接改变处置"],
  ["瘾疹", ["土风疮"], "皮肤病下位亚型"],
  ["月经先期", ["月经后期", "月经过多"], "月经病同级并列"],
];
for (const [disease, expected, note] of NEIGHBOR_EXPECTATIONS) {
  const neighbors = governedTcmDiseaseNeighbors(disease).map((item) => item.canonical);
  for (const name of expected) {
    check(() => assert.ok(
      neighbors.includes(name),
      `${disease} 的受治理相邻病名应含「${name}」（${note}）；实得：${neighbors.join("、") || "(空)"}`,
    ));
  }
  check(() => assert.ok(
    neighbors.length > 0 && neighbors.length <= 8,
    `${disease} 的相邻病名条数必须有上限，避免修复提示变成词表倾倒；实得 ${neighbors.length}`,
  ));
  check(() => assert.equal(
    new Set(neighbors).size,
    neighbors.length,
    `${disease} 的相邻病名不得重复`,
  ));
}
// 编码邻近度排序的直接断言：不寐病 A04.01.13 的头部候选必须是神志睡眠簇，
// 不是同属心系病 A04.01 但编号远端的心脏病症。
check(() => {
  const top = governedTcmDiseaseNeighbors("不寐").slice(0, 4).map((item) => item.canonical);
  for (const cardiac of ["胸痹心痛", "真心痛", "高原胸痹", "心水病"]) {
    assert.ok(!top.includes(cardiac), `不寐的首选相邻病名不应是心脏病症「${cardiac}」：${top.join("、")}`);
  }
});
// 不取上位类目。
check(() => {
  for (const disease of ["感冒", "头痛", "不寐"]) {
    for (const item of governedTcmDiseaseNeighbors(disease)) {
      assert.notEqual(item.relation, "parent", `${disease} 的相邻病名不应包含上位类目：${item.canonical}`);
    }
  }
});
// fail-open：症状层临时诊断术语（胃痛/腰痛/牙痛/心悸）没有可鉴别的并列病名，返回空，检查整体跳过。
for (const symptomLevel of ["胃痛", "腰痛", "牙痛", "心悸"]) {
  check(() => assert.deepEqual(
    governedTcmDiseaseNeighbors(symptomLevel),
    [],
    `症状层临时术语不得凭空生成相邻病名：${symptomLevel}`,
  ));
}
check(() => assert.deepEqual(governedTcmDiseaseNeighbors("完全编造的病名"), [], "词表外病名返回空锚"));
check(() => assert.equal(isGovernedTcmDiseaseName("头痛"), true));
check(() => assert.equal(isGovernedTcmDiseaseName("气血两虚证"), false, "证型不是病名"));

// ─────────────────────────────────────────────────────────────────────────────
// ③ 主诉主症的受控病位锚
//
// 类边界（这一条最要紧）：只有**部位性主症**可以用来断言病位——头痛必然涉及头、
// 胃痛必然涉及胃，这是解剖必然性。证候轴召回映射（失眠→心、神疲→脾、盗汗→心肾）
// 回答的是「该症状常见于哪些脏腑的证候」，是召回先验而非病位的必要条件，
// 拿它断言会判错临床上完全成立的辨证（不寐辨为肾即心肾不交/肾阴虚）。
// ─────────────────────────────────────────────────────────────────────────────
const ANCHORED_CHIEF_COMPLAINTS = [
  ["头痛2+月", ["脑", "络脉", "经脉"], ["心", "脾"]],
  ["胃脘痛3天", ["胃"], ["肝", "脾"]],
  ["腰痛反复1年", ["肾", "骨"], ["肝"]],
  ["牙痛2天", ["胃", "骨"], ["心"]],
  ["皮肤瘙痒1周", ["皮毛"], ["肺", "脾"]],
];
for (const [complaint, anchorLabels, unrelatedItems] of ANCHORED_CHIEF_COMPLAINTS) {
  const anchor = chiefComplaintAnchor(`主诉：${complaint}`);
  check(() => assert.ok(anchor.locationIds.length > 0, `部位性主症必须解析出受控病位锚：${complaint}`));
  check(() => assert.deepEqual(
    anchor.locationLabels,
    anchorLabels,
    `病位锚的规范中文名必须从受治理词表读取，不在代码里写死：${complaint}`,
  ));
  check(() => assert.equal(
    locationItemsCoverChiefComplaintAnchor(unrelatedItems, anchor),
    false,
    `病位全部由伴随症状占据时必须判未覆盖：${complaint} → ${unrelatedItems.join("、")}`,
  ));
  // 只做加法：主病位在场时，模型另外给出的兼及病位一律不受限制。
  check(() => assert.equal(
    locationItemsCoverChiefComplaintAnchor([anchorLabels[0], ...unrelatedItems], anchor),
    true,
    `主病位在场即判覆盖，兼及病位照常保留：${complaint}`,
  ));
}
// 未受治理的部位写法（清窍/头窍）认不出——下游全部看不见，正是甲方那一例的形态。
check(() => {
  const anchor = chiefComplaintAnchor("主诉：头痛2+月");
  assert.equal(
    locationItemsCoverChiefComplaintAnchor(["脾", "心", "清窍"], anchor),
    false,
    "未受治理的病位写法不得当作主症病位已覆盖",
  );
  assert.equal(
    locationItemsCoverChiefComplaintAnchor(["脑窍", "心", "脾"], anchor),
    true,
    "受治理病位的复合表述（脑窍→脑）必须认得出",
  );
});
// fail-open 边界：功能性/全身性主症一律不产生病位锚，本层整体跳过。
for (const functional of ["失眠2个月", "乏力3周", "心悸1年", "纳差半月", "反复低热2周", "盗汗1个月"]) {
  const anchor = chiefComplaintAnchor(`主诉：${functional}`);
  check(() => assert.deepEqual(
    anchor.locationIds,
    [],
    `功能性主症不得用于断言病位（否则会判错心肾不交等成立的辨证）：${functional}`,
  ));
  check(() => assert.equal(
    locationItemsCoverChiefComplaintAnchor(["肾"], anchor),
    true,
    `空锚必须判覆盖（fail-open）：${functional}`,
  ));
}
check(() => assert.equal(
  locationItemsCoverChiefComplaintAnchor([], chiefComplaintAnchor("主诉：头痛2+月")),
  true,
  "病位为空由 location_classification_missing 负责，本层不重复报",
));

// ─────────────────────────────────────────────────────────────────────────────
// ④ 治法的病例绑定
//
// 类边界：按**治法族**（GB/T 16751.3 编号的父节点）而不是按条比对。
// 同族改写（养血安神 ↔ 养心安神）不是多出来的方向；整族在病机链里一个节点都没有，
// 才是甲方指出的"凭空追加"。上下位关系（疏肝清热 4.6.4.5.1.1 之于 清肝泄火 4.6.4.5.1）同样算覆盖。
// ─────────────────────────────────────────────────────────────────────────────
check(() => {
  const methods = governedTreatmentMethodsInText("养心安神");
  assert.equal(methods.length, 1, "养心安神必须命中受治理治法词表");
  assert.equal(
    methods[0].relationPolicy,
    "method_requires_case_binding",
    "治法层的 relationPolicy 就是词表自己声明的『必须绑定本例』",
  );
});
// 治则层与治法层是两个访问器，不得互相顶替：治则访问器**必须**过滤掉治法层，
// 这正是 956 条治法从未参与判断的机制。
check(() => assert.equal(
  governedTreatmentPrinciplesInText("养心安神").length,
  0,
  "治则访问器不返回治法层条目——这是本条根因的机制本体，改动它会静默改变 overallPrinciple 的判据",
));
check(() => assert.ok(
  governedTreatmentPrinciplesInText("虚则补之").length > 0,
  "治则访问器仍须认得治则层条目",
));
const methodOf = (text) => governedTreatmentMethodsInText(text);
check(() => assert.equal(
  treatmentMethodCoveredBy(methodOf("养心安神")[0], methodOf("养血安神")),
  true,
  "同族治法（安神法）互相覆盖，同义改写不得误报为凭空追加",
));
check(() => assert.equal(
  treatmentMethodCoveredBy(methodOf("疏肝清热")[0], methodOf("清肝泻火")),
  true,
  "上下位治法（编号互为前缀）互相覆盖",
));
check(() => assert.equal(
  treatmentMethodCoveredBy(methodOf("补益心脾")[0], methodOf("益气养血")),
  false,
  "不同族治法不得互相覆盖——补益心脾是独立方向，不能被补气顶替",
));
check(() => assert.equal(
  treatmentMethodCoveredBy(methodOf("养心安神")[0], methodOf("益气养血，和络止痛")),
  false,
  "整个安神族在病机链里一个节点都没有时必须判未绑定",
));

// ─────────────────────────────────────────────────────────────────────────────
// 端到端：四条不变式在完整 M03 载荷上的命中与放行
// ─────────────────────────────────────────────────────────────────────────────
const CUSTOMER_CASE = JSON.parse(fs.readFileSync(
  "scripts/fixtures/postpartum-headache-case.json",
  "utf8",
));
const CUSTOMER_FIELDS = CUSTOMER_CASE.fields;
/**
 * 病历字段 → 判据入参上下文。必须逐份构造：`m03SemanticIssue` 会先校验产出里的患者事实
 * 在上下文里有没有出处，**上下文与产出必须来自同一份病例**。
 *
 * 拿一份病例的上下文去判另一份的产出，先撞上的是 patient_fact_ungrounded_*，
 * 而不是本节想钉的 location_chief_symptom_anchor_missing——判据没坏，是喂错了料。
 */
function customerContextFromFields(fields) {
  return [
    `主诉：${fields["主诉"] ?? ""}`,
    `现病史：${fields["现病史"] ?? ""}`,
    `既往史：${fields["既往史"] ?? ""}`,
    `问诊补充：${fields["问诊补充"] ?? ""}`,
    `面象：${fields["面象"] ?? ""}`,
    `舌象：${fields["舌象"] ?? ""}`,
    `脉象：${fields["脉象"] ?? ""}`,
  ].join("\n");
}
const customerContext = customerContextFromFields(CUSTOMER_FIELDS);

// 一份四条全部满足的产后血虚头痛 M03：主病位含脑、病名鉴别到位、治法方向全部有节点承接。
const compliant = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "头痛",
    tcmDiseaseRationale: "以产后头痛隐隐、遇劳遇风加重为主症，病程2月余，属内伤范畴，故归入头风病，与眩晕、真头痛相区分。",
    tcmDiagnosticRationale: "头痛隐隐结合面色少华、舌质淡、脉细弱，支持气血两虚、清窍失养的工作判断。",
    tcmDiseaseDifferentials: [
      { diseaseName: "内伤头痛", reason: "产后起病、遇劳加重，需与外感头痛分流", distinguishingPoints: "本例病程2月余、无恶寒发热，符合内伤而非外感", nextCheck: null },
      { diseaseName: "厥头痛", reason: "头痛剧烈伴呕吐神昏属急重病名，须先排除", distinguishingPoints: "本例头痛隐隐、时发时止，无喷射性呕吐与意识障碍", nextCheck: "若出现剧烈头痛伴呕吐或意识改变，立即按急诊流程评估" },
    ],
    primarySyndrome: "气血两虚证",
    primarySyndromeBasis: ["头痛隐隐，时发时止", "面色少华，神疲"],
    tcmDifferentials: [],
    overallPathogenesis: "产后气血亏虚，清窍失养，脑络不荣，故头痛隐隐",
    recommendedFormulaDirection: "八珍汤加减",
    recommendedFormulaNames: ["八珍汤"],
    formulaSelectionMode: "single",
  },
  westernDiagnosis: {
    primary: {
      name: "头痛（病因待查）",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["头痛隐隐，时发时止", "遇疲劳、遇风则加重"],
      clinicalRationale: "遇疲劳、遇风则加重提示诱因相关性，结合病程逾2月且无红旗征，考虑良性头痛谱系；但血压与查体尚未完成，具体病因仍需鉴别。",
      limitations: ["未提供血压测量结果"],
      suggestedChecks: ["测量血压以排除高血压相关头痛"],
      evidence: { evidenceLevel: "model_inference", source: "基于本例已提供病史", confidence: "中" },
    },
    differentials: [],
  },
  pathogenesis: {
    locationDifferentiation: {
      items: ["脑", "脾", "心"],
      details: [{ location: "脑", basis: "头痛隐隐，时发时止" }],
      resolution: "bounded",
      resolutionReason: "病位判断基于四诊与病史，缺乏客观检查佐证",
    },
    chain: [
      { nodeId: "P1", patientFact: "头痛隐隐，时发时止", syndromeEvidence: "面色少华，神疲", pathogenesis: "气血亏虚，清窍失养，脑络不荣", therapyDirection: "益气养血，和络止痛", pathogenesisType: "主因", biaoBen: "本虚" },
      { nodeId: "P2", patientFact: "小便清长，大便稀溏", syndromeEvidence: "舌质淡，苔薄白", pathogenesis: "脾虚失运，气血生化不足", therapyDirection: "健脾益气", pathogenesisType: "兼因", biaoBen: "本虚" },
    ],
  },
  therapy: {
    overallPrinciple: "虚则补之",
    overallMethod: "益气养血，和络止痛，健脾益气",
    subTherapies: [
      { therapy: "益气养血，和络止痛", targetPathogenesis: "气血亏虚，清窍失养", priority: "主要" },
      { therapy: "健脾益气", targetPathogenesis: "脾虚失运，气血生化不足", priority: "次要" },
    ],
  },
  management: { followupSafetyNet: "若头痛突然加剧、出现呕吐或意识改变，请立即急诊就医" },
};

const mutate = (fn) => { const clone = structuredClone(compliant); fn(clone); return clone; };

check(() => assert.equal(
  m03SemanticIssue(compliant, customerContext),
  undefined,
  "四条全部满足的产后血虚头痛 M03 必须整体通过",
));

// ② 缺病名鉴别 / 把证型填进病名鉴别。
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.overview.tcmDiseaseDifferentials = []; }), customerContext),
  "tcm_disease_differentials_missing",
  "签名病名在词表中存在相邻病名却不给病名鉴别 → 命中",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.overview.tcmDiseaseDifferentials = [
      { diseaseName: "肝郁血虚证", reason: "产后情绪波动常见", distinguishingPoints: "本例未见善太息", nextCheck: null },
    ];
  }), customerContext),
  "tcm_disease_differential_not_a_disease",
  "把证型填进病名鉴别（辨病鉴别写成证候鉴别）→ 命中，这正是甲方原话指出的错位",
));
// 症状层病名（词表无相邻病名）时不要求，fail-open。
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.overview.tcmDiseaseName = "胃痛";
    r.overview.tcmDiseaseRationale = "以胃脘疼痛为主症、病程短且无呕血黑便，故归入胃痛范畴，与真心痛相区分。";
    r.overview.tcmDiseaseDifferentials = [];
  }), customerContext),
  undefined,
  "词表中无相邻病名的症状层病名不得强行要求病名鉴别（fail-open）",
));

// ③ 病位缺主症锚。
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.pathogenesis.locationDifferentiation.items = ["脾", "心"]; }), customerContext),
  "location_chief_symptom_anchor_missing",
  "病位全部由伴随症状占据（脾来自神疲、心来自心悸）→ 命中",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.pathogenesis.locationDifferentiation.items = ["脾", "心", "清窍"]; }), customerContext),
  "location_chief_symptom_anchor_missing",
  "未受治理的「清窍」不算主症病位已覆盖 → 仍命中",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.pathogenesis.locationDifferentiation.items = ["脑窍", "脾", "心", "肝", "肾"]; }), customerContext),
  undefined,
  "主病位在场时，兼及的肝脾肾一律不受限制（本层只做加法）",
));

// ④ 治法方向无病例绑定 / 主症无病机节点承接。
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.therapy.overallMethod = "益气养血，和络止痛，健脾益气，养心安神"; }), customerContext),
  "therapy_method_direction_unbound",
  "总治法多出一个整族都没有节点承接的方向（养心安神）→ 命中，这正是甲方原话「治法仍含养心安神」",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.therapy.overallMethod = "益气养血，和络止痛，健脾益气，养心安神";
    r.pathogenesis.chain.push({
      nodeId: "P3",
      patientFact: "伴头晕、心悸，神疲乏力",
      syndromeEvidence: "脉细弱",
      pathogenesis: "血不养心，心神失养",
      therapyDirection: "养血安神",
      pathogenesisType: "兼因",
      biaoBen: "本虚",
    });
    r.therapy.subTherapies.push({ therapy: "养血安神", targetPathogenesis: "血不养心，心神失养", priority: "次要" });
  }), customerContext),
  undefined,
  "同族方向（养血安神）有节点承接时，总治法写成养心安神属同义改写，不得误报",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.pathogenesis.chain = [{
      nodeId: "P1",
      patientFact: "小便清长，大便稀溏",
      syndromeEvidence: "舌质淡，苔薄白",
      pathogenesis: "脾虚失运，气血生化不足",
      therapyDirection: "益气养血，和络止痛",
      pathogenesisType: "主因",
      biaoBen: "本虚",
    }];
    r.therapy.subTherapies = [{ therapy: "益气养血，和络止痛", targetPathogenesis: "脾虚失运，气血生化不足", priority: "主要" }];
  }), customerContext),
  "therapy_chief_symptom_unaddressed",
  "整条病机链只讲伴随症状、主症无人承接 → 命中（兼症反客为主的确定性形态）",
));

// 分层：四条都是 T2——结论本身成立且已过接地与安全合同，缺的是「讲对/讲全」那一层，
// 一律带批注受理 + 修复提示，不作废整份 M03。
for (const reason of [
  "tcm_disease_differentials_missing",
  "tcm_disease_differential_not_a_disease",
  "location_chief_symptom_anchor_missing",
  "therapy_method_direction_unbound",
  "therapy_chief_symptom_unaddressed",
]) {
  check(() => assert.equal(
    rejectionTier(`m03_${reason}`),
    "T2",
    `${reason} 必须是 T2（带批注受理），不得作废整份 M03`,
  ));
  // 一条不带名字的修复指令是不可执行的：每个新驳回码都必须有对应的修复引导。
  const hint = structuredClinicalRepairHint("diagnose", `m03_${reason}`, []);
  check(() => assert.ok(
    typeof hint === "string" && hint.length > 60,
    `${reason} 必须有可执行的修复引导文案`,
  ));
}
// 修复提示必须带上服务端才知道的**真实候选名**（相邻病名 / 受控病位名），否则模型无从执行。
check(() => {
  const hint = structuredClinicalRepairHint(
    "diagnose",
    "m03_tcm_disease_differentials_missing",
    governedTcmDiseaseNeighbors("头痛").map((item) => item.canonical),
  );
  assert.ok(hint.includes("外感头痛"), "病名鉴别的修复提示必须逐字给出受治理相邻病名");
});
check(() => {
  const hint = structuredClinicalRepairHint(
    "diagnose",
    "m03_location_chief_symptom_anchor_missing",
    chiefComplaintAnchor("主诉：头痛2+月").locationLabels,
  );
  assert.ok(hint.includes("脑"), "病位锚的修复提示必须逐字给出受控病位名");
});

// ─────────────────────────────────────────────────────────────────────────────
// 甲方原始病例复现：仓库内固定保留一份去标识化的真实模型产出；本机若还保留
// artifacts 历史归档，则一并扫描。这样既保留真实缺陷形态，也保证 fresh clone 可复现。
// ─────────────────────────────────────────────────────────────────────────────
const CUSTOMER_RUNS = [
  ["committed-prod-20260804", "scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m03.json"],
  ["customer-cases-gold", "artifacts/customer-cases-gold/case-3.json"],
  ["customer-cases-exempt", "artifacts/customer-cases-exempt/case-3.json"],
  ["customer-cases-prod-m03par", "artifacts/customer-cases-prod-m03par/case-3.json"],
  ["customer-cases-prod-final", "artifacts/customer-cases-prod-final/case-3.json"],
  ["customer-cases-final2", "artifacts/customer-cases-final2/case-3.json"],
];
let reproduced = 0;
for (const [run, path] of CUSTOMER_RUNS) {
  // 只有 artifacts/ 下的**可选本机归档**受 CDSS_IGNORE_LOCAL_ARTIFACTS 屏蔽；
  // 已提交进仓库的 scripts/fixtures/ 夹具任何时候都要读，否则 fresh 态复现样本为 0，
  // 本节的「复现样本不足」断言会红——这条断言刚好抓住了第一版把两者一锅端的改动。
  const optional = path.startsWith("artifacts/");
  if (optional ? !hasLocalArtifact(path) : !fs.existsSync(path)) continue;
  const payload = JSON.parse(fs.readFileSync(path, "utf8"));
  const reasoning = payload.stages?.diagnose?.reasoning || (payload.stage === "diagnose" ? payload : undefined);
  if (!reasoning) continue;
  reproduced += 1;
  // 每份归档自带 fields，用它自己的上下文判它自己的产出。
  // 原来全部共用committed夹具的上下文：fresh clone 上只跑到那一份、恰好自洽所以绿；
  // 任何还留着 artifacts 历史归档的机器上，五份旧产出被拿新病例的上下文去judge，
  // 一律先撞 patient_fact_ungrounded 而红。绿或红取决于本机有没有那个目录——
  // 这类环境相关的判据比直接写错更难查，因为两边都"跑过测试"。
  const runContext = payload.fields ? customerContextFromFields(payload.fields) : customerContext;
  const issue = m03SemanticIssue(reasoning, runContext);
  check(() => assert.notEqual(
    issue,
    undefined,
    `甲方原始病例的历史缺陷产出必须被确定性判据抓住（${run}，该轮推出 ${reasoning.overview?.recommendedFormulaDirection}）`,
  ));
  check(() => assert.equal(
    issue,
    "location_chief_symptom_anchor_missing",
    `${run}：主症头痛的病位未进入病位辨证，正是治法与选方跟着兼症走的起点`,
  ));
}
check(() => assert.ok(reproduced >= 1, `甲方原始病例复现样本不足：仅 ${reproduced} 份`));

console.log(JSON.stringify({ checks, customerRunsReproduced: reproduced, failures: 0 }));

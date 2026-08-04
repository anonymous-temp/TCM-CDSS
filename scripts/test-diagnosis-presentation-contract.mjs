// 甲方 2026-08-04 复测「呈现层六条」的确定性回归。
//
// 六条各有各的根因，但共同点是**都发生在渲染边界之后**：结构化载荷里信息齐全，医生看到的
// 那一页却把它拼错了、压扁了、或者根本没分类。lib 层的既有套件断言的是函数返回值，
// 拦不住这一类；本文件按「医生实际看到的文本」断言。
//
// 每条都先在生产复现（https://…/tcm-cdss，2026-08-04），fixture 就是那两份原始载荷：
//   1.1.1 西医诊断下方复述主诉/现病史 —— 只有一行「支持依据」，内容是主诉与现病史逐字复述，
//         没有排除依据、没有待查依据、没有事实来源。
//   1.1.2 primary.name = 「头痛（症状性）」，医生页面逐字显示（归档里还有尿路感染/多汗症/
//         三叉神经痛四例同形，是一整类写法）。「（症状性）」在规范用法里是病因学限定，
//         挂在症状名后面把「病因不明」说成了「病因已知」。
//   1.2.1 中医诊断卡同时印「辨病：头风病」与「主症：产后2月余，头痛反复发作1月」，
//         后者就是主诉原句——甲方连续两轮指出的病史复述。
//   2.1   辨证推理是字段拼接：四诊要点与病位病性并排罗列却无对应关系，主诉与现病史各印一遍，
//         病机原文整段照抄自带句号，拼出「。，故辨为」。
//   7.1   方义解析是合法 Markdown 列表，却经 markdownCell（表格单元格渲染口，把 \n 压成空格）
//         输出，整段塌成一行；病机短引用被词内的「则」截断成「清窍失养，不荣」。
//   7.2   逐味各背一句对每张方逐字相同的关系模板（「为本方治疗支点」「同承接上述病机」）。
//   9.1   灸法卡片的「常用穴位」= 「按针刺方案中与当前证型匹配的穴位」——一句延期说明，不是穴位。
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  synchronizeVisibleClinicalSummary,
  alignNormalizedM03TcmDiagnosticRationale,
  westernDiagnosisLabelForDisplay,
} = await import("../src/lib/diagnosis-visible-summary.ts");
const {
  classifyWesternDiagnosticEvidence,
  clinicalFactSourcesFromCaseState,
  clinicalFactSourcesFromContext,
  clinicalFactWithSource,
} = await import("../src/lib/clinical-fact-source.ts");
const { buildFormulaAnalysis, formulaAnalysisCharBudget } = await import("../src/lib/herb-target-contract.ts");
const { TCM_TREATMENT_PROJECTS, tcmTreatmentTemplatePointsAreGoverned } =
  await import("../src/lib/tcm-treatment-projects.ts");

let checks = 0;
const check = (fn) => { fn(); checks += 1; };

const FIXTURE_DIR = "scripts/fixtures/chief-complaint-primacy";
const M03 = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/prod-20260804-postpartum-headache.m03.json`, "utf8"));
const M04 = JSON.parse(fs.readFileSync(`${FIXTURE_DIR}/prod-20260804-postpartum-headache.m04.json`, "utf8"));
// 生产病历接地正文（该例无 HIS 快照，主诉在首行且不带标签，与 clinicalGroundingText 的形态一致）。
const CONTEXT = [
  "产后2月余，头痛反复发作1月",
  "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
  "既往史：否认高血压、糖尿病病史",
  "舌象：舌淡苔薄白",
  "脉象：脉细弱",
].join("\n");
const CASE_STATE = {
  chiefComplaint: "产后2月余，头痛反复发作1月",
  symptoms: {
    现病史: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
    既往史: "否认高血压、糖尿病病史",
  },
  tongue: "舌淡苔薄白",
  pulse: "脉细弱",
};

const sentinel = (payload) =>
  `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->\n`;
const visibleOf = (payload, stage, context = "") =>
  synchronizeVisibleClinicalSummary(sentinel(payload), stage, context).split("<!-- DIAGNOSIS_JSON_START -->")[0];

// ─────────────────────────────────────────────────────────────────────────────
// 1.1.1 支持依据 / 排除依据 / 待查依据 三类 + 事实来源
// ─────────────────────────────────────────────────────────────────────────────
const m03WithChartFacts = structuredClone(M03);
m03WithChartFacts.westernDiagnosis.primary.supportingFacts = [
  "产后2月余，头痛反复发作1月",
  "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
  "否认高血压、糖尿病病史",
];

check(() => {
  const evidence = classifyWesternDiagnosticEvidence(m03WithChartFacts.westernDiagnosis.primary);
  assert.equal(evidence.supporting.length, 2, "两条阳性事实留在支持依据");
  assert.deepEqual(evidence.excluding, ["否认高血压、糖尿病病史"],
    "否定极性的事实是排除依据，混在支持依据里读起来像在支持诊断");
  assert.ok(evidence.pending.length > 0, "资料限制与建议检查合成待查依据");
  assert.ok(evidence.pending.some((item) => item.includes("血压")), "建议检查必须进入待查依据");
});
// 极性判定必须走确定性极性层：非明确否定一律留在支持依据（宁少归一条排除，不误读一条阳性）。
check(() => {
  const evidence = classifyWesternDiagnosticEvidence({ supportingFacts: ["尚未确认有无呕吐", "头痛反复发作1月"] });
  assert.equal(evidence.excluding.length, 0, "「尚未确认」不是否定，不得当排除依据");
  assert.equal(evidence.supporting.length, 2);
});
check(() => assert.deepEqual(
  classifyWesternDiagnosticEvidence(null),
  { supporting: [], excluding: [], pending: [] },
  "空载荷返回三个空类，不抛错",
));

const visibleM03 = visibleOf(m03WithChartFacts, "diagnose", CONTEXT);
for (const label of ["支持依据", "排除依据", "待查依据"]) {
  check(() => assert.ok(visibleM03.includes(`**${label}**`), `西医诊断段必须出现「${label}」`));
}
check(() => assert.ok(
  /\*\*支持依据\*\*：[^\n]*（来源：主诉）/.test(visibleM03),
  "主诉级事实必须标注来源，而不是裸复述主诉",
));
check(() => assert.ok(
  /\*\*支持依据\*\*：[^\n]*（来源：现病史）/.test(visibleM03),
  "现病史级事实必须标注来源",
));
check(() => assert.ok(
  /\*\*排除依据\*\*：[^\n]*（来源：既往史）/.test(visibleM03),
  "否认既往病史的事实来源是既往史",
));
// 待查依据是「尚缺什么/下一步查什么」，不是病历事实，标来源没有意义。
check(() => assert.ok(
  !/\*\*待查依据\*\*：[^\n]*（来源：/.test(visibleM03),
  "待查依据不得标事实来源",
));
// fail-open：不传接地正文时三类照常呈现，只是不带来源标注。
check(() => {
  const withoutContext = visibleOf(m03WithChartFacts, "diagnose");
  assert.ok(withoutContext.includes("**支持依据**"), "无接地正文时三类仍呈现");
  assert.ok(!withoutContext.includes("（来源："), "无接地正文时不编造来源");
});
// 来源解析：接地正文与病例状态两条路径必须给出同样的字段归属。
check(() => {
  const fromContext = clinicalFactSourcesFromContext(CONTEXT);
  const fromState = clinicalFactSourcesFromCaseState(CASE_STATE);
  const label = (sources, fact) => clinicalFactWithSource(fact, sources);
  assert.ok(label(fromContext, "产后2月余，头痛反复发作1月").includes("（来源：主诉）"));
  assert.ok(label(fromState, "产后2月余，头痛反复发作1月").includes("（来源：主诉）"));
  assert.ok(label(fromState, "否认高血压、糖尿病病史").includes("（来源：既往史）"),
    "病例状态里 symptoms 的中文键名即受治理字段名，必须据此归属");
  assert.equal(label(fromState, "查无此事的一条依据"), "查无此事的一条依据",
    "归属不到来源时原样返回（fail-open，不删依据也不编来源）");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.1.2 诊断名规范化：非规范括注后缀一律收敛为「X，病因待查」
// ─────────────────────────────────────────────────────────────────────────────
for (const [raw, expected] of [
  ["头痛（症状性）", "头痛，病因待查"],   // ← 生产实测原文
  ["头痛(症状性)", "头痛，病因待查"],
  ["头痛症状", "头痛，病因待查"],
  ["头痛（待查）", "头痛，病因待查"],
  ["头痛（病因待查）", "头痛，病因待查"],
  ["头痛（病因待鉴别）", "头痛，病因待查"],
  ["头痛待因", "头痛，病因待查"],
  ["尿路感染（症状性）", "尿路感染，病因待查"],
  ["三叉神经痛（症状性）", "三叉神经痛，病因待查"],
]) {
  check(() => assert.equal(westernDiagnosisLabelForDisplay(raw), expected, `${raw} → ${expected}`));
}
// 规范诊断名原样保留——本层只收敛症状级限定，不改写任何成立的诊断。
for (const intact of ["社区获得性肺炎", "2型糖尿病", "原发性高血压", "偏头痛"]) {
  check(() => assert.equal(westernDiagnosisLabelForDisplay(intact), intact, `${intact} 必须原样保留`));
}
check(() => assert.equal(westernDiagnosisLabelForDisplay(""), "", "空标签返回空"));
check(() => assert.equal(westernDiagnosisLabelForDisplay(null), "", "非字符串返回空"));
// 有 ICD-10 编码时以编码名称为规范诊断名（编码由服务端确定性关联，不是模型措辞）。
check(() => assert.equal(
  westernDiagnosisLabelForDisplay("头痛（症状性）", { code: "R51.x00", display: "头痛" }),
  "头痛，病因待查",
));
// 编码歧义（编码名称与本标签核心不同）时不得改写诊断。
check(() => assert.equal(
  westernDiagnosisLabelForDisplay("紧张型头痛", { code: "G44.200", display: "偏头痛" }),
  "紧张型头痛",
  "编码名称与标签核心不一致时保留模型标签，不得替换成另一个疾病",
));
check(() => {
  const withNonStandard = structuredClone(M03);
  withNonStandard.westernDiagnosis.primary.name = "头痛（症状性）";
  const visible = visibleOf(withNonStandard, "diagnose", CONTEXT);
  assert.ok(visible.includes("**诊断倾向**：头痛，病因待查"), "医生可见行必须是规范形态");
  assert.ok(!visible.includes("（症状性）"), "「（症状性）」不得出现在医生可见正文");
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.2.1 中医诊断卡只保留证候结论
// ─────────────────────────────────────────────────────────────────────────────
check(() => {
  const overviewBlock = visibleM03.split("## 中医诊断概览")[1].split("###")[0];
  assert.ok(overviewBlock.includes("**证型**"), "证候结论必须保留在概览卡里");
  assert.ok(!overviewBlock.includes("**中医病名**"), "病名不再挤在证候卡里");
  assert.ok(!overviewBlock.includes(M03.overview.primarySyndromeBasis[0]),
    "主诉原句（病史复述）不得出现在证候卡里");
});
check(() => {
  assert.ok(visibleM03.includes("### 中医辨病"), "病名移入独立的辨病段");
  assert.ok(visibleM03.includes(`**中医病名**：${M03.overview.tcmDiseaseName}`), "病名本身不得丢失");
  assert.ok(visibleM03.includes("**辨病推理**："), "辨病推理与病名归在同一处");
});
// 病名缺失时不留空段。
check(() => {
  const noDisease = structuredClone(M03);
  noDisease.overview.tcmDiseaseName = "";
  noDisease.overview.tcmDiseaseRationale = "";
  noDisease.overview.tcmDiseaseDifferentials = [];
  assert.ok(!visibleOf(noDisease, "diagnose", CONTEXT).includes("### 中医辨病"), "无病名时不输出空辨病段");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.1 辨证推理必须有实质内容（四诊要点 → 病位病性各自的依据 → 病机 → 证型）
// ─────────────────────────────────────────────────────────────────────────────
const projectedRationale = (() => {
  const payload = structuredClone(M03);
  payload.overview.tcmDiagnosticRationale = "";
  const out = alignNormalizedM03TcmDiagnosticRationale(sentinel(payload));
  return JSON.parse(out.match(/START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END/)[1].trim())
    .overview.tcmDiagnosticRationale;
})();
check(() => assert.ok(
  /病位在[^，。]*（据[^）]+）/.test(projectedRationale),
  "每条病位必须点名支持它的四诊要点，否则就是字段并排罗列而非推理",
));
check(() => assert.ok(
  /病性属[^，。]*（据[^）]+）/.test(projectedRationale),
  "病性同样必须带依据",
));
check(() => assert.ok(
  projectedRationale.includes("心（据") && /失眠|心悸/.test(projectedRationale),
  "心悸失眠 → 心，这条归属取自受治理症状—轴映射",
));
check(() => assert.ok(
  !/[。；]，/.test(projectedRationale),
  "不得出现「。，故辨为」这类破碎标点（病机原文自带句号直接拼接的结果）",
));
check(() => {
  const chiefComplaint = M03.overview.primarySyndromeBasis[0];
  const occurrences = projectedRationale.split(chiefComplaint).length - 1;
  assert.ok(occurrences <= 1, `同一条事实不得复述两遍（出现 ${occurrences} 次）`);
});
check(() => assert.ok(
  projectedRationale.endsWith("。") && projectedRationale.includes("故辨为"),
  "推理链仍以证型归属收尾",
));

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 / 7.2 方义解析的格式与长度
// ─────────────────────────────────────────────────────────────────────────────
const candidate = M04.formula.candidates[0];
const analysis = buildFormulaAnalysis(
  candidate.herbs.map((herb) => ({
    name: herb.name, role: herb.role, function: herb.function, targetPathogenesis: herb.targetPathogenesis,
  })),
  candidate.therapyMatch,
);
check(() => assert.ok(analysis.includes("\n- "), "逐味行必须是真的 Markdown 列表行"));
check(() => assert.ok(
  analysis.includes("不荣则痛"),
  "病机短引用不得被词内的「则」截断——生产实测被砍成「清窍失养，不荣」",
));
check(() => {
  const groups = analysis.split("\n").filter((line) => /^\*\*.+\*\*$/.test(line));
  assert.ok(groups.length >= 2, "病机作分组标题呈现");
  assert.equal(new Set(groups).size, groups.length, "同一条病机只作一次标题，不逐味重复");
});
for (const boilerplate of ["为本方治疗支点", "同承接上述", "承接次级病机", "协同君药同治"]) {
  check(() => assert.ok(
    !analysis.includes(boilerplate),
    `「${boilerplate}」对每张方逐字相同，不携带本例信息，不得逐味重复`,
  ));
}
check(() => {
  const budget = formulaAnalysisCharBudget(candidate.herbs.length);
  assert.ok(analysis.length <= budget, `方义 ${analysis.length} 字 > ${candidate.herbs.length} 味方预算 ${budget} 字`);
  assert.ok(analysis.length < candidate.formulaAnalysis.length,
    `必须短于生产原文（原 ${candidate.formulaAnalysis.length} 字，现 ${analysis.length} 字）`);
});
// 逐味粒度不得因为压缩而丢失：每一味药都必须仍有自己的一行。
check(() => {
  for (const herb of candidate.herbs) {
    assert.ok(analysis.includes(`- ${herb.name}（`), `${herb.name} 必须仍有独立一行`);
  }
});
// 7.1 的另一半：渲染口。方义是段落不是表格单元格，换行必须活着到医生页面上。
check(() => {
  const payload = structuredClone(M04);
  payload.formula.candidates[0].formulaAnalysis = analysis;
  const visible = visibleOf(payload, "prescribe");
  const section = visible.split("### 方义分析")[1];
  assert.ok(section.includes("\n- "), "Markdown 报告里方义解析必须保留换行，不得塌成一段");
});

// ─────────────────────────────────────────────────────────────────────────────
// 9.1 推荐治疗项目的常用穴位必须是穴位
// ─────────────────────────────────────────────────────────────────────────────
const templateById = new Map(
  TCM_TREATMENT_PROJECTS.flatMap((project) => project.planTemplates.map((template) => [template.id, template])),
);
for (const id of [
  "moxibustion-influenza-hunan-2025",                    // 「按针刺方案中与当前证型匹配的穴位」
  "thread-embedding-obesity-specialist-assessment",      // 「具体埋线穴位须经专科查体和辨证确认」
  "bloodletting-influenza-heat-excess-specialist",       // 「点刺或刺络部位须由专科医师按证型现场确定」
]) {
  check(() => assert.equal(
    tcmTreatmentTemplatePointsAreGoverned(templateById.get(id)),
    false,
    `${id} 的 sitesOrPoints 是延期说明，目录自己在 parameterCompleteness 里声明过`,
  ));
}
// 精确定位需查体 ≠ 取穴未治理：局部阿是穴 + 循经远端穴是受治理的取穴范围，必须照常呈现。
check(() => assert.equal(
  tcmTreatmentTemplatePointsAreGoverned(templateById.get("acupuncture-musculoskeletal-common-outpatient")),
  true,
  "exact_points_require_exam 给出的是受治理取穴范围，不得被误判为未治理",
));
// 类断言（不针对那三条模板）：凡目录在 parameterCompleteness 里声明取穴/部位尚未治理的模板，
// 一律不得被判为已治理取穴。判据读的是目录字段，词表升级新增同类模板时本条自动覆盖。
check(() => {
  const allTemplates = TCM_TREATMENT_PROJECTS.flatMap((project) => project.planTemplates);
  const deferring = allTemplates.filter((template) => {
    const completeness = String(template.parameterCompleteness || "");
    if (completeness.endsWith("exact_points_require_exam")) return false;
    return /(?:points_require_syndrome_selection|points_require_exam|site_requires_exam)$/.test(completeness);
  });
  assert.ok(deferring.length >= 3, "目录里确实存在这一类模板（本判据的现实依据）");
  assert.deepEqual(
    deferring.filter(tcmTreatmentTemplatePointsAreGoverned).map((template) => template.id),
    [],
    "声明取穴未治理的模板不得进入「常用穴位」聚合",
  );
});
// 端到端形态：灸法的常用穴位聚合池里不得再出现那句跨方案指引。
check(() => {
  const moxibustion = TCM_TREATMENT_PROJECTS.find((project) => project.code === "moxibustion");
  const pool = moxibustion.planTemplates
    .filter(tcmTreatmentTemplatePointsAreGoverned)
    .flatMap((template) => template.sitesOrPoints);
  assert.ok(!pool.includes("按针刺方案中与当前证型匹配的穴位"),
    "生产实测那句「按针刺方案中与当前证型匹配的穴位」不得再作为常用穴位呈现");
  assert.ok(pool.length > 0, "排除延期说明后灸法仍有可呈现的受治理部位，不能把整栏清空");
});

console.log(`diagnosis-presentation-contract: ${checks} checks passed`);

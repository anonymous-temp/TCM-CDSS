// 普通咳嗽·风寒袭肺证模板的**端到端**验证（2026-08-11 中医师签字启用后补）。
//
// 为什么单开一套：test:common-cough-template 打的是纯函数（闸门判据、条件加穴、逐穴溯源），
// 而这条特性真正容易出错的地方在**接线**——
//   · currentFacts 有没有从 compileTcmTreatmentRecommendations 一路传到闸门
//     （传成 caseFacts 就会让「既往咳嗽」把病例带进来，那正是裁定点名要排除的）；
//   · 条件加穴有没有真的进 suggestedSitesOrPoints，还是只在 provenance 里；
//   · 签字后 protocolStatus / tailoringStatus / protocolGap 三者是不是同一个判据。
// 纯函数全绿而接线错了，线上就是"改了还是老样子"——这个仓库为此吃过亏。
//
// isTrustedM03 只校验签名的**形状**（版本号 + hmac-sha256:<64hex> 正则），不验 HMAC 本身，
// 因此这里可以构造一份合成的已签名 M03 走完真实编排路径。
import assert from "node:assert/strict";

process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture";

const { compileTcmTreatmentRecommendations } =
  await import("../src/lib/tcm-treatment-capabilities.server.ts");
const { tcmTreatmentTailoringPresentation } = await import("../src/lib/diagnosis-visible-summary.ts");
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

const signedPrior = (syndrome, pathogenesis, therapy) => ({
  stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v4",
  contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: {
    primarySyndrome: syndrome,
    overallPathogenesis: pathogenesis,
  },
  // 编排层读 westernDiagnosis.primary.name 拼「本例临床文本」，缺了会抛。
  westernDiagnosis: { primary: { name: "急性支气管炎", status: "working_diagnosis", supportingFacts: [] } },
  therapy: { overallPrinciple: therapy, overallMethod: therapy },
  pathogenesis: {
    chain: [{
      nodeId: "P1",
      patientFact: "咳嗽、痰白稀、恶寒无汗",
      syndromeEvidence: syndrome,
      pathogenesis,
      therapyDirection: therapy,
    }],
  },
});

const caseStateFor = (chiefComplaint, presentHistory, pastHistory = "", extra = {}) => ({
  chiefComplaint,
  symptoms: { presentHistory },
  pastHistory,
  // 裁定适用范围是成人；不给年龄的病例一律不启用（见 minAgeYears 的 fail-closed 方向）。
  patient: { age: 42, sex: "男" },
  clinicTreatmentCapabilities: ["acupuncture"],
  safetyGate: { status: "ready" },
  ...extra,
});

const compile = (caseState, prior) =>
  compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], prior, caseState)
    .find((item) => item.projectCode === "acupuncture");

const WIND_COLD = signedPrior("风寒袭肺证", "风寒袭肺，肺气失宣", "疏风散寒、宣肺止咳");
const bare = (points) => points.map((point) => point.replace(/（[^）]*）/g, "").trim());

check("① 风寒咳嗽 + 鼻塞流清涕：走受治理模板，含列缺、风门、合谷、风池", () => {
  const item = compile(
    caseStateFor("咳嗽5天", "5天前受凉后出现咳嗽，痰白清稀，恶寒无汗，鼻塞流清涕。"),
    WIND_COLD,
  );
  assert.ok(item, "针刺项目未出现在结果里");
  const points = bare(item.suggestedSitesOrPoints);
  assert.deepEqual(
    points,
    ["肺俞", "中府", "列缺", "太渊", "风门", "合谷", "风池"],
    `候选穴位与裁定不符：${item.suggestedSitesOrPoints.join("、")}`,
  );
  // 风池必须带得出"是被什么带进来的"，否则医生无从判断它该不该用。
  const fengchi = item.suggestedSitesOrPoints.find((point) => point.startsWith("风池"));
  assert.ok(/鼻窍或头项症状时加用/.test(fengchi), `风池缺触发说明：${fengchi}`);
  // 签字后：闸门准入条件本身含"已签名证型 + 已终审"，因此算患者级方案。
  assert.equal(item.protocolStatus, "governed_patient_specific_plan");
  assert.equal(item.tailoringStatus, "syndrome_tailored");
  assert.equal(item.protocolGap, undefined, "已按证型选定的方案不应再报 protocolGap");
  assert.equal(item.deferredGovernedTemplate, undefined, "已签字就不该再挂待签字说明");
  // 频次不得照搬流感专项方案。
  assert.ok(!/每次\s*30\s*分钟/.test(item.scheduleSuggestion), `排程照搬了流感方案：${item.scheduleSuggestion}`);
});

check("② 风寒咳嗽、无鼻窍/头项症状：不加风池", () => {
  const item = compile(
    caseStateFor("咳嗽3天", "3天前受凉后咳嗽，痰白清稀，恶寒无汗，无鼻塞流涕，无头痛项强。"),
    WIND_COLD,
  );
  const points = bare(item.suggestedSitesOrPoints);
  assert.deepEqual(points, ["肺俞", "中府", "列缺", "太渊", "风门", "合谷"], `不应加风池：${points.join("、")}`);
});

check("③ 仅有既往咳嗽（本次无咳嗽）：不得命中本模板", () => {
  // 这一条正是「currentFacts 传成 caseFacts」会踩的坑：既往史里有咳嗽，当前主诉没有。
  const item = compile(
    { ...caseStateFor("鼻塞流清涕2天", "2天前受凉，鼻塞流清涕，无咳嗽。", "既往慢性咳嗽病史3年。") },
    WIND_COLD,
  );
  if (item) {
    const points = bare(item.suggestedSitesOrPoints);
    assert.notDeepEqual(
      points.slice(0, 6),
      ["肺俞", "中府", "列缺", "太渊", "风门", "合谷"],
      "既往咳嗽把病例带进了普通风寒咳嗽模板——currentFacts 很可能被传成了 caseFacts",
    );
    assert.notEqual(item.protocolStatus, "governed_patient_specific_plan", "不该形成患者级方案");
  }
});

check("④ 风热咳嗽：不得命中风寒模板", () => {
  const item = compile(
    caseStateFor("咳嗽4天", "4天前起咳嗽，痰黄黏稠，咽痛口渴，微恶风。"),
    signedPrior("风热犯肺证", "风热犯肺，肺失清肃", "疏风清热、宣肺止咳"),
  );
  if (item) {
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(
      !(points.includes("中府") && points.includes("风门") && points.includes("太渊")),
      `风热证拿到了风寒模板取穴：${points.join("、")}`,
    );
  }
});

check("⑤ 流感：不得命中本模板（既有流感专项方案的适应证不得被扩大）", () => {
  const item = compile(
    caseStateFor("流行性感冒3天", "确诊流行性感冒3天，咳嗽，恶寒重发热轻，全身酸痛。"),
    signedPrior("风寒束表证", "风寒束表；风寒袭肺", "解表散寒"),
  );
  if (item) {
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(!points.includes("中府"), `流感例拿到了普通咳嗽模板取穴：${points.join("、")}`);
  }
});

// 对抗性复核（2026-08-11）抓到的一条：patient-specific 这一档三处措辞一律写「按证型加减」，
// 而「加减」断言的是**在基础方上做过增删**这个动作。证型专用模板整条按证型选中、没有加减穴，
// 写成加减就是告诉医生系统做过一件它没做的事。
check("证型专用模板不得被说成「按证型加减」，而证型加减仍照旧", () => {
  const item = compile(
    caseStateFor("咳嗽5天", "5天前受凉后咳嗽，痰白清稀，恶寒无汗，鼻塞流清涕。"),
    WIND_COLD,
  );
  const presentation = tcmTreatmentTailoringPresentation(item);
  for (const text of [presentation.status, presentation.pointsLabel, presentation.badge]) {
    assert.ok(!/加减/.test(text), `证型专用模板被说成了加减：${text}`);
    assert.ok(/证型专用/.test(text), `措辞未说清这是证型专用方案：${text}`);
  }
  assert.ok(/条件加穴/.test(presentation.pointsLabel), "本例触发了风池，标题应说明含条件加穴");

  // 反向护栏：真正做过证型加减的方案，措辞一个字都不能变。
  const refined = tcmTreatmentTailoringPresentation({
    protocolStatus: "governed_patient_specific_plan",
    pointProvenance: [{ role: "base_point" }, { role: "syndrome_refinement" }],
  });
  assert.equal(refined.badge, "按证型加减 · 待复核");
  assert.equal(refined.pointsLabel, "按本例证型加减后的候选穴位");

  // 后台状态投影仍供 HIS/审计消费；两个医生可见出口只消费最小临床投影，不能再展开状态措辞。
  for (const outlet of ["src/lib/diagnosis-visible-summary.ts", "src/app/diagnosis/DiagnosisClient.tsx"]) {
    const source = readFileSync(fileURLToPath(new URL(`../${outlet}`, import.meta.url)), "utf8");
    assert.ok(source.includes("buildClinicianTreatmentProjects"), `${outlet} 未使用医生端共享投影`);
    assert.ok(!source.includes("按本例证型加减后的候选穴位："), `${outlet} 仍在自拼加减措辞`);
  }
});

// ── 2026-08-11 对抗性复核确认的 6 条闸门缺陷，逐条按其原始触发输入钉住 ──────────
check("复核①：已签名结论以「鉴别 / 病机演变」口吻提到风寒袭肺，不得开闸", () => {
  for (const [syndrome, evidence] of [
    ["痰湿蕴肺证", "痰多色白黏腻、舌苔白腻；本证与风寒袭肺证鉴别要点在于痰多黏腻、病程较长"],
    ["痰湿蕴肺证", "初起风寒袭肺，失于宣散，日久聚湿生痰，痰湿蕴肺，肺失宣降"],
    ["寒饮伏肺证", "素有伏饮，复因风寒袭肺引动"],
    ["痰热壅肺证", "风寒袭肺入里化热"],
  ]) {
    const prior = signedPrior(syndrome, evidence, "宣肺化痰");
    const item = compile(caseStateFor("咳嗽反复2月", "咳嗽2月，痰多色白黏腻，胸闷纳呆，舌苔白腻。"), prior);
    if (!item) continue;
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(
      !(points.includes("中府") && points.includes("风门")),
      `「${syndrome}」拿到了风寒模板取穴：${points.join("、")}`,
    );
    assert.notEqual(item.protocolStatus, "governed_patient_specific_plan", `「${syndrome}」不该形成患者级方案`);
  }
});

check("复核②：「发病以来无明显发热及咳嗽」——跨字否定必须拦住", () => {
  for (const history of [
    "3天前受凉起病，鼻塞流清涕，发病以来无明显发热及咳嗽。",
    "患者近期无明显发热及咳嗽，仅鼻塞流清涕。",
  ]) {
    const item = compile(caseStateFor("鼻塞流清涕3天", history), WIND_COLD);
    if (!item) continue;
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(!points.includes("中府"), `病历写着「无…咳嗽」却拿到咳嗽方案：${points.join("、")}`);
    assert.notEqual(item.protocolStatus, "governed_patient_specific_plan");
  }
});

check("复核③：裁定适用范围是成人——婴幼儿与年龄缺失一律不启用", () => {
  for (const age of ["8个月", "4岁", 4, undefined]) {
    const caseState = caseStateFor("咳嗽3天", "3天前受凉后咳嗽，痰白清稀，恶寒无汗。", "", {
      patient: age === undefined ? {} : { age },
    });
    const item = compile(caseState, WIND_COLD);
    if (!item) continue;
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(
      !(points.includes("中府") && points.includes("肺俞")),
      `年龄=${age} 拿到了成人方案（中府/肺俞在小儿是气胸风险穴）：${points.join("、")}`,
    );
    assert.notEqual(item.protocolStatus, "governed_patient_specific_plan", `年龄=${age} 不该形成患者级方案`);
  }
  // 成人照常启用——收紧不得把正当病例一并挡掉。
  const adult = compile(caseStateFor("咳嗽3天", "3天前受凉后咳嗽，痰白清稀，恶寒无汗。"), WIND_COLD);
  assert.equal(adult.protocolStatus, "governed_patient_specific_plan", "成人病例被误挡");
});

check("复核④：「甲型流感病毒抗原阴性」不得把病例送进流感专项方案", () => {
  const item = compile(
    caseStateFor("咳嗽5天", "5天前受凉后出现咳嗽，痰白清稀，恶寒无汗。甲型流感病毒抗原阴性。"),
    WIND_COLD,
  );
  assert.ok(item, "针刺项目应仍在结果里");
  assert.ok(
    !/每次\s*30\s*分钟/.test(item.scheduleSuggestion),
    `一个阴性结果换来了流感专项排程：${item.scheduleSuggestion}`,
  );
  const points = bare(item.suggestedSitesOrPoints);
  assert.ok(!(points.includes("太阳") && points.includes("外关")), `拿到了流感取穴：${points.join("、")}`);
});

check("复核⑤：闸门不得压过本节点的适应证——颈痛节点不得发肺系取穴", () => {
  const prior = signedPrior("风寒袭肺证", "风寒袭肺，肺气失宣", "疏风散寒");
  prior.pathogenesis.chain.push({
    nodeId: "P2",
    patientFact: "颈项疼痛活动受限2周",
    syndromeEvidence: "颈项经筋痹阻",
    pathogenesis: "颈项经筋痹阻，气血不通",
    therapyDirection: "通经活络止痛",
  });
  const items = compileTcmTreatmentRecommendations(
    [{ projectCode: "acupuncture", targetRef: "P2" }],
    prior,
    caseStateFor("咳嗽5天，颈项疼痛2周", "5天前受凉后咳嗽，痰白清稀，恶寒无汗；颈项疼痛活动受限2周。"),
  );
  const item = items.find((entry) => entry.projectCode === "acupuncture");
  if (item) {
    assert.ok(/颈项/.test(item.targetPathogenesis), "本条卡片应打在颈痛节点上");
    const points = bare(item.suggestedSitesOrPoints);
    assert.ok(!points.includes("中府"), `颈痛节点发出了肺系取穴：${points.join("、")}`);
  }
});

check("复核⑥：写在现病史里的既往描述不得触发条件加穴", () => {
  const item = compile(
    caseStateFor("咳嗽5天", "5天前受凉后咳嗽，痰白清稀，恶寒无汗，无鼻塞流涕；既往有偏头痛史。"),
    WIND_COLD,
  );
  const points = bare(item.suggestedSitesOrPoints);
  assert.ok(!points.includes("风池"), `既往偏头痛史把风池带出来了：${points.join("、")}`);
});

check("⑥ 红旗病例：整条不返回治疗建议（不依赖本模板的排除项）", () => {
  const caseState = {
    ...caseStateFor("咳嗽伴咯血1天", "咳嗽伴咯血，胸痛气促。"),
    safetyGate: { status: "red_flag" },
  };
  const items = compileTcmTreatmentRecommendations(
    [{ projectCode: "acupuncture", targetRef: "P1" }],
    WIND_COLD,
    caseState,
  );
  assert.deepEqual(items, [], "红旗病例必须整条不返回治疗建议");
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "cough-template-end-to-end", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "cough-template-end-to-end", checks: 13, failures: 0 }));

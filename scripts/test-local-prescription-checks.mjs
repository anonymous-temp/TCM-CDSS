/**
 * 处方本地确定性核对（src/lib/local-prescription-checks.ts）。
 *
 * 灵犀合理用药审方已整体删除（owner 2026-09-25：永不启用）。原 rxaudit 套件里测的大多是
 * 远端客户端、送审载荷与供应商响应归一，随代码一并删除；这里保留并迁移的是生产上一直在工作的
 * 本地判据——它们与谁来审方无关，删掉任何一条都是把未知当成无风险：
 *   ① 十八反（强提示）/ 十九畏（提示档）配伍预检段；
 *   ② 候选饮片缺单次剂量（结构化优先，无结构化候选时读处方 Markdown）；
 *   ③ 每日频次/疗程/单味剂量不可核验的提交前问题码；
 *   ④ 现用药只记了「本次/局部未用药」或明确「不详」时的待核对提示（未提及 ≠ 阴性）；
 *   ⑤ 已由服务端签名证明的严重风险版本在改方后继续保留；
 *   ⑥ 对外冻结词表：auditCorrelation 的键序与取值、M05 流里的状态标记。
 * 药名身份归一的单一来源由 test:medication-identity-convergence 钉住。
 * 删除前后三条路由 205 份输出对 68ea3f0 逐字节等价（2026-09-25 一次性证明，见合并提交说明）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, {
  alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` },
});
const checks = await jiti.import("../src/lib/local-prescription-checks.ts");
const wire = await jiti.import("../src/lib/rxaudit-status.ts");

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; };
const regimen = { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, course: "5日", method: "每日1剂，水煎服，每日分2次服", followUpNode: "完成5剂后复诊" };
const stateWith = (herbs, extra = {}) => ({
  patient: { sex: "男", age: 46 }, conversation: [],
  reasoningPrescribe: { stage: "prescribe", formula: { candidates: [{ herbs, decoction: { ...regimen } }], patentAndWestern: extra.patentAndWestern || [] } },
  ...extra.state,
});
const herb = (name, dose, processing = null) => ({ name, dose, processing, decoctionRequirement: null });
const scope = (medicationHistory, extra = {}) => checks.localMedicationScopeReason({ patient: {}, conversation: [], medicationHistory, ...extra });

// ── ① 配伍预检 ────────────────────────────────────────────────────────────────
check("十八反走强提示，逐对报出并带依据", () => {
  const text = checks.buildLocalHighRiskHerbPairSection(stateWith([herb("乌头", "3g"), herb("半夏", "9g")]), 0);
  assert.match(text, /^## 生成前配伍预检提示\n/);
  // 行内文本经 NFKC 归一并转义 Markdown 元字符（全角逗号/括号因此变成半角并带反斜杠）。
  assert.match(text, /\*\*乌头—半夏\*\*：命中十八反,请医生或药师重点复核。依据：传统十八反十九畏;药典注意项/);
  assert.match(text, /本提示不阻断诊疗流程。$/);
});
check("十九畏走提示档，措辞明示强度低于十八反", () => {
  const text = checks.buildLocalHighRiskHerbPairSection(stateWith([herb("丁香", "3g"), herb("郁金", "9g")]), 0);
  assert.match(text, /\*\*丁香—郁金\*\*：命中十九畏\\\(强度低于十八反\\\),请医生或药师确认是否确需同用。/);
  assert.doesNotMatch(text, /重点复核/);
});
check("同一候选里十八反排在十九畏之前，阴性对照为空串", () => {
  const text = checks.buildLocalHighRiskHerbPairSection(stateWith([herb("丁香", "3g"), herb("郁金", "9g"), herb("甘草", "6g"), herb("海藻", "9g")]), 0);
  assert.ok(text.indexOf("甘草—海藻") > 0 && text.indexOf("甘草—海藻") < text.indexOf("丁香—郁金"), text);
  assert.equal(checks.buildLocalHighRiskHerbPairSection(stateWith([herb("黄芪", "15g"), herb("茯苓", "12g")]), 0), "");
  assert.equal(checks.buildLocalHighRiskHerbPairSection({ patient: {}, conversation: [] }, 0), "", "无候选时不得编造配伍段");
});
check("只看所选候选：未选中的候选里的禁忌对不外溢", () => {
  const state = stateWith([herb("黄芪", "15g")]);
  state.reasoningPrescribe.formula.candidates.push({ herbs: [herb("甘草", "6g"), herb("海藻", "9g")], decoction: regimen });
  assert.equal(checks.buildLocalHighRiskHerbPairSection(state, 0), "");
  assert.match(checks.buildLocalHighRiskHerbPairSection(state, 1), /甘草—海藻/);
});

// ── ② 缺单次剂量 ──────────────────────────────────────────────────────────────
const missingDose = (drugName, itemNo = 1) => ({ code: "missing_dose", itemNo, drugName, message: `${drugName}未标注单次剂量` });
check("结构化候选：缺失、待定、零与负值都算缺剂量；毫克与小数照常认", () => {
  for (const dose of [null, "", "剂量待定", "0g", "-3g", "适量", "3-6g"]) {
    assert.deepEqual(checks.buildPrescriptionInputAdvisories(stateWith([herb("白术", dose)])), [missingDose("白术")], String(dose));
  }
  for (const dose of ["0.5g", "500mg", "１５g", "15克"]) {
    assert.deepEqual(checks.buildPrescriptionInputAdvisories(stateWith([herb("白术", dose)])), [], dose);
  }
});
check("炮制名称按单字前缀或括注拼接，行号跳过空药名", () => {
  const advisories = checks.buildPrescriptionInputAdvisories(stateWith([herb("  ", "3g"), herb("甘草", null, "炙"), herb("黄芪", "", "蜜炙"), herb("炙甘草", "", "炙")]));
  assert.deepEqual(advisories, [missingDose("炙甘草", 1), missingDose("黄芪（蜜炙）", 2), missingDose("炙甘草", 3)]);
});
check("无结构化候选时读处方 Markdown 饮片表；显式候选索引不存在时不回落", () => {
  const markdownState = { patient: {}, conversation: [], prescription: ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 黄芪 | 15g |", "| 白术 | |"].join("\n") };
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(markdownState), [missingDose("白术", 2)]);
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(markdownState, 0), [], "显式索引下不得把 Markdown 当成所选候选");
});
check("候选只剩中成药/西药时不回落去读 Markdown（结构化候选存在）", () => {
  const markdown = ["## 中药饮片处方", "| 药名 | 剂量 |", "|---|---|", "| 白术 | |"].join("\n");
  const medicine = { type: "中成药", name: "示例中成药", specification: "每袋6g", usageBoundary: "仅作候选复核", course: "3日", positioning: "替代方案",
    correspondingProblem: "口苦", evidence: { evidenceLevel: "instruction", source: "示例说明书" }, relationship: "不默认与饮片联用", riskNote: "复核过敏史与现用药" };
  const withMedicine = stateWith([herb(" ", null)], { patentAndWestern: [medicine], state: { prescription: markdown } });
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(withMedicine), []);
  const withoutMedicine = stateWith([herb(" ", null)], { state: { prescription: markdown } });
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(withoutMedicine), [missingDose("白术")], "阴性对照：没有结构化条目才读 Markdown");
});
check("待核对段只用中性口径：不叫人「重新审方」，也不把未核实说成已排除", () => {
  const text = checks.buildPrescriptionInputAdvisorySection([missingDose("白术")]);
  assert.equal(text, "## 处方信息待核对\n- 白术未标注单次剂量。请结合原始病历人工核对；在核实前不得视为已排除相关用药风险。");
  assert.equal(checks.buildPrescriptionInputAdvisorySection([]), "");
});

// ── ③ 提交前问题码（clinical-delivery-advisory 按码渲染）──────────────────────
check("候选缺失 / 服法不可核验 / 单味剂量不可解析 各得其码", () => {
  assert.equal(checks.prescriptionSubmissionIssue({ patient: {}, conversation: [] }), "candidate_missing");
  assert.equal(checks.prescriptionSubmissionIssue(stateWith([herb("黄连", "3g")])), undefined);
  const missingTimes = stateWith([herb("黄连", "3g")]);
  delete missingTimes.reasoningPrescribe.formula.candidates[0].decoction.administrationTimesPerDay;
  assert.equal(checks.prescriptionSubmissionIssue(missingTimes), "regimen_incomplete");
  const blankCourse = stateWith([herb("槟榔", "6g")]);
  blankCourse.reasoningPrescribe.formula.candidates[0].decoction = { doseCount: "5剂", course: "", method: "水煎服", followUpNode: "" };
  assert.equal(checks.prescriptionSubmissionIssue(blankCourse), "regimen_incomplete");
  assert.equal(checks.prescriptionSubmissionIssue(stateWith([herb("槟榔", "剂量待定")])), "herb_dose_incomplete");
});
check("候选索引：显式索引只认存在的候选，未指定时取第一张带药味的候选", () => {
  const state = stateWith([]);
  state.reasoningPrescribe.formula.candidates.push({ herbs: [herb("黄芪", "15g")], decoction: regimen });
  assert.equal(checks.resolvePrescriptionCandidateIndex(state), 1);
  assert.equal(checks.resolvePrescriptionCandidateIndex(state, 0), 0);
  assert.equal(checks.resolvePrescriptionCandidateIndex(state, 2), undefined);
  assert.equal(checks.resolvePrescriptionCandidateIndex({ patient: {}, conversation: [] }), undefined);
});

// ── ④ 现用药范围（未提及 ≠ 阴性）──────────────────────────────────────────────
check("本次/局部未用药不排除长期或其他现用药；不详/未提及是明确 unknown", () => {
  const cases = [
    ["发病后未服药", "medication_current_scope_incomplete"],
    ["既往服用阿莫西林，发病后未服药", "medication_current_scope_incomplete"],
    ["曾服阿莫西林已停用，发病后未服药", "medication_current_scope_incomplete"],
    ["否认服用阿司匹林，发病后未服药", "medication_current_scope_incomplete"],
    ["家属长期服用阿司匹林，发病后未服药", "medication_current_scope_incomplete"],
    ["近3天未用药", "medication_current_scope_incomplete"],
    ["就诊前未予药物治疗", "medication_current_scope_incomplete"],
    ["症状出现后未自行服用药物", "medication_current_scope_incomplete"],
    ["未自行服药", "medication_current_scope_incomplete"],
    ["未接受药物治疗", "medication_current_scope_incomplete"],
    ["从未忘记服用阿司匹林，发病后未服药", "medication_current_scope_incomplete"],
    ["现用药不 详", "medication_current_scope_unknown"],
    ["现用药不\n详", "medication_current_scope_unknown"],
    ["现用药未 提 及", "medication_current_scope_unknown"],
    ["入院前未接受药物治疗，目前用药不详", "medication_current_scope_unknown"],
    ["目前无任何用药", undefined],
    ["既往服用阿司匹林，当前无任何用药", undefined],
    ["现服阿司匹林，发病后未服其他药", undefined],
    ["长期服用阿司匹林，发病后未服药", undefined],
    ["未停用阿司匹林，发病后未服其他药", undefined],
    ["目前仍在服用华法林，不要停药，发病后未服药", undefined],
    ["现服氨氯地平5mg每日1次", undefined],
    ["", undefined],
    [undefined, undefined],
  ];
  for (const [text, expected] of cases) assert.equal(scope(text), expected, JSON.stringify(text));
});
check("类别名、字段标签与伪剂型不能冒充「已证明的具体现用药」（整类 + 阳性对照）", () => {
  for (const generic of ["当前服用抗凝药物", "长期服用降压药", "当前服用抗凝药片", "当前服用止痛药胶囊", "当前服用抗生素", "当前服用降压片",
    "当前服用消炎片", "当前服用感冒胶囊", "目前服用感冒药片", "当前使用胰岛素", "当前服用维生素", "当前用药记录", "药物清单图片", "当前用药滴丸"]) {
    assert.equal(scope(`${generic}，发病后未服其他药`), "medication_current_scope_incomplete", generic);
  }
  for (const specific of ["现服阿司匹林", "现服黄芪颗粒", "现服复方丹参滴丸", "现服华法林钠片", "长期服用二甲双胍缓释片"]) {
    assert.equal(scope(`${specific}，发病后未服其他药`), undefined, specific);
  }
});
check("HIS 用药史栏优先于顶层字段；患者姓名先去标识再判定", () => {
  const his = (yongyaoshi) => ({ hisRecord: { caseId: "his-1", fields: { yongyaoshi, patientName: "张三" } } });
  assert.equal(scope("现服阿司匹林", his("发病后未服药")), "medication_current_scope_incomplete");
  assert.equal(scope("发病后未服药", his("现服阿司匹林，发病后未服其他药")), undefined);
  assert.equal(scope("发病后未服药", his("  ")), "medication_current_scope_incomplete", "空白 HIS 栏回落到顶层字段");
  // 姓名恰与药名同形时，去标识后不再能证明现用药。
  assert.equal(scope("现服黄芪，发病后未服其他药", { patient: { name: "黄芪" } }), "medication_current_scope_incomplete");
});
check("待核对条目：码与措辞是对外 JSON，缺剂量在前、现用药在后", () => {
  const state = stateWith([herb("白术", null)], { state: { medicationHistory: "现用药不详" } });
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(state), [missingDose("白术"),
    { code: "medication_semantics_incomplete", itemNo: 0, drugName: "现用药", message: "现用药信息明确不详或尚未核实，联用风险必须结合原文人工核对" }]);
  const partial = stateWith([herb("白术", "9g")], { state: { medicationHistory: "发病后未服药" } });
  assert.deepEqual(checks.buildPrescriptionInputAdvisories(partial).map((item) => item.message),
    ["已记录本次或局部未用药，但不能据此排除长期或其他现用药，联用风险必须结合原文人工核对"]);
});

// ── ⑤ 已证明的严重风险版本 ────────────────────────────────────────────────────
check("BLOCK 或 CRITICAL 版本保留强提示，其余为空", () => {
  const expected = "## 处方风险提示\n**强提示**：当前精确处方版本已有经确认的严重风险，仍需保留该风险提示；本次没有新的外部复核结果。";
  assert.equal(checks.buildRetainedPrescriptionRiskSection({ auditResult: "BLOCK" }), expected);
  assert.equal(checks.buildRetainedPrescriptionRiskSection({ auditResult: "MANUAL_REVIEW", highestRiskLevel: "CRITICAL" }), expected);
  for (const revision of [undefined, { auditResult: "NOT_SUBMITTED" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH" }]) {
    assert.equal(checks.buildRetainedPrescriptionRiskSection(revision), "");
  }
});

// ── ⑥ 对外冻结词表 ────────────────────────────────────────────────────────────
check("auditCorrelation 键序与取值逐字节冻结", () => {
  assert.equal(JSON.stringify(wire.skippedRxAuditCorrelation({ candidateIndex: 0, prescriptionHash: "sha256-abc", auditedAt: "2026-09-25T00:00:00.000Z" })),
    '{"provider":"lingxi-rxaudit","providerAvailable":false,"providerReason":"rxaudit_disabled","candidateIndex":0,"prescriptionHash":"sha256-abc","auditedAt":"2026-09-25T00:00:00.000Z"}');
  assert.equal(JSON.stringify(wire.skippedRxAuditCorrelation({ prescriptionHash: "", auditedAt: "x" })),
    '{"provider":"lingxi-rxaudit","providerAvailable":false,"providerReason":"rxaudit_disabled","auditedAt":"x"}', "空哈希与缺索引不出键");
  assert.equal(wire.skippedRxAuditCorrelationMarker(wire.skippedRxAuditCorrelation({ auditedAt: "x" })),
    `<!-- TCM_CDSS_RXAUDIT_CORRELATION:${encodeURIComponent('{"provider":"lingxi-rxaudit","providerAvailable":false,"providerReason":"rxaudit_disabled","auditedAt":"x"}')} -->`);
  assert.equal(wire.RXAUDIT_DISABLED_REASON, "rxaudit_disabled");
});
check("M05 流状态标记只有 DISABLED 一档可产出，旧会话里的其他档仍可解析", () => {
  assert.equal(wire.RXAUDIT_DISABLED_STATUS_MARKER, "<!-- TCM_CDSS_RXAUDIT_STATUS:DISABLED -->");
  assert.deepEqual(wire.parseRxAuditStatusMarker(wire.RXAUDIT_DISABLED_STATUS_MARKER), { available: false, presentationDisabled: true });
  assert.deepEqual(wire.parseRxAuditStatusMarker("<!-- TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:NO_PRESCRIPTION_ITEMS -->"), { available: false, reason: "no_prescription_items" });
  assert.equal(wire.stripRxAuditStatusMarker(`${wire.RXAUDIT_DISABLED_STATUS_MARKER}\n## 生成前配伍预检提示`), "## 生成前配伍预检提示");
});

// ── 删除是否干净：应用源码里不再有外部审方的调用面 ─────────────────────────────
check("src 不再导入已删模块、不再读 RXAI_AUDIT_/RXAI_QUERY_/CDSS_SHOW_RX_AUDIT_SECTION", () => {
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(?:ts|tsx)$/.test(name)) files.push(full); } };
  walk(path.join(root, "src"));
  assert.ok(files.length > 100, `源码遍历过少：${files.length}`);
  const offenders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    return /from\s+["'](?:\.\/|@\/lib\/)(?:rxaudit|rxaudit-normalize|rxai-query\.server|medication-event-extractor)["']/.test(text)
      || /process\.env\.(?:RXAI_AUDIT_|RXAI_QUERY_|CDSS_SHOW_RX_AUDIT_SECTION)/.test(text)
      || /rational-drug-use/.test(text);
  });
  assert.deepEqual(offenders.map((file) => path.relative(root, file)), []);
});

console.log(`local-prescription-checks: ${passed} checks passed`);

// 10/19 第三轮（2026-10-19）：甲方 10 例与留出集第 12 轮复评（local12）里剩下的服务端缺陷，一类一修。
//
// 每条断言都带反证：把改动撤掉或换成对照输入后必须变红（反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt）。
//
//   1 阴性净化器的否认作用域：「无汗」「无痰」只否认自己；顿号列举里自带「有/伴/见」的一项不在否认之下
//     （甲方标准病历 1 三次中两次辨证依据成了「咳嗽，为风寒袭表…」）
//   2 「示/提示/表明…无X」是推断，不改「未诉X」（「二便调示里和无热结」）
//   3 皮疹总称：病历写了风团/红斑/水疱就算写到皮疹（口咽黏膜疱疹不算）；鉴别行以被鉴别病证为主语的否认不净化
//   4 内部记号清洗不擦检验缩写（dsDNA、cTnI、hsCRP…；留出例 S079「抗及」）
//   5 注意事项：有毒药逐味点到（S054 附子）；「方中有木香、当归等药。」残句不留（S078）；自行停药（S178）；
//     红旗页在用药物写带药就医、不写间隔服用、不写年龄相关服法（S188）；行动受限的运动保健（甲方病历 5）
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const hygiene = await jiti.import("../src/lib/internal-tag-hygiene.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

// safetyGate 是服务端写的字段，归一化时丢弃；路由在 withSafetyGate 之后才有，这里同样在归一化之后挂上。
const stateOf = (presentHistory, { safetyGate, ...extra } = {}) => {
  const normalized = types.normalizeCaseStateInput({
    id: "r3", chiefComplaint: "x", patient: { sex: "女", age: 28 }, symptoms: { presentHistory }, conversation: [], ...extra,
  });
  return safetyGate ? { ...normalized, safetyGate } : normalized;
};
const sanitizeField = (record, field, text, entry = {}) => {
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ stage: "diagnose", overview: { tcmDiagnosticRationale: field === "rationale" ? text : "x", tcmDiseaseDifferentials: [{ diseaseName: "风瘙痒", distinguishingPoints: field === "differential" ? text : "x", ...entry }] } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = safety.sanitizeUngroundedRedFlagNegations(content, stateOf(record));
  const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return field === "rationale" ? json.overview.tcmDiagnosticRationale : json.overview.tcmDiseaseDifferentials[0].distinguishingPoints;
};

// ───── 1 否认作用域 ─────
const CASE1 = "患者2天前淋雨后出现恶寒发热，恶寒重、发热轻，自测体温37.5℃，伴鼻塞、流清涕，稍有咳嗽，无汗。";
await check("1.1 「…无汗、鼻塞流清涕、稍有咳嗽，为风寒袭表…」原样保留（此前整句改成「病历已记录咳嗽阳性」）", () => {
  const text = "淋雨后恶寒重、发热轻、无汗、鼻塞流清涕、稍有咳嗽，为风寒袭表、卫阳被遏、肺气失宣，故属风寒束表证。";
  assert.equal(sanitizeField(CASE1, "rationale", text), text);
  assert.equal(sanitizeField("胃脘胀痛3天，无反酸，偶有嗳气，纳差。", "rationale", "胃脘胀痛、无反酸、偶有嗳气、纳差，属肝胃不和。"), "胃脘胀痛、无反酸、偶有嗳气、纳差，属肝胃不和。");
  // 单防线用例：只有「无汗只否认自己」一条护着（后面各项没有肯定词）；只有「自带肯定词」一条护着（否认项是普通症状）。
  // 病历里不能逐字写着同一个否认（「无汗」「无腹痛」）：那样净化器按「否认逐字有据」整句放行，测不到作用域。
  assert.equal(sanitizeField("恶寒重，汗不出，头痛身痛，痰白稀。", "rationale", "恶寒重、无汗、头痛身痛、痰白稀，属风寒束表。"), "恶寒重、无汗、头痛身痛、痰白稀，属风寒束表。");
  assert.equal(sanitizeField("腹泻2天，日4次，伴发热，否认腹痛。", "rationale", "腹泻、无腹痛、伴发热，属湿热泄泻。"), "腹泻、无腹痛、伴发热，属湿热泄泻。");
});
await check("1.2 对照：普通顿号列举照旧一并否认（「无恶心、呕吐」而病历记录呕吐仍改正）", () => {
  assert.match(sanitizeField("恶心2天，呕吐3次，无发热。", "rationale", "无恶心、呕吐，属胃气上逆。"), /病历已记录/);
});

// ───── 2 推断里的「无」 ─────
await check("2.1 「二便调示里和无热结」不改「未诉热结」；没有推断词的「无热结」照改（对照）；「无脓无屑」不改成「未诉脓无屑」", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("精神饮食尚可、二便调示里和无热结。", CASE1), "精神饮食尚可、二便调示里和无热结。");
  assert.equal(visible.unrecordedNegativesAsNotReported("恶寒发热，无热结。", CASE1), "恶寒发热，未诉热结。");
  // 「口不渴」同「无X」：病历没记录口渴时写「未诉口渴」；病历写了口渴（或不欲饮）照留；「大便不干」不是口干（对照）。
  assert.equal(visible.unrecordedNegativesAsNotReported("本例恶寒重、发热轻、无汗、口不渴，涕清", CASE1), "本例恶寒重、发热轻、无汗、未诉口渴，涕清");
  assert.equal(visible.unrecordedNegativesAsNotReported("本例口不渴，涕清", `${CASE1}口不渴。`), "本例口不渴，涕清");
  assert.equal(visible.unrecordedNegativesAsNotReported("大便不干，小便调", CASE1), "大便不干，小便调");
  // 「无脓无屑」不再整段当一个对象改成「未诉脓无屑」。
  assert.equal(visible.unrecordedNegativesAsNotReported("头皮无脓无屑，", CASE1), "头皮无脓无屑，");
});

// ───── 3 皮疹总称与鉴别主语 ─────
const CASE9 = "两天前患者因大汗后吹空调出现周身皮肤瘙痒，搔抓后迅速出现红色风团，时消时现，伴发热、微恶风。";
await check("3.1 鉴别行「风瘙痒无原发皮疹」说的是风瘙痒，原样保留（此前交付成「未诉皮疹」）", () => {
  assert.equal(sanitizeField(CASE9, "differential", "本例搔抓后迅速出现红色风团，风瘙痒无原发皮疹"), "本例搔抓后迅速出现红色风团，风瘙痒无原发皮疹");
});
await check("3.2 说本例「无皮疹」而病历有风团：按已记录改正，不再说「尚未确认」；口咽黏膜疱疹不算皮疹（对照）", () => {
  assert.match(sanitizeField(CASE9, "differential", "本例无皮疹"), /病历已记录皮疹阳性/);
  assert.equal(safety.SKIN_LESION_FORM.test("咽峡及软腭部可见直径2～3cm的疱疹及溃疡"), false);
  assert.equal(safety.SKIN_LESION_FORM.test("胸胁部片状红斑，其上可见米粒大小水疱"), true);
  assert.match(sanitizeField("咽峡及软腭部可见疱疹，发热2天。", "differential", "本例无皮疹"), /尚未确认皮疹/);
});

// ───── 4 检验缩写 ─────
await check("4.1 内部记号清洗保留 dsDNA、cTnI、hsCRP、aPTT、mRNA、proBNP；字段名照擦（对照）", () => {
  assert.equal(hygiene.stripInternalEngineeringTags("查抗核抗体、抗dsDNA及尿常规"), "查抗核抗体、抗dsDNA及尿常规");
  assert.equal(hygiene.stripInternalEngineeringTags("查cTnI、hsCRP、aPTT、mRNA、proBNP"), "查cTnI、hsCRP、aPTT、mRNA、proBNP");
  assert.equal(hygiene.stripInternalEngineeringTags("见targetPathogenesis与evidenceId"), "见与");
});

// ───── 5 注意事项 ─────
const rx = (precautionLines, herbs = [{ name: "陈皮", role: "君", function: "理气健脾", dose: "10g" }], extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs }] },
  nonPharma: { precautions: precautionLines, ...extra },
});
await check("5.1 有毒药逐味点到：只写了吴茱萸，附子补一句；都写到了不补（对照）", () => {
  const herbs = [{ name: "附子", role: "君", function: "温肾", dose: "6g" }, { name: "吴茱萸", role: "佐", function: "温中", dose: "3g" }];
  const out = surface.projectDeliveredReasoning(rx(["方中吴茱萸有小毒，服后如出现恶心、头晕等不适，请及时告知医生。"], herbs));
  assert.ok(out.nonPharma.precautions.some((line) => /方中附子在药典中标注有毒/.test(line)));
  assert.ok(!out.nonPharma.precautions.some((line) => /方中[^。]*吴茱萸[^。]*在药典中标注有毒/.test(line)));
  const both = surface.projectDeliveredReasoning(rx(["方中附子有毒须先煎，吴茱萸有小毒，出现口唇发麻请停药就医。"], herbs));
  assert.equal(both.nonPharma.precautions.length, 1);
});
await check("5.2 「方中有木香、当归等药。」残句不留；带提示的「方中有附子，须先煎…」照留（对照）", () => {
  const herbs = ["木香", "当归", "附子"].map((name) => ({ name, role: "臣", function: "x", dose: "6g" }));
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。", "方中有木香、当归等药。", "方中有附子，须先煎，如出现口唇发麻请停药就医。"], herbs));
  assert.deepEqual(out.nonPharma.precautions, ["饮食清淡。", "方中有附子，须先煎，如出现口唇发麻请停药就医。"]);
});
await check("5.3 自行停药：「高血压病史8年，1个月前自行停药」算出一项并补规则句；遵医嘱停药、否认不算（对照）", () => {
  assert.deepEqual(polarity.selfDiscontinuedMedication("高血压病史8年，1个月前自行停药"), { condition: "高血压", names: [] });
  assert.equal(polarity.selfDiscontinuedMedication("高血压病史8年，遵医嘱停药1个月"), undefined);
  const items = precautions.requiredPrecautionsForCase(stateOf("头痛2小时。", { pastHistory: "高血压病史8年，1个月前自行停药" }), null);
  const item = items.find((entry) => entry.kind === "self_discontinued_medication");
  assert.ok(item);
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"]), { requiredPrecautions: [item] });
  assert.match(out.nonPharma.precautions[0], /自行停用了降压药，请尽快由医生评估后调整用药并规律服用/);
});
await check("5.4 红旗页：在用药物写带药就医、去掉「与中药间隔服用」、不出年龄相关服法；非红旗照旧（对照）", () => {
  const gate = { status: "red_flag", allowDiagnosis: true, allowDosePrescription: false, reasons: ["x"], redFlags: ["x"] };
  const red = precautions.requiredPrecautionsForCase(stateOf("头晕、嗜睡2天。", { patient: { sex: "男", age: 79 }, pastHistory: "长期口服“酒石酸美托洛尔片”25mg每日2次", safetyGate: gate }), null);
  const meds = red.find((entry) => entry.kind === "current_medications");
  assert.equal(meds?.urgent, true);
  assert.ok(!red.some((entry) => entry.kind === "elderly_administration"));
  const out = surface.projectDeliveredReasoning(rx(["正在服用的酒石酸美托洛尔片请告知医生，是否继续服用由医生决定；中药与西药同服时最好间隔1小时左右。", "如出现嗜睡加重立即就医，中药与西药同服时最好间隔1小时左右。"]), { requiredPrecautions: [meds] });
  assert.match(out.nonPharma.precautions[0], /^请把正在使用的酒石酸美托洛尔片连同药盒带去就医/);
  assert.ok(!out.nonPharma.precautions.some((line) => /间隔/.test(line)));
  const calm = precautions.requiredPrecautionsForCase(stateOf("头晕2天。", { patient: { sex: "男", age: 79 }, pastHistory: "长期口服“酒石酸美托洛尔片”25mg每日2次" }), null);
  assert.ok(calm.some((entry) => entry.kind === "elderly_administration"));
  assert.ok(!calm.find((entry) => entry.kind === "current_medications")?.urgent);
});
await check("5.5 行动受限：拄拐的患者运动保健改坐式并写陪同扶物；已按受限写的不动；没有受限不出这一项（对照）", () => {
  const items = precautions.requiredPrecautionsForCase(stateOf("反复感冒1年。", { patient: { sex: "女", age: 78 }, pastHistory: "股骨骨折术后，现可拄拐缓慢行走" }), null);
  const mobility = items.find((entry) => entry.kind === "mobility_limited_exercise");
  assert.deepEqual(mobility, { kind: "mobility_limited_exercise", limitation: "拄拐" });
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"], undefined, { exercise: "以散步、八段锦为主，每次20分钟，每周3–5次，量力而行。" }), { requiredPrecautions: [mobility] });
  assert.match(out.nonPharma.exercise, /坐式八段锦/);
  assert.match(out.nonPharma.exercise, /家人陪同下扶物或坐位进行/);
  assert.deepEqual(out.nonPharma.precautions, ["饮食清淡。"]);
  const adapted = surface.projectDeliveredReasoning(rx(["饮食清淡。"], undefined, { exercise: "以坐位活动为主，家人陪同。" }), { requiredPrecautions: [mobility] });
  assert.equal(adapted.nonPharma.exercise, "以坐位活动为主，家人陪同。");
  assert.ok(!precautions.requiredPrecautionsForCase(stateOf("反复感冒1年。", { patient: { sex: "女", age: 78 } }), null).some((entry) => entry.kind === "mobility_limited_exercise"));
  assert.match(precautions.requiredPrecautionsPromptSection([mobility]), /运动保健一栏按行动受限写/);
});

// ───── 6 病历用药取名与兼证判据 ─────
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
await check("6.1 取名：「给予头部CT示…脑挫裂伤」不是药；「易蒙停」的停不是停药；「自用痔疮栓」是外用药；下一句「停用该药」的药不算在用", () => {
  const names = (text) => polarity.recordedMedicationMentions(text).names;
  assert.deepEqual(names("急诊检查后，给予头部CT示：颅脑螺旋CT平扫颅内未见明确血肿及脑挫裂伤。"), []);
  assert.deepEqual(names("外院曾予蒙脱石散、易蒙停等药物治疗，症状未能缓解。"), ["蒙脱石散", "易蒙停"]);
  assert.deepEqual(names("两年余前患者出现大便带血，自用痔疮栓、膏等治疗。"), ["痔疮栓"]);
  assert.deepEqual(names("2020-08-04起口服吉非替尼治疗。其后因不能耐受自行停用该药。末次复查病情进展。"), []);
  assert.deepEqual(names("2020-08-04起口服吉非替尼治疗。末次复查病情稳定。"), ["吉非替尼"]);
  assert.equal(polarity.medicationStoppedInNextSentence("2020-08-04起口服吉非替尼治疗。其后因不能耐受自行停用该药。", "吉非替尼"), true);
  assert.equal(polarity.medicationStoppedInNextSentence("2020-08-04起口服吉非替尼治疗。其后病情稳定。", "吉非替尼"), false);
});
await check("6.2 「一直口服中药治疗」出「在服中药」一项（请把方子带给医生）；因不能耐受而停的不出「自行停药」一项", () => {
  const items = precautions.requiredPrecautionsForCase(stateOf("术后患者一直口服中药治疗，定期复查病情稳定。"), null);
  assert.deepEqual(items.find((entry) => entry.kind === "unnamed_medication"), { kind: "unnamed_medication", herbal: true });
  const out = surface.projectDeliveredReasoning(rx(["饮食清淡。"]), { requiredPrecautions: [{ kind: "unnamed_medication", herbal: true }] });
  assert.match(out.nonPharma.precautions[0], /^您一直在服的中药，请把方子带给医生看/);
  assert.equal(polarity.selfDiscontinuedMedication("口服吉非替尼治疗，其后因不能耐受自行停用该药"), undefined);
  // 单防线用例：有慢性病名、因不良反应自停——那是该换药，不写「规律服用」。
  assert.equal(polarity.selfDiscontinuedMedication("高血压病史5年，服降压药后干咳不能耐受，自行停药"), undefined);
});
await check("6.3 兼证判据认「兼有肺气不足」「兼见卫表不固」；「兼顾」不算（对照）", () => {
  assert.equal(secondary.secondaryPatternClaims("舌淡脉弱，提示兼有肺气不足。").length, 1);
  assert.equal(secondary.secondaryPatternClaims("自汗恶风，兼见卫表不固。").length, 1);
  assert.equal(secondary.secondaryPatternClaims("治当兼顾肺气不足。").length, 0);
});
await check("6.3b 自称兼夹的分句（「为肝气不舒之兼象」「心脾同病」）进核对、可删；只用病机词解释伴随表现的分句（「纳差便溏为脾运不健」）只在宽判据里算，且不删", async () => {
  const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
  assert.deepEqual(phrasing.mechanismClaimsUncoveredBy("心脾两虚证", "急躁易怒、脉弦为肝气不舒之兼象，纳差便溏为脾运不健"), ["急躁易怒、脉弦为肝气不舒之兼象"]);
  assert.deepEqual(phrasing.mechanismClaimsUncoveredBy("胃热证", "纳差便溏为脾气不足，舌苔白腻示湿浊中阻"), ["纳差便溏为脾气不足", "舌苔白腻示湿浊中阻"]);
  assert.deepEqual(phrasing.mechanismClaimsUncoveredBy("肝郁脾虚证", "脉弦为肝郁，纳差为脾虚，不支持湿热"), []);
  assert.equal(phrasing.declaresSecondaryMechanism("心脾同病"), true);
  assert.equal(phrasing.declaresSecondaryMechanism("纳差便溏为脾运不健"), false);
  const editable = "急躁易怒、脉弦为肝气不舒之兼象，纳差便溏为脾运不健";
  const remove = (clauses) => secondary.parseSecondaryConsistencyDecision(JSON.stringify({ decision: "remove", clauses }), { recordText: "x", primarySyndrome: "心脾两虚证", editableText: editable });
  assert.deepEqual(remove(["急躁易怒、脉弦为肝气不舒之兼象"]), { decision: "remove", clauses: ["急躁易怒、脉弦为肝气不舒之兼象"] });
  assert.equal(remove(["纳差便溏为脾运不健"]), undefined);
});
await check("6.4 注意事项：药类英文缩写换中文（ARB→沙坦类降压药）；说某药特殊煎法而药表不是这样的小句去掉，药表一致的照留（对照）", () => {
  const abbr = surface.projectDeliveredReasoning(rx(["正在服用的ARB类降压药请告知医生。"]));
  assert.equal(abbr.nonPharma.precautions[0], "正在服用的沙坦类降压药请告知医生。");
  const herbs = [{ name: "人参", role: "君", function: "大补元气", dose: "6g", decoctionRequirement: "另煎" }, { name: "附子", role: "臣", function: "温阳", dose: "6g", decoctionRequirement: "先煎、久煎" }];
  const out = surface.projectDeliveredReasoning(rx(["人参须先煎久煎，饮食清淡。", "附子须先煎久煎，如出现口唇发麻请停药就医。"], herbs));
  assert.deepEqual(out.nonPharma.precautions.slice(0, 2), ["饮食清淡。", "附子须先煎久煎，如出现口唇发麻请停药就医。"]);
});

await check("6.5 不给剂量的病例，复诊提示不以「服完本次的药」为节点：红旗先急诊/专科，其余先就诊评估；给剂量的照旧（对照）；幂等", () => {
  const net = "请服完本次的药后复诊。若出现呕血、黑便或腹痛加剧，请立即就医。";
  const red = surface.followupWhenDoseWithheld(net, "red_flag");
  assert.match(red, /^请先到医院急诊或专科就诊/);
  assert.match(red, /若出现呕血、黑便或腹痛加剧，请立即就医。$/);
  assert.match(surface.followupWhenDoseWithheld(net, "withheld"), /^请先到医院就诊，由医生完成评估并确定能否用药/);
  assert.equal(surface.followupWhenDoseWithheld(red, "red_flag"), red);
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, management: { followupSafetyNet: net } };
  assert.equal(surface.projectDeliveredReasoning(reasoning).management.followupSafetyNet, net);
  assert.match(surface.projectDeliveredReasoning(reasoning, { doseWithheld: "withheld" }).management.followupSafetyNet, /^请先到医院就诊/);
});

await check("6.6 「当时/入院时 + 否认」也是否认（「当时无腹痛、水肿、发热及关节痛」不再把关节痛读成阳性）；「当时出现关节痛」照旧阳性（对照）", () => {
  const affirmed = polarity.affirmedClinicalText("1月前出现双下肢紫癜，当时无腹痛、水肿、发热及关节痛，于当地医院就诊");
  assert.ok(!/关节痛|腹痛/.test(affirmed), affirmed);
  assert.match(polarity.affirmedClinicalText("1月前出现双下肢紫癜，当时出现关节痛"), /关节痛/);
});

await check("6.7 删掉的小句后面「并告知医生」不留成无主残句：改成「请告知医生」", () => {
  const reasoning = rx(["如出现胃部不适，可改为饭后服用，并告知医生。"]);
  reasoning.formula.candidates[0].decoction = { method: "每日1剂，水煎两次，分2次饭后温服" };
  const out = surface.projectDeliveredReasoning(reasoning);
  assert.equal(out.nonPharma.precautions.find((line) => /胃部不适/.test(line)), "如出现胃部不适，请告知医生。");
});

// ───── 7 教材表补骨折 ─────
await check("7.1 教材表有骨折（三期各一行，后期分肝肾、气血）：肋骨骨折按病名找得到行，初期桃红四物汤；口语主诉也进候选", async () => {
  const tb = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
  assert.equal(tb.textbookRowForSyndrome("肋骨骨折", "气滞血瘀证")?.formulas?.[0], "桃红四物汤");
  assert.equal(tb.textbookRowForSyndrome("骨折", "瘀血阻络证")?.formulas?.[0], "新伤续断汤");
  assert.equal(tb.textbookRowForSyndrome("骨折", "气血两虚证")?.formulas?.[0], "八珍汤");
  assert.ok(tb.textbookDiseaseNamesForCase({ sex: "男", ageYears: 50 }).includes("骨折"));
  const candidates = tb.textbookCandidatesForCase({ chiefComplaint: "外伤后右胸痛3天", presentHistory: "3天前摔倒致右胸部疼痛，CT示右侧第8后肋骨折。", sex: "男", ageYears: 50 });
  assert.ok(candidates.some((entry) => entry.disease === "骨折"), JSON.stringify(candidates.map((entry) => entry.disease)));
});

console.log(JSON.stringify({ suite: "r1019-round3", cases, failures: process.exitCode ? "see above" : 0 }));

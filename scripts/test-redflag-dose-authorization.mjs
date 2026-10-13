/**
 * 红旗病例的剂量授权：开关必须真的起作用，独立硬边界必须不受开关影响。
 *
 * 【这条套件钉的是什么】
 * 2026-08-15 审查发现 derivePrescriptionPermission 的红旗分支是**提前返回**的，
 * 在儿科体重、妊娠状态、语义筛查、高危剂量这几道**与红旗无关**的独立边界之前就 return 了。
 * 于是两版都错，只是错法不同：
 *
 *   · 旧版（CDSS_GATE_DISPOSITION 默认 advise）：红旗 ⇒ 直接 full_dose。
 *     实测 6 岁儿童 + 蛛网膜下腔出血形态的红旗 ⇒ **full_dose** ——
 *     儿科剂量硬边界被整条跳过。这是本次审查抓到的最实的一个洞。
 *   · 后一版：红旗 ⇒ 无条件 non_dose_only。结论碰巧安全，但
 *     ①CDSS_GATE_DISPOSITION 对该路径完全失效（三档输出一字不差），
 *     文档承诺的「block 用于 ops 回滚」失去意义、且**回滚不了**；
 *     ②掩盖了上面那个排序缺陷；
 *     ③唯一跑默认档的断言只验「开关自报 advise」，不验「开关起作用」，所以套件抓不到。
 *
 * 【现在的口径】剂量授权单独成轴：
 *   · CDSS_REDFLAG_DOSE_AUTHORIZATION 管剂量授权，默认 withhold（与线上一致），
 *     allow 是运维回退档；
 *   · 流程与呈现只有「提示不拦截」一种（CDSS_GATE_DISPOSITION 及其 block 回退档
 *     2026-09-25 删除，原第 4 节「两轴不得绑回同一开关」随之删除）。
 * 独立硬边界（儿科/妊娠/语义筛查/高危剂量）**不受任何一个开关影响**——这正是本套件的重点。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { withSafetyGate, derivePrescriptionPermission, redFlagDoseAuthorizationAllowed, hardDoseSafetyBoundaryReasons } =
  await jiti.import("../src/lib/diagnosis-safety.ts");

const BASE = {
  id: "redflag-dose-suite", phase: "prescribe",
  tongue: "舌淡红苔薄白", pulse: "脉弦",
  vitals: "T36.7℃ P88次/分 R20次/分 BP132/84mmHg",
  pastHistory: "", medicationHistory: "近期未服药", allergyHistory: "否认药物、食物过敏",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};
const REDFLAG_TEXT = "突发剧烈头痛1小时，数秒内达到最剧烈程度，伴恶心呕吐2次，颈项僵硬";
const caseOf = (patch) => ({
  ...BASE, patient: { sex: "男", age: 45 },
  chiefComplaint: REDFLAG_TEXT, symptoms: { general: REDFLAG_TEXT, tcmFourExams: "" },
  ...patch,
});
const modeOf = (state) => derivePrescriptionPermission(withSafetyGate(state)).candidateMode;
const gateOf = (state) => withSafetyGate(state).safetyGate.status;

function withAuthorization(value, run) {
  const prev = process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
  if (value === undefined) delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
  else process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION = value;
  try { run(); } finally {
    if (prev === undefined) delete process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION;
    else process.env.CDSS_REDFLAG_DOSE_AUTHORIZATION = prev;
  }
}

const ADULT = caseOf({});
assert.equal(gateOf(ADULT), "red_flag", "夹具前提：该病例必须命中红旗，否则本套件测的不是红旗路径");

// ── 1. 默认档必须与线上一致：红旗不给剂量 ──────────────────────────────────
withAuthorization(undefined, () => {
  assert.equal(redFlagDoseAuthorizationAllowed(), false, "缺省必须是 withhold");
  assert.equal(modeOf(ADULT), "non_dose_only", "默认档下红旗病例不得取得剂量级候选");
});
withAuthorization("withhold", () => {
  assert.equal(modeOf(ADULT), "non_dose_only", "显式 withhold 与默认一致");
});

// ── 2. 开关必须**真的起作用**（旧套件只验自报值，抓不到失效） ───────────────
withAuthorization("allow", () => {
  assert.equal(redFlagDoseAuthorizationAllowed(), true, "allow 档开关自报值必须为真");
  assert.notEqual(
    modeOf(ADULT), "non_dose_only",
    "allow 是运维回退档：成人红旗必须能重新取得剂量级候选，否则开关等于不存在——" +
    "这正是上一版的缺陷（三档输出一字不差）",
  );
});

// ── 3. 独立硬边界不受开关影响（本次审查抓到的真实漏洞） ─────────────────────
// 儿童（2026-09-30 起）：年龄段可判的按年龄分数法出剂量，不再是独立硬边界；**年龄段判不出**（只写「患儿」）才是——
// 独立硬边界的代表换成它，「红旗开关不得绕过独立硬边界」这条原则照旧两头钉。
const PEDIATRIC = caseOf({
  patient: { sex: "男" }, chiefComplaint: `患儿${REDFLAG_TEXT}`, symptoms: { general: `患儿${REDFLAG_TEXT}`, tcmFourExams: "" },
  vitals: "T36.7℃ P100次/分 R22次/分 BP100/64mmHg",
});
const PEDIATRIC_KNOWN_AGE = caseOf({ patient: { sex: "男", age: 6 }, vitals: "T36.7℃ P100次/分 R22次/分 BP100/64mmHg" });
const PREGNANT = caseOf({
  patient: { sex: "女", age: 29 },
  // 措辞刻意用无歧义的「妊娠12周」：本套件的被测对象是开关，不是妊娠识别词表。
  // 实测「停经12周，本院建卡产检中」当前判不出妊娠阳性——那是另一条独立缺口，另记。
  pastHistory: "妊娠12周，规律产检中",
});
for (const value of [undefined, "withhold", "allow"]) {
  withAuthorization(value, () => {
    assert.equal(
      modeOf(PEDIATRIC), "non_dose_only",
      `年龄段判不出的儿童病例，剂量边界不得被红旗剂量开关绕过（档位=${value ?? "默认"}）：` +
      "旧版 advise 档实测给出 full_dose，儿科硬边界被红旗分支的提前返回整条跳过",
    );
    assert.equal(
      modeOf(PREGNANT), "non_dose_only",
      `妊娠阳性的剂量边界不得被红旗剂量开关绕过（档位=${value ?? "默认"}）`,
    );
  });
}

// 年龄段可判的儿童：只有红旗轴管它——默认/withhold 收回，allow 回退档放行并带折算档位（不再有独立的儿科硬边界）。
for (const value of [undefined, "withhold"]) {
  withAuthorization(value, () => {
    assert.equal(modeOf(PEDIATRIC_KNOWN_AGE), "non_dose_only", `红旗未解除：6 岁儿童同样收回剂量（档位=${value ?? "默认"}）`);
  });
}
withAuthorization("allow", () => {
  const permission = derivePrescriptionPermission(withSafetyGate(PEDIATRIC_KNOWN_AGE));
  assert.notEqual(permission.candidateMode, "non_dose_only", "allow 回退档：年龄段可判的儿童不再有独立硬边界");
  assert.equal(permission.pediatricDose?.stage, "preschool", "放行时带年龄分数法档位（6 岁 → 学龄前 1/2）");
});

// ── 4. 非红旗病例不受本开关影响 ────────────────────────────────────────────
const BENIGN_TEXT = "胃脘隐痛伴口干3月，饥不欲食，口干咽燥，大便干结";
const BENIGN = caseOf({
  patient: { sex: "女", age: 52 },
  chiefComplaint: BENIGN_TEXT,
  symptoms: { general: `${BENIGN_TEXT}。无呕血黑便，无消瘦，无吞咽困难，无发热。`, tcmFourExams: "" },
  tongue: "舌红少津，苔少而剥", pulse: "脉细数",
  vitals: "T36.6℃ P78次/分 R18次/分 BP118/74mmHg",
});
assert.notEqual(gateOf(BENIGN), "red_flag", "夹具前提：对照病例不得命中红旗");
const benignModes = new Set();
for (const value of [undefined, "withhold", "allow"]) {
  withAuthorization(value, () => { benignModes.add(modeOf(BENIGN)); });
}
assert.equal(benignModes.size, 1, `非红旗病例的权限不得随红旗剂量开关变化（实得 ${[...benignModes].join("/")}）`);
assert.notEqual([...benignModes][0], "non_dose_only", "普通门诊病例不得因本开关被降级");

// ── 5. 生产 smoke 的完整链夹具必须真的走 C + ready + full_dose ─────────
// 不能只看 M03 有签名、M04 有药味：needs_information 下的 limited_dose 也可以同时满足这两项。
const PROD_SMOKE_FULL_DOSE_CASE = {
  id: "prod-smoke-preflight-contract",
  customerId: "test-customer",
  patient: { sex: "女", age: 28 },
  chiefComplaint: "产后2月余，头痛反复发作1月",
  symptoms: {
    presentHistory: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华。否认突发最剧烈头痛、胸痛、呼吸困难、晕厥及意识障碍。",
    general: "神疲乏力、心悸失眠、面色少华",
  },
  tongue: "舌淡苔薄白",
  pulse: "脉细弱",
  conversation: [],
  vitals: { T: "36.8℃", P: "78次/分", R: "18次/分", BP: "112/72mmHg", SpO2: "98%" },
  pastHistory: "否认高血压、糖尿病及神经系统疾病史。现否认妊娠，未哺乳，近期无备孕计划。否认打鼾、睡眠中呼吸暂停和日间嗜睡。",
  medicationHistory: "本次尚未使用其他药物。",
  allergyHistory: "否认药物过敏。",
};
const smokeGated = withSafetyGate(PROD_SMOKE_FULL_DOSE_CASE);
assert.equal(smokeGated.completeness.level, "C", "smoke 夹具必须命中服务端权威 C 级完整度");
assert.equal(smokeGated.safetyGate.status, "ready", "smoke 夹具必须通过服务端全部安全预检");
assert.equal(derivePrescriptionPermission(smokeGated).candidateMode, "full_dose", "smoke 夹具必须覆盖 full_dose 而非 limited_dose");

const redFlagsRouteSource = readFileSync(path.join(repoRoot, "src/app/api/diagnosis/red-flags/route.ts"), "utf8");
assert.equal((redFlagsRouteSource.match(/operationalCompleteness:/g) || []).length, 2,
  "red-flags 的常规与确定性危急早返回都必须回传权威完整度");
assert.equal((redFlagsRouteSource.match(/prescriptionPermission:/g) || []).length, 2,
  "red-flags 的两条返回路径都必须回传处方权限档位");

// ── 6. 独立硬边界不受「病历不完整 + 尚未追问」影响（2026-10-13 全面回归实测） ─────────────
// 本套件此前的夹具全部是 questionRounds: 1，所以没走到这条路径：完整度不到 C 且一轮追问都没答时，
// derivePrescriptionPermission 先返回 limited_dose，妊娠阳性/可疑、哺乳、抗凝、患儿年龄不明这几道
// 独立硬边界根本轮不到评估——同一份病历写得越少，反而越能拿到剂量。本机实测 5 例全部给出带剂量方
// （妊娠 12 周给姜半夏 9g、华法林给乳香没药、哺乳期给王不留行，HIS 还是 ready/valid），
// 而 M05 用的 hardDoseSafetyBoundaryReasons 同时在说「已记录妊娠…不得采纳」：两处各判各的。
// HIS 直连接口不答追问就是 questionRounds=0，这是甲方的主路径。
const SPARSE = {
  id: "hard-boundary-sparse", phase: "prescribe", conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "", maxQuestionRounds: 1,
};
const HARD_BOUNDARY_CASES = {
  妊娠阳性: { patient: { sex: "女", age: 28 }, chiefComplaint: "停经12周，恶心呕吐2周", symptoms: { presentHistory: "停经12周，B超提示宫内早孕。近2周恶心呕吐。" } },
  可能怀孕: { patient: { sex: "女", age: 30 }, chiefComplaint: "胃脘胀痛1周", symptoms: { presentHistory: "胃脘胀痛，嗳气。月经推迟10天，自述可能怀孕。" } },
  哺乳期: { patient: { sex: "女", age: 29 }, chiefComplaint: "右乳胀痛3天", symptoms: { presentHistory: "产后3月，哺乳期，右乳胀痛。" } },
  抗凝治疗: { patient: { sex: "男", age: 66 }, chiefComplaint: "右膝关节刺痛半年", symptoms: { presentHistory: "右膝刺痛，痛处固定。" }, medicationHistory: "长期服用华法林。" },
  患儿年龄不明: { patient: { sex: "男" }, chiefComplaint: "患儿咳嗽流涕2天", symptoms: { presentHistory: "患儿2天前受凉后咳嗽，流清涕，无发热，纳可。" }, tongue: "舌淡红苔薄白", pulse: "脉浮" },
};
// 同一批病历去掉硬边界那一句：信息有限仍然只是「有限信息候选」，不得被本次修复顺带收回剂量。
const SPARSE_CONTROLS = {
  普通胃痛: { patient: { sex: "女", age: 30 }, chiefComplaint: "胃脘胀痛1周", symptoms: { presentHistory: "胃脘胀痛，嗳气。现否认妊娠，未哺乳，无备孕计划。" } },
  普通膝痛: { patient: { sex: "男", age: 66 }, chiefComplaint: "右膝关节刺痛半年", symptoms: { presentHistory: "右膝刺痛，痛处固定。" }, medicationHistory: "近期未服药。" },
  年龄已知儿童: { patient: { sex: "男", age: 6 }, chiefComplaint: "咳嗽流涕2天", symptoms: { presentHistory: "2天前受凉后咳嗽，流清涕，无发热，纳可。" }, tongue: "舌淡红苔薄白", pulse: "脉浮" },
  只有主诉: { patient: {}, chiefComplaint: "胃痛3天", symptoms: {} },
};
const COMPLETE_FIELDS = {
  tongue: "舌淡红苔薄白", pulse: "脉滑",
  vitals: { T: "36.6℃", P: "76次/分", R: "18次/分", BP: "122/78mmHg" },
  pastHistory: "既往体健。", allergyHistory: "否认药物过敏。",
};
let hardBoundaryCells = 0;
for (const [label, patch] of Object.entries(HARD_BOUNDARY_CASES)) {
  for (const questionRounds of [0, 1]) {
    for (const [shape, extra] of [["不完整", {}], ["补全四诊与既往", COMPLETE_FIELDS]]) {
      const state = withSafetyGate({ ...SPARSE, ...extra, ...patch, questionRounds });
      const permission = derivePrescriptionPermission(state);
      const where = `${label}·${shape}·questionRounds=${questionRounds}（完整度 ${state.completeness?.level}）`;
      assert.notEqual(state.safetyGate.status, "red_flag", `夹具前提：${where} 不得命中红旗，否则测的是红旗轴`);
      assert.ok(hardDoseSafetyBoundaryReasons(state).length > 0, `夹具前提：${where} 必须被 hardDoseSafetyBoundaryReasons 认作独立硬边界`);
      assert.equal(permission.candidateMode, "non_dose_only",
        `${where}：独立硬边界必须收回剂量，不得因「病历不完整且尚未追问」先拿到 limited_dose`);
      assert.equal(permission.formalAdoption, "blocked", `${where}：不得可采纳`);
      assert.ok(!permission.reasons.some((reason) => /关键信息覆盖有限/.test(reason)),
        `${where}：理由必须是硬边界本身，不是「信息覆盖有限」`);
      hardBoundaryCells += 1;
    }
  }
}
assert.equal(hardBoundaryCells, 20, "5 类硬边界 × 2 种完整度 × 2 种追问轮次");
for (const [label, patch] of Object.entries(SPARSE_CONTROLS)) {
  const state = withSafetyGate({ ...SPARSE, ...patch, questionRounds: 0 });
  assert.notEqual(state.completeness?.level, "C", `对照前提：${label} 必须是不完整病历`);
  assert.deepEqual(hardDoseSafetyBoundaryReasons(state), [], `对照前提：${label} 没有独立硬边界`);
  assert.equal(derivePrescriptionPermission(state).candidateMode, "limited_dose",
    `${label}：没有硬边界的不完整病历仍按有限信息出候选（追问是增强手段，不是门槛）`);
}

console.log("test-redflag-dose-authorization: OK", {
  switchValues: 3,
  independentBoundaries: ["pediatric", "pregnancy"],
  hardBoundaryCells,
  prodSmokeFullDosePreflight: true,
});

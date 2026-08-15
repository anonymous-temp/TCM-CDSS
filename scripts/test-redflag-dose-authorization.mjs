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
 * 【现在的口径】两轴分开：
 *   · CDSS_GATE_DISPOSITION 管流程与呈现（红旗后还给不给 M03 分析、警示置不置顶）；
 *   · CDSS_REDFLAG_DOSE_AUTHORIZATION 管剂量授权，默认 withhold（与线上一致），
 *     allow 是运维回退档。
 * 独立硬边界（儿科/妊娠/语义筛查/高危剂量）**不受任何一个开关影响**——这正是本套件的重点。
 */
import assert from "node:assert/strict";
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
const { withSafetyGate, derivePrescriptionPermission, redFlagDoseAuthorizationAllowed } =
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
const PEDIATRIC = caseOf({ patient: { sex: "男", age: 6 }, vitals: "T36.7℃ P100次/分 R22次/分 BP100/64mmHg" });
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
      `儿童病例的剂量边界不得被红旗剂量开关绕过（档位=${value ?? "默认"}）：` +
      "旧版 advise 档实测给出 full_dose，儿科硬边界被红旗分支的提前返回整条跳过",
    );
    assert.equal(
      modeOf(PREGNANT), "non_dose_only",
      `妊娠阳性的剂量边界不得被红旗剂量开关绕过（档位=${value ?? "默认"}）`,
    );
  });
}

// ── 4. 两轴不得再被绑回同一个开关 ──────────────────────────────────────────
{
  const prevDisposition = process.env.CDSS_GATE_DISPOSITION;
  const seen = new Set();
  for (const disposition of [undefined, "advise", "block"]) {
    if (disposition === undefined) delete process.env.CDSS_GATE_DISPOSITION;
    else process.env.CDSS_GATE_DISPOSITION = disposition;
    withAuthorization("allow", () => { seen.add(modeOf(ADULT)); });
  }
  if (prevDisposition === undefined) delete process.env.CDSS_GATE_DISPOSITION;
  else process.env.CDSS_GATE_DISPOSITION = prevDisposition;
  assert.equal(
    seen.size, 1,
    "剂量授权只能由 CDSS_REDFLAG_DOSE_AUTHORIZATION 决定；" +
    `CDSS_GATE_DISPOSITION 改变了它说明两轴又被绑回一起（实得 ${[...seen].join("/")}）`,
  );
}

// ── 5. 非红旗病例不受本开关影响 ────────────────────────────────────────────
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

console.log("test-redflag-dose-authorization: OK", {
  switchValues: 3,
  independentBoundaries: ["pediatric", "pregnancy"],
  axesKeptSeparate: true,
});

// 儿童生命体征的年龄分档判定线 + 年龄记录冲突的数值比较（2026-09-30 儿童剂量回放暴露）。
//
// 缺陷：成人固定线（心率≥150 红旗/≥120 复测、呼吸≥35 红旗/≥25 复测、收缩压≤80 或舒张压≤45 危急）把健康新生儿
// （呼吸 40～45）判成红旗、把 8 月龄婴儿心率 120/呼吸 32 判成「需尽快复测」，儿童剂量放开后新生儿/乳婴儿几乎每例都被收回剂量；
// 另外调用方给数值年龄 0.6667、HIS 栏写「8个月」被逐字比较判成「年龄记录冲突」。
// 判定线取自联网核对的教材/指南（数据与出处：src/data/tcm-pediatric-vital-reference.source.json）。
// 每条断言带反证：成人线不动、边界相邻档、危险值仍报、年龄未知走成人线。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus",
  REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const safety = jiti("../src/lib/diagnosis-safety.ts");
const types = jiti("../src/lib/diagnosis-types.ts");
const reference = jiti("../src/lib/pediatric-vital-reference.ts");
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const failures = [];
let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 700) }); }
};

function caseWith({ age, P, R, BP, patientAge, chiefComplaint = "咳嗽痰多3天" }) {
  const base = types.createInitialCaseState();
  const fields = {
    sex: "男", zhushu: chiefComplaint, T: undefined,
    ...(age != null ? { age } : {}),
    ...(P != null ? { vitalsP: `${P}次/分` } : {}),
    ...(R != null ? { vitalsR: `${R}次/分` } : {}),
    ...(BP != null ? { vitalsBP: `${BP}mmHg` } : {}),
  };
  delete fields.T;
  return {
    ...base,
    phase: "question",
    chiefComplaint,
    questionRounds: 1,
    ...(patientAge != null ? { patient: { ...base.patient, sex: "男", age: patientAge } } : {}),
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1", source: "test", caseId: base.id, updatedAt: new Date(0).toISOString(),
      fields, rawText: Object.values(fields).join("；"),
    },
  };
}
const flags = (state) => safety.detectProgrammaticRedFlags(state).filter((flag) => /^(?:心率|呼吸|血压)/.test(flag));
const adv = (state) => safety.measuredVitalAdvisories(state).filter((flag) => /^(?:心率|呼吸|血压)/.test(flag));

check("1.1 新生儿正常呼吸 40 / 心率 128 不再是红旗，也不提示复测（回放实例：12 天新生儿）", () => {
  const state = caseWith({ age: "12天", P: 128, R: 40 });
  assert.deepEqual(flags(state), []);
  assert.deepEqual(adv(state), []);
});

check("1.2 反证：同样的读数在成人仍是红旗/复测（成人线不动）", () => {
  assert.match(flags(caseWith({ age: "35岁", R: 40 })).join("；"), /呼吸 40次\/分异常/);
  assert.match(adv(caseWith({ age: "35岁", P: 128 })).join("；"), /心率\/脉搏 128次\/分需尽快复测/);
  assert.match(flags(caseWith({ age: "35岁", P: 155 })).join("；"), /心率\/脉搏 155次\/分异常/);
});

check("1.3 婴儿（8 月龄）心率 120、呼吸 30 是正常值，不提示复测；呼吸 32 已超 6～12 月龄正常上限 30 → 只是复测提示（回放实例）", () => {
  const state = caseWith({ age: "8个月", P: 120, R: 30 });
  assert.deepEqual(flags(state), []);
  assert.deepEqual(adv(state), []);
  assert.match(adv(caseWith({ age: "8个月", P: 120, R: 32 })).join("；"), /呼吸 32次\/分需尽快复测/, "反证：超上限仍提示");
  assert.deepEqual(flags(caseWith({ age: "8个月", P: 120, R: 32 })), [], "复测提示不是红旗");
});

check("1.4 危险值仍报：新生儿呼吸 ≥60 / 心率 ≥220 红旗；婴儿呼吸 ≥50；幼儿呼吸 ≥40、心率 ≥180", () => {
  assert.match(flags(caseWith({ age: "12天", R: 60 })).join("；"), /呼吸 60次\/分异常/);
  assert.equal(flags(caseWith({ age: "12天", R: 59 })).length, 0, "反证：59 不是红旗（WHO 快速呼吸线 <2 月 ≥60）");
  assert.match(flags(caseWith({ age: "12天", P: 220 })).join("；"), /心率\/脉搏 220次\/分异常/);
  assert.equal(flags(caseWith({ age: "12天", P: 219 })).length, 0);
  assert.match(flags(caseWith({ age: "8个月", R: 50 })).join("；"), /呼吸 50次\/分异常/);
  assert.equal(flags(caseWith({ age: "8个月", R: 49 })).length, 0);
  assert.match(flags(caseWith({ age: "2岁", R: 40 })).join("；"), /呼吸 40次\/分异常/);
  assert.equal(flags(caseWith({ age: "2岁", R: 39 })).length, 0);
  assert.match(flags(caseWith({ age: "2岁", P: 180 })).join("；"), /心率\/脉搏 180次\/分异常/);
  assert.equal(flags(caseWith({ age: "2岁", P: 179 })).length, 0);
});

check("1.6 复测提示线：婴儿呼吸 41～49、心率 187～219；幼儿呼吸 31～39、心率 152～179", () => {
  const infantBreath = adv(caseWith({ age: "3个月", R: 45 }));
  assert.match(infantBreath.join("；"), /呼吸 45次\/分需尽快复测/);
  assert.equal(adv(caseWith({ age: "3个月", R: 40 })).length, 0, "40 仍在 0～5 月龄正常上限内");
  assert.match(adv(caseWith({ age: "3个月", P: 190 })).join("；"), /心率\/脉搏 190次\/分需尽快复测/);
  assert.equal(adv(caseWith({ age: "3个月", P: 186 })).length, 0);
  assert.match(adv(caseWith({ age: "2岁", R: 35 })).join("；"), /呼吸 35次\/分需尽快复测/);
  assert.match(adv(caseWith({ age: "2岁", P: 160 })).join("；"), /心率\/脉搏 160次\/分需尽快复测/);
});

check("1.7 12 岁及以上、年龄未知 → 沿用成人线（不放宽）", () => {
  assert.match(flags(caseWith({ age: "12岁", R: 36 })).join("；"), /呼吸 36次\/分异常/);
  assert.match(flags(caseWith({ age: "15岁", P: 155 })).join("；"), /心率\/脉搏 155次\/分异常/);
  assert.match(flags(caseWith({ R: 40 })).join("；"), /呼吸 40次\/分异常/, "年龄未知 → 成人线");
  assert.equal(reference.pediatricVitalReferenceForAgeYears(12), undefined);
  assert.equal(reference.pediatricVitalReferenceForAgeYears(undefined), undefined);
  assert.equal(reference.pediatricVitalReferenceForAgeYears(-1), undefined);
});

check("1.8 5～12 岁：呼吸红旗仍是成人 35（已高于 WHO 5～12 岁 30 线，不放宽）；复测线放到 WHO 快速呼吸线 31", () => {
  assert.match(flags(caseWith({ age: "9岁", R: 35 })).join("；"), /呼吸 35次\/分异常/);
  assert.equal(adv(caseWith({ age: "9岁", R: 28 })).length, 0, "9 岁呼吸 28 在 WHO 快速呼吸线（>30）之下");
  assert.match(adv(caseWith({ age: "9岁", R: 32 })).join("；"), /呼吸 32次\/分需尽快复测/);
});

check("1.9 只写档位词（没有数值年龄）时取该档最大年龄：更保守的一侧", () => {
  const infant = caseWith({ P: 120, R: 55, chiefComplaint: "婴儿咳嗽3天" });
  assert.match(flags(infant).join("；"), /呼吸 55次\/分异常/, "婴儿档按 6～12 月龄取线：呼吸红旗 50");
  const newborn = caseWith({ R: 45, chiefComplaint: "新生儿黄疸10天" });
  assert.deepEqual(flags(newborn), [], "新生儿档呼吸 45 正常");
});

check("2.1 儿童低血压线：婴儿 75/45 不再危急；<70 才危急；成人 75/45 仍危急", () => {
  assert.equal(flags(caseWith({ age: "8个月", BP: "75/45" })).length, 0);
  assert.equal(adv(caseWith({ age: "8个月", BP: "75/45" })).length, 0);
  assert.match(flags(caseWith({ age: "8个月", BP: "68/40" })).join("；"), /血压 68\/40mmHg 达低血压\/休克风险警戒值/);
  assert.match(flags(caseWith({ age: "35岁", BP: "75/45" })).join("；"), /低血压\/休克风险警戒值/);
  assert.equal(flags(caseWith({ age: "5岁", BP: "85/50" })).length, 0, "5 岁线 70+2×5=80");
  assert.match(flags(caseWith({ age: "5岁", BP: "78/50" })).join("；"), /低血压\/休克风险警戒值/);
  assert.match(flags(caseWith({ age: "12岁", BP: "78/50" })).join("；"), /低血压\/休克风险警戒值/, "12 岁沿用成人线");
});

check("2.2 高血压线不动（儿童 190/125 仍报）", () => {
  assert.match(flags(caseWith({ age: "8岁", BP: "190/125" })).join("；"), /重度高血压警戒值/);
});

check("3.1 年龄记录冲突按数值比：0.6667 岁 = 8个月；12天 = 0.0329 岁；35 ≠ 36；8个月 ≠ 5 岁", () => {
  const conflict = (patientAge, age) => safety.evaluateSafetyGate(caseWith({ age, patientAge })).missingItemCodes.includes("age_conflict");
  assert.equal(conflict(0.6667, "8个月"), false);
  assert.equal(conflict(0.0329, "12天"), false);
  assert.equal(conflict(0.67, "8个月"), false);
  assert.equal(conflict(35, "35岁"), false);
  assert.equal(conflict(35, "36岁"), true, "反证：成人相差 1 岁仍是冲突");
  assert.equal(conflict(5, "8个月"), true, "反证：8 个月 ≠ 5 岁");
  assert.equal(conflict(2, "12天"), true);
  assert.equal(conflict(35, "三十五"), true, "解析不了的仍回落字面量比较：不同即冲突");
});

check("4.1 数据文件：每个年龄带的判定线不低于成人复测线的下限之外的越界值，且带连续无缝（0 天～12 岁）", () => {
  const data = JSON.parse(source("src/data/tcm-pediatric-vital-reference.source.json"));
  let expected = 0;
  for (const band of data.bands) {
    assert.equal(band.minDays, expected, `${band.label} 起点必须接上一档终点`);
    assert.ok(band.maxDays > band.minDays);
    expected = band.maxDays;
    assert.ok(band.pulseAdvisoryFrom < band.pulseRedFlagFrom, `${band.label} 心率复测线必须低于红旗线`);
    assert.ok(band.respirationAdvisoryFrom < band.respirationRedFlagFrom, `${band.label} 呼吸复测线必须低于红旗线`);
    assert.ok(band.respirationRedFlagFrom >= 35, `${band.label} 呼吸红旗线不得低于成人线 35（本表只放宽）`);
    assert.ok(band.pulseRedFlagFrom >= 150, `${band.label} 心率红旗线不得低于成人线 150（本表只放宽）`);
  }
  assert.equal(expected, 12 * 365, "覆盖到 12 岁");
  assert.ok(data.sourceRefs.length >= 5 && data.sourceRefs.every((ref) => ref.quote && ref.basis));
});

check("5.1 儿童折算说明不进「需确认」清单：reasons 里没有，pediatricDose 携带", () => {
  const permission = safety.derivePrescriptionPermission(caseWith({ age: "8个月", P: 120, R: 30, patientAge: 0.6667 }));
  assert.equal(permission.pediatricDose?.stage, "infant");
  assert.equal(permission.reasons.some((reason) => /年龄分数法/.test(reason)), false);
});

check("6.1 部分构造的病例（没有 patient 对象）不抛错：年龄性别未知按成人线处理", () => {
  assert.doesNotThrow(() => safety.detectProgrammaticRedFlags({ chiefComplaint: "呼吸急促", conversation: [], hisRecord: { fields: { vitalsR: "40次/分" } } }));
  assert.match(safety.detectProgrammaticRedFlags({ chiefComplaint: "呼吸急促", conversation: [], hisRecord: { fields: { vitalsR: "40次/分" } } }).join("；"), /呼吸 40次\/分异常/);
});

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks }, null, 2));

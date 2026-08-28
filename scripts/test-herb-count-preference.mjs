// 饮片味数偏好与流派选择入参（甲方 2026-08-05 接口缺失 #1，优先级「高」）。
//
// 这两个入参代码早就实现了，却是 9 项里唯一没闭环的一条——因为文档没露出、也没有任何回归钉住。
// 实测代价：`between_10_15` 的归一正则漏了 en dash，而**系统自己在 prompt 里印的就是「10–15 味」**
// （U+2013）。甲方照抄回传，三档里恰好中间那一档静默失效、不报错、无日志，
// 复现时只会得出「味数偏好时灵时不灵」的结论。
//
// 另一处易踩：herbCountPreference **只认 caseState 顶层**，放进 hisRecord.fields 不生效且不报错；
// 而同为「高」优先级的 tcmLineagePreference 两个通道都生效。两者行为不同，必须各自钉死，
// 否则哪天有人「顺手统一一下」就会悄悄改变甲方已经集成的语义。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { buildPrescribePrompt, buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { LINEAGE_CARDS } = await jiti.import("../src/lib/tcm-lineages.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// 甲方 11 项里「流派/药味数量配置」判为未完成——不是后端没做，是**页面上没有控件**，
// 而且 applyDraftToCaseState 还把流派硬编码成 "unrestricted"，医生就算选了也会被丢。
// 这条钉的是那两处，避免又退回「后端支持、医生用不上」的状态。
check("流派与味数在页面上可配置，且 draft 的值真的写回 caseState", () => {
  const client = readFileSync(`${process.cwd()}/src/app/diagnosis/DiagnosisClient.tsx`, "utf8");
  assert.match(client, /testId="lineage-preference"/, "缺少诊疗思路（流派）选择控件");
  assert.match(client, /testId="herb-count-preference"/, "缺少饮片味数选择控件");
  assert.doesNotMatch(
    client,
    /tcmLineagePreference:\s*"unrestricted",\s*\n\s*clinicTreatmentCapabilities: draft\./,
    "写回 caseState 时不得把流派硬编码成 unrestricted，否则控件形同虚设",
  );
  assert.match(client, /herbCountPreference: normalizeHerbCountDraft\(draft\.herbCountPreference\)/,
    "味数偏好必须从 draft 写回 caseState");
});

const base = { id: "HCP-1", chiefComplaint: "反复头痛3月", patient: { sex: "女", age: 34 } };
const normalizedWith = (extra) => normalizeCaseStateInput({ ...base, ...extra });

check("HCP-01 三个受控代码原样生效", () => {
  for (const code of ["within_10", "between_10_15", "at_least_15"]) {
    assert.equal(normalizedWith({ herbCountPreference: code })?.herbCountPreference, code, code);
  }
});

check("HCP-02 中文与符号写法归一到正确档位（含 en dash / em dash）", () => {
  const expectations = [
    ["10味以内", "within_10"],
    ["≤10", "within_10"],
    ["<10", "within_10"],
    ["10-15", "between_10_15"],
    ["10–15", "between_10_15"],   // U+2013 en dash —— 系统自己 prompt 里印的就是这个
    ["10—15", "between_10_15"],   // U+2014 em dash
    ["10~15", "between_10_15"],
    ["10至15", "between_10_15"],
    ["10－15", "between_10_15"],   // 全角连字符
    ["15味及以上", "at_least_15"],
    ["15味以上", "at_least_15"],
    ["≥15", "at_least_15"],
    [">15", "at_least_15"],
  ];
  for (const [input, expected] of expectations) {
    assert.equal(
      normalizedWith({ herbCountPreference: input })?.herbCountPreference,
      expected,
      `「${input}」应归一为 ${expected}`,
    );
  }
});

check("HCP-03 非法写法一律丢弃为空且不报错（绝不猜档位）", () => {
  for (const input of ["WITHIN_10", 12, "少一点", "", null, "8-20", {}, []]) {
    const normalized = normalizedWith({ herbCountPreference: input });
    assert.ok(normalized, `caseState 因 herbCountPreference=${JSON.stringify(input)} 被整体拒收`);
    assert.equal(
      normalized.herbCountPreference,
      undefined,
      `「${JSON.stringify(input)}」被猜成了 ${normalized.herbCountPreference}——宁可不生效，不可猜`,
    );
  }
});

check("HCP-04 只认顶层：hisRecord.fields 通道不生效（与流派不同，必须显式钉住）", () => {
  const viaHis = normalizeCaseStateInput({
    ...base,
    hisRecord: { fields: { herbCountPreference: "within_10" } },
  });
  assert.equal(
    viaHis?.herbCountPreference,
    undefined,
    "herbCountPreference 开始从 hisRecord.fields 生效了——这是行为变更，" +
      "必须同步改 docs/中医CDSS-对外接口文档.md §3.3.3 第 1 条，否则文档与实现分叉",
  );
});

check("HCP-05 只进 M04 prompt，M03 不读取", () => {
  const caseState = normalizedWith({ herbCountPreference: "within_10" });
  const prescribe = buildPrescribePrompt(caseState);
  assert.ok(
    /味数/.test(prescribe),
    "M04 prompt 未注入味数偏好——入参收下了却没送到唯一会用它的阶段",
  );
  const diagnose = buildDiagnosePrompt(caseState);
  assert.ok(!/饮片味数偏好/.test(diagnose), "M03 prompt 混入了味数偏好，超出该入参的声明作用域");
});

check("HCP-06 软偏好：不得在 prompt 里表述为硬性裁剪", () => {
  // 甲方对味数的口径是「如诊疗必须也不能裁剪」。指令若写成硬约束，
  // 模型会为凑数删掉绑定病机节点的必需药味——那比不支持这个入参危险得多。
  const prescribe = buildPrescribePrompt(normalizedWith({ herbCountPreference: "within_10" }));
  const band = prescribe.slice(Math.max(0, prescribe.indexOf("味数") - 200), prescribe.indexOf("味数") + 400);
  assert.ok(
    /不得|不能|优先|偏好|尽量/.test(band),
    `味数指令缺少软化措辞，可能被当成硬约束：${JSON.stringify(band.slice(0, 200))}`,
  );
});

check("HCP-07 流派：6 张受控卡片的 code 全部可直接作为入参", () => {
  assert.equal(LINEAGE_CARDS.length, 6, `流派卡片数变为 ${LINEAGE_CARDS.length}，需同步接口文档 §3.3.2 的表`);
  for (const card of LINEAGE_CARDS) {
    assert.equal(
      normalizedWith({ tcmLineagePreference: card.code })?.tcmLineagePreference,
      card.code,
      `流派 ${card.code} 不被接受`,
    );
  }
});

check("HCP-08 流派：中文别名可用，且两条通道都生效", () => {
  assert.equal(normalizedWith({ tcmLineagePreference: "温病" })?.tcmLineagePreference, "warm-disease");
  assert.equal(normalizedWith({ tcmLineagePreference: "温补学派" })?.tcmLineagePreference, "warm-tonify");
  assert.equal(normalizedWith({ tcmLineagePreference: "扶阳学派" })?.tcmLineagePreference, "support-yang");
  const viaHis = normalizeCaseStateInput({
    ...base,
    hisRecord: { fields: { tcmLineagePreference: "classical-formula" } },
  });
  assert.equal(
    viaHis?.tcmLineagePreference,
    "classical-formula",
    "流派的 hisRecord.fields 通道失效了——文档 §3.3.2 声明两条通道都生效",
  );
});

check("HCP-09 流派缺省为 unrestricted，非法值不得猜成某个流派", () => {
  assert.equal(normalizedWith({})?.tcmLineagePreference, "unrestricted");
  for (const input of ["不存在的流派", 42, {}]) {
    assert.equal(
      normalizedWith({ tcmLineagePreference: input })?.tcmLineagePreference,
      "unrestricted",
      `非法流派 ${JSON.stringify(input)} 被猜成了具体流派`,
    );
  }
});

check("HCP-10 文档与实现同源：流派表与卡片表必须同集（双向）", () => {
  // 这一条是本套件存在的直接原因：功能做完了、文档没露出，甲方就判为未交付。
  // **双向**：只查「实现有的文档必须有」是不够的——文档一度列了 13 个流派而实现只承诺其中
  // 一部分，单向断言全绿。反向漏检就是本项目反复出现的「两处各写各的」。
  const doc = readFileSync("docs/中医CDSS-对外接口文档.md", "utf8");
  for (const card of LINEAGE_CARDS) {
    assert.ok(doc.includes(`\`${card.code}\``), `接口文档缺流派 code：${card.code}`);
  }
  const RETIRED = ["empirical-formula", "spleen-stomach", "menghe", "lingnan", "haipai", "institution-first", "gongxie", "hanliang"];
  const leaked = RETIRED.filter((code) => doc.includes(`\`${code}\``));
  assert.deepEqual(leaked, [], `接口文档仍在承诺已下线的流派：${leaked.join("、")}`);
  for (const band of ["within_10", "between_10_15", "at_least_15"]) {
    assert.ok(doc.includes(`\`${band}\``), `接口文档缺味数取值：${band}`);
  }
  assert.ok(doc.includes("herbCountPreference"), "接口文档整篇没有 herbCountPreference");
});

if (failures.length > 0) {
  console.error("味数/流派入参 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ lineageCards: LINEAGE_CARDS.length, failures: 0 }));

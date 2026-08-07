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
const { LINEAGE_CARDS, PUBLISHED_LINEAGE_CODES, publishedLineageCards } = await jiti.import("../src/lib/tcm-lineages.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

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
      "必须同步改 docs/中医CDSS-对外接口文档.md §2.3.3 第 1 条，否则文档与实现分叉",
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

check("HCP-07 全部受控流派卡片的 code 都可直接作为入参（含未对外发布的）", () => {
  // 未发布 ≠ 不可用：不写进对外文档只是不作为承诺能力，解析必须继续认，否则已集成方会突然报错。
  assert.ok(LINEAGE_CARDS.length >= PUBLISHED_LINEAGE_CODES.length, "受控卡片数少于对外发布集");
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
  const viaHis = normalizeCaseStateInput({
    ...base,
    hisRecord: { fields: { tcmLineagePreference: "classical-formula" } },
  });
  assert.equal(
    viaHis?.tcmLineagePreference,
    "classical-formula",
    "流派的 hisRecord.fields 通道失效了——文档 §2.3.2 声明两条通道都生效",
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

check("HCP-10 文档与实现同源：接口文档必须与对外发布流派集**同集**，且列全 3 个味数取值", () => {
  // 产品决定（2026-08-07）：对外只支持门诊高频 4 个 + 默认档，其余仍可解析但不对外承诺。
  // 本断言双向钉死——发布集里的必须在文档里，**未发布的一个都不许出现在文档里**。
  // 上一版就是照抄实现把 13 个全列了，与「流派支持的可以少一些，三四五个」的决定相悖。
  const doc = readFileSync("docs/中医CDSS-对外接口文档.md", "utf8");
  for (const card of publishedLineageCards()) {
    assert.ok(doc.includes(`\`${card.code}\``), `接口文档缺对外发布的流派 code：${card.code}`);
  }
  const unpublished = LINEAGE_CARDS
    .filter((card) => !PUBLISHED_LINEAGE_CODES.includes(card.code))
    .filter((card) => doc.includes(`\`${card.code}\``));
  assert.deepEqual(
    unpublished.map((card) => card.code),
    [],
    "接口文档出现了未对外发布的流派 code——对外只承诺发布集，多列等于承诺我们没深做的东西",
  );
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

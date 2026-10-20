// 10/20 第十轮：对照竞品 ABC（证型列要素、治法逐要素对应、没有治则）与甲方口径「治则与治法是否与主证候匹配」。
//
//   1 治则按已定证型（主证与兼证）的虚实寒热推：证名有虚即虚、有邪即实，两样都有为扶正祛邪；治法只在证名看不出虚实时参与。
//     第九轮输出回放：治法里多写一句益气养阴就推成扶正祛邪（气滞心胸兼肝火上炎）；痛痹兼肾阳虚推成虚则补之；水凌心肺推成虚则补之。
//     实证而治法带教材本有的治本补益（痰浊壅肺·化痰降气、健脾益气）写标本兼治；寒热错杂证写调理阴阳。
//     对照：甲方 10 例、纯虚、纯实、虚实夹杂的典型证名照旧。
//   2 输出顺序：中医半先写病机（病位、病性逐要素摘依据），后写病名证名（联网调研：证素辨证「证候→证素→证名」；关思考时字段顺序即推理顺序）。
//     提示词写明证名由已列出的病位病性组成、治法逐要素对应、证型里没有的病机不另立治法。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const format = await jiti.import("../src/lib/model-response-format.ts");
const merge = await jiti.import("../src/lib/m03-parallel-merge.ts");
const principle = (primary, method, secondary = []) =>
  visible.nationalTreatmentPrinciple("", { overview: { primarySyndrome: primary, secondarySyndromes: secondary }, therapy: { overallMethod: method } });

await check("1.1 治法里多写的补益不把实证推成扶正祛邪（气滞心胸兼肝火上炎 + 益气养阴 → 热者寒之；温热疫毒 + 扶正达邪 → 热者寒之）", () => {
  assert.equal(principle("气滞心胸证", "疏肝理气，宽胸止痛，益气养阴，清肝泻火", ["肝火上炎证"]), "热者寒之");
  assert.equal(principle("温热疫毒证", "清心凉营，清热生津，扶正达邪，通腑泄热", ["阳明腑实证"]), "热者寒之");
});

await check("1.2 证名看不出虚实的要素按治法判：痛痹兼肾阳虚 → 扶正祛邪；痛痹 → 寒者热之；水凌心肺（温阳利水）→ 扶正祛邪", () => {
  assert.equal(principle("痛痹", "温经散寒，祛风除湿，通络止痛，温补肾阳", ["肾阳虚证"]), "扶正祛邪");
  assert.equal(principle("痛痹", "温经散寒，祛风除湿，通络止痛"), "寒者热之");
  assert.equal(principle("水凌心肺证", "温阳利水，泻肺平喘"), "扶正祛邪");
});

await check("1.3 实证带治本补益 → 标本兼治；寒热错杂 → 调理阴阳；表寒里热不算寒热错杂", () => {
  assert.equal(principle("痰浊壅肺证", "化痰降气，健脾益气，止咳平喘"), "标本兼治");
  assert.equal(principle("寒热错杂证", "辛开苦降，寒热平调"), "调理阴阳");
  assert.notEqual(principle("风寒束表证", "疏风散寒，清泄里热", ["里热炽盛证"]), "调理阴阳");
});

await check("1.4 「乘」「伤气」「两伤」是虚：肝气乘脾 → 扶正祛邪；劳倦伤气 → 虚则补之或扶正祛邪（不写实则泻之）；气阴两伤 → 虚则补之", () => {
  assert.equal(principle("肝气乘脾证", "抑肝扶脾，理气止痛"), "扶正祛邪");
  assert.notEqual(principle("劳倦伤气证", "补中益气，活血舒筋"), "实则泻之");
  assert.equal(principle("气阴两伤证", "益气养阴，生津止渴"), "虚则补之");
  assert.equal(principle("血虚发热证", "益气养血"), "虚则补之");
});

await check("1.5 对照：甲方 10 例与典型证名照旧", () => {
  const expected = [
    ["风寒束表证", "辛温解表，宣肺散寒", "寒者热之"], ["心虚胆怯证", "镇惊定志，养心安神", "虚则补之"],
    ["血虚头痛", "养血滋阴，和络止痛", "虚则补之"], ["肝气犯胃证", "疏肝理气，和胃止痛", "实则泻之"],
    ["肺脾两虚证", "补益肺气，健脾益气，固表止汗", "虚则补之"], ["肾阴虚证", "滋补肾阴", "虚则补之"],
    ["胃火上炎证", "清胃泻火，凉血止痛", "热者寒之"], ["肝经郁热证", "清泻肝火，解毒止痛", "热者寒之"],
    ["风热犯表证", "疏风清热，透疹止痒", "热者寒之"], ["血热证", "清热凉血，固冲调经", "热者寒之"],
    ["阴虚火旺证", "滋阴降火", "虚则补之"], ["气虚血瘀证", "益气活血", "扶正祛邪"], ["脾虚湿盛证", "健脾化湿", "扶正祛邪"],
  ];
  for (const [primary, method, want] of expected) assert.equal(principle(primary, method), want, `${primary}·${method}`);
});

await check("2.1 中医半先写病机后写病名证名：提供商 schema 顺序、并行分工说明、提示词模板一致", () => {
  const schema = format.providerJsonSchemaForTask("m03_tcm");
  const source = readFileSync("src/lib/model-response-format.ts", "utf8");
  assert.match(source, /"schemaVersion", "stage", "pathogenesis", "overview", "therapy"/);
  assert.ok(schema?.properties, "取不到 m03_tcm 的提供商 schema");
  {
    const keys = Object.keys(schema.properties);
    assert.ok(keys.indexOf("pathogenesis") < keys.indexOf("overview"), keys.join(","));
  }
  assert.match(merge.buildM03ParallelHalfSuffix("tcm"), /按此顺序写：pathogenesis、overview、therapy/);
  const prompts = readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  const template = prompts.slice(prompts.indexOf('{\n  "pathogenesis": {'));
  assert.ok(template.indexOf('"pathogenesis": {') < template.indexOf('"overview": {'), "模板里病机要在 overview 之前");
  assert.match(prompts, /先辨病位病性、后定证名/);
  assert.match(prompts, /证型里没有的病机不另立治法/);
});

console.log(`r1022-abc: ${cases} cases${process.exitCode ? " (FAILED)" : " ok"}`);

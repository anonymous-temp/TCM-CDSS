/**
 * 指南/文献引用的人群适用性过滤（2026-09-08 用真函数复现的「证据不适用」缺陷）。
 *
 * 此前 diagnosticReferenceAppliesToPatient 把宽口径妇科词（maternal：妇女/妇人/月经…）与胎产严格
 * 口径（obstetric）都拿来**全文**排除：男性或 ≥60 岁患者，只要某条指南摘要里出现一句
 * 「绝经后妇女及老年人」「育龄妇女月经量」，整条就被判不适用——68 岁女性骨质疏松、45 岁男性缺铁性
 * 贫血的**唯一适用指南**因此消失，参考文献区空白。这与 tcm-population-scope.source.json 的治理注记
 * 相悖（maternal「绝不可用于冲突减分」，obstetric 是「唯一可用于人群冲突减分的口径」）。
 *
 * 钉行为：
 *  1) 摘要里的宽口径妇科词不排除（68F 骨质疏松 / 45M 缺铁性贫血 拿到各自指南）；
 *  2) 胎产严格口径全文命中仍排除（男性/≥60 不得引用《妊娠期高血压疾病诊治指南》）；
 *  3) 宽口径词出现在**题名**里仍排除（《月经不调中西医结合诊疗共识》不给男性）；
 *  4) 儿科/老年错配的既有规则不变。
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { buildEvidenceOutputTransform } = await jiti.import("../src/lib/cdss-evidence-context.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const evidence = [
  "## EviMed 指南/共识检索",
  "用途：诊断、治疗原则、随访与转诊依据",
  "命中证据摘要（仅引用下列真实题名、机构、年份和URL；不得编造未列出的资料；引用时使用方括号ID）：",
  "[EVID-GUIDE-001] 儿童骨质疏松症诊断与治疗专家共识（中华医学会儿科学分会，2022）：本共识针对儿童及青少年骨质疏松的诊断标准。 URL:https://example.org/g1",
  "[EVID-GUIDE-002] 原发性骨质疏松症诊疗指南（2022）（中华医学会骨质疏松和骨矿盐疾病分会，2022）：适用于绝经后妇女及老年人原发性骨质疏松症的诊断与治疗。 URL:https://example.org/g2",
  "[EVID-GUIDE-003] 缺铁性贫血诊断与治疗中国专家共识（中华医学会血液学分会，2021）：适用于成人缺铁性贫血，包括育龄妇女月经量增多所致者。 URL:https://example.org/g3",
  "[EVID-GUIDE-004] 妊娠期高血压疾病诊治指南（2020）（中华医学会妇产科学分会，2020）：妊娠期及产后高血压疾病的诊断与处理。 URL:https://example.org/g4",
  "[EVID-GUIDE-005] 月经过多诊治指南（中华医学会妇产科学分会，2021）：经量异常增多的评估、鉴别与治疗。 URL:https://example.org/g5",
].join("\n");

function references(patient, primaryName, chiefComplaint, claimedId) {
  const state = withSafetyGate(normalizeCaseStateInput({ caseId: "evidence-probe", chiefComplaint, rawText: chiefComplaint, patient }));
  const transform = buildEvidenceOutputTransform(evidence, undefined, state);
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: primaryName, supportingFacts: [chiefComplaint], guidelineReferences: [{ evidenceId: claimedId, appliesTo: "模型选择" }] }, differentials: [] },
  };
  const out = transform(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload)}\n<!-- DIAGNOSIS_JSON_END -->`);
  const json = JSON.parse(out.slice(out.indexOf("-->") + 3, out.lastIndexOf("<!--")).trim());
  return (json.westernDiagnosis.primary.guidelineReferences || []).map((item) => item.evidenceId);
}

// 1) 摘要里的宽口径妇科词不再排除唯一适用的指南。
assert.deepEqual(references({ age: 68, sex: "女" }, "原发性骨质疏松症", "腰背痛3月，绝经后骨质疏松", "EVID-GUIDE-002"), ["EVID-GUIDE-002"], "68 岁女性：骨质疏松指南不得因摘要提到「妇女」被排除");
assert.deepEqual(references({ age: 45, sex: "男" }, "缺铁性贫血", "乏力头晕2月，血红蛋白偏低", "EVID-GUIDE-003"), ["EVID-GUIDE-003"], "45 岁男性：贫血共识不得因摘要提到「育龄妇女月经量」被排除");
assert.deepEqual(references({ age: 40, sex: "男" }, "骨质疏松症", "腰背痛3月", "EVID-GUIDE-002"), ["EVID-GUIDE-002"], "40 岁男性：骨质疏松指南适用");
assert.deepEqual(references({ age: 30, sex: "女" }, "缺铁性贫血", "乏力头晕2月，月经量多", "EVID-GUIDE-003"), ["EVID-GUIDE-003"], "30 岁女性：对照");

// 2) 胎产严格口径全文命中仍排除：男性 / ≥60 女性 不得引用妊娠期指南（模型点名也不行）。
assert.deepEqual(references({ age: 45, sex: "男" }, "高血压", "头晕1月，血压偏高", "EVID-GUIDE-004"), [], "男性：妊娠期高血压指南不适用");
assert.deepEqual(references({ age: 68, sex: "女" }, "高血压", "头晕1月，血压偏高，已绝经", "EVID-GUIDE-004"), [], "绝经后女性：妊娠期高血压指南不适用");
assert.deepEqual(references({ age: 28, sex: "女" }, "妊娠期高血压", "孕28周血压升高", "EVID-GUIDE-004"), ["EVID-GUIDE-004"], "育龄女性：妊娠期高血压指南适用（对照）");

// 3) 宽口径词出现在题名里仍排除。
assert.deepEqual(references({ age: 45, sex: "男" }, "月经过多", "乏力", "EVID-GUIDE-005"), [], "男性：题名含「月经」的指南不适用");
assert.deepEqual(references({ age: 30, sex: "女" }, "月经过多", "经量增多3月", "EVID-GUIDE-005"), ["EVID-GUIDE-005"], "育龄女性：月经过多指南适用（对照）");

// 4) 儿科/成人错配的既有规则不变。
assert.deepEqual(references({ age: 40, sex: "男" }, "骨质疏松症", "腰背痛3月", "EVID-GUIDE-001"), ["EVID-GUIDE-002"], "成人点名儿童共识：服务端换成人群适用的首选指南");
assert.deepEqual(references({ age: 9, sex: "男" }, "骨质疏松症", "腰背痛3月", "EVID-GUIDE-001"), ["EVID-GUIDE-001"], "儿童：儿童共识适用");

console.log(JSON.stringify({ suite: "evidence-population-applicability", assertions: 11, failures: 0 }));

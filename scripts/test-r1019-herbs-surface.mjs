// 10/19 第二轮（饮片）：教材锁定方的原有药味不按方向对立驳回（留出集 S046）、教材方取目录原书出处（甲方病历 3 加味四物汤《金匮翼》）、
// 注意事项里不在本方的药名只去掉那一个。夹具取自本地验收运行（scripts/fixtures/r1019/herbs-surface-cases.json）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
let cases = 0;
const check = (name, run) => { cases += 1; try { run(); } catch (error) { process.exitCode = 1; console.error(`✗ ${name}\n  ${error.message}`); } };
const contract = await jiti.import(`${process.cwd()}/src/lib/diagnosis-stage-contract.ts`);
const surface = await jiti.import(`${process.cwd()}/src/lib/delivered-surface.ts`);
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/r1019/herbs-surface-cases.json", import.meta.url), "utf8"));
const s046 = { prescribe: { content: FIXTURE.s046.prescribeContent }, diagnose: { structured: FIXTURE.s046.diagnoseStructured } };
const herbs046 = JSON.parse(s046.prescribe.content.match(/CDSS_NON_DOSE_CANDIDATE_JSON:(\{.*?\}) -->/s)[1]).candidates[0].herbs
  .map((h) => ({ name: h.name, role: h.role, function: h.function, targetPathogenesis: h.targetPathogenesis, prescriptionRole: `${h.role}药：${h.targetPathogenesis}` }));
check("P1 S046：M03 锁定教材本证代表方竹叶石膏汤，去人参、粳米后原方的半夏不再按温燥对立驳回", () => {
  assert.deepEqual(contract.unsupportedHighImpactHerbFindings(herbs046, s046.diagnose.structured, true, []), []);
});
check("P2 对照：M03 没锁这首方时半夏照判；方外加入的温热药（附子）照判", () => {
  const unlocked = structuredClone(s046.diagnose.structured); unlocked.overview.recommendedFormulaNames = [];
  assert.deepEqual(contract.unsupportedHighImpactHerbFindings(herbs046, unlocked, true, []).map((x) => x.name), ["半夏"]);
  const withAconite = [...herbs046, { name: "附子", role: "佐", function: "回阳救逆，散寒止痛", targetPathogenesis: "胃火上逆", prescriptionRole: "佐药：胃火上逆" }];
  assert.ok(contract.unsupportedHighImpactHerbFindings(withAconite, s046.diagnose.structured, true, []).some((x) => x.name === "附子"));
});
const r3 = FIXTURE.case3r3.prescribeStructured;
check("P3 甲方病历 3：出处由教材「代表方」换成名录里与教材组成逐味相同的《金匮翼》卷五；再投影不变", () => {
  const projected = surface.projectDeliveredReasoning(r3);
  assert.match(projected.formula.candidates[0].formulaSource.source, /^加味四物汤：方出《金匮翼》卷五/);
  assert.deepEqual(surface.projectDeliveredReasoning(projected).formula.candidates[0].formulaSource, projected.formula.candidates[0].formulaSource);
});
check("P4 出处占位（「当前可核验依据不足」）且方名是教材代表方、组成过半时写原书（S046 竹叶石膏汤《伤寒论》）；名录没有逐味相同的原书时仍写教材（对照）", () => {
  const fake = structuredClone(r3);
  fake.overview = { ...fake.overview, tcmDiseaseName: "呃逆", primarySyndrome: "胃火上逆证" };
  const candidate = fake.formula.candidates[0];
  candidate.name = "竹叶石膏汤加减";
  candidate.herbs = ["石膏", "竹叶", "麦冬", "知母", "半夏", "柿蒂", "大黄", "厚朴", "炙甘草"].map((name, index) => ({ ...r3.formula.candidates[0].herbs[0], name, role: index < 2 ? "君" : "佐" }));
  candidate.formulaSource = { ...candidate.formulaSource, source: "内部证据缺口" };
  assert.equal(surface.projectDeliveredReasoning(fake).formula.candidates[0].formulaSource.source, "竹叶石膏汤：《伤寒论》");
  const other = structuredClone(r3);
  other.formula.candidates[0].formulaSource = { ...other.formula.candidates[0].formulaSource, source: "加味四物汤：《中医内科学》头痛·血虚头痛代表方" };
  other.formula.candidates[0].herbs = other.formula.candidates[0].herbs.filter((herb) => !["当归", "川芎", "白芍", "菊花"].includes(herb.name));
  assert.match(surface.projectDeliveredReasoning(other).formula.candidates[0].formulaSource.source, /代表方/, "组成不过半：不按这首方写出处");
});
check("P5 交付面按最终处方修剪注意事项（编译之后剔掉的药）", () => {
  const fake = structuredClone(r3);
  fake.nonPharma.precautions = ["方中熟地黄、苍术滋腻燥烈，胃脘不适者请告知医生。", ...fake.nonPharma.precautions];
  const lines = surface.projectDeliveredReasoning(fake).nonPharma.precautions;
  assert.ok(lines.includes("方中熟地黄滋腻燥烈，胃脘不适者请告知医生。"), JSON.stringify(lines));
});
console.log(JSON.stringify({ suite: "r1019-herbs-patch", cases, failures: process.exitCode ? "see above" : 0 }));

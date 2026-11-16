// G3：教材缺口、六淋分型、原方与候选边界。全部夹具为合成改写，无模型/网络调用。
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const t = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const original = await jiti.import("../src/lib/formula-original-composition.ts");
const pick = await jiti.import("../src/lib/textbook-disease-pick.server.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const source = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-supplement.source.json", "utf8"));
let count = 0, failures = 0;
async function check(name, run) {
  count++;
  try { await run(); console.log(`✓ ${name}`); }
  catch (error) { failures++; console.error(`✗ ${name}\n  ${error.message}`); process.exitCode = 1; }
}
const input = (chiefComplaint, presentHistory) => ({ chiefComplaint, presentHistory, recordText: `主诉：${chiefComplaint}\n现病史：${presentHistory}`, sex: "男", ageYears: 42 });
const name = (chief, history = "") => t.diseaseNameWithRecordSubtype("淋证", `主诉：${chief}\n现病史：${history}`);
const ear = input("右耳堵闷三周", "耳镜见鼓膜内陷，有液平面；听力减退。无流脓。纳少便溏，脉缓。");
const voice = input("声嘶反复九个月", "说话费力，痰少而黏；喉镜见声带小结。舌暗，脉涩。");
const gather = input("腹中胀痛走窜", "患者3月前情绪不畅后出现腹中胀痛，自觉气聚，时聚时散，散后如常，情绪紧张时明显。");

await check("1.1 每条新增行和规则引文逐字存在，网页文本独立对应保存HTML，组成对应原方", () => {
  const result = spawnSync("python3", ["scripts/verify-r1065-gknow-sources.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(JSON.parse(result.stdout).quotesVerified >= 45);
});
await check("1.2 耳胀耳闭四型有法方，组成只取指定原书（含药引）", () => {
  const rows = t.textbookFormulaRowsForDisease("耳胀耳闭");
  assert.deepEqual(rows.map((r) => r.syndromeName).sort(), ["风邪袭耳证", "肝胆蕴热证", "脾虚湿困证", "气血瘀阻证"].sort());
  for (const row of rows) {
    const raw = source.rows.find((r) => r.id === row.id);
    const herbs = row.formulas.flatMap((n) => { const e = original.originalFormula(n, raw.formulaBooks[n]); assert.ok(e); return [...e.herbs.map((h) => h.herb), ...e.guides]; });
    assert.deepEqual(row.composition, [...new Set(herbs)]);
    assert.ok(row.therapy.length > 0 && row.formulas.length > 0);
  }
});
await check("1.3 喉喑六型、急三型慢三型；风热无原方者仅知识参考，不能锁方", () => {
  assert.equal(t.textbookFormulaRowsForDisease("喉喑").filter((r) => source.rows.find((x) => x.id === r.id)?.gknow).length, 6);
  assert.equal(t.textbookFormulaRowsForDisease("急喉喑").length, 3);
  const chronic = t.textbookFormulaRowsForDisease("慢喉喑");
  for (const r of chronic) for (const f of r.formulas) assert.ok(original.originalFormulasNamed(f).length > 0, f);
  for (const n of ["阴虚火旺证", "肺脾气虚证", "痰凝血瘀证"]) assert.ok(chronic.some((r) => r.syndromeName === n));
  const candidates = t.textbookCandidatesForCase(voice).find((r) => r.disease === "慢喉喑");
  assert.ok(candidates.rows.every((r) => ["阴虚火旺证", "肺脾气虚证", "痰凝血瘀证"].includes(r.syndromeName)));
  const wind = t.textbookRowForSyndrome("急喉喑", "风热壅肺证");
  assert.ok(wind?.referenceOnly);
  assert.deepEqual(wind.formulas, []);
  assert.ok(!t.buildTextbookFormulaContext("急喉喑", "风热壅肺证").includes('candidate.name 写'));
});
await check("1.4 聚证原表两型完整，不复制生成行、不把气聚误作固定积块", () => {
  const rows = t.textbookFormulaRowsForDisease("聚证");
  assert.deepEqual(rows.map((r) => [r.syndromeName, r.formulas[0]]), [["肝郁气滞证", "逍遥散"], ["食滞痰阻证", "六磨汤"]]);
  const data = JSON.parse(fs.readFileSync("src/data/tcm-knowledge-gap-retrieval.source.json", "utf8"));
  assert.ok(data.rules.some((r) => r.disease === "聚证" && r.evidence.some((e) => e.line === 235625)));
});
await check("2.1 石淋覆盖排砂石、影像结石和绞痛的肯定表现", () => {
  for (const [chief, history] of [["尿中排出砂石", "排尿涩痛"], ["排尿不适", "B超见输尿管结石"], ["腰腹部绞痛", "伴血尿"]]) assert.equal(name(chief, history), "淋证（石淋）");
});
await check("2.2 否定、未问、既往、他人、计划检查均不作本次石淋依据", () => {
  for (const history of ["否认输尿管结石", "是否有输尿管结石尚未询问", "既往肾结石，已排出", "父亲有肾结石", "拟检查有无尿路结石"]) assert.equal(name("尿频", history), "淋证", history);
});
await check("2.3 血淋需肯定尿血并尿痛；无痛、未问和既往尿痛不够", () => {
  assert.equal(name("肉眼血尿", "同时尿痛明显"), "淋证（血淋）");
  for (const h of ["无尿痛", "尿痛尚未询问", "既往尿痛，现无不适"]) assert.equal(name("肉眼血尿", h), "淋证");
  assert.equal(t.diseaseNameWithRecordSubtype("热淋", "主诉：血尿\n现病史：尿痛"), "淋证（血淋）");
});
await check("2.4 热气膏劳分别按特征分型，无痛乳糜尿和单纯乏力不强行归淋", () => {
  for (const [chief, h, expected] of [["排尿灼痛", "小便赤热", "热淋"], ["小腹胀满", "小便涩滞", "气淋"], ["小便如米泔水", "尿道热涩疼痛", "膏淋"], ["尿频反复", "遇劳即发", "劳淋"]]) assert.equal(name(chief, h), `淋证（${expected}）`);
  assert.equal(name("乳糜尿", "无尿痛"), "淋证");
  assert.equal(name("疲乏", "劳累后加重"), "淋证");
});
await check("2.5 同一病历按主诉、现病史、全文的最早肯定特征，血证旧分型保留", () => {
  assert.equal(name("腰腹绞痛，继而血尿", "尿痛"), "淋证（石淋）");
  assert.equal(name("血尿，继而腰腹绞痛", "尿痛"), "淋证（血淋）");
  assert.equal(t.diseaseNameWithRecordSubtype("血证", "主诉：鼻出血\n现病史：既往牙龈出血"), "血证（鼻衄）");
});
await check("3.1 本型候选和用方读同一行：石淋不再借热淋或跨病湿热证", () => {
  const x = input("腰腹绞痛", "尿中夹砂石，伴尿痛");
  const section = t.textbookCandidatesForCase({ ...x, preferredDiseases: ["淋证"] }).find((r) => r.disease === "淋证");
  assert.deepEqual(section.rows.map((r) => r.syndromeName), ["石淋"]);
  assert.equal(t.textbookRowForSyndrome("淋证（石淋）", "湿热蕴结证").formulas[0], "石韦散");
  assert.equal(t.textbookRowForSyndrome("淋证（血淋）", "热淋").formulas[0], "小蓟饮子");
});
await check("3.2 淋证鉴别按型：血淋比尿血/石淋，膏淋比尿浊，不给无关型段落", () => {
  assert.ok(t.textbookDifferentialsForDisease("淋证（血淋）", 8).some((r) => r.name === "石淋"));
  assert.ok(t.textbookDifferentialsForDisease("淋证（血淋）", 8).some((r) => r.name === "尿血"));
  assert.ok(!t.textbookDifferentialFitsSubtype("淋证", "血淋", "尿浊"));
  assert.ok(t.textbookDifferentialFitsSubtype("淋证", "膏淋", "尿浊"));
});
await check("4.1 闭集包含耳胀耳闭和急慢喉喑，未知病名仍被丢弃", () => {
  const state = types.normalizeCaseStateInput({ chiefComplaint: "声嘶", patient: { age: 42, sex: "男" } });
  const req = pick.buildTextbookDiseasePickRequest(state);
  for (const n of ["耳胀耳闭", "喉喑", "慢喉喑", "急喉喑", "聚证"]) assert.ok(req.allowed.has(n), n);
  assert.deepEqual(pick.parseTextbookDiseasePick('{"diseases":["急喉喑","未知喉病"]}', req.allowed), ["急喉喑"]);
  const generated = JSON.parse(fs.readFileSync("src/data/tcm-textbook-disease-names.json", "utf8"));
  assert.ok(generated.names.includes("耳胀耳闭") && generated.names.includes("急喉喑"));
});
await check("4.2 耳部主诉并本次鼓室特征才提升耳胀耳闭，历史/未问/别处液平面不误选", () => {
  assert.equal(t.textbookCandidatesForCase({ ...ear, preferredDiseases: ["耳鸣耳聋"] })[0].disease, "耳胀耳闭");
  for (const h of ["既往鼓膜内陷，现已恢复", "鼓膜内陷尚未检查", "腹部X片见液平面"]) assert.deepEqual(t.knowledgeGapPreferredDiseases(input("耳闷", h)), []);
});
await check("4.3 声嘶并小结入慢喉喑；腹部气聚攻窜入聚证；伴随、否定、既往不提升", () => {
  assert.equal(t.textbookCandidatesForCase({ ...voice, preferredDiseases: ["喉痹"] })[0].disease, "慢喉喑");
  assert.equal(t.textbookCandidatesForCase({ ...gather, preferredDiseases: ["腹痛"] })[0].disease, "聚证");
  for (const x of [input("咽痛伴声嘶", "声带小结"), input("声嘶", "否认声带小结"), input("腹中胀痛走窜", "既往气聚，时聚时散，曾有攻窜"), input("失眠", "声音嘶哑，声带小结")]) assert.deepEqual(t.knowledgeGapPreferredDiseases(x), []);
});
await check("4.4 新行不凭公共舌脉在无关皮肤病里入选；石淋主诉不被鼻渊抢走", () => {
  const itchy = input("皮肤瘙痒", "舌红，苔薄，脉细数，口干，夜间不适，失眠多梦，腰膝酸软。");
  assert.ok(!t.textbookCandidatesForCase(itchy).some((r) => ["喉喑", "急喉喑", "慢喉喑", "耳胀耳闭"].includes(r.disease)));
  assert.equal(t.textbookCandidatesForCase(input("右侧腰腹部绞痛", "突发一侧腰腹绞痛，尿中带血"))[0].disease, "淋证");
});
await check("4.5 选病主路径使用同一检索规则，急症优先不被新病覆盖", () => {
  const code = fs.readFileSync("src/lib/textbook-disease-pick.server.ts", "utf8");
  assert.match(code, /const gaps = knowledgeGapPreferredDiseases\(/u);
  assert.match(code, /withTrueHeartPainFirst\(retrieved,/u);
});
console.log(JSON.stringify({ checks: count, failures }));

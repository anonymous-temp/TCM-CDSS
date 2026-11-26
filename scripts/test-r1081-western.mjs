import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": path.resolve("src"),
  "server-only": path.resolve("node_modules/next/dist/compiled/server-only/empty.js"),
} });
const { settleWesternDiagnosisBasis: settle } = await jiti.import("../src/lib/recorded-test-claims.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { clinicalGroundingText } = await jiti.import("../src/lib/diagnosis-safety.ts");

if (process.argv.includes("--replay")) {
  const rows = [];
  for (const group of fs.readdirSync("zz-evidence/out")) {
    const dir = path.join("zz-evidence/out", group);
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
      const { input, diagnose } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const p = diagnose?.structured?.westernDiagnosis?.primary;
      if (!p?.name || !p.clinicalRationale) continue;
      const chart = clinicalGroundingText(normalizeCaseStateInput(input));
      const settled = settle(p.name, p.clinicalRationale, chart);
      rows.push({ id: group + "/" + file, before: p.name, ...settled });
    }
  }
  console.log(JSON.stringify(rows));
} else {
  const { westernPatientRecord } = await jiti.import("../src/lib/western-patient-record.ts");
  const basis = await jiti.import("../src/lib/western-basis-authoring.server.ts");
  const { buildM03SharedPatientContext, buildM03ContextPackets } = await jiti.import("../src/lib/m03-context-packets.ts");
  const tests = [];
  const check = async (name, fn) => {
    try { await fn(); console.log("PASS", name); } catch (error) { tests.push(name); console.error("FAIL", name, error.message); }
  };
  await check("本人已确诊，既往检查未复查", () => {
    const chart = "患者反复夜间遗尿，经检查已排除器质性病变，确诊为“遗尿症”。";
    const result = settle("遗尿症待查", "既往已确诊遗尿症，本次未复查尿常规，尚不能确诊。", chart);
    assert.deepEqual(result, { name: "遗尿症", basis: "既往已确诊遗尿症，本次未复查尿常规。" });
    for (const text of ["母亲确诊为遗尿症。", "怀疑遗尿症。", "未确诊为遗尿症。"]) {
      assert.equal(settle("遗尿症待查", "症状原因有待明确。", text).name, "遗尿症待查", text);
    }
  });
  await check("脑影像缺项及阴性对照", () => {
    const old = "突发失语。尚缺CT，需核实后确认急性脑梗死。";
    const result = settle("急性脑梗死待查", old, "突发失语。脑CT：未见明确梗死灶。");
    assert.deepEqual(result, { name: "急性脑梗死待查", basis: "突发失语。" });
    assert.match(settle("急性脑梗死待查", old, "胸部CT正常。").basis, /尚缺头颅CT/u);
  });
  await check("检查替代项只呈现一项", () => {
    const result = settle("心脏神经症待查", "反复胸闷。", "心悸胸闷1周");
    assert.match(result.basis, /尚缺心电图，/u);
    assert.doesNotMatch(result.basis, /或/u);
  });
  await check("病程限定属于分型", () => {
    const chart = "失眠2月余，入睡困难、乏力。";
    const rationale = "入睡困难伴日间疲乏，病程不足3个月，尚未达到失眠障碍的病程标准；需关注睡眠环境。";
    const result = settle("失眠障碍待查", rationale, chart);
    assert.equal(result.name, "失眠障碍");
    assert.doesNotMatch(result.basis, /尚未达到/u);
    assert.equal(settle("慢性失眠障碍待查", "持续失眠。", chart).name, "慢性失眠障碍待查");
  });
  await check("推测病名受人群和病程约束", () => {
    const chart = "患者年龄：70岁\n四肢疼痛2个月";
    const result = settle("关节痛待查", "持续疼痛，考虑纤维肌痛综合征、反复上呼吸道感染、骨关节炎可能。", chart);
    assert.equal(result.basis, "持续疼痛，考虑骨关节炎可能。");
    assert.match(settle("关节痛待查", "考虑纤维肌痛综合征可能。", "四肢疼痛半年").basis, /纤维肌痛/u);
  });
  await check("只交付本人报告", () => {
    const state = normalizeCaseStateInput({ patient: { age: 27, sex: "女" }, chiefComplaint: "腹胀", symptoms: {
      辅助检查: "甲乙报告总览。\n【报告解读】甲结果记录，6岁男童。\n【报告解读】乙结果记录，27岁女性。",
    } });
    const clean = westernPatientRecord(state);
    assert.match(clinicalGroundingText(clean), /乙结果记录/u);
    assert.doesNotMatch(buildM03SharedPatientContext(clean), /甲结果记录|甲乙报告总览/u);
    assert.match(buildM03SharedPatientContext(state), /甲结果记录/u);
  });
  await check("HIS流派不进入西医半", () => {
    const packet = preference => {
      const state = normalizeCaseStateInput({ chiefComplaint: "胸闷", hisRecord: { fields: { tcmLineagePreference: preference } } });
      return buildM03ContextPackets({ sharedPatientContext: buildM03SharedPatientContext(westernPatientRecord(state)), fullPrompt: preference, evidenceContext: "", stageInstructions: "" }).western;
    };
    assert.equal(packet("扶阳派"), packet("经方派"));
  });
  await check("成立性判断、依据及候选首位同源", async () => {
    const name = "阵发性心房颤动待查";
    const core = "阵发性心房颤动";
    const quote = "动态心电图记录阵发性心房颤动";
    const content = JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: "原依据" }, candidates: [{ name }] } });
    const proposal = { criteria: [{ point: "动态心电图", quote }], established: "yes", establishmentQuote: quote,
      summary: "", negatives: [], exclude: [], level: "动态心电图证实节律异常", text: "心悸反复短暂发作，节律异常与不适同时出现，动态心电图证实阵发性心房颤动，应结合发作时症状评估心室率。" };
    async function apply(proof) {
      const out = await basis.withAuthoredWesternBasis(content, { recordText: "主诉：间断心悸半年。"+quote+"。", chiefComplaint: "间断心悸" },
        Promise.resolve({ name, proposal: { ...proposal, establishmentQuote: proof } }));
      return JSON.parse(out).westernDiagnosis;
    }
    const accepted = await apply(quote);
    assert.equal(accepted.primary.name, core);
    assert.equal(accepted.candidates[0].name, core);
    assert.equal(accepted.primary.clinicalRationale, proposal.text);
    assert.equal((await apply("无来源的结论")).primary.name, name);
  });
  await check("缺心肌梗死检查时保留急性冠脉综合征方向", async () => {
    const { deterministicWesternNameCorrection } = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
    assert.equal(deterministicWesternNameCorrection("急性心肌梗死待查", "胸痛2小时，心电图未查，肌钙蛋白待回报。")?.supportedName, "急性冠脉综合征待查");
    assert.equal(deterministicWesternNameCorrection("急性心肌梗死", "外院确诊为急性心肌梗死。"), undefined);
  });
  await check("上位病名与依据一起采纳", async () => {
    const name = "妊娠剧吐待查";
    const quote = "妊娠早期晨起恶心呕吐";
    const chart = "妊娠早期晨起恶心呕吐，尚能少量进食，体重稳定。";
    const original = JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: "原依据" }, candidates: [{ name }] } });
    const proposal = { supportedName: "妊娠呕吐", summary: "", established: "yes", criteria: [{ point: "妊娠早期恶心呕吐", quote }], negatives: [], exclude: [], level: "早孕期症状轻且稳定",
      text: "晨起恶心呕吐且尚能进食，早孕期症状轻且稳定，表现符合妊娠呕吐，需随访进食与体重变化。" };
    const apply = async (proof, redFlag = false) => JSON.parse(await basis.withAuthoredWesternBasis(original,
      { recordText: chart, chiefComplaint: "恶心呕吐", redFlag }, Promise.resolve({ name, proposal: { ...proposal, criteria: [{ point: "妊娠早期恶心呕吐", quote: proof }] } }))).westernDiagnosis.primary;
    assert.equal((await apply(quote)).name, "妊娠呕吐");
    assert.equal((await apply("严重脱水酮症")).name, name);
    assert.equal((await apply(quote, true)).name, name);
  });
  await check("假设病名须有本人原文", async () => {
    const name = "腰痛待查";
    const chart = "搬运重物后腰部隐痛，弯腰加重，休息稍缓解。";
    const proposal = { established: "no", summary: "", level: "负重诱发提示机械性疼痛",
      criteria: [{ point: "腰部疼痛", quote: "腰部隐痛" }], negatives: [], exclude: [],
      hypotheses: [{ name: "慢性肾脏病", point: "肾功能异常", quote: "肌酐升高" }],
      text: "腰部隐痛受活动影响，负重诱发提示机械性疼痛，腰痛原因仍需结合活动方式定位，考虑慢性肾脏病可能。" };
    const content = JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: "原依据" }, differentials: [{ name: "慢性肾脏病" }] } });
    const out = await basis.withAuthoredWesternBasis(content, { recordText: chart, chiefComplaint: "腰痛" },
      Promise.resolve({ name, proposal }));
    const rationale = JSON.parse(out).westernDiagnosis.primary.clinicalRationale;
    assert.match(rationale, /负重诱发提示机械性疼痛/u);
    assert.doesNotMatch(rationale, /考虑慢性肾脏病/u);
  });
  await check("时间与症状逐字对应", () => {
    const proposal = { text: "月经量多4月并有头晕乏力，红细胞体积减小，铁蛋白降低，考虑缺铁性贫血可能。", timedFacts: ["月经量多4月"], criteria: [], negatives: [], exclude: [], level: "" };
    const context = { recordText: "近半年月经量多。头晕乏力4月。", name: "缺铁性贫血", listedNames: [] };
    assert.equal(basis.westernBasisIssue(proposal, context), "duration_not_bound_to_fact");
    proposal.text = proposal.text.replace("月经量多4月", "近半年月经量多");
    proposal.timedFacts = ["近半年月经量多"];
    assert.notEqual(basis.westernBasisIssue(proposal, context), "duration_not_bound_to_fact");
  });
  if (tests.length) process.exitCode = 1;
}

// 第五十一轮（甲方 11/18 批注 + n8 判错清单）阶段一：备用「若见」行缺省不交付、病机链节点治法、西医名随依据、中医鉴别相似处、
// 典型表现取主症、妊娠慎用药不分君臣、抗凝下化瘀止血药、人群提示措辞、皮肤弹性引文。全部病历为合成。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const c = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const columns = await jiti.import("../src/lib/pathogenesis-columns.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const exclusion = await jiti.import("../src/lib/medicine-candidate-exclusion.ts");
const advisory = await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const discriminators = (await import("../src/data/redflag-discriminators.source.json", { with: { type: "json" } })).default;

const check = async (id, title, run) => {
  if (process.env.R1068_CHECK && process.env.R1068_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};

const state = types.normalizeCaseStateInput({ patient: { age: 38, sex: "男" }, chiefComplaint: "鼻塞2天", symptoms: { 现病史: "鼻塞，恶寒，咳嗽，舌苔薄白，脉浮紧。" } });
const prior = { stage: "diagnose", overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", recommendedFormulaNames: ["荆防败毒散"], primarySyndromeBasis: ["鼻塞，恶寒，咳嗽"] }, therapy: { overallMethod: "辛温解表，宣肺散寒" }, pathogenesis: { chain: [{ nodeId: "P1", patientFact: "鼻塞，恶寒，咳嗽", pathogenesis: "风寒束表，肺失宣肃", therapyDirection: "辛温解表" }] } };
const names = ["荆芥", "防风", "甘草"];

await check("1.1", "教材「若见」补位缺省关：条件不在病历里的备用行不交付；显式打开才补", () => {
  const saved = process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
  try {
    delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
    assert.equal(c.modificationTextbookFillEnabled(), false);
    const rows = c.fillTextbookModificationConditions([], prior, state, names);
    assert.ok(rows.every((row) => !/^若/u.test(String(row.trigger || ""))), JSON.stringify(rows));
    process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = "true";
    assert.equal(c.modificationTextbookFillEnabled(), true);
    const filled = c.fillTextbookModificationConditions([], prior, state, names);
    assert.ok(filled.some((row) => /^若见/u.test(String(row.trigger || ""))), "反证：打开补位时应有若见行");
  } finally {
    if (saved === undefined) delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL; else process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = saved;
  }
});

await check("2.1", "病机链节点治法：没有对应的总治法项时保留模型原写，不落到总治法第一项；子治法同步", () => {
  const reasoning = {
    therapy: { overallMethod: "疏风清热，宣肺止咳", subTherapies: [{ therapy: "清热生津，润肠通便", targetPathogenesis: "热邪伤津，肠道失润" }] },
    pathogenesis: { chain: [
      { nodeId: "P1", pathogenesis: "风热犯肺，肺失清肃", therapyDirection: "疏风清热，宣肺止咳" },
      { nodeId: "P2", pathogenesis: "热邪伤津，肠道失润", therapyDirection: "清热生津，润肠通便" },
    ] },
  };
  columns.reconcileChainTherapy(reasoning);
  assert.equal(reasoning.pathogenesis.chain[0].therapyDirection, "疏风清热", "多节点照抄整句总治法时按病机取对应项");
  assert.equal(reasoning.pathogenesis.chain[1].therapyDirection, "清热生津，润肠通便", "无对应项保留模型原写");
  assert.equal(reasoning.therapy.subTherapies[0].therapy, "清热生津，润肠通便");
  // 节点照抄整句总治法时按病机取对应项（两节点各取一项，不重复），并同步子治法。
  const copied = {
    therapy: { overallMethod: "清热凉血调经，益气养心", subTherapies: [{ therapy: "清热凉血调经，益气养心", targetPathogenesis: "气虚失养" }] },
    pathogenesis: { chain: [
      { nodeId: "P1", pathogenesis: "热入血分，迫血妄行", therapyDirection: "清热凉血调经，益气养心" },
      { nodeId: "P2", pathogenesis: "气虚失养", therapyDirection: "清热凉血调经，益气养心" },
    ] },
  };
  columns.reconcileChainTherapy(copied);
  assert.deepEqual(copied.pathogenesis.chain.map((node) => node.therapyDirection), ["清热凉血调经", "益气养心"]);
  assert.equal(copied.therapy.subTherapies[0].therapy, "益气养心");
  // 节点治法部分在总治法里：只留在的那几项（四十九轮规则保留）。
  const partial = { therapy: { overallMethod: "清热凉血调经，益气养心" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "热扰血分", therapyDirection: "凉血调经，疏肝清热" }] } };
  columns.reconcileChainTherapy(partial);
  assert.equal(partial.pathogenesis.chain[0].therapyDirection, "凉血调经");
});

const pregnancyRecord = "患者性别：女\n患者年龄：27岁\n主诉：恶心呕吐2周\n现病史：停经8周，B超示宫内早孕活胎，恶心呕吐2周，体重下降1kg，尿酮体弱阳性，电解质正常。";
await check("3.1", "西医名随依据：依据肯定的是另一个受治理病名（妊娠期恶心呕吐）时病名改为它；同一病宽窄写法与依据含病名不改", () => {
  const basis = "早孕宫内活胎基础上持续2周恶心呕吐、体重下降1kg，尿酮体弱阳性，符合妊娠期恶心呕吐；电解质正常，尚未达重度脱水标准。";
  assert.equal(claims.basisAffirmedOtherDisease("妊娠剧吐", basis, pregnancyRecord), "妊娠呕吐");
  assert.equal(claims.settleWesternDiagnosisBasis("妊娠剧吐", basis, pregnancyRecord).name, "妊娠呕吐");
  assert.equal(claims.basisAffirmedOtherDisease("2型糖尿病", "多饮多尿、空腹血糖9.8mmol/L，符合糖尿病表现。", "主诉：口干多饮1月"), undefined, "宽窄写法不改");
  assert.equal(claims.basisAffirmedOtherDisease("妊娠剧吐", "持续呕吐、酮体3+、电解质紊乱，符合妊娠剧吐；需与妊娠期恶心呕吐鉴别。", pregnancyRecord), undefined, "依据含病名不改");
});

await check("3.2", "依据写「诊断待客观依据确立」「尚未排除…器质性病因」时病名加待查；写明可临床诊断的不加", () => {
  const record = "主诉：眼睑下垂伴复视1月\n现病史：晨轻暮重，休息后减轻，疲劳试验阳性。";
  assert.equal(claims.settleWesternDiagnosisBasis("重症肌无力", "波动性眼睑下垂伴复视、疲劳试验阳性，符合神经肌肉接头病变；新斯的明试验、抗体未做，诊断待客观依据确立。", record).name, "重症肌无力待查");
  const panic = "主诉：突发心悸10分钟\n现病史：伴濒死感，10分钟内自行缓解，发作间期正常。";
  assert.equal(claims.settleWesternDiagnosisBasis("惊恐障碍", "突发心悸伴濒死恐惧，10分钟内缓解，符合惊恐发作特征；但尚未排除心律失常、甲亢、低血糖等器质性病因。", panic).name, "惊恐障碍待查");
  assert.equal(claims.settleWesternDiagnosisBasis("惊恐障碍", "突发心悸伴濒死恐惧，符合惊恐发作特征；但尚未排除心律失常、甲亢等器质病因，需先完成急诊评估。", panic).name, "惊恐障碍待查", "「器质病因」同样算");
  const pain = "患者性别：女\n患者年龄：24岁\n主诉：经期腹痛半年\n现病史：经行小腹疼痛，经后缓解。";
  assert.equal(claims.settleWesternDiagnosisBasis("原发性痛经", "初潮后经期周期性下腹痛，经后缓解，符合原发性痛经表现；尚需盆腔超声排除子宫内膜异位症、子宫腺肌病等器质性疾病。", pain).name, "原发性痛经待查", "排除性诊断的依据还要排除器质性疾病");
  assert.equal(claims.settleWesternDiagnosisBasis("原发性痛经", "初潮后即出现经期周期性下腹痛，盆腔超声未见异常，符合原发性痛经。", pain).name, "原发性痛经", "反证：已排除的不加待查");
  assert.equal(claims.settleWesternDiagnosisBasis("惊恐障碍", "反复突发心悸伴濒死恐惧，心电图、甲功、血糖均正常，符合惊恐障碍诊断标准。", panic).name, "惊恐障碍", "反证：已排除器质性病因的不加待查");
});

const toothRecord = "患者性别：男\n患者年龄：41岁\n主诉：右下牙痛3天\n现病史：右侧下牙及牙龈肿痛，遇热加重，口渴喜冷饮，大便干结。舌红苔黄，脉滑数。";
await check("4.1", "中医鉴别：自己写本例没有该病主症、相似处只写病机病类的不留；写本例已见表现或同一部位的保留；教材列出的保留", () => {
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("头痛", "胃火可上攻头面致痛；本例疼痛局限于右侧下牙及牙龈，未诉头痛", toothRecord, "牙痛", "胃火可上攻头面致痛"), true);
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("口疮", "同有口腔灼痛、口渴喜冷饮；本例未诉口腔溃疡", toothRecord, "牙痛", "同有口渴喜冷饮"), false, "相似处写了本例已见表现");
  const stuffy = "主诉：胃脘胀满2周\n现病史：胃脘胀满，食后加重，嗳气。";
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("胃痛", "部位相同易混；本例以胀满为主，未诉胃脘疼痛", stuffy, "胃痞", "部位相同易混"), false, "同一部位算相似");
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("聚证", "同属腹部病证；本例未诉聚证", stuffy, "胃痞", "同属腹部病证"), false, "教材对本病列出的鉴别病不按这一条去掉");
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("真心痛", "同属胃心胸部疼痛；本例无胸痛彻背", toothRecord, "牙痛", "同属胃心胸部疼痛"), false, "缺的不是病名本身的主症时不判");
});

await check("4.2", "规范化出口按同一判据去掉无相似处的鉴别行", () => {
  const reasoning = { stage: "diagnose", overview: { tcmDiseaseName: "牙痛", tcmDiseaseDifferentials: [
    { diseaseName: "头痛", reason: "胃火可上攻头面致痛", distinguishingPoints: "本例疼痛局限于右侧下牙及牙龈，未诉头痛" },
    { diseaseName: "口疮", reason: "同有口渴喜冷饮", distinguishingPoints: "本例未诉口腔溃疡" },
  ] } };
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = normalization.normalizeM03TcmDiseaseDifferentialNames(content, toothRecord);
  const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  assert.deepEqual(json.overview.tcmDiseaseDifferentials.map((row) => row.diseaseName), ["口疮"]);
});

await check("4.3", "教材主症与本例已见表现有交集的鉴别不按无相似处去掉（补写小任务补入的行常写「本例未诉X」）", () => {
  const dizzy = "主诉：右侧肢体无力2天\n现病史：右侧肢体无力，言语謇涩，伴头晕。";
  assert.equal(textbook.textbookDifferentialSharesAffirmedFinding("眩晕", dizzy), true);
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("眩晕", "同属脑病；本例未诉眩晕、视物旋转", dizzy, "中风", "同属脑病"), false);
  const plain = "主诉：右侧肢体无力2天\n现病史：右侧肢体无力，言语謇涩。";
  assert.equal(textbook.tcmDifferentialSelfDeclaredUnrelated("眩晕", "同属脑病；本例未诉眩晕、视物旋转", plain, "中风", "同属脑病"), true, "反证：没有交集时去掉");
});

await check("5.1", "鉴别典型表现取教材定义里的主症，不贴整段定义；定义只讲病因病类的留空", () => {
  assert.equal(textbook.textbookDefinitionKeyManifestation("胃痞，又称痞满，是指以自觉心下痞塞，胸膈胀满，触之无形，按之柔软，压之无痛为主要症状的病证。"), "自觉心下痞塞，胸膈胀满，触之无形，按之柔软，压之无痛");
  assert.equal(textbook.textbookDefinitionKeyManifestation("心悸，是指病人自觉心中悸动，惊惕不安，甚则不能自主的一种病证。"), "病人自觉心中悸动，惊惕不安，甚则不能自主");
  assert.equal(textbook.textbookDefinitionKeyManifestation("月经周期延长7天以上，甚至3～5个月一行，连续出现3个周期以上，称为“月经后期”。"), "月经周期延长7天以上，甚至3～5个月一行，连续出现3个周期以上");
  assert.equal(textbook.textbookDefinitionKeyManifestation("暑温是感受暑热病邪引起的一种急性外感热病。"), "");
  assert.equal(textbook.textbookDefinitionKeyManifestation("虚劳又称虚损，是以脏腑亏损，气血阴阳虚衰，久虚不复成劳为主要病机，以五脏虚证为主要临床表现的多种慢性虚弱证候的总称。"), "五脏虚证");
  const shown = textbook.textbookDiseaseTypicalManifestation("心悸");
  assert.ok(shown && !/是指|一种病证/u.test(shown), shown);
});

await check("6.1", "已记录在孕：药典孕妇慎用饮片不分君臣佐使都拦；未孕女性与男性不拦", () => {
  assert.ok(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "佐" }], pregnancyRecord)?.endsWith("_pregnancy"));
  assert.ok(contract.m04GenerationSpecialPopulationIssue([{ name: "枳壳", role: "使" }], pregnancyRecord)?.endsWith("_pregnancy"));
  assert.equal(contract.herbBarredForCase("牛膝", pregnancyRecord), true);
  const notPregnant = "患者性别：女\n患者年龄：27岁\n主诉：腰酸3天\n现病史：腰酸，否认妊娠，月经规律，末次月经10天前。";
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "佐" }], notPregnant), undefined);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "牛膝", role: "君" }], "患者性别：男\n患者年龄：60岁\n主诉：腰痛"), undefined);
});

await check("6.2", "已记录在孕：说明书孕妇禁用/慎用的中成药不推荐；未孕不拦", () => {
  const label = { contraindication: "孕妇慎用。", precaution: "忌辛辣。" };
  assert.equal(exclusion.medicineLabelConflictsWithCase(label, pregnancyRecord), true);
  assert.equal(exclusion.medicineLabelConflictsWithCase({ contraindication: "孕妇禁用。" }, pregnancyRecord), true);
  assert.equal(exclusion.medicineLabelConflictsWithCase(label, "患者性别：男\n患者年龄：40岁\n主诉：胃胀"), false);
  assert.equal(exclusion.medicineLabelConflictsWithCase({ contraindication: "糖尿病患者慎用。" }, pregnancyRecord), false);
});

await check("7.1", "抗凝在用：化瘀止血药（三七、蒲黄、茜草、花蕊石）也拦；收敛止血药不拦", () => {
  const onWarfarin = "患者性别：女\n患者年龄：62岁\n主诉：月经量多2月\n现病史：房颤，长期口服华法林3mg每日1次，INR 3.5，月经量较前增多。\n用药史：华法林3mg每日1次";
  for (const name of ["三七", "蒲黄", "茜草", "花蕊石"]) assert.equal(contract.herbBarredForCase(name, onWarfarin), true, name);
  for (const name of ["仙鹤草", "白及"]) assert.equal(contract.herbBarredForCase(name, onWarfarin), false, name);
  assert.equal(contract.herbBarredForCase("三七", "患者性别：男\n患者年龄：40岁\n主诉：跌打肿痛"), false, "反证：没有抗凝时不拦");
});

await check("8.1", "人群冲突提示写明哪一类人群，不写本例不适用的「妊娠哺乳」", () => {
  const candidate = { name: "自拟方", herbs: [{ name: "当归", dose: "10g", role: "臣" }], decoction: {} };
  const anticoag = advisory.clinicalDeliveryAdvisoryFromIssue("candidate_0_herb_0_special_population_high_risk_antithrombotic_therapy", candidate);
  assert.ok(!/妊娠|哺乳/u.test(anticoag.message), anticoag.message);
  assert.match(anticoag.message, /抗凝/u);
  const liver = advisory.clinicalDeliveryAdvisoryFromIssue("candidate_0_herb_0_contraindication", candidate);
  assert.ok(!/妊娠|哺乳/u.test(liver.message), liver.message);
});

await check("9.1", "皮肤弹性差的引文须写明弹性差/回缩缓慢；「弹性可」不算", () => {
  const anchors = discriminators.quoteAnchors.byConcept["reduced-skin-turgor"];
  assert.ok(Array.isArray(anchors) && anchors.length > 0);
  assert.equal(anchors.some((anchor) => "皮肤稍干、弹性可".includes(anchor)), false);
  assert.equal(anchors.some((anchor) => "皮肤弹性差，捏起后回缩缓慢".includes(anchor)), true);
});

// ── 阶段二、三、四 ──
const fitModule = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const indication = await jiti.import("../src/lib/herb-indication.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const rationale = await jiti.import("../src/lib/m03-final-rationale.server.ts");

await check("10.1", "加减条件：主诉里列出的每个症状（含「伴」之后）都算主诉本身；主诉以外的伴随表现仍可作条件", () => {
  const ctx = (chiefComplaint) => ({ caseState: { chiefComplaint }, recordText: `主诉：${chiefComplaint}` });
  assert.equal(c.modificationTriggerNotFinding("视物模糊", ctx("左眼剧痛、视物模糊2天")), "main_symptom");
  assert.equal(c.modificationTriggerNotFinding("左眼剧痛", ctx("左眼剧痛、视物模糊2天")), "main_symptom");
  assert.equal(c.modificationTriggerNotFinding("流涕", ctx("恶寒、发热伴鼻塞、流涕2天")), "main_symptom", "主诉里「伴」之后列的也是主诉本身");
  assert.equal(c.modificationTriggerNotFinding("口干", ctx("胃脘疼痛3天")), undefined, "反证：主诉以外的伴随表现可作条件");
});

await check("10.2", "加减核对给模型看《中药学》主治范围（功效＋【应用】标题）；药症不对的行不再为凑条数保留", () => {
  const payload = fitModule.modificationFitRowPayload({ trigger: "嗳气", action: "加", herbName: "苍术", evidence: { evidenceLevel: "model_inference" } }, 0);
  assert.ok(typeof payload.indications === "string" && payload.indications.includes("湿"), payload.indications);
  assert.ok(!payload.indications.includes("嗳气"));
  assert.match(indication.herbIndicationText("柿蒂") || "", /呃逆/u);
  assert.equal(indication.herbIndicationText("不是药名"), undefined);
});

const compositeRecord = "主诉：咳嗽2月\n现病史：干咳少痰，口干咽燥，神疲乏力，气短，动则汗出，舌红少苔，脉细数。";
const compositeRoot = (primary, natures, method = "养阴润肺，止咳") => ({ stage: "diagnose", overview: { tcmDiseaseName: "咳嗽", primarySyndrome: primary, secondarySyndromes: [], tcmDiagnosticRationale: `故属${primary}。`, overallPathogenesis: "肺阴亏耗，肺气不足。" },
  pathogenesis: { natureDifferentiation: { items: natures, rootDeficiency: natures, branchExcess: [] }, locationDifferentiation: { items: ["肺"], details: [] }, chain: [] }, therapy: { overallMethod: method } });
await check("11.1", "证名跟着分析走：单一阴虚证、病性列了气虚且病历有两项以上气虚表现 → 气阴两虚证，治法补「益气养阴」；没有气虚表现不改", () => {
  const r = compositeRoot("肺阴虚证", ["阴虚", "气虚"]);
  assert.deepEqual(surface.compositeSyndromeRename(r, compositeRecord), { from: "肺阴虚证", to: "气阴两虚证" });
  assert.equal(r.overview.primarySyndrome, "气阴两虚证");
  assert.match(r.therapy.overallMethod, /益气养阴$/u);
  assert.match(r.overview.tcmDiagnosticRationale, /气阴两虚证/u);
  const already = compositeRoot("肺阴虚证", ["阴虚", "气虚"], "养阴润肺，补气固表");
  surface.compositeSyndromeRename(already, compositeRecord);
  assert.equal(already.therapy.overallMethod, "养阴润肺，补气固表", "补气＝益气，已有不补");
  const noQi = compositeRoot("肺阴虚证", ["阴虚", "气虚"]);
  assert.equal(surface.compositeSyndromeRename(noQi, "主诉：咳嗽2月\n现病史：干咳少痰，口干咽燥，舌红少苔，脉细数。"), undefined, "反证：病历没有气虚表现");
  const notInNature = compositeRoot("肺阴虚证", ["阴虚"]);
  assert.equal(surface.compositeSyndromeRename(notInNature, compositeRecord), undefined, "反证：病性栏没列气虚");
});

await check("12.1", "依据定稿预取稿：病名证名病历舌脉流派都没变才按定稿快照复核；任一变了不复用", () => {
  const ctx = (names, record = "主诉：心悸", disease = "心悸", lineage = null) => ({ recordText: record, input: { conclusion: { disease, names }, tongue: [{ term: "舌淡" }], pulse: [{ term: "脉细" }], lineage } });
  assert.equal(rationale.finalRationaleConclusionUnchanged(ctx(["心脾两虚证"]), ctx(["心脾两虚证"])), true);
  assert.equal(rationale.finalRationaleConclusionUnchanged(ctx(["心血虚证"]), ctx(["心脾两虚证"])), false);
  assert.equal(rationale.finalRationaleConclusionUnchanged(ctx(["心脾两虚证"], "主诉：心悸1月"), ctx(["心脾两虚证"])), false);
  assert.equal(rationale.finalRationaleConclusionUnchanged(ctx(["心脾两虚证"], undefined, "心悸", { code: "support-yang" }), ctx(["心脾两虚证"])), false);
});

await check("1.2", "补位关时教材「主症甚」行（若见咳甚）也不补：病历只记了主症，没有记「甚」", () => {
  const saved = process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
  try {
    delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
    const st = types.normalizeCaseStateInput({ patient: { age: 30, sex: "男" }, chiefComplaint: "咳嗽3天", symptoms: { 现病史: "咳嗽，咯痰黄稠，咽痛，发热，舌红苔薄黄，脉浮数。" } });
    const p = { stage: "diagnose", overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风热犯肺证", recommendedFormulaNames: ["桑菊饮"], primarySyndromeBasis: ["咳嗽，咯痰黄稠"] }, therapy: { overallMethod: "疏风清热，宣肺止咳" }, pathogenesis: { chain: [] } };
    const rows = c.fillTextbookModificationConditions([], p, st, ["桑叶", "菊花", "苦杏仁", "连翘", "薄荷", "桔梗", "甘草", "芦根"]);
    assert.ok(rows.every((row) => !/^若/u.test(String(row.trigger || ""))), JSON.stringify(rows.map((row) => row.trigger)));
  } finally {
    if (saved === undefined) delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL; else process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = saved;
  }
});

await check("1.3", "补位关时教材主症甚条件不再经任何一路交付；压力、诱因不是加减条件", () => {
  const saved = process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
  try {
    delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL;
    const st = types.normalizeCaseStateInput({ patient: { age: 30, sex: "男" }, chiefComplaint: "恶寒发热1天", symptoms: { 现病史: "恶寒，发热，无汗，头痛身痛，鼻塞，舌苔薄白，脉浮紧。" } });
    const ctx = { prior, caseState: st, recordText: types.normalizeCaseStateInput ? `主诉：恶寒发热1天\n现病史：恶寒，发热，无汗，头痛身痛，鼻塞，舌苔薄白，脉浮紧。` : "" };
    assert.equal(c.textbookMainSymptomPresent("若见恶寒甚", "麻黄", ctx), undefined);
    assert.equal(c.retainModificationFindings([{ trigger: "若见恶寒甚", herbName: "麻黄" }], ctx).length, 0);
  } finally {
    if (saved === undefined) delete process.env.CDSS_MODIFICATION_TEXTBOOK_FILL; else process.env.CDSS_MODIFICATION_TEXTBOOK_FILL = saved;
  }
  for (const trigger of ["学校压力大", "经济压力", "工作压力较大"]) assert.equal(c.modificationTriggerNotFinding(trigger), "factor", trigger);
  assert.equal(c.modificationTriggerNotFinding("血压偏高"), undefined, "反证：不是压力");
});

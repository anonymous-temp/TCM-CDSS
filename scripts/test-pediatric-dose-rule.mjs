// 儿童中药汤剂剂量：年龄分数法（2026-09-30，owner 决定——不再对未满 18 岁一律收回剂量）。
//
// 规则来源：《中药学》十三五规划教材·用药剂量（新生儿1/6、乳婴儿1/3、幼儿1/2、学龄儿童2/3）；
// 《中医儿科学》十三五规划教材同节给得更宽，本规则取较保守的一部。数据 src/data/tcm-pediatric-dose-rule.source.json，
// 判「是不是儿童、哪一档」只在 src/lib/pediatric-dose-rule.ts 算一次，安全门 / M04 合同 / 编译器 / HIS 读同一个结果。
//
// 每条断言都带反证（成人、年龄段判不出、边界相邻档、旧口径）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// 全部为合成流量：不读运行时凭据、不连任何模型服务（第 8 节用桩 fetch 回放一份成人剂量的 M04 提案）。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-only",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus", PRIMARY_PRESCRIBE_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max",
  M04_ORCHESTRATION_DEADLINE_MS: "60000", REASONING_CONTRACT_SIGNING_KEY: "synthetic-signing-key-at-least-32-characters",
});

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const rule = jiti("../src/lib/pediatric-dose-rule.ts");
const safety = jiti("../src/lib/diagnosis-safety.ts");
const types = jiti("../src/lib/diagnosis-types.ts");
const contract = jiti("../src/lib/diagnosis-stage-contract.ts");
const advisory = jiti("../src/lib/clinical-delivery-advisory.ts");
const compiler = jiti("../src/lib/m04-proposal-compiler.ts");
const knowledge = jiti("../src/lib/tcm-knowledge.ts");
const fallbackModule = jiti("../src/lib/m04-deterministic-fallback.ts");
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const failures = [];
let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 700) }); }
};

const stageOf = (years) => rule.pediatricDoseRuleForAgeYears(years)?.stage;

check("1.1 年龄分期边界：相邻两侧各落在正确的档（天/岁换算）", () => {
  const day = (n) => n / 365;
  assert.equal(stageOf(0), "neonate");
  assert.equal(stageOf(day(27)), "neonate");
  assert.equal(stageOf(day(28)), "infant", "满 28 天进乳婴儿档");
  assert.equal(stageOf(0.5), "infant");
  assert.equal(stageOf(364 / 365), "infant");
  assert.equal(stageOf(1), "toddler", "满 1 岁进幼儿档");
  assert.equal(stageOf(2.9), "toddler");
  assert.equal(stageOf(3), "preschool", "满 3 岁进学龄前档（教材未单列，按幼儿 1/2）");
  assert.equal(stageOf(6.99), "preschool");
  assert.equal(stageOf(7), "school");
  assert.equal(stageOf(11.99), "school");
  assert.equal(stageOf(12), "adolescent", "12 岁及以上：三处来源一致指向接近成人量");
  assert.equal(stageOf(17.99), "adolescent");
});

check("1.2 反证：18 岁及以上、负数、非数值都不是儿童档位", () => {
  assert.equal(rule.pediatricDoseRuleForAgeYears(18), undefined);
  assert.equal(rule.pediatricDoseRuleForAgeYears(45), undefined);
  assert.equal(rule.pediatricDoseRuleForAgeYears(-1), undefined);
  assert.equal(rule.pediatricDoseRuleForAgeYears(Number.NaN), undefined);
});

check("1.3 分数与教材表一致，且教材两行「幼儿」「学龄前」共用 1/2（宁保守）", () => {
  const fractions = Object.fromEntries(["neonate", "infant", "toddler", "preschool", "school", "adolescent"].map((stage) => {
    const years = { neonate: 0.01, infant: 0.5, toddler: 2, preschool: 5, school: 10, adolescent: 15 }[stage];
    return [stage, rule.pediatricDoseRuleForAgeYears(years).fractionText];
  }));
  assert.deepEqual(fractions, { neonate: "1/6", infant: "1/3", toddler: "1/2", preschool: "1/2", school: "2/3", adolescent: "1" });
  // 教材原文（本地语料）就是这张表；数据文件把两部教材的原句都登记了，改数时必须回到原文。
  const data = JSON.parse(source("src/data/tcm-pediatric-dose-rule.source.json"));
  assert.match(data.sourceRefs.map((item) => item.quote).join("\n"), /新生儿用成人量的1\/6，乳婴儿用成人量的1\/3，幼儿用成人量的1\/2，学龄儿童用成人量的2\/3/);
});

check("2.1 逐味儿童上限 = 成人上限 × 分数，向下取 0.5g，不取零", () => {
  const half = rule.pediatricDoseRuleForAgeYears(2);
  const third = rule.pediatricDoseRuleForAgeYears(0.5);
  const sixth = rule.pediatricDoseRuleForAgeYears(0.01);
  const twoThirds = rule.pediatricDoseRuleForAgeYears(10);
  assert.equal(rule.pediatricDoseCeilingG(15, half), 7.5);
  assert.equal(rule.pediatricDoseCeilingG(15, third), 5);
  assert.equal(rule.pediatricDoseCeilingG(15, sixth), 2.5);
  assert.equal(rule.pediatricDoseCeilingG(15, twoThirds), 10);
  assert.equal(rule.pediatricDoseCeilingG(10, third), 3, "10g×1/3=3.33 → 向下取 3.0，不放大");
  assert.equal(rule.pediatricDoseCeilingG(3, sixth), 0.5);
  assert.equal(rule.pediatricDoseCeilingG(0.3, sixth), 0.05, "不足 0.5g 保留三位小数，不取零");
  assert.equal(rule.pediatricDoseCeilingG(0, half), 0);
  const adolescent = rule.pediatricDoseRuleForAgeYears(15);
  assert.equal(rule.pediatricDoseCeilingG(15, adolescent), 15, "青少年接近成人量：上限就是药典成人上限");
});

check("2.2 教材点名的控量药（麻黄/大黄/细辛…）任何年龄档都不超过成人上限的 2/3；同一档的普通药不受影响", () => {
  const adolescent = rule.pediatricDoseRuleForAgeYears(15);
  const toddlerRule = rule.pediatricDoseRuleForAgeYears(2);
  assert.equal(rule.pediatricDoseCeilingG(10, adolescent, "麻黄"), 6.5, "10×2/3=6.67 → 6.5，而不是成人上限 10");
  assert.equal(rule.pediatricDoseCeilingG(10, adolescent, "炙麻黄"), 6.5, "炮制品同样受控");
  assert.equal(rule.pediatricDoseCeilingG(10, adolescent, "黄芪"), 10, "反证：非控量药在青少年档就是成人上限");
  assert.equal(rule.pediatricDoseCeilingG(10, toddlerRule, "麻黄"), 5, "幼儿 1/2 本就低于 2/3，取小者");
  assert.equal(rule.pediatricDoseFractionFor(adolescent, "大黄"), 2 / 3);
});

check("2.3 禁用/慎用清单：罂粟壳任何儿童禁用；苦杏仁只对婴儿慎用；青少年对「婴儿慎用」的药不触发；成人语境不查", () => {
  const teen = rule.pediatricDoseRuleForAgeYears(15);
  const baby = rule.pediatricDoseRuleForAgeYears(0.5);
  const kid = rule.pediatricDoseRuleForAgeYears(6);
  for (const name of ["罂粟壳", "密陀僧", "雷公藤", "关木通", "广防己", "青木香", "马兜铃", "天仙藤"]) {
    assert.equal(rule.pediatricHerbRestriction(name, teen)?.level, "prohibited", `${name} 儿童禁用（含青少年）`);
  }
  assert.equal(rule.pediatricHerbRestriction("炒苦杏仁", baby)?.level, "caution", "婴儿慎用，炮制品同样命中");
  assert.equal(rule.pediatricHerbRestriction("苦杏仁", kid), undefined, "反证：6 岁不属婴儿");
  assert.equal(rule.pediatricHerbRestriction("白果", kid)?.level, "caution");
  assert.equal(rule.pediatricHerbRestriction("茯苓", kid), undefined);
  assert.equal(rule.pediatricHerbRestriction("", kid), undefined);
  const lists = rule.pediatricRestrictedHerbNames(baby);
  assert.ok(lists.prohibited.includes("罂粟壳") && lists.caution.includes("苦杏仁"));
  assert.equal(rule.pediatricRestrictedHerbNames(kid).caution.includes("苦杏仁"), false);
});

check("3.1 定性词：婴幼儿取更保守的乳婴儿档；只写「患儿」判不出档位（不猜）", () => {
  assert.equal(rule.pediatricDoseRuleForStageWords("新生儿黄疸")?.stage, "neonate");
  assert.equal(rule.pediatricDoseRuleForStageWords("婴幼儿腹泻")?.stage, "infant");
  assert.equal(rule.pediatricDoseRuleForStageWords("幼儿发热")?.stage, "toddler");
  assert.equal(rule.pediatricDoseRuleForStageWords("学龄前儿童咳嗽")?.stage, "preschool");
  assert.equal(rule.pediatricDoseRuleForStageWords("小学生食积")?.stage, "school");
  assert.equal(rule.pediatricDoseRuleForStageWords("患儿咳嗽"), undefined);
  assert.equal(rule.pediatricDoseRuleForStageWords("宝宝夜啼"), undefined);
  assert.equal(rule.pediatricDoseRuleForStageWords("成年男性，咳嗽"), undefined);
});

check("3.2 接地语料：服务端写的「患者年龄：N岁」优先，小数年龄（月龄婴儿）也认；成人为 undefined", () => {
  assert.equal(rule.pediatricDoseRuleFromGroundingText("患者年龄：2岁\n主诉：发热")?.stage, "toddler");
  assert.equal(rule.pediatricDoseRuleFromGroundingText("患者年龄：0.5岁\n主诉：腹泻")?.stage, "infant");
  assert.equal(rule.pediatricDoseRuleFromGroundingText("患者年龄：6.0833岁\n主诉：咳嗽")?.stage, "preschool");
  assert.equal(rule.pediatricDoseRuleFromGroundingText("患者年龄：45岁\n主诉：失眠"), undefined, "反证：成人");
  assert.equal(rule.pediatricDoseRuleFromGroundingText("年龄：8个月\n主诉：湿疹")?.stage, "infant", "叙述里带标签的月龄");
  assert.equal(rule.isPediatricGroundingText("患者年龄：0.5岁"), true);
  assert.equal(rule.isPediatricGroundingText("患者年龄：17.9岁"), true);
  assert.equal(rule.isPediatricGroundingText("患者年龄：18岁"), false);
});

// ── 病历侧 ─────────────────────────────────────────────────────────────
function caseWith(fields, chiefComplaint = "夜间汗出反复1月") {
  const base = types.createInitialCaseState();
  return safety.withSafetyGate({
    ...base,
    phase: "question",
    chiefComplaint,
    questionRounds: 1,
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1", source: "test", caseId: base.id, updatedAt: new Date(0).toISOString(),
      fields: { zhushu: chiefComplaint, ...fields },
      rawText: Object.values(fields).join("；"),
    },
  });
}

check("4.1 数值年龄 → 档位；HIS 年龄栏的月龄/天龄也认（新生儿只按天记）", () => {
  const stage = (age, cc) => safety.pediatricDoseRuleForCase(caseWith({ sex: "男", age }, cc))?.stage;
  assert.equal(stage("3岁"), "preschool");
  assert.equal(stage("8个月"), "infant");
  assert.equal(stage("18月龄"), "toddler");
  assert.equal(stage("12天"), "neonate");
  assert.equal(stage("3周龄"), "neonate");
  assert.equal(stage("6岁2个月"), "preschool");
  assert.equal(stage("8岁"), "school");
  assert.equal(stage("13岁"), "adolescent");
});

check("4.2 反证：成人不是儿童；叙述里的「发热3天」不会被当成新生儿的天龄", () => {
  const adult = caseWith({ sex: "男", age: "45岁" }, "发热3天，咳嗽");
  assert.equal(safety.isPediatricPatient(adult), false);
  assert.equal(safety.pediatricDoseRuleForCase(adult), undefined);
  const noAge = caseWith({ sex: "男", age: "" }, "患者男，3天来发热");
  assert.equal(safety.isPediatricPatient(noAge), false, "「男，3天」不是年龄字面，不得把成人判成新生儿");
});

check("4.3 只写「患儿」、无数值年龄：是儿童但档位判不出 → 收回剂量并追问年龄（不退化为成人剂量）", () => {
  const unknown = caseWith({ sex: "男", age: "" }, "患儿咳嗽痰多3天");
  assert.equal(safety.isPediatricPatient(unknown), true);
  assert.equal(safety.pediatricDoseRuleForCase(unknown), undefined);
  const permission = safety.derivePrescriptionPermission(unknown);
  assert.equal(permission.candidateMode, "non_dose_only");
  assert.match(permission.reasons.join("；"), /儿童年龄段无法判定/);
  assert.ok(safety.evaluateSafetyGate(unknown).missingItemCodes.includes("pediatric_age_unknown"));
  assert.equal(safety.evaluateSafetyGate(unknown).missingItemCodes.includes("pediatric_dose_rules_unavailable"), false, "旧「未配置儿童剂量规则」码不再产生");
  assert.equal(safety.hasHardDoseSafetyBoundary(unknown), true, "硬边界谓词同源：判不出档位的儿童仍是硬边界");
  assert.match(safety.hardDoseSafetyBoundaryReasons(unknown).join("；"), /儿童年龄段无法判定/);
  assert.equal(safety.hasHardDoseSafetyBoundary(caseWith({ sex: "男", age: "8岁" })), false, "反证：8 岁不是硬边界");
});

check("4.4 定性词能判档的（婴儿/幼儿/小学生）无需数值年龄也可折算", () => {
  const infant = caseWith({ sex: "男", age: "" }, "婴儿夜啼，易惊");
  assert.equal(safety.pediatricDoseRuleForCase(infant)?.stage, "infant");
  assert.notEqual(safety.derivePrescriptionPermission(infant).candidateMode, "non_dose_only");
});

check("4.5 儿童给出折算档位，说明不进「需确认」原因清单；成人没有", () => {
  const child = caseWith({ sex: "男", age: "5岁", weight: "18kg" });
  const permission = safety.derivePrescriptionPermission(child);
  assert.notEqual(permission.candidateMode, "non_dose_only");
  assert.equal(permission.pediatricDose?.stage, "preschool");
  assert.match(rule.pediatricDoseRuleSummary(permission.pediatricDose), /儿童（学龄前儿童，3～7岁（教材未单列，按幼儿档））：剂量按《中药学》《中医儿科学》年龄分数法折算，每味药取成人一般用量的 1\/2 以内/);
  assert.equal(permission.reasons.some((reason) => /年龄分数法/.test(reason)), false, "说明不是待确认项：reasons 会被 M04 路由整段列进「正式采纳前需确认」");
  assert.equal(safety.derivePrescriptionPermission(caseWith({ sex: "男", age: "45岁" })).pediatricDose, undefined);
  assert.equal(safety.hasHardDoseSafetyBoundary(child), false);
});

check("4.6 独立硬边界不受影响：儿童 + 红旗仍收回剂量（红旗轴照旧）", () => {
  const redFlagChild = caseWith({ sex: "男", age: "5岁", weight: "18kg" }, "当前持续压榨性胸痛30分钟未缓解，伴大汗");
  const permission = safety.derivePrescriptionPermission(redFlagChild);
  assert.equal(permission.candidateMode, "non_dose_only");
  assert.equal(permission.pediatricDose, undefined, "收回剂量的出口不带折算档位（没有剂量可折算）");
});

check("4.6b 婴幼儿病历的「母乳喂养」是患儿自己的喂养方式，不是母亲的哺乳期：不得触发孕哺独立硬边界（2026-09-30 回放：12 天新生儿被收回剂量）", () => {
  const boundary = (fields, cc) => safety.hardDoseSafetyBoundaryReasons(caseWith(fields, cc)).filter((reason) => /妊娠|哺乳|备孕/.test(reason));
  for (const [age, feeding] of [["12天", "母乳喂养"], ["8个月", "母乳喂养，未添加辅食"], ["18月龄", "哺乳后易吐奶"], ["3岁", "仍母乳喂养"], ["1个月", "母乳性黄疸"], ["5岁", "混合喂养史"]]) {
    assert.deepEqual(boundary({ sex: "男", age, extraText: feeding }, "皮肤黄染，吃奶欠佳"), [], `${age} + ${feeding} 不是孕哺状态`);
    assert.notEqual(safety.derivePrescriptionPermission(caseWith({ sex: "男", age, weight: "6kg", extraText: feeding, vitalsT: "36.8℃" }, "皮肤黄染，吃奶欠佳")).candidateMode, "non_dose_only", `${age} + ${feeding} 仍应给折算剂量`);
  }
  // 反证：成年女性的哺乳期/母乳喂养仍是硬边界；10 岁及以上女孩不豁免（初潮最早 8～9 岁，宁可多拦）；儿童的明确妊娠表述仍然锁剂量
  assert.equal(boundary({ sex: "女", age: "28岁", extraText: "产后3个月，母乳喂养中" }, "乳汁不足").length, 1);
  assert.equal(boundary({ sex: "女", age: "30岁", extraText: "正在哺乳" }, "咳嗽").length, 1);
  assert.equal(boundary({ sex: "女", age: "10岁", extraText: "哺乳期" }, "咳嗽").length, 1);
  assert.equal(boundary({ sex: "女", age: "5岁", extraText: "已妊娠8周" }, "咳嗽").length, 1, "明确的妊娠表述即使与年龄矛盾也锁剂量（既有设计）");
  // 只写档位词、没有数值年龄时同样按婴幼儿语境处理；学龄档（7～12 岁）无数值年龄不豁免
  assert.deepEqual(boundary({ sex: "男", age: "", extraText: "母乳喂养" }, "婴儿夜啼，易惊"), []);
});

check("4.6c 药品说明书的孕哺条款相关性：<10 岁不当作育龄人群（母乳喂养不触发），成年女性与明确阳性照旧", () => {
  const medication = jiti("../src/lib/patient-relevant-medication-risk.ts");
  const applies = (fields, extra = "") => medication.reproductiveMedicationRiskApplies({
    patient: { sex: fields.sex, age: fields.age }, chiefComplaint: extra, hisRecord: { fields },
  });
  assert.equal(applies({ sex: "女", age: "5岁" }, "咳嗽，母乳喂养"), false);
  assert.equal(applies({ sex: "男", age: "8个月" }, "吃奶欠佳，母乳喂养"), false);
  assert.equal(applies({ sex: "女", age: "28岁" }, "咳嗽"), true);
  assert.equal(applies({ sex: "女", age: "28岁" }, "产后母乳喂养中"), true);
  assert.equal(applies({ sex: "女", age: "12岁" }, "咳嗽"), true, "12 岁女孩仍按育龄人群处理");
});

check("4.7 接地语料的年龄行：月龄 6 个月 → 0.5，12 天 → 0.0329；且能被合同侧解析回同一档", () => {
  const six = safety.clinicalGroundingText(caseWith({ sex: "男", age: "6个月" }));
  assert.match(six, /患者年龄：0\.5岁/);
  assert.equal(rule.pediatricDoseRuleFromGroundingText(six)?.stage, "infant");
  const days = safety.clinicalGroundingText(caseWith({ sex: "男", age: "12天" }));
  assert.match(days, /患者年龄：0\.0329岁/);
  assert.equal(rule.pediatricDoseRuleFromGroundingText(days)?.stage, "neonate");
  // 合同侧与病历侧同源：同一份病历两边算出同一档
  for (const age of ["8个月", "2岁", "5岁", "9岁", "12天"]) {
    const state = caseWith({ sex: "男", age });
    assert.equal(
      rule.pediatricDoseRuleFromGroundingText(safety.clinicalGroundingText(state))?.stage,
      safety.pediatricDoseRuleForCase(state)?.stage,
      `${age}: 合同侧与病历侧必须同档`,
    );
  }
});

// ── 合同 / 剂量核对 ─────────────────────────────────────────────────────
const doseLimit = (name) => knowledge.getTcmHerbDoseLimit(name);
const toddler = rule.pediatricDoseRuleForAgeYears(2);
const infant = rule.pediatricDoseRuleForAgeYears(0.5);

check("5.1 剂量区间：儿童是 (0, 成人上限×分数]；成人仍是 [下限, 上限]（同一剂量两个口径结果相反）", () => {
  const fuling = doseLimit("茯苓");
  assert.ok(fuling && fuling.min > 5, "前提：茯苓成人下限高于 5g（药典 10–15g）");
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "6g", "水煎服", toddler), true, "幼儿 6g 在折算上限 7.5g 内");
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "6g", "水煎服"), false, "反证：同一个 6g 按成人口径低于下限");
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "8g", "水煎服", toddler), false, "超过折算上限 7.5g");
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "8g", "水煎服", infant), false, "乳婴儿上限 5g，更严");
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "4g", "水煎服", infant), true);
  assert.equal(contract.doseWithinConservativeModelLimit("茯苓", "0g", "水煎服", toddler), false, "零剂量不是剂量");
});

check("5.2 监管类药味不因儿童折算放行（管制/毒性药仍不进剂量候选）", () => {
  for (const name of ["朱砂", "雄黄", "水银", "穿山甲"]) {
    assert.equal(contract.doseWithinConservativeModelLimit(name, "0.5g", "水煎服", toddler), false, `${name} 儿童也不得作为普通剂量药`);
  }
});

check("5.3 偏离对象：儿童口径带折算说明，方向恒为超上限；成人口径不变", () => {
  const child = contract.ordinaryHistoricalDoseDeviation({ name: "茯苓", dose: "20g" }, "水煎服", toddler);
  assert.equal(child?.direction, "above_reference");
  assert.equal(child?.max, 7.5);
  assert.equal(child?.adultMax, 15);
  assert.equal(child?.pediatric?.fractionText, "1/2");
  assert.equal(contract.ordinaryHistoricalDoseDeviation({ name: "茯苓", dose: "6g" }, "水煎服", toddler), undefined, "折算区间内无偏离");
  const adult = contract.ordinaryHistoricalDoseDeviation({ name: "茯苓", dose: "6g" }, "水煎服");
  assert.equal(adult?.direction, "below_reference", "反证：成人口径下 6g 是低于下限");
  assert.equal(adult?.pediatric, undefined);
});

const candidate = (dose) => ({
  name: "本例辨证组方", herbs: [{ name: "茯苓", dose, role: "君", function: "健脾渗湿", targetPathogenesis: "脾虚湿盛" }],
  decoction: { method: "水煎服", dosesPerDay: 1, administrationTimesPerDay: 2 },
});
const doseCodes = (dose, context) => advisory.collectClinicalDeliveryAdvisories(candidate(dose), undefined, context)
  .map((item) => item.code).filter((code) => /dose/.test(code));

check("5.4 审方提示：同一剂量在儿童语境不报偏离，在成人语境报「低于参考」；超折算上限时儿童语境报偏离且文案是儿童口径", () => {
  assert.deepEqual(doseCodes("6g", "患者年龄：2岁\n主诉：泄泻"), []);
  assert.ok(doseCodes("6g", "患者年龄：45岁\n主诉：泄泻").some((code) => /dose_reference_deviation/.test(code)), "反证：成人语境");
  assert.ok(doseCodes("20g", "患者年龄：2岁\n主诉：泄泻").some((code) => /dose_reference_deviation/.test(code)));
  const message = advisory.collectClinicalDeliveryAdvisories(candidate("20g"), undefined, "患者年龄：2岁\n主诉：泄泻")
    .find((item) => /dose_reference_deviation/.test(item.code))?.message || "";
  assert.match(message, /儿童折算上限 7\.5g/);
  assert.match(message, /成人历史参考 \d+–\d+g × 1\/2/);
});

check("5.5 特殊人群矩阵的儿童臂：小数年龄（月龄婴儿、带月数的儿童）此前整段漏判，现在命中；成人与 18 岁不命中", () => {
  const profile = knowledge.getTcmHerbGenerationSafetyProfile("罂粟壳");
  assert.ok(profile.populationRules.some((item) => item.severity === "HIGH" && /儿童|婴幼儿/.test(item.population)), "前提：罂粟壳有儿童禁用的 HIGH 规则");
  const flagged = (context) => contract.m04GenerationSpecialPopulationIssue([{ name: "罂粟壳" }], context);
  assert.match(flagged("患者年龄：0.5岁\n主诉：久咳") || "", /special_population_high_risk_pediatric/);
  assert.match(flagged("患者年龄：6.0833岁\n主诉：久咳") || "", /special_population_high_risk_pediatric/);
  assert.match(flagged("患者年龄：8岁\n主诉：久咳") || "", /special_population_high_risk_pediatric/);
  assert.equal(flagged("患者年龄：18岁\n主诉：久咳"), undefined);
  assert.equal(flagged("患者年龄：45岁\n主诉：久咳"), undefined);
  assert.match(flagged("患儿久咳三月") || "", /special_population_high_risk_pediatric/, "定性词仍命中");
  // 规则数据里的禁用清单与知识库 HIGH 规则同一出口（此前关木通只有 MEDIUM 批注，儿童处方里会原样放行）
  const banned = (name, context) => contract.m04GenerationSpecialPopulationIssue([{ name }], context);
  assert.match(banned("关木通", "患者年龄：14岁\n主诉：水肿") || "", /herb_0_special_population_high_risk_pediatric/);
  assert.match(banned("马兜铃", "患者年龄：0.3岁\n主诉：咳嗽") || "", /special_population_high_risk_pediatric/);
  assert.equal(banned("关木通", "患者年龄：45岁\n主诉：水肿"), undefined, "反证：成人不走儿童禁用清单");
  assert.equal(banned("鸦胆子", "患者年龄：8岁\n主诉：痢疾"), undefined, "慎用级不驱动修复（只在编译器批注）");
});

// ── 编译器 ─────────────────────────────────────────────────────────────
const prior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallMethod: "健脾益气，化湿和中", overallPrinciple: "虚则补之" },
};
const proposal = {
  candidate: {
    name: "本例辨证组方",
    applicable: "食少倦怠与便溏并见，健脾益气同时兼顾化湿。",
    notApplicable: "便溏加重或出现腹痛时重新评估。",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气，改善食少倦怠" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿，兼顾便溏" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    formulaAnalysis: "党参为君补脾益气以改善食少倦怠，白术为臣健脾燥湿以助运化，茯苓为佐渗湿兼顾便溏，炙甘草为使补脾和胃、协调诸药。",
    decoction: { doseCount: "6剂", dosesPerDay: 2, administrationTimesPerDay: 2, method: "每日两剂分两次温服", followUpNode: "服完三日复诊，便溏加重提前复诊" },
  },
  patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息，餐后适量散步。", emotion: "保持心情舒畅。", tcmTreatments: [], precautions: ["每日观察食欲与便溏变化，若持续加重请提前复诊。"] },
};
const compiledHerbs = (state) => compiler.compileM04Proposal(structuredClone(proposal), prior, state).formula.candidates[0].herbs;
const byName = (herbs, name) => herbs.find((herb) => herb.name === name);

check("6.1 编译：儿童超折算上限的味按上限截取并注明；折算区间内的味原样保留", () => {
  const child = safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "2岁", weight: "12kg" }));
  const herbs = compiledHerbs(child);
  // 幼儿 1/2：茯苓 10–15g → 7.5g；白术 6–12g → 6g；党参 9–30g → 15g；炙甘草 2–10g → 5g
  assert.equal(byName(herbs, "茯苓").dose, "7.5g");
  assert.equal(byName(herbs, "白术").dose, "6g");
  assert.equal(byName(herbs, "党参").dose, "12g", "折算上限 15g 内的味不改");
  assert.equal(byName(herbs, "炙甘草").dose, "5g");
  const reasons = byName(herbs, "茯苓").verificationReasons.join("；");
  assert.match(reasons, /候选剂量原为 12g，高于儿童折算上限/);
  assert.match(reasons, /× 1\/2/);
  assert.equal(byName(herbs, "党参").verificationTier, "verified");
  assert.match(byName(herbs, "党参").verificationReasons.join("；"), /已按儿童折算上限 15g/);
});

check("6.2 反证：同一份提案在成人病例上原样保留（成人路径逐字节不变）", () => {
  const adult = safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "45岁" }));
  const herbs = compiledHerbs(adult);
  assert.deepEqual(herbs.map((herb) => herb.dose), ["12g", "10g", "12g", "6g"]);
  assert.doesNotMatch(herbs.flatMap((herb) => herb.verificationReasons).join("；"), /儿童折算/);
  const noState = compiler.compileM04Proposal(structuredClone(proposal), prior).formula.candidates[0].herbs;
  assert.deepEqual(noState.map((herb) => herb.dose), ["12g", "10g", "12g", "6g"]);
});

check("6.3 分档：同一提案 乳婴儿(1/3) 比 学龄儿童(2/3) 截得更狠", () => {
  const doses = (age) => compiledHerbs(safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age, weight: "10kg" }))).map((herb) => parseFloat(herb.dose));
  const infantDoses = doses("8个月");
  const schoolDoses = doses("9岁");
  assert.equal(infantDoses[2], 5, "茯苓 15g×1/3=5");
  assert.equal(schoolDoses[2], 10, "茯苓 15g×2/3=10");
  assert.ok(infantDoses.every((value, index) => value <= schoolDoses[index]));
});

// ── M04 合同（生成侧）：这是修复轮的驱动点，成人区间不适用于儿童会把模型推回成人剂量 ────────────────
const contractPrior = types.ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const contractProposal = {
  candidate: {
    name: "本例辨证组方",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "5日复诊" },
    formulaAnalysis: "党参补脾益气，白术健脾燥湿，茯苓渗湿，炙甘草补脾和胃。",
  },
  patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
};
const contractCompiled = (firstDose) => {
  const value = structuredClone(contractProposal);
  const result = compiler.compileM04Proposal(value, contractPrior);
  result.formula.candidates[0].herbs[0].dose = firstDose;
  return result;
};
const semantic = (value, context) => contract.m04SemanticIssue(value, "", contractPrior, knowledge.isKnownTcmHerbName, true, true, false, false, context, true);
const floorIssue = (value, context) => contract.m04SafetyContractIssue(value, contractPrior, {
  isKnownHerbName: knowledge.isKnownTcmHerbName, trustedWorkbenchEdit: false, auditedClinicalRisksAreAdvisory: false,
  clinicalContext: context, waiveTherapyCoverageAnnotated: true,
});
const childContext = "患者年龄：2岁\n食少倦怠；大便溏薄";
const adultContext = "患者年龄：45岁\n食少倦怠；大便溏薄";

check("5.6 合同：党参 8g（成人下限 9g 以下）——成人语境报偏离，幼儿语境放行；党参 20g（成人区间内、超幼儿上限 15g）——反过来", () => {
  assert.equal(knowledge.getTcmHerbDoseLimit("党参").min, 9, "前提：党参成人区间 9–30g");
  const low = contractCompiled("8g");
  assert.equal(semantic(low, adultContext), "candidate_0_herb_0_dose_reference_deviation", "反证：成人口径 8g 低于下限");
  assert.notEqual(semantic(low, childContext), "candidate_0_herb_0_dose_reference_deviation", "幼儿口径 8g 在 15g 折算上限内");
  const high = contractCompiled("20g");
  assert.notEqual(semantic(high, adultContext), "candidate_0_herb_0_dose_reference_deviation", "成人口径 20g 在 9–30g 内");
  assert.equal(semantic(high, childContext), "candidate_0_herb_0_dose_reference_deviation", "幼儿口径 20g 超折算上限");
  assert.equal(floorIssue(high, childContext), undefined, "超折算上限是批注（编译器会截取），不是 T1 硬拦——与成人越上限同一分级");
});

check("5.7 合同：儿童语境下野蛮超量（成人上限的数倍）仍被安全底线拦截；毒性标记药味不因儿童折算放行", () => {
  const wild = contractCompiled("200g");
  assert.match(floorIssue(wild, childContext) || "", /herb_0_dose_sanity_ceiling/);
  // 超折算上限（20g > 15g）且被标了毒性：不再是「普通药味的可批注偏离」，回到 T1 硬拦——与成人越上限同一分级。
  const toxicFlag = contractCompiled("20g");
  toxicFlag.formula.candidates[0].herbs[0].isToxic = true;
  assert.match(floorIssue(toxicFlag, childContext) || "", /herb_0_dose_outside_conservative_range/);
  const ordinaryFlag = contractCompiled("20g");
  assert.equal(floorIssue(ordinaryFlag, childContext), undefined, "反证：同一剂量、无毒性标记时只是批注");
});

check("6.4 儿童慎用药味（细辛：儿童/婴幼儿 MEDIUM 规则）在该味上写明；同一味在成人病例没有这句", () => {
  const profile = knowledge.getTcmHerbGenerationSafetyProfile("细辛");
  assert.ok(profile.populationRules.some((item) => /儿童|婴幼儿/.test(item.population) && item.severity !== "LOW"), "前提：细辛有儿童慎用规则");
  const withXixin = structuredClone(proposal);
  withXixin.candidate.herbs[1] = { ...withXixin.candidate.herbs[1], name: "细辛", dose: "3g", function: "祛风散寒，通窍止痛" };
  const build = (state) => compiler.compileM04Proposal(structuredClone(withXixin), prior, state).formula.candidates[0].herbs.find((herb) => herb.name === "细辛");
  const child = build(safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "6岁", weight: "20kg" })));
  assert.match(child.verificationReasons.join("；"), /细辛属儿童\/婴幼儿慎用药味：剂量已按年龄分数法控制/);
  assert.ok(parseFloat(child.dose) <= 1.5, `6 岁(1/2)：细辛成人上限 3g → 折算上限 1.5g，实际 ${child.dose}`);
  const adult = build(safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "45岁" })));
  assert.doesNotMatch(adult.verificationReasons.join("；"), /儿童\/婴幼儿慎用药味/);
});

check("6.5 数据清单里的慎用药（白果）在儿童处方里写明依据；青少年整体接近成人量，普通药原样保留、控量药封顶", () => {
  const withGuo = structuredClone(proposal);
  withGuo.candidate.herbs[1] = { ...withGuo.candidate.herbs[1], name: "白果", dose: "6g", function: "敛肺定喘，止带缩尿" };
  const herbsFor = (state) => compiler.compileM04Proposal(structuredClone(withGuo), prior, state).formula.candidates[0].herbs;
  const child = herbsFor(safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "6岁", weight: "20kg" })));
  assert.match(child.find((herb) => herb.name === "白果").verificationReasons.join("；"), /白果儿童慎用：小儿尤当注意/);
  const teen = herbsFor(safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "15岁", weight: "50kg" })));
  assert.deepEqual(teen.filter((herb) => herb.name !== "白果").map((herb) => herb.dose), ["12g", "12g", "6g"], "15 岁：分数为 1，普通药不被截");
  const withMahuang = structuredClone(proposal);
  withMahuang.candidate.herbs[1] = { ...withMahuang.candidate.herbs[1], name: "麻黄", dose: "10g", function: "发汗解表，宣肺平喘" };
  const mahuang = compiler.compileM04Proposal(withMahuang, prior, safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "15岁", weight: "50kg" })))
    .formula.candidates[0].herbs.find((herb) => herb.name === "麻黄");
  assert.equal(mahuang.dose, "6.5g", "15 岁：麻黄成人上限 10g，控量药按 2/3 封顶而不是放到 10g");
});

// ── 出口文案与接线 ─────────────────────────────────────────────────────
check("7.1 提示与说明：摘要写明年龄档、分数与依据；导引写明总量控制/急重不受限/峻烈药从低；新生儿另有一条", () => {
  const summary = rule.pediatricDoseRuleSummary(toddler);
  assert.match(summary, /幼儿/);
  assert.match(summary, /1\/2/);
  const guidance = rule.pediatricDoseRuleGuidance(toddler).join("\n");
  assert.match(guidance, /总量控制/);
  assert.match(guidance, /病情急重者不受上述比例限制/);
  assert.match(guidance, /麻黄、附子、细辛、乌头、大黄、巴豆、芒硝/);
  assert.doesNotMatch(guidance, /新生儿期/);
  assert.match(rule.pediatricDoseRuleGuidance(rule.pediatricDoseRuleForAgeYears(0.01)).join("\n"), /新生儿期.*儿科医师/);
});

check("7.2 M04 参考页兜底：儿童文案给出折算分数，年龄段判不出时仍要求折算；不再要求药师复核", () => {
  const text = source("src/lib/m04-deterministic-fallback.ts");
  assert.match(text, /pediatricDoseRuleForCase/);
  assert.doesNotMatch(text, /儿童用量须由医师按体重\/年龄折算并经药师复核/);
  assert.equal(typeof fallbackModule.buildDeterministicFormulaReferenceFallback, "function");
});

check("7.3 接线：路由把折算档位写进提示词与页面、编译器/合同/审方/HIS 读同一个规则模块", () => {
  const route = source("src/app/api/diagnosis/prescribe/route.ts");
  assert.match(route, /const pediatricDose = permission\.pediatricDose;/);
  assert.match(route, /【儿童剂量】/);
  assert.match(route, /## 儿童用药说明/);
  assert.match(route, /本例禁用药味（不得入方）/, "提示词必须把本档禁用药名告诉模型，不只靠合同事后拦");
  assert.match(route, /pediatricNotice,\s*informationNotice,/, "儿童说明必须进入最终输出数组，只定义不交付等于没有");
  assert.match(source("src/lib/m04-proposal-compiler.ts"), /pediatricDoseRuleFromGroundingText\(clinicalGroundingText\(caseState\)\)/);
  assert.match(source("src/lib/diagnosis-stage-contract.ts"), /pediatricDoseRuleFromGroundingText\(clinicalContext/);
  assert.match(source("src/lib/his-scheme.ts"), /permission\.pediatricDose/);
  assert.match(source("src/lib/clinical-delivery-advisory.ts"), /pediatricDoseRuleFromGroundingText\(clinicalContext\)/);
  // 病历侧只剩一份儿童词表（来自数据文件），不再手抄第二份正则
  const safetySource = source("src/lib/diagnosis-safety.ts");
  assert.doesNotMatch(safetySource, /患儿\|儿童\|未成年人\|新生儿\|婴儿\|婴幼儿\|乳儿\|幼儿\|宝宝\|男童\|女童\|月龄/);
});

// ── 8 端到端：流层（编译 → 合同 → 验收）回放一份成人剂量的 M04 提案 ──────────────────────────
const api = jiti("../src/lib/diagnosis-api.ts");
const encoder = new TextEncoder();
const sse = (value) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
  controller.close();
} }), { headers: { "content-type": "text/event-stream" } });
async function replayProposal(caseState, clinicalContext) {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const requests = [];
  try {
    console.info = () => {};
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) return sse(structuredClone(contractProposal));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ status: "accepted" }) }, finish_reason: "stop" }] });
    };
    const response = await api.callDiagnosisStream("synthetic pediatric fixture", "deepseek", undefined, "markdown", {
      structuredStage: "prescribe", structuredPriorReasoning: contractPrior,
      structuredClinicalContext: clinicalContext, structuredCaseState: caseState,
      structuredOrchestrationStartedAt: Date.now() - 60000 + 30000,
      truncateFallback: "GENERIC_KB_FALLBACK", deadlineFallback: "GENERIC_DEADLINE_FALLBACK",
      prescribeSignatureContext: { contractVersion: "tcm-cdss-m04-signature-v3", caseId: "synthetic", encounterId: "synthetic",
        clinicalInputHash: `sha256:${"a".repeat(64)}`, diagnoseContractHash: `sha256:${"b".repeat(64)}` },
    });
    const wire = await response.text();
    const frames = wire.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const final = frames.filter((frame) => frame.content?.startsWith("<<<CDSS_STREAM_FINAL>>>")).at(-1)?.content || "";
    return { final, requests: requests.length };
  } finally { globalThis.fetch = originalFetch; console.info = originalInfo; }
}
const doseRows = (content) => Object.fromEntries([...content.matchAll(/(党参|白术|茯苓|炙甘草)[^\n|]*?\|?\s*(\d+(?:\.\d+)?)\s*g/g)].map((m) => [m[1], m[2]]));

let asyncChecks = 0;
const checkAsync = async (name, fn) => {
  asyncChecks += 1;
  try { await fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 900) }); }
};

await checkAsync("8.1 端到端：2 岁儿童 + 成人剂量提案 → 最终页每味药不超过折算上限，且没有为压剂量多走一轮修复", async () => {
  const child = safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "2岁", weight: "12kg" }));
  const context = `${safety.clinicalGroundingText(child)}\n食少倦怠；大便溏薄`;
  const { final, requests } = await replayProposal(child, context);
  assert.ok(final.includes("DIAGNOSIS_JSON_START"), `应交付候选方: ${final.slice(0, 200)}`);
  const herbs = JSON.parse(final.slice(final.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, final.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0].herbs;
  const doses = Object.fromEntries(herbs.map((herb) => [herb.name, herb.dose]));
  assert.equal(doses["茯苓"], "7.5g");
  assert.equal(doses["白术"], "6g");
  assert.equal(doses["炙甘草"], "5g");
  assert.equal(doses["党参"], "12g");
  assert.equal(requests, 1, "折算由编译器确定性完成，不靠修复轮把模型推回去");
  void doseRows;
});

await checkAsync("8.2 反证：同一提案、同一流程，成人病例原样交付成人剂量", async () => {
  const adult = safety.sanitizeCaseStateForModel(caseWith({ sex: "男", age: "45岁" }));
  const context = `${safety.clinicalGroundingText(adult)}\n食少倦怠；大便溏薄`;
  const { final } = await replayProposal(adult, context);
  const herbs = JSON.parse(final.slice(final.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, final.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0].herbs;
  assert.deepEqual(herbs.map((herb) => herb.dose), ["12g", "10g", "12g", "6g"]);
});

console.log(JSON.stringify({ suite: "pediatric-dose-rule", checks: checks + asyncChecks, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

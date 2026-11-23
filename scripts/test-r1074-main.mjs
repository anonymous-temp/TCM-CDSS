// 第五十六轮（2026-11-23）：第五十五轮对照实验里新写 40 份病历暴露的两类服务端问题（模型调用一律不发生）。
//  R 红旗过度预警四类，都在确定性层：
//    R1 口语「胸口发闷」的急性线索读了全文（别的症状的「持续几个小时」、被否认的「突然」），只读本句、线索须肯定（f06）；
//    R2 阴道出血程度判据窗口里被否认的程度词（「无大血块」）也算（f26）；
//    R3 「伴」引出的并列症状里的下肢无力不沿用上一整句的慢性起病锚点（f35）；
//    R4 化脓性扁桃体炎「吞咽困难，能咽口水」被报颈深感染，急性咽喉感染里的吞咽痛被报上消化道梗阻（f39）。
//  A 病位、病性两轴的「已确定/有界、说明句、可信度」在交付前按交付内容重算：服务端不再断言「尚缺直接的病历依据」、不再把引文没对上压成可信度低。
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const check = async (id, title, run) => {
  if (process.env.R1074_CHECK && process.env.R1074_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const gate = (input) => safety.withSafetyGate(types.normalizeCaseStateInput(input)).safetyGate;
const record = (chiefComplaint, history, extra = {}, patient = { sex: "女", age: 40 }, vitals = { T: "36.5", P: "76", R: "18", BP: "120/76" }) => ({
  chiefComplaint, patient, symptoms: { 现病史: history, 既往史: "既往体健", 过敏史: "否认药物及食物过敏史", ...extra }, tongue: "舌淡红，苔薄白", pulse: "脉平", vitals, conversation: [],
});

// ───── R：四类红旗过度预警 ─────
const f06 = record("头痛反复3月", "患者3月来反复头痛，以前额和头顶昏沉、发闷为主，像戴了顶湿帽子箍着，阴雨天和吃完油腻饭后明显，每周发作3～4次，每次持续几个小时，能忍受。伴胸口和胃脘部发闷，恶心想吐但没吐，不想吃饭，嘴里黏腻，痰多色白。头痛不是突然出现的，无剧烈爆裂样痛，无喷射样呕吐，无视物模糊、复视，无肢体麻木无力，无言语不清。", { 既往史: "高血压5年，服苯磺酸氨氯地平片5mg每日1次，规律服药" }, { sex: "女", age: 56 }, { T: "36.5", P: "76", R: "18", BP: "138/84" });
await check("R1", "胸口发闷的急性线索只读本句且须肯定：前一句头痛的「持续几个小时」与「不是突然出现」不算；本句写「突然」「持续半小时」照报", () => {
  assert.deepEqual(gate(f06).redFlags, []);
  assert.ok(gate(record("胸口压迫感半小时", "今天突然胸口像石头压着，持续半小时。")).redFlags.some((item) => /急性心血管事件/u.test(item)));
  assert.ok(gate(record("胸口发闷1小时", "胸口发闷1小时，休息不缓解。")).redFlags.some((item) => /急性心血管事件/u.test(item)));
  // 本句的线索被否认（「胸口发闷不是突然出现的」）也不算
  assert.deepEqual(gate(record("胸闷", "胸口发闷，不是突然出现的，痰多。")).redFlags, []);
});

const f26 = record("产后阴道流血5周未净", "患者2026-10-14顺产一女，产后至今阴道流血一直没干净，量较多，每天需换3～4片卫生巾，颜色淡红，质稀，无臭味，无大血块。伴小腹空坠感，精神倦怠，四肢无力，气短懒言，稍动就出汗，面色发白。纯母乳喂养中。无发热，无腹痛加剧，无乳房红肿。",
  { 婚育史: "已婚，G1P1，2026-10-14足月顺产1女，纯母乳喂养", 辅助检查: "盆腔彩超示子宫复旧欠佳，宫腔内未见明显组织物残留；血常规Hb 105g/L；血β-hCG 5mIU/mL" }, { sex: "女", age: 29 }, { T: "36.6", P: "84", R: "18", BP: "106/68" });
await check("R2", "阴道出血窗口里被否认的程度词（无大血块）不算量多的证据；肯定的血块、量多、不止照报", () => {
  assert.deepEqual(gate(f26).redFlags.filter((item) => /阴道出血/u.test(item)), []);
  assert.ok(gate(record("阴道流血3天", "阴道流血3天，量多，有大血块。")).redFlags.some((item) => /活动性大量阴道出血/u.test(item)));
  assert.ok(gate(record("阴道流血", "阴道流血不止，夹有血块，面色苍白。")).redFlags.some((item) => /活动性大量阴道出血/u.test(item)));
  // 同一窗口里先否认一个、后肯定另一个：肯定的那个照算（逐个判，不是只看最后一个）
  assert.ok(gate(record("阴道流血", "阴道流血10天，无血块，量多。")).redFlags.some((item) => /活动性大量阴道出血/u.test(item)));
});

const f35 = record("腰背酸痛2年，加重3月", "患者2年来腰背酸痛，久坐久站后加重，躺下休息减轻，近3月加重，身高比年轻时矮了约3cm。伴腰膝酸软，下肢无力，头晕耳鸣，记性差，头发稀少，牙齿松动，夜尿2次。近期无摔倒、无外伤，无突然剧烈疼痛，无夜间静息痛加重，无发热，体重无下降，下肢无麻木，大小便控制正常。",
  { 既往史: "2026-08确诊骨质疏松症，服阿仑膦酸钠片70mg每周1次" }, { sex: "女", age: 68 }, { T: "36.4", P: "74", R: "18", BP: "128/78" });
await check("R3", "「伴」引出的并列症状里的无力沿用「伴」所接那一段的慢性起病锚点；单侧、锚点段有急性线索、缺损自带时长的照报", () => {
  assert.deepEqual(gate(f35).redFlags, []);
  assert.deepEqual(gate(record("腰痛3年", "患者3年来腰痛，伴腰膝酸软，下肢无力，畏寒肢冷。")).redFlags, []);
  assert.ok(gate(record("头晕", "患者3年前诊断高血压，今晨突然头晕。伴恶心，右侧肢体无力。")).redFlags.some((item) => /神经系统急症/u.test(item)));
  assert.ok(gate(record("头晕", "今晨突然头晕。伴恶心，肢体无力。")).redFlags.some((item) => /神经系统急症/u.test(item)));
  assert.ok(gate(record("腰痛2年", "患者2年来腰痛。伴腰酸，下肢无力2天。")).redFlags.some((item) => /神经系统急症/u.test(item)));
  // 单独钉住各守卫（其他守卫不同时成立的写法）：单侧；锚点段既有慢性锚点又有急性线索
  assert.ok(gate(record("高血压3年", "患者3年来高血压。伴头晕，右侧肢体无力。")).redFlags.some((item) => /神经系统急症/u.test(item)));
  assert.ok(gate(record("头晕", "患者3年来高血压，今晨突然头晕。伴恶心，肢体无力。")).redFlags.some((item) => /神经系统急症/u.test(item)));
});

const f39 = record("咽痛剧烈伴发热2天", "患者2天前吃烧烤后咽痛，今天明显加重，痛连两侧耳根和下颌，吞咽困难，能咽口水和喝稀粥，发热，最高39.2℃，口渴想喝凉的，口臭，大便2天没解，小便黄。无张口困难，无流口水，无呼吸困难，说话声音无改变。",
  { 辅助检查: "本院查体：双侧扁桃体Ⅱ度肿大，充血，表面可见黄白色脓点，悬雍垂居中，软腭无膨隆，张口度正常，无流涎；双侧颌下淋巴结肿大压痛。血常规WBC 15.6×10⁹/L" }, { sex: "女", age: 22 }, { T: "39.0", P: "108", R: "20", BP: "112/72" });
await check("R4", "吞咽困难而口水仍咽得下不是颈深感染的危险征象；急性咽喉感染里的吞咽困难不按上消化道梗阻报；不能咽口水、进行性吞咽困难照报", () => {
  assert.deepEqual(gate(f39).redFlags, []);
  assert.ok(gate(record("咽痛3天", "咽痛3天，吞咽困难，不能咽口水，流涎，发热。")).redFlags.some((item) => /颈深部感染/u.test(item)));
  const throat = gate(record("咽痛伴发热", "咽痛伴吞咽困难，发热。")).redFlags;
  assert.ok(throat.some((item) => /颈深部感染/u.test(item)));
  // 同一事件不再叠第二条（上消化道吞咽梗阻）
  assert.ok(!throat.some((item) => /上消化道警示征象/u.test(item)), JSON.stringify(throat));
  assert.ok(gate(record("吞咽困难3月", "进行性吞咽困难3月，近2天咽痛。")).redFlags.some((item) => /上消化道警示征象/u.test(item)));
  assert.ok(gate(record("吞咽困难2月", "吞咽困难2月，进食梗阻感，消瘦。", {}, { sex: "男", age: 66 })).redFlags.some((item) => /上消化道警示征象/u.test(item)));
  // 单独钉住：进行性（同句没有长病程）；同句病程超过 14 天（没写进行性）。主诉不写吞咽困难，免得主诉那一行自己成立。
  assert.ok(gate(record("咽痛2天", "进行性吞咽困难，近2天咽痛加重。", {}, { sex: "男", age: 66 })).redFlags.some((item) => /上消化道警示征象/u.test(item)));
  assert.ok(gate(record("咽痛2天", "吞咽困难3月，近2天咽痛。", {}, { sex: "男", age: 66 })).redFlags.some((item) => /上消化道警示征象/u.test(item)));
});

await check("R5", "受治理表：保留写法闭集与咽喉急性病程天数在源表、紧凑表同步", () => {
  const source = JSON.parse(fs.readFileSync(`${root}/src/data/redflag-discriminators.source.json`, "utf8")).deterministicCombinations.deepNeckSpaceInfection;
  assert.ok(source.swallowingPreservedPatterns.length >= 2 && source.swallowingPreservedNote && source.acuteThroatOdynophagiaMaxDays === 14);
  // 保留写法只认口水/唾液（食管梗阻也常仍能进流质）
  assert.ok(source.swallowingPreservedPatterns.every((pattern) => /口水|唾液/u.test(pattern)));
  execFileSync(process.execPath, [`${root}/scripts/build-redflag-discriminators.mjs`, "--check"], { stdio: "pipe" });
});

// ───── A：两轴记账字段交付前按交付内容重算 ─────
const recordText = "患者因公司裁员与领导大吵一架后失眠，躺下脑子停不下来，眼睛发红，耳朵嗡嗡响，口干口苦。产后阴道流血5周未净，量多色淡质稀，小腹空坠。精神倦怠，四肢无力，气短懒言。多吃几口就喊肚子胀；偶尔打嗝、恶心。苔薄腻。舌淡，苔薄白。脉缓弱。畏寒肢冷，小便清长。";
const evidence = (confidence) => ({ evidenceLevel: "model_inference", source: "本例四诊与病史推断", confidence });
await check("A1", "病位条目都有逐字依据：已确定、删服务端说明句；合并写的「胞宫、冲任」一条依据两个病位都认", () => {
  const stale = { pathogenesis: { locationDifferentiation: { items: ["肝", "心"], resolution: "bounded", resolutionReason: "病位“胃”尚缺直接的病历依据", evidence: evidence("低"),
    details: [{ location: "肝", basis: "因公司裁员与领导大吵一架" }, { location: "心", basis: "躺下脑子停不下来" }] } } };
  summary.withAxisBookkeepingFromFinalContent(stale, recordText);
  const location = stale.pathogenesis.locationDifferentiation;
  assert.equal(location.resolution, "resolved"); assert.equal(location.resolutionReason, undefined); assert.equal(location.evidence.confidence, "中");
  const joined = { pathogenesis: { locationDifferentiation: { items: ["胞宫", "冲任", "脾"], resolution: "bounded", resolutionReason: "病位“胞宫、冲任”尚缺直接的病历依据", evidence: evidence("低"),
    details: [{ location: "脾", basis: "精神倦怠，四肢无力，气短懒言" }, { location: "胞宫、冲任", basis: "产后阴道流血5周未净，量多色淡质稀，小腹空坠" }] } } };
  summary.withAxisBookkeepingFromFinalContent(joined, recordText);
  assert.equal(joined.pathogenesis.locationDifferentiation.resolution, "resolved");
});
await check("A2", "病位有一项真没有对上原文：仍有界，但不写「尚缺直接的病历依据」、可信度不压成低", () => {
  const partial = { pathogenesis: { locationDifferentiation: { items: ["肝", "胃"], resolution: "bounded", resolutionReason: "病位“胃”尚缺直接的病历依据", evidence: evidence("低"),
    details: [{ location: "肝", basis: "因公司裁员与领导大吵一架" }, { location: "胃", basis: "胃脘胀满不舒" }] } } };
  summary.withAxisBookkeepingFromFinalContent(partial, recordText);
  const location = partial.pathogenesis.locationDifferentiation;
  assert.equal(location.resolution, "bounded"); assert.equal(location.resolutionReason, undefined); assert.equal(location.evidence.confidence, "中");
});
await check("A3", "病性：去掉「本虚标实」格局说法，条目取本虚与标实之并；unresolved 而有要素时重判；模型点名的待核实说明不覆盖", () => {
  const nature = { pathogenesis: { natureDifferentiation: { items: ["本虚标实"], rootDeficiency: ["脾胃气虚", "本虚标实"], branchExcess: ["湿滞"], basis: "苔薄腻；多吃几口就喊肚子胀；偶尔打嗝、恶心",
    resolution: "unresolved", resolutionReason: "本例记录中没有可稳定归纳的病性及其依据", evidence: evidence("低") } } };
  summary.withAxisBookkeepingFromFinalContent(nature, recordText);
  const axis = nature.pathogenesis.natureDifferentiation;
  assert.deepEqual(axis.items, ["脾胃气虚", "湿滞"]); assert.deepEqual(axis.rootDeficiency, ["脾胃气虚"]);
  assert.notEqual(axis.resolution, "unresolved"); assert.equal(axis.resolutionReason, undefined); assert.equal(axis.evidence.confidence, "中");
  const named = { pathogenesis: { natureDifferentiation: { items: ["寒"], rootDeficiency: [], branchExcess: ["寒"], basis: "苔薄腻", resolution: "bounded",
    resolutionReason: "病性“寒”尚待核实（可留意畏寒、肢冷、口淡不渴、小便清长等表现）", evidence: evidence("中") } } };
  summary.withAxisBookkeepingFromFinalContent(named, recordText);
  assert.equal(named.pathogenesis.natureDifferentiation.resolution, "bounded");
  assert.match(named.pathogenesis.natureDifferentiation.resolutionReason, /尚待核实（可留意/u);
  // 依据其实够、模型却点名了待核实：照旧有界、说明保留（不替流式定稿的判断翻案）
  const supported = { pathogenesis: { natureDifferentiation: { items: ["寒"], rootDeficiency: [], branchExcess: ["寒"], basis: "畏寒肢冷，小便清长", resolution: "bounded",
    resolutionReason: "病性“寒”中寒热喜恶尚待核实", evidence: evidence("中") } } };
  summary.withAxisBookkeepingFromFinalContent(supported, recordText);
  assert.equal(supported.pathogenesis.natureDifferentiation.resolution, "bounded");
  assert.match(supported.pathogenesis.natureDifferentiation.resolutionReason, /寒热喜恶尚待核实/u);
});
await check("A4", "幂等；急危重说明句不删；没有病历原文时不动", () => {
  const value = { pathogenesis: { locationDifferentiation: { items: ["肝", "心"], resolution: "bounded", resolutionReason: "病位“胃”尚缺直接的病历依据", evidence: evidence("低"),
    details: [{ location: "肝", basis: "因公司裁员与领导大吵一架" }, { location: "心", basis: "躺下脑子停不下来" }] } } };
  summary.withAxisBookkeepingFromFinalContent(value, recordText);
  const once = JSON.stringify(value); summary.withAxisBookkeepingFromFinalContent(value, recordText);
  assert.equal(JSON.stringify(value), once);
  const redFlag = { pathogenesis: { natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "", resolution: "bounded", resolutionReason: "急危重风险未排除，请先完成急诊或转诊评估", evidence: evidence("中") } } };
  summary.withAxisBookkeepingFromFinalContent(redFlag, recordText);
  assert.match(redFlag.pathogenesis.natureDifferentiation.resolutionReason, /急危重风险未排除/u);
  const untouched = { pathogenesis: { locationDifferentiation: { items: ["肝"], resolution: "bounded", resolutionReason: "病位“肝”尚缺直接的病历依据", evidence: evidence("低"), details: [] } } };
  summary.withAxisBookkeepingFromFinalContent(untouched, "");
  assert.equal(untouched.pathogenesis.locationDifferentiation.evidence.confidence, "低");
});
await check("A5", "接线：交付面投影在合称/证型按两轴定稿之前重算两轴（重算后两轴已确定的，证型那一步才看得到）", () => {
  const source = fs.readFileSync(`${root}/src/lib/delivered-surface.ts`, "utf8");
  const recompute = source.indexOf("withAxisBookkeepingFromFinalContent(projected, options.recordText)");
  const syndrome = source.indexOf("withSyndromeResolutionFromAxes(projected, options.recordText");
  assert.ok(recompute > 0 && syndrome > recompute && syndrome - recompute < 400);
});

// 第九轮 WP9-G（2026-10-19，中成药/西药推荐，甲方 P1「中成药推荐 ≥90%：与证候匹配、无矛盾推荐」）。
//
// M 集验收评审新增模块 K（中成药推荐）：123/141 = 87.2%，18 例不合格，四类：
//   1 同类重复（9 例）：多潘立酮＋甲氧氯普胺、聚乙二醇4000＋乳果糖、塞来昔布＋双氯芬酸钠栓、两种外用止痛喷剂、两种湿疹外用膏、
//     天麻首乌片＋天麻醒脑胶囊、木香顺气丸＋平胃丸、胃苏颗粒＋复方陈香胃片、外用贴膏＋气雾剂。第五轮只对解热镇痛药去重。
//   2 药性方向与证候相反（补益心脾配肝阳上亢、清热燥湿配风寒湿痹…）：规划模型此前看不到治法与病机；判据只在明确相反时不列。
//   3 推荐栏与注意事项自相矛盾（「不要再服其他治疗胃脘胀满的中成药」同页列着胃苏颗粒）。
//   4 与现用药同成分（现用丹参滴丸，推荐丹参保心茶）。
// 每条断言都带对照；反证记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 9/medicines）。
//
//   1 西药同类（药理学分类表）：同四级分类留一个；只共享三级分类要对应问题重合；按给药途径分开；抗感染类不按药理类别合并
//   2 中成药同类：同一给药途径 + 对应问题概念全包含；外用/内服各留一个；问题不同的都留
//   3 药理学分类表：来源与指纹、按全名与通用名查（削尾巴）、各给药途径取各自的分类
//   4 方向底线：纯补配纯实、纯攻配纯虚、清热配寒证、温热配热证；补攻并用、外用、虚实夹杂一律弃权
//   5 现用药：current_medications 里的中成药同品/同组成/同以某味药命名都不再推荐
//   6 规划器：把已签名辨证放进模型看到的病例事实；提示词规则；方向相反的候选不交给模型；同类只留一个
//   7 编译器接线
//   8 交付面：注意事项叫患者别再服「治疗某问题的中成药」时，同页推荐栏治该问题的中成药不再推荐

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

process.env.CDSS_DRUG_INVENTORY_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "cdss-r1021-medicines-"));
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

const dup = await jiti.import("../src/lib/patent-medicine-duplication.server.ts");
const loc = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const surf = await jiti.import("../src/lib/delivered-surface.ts");

const med = (type, name, problem, route = "口服", extra = {}) => ({ type, name, correspondingProblem: problem, route, positioning: "需医生评估", ...extra });
const names = (rows) => rows.map((row) => row.name);
const keep = (rows) => names(dup.withoutSameClassMedicines(rows));

// ── 1 西药同类 ─────────────────────────────────────────────────────────────
await check("1.1 同为胃肠动力药（多潘立酮＋甲氧氯普胺，RobustSDT-0062）只留排在前面的", () => {
  assert.deepEqual(keep([med("西药", "多潘立酮片", "脘腹痞闷、进食后呕吐加重", ""), med("西药", "甲氧氯普胺片", "频繁呕吐", "")]), ["多潘立酮片"]);
  assert.deepEqual(keep([med("西药", "甲氧氯普胺片", "频繁呕吐", ""), med("西药", "多潘立酮片", "脘腹痞闷、进食后呕吐加重", "")]), ["甲氧氯普胺片"], "留下的是排在前面的");
  // 对照：不同药理类别（促动力药与抗酸药）、同一页的都留
  assert.deepEqual(keep([med("西药", "多潘立酮片", "脘腹痞闷", ""), med("西药", "铝碳酸镁片", "反酸烧心", "")]), ["多潘立酮片", "铝碳酸镁片"]);
});

await check("1.2 同为渗透性泻药（聚乙二醇4000＋乳果糖，RobustSDT-0071）只留一个；对照：蒙脱石散（止泻药）不受影响", () => {
  assert.deepEqual(keep([med("西药", "聚乙二醇4000散", "慢性便秘", ""), med("西药", "乳果糖口服溶液", "慢性便秘", "")]), ["聚乙二醇4000散"]);
  assert.deepEqual(keep([med("西药", "聚乙二醇4000散", "慢性便秘", ""), med("西药", "蒙脱石散", "腹泻", "")]), ["聚乙二醇4000散", "蒙脱石散"]);
});

await check("1.3 两种非甾体抗炎药（塞来昔布＋双氯芬酸钠栓，TCMChat-336）：共享三级分类 + 对应问题相同才合并；问题不同、途径不同都保留", () => {
  assert.deepEqual(keep([med("西药", "塞来昔布胶囊", "左膝关节疼痛", ""), med("西药", "双氯芬酸钠栓", "左膝关节疼痛", "")]), ["塞来昔布胶囊"]);
  assert.deepEqual(keep([med("西药", "塞来昔布胶囊", "左膝关节疼痛", ""), med("西药", "双氯芬酸钠栓", "发热", "")]), ["塞来昔布胶囊", "双氯芬酸钠栓"],
    "对照：只共享三级分类而问题不重合，不合并");
  assert.deepEqual(keep([med("西药", "塞来昔布胶囊", "关节痛", ""), med("西药", "双氯芬酸二乙胺凝胶", "关节痛", "外用")]), ["塞来昔布胶囊", "双氯芬酸二乙胺凝胶"],
    "对照：口服与皮肤外用各留一种（凝胶挂的是局部用非甾体抗炎药，不与口服比）");
});

await check("1.4 同四级分类的西药（如两种质子泵抑制药）不需要问题重合就合并；对照：按病原体选的抗感染类（甲硝唑＋克霉唑栓）不按药理类别合并", () => {
  assert.deepEqual(keep([med("西药", "奥美拉唑肠溶胶囊", "胃溃疡", ""), med("西药", "兰索拉唑肠溶片", "反流性食管炎", "")]), ["奥美拉唑肠溶胶囊"]);
  assert.deepEqual(keep([med("西药", "甲硝唑片", "阴道炎", ""), med("西药", "克霉唑栓", "阴道炎", "")]), ["甲硝唑片", "克霉唑栓"]);
});

await check("1.5 抗组胺药、促动力药等第二档（氯雷他定＋西替利嗪、莫沙必利＋多潘立酮）同理", () => {
  assert.deepEqual(keep([med("西药", "氯雷他定片", "急性荨麻疹", ""), med("西药", "盐酸西替利嗪片", "急性荨麻疹", "")]), ["氯雷他定片"]);
  assert.deepEqual(keep([med("西药", "枸橼酸莫沙必利片", "功能性消化不良", ""), med("西药", "多潘立酮片", "功能性消化不良", "")]), ["枸橼酸莫沙必利片"]);
});

await check("1.6 中成药与西药互不比较；分类表查不到的西药不动", () => {
  assert.deepEqual(keep([med("中成药", "胃苏颗粒", "嗳气", "开水冲服"), med("西药", "铝碳酸镁片", "嗳气", "")]), ["胃苏颗粒", "铝碳酸镁片"]);
  assert.deepEqual(keep([med("西药", "某某新药片", "头痛", ""), med("西药", "另一新药胶囊", "头痛", "")]), ["某某新药片", "另一新药胶囊"]);
});

// ── 2 中成药同类 ───────────────────────────────────────────────────────────
await check("2.1 两种外用止痛喷剂（SD-488395）、外用贴膏＋气雾剂（SD-483155）：同一给药途径、同一问题只留一个；内服的汉桃叶片不受影响", () => {
  assert.deepEqual(keep([
    med("中成药", "乳香风湿气雾剂", "关节肌肉痛、多关节疼痛", "外用，喷于患处"),
    med("中成药", "汉桃叶片", "风湿关节痛、晨僵", "口服"),
    med("中成药", "双虎肿痛宁喷雾剂", "关节肌肉痛、多关节疼痛", "外用，喷洒患处"),
  ]), ["乳香风湿气雾剂", "汉桃叶片"]);
  assert.deepEqual(keep([
    med("中成药", "一枝篙伤湿祛痛膏", "寒湿腰痛证", "外用，贴于患处"),
    med("中成药", "云南白药膏", "寒湿腰痛、腰背肌肉酸痛", "贴患处"),
    med("中成药", "乳香风湿气雾剂", "寒湿腰痛证", "外用，喷于患处"),
  ]), ["一枝篙伤湿祛痛膏"]);
});

await check("2.2 两种湿疹外用膏（0516）、两种内服行气化湿丸（447858）、天麻首乌片＋天麻醒脑胶囊（0578）、胃苏颗粒＋复方陈香胃片（0623）", () => {
  assert.deepEqual(keep([med("中成药", "丹皮酚软膏", "左手背湿疹瘙痒、手易脱皮", "外用，涂敷患处"), med("中成药", "七参连湿疹膏", "湿疹皮炎、湿疹", "外用")]), ["丹皮酚软膏"]);
  assert.deepEqual(keep([med("中成药", "木香顺气丸", "胃脘胀闷、嗳气时作"), med("中成药", "平胃丸", "嗳气")]), ["木香顺气丸"]);
  assert.deepEqual(keep([med("中成药", "天麻首乌片", "头痛、眩晕、耳鸣"), med("中成药", "天麻醒脑胶囊", "肝肾不足之头痛头晕、耳鸣")]), ["天麻首乌片"]);
  assert.deepEqual(keep([med("中成药", "胃苏颗粒", "气滞型胃脘胀满、嗳气", "开水冲服"), med("西药", "铝碳酸镁片", "反酸烧心", ""), med("中成药", "复方陈香胃片", "嗳气")]), ["胃苏颗粒", "铝碳酸镁片"]);
});

await check("2.3 对照：问题不同都留；各管一块的（失眠心悸＋心悸胸痹）不是被包含，也留；内服与外用同一问题各留一个", () => {
  assert.deepEqual(keep([med("中成药", "归脾丸", "失眠、心悸"), med("中成药", "木香顺气丸", "嗳气")]), ["归脾丸", "木香顺气丸"]);
  assert.deepEqual(keep([med("中成药", "归脾丸", "失眠、心悸"), med("中成药", "诺迪康胶囊", "心悸、胸痹")]), ["归脾丸", "诺迪康胶囊"]);
  assert.deepEqual(keep([med("中成药", "云南白药气雾剂", "瘀血腰痛", "外用，喷于伤患处"), med("中成药", "七生力片", "瘀血腰痛、乏力")]), ["云南白药气雾剂", "七生力片"]);
  assert.deepEqual(keep([med("中成药", "润肺膏", "久咳痰嗽", "开水冲服"), med("中成药", "云南白药膏", "跌打损伤", "贴患处")]), ["润肺膏", "云南白药膏"], "润肺膏是内服的膏滋，按用法判不是外用");
});

await check("2.4 给药途径：贴患处、外用喷于患处按外用；开水冲服的膏滋、栓剂（全身吸收）按全身；滴眼液按五官", () => {
  assert.equal(dup.medicineRouteGroup("云南白药膏", "贴患处"), "skin");
  assert.equal(dup.medicineRouteGroup("乳香风湿气雾剂", "外用，喷于患处"), "skin");
  assert.equal(dup.medicineRouteGroup("润肺膏", "开水冲服"), "systemic");
  assert.equal(dup.medicineRouteGroup("双氯芬酸钠栓", ""), "systemic");
  assert.equal(dup.medicineRouteGroup("玻璃酸钠滴眼液", ""), "sensory");
});

// ── 3 药理学分类表 ─────────────────────────────────────────────────────────
await check("3.1 分类表带来源与指纹；按全名、再按削尾巴的通用名查；口服的药不拿眼科、皮肤科的行去比", () => {
  const table = JSON.parse(fs.readFileSync("src/data/western-drug-pharmacology-class.json", "utf8"));
  assert.equal(table.schemaVersion, "western-drug-pharmacology-class-v1");
  assert.match(table.source.sha256, /^[0-9a-f]{64}$/);
  assert.match(table.source.file, /药理学分类/);
  assert.ok(table.classes.length > 300 && Object.keys(table.byProduct).length > 3000);
  assert.ok(table.classes.every((entry) => entry.split(">").length >= 3 && !entry.startsWith("其他")), "不收一级分类为「其他」的兜底行");
  // 削尾巴：表里没有「氨氯地平片」，有「氨氯地平」通用名
  assert.equal(keep([med("西药", "氨氯地平片", "高血压", ""), med("西药", "苯磺酸氨氯地平片", "高血压", "")]).length, 1, "同药不同写法按通用名归一");
  // 口服的塞来昔布与口服的布洛芬：同在抗炎和抗风湿药；塞来昔布另挂着眼科行，不与别的药在眼科行上“共享”
  assert.deepEqual(keep([med("西药", "塞来昔布胶囊", "腰痛", ""), med("西药", "氯雷他定片", "腰痛", "")]), ["塞来昔布胶囊", "氯雷他定片"]);
});

// ── 4 方向底线 ─────────────────────────────────────────────────────────────
const direction = (name, names2, method, { type = "中成药", route = "口服" } = {}) =>
  dup.patentMedicineOpposesSignedDirection({ type, name, route }, { names: names2, method });

await check("4.1 补益药配纯实证（宁心益智胶囊配肝阳上亢，MTCMB-3）不列；对照：同药配心脾两虚、补攻并用的绞股蓝总甙片、治法带润补的配实证都不动", () => {
  assert.equal(direction("宁心益智胶囊", "肝阳上亢证", "平肝潜阳，清火息风，止晕"), "tonic_for_excess");
  assert.equal(direction("宁心益智胶囊", "心脾两虚证", "补益心脾，宁心安神"), undefined);
  assert.equal(direction("绞股蓝总甙片", "肝阳上亢证", "平肝潜阳，清火息风，止晕"), undefined, "养心健脾与除痰化瘀并用，不是纯补");
  assert.equal(direction("铁皮枫斗胶囊", "风燥伤肺证", "疏风清肺，润燥止咳"), undefined, "治法带润燥，养阴药不算相反");
  assert.equal(direction("七味通痹口服液", "痰瘀痹阻证", "化痰祛瘀，蠲痹通络"), undefined, "补肾壮骨与祛风蠲痹并用");
});

await check("4.2 攻邪药配纯虚证（木香顺气丸、平胃丸配气阴亏虚证，SD-447858）不列；对照：配寒湿证、成份里有补虚药的参苓口服液不动", () => {
  assert.equal(direction("木香顺气丸", "气阴亏虚证", "益气健脾，生津止渴"), "attack_for_deficiency");
  assert.equal(direction("平胃丸", "气阴亏虚证", "益气健脾，生津止渴"), "attack_for_deficiency");
  assert.equal(direction("平胃丸", "寒湿阻遏证", "温中化湿，健脾和胃"), undefined);
  assert.equal(direction("参苓口服液", "脾胃气虚证", "健脾益气，佐以助运"), undefined, "理脾消食，成份有太子参、白扁豆：不是纯攻");
});

await check("4.3 寒热：成份分类判寒的疗癣卡西甫散配风寒湿痹不列；温热的四神丸配下焦湿热不列；对照：配湿热证、解表散风的荆防败毒丸配风寒表证不动", () => {
  assert.equal(direction("疗癣卡西甫散", "风寒湿痹证", "祛风除湿，散寒通络"), "cold_for_cold_case");
  assert.equal(direction("疗癣卡西甫散", "湿热蕴肤证", "清热利湿，祛风止痒"), undefined);
  assert.equal(direction("四神丸", "劳淋，下焦湿热证", "补脾益肾，通淋止痛，清热利湿通淋"), "warm_for_heat_case");
  assert.equal(direction("四神丸", "脾肾阳虚证", "温补脾肾，涩肠止泻"), undefined);
  assert.equal(direction("荆防败毒丸", "风寒束表证", "辛温解表，宣肺散寒，止咳化痰"), undefined);
});

await check("4.4 外用药、西药、查不到说明书与成份的药、证名寒热并见或虚实夹杂的一律弃权", () => {
  assert.equal(direction("七参连湿疹膏", "气不摄血证", "补气摄血，养血止血", { route: "外用" }), undefined, "外用治局部");
  assert.equal(direction("宁心益智胶囊", "肝阳上亢证", "平肝潜阳，清火息风，止晕", { type: "西药" }), undefined);
  assert.equal(direction("某某不存在的药", "肝阳上亢证", "平肝潜阳，清火息风，止晕"), undefined);
  assert.equal(direction("宁心益智胶囊", "阴虚火旺证", "滋阴降火"), undefined, "虚实夹杂");
  assert.equal(direction("疗癣卡西甫散", "寒热错杂证", "辛开苦降"), undefined, "寒热并见");
  assert.equal(dup.signedDirectionOf(undefined), undefined);
  assert.deepEqual(dup.signedDirectionOf({ overview: { primarySyndrome: "肝阳上亢证", secondarySyndromes: ["血瘀证"] }, therapy: { overallMethod: "平肝潜阳" } }), { names: "肝阳上亢证，血瘀证", method: "平肝潜阳" });
});

// ── 5 现用药 ───────────────────────────────────────────────────────────────
const mtcmb35 = types.normalizeCaseStateInput({
  id: "r1021-mtcmb35", chiefComplaint: "胸闷、心慌", patient: { sex: "男", age: 76 }, conversation: [],
  symptoms: { 现病史: "患者于4月前出现胸闷、心慌，伴胸痛，诊断为“冠状动脉粥样硬化性心脏病”，给与阿司匹林、依姆多、倍他乐克缓释片、可定、参松养心胶囊、丹参滴丸治疗，仍有胸闷心慌发作" },
});

await check("5.1 现用丹参滴丸（说明书与方剂目录都没有组成，只知药名），推荐丹参保心茶不再列（MTCMB-35）；参芍片、没有现用药的病例不受影响", () => {
  const self = dup.selfTakenMedicationCompositions(mtcmb35);
  assert.ok(self.some((item) => item.name === "丹参滴丸" && item.namesake?.includes("丹参")), JSON.stringify(self.map((item) => item.name)));
  assert.equal(dup.patentMedicineDuplication(med("中成药", "丹参保心茶", "血瘀、胸痹"), [], self)?.reason, "self_medication");
  assert.equal(dup.patentMedicineDuplication(med("中成药", "复方丹参滴丸", "胸痹"), [], self)?.selfMedication, "丹参滴丸");
  assert.equal(dup.patentMedicineDuplication(med("中成药", "参芍片", "气虚血瘀之胸闷胸痛心悸"), [], self), undefined, "参松养心胶囊的组成与参芍片没有共同药味");
  assert.equal(dup.patentMedicineDuplication(med("中成药", "丹参保心茶", "血瘀、胸痹"), [], dup.selfTakenMedicationCompositions(types.normalizeCaseStateInput({
    id: "r1021-none", chiefComplaint: "胸闷", patient: { sex: "男", age: 60 }, conversation: [], symptoms: { 现病史: "胸闷两周，无胸痛。" },
  }))), undefined, "病历没写现用药时不动");
});

await check("5.2 有说明书组成的现用中成药：共有两味以上才算（参松养心胶囊与含人参、丹参、麦冬的成药）", () => {
  const self = dup.selfTakenMedicationCompositions(mtcmb35).filter((item) => item.name === "参松养心胶囊");
  assert.ok(self[0]?.identities.length >= 5);
  // 生脉饮类（人参、麦冬、五味子）与参松养心胶囊共有人参、麦冬
  const shared = self[0].identities.filter((herb) => dup.patentMedicineCompositionIdentities("生脉饮").includes(herb));
  assert.equal(Boolean(dup.patentMedicineDuplication(med("中成药", "生脉饮", "心悸气短"), [], self)), shared.length >= 2);
});

// ── 6 规划器 ───────────────────────────────────────────────────────────────
const captured = [];
let stubReply = { localEvidenceIds: [], westernMedicines: [] };
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  captured.push(JSON.parse(body));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(stubReply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "stub-key-never-log", BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  BAILIAN_QWEN_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, CDSS_TEXT_MODEL_ALLOWED_HOSTS: "127.0.0.1",
});
const planner = await jiti.import("../src/lib/medicine-candidate-planner.server.ts");
const plannerState = (syndrome, method, complaint, history) => ({
  id: "r1021-planner", phase: "prescribe", patient: { sex: "男", age: 62 }, chiefComplaint: complaint, symptoms: { presentHistory: history }, conversation: [],
  reasoningDiagnose: {
    overview: { tcmDiseaseName: "不寐", primarySyndrome: syndrome, primarySyndromeBasis: ["失眠", "多梦"], overallPathogenesis: "肝阳偏亢，扰动心神" },
    therapy: { overallMethod: method },
    westernDiagnosis: { primary: { name: "失眠障碍", supportingFacts: ["多梦"] } },
  },
});

try {
  await check("6.1 规划模型的病例事实最前面是已签名辨证（病名、证候、治法、病机）；提示词写明三点核对和「同一问题同一途径只选一个」", async () => {
    const state = plannerState("肝阳上亢证", "平肝潜阳，清火息风，安神", "失眠多梦伴心悸半年", "失眠、多梦、心悸，头晕耳鸣，急躁易怒");
    stubReply = { localEvidenceIds: [], westernMedicines: [] };
    captured.length = 0;
    await planner.planEvidenceBoundMedicineCandidates(state);
    const request = captured.at(-1);
    const system = request.messages[0].content, user = request.messages[1].content;
    assert.match(user, /^本例已定中医辨证（医生已签名）：中医病名：不寐；证候：肝阳上亢证；治法：平肝潜阳，清火息风，安神；病机：肝阳偏亢，扰动心神。/u);
    assert.match(system, /本例已定中医辨证/u);
    assert.match(system, /说明书所述证型.{0,40}只是症状词相同而证型不同的不选/u);
    assert.match(system, /温补药不用于实热，滋阴药不用于湿浊、痰湿或气虚阳虚/u);
    assert.match(system, /同一个对应问题、同一种给药途径只选一个药/u);
    assert.match(system, /药理类别相同的西药.*只提一个/u);
    assert.match(system, /成分或功效相同的同类药.*也不再选/u);
    // 对照：没有已签名辨证的病例不写这一行
    const bare = { ...state, reasoningDiagnose: undefined };
    captured.length = 0;
    await planner.planEvidenceBoundMedicineCandidates(bare);
    assert.doesNotMatch(captured.at(-1)?.messages[1].content ?? "", /本例已定中医辨证/u);
  });

  await check("6.2 方向与已签名证候明确相反的内服中成药在检索层就被拿掉（规划模型、M04 证据清单看到的是同一份）；对照：方向相合的病例里补益类药照常给", async () => {
    const compatible = plannerState("心脾两虚证", "补益心脾，养血安神", "失眠多梦伴心悸半年", "失眠、多梦、心悸、健忘，乏力纳差");
    const opposed = plannerState("肝阳上亢证", "平肝潜阳，清火息风，安神", "失眠多梦伴心悸半年", "失眠、多梦、心悸、健忘，乏力纳差");
    const isFlagged = (state, item) => Boolean(dup.patentMedicineOpposesSignedDirection(
      { type: "中成药", name: item.name, route: "口服" }, dup.signedDirectionOf(state.reasoningDiagnose)));
    // 没有已签名辨证时检索不受方向底线影响：同一病历的未过滤名单，用来确认「被拿掉的」确实是方向相反的那批
    const unfiltered = loc.retrieveLocalPatentMedicineCandidates({ ...opposed, reasoningDiagnose: undefined }, 60);
    const wouldBeFlagged = unfiltered.filter((item) => isFlagged(opposed, item));
    assert.ok(wouldBeFlagged.length >= 3, `夹具应有被判相反的候选：${unfiltered.slice(0, 10).map((item) => item.name).join("、")}`);
    const pool = loc.retrieveLocalPatentMedicineCandidates(opposed, 10);
    assert.ok(pool.length > 0 && pool.every((item) => !isFlagged(opposed, item)), `检索名单里不应再有方向相反的药：${pool.map((item) => item.name).join("、")}`);
    // 规划模型看到的就是这份名单
    stubReply = { localEvidenceIds: [], westernMedicines: [] };
    captured.length = 0;
    await planner.planEvidenceBoundMedicineCandidates(opposed);
    const catalog = captured.at(-1).messages[1].content;
    for (const item of pool) assert.ok(catalog.includes(`"evidenceId":"${item.id}","name":"${item.name}"`), `${item.name} 保留检索编号 ${item.id}`);
    for (const item of wouldBeFlagged) assert.ok(!catalog.includes(`"name":"${item.name}"`), `${item.name} 不应交给规划模型`);
    // 对照：方向相合的病例，补益类药一个不少
    const compatiblePool = loc.retrieveLocalPatentMedicineCandidates(compatible, 10);
    assert.ok(compatiblePool.length > 0 && compatiblePool.every((item) => !isFlagged(compatible, item)));
    assert.ok(compatiblePool.some((item) => isFlagged(opposed, item)), "同一批补益药放到肝阳上亢的病例里会被判相反（对照有意义）");
    captured.length = 0;
    await planner.planEvidenceBoundMedicineCandidates(compatible);
    for (const item of compatiblePool) assert.ok(captured.at(-1).messages[1].content.includes(`"name":"${item.name}"`), `${item.name} 应在候选里`);
  });

  await check("6.3 规划模型选了同一问题、同一途径的两个中成药时只留排在前面的；对照：问题不同的两个都留", async () => {
    // 规划结果按（病例文本、候选）缓存：病程字样不同，免得拿到 6.2 里同一病例缓存下来的空选择。
    const same = plannerState("心脾两虚证", "补益心脾，养血安神", "失眠多梦伴心悸三个月", "失眠、多梦、心悸、健忘，乏力纳差");
    const pool = loc.retrieveLocalPatentMedicineCandidates(same, 10);
    const asRow = (item) => ({ name: item.name, correspondingProblem: item.matchedConcepts.join("、"), route: "口服" });
    const [first, second] = pool;
    assert.ok(dup.medicineProblemsOverlap(asRow(first), asRow(second)));
    stubReply = { localEvidenceIds: [first.id, second.id], westernMedicines: [] };
    const merged = await planner.planEvidenceBoundMedicineCandidates(same);
    assert.deepEqual(merged.candidates.map((item) => item.name), [first.name], "同一问题只留排在前面的");
    // 对照：模型把顺序反过来列，留下的是它排在前面的；只选一个的不受影响（问题不同的两个都留，见 2.3 的单元断言：规划候选里同批检索的药问题概念几乎总是重合）
    stubReply = { localEvidenceIds: [second.id, first.id], westernMedicines: [] };
    const reversed = await planner.planEvidenceBoundMedicineCandidates({ ...same, chiefComplaint: "失眠多梦伴心悸四个月" });
    assert.deepEqual(reversed.candidates.map((item) => item.name), [second.name]);
    stubReply = { localEvidenceIds: [first.id], westernMedicines: [] };
    const single = await planner.planEvidenceBoundMedicineCandidates({ ...same, chiefComplaint: "失眠多梦伴心悸五个月" });
    assert.deepEqual(single.candidates.map((item) => item.name), [first.name]);
  });
} finally {
  server.close();
}

// ── 7 编译器接线（源码级） ─────────────────────────────────────────────────
await check("7.1 编译器：现用药重复 → 方向底线 → 解热镇痛 → 同名 → 同类，依次过；规划器与编译器共用同一组函数", () => {
  const compiler = fs.readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.match(compiler, /withoutSameClassMedicines\(withoutRepeatedMedicineNames\(withoutSameClassAnalgesics\(proposal\.patentAndWestern\s*\.filter\(\(item\) => !patentMedicineDuplication\(item, duplicationHerbs, selfMedications\)\)\s*\.filter\(\(item\) => !patentMedicineOpposesSignedDirection\(item, signedDirection\)\)\)\)\)/u);
  // 第二十四轮：在这一串之前先过「说明书说到本例主要问题」（patentMedicineCoversMainProblem），对证的排前。
  assert.match(compiler, /patentMedicineCoversMainProblem\(labelIndication\(item\), mainProblem\) !== false\);[\s\S]{0,400}proposal\.patentAndWestern = \[\.\.\.coveredMedicines\.filter\(syndromeMatched\)/u);
  assert.match(compiler, /const signedDirection = signedDirectionOf\(prior\)/u);
  const plannerSource = fs.readFileSync("src/lib/medicine-candidate-planner.server.ts", "utf8");
  assert.match(plannerSource, /patentMedicineDuplication\(item\.candidate, \[\], selfMedications\)/u);
  assert.match(plannerSource, /patentMedicineOpposesSignedDirection\(item\.candidate, signedDirection\)/u);
  const candidatesSource = fs.readFileSync("src/lib/local-patent-medicine-candidates.ts", "utf8");
  assert.match(candidatesSource, /patentMedicineDirectionConflict\(\{\s*clause: medicineFunctionClause\(entry\.indication\),\s*herbs: \(\) => patentMedicineCompositionIdentities\(entry\.name\),\s*indication: entry\.indication,\s*\}, signedDirection\)/u, "检索层第六道（10/24 起带适应证全文，见 test:r1030-main 5.1）");
  assert.match(fs.readFileSync("src/lib/delivered-surface.ts", "utf8"), /TOPICAL_MEDICATION_FORM \} from "\.\/local-patent-medicine-candidates"/u, "外用剂型词表只有一份");
  assert.match(plannerSource, /withoutSameClassMedicines\(screened\.map/u);
  assert.match(plannerSource, /PLANNER_PROMPT_VERSION = "2026-10-19-signed-direction-class-dedupe-v4"/u, "提示词改了，缓存键里的版本必须变");
  assert.match(plannerSource, /signedDiagnosisText\(caseState\), localCandidates\.map/u, "已签名辨证进缓存键");
});

await check("7.2 M04 提示词的 patentAndWestern 规则与规划器同口径：证型一致、寒热虚实不相反、病邪有记载、同问题同途径只列一个、不再列现用药的同类", () => {
  const prompts = fs.readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  const rule = prompts.split("\n").find((line) => line.includes("patentAndWestern 只能从证据上下文中")) ?? "";
  assert.match(rule, /说明书所述证型.{0,30}只是症状词相同而证型不同的不选/u);
  assert.match(rule, /温补药不用于实热，滋阴药不用于湿浊、痰湿或气虚阳虚/u);
  assert.match(rule, /同一个对应问题、同一种给药途径只列一个药，西药同一药理类别也只列一个/u);
  assert.match(rule, /成分或功效相同的同类药也不再列/u);
  assert.match(rule, /没有合格条目时输出空数组/u, "原有的空数组规则不得丢");
});

// ── 8 交付面：推荐栏与注意事项 ─────────────────────────────────────────────
const prescribePage = (precautions, meds) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "半夏泻心汤", herbs: [{ name: "半夏" }, { name: "黄连" }] }], patentAndWestern: meds, modifications: [] },
  nonPharma: { precautions, tcmTreatments: [] }, management: {},
});
const project = (precautions, meds) => surf.projectDeliveredReasoning(prescribePage(precautions, meds));

await check("8.1 注意事项叫患者别再服「其他治疗胃脘胀满的中成药」，同页的胃苏颗粒（治胃脘胀满）不再推荐；注意事项照留，西药不动（RobustSDT-0623）", () => {
  const out = project(["服本方期间不要再服其他治疗胃脘胀满的中成药，以免功效重复。"], [
    med("中成药", "胃苏颗粒", "气滞型胃脘胀满、嗳气", "开水冲服", { positioning: "联合治疗" }),
    med("西药", "铝碳酸镁片", "反酸烧心", ""),
  ]);
  assert.deepEqual(names(out.formula.patentAndWestern), ["铝碳酸镁片"]);
  assert.ok(out.nonPharma.precautions.some((line) => /不要再服其他治疗胃脘胀满的中成药/.test(line)), "注意事项那一条照留");
});

await check("8.2 对照：患者自行另加（「不要自行加用…」）说的是患者自己，不与医生评估的备选矛盾；定位为替代方案的、治别的问题的都不动", () => {
  const line = "服本方期间不要自行加用其他治疗胃脘胀满的中成药，以免功效重复。";
  assert.deepEqual(names(project([line], [med("中成药", "胃苏颗粒", "气滞型胃脘胀满、嗳气", "开水冲服", { positioning: "联合治疗" })]).formula.patentAndWestern), ["胃苏颗粒"]);
  const strict = "服本方期间不要再服其他治疗胃脘胀满的中成药，以免功效重复。";
  assert.deepEqual(names(project([strict], [med("中成药", "胃苏颗粒", "气滞型胃脘胀满、嗳气", "开水冲服", { positioning: "替代方案" })]).formula.patentAndWestern), ["胃苏颗粒"]);
  assert.deepEqual(names(project([strict], [med("中成药", "归脾丸", "失眠、心悸")]).formula.patentAndWestern), ["归脾丸"]);
});

console.log(JSON.stringify({ suite: "r1021-medicines", cases, failures: process.exitCode ? 1 : 0 }));

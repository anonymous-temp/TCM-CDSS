// 10/19 第六轮·注意事项（2026-10-19）：第五轮（718e1ea）终测 Claude 评审在注意事项上又找到的两类。
//
// 每条断言都带对照，并跑过反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 6/precautions/）。
//
//   1 哺乳提示两条并存且说法不一（甲方病历 3）：补规则句时把模型写的哺乳用药那句换掉；给模型的清单不再用「患者一年内分娩、哺乳情况未记录：」
//     这种会被照抄成第三人称的标题；交付面把照抄清单写成的「病历记录患者已自服」「患者一年内分娩」「患者68岁」改成对患者说的话
//   2 注意事项凭空点名病历与推荐药里都没有的成药（留出例 S145「不要再服连翘败毒丸」）：「X等同类…中成药」只去掉举例的药名，
//     其余去掉那一小句（连同它的「以免…」），整条只剩它时整条去掉
import assert from "node:assert/strict";
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

const types = await jiti.import("../src/lib/diagnosis-types.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const labels = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");

const stateOf = (presentHistory, extra = {}) => types.normalizeCaseStateInput({
  id: "r6p", chiefComplaint: "x", patient: { sex: "女", age: 32 }, symptoms: { presentHistory }, conversation: [], ...extra,
});
const rx = (lines, herbs = ["陈皮"], patentAndWestern = []) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
  formula: { candidates: [{ name: "x", formulaAnalysis: "x", herbs: herbs.map((name) => ({ name, role: "臣", function: "x", dose: "10g" })), decoction: { method: "水煎服，分2次饭后温服" } }], patentAndWestern },
  nonPharma: { precautions: lines, diet: "", acupointCare: null, tcmTreatments: [] },
});
const project = (reasoning, options) => surface.projectDeliveredReasoning(reasoning, options).nonPharma.precautions;

// ───── 1 哺乳提示 ─────
const HERBS_3 = ["熟地黄", "白芍", "当归", "川芎", "党参", "白术"];
await check("1.1 补哺乳规则句时，模型写的哺乳用药那句换掉，不并存（甲方病历 3：「方中当归等哺乳期用药请先咨询医生」与「方中川芎哺乳期须慎用」同页）；同时说妊娠的、哺乳护理的照留（对照）", () => {
  const model = "患者一年内分娩，如正在哺乳请先告知医生，方中当归等哺乳期用药请先咨询医生。";
  const out = project(rx([model, "本方宜温服。"], HERBS_3), { requiredPrecautions: [{ kind: "postpartum_lactation" }] });
  assert.deepEqual(out, ["产后如正在哺乳，请服药前告知医生（方中川芎哺乳期须慎用），由医生评估后再服。", "本方宜温服。"]);
  const kept = ["如已怀孕、可能怀孕或正在哺乳，须在服药前告知医生。", "保持排乳通畅，哺乳前后清洁乳头。"];
  const withKept = project(rx([model, ...kept], HERBS_3), { requiredPrecautions: [{ kind: "postpartum_lactation" }] });
  assert.deepEqual(withKept.slice(1), kept);
  // 模型那句按知识库档位点到了：不补规则句，模型那句照留。
  const right = "产后如正在哺乳，请先告知医生，方中川芎哺乳期慎用。";
  assert.deepEqual(project(rx([right], HERBS_3), { requiredPrecautions: [{ kind: "postpartum_lactation" }] }), [right]);
});

await check("1.2 给模型的清单不再用「患者一年内分娩、哺乳情况未记录：」「病历记录患者已自服」这类会被照抄的第三人称，开头写明对患者说话；药名与要写的内容照列（对照）", () => {
  const lactation = precautions.requiredPrecautionsPromptSection([{ kind: "postpartum_lactation" }]);
  assert.doesNotMatch(lactation, /患者一年内分娩|未记录：/u);
  assert.match(lactation, /产后如正在哺乳，请服药前告知医生/u);
  assert.match(lactation, /不要照抄/u);
  const self = precautions.requiredPrecautionsPromptSection([{ kind: "self_medication", name: "黄连上清丸", base: "黄连上清", composition: ["黄连", "大黄"], alcoholWarning: false }]);
  assert.doesNotMatch(self, /病历记录患者已自服/u);
  assert.match(self, /黄连上清丸[\s\S]*黄连、大黄/u);
});

await check("1.3 交付面把照抄清单的第三人称开头改成对患者说的话（外用药说「外用」）；规则句「病历记录用过的…」与别的「患者…」照旧（对照）", () => {
  const out = project(rx([
    "病历记录患者已自服板蓝根颗粒，服本方期间是否继续服用由医生决定。",
    "病历记录已自服麝香通心滴丸，服本方期间是否继续服用由医生决定。",
    "病历记录患者已自服青鹏软膏，服本方期间是否继续外用由医生决定。",
    "患者一年内分娩，如正在哺乳请先告知医生。",
    "患者68岁，服药期间起身宜缓，防跌倒。",
    "病历记录用过的替米沙坦，请告知医生现在是否还在用。",
    "患者如出现心慌，请及时就医。",
  ]));
  assert.deepEqual(out, [
    "您已自服板蓝根颗粒，服本方期间是否继续服用由医生决定。",
    "您已自服麝香通心滴丸，服本方期间是否继续服用由医生决定。",
    "您已外用青鹏软膏，服本方期间是否继续外用由医生决定。",
    "产后如正在哺乳请先告知医生。",
    "您68岁，服药期间起身宜缓，防跌倒。",
    "病历记录用过的替米沙坦，请告知医生现在是否还在用。",
    "患者如出现心慌，请及时就医。",
  ]);
});

// ───── 2 凭空点名的成药 ─────
await check("2.1 说明书目录认得的带剂型药名：「连翘败毒丸」「三黄丸、清宁丸」「盐酸二甲双胍片」认出；「药液」「当归」「发散风寒」「饮冷」不算药名（对照）", () => {
  assert.deepEqual(labels.labelledMedicineNamesIn("服本方期间不要再服连翘败毒丸，以免清热药重复叠加。"), ["连翘败毒丸"]);
  assert.deepEqual(labels.labelledMedicineNamesIn("不要再服三黄丸、清宁丸等同类泻火通便中成药。"), ["三黄丸", "清宁丸"]);
  assert.deepEqual(labels.labelledMedicineNamesIn("正在服用的盐酸二甲双胍片请告知医生"), ["盐酸二甲双胍片"]);
  assert.deepEqual(labels.labelledMedicineNamesIn("方中当归养血，煎取药液约400mL；宜发散风寒，忌饮冷。"), []);
});

await check("2.2 病历里有的药名列入核对清单（自服的黄连上清丸、甲硝唑片）；病历没写药的不出这一项、也不进给模型的清单（对照）", () => {
  const tooth = precautions.requiredPrecautionsForCase(stateOf("三天前右下牙胀痛，自服“黄连上清丸”及“甲硝唑片”后疼痛略有缓解。"), null);
  const names = tooth.find((item) => item.kind === "recorded_drug_names")?.names || [];
  assert.ok(names.includes("黄连上清丸") && names.includes("甲硝唑片"), JSON.stringify(names));
  assert.ok(!precautions.requiredPrecautionsForCase(stateOf("前日吃山楂后胃脘胀满。"), null).some((item) => item.kind === "recorded_drug_names"));
  assert.equal(precautions.requiredPrecautionsPromptSection([{ kind: "recorded_drug_names", names: ["黄连上清丸"] }]), "");
});

await check("2.3 注意事项点名的成药病历与推荐里都没有：只有它的整条去掉（连同「以免…」，留出例 S145）；「X、Y等同类…中成药」只去掉举例的药名（「同类」没了所指时说成功效相近的）；病历有的、推荐里有的照留；调用方没给本例项目时不核（对照）", () => {
  const recorded = [{ kind: "recorded_drug_names", names: ["黄连上清丸"] }];
  const recommend = [{ type: "中成药", name: "板蓝根颗粒" }];
  const lines = [
    "服本方期间不要再服连翘败毒丸，以免清热药重复叠加。",
    "服本方期间不要再服三黄丸、清宁丸等同类泻火通便中成药。",
    "服本方期间不要再服养心定悸口服液等同类中成药。",
    "方中有人参，服本方期间不要再服健脾五味丸等含人参制剂。",
    "您已自服黄连上清丸，服本方期间请停服黄连上清丸，以免药效重复。",
    "板蓝根颗粒与本方间隔1小时服用。",
    "饮食清淡。",
  ];
  assert.deepEqual(project(rx(lines, ["陈皮", "人参"], recommend), { requiredPrecautions: recorded }), [
    "服本方期间不要再服同类泻火通便中成药。",
    "服本方期间不要再服功效相近的中成药。",
    "方中有人参，服本方期间不要再服含人参制剂。",
    "您已自服黄连上清丸，服本方期间请停服黄连上清丸，以免药效重复。",
    "板蓝根颗粒与本方间隔1小时服用。",
    "饮食清淡。",
  ]);
  // 同一条里还有别的话：只去掉点名那一小句与它的「以免…」。
  assert.deepEqual(project(rx(["饭后温服，不要再服连翘败毒丸，以免药力叠加；忌辛辣。"]), { requiredPrecautions: [] }), ["饭后温服，忌辛辣。"]);
  assert.deepEqual(project(rx([lines[0]])), [lines[0]]);
});

console.log(JSON.stringify({ suite: "r1019-round6-precautions", cases, failures: process.exitCode ? "see above" : 0 }));

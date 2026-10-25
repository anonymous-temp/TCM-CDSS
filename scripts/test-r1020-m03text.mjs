// 第八轮 WP-B（2026-10-19 晚）：M03 交付文字与患者陈述核对。第七轮评审在 X 集 / 留出集里报的服务端缺陷。
//
// 每条断言都带反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 8/m03text）。
//
//   1 脉象净化改坏脉管构词（留出 S079「肉桂温通经脉散寒」→「经脉象待核实寒」，与 10/13「生脉散」同类）：
//     「脉」前是脉管/奇经/方名构词时，后面碰巧跟着的脉名字（散/实/虚/紧…）不是脉象；真脉象断言（脉浮紧、肝脉弦、失血脉微欲绝）照改
//   2 辨病依据残句：
//     2a 鉴别句「痫证发作无发热，与本例持续高热不符」（X-C-0055）——对照小句以「与/同/较/不同于」+「本例」起头时同样说的是鉴别对象
//     2b 删掉鉴别分句后留下的「故与二者相区分」（X-C-0159）——回指的内容已被删，连尾句一起删
//   3 中医病名栏是西医病名（X-C-0606/0335「血栓闭塞性脉管炎」应为「脱疽」）：教材节名是西医病名而教材在该节定义里写明「属中医学“X”范畴」
//   4 患者陈述核对漏掉「病历已有的主词 + 病历没有的限定」（X-C-0426 黄色鲜明、0533 皮色不变、0372 痛有定处、0294 壮热/肿势绕喉）：
//     服务端的解析与删除不是拦路点（用这四例的原文字段证明）；提示词补了限定词一类的说明（措辞待主控实测）

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "false",
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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const clinicalState = await jiti.import("../src/lib/clinical-state.ts");
const terminology = await jiti.import("../src/lib/clinical-terminology.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const claim = await jiti.import("../src/lib/m03-patient-claim-check.server.ts");

const stateOf = (record, extra = {}) => types.normalizeCaseStateInput({
  id: "r1020", chiefComplaint: record.slice(0, 30), symptoms: { presentHistory: record }, conversation: [], patient: {}, ...extra,
});
const sanitize = (text, record) => safety.sanitizeUngroundedRedFlagNegations(text, stateOf(record));

// ───── 1 脉管构词不是脉象 ─────
const NO_PULSE_RECORD = "腰痛两周，无其他不适。";
await check("1.1 未录脉象时，脉管/奇经/方名构词后碰巧跟着脉名字的写法原样保留（S079 方义原句、血脉实、筋脉紧急、冲任脉虚、阳跷脉虚、通脉散）", () => {
  const sentence = "桂枝汤以桂枝解肌，茯苓渗湿、苦杏仁宣肺散风、黄芩清解郁热并制辛温之燥、肉桂温通经脉散寒，共为佐；甘草为使调和诸药。";
  assert.equal(sanitize(sentence, NO_PULSE_RECORD), sentence);
  for (const text of ["血脉实而痛。", "筋脉紧急，屈伸不利。", "冲任脉虚，经血非时。", "阳跷脉虚，夜卧寐躁。", "验方新编通脉散。", "生脉散益气养阴。", "主动脉结增宽。", "静脉曲张，下肢沉重。"]) {
    assert.equal(sanitize(text, NO_PULSE_RECORD), text, text);
  }
});

await check("1.2 对照：真脉象断言照改（脉浮紧、脉弦细、六脉沉细无力、肝脉弦、失血脉微欲绝、吐血脉数）；病历写了脉象时原样不动", () => {
  assert.equal(sanitize("恶寒无汗，脉浮紧。", NO_PULSE_RECORD), "恶寒无汗，脉象待核实。");
  assert.equal(sanitize("舌红，脉弦细。", NO_PULSE_RECORD), "舌象待核实，脉象待核实。");
  assert.equal(sanitize("六脉沉细无力。", NO_PULSE_RECORD), "六脉象待核实。");
  assert.equal(sanitize("肝脉弦，心脉洪。", NO_PULSE_RECORD), "肝脉象待核实，心脉象待核实。");
  assert.equal(sanitize("失血脉微欲绝，汗出肢冷。", NO_PULSE_RECORD), "失血脉象待核实，汗出肢冷。");
  assert.equal(sanitize("吐血脉数，面色苍白。", NO_PULSE_RECORD), "吐血脉象待核实，面色苍白。");
  assert.equal(sanitize("恶寒无汗，脉浮紧。", "恶寒无汗，舌淡红，脉浮紧。"), "恶寒无汗，脉浮紧。");
  assert.equal(sanitize("诊脉弦数与否待查。", NO_PULSE_RECORD), "诊脉弦数与否待查。");
});

await check("1.3 识别面同一个守卫：「筋脉紧急」「经脉虚弱」不算记录了脉象；「脉弦细」「左手脉象弦硬」算", () => {
  assert.equal(clinicalState.isUnknownClinicalFieldText("筋脉紧急，屈伸不利", "pulse"), true);
  assert.equal(clinicalState.isUnknownClinicalFieldText("经脉虚弱", "pulse"), true);
  assert.equal(clinicalState.isUnknownClinicalFieldText("脉弦细", "pulse"), false);
  assert.equal(clinicalState.isUnknownClinicalFieldText("左手脉象弦硬", "pulse"), false);
  assert.equal(clinicalState.isUnknownClinicalFieldText("脉浮", "pulse"), false);
  assert.equal(new RegExp(`${clinicalState.PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}脉实`).test("血脉实"), false);
  assert.equal(new RegExp(`${clinicalState.PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}脉实`).test("失血脉实"), true, "出血词后的血不按脉管构词");
  assert.equal(new RegExp(`${clinicalState.PULSE_VESSEL_NOUN_LOOKBEHIND_SOURCE}脉实`).test("诊脉实"), true);
});

// ───── 2a 对照本例的写法 ─────
const FEVER_RECORD = "男孩，3岁。骤发高热，持续3~4天，烦躁,饮食减少,偶有抽风,咽红,舌质偏红,苔薄黄，指纹浮紫。";
await check("2.1 鉴别对象的否认后面接「与本例…」「不同于本例…」「较本例…」「而与本例…」：不按本例的否认改写（X-C-0055）；兄弟句（去掉否认词）同样不动", () => {
  for (const text of [
    "以骤发高热、烦躁、偶有抽风为主症，起病急骤，归急惊风；痫证发作无发热，与本例持续高热不符。",
    "痫证发作无发热，不同于本例持续高热。",
    "痫证发作无发热，较本例持续高热明显不同。",
    "痫证发作无发热，同本例持续高热不符。",
    "痫证发作无发热，本例持续高热不符。",
    "痫证发作无发热，而与本例持续高热不符。",
  ]) {
    assert.doesNotMatch(sanitize(text, FEVER_RECORD), /病历已记录|有发热/u, text);
    assert.match(sanitize(text, FEVER_RECORD), /痫证发作无发热/u, text);
  }
  assert.equal(sanitize("痫证发作体温正常，与本例持续高热不符。", FEVER_RECORD), "痫证发作体温正常，与本例持续高热不符。");
});

await check("2.2 对照：本例自己的否认、后面不接对照本例的否认，与病历矛盾时照样改正（第二十轮起改正方式是删掉，连同只回指它的结论尾句）", () => {
  assert.equal(sanitize("本例无发热，与本例持续高热不符。", FEVER_RECORD), "");
  assert.equal(sanitize("无发热，故非外感。", FEVER_RECORD), "");
  assert.equal(sanitize("痫证发作无发热，故与二者相区分。", FEVER_RECORD), "", "没有对照本例的小句：保守方向（类夹具 residual）");
  assert.equal(sanitize("患者无发热，与本例持续高热不符。", FEVER_RECORD), "", "以患者起头的否认是本例的断言");
});

// ───── 2b 删掉分句后的回指尾句 ─────
await check("2.3 删掉鉴别分句后只剩「故与二者相区分」时连尾句一起删（X-C-0159）；所指仍在、或删之前就这样写的不动", () => {
  const before = "产后出现小便艰涩而痛，属产后小便淋痛；尿血色鲜红，故与二者相区分。";
  assert.equal(claim.withoutClaimSpan(before, "尿血色鲜红"), "产后出现小便艰涩而痛，属产后小便淋痛。");
  const two = "产后出现小便艰涩而痛、余沥不尽，属产后小便淋痛；尿血色鲜红；尿浊色白如米泔，故与二者相区分。";
  assert.equal(claim.withoutClaimSpan(claim.withoutClaimSpan(two, "尿血色鲜红"), "尿浊色白如米泔"), "产后出现小便艰涩而痛、余沥不尽，属产后小便淋痛。");
  // 对照：所指仍在（同一单元里还有别的分句）→ 不动
  const kept = "产后出现小便艰涩而痛，属产后小便淋痛；尿血色鲜红，尿浊色白，故与二者相区分。";
  assert.equal(claim.withoutClaimSpan(kept, "尿血色鲜红"), "产后出现小便艰涩而痛，属产后小便淋痛；尿浊色白，故与二者相区分。");
  // 对照：删的是别处的分句，尾句本来就是这样写的 → 不动
  const other = "产后出现小便艰涩而痛，尿色红赤；属产后小便淋痛；故与二者相区分。";
  assert.equal(claim.withoutClaimSpan(other, "尿色红赤"), "产后出现小便艰涩而痛；属产后小便淋痛；故与二者相区分。");
  assert.equal(claim.withoutOrphanedAnaphoricTail("A；故与二者相区分。", "A；故与二者相区分。"), "A；故与二者相区分。");
});

// ───── 3 西医节名 → 中医病名 ─────
const names = (await import("node:fs")).default.readFileSync(`${process.cwd()}/src/data/tcm-textbook-disease-names.json`, "utf8");
const namesJson = JSON.parse(names);
await check("3.1 教材节名是西医病名而教材定义写明「属中医学“X”范畴」：中医病名栏取中医病名（血栓闭塞性脉管炎 → 脱疽，股骨头缺血性坏死 → 骨蚀）；其余教材节名、国标正名原样", () => {
  const ctx = { overview: { primarySyndrome: "" } };
  assert.equal(terminology.canonicalTcmDiseaseName("血栓闭塞性脉管炎", ctx), "脱疽");
  assert.equal(terminology.canonicalTcmDiseaseName("股骨头缺血性坏死", ctx), "骨蚀");
  assert.equal(terminology.canonicalTcmDiseaseName("脱疽", ctx), "脱疽");
  for (const [name, expected] of [["头痛", "头痛"], ["虚劳", "虚劳"], ["流行性腮腺炎", "流行性腮腺炎"], ["注意力缺陷多动障碍", "注意力缺陷多动障碍"], ["胃痛", "胃痛"], ["不孕症", "不孕症"], ["肺炎喘嗽", "肺炎喘嗽"]]) {
    assert.equal(terminology.canonicalTcmDiseaseName(name, ctx), expected, name);
  }
  assert.equal(terminology.textbookSectionDeliveryName("血栓闭塞性脉管炎"), "脱疽");
  assert.equal(terminology.textbookSectionDeliveryName("胃痛"), "胃痛");
});

await check("3.2 映射表来自教材：每条带书名、行号、原句；原句里有引号的中医病名，且该名是国标正名；节名本身不是国标正名", () => {
  const map = namesJson.tcmNameBySectionName;
  assert.deepEqual(Object.keys(map).sort(), ["股骨头缺血性坏死", "血栓闭塞性脉管炎"]);
  for (const [section, tcm] of Object.entries(map)) {
    const basis = namesJson.tcmNameBasis[section];
    assert.ok(basis && basis.book && basis.line > 0, section);
    assert.ok(new RegExp(`中医学?(?:[“"][^”"]{2,8}[”"])*[“"]${tcm}[”"]|[“"]${tcm}[”"]`, "u").test(basis.quote), `${section}: ${basis.quote}`);
    assert.ok(namesJson.names.includes(section), "节名在教材病名表里");
    const resolved = terminology.resolveTcmDiseaseName(tcm);
    assert.equal(resolved.canonical, tcm);
    assert.ok(["standard", "standard_alias"].includes(resolved.status), `${tcm} ${resolved.status}`);
  }
  assert.equal(Object.keys(map).includes("头痛"), false);
});

await check("3.3 教材查表：按中医病名「脱疽」也查得到同一节的证型（别名登记）；按节名照旧；对照：别的病名不串", () => {
  const byTcm = textbook.textbookRowForSyndrome("脱疽", "热毒伤阴证");
  const bySection = textbook.textbookRowForSyndrome("血栓闭塞性脉管炎", "热毒伤阴证");
  assert.ok(byTcm && bySection);
  assert.equal(byTcm.id, bySection.id);
  assert.equal(byTcm.disease, "血栓闭塞性脉管炎");
  assert.equal(byTcm.syndromeName, "热毒伤阴证");
  assert.equal(textbook.textbookRowForSyndrome("脱疽", "湿热下注证"), undefined, "该节没有的证名不借别的病");
  assert.equal(textbook.textbookRowForSyndrome("胃痛", "热毒伤阴证"), undefined);
});

const m03 = (disease, syndrome, method) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], recommendedFormulaDirection: "", tcmDiseaseRationale: `属${disease}范畴。` },
  therapy: { overallPrinciple: "", overallMethod: method },
  pathogenesis: { chain: [], locationDifferentiation: { items: [] } },
});
await check("3.4 教材锚定不把中医病名改回西医节名（脱疽·热毒伤阴证仍是脱疽）；对照：写「头风病」的头痛例仍改回教材节名「头痛」", () => {
  const anchored = provenance.withDeterministicFormulaReferences(m03("脱疽", "热毒伤阴证", "清热解毒，养阴"));
  assert.equal(anchored.overview.tcmDiseaseName, "脱疽");
  assert.equal(anchored.overview.tcmDiseaseRationale, "属脱疽范畴。");
  const sectionNamed = provenance.withDeterministicFormulaReferences(m03("血栓闭塞性脉管炎", "热毒伤阴证", "清热解毒，养阴"));
  assert.equal(sectionNamed.overview.tcmDiseaseName, "脱疽", "模型直接写节名也交付中医病名");
  const head = textbook.textbookRowForSyndrome("头痛", "血虚头痛证");
  assert.ok(head, "教材头痛节有血虚头痛证");
  const renamed = provenance.withDeterministicFormulaReferences(m03("头风病", head.syndromeName, "养血"));
  assert.equal(renamed.overview.tcmDiseaseName, "头痛");
});

await check("3.5 病名级鉴别：西医节名写成中医病名；与当前病名同一个病不构成鉴别；对照：别的教材节名原样", () => {
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("血栓闭塞性脉管炎", "痹证"), { action: "rename", name: "脱疽", from: "血栓闭塞性脉管炎" });
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("血栓闭塞性脉管炎", "脱疽"), { action: "drop", from: "血栓闭塞性脉管炎" });
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("脱疽", "痹证"), { action: "keep", name: "脱疽" });
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("痹证", "头痛"), { action: "keep", name: "痹证" });
  assert.deepEqual(normalization.resolveTcmDiseaseDifferentialName("头痛", "头痛"), { action: "drop", from: "头痛" });
});

// ───── 4 患者陈述核对 ─────
const FIELD_CASES = [
  { key: "X-C-0426", record: "性别：男；年龄：40岁\n患者，男，40岁。一周前发热，食欲减退，四肢乏力。刻下身黄，巩膜黄，小便色如红茶，烦热，恶心，呕吐，不大便三日，腹胀不适，舌红，苔黄腻，脉数。",
    field: "tcmDiagnosticRationale", text: "身黄、巩膜黄、小便色如红茶为湿热交蒸肝胆、胆汁外溢肌肤下注膀胱，黄色鲜明属热重于湿；烦热、舌红、苔黄腻、脉数为湿热内盛之象，诸症合参，证属热重于湿证。", span: "黄色鲜明", keep: "身黄、巩膜黄", echo: "身黄" },
  { key: "X-C-0533", record: "性别：男；年龄：34岁\n患者刘某，男性，34岁。水肿反复消长不已，面浮身肿，腰以下肿甚，按之凹陷不起，腰部冷痛酸重，尿量减少，四肢厥冷，怯寒神疲，面色灰滞，舌质淡胖，苔白，脉沉细。",
    field: "tcmDiseaseRationale", text: "以面浮身肿、腰以下肿甚、按之凹陷不起、尿量减少为主症，水泛肌肤而四肢皮色不变，属水肿；鼓胀以单腹肿胀、青筋暴露为主，本例为全身性浮肿而非单腹胀，故不归鼓胀。", span: "四肢皮色不变", keep: "尿量减少", echo: "身肿" },
  { key: "X-C-0372", record: "性别：男；年龄：60岁\n患者，男，60岁。心前区疼痛多年，每逢秋冬季加重。入冬以来时感心前区刺痛，且放射至左肩背部，经常心悸，胸闷，舌质紫暗，脉沉涩。",
    field: "tcmDiagnosticRationale", text: "心前区刺痛、痛处固定并放射至左肩背部，为瘀血阻滞心脉、不通则痛，故属心血瘀阻；经常心悸、胸闷为心脉瘀阻、心气不畅所致。", span: "痛处固定", keep: "心前区刺痛", echo: "刺痛" },
  { key: "X-C-0294", record: "性别：男；年龄：32岁\n某男，32岁。咽喉疼痛红肿，吞咽困难，咽喉如梗，咽部红肿明显，颌下有臖核,压痛，伴发热，口渴喜饮，头痛剧烈，小便短赤，大便秘结。舌质红，苔黄，脉数有力。",
    field: "tcmDiagnosticRationale", text: "咽喉红肿疼痛、吞咽困难、颌下臖核压痛，为热毒蕴结咽喉、气血壅滞，故病位在咽喉；壮热、口渴喜饮、小便短赤、大便秘结、舌红苔黄、脉数有力，为里热炽盛、痰热内蕴，故病性属痰热实火。", span: "壮热", keep: "口渴喜饮", echo: "口渴" },
];
await check("4.1 这四例的原文字段：模型把「病历主词 + 病历没有的限定」标出来时，服务端收下、删到最小单位、病历原话保住；标成病历原话（身黄、刺痛）不收", () => {
  for (const item of FIELD_CASES) {
    const fields = [{ id: item.field, text: item.text }];
    const removals = claim.parsePatientClaimRemovals(JSON.stringify({ claims: [{ field: item.field, span: item.span }] }), fields, item.record);
    assert.deepEqual(removals, [{ field: item.field, span: item.span }], item.key);
    const root = { overview: { [item.field]: item.text } };
    assert.equal(claim.applyPatientClaimRemovals(root, "tcm", removals), 1, item.key);
    const after = root.overview[item.field];
    assert.ok(!after.includes(item.span), `${item.key}: ${after}`);
    assert.ok(after.includes(item.keep), `${item.key}: ${after}`);
    assert.doesNotMatch(after, /[，、；]{2,}|^[，、；]|[，、]。/u, `${item.key} 无标点残片: ${after}`);
    // 对照：标的是病历原话（两字的短片段，只有「是病历原文的一部分」这一道守卫能拦）
    const echoed = claim.parsePatientClaimRemovals(JSON.stringify({ claims: [{ field: item.field, span: item.echo }] }), fields, item.record);
    assert.deepEqual(echoed, [], `${item.key} 病历原话不收`);
  }
});

const savedFetch = globalThis.fetch;
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
await check("4.2 桩模型整条链：两次核对都标到限定词、复核判「没写到」→ 删；复核判「写到了」→ 不删；核对与复核的提示词带限定词说明（程度、颜色性状、固定与否）", async () => {
  const item = FIELD_CASES[0];
  const content = JSON.stringify({ overview: { tcmDiseaseRationale: "归黄疸。", tcmDiagnosticRationale: item.text } });
  const bodies = [];
  let verdict = "absent";
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.messages[0].content.includes("你是病历核对员")) return completion({ items: [{ id: 0, verdict, quote: "身黄" }] });
      return completion({ claims: [{ field: item.field, span: item.span }] });
    };
    const removals = await claim.decidePatientClaimRemovals(content, { recordText: item.record }, "tcm");
    assert.deepEqual(removals, [{ field: item.field, span: item.span }]);
    const extraction = bodies.find((body) => body.messages[0].content.includes("你是病历事实核对器")).messages[0].content;
    const verification = bodies.find((body) => body.messages[0].content.includes("你是病历核对员")).messages[0].content;
    assert.match(extraction, /限定[\s\S]{0,40}程度[\s\S]{0,200}颜色或性状[\s\S]{0,200}固定与否/u);
    assert.match(verification, /程度[\s\S]{0,60}颜色或性状[\s\S]{0,60}固定与否/u);
    verdict = "supported";
    assert.deepEqual(await claim.decidePatientClaimRemovals(content, { recordText: `${item.record}。` }, "tcm"), [], "复核判写到了");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

await check("4.3 开关 CDSS_M03_PATIENT_CLAIM_EITHER_PASS：缺省肯定说法要两次核对都标到；打开后只有一次标到也交给复核（复核仍是最后一道关）", async () => {
  const item = FIELD_CASES[0];
  const content = JSON.stringify({ overview: { tcmDiseaseRationale: "归黄疸。", tcmDiagnosticRationale: item.text } });
  const run = async () => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.messages[0].content.includes("你是病历核对员")) return completion({ items: [{ id: 0, verdict: "absent" }] });
      const firstField = JSON.parse(body.messages[1].content).fields[0].id;
      return completion({ claims: firstField === "tcmDiagnosticRationale" ? [{ field: item.field, span: item.span }] : [] });
    };
    return claim.decidePatientClaimRemovals(content, { recordText: item.record }, "tcm");
  };
  try {
    assert.deepEqual(await run(), [], "缺省：一次标到不收");
    process.env.CDSS_M03_PATIENT_CLAIM_EITHER_PASS = "true";
    assert.deepEqual(await run(), [{ field: item.field, span: item.span }], "打开：一次标到交给复核，复核判没写到 → 删");
  } finally {
    delete process.env.CDSS_M03_PATIENT_CLAIM_EITHER_PASS;
    globalThis.fetch = savedFetch;
  }
  assert.deepEqual(claim.patientClaimCandidatesForVerification([{ field: "a", span: "壮热" }], [], {}), []);
  assert.deepEqual(claim.patientClaimCandidatesForVerification([{ field: "a", span: "壮热" }], [], { eitherPass: true }), [{ field: "a", span: "壮热" }]);
  assert.deepEqual(claim.patientClaimCandidatesForVerification([{ field: "a", span: "口不渴" }], [], {}), [{ field: "a", span: "口不渴" }], "否定说法一次标到本来就交给复核");
});

console.log(JSON.stringify({ suite: "r1020-m03text", cases, failures: process.exitCode ? "see above" : 0 }));

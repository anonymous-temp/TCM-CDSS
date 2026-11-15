// 第四十六轮（2026-11-15）工作包 B「结论与分析说的不是一回事」：证名、病性轴、病机链、总体病机、治法、辨证依据对同一组证素说同一句话。
// 甲方 11.05「病机分析」17/17 不合格、两次点名「分析为脾虚湿蕴，证名只写脾虚证」；第四十五轮逐字复核 200 份 C/D/H/G 四项的「错」。
//  1. 治法在治的实邪（渗湿、化痰、活血…）：分析也写了、病历有两条以上表现时病性栏补上，交付面国标合称接上（脾虚证 + 湿 → 脾虚湿困证）；
//     分析与结论对齐那一步不再把它当成「证名里没有」删掉（analysis-element-closure、m03-analysis-alignment）。
//  2. 分析里自立的实邪（证名与教材治法都没有）：按《中医诊断学》辨证要点核对，成组则立兼证，宽路径够数只标证据，不够数撤回（m03-element-support）。
//  3. 待核实：提示词用语外露、评论证名本身、问病历已写明的四诊属性、问已列着的证素，都不交付；病性说明不再写「个别要素尚缺直接的病历依据」，
//     点名缺哪一条；重写稿换上后病性栏重判，不留旧说明。
//  4. 治法：同一件事换个说法又写一遍的去掉；教材本证治法栏的项不按上下位并掉；治法覆盖核对与教材锚定用同一判据看「将要交付的治法」。
// 每条断言都有反证（~/runlogs/r1018/work/r1063/cp/analysis.py）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
let failures = 0;
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const closure = await jiti.import("../src/lib/analysis-element-closure.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const phrasing = await jiti.import("../src/lib/tcm-therapy-phrasing.ts");
const coverage = await jiti.import("../src/lib/m03-method-coverage.server.ts");
const alignment = await jiti.import("../src/lib/m03-analysis-alignment.server.ts");
const element = await jiti.import("../src/lib/m03-element-support.server.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const { textbookRowForSyndrome: textbookRow } = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (value) => `${S}\n${JSON.stringify(value)}\n${E}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E)));

// 经行泄泻·脾虚证（new45-n20 的形状）：教材治法「健脾渗湿，理气调经」，病机链写湿浊下注，病性栏只写气虚。
const N20_RECORD = "主诉：经期腹泻1年\n现病史：近1年每逢月经来潮前1～2天至经期出现大便溏泄，每日3～4次，伴经期脘腹胀满，神疲肢倦，面浮肢肿。\n脉象：脉濡缓";
const n20 = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: {
    tcmDiseaseName: "经行泄泻", primarySyndrome: "脾虚证", secondarySyndromes: [],
    tcmDiagnosticRationale: "经前至经期大便溏泄，伴面浮肢肿，为脾气虚弱、运化失司、水湿内停；脉濡缓为脾虚湿盛之象。证属脾虚证。",
    overallPathogenesis: "脾气虚弱，水湿内停下注大肠则为泄泻",
    overallTherapy: "健脾渗湿，理气调经",
  },
  pathogenesis: {
    natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "神疲肢倦", resolution: "resolved" },
    locationDifferentiation: { items: ["脾"], details: [{ location: "脾", basis: "大便溏泄" }], resolution: "resolved" },
    chain: [{ pathogenesis: "经行脾虚湿盛，湿浊下注大肠", therapyDirection: "健脾渗湿止泻" }],
    uncertainties: [],
  },
  therapy: { overallMethod: "健脾渗湿，理气调经", overallPrinciple: "虚则补之" },
});

await check("1.1 分析里的实邪说法：病机写法认、否认说法不认、症状写法不认", () => {
  assert.deepEqual([...closure.excessElementMentionsIn("经行脾虚湿盛，湿浊下注大肠")], ["damp"]);
  assert.deepEqual([...closure.excessElementMentionsIn("舌淡红，未见湿浊之象")], [], "否认不算");
  assert.deepEqual([...closure.excessElementMentionsIn("咳嗽痰多色白")], [], "痰多是症状，不是痰这一证素");
  assert.ok(closure.excessElementMentionsIn("故证属痰气互结兼瘀").has("stasis"));
});

await check("1.2 治法在治的实邪：渗湿 → 湿；渗利水湿只算湿不另算水停；理气调经不算", () => {
  assert.deepEqual([...closure.methodImpliedExcessElements("健脾渗湿，理气调经")], ["damp"]);
  assert.deepEqual([...closure.methodImpliedExcessElements("健脾益气，渗利水湿")], ["damp"]);
  assert.deepEqual([...closure.methodImpliedExcessElements("健脾温阳利水")], ["water"]);
  assert.deepEqual([...closure.methodImpliedExcessElements("益气健脾，理气调经")], []);
});

await check("1.3 病历里湿的表现：浮肿、溏泄、脉濡都算，否认的不算", () => {
  const signs = closure.recordExcessSigns(N20_RECORD, "damp").map((item) => item.sign);
  assert.ok(signs.length >= 2, JSON.stringify(signs));
  assert.ok(signs.includes("面浮肢肿") && signs.includes("脉濡"), JSON.stringify(signs));
  assert.equal(closure.recordExcessSigns("双下肢无浮肿，大便成形", "damp").length, 0);
});

await check("1.4 治法在治、分析写了、病历两条以上表现：病性栏补上湿（标实栏、依据原文）；任一条不满足不补", () => {
  const reasoning = n20();
  assert.deepEqual(closure.withMethodImpliedNatureElements(reasoning, N20_RECORD), ["湿"]);
  const nature = reasoning.pathogenesis.natureDifferentiation;
  assert.ok(nature.items.includes("湿") && nature.branchExcess.includes("湿"));
  assert.ok(nature.basis.split("；").slice(1).every((quote) => N20_RECORD.includes(quote)), nature.basis);
  const noMethod = n20(); noMethod.therapy.overallMethod = "益气健脾，理气调经"; noMethod.overview.overallTherapy = "益气健脾，理气调经";
  assert.deepEqual(closure.withMethodImpliedNatureElements(noMethod, N20_RECORD), [], "治法不治湿：不补");
  const noMention = n20(); noMention.pathogenesis.chain[0].pathogenesis = "经行脾虚，清浊不分"; noMention.overview.overallPathogenesis = "脾气虚弱，统摄无权"; noMention.overview.tcmDiagnosticRationale = "经前至经期大便溏泄，为脾气虚弱。证属脾虚证。";
  assert.deepEqual(closure.withMethodImpliedNatureElements(noMention, N20_RECORD), [], "分析没写湿：不补");
  assert.deepEqual(closure.withMethodImpliedNatureElements(n20(), "主诉：经期腹泻1年\n现病史：经期大便溏泄"), [], "病历只有一条：不补");
});

await check("1.5 交付面：补齐病性栏后国标合称接上（脾虚证 → 脾虚湿困证），病性栏列着湿", () => {
  const projected = surface.projectDeliveredReasoning(n20(), { recordText: N20_RECORD });
  assert.equal(projected.overview.primarySyndrome, "脾虚湿困证");
  assert.ok(projected.pathogenesis.natureDifferentiation.items.includes("湿"));
  const without = n20(); without.therapy.overallMethod = "益气健脾，理气调经"; without.overview.overallTherapy = "益气健脾，理气调经";
  without.pathogenesis.chain[0] = { pathogenesis: "经行脾虚，清浊不分", therapyDirection: "健脾止泻" };
  without.overview.overallPathogenesis = "脾气虚弱，统摄无权"; without.overview.tcmDiagnosticRationale = "经前至经期大便溏泄，为脾气虚弱。证属脾虚证。";
  assert.equal(surface.projectDeliveredReasoning(without, { recordText: N20_RECORD }).overview.primarySyndrome, "脾虚证", "对照：病性栏没有湿时不改名");
});

await check("1.6 合称的湿证表现与病性栏补齐同一张表：苔腻、困重之外，浮肿、便溏、脉濡也算", () => {
  const reasoning = n20();
  reasoning.pathogenesis.natureDifferentiation.items = ["气虚", "湿"];
  assert.equal(surface.compositeSyndromeRename(reasoning, N20_RECORD)?.to, "脾虚湿困证");
  const sparse = n20();
  sparse.pathogenesis.natureDifferentiation.items = ["气虚", "湿"];
  assert.equal(surface.compositeSyndromeRename(sparse, "主诉：经期腹泻1年\n现病史：经期大便溏泄，舌淡红"), undefined, "对照：病历只一条湿象不改名");
});

await check("2.1 分析对齐：治法在治的病性不算「证名里没有」；治法不治的照旧算", () => {
  const reasoning = n20();
  reasoning.pathogenesis.natureDifferentiation.items = ["气虚", "湿"];
  reasoning.pathogenesis.natureDifferentiation.branchExcess = ["湿"];
  reasoning.overview.primarySyndrome = "脾气虚证";
  const issues = alignment.analysisMisalignments(reasoning, "主诉：经期腹泻\n现病史：大便溏");
  assert.ok(!issues.some((issue) => issue.code === "nature_element_unnamed"), JSON.stringify(issues));
  const stasis = n20();
  stasis.overview.tcmDiseaseName = "痛经"; stasis.overview.primarySyndrome = "气血虚弱证";
  stasis.pathogenesis.natureDifferentiation = { items: ["气虚", "血虚", "血瘀"], rootDeficiency: ["气虚", "血虚"], branchExcess: ["血瘀"], basis: "面色少华" };
  stasis.therapy.overallMethod = "益气养血，调经止痛"; stasis.overview.overallTherapy = "益气养血，调经止痛";
  assert.ok(alignment.analysisMisalignments(stasis, "主诉：痛经").some((issue) => issue.code === "nature_element_unnamed"), "对照：益气养血不治瘀，病性栏的血瘀仍算对不上");
});

await check("2.2 对齐重写稿的待核实：评论证名本身的、提示段说法的、问病历已写明的不换上", () => {
  const reasoning = n20();
  reasoning.pathogenesis.natureDifferentiation = { items: ["气虚", "湿"], rootDeficiency: ["气虚"], branchExcess: ["湿"], basis: "神疲肢倦" };
  const rewrite = {
    rationale: "经前至经期大便溏泄，伴面浮肢肿、神疲肢倦，为脾气虚弱、运化失司、水湿内停；脉濡缓为湿盛之象。故为脾虚湿困证。",
    natureItems: ["气虚", "湿"], rootDeficiency: ["气虚"], branchExcess: ["湿"], natureBasis: "神疲肢倦；面浮肢肿",
    overallPathogenesis: "脾气虚弱，运化失司，水湿内停",
    uncertainties: [
      { item: "湿邪是否作为独立病性要素", reason: "结论证名未列湿，需确认", affects: "证名" },
      { item: "小便情况", reason: "病历否认句后接小便清长，按否认读", affects: "寒热" },
      { item: "舌苔厚薄", reason: "未记录", affects: "湿的轻重" },
      { item: "带下情况", reason: "病历未记录带下", affects: "湿的轻重" },
    ],
  };
  const record = `${N20_RECORD}\n舌象：舌淡，苔薄白`;
  const accepted = alignment.acceptedAlignmentRewrite(reasoning, rewrite, record);
  assert.ok(accepted, "应采信");
  assert.deepEqual(accepted.pathogenesis.uncertainties.map((row) => row.item), ["带下情况"]);
});

await check("2.3 重写稿换上后病性栏按新条目重判：依据逐项都有就是已确定，不留重写前的说明", () => {
  const before = n20();
  before.pathogenesis.natureDifferentiation = { items: ["气滞", "津亏"], rootDeficiency: ["津亏"], branchExcess: ["气滞"], basis: "粪便硬", resolution: "bounded", resolutionReason: "病性“气滞、津亏”中个别要素尚缺直接的病历依据" };
  const accepted = structuredClone(before);
  accepted.pathogenesis.natureDifferentiation = { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "神疲肢倦", resolution: "bounded", resolutionReason: "病性“气滞、津亏”中个别要素尚缺直接的病历依据" };
  const out = unwrap(alignment.contentWithAcceptedRewrite(wrap(before), accepted, N20_RECORD));
  assert.equal(out.pathogenesis.natureDifferentiation.resolution, "resolved");
  assert.equal(out.pathogenesis.natureDifferentiation.resolutionReason, undefined);
});

await check("3.1 待核实不交付：提示词用语外露、评论证名、问已写明的四诊属性、问已列着的证素；对照照留", () => {
  const reasoning = n20();
  reasoning.pathogenesis.locationDifferentiation = { items: ["膝", "肾", "脾"], details: [], resolution: "bounded" };
  reasoning.pathogenesis.natureDifferentiation = { items: ["阳虚", "寒湿"], rootDeficiency: ["阳虚"], branchExcess: ["寒湿"], basis: "怕冷" };
  reasoning.pathogenesis.uncertainties = [
    { item: "小便情况", reason: "病历否认句后接小便清长，按否认读", affects: "寒热" },
    { item: "湿邪是否作为独立病性要素", reason: "结论证名未列湿", affects: "证名" },
    { item: "舌苔厚薄", reason: "苔薄未示寒热属性", affects: "寒热" },
    { item: "冷汗肢温未记", reason: "有无阳脱倾向不明", affects: "阳脱" },
    { item: "是否兼脾阳虚", reason: "本例虽见怕冷、舌淡胖，未诉腹痛", affects: "温脾" },
    { item: "是否兼肝血虚", reason: "未见爪甲色淡", affects: "养血" },
    { item: "关节肿胀", reason: "未记录肿胀、积液情况", affects: "痹证分型" },
  ];
  const record = "主诉：双膝活动痛3年\n现病史：怕冷，体重偏高\n体格检查：皮肤湿冷\n舌象：舌淡胖，苔薄白";
  const items = surface.projectDeliveredReasoning(reasoning, { recordText: record }).pathogenesis.uncertainties.map((row) => row.item);
  assert.deepEqual(items, ["是否兼肝血虚", "关节肿胀"]);
});

await check("3.2 病性有界说明点名缺哪一条与该有的表现；不写「个别要素尚缺直接的病历依据」", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "热秘", primarySyndromeBasis: ["每3至4天排便"], primarySyndromeResolution: "bounded" },
    pathogenesis: { natureDifferentiation: { items: ["气滞"], rootDeficiency: [], branchExcess: ["气滞"], basis: "每3至4天排便，粪便硬", resolution: "bounded" }, chain: [], uncertainties: [] },
  };
  const record = "主诉：妊娠20周排便困难3周\n现病史：每3至4天排便，粪便硬，无腹痛\n舌象：舌淡红，苔薄\n脉象：滑";
  const nature = unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(reasoning), record)).pathogenesis.natureDifferentiation;
  assert.equal(nature.resolution, "bounded");
  assert.match(nature.resolutionReason, /“气滞”尚未见到胀闷、胀痛、窜痛、脉弦等表现/u);
  assert.doesNotMatch(nature.resolutionReason, /个别要素/u);
});

await check("3.2c 证名本身就是这一类的病性（心虚胆怯证之于气虚）：通用表现表认不出时不拦已确定（本证表现由教材证型说）", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "心虚胆怯证", primarySyndromeBasis: ["善惊易恐"], primarySyndromeResolution: "bounded" },
    pathogenesis: { natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "善惊易恐", resolution: "bounded" }, chain: [], uncertainties: [] },
  };
  const nature = unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(reasoning), "主诉：心悸1月\n现病史：心悸不宁，善惊易恐，夜寐多梦")).pathogenesis.natureDifferentiation;
  assert.equal(nature.resolution, "resolved");
});

await check("3.2b 病性每一条在依据里都有自己的表现（畏寒、肢冷之于阳虚与寒凝）：按已确定交付，不因段数少于条数写说明", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "肾阳虚证", primarySyndromeBasis: ["畏寒"], primarySyndromeResolution: "bounded" },
    pathogenesis: { natureDifferentiation: { items: ["阳虚", "寒凝"], rootDeficiency: ["阳虚"], branchExcess: ["寒凝"], basis: "畏寒、肢冷", resolution: "bounded" }, chain: [], uncertainties: [] },
  };
  const nature = unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(reasoning), "双膝关节隐痛2年，伴腰膝酸软、畏寒、肢冷。")).pathogenesis.natureDifferentiation;
  assert.equal(nature.resolution, "resolved");
});

await check("3.3 病性依据没摘到而病历有：补上病历原文（热的依据漏了发热）；病历只有正常舌象时不算血虚的表现", () => {
  const support = summary.natureAxisElementSupport(["热", "气逆"], "鼻翼扇动、胸壁凹陷", "主诉：咳嗽喘息2天\n现病史：发热，体温38.0℃，鼻翼扇动、胸壁凹陷");
  assert.ok(support.basis.split("；").some((segment) => segment.includes("发热")), support.basis);
  const blood = summary.natureAxisElementSupport(["血虚"], "舌淡红，苔薄", "主诉：头痛\n舌象：舌淡红，苔薄\n脉象：弦");
  assert.deepEqual(blood.unsupported.map((item) => item.label), ["血虚"], "舌淡红不是舌淡");
  assert.equal(closure.textHasSign("舌色淡红", "舌色淡"), false);
  assert.deepEqual(closure.recordSignQuotes("舌色淡红，脉弦", ["舌色淡"]), []);
  const temperature = summary.natureAxisElementSupport(["热"], "鼻翼扇动", "主诉：咳嗽喘息2天\n生命体征：体温38.0℃，鼻翼扇动");
  assert.ok(temperature.basis.includes("体温38.0℃"), `体温读数是热象：${temperature.basis}`);
  const empty = summary.natureAxisElementSupport(["热"], "", "主诉：发热2天");
  assert.equal(empty.basis, "", "模型的依据整段对不上病历时不替它补");
  assert.deepEqual(empty.unsupported, []);
});

await check("3.4 模型点名的待核实项问的是病历已写明的事时，不拿来写病性说明", () => {
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "喘脱证", primarySyndromeBasis: ["呼吸急促"], primarySyndromeResolution: "bounded" },
    pathogenesis: {
      natureDifferentiation: { items: ["血瘀", "气脱"], rootDeficiency: ["气脱"], branchExcess: ["血瘀"], basis: "舌暗，苔薄", resolution: "bounded" },
      chain: [], uncertainties: [{ item: "舌苔厚薄", reason: "苔薄未示寒热属性", affects: "病性" }],
    },
  };
  const record = "主诉：呼吸困难2小时\n现病史：呼吸急促，口唇稍紫\n舌象：舌暗，苔薄\n脉象：弦数";
  const nature = unwrap(summary.sanitizeOptionalPathogenesisClassifications(wrap(reasoning), record)).pathogenesis.natureDifferentiation;
  assert.doesNotMatch(String(nature.resolutionReason || ""), /舌苔厚薄/u, String(nature.resolutionReason));
});

await check("3.5 寒热有界说明写还缺哪几项、已见的写全（舌红、苔薄黄），不写「目前只见于」", () => {
  const reason = summary.coldHeatPendingReason(["舌红", "苔薄黄"], "主诉：咳嗽\n舌象：舌红，苔薄黄\n脉象：弦");
  assert.match(reason, /^寒热尚需结合.*口渴.*判断（已见舌红、苔薄黄）$/u);
  assert.doesNotMatch(reason, /只见于/u);
  const heat = summary.recordColdHeatSupport("舌红，苔薄黄，脉弦", "heat");
  assert.deepEqual(heat.terms, ["舌红", "苔薄黄"]);
  assert.deepEqual(summary.recordColdHeatSupport("舌象：舌红，苔薄黄", "heat").quotes, ["舌红"], "引文不带栏目名");
  const diagnose = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "脾寒气滞证", primarySyndromeResolution: "resolved", primarySyndromeBasis: ["夜间啼哭"] }, westernDiagnosis: {},
    pathogenesis: { symptomClusters: [], chain: [], uncertainties: [], natureDifferentiation: { items: ["寒"], rootDeficiency: [], branchExcess: ["寒"], basis: "舌象：舌质淡，苔薄白", resolution: "resolved", evidence: { evidenceLevel: "model_inference", source: "本例", confidence: "中" } }, locationDifferentiation: { items: [], details: [], resolution: "unresolved" } },
    therapy: { overallPrinciple: "寒者热之", overallMethod: "温脾散寒" } };
  const bounded = unwrap(summary.applyM03AdvisoryQualityBoundaries(wrap(diagnose), "主诉：夜间啼哭2周\n舌象：舌质淡，苔薄白")).pathogenesis.natureDifferentiation;
  assert.match(bounded.resolutionReason, /^寒热尚需结合.*判断（已见舌质淡）$/u);
});

await check("3.6 寒热见证：红斑、眼红与结膜充血、眼眵色黄算热象", () => {
  assert.ok(summary.recordColdHeatSupport("头皮和肘部红斑鳞屑5年，舌红，苔薄黄", "heat").dimensions.size >= 2);
  assert.ok(summary.recordColdHeatSupport("双眼发红，眼眵多、色黄白黏稠，睑结膜充血明显", "heat").dimensions.size >= 2);
  assert.equal(summary.recordColdHeatSupport("双眼无发红，无眼眵", "heat").dimensions.size, 0, "否认的不算");
});

await check("4.1 治法里同一件事换个说法又写一遍的去掉（只去后一项）；开头不同、结局相同的两种治法照留", () => {
  assert.equal(phrasing.withoutRedundantTherapyPhrases("化痰祛湿，健脾和胃，燥湿化痰"), "化痰祛湿，健脾和胃");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热通腑，利湿退黄，利胆退黄"), "清热通腑，利湿退黄");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("益气止血固脱，升提固脱"), "益气止血固脱");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("健脾温阳利水，利水消肿"), "健脾温阳利水");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("温中止痛，行气止痛"), "温中止痛，行气止痛", "对照");
  assert.equal(phrasing.withoutRedundantTherapyPhrases("清热利湿，活血止痛"), "清热利湿，活血止痛", "对照");
});

await check("4.2 交付治法：本证教材治法栏的项不按上下位并掉（益气健脾，甘温除热）", () => {
  assert.equal(surface.clinicalMethodItems("益气健脾，甘温除热", 3, new Set(["益气健脾", "甘温除热"])), "益气健脾，甘温除热");
  assert.equal(surface.clinicalMethodItems("益气健脾，甘温除热", 3), "益气健脾", "对照：不是教材项时照旧并掉");
  const projected = surface.projectDeliveredReasoning({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "内伤发热", primarySyndrome: "气虚发热证", overallTherapy: "益气健脾，甘温除热" },
    pathogenesis: { chain: [], uncertainties: [] }, therapy: { overallMethod: "益气健脾，甘温除热" },
  }, {});
  assert.equal(projected.therapy.overallMethod, "益气健脾，甘温除热");
});

await check("4.3 治法覆盖核对看的「将要交付的治法」与教材锚定同一判据：病历没写痛时理气止痛不锚定，按一项算", () => {
  assert.equal(coverage.methodToDeliver("夜啼", "脾寒气滞证", "温脾散寒，理气止痛", { recordText: "主诉：夜间啼哭1周\n现病史：哭时屈腰蜷腿，四肢欠温" }), "温脾散寒");
  assert.equal(coverage.methodToDeliver("夜啼", "脾寒气滞证", "", { recordText: "主诉：夜间啼哭1周\n现病史：哭时屈腰蜷腿，腹痛，四肢欠温" }), "温脾散寒，理气止痛", "对照：病历写了腹痛");
});

// 外感发热·气虚邪陷证（p100c-C008 的形状，无教材行）：病性栏列湿，结论句「合为气虚邪陷、湿热内蕴之证」。
const c008 = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: {
    tcmDiseaseName: "外感发热", primarySyndrome: "气虚邪陷证", secondarySyndromes: [],
    tcmDiagnosticRationale: "发热伴寒战，为外邪袭表、正邪交争；乏力、脉细数无力，示正气不支；饮食差、尿少、苔黄腻为湿热内蕴、脾胃升降失司；诸症合为气虚邪陷、湿热内蕴之证。",
    overallPathogenesis: "外邪未解，正气不支，邪热内陷；湿热内蕴，脾胃升降失司",
  },
  pathogenesis: {
    natureDifferentiation: { items: ["气虚", "湿"], rootDeficiency: ["气虚"], branchExcess: ["湿"], basis: "苔黄腻" },
    chain: [
      { pathogenesis: "外邪未解，正邪交争，表里同病", therapyDirection: "解表清里，透邪外达" },
      { pathogenesis: "湿热内蕴，脾胃升降失司", therapyDirection: "化湿和胃，通利小便" },
    ],
    uncertainties: [],
  },
  therapy: { overallMethod: "解表清里，益气固脱，化湿和胃" },
});

await check("5.1 要核对的实邪证素：分析立了、证名与教材治法都没有（湿热 → 湿热证）；证名有、教材治法在治、没立住的都不核", () => {
  const units = element.excessElementUnits(c008(), [], "主诉：发热伴乏力2天");
  assert.equal(units.length, 1);
  assert.equal(units[0].entryName, "湿热证");
  assert.equal(units[0].secondaryName, "湿热内蕴证");
  const named = c008(); named.overview.primarySyndrome = "湿热内蕴证";
  assert.equal(element.excessElementUnits(named, [], "").length, 0, "证名已有湿");
  assert.equal(element.excessElementUnits(n20(), [], N20_RECORD).length, 0, "教材本证治法健脾渗湿在治湿：交付面补病性栏，不立兼证");
  const loose = c008();
  loose.pathogenesis.natureDifferentiation = { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "乏力" };
  loose.pathogenesis.chain[1] = { pathogenesis: "湿热内蕴，脾胃升降失司", therapyDirection: "和胃降逆" };
  loose.overview.tcmDiagnosticRationale = "发热伴寒战，为外邪袭表；饮食差、苔黄腻为湿热内蕴。证属气虚邪陷证。";
  assert.equal(element.excessElementUnits(loose, [], "").length, 0, "只顺带提到（病性栏没列、结论没写、病机链没在治）：不核");
  assert.equal(element.excessElementUnits(n20(), [], "主诉：经期腹泻1年\n现病史：经期大便次数增多").length, 0, "病历对教材证型吻合度低时也不核教材治法在治的湿");
});

await check("5.1b 病历对主证教材证型吻合得好（主证已解释主要表现）：分析里多写的实邪不核", () => {
  const record = "主诉：胃痛2月\n现病史：胃脘胀痛，痛连两胁，遇烦恼则痛作或痛甚，嗳气、矢气则痛舒，胸闷嗳气，喜长叹息，大便不畅\n舌象：舌苔薄黄腻\n脉象：脉弦";
  const reasoning = c008();
  reasoning.overview.tcmDiseaseName = "胃痛"; reasoning.overview.primarySyndrome = "肝气犯胃证";
  assert.ok(secondary.textbookPatternFit(textbookRow("胃痛", "肝气犯胃证"), record) >= secondary.GROUP_CHECK_FIT_CEILING, "前提：吻合度达到闸门");
  assert.equal(element.excessElementUnits(reasoning, [], record).length, 0);
});

await check("5.1c 痰湿是一个病理产物：证名有痰时不另拆湿；几个实邪都立住时先核立得最实的", () => {
  const phlegm = c008();
  phlegm.overview.primarySyndrome = "痰气互结证"; phlegm.overview.tcmDiseaseName = "梅核气";
  phlegm.overview.tcmDiagnosticRationale = "咽部异物感为痰气交阻。证属痰气互结证。"; phlegm.overview.overallPathogenesis = "痰气互结于咽喉";
  phlegm.pathogenesis.natureDifferentiation = { items: ["气滞", "痰湿", "血瘀"], rootDeficiency: [], branchExcess: ["气滞", "痰湿", "血瘀"], basis: "舌暗" };
  phlegm.pathogenesis.chain = [{ pathogenesis: "痰气互结于咽喉", therapyDirection: "行气化痰" }];
  assert.deepEqual(element.excessElementUnits(phlegm, [], "").map((unit) => unit.entryName), ["血瘀证"]);
  const weighted = c008();
  weighted.pathogenesis.natureDifferentiation.items = ["气虚", "湿", "血瘀"];
  weighted.overview.tcmDiagnosticRationale = "乏力为气虚，舌暗有瘀点为瘀血内阻。诸症合参，证属气虚邪陷兼瘀。";
  weighted.pathogenesis.chain.push({ pathogenesis: "瘀血内阻", therapyDirection: "活血化瘀" });
  assert.deepEqual(element.excessElementUnits(weighted, [], "").map((unit) => unit.entryName), ["血瘀证"]);
});

await check("5.2 活动性出血时不核血瘀", () => {
  const reasoning = c008();
  reasoning.pathogenesis.natureDifferentiation = { items: ["气虚", "血瘀"], rootDeficiency: ["气虚"], branchExcess: ["血瘀"], basis: "舌暗" };
  reasoning.overview.tcmDiagnosticRationale = "腹痛如刺为瘀血内阻；证属气虚邪陷证。"; reasoning.overview.overallPathogenesis = "瘀血内阻";
  reasoning.pathogenesis.chain[1] = { pathogenesis: "瘀血内阻", therapyDirection: "活血化瘀" };
  assert.equal(element.excessElementUnits(reasoning, [], "主诉：腹痛\n现病史：舌暗").length, 1, "对照：没有出血时核");
  assert.equal(element.excessElementUnits(reasoning, [], "主诉：腹痛\n现病史：呕血2次，量约200ml，舌暗").length, 0);
});

await check("5.3 处置：按辨证要点成组且过闸门 → 证名带上；只按宽路径够数 → 只标证据；不够数 → 撤回；查不到 → 不动", () => {
  assert.equal(element.excessElementAction({ verdict: "pass", strict: true, specific: 2, category: 1, listed: 0, distinct: 3 }, true), "name");
  assert.equal(element.excessElementAction({ verdict: "pass", strict: true, specific: 2, category: 1, listed: 0, distinct: 3 }, false), "label");
  assert.equal(element.excessElementAction({ verdict: "pass", strict: false, specific: 0, category: 0, listed: 3, distinct: 3 }, true), "label");
  assert.equal(element.excessElementAction({ verdict: "fail", specific: 0, category: 0, listed: 1, distinct: 1 }, true), "withdraw");
  assert.equal(element.excessElementAction({ verdict: "unknown", specific: 0, category: 0, listed: 0, distinct: 0 }, true), "none");
});

await check("5.4 辨证要点成组（strict）与证素宽路径分开记：只靠证候表现三条够数的不算成组", () => {
  const entry = secondary.diagnosticsCriteriaFor("血虚证");
  const record = "面色萎黄，头晕眼花，爪甲色淡，月经量少色淡";
  const matches = [{ item: "萎黄", quote: "面色萎黄" }, { item: "头晕眼花", quote: "头晕眼花" }, { item: "爪甲色淡", quote: "爪甲色淡" }];
  const breadth = secondary.evaluateCriteriaMatches(entry, matches, { recordText: record, primaryTerms: [], breadth: true });
  assert.equal(breadth.verdict, "pass");
  assert.equal(breadth.strict, false);
});

await check("5.5 立兼证的闸门：已有兼证、寒热相反时不过；无教材行、结构成立时过", () => {
  const unit = element.excessElementUnits(c008(), [], "")[0];
  assert.equal(element.excessNameGate(c008(), unit, "主诉：发热"), true);
  const already = c008(); already.overview.secondarySyndromes = ["脾气虚证"];
  assert.equal(element.excessNameGate(already, unit, "主诉：发热"), false);
  const cold = c008(); cold.overview.primarySyndrome = "风寒束表证";
  assert.equal(element.excessNameGate(cold, unit, "主诉：发热"), false, "风寒与湿热寒热相反");
});

await check("5.6 证名带上：立为兼证（湿热内蕴证），治法已在治湿时不重复补，证据标为辨证要点", () => {
  const root = c008();
  const unit = element.excessElementUnits(root, [], "")[0];
  const verdict = { verdict: "pass", strict: true, entry: "湿热证", specific: 0, category: 0, listed: 3, distinct: 3, quotes: ["苔黄腻", "饮食差", "尿少"] };
  assert.equal(element.applyExcessElementDecisions(root, [{ unit, verdict, action: "name" }]), true);
  assert.deepEqual(root.overview.secondarySyndromes, ["湿热内蕴证"]);
  assert.equal(root.therapy.overallMethod, "解表清里，益气固脱，化湿和胃", "化湿和胃已在治湿");
  assert.equal(root.pathogenesis.chain[1].evidence.source, "《中医诊断学》湿热证辨证要点");
});

await check("5.7 撤回：病性栏、病机链（删写了它的分句与只为它写的治法项）、总治法里只为它写的项、辨证依据里那一分句（病历表现留下归待核实）都撤，待核实写「是否兼X」（用分析自己的写法：湿热）", () => {
  const root = c008();
  const unit = element.excessElementUnits(root, [], "")[0];
  const verdict = { verdict: "fail", entry: "湿热证", specific: 0, category: 0, listed: 1, distinct: 1, quotes: ["苔黄腻"] };
  element.applyExcessElementDecisions(root, [{ unit, verdict, action: "withdraw" }], "");
  assert.deepEqual(root.pathogenesis.natureDifferentiation.items, ["气虚"]);
  assert.deepEqual(root.pathogenesis.natureDifferentiation.branchExcess, []);
  assert.equal(root.pathogenesis.chain.length, 2, "删掉湿热那一分句后还剩独立病机「脾胃升降失司」：节点留着");
  assert.equal(root.pathogenesis.chain[1].pathogenesis, "脾胃升降失司");
  assert.equal(root.pathogenesis.chain[1].therapyDirection, "通利小便");
  assert.equal(root.therapy.overallMethod, "解表清里，益气固脱");
  assert.doesNotMatch(root.overview.tcmDiagnosticRationale, /为湿热内蕴|湿热内蕴之证/u);
  assert.match(root.overview.tcmDiagnosticRationale, /饮食差、尿少、苔黄腻，是否兼湿热尚待核实/u);
  assert.equal(root.pathogenesis.uncertainties[0].item, "是否兼湿热");
  assert.doesNotMatch(root.overview.overallPathogenesis, /湿热/u);
});

await check("5.8 虚性证素撤回时，写明了证名本有脏腑的治法项（脾气虚证下的「健脾益气」）不跟着撤；名外脏腑的（补益肺气）撤", () => {
  const root = {
    overview: { tcmDiseaseName: "耳胀", primarySyndrome: "脾气虚证", secondarySyndromes: [], tcmDiagnosticRationale: "肢倦乏力、纳差、便溏为脾气亏虚；气短为肺气亏虚。证属脾气虚证。", overallPathogenesis: "脾气亏虚，运化失司" },
    pathogenesis: { chain: [{ pathogenesis: "脾气亏虚，运化失司", therapyDirection: "健脾益气" }, { pathogenesis: "肺气亏虚，宣降失司", therapyDirection: "补益肺气" }], natureDifferentiation: { items: ["气虚"] }, uncertainties: [] },
    therapy: { overallMethod: "健脾益气，补益肺气" },
  };
  const decision = { verdicts: [{ unit: { type: "气虚", organs: ["肺"], entryName: "肺气虚证", mentions: 1 }, verdict: { verdict: "fail", entry: "肺气虚证", specific: 0, category: 0, listed: 1, distinct: 1 } }] };
  const out = JSON.parse(element.applyElementSupportDecision(JSON.stringify(root), decision, ""));
  assert.equal(out.therapy.overallMethod, "健脾益气");
  assert.equal(out.pathogenesis.chain.length, 1);
});

await check("6.1 删掉结论小句后只剩结论引语的残句整句去掉；带结论的照留", () => {
  assert.equal(closure.withoutDanglingConclusionLeads("为久病络脉瘀滞之外候。诸症合参。发声费力，是否兼气虚尚待核实。"), "为久病络脉瘀滞之外候。发声费力，是否兼气虚尚待核实。");
  assert.equal(closure.withoutDanglingConclusionLeads("诸症合参，证属气滞血瘀证。"), "诸症合参，证属气滞血瘀证。");
  assert.equal(secondary.withoutClauses("咽部异物感为痰气交阻。诸症合参，证属痰气互结兼瘀。", ["证属痰气互结兼瘀"]), "咽部异物感为痰气交阻。");
});

await check("7.1 病机链首节点讲的实邪教材这一证的证名与治法都没有时，不标教材行出处；讲的是本证时照标", () => {
  const base = () => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "痛经", primarySyndrome: "气血虚弱证", primarySyndromeResolution: "bounded" },
    pathogenesis: { chain: [{ pathogenesis: "瘀阻胞宫，不通则痛", therapyDirection: "化瘀止痛", evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" } }], uncertainties: [] },
    therapy: { overallMethod: "益气养血，调经止痛", subTherapies: [] },
  });
  assert.equal(surface.projectDeliveredReasoning(base(), {}).pathogenesis.chain[0].evidence.evidenceLevel, "model_inference");
  const own = base();
  own.pathogenesis.chain[0].pathogenesis = "气血虚弱，胞脉失养，不荣则痛";
  assert.equal(surface.projectDeliveredReasoning(own, {}).pathogenesis.chain[0].evidence.evidenceLevel, "kb_entry");
});

if (failures > 0) process.exit(1);

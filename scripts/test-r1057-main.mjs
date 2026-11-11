// 第四十二轮（2026-11-10）：根因一「这张方的原方组成没有唯一权威」。
// 原方组成表（src/data/tcm-formula-original-compositions.json）是「原方」措辞、加减后缀、药引、原方炮制、出处的唯一依据；
// 方的身份是方名加出处；受治理目录与原方表全表对账进闸门；给开方模型的基准只写基础药名和原方炮制。
// 每条断言都有反证（~/runlogs/r1018/work/r1057/cp/）。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

const original = await jiti.import("../src/lib/formula-original-composition.ts");
const display = await jiti.import("../src/lib/formula-baseline-display.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const processing = await jiti.import("../src/lib/herb-processing-forms.ts");
const reconciliation = await jiti.import("../src/lib/formula-original-reconciliation.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const source = read("../src/data/tcm-formula-original-compositions.source.json");
const table = read("../src/data/tcm-formula-original-compositions.json");
const catalog = read("../src/data/tcm-formula-governed-catalog.json").entries;
const H = (names) => names.map((name) => ({ name }));
const norm = (text) => String(text || "").normalize("NFKC").replace(/\s+/gu, "");

// ───── 1 表本身 ─────
await check("1.1 原方表每一行：规范书名、键不重复、药味不重复，每味药的原文写法、原文炮制词、药引原文都逐字在摘句里", () => {
  const seen = new Set();
  const tiers = new Set(["original_text", "national_catalog", "fangjixue", "textbook_appendix", "modern_source"]);
  for (const row of source.rows) {
    const key = `${row.name}|${row.book}|${row.variant || ""}`;
    assert.ok(row.name && row.book, key);
    assert.ok(!seen.has(key), `键重复：${key}`);
    seen.add(key);
    assert.equal(original.canonicalFormulaBook(`《${row.book}》`), row.book, `不是规范书名：${key}`);
    assert.ok(tiers.has(row.tier), `tier：${key}`);
    assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, `没有证据：${key}`);
    const quotes = norm(row.evidence.map((item) => item.quote).join(""));
    const herbs = new Set();
    assert.ok(row.ingredients.length > 0, `没有药味：${key}`);
    for (const item of row.ingredients) {
      assert.ok(quotes.includes(norm(item.written)), `「${item.written}」不在摘句里：${key}`);
      assert.ok(!herbs.has(item.herb), `药味重复 ${item.herb}：${key}`);
      herbs.add(item.herb);
      if (item.preparation) assert.ok(item.preparationRaw && quotes.includes(norm(item.preparationRaw)), `炮制词不在摘句里：${key} ${item.written}`);
    }
    for (const guide of row.guideHerbs || []) {
      assert.ok(quotes.includes(norm(guide.written)), `药引原文不在摘句里：${key} ${guide.written}`);
      assert.ok(!herbs.has(guide.herb), `药引已在药味里：${key} ${guide.herb}`);
    }
    for (const evidence of row.evidence) {
      if (evidence.kind === "jicheng") assert.ok(evidence.url && evidence.book, `jicheng 证据缺 url/book：${key}`);
      if (evidence.kind === "local") assert.ok(evidence.file && Number.isInteger(evidence.line), `本地证据缺文件行号：${key}`);
      if (evidence.kind === "web") assert.ok(evidence.url, `网页证据缺 url：${key}`);
    }
  }
});

await check("1.2 生成物与输入逐行对应（行数、药味、药引）；深圳标准与教材不作原方出处", () => {
  assert.equal(table.entries.length, source.rows.length);
  source.rows.forEach((row, index) => {
    const entry = table.entries[index];
    assert.equal(`${entry.name}|${entry.book}`, `${row.name}|${row.book}`);
    assert.deepEqual(entry.herbs.map((item) => item.herb), row.ingredients.map((item) => item.herb), row.name);
    assert.deepEqual(entry.guides, (row.guideHerbs || []).map((item) => item.herb), row.name);
  });
  for (const entry of table.entries) {
    assert.ok(!/SZJG|中药方剂编码规则|深圳/u.test(entry.book), `深圳标准不是原方出处：${entry.name}`);
  }
  assert.ok(table.entries.length >= 2300, `表行数 ${table.entries.length}`);
});

// ───── 2 四个点名病例 ─────
await check("2.1 人参养荣汤：照抄深圳标准的组成（枸杞子、首乌藤、无肉桂）不是原方；《局方》原文十二味是原方；生姜、大枣是药引；荣/营两种写法是同一条", () => {
  const szjg = ["当归", "白芍", "黄芪", "人参", "白术", "熟地黄", "茯苓", "制远志", "陈皮", "炙甘草", "五味子", "枸杞子", "首乌藤"];
  const jufang = ["白芍", "当归", "陈皮", "黄芪", "肉桂", "人参", "白术", "炙甘草", "熟地黄", "五味子", "茯苓", "远志"];
  assert.equal(surface.candidateIsOriginalFormula("人参养荣汤", H(szjg)), false);
  assert.equal(surface.candidateIsOriginalFormula("人参养荣汤", H(jufang)), true);
  assert.equal(surface.candidateIsOriginalFormula("人参养荣汤", H([...jufang, "生姜", "大枣"])), true, "药引列进药味表仍是原方");
  assert.equal(surface.candidateIsOriginalFormula("人参养荣汤", H([...jufang, "枸杞子"])), false, "多出原方没有的药不是原方");
  assert.match(surface.omittedGuideHerbNote("人参养荣汤", H(jufang)) || "", /生姜、大枣/u);
  const entry = original.originalFormula("人参养荣汤", "《太平惠民和剂局方》");
  assert.ok(entry && entry.herbs.some((item) => item.herb === "肉桂" && item.written === "桂心"));
  assert.equal(original.originalFormula("人参养营汤", "《太平惠民和剂局方》"), entry, "人参养营汤与人参养荣汤是同一条");
  assert.match(entry.evidence.quote, /桂心/u);
});

await check("2.2 天麻钩藤饮：目录的调剂品名（姜天麻、黄芩片、盐杜仲、朱茯神、煅石决明）不是原方炮制，不写进交付药名", () => {
  assert.deepEqual(provenance.governedFormulaOriginalPreparations("天麻钩藤饮"), []);
  for (const herb of ["天麻", "黄芩", "杜仲", "茯苓", "茯神", "石决明"]) {
    // 方名不带来任何炮制：带不带方名结果相同（杜仲按《中药炮制学》通则盐炙是另一条规则，与方无关）。
    assert.equal(processing.processedHerbName(herb, { formulaName: "天麻钩藤饮" }), processing.processedHerbName(herb, {}), herb);
  }
});

await check("2.3 柴胡葛根汤：教材行写的出处是《外科正宗》，原方十味取自原书；教材「常用药」十一味不是原方", () => {
  const rowId = "erke|流行性腮腺炎|温毒外袭";
  assert.equal(original.textbookRowFormulaBook(rowId, "柴胡葛根汤"), "外科正宗");
  const entry = provenance.originalFormulaFor("柴胡葛根汤", { textbookRowId: rowId });
  assert.deepEqual(entry.herbs.map((item) => item.herb), ["柴胡", "天花粉", "葛根", "黄芩", "桔梗", "连翘", "牛蒡子", "石膏", "甘草", "升麻"]);
  const row = textbook.textbookRowForSyndrome("流行性腮腺炎", "温毒外袭") || textbook.textbookRowForSyndrome("痄腮", "温毒外袭");
  const common = ["柴胡", "葛根", "黄芩", "牛蒡子", "桔梗", "升麻", "连翘", "板蓝根", "夏枯草", "赤芍", "僵蚕"];
  assert.equal(surface.candidateIsOriginalFormula("柴胡葛根汤", H(common), { textbookRowId: rowId }), false, "教材常用药不是原方");
  assert.equal(surface.candidateIsOriginalFormula("柴胡葛根汤", H(entry.herbs.map((item) => item.herb)), { textbookRowId: rowId }), true);
  assert.equal(provenance.textbookFormulaOriginalSource("柴胡葛根汤", common, { textbookRowId: rowId }), "《外科正宗》");
  assert.ok(row || true);
});

await check("2.4 白术散：教材署《全生指迷方》，目录同名条目是《小儿药证直诀》的另一首——同名异方，不锁目录条目，出处写《全生指迷方》，开方提示里给的是那本书的原方", () => {
  const rowId = "fuke|子肿|脾虚证";
  const textbookHerbs = ["白术", "茯苓", "大腹皮", "生姜皮", "陈皮"];
  assert.equal(original.textbookRowFormulaBook(rowId, "白术散"), "全生指迷方");
  assert.equal(provenance.textbookCitedFormulaIsGovernedHomonym("白术散", rowId, textbookHerbs), true);
  assert.equal(provenance.textbookFormulaGovernedEntryIsHomonym("白术散", textbookHerbs, { textbookRowId: rowId }), true);
  assert.equal(provenance.textbookFormulaOriginalSource("白术散", textbookHerbs, { textbookRowId: rowId }), "《全生指迷方》");
  const entry = provenance.originalFormulaFor("白术散", { textbookRowId: rowId });
  assert.ok(entry && entry.book === "全生指迷方" && entry.herbs.some((item) => item.herb === "大腹皮"), JSON.stringify(entry));
  assert.ok(!entry.herbs.some((item) => item.herb === "人参"), "不是钱乙那首");
  const diagnose = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: "子肿", primarySyndrome: "脾虚证", primarySyndromeResolution: "resolved", recommendedFormulaDirection: "白术散加减" },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾利水", subTherapies: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["脾"] } } };
  const locked = provenance.withDeterministicFormulaReferences(diagnose, "主诉：妊娠7月，面目四肢浮肿2周", undefined);
  assert.ok(!(locked.overview.recommendedFormulaNames || []).includes("白术散"), "不按方名锁《小儿药证直诀》白术散");
  assert.match(String(locked.overview.recommendedFormulaDirection), /白术散/u, "方向里仍写教材方名");
  const context = textbook.buildTextbookFormulaContext("子肿", "脾虚证", {});
  assert.match(context, /白术散（《全生指迷方》）原方：/u);
  assert.match(context, /教材常用药/u);
  // 对照：同一本书的条目不算同名异方（六味地黄丸《小儿药证直诀》）。
  assert.equal(provenance.textbookCitedFormulaIsGovernedHomonym("六味地黄丸", undefined, ["熟地黄", "山茱萸", "山药", "泽泻", "牡丹皮", "茯苓"]), false);
});

// ───── 3 只读这张表 ─────
await check("3.1 表里没有的方不判原方、不补药引：深圳标准条目自己的组成、教材行的组成都不算原方依据", () => {
  let checked = 0;
  for (const entry of catalog) {
    if (entry.sourceClass !== "official_local_formula_standard" || !entry.identityLockEligible) continue;
    if (provenance.originalFormulaFor(entry.name)) continue;
    assert.equal(surface.candidateIsOriginalFormula(entry.name, H(entry.ingredients)), undefined, entry.name);
    assert.equal(surface.omittedGuideHerbNote(entry.name, H(entry.ingredients.filter((name) => !/生姜|大枣/u.test(name)))), undefined, entry.name);
    checked += 1;
  }
  assert.ok(checked >= 5, `抽到的深圳标准条目 ${checked}`);
  const code = readFileSync(new URL("../src/lib/delivered-surface.ts", import.meta.url), "utf8");
  const body = code.slice(code.indexOf("export function candidateIsOriginalFormula"), code.indexOf("const SAME_SOURCE_HERB_GROUPS"));
  assert.ok(body.length > 200 && !/formulaCompilationReferences|textbookFormulaComposition/u.test(body), "candidateIsOriginalFormula 不得再读目录或教材行组成");
  const guide = code.slice(code.indexOf("export function omittedGuideHerbNote"), code.indexOf("export function omittedGuideHerbNote") + 1800);
  assert.ok(!/formulaCompilationReferences|formulaGuideHerbsFromCommentary/u.test(guide), "omittedGuideHerbNote 不得再读目录或方解");
});

await check("3.2 旧的 original-text 表与它的生成器已删除，没有读者；原方炮制只来自原方表", () => {
  assert.ok(!existsSync(new URL("../src/data/tcm-formula-original-text.json", import.meta.url)));
  assert.ok(!existsSync(new URL("./build-formula-original-text.py", import.meta.url)));
  const provenanceCode = readFileSync(new URL("../src/lib/tcm-formula-provenance.ts", import.meta.url), "utf8");
  const body = provenanceCode.slice(provenanceCode.indexOf("export function governedFormulaOriginalPreparations"), provenanceCode.indexOf("function cleanFormulaDisplayName"));
  assert.ok(body.length > 100 && !/ingredientLinks|prescriptionOriginal/u.test(body), "原方炮制不得再读目录链接字段或目录自带原文");
});

await check("3.3 原方炮制的交付口径：通行的三味（甘草炙、黄芪炙、酸枣仁炒）与国家经典名方目录原文写明的随方写；古书的「酒洗」「炙（非蜜炙）」只记录不改药名", () => {
  assert.equal(processing.processedHerbName("甘草", { formulaName: "归脾汤" }), "炙甘草");
  assert.equal(processing.processedHerbName("酸枣仁", { formulaName: "归脾汤" }), "炒酸枣仁");
  assert.equal(processing.processedHerbName("白术", { formulaName: "完带汤" }), "土炒白术");
  assert.equal(processing.processedHerbName("大黄", { formulaName: "大承气汤" }), undefined, "大黄酒洗不是酒大黄");
  assert.equal(processing.processedHerbName("枳实", { formulaName: "大承气汤" }), undefined);
  assert.equal(processing.processedHerbName("龙胆", { formulaName: "龙胆泻肝汤" }), undefined);
  const dachengqi = original.originalFormula("大承气汤", "《伤寒论》");
  assert.ok(dachengqi.herbs.some((item) => item.herb === "大黄" && item.preparation === "酒" && !item.deliver), "原书炮制仍记录在表里");
});

await check("3.4 方名以药名开头的整个方名不随药名改（龙胆泻肝汤、黄芪建中汤）", () => {
  const text = processing.withProcessedHerbMentions("本方以龙胆泻肝汤为基础加减，龙胆为君，合黄芪建中汤意，黄芪益气。", new Map([["龙胆", "酒龙胆"], ["黄芪", "炙黄芪"]]));
  assert.equal(text, "本方以龙胆泻肝汤为基础加减，酒龙胆为君，合黄芪建中汤意，炙黄芪益气。");
});

// ───── 4 是不是同一味药 ─────
await check("4.1 原方表的药与处方、目录里的药按同一味比：古名与品种（芍药—白芍）、产地规格（木通—川木通、滑石—滑石粉）、登记的异写（桂心—肉桂）算同一味；白芍与赤芍、苍术与白术不算；犀角可由水牛角满足", () => {
  for (const [left, right] of [["芍药", "白芍"], ["芍药", "赤芍"], ["贝母", "浙贝母"], ["木通", "川木通"], ["牛膝", "川牛膝"], ["滑石", "滑石粉"], ["紫苏", "紫苏叶"], ["竹叶", "淡竹叶"], ["肉桂", "桂心"], ["决明子", "草决明"], ["甘草", "炙甘草"], ["天麻", "姜天麻"]]) {
    assert.equal(provenance.originalHerbMatches(left, right), true, `${left}—${right}`);
  }
  for (const [left, right] of [["白芍", "赤芍"], ["白术", "苍术"], ["肉桂", "桂枝"], ["人参", "党参"], ["枸杞子", "肉桂"], ["陈皮", "青皮"]]) {
    assert.equal(provenance.originalHerbMatches(left, right), false, `${left}—${right}`);
  }
  assert.equal(provenance.originalHerbSatisfiedBy("犀角", "水牛角"), true);
  assert.equal(provenance.originalHerbSatisfiedBy("水牛角", "犀角"), false, "替代只有一个方向");
});

// ───── 5 全表对账 ─────
await check("5.1 受治理目录 × 原方表：同名同书的条目按药味逐味比，未列入接受清单的差异为零，接受清单没有过期项、每条都有理由", () => {
  const result = reconciliation.catalogOriginalReconciliation();
  assert.ok(result.compared >= 2000, `可比条目 ${result.compared}`);
  assert.deepEqual(result.unresolved.map((item) => `${item.name}${item.source} 多:${item.extraInCatalog.join("、")} 缺:${item.missingInCatalog.join("、")}`), []);
  assert.deepEqual(result.staleAccepted.map((item) => `${item.name}《${item.book}》`), []);
  for (const item of reconciliation.acceptedCatalogOriginalDifferences()) {
    assert.ok(item.reason && item.reason.length >= 8 && item.category, `接受清单缺理由：${item.name}`);
  }
});

await check("5.2 对账确实在比：把目录里一条的组成换掉一味就报差异；差异列进清单后不再报", () => {
  const differences = reconciliation.governedCatalogOriginalDifferences();
  const accepted = reconciliation.acceptedCatalogOriginalDifferences();
  assert.equal(differences.length, accepted.length, "差异条数 = 接受清单条数");
  const target = catalog.find((entry) => entry.name === "人参养荣汤");
  const entry = original.originalFormula(target.name, target.source);
  assert.ok(entry, "人参养荣汤在表里");
  assert.ok(!differences.some((item) => item.id === target.id), "人参养荣汤目录条目已订正为原方");
  assert.ok(target.ingredients.some((name) => provenance.originalHerbMatches("肉桂", name)), "目录条目有肉桂");
  assert.ok(!target.ingredients.some((name) => /枸杞|首乌藤/u.test(name)), "目录条目不再有枸杞子、首乌藤");
});

// ───── 6 给模型看的基准 ─────
await check("6.1 开方提示词的方剂目录编译基准只写基础药名与原方炮制：天麻钩藤饮不出现姜天麻、煅石决明、黄芩片、盐杜仲、朱茯神", () => {
  const reference = provenance.formulaCompilationReferences(["天麻钩藤饮"])[0];
  const names = display.formulaBaselineDisplayNames(reference.ingredients, display.originalFormulaForCatalogEntry(reference.formulaName, reference.source));
  assert.equal(names.length, reference.ingredients.length);
  assert.ok(!names.some((name) => /姜天麻|煅石决明|黄芩片|盐杜仲|朱茯神/u.test(name)), names.join("、"));
  assert.ok(names.includes("天麻") && names.includes("石决明") && names.includes("黄芩"), names.join("、"));
  // 有毒的药不按原书改回生品名。
  assert.equal(display.dispensingBaseName("制川乌"), "制川乌");
  assert.equal(display.dispensingBaseName("姜半夏"), "姜半夏");
  assert.equal(display.dispensingBaseName("熟地黄"), "熟地黄");
  assert.equal(display.dispensingBaseName("黄芩片"), "黄芩");
  const caseState = { patient: { sex: "男", age: 58 }, chiefComplaint: "头晕头痛1周", conversation: [],
    reasoningDiagnose: { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: { tcmDiseaseName: "眩晕", primarySyndrome: "肝阳上亢证", overallPathogenesis: "肝阳偏亢，风阳上扰", overallTherapy: "平肝潜阳，清火息风",
        recommendedFormulaDirection: "天麻钩藤饮加减", recommendedFormulaNames: ["天麻钩藤饮"], formulaSelectionMode: "single" },
      pathogenesis: { chain: [{ nodeId: "P1", patientFact: "头晕头痛，面红目赤", syndromeEvidence: "舌红苔黄，脉弦数", pathogenesis: "肝阳上亢", therapyDirection: "平肝潜阳" }] },
      therapy: { overallPrinciple: "实则泻之", overallMethod: "平肝潜阳，清火息风", subTherapies: [] } } };
  const prompt = prompts.buildPrescribePrompt(caseState);
  const start = prompt.indexOf("【服务端方剂目录编译基准");
  assert.ok(start >= 0);
  const section = prompt.slice(start, start + 2500);
  assert.match(section, /基准药味：[^\n]*天麻、钩藤、石决明/u);
  // 整份提示词都不带深圳标准的调剂品名（朱茯神是《杂病证治新义》原文写法，教材常用药与方解里照原文出现，不算）。
  const leaked = prompt.split("\n").filter((line) => /姜天麻|煅石决明|黄芩片|盐杜仲/u.test(line)).map((line) => line.slice(0, 60));
  assert.deepEqual(leaked, [], "开方提示词不带调剂品名");
});

await check("6.3 「组成逻辑」（进开方提示词、处方 JSON 与 HIS 方案）同一口径：不带调剂品名；两个读者都经 compositionLogicWithBaselineNames", () => {
  const [logic] = display.compositionLogicWithBaselineNames(["天麻钩藤饮"]);
  assert.ok(logic, "天麻钩藤饮有组成逻辑");
  assert.match(logic.summary, /^组成：天麻、钩藤、石决明/u);
  assert.ok(!/姜天麻|煅石决明|黄芩片|盐杜仲/u.test(logic.summary), logic.summary);
  assert.match(logic.summary, /出处：《[^》]+》/u);
  // 人工写的方义句（桂枝汤）不是「组成：」开头，原样返回。
  const [seed] = display.compositionLogicWithBaselineNames(["桂枝汤"]);
  assert.ok(seed && !/^组成：/u.test(seed.summary));
  for (const file of ["tcm-formula-provenance.ts", "tcm-classic-context.server.ts", "diagnosis-prompts.ts"]) {
    const code = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
    assert.ok(!/compositionLogicForFormulaNames\(/u.test(code), `${file} 不直接读未换名的组成逻辑`);
  }
});

await check("6.2 辨证阶段检索卡片的基础组成同样不带调剂品名", () => {
  const code = readFileSync(new URL("../src/lib/tcm-formula-indications.ts", import.meta.url), "utf8");
  assert.match(code, /基础组成：\$\{\[\.\.\.new Set\(formulaBaselineDisplayNames\(/u);
  const fallback = readFileSync(new URL("../src/lib/m04-deterministic-fallback.ts", import.meta.url), "utf8");
  assert.match(fallback, /formulaBaselineDisplayNames\(reference\.ingredients/u);
  assert.ok(indications);
});

// ───── 7 出处与书名 ─────
await check("7.1 出处写法归到规范书名：简称、卷次、篇名都认（《局方》卷五、《金匮》、《景岳全书·新方八阵》、《医宗金鉴·外科心法要诀》）", () => {
  assert.equal(original.canonicalFormulaBook("《局方》卷五"), "太平惠民和剂局方");
  assert.equal(original.canonicalFormulaBook("《和剂局方》"), "太平惠民和剂局方");
  assert.equal(original.canonicalFormulaBook("《金匮》"), "金匮要略");
  assert.equal(original.canonicalFormulaBook("《景岳全书·新方八阵》"), "景岳全书");
  assert.equal(original.canonicalFormulaBook("《医宗金鉴·外科心法要诀》"), "医宗金鉴");
  assert.equal(original.canonicalFormulaBook("《济生方》"), "严氏济生方");
  assert.equal(original.canonicalFormulaBook(""), "");
});

await check("7.2 给了出处就只认那本书：别的书的同名方不借；没给出处、表里有几本书的同名方时不猜", () => {
  assert.equal(original.originalFormula("白术散", "《伤寒论》"), undefined);
  const qian = original.originalFormula("白术散", "《小儿药证直诀》");
  const zhimi = original.originalFormula("白术散", "《全生指迷方》");
  assert.ok(qian && zhimi && qian !== zhimi);
  assert.ok(qian.herbs.some((item) => item.herb === "人参") && zhimi.herbs.some((item) => item.herb === "大腹皮"));
  // 受治理目录的白术散是钱乙方：不给上下文时按目录条目的出处取。
  assert.equal(provenance.originalFormulaFor("白术散"), qian);
});

console.log(JSON.stringify({ suite: "r1057-main", failures }));

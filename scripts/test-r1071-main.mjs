// 第五十四轮：教材代表方锁不上 → 开方阶段没有组成基准 → 同一份辨证结果每次重抽方名与药味都可能不同（2026-11-21 甲方病历13
// 强制重生成三次：两次「菟丝子散合桑螵蛸散加减」12、11 味，一次「菟丝子散加减」10 味）。教材 1390 个证型里 220 个代表方锁不上，
// 已锁定的同样重抽三次药味逐字相同。按类收口（模型调用一律不发生）：
//  A 同一首方的另一种写法：锁定查找也读目录别名与原方组成表登记的同书异写（葛根芩连汤、麻杏石甘汤、镇肝息风汤、六味地黄汤），只认同一本书；
//  B 目录没收、原方组成表有原书逐字核对的教材代表方：校勘通道补收（ADJ-ORIG-20261121-TEXTBOOK-LOCK），主治取教材该证原文；
//  C 菟丝子散：原书具名，同书另两首同名方组成不同，方的身份按方名＋出处判 → 可锁定；
//  D 同名异方照旧不锁（教材写《金匮翼》的加味四物汤不借目录里《医宗金鉴》那首）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const original = await jiti.import("../src/lib/formula-original-composition.ts");

const check = async (id, title, run) => {
  if (process.env.R1071_CHECK && process.env.R1071_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const data = (name) => JSON.parse(fs.readFileSync(`${root}/src/data/${name}`, "utf8"));
const reference = (name) => provenance.formulaCompilationReferences([name]);

/** 病历用该证的教材典型表现（与辨证阶段锚定同一入口），方向写教材代表方。 */
function lockFor(rowId, direction) {
  const row = textbook.textbookRowById(rowId);
  assert.ok(row, rowId);
  const reasoning = {
    stage: "diagnose",
    overview: { tcmDiseaseName: row.disease, primarySyndrome: row.syndromeName, secondarySyndromes: [], recommendedFormulaDirection: direction ?? `${row.formulas.join("合")}加减` },
    therapy: { overallMethod: row.therapy },
    pathogenesis: { locationDifferentiation: { items: [] }, natureDifferentiation: { items: [] }, chain: [] },
  };
  return provenance.withDeterministicFormulaReferences(reasoning, row.manifestations).overview;
}

// ───── A 同方异写 ─────
await check("A1", "目录别名（麻杏石甘汤）与原方表登记的同书异写（葛根芩连汤、镇肝息风汤、六味地黄汤）都查到同一本书的编译行，基准上记教材的写法", async () => {
  for (const [name, source, size] of [["麻杏石甘汤", "《伤寒论》", 4], ["葛根芩连汤", "《伤寒论》", 4], ["镇肝息风汤", "《医学衷中参西录》", 12], ["六味地黄汤", "《小儿药证直诀》", 6]]) {
    const refs = reference(name);
    assert.equal(refs.length, 1, name);
    assert.equal(refs[0].formulaName, name, `${name} 基准方名应是问的写法`);
    assert.equal(refs[0].source, source, name);
    assert.equal(refs[0].ingredients.length, size, name);
  }
  // 按目录条目名直接查到的仍记条目名（此前的行为）。
  assert.equal(reference("葛根黄芩黄连汤")[0].formulaName, "葛根黄芩黄连汤");
});

await check("A2", "原方表把这个写法登记为别的书里那首方时不认（六磨饮子《世医得效方》≠ 六磨汤《证治准绳》，养脏汤《医宗金鉴》≠ 真人养脏汤《局方》）；目录自己登记的别名照认（东垣清暑益气汤→《脾胃论》那首，不是《温热经纬》那首）", async () => {
  // （汤作丸散、栝蒌/瓜蒌是方名识别本来就认的同方写法，不在此列：柴胡疏肝汤按写法表查到柴胡疏肝散。）
  for (const [name, alias] of [["六磨饮子", "六磨汤"], ["养脏汤", "真人养脏汤"]]) {
    assert.ok(original.originalFormulasNamed(name).some((entry) => (entry.aliases || []).includes(alias)), `前提：原方表把 ${name} 登记了「${alias}」写法`);
    assert.ok(reference(alias).length === 1, `前提：目录有 ${alias}`);
    assert.equal(reference(name).length, 0, name);
  }
  assert.match(reference("东垣清暑益气汤")[0]?.source || "", /脾胃论/u);
  // 几条都对得上时不取：「秦艽白术汤」按写法表既可是秦艽白术丸也可是秦艽白术散，目录两首都收，不替医生选一首。
  assert.equal(reference("秦艽白术丸").length, 1);
  assert.equal(reference("秦艽白术散").length, 1);
  assert.equal(reference("秦艽白术汤").length, 0);
});

await check("A3", "教材证型按写法锁上：泄泻·湿热中阻证锁葛根芩连汤（方向照教材写法），喘证·表寒肺热证锁麻杏石甘汤", async () => {
  const gegen = lockFor("neike|泄泻|湿热中阻");
  assert.deepEqual(gegen.recommendedFormulaNames, ["葛根芩连汤"]);
  assert.equal(gegen.recommendedFormulaDirection, "葛根芩连汤加减");
  assert.equal(gegen.formulaSelectionMode, "single");
  assert.deepEqual(lockFor("neike|喘证|表寒肺热").recommendedFormulaNames, ["麻杏石甘汤"]);
});

// ───── B 校勘补收 ─────
const collation = data("tcm-formula-catalog-collation.source.json").entries.filter((entry) => entry.adjudicationRef === "ADJ-ORIG-20261121-TEXTBOOK-LOCK");
const originalRows = data("tcm-formula-original-compositions.source.json").rows;

await check("B1", "补收的每一条：组成就是原方组成表同名同书那一条的药味（不多不少不改名），出处与原文网址取自那一条，主治取教材该证原文", async () => {
  assert.ok(collation.length >= 60, `补收 ${collation.length}`);
  // 教材行按运行时读入的写法（OCR 错字已按闭集改回：苓连二母丸→芩连二母丸、桑螺蛸→桑螵蛸）。
  const tableRows = [...data("tcm-textbook-syndrome-formula-table.json").rows, ...(data("tcm-textbook-syndrome-supplement.source.json").rows || [])]
    .map((item) => textbook.textbookRowById(item.id)).filter(Boolean);
  for (const entry of collation) {
    const book = entry.source.replace(/^《|》$/gu, "");
    const row = originalRows.find((item) => (item.name === entry.name || (item.aliases || []).includes(entry.name)) && item.book === book && item.tier === "original_text");
    assert.ok(row, `${entry.name} 在原方表里找不到《${book}》原文条目`);
    assert.deepEqual(entry.ingredients, [...new Set(row.ingredients.map((item) => item.herb))], entry.name);
    assert.ok(row.evidence.some((item) => item.url === entry.evidenceUrl), entry.name);
    assert.equal(entry.properNameInSource, true);
    assert.equal(entry.administration, "internal");
    assert.ok(entry.indications.length > 0, entry.name);
    for (const indication of entry.indications) {
      const match = indication.match(/^《([^》]+)》([^·]+)·([^（]+)（教材代表方）：(.+)$/u);
      assert.ok(match, `${entry.name} 主治写法 ${indication}`);
      assert.ok(tableRows.some((item) => item.disease === match[2] && (item.syndromeName || item.syndrome) === match[3] && item.manifestations.trim() === match[4] && item.formulas.includes(entry.name)), `${entry.name} 主治不是教材该证原文：${indication}`);
    }
  }
});

await check("B2", "目录里已有同一本书、组成相同的条目时不另收（镇肝息风汤/镇肝熄风汤、六味地黄汤/丸、王氏清暑益气汤/清暑益气汤），改在原方表登记同书异写", async () => {
  const names = new Set(collation.map((entry) => entry.name));
  for (const name of ["镇肝息风汤", "六味地黄汤", "王氏清暑益气汤", "生铁落饮", "栝蒌薤白半夏汤"]) assert.ok(!names.has(name), name);
  const linked = (name, book, alias) => originalRows.some((row) => row.name === name && row.book === book && (row.aliases || []).includes(alias));
  assert.ok(linked("镇肝息风汤", "医学衷中参西录", "镇肝熄风汤"));
  assert.ok(linked("六味地黄汤", "小儿药证直诀", "六味地黄丸"));
  assert.ok(linked("王氏清暑益气汤", "温热经纬", "清暑益气汤"));
});

await check("B3", "补收的教材代表方能锁：咳嗽·痰湿蕴肺证锁二陈平胃散合三子养亲汤（合方两首都在），口疮·心火上炎证锁泻心导赤散", async () => {
  const cough = lockFor("neike|咳嗽|痰湿蕴肺");
  assert.deepEqual(cough.recommendedFormulaNames, ["二陈平胃散", "三子养亲汤"]);
  assert.equal(cough.formulaSelectionMode, "combined");
  assert.deepEqual(lockFor("erke|口疮|心火上炎").recommendedFormulaNames, ["泻心导赤散"]);
});

// ───── C 菟丝子散 ─────
await check("C1", "遗尿·下元虚寒证锁菟丝子散合桑螵蛸散（甲方病历13）；菟丝子散基准是《太平圣惠方》卷五十八这一首", async () => {
  const overview = lockFor("erke|遗尿|下元虚寒");
  assert.deepEqual(overview.recommendedFormulaNames, ["菟丝子散", "桑螵蛸散"]);
  assert.equal(overview.formulaSelectionMode, "combined");
  assert.equal(overview.recommendedFormulaDirection, "菟丝子散合桑螵蛸散加减");
  const refs = reference("菟丝子散");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].source, "《太平圣惠方》卷五十八");
  assert.deepEqual([...refs[0].ingredients].sort(), ["五味子", "牡蛎", "肉苁蓉", "菟丝子", "附子", "鸡内金"].sort());
});

// ───── D 同名异方 ─────
await check("D1", "教材里同一方名在别的证型下引另一本书时不补收（加味四物汤：血虚头痛引《金匮翼》，产后引《医宗金鉴》，医宗金鉴那首是产后淋闭方）：甲方标准病例3 血虚头痛仍按教材方名、出处写《金匮翼》", async () => {
  assert.ok(!collation.some((entry) => entry.name === "加味四物汤"));
  assert.equal(reference("加味四物汤").length, 0);
  const overview = lockFor("neike|头痛|血虚头痛");
  assert.deepEqual(overview.recommendedFormulaNames, []);
  assert.equal(overview.recommendedFormulaDirection, "加味四物汤加减");
  const row = textbook.textbookRowById("neike|头痛|血虚头痛");
  assert.match(provenance.textbookFormulaOriginalSource("加味四物汤", row.composition) || "", /金匮翼/u);
});

// ───── F 同一件事两处各写：单字病名、方名写法 ─────
await check("F1", "单字病名（疖、痈、疣、癣）按精确同名查得到教材行：疖·热毒蕴结证锁五味消毒饮，痈·火毒凝结证锁仙方活命饮；单字不做包含匹配", async () => {
  assert.equal(textbook.textbookRowForSyndrome("疖", "热毒蕴结证")?.id, "waike|疖|热毒蕴结证");
  assert.ok(textbook.textbookFormulaRowsForDisease("痈").length >= 3);
  assert.deepEqual(lockFor("waike|疖|热毒蕴结证").recommendedFormulaNames, ["五味消毒饮"]);
  assert.deepEqual(lockFor("waike|痈|火毒凝结证").recommendedFormulaNames, ["仙方活命饮"]);
  // 「疮」不是节名：单字不按包含去找「疮疡」「口疮」。
  assert.equal(textbook.textbookFormulaRowsForDisease("疮").length, 0);
});

await check("F2", "方名识别、主治覆盖、教材代表方判断与编译行查找用同一张写法表：教材「知柏地黄汤」认作目录「知柏地黄丸」也判覆盖本病并锁定，「瓜蒌牛蒡汤」不因名录写「栝蒌」锁不上", async () => {
  const spellings = await jiti.import("../src/lib/formula-name-spellings.ts");
  assert.ok(spellings.sameFormulaNameSpelling("知柏地黄汤", "知柏地黄丸"));
  assert.ok(spellings.sameFormulaNameSpelling("栝蒌薤白半夏汤加减", "瓜蒌薤白半夏汤"));
  assert.ok(!spellings.sameFormulaNameSpelling("四妙汤", "四物汤"));
  assert.ok(lockFor("waike|瘰疬|阴虚火旺证").recommendedFormulaNames.length === 1);
  assert.ok(lockFor("waike|乳痈|肝胃郁热证").recommendedFormulaNames.length === 1);
  assert.equal(reference("栝蒌牛蒡汤").length, 1);
});

await check("F3", "按同方异写认到另一剂型的编译行时（十全大补丸 → 目录《局方》十全大补汤），方义「加X」核对的基准不收汤剂的煎服药引（生姜、大枣）", async () => {
  assert.equal(reference("十全大补丸")[0]?.source, "《太平惠民和剂局方》");
  assert.ok(reference("十全大补丸")[0].ingredients.includes("大枣"), "前提：目录十全大补汤列了大枣");
  const base = provenance.formulaEditClaimBaseIngredients("十全大补丸");
  assert.ok(base.includes("黄芪") && base.includes("肉桂"), JSON.stringify(base));
  assert.ok(!base.includes("大枣"), JSON.stringify(base));
});

await check("F4", "借同方另一剂型取出处时只认目录条目本名：内伤发热·气郁发热「加味逍遥散」不经「加味逍遥饮」（原方表里是《审视瑶函》暴盲方的写法）借到眼科那首，出处仍是《内科摘要》", async () => {
  const row = textbook.textbookRowForSyndrome("内伤发热", "气郁发热");
  assert.ok(row.formulas.includes("加味逍遥散"));
  assert.equal(provenance.textbookFormulaOriginalSource("加味逍遥散", row.composition), "《内科摘要》");
});

await check("F5", "教材行没有分方组成时，合方里按同方异写才认到目录的那首方的药照样补进教材基准（痛风·湿热阻痹「四妙散合宣痹汤」：四妙散→目录四妙丸，含苍术）；按名字直接查到的方不补（荆防败毒散只用教材组成）", async () => {
  const caution = await jiti.import("../src/lib/herb-record-caution.ts");
  const row = textbook.textbookRowForSyndrome("痛风", "湿热阻痹");
  const base = caution.textbookBaseIngredients(row, ["四妙散"]);
  for (const herb of ["苍术", "牛膝", "薏苡仁"]) assert.ok(base.includes(herb), `${herb} in ${base.join("、")}`);
  const sense = textbook.textbookRowForSyndrome("感冒", "风寒束表证");
  assert.deepEqual(caution.textbookBaseIngredients(sense, ["荆防败毒散"]), [...sense.composition]);
});

// ───── E 棘轮 ─────
await check("E1", "教材证型（病历=该证典型表现）锁上代表方的行数不回退：第五十四轮前 1170，本轮 ≥1270", async () => {
  const table = data("tcm-textbook-syndrome-formula-table.json");
  const supplement = data("tcm-textbook-syndrome-supplement.source.json");
  let locked = 0;
  for (const id of new Set([...table.rows, ...(supplement.rows || [])].map((row) => row.id))) {
    const row = textbook.textbookRowById(id);
    if (!row?.formulas?.length || !["single", "combined", "alternative"].includes(row.formulaJoin)) continue;
    const overview = lockFor(id, `${row.formulas.join(row.formulaJoin === "alternative" ? "或" : "合")}加减`);
    if ((overview.recommendedFormulaNames || []).length >= (row.formulaJoin === "alternative" ? 1 : row.formulas.length)) locked += 1;
  }
  assert.ok(locked >= 1270, `锁上 ${locked}`);
});

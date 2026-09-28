import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

// 目录功效补全与治法对齐（2026-09-28）：
//  · 2,969 首里原本只有 545 首有 functions；《方剂学》教材【功用】给功效为空、且能确认是同一张方
//    （出处书名一致或组成 ≥60% 重合）的条目补上，记 functionsSource；
//  · 对齐判据：同一受控治法或编号上下位（同一支系，上位 ≥3 级）算正面对齐，同族兄弟不算；
//  · 教材补全的功效只作正面证据，对不上时退回「功效为空」的旧判法。
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const governance = await jiti.import("../src/lib/clinical-governance-tables.ts");
const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8")).entries;
const textbook = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-textbook-functions.json", import.meta.url), "utf8"));

const failures = [];
let checks = 0;
const check = (name, fn) => { checks++; try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };
const compact = (value) => String(value || "").replace(/\s+/g, "");

check("the textbook extraction covers the textbook's main formulas and carries its provenance", () => {
  assert.ok(textbook.counts.main >= 220, `main formulas ${textbook.counts.main}`);
  assert.ok(/^[0-9a-f]{64}$/.test(textbook.source.sha256));
  const byName = (name) => textbook.entries.find((entry) => entry.name === name);
  assert.deepEqual(byName("完带汤")?.functions, ["补脾疏肝", "化湿止带"]);
  assert.deepEqual(byName("麻黄汤")?.functions, ["发汗解表", "宣肺平喘"]);
  assert.deepEqual(byName("六味地黄丸")?.aliases, ["地黄丸"], "「（原名地黄丸）」进别名");
});

check("every textbook fill is the same formula (source book or ≥60% composition) and never overwrites standard functions", () => {
  const curated = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-curated-functions.source.json", import.meta.url), "utf8")).rows;
  const filled = catalog.filter((entry) => entry.functionsSource && entry.functionsSource.match !== "curated_row");
  assert.ok(filled.length >= 140, `filled ${filled.length}`);
  // 联网核对行：方名与目录出处逐字对上才补，来源 URL 随条目保存。
  for (const entry of catalog.filter((item) => item.functionsSource?.match === "curated_row")) {
    const row = curated.find((candidate) => candidate.name === entry.name && compact(candidate.source) === compact(entry.source));
    assert.ok(row, `${entry.name}: curated row missing`);
    assert.deepEqual(entry.functions, row.functions);
    assert.match(String(entry.functionsSource.reference?.url || ""), /^https?:\/\//, `${entry.name}: curated fill must carry its source URL`);
    assert.ok(["matches", "partial"].includes(row.compositionCheck), `${entry.name}: composition must have been checked`);
  }
  for (const entry of filled) {
    assert.equal(entry.standardCode, undefined, `${entry.name}: standard functions must not be overwritten`);
    const rows = textbook.entries.filter((row) => row.name === entry.name || (row.aliases || []).includes(entry.name) ||
      (entry.aliases || []).includes(row.name));
    const row = rows.find((candidate) => candidate.source === entry.functionsSource.textbookSource);
    assert.ok(row, `${entry.name}: textbook row missing`);
    assert.deepEqual(entry.functions, row.functions);
    if (entry.functionsSource.match === "source_book") {
      const book = compact(row.source).replace(/[《》]/g, "");
      assert.ok(compact(entry.source).includes(book) || book.includes(compact(entry.source).replace(/[《》。]/g, "")), `${entry.name}: book mismatch`);
    } else {
      assert.equal(entry.functionsSource.match, "composition_overlap");
      const ingredients = entry.ingredients.map(compact).filter(Boolean);
      const present = ingredients.filter((name) => compact(row.composition).includes(name)).length;
      assert.ok(ingredients.length >= 2 && present >= 2 && present / ingredients.length >= 0.6, `${entry.name}: composition ${present}/${ingredients.length}`);
    }
  }
  for (const name of ["完带汤", "茵陈蒿汤", "归脾汤", "厚朴温中汤"]) {
    assert.ok(catalog.find((entry) => entry.name === name)?.functions?.length, `${name} must now carry functions`);
  }
  // 同名异方不补：同名但出处与组成都对不上的条目保持功效为空。
  const sameNameUnfilled = catalog.filter((entry) => !entry.functions?.length && textbook.entries.some((row) => row.name === entry.name));
  assert.ok(sameNameUnfilled.length >= 1, "at least one same-name-different-formula entry is left unfilled");
});

check("alignment: same controlled method or ancestor/descendant lineage; siblings and broad categories do not count", () => {
  const method = (text) => governance.governedTreatmentMethodsInText(text)[0];
  const dampness = method("化湿");
  const leukorrhea = method("除湿止带");
  assert.equal(governance.treatmentMethodsShareLineage(dampness, leukorrhea), true, "化湿 4.9.1 ⊃ 除湿止带 4.9.1.1.4.1");
  assert.equal(governance.treatmentMethodsShareLineage(method("补气"), method("补血")), false, "补气 and 补血 are siblings, not one direction");
  assert.equal(governance.treatmentMethodsShareLineage(method("清心利湿"), method("清热利湿")), false, "导赤散 vs 阳黄 stays apart");
  const signed = indications.signedTherapyMethodIds({ therapy: { overallMethod: "健脾益气，升阳除湿止带" } });
  assert.equal(indications.formulaFunctionsPositivelyAligned(["补脾疏肝", "化湿止带"], signed), true);
  // 教材功效对不上号：不作否决（退回功效为空），但也不算正面证据。
  const heartSpleen = indications.signedTherapyMethodIds({ therapy: { overallMethod: "补益心脾，养心安神" } });
  assert.equal(indications.formulaFunctionsPositivelyAligned(["益气补血", "健脾养心"], heartSpleen), false);
  assert.equal(indications.formulaTherapyAlignedWithSigned(["益气补血", "健脾养心"], heartSpleen, "supplementary"), true);
  assert.equal(indications.formulaTherapyAlignedWithSigned(["益气补血", "健脾养心"], heartSpleen), false, "the same misalignment still vetoes standard functions");
});

check("trust: 完带汤 is kept for 带下/脾虚湿盛 cases; 导赤散 is still dropped for 阳黄", () => {
  const reasoning = (syndrome, method, name) => ({ overview: { recommendedFormulaDirection: `${name}加减`, primarySyndrome: syndrome, primarySyndromeResolution: "bounded" }, therapy: { overallMethod: method } });
  const trusted = (syndrome, method, name) => indications.trustedModelFormulaIdentityNames(reasoning(syndrome, method, name), [name]).size > 0;
  assert.equal(trusted("脾虚湿盛证", "健脾益气，化湿止带", "完带汤"), true, "名医原方完带汤：此前因证候标注反证被剥");
  assert.equal(trusted("肝郁脾虚，湿浊带下证", "疏肝健脾，化湿止带", "完带汤"), true);
  assert.equal(trusted("湿热黄疸证", "清热利湿退黄", "茵陈蒿汤"), true);
  assert.equal(trusted("心脾两虚证", "补益心脾，养心安神", "归脾汤"), true);
  assert.equal(trusted("湿热内蕴证", "清热利湿退黄，通腑泄热", "导赤散"), false);
});

console.log(JSON.stringify({ suite: "formula-textbook-functions", checks, failures }, null, 1));
assert.equal(failures.length, 0);

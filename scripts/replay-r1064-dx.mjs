import fs from "node:fs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
const { withDeterministicFormulaReferences, textbookFormulaOriginalSource, identifyKnownFormulaNames } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { clinicalGroundingText, activeBleedingInGroundingText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { herbBarredForCase } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { textbookRowForSyndrome } = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const { textbookRowFormulaBook, textbookCitedFormulaBooks, canonicalFormulaBook } = await jiti.import("../src/lib/formula-original-composition.ts");
const guidelineModule = process.argv.includes("--new") ? await jiti.import("../src/lib/western-guideline-references.ts") : undefined;
const base = "/home/coder/runlogs/r1018/work/r1063/out";
const rows = [];
for (const set of ["p100c", "new40", "new45", "retest"]) {
 for (const name of fs.readdirSync(`${base}/${set}-r46c`).filter(x => x.endsWith(".r1.json")).sort()) {
  const raw = JSON.parse(fs.readFileSync(`${base}/${set}-r46c/${name}`, "utf8"));
  const state = normalizeCaseStateInput(raw.input);
  const d = raw.diagnose?.structured;
  const p = raw.prescribe?.structured;
  if (!d) throw new Error(`${name}: missing reasoning`);
  const recordText = clinicalGroundingText(state);
  const out = projectDeliveredReasoning(withDeterministicFormulaReferences(d, recordText, state.tcmLineagePreference, { activeBleeding: activeBleedingInGroundingText(recordText), barredHerb: herb => herbBarredForCase(herb, recordText) }), { recordText, patientSex: state.patient?.sex, herbBoundaryAudience: { ageYears: state.patient?.age } });
  const tr = textbookRowForSyndrome(d.overview?.tcmDiseaseName || "", d.overview?.primarySyndrome || "");
  const projectedPrescription = p ? projectDeliveredReasoning(p, { recordText, patientSex: state.patient?.sex, herbBoundaryAudience: { ageYears: state.patient?.age } }) : undefined;
  // 对无 formulaNames 的加减方同样扫出处，保留具体教材行与同名异书的差别供人工复核。
  const sources = (projectedPrescription?.formula?.candidates || []).map(c => {
   const names = [...new Set([...(c.formulaNames || []), ...(c.baseFormulas || []).map(x => x.name), ...identifyKnownFormulaNames(c.name || "")])];
   const sourceFor = f => c.baseFormulas?.find(x => x.name === f)?.source || String(c.formulaSource?.source || "").split(/[；;]/u).find(part => part.trim().startsWith(`${f}：`)) || c.formulaSource?.source;
   return { name: c.name, source: c.formulaSource?.source, formulaNames: c.formulaNames, baseFormulas: c.baseFormulas,
    books: names.map(f => ({ formula: f, textbook: tr ? textbookRowFormulaBook(tr.id, f) : "", textbookBooks: textbookCitedFormulaBooks(f), delivered: sourceFor(f), deliveredBook: canonicalFormulaBook(sourceFor(f) || ""), current: textbookFormulaOriginalSource(f, (c.herbs || []).map(x => x.name), { textbookRowId: tr?.id }) })) };
  });
  rows.push({ file: `${set}-${name}`, overview: out.overview, method: out.therapy?.overallMethod, sources, western: d.westernDiagnosis?.primary ? { ...d.westernDiagnosis.primary, ...(guidelineModule ? { guidelineReferences: guidelineModule.finalWesternGuidelineReferences(d.westernDiagnosis.primary.name, d.westernDiagnosis.primary.guidelineReferences || []) } : {}) } : undefined });
 }
}
fs.writeFileSync(process.argv[2], JSON.stringify(rows, null, 2), { mode: 0o600 });
fs.chmodSync(process.argv[2], 0o600);
console.log(`replayed ${rows.length}: ${process.argv[2]}`);

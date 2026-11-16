// 离线重放检索与分型；不调用模型，不修改归档。用 --root 指定修改前快照。
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
const root = process.argv.find((x) => x.startsWith("--root="))?.slice(7) || process.cwd();
const output = process.argv.find((x) => x.startsWith("--out="))?.slice(6);
if (!output) throw new Error("--out is required (patient records stay outside the repository)");
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const t = await jiti.import(`${root}/src/lib/tcm-textbook-syndromes.ts`);
const types = await jiti.import(`${root}/src/lib/diagnosis-types.ts`);
const safety = await jiti.import(`${root}/src/lib/diagnosis-safety.ts`);
const results = [];
for (const [round, base, suffix, sets] of [
  ["r46c", "/home/coder/runlogs/r1018/work/r1063/out", "r46c", ["p100c", "new40", "new45", "retest"]],
  ["r47h", "/home/coder/runlogs/r1018/work/r1064/out", "r47h", ["p100c", "new40", "new45", "retest", "new47"]],
]) for (const set of sets) {
  const dir = path.join(base, `${set}-${suffix}`);
  for (const file of fs.readdirSync(dir).filter((x) => x.endsWith(".r1.json")).sort()) {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const state = types.normalizeCaseStateInput(saved.input);
    const recordText = safety.trustedInputText(state);
    const overview = saved.diagnose?.structured?.overview || {};
    const disease = overview.tcmDiseaseName || "";
    const input = { chiefComplaint: state.chiefComplaint, presentHistory: Object.values(state.symptoms || {}).filter((x) => typeof x === "string").join("。"), recordText, tongue: state.tongue, pulse: state.pulse, sex: state.patient?.sex, ageYears: state.patient?.age };
    const preferred = t.splitTextbookDiseaseSubtype(disease).disease;
    results.push({ round, set, id: saved.key || file, disease,
      subtype: t.diseaseNameWithRecordSubtype(disease, recordText),
      fallback: t.textbookCandidatesForCase(input).map((x) => ({ disease: x.disease, rows: x.rows.map((r) => r.id) })),
      retainedPick: t.textbookCandidatesForCase({ ...input, preferredDiseases: preferred ? [preferred] : [] }).map((x) => ({ disease: x.disease, rows: x.rows.map((r) => r.id) })),
    });
  }
}
fs.writeFileSync(output, `${JSON.stringify(results, null, 1)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ records: results.length, output }));

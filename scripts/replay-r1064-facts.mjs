// Offline fixed-r46c scan and rejected-rewrite fallback replay. Never calls a model or reads env files.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { scanDeliveryInvariants, DELIVERY_INVARIANT_RULES } = await jiti.import("../src/lib/delivery-invariants.ts");
const { buildDeliveryInvariantGovernance } = await jiti.import("../src/lib/delivery-invariant-governance.ts");
const { buildTrustedRecordIndex } = await jiti.import("../src/lib/delivery-trusted-record.server.ts");
const { analysisMisalignments, withoutMisalignedAnalysis } = await jiti.import("../src/lib/m03-analysis-alignment.server.ts");
const { collectDeliveryText, stableDeliveryJson } = await jiti.import("../src/lib/delivery-text.ts");
const base = "/home/coder/runlogs/r1018/work/r1063/out";
const out = process.argv[2] || "/var/tmp/r1064/facts-replay";
fs.mkdirSync(out, { recursive: true });
const manifest = [], findings = [], changes = [];
const summary = Object.fromEntries(DELIVERY_INVARIANT_RULES.map((rule) => [rule.ruleId, { label: rule.label, violations: 0, cases: new Set(), unknown: 0, unknownCases: new Set() }]));
let count = 0, rejectedChangedCases = 0;
for (const [group, expected] of [["p100c", 100], ["new40", 40], ["new45", 40], ["retest", 20]]) {
  const dir = path.join(base, `${group}-r46c`);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".r1.json")).sort();
  if (files.length !== expected) throw new Error(`${group}: ${files.length} != ${expected}`);
  for (const name of files) {
    const file = path.join(dir, name), bytes = fs.readFileSync(file), data = JSON.parse(bytes);
    const caseId = `${group}-${name.replace(/\.r1\.json$/u, "")}`;
    count++;
    manifest.push({ caseId, file, sha256: createHash("sha256").update(bytes).digest("hex") });
    const m03 = data.diagnose?.structured, m04 = data.prescribe?.structured;
    const recordIndex = buildTrustedRecordIndex(data.input || {});
    const input = { m03, m04, recordIndex };
    const governedContext = buildDeliveryInvariantGovernance({ ...input, recordText: recordIndex.sources.filter((source) => source.role !== "history" && source.role !== "mixed").map((source) => source.text).join("\n"), ageYears: recordIndex.ageYears });
    // Historical artifacts have no typed deterministic circulation reason code. The saved semantic shock category is a shadow candidate only.
    if (data.redFlags?.semanticTriage?.evidence?.some((entry) => entry.category === "shock")) governedContext.circulationRisk = { triggered: true, reasonCodes: ["legacy_semantic_shock_unconfirmed"], authority: "saved semanticTriage.category; deterministic reason code unavailable" };
    const rows = scanDeliveryInvariants({ ...input, governedContext });
    for (const row of rows) {
      findings.push({ caseId, ...row });
      const stat = summary[row.ruleId];
      if (row.status === "violation") { stat.violations++; stat.cases.add(caseId); }
      else { stat.unknown++; stat.unknownCases.add(caseId); }
    }
    const issues = analysisMisalignments(m03 || {}, recordIndex.sources.map((source) => source.text).join("\n"));
    if (issues.length) {
      const next = withoutMisalignedAnalysis(m03, recordIndex.sources.map((source) => source.text).join("\n"));
      if (stableDeliveryJson(m03) !== stableDeliveryJson(next)) rejectedChangedCases++;
      const occurrenceKey = (root, unit) => unit.path.replace(/^\/pathogenesis\/chain\/(\d+)/u, (_whole, index) => `/pathogenesis/chain/@${root.pathogenesis.chain[Number(index)].nodeId || index}`)
        .replace(/^\/pathogenesis\/uncertainties\/(\d+)/u, (_whole, index) => `/pathogenesis/uncertainties/@${createHash("sha256").update(root.pathogenesis.uncertainties[Number(index)].item || "").digest("hex").slice(0,12)}`);
      const after = new Map(collectDeliveryText(next).map((unit) => [occurrenceKey(next, unit), unit]));
      for (const before of collectDeliveryText(m03)) {
        const key = occurrenceKey(m03, before), remaining = after.get(key);
        if (remaining?.text === before.text) continue;
        changes.push({ caseId, path: before.path, occurrenceKey: key, before: before.text, after: remaining?.text ?? null,
          kind: !remaining && key.includes("/chain/@") ? "deleted_node" : !remaining && key.includes("/uncertainties/@") ? "removed_uncertainty"
            : before.path.includes("/natureDifferentiation/") ? "nature_item_or_resolution" : remaining?.text === "" ? "cleared_required_prose" : "sentence_cut",
          issues: issues.map((issue) => issue.code) });
      }
    }
  }
}
const table = Object.fromEntries(Object.entries(summary).map(([rule, stat]) => [rule, { ...stat, cases: stat.cases.size, unknownCases: stat.unknownCases.size }]));
const sampled = Object.fromEntries(DELIVERY_INVARIANT_RULES.map(({ ruleId }) => [ruleId, findings.filter((finding) => finding.ruleId === ruleId).slice(0, 3)]));
for (const [name, value] of Object.entries({ manifest, findings, changes, samples: sampled, summary: { count, rules: table, rejectedRewriteReplay: { changedCases: rejectedChangedCases, changedTextLeaves: changes.length, actionCounts: Object.fromEntries([...new Set(changes.map((row) => row.kind))].map((kind) => [kind, changes.filter((row) => row.kind === kind).length])), scope: "hypothetical rejected/unavailable branch only, not live model rewrite acceptance", classifications: Object.fromEntries([...new Set(changes.map((row) => row.path.split("/").slice(0, 3).join("/")))].map((key) => [key, changes.filter((row) => row.path.startsWith(key)).length])) }, standaloneScannerMutations: 0, modelCalls: 0 } })) fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(value, null, 2));
console.log(JSON.stringify({ count, rules: table, rejectedChangedCases, changedTextLeaves: changes.length, out }, null, 2));

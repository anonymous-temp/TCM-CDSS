import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { parseMedicationLabelUsage } = await jiti.import("../src/lib/medication-label-usage.ts");

assert.deepEqual(
  parseMedicationLabelUsage("口服，一次3～5克，一日2～3次，饭前或空腹时服。"),
  {
    route: "口服",
    singleDose: "一次3～5克",
    frequency: "一日2～3次",
    administrationTiming: "饭前或空腹时服",
  },
);
assert.deepEqual(
  parseMedicationLabelUsage("口服。一次6～9克(1-1.5袋)，一日2～3次。"),
  { route: "口服", singleDose: "一次6～9克(1-1.5袋)", frequency: "一日2～3次" },
);
assert.equal(parseMedicationLabelUsage("口服，每日2次").course, undefined);
assert.equal(parseMedicationLabelUsage("口服，一次1袋，一日2次，疗程7日").course, "疗程7日");
assert.deepEqual(parseMedicationLabelUsage(""), {});
const compilerSource = readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
assert.doesNotMatch(compilerSource, /course:\s*["']本候选不形成疗程医嘱/);
assert.match(clientSource, /item\.administrationTiming/);

console.log(JSON.stringify({ suite: "medication-label-usage", cases: 7, failures: 0 }));

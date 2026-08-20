import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

process.env.CDSS_DRUG_INVENTORY_PATH = mkdtempSync(join(tmpdir(), "cdss-customer-candidates-"));
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { retrieveLocalPatentMedicineCandidates } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { planEvidenceBoundMedicineCandidates } = await jiti.import("../src/lib/medicine-candidate-planner.server.ts");
const { importDrugInventory, resetDrugInventoryCacheForTests } = await jiti.import("../src/lib/drug-inventory.server.ts");

const caseState = {
  id: "tenant-medicine-candidate",
  phase: "prescribe",
  patient: { sex: "女", age: 45 },
  chiefComplaint: "失眠多梦伴心悸半年",
  symptoms: {},
  conversation: [],
  reasoningDiagnose: {
    overview: { primarySyndrome: "心脾两虚证", primarySyndromeBasis: ["心悸", "多梦"] },
    westernDiagnosis: { primary: { name: "失眠障碍", supportingFacts: ["多梦"] } },
  },
};
const first = retrieveLocalPatentMedicineCandidates(caseState, 10)[0];
assert.ok(first?.name, "fixture must retrieve a governed local medicine");

await importDrugInventory("hospital-A", { items: [{ name: first.name, kind: "patent", available: true, goodsId: "A-GOODS-ID" }] });
await importDrugInventory("hospital-B", { items: [{ name: "其他院内药", kind: "patent", available: true, goodsId: "B-GOODS-ID" }] });
resetDrugInventoryCacheForTests();

const a = await planEvidenceBoundMedicineCandidates(caseState, "hospital-A");
const b = await planEvidenceBoundMedicineCandidates(caseState, "hospital-B");
const customerWithoutInventory = await planEvidenceBoundMedicineCandidates(caseState, "hospital-without-inventory");
assert.ok(a.candidates.some((item) => item.name === first.name));
assert.ok(!b.candidates.some((item) => item.name === first.name));
assert.doesNotMatch(JSON.stringify(b), /A-GOODS-ID/);
assert.ok(
  customerWithoutInventory.candidates.some((item) => item.name === first.name),
  "客户尚未导入库存时应保留受治理候选，不得把 unknown 误判成非本院药",
);

console.log(JSON.stringify({ suite: "customer-medicine-candidates", candidate: first.name, failures: 0 }));

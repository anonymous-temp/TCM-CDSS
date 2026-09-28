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
const retrieved = retrieveLocalPatentMedicineCandidates(caseState, 10);
const first = retrieved[0];
assert.ok(first?.name, "fixture must retrieve a governed local medicine");
const second = retrieved.slice(1).find((item) => item.score >= 3);
assert.ok(second?.name, "fixture must retrieve a second relevant local medicine");

await importDrugInventory("hospital-A", { items: [{ name: first.name, kind: "patent", available: true, goodsId: "A-GOODS-ID" }] });
await importDrugInventory("hospital-B", { items: [{ name: "其他院内药", kind: "patent", available: true, goodsId: "B-GOODS-ID" }] });
await importDrugInventory("hospital-C", { items: [{ name: second.name, kind: "patent", available: true, goodsId: "C-GOODS-ID" }] });
// 只同步了饮片的诊所（生产 2026-09-28：105 份库存里 100 份只有饮片）。
await importDrugInventory("hospital-D", { items: [{ name: "黄芪", kind: "herb" }, { name: "当归", kind: "herb" }] });
resetDrugInventoryCacheForTests();

const a = await planEvidenceBoundMedicineCandidates(caseState, "hospital-A");
const b = await planEvidenceBoundMedicineCandidates(caseState, "hospital-B");
const c = await planEvidenceBoundMedicineCandidates(caseState, "hospital-C");
const d = await planEvidenceBoundMedicineCandidates(caseState, "hospital-D");
const customerWithoutInventory = await planEvidenceBoundMedicineCandidates(caseState, "hospital-without-inventory");
assert.ok(a.candidates.some((item) => item.name === first.name));
// 2026-09-28 起库存只是参考（甲方）：院内没有的中成药**不再删除**，出方时标「库存外用药」。
// 此前这里断言 B 拿不到该药——那正是「只同步了饮片的诊所拿不到任何中成药」这一线上缺陷的来源。
assert.ok(b.candidates.some((item) => item.name === first.name),
  "院内没有的中成药照常推荐（标库存外用药），不得删除");
assert.doesNotMatch(JSON.stringify(b), /A-GOODS-ID/, "客户之间的院内商品号互不可见");
assert.doesNotMatch(JSON.stringify(a), /C-GOODS-ID/);
// 院内有货的排前面：C 只有第二候选有货，兜底首选（规划模型不可用时）必须是它。
assert.equal(c.candidates[0]?.name, second.name, "院内有货的中成药应优先推荐");
assert.equal(a.candidates[0]?.name, first.name);
assert.ok(d.candidates.some((item) => item.name === first.name),
  "只同步了饮片的诊所不得因此失去中成药推荐");
assert.ok(
  customerWithoutInventory.candidates.some((item) => item.name === first.name),
  "客户尚未导入库存时应保留受治理候选，不得把 unknown 误判成非本院药",
);

console.log(JSON.stringify({ suite: "customer-medicine-candidates", candidate: first.name, inStockPreferred: second.name, failures: 0 }));

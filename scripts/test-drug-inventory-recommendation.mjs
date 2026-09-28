// 库存与推药来源（甲方 2026-09-28）。
//
// 需求原话：客户可能没有中药，没有时调接口不要报错，推药用 AI 推的；推药优先客户库房的药，
// 没有再用我们自己的库、EviMed 或 AI 推的；同步药品不阻塞推理，药品只是参考。
//
// 生产实测（2026-09-28）暴露的缺陷，本套件逐条钉住：
//   ① 105 份库存里 100 份只有饮片：规划器把「不在库存里」的中成药/西药**删掉**，这些诊所拿不到
//      任何中成药和西药推荐；只同步中成药的客户，每味饮片被标缺货、替代为空。
//   ② 空清单 400、kind 写「中药/中成药」400、available 写 1/0 400——「不要报错」。
//   ③ 55 家真实诊所 24,485 条饮片名只有 63% 对得上标准名（「（免）川牛膝」「甘草片」「煅龙骨」），
//      对不上的有货也被当成缺货。
// 页面/HIS 的库存标签（院内有货 / 缺货 / 库存外用药）是甲方定名，与对外接口文档同名。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createJiti } from "jiti";

const workDir = await mkdtemp(join(tmpdir(), "cdss-inventory-recommendation-"));
process.env.CDSS_DRUG_INVENTORY_PATH = join(workDir, "drug-inventory");
process.env.CDSS_TENANT_AUDIT_PATH = join(workDir, "tenant-audit.ndjson");

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const inv = await jiti.import("../src/lib/drug-inventory.server.ts");
const names = await jiti.import("../src/lib/drug-inventory-names.ts");
const route = await jiti.import("../src/app/api/drug-inventory/route.ts");
const availabilityRoute = await jiti.import("../src/app/api/drug-inventory/availability/route.ts");
const planner = await jiti.import("../src/lib/medicine-candidate-planner.server.ts");
const { retrieveLocalPatentMedicineCandidates, LOCAL_PRESCRIPTION_PATENT_MEDICINE_ENTRIES } =
  await jiti.import("../src/lib/local-patent-medicine-candidates.ts");

const failures = [];
let checks = 0;
async function check(name, fn) {
  checks += 1;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

let seq = 0;
const post = (customerId, body) => route.POST(new Request("http://localhost/api/drug-inventory", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": `inv-rec-${String(++seq).padStart(4, "0")}-20260928`,
    "x-cdss-customer-id": customerId,
  },
  body: JSON.stringify(body),
}));

// ── 院内药名清洗（只用于可得性匹配）────────────────────────────────────────
await check("NAME-01 常见 HIS 写法能对上标准名", () => {
  const cases = [
    ["（免）川牛膝", "川牛膝"], ["Y荆芥", "荆芥"], ["Z广藿香", "广藿香"], ["浙贝母/片", "浙贝母"],
    ["茯苓/一等方块", "茯苓"], ["炒酸枣仁（打碎）", "酸枣仁"], ["菊花（杭菊）", "菊花"], ["附片（黑顺片）", "附子"],
    ["甘草片", "甘草"], ["党参段", "党参"], ["当归8", "当归"], ["醋五味子", "五味子"], ["蜜款冬花", "款冬花"],
    ["麸白芍", "白芍"], ["盐杜仲/盐炙", "杜仲"], ["姜厚朴(煮)", "厚朴"], ["K当归(配方颗粒)", "当归"],
    ["干益母草", "益母草"], ["烫狗脊", "狗脊"], ["蒸萸肉", "山茱萸"], ["米炒党参", "党参"], ["人参片", "人参"],
    ["焦六神曲", "六神曲"], ["煅龙骨", "龙骨"], ["白花蛇舌草", "白花蛇舌草"], ["浮小麦", "浮小麦"], ["土鳖虫", "土鳖虫（䗪虫）"],
  ];
  const wrong = cases.filter(([raw, expected]) => names.resolveInventoryHerbName(raw).canonicalName !== expected)
    .map(([raw, expected]) => `${raw}→${names.resolveInventoryHerbName(raw).canonicalName || "∅"}（应为${expected}）`);
  assert.deepEqual(wrong, []);
  assert.equal(names.resolveInventoryHerbName("三七粉").form, "powder");
  assert.equal(names.resolveInventoryHerbName("K当归(配方颗粒)").form, "granule");
});

await check("NAME-02 临床上不能互换的炮制品不归并；歧义名不择一", () => {
  // 制/煅/炭不剥：制何首乌≠何首乌、煅石膏（外用）≠石膏、荆芥炭≠荆芥。
  assert.equal(names.resolveInventoryHerbName("制何首乌").canonicalName, "制何首乌");
  assert.equal(names.resolveInventoryHerbName("煅石膏").canonicalName, "煅石膏");
  assert.equal(names.resolveInventoryHerbName("荆芥炭").canonicalName, "荆芥炭");
  assert.equal(names.resolveInventoryHerbName("炙甘草").canonicalName, "炙甘草");
  assert.equal(names.resolveInventoryHerbName("一包针").status, "ambiguous");
  const test = names.resolveInventoryHerbName("测试中药75601669");
  assert.equal(test.canonicalName, "");
  assert.equal(test.suspect, true);
  assert.equal(names.resolveInventoryHerbName("小青龙颗粒").likelyNotHerb, true);
});

await check("NAME-03 中成药/西药匹配键：去规格与剂型，但不吞掉药名里的数字", () => {
  assert.equal(names.medicineNameKey("阿莫西林胶囊0.25g*24粒"), "阿莫西林胶囊");
  assert.notEqual(names.medicineNameKey("维生素B12片"), names.medicineNameKey("维生素B6片"));
  assert.equal(names.medicineBaseKey("逍遥丸(浓缩丸)"), names.medicineBaseKey("逍遥颗粒"));
  assert.equal(names.medicineBaseKey("奥美拉唑肠溶胶囊"), "奥美拉唑");
});

await check("NAME-04 kind / available 的中文与数字写法", () => {
  assert.equal(names.inventoryKindFromInput("中药").kind, "herb");
  assert.equal(names.inventoryKindFromInput("中成药").kind, "patent");
  assert.equal(names.inventoryKindFromInput("西药").kind, "western");
  assert.equal(names.inventoryKindFromInput("配方颗粒").form, "granule");
  assert.equal(names.inventoryKindFromInput("药品"), undefined);
  assert.equal(names.inventoryAvailableFromInput(1), true);
  assert.equal(names.inventoryAvailableFromInput(0), false);
  assert.equal(names.inventoryAvailableFromInput("否"), false);
  assert.equal(names.inventoryAvailableFromInput(2), undefined);
});

// ── 同步接口：不报错 ─────────────────────────────────────────────────────
await check("SYNC-01 不写类别的空清单：200、不改动现有库存", async () => {
  const first = await post("hosp-empty", { items: [{ name: "黄芪" }] });
  assert.equal(first.status, 200);
  const empty = await post("hosp-empty", { items: [] });
  assert.equal(empty.status, 200, "空清单不得报错");
  const body = await empty.json();
  assert.equal(body.unchanged, true);
  assert.equal(body.itemCount, 1, "空清单不得清空已有库存");
  assert.match(body.note, /kinds/);
});

await check("SYNC-02 从未同步过的客户推空清单：200，且不落任何库存文件", async () => {
  const response = await post("hosp-empty-new", { items: [] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).inventoryLoaded, false);
  assert.equal(await inv.drugInventorySnapshot("hosp-empty-new"), null);
});

await check("SYNC-03 kind/available 常见写法照常导入；无法识别的写法整批拒收并逐条回报", async () => {
  const ok = await post("hosp-alias", {
    items: [
      { name: "黄芪", kind: "中药", available: 1 },
      { name: "逍遥丸", kind: "中成药", available: "是" },
      { name: "奥美拉唑肠溶胶囊", kind: "西药", available: 0 },
    ],
  });
  assert.equal(ok.status, 200);
  const snapshot = await ok.json();
  assert.equal(snapshot.availableHerbCount, 1);
  assert.equal(snapshot.availablePatentCount, 1);
  assert.equal(snapshot.availableWesternCount, 0);
  const bad = await post("hosp-alias", { items: [{ name: "黄芪", kind: "药品" }, { name: "当归", available: 2 }] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).rejectedEntryCount, 2);
});

await check("SYNC-04 kinds：只替换声明的类别；某类为空即声明本院没有这一类药", async () => {
  await post("hosp-kinds", { items: [{ name: "黄芪" }, { name: "当归" }] });
  const patent = await post("hosp-kinds", { kinds: ["patent"], items: [{ name: "逍遥丸", kind: "patent" }] });
  assert.equal(patent.status, 200);
  const afterPatent = await patent.json();
  assert.equal(afterPatent.availableHerbCount, 2, "只推中成药时，饮片不得被整批清掉");
  assert.equal(afterPatent.coverage.herb, "synced");
  assert.equal(afterPatent.coverage.patent, "synced");
  const noHerb = await post("hosp-kinds", { kinds: ["饮片"], items: [] });
  assert.equal(noHerb.status, 200);
  const afterNoHerb = await noHerb.json();
  assert.equal(afterNoHerb.coverage.herb, "declared_none");
  assert.equal(afterNoHerb.availableHerbCount, 0);
  assert.equal(afterNoHerb.availablePatentCount, 1, "声明没有饮片不得影响中成药");
  const outOfScope = await post("hosp-kinds", { kinds: ["patent"], items: [{ name: "黄芪", kind: "herb" }] });
  assert.equal(outOfScope.status, 400, "条目类别超出本批声明的 kinds 要整批拒收");
  const badKinds = await post("hosp-kinds", { kinds: [], items: [] });
  assert.equal(badKinds.status, 400);
  assert.equal((await badKinds.json()).code, "invalid_inventory_kinds");
});

await check("SYNC-05 响应回报疑似测试数据与疑似非饮片条目", async () => {
  const response = await post("hosp-report", {
    items: [{ name: "黄芪" }, { name: "测试中药75601669" }, { name: "小青龙颗粒" }],
  });
  const body = await response.json();
  assert.ok(body.suspectNames.includes("测试中药75601669"));
  assert.ok(body.likelyNonHerbNames.includes("小青龙颗粒"));
  assert.match(body.note, /likelyNonHerbNames/);
});

// ── 库存标签：没同步 ≠ 缺货；名字没认出 ≠ 缺货 ─────────────────────────────
await check("LABEL-01 只同步饮片的诊所：饮片按库存标，中成药/西药标库存外用药（可得性 unknown）", async () => {
  await post("hosp-herb-only", { items: [{ name: "甘草片", goodsId: "G-001" }, { name: "（免）川牛膝" }, { name: "当归", available: false }] });
  const view = await inv.inventoryAvailabilityView("hosp-herb-only");
  const gancao = view.statusOf("甘草", "herb");
  assert.equal(gancao.label, "院内有货", "院内写「甘草片」，处方写「甘草」要判有货");
  assert.equal(gancao.inventoryName, "甘草片");
  assert.equal(gancao.goodsId, "G-001");
  assert.equal(view.statusOf("川牛膝", "herb").label, "院内有货");
  assert.equal(view.statusOf("当归", "herb").label, "缺货");
  assert.equal(view.statusOf("麻黄", "herb").label, "库存外用药");
  const patent = view.statusOf("逍遥丸", "patent");
  assert.equal(patent.label, "库存外用药");
  assert.equal(patent.availability, "unknown", "没同步中成药不能判成缺货");
  assert.match(patent.note, /未同步中成药/);
});

await check("LABEL-02 声明没有饮片：饮片标库存外用药且不列替代；中成药同基础方其他剂型判院内有货并给出院内品名", async () => {
  await post("hosp-no-herb", { kinds: ["herb", "patent"], items: [{ name: "逍遥颗粒", kind: "patent" }] });
  const projection = await inv.drugAvailabilityProjection(
    [{ name: "柴胡" }, { name: "当归" }],
    "hosp-no-herb",
    [{ name: "逍遥丸", type: "中成药" }, { name: "奥美拉唑", type: "西药" }],
  );
  assert.deepEqual(projection.herbAvailability.map((row) => row.label), ["库存外用药", "库存外用药"]);
  assert.match(projection.herbAvailability[0].note, /未配备中药饮片/);
  assert.deepEqual(projection.outOfStock, [], "本院没有饮片时不列替代（院内不存在可替代的有货饮片）");
  const [xiaoyao, omeprazole] = projection.medicineAvailability;
  assert.equal(xiaoyao.label, "院内有货");
  assert.equal(xiaoyao.inventoryName, "逍遥颗粒");
  assert.match(xiaoyao.note, /院内剂型/);
  assert.equal(omeprazole.label, "库存外用药");
  assert.match(projection.inventory.note, /已声明未配备中药饮片/);
});

await check("LABEL-03 未接库存：不给标签，行为与接入前一致", async () => {
  const projection = await inv.drugAvailabilityProjection([{ name: "黄芪" }], "hosp-never", [{ name: "逍遥丸", type: "中成药" }]);
  assert.equal(projection.inventory.loaded, false);
  assert.equal(projection.herbAvailability[0].availability, "unknown");
  assert.equal(projection.herbAvailability[0].label, undefined);
  assert.equal(projection.medicineAvailability[0].label, undefined);
  assert.equal(await inv.buildDrugInventoryPromptContext("hosp-never"), "");
});

await check("LABEL-04 旧库存文件（没有 coverage、导入时对不上正名）读入时按当前规则重算", async () => {
  const customerId = "hosp-legacy";
  const target = inv.drugInventoryPath(customerId);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({
    schemaVersion: "tcm-cdss-drug-inventory-v2",
    customerId,
    inventoryVersion: "legacy-version",
    importedAt: "2026-01-01T00:00:00.000Z",
    source: "legacy",
    itemCount: 1,
    availableHerbCount: 1,
    availablePatentCount: 0,
    availableWesternCount: 0,
    unresolvedNames: ["甘草片"],
    ambiguousNames: [],
    items: [{ name: "甘草片", kind: "herb", canonicalName: "", available: true }],
  }));
  inv.resetDrugInventoryCacheForTests(customerId);
  const view = await inv.inventoryAvailabilityView(customerId);
  assert.equal(view.statusOf("甘草", "herb").label, "院内有货");
  assert.equal(view.coverage.herb, "synced");
  assert.equal(view.coverage.patent, "not_synced");
  assert.equal(view.stale, true, "超过 30 天未更新要标注");
  const snapshot = await inv.drugInventorySnapshot(customerId);
  assert.deepEqual(snapshot.unresolvedNames, [], "重算后不应再回报已能对上的名字");
  assert.ok(await inv.buildDrugInventoryPromptContext(customerId));
});

await check("LABEL-05 页面查询接口：按药名返回标签，未知类别与非法载荷不报 500", async () => {
  await post("hosp-page", { items: [{ name: "黄芪" }, { name: "归脾丸", kind: "patent" }] });
  const response = await availabilityRoute.POST(new Request("http://localhost/api/drug-inventory/availability", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cdss-customer-id": "hosp-page" },
    body: JSON.stringify({ items: [{ name: "黄芪", kind: "herb" }, { name: "归脾丸", kind: "patent" }, { name: "麻黄", kind: "herb" }, { name: "x", kind: "bogus" }] }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.inventoryLoaded, true);
  assert.deepEqual(body.items.map((item) => item.label), ["院内有货", "院内有货", "库存外用药"]);
  const bad = await availabilityRoute.POST(new Request("http://localhost/api/drug-inventory/availability", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cdss-customer-id": "hosp-page" },
    body: JSON.stringify({ items: "黄芪" }),
  }));
  assert.equal(bad.status, 400);
});

// ── AI 提名中成药：核对到说明书才采用 ─────────────────────────────────────────
const plannerCase = {
  id: "ai-patent-case",
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
await check("AI-01 本地说明书目录（含处方中成药）里能核对到、且通过同一套相关性与安全排除的提名才采用", async () => {
  const [otcPool, rxPool] = planner.medicinePlannerTestHooks.retrieveCandidatePools(plannerCase);
  assert.ok(LOCAL_PRESCRIPTION_PATENT_MEDICINE_ENTRIES.length > 4000, "处方中成药目录应已随包生成");
  assert.ok(LOCAL_PRESCRIPTION_PATENT_MEDICINE_ENTRIES.every((entry) => !/注射/.test(entry.name)), "处方目录不得收注射剂");
  const relevant = [...otcPool.slice(10), ...rxPool][0];
  assert.ok(relevant, "fixture 需要至少一个前 10 名之外的相关候选");
  const resolved = await planner.medicinePlannerTestHooks.resolveProposedPatentMedicine(
    { name: relevant.name, correspondingProblem: "心悸" }, 0, "失眠多梦伴心悸半年；心悸；多梦", [otcPool, rxPool]);
  assert.ok(resolved, "本地目录能核对到的提名应被采用");
  assert.match(resolved.candidate.evidenceId, /^LOCAL-INST-5\d\d$/, "规划器追加候选用 5xx 编号，避免与证据段 001–010 撞号");
  assert.match(resolved.record, new RegExp(resolved.candidate.evidenceId));
  assert.match(resolved.record, /条目指纹：sha256:/);
  const injection = await planner.medicinePlannerTestHooks.resolveProposedPatentMedicine(
    { name: "参麦注射液", correspondingProblem: "心悸" }, 1, "失眠多梦伴心悸半年；心悸", [otcPool, rxPool]);
  assert.equal(injection, undefined, "不得提名注射剂");
  const unrelated = await planner.medicinePlannerTestHooks.resolveProposedPatentMedicine(
    { name: relevant.name, correspondingProblem: "膝关节疼痛" }, 1, "失眠多梦伴心悸半年；心悸", [otcPool, rxPool]);
  assert.equal(unrelated, undefined, "对应问题不是本例阳性问题的提名不采用");
  // 本地没有、EviMed 也查不到（测试环境无 EviMed 密钥）：不采用，不编药名。
  const fabricated = await planner.medicinePlannerTestHooks.resolveProposedPatentMedicine(
    { name: "安神补脑宁心颗粒甲", correspondingProblem: "心悸" }, 1, "失眠多梦伴心悸半年；心悸", [otcPool, rxPool]);
  assert.equal(fabricated, undefined, "核对不到说明书的提名不得出现");
});

await check("AI-02 院内有货的处方中成药可进入候选（排在院内缺货/库存外之前）", async () => {
  const rxPool = retrieveLocalPatentMedicineCandidates(plannerCase, 60, undefined, { entries: LOCAL_PRESCRIPTION_PATENT_MEDICINE_ENTRIES });
  const rxRelevant = rxPool.find((item) => item.score >= 3);
  assert.ok(rxRelevant, "fixture 需要一个相关的处方中成药");
  await post("hosp-rx", { kinds: ["patent"], items: [{ name: rxRelevant.name, kind: "patent", goodsId: "RX-1" }] });
  const plan = await planner.planEvidenceBoundMedicineCandidates(plannerCase, "hosp-rx");
  assert.equal(plan.candidates[0]?.name, rxRelevant.name, "院内有货的处方中成药应排第一");
  assert.match(plan.evidenceContext, new RegExp(`药名：${rxRelevant.name}`), "追加候选的说明书条目要随规划结果注入证据段");
});

await rm(workDir, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "drug-inventory-recommendation", checks, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "drug-inventory-recommendation", checks, failures: 0 }));

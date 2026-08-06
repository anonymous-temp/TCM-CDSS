// 院内药品库存导入与可得性标注（甲方 2026-08-05「药品同步接口」入站方向）。
//
// 需求：甲方把医院库存药导进来，开方时基于库存有的药来开。
//
// 本套件的要害不是「能不能导入」，而是**库存绝不能静默改方**：
// 库存是可得性约束，不是临床正确性约束。这与甲方自己对味数的口径一致——
// 「味数控制只是建议，如诊疗必须也不能裁剪，如经方不能裁剪、必须加药味不能裁剪」。
// 本例该用麻黄汤而院内没有麻黄时，正确做法是如实标注缺货并给替代候选，
// 而不是悄悄换一味药——那会让医生看到的方与系统推理的方不是同一个，比缺货危险得多。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const workDir = await mkdtemp(join(tmpdir(), "cdss-inventory-"));
process.env.CDSS_DRUG_INVENTORY_PATH = join(workDir, "drug-inventory.json");

// server-only 由 Next 在构建期提供，jiti 下需按仓库既有约定指向其空实现。
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const inv = await jiti.import("../src/lib/drug-inventory.server.ts");
const route = await jiti.import("../src/app/api/drug-inventory/route.ts");

const failures = [];
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const post = (body) => route.POST(new Request("http://localhost:3000/api/drug-inventory", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

// —— 未导入库存时，行为必须与接库存前完全一致 ——
await check("INV-01 未导入库存：可得性全 unknown，不阻断任何链路", async () => {
  inv.resetDrugInventoryCacheForTests();
  const view = await inv.herbAvailabilityView();
  assert.equal(view.inventoryLoaded, false);
  assert.equal(view.statusOf("黄芪"), "unknown", "未导入库存时不得判任何药为缺货");
  assert.deepEqual(await inv.outOfStockAdvice(["黄芪", "当归"]), [],
    "未导入库存时不得产生缺货建议");
  assert.equal(await inv.buildDrugInventoryPromptContext(), "",
    "未导入库存时提示词必须与接入前逐字节相同");
  const status = await (await route.GET()).json();
  assert.equal(status.inventoryLoaded, false);
});

const HOSPITAL_STOCK = {
  source: "好医生HIS-测试院区",
  items: [
    { name: "黄芪", kind: "herb", available: true },
    { name: "当归", kind: "herb", available: true },
    { name: "白术", kind: "herb", available: true },
    { name: "茯苓", kind: "herb", available: true },
    { name: "党参", kind: "herb", available: true },
    { name: "大枣", kind: "herb", available: true },
    { name: "炙甘草", kind: "herb", available: true },
    { name: "人参", kind: "herb", available: false },
    { name: "麻黄", kind: "herb", available: false },
    { name: "八珍颗粒", kind: "patent", available: true, specification: "每袋8g", goodsId: "P-0001" },
  ],
};

await check("INV-02 导入落盘并可跨进程重读（重启不丢）", async () => {
  const res = await post(HOSPITAL_STOCK);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.itemCount, 10);
  assert.equal(body.availableHerbCount, 7);
  assert.equal(body.availablePatentCount, 1);
  assert.ok(body.inventoryVersion, "缺库存版本");
  // 清进程内缓存后重读，模拟重启
  inv.resetDrugInventoryCacheForTests();
  const reloaded = await inv.drugInventorySnapshot();
  assert.equal(reloaded.inventoryVersion, body.inventoryVersion, "重启后库存版本必须一致");
  assert.equal(reloaded.itemCount, 10);
});

await check("INV-03 可得性判定：有货/缺货/院内目录外", async () => {
  inv.resetDrugInventoryCacheForTests();
  const view = await inv.herbAvailabilityView();
  assert.equal(view.inventoryLoaded, true);
  assert.equal(view.statusOf("黄芪"), "in_stock");
  assert.equal(view.statusOf("人参"), "out_of_stock", "院内目录里标记不可用的药必须判缺货");
  assert.equal(view.statusOf("麻黄"), "out_of_stock");
  assert.ok(view.availableHerbNames.includes("黄芪"));
  assert.ok(!view.availableHerbNames.includes("人参"), "不可用的药不得进有货清单");
});

// —— 本套件的临床要害 ——
await check("INV-04 缺货药不得从处方中删除，只能标注 + 给替代", async () => {
  inv.resetDrugInventoryCacheForTests();
  const prescription = ["黄芪", "人参", "当归", "白术"];
  const advice = await inv.outOfStockAdvice(prescription);
  assert.equal(advice.length, 1, "应且只应报出人参一味缺货");
  assert.equal(advice[0].herb, "人参");
  assert.equal(advice[0].availability, "out_of_stock");
  // 关键：接口只产出建议，不返回「改写后的处方」——没有任何出口可以让库存改方。
  assert.ok(!("revisedPrescription" in advice[0]),
    "库存层不得产出改写后的处方；缺货必须由医师决定如何处理");
  for (const sub of advice[0].substitutes) {
    assert.ok(sub.differenceNote.includes("系统不裁定二者等效"),
      "替代候选必须保留「系统不裁定等效」声明");
  }
});

await check("INV-05 替代候选必须先过安全边界、再按库存过滤（顺序不可反）", async () => {
  inv.resetDrugInventoryCacheForTests();
  const view = await inv.herbAvailabilityView();
  const advice = await inv.outOfStockAdvice(["黄芪", "人参", "当归", "白术"]);
  for (const sub of advice[0].substitutes) {
    assert.equal(view.statusOf(sub.substitute), "in_stock",
      `替代候选 ${sub.substitute} 不在院内库存里，给了也开不出来`);
    assert.ok(!["黄芪", "当归", "白术"].includes(sub.substitute),
      `${sub.substitute} 已在现方中，不构成替代`);
  }
});

await check("INV-06 提示词是软偏好，必须明写「临床必须时不得迁就库存」", async () => {
  inv.resetDrugInventoryCacheForTests();
  const context = await inv.buildDrugInventoryPromptContext();
  assert.ok(context.includes("黄芪"), "有货清单未进提示词");
  assert.ok(!context.includes("人参"), "缺货药不得出现在有货清单里");
  assert.ok(/不得为迁就库存/.test(context),
    "提示词必须给出临床优先的出口，否则模型会为凑库存牺牲方证对应");
  assert.ok(/优先/.test(context) && !/只能从|仅限|必须从上述/.test(context),
    "库存是软偏好，不得写成硬门禁");
});

await check("INV-07 歧义药名绝不自动择一，如实回报", async () => {
  const res = await post({
    source: "歧义测试",
    items: [
      { name: "一包针", kind: "herb", available: true },
      { name: "黄芪", kind: "herb", available: true },
    ],
  });
  const body = await res.json();
  assert.ok(body.ambiguousNames.includes("一包针"),
    "歧义药名必须回报给甲方补映射，不得静默择一或丢弃");
  assert.ok(body.note && /不会替这些名字自动择一/.test(body.note));
});

await check("INV-08 归一不到正名的院内药名如实回报，不静默吞掉", async () => {
  const res = await post({
    source: "未知名测试",
    items: [
      { name: "某院内自制颗粒XYZ", kind: "herb", available: true },
      { name: "黄芪", kind: "herb", available: true },
    ],
  });
  const body = await res.json();
  assert.ok(body.unresolvedNames.includes("某院内自制颗粒XYZ"),
    "归一不到的药名必须回报，否则甲方无从知道是没推还是没认出");
});

await check("INV-09 整批替换语义：重新导入后旧条目不残留", async () => {
  await post({ source: "第一批", items: [{ name: "黄芪", kind: "herb", available: true }] });
  inv.resetDrugInventoryCacheForTests();
  let view = await inv.herbAvailabilityView();
  assert.equal(view.statusOf("黄芪"), "in_stock");
  await post({ source: "第二批", items: [{ name: "当归", kind: "herb", available: true }] });
  inv.resetDrugInventoryCacheForTests();
  view = await inv.herbAvailabilityView();
  assert.equal(view.statusOf("当归"), "in_stock");
  assert.equal(view.statusOf("黄芪"), "out_of_stock",
    "整批替换后旧批次药味不得残留为有货——残留会让已下架的药长期被当成有货");
});

await check("INV-10 非法入参与超量导入被明确拒绝", async () => {
  const bad = await post({ source: "x", items: "not-an-array" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_inventory_items");
  const huge = await post({ source: "x", items: Array.from({ length: 20_001 }, (_, i) => ({ name: `药${i}`, kind: "herb" })) });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).code, "inventory_too_large");
});

await check("INV-11 HIS 投影带可得性，但处方药味逐字不变", async () => {
  await post(HOSPITAL_STOCK);
  inv.resetDrugInventoryCacheForTests();
  const herbs = [{ name: "黄芪" }, { name: "人参" }, { name: "当归" }];
  const projection = await inv.drugAvailabilityProjection(herbs);
  assert.equal(projection.inventory.loaded, true);
  assert.deepEqual(projection.herbAvailability.map((item) => item.name), ["黄芪", "人参", "当归"],
    "投影不得增删或重排处方药味");
  assert.deepEqual(
    projection.herbAvailability.map((item) => item.availability),
    ["in_stock", "out_of_stock", "in_stock"],
  );
  assert.equal(projection.outOfStock.length, 1);
  assert.ok(/不参与临床合同签名/.test(projection.inventory.note),
    "必须声明库存不进签名域——库存每天变，进合同会让昨天签的方案今天验签失败");
});

await rm(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "drug-inventory", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "drug-inventory", checks: 11, failures: 0 }));

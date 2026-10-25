// 第九轮 WP9-B（2026-10-19）：鉴别诊断覆盖率（甲方验收「存在明显需鉴别病种/证候时，病名、证候各至少 2 条，遗漏判负」）。
//
// 第八轮 1081 份输出里病名鉴别不足两条的 339 例（31%）：提示词写「每例 1–2 项」，模型写一条就算守约；模型写了两条、其中一条是
// 西医病名被归一丢掉的另占约一半（第九轮 20 例实测 13 例不足，7 例模型只写一条，6 例写了两条被归一丢一条）；教材对 331 个病名里
// 只有 123 个列有两个以上能留在交付结果里的中医病证名，所以补写不能只靠教材。
//
// 每条断言都带对照与反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 9/differentials）。
//
//   1 保留判据：数出来的就是交付时留下的（与归一函数同一个判据）
//   2 补写（病名级）：保留下来少于两项才发请求；原有的行原样保留，补的是缺的那几项；闭集 / 开放两种候选；失败原样返回
//   3 补写（证候级）：模型已写至少一项才补；候选取教材同病其他证型，教材外的名字要过受治理证候词表
//   4 交付面兜底：补写失败时用教材所列的中医病证名补到两项，不重复，幂等
//   5 提示词：病名、证候鉴别都写「2–3 项」

import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
});
delete process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING;

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const authoring = await jiti.import("../src/lib/tcm-disease-differential-authoring.server.ts");
const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");

const savedFetch = globalThis.fetch;
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
/** 记录请求体并按 respond(system, user) 回复；每个用例结束后还原。 */
async function withModel(respond, run) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    const system = body.messages?.[0]?.content || "";
    const user = JSON.parse(body.messages?.[1]?.content || "{}");
    calls.push({ system, user, maxTokens: body.max_tokens });
    return completion(await respond(system, user, calls.length));
  };
  try { return await run(calls); } finally { globalThis.fetch = savedFetch; }
}

const entry = (diseaseName, points = "本例以头晕为主，未诉胸痛", extra = {}) => ({
  diseaseName, reason: "主症相近", typicalManifestation: "常见表现与本病相近而病位不同", distinguishingPoints: points, nextCheck: "", ...extra,
});
const syndromeEntry = (syndrome, points = "本例未诉胸胁胀满，舌淡苔白", extra = {}) => ({
  syndrome, reason: "主症相近", typicalManifestation: "常见表现相近而舌脉不同", distinguishingPoints: points, nextCheck: "", ...extra,
});
const diseaseRow = (diseaseName) => ({ diseaseName, reason: "同见头晕", distinguishingPoints: "本例无昏仆", typicalManifestation: "头晕目眩", nextCheck: null });
const synRow = (syndrome) => ({ syndrome, reason: "同见乏力", distinguishingPoints: "本例舌淡", typicalManifestation: "乏力气短", nextCheck: null });
const half = (overview) => JSON.stringify({ overview: { tcmDiseaseName: "眩晕", primarySyndrome: "气血亏虚证", ...overview }, pathogenesis: { chain: [] } });
const recordText = "头晕反复发作2年，劳累后加重，伴神疲乏力、面色少华，纳少便溏，舌淡苔薄白，脉细弱。";
// 补写小任务的结果按请求内容缓存（成功的才缓存）：每个用例用不同的病历尾巴，免得命中上一个用例的缓存。
let seq = 0;
const rec = () => `${recordText}（用例${++seq}）`;

// ───── 1 保留判据 ─────
await check("1.1 保留下来的病名鉴别 = 归一函数不丢的：西医病名丢掉、改名后同名的去重、与本病同名的不算（对照：中医病名都留）", () => {
  const rows = authoring.retainableDiseaseDifferentialRows([
    diseaseRow("流行性感冒"), diseaseRow("时行感冒"), diseaseRow("丘疹性荨麻疹"), diseaseRow("感冒"), diseaseRow("喘证"), { reason: "无名" },
  ], "感冒");
  assert.deepEqual(rows.map((item) => item.name), ["时行感冒", "喘证"], "流感改名为时行感冒、与下一条同名去重；丘疹性荨麻疹（西医）与感冒（本病）不算");
  assert.deepEqual(authoring.retainableDiseaseDifferentialRows([diseaseRow("郁病"), diseaseRow("心悸")], "不寐").map((item) => item.name), ["郁病", "心悸"]);
  assert.deepEqual(authoring.retainableDiseaseDifferentialRows(undefined, "不寐"), []);
});
await check("1.2 证候鉴别：与主证候同名的不算一项（忽略末尾「证/型」），同名去重", () => {
  const rows = authoring.retainableSyndromeDifferentialRows([synRow("气血亏虚"), synRow("肝郁气滞证"), synRow("肝郁气滞"), synRow("")], "气血亏虚证");
  assert.deepEqual(rows.map((item) => item.name), ["肝郁气滞证"]);
});
await check("1.3 下限常量为 2；教材对眩晕列的鉴别里有能留下的中医病证名（夹具前提）", () => {
  assert.equal(normalization.MIN_TCM_DIFFERENTIALS, 2);
  const kept = textbook.textbookDifferentialsForDisease("眩晕", 50).filter((item) => normalization.resolveTcmDiseaseDifferentialName(item.name, "眩晕").action === "keep");
  assert.ok(kept.length >= 1, `眩晕的教材鉴别：${JSON.stringify(textbook.textbookDifferentialsForDisease("眩晕", 50).map((item) => item.name))}`);
  // 默认仍是前 2 个（既有调用方不变），给 limit 才放开
  assert.ok(textbook.textbookDifferentialsForDisease("崩漏").length <= 2);
  assert.ok(textbook.textbookDifferentialsForDisease("崩漏", 50).length > 2, "对照：放开 limit 后能看到教材所列的全部");
});

// ───── 2 补写（病名级）─────
await check("2.1 模型只写了一条：发一次请求，原有那一行原样在前，补的一条在后，共两条", async () => {
  const kept = textbook.textbookDifferentialsForDisease("眩晕", 50).map((item) => item.name)
    .filter((name) => normalization.resolveTcmDiseaseDifferentialName(name, "眩晕").action === "keep");
  const pick = kept[0] || "中风";
  await withModel(() => ({ differentials: [entry(pick)] }), async (calls) => {
    const original = diseaseRow("郁病");
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({ tcmDiseaseDifferentials: [original], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] }), { recordText: rec() }));
    assert.equal(calls.length, 1, "只发病名这一个请求（证候鉴别已够两项）");
    assert.deepEqual(out.overview.tcmDiseaseDifferentials[0], original, "原有的行原样保留");
    assert.equal(out.overview.tcmDiseaseDifferentials.length, 2);
    assert.match(out.overview.tcmDiseaseDifferentials[1].distinguishingPoints, /^本例/);
    assert.deepEqual(calls[0].user.alreadyListed, ["郁病"], "把已写的告诉小任务，不让它重复");
    assert.equal(out.overview.primarySyndrome, "气血亏虚证", "其余字段不动");
  });
});
await check("2.2 已有两条可保留的：不发请求、原样返回（对照）", async () => {
  await withModel(() => ({ differentials: [] }), async (calls) => {
    const content = half({ tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("心悸")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] });
    assert.equal(await authoring.completeTcmDiseaseDifferentials(content, { recordText: rec() }), content);
    assert.equal(calls.length, 0);
  });
});
await check("2.3 写了两条、其中一条是西医病名被归一丢掉：按「只剩一条」补一条，西医那条不留（第九轮实测占不足两条的近一半）", async () => {
  await withModel(() => ({ differentials: [entry("中风")] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({
      tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("丘疹性荨麻疹")],
      tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")],
    }), { recordText: rec() }));
    assert.equal(calls.length, 1);
    assert.deepEqual(out.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName), ["郁病", "中风"]);
  });
});
await check("2.4 补写的名字：重复 alreadyListed、与本病同名、西医病名都不收；收得下的才补（部分失败时少补，不乱补）", async () => {
  await withModel(() => ({ differentials: [entry("郁病"), entry("眩晕"), entry("丘疹性荨麻疹"), entry("中风")] }), async () => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({
      tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")],
    }), { recordText: rec() }));
    assert.deepEqual(out.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName), ["郁病", "中风"]);
  });
});
await check("2.5 教材够补时是闭集：只收教材所列的名字（模型另提的名字不收）；不够时才开放（名字仍过归一判据）", async () => {
  const listed = textbook.textbookDifferentialsForDisease("淋证", 50)
    .filter((item) => normalization.resolveTcmDiseaseDifferentialName(item.name, "淋证").action === "keep").map((item) => item.name);
  assert.ok(listed.length >= 2, `夹具前提：教材对淋证列有 ≥2 个可留的鉴别（${listed.join("、")}）`);
  const lin = (overview) => JSON.stringify({ overview: { tcmDiseaseName: "淋证", primarySyndrome: "膀胱湿热证", ...overview }, pathogenesis: { chain: [] } });
  await withModel(() => ({ differentials: [entry("不寐"), entry(listed[0]), entry(listed[1])] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(lin({ tcmDiseaseDifferentials: [], tcmDifferentials: [synRow("肝胆湿热证"), synRow("脾肾亏虚证")] }), { recordText: "尿频尿急尿痛3天，小便黄赤。" }));
    assert.deepEqual(out.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName), [listed[0], listed[1]], "闭集：「不寐」不在教材所列里，不收");
    assert.ok(calls[0].user.textbookDifferentials.length >= 2);
    assert.match(calls[0].system, /只能逐字取自其中/);
  });
  // 教材只有一个可补的、需要两个：开放，教材所列的优先，另提的中医病名过判据
  const one = textbook.textbookDifferentialsForDisease("月经先期", 50).filter((item) => normalization.resolveTcmDiseaseDifferentialName(item.name, "月经先期").action === "keep").map((item) => item.name);
  assert.equal(one.length, 1, `夹具前提：教材对月经先期只列一个可留的鉴别（${one.join("、")}）`);
  await withModel(() => ({ differentials: [entry(one[0]), entry("崩漏"), entry("丘疹性荨麻疹")] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview: { tcmDiseaseName: "月经先期", primarySyndrome: "阳盛血热证", tcmDiseaseDifferentials: [], tcmDifferentials: [synRow("肝郁血热证"), synRow("气虚证")] }, pathogenesis: { chain: [] } }), { recordText: "月经周期提前10天，量多色红。" }));
    const names = out.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName);
    assert.deepEqual(names, [one[0], "崩漏"], "开放：教材所列的先用，另提的中医病名也收；西医病名不收");
    assert.match(calls[0].system, /优先从中选/);
    assert.match(calls[0].system, /tcmDiseaseNameList/);
    const list = calls[0].user.tcmDiseaseNameList;
    assert.ok(Array.isArray(list) && list.length > 100, "规范中医病名闭集");
    assert.ok(!list.includes("月经先期") && !list.includes(one[0]), "不含本病与教材已列的候选");
    assert.ok(!list.some((name) => normalization.WESTERN_DISEASE_FORM.test(name)), "闭集里没有西医构词的名字（骨关节炎、接触性皮炎…）");
  });
  // 教材一个可补的都没有：完全开放，只收过判据的中医病名
  await withModel(() => ({ differentials: [entry("丘疹性荨麻疹"), entry("湿疮"), entry("风瘙痒")] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview: { tcmDiseaseName: "瘾疹", primarySyndrome: "风热犯表证", tcmDiseaseDifferentials: [], tcmDifferentials: [synRow("风寒束表证"), synRow("胃肠湿热证")] }, pathogenesis: { chain: [] } }), { recordText: "大汗后吹空调出现全身红色风团2天，瘙痒，骤起骤消。" }));
    assert.ok(!out.overview.tcmDiseaseDifferentials.some((item) => item.diseaseName === "丘疹性荨麻疹"));
    assert.ok(out.overview.tcmDiseaseDifferentials.length >= 1);
    assert.match(calls[0].system, /tcmDiseaseNameList/);
  });
  // 闭集开关关闭：回到让模型自行提出
  process.env.CDSS_TCM_DIFFERENTIAL_NAME_LIST = "false";
  try {
    await withModel(() => ({ differentials: [entry("湿疮")] }), async (calls) => {
      await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview: { tcmDiseaseName: "瘾疹", primarySyndrome: "风热犯表证", tcmDiseaseDifferentials: [], tcmDifferentials: [synRow("风寒束表证"), synRow("胃肠湿热证")] }, pathogenesis: { chain: [] } }), { recordText: "全身风团3天，瘙痒，骤起骤消，遇热加重。" });
      assert.match(calls[0].system, /自行提出/);
      assert.equal(calls[0].user.tcmDiseaseNameList, undefined);
    });
  } finally { delete process.env.CDSS_TCM_DIFFERENTIAL_NAME_LIST; }
  // 模型自行提出的西医构词名字（教材有的节以西医病名立节）不收：甲方 9.24 中医鉴别只列中医病名
  await withModel(() => ({ differentials: [entry("骨关节炎"), entry("历节")] }), async () => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview: { tcmDiseaseName: "痹证", primarySyndrome: "风寒湿痹证", tcmDiseaseDifferentials: [diseaseRow("痿证")], tcmDifferentials: [synRow("风热痹阻证"), synRow("痰瘀痹阻证")] }, pathogenesis: { chain: [] } }), { recordText: rec() }));
    assert.ok(!out.overview.tcmDiseaseDifferentials.some((item) => item.diseaseName === "骨关节炎"), "骨关节炎是教材节名，但是西医构词，模型自提时不收");
  });
});
await check("2.6 补写结果的格式：区分要点须以「本例」起头、不照搬教材、典型表现不得为空；不合格的不收（对照：合格的收）", async () => {
  const bad = [
    entry("中风", "据教材定义可区分，不是中风"), entry("中风", "头晕为主，未诉昏仆"), entry("中风", "本例未诉昏仆", { typicalManifestation: "" }),
  ];
  for (const item of bad) {
    await withModel(() => ({ differentials: [item] }), async () => {
      const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({ tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] }), { recordText: rec() }));
      assert.equal(out.overview.tcmDiseaseDifferentials.length, 1, JSON.stringify(item));
    });
  }
  await withModel(() => ({ differentials: [entry("中风")] }), async () => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({ tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] }), { recordText: rec() }));
    assert.equal(out.overview.tcmDiseaseDifferentials.length, 2);
  });
});
await check("2.7 小任务不可用（抛错）或返回空：原样返回，交付面兜底接手；开关关闭时不发请求", async () => {
  const content = half({ tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] });
  globalThis.fetch = async () => { throw new Error("upstream down"); };
  try {
    assert.equal(await authoring.completeTcmDiseaseDifferentials(content, { recordText: rec() }), content);
    assert.equal(await authoring.completeTcmDiseaseDifferentials("不是 JSON", { recordText: rec() }), "不是 JSON");
  } finally { globalThis.fetch = savedFetch; }
  await withModel(() => ({ differentials: [] }), async (calls) => {
    assert.equal(await authoring.completeTcmDiseaseDifferentials(content, { recordText: rec() }), content);
    assert.equal(calls.length, 1);
  });
  process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING = "false";
  try {
    await withModel(() => ({ differentials: [entry("中风")] }), async (calls) => {
      assert.equal(await authoring.completeTcmDiseaseDifferentials(content, { recordText: rec() }), content);
      assert.equal(calls.length, 0);
    });
  } finally { delete process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING; }
});
await check("2.8 一条都没写：补两条（旧行为保留）；缺两项时请求里写明恰好两项", async () => {
  await withModel(() => ({ differentials: [entry("中风"), entry("厥证")] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({ tcmDiseaseDifferentials: [], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] }), { recordText: rec() }));
    assert.equal(out.overview.tcmDiseaseDifferentials.length, 2);
    assert.match(calls[0].system, /恰好 2 项/);
    assert.deepEqual(calls[0].user.alreadyListed, []);
  });
});

// ───── 3 补写（证候级）─────
await check("3.1 证候鉴别只有一项：并行补一项；候选是教材该病下的其他证型（名字逐字），主证候与已写的不在候选里", async () => {
  const rows = textbook.textbookCandidatesForCase({ diseaseName: "眩晕", presentHistory: recordText }, { maxDiseases: 6, maxRowsPerDisease: 12 }).find((item) => item.disease === "眩晕")?.rows || [];
  const other = rows.map((row) => row.syndromeName).find((name) => !/气血亏虚/.test(name) && !/肝阳上亢/.test(name));
  assert.ok(other, "夹具前提：教材眩晕有别的证型");
  await withModel((system) => /证候鉴别的整理者/.test(system) ? { differentials: [syndromeEntry(other)] } : { differentials: [] }, async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({
      tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("中风")], tcmDifferentials: [synRow("肝阳上亢证")],
    }), { recordText: rec() }));
    assert.equal(calls.length, 1, "病名已够，只发证候这一个请求");
    assert.deepEqual(out.overview.tcmDifferentials.map((item) => item.syndrome), ["肝阳上亢证", other]);
    const names = calls[0].user.textbookSyndromes.map((item) => item.syndrome);
    assert.ok(!names.some((name) => /气血亏虚/.test(name) || /肝阳上亢/.test(name)), `候选不含主证候与已写的：${names.join("、")}`);
    assert.deepEqual(calls[0].user.alreadyListed, ["肝阳上亢证"]);
  });
});
await check("3.2 证候鉴别：模型整栏留空的不补（可能是写明了「资料不足以鉴别」）；主证候未形成的不补（对照：已写一项的补）", async () => {
  await withModel(() => ({ differentials: [syndromeEntry("肝阳上亢证")] }), async (calls) => {
    const base = { tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("中风")] };
    const empty = half({ ...base, tcmDifferentials: [] });
    assert.equal(await authoring.completeTcmDiseaseDifferentials(empty, { recordText: rec() }), empty);
    const unresolved = half({ ...base, tcmDifferentials: [synRow("痰湿中阻证")], primarySyndromeResolution: "unresolved" });
    assert.equal(await authoring.completeTcmDiseaseDifferentials(unresolved, { recordText: rec() }), unresolved);
    assert.equal(calls.length, 0);
    const one = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({ ...base, tcmDifferentials: [synRow("痰湿中阻证")] }), { recordText: rec() }));
    assert.equal(one.overview.tcmDifferentials.length, 2);
  });
});
await check("3.3 证候名：与主证候同名、与已写重复、不是证候名（症状堆砌）都不收；教材够补时只收教材同病其他证型的名字", async () => {
  await withModel((_system, user) => ({ differentials: [
    syndromeEntry("气血亏虚证"), syndromeEntry("痰湿中阻"), syndromeEntry("头晕乏力"), syndromeEntry("心脾两虚证"), syndromeEntry(user.textbookSyndromes[0].syndrome),
  ] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({
      tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("中风")], tcmDifferentials: [synRow("痰湿中阻证")],
    }), { recordText: rec() }));
    assert.equal(out.overview.tcmDifferentials.length, 2);
    assert.equal(out.overview.tcmDifferentials[1].syndrome, calls[0].user.textbookSyndromes[0].syndrome);
    assert.ok(!out.overview.tcmDifferentials.some((item) => /气血亏虚|头晕乏力|心脾两虚/.test(item.syndrome)), JSON.stringify(out.overview.tcmDifferentials.map((item) => item.syndrome)));
  });
});
await check("3.5 教材没有这个病的证型时开放：另提的证候名要过受治理证候词表（证候名收，症状堆砌不收）", async () => {
  const content = JSON.stringify({ overview: { tcmDiseaseName: "测试病名", primarySyndrome: "气血亏虚证", tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("中风")], tcmDifferentials: [synRow("痰湿中阻证")] }, pathogenesis: { chain: [] } });
  await withModel(() => ({ differentials: [syndromeEntry("头晕乏力"), syndromeEntry("肝阳上亢证")] }), async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(content, { recordText: rec() }));
    assert.equal(calls[0].user.textbookSyndromes, undefined, "夹具前提：教材没有这个病");
    assert.deepEqual(out.overview.tcmDifferentials.map((item) => item.syndrome), ["痰湿中阻证", "肝阳上亢证"]);
    assert.match(calls[0].system, /自行提出/);
  });
});
await check("3.4 病名与证候都不足：两个请求并行发出，各补各的", async () => {
  await withModel((system) => /证候鉴别的整理者/.test(system) ? { differentials: [syndromeEntry("肝阳上亢证")] } : { differentials: [entry("中风")] }, async (calls) => {
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(half({
      tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("痰湿中阻证")],
    }), { recordText: rec() }));
    assert.equal(calls.length, 2);
    assert.equal(out.overview.tcmDiseaseDifferentials.length, 2);
    assert.equal(out.overview.tcmDifferentials.length, 2);
  });
});

// ───── 4 交付面兜底 ─────
const diagnose = (disease, differentials) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: disease, primarySyndrome: "某证", tcmDiseaseDifferentials: differentials },
  pathogenesis: { chain: [{ pathogenesis: "x" }] }, westernDiagnosis: { primary: { name: "x" }, differentials: [] },
});
const deliveredNames = (reasoning) => projectDeliveredReasoning(reasoning).overview.tcmDiseaseDifferentials.map((item) => item.diseaseName);
await check("4.1 交付面：保留下来只有一条时，用教材所列的中医病证名补到两条，不与已有的重复；已有两条的不动（补写失败时的兜底）", () => {
  const listed = textbook.textbookDifferentialsForDisease("胃痛", 50)
    .filter((item) => normalization.resolveTcmDiseaseDifferentialName(item.name, "胃痛").action !== "drop").map((item) => item.name);
  assert.ok(listed.length >= 3, `夹具前提 ${listed.join("、")}`);
  const present = { diseaseName: listed[0], reason: "x", distinguishingPoints: "本例胃脘痛", typicalManifestation: "胃脘疼痛", nextCheck: null };
  const names = deliveredNames(diagnose("胃痛", [present]));
  assert.equal(names.length, 2);
  assert.equal(names[0], listed[0]);
  assert.notEqual(names[1], listed[0]);
  assert.ok(listed.includes(names[1]));
  const two = [present, { ...present, diseaseName: "自拟鉴别病" }];
  assert.deepEqual(deliveredNames(diagnose("胃痛", two)), [listed[0], "自拟鉴别病"], "对照：已有两条不补");
  // 已有的是教材第一个时补的是第二个（不是又贴一遍第一个）
  const second = deliveredNames(diagnose("胃痛", [{ ...present, diseaseName: listed[1] }]));
  assert.deepEqual(second.slice(0, 1), [listed[1]]);
  assert.equal(second[1], listed[0]);
});
await check("4.2 交付面兜底：幂等（再投影一次不再变）；教材没有可补的名字时保持一条，不拼文字", () => {
  const present = { diseaseName: "郁病", reason: "x", distinguishingPoints: "本例情志不畅", typicalManifestation: "情志抑郁", nextCheck: null };
  const once = projectDeliveredReasoning(diagnose("胃痛", [present]));
  const twice = projectDeliveredReasoning(once);
  assert.deepEqual(twice.overview.tcmDiseaseDifferentials, once.overview.tcmDiseaseDifferentials);
  assert.equal(once.overview.tcmDiseaseDifferentials.length, 2);
  assert.equal(deliveredNames(diagnose("不存在的病名", [present])).length, 1, "教材没有这个病：不补");
  assert.equal(deliveredNames(diagnose("瘾疹", [present])).length, 1, "瘾疹节只列西医病名：不补（既有口径，丘疹性荨麻疹不贴）");
});
await check("4.3 交付面：没有任何鉴别时仍按教材补（旧行为不变）；有限结论不补", () => {
  const names = deliveredNames(diagnose("咳嗽", []));
  assert.deepEqual(names, ["肺痨", "肺胀"]);
  const limited = diagnose("咳嗽", []);
  limited.overview.primarySyndromeResolution = "unresolved";
  limited.pathogenesis.chain = [];
  assert.deepEqual(projectDeliveredReasoning(limited).overview.tcmDiseaseDifferentials, []);
});

// ───── 6 流式预取：补写不占关键路径 ─────
const moduleDrafts = await jiti.import("../src/lib/diagnosis-stream-module-drafts.ts");
await check("6.1 中医半流里 overview 闭合才返回它（含鉴别条目）；未闭合、没有 overview、前面有杂文都不误报", () => {
  const overview = { tcmDiseaseName: "眩晕", primarySyndrome: "气血亏虚证", tcmDiseaseDifferentials: [diseaseRow("郁病")] };
  const closed = JSON.stringify({ overview, pathogenesis: { chain: [] } });
  const cut = closed.slice(0, closed.indexOf('"pathogenesis"'));
  assert.deepEqual(moduleDrafts.completedM03Overview(`${cut}"pathogenesis":{"chain":[`), overview, "overview 之后还在写别的");
  assert.equal(moduleDrafts.completedM03Overview(closed.slice(0, closed.indexOf('"tcmDiseaseDifferentials"') + 30)), undefined, "overview 还没闭合");
  assert.equal(moduleDrafts.completedM03Overview('{"pathogenesis":{"chain":[]}'), undefined);
  assert.equal(moduleDrafts.completedM03Overview("没有对象"), undefined);
  assert.deepEqual(moduleDrafts.completedM03Overview(`前面一句话 ${closed}`), overview);
});
await check("6.2 预取与收口发出逐字相同的请求：预取发一次，收口命中（总共一次请求），结果与不预取时相同", async () => {
  const overview = { tcmDiseaseName: "眩晕", primarySyndrome: "气血亏虚证", tcmDiseaseDifferentials: [diseaseRow("郁病")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] };
  const context = { recordText: rec(), patient: { sex: "女", age: 52 } };
  await withModel(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { differentials: [entry("中风")] };
  }, async (calls) => {
    authoring.prefetchTcmDifferentialTopUp(overview, context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 1, "预取发出一次请求");
    // 收口时请求还在途中：合流，不再发
    const out = JSON.parse(await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview, pathogenesis: { chain: [] } }), context));
    assert.equal(calls.length, 1, "收口命中在途请求");
    assert.deepEqual(out.overview.tcmDiseaseDifferentials.map((item) => item.diseaseName), ["郁病", "中风"]);
    // 结果已缓存：再收口一次也不发
    await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview, pathogenesis: { chain: [] } }), context);
    assert.equal(calls.length, 1);
  });
});
await check("6.3 预取不该发的不发：鉴别已够两项、开关关闭、合流关闭（对照：不够时发）；病历不同则不命中", async () => {
  const enough = { tcmDiseaseName: "眩晕", primarySyndrome: "气血亏虚证", tcmDiseaseDifferentials: [diseaseRow("郁病"), diseaseRow("中风")], tcmDifferentials: [synRow("肝阳上亢证"), synRow("痰湿中阻证")] };
  const short = { ...enough, tcmDiseaseDifferentials: [diseaseRow("郁病")] };
  await withModel(() => ({ differentials: [entry("中风")] }), async (calls) => {
    authoring.prefetchTcmDifferentialTopUp(enough, { recordText: rec() });
    authoring.prefetchTcmDifferentialTopUp(undefined, { recordText: rec() });
    authoring.prefetchTcmDifferentialTopUp({ tcmDiseaseDifferentials: [] }, { recordText: rec() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);
    process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING = "false";
    authoring.prefetchTcmDifferentialTopUp(short, { recordText: rec() });
    delete process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING;
    process.env.CDSS_SMALL_TASK_MEMO = "false";
    authoring.prefetchTcmDifferentialTopUp(short, { recordText: rec() });
    delete process.env.CDSS_SMALL_TASK_MEMO;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, "开关关闭、合流关闭都不预取");
    authoring.prefetchTcmDifferentialTopUp(short, { recordText: rec() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1, "对照：不够两项就预取");
    // 预取用的病历与收口不同（不会发生，但要证明不会误用别人的结果）：收口自己再发
    await authoring.completeTcmDiseaseDifferentials(JSON.stringify({ overview: short, pathogenesis: { chain: [] } }), { recordText: rec() });
    assert.equal(calls.length, 2);
  });
});
await check("6.4 接线（源码）：流式层在首轮 overview 闭合时回调一次；诊断路由只在并行两半时传入，并与收口用同一份上下文", () => {
  const api = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
  assert.match(api, /opts\.onInitialM03Overview && !initialM03OverviewReported && structuredRetryCount === 0/);
  assert.match(api, /completedM03Overview\(partial\)/);
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(route, /onInitialM03Overview: \(overview: Record<string, unknown>\) =>\s*prefetchTcmDifferentialTopUp\(overview, differentialTopUpContext\)/);
  // 第十九轮起收口包在 finishTcmHalf(content) 里（病名须解释就诊原因时对重抽稿再走一遍），参数名随之是 content。
  assert.match(route, /completeTcmDiseaseDifferentials\((?:tcmContent|content), differentialTopUpContext, transformSignal\)/);
  assert.ok(route.indexOf("onInitialM03Overview") > route.indexOf("m03ParallelGenerationEnabled()"), "在并行两半的分支里");
  assert.ok(route.indexOf("onInitialM03Overview") < route.indexOf("truncateFallback:"), "不在并行分支之外");
});

// ───── 5 提示词 ─────
await check("5.1 M03 提示词：病名鉴别「2–3 项」、证候鉴别「2–3 项」，不再写「1–2 项」「1–3项」；最需排除的在前", async () => {
  const { buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const prompt = buildDiagnosePrompt(types.normalizeCaseStateInput({ id: "d1", chiefComplaint: "头晕2年", patient: { sex: "女", age: 52 }, symptoms: { 现病史: recordText } }));
  assert.ok(prompt.includes("每例给出 2–3 项"), "病名鉴别");
  assert.ok(!prompt.includes("每例必须给出 1–2 项"), "旧写法已去掉");
  assert.ok(/overview\.tcmDifferentials[^。]{0,40}给出\s*2–3\s*项/.test(prompt), "证候鉴别");
  assert.ok(!/已有可比较证候时给出1–3项/.test(prompt));
  assert.ok(/最需要排除的写在前面/.test(prompt));
});

console.log(`r1021 differentials: ${cases} cases${process.exitCode ? " (with failures)" : " ok"}`);

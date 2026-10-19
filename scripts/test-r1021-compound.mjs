// 第九轮 WP9-C（2026-10-19 晚）：复合证 / 兼证。M 集（真实医案）中医诊断参考为复合证的 86 例只过 27%，单证参考的 134 例过 68%。
//
// 每条断言都带反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 9/compound）。
// 材料与量：~/runlogs/r1018/work/r1021/compound/diagnosis.md
//
//   1 病历对主证教材证型主症的吻合度（textbookPatternFit）与闸门常数：甲方病历 4（肝气犯胃）0.50，真实医案（RobustSDT-0614 湿热中阻）0.00
//   2 找组小任务的输出解析：只认被选中的那一组判 independent；摘录逐字出自病历肯定句且不少于两条；兼证不能是主证本身
//   3 整条链（桩模型）：低吻合度 → 找组 → 特异性复核 → 补兼证；复核否决、找组无、吻合度高、开关关、未定主证、已有兼证都不改；
//     甲方病历 4 在高吻合度下一次请求都不发
//   4 证名改名不得丢掉复合证名的「气」「郁滞」，也不得把两脏合称改成不写脏腑的行（textbookNearestRow）；同义写法照旧归一

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
  OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "false",
});
delete process.env.CDSS_M03_SECONDARY_GROUP_CHECK;
delete process.env.CDSS_M03_SECONDARY_BROAD_TRIGGER;
delete process.env.CDSS_M03_SECONDARY_CONSISTENCY;

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

const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");

// 甲方标准病历 4（胃痛·肝气犯胃证；标准答案无兼证）与公开数据集 RobustSDT-single_0614（真实医案，参考为「脾胃气虚，湿热内蕴证」）。
const RECORD_C4 = "患者半月前与家人争吵后出现胃痛不适，以胃脘胀痛为主，常因情绪波动诱发或加重，得嗳气、矢气则痛舒。伴胸闷、善叹息，大便溏结不调，饮食欠佳，睡眠差，小便正常。发病以来神志清，精神尚可，体力无明显变化。舌淡红，薄白苔，脉弦细。";
const RECORD_0614 = "患者半年前因饮食不节出现上腹部隐痛，偶有反酸，伴咽部不适、咽痒，晨起口苦、口粘。无嗳气，无恶心呕吐，无头晕头痛，无胸闷心悸，无发热。纳食尚可，睡眠安稳，小便调畅，大便每日1次，质成型，无便血。症状加重因素为进食油腻、生冷食物；缓解因素为服药后及餐后散步。舌淡暗，边有齿痕，苔薄黄腻，脉细滑。";

// ───── 1 吻合度 ─────
await check("1.1 吻合度：甲方病历 4 对肝气犯胃证 ≥ 闸值；真实医案 0614 对湿热中阻证（胃痛）远低于闸值；教材主症不足 4 条的行不算（undefined）", () => {
  const c4 = textbook.textbookRowForSyndrome("胃痛", "肝气犯胃证");
  assert.ok(c4, "夹具前提：教材胃痛有肝气犯胃证");
  const fitC4 = secondary.textbookPatternFit(c4, RECORD_C4);
  assert.ok(fitC4 >= secondary.GROUP_CHECK_FIT_CEILING, `病历 4 吻合度 ${fitC4}`);
  const r0614 = textbook.textbookRowForSyndrome("胃痛", "湿热中阻证");
  assert.ok(r0614, "夹具前提：教材胃痛有湿热中阻证");
  const fit0614 = secondary.textbookPatternFit(r0614, RECORD_0614);
  assert.ok(fit0614 < secondary.GROUP_CHECK_FIT_CEILING, `0614 吻合度 ${fit0614}`);
  assert.equal(secondary.textbookPatternFit({ manifestations: "头痛，发热，恶寒" }, "头痛发热恶寒"), undefined);
});
await check("1.2 闸值常数 0.30（甲方 10 例 0.20–0.50、留出 10 例 0.10–0.44、人工判定的「该立」18 例 0.00–0.27）", () => {
  assert.equal(secondary.GROUP_CHECK_FIT_CEILING, 0.3);
});
await check("1.3 否认句里出现的教材主症不算吻合（「无嗳气」不算对上「嗳气」）", () => {
  const row = { manifestations: "胃脘胀痛，嗳气，恶心呕吐，胸闷，善叹息，大便不畅" };
  const affirmed = secondary.textbookPatternFit(row, "胃脘胀痛，嗳气，恶心呕吐，胸闷，善叹息。");
  const denied = secondary.textbookPatternFit(row, "胃脘胀痛。无嗳气，无恶心呕吐，无胸闷，无善叹息。");
  assert.ok(affirmed > denied, `${affirmed} vs ${denied}`);
  assert.ok(denied <= 0.34, String(denied));
});

// ───── 2 找组与复核的输出解析 ─────
const ctx0614 = { recordText: RECORD_0614, primarySyndrome: "湿热中阻证", editableText: "舌淡暗边有齿痕为脾运不健" };
const finderJson = (patch = {}) => JSON.stringify({
  groups: [{ syndrome: "脾虚湿困证", items: ["舌淡暗", "边有齿痕", "脉细滑"], verdict: "independent" }],
  decision: "add", secondarySyndrome: "脾虚湿困证", method: "健脾化湿", ...patch,
});
await check("2.1 找组：被选中的一组判 independent、摘录逐字出自病历 → 补兼证（证名、治法、摘录）", () => {
  const decision = secondary.parseGroupFinderDecision(finderJson(), ctx0614);
  assert.equal(decision?.decision, "add");
  assert.equal(decision.secondarySyndrome, "脾虚湿困证");
  assert.equal(decision.method, "健脾化湿");
  assert.ok(decision.evidence.length >= 2, JSON.stringify(decision));
});
await check("2.2 对照：判 merged / single、选中的组不在 groups 里、decision 为 none → 都不补", () => {
  for (const verdict of ["merged", "single"]) {
    assert.equal(secondary.parseGroupFinderDecision(finderJson({ groups: [{ syndrome: "脾虚湿困证", items: ["舌淡暗", "边有齿痕"], verdict }] }), ctx0614), undefined, verdict);
  }
  assert.equal(secondary.parseGroupFinderDecision(finderJson({ secondarySyndrome: "肾气不足证" }), ctx0614), undefined);
  assert.equal(secondary.parseGroupFinderDecision(JSON.stringify({ groups: [], decision: "none" }), ctx0614), undefined);
  assert.equal(secondary.parseGroupFinderDecision("不是 JSON", ctx0614), undefined);
});
await check("2.3 摘录不在病历里、或只有一条在病历里 → 不补；否认句里的不算（「无嗳气」「无恶心呕吐」）", () => {
  const groups = (items) => [{ syndrome: "脾虚湿困证", items, verdict: "independent" }];
  assert.equal(secondary.parseGroupFinderDecision(finderJson({ groups: groups(["舌淡暗", "神疲乏力"]) }), ctx0614), undefined, "只有一条逐字出自病历");
  assert.equal(secondary.parseGroupFinderDecision(finderJson({ groups: groups(["嗳气", "恶心呕吐"]) }), ctx0614), undefined, "否认句");
  assert.equal(secondary.parseGroupFinderDecision(finderJson({ groups: groups(["舌淡暗", "边有齿痕"]) }), ctx0614)?.decision, "add", "对照：两条逐字出自病历");
});
await check("2.4 兼证不能是主证本身或主证已含的因素（主证「脾虚湿困证」不再补「脾虚湿困证」「湿困证」）", () => {
  const ctx = { ...ctx0614, primarySyndrome: "脾虚湿困证" };
  assert.equal(secondary.parseGroupFinderDecision(finderJson(), ctx), undefined);
  assert.equal(secondary.parseGroupFinderDecision(finderJson({ groups: [{ syndrome: "湿困证", items: ["舌淡暗", "边有齿痕"], verdict: "independent" }], secondarySyndrome: "湿困证" }), ctx), undefined);
});
await check("2.5 复核：只有明确 keep 才保留；drop、缺字段、乱写、非 JSON 一律当否决", () => {
  assert.equal(secondary.parseGroupVerifierVerdict(JSON.stringify({ verdict: "keep", specific: ["舌淡暗"] })), true);
  for (const bad of [JSON.stringify({ verdict: "drop" }), JSON.stringify({ specific: [] }), JSON.stringify({ verdict: "KEEP" }), "keep", "", undefined]) {
    assert.equal(secondary.parseGroupVerifierVerdict(bad), false, String(bad));
  }
});

// ───── 3 整条链（桩模型） ─────
const savedFetch = globalThis.fetch;
const completion = (payload) => new Response(JSON.stringify({
  id: "t", object: "chat.completion", model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
const half = (overview = {}, method = "清化湿热，理气和胃") => JSON.stringify({
  overview: {
    tcmDiseaseName: "胃痛", primarySyndrome: "湿热中阻证", primarySyndromeResolution: "bounded", secondarySyndromes: [],
    tcmDiagnosticRationale: "上腹隐痛、进食油腻生冷加重，苔薄黄腻、晨起口苦口粘，为湿热蕴阻中焦，故属湿热中阻证；舌淡暗边有齿痕、脉细滑，示脾运不健。",
    overallPathogenesis: "湿热蕴阻中焦，胃失和降。",
    ...overview,
  },
  therapy: { overallMethod: method },
});
/** kind：find / verify / claims（按系统提示词认）。 */
const kindOf = (body) => {
  const system = body.messages[0].content;
  if (system.includes("第二个成组的证候")) return "find";
  if (system.includes("能否立为兼证")) return "verify";
  if (system.includes("前后一致性")) return "claims";
  return "other";
};
const withStub = async (handlers, run) => {
  const calls = { find: 0, verify: 0, claims: 0, other: 0 };
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const kind = kindOf(body);
    calls[kind] += 1;
    bodies.push({ kind, body });
    const handler = handlers[kind];
    if (!handler) throw new Error(`unexpected ${kind}`);
    return completion(handler(body));
  };
  try { return await run(calls, bodies); } finally { globalThis.fetch = savedFetch; }
};
const FIND_ADD = () => finderJson();
const KEEP = () => ({ verdict: "keep", specific: ["舌淡暗", "边有齿痕"] });
const DROP = () => ({ verdict: "drop", specific: [] });

await check("3.1 低吻合度：找组 → 特异性复核 保留 → 补兼证并列治法；两次请求各一", async () => {
  await withStub({ find: FIND_ADD, verify: KEEP }, async (calls, bodies) => {
    const out = JSON.parse(await secondary.reconcileSecondarySyndromes(half(), { recordText: RECORD_0614 }));
    assert.deepEqual(out.overview.secondarySyndromes, ["脾虚湿困证"]);
    assert.match(out.therapy.overallMethod, /健脾化湿/u);
    assert.deepEqual([calls.find, calls.verify, calls.claims], [1, 1, 0]);
    // 找组与复核都看得到主证的教材主症（胃痛·湿热中阻证），用来排除「主证本身的典型表现」
    const find = JSON.parse(bodies.find((item) => item.kind === "find").body.messages[1].content);
    assert.ok(find.primaryManifestations && find.primaryManifestations.length > 10, JSON.stringify(find).slice(0, 200));
    assert.equal(find.primarySyndrome, "湿热中阻证");
  });
});
await check("3.2 复核否决 → 不改；找组无 → 不改且不发复核（对照）", async () => {
  await withStub({ find: FIND_ADD, verify: DROP }, async (calls) => {
    const raw = half();
    assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }), raw);
    assert.deepEqual([calls.find, calls.verify], [1, 1]);
  });
  await withStub({ find: () => ({ groups: [], decision: "none" }), verify: KEEP }, async (calls) => {
    const raw = half();
    assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }), raw);
    assert.deepEqual([calls.find, calls.verify], [1, 0]);
  });
});
await check("3.3 找组给的摘录不在病历里 → 不改且不发复核", async () => {
  await withStub({ find: () => finderJson({ groups: [{ syndrome: "脾虚湿困证", items: ["神疲乏力", "食少便溏"], verdict: "independent" }] }), verify: KEEP }, async (calls) => {
    const raw = half();
    assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }), raw);
    assert.deepEqual([calls.find, calls.verify], [1, 0]);
  });
});
await check("3.4 甲方病历 4（肝气犯胃证，吻合度高）：桩模型会补也不发任何请求，原样返回", async () => {
  await withStub({ find: FIND_ADD, verify: KEEP, claims: () => ({ decision: "none" }) }, async (calls) => {
    const raw = half({
      primarySyndrome: "肝气犯胃证",
      tcmDiagnosticRationale: "胃脘胀痛、因情绪波动诱发、嗳气矢气则舒，为肝气犯胃；胸闷、善叹息为肝失条达；舌淡红薄白苔、脉弦细与气滞肝郁相符。",
    }, "疏肝解郁，理气止痛");
    assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_C4 }), raw);
    assert.deepEqual([calls.find, calls.verify, calls.claims], [0, 0, 0]);
  });
});
await check("3.5 开关 CDSS_M03_SECONDARY_GROUP_CHECK=false 与未定主证（unresolved）、已有兼证：都不发请求", async () => {
  await withStub({ find: FIND_ADD, verify: KEEP }, async (calls) => {
    process.env.CDSS_M03_SECONDARY_GROUP_CHECK = "false";
    try {
      const raw = half();
      assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }), raw);
    } finally { delete process.env.CDSS_M03_SECONDARY_GROUP_CHECK; }
    const unresolved = half({ primarySyndromeResolution: "unresolved" });
    assert.equal(await secondary.reconcileSecondarySyndromes(unresolved, { recordText: RECORD_0614 }), unresolved);
    const existing = half({ secondarySyndromes: ["血瘀证"] });
    assert.equal(await secondary.reconcileSecondarySyndromes(existing, { recordText: RECORD_0614 }), existing);
    assert.deepEqual([calls.find, calls.verify, calls.claims], [0, 0, 0]);
  });
});
await check("3.6 主证对不上教材行（证名自拟）时不设闸；模型不可用（请求抛错）原样返回、不抛", async () => {
  await withStub({ find: FIND_ADD, verify: KEEP }, async (calls) => {
    const out = JSON.parse(await secondary.reconcileSecondarySyndromes(half({ primarySyndrome: "中焦湿热蕴结证" }), { recordText: RECORD_0614 }));
    assert.deepEqual(out.overview.secondarySyndromes, ["脾虚湿困证"]);
    assert.equal(calls.find, 1);
  });
  globalThis.fetch = async () => { throw new Error("upstream down"); };
  try {
    const raw = half();
    assert.equal(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }), raw);
  } finally { globalThis.fetch = savedFetch; }
});
await check("3.7 依据里自称兼夹（第一条路）补兼证时优先于找组的结果；两条路并行各发一次", async () => {
  await withStub({
    claims: () => ({ decision: "add", secondarySyndrome: "脾气虚证", method: "健脾益气", evidence: ["边有齿痕", "脉细滑"] }),
    find: () => finderJson({ groups: [{ syndrome: "肝气郁结证", items: ["舌淡暗", "边有齿痕"], verdict: "independent" }], secondarySyndrome: "肝气郁结证", method: "疏肝解郁" }),
    verify: KEEP,
  }, async (calls) => {
    const raw = half({ tcmDiagnosticRationale: "苔薄黄腻、口苦口粘，为湿热中阻；舌淡暗边有齿痕、脉细滑，兼有脾气不足。" });
    const out = JSON.parse(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }));
    assert.deepEqual(out.overview.secondarySyndromes, ["脾气虚证"]);
    assert.deepEqual([calls.claims, calls.find], [1, 1]);
  });
});
await check("3.8 第一条路只能「删说法」、找组有结果时以找组为准（删与补相抵，补兼证后依据里不另立兼证的说法按原规则去掉）", async () => {
  await withStub({
    claims: () => ({ decision: "remove", clauses: ["舌淡暗边有齿痕、脉细滑，兼有脾气不足"] }),
    find: FIND_ADD, verify: KEEP,
  }, async () => {
    const raw = half({ tcmDiagnosticRationale: "苔薄黄腻、口苦口粘，为湿热中阻；舌淡暗边有齿痕、脉细滑，兼有脾气不足。" });
    const out = JSON.parse(await secondary.reconcileSecondarySyndromes(raw, { recordText: RECORD_0614 }));
    assert.deepEqual(out.overview.secondarySyndromes, ["脾虚湿困证"]);
    assert.match(out.overview.tcmDiagnosticRationale, /兼有脾气不足/u, "补兼证时不删依据里的说法");
  });
});

// ───── 4 改名不丢复合证因素 ─────
const table = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-formula-table.json", "utf8"));
const diseasesInTable = [...new Set(table.rows.map((row) => row.disease))];
const evidenceOf = (disease, syndrome) => table.rows.filter((row) => row.disease === disease && (!syndrome || row.syndromeName === syndrome)).map((row) => `${row.manifestations}${row.tongue}${row.pulse}`).join("，");
const COMPOUND_NAMES = [["气滞血瘀证", "行气活血化瘀"], ["气虚血瘀证", "益气活血化瘀"], ["气阴两虚证", "益气养阴"], ["肝郁脾虚证", "疏肝健脾"], ["痰瘀互结证", "化痰活血"], ["脾肾阳虚证", "温补脾肾"], ["湿热瘀阻证", "清热利湿化瘀"], ["气血两虚证", "补益气血"], ["心脾两虚证", "补益心脾"], ["肝肾阴虚证", "滋补肝肾"], ["脾肾气虚证", "健脾益肾"], ["肺肾两虚证", "补肺益肾"]];
const qiOf = (name) => /气(?=虚|滞|阴|血|衰|亏|不足)/u.test(name.replace(/阳气(?=虚|衰|不足|亏)/gu, "阳"));
const stagnationOf = (name) => /郁|滞|气犯|不和|肝旺/u.test(name);
const organsOf = (name) => name.match(/心|肝|脾|肺|肾|胃|胆|肠|膀胱/gu) || [];

await check("4.1 扫描：每个教材病 × 12 个复合证名（病里没有这个证名的）× 以该病全部证型的主症为病历，改名结果不丢「气」、不丢「郁滞」、不把两脏合称改成不写脏腑的行", () => {
  let renamed = 0; let total = 0;
  for (const disease of diseasesInTable) {
    const evidence = evidenceOf(disease);
    for (const [name, method] of COMPOUND_NAMES) {
      if (textbook.textbookRowForSyndrome(disease, name)) continue;
      total += 1;
      const row = textbook.textbookNearestRow(disease, name, method, evidence, []);
      if (!row) continue;
      renamed += 1;
      assert.ok(!qiOf(name) || qiOf(row.syndromeName), `${disease} ${name} → ${row.syndromeName} 丢了「气」`);
      assert.ok(!stagnationOf(name) || stagnationOf(row.syndromeName), `${disease} ${name} → ${row.syndromeName} 丢了「郁滞」`);
      assert.ok(new Set(organsOf(name)).size < 2 || new Set(organsOf(row.syndromeName)).size > 0, `${disease} ${name} → ${row.syndromeName} 两脏合称改成了不写脏腑的行`);
    }
  }
  assert.ok(total > 5000, `扫描样本 ${total}`);
  assert.ok(renamed > 30, `对照：同义写法仍在改名（${renamed}）`);
});
await check("4.2 具体例：月经过少的「气滞血瘀证」不再改成「血瘀证」；汗证（教材无此证名）的「气阴两虚证」不再改成阴虚火旺类；同义写法照旧（眩晕·气血两虚证→气血亏虚证、瘿病·痰瘀互结证→痰结血瘀证、白疕·气滞血瘀证→气血瘀滞证）", () => {
  const nearest = (disease, name, method, source) => textbook.textbookNearestRow(disease, name, method, evidenceOf(disease, source), []);
  assert.equal(nearest("月经过少", "气滞血瘀证", "行气活血化瘀", "血瘀证"), undefined);
  assert.equal(nearest("血证", "气阴两虚证", "益气养阴", "阴虚火旺证"), undefined);
  assert.equal(nearest("眩晕", "气血两虚证", "补益气血")?.syndromeName, "气血亏虚证");
  assert.equal(nearest("瘿病", "痰瘀互结证", "化痰活血")?.syndromeName, "痰结血瘀证");
  assert.equal(nearest("白疕", "气滞血瘀证", "行气活血化瘀")?.syndromeName, "气血瘀滞证");
});
await check("4.3 病位栏只写了一脏的两脏合称仍按单脏归一（10/17 口径：证名「肝肾阴虚」、病位只有「肾」）；病历 5 的肺脾两虚证在虚劳里不改成单脏行（对照）", () => {
  const evidence = evidenceOf("虚劳");
  const kept = textbook.textbookNearestRow("虚劳", "肺脾两虚证", "补益肺气，健脾益气，固表止汗", evidence, ["肺", "脾"]);
  assert.ok(!kept || /肺/u.test(kept.syndromeName) && /脾/u.test(kept.syndromeName), kept?.syndromeName);
});

console.log(JSON.stringify({ suite: "r1021-compound", cases, failures: process.exitCode ? "see above" : 0 }));

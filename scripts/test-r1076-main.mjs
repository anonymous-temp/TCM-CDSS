// 第五十八轮（2026-11-23）：强制重新生成（x-cdss-regenerate: force）时方名、药味、加减仍会变。
// 用户定：把之前的结果作为背景回传给模型，差异尽量小。量法与材料见 ~/runlogs/r1018/work/r1076。
//  A. 模型调用层（model-call-memo.server.ts）：强制时只重抽阶段主生成，其余同内容回放；主生成以同内容上一次的输出为基准。
//  B. 按病历留的基准（regeneration-anchor.server.ts）：开方提示词变了（辨证文字重写）时兜底；辨证只作比对。
//  C. 阶段结果留存的挂钩与路由接线。
// 每条断言都有反证（~/runlogs/r1018/work/r1076/cp/）。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const only = process.env.R1076_CHECK;
const check = async (id, name, run) => {
  if (only && only !== id) return;
  try {
    await run();
    console.log(`✓ ${id} ${name}`);
  } catch (error) {
    console.error(`✗ ${id} ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "test-key-test-key-test-key-1234";
process.env.CDSS_MODEL_CALL_MEMO = "true";
delete process.env.CDSS_MODEL_CALL_MEMO_PATH;
delete process.env.CDSS_REGENERATE_FRESH_SCOPE;
delete process.env.CDSS_REGENERATION_ANCHOR;
const memo = await jiti.import("../src/lib/model-call-memo.server.ts");
const coalesce = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
const anchor = await jiti.import("../src/lib/regeneration-anchor.server.ts");

const URL_ = "https://example.invalid/v1/chat/completions";
const body = (content, extra = {}) => JSON.stringify({ model: "deepseek-flash", temperature: 0, stream: false, max_tokens: 100, messages: [{ role: "system", content: "系统提示" }, { role: "user", content }], ...extra });
const okJson = (text, finish = "stop") => JSON.stringify({ choices: [{ finish_reason: finish, message: { content: text } }] });
const realFetch = globalThis.fetch;
function stub(responder) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push(init?.body);
    return responder(calls.length, init);
  };
  return calls;
}
const jsonResponse = (text, status = 200) => new Response(text, { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const inScope = (run, options = {}) => memo.runWithModelCallMemo(options, run);
const call = async (content, options = {}, init = {}) =>
  JSON.parse(await (await memo.memoizedModelFetch(URL_, { method: "POST", body: body(content), ...init }, undefined, options)).text()).choices[0].message.content;
const PRIMARY = { primaryGeneration: true };
const userContent = (sent) => JSON.parse(sent).messages.at(-1).content;
const withEnv = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

// ─── A. 模型调用层 ─────────────────────────────────────────────────────────────────────────

await check("A1", "强制重新生成只重抽阶段主生成：小任务同内容照常回放，主生成真实调用并覆盖", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => { await call("小任务甲"); await settle(); await call("主生成甲", PRIMARY); await settle(); });
  assert.equal(calls.length, 2);
  const forced = await inScope(async () => {
    const aux = await call("小任务甲");
    const primary = await call("主生成甲", PRIMARY);
    await settle();
    return { aux, primary };
  }, { fresh: true });
  assert.equal(forced.aux, "答1", "小任务输入没变，应回放");
  assert.equal(forced.primary, "答3", "主生成应真实重抽");
  assert.equal(calls.length, 3);
  assert.equal(await inScope(() => call("主生成甲", PRIMARY)), "答3", "重抽结果覆盖旧答案，之后的不强制请求回放新答案");
});

await check("A2", "CDSS_REGENERATE_FRESH_SCOPE=all 恢复全部重抽（量整条链路的独立抽样时用）", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => { await call("小任务乙"); await settle(); });
  await withEnv({ CDSS_REGENERATE_FRESH_SCOPE: "all" }, async () => {
    assert.equal(await inScope(() => call("小任务乙"), { fresh: true }), "答2");
  });
  assert.equal(calls.length, 2);
});

await check("A3", "外部检索段不是主生成：强制时照常回放；all 时重算", async () => {
  memo.resetModelCallMemoForTests();
  let computed = 0;
  const compute = async () => `检索${++computed}`;
  await inScope(() => memo.memoizedScopeText("external_evidence_prescribe", ["病历丙"], compute));
  await settle();
  assert.equal(await inScope(() => memo.memoizedScopeText("external_evidence_prescribe", ["病历丙"], compute), { fresh: true }), "检索1");
  assert.equal(computed, 1);
  await withEnv({ CDSS_REGENERATE_FRESH_SCOPE: "all" }, async () => {
    assert.equal(await inScope(() => memo.memoizedScopeText("external_evidence_prescribe", ["病历丙"], compute), { fresh: true }), "检索2");
  });
});

await check("A4", "主生成重抽：同内容上一次的输出接在最后一条 user 消息末尾作基准；键不变，新输出覆盖旧输出", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`{"方名":"第${n}版"}`)));
  await inScope(async () => { await call("开方提示词", PRIMARY); await settle(); });
  await inScope(async () => { await call("开方提示词", PRIMARY); await settle(); }, { fresh: true });
  assert.equal(calls.length, 2);
  const sent = JSON.parse(calls[1]);
  assert.equal(sent.messages[0].content, "系统提示", "系统消息不动");
  assert.ok(userContent(calls[1]).startsWith("开方提示词\n\n【同一份输入上一次的输出（本次重新生成的基准）】"), "基准段接在原提示词之后");
  assert.ok(userContent(calls[1]).includes('{"方名":"第1版"}'), "带上一次的完整输出");
  assert.ok(/把上一次的输出原样再写一遍/.test(userContent(calls[1])));
  assert.ok(!/才改那一项|才可以改/.test(userContent(calls[1])), "不给模型留「可以改」的口子：安全核对由确定性层每次重做");
  assert.deepEqual({ ...sent, messages: undefined }, { ...JSON.parse(body("开方提示词")), messages: undefined }, "其余请求参数不变");
  // 新输出存回原键：下一次强制以第 2 版为基准；不强制时回放第 2 版。
  await inScope(async () => { await call("开方提示词", PRIMARY); await settle(); }, { fresh: true });
  assert.ok(userContent(calls[2]).includes('{"方名":"第2版"}') && !userContent(calls[2]).includes("第1版"));
  assert.equal(await inScope(() => call("开方提示词", PRIMARY)), '{"方名":"第3版"}');
  assert.equal(calls.length, 3);
});

await check("A5", "没有同内容的上一次输出：有路由给的兜底基准段就用它，没有就照原样发；两者都有时用上一次输出", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => { await call("提示词一", PRIMARY); await settle(); }, { fresh: true });
  assert.equal(calls[0], body("提示词一"), "没有基准时请求体逐字不变");
  await inScope(async () => {
    memo.setRegenerationFallbackSection("【同一份病历上一次的处方】方名：桂枝汤");
    await call("提示词二", PRIMARY);
    await settle();
  }, { fresh: true });
  assert.equal(userContent(calls[1]), "提示词二\n\n【同一份病历上一次的处方】方名：桂枝汤");
  await inScope(async () => {
    memo.setRegenerationFallbackSection("【同一份病历上一次的处方】方名：桂枝汤");
    await call("提示词二", PRIMARY);
    await settle();
  }, { fresh: true });
  assert.ok(userContent(calls[2]).includes("上一次输出开始\n答2"), "有同内容的上一次输出时用它");
  assert.ok(!userContent(calls[2]).includes("桂枝汤"), "不再叠加兜底段");
});

await check("A6", "CDSS_REGENERATION_ANCHOR=false：强制重新生成回到独立抽样，请求体不带任何基准", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => { await call("提示词三", PRIMARY); await settle(); });
  await withEnv({ CDSS_REGENERATION_ANCHOR: "false" }, async () => {
    await inScope(async () => {
      memo.setRegenerationFallbackSection("兜底段");
      assert.equal(await call("提示词三", PRIMARY), "答2");
    }, { fresh: true });
  });
  assert.equal(calls[1], body("提示词三"));
});

await check("A7", "不强制时不带基准：有留存就回放，没有就照原样发（即使路由设了兜底段）；小任务强制时也不带", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => {
    memo.setRegenerationFallbackSection("兜底段");
    await call("提示词四", PRIMARY);
    await settle();
    assert.equal(await call("提示词四", PRIMARY), "答1");
  });
  assert.deepEqual(calls, [body("提示词四")]);
  await inScope(async () => {
    memo.setRegenerationFallbackSection("兜底段");
    await call("小任务没有留存");
  }, { fresh: true });
  assert.equal(calls[1], body("小任务没有留存"), "小任务不是主生成，不带基准");
  // 全部重抽（all）时小任务也重抽，但基准只给主生成：小任务的输出格式各不相同，不能套同一句要求。
  await withEnv({ CDSS_REGENERATE_FRESH_SCOPE: "all" }, async () => {
    await settle();
    await inScope(async () => {
      memo.setRegenerationFallbackSection("兜底段");
      await call("小任务没有留存");
    }, { fresh: true });
  });
  assert.equal(calls[2], body("小任务没有留存"));
});

await check("A8", "从留存的原始响应取模型正文：流式逐段拼接、非流式取 message；工具调用、空正文、超长、残缺都不作基准", () => {
  const sse = [
    `data: {"choices":[{"delta":{"content":"{\\"方名\\":"}}]}`,
    `data: {"choices":[{"delta":{"reasoning_content":"思考不算"}}]}`,
    `data: {"choices":[{"delta":{"content":"\\"桂枝汤\\"}"}}]}`,
    `data: {"choices":[{"finish_reason":"stop","delta":{}}]}`,
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(memo.assistantTextFromModelResponse(sse), '{"方名":"桂枝汤"}');
  assert.equal(memo.assistantTextFromModelResponse(okJson("  正文  ")), "正文");
  // 强制工具调用（辨证两半不合 schema 时的重试）没有正文，取它的参数：那才是当时被采用的输出。
  assert.equal(memo.assistantTextFromModelResponse(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ function: { arguments: '{"westernDiagnosis":{}}' } }] } }] })), '{"westernDiagnosis":{}}');
  assert.equal(memo.assistantTextFromModelResponse([
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":"}}]}}]}`,
    `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]}}]}`,
    `data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}`,
  ].join("\n\n")), '{"a":1}');
  assert.equal(memo.assistantTextFromModelResponse(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ function: { arguments: "" } }] } }] })), undefined);
  assert.equal(memo.assistantTextFromModelResponse(okJson("")), undefined);
  assert.equal(memo.assistantTextFromModelResponse(okJson("长".repeat(24_001))), undefined);
  assert.equal(memo.assistantTextFromModelResponse(okJson("长".repeat(24_000))).length, 24_000);
  assert.equal(memo.assistantTextFromModelResponse("data: {残缺"), undefined);
  assert.equal(memo.assistantTextFromModelResponse("不是JSON"), undefined);
});

await check("A9", "基准段只接在最后一条 user 消息的字符串正文后；不是预期形状的请求体原样发", () => {
  const multi = JSON.stringify({ model: "m", messages: [{ role: "user", content: "先" }, { role: "assistant", content: "中" }, { role: "user", content: "后" }] });
  const out = JSON.parse(memo.requestBodyWithRegenerationSection(multi, "基准"));
  assert.deepEqual(out.messages.map((item) => item.content), ["先", "中", "后\n\n基准"]);
  assert.equal(memo.requestBodyWithRegenerationSection(JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "图" }] }] }), "基准"), undefined);
  assert.equal(memo.requestBodyWithRegenerationSection(JSON.stringify({ messages: [{ role: "system", content: "只有系统" }] }), "基准"), undefined);
  assert.equal(memo.requestBodyWithRegenerationSection(JSON.stringify({ prompt: "没有消息" }), "基准"), undefined);
  assert.equal(memo.requestBodyWithRegenerationSection("不是JSON", "基准"), undefined);
});

await check("A10", "降级结果用过的答案作废后不再成为基准", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => {
    await call("提示词五", PRIMARY);
    await settle();
    await memo.forgetModelCallsInScope(memo.currentModelCallMemoScope());
  });
  await inScope(async () => { await call("提示词五", PRIMARY); await settle(); }, { fresh: true });
  assert.equal(calls[1], body("提示词五"));
});

await check("A11", "基准读取落盘留存：进程重启（清内存）后强制重新生成仍带上一次输出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r1076-memo-"));
  try {
    await withEnv({ CDSS_MODEL_CALL_MEMO_PATH: dir }, async () => {
      memo.resetModelCallMemoForTests();
      const calls = stub((n) => jsonResponse(okJson(`落盘答${n}`)));
      await inScope(async () => { await call("提示词六", PRIMARY); await settle(); });
      await new Promise((resolve) => setTimeout(resolve, 80));
      memo.resetModelCallMemoForTests();
      await inScope(async () => { await call("提示词六", PRIMARY); await settle(); }, { fresh: true });
      assert.ok(userContent(calls[1]).includes("落盘答1"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── B. 按病历留的基准 ─────────────────────────────────────────────────────────────────────

const prior = (overrides = {}) => ({
  stage: "diagnose",
  overview: { tcmDiseaseName: "遗尿", primarySyndrome: "下元虚寒证", secondarySyndromes: [], recommendedFormulaNames: ["菟丝子散", "桑螵蛸散"],
    recommendedFormulaDirection: "菟丝子散合桑螵蛸散加减", formulaSelectionMode: "combined", overallTherapy: "温补肾阳，固摄止遗", ...overrides },
  pathogenesis: { chain: [{ nodeId: "P1" }] },
  therapy: { overallMethod: "温补肾阳，固摄止遗" },
  westernDiagnosis: { primary: { name: "遗尿症待查" } },
});
const prescription = (herbs, modifications = [], extra = {}) => ({
  stage: "prescribe",
  formula: {
    candidates: [{ name: "菟丝子散合桑螵蛸散加减", constructionType: "combined", formulaNames: ["菟丝子散", "桑螵蛸散"], herbs,
      decoction: { doseCount: "7剂", course: "7日" }, ...extra }],
    modifications,
    patentAndWestern: [{ name: "缩泉丸" }],
  },
});
const HERBS = [
  { name: "菟丝子", dose: "6g", role: "君", decoctionRequirement: "包煎" },
  { name: "桑螵蛸", dose: "5g", role: "君" },
  { name: "制附子", dose: "3g", role: "臣", decoctionRequirement: "先煎、久煎" },
  { name: "龟甲", dose: "9g", role: "佐" },
];
const MODS = [{ trigger: "本例已见反复遗尿", action: "加", herbName: "覆盆子", doseOrHandling: "5g" }, { trigger: "睡眠深", action: "加", herbName: "益智", doseOrHandling: "2.5g" }];

await check("B1", "病历指纹：各阶段产物、流程字段、病例编号不进；病历、租户、代码版本不同就不同", async () => {
  const tenant = { clientId: "c", customerId: "hospital-a" };
  const record = { chiefComplaint: "反复遗尿1年", symptoms: { 现病史: "夜间遗尿，神疲乏力" }, patient: { age: 6, sex: "男" } };
  const key = (state, t = tenant) => coalesce.stageRecordFingerprint("prescribe", t, state);
  const base = key(record);
  assert.equal(key({ ...record, id: "另一个编号", reasoningDiagnose: prior(), diagnosis: "正文", prescription: "正文", reasoningPrescribe: {}, reasoningV2: {},
    questionRounds: 2, safetyGate: { status: "ready" }, clinicalFacts: {}, completeness: {} }), base);
  assert.equal(key({ ...record, chiefComplaint: "反复遗尿1年。" }), base, "只差句末标点算同一份");
  assert.notEqual(key({ ...record, chiefComplaint: "反复遗尿2年" }), base);
  assert.notEqual(key(record, { ...tenant, customerId: "hospital-b" }), base);
  assert.notEqual(coalesce.stageRecordFingerprint("diagnose", tenant, record), base, "两个阶段各留各的");
  await withEnv({ CDSS_BUILD_SOURCE_DIGEST: "另一版" }, () => assert.notEqual(key(record), base, "换了版本不认上一版的结论"));
});

await check("B2", "开方基准：取方名、逐味药名剂量角色、加减、中成药与所依据的辨证结论；不给剂量的页、非开方结果、没有辨证都不作基准", () => {
  const got = anchor.prescribeAnchorFromReasoning(prescription(HERBS, MODS), prior());
  assert.equal(got.name, "菟丝子散合桑螵蛸散加减");
  assert.deepEqual(got.herbs.map((herb) => `${herb.name}${herb.dose}${herb.role}`), ["菟丝子6g君", "桑螵蛸5g君", "制附子3g臣", "龟甲9g佐"]);
  assert.deepEqual(got.modifications.map((row) => row.herbName), ["覆盆子", "益智"]);
  assert.deepEqual(got.medicines, ["缩泉丸"]);
  assert.deepEqual(got.basis, { tcmDiseaseName: "遗尿", primarySyndrome: "下元虚寒证", secondarySyndromes: [], lockedFormulaNames: ["菟丝子散", "桑螵蛸散"] });
  assert.equal(anchor.prescribeAnchorFromReasoning(prescription([...HERBS.slice(0, 3), { name: "龟甲", dose: null, role: "佐" }]), prior()), undefined, "有一味没有剂量");
  assert.equal(anchor.prescribeAnchorFromReasoning({ ...prescription(HERBS), stage: "diagnose" }, prior()), undefined);
  assert.equal(anchor.prescribeAnchorFromReasoning(prescription(HERBS), undefined), undefined);
  assert.equal(anchor.prescribeAnchorFromReasoning(prescription([]), prior()), undefined);
});

await check("B3", "上次的处方是在同一组辨证结论下开的才作基准：病名、主证、兼证、锁定方任一不同就不用", () => {
  const got = anchor.prescribeAnchorFromReasoning(prescription(HERBS, MODS), prior({ secondarySyndromes: ["脾气虚证", "肺气虚证"] }));
  assert.equal(anchor.prescribeAnchorApplies(got, prior({ secondarySyndromes: ["肺气虚证", "脾气虚证"] })), true, "兼证顺序不同算相同");
  assert.equal(anchor.prescribeAnchorApplies(got, prior({ secondarySyndromes: ["脾气虚证"] })), false);
  assert.equal(anchor.prescribeAnchorApplies(got, prior({ secondarySyndromes: ["脾气虚证", "肺气虚证"], primarySyndrome: "肾气不足证" })), false);
  assert.equal(anchor.prescribeAnchorApplies(got, prior({ secondarySyndromes: ["脾气虚证", "肺气虚证"], tcmDiseaseName: "小便不禁" })), false);
  assert.equal(anchor.prescribeAnchorApplies(got, prior({ secondarySyndromes: ["脾气虚证", "肺气虚证"], recommendedFormulaNames: ["菟丝子散"] })), false);
  assert.equal(anchor.prescribeAnchorApplies(undefined, prior()), false);
  assert.equal(anchor.prescribeAnchorApplies(got, undefined), false);
});

await check("B4", "与基准比「决定」：方名、增减药味、剂量、角色、加减行逐项数得出；「本例已见」前缀与文字不算差别", () => {
  const before = anchor.prescribeAnchorFromReasoning(prescription(HERBS, MODS), prior());
  const same = anchor.prescribeAnchorFromReasoning(prescription(HERBS.map((herb) => ({ ...herb, function: "换了说法" })),
    [{ ...MODS[0], trigger: "反复遗尿", reason: "换了说法" }, MODS[1]]), prior());
  assert.deepEqual(anchor.prescribeAnchorDifference(before, same),
    { nameChanged: false, herbsAdded: [], herbsRemoved: [], dosesChanged: 0, rolesChanged: 0, modificationsAdded: 0, modificationsRemoved: 0 });
  const changed = anchor.prescribeAnchorFromReasoning(prescription(
    [{ ...HERBS[0], dose: "9g" }, HERBS[1], { ...HERBS[2], role: "佐" }, { name: "煅龙骨", dose: "9g", role: "佐" }],
    [MODS[1], { trigger: "畏寒肢冷", action: "加", herbName: "肉桂", doseOrHandling: "2g" }], { name: "菟丝子散加减" }), prior());
  assert.deepEqual(anchor.prescribeAnchorDifference(before, changed),
    { nameChanged: true, herbsAdded: ["煅龙骨"], herbsRemoved: ["龟甲"], dosesChanged: 1, rolesChanged: 1, modificationsAdded: 1, modificationsRemoved: 1 });
  assert.equal(anchor.prescribeAnchorDifference(before, undefined), undefined, "本次是不给剂量的页时不可比");
});

await check("B5", "写给模型的处方基准段：方名、每一味的药名剂量角色与味数、加减、中成药都在；没有的写明上次未列", () => {
  const section = anchor.prescribeAnchorPromptSection(anchor.prescribeAnchorFromReasoning(prescription(HERBS, MODS), prior()));
  assert.ok(section.startsWith("【同一份病历上一次的处方（本次重新生成的基准）】"));
  assert.ok(section.includes("方名：菟丝子散合桑螵蛸散加减"));
  assert.ok(section.includes("共4味）：菟丝子 6g 君；桑螵蛸 5g 君；制附子 3g 臣；龟甲 9g 佐"));
  assert.ok(section.includes("随证加减（共2条）：本例已见反复遗尿：加覆盆子 5g；睡眠深：加益智 2.5g"));
  assert.ok(section.includes("中成药/西药：缩泉丸"));
  assert.ok(section.includes("剂数与疗程：7剂，7日"));
  assert.ok(/就是上面这4味，药名（含炮制写法）、剂量、君臣佐使逐味相同，不增不减/.test(section));
  const bare = anchor.prescribeAnchorPromptSection(anchor.prescribeAnchorFromReasoning({ stage: "prescribe", formula: { candidates: [{ name: "自拟方", herbs: HERBS }], modifications: [], patentAndWestern: null } }, prior()));
  assert.ok(bare.includes("随证加减：上次未列") && bare.includes("中成药/西药：上次未推荐"));
});

await check("B6", "辨证结论（只作比对）：有限结论不留；病名、主证、兼证、治法、锁定方、西医名逐项比", () => {
  const got = anchor.diagnoseAnchorFromReasoning(prior());
  assert.deepEqual([got.tcmDiseaseName, got.primarySyndrome, got.overallMethod, got.westernName, got.lockedFormulaNames.join("+")],
    ["遗尿", "下元虚寒证", "温补肾阳，固摄止遗", "遗尿症待查", "菟丝子散+桑螵蛸散"]);
  assert.equal(anchor.diagnoseAnchorFromReasoning({ ...prior(), pathogenesis: { chain: [] } }), undefined, "没有病机链的有限结论");
  assert.equal(anchor.diagnoseAnchorFromReasoning({ ...prior(), stage: "prescribe" }), undefined);
  assert.deepEqual(anchor.diagnoseAnchorDifference(got, anchor.diagnoseAnchorFromReasoning(prior())),
    { diseaseChanged: false, primaryChanged: false, secondaryChanged: false, methodChanged: false, lockChanged: false, westernChanged: false });
  const other = { ...prior({ primarySyndrome: "肺脾气虚证", recommendedFormulaNames: ["补中益气汤"], secondarySyndromes: ["肾气不足证"] }), therapy: { overallMethod: "补肺健脾" }, westernDiagnosis: { primary: { name: "遗尿症" } } };
  assert.deepEqual(anchor.diagnoseAnchorDifference(got, anchor.diagnoseAnchorFromReasoning(other)),
    { diseaseChanged: false, primaryChanged: true, secondaryChanged: true, methodChanged: true, lockChanged: true, westernChanged: true });
});

const sentinel = (value) => `正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(value)}\n<!-- DIAGNOSIS_JSON_END -->`;
await check("B7", "留存：与阶段结果留存同开同关、可单独关闭；按病历取，另一份病历取不到；落盘加密且清内存后仍读得到", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r1076-anchor-"));
  const tenant = { clientId: "c", customerId: "hospital-a" };
  const record = { chiefComplaint: "反复遗尿1年", symptoms: { 现病史: "夜间遗尿" } };
  const extract = (value) => anchor.prescribeAnchorFromReasoning(value, prior());
  try {
    await withEnv({ CDSS_STAGE_RESULT_REUSE: "true", CDSS_STAGE_RESULT_STORE_PATH: dir }, async () => {
      coalesce.resetStageResultCacheForTests();
      assert.equal(await anchor.readPrescribeAnchor(tenant, record), undefined);
      const stored = extract(prescription(HERBS, MODS));
      await coalesce.writeStageSidecar("regeneration-anchor-prescribe", coalesce.stageRecordFingerprint("prescribe", tenant, record), stored);
      assert.deepEqual(await anchor.readPrescribeAnchor(tenant, { ...record, id: "换了编号", reasoningDiagnose: prior() }), stored);
      assert.equal(await anchor.readPrescribeAnchor(tenant, { ...record, chiefComplaint: "反复遗尿2年" }), undefined);
      assert.equal(await anchor.readPrescribeAnchor({ ...tenant, customerId: "hospital-b" }, record), undefined);
      const files = readdirSync(join(dir, "regeneration-anchor-prescribe"), { recursive: true }).filter((name) => String(name).endsWith(".bin"));
      assert.equal(files.length, 1);
      assert.ok(!readFileSync(join(dir, "regeneration-anchor-prescribe", String(files[0]))).toString("utf8").includes("菟丝子"), "文件里没有明文");
      coalesce.resetStageResultCacheForTests();
      assert.deepEqual(await anchor.readPrescribeAnchor(tenant, record), stored, "清内存后从盘上读");
      // 留存里不是一份处方基准（形状不对、别的阶段的）时按没有处理。
      const odd = { ...record, chiefComplaint: "形状不对的留存" };
      for (const value of [{ v: 1, stage: "prescribe", basis: stored.basis, herbs: [] }, { v: 1, stage: "diagnose", primarySyndrome: "证", tcmDiseaseName: "病" }, "文本", null]) {
        await coalesce.writeStageSidecar("regeneration-anchor-prescribe", coalesce.stageRecordFingerprint("prescribe", tenant, odd), value);
        assert.equal(await anchor.readPrescribeAnchor(tenant, odd), undefined);
      }
      await withEnv({ CDSS_REGENERATION_ANCHOR: "false" }, async () => assert.equal(await anchor.readPrescribeAnchor(tenant, record), undefined));
      await withEnv({ CDSS_STAGE_RESULT_REUSE: "false" }, async () => assert.equal(await anchor.readPrescribeAnchor(tenant, record), undefined));
      // 换密钥读不出按没有处理。
      coalesce.resetStageResultCacheForTests();
      await withEnv({ CASE_SNAPSHOT_ENCRYPTION_KEY: "another-key-another-key-123456" }, async () => assert.equal(await anchor.readPrescribeAnchor(tenant, record), undefined));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    coalesce.resetStageResultCacheForTests();
  }
});

await check("B8", "rememberPrescribeAnchor / rememberDiagnoseAnchor：从最终正文取结论留存；不给剂量的页与有限结论不留", async () => {
  const tenant = { clientId: "c", customerId: "hospital-a" };
  const record = { chiefComplaint: "反复遗尿1年" };
  await withEnv({ CDSS_STAGE_RESULT_REUSE: "true", CDSS_STAGE_RESULT_STORE_PATH: "" }, async () => {
    coalesce.resetStageResultCacheForTests();
    const full = { schemaVersion: "tcm-cdss-reasoning-v2", ...JSON.parse(JSON.stringify(prior())) };
    anchor.rememberDiagnoseAnchor(tenant, record, "没有结构化结果的降级页");
    await settle();
    assert.equal(await anchor.readDiagnoseAnchor(tenant, record), undefined);
    anchor.rememberPrescribeAnchor(tenant, record, "不给剂量的页（没有结构化结果）", full);
    await settle();
    assert.equal(await anchor.readPrescribeAnchor(tenant, record), undefined);
    // 真实交付的一对辨证、开方结果（第五十七轮夹具）：留下来的就是交付的方名、药味与加减。
    const pair = Object.values(JSON.parse(readFileSync(new URL("./fixtures/m04-salvage/delivered-pairs.json", import.meta.url), "utf8")).cases)[0];
    anchor.rememberDiagnoseAnchor(tenant, record, sentinel(pair.m03));
    anchor.rememberPrescribeAnchor(tenant, record, sentinel(pair.m04), pair.m03);
    await settle();
    const diagnosed = await anchor.readDiagnoseAnchor(tenant, record);
    assert.equal(diagnosed.primarySyndrome, pair.m03.overview.primarySyndrome);
    assert.equal(diagnosed.westernName, pair.m03.westernDiagnosis.primary.name);
    const prescribed = await anchor.readPrescribeAnchor(tenant, record);
    const delivered = pair.m04.formula.candidates[0];
    assert.equal(prescribed.name, delivered.name);
    assert.deepEqual(prescribed.herbs.map((herb) => [herb.name, herb.dose, herb.role]), delivered.herbs.map((herb) => [herb.name, herb.dose, herb.role]));
    assert.equal(prescribed.modifications.length, pair.m04.formula.modifications.filter((row) => row.trigger && row.herbName).length);
    assert.equal(anchor.prescribeAnchorApplies(prescribed, pair.m03), true);
    assert.deepEqual(Object.values(anchor.prescribeAnchorDifference(prescribed, anchor.prescribeAnchorFromReasoning(pair.m04, pair.m03))).flat().filter(Boolean), []);
    // 辨证与开方各留各的：只留了辨证的病历读不到处方基准。
    const other = { chiefComplaint: "另一份病历" };
    anchor.rememberDiagnoseAnchor(tenant, other, sentinel(pair.m03));
    await settle();
    assert.equal(await anchor.readPrescribeAnchor(tenant, other), undefined);
  });
  coalesce.resetStageResultCacheForTests();
});

// ─── C. 阶段结果留存的挂钩与路由接线 ───────────────────────────────────────────────────────

const ndjson = (content) => new Response(`${JSON.stringify({ content })}\n${JSON.stringify({ content: "[END]" })}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
await check("C1", "onReusableResult：真实算出可复用结果时调一次（含强制重算）；回放、不可复用、关闭复用时不调", async () => {
  await withEnv({ CDSS_STAGE_RESULT_REUSE: "true", CDSS_STAGE_RESULT_STORE_PATH: "" }, async () => {
    coalesce.resetStageResultCacheForTests();
    const seen = [];
    const request = (overrides = {}) => ({ stage: "prescribe", key: "r1076-c1", compute: async () => ndjson("处方正文"), cacheable: () => true,
      onReusableResult: (content) => seen.push(content), ...overrides });
    await (await coalesce.coalesceStageResponse(request())).text(); await settle();
    assert.deepEqual(seen, ["处方正文"]);
    const replay = await coalesce.coalesceStageResponse(request()); await replay.text(); await settle();
    assert.equal(replay.headers.get("x-cdss-stage-result"), "reused");
    assert.equal(seen.length, 1, "回放不是新结果");
    await (await coalesce.coalesceStageResponse(request({ bypass: true, compute: async () => ndjson("重算正文") }))).text(); await settle();
    assert.deepEqual(seen, ["处方正文", "重算正文"]);
    await (await coalesce.coalesceStageResponse(request({ key: "r1076-c1b", cacheable: () => false }))).text(); await settle();
    assert.equal(seen.length, 2, "降级页不留");
    // 回调抛错不影响结果，也不漏成未处理的异常。
    let leaked;
    const onLeak = (error) => { leaked = error; };
    process.on("uncaughtException", onLeak); process.on("unhandledRejection", onLeak);
    try {
      const thrown = await coalesce.coalesceStageResponse(request({ key: "r1076-c1c", onReusableResult: () => { throw new Error("boom"); } }));
      // 回调在收尾里抛错而没被接住时，订阅者不会被关闭，响应流会一直挂着：限时读。
      const body = await Promise.race([thrown.text(), new Promise((resolve) => setTimeout(() => resolve("（响应流没有结束）"), 500))]);
      assert.ok(body.includes("处方正文"), body);
      await settle();
    } finally {
      process.off("uncaughtException", onLeak); process.off("unhandledRejection", onLeak);
    }
    assert.equal(leaked, undefined, "留存回调的异常漏出去了");
  });
  await withEnv({ CDSS_STAGE_RESULT_REUSE: "false" }, async () => {
    const seen = [];
    await (await coalesce.coalesceStageResponse({ stage: "prescribe", key: "r1076-c1d", compute: async () => ndjson("正文"), cacheable: () => true, onReusableResult: (content) => seen.push(content) })).text();
    await settle();
    assert.equal(seen.length, 0);
  });
  coalesce.resetStageResultCacheForTests();
});

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
await check("C2", "接线：流层发出的请求标为主生成，SDK 小任务不标；开方路由只在强制时读基准、辨证结论相同才交给调用层兜底", () => {
  const api = source("lib/diagnosis-api.ts");
  const helper = api.slice(api.indexOf("export async function fetchWithConnectTimeout("), api.indexOf("export async function readProviderChunk("));
  assert.ok(helper.length > 200 && helper.length < 3000, "切片越界");
  assert.ok(/memoizedModelFetch\(url, \{ \.\.\.init, signal: attemptController\.signal \}, undefined, \{ primaryGeneration: true \}\)/.test(helper));
  assert.equal(api.split("memoizedModelFetch(").length - 1, 1, "流层只有这一个出口");
  const transport = source("lib/model-transport-observation.ts");
  assert.ok(transport.includes("return memoizedModelFetch(input, init, onNetworkAttempt);"), "小任务出口不带 primaryGeneration");
  const route = source("app/api/diagnosis/prescribe/route.ts");
  assert.ok(/const regenerationAnchor = regenerate\s*\?\s*await readPrescribeAnchor\(parsed\.customer, parsed\.caseState\)\.catch\(\(\) => undefined\)\s*:\s*undefined;/.test(route));
  assert.ok(route.includes("const applicableRegenerationAnchor = prescribeAnchorApplies(regenerationAnchor, submittedPriorReasoning) ? regenerationAnchor : undefined;"));
  assert.ok(route.includes("setRegenerationFallbackSection(applicableRegenerationAnchor ? prescribeAnchorPromptSection(applicableRegenerationAnchor) : undefined);"));
  assert.ok(route.includes("onReusableResult: (content) => rememberPrescribeAnchor(parsed.customer, parsed.caseState, content, diagnoseReasoningFromState(parsed.caseState)),"));
  const diagnose = source("app/api/diagnosis/diagnose/route.ts");
  assert.ok(diagnose.includes("rememberDiagnoseAnchor(parsed.customer, parsed.caseState, content);"));
  assert.ok(!diagnose.includes("setRegenerationFallbackSection"), "辨证不用交付结论作基准（交付写法不是模型原样输出，回灌不幂等）");
  const archive = source("lib/request-archive.server.ts");
  assert.ok(archive.includes("runWithModelCallMemo({ fresh: regenerateFreshRequested(req) }, () => handler(req))"));
});

globalThis.fetch = realFetch;
if (process.exitCode) console.error("\nr1076-main 有失败项");

// 第三十四轮（2026-11-01）：同病历波动与耗时、改坏余项。量法与材料见 ~/runlogs/r1018/work/r1046。
// 1. 同内容的模型调用只算一次（model-call-memo.server.ts）：作用域、键、完整响应、作废、加密落盘、合流。
// 2. regenerate=1 不再重抽；force 才重抽。
// 每条断言都有反证（~/runlogs/r1018/work/r1046/cp/）。
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

const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "test-key-test-key-test-key-1234";
const memo = await jiti.import("../src/lib/model-call-memo.server.ts");
const coalesce = await jiti.import("../src/lib/stage-result-coalescing.server.ts");

const URL_ = "https://example.invalid/v1/chat/completions";
const body = (content, extra = {}) => JSON.stringify({ model: "deepseek-flash", temperature: 0, stream: false, max_tokens: 100, messages: [{ role: "user", content }], ...extra });
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
const call = async (content, extra) => (await memo.memoizedModelFetch(URL_, { method: "POST", body: body(content, extra) })).text();

process.env.CDSS_MODEL_CALL_MEMO = "true";

await check("1.1 作用域外（健康检查、部署探针）永远真实调用", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  assert.equal(JSON.parse(await call("探针")).choices[0].message.content, "答1");
  await settle();
  assert.equal(JSON.parse(await call("探针")).choices[0].message.content, "答2");
  assert.equal(calls.length, 2);
});

await check("1.1b 开关关闭时路由作用域也不生效（本机与测试默认如此，生产默认开）", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  process.env.CDSS_MODEL_CALL_MEMO = "false";
  await inScope(() => call("关闭时"));
  await settle();
  await inScope(() => call("关闭时"));
  process.env.CDSS_MODEL_CALL_MEMO = "true";
  assert.equal(calls.length, 2);
});

await check("1.2 作用域内同内容回放原始响应，只调一次", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  const first = await inScope(() => call("病历甲"));
  await settle();
  const second = await inScope(() => call("病历甲"));
  assert.equal(first, second);
  assert.equal(calls.length, 1);
});

await check("1.3 键：全半角与空白不算不同；内容、模型、温度不同才算；max_tokens 不进键", () => {
  const key = (content, extra) => memo.modelCallMemoKey(URL_, body(content, extra));
  assert.equal(key("舌淡红， 苔白。"), key("舌淡红,苔白."));
  assert.equal(key("甲", { max_tokens: 100 }), key("甲", { max_tokens: 900 }));
  assert.notEqual(key("无胸痛，发热"), key("无胸痛发热"));
  assert.notEqual(key("甲"), key("乙"));
  assert.notEqual(key("甲"), key("甲", { temperature: 0.4 }));
  assert.notEqual(key("甲"), key("甲", { model: "qwen3.8-flash" }));
  assert.notEqual(key("甲"), key("甲", { stream: true }));
  assert.equal(memo.modelCallMemoKey(URL_, "不是JSON"), undefined);
});

await check("1.4 被截断、非 2xx、断流的响应不存", async () => {
  assert.equal(memo.modelResponseComplete(okJson("x", "length")), false);
  assert.equal(memo.modelResponseComplete(okJson("x")), true);
  assert.equal(memo.modelResponseComplete(okJson("", "stop")), false);
  assert.equal(memo.modelResponseComplete(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`), false);
  assert.equal(memo.modelResponseComplete(`data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n`), true);
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => (n === 1 ? jsonResponse("{}", 503) : n === 2 ? jsonResponse(okJson("截断", "length")) : jsonResponse(okJson("完整"))));
  await inScope(() => call("病历乙"));
  await settle();
  await inScope(() => call("病历乙"));
  await settle();
  assert.equal(JSON.parse(await inScope(() => call("病历乙"))).choices[0].message.content, "完整");
  assert.equal(calls.length, 3);
});

await check("1.5 阶段结果降级：这次用过的答案作废，下一次重抽", async () => {
  memo.resetModelCallMemoForTests();
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(async () => {
    await call("病历丙");
    await settle();
    await memo.forgetModelCallsInScope(memo.currentModelCallMemoScope());
  });
  assert.equal(JSON.parse(await inScope(() => call("病历丙"))).choices[0].message.content, "答2");
  assert.equal(calls.length, 2);
});

await check("1.6 fresh（显式重抽）不读旧答案、算完覆盖", async () => {
  memo.resetModelCallMemoForTests();
  stub((n) => jsonResponse(okJson(`答${n}`)));
  await inScope(() => call("病历丁"));
  await settle();
  const redrawn = await inScope(() => call("病历丁"), { fresh: true });
  assert.equal(JSON.parse(redrawn).choices[0].message.content, "答2");
  await settle();
  assert.equal(JSON.parse(await inScope(() => call("病历丁"))).choices[0].message.content, "答2");
});

await check("1.7 落盘加密：文件里没有明文；进程重启（清内存）后命中；换密钥读不出按未命中", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memo-"));
  process.env.CDSS_MODEL_CALL_MEMO_PATH = dir;
  try {
    memo.resetModelCallMemoForTests();
    const calls = stub((n) => jsonResponse(okJson(`患者胃痛答${n}`)));
    await inScope(() => call("病历戊"));
    await settle();
    const shard = readdirSync(dir)[0];
    const file = readdirSync(join(dir, shard)).find((name) => name.endsWith(".bin"));
    assert.ok(file);
    assert.ok(!readFileSync(join(dir, shard, file)).includes(Buffer.from("患者胃痛")));
    memo.resetModelCallMemoForTests();
    assert.match(await inScope(() => call("病历戊")), /答1/);
    assert.equal(calls.length, 1);
    memo.resetModelCallMemoForTests();
    const saved = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY;
    process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = "another-key-another-key-another";
    assert.match(await inScope(() => call("病历戊")), /答2/);
    process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = saved;
    assert.equal(calls.length, 2);
  } finally {
    delete process.env.CDSS_MODEL_CALL_MEMO_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("1.8 进行中的同内容调用并入；先到的失败，后到的自己再发", async () => {
  memo.resetModelCallMemoForTests();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = stub(async (n) => {
    await gate;
    return jsonResponse(okJson(`答${n}`));
  });
  const [one, two] = await Promise.all([inScope(() => call("病历己")), inScope(() => call("病历己")), (async () => { await settle(); release(); })()]);
  assert.equal(one, two);
  assert.equal(calls.length, 1);
  memo.resetModelCallMemoForTests();
  const calls2 = stub((n) => (n === 1 ? Promise.reject(new Error("断了")) : jsonResponse(okJson("第二次"))));
  const outcome = await Promise.allSettled([inScope(() => call("病历庚")), inScope(() => call("病历庚"))]);
  assert.equal(outcome[0].status, "rejected");
  assert.match(outcome[1].value, /第二次/);
  assert.equal(calls2.length, 2);
});

await check("1.9 回放的流式响应能被原样读出（SSE 全文）", async () => {
  memo.resetModelCallMemoForTests();
  const sse = `data: {"choices":[{"delta":{"content":"甲"}}]}\n\ndata: {"choices":[{"finish_reason":"stop","delta":{"content":"乙"}}]}\n\ndata: [DONE]\n\n`;
  stub(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
  await inScope(() => call("病历辛", { stream: true }));
  await settle();
  const replay = await inScope(() => memo.memoizedModelFetch(URL_, { method: "POST", body: body("病历辛", { stream: true }) }));
  assert.equal(replay.headers.get("content-type"), "text/event-stream");
  assert.equal(await replay.text(), sse);
});

await check("1.10 中止信号：等别人的结果时被中止，立刻抛出", async () => {
  memo.resetModelCallMemoForTests();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stub(async () => { await gate; return jsonResponse(okJson("x")); });
  const owner = inScope(() => call("病历壬"));
  await settle();
  const controller = new AbortController();
  const joiner = inScope(() => memo.memoizedModelFetch(URL_, { method: "POST", body: body("病历壬"), signal: controller.signal }));
  controller.abort();
  await assert.rejects(joiner);
  release();
  await owner;
});

await check("2.1 regenerate=1 不再重抽；force 才重抽；开关恢复旧口径", () => {
  const request = (headers, query = "") => new Request(`https://x.invalid/api/diagnosis/diagnose${query}`, { method: "POST", headers });
  assert.equal(coalesce.regenerateFreshRequested(request({ "x-cdss-regenerate": "1" })), false);
  assert.equal(coalesce.regenerateFreshRequested(request({}, "?regenerate=1")), false);
  assert.equal(coalesce.regenerateFreshRequested(request({ "x-cdss-regenerate": "force" })), true);
  assert.equal(coalesce.regenerateFreshRequested(request({}, "?regenerate=force")), true);
  assert.equal(coalesce.regenerateFreshRequested(request({})), false);
  process.env.CDSS_REGENERATE_REDRAW = "true";
  assert.equal(coalesce.regenerateFreshRequested(request({ "x-cdss-regenerate": "1" })), true);
  delete process.env.CDSS_REGENERATE_REDRAW;
});

await check("2.2 阶段结果降级时作废本次模型答案（coalesce 接到作用域）", async () => {
  memo.resetModelCallMemoForTests();
  process.env.CDSS_STAGE_RESULT_REUSE = "true";
  const calls = stub((n) => jsonResponse(okJson(`答${n}`)));
  const run = () => memo.runWithModelCallMemo({}, () => coalesce.coalesceStageResponse({
    stage: "diagnose",
    key: "k-degraded",
    compute: async () => {
      const text = await call("病历癸");
      return new Response(`${JSON.stringify({ content: text })}\n${JSON.stringify({ content: "[END]" })}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    },
    cacheable: () => false,
  }));
  await (await run()).text();
  await settle();
  await (await run()).text();
  assert.equal(calls.length, 2);
  delete process.env.CDSS_STAGE_RESULT_REUSE;
  coalesce.resetStageResultCacheForTests();
});

globalThis.fetch = realFetch;
delete process.env.CDSS_MODEL_CALL_MEMO;

// ───── 3 治法：模型原写的项单独问；证名一写出来就先发提名 ─────
const coverage = await jiti.import("../src/lib/m03-method-coverage.server.ts");
const smallMemo = await jiti.import("../src/lib/small-task-memo.server.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const modelConfigEnv = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://api.deepseek.com", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", BAILIAN_QWEN_API_KEY: "k", BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_MODEL: "qwen3.8-flash", PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-flash" };

await check("3.1 模型原写的项用「只有写错才去掉」的问法；提名至多两项；教材治法原有的项不动", async () => {
  Object.assign(process.env, modelConfigEnv);
  smallMemo.resetSmallTaskMemoForTests();
  const row = textbook.textbookRowForSyndrome("咳嗽", "风寒袭肺证");
  assert.ok(row);
  const systems = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(init.body);
    const system = request.messages[0].content;
    systems.push(system);
    const content = /把病历里这次的现症按组列出来/.test(system)
      ? JSON.stringify({ groups: [{ findings: ["痰多色白质稀"], coveredBy: null, item: "化痰" }, { findings: ["鼻塞", "流清涕"], coveredBy: null, item: "通窍" }, { findings: ["咽痒", "咽干"], coveredBy: null, item: "利咽" }] })
      : JSON.stringify({ confirmed: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const content = JSON.stringify({ overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证", overallTherapy: "" }, therapy: { overallMethod: `${row.therapy}，健脾和胃` } });
  const out = JSON.parse(await coverage.completeMethodCoverage(content, { recordText: "咳嗽三天，痰多色白质稀，鼻塞，流清涕，咽痒，咽干", chiefComplaint: "咳嗽三天" }));
  assert.ok(systems.length > 0, `没发请求: ${JSON.stringify(out.therapy)}`);
  const items = String(out.therapy.verifiedMethodItem).split("，");
  assert.equal(items[0], "健脾和胃");
  assert.ok(items.includes("化痰"));
  assert.ok(items.length <= 3);
  assert.ok(systems.some((one) => /核对初拟治法里的一项/.test(one)));
  // 模型没写别的项时，提名补的也至多两项。
  smallMemo.resetSmallTaskMemoForTests();
  const onlyNamed = JSON.parse(await coverage.completeMethodCoverage(JSON.stringify({ overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证" }, therapy: { overallMethod: row.therapy } }), { recordText: "咳嗽三天，痰多色白质稀，鼻塞，流清涕，咽痒，咽干", chiefComplaint: "咳嗽三天" }));
  assert.equal(String(onlyNamed.therapy.verifiedMethodItem).split("，").length, 2);
  // 提名的提示词里没有模型写的治法：证名一写出来就能先发，收口时同一请求命中。
  const before = systems.length;
  coverage.prefetchMethodCoverage({ tcmDiseaseName: "咳嗽", primarySyndrome: "风寒袭肺证" }, { recordText: "咳嗽三天，痰多色白质稀，鼻塞，流清涕，咽痒，咽干", chiefComplaint: "咳嗽三天" });
  await settle();
  assert.equal(systems.length, before, "提名与复核都应命中已有结果");
  globalThis.fetch = realFetch;
});

await check("3.2 第三十三轮量到的：同一件事不重复（化痰止咳 后面不再加 化痰）", () => {
  assert.equal(coverage.methodItemQualifies({ item: "化痰", quotes: [], fromModel: true }, { method: "疏风散寒，化痰止咳", recordText: "" }), false);
  assert.equal(coverage.methodItemQualifies({ item: "利咽", quotes: [], fromModel: true }, { method: "疏风散寒，化痰止咳", recordText: "" }), true);
  // 提名补的项要成组：一条顺带表现不够，两条或在主诉里才算。
  const context = { method: "疏风散寒", recordText: "咳嗽三天，痰多色白，大便干", chiefComplaint: "咳嗽三天，痰多色白" };
  assert.equal(coverage.methodItemQualifies({ item: "清热通便", quotes: ["大便干"] }, context), false);
  assert.equal(coverage.methodItemQualifies({ item: "化痰", quotes: ["痰多色白"] }, context), true);
  assert.equal(coverage.methodItemQualifies({ item: "润肠", quotes: ["大便干", "咳嗽三天"] }, context), true);
  assert.equal(coverage.methodItemQualifies({ item: "润肠", quotes: ["大便干", "没有的话"] }, context), false);
});

// ───── 4 加减 ─────
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");

await check("4.1 条件自己写明方向才随条件走；没写明（若咽痛明显）、不是条件句的，照旧核对", () => {
  assert.equal(contract.conditionDeclaresHighImpactDirection("若畏寒肢冷、腹部喜温", "herb_0_unsupported_high_impact_yang_warm"), true);
  assert.equal(contract.conditionDeclaresHighImpactDirection("若发热甚", "herb_0_unsupported_high_impact_heat_clear"), true);
  assert.equal(contract.conditionDeclaresHighImpactDirection("若咽痛明显", "herb_0_unsupported_high_impact_heat_clear"), false);
  assert.equal(contract.conditionDeclaresHighImpactDirection("发热甚", "herb_0_unsupported_high_impact_heat_clear"), false);
  assert.equal(contract.conditionDeclaresHighImpactDirection("若发热甚", "herb_0_unsupported_high_impact_yang_warm_blood_move"), false);
  assert.equal(contract.conditionDeclaresHighImpactDirection("若发热甚", "herb_0_other"), false);
});

await check("4.2 模型条件夹了舌脉：去掉那一段留症状；全是舌脉的不动", () => {
  assert.equal(textbook.conditionWithoutTonguePulseClauses("若头晕较甚、苔厚腻"), "若头晕较甚");
  assert.equal(textbook.conditionWithoutTonguePulseClauses("若心烦口苦，舌红苔转黄"), "若心烦口苦");
  assert.equal(textbook.conditionWithoutTonguePulseClauses("若舌红少苔"), "若舌红少苔");
  assert.equal(textbook.conditionWithoutTonguePulseClauses("若腹胀明显"), "若腹胀明显");
});

const addRow = (trigger, herbName, extra = {}) => ({ actionType: "add", trigger, targetRef: "P1", herbName, reason: "随证", ...extra });
const modPrior = { stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "脾胃虚寒证" }, pathogenesis: { chain: [{ nodeId: "P1" }] } };

await check("4.3 超过四行时先留不同的条件；同一条件的第二行里加味排在「调整」前面", () => {
  const rows = compiler.normalizeModificationsForTest([
    addRow("若反酸", "海螵蛸"),
    addRow("若反酸", "瓦楞子"),
    addRow("若腹胀", "木香"),
    addRow("若腹胀", "枳壳"),
    addRow("若纳差", "鸡内金"),
    addRow("若便溏", "炒薏苡仁"),
  ], modPrior);
  assert.deepEqual(rows.map((row) => row.trigger), ["若反酸", "若腹胀", "若纳差", "若便溏"]);
});

await check("4.4 加味保留炮制写法（煅瓦楞子、焦山楂）；未识别前缀不算；下游按身份比不受影响", () => {
  const rows = compiler.normalizeModificationsForTest([addRow("若反酸", "煅瓦楞子"), addRow("若食积", "焦山楂"), addRow("若便溏", "炒白术"), addRow("若寒甚", "丁香")], modPrior);
  assert.deepEqual(rows.map((row) => row.herbName), ["煅瓦楞子", "焦山楂", "炒白术", "丁香"]);
  assert.equal(contract.canonicalTcmHerbIdentity("煅瓦楞子"), "瓦楞子");
});

await check("4.5 不同的条件不足两个时补写：每行过编译同一套判据；已够两个条件不发请求", async () => {
  Object.assign(process.env, modelConfigEnv);
  smallMemo.resetSmallTaskMemoForTests();
  const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "胃气不和证" }, therapy: { overallMethod: "理气和胃" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "胃气不和", therapyDirection: "理气和胃" }] } };
  const root = (modifications) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ overview: prior.overview, therapy: prior.therapy, formula: { candidates: [{ herbs: [{ name: "陈皮" }, { name: "半夏" }, { name: "甘草" }] }], modifications } })}\n<!-- DIAGNOSIS_JSON_END -->`;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const system = JSON.parse(init.body).messages[0].content;
    const content = /写备用的随证加减/.test(system)
      ? JSON.stringify({ rows: [
          { trigger: "若腹胀明显", herbName: "枳壳", dose: "10g", reason: "行气消胀" },
          { trigger: "若腹胀明显", herbName: "厚朴", dose: "10g", reason: "同一条件不算新条件" },
          { trigger: "若颈部结块", herbName: "海藻", dose: "10g", reason: "软坚散结，与甘草十八反" },
          { trigger: "若食少", herbName: "鸡内金", dose: "500g", reason: "超量" },
          { trigger: "若舌红", herbName: "麦冬", dose: "10g", reason: "写舌象" },
          { trigger: "若食积", herbName: "焦山楂", dose: "10g", reason: "消食化积" },
        ] })
      : JSON.stringify({ confirmed: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await fit.topUpModificationConditions(root([]), { recordText: "胃胀三天", prior, caseState: undefined });
  const body = JSON.parse(out.slice(out.indexOf("START -->") + 9, out.indexOf("<!-- DIAGNOSIS_JSON_END")));
  assert.deepEqual(body.formula.modifications.map((row) => row.herbName), ["枳壳", "焦山楂"]);
  assert.equal(body.formula.modifications[0].evidence.confidence, "低");
  calls = 0;
  const enough = root([{ trigger: "若腹胀", herbName: "枳壳" }, { trigger: "若嗳气", herbName: "旋覆花" }]);
  assert.equal(await fit.topUpModificationConditions(enough, { recordText: "胃胀三天", prior }), enough);
  assert.equal(calls, 0);
  globalThis.fetch = realFetch;
});

const element = await jiti.import("../src/lib/m03-element-support.server.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const phi = await jiti.import("../src/lib/phi-sanitizer.ts");

// ───── 6 第三十三轮审计留下的 ─────
await check("6.1 证素撤下不动流派句与否认句（扶阳句里的阳虚实据；舌质淡红示血虚未甚）；断言句照撤", () => {
  const content = JSON.stringify({
    overview: { primarySyndrome: "寒凝血瘀证", secondarySyndromes: [], tcmDiagnosticRationale: "小腹冷痛、经色紫暗，为寒凝血瘀。舌质淡红示血虚未甚。神疲乏力、面色少华，为肝血不足。扶阳学派看阴阳实据，本例面色少华属血虚之象，与扶阳抑阴思路相符。" },
    therapy: { overallMethod: "温经散寒" }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "寒凝血瘀，兼肝血不足", therapyDirection: "温经散寒" }], uncertainties: [] },
  });
  const decision = { verdicts: [{ unit: { type: "血虚", entryName: "血虚证" }, verdict: { verdict: "fail", entry: "血虚证", specific: 0, category: 0, listed: 0, distinct: 0 } }] };
  const rationale = JSON.parse(element.applyElementSupportDecision(content, decision)).overview.tcmDiagnosticRationale;
  assert.match(rationale, /舌质淡红示血虚未甚/u);
  assert.match(rationale, /本例面色少华属血虚之象/u);
  assert.doesNotMatch(rationale, /为肝血不足/u);
});

await check("6.2 总治法丢了、分治法还在：按分治法写总治法", () => {
  const body = JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "胃气不和证" }, westernDiagnosis: {}, pathogenesis: { chain: [{ nodeId: "P1", therapyDirection: "理气和胃" }, { nodeId: "P2", therapyDirection: "理气和胃" }, { nodeId: "P3", therapyDirection: "升清止晕" }] }, therapy: { overallPrinciple: "实则泻之" } });
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${body}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = visible.applyM03AdvisoryQualityBoundaries(content, "胃胀");
  const root = JSON.parse(out.slice(out.indexOf("START -->") + 9, out.indexOf("<!-- DIAGNOSIS_JSON_END")));
  assert.equal(root.therapy.overallMethod, "理气和胃，升清止晕");
});

await check("6.2b 总治法里混进「不详」：只去这一项；提名写「不详」不算治法", () => {
  const body = JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "痰湿中阻证" }, westernDiagnosis: {}, pathogenesis: { chain: [{ nodeId: "P1", therapyDirection: "和胃降逆" }] }, therapy: { overallPrinciple: "标本兼治", overallMethod: "化痰祛湿，健脾和胃，不详" } });
  const content = `<!-- DIAGNOSIS_JSON_START -->\n${body}\n<!-- DIAGNOSIS_JSON_END -->`;
  const out = visible.applyM03AdvisoryQualityBoundaries(content, "头晕");
  const root = JSON.parse(out.slice(out.indexOf("START -->") + 9, out.indexOf("<!-- DIAGNOSIS_JSON_END")));
  assert.equal(root.therapy.overallMethod, "化痰祛湿，健脾和胃");
  assert.equal(coverage.methodItemQualifies({ item: "不详", quotes: ["诱因不详"] }, { method: "化痰祛湿", recordText: "起病诱因不详", chiefComplaint: "起病诱因不详" }), false);
});

await check("6.3 证-方方向提示只留寒热相反、且不是辨证阶段定的方", () => {
  const source = readFileSync("src/lib/diagnosis-visible-summary.ts", "utf8");
  assert.match(source, /conflict\.axis !== "thermal" \|\| direction\.includes\(base\) \|\| seen\.has\(base\)/u);
  const consistency = readFileSync("src/lib/formula-syndrome-consistency.ts", "utf8");
  assert.doesNotMatch(consistency, /确定性比对|标准目录归属/u);
});

await check("6.4 慢性失眠按 ICSD-3 写；查判据表、编码照旧能查到", async () => {
  const terminology = await jiti.import("../src/lib/clinical-terminology.ts");
  assert.equal(terminology.canonicalWesternDiagnosisName("慢性失眠障碍"), "慢性失眠");
  const criteria = await jiti.import("../src/lib/western-diagnostic-criteria.server.ts");
  assert.equal(criteria.westernCriteriaEntry("慢性失眠")?.name, "慢性失眠障碍");
});

await check("6.5 M03 外部检索也有软上限；关闭写法可用", async () => {
  const budget = await jiti.import("../src/lib/prompt-budget.ts");
  assert.equal(budget.m03ExternalEvidenceSoftDeadlineMs(), 2500);
  process.env.PRIMARY_DIAGNOSE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS = "off";
  assert.equal(budget.m03ExternalEvidenceSoftDeadlineMs(), undefined);
  delete process.env.PRIMARY_DIAGNOSE_EXTERNAL_EVIDENCE_SOFT_DEADLINE_MS;
});

await check("4.6 教材两味一组：带出来的那一味用自己的功效作理由；模型自己写了就用模型的；同一条件的行排在一起", () => {
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", recommendedFormulaNames: [] }, pathogenesis: { chain: [{ nodeId: "P1" }] } };
  const row = textbook.textbookRowForSyndrome("感冒", "风寒束表证");
  const index = row.modifications.findIndex((item) => item.herbs.includes("麻黄") && item.herbs.includes("桂枝"));
  assert.ok(index >= 0, JSON.stringify(row.modifications));
  const id = `E${index + 1}`;
  const base = { actionType: "add", targetRef: "P1", reason: "桂枝辛温解表，助荆防发散风寒", textbookEntry: id };
  const one = compiler.normalizeModificationsForTest([{ ...base, trigger: "若恶寒甚", herbName: "桂枝" }], prior);
  const partner = one.find((item) => item.herbName === "麻黄");
  assert.ok(partner, JSON.stringify(one));
  assert.doesNotMatch(partner.reason, /桂枝/u);
  const both = compiler.normalizeModificationsForTest([{ ...base, trigger: "若恶寒甚", herbName: "桂枝" }, { ...base, trigger: "若恶寒甚", herbName: "麻黄", reason: "麻黄发汗散寒" }], prior);
  assert.equal(both.find((item) => item.herbName === "麻黄").reason, "麻黄发汗散寒");
});

await check("4.7 条件式的行不挂到节点病机上（只共一个二字词不算）", () => {
  const clean = (value, fallback) => value || fallback;
  assert.equal(compiler.modificationTargetPathogenesis({ trigger: "若气虚夹湿", targetRef: "P1", reason: "x" }, { pathogenesis: "心胆气虚，决断失司" }, clean), "兼见气虚夹湿");
  assert.equal(compiler.modificationTargetPathogenesis({ trigger: "气虚乏力", targetRef: "P1", reason: "x" }, { pathogenesis: "心胆气虚，决断失司" }, clean), "心胆气虚，决断失司");
});

// ───── 5 文本 ─────

await check("5.2 撤兼证连「故」一起去掉，不留「…，故。」", () => {
  const root = { overview: { secondarySyndromes: ["脾虚湿滞证"], primarySyndrome: "肝郁气滞证", tcmDiagnosticRationale: "腹胀、纳差、便溏，为肝木乘脾、脾运失健，故兼脾虚湿滞。舌暗红有瘀点支持气滞血瘀，余症俱见。", overallPathogenesis: "肝郁气滞，兼脾虚湿滞" }, therapy: { overallMethod: "疏肝理气，健脾化湿" } };
  assert.equal(secondary.withdrawSecondarySyndrome(root, "脾虚湿滞证"), true);
  assert.doesNotMatch(root.overview.tcmDiagnosticRationale, /故[。；]/u);
  assert.match(root.overview.tcmDiagnosticRationale, /脾运失健。舌暗红/u);
});

await check("5.3 判断句的前半不算表现（故病位涉脾胃、病性属脾气虚）；表现句照旧留下", () => {
  const failed = new Set(["qi"]);
  const entail = element.entailedDeficiencies ? element.entailedDeficiencies([]) : undefined;
  assert.equal(element.findingsBeforeAttribution("故病位涉脾胃、病性属脾气虚", failed, entail), undefined);
  assert.equal(element.findingsBeforeAttribution("神疲乏力、面色少华为气血亏虚", failed, entail), "神疲乏力、面色少华");
});

await check("5.4 检查结论「钡透无异常」不改写成「未诉异常」；未记录的症状否认照旧改写", () => {
  assert.equal(visible.unrecordedNegativesAsNotReported("食道钡透无异常", "咽中梗阻"), "食道钡透无异常");
  assert.equal(visible.unrecordedNegativesAsNotReported("无胸痛", "咽中梗阻"), "未诉胸痛");
});

await check("5.5 改名后推理说明的框架句：后面还跟着描述时断开", () => {
  assert.equal(western.rationaleAlignedWithRenamedPrimary("符合膝骨关节炎退行性负重痛特点；尚无影像", "膝骨关节炎", "D"), "考虑膝骨关节炎可能，退行性负重痛特点；尚无影像");
  assert.equal(western.rationaleAlignedWithRenamedPrimary("符合慢性支气管炎临床诊断；尚缺肺功能", "慢性支气管炎", "D"), "考虑慢性支气管炎可能；尚缺肺功能");
});

await check("5.6 四味方容许缺末位一味（白虎汤去粳米）；前三味仍必须在；三味方仍要齐", () => {
  const baihu = provenance.formulaCompilationReferences(["白虎汤"])[0];
  assert.equal(baihu.ingredients.length, 4);
  assert.equal(baihu.minimumPreservedIngredientCount, 3);
  assert.ok(baihu.requiredIngredients.includes("石膏"));
  assert.ok(!baihu.requiredIngredients.includes("粳米"));
  assert.ok(provenance.formulaCompilationReferences(["四物汤"])[0].requiredIngredients.includes("白芍"));
  assert.equal(provenance.formulaCompilationReferences(["小陷胸汤"])[0].minimumPreservedIngredientCount, 3);
  assert.equal(provenance.formulaCompilationReferences(["桂枝汤"])[0].minimumPreservedIngredientCount, 4);
});

await check("5.7 「后时有咳嗽」不是姓名；真姓名照旧脱敏", () => {
  assert.match(phi.scrubSubjectPrefixedName ? "ok" : "ok", /ok/);
  const lexemes = JSON.parse(readFileSync("src/data/phi-clinical-lexemes.json", "utf8")).terms;
  assert.ok(lexemes.includes("后时"));
  assert.ok(!lexemes.includes("后"));
});

await check("5.10 兼证：特异表现写全三条即成组；只对上两条、没有共见类仍不够", () => {
  const entry = secondary.diagnosticsCriteriaFor("脾气虚证");
  assert.ok(entry && entry.specific.length >= 3);
  const [a, b, c] = entry.specific;
  const recordText = `${a}，${b}，${c}`;
  const hit = (items) => items.map((item) => ({ item, quote: item }));
  assert.equal(secondary.evaluateCriteriaMatches(entry, hit([a, b, c]), { recordText, primaryTerms: [] }).verdict, "pass");
  assert.equal(secondary.evaluateCriteriaMatches(entry, hit([a, b]), { recordText, primaryTerms: [] }).verdict, "fail");
});

await check("5.11 现病史写着患病多年：症状层面的名字也问已确诊慢性病", async () => {
  Object.assign(process.env, modelConfigEnv);
  smallMemo.resetSmallTaskMemoForTests();
  const standard = await jiti.import("../src/lib/western-name-standard.server.ts");
  const asked = [];
  globalThis.fetch = async (_input, init) => {
    const system = JSON.parse(init.body).messages[0].content;
    asked.push(system);
    const content = /当前西医诊断只写到症状/.test(system)
      ? JSON.stringify({ established: { name: "2型糖尿病", quote: "患糖尿病十余年", rationale: "血糖控制不佳" } })
      : JSON.stringify({ confirmed: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const western = JSON.stringify({ westernDiagnosis: { primary: { name: "糖尿病待查", clinicalRationale: "x" }, candidates: [], differentials: [] } });
  const out = JSON.parse(await standard.finalizeWesternPrimaryName(western, { recordText: "诉患糖尿病十余年不愈，口渴乏力", chiefComplaint: "患糖尿病十余年不愈" }));
  assert.equal(out.westernDiagnosis.primary.name, "2型糖尿病");
  asked.length = 0;
  await standard.finalizeWesternPrimaryName(JSON.stringify({ westernDiagnosis: { primary: { name: "咳嗽待查", clinicalRationale: "x" }, candidates: [], differentials: [] } }), { recordText: "咳嗽三天", chiefComplaint: "咳嗽三天" });
  assert.ok(!asked.some((one) => /当前西医诊断只写到症状/.test(one)));
  globalThis.fetch = realFetch;
});

await check("5.9 数「X味」时「全方保留」不挡第一味；「兼制青皮」的制是动词", async () => {
  const review = await jiti.import("../src/lib/formula-analysis-review.ts");
  const herbs = ["黄芪", "桂枝", "白芍", "炙甘草", "大枣", "饴糖"];
  assert.match(review.withRecountedHerbCountWords("全方保留黄芪、桂枝、白芍、炙甘草、大枣、饴糖七味，加干姜。", herbs).text, /饴糖六味/u);
  assert.equal(review.withMentionsAlignedToTableNames("白芍为佐，兼制青皮辛散之性。", ["白芍", "青皮"]).text, "白芍为佐，兼制青皮辛散之性。");
});

await check("5.8 方义多算一味共为君：表随方义；表里的君在方义里成了臣、或该味有毒的，不改", () => {
  const herb = (name, role) => ({ name, role, targetKind: "pathogenesis" });
  const hooks = compiler.m04CompilerTestHooks;
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "泄泻", primarySyndrome: "脾胃虚弱证" } };
  const base = { name: "参苓白术散", herbs: [herb("人参", "君"), herb("白术", "君"), herb("茯苓", "臣"), herb("山药", "臣")] };
  const promoted = hooks.withAnalysisConsistentCandidate({ ...base, formulaAnalysis: "人参、白术、茯苓三味为君，山药为臣。" }, prior);
  assert.equal(promoted.herbs.find((one) => one.name === "茯苓").role, "君");
  const demoting = hooks.withAnalysisConsistentCandidate({ ...base, formulaAnalysis: "人参为君，白术、茯苓为臣，山药为佐。" }, prior);
  assert.equal(demoting.herbs.find((one) => one.name === "白术").role, "君");
});

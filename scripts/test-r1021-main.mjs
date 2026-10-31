// 10/19 第九轮（主控）：甲方验收 P0 项。
//
//   1 加味之间不得相反（十八反十九畏）：两条加减各自与方中无反、同列一页即成禁忌药对（H 集 X-H-0163/0174：
//     理中丸「呕吐较甚加半夏」+「久呕…加附子」）。保留前一条，去掉后一条；不相反的加减、减/调整照旧（对照）
//   2 作答后的红旗筛查即经回环先算辨证与开方（甲方接口响应：作答后冷算 辨证约13s、红旗约5s）；预先算的病例与 HIS 随后的辨证请求同指纹；
//     不作答/跳过、带 regenerate、页面 cookie 请求、复用关闭时不算（对照）

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

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

const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");

await check("1.1 理中丸加「半夏」又加「附子」：后一条不列，原因记为与处方药味冲突；只加半夏、吴茱萸照旧；「减附子」不受影响（对照）", () => {
  const base = ["人参", "干姜", "白术", "炙甘草"];
  const items = [
    { action: "加", herbName: "半夏", trigger: "若呕吐较甚" },
    { action: "加", herbName: "吴茱萸", trigger: "若呕吐清水不止" },
    { action: "加", herbName: "附子", trigger: "若久呕不止，汗出肢冷" },
  ];
  const reasons = [];
  const kept = compiler.withoutMutuallyIncompatibleAdditions(items, base, reasons);
  assert.deepEqual(kept.map((item) => item.herbName), ["半夏", "吴茱萸"]);
  assert.deepEqual(reasons, ["action_conflicts_with_candidate"]);
  assert.equal(knowledge.findTcmHerbPairIncompatibilities([...base, ...kept.map((item) => item.herbName)]).length, 0);
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions(items.slice(0, 2), base).map((item) => item.herbName), ["半夏", "吴茱萸"]);
  const removal = [{ action: "加", herbName: "半夏" }, { action: "减", herbName: "附子" }];
  assert.equal(compiler.withoutMutuallyIncompatibleAdditions(removal, ["附子", "干姜"]).length, 1, "方中已有附子时加半夏仍不列（与方中相反）");
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions([{ action: "减", herbName: "附子" }], ["附子", "干姜"]).map((item) => item.herbName), ["附子"]);
});

await check("1.2 编译出口经过这道筛（模型加减与教材兜底加减两条路都走）", () => {
  const source = readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.match(source, /const compiledModifications = withoutMutuallyIncompatibleAdditions\(withConditionals/);
});

await check("2.1 作答后病例与 HIS 随后的辨证请求同指纹（流程字段不同也一样）；不作答的病例指纹不同（对照）", async () => {
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const pre = await jiti.import("../src/lib/no-answer-precompute.server.ts");
  const coalesce = await jiti.import("../src/lib/stage-result-coalescing.server.ts");
  const raw = { chiefComplaint: "胃痛3天", patient: { sex: "男", age: 40 }, symptoms: { 现病史: "胃脘胀痛，嗳气" },
    conversation: [{ role: "assistant", content: "疼痛与冷热的关系？" }, { role: "user", content: "遇冷加重，得温痛减" }] };
  const redFlagsState = types.normalizeCaseStateInput({ ...raw, questionRounds: 1, safetyGate: { status: "needs_information" } });
  const hisDiagnoseState = types.normalizeCaseStateInput(raw);
  const tenant = { clientId: "c", customerId: "hospital-a" };
  const precomputed = types.normalizeCaseStateInput(pre.answeredCaseState(redFlagsState));
  assert.equal(coalesce.stageRequestFingerprint("diagnose", tenant, precomputed), coalesce.stageRequestFingerprint("diagnose", tenant, hisDiagnoseState));
  const unanswered = types.normalizeCaseStateInput({ ...raw, conversation: [] });
  assert.notEqual(coalesce.stageRequestFingerprint("diagnose", tenant, unanswered), coalesce.stageRequestFingerprint("diagnose", tenant, hisDiagnoseState));
});

await check("2.2 只在作答后、接口令牌请求、复用开启时触发；regenerate、cookie 请求、未作答不触发（对照）", async () => {
  const types = await jiti.import("../src/lib/diagnosis-types.ts");
  const pre = await jiti.import("../src/lib/no-answer-precompute.server.ts");
  const previous = { reuse: process.env.CDSS_STAGE_RESULT_REUSE, key: process.env.REASONING_CONTRACT_SIGNING_KEY, fetch: globalThis.fetch };
  process.env.CDSS_STAGE_RESULT_REUSE = "true";
  process.env.REASONING_CONTRACT_SIGNING_KEY = "test-signing-key-for-precompute-0123456789";
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("", { status: 500 }); };
  try {
    const answered = types.normalizeCaseStateInput({ chiefComplaint: "胃痛3天", patient: { sex: "男", age: 40 }, symptoms: { 现病史: "胃脘胀痛" },
      conversation: [{ role: "assistant", content: "疼痛与冷热的关系？" }, { role: "user", content: "遇冷加重" }] });
    const unanswered = types.normalizeCaseStateInput({ chiefComplaint: "胃痛3天", patient: { sex: "男", age: 40 }, symptoms: { 现病史: "胃脘胀痛" }, conversation: [] });
    const request = (headers) => new Request("http://localhost/api/diagnosis/red-flags", { method: "POST", headers });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    pre.precomputeAnsweredPath(request({ "x-cdss-api-token": "t", "x-cdss-customer-id": "hospital-a" }), answered); await settle();
    assert.equal(calls.filter((url) => url.endsWith("/api/diagnosis/diagnose")).length, 1, JSON.stringify(calls));
    calls.length = 0;
    pre.precomputeAnsweredPath(request({ "x-cdss-api-token": "t", "x-cdss-regenerate": "1" }), answered); await settle();
    pre.precomputeAnsweredPath(request({ cookie: "tcm_cdss_ui_access=x" }), answered); await settle();
    pre.precomputeAnsweredPath(request({ "x-cdss-api-token": "t" }), unanswered); await settle();
    process.env.CDSS_STAGE_RESULT_REUSE = "false";
    pre.precomputeAnsweredPath(request({ "x-cdss-api-token": "t", "x-cdss-customer-id": "hospital-b" }), answered); await settle();
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.reuse === undefined) delete process.env.CDSS_STAGE_RESULT_REUSE; else process.env.CDSS_STAGE_RESULT_REUSE = previous.reuse;
    if (previous.key === undefined) delete process.env.REASONING_CONTRACT_SIGNING_KEY; else process.env.REASONING_CONTRACT_SIGNING_KEY = previous.key;
  }
});

await check("2.3 红旗筛查路由接上（页面答题期预热 prefetch=diagnose 不触发）", () => {
  const source = readFileSync("src/app/api/diagnosis/red-flags/route.ts", "utf8");
  assert.match(source, /if \(new URL\(req\.url\)\.searchParams\.get\("prefetch"\) === "diagnose"\) prefetchDiagnoseInputs\(parsed\.caseState\);\n[^\n]*\n[^\n]*\n  else precomputeAnsweredPath\(req, parsed\.caseState\);/);
});

console.log(JSON.stringify({ suite: "r1021-main", cases, failures: process.exitCode ? "see above" : 0 }));

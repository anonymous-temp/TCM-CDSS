// 第二十二轮（2026-10-26）：用户决定 D1–D5 的落地。
//   D1 发热伴胸闷（可伴气促）、无不稳定征象：不报红旗，24 小时内评估，剂量照常（febrileChestTightnessDeferralApplies）。
//   D2 宽容读取：键名大小写（Role/Content 等）照样读；生命体征传来的不是数值时从同一病例最近一次请求补回，补不回如实提示。
//   D3 临床接口响应也加密留存，与请求行用 exchangeId 对上。
// 每条断言都有反证（~/runlogs/r1018/work/r1034/counterproofs.txt）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "r1034-archive-"));
const SECRET = "r1034-test-snapshot-secret-0123456789";
process.env.CDSS_REQUEST_ARCHIVE = "true";
process.env.CDSS_REQUEST_ARCHIVE_PATH = ARCHIVE_DIR;
process.env.CASE_SNAPSHOT_ENCRYPTION_KEY = SECRET;
process.env.REASONING_CONTRACT_SIGNING_KEY = process.env.REASONING_CONTRACT_SIGNING_KEY || "r1034-test-signing-key-0123456789";

const types = await jiti.import("../src/lib/diagnosis-types.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const recovery = await jiti.import("../src/lib/input-vitals-recovery.server.ts");
const archive = await jiti.import("../src/lib/request-archive.server.ts");
const precompute = await jiti.import("../src/lib/internal-precompute.ts");
const exporter = await import("../scripts/request-archive-export.mjs");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/febrile-chest-tightness-deferral.json", import.meta.url), "utf8"));

const gateOf = (raw) => {
  const state = safety.withSafetyGate(types.normalizeCaseStateInput(raw));
  return {
    state,
    gate: state.safetyGate,
    mode: safety.derivePrescriptionPermission(state).candidateMode,
    target: safety.priorityEvaluationFollowupTarget(state),
  };
};
const patched = (base, patch) => {
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const [head, tail] = key.split(".");
    if (tail === undefined) next[head] = structuredClone(value);
    else next[head] = { ...(next[head] || {}), [tail]: value };
  }
  return next;
};

// ---------- D1 ----------
await check("1.1 D1：发热伴胸闷（气促）、生命体征按 NEWS2 稳定、无急性冠脉典型伴随 → 不报红旗，24 小时内评估（心肌炎、肺炎），剂量照常", () => {
  for (const item of fixture.deferred) {
    const { gate, mode, target } = gateOf(item.caseState);
    assert.equal(gate.redFlags.length, 0, `${item.id}: ${gate.redFlags.join("；")}`);
    assert.notEqual(mode, "non_dose_only", item.id);
    assert.equal(target?.pathway, "febrile_chest_tightness", `${item.id}: ${JSON.stringify(target)}`);
    assert.equal(target?.window, "within_24h", item.id);
  }
});

await check("1.1b D1 只替换原本会报的红旗：单纯发热加胸闷（无气促）既不报红旗也不加 24 小时评估", () => {
  for (const item of fixture.unaffected) {
    const { gate, target } = gateOf(item.caseState);
    assert.equal(gate.redFlags.length, 0, item.id);
    assert.notEqual(target?.pathway, "febrile_chest_tightness", `${item.id}: ${JSON.stringify(target)}`);
  }
});

await check("1.2 D1 不适用时红旗照旧：冷汗、已知冠心病、血氧 91、呼吸 26、心率 135、NEWS2 总分 6、只有体温、不发热、突发、胸痛、意识模糊", () => {
  const base = fixture.deferred[0].caseState;
  for (const control of fixture.mustStayRed) {
    const { gate, mode } = gateOf(patched(base, control.patch));
    assert.equal(gate.status, "red_flag", `${control.id}（${control.change}）: ${gate.status}`);
    assert.equal(mode, "non_dose_only", control.id);
  }
});

await check("1.3 D1 的复诊首句写 24 小时内、心电图与肌钙蛋白；红旗规则与 24 小时通道读同一个谓词", () => {
  const { state } = gateOf(fixture.deferred[0].caseState);
  const plan = [safety.priorityEvaluationFirstStep(safety.priorityEvaluationFollowupTarget(state)), safety.priorityEvaluationFollowUpNode(safety.priorityEvaluationFollowupTarget(state), "完成7剂（7日）后复诊")];
  assert.match(JSON.stringify(plan), /24小时内/);
  assert.match(JSON.stringify(plan), /心电图/);
  assert.match(JSON.stringify(plan), /肌钙蛋白/);
  assert.equal(safety.febrileChestTightnessDeferralApplies(types.normalizeCaseStateInput(fixture.deferred[0].caseState)), true);
});

// ---------- D2a 键名大小写 ----------
await check("2.1 D2：问答项写成 Role/Content（.NET 按属性名输出）照样读到；取值 Assistant/User 也认", () => {
  const raw = {
    chiefComplaint: "咳嗽，咳痰",
    patient: { sex: "女", age: 13 },
    conversation: [
      { Role: "assistant", Content: "既往用药后有无过敏反应？" },
      { Role: "User", Content: "既往使用安痛定后出现明确过敏反应\n胸痛，呕吐" },
    ],
  };
  const state = types.normalizeCaseStateInput(raw);
  assert.equal(state.conversation.length, 2, JSON.stringify(state.conversation));
  assert.equal(state.conversation[1].role, "user");
  assert.match(state.conversation[1].content, /安痛定/);
  const keyCase = types.canonicalizeInputKeyCase(raw);
  assert.deepEqual(keyCase.renamed, ["caseState.conversation[0].Role", "caseState.conversation[0].Content", "caseState.conversation[1].Role", "caseState.conversation[1].Content"]);
});

await check("2.2 D2：顶层与 patient 的大写键也读；同时给了小写键以小写为准；生命体征键与病历中文键原样保留", () => {
  const state = types.normalizeCaseStateInput({
    ChiefComplaint: "头痛3天",
    Patient: { Sex: "男", Age: 52 },
    Symptoms: { 现病史: "头痛3天，胀痛" },
    Vitals: { T: "36.8", BP: "128/80" },
    tongue: "舌红", Tongue: "舌淡",
  });
  assert.equal(state.chiefComplaint, "头痛3天");
  assert.equal(state.patient.sex, "男");
  assert.equal(state.patient.age, 52);
  assert.equal(state.symptoms.presentHistory, "头痛3天，胀痛");
  assert.equal(state.vitals.T, "36.8");
  assert.equal(state.tongue, "舌红");
});

// ---------- D2b 生命体征补回 ----------
const VK = { T: { ValueKind: 3 }, P: { ValueKind: 3 }, R: { ValueKind: 3 }, BP: { ValueKind: 3 } };
const readable = { T: "38.5", P: "88", R: "20", BP: "120/80" };
const record = { id: "case-001", chiefComplaint: "咽痛发热2天", patient: { sex: "女", age: 33 }, symptoms: { 现病史: "咽痛发热2天" } };
const bound = (raw) => types.normalizeCaseStateInput(raw);

await check("2.3 D2：生命体征传来 {ValueKind:3} 时，从同一租户同一病例 30 分钟内最近一次请求补回，只补读不出的项", () => {
  recovery.resetVitalsRecoveryForTests();
  const now = 1_800_000_000_000;
  const first = { ...record, vitals: readable };
  recovery.recoverUnreadableVitals(bound(first), first, "90000405", now);
  const second = { ...record, vitals: { ...VK, SpO2: "97" } };
  const out = recovery.recoverUnreadableVitals(bound(second), second, "90000405", now + 15_000);
  assert.deepEqual({ T: out.vitals.T, P: out.vitals.P, R: out.vitals.R, BP: out.vitals.BP, SpO2: out.vitals.SpO2 }, { ...readable, SpO2: "97" });
  assert.equal(out.inputDiagnostics, undefined);
  const gate = safety.withSafetyGate(out).safetyGate;
  assert.ok(!(gate.advisories || []).some((line) => /未能读取/.test(line)), JSON.stringify(gate.advisories));
});

await check("2.4 D2：别的租户、别的病例、超过 30 分钟、没有病例编号都不补；补不回的项如实写进 advisories", () => {
  for (const [label, tenant, caseId, delay] of [["其他租户", "00000239", "case-001", 1_000], ["其他病例", "90000405", "case-002", 1_000], ["超时", "90000405", "case-001", 31 * 60_000], ["无编号", "90000405", "", 1_000]]) {
    recovery.resetVitalsRecoveryForTests();
    const now = 1_800_000_000_000;
    const first = { ...record, vitals: readable };
    recovery.recoverUnreadableVitals(bound(first), first, "90000405", now);
    const second = { ...record, ...(caseId ? { id: caseId } : { id: undefined }), vitals: VK };
    const out = recovery.recoverUnreadableVitals(bound(second), second, tenant, now + delay);
    assert.equal(out.vitals.T, undefined, label);
    assert.deepEqual(out.inputDiagnostics?.unreadableVitals, ["T", "P", "R", "BP"], label);
    const gate = safety.withSafetyGate(out).safetyGate;
    assert.ok((gate.advisories || []).some((line) => /生命体征（T、P、R、BP）未能读取/.test(line)), `${label}: ${JSON.stringify(gate.advisories)}`);
  }
});

await check("2.5 D2：inputDiagnostics 只由服务端写，调用方在 caseState 里传进来会被丢掉", () => {
  const state = types.normalizeCaseStateInput({ ...record, vitals: readable, inputDiagnostics: { unreadableVitals: ["T"] } });
  assert.equal(state.inputDiagnostics, undefined);
});

// ---------- D3 响应留存 ----------
const readArchive = () => fs.readdirSync(ARCHIVE_DIR).filter((name) => name.endsWith(".ndjson"))
  .flatMap((name) => fs.readFileSync(path.join(ARCHIVE_DIR, name), "utf8").split("\n").filter(Boolean))
  .map((raw) => JSON.parse(raw))
  .map((line) => ({ route: line.route, ...exporter.decryptRequestArchiveLine(line, exporter.requestArchiveKeyFromSecret(SECRET)) }));
const ndjsonHandler = (chunks) => async (req) => {
  const body = await req.json();
  void archive.archiveClinicalRequest(req, body);
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/x-ndjson", "x-cdss-stage-result": "reused" } });
};

await check("3.1 D3：响应正文原样流给调用方，同时加密留存；请求行与响应行 exchangeId 相同，响应行 kind=response、带状态与复用头", async () => {
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  archive.resetRequestArchiveStateForTests();
  const chunks = ['{"content":"辨证："}\n', '{"content":"风热犯表证"}\n', '{"content":"[END]"}\n'];
  const handler = archive.withClinicalResponseArchive(ndjsonHandler(chunks));
  const response = await handler(new Request("http://127.0.0.1/tcm-cdss/api/diagnosis/diagnose", {
    method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "90000405" }, body: JSON.stringify({ caseState: { chiefComplaint: "咽痛" } }),
  }));
  assert.equal(await response.text(), chunks.join(""));
  assert.equal(response.headers.get("x-cdss-stage-result"), "reused");
  await archive.requestArchiveIdle();
  const lines = readArchive();
  const request = lines.find((line) => line.kind === undefined);
  const reply = lines.find((line) => line.kind === "response");
  assert.ok(request && reply, JSON.stringify(lines.map((line) => line.kind)));
  assert.equal(request.exchangeId, reply.exchangeId);
  assert.ok(reply.exchangeId);
  assert.equal(reply.body, chunks.join(""));
  assert.equal(reply.status, 200);
  assert.equal(reply.stageResult, "reused");
  assert.equal(reply.customerIdHeader, "90000405");
  assert.equal(reply.aborted, false);
  assert.equal(reply.truncated, false);
});

await check("3.2 D3：服务端自己发起的预先计算、留存关闭、闭集外路由都不留响应", async () => {
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  archive.resetRequestArchiveStateForTests();
  const token = await precompute.internalPrecomputeToken();
  const handler = archive.withClinicalResponseArchive(async () => Response.json({ ok: true }));
  await (await handler(new Request("http://127.0.0.1/api/diagnosis/prescribe", { method: "POST", headers: { [precompute.INTERNAL_PRECOMPUTE_HEADER]: token } }))).text();
  await (await handler(new Request("http://127.0.0.1/api/auth/access", { method: "POST" }))).text();
  process.env.CDSS_REQUEST_ARCHIVE = "false";
  await (await handler(new Request("http://127.0.0.1/api/diagnosis/assess", { method: "POST" }))).text();
  process.env.CDSS_REQUEST_ARCHIVE = "true";
  await archive.requestArchiveIdle();
  assert.equal(fs.existsSync(ARCHIVE_DIR) ? readArchive().length : 0, 0);
});

await check("3.3 D3：JSON 响应（红旗检查）也留；超过 4MB 只留前 4MB 并标 truncated，调用方拿到的仍是全文", async () => {
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  archive.resetRequestArchiveStateForTests();
  const small = archive.withClinicalResponseArchive(async () => Response.json({ safetyGate: { status: "ready" } }));
  assert.equal(await (await small(new Request("http://127.0.0.1/api/diagnosis/red-flags", { method: "POST" }))).text(), '{"safetyGate":{"status":"ready"}}');
  const big = "x".repeat(5 * 1024 * 1024);
  const large = archive.withClinicalResponseArchive(async () => new Response(big, { status: 200 }));
  assert.equal((await (await large(new Request("http://127.0.0.1/api/diagnosis/assess", { method: "POST" }))).text()).length, big.length);
  await archive.requestArchiveIdle();
  const lines = readArchive();
  assert.equal(lines.find((line) => line.route === "/api/diagnosis/red-flags")?.body, '{"safetyGate":{"status":"ready"}}');
  const truncated = lines.find((line) => line.route === "/api/diagnosis/assess");
  assert.equal(truncated?.truncated, true);
  assert.equal(truncated?.body.length, 4 * 1024 * 1024);
});

await check("3.4 D3：11 个临床路由的 POST 都经 withClinicalResponseArchive 导出", () => {
  for (const route of archive.ARCHIVED_ROUTES) {
    const file = path.join(process.cwd(), "src/app", `${route}/route.ts`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /export const POST = withClinicalResponseArchive\(handlePost\);/, route);
    assert.doesNotMatch(source, /export async function POST/, route);
  }
});

fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
console.log(`r1034-main: ${cases} checks`);

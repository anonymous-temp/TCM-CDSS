import assert from "node:assert/strict";

const BASE_URL = (
  process.env.BASE_URL ||
  process.env.TCM_CDSS_BASE_URL ||
  "http://127.0.0.1:3000"
).replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || process.env.TCM_CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.RED_FLAG_TIMEOUT_MS || 30_000);
const MAX_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.RED_FLAG_MAX_ATTEMPTS || 3)));
const STABILITY_RUNS = Math.max(1, Math.min(5, Number(process.env.RED_FLAG_STABILITY_RUNS || 3)));

function caseState(id, text, vitals = {}) {
  return {
    id: `live_red_flag_${id}_${Date.now()}`,
    phase: "collect",
    patient: { sex: "男", age: 48 },
    chiefComplaint: text,
    symptoms: { presentHistory: text, tcmDetail: "" },
    vitals,
    conversation: [],
  };
}

async function assessOnce(id, text, vitals = {}) {
  const startedAt = Date.now();
  let lastFailure = "unknown_failure";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE_URL}/api/diagnosis/red-flags`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
        },
        body: JSON.stringify({ caseState: caseState(id, text, vitals) }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `red-flag regression authentication failed (${response.status}); ` +
          "set CDSS_API_TOKEN or TCM_CDSS_API_TOKEN",
        );
      }
      const body = await response.json();
      if (response.ok && (
        (body.clinicalFacts?.semanticStatus === "checked" && body.clinicalFacts?.reviewStatus === "checked") ||
        body.semanticStatus === "skipped_deterministic_critical_vital"
      )) {
        return { id, body, elapsedMs: Date.now() - startedAt, attempts: attempt };
      }
      lastFailure = response.ok
        ? `semantic_${body.clinicalFacts?.unavailableReason || "unavailable"}`
        : `http_${response.status}`;
      if (!response.ok && response.status !== 429 && response.status < 500) {
        assert.equal(response.ok, true, `${id}: HTTP ${response.status}`);
      }
    } catch (error) {
      if (/authentication failed/.test(String(error?.message || error))) throw error;
      lastFailure = error?.name === "AbortError" ? "timeout" : String(error?.message || error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`${id}: semantic red-flag layer unavailable after ${MAX_ATTEMPTS} attempts (${lastFailure})`);
}

function classificationSignature(body) {
  const facts = (body.clinicalFacts?.redFlags || [])
    .filter((item) => item.status === "positive" || item.status === "possible")
    .map((item) => [
      item.category,
      item.status,
      item.urgency === "emergency"
        ? "emergency"
        : item.urgency === "urgent" || item.urgency === "clarify"
          ? "advisory"
          : "routine",
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ gate: body.safetyGate?.status, facts });
}

async function assess(id, text, vitals = {}) {
  const runs = [];
  for (let run = 1; run <= STABILITY_RUNS; run += 1) {
    runs.push(await assessOnce(`${id}_run${run}`, text, vitals));
  }
  const gates = runs.map((result) => result.body.safetyGate?.status);
  assert.equal(new Set(gates).size, 1, `${id}: workflow disposition changed across ${STABILITY_RUNS} independent runs\n${runs.map((result) => classificationSignature(result.body)).join("\n")}`);
  return {
    ...runs.at(-1),
    id,
    elapsedMs: runs.reduce((sum, result) => sum + result.elapsedMs, 0),
    attempts: Math.max(...runs.map((result) => result.attempts)),
    stabilityRuns: STABILITY_RUNS,
    runs,
  };
}

function positiveCategories(result) {
  return (result.body.clinicalFacts?.redFlags || [])
    .filter((item) => item.status === "positive" && item.urgency === "emergency")
    .map((item) => item.category);
}

function assertSemanticPositive(result, category) {
  for (const run of result.runs || [result]) {
    const facts = run.body.clinicalFacts?.redFlags || [];
    assert.equal(run.body.safetyGate?.status, "red_flag", `${result.id}: positive semantic fact did not open the red-flag branch`);
    assert.ok(positiveCategories(run).includes(category), `${result.id}: missing positive category ${category}`);
    assert.ok(
      facts.some((item) => item.category === category && item.status === "positive" && item.urgency === "emergency" && String(item.quote || "").trim()),
      `${result.id}: positive fact must retain a patient-text quote`,
    );
  }
}

function assertNoCurrentRedFlag(result) {
  for (const run of result.runs || [result]) {
    const activeFacts = (run.body.clinicalFacts?.redFlags || [])
      .filter((item) => item.status === "positive" || item.status === "possible");
    assert.notEqual(run.body.safetyGate?.status, "red_flag", `${result.id}: non-current fact became an emergency red flag`);
    assert.deepEqual(activeFacts, [], `${result.id}: family/history/conditional/negated fact became a current semantic fact`);
    assert.deepEqual(run.body.safetyGate?.advisories || [], [], `${result.id}: non-current fact created a clinician advisory`);
  }
}

function assertOrdinaryCurrentFinding(result) {
  for (const run of result.runs || [result]) {
    const escalated = (run.body.clinicalFacts?.redFlags || []).filter((item) =>
      (item.status === "positive" || item.status === "possible") &&
      (item.urgency === "emergency" || item.urgency === "urgent"));
    const clarifications = (run.body.clinicalFacts?.redFlags || []).filter((item) =>
      (item.status === "positive" || item.status === "possible") && item.urgency === "clarify");
    assert.notEqual(run.body.safetyGate?.status, "red_flag", `${result.id}: ordinary current symptom became an emergency red flag`);
    assert.deepEqual(escalated, [], `${result.id}: ordinary current symptom was unnecessarily escalated`);
    assert.ok(clarifications.every((item) => String(item.quote || "").trim()), `${result.id}: clarification finding must remain grounded in patient text`);
  }
}

function assertSemanticAdvisory(result, category) {
  for (const run of result.runs || [result]) {
    const facts = run.body.clinicalFacts?.redFlags || [];
    assert.notEqual(run.body.safetyGate?.status, "red_flag", `${result.id}: advisory fact became a hard red flag`);
    assert.ok(
      facts.some((item) => item.category === category &&
        (item.status === "positive" || item.status === "possible") &&
        (item.urgency === "urgent" || item.urgency === "clarify") &&
        String(item.quote || "").trim()),
      `${result.id}: missing grounded advisory category ${category}`,
    );
    assert.ok((run.body.safetyGate?.advisories || []).length > 0, `${result.id}: advisory was not exposed to the clinician`);
  }
}

const probes = [];
const MELENA_WITH_PRESYNCOPE_TEXT = "这两天拉出来像柏油一样又黑又亮，今天站起来眼前发黑";

for (const [id, text, category] of [
  ["respiratory_colloquial", "这两小时说半句话就得停下来歇，平躺更憋，只能坐起来喘", "respiratory"],
  ["neurologic_colloquial", "刚才右边手脚突然不听使唤，嘴角歪了，说话也含糊", "neuro"],
  ["major_gi_bleed_colloquial", "刚才大量呕鲜血一直没停，面色苍白出冷汗，人已经意识模糊", "gi_bleed"],
  ["anaphylaxis_colloquial", "吃完花生后嗓子眼一下堵住了，声音发不出来，脸也肿", "anaphylaxis"],
  ["conditional_to_current", "如果以后出现胸痛要立即就诊，我胸痛持续20分钟并大汗", "cardiac"],
  ["unresolved_chest_pain", "胸痛一直没有缓解，伴随症状还没来得及问", "cardiac"],
  ["melena_with_presyncope_needs_assessment", MELENA_WITH_PRESYNCOPE_TEXT, "gi_bleed"],
]) {
  const result = await assess(id, text);
  assertSemanticPositive(result, category);
  probes.push({ id, kind: "semantic_positive", elapsedMs: result.elapsedMs, attempts: result.attempts, categories: positiveCategories(result) });
}


for (const [id, text, category] of [
  ["family_to_patient_advisory", "我妈妈以前晕厥过，我今天突发晕厥一次，现已清醒", "syncope"],
  ["melena_without_instability", "这三天大便发黑，目前没有头晕、气促或活动性呕血", "gi_bleed"],
  ["persistent_external_bleeding_unknown_volume", "手划伤后渗血半小时还没完全停，出血量说不清", "bleeding"],
  ["severe_headache_without_onset_or_deficit", "头痛得厉害，但起病方式说不清，也没发现手脚无力", "neuro"],
  ["progressive_abdominal_pain", "肚子痛这两天越来越明显，没发热呕吐，也没有板状腹信息", "acute_abdomen"],
]) {
  const result = await assess(id, text);
  assertSemanticAdvisory(result, category);
  probes.push({ id, kind: "semantic_advisory", elapsedMs: result.elapsedMs, attempts: result.attempts });
}

for (const [id, text] of [
  ["family_scope", "我妈妈以前晕倒过好几次，我本人从来没晕过，现在也没有不舒服"],
  ["conditional_scope", "医生说如果以后胸口痛就马上去急诊；我现在没有胸痛，也不气短"],
  ["negated_split", "不是胸痛，就是饭后胃里胀，走路也不喘"],
  ["historical_resolved", "上周胸痛去急诊查过，之后已经完全缓解；今天只是复诊，目前无胸痛气促"],
  ["conditional_modal", "如果胸痛加重，我会晕厥就马上去急诊；目前没有胸痛或晕厥"],
]) {
  const result = await assess(id, text);
  assertNoCurrentRedFlag(result);
  probes.push({ id, kind: "semantic_boundary", elapsedMs: result.elapsedMs, attempts: result.attempts, categories: positiveCategories(result) });
}


const mildPersistent = await assess("mild_persistent", "腹痛不是很重，仍持续存在，没有反跳痛，也没发热呕吐");
assertOrdinaryCurrentFinding(mildPersistent);
probes.push({ id: mildPersistent.id, kind: "ordinary_current", elapsedMs: mildPersistent.elapsedMs, attempts: mildPersistent.attempts });

const splitBp = await assess("split_bp_advisory", "今天有点头胀，没有胸痛、气促、神经功能异常或意识改变", { systolicBP: "190", diastolicBP: "122" });
assert.notEqual(splitBp.body.safetyGate?.status, "red_flag", "severe but non-extreme BP without target-organ symptoms must not become an emergency");
assert.match(JSON.stringify(splitBp.body.safetyGate?.advisories || []), /190|122|血压/);
probes.push({ id: splitBp.id, kind: "deterministic_vital_advisory", elapsedMs: splitBp.elapsedMs, attempts: splitBp.attempts });

const shockBp = await assess("split_bp_shock", "乏力、冷汗", { systolicBP: "82", diastolicBP: "45" });
assert.equal(shockBp.body.safetyGate?.status, "red_flag", "extreme hypotension did not trigger the deterministic emergency boundary");
assert.match(JSON.stringify(shockBp.body.safetyGate?.redFlags || []), /82|45|血压/);
probes.push({ id: shockBp.id, kind: "deterministic_vital", elapsedMs: shockBp.elapsedMs, attempts: shockBp.attempts });

const lowSpo2 = await assess("low_spo2", "只是觉得有点乏力", { SpO2: "89%" });
assert.equal(lowSpo2.body.safetyGate?.status, "red_flag", "low SpO2 did not trigger the deterministic emergency boundary");
assert.match(JSON.stringify(lowSpo2.body.safetyGate?.redFlags || []), /89|血氧/);
probes.push({ id: lowSpo2.id, kind: "deterministic_vital", elapsedMs: lowSpo2.elapsedMs, attempts: lowSpo2.attempts });

const invalidSpo2 = await assess("invalid_spo2", "目前没有明显不舒服", { SpO2: "999%" });
assert.notEqual(invalidSpo2.body.safetyGate?.status, "red_flag", "an impossible SpO2 value must request verification instead of becoming a clinical fact");
assert.match(JSON.stringify(invalidSpo2.body.safetyGate?.missingItems || []), /血氧|SpO2/i);
probes.push({ id: invalidSpo2.id, kind: "invalid_vital", elapsedMs: invalidSpo2.elapsedMs, attempts: invalidSpo2.attempts });

const beforeFollowup = await assess("followup_before", "这两天有点胃胀，想调理一下");
assertNoCurrentRedFlag(beforeFollowup);
const afterFollowup = await assess(
  "followup_after",
  `这两天有点胃胀；刚补充问到：${MELENA_WITH_PRESYNCOPE_TEXT}`,
);
assertSemanticPositive(afterFollowup, "gi_bleed");
probes.push({
  id: "followup_red_flag_transition",
  kind: "post_followup_transition",
  elapsedMs: beforeFollowup.elapsedMs + afterFollowup.elapsedMs,
  attempts: Math.max(beforeFollowup.attempts, afterFollowup.attempts),
  phaseRequests: 2,
  phaseAttempts: { before: beforeFollowup.attempts, after: afterFollowup.attempts },
});

const recoveredAfterRetry = probes.filter((probe) => Number(probe.attempts || 1) > 1).length;
console.log(JSON.stringify({
  suite: "live-red-flags",
  probes: probes.length,
  stabilityRuns: STABILITY_RUNS,
  failures: 0,
  recoveredAfterRetry,
  results: probes,
}, null, 2));
// Recovery is operationally useful, but it is not a green reliability result. This prevents a
// transient provider failure from disappearing inside a nominally successful regression report.
process.exit(recoveredAfterRetry > 0 ? 2 : 0);

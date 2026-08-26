// TCMEval-SDT production-path benchmark.
//
// Source: Wang et al., Scientific Data 12, 437 (2025), CC-BY 4.0.
// The source revision and every input hash are pinned in scripts/lib/tcmeval-sdt.mjs.
// Only Clinical Data is sent to the CDSS. Options and gold answers are used after the response,
// so the benchmark adapter cannot leak the answer space into M03 generation.
//
// Example (production-native deterministic 50-case sample, matching the paper's sample size):
//   TCMEVAL_SPLIT=train TCMEVAL_SAMPLE_SIZE=50 TCMEVAL_SAMPLE_SEED=20250313 \
//   OUT_DIR=artifacts/tcmeval-sdt-prod-50 BASE_URL=... CDSS_API_TOKEN=... \
//   npm run regress:tcmeval-sdt

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  TCMEVAL_SDT_SOURCE_COMMIT,
  TCMEVAL_SDT_SOURCE_FILES,
  aggregateTcmEvalResults,
  buildTcmEvalCaseState,
  consumeTcmEvalNdjson,
  evaluateTcmEvalRecord,
  loadTcmEvalRecords,
  parseTcmEvalReasoning,
  sha256Text,
  tcmEvalVisibleContent,
} from "./lib/tcmeval-sdt.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const SOURCE_DIR = process.env.TCMEVAL_SOURCE_DIR ||
  `artifacts/tcmeval-sdt/source-${TCMEVAL_SDT_SOURCE_COMMIT.slice(0, 12)}`;
const OUT_DIR = process.env.OUT_DIR || "artifacts/tcmeval-sdt-run";
const SPLIT = (process.env.TCMEVAL_SPLIT || "all").trim().toLowerCase();
const ONLY = new Set((process.env.ONLY || "").split(",").map((item) => item.trim()).filter(Boolean));
const SAMPLE_SIZE = Math.max(0, Number(process.env.TCMEVAL_SAMPLE_SIZE || 0));
const SAMPLE_SEED = process.env.TCMEVAL_SAMPLE_SEED || "20250313";
const OFFSET = Math.max(0, Number(process.env.TCMEVAL_OFFSET || 0));
const LIMIT = Math.max(0, Number(process.env.TCMEVAL_LIMIT || 0));
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.PROBE_CONCURRENCY || 2)));
const RATE_LIMIT = Math.max(1, Number(process.env.PROBE_RATE_LIMIT || 55));
const RATE_WINDOW_MS = 10 * 60 * 1000;
const TIMEOUT_MS = Math.max(10_000, Number(process.env.LIVE_MODEL_TIMEOUT_MS || 210_000));
const MAX_ATTEMPTS = Math.max(1, Math.min(2, Number(process.env.M03_MAX_ATTEMPTS || 1)));
const DRY_RUN = process.env.TCMEVAL_DRY_RUN === "1";
const REEVALUATE = process.env.TCMEVAL_REEVALUATE === "1";
const SUMMARY_ONLY = process.env.TCMEVAL_SUMMARY_ONLY === "1";

if (!new Set(["all", "train", "test", "validation"]).has(SPLIT)) {
  throw new Error(`TCMEVAL_SPLIT 仅支持 all/train/test/validation：${SPLIT}`);
}

async function fetchPinnedSource(file) {
  mkdirSync(SOURCE_DIR, { recursive: true });
  const target = join(SOURCE_DIR, file.name);
  if (existsSync(target)) {
    const cached = readFileSync(target, "utf8");
    if (sha256Text(cached) === file.sha256) return cached;
    throw new Error(`TCMEval-SDT 本地缓存哈希漂移：${target}`);
  }
  const url = `https://api.github.com/repos/zhuyan166/TCMEval/contents/${file.path}?ref=${TCMEVAL_SDT_SOURCE_COMMIT}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tcm-cdss-tcmeval-sdt-regression",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TCMEval-SDT 下载失败 HTTP ${response.status}: ${url}`);
    const payload = await response.json();
    if (payload?.encoding !== "base64" || typeof payload?.content !== "string") {
      throw new Error(`TCMEval-SDT GitHub 内容响应不可解析：${file.name}`);
    }
    const body = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
    const actual = sha256Text(body);
    if (actual !== file.sha256) throw new Error(`TCMEval-SDT 下载哈希不符 ${file.name}: ${actual}`);
    writeFileSync(target, body);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// GitHub's content endpoint can throttle large anonymous downloads. Fetch sequentially: this runs
// once per pinned revision and avoids accepting a partial cache merely to make the benchmark start
// faster.
const sourceEntries = [];
for (const file of TCMEVAL_SDT_SOURCE_FILES) {
  sourceEntries.push([file.key, await fetchPinnedSource(file)]);
}
const allRecords = loadTcmEvalRecords(Object.fromEntries(sourceEntries));
let selected = allRecords.filter((record) => SPLIT === "all" || record.split === SPLIT);
if (ONLY.size) selected = selected.filter((record) => ONLY.has(record.id));
if (SAMPLE_SIZE > 0 && SAMPLE_SIZE < selected.length) {
  selected = [...selected]
    .sort((left, right) => sha256Text(`${SAMPLE_SEED}:${left.id}`).localeCompare(sha256Text(`${SAMPLE_SEED}:${right.id}`)))
    .slice(0, SAMPLE_SIZE);
}
if (OFFSET > 0 || LIMIT > 0) selected = selected.slice(OFFSET, LIMIT > 0 ? OFFSET + LIMIT : undefined);
if (!selected.length) throw new Error("TCMEval-SDT 选择结果为空");

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, "raw"), { recursive: true });

if (DRY_RUN) {
  const projections = selected.map((record) => {
    const state = withSafetyGate(buildTcmEvalCaseState(record));
    return {
      id: record.id,
      split: record.split,
      gate: state.safetyGate?.status || "unknown",
      allowDiagnosis: state.safetyGate?.allowDiagnosis,
      completeness: state.completeness?.level || "unknown",
      redFlagCount: state.safetyGate?.redFlags?.length || 0,
      payloadBytes: Buffer.byteLength(JSON.stringify({ caseState: state })),
    };
  });
  const countBy = (key) => projections.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
  const preflight = {
    benchmark: "TCMEval-SDT",
    sourceCommit: TCMEVAL_SDT_SOURCE_COMMIT,
    total: projections.length,
    bySplit: countBy("split"),
    gateStatuses: countBy("gate"),
    completeness: countBy("completeness"),
    allowDiagnosis: countBy("allowDiagnosis"),
    redFlagCases: projections.filter((item) => item.redFlagCount > 0).length,
    maxPayloadBytes: Math.max(...projections.map((item) => item.payloadBytes)),
    projections,
  };
  writeFileSync(join(OUT_DIR, "preflight.json"), JSON.stringify(preflight, null, 1));
  console.log(JSON.stringify({ ...preflight, projections: undefined }, null, 1));
  process.exit(0);
}

const stamps = [];
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > RATE_WINDOW_MS) stamps.shift();
    if (stamps.length < RATE_LIMIT) {
      stamps.push(now);
      return;
    }
    const waitMs = RATE_WINDOW_MS - (now - stamps[0]) + 500;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
  }
}

async function postDiagnose(caseState, transportAttempt = 0) {
  await acquireSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/api/diagnosis/diagnose`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
        // 多租户生产版必须带客户标识，否则 JIT 租户路由直接拒绝（甲方 08cc573 复测第 8 项）。
        ...(process.env.CDSS_CUSTOMER_ID ? { "x-cdss-customer-id": process.env.CDSS_CUSTOMER_ID } : {}),
      },
      body: JSON.stringify({ caseState }),
      signal: controller.signal,
    });
    if (response.status === 429 && transportAttempt < 4) {
      const retryAfter = Number(response.headers.get("Retry-After") || 30);
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000 + 1000, 120_000)));
      return postDiagnose(caseState, transportAttempt + 1);
    }
    return { status: response.status, raw: await response.text(), ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, raw: "", ms: Date.now() - startedAt, transport: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function retryableAttempt(result) {
  if (result.response.transport || result.response.status === 0) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(result.response.status)) return true;
  if (result.response.status !== 200) return false;
  return Boolean(result.stream.errorFrame || !result.stream.sawEnd || result.truncated || !result.reasoning);
}

async function runRecord(record) {
  const initialState = buildTcmEvalCaseState(record);
  const gatedState = withSafetyGate(initialState);
  const attempts = [];
  let finalAttempt;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await postDiagnose(gatedState);
    const stream = consumeTcmEvalNdjson(response.raw);
    const reasoning = parseTcmEvalReasoning(stream.content);
    finalAttempt = {
      response,
      stream,
      reasoning,
      truncated: stream.content.includes("[TRUNCATED]"),
    };
    attempts.push({
      attempt,
      status: response.status,
      ms: response.ms,
      transport: response.transport,
      errorFrame: stream.errorFrame,
      sawEnd: stream.sawEnd,
      contract: Boolean(reasoning),
      truncated: finalAttempt.truncated,
    });
    if (!retryableAttempt(finalAttempt)) break;
  }
  const score = evaluateTcmEvalRecord(record, finalAttempt?.reasoning);
  const result = {
    id: record.id,
    split: record.split,
    gate: {
      status: gatedState.safetyGate?.status,
      allowDiagnosis: gatedState.safetyGate?.allowDiagnosis,
      allowDosePrescription: gatedState.safetyGate?.allowDosePrescription,
      redFlagCount: gatedState.safetyGate?.redFlags?.length || 0,
      missingItemCount: gatedState.safetyGate?.missingItems?.length || 0,
      candidateMode: gatedState.safetyGate?.candidateMode,
      completeness: gatedState.completeness?.level,
    },
    stage: {
      status: finalAttempt?.response.status || 0,
      ms: finalAttempt?.response.ms || 0,
      transport: finalAttempt?.response.transport,
      errorFrame: finalAttempt?.stream.errorFrame,
      sawEnd: finalAttempt?.stream.sawEnd || false,
      contract: Boolean(finalAttempt?.reasoning),
      truncated: finalAttempt?.truncated || false,
      attempts,
    },
    score,
    reasoning: finalAttempt?.reasoning || null,
  };
  writeFileSync(join(OUT_DIR, "raw", `${record.id}.md`), [
    `# ${record.id} (${record.split})`,
    `gate=${result.gate.status}; completeness=${result.gate.completeness}; redFlags=${result.gate.redFlagCount}`,
    "",
    tcmEvalVisibleContent(finalAttempt?.stream.content || ""),
  ].join("\n"));
  return result;
}

const selectedIds = new Set(selected.map((record) => record.id));
if (REEVALUATE) {
  const recordById = new Map(selected.map((record) => [record.id, record]));
  let reevaluated = 0;
  for (const record of selected) {
    const target = join(OUT_DIR, `${record.id}.json`);
    if (!existsSync(target)) continue;
    const result = JSON.parse(readFileSync(target, "utf8"));
    if (result.harnessError) continue;
    result.score = evaluateTcmEvalRecord(recordById.get(record.id), result.reasoning);
    writeFileSync(target, JSON.stringify(result, null, 1));
    reevaluated += 1;
  }
  console.error(`[tcmeval-sdt] reevaluated=${reevaluated}`);
}
const completed = selected.filter((record) => existsSync(join(OUT_DIR, `${record.id}.json`)));
const pending = SUMMARY_ONLY
  ? []
  : selected.filter((record) => !existsSync(join(OUT_DIR, `${record.id}.json`)));
console.error(
  `[tcmeval-sdt] selected=${selected.length} completed=${completed.length} pending=${pending.length} ` +
  `split=${SPLIT} concurrency=${CONCURRENCY} rate=${RATE_LIMIT}/10min attempts=${MAX_ATTEMPTS} summaryOnly=${SUMMARY_ONLY}`,
);

let cursor = 0;
let done = 0;
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= pending.length) return;
    const record = pending[index];
    try {
      const result = await runRecord(record);
      writeFileSync(join(OUT_DIR, `${record.id}.json`), JSON.stringify(result, null, 1));
      done += 1;
      console.error(
        `[${done}/${pending.length}] ${record.id} split=${record.split} gate=${result.gate.status} ` +
        `contract=${result.stage.contract} score=${result.score.weighted.toFixed(4)}`,
      );
    } catch (error) {
      const result = { id: record.id, split: record.split, harnessError: String(error?.stack || error) };
      writeFileSync(join(OUT_DIR, `${record.id}.json`), JSON.stringify(result, null, 1));
      done += 1;
      console.error(`[${done}/${pending.length}] ERROR ${record.id}: ${error?.message || error}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const results = readdirSync(OUT_DIR)
  .filter((name) => name.endsWith(".json") && name !== "summary.json")
  .map((name) => JSON.parse(readFileSync(join(OUT_DIR, name), "utf8")))
  .filter((item) => selectedIds.has(item.id));
const summary = {
  benchmark: "TCMEval-SDT",
  source: {
    paper: "https://www.nature.com/articles/s41597-025-04772-9",
    repository: "https://github.com/zhuyan166/TCMEval/tree/main/evaluation/TCMEval-SDT",
    commit: TCMEVAL_SDT_SOURCE_COMMIT,
    license: "CC-BY-4.0",
    files: Object.fromEntries(TCMEVAL_SDT_SOURCE_FILES.map((file) => [file.name, file.sha256])),
  },
  selection: {
    split: SPLIT,
    only: [...ONLY],
    sampleSize: SAMPLE_SIZE,
    sampleSeed: SAMPLE_SEED,
    offset: OFFSET,
    limit: LIMIT,
    summaryOnly: SUMMARY_ONLY,
  },
  methodology: {
    path: "production M03 endpoint",
    answerLeakage: "Only Clinical Data is sent; options and gold answers are applied after generation.",
    comparability: "Production-native result, not directly comparable with option-present paper baselines.",
    task1: "Official exact-match recall; normalized containment is reported separately as an adapter diagnostic.",
    task2Task3: "Official proportional score after deterministic matching of M03 pathogenesis/syndrome text to the ten options.",
    task4: "Official character-level ROUGE-L over the structured M03 explanatory projection.",
    weights: "0.2/0.3/0.4/0.1",
    safety: "Production red-flag and completeness gates remain enabled and are reported separately.",
  },
  ...aggregateTcmEvalResults(results),
};
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));

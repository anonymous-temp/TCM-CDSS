#!/usr/bin/env node
// 按接口调用方的真实传参形状跑全链路（2026-10-13）：question →（跳过 / 作答 / 不追问）→ red-flags → diagnose → prescribe → assess。
//
// 为什么单独有这个驱动：既有回归脚本用的是页面形状（hisRecord，或 presentHistory + 空 conversation）。
// 生产留存的甲方请求是另一种形状——整份病历在 symptoms 的中文键下、追问问答在 conversation、后续调用只回传
// 上一步的结构化结果、不带 questionRounds / safetyGate / clinicalFacts。追问后安全闸门读不到病历正文的缺陷
// 就藏在这两种形状的差别里（见 test:customer-request-shape）。本驱动逐字段照甲方的写法组请求。
//
// 两种跑法：
//   · 直调路由（缺省）：不起 Next 服务，经 jiti 直接调各路由的 POST；本机内存小，这是日常用法。
//       CDSS_ENV_FILE=/path/local.env node scripts/regress-customer-shape.mjs cases.json outDir
//   · 打已部署的服务：BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=… node scripts/regress-customer-shape.mjs cases.json outDir
// 环境变量：CONC（并发，缺省 3）、RUNS（每例重复生成次数，缺省 1）、FOLLOWUP=skip|answer|none（缺省 skip）、
//           CDSS_CUSTOMER_ID（缺省 hospital-a）、STAGES（缺省 question,redflags,diagnose,prescribe,assess）、SHARD=i/n（分片）、ONLY（按 key 子串筛选）、
//           REGENERATE=0（不带重新生成头，观察结果复用）、THINK_MS（出题后停顿毫秒数）。
// 病例文件：[{ key, gold?, expect?, caseState: { chiefComplaint, patient, symptoms: {现病史…}, tongue?, pulse?, vitals?, tcmLineagePreference? } }]
// 输出：outDir/<key>.r<run>.json，已存在且完整的跳过（断点续跑）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [casesFile, outDir] = process.argv.slice(2);
if (!casesFile || !outDir) {
  console.error("usage: node scripts/regress-customer-shape.mjs <cases.json> <outDir>");
  process.exit(2);
}
if (process.env.CDSS_ENV_FILE) {
  for (const line of fs.readFileSync(process.env.CDSS_ENV_FILE, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !(line.slice(0, at) in process.env)) process.env[line.slice(0, at)] = line.slice(at + 1);
  }
}
const BASE = process.env.BASE_URL || "";
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER = process.env.CDSS_CUSTOMER_ID || "hospital-a";
const CONC = Number(process.env.CONC || 3);
const RUNS = Number(process.env.RUNS || 1);
const FOLLOWUP = process.env.FOLLOWUP || "skip";
const REGENERATE = process.env.REGENERATE !== "0";
// 出题后停顿多少毫秒再继续（模拟医生看题；REGENERATE=0 时让「按不回答预先计算」有时间跑完）。
const THINK_MS = Number(process.env.THINK_MS || 0);
const STAGES = new Set((process.env.STAGES || "question,redflags,diagnose,prescribe,assess").split(","));
const SKIP_SENTENCE = "本次未能确认，请继续现场评估";
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

let handlers;
if (!BASE) {
  const { createJiti } = await import("jiti");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": "/dev/null" } });
  handlers = {};
  for (const route of ["question", "red-flags", "diagnose", "prescribe", "assess"]) {
    handlers[route] = (await jiti.import(`${root}/src/app/api/diagnosis/${route}/route.ts`)).POST;
  }
}

async function post(route, body, extraHeaders = {}) {
  // 评测缺省每次都重新生成（否则同一病例第二次起拿到的是复用结果，量不出生成本身）；REGENERATE=0 时不带这个头，
  // 用来看调用方真实会遇到的行为（出题时预先计算、跳过后直接复用）。
  const headers = { "content-type": "application/json", "x-cdss-api-token": TOKEN, "x-cdss-customer-id": CUSTOMER, ...(REGENERATE ? { "x-cdss-regenerate": "1" } : {}), ...extraHeaders };
  const started = Date.now();
  try {
    const url = `${BASE || "http://127.0.0.1"}/api/diagnosis/${route}`;
    const init = { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) };
    const response = BASE ? await fetch(url, init) : await handlers[route](new Request(url, init));
    const raw = await response.text();
    return { status: response.status, ms: Date.now() - started, raw, reuse: response.headers.get("x-cdss-stage-result") };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, raw: "", error: String(error?.message || error) };
  }
}

function stream(result) {
  let content = "";
  let ended = false;
  const errors = [];
  for (const line of result.raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (typeof frame.error === "string") errors.push(frame.error);
      if (frame.type || typeof frame.content !== "string") continue;
      if (frame.content === "[END]") ended = true; else content += frame.content;
    } catch { /* 非 JSON 行忽略 */ }
  }
  const marker = "<<<CDSS_STREAM_FINAL>>>";
  const at = content.lastIndexOf(marker);
  const visible = at >= 0 ? content.slice(at + marker.length) : content;
  let structured = null;
  for (const match of visible.matchAll(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/g)) {
    try { const value = JSON.parse(match[1]); if (value && typeof value === "object") structured = value; } catch { /* 忽略 */ }
  }
  return { status: result.status, ms: result.ms, ended, errors, content: visible, structured, reuse: result.reuse, error: result.error };
}

function jsonBody(result) {
  let body = null;
  try { body = JSON.parse(result.raw); } catch { /* 忽略 */ }
  return { status: result.status, ms: result.ms, body, error: result.error };
}

async function runCase(entry, run) {
  const file = `${outDir}/${entry.key}.r${run}.json`;
  if (fs.existsSync(file)) {
    try {
      const previous = JSON.parse(fs.readFileSync(file, "utf8"));
      if (previous.finishedAt && previous.diagnose?.status === 200 && (!STAGES.has("prescribe") || previous.prescribe?.status === 200)) return;
    } catch { /* 重跑 */ }
  }
  const out = { key: entry.key, run, gold: entry.gold || null, expect: entry.expect || null, tags: entry.tags || [], input: entry.caseState, followup: FOLLOWUP, startedAt: new Date().toISOString() };
  // 甲方的写法：每一步只带病历、对话与上一步的结构化结果。
  const record = { ...entry.caseState, id: `${entry.caseState.id || entry.key}-${run}-${Date.now().toString(36)}` };
  out.caseId = record.id;
  let conversation = [];
  if (STAGES.has("question") && FOLLOWUP !== "none") {
    const question = stream(await post("question", { caseState: { ...record, phase: "question", questionRounds: 0 } }));
    const plan = question.structured?.m02Plan;
    out.question = { status: question.status, ms: question.ms, decision: plan?.decision, questions: plan?.questions || [], errors: question.errors };
    if (plan?.decision === "ask" && plan.questions?.length) {
      if (FOLLOWUP === "answer") {
        conversation = plan.questions.flatMap((item) => {
          const choices = (item.options || []).filter((option) => option.kind === "clinical_fact");
          // 作答形态：有期望答案就按它选，否则选第一个临床选项；内容取选项原文（甲方面板回传的就是它）。
          const wanted = entry.answers?.find((answer) => choices.some((option) => (option.answer || option.label || "").includes(answer)));
          const picked = choices.find((option) => wanted && (option.answer || option.label || "").includes(wanted)) || choices[0];
          return picked ? [{ role: "assistant", content: item.question }, { role: "user", content: picked.answer || picked.recordValue || picked.label }] : [];
        });
      } else {
        conversation = [{ role: "user", content: SKIP_SENTENCE }];
      }
    }
  }
  const caseState = { ...record, conversation };
  if (THINK_MS > 0 && out.question) await new Promise((resolve) => setTimeout(resolve, THINK_MS));
  if (STAGES.has("redflags")) {
    const redFlags = jsonBody(await post("red-flags", { caseState }));
    out.redFlags = {
      status: redFlags.status, ms: redFlags.ms,
      gate: redFlags.body?.safetyGate?.status, mode: redFlags.body?.prescriptionPermission?.candidateMode,
      level: redFlags.body?.operationalCompleteness?.level,
      redFlags: redFlags.body?.safetyGate?.redFlags, missingItemCodes: redFlags.body?.safetyGate?.missingItemCodes,
      advisories: redFlags.body?.safetyGate?.advisories, semanticTriage: redFlags.body?.safetyGate?.semanticTriage,
      reasons: redFlags.body?.prescriptionPermission?.reasons,
    };
  }
  const diagnose = stream(await post("diagnose", { caseState }));
  out.diagnose = { status: diagnose.status, ms: diagnose.ms, ended: diagnose.ended, errors: diagnose.errors, reuse: diagnose.reuse, structured: diagnose.structured, content: diagnose.content };
  if (diagnose.structured && STAGES.has("prescribe")) {
    const prescribe = stream(await post("prescribe", { caseState: { ...caseState, reasoningDiagnose: diagnose.structured } }));
    out.prescribe = { status: prescribe.status, ms: prescribe.ms, ended: prescribe.ended, errors: prescribe.errors, reuse: prescribe.reuse, structured: prescribe.structured, content: prescribe.content };
    if (prescribe.structured && STAGES.has("assess")) {
      const assess = stream(await post("assess", { caseState: { ...caseState, reasoningDiagnose: diagnose.structured, reasoningPrescribe: prescribe.structured } }));
      out.assess = { status: assess.status, ms: assess.ms, ended: assess.ended, errors: assess.errors, content: assess.content };
    }
  }
  out.finishedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(out), { mode: 0o600 });
  const overview = out.diagnose.structured?.overview;
  const candidate = out.prescribe?.structured?.formula?.candidates?.[0];
  console.log([
    `${entry.key}#${run}`,
    `Q ${out.question?.decision ?? "-"}/${out.question?.questions?.length ?? 0}/${out.question?.ms ?? "-"}ms`,
    `RF ${out.redFlags?.gate ?? "-"}/${out.redFlags?.mode ?? "-"}/${out.redFlags?.level ?? "-"}`,
    `M03 ${out.diagnose.status}/${out.diagnose.ms}ms ${overview ? `${overview.tcmDiseaseName}/${overview.primarySyndrome}→${overview.recommendedFormulaDirection}` : "无结构化"}`,
    `M04 ${out.prescribe?.status ?? "-"}/${out.prescribe?.ms ?? "-"}ms ${candidate ? `${candidate.name} ${candidate.herbs?.length}味` : (out.prescribe ? "无候选" : "")}`,
    `M05 ${out.assess?.status ?? "-"}/${out.assess?.ms ?? "-"}ms`,
    entry.gold ? `gold=${entry.gold}` : "",
  ].filter(Boolean).join(" | "));
}

const cases = JSON.parse(fs.readFileSync(casesFile, "utf8"));
const only = (process.env.ONLY || "").split(",").filter(Boolean);
// SHARD=i/n：只跑下标对 n 取余等于 i 的病例（直调路由时单进程内的 CPU 工作互相排队，多开几个进程分片更快）。
const [shardIndex, shardCount] = (process.env.SHARD || "0/1").split("/").map(Number);
const queue = [];
for (const [index, entry] of cases.entries()) {
  if (shardCount > 1 && index % shardCount !== shardIndex) continue;
  if (only.length && !only.some((key) => String(entry.key).includes(key))) continue;
  for (let run = 1; run <= RUNS; run += 1) queue.push([entry, run]);
}
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const [entry, run] = queue.shift();
    try { await runCase(entry, run); } catch (error) { console.log(`ERR ${entry.key}#${run} ${error?.message || error}`); }
  }
}));
console.log("CUSTOMER_CHAIN_DONE");
process.exit(0);

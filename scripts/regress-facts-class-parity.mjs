/**
 * 开放语言检测的整类 parity 实机回归（冻结令要求的「受治理类目样例 + 整类 parity 回归（含反例）」）。
 *
 * 读 scripts/fixtures/open-language-classes/*.json，每个类目的阳性样例与反例各跑 RUNS 次，
 * 直接走生产同一条事实抽取路径（maybeAttachClinicalFactsBackstop 的默认模型编排），再交给
 * evaluateSafetyGate。不需要起服务，但需要真实的事实抽取模型配置（.env.local 或 mk-local-env）。
 *
 * 为什么不用黄金基线代替：黄金基线一个说法一条用例，而这类缺陷是模型对「一类语气」的判断，
 * 单条用例 6 次里错 3 次这种波动，只有整类多次采样才看得出改动前后的差别。
 *
 * 为什么每次采样换一个租户：事实缓存与并发合流都按（租户，病历文本）键控，同一进程里同租户
 * 重复同一句话是缓存命中，不是独立样本（见 cdss-facts-cache-defeats-ab-attribution）。
 *
 * 判定：
 *   阳性样例 —— 目标类目下有当前患者 positive/possible 且非 routine 的发现，且门禁不给剂量；
 *   反例     —— 目标类目下没有当前患者 positive/possible 且非 routine 的发现。
 *   反例不断言门禁放行：确定性层对部分反例本就保守扣剂量（见 fixture 的 knownDeterministicFindings），
 *   这里量的是语义层。
 *
 * 环境变量：CLASS_FILTER（类目 id 子串）、SET_FILTER（development/holdout1/…）、
 * CONTEXT_FILTER（outpatient_record/sparse）、RUNS（默认 5）、CONCURRENCY（默认 4）。
 * 退出码：0 全过；1 有判定失败；2 有采样因模型不可用而未完成（不能算绿）。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { OPEN_LANGUAGE_CLASS_CONTEXTS as CONTEXTS } from "./lib/open-language-class-contexts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { maybeAttachClinicalFactsBackstop, getClinicalFactsModelPlan, CLINICAL_FACTS_PROMPT_VERSION } =
  await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");

const RUNS = Math.max(1, Number(process.env.RUNS || 5));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));
const fixtureDir = path.join(here, "fixtures/open-language-classes");

// 模型调用遥测走 console.info，会混进本脚本的 JSON 输出。
console.info = () => {};

function activeTargetFindings(facts, targetCategories) {
  return (facts?.redFlags || []).filter((finding) =>
    finding.subject === "patient" &&
    (finding.status === "positive" || finding.status === "possible") &&
    finding.urgency !== "routine" &&
    targetCategories.includes(finding.category));
}

const classes = readdirSync(fixtureDir)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(path.join(fixtureDir, file), "utf8")))
  // 确定性类目与模型无关，整类都在闸门 test:open-language-classes 里量。
  .filter((entry) => entry.mode !== "deterministic")
  .filter((entry) => !process.env.CLASS_FILTER || entry.id.includes(process.env.CLASS_FILTER));
if (classes.length === 0) throw new Error("no open-language class fixture matched CLASS_FILTER");

const jobs = [];
for (const entry of classes) {
  for (const [setName, set] of Object.entries(entry.sets)) {
    if (process.env.SET_FILTER && setName !== process.env.SET_FILTER) continue;
    for (const context of entry.contexts) {
      if (process.env.CONTEXT_FILTER && context !== process.env.CONTEXT_FILTER) continue;
      for (const kind of ["positive", "control"]) {
        for (const text of set[kind]) {
          for (let run = 0; run < RUNS; run += 1) jobs.push({ entry, setName, context, kind, text, run });
        }
      }
    }
  }
}

async function runJob(job) {
  const customerId = `parity-${createHash("sha256").update(`${job.context}\0${job.text}`).digest("hex").slice(0, 12)}-${job.run}`;
  const state = CONTEXTS[job.context](job.text, customerId);
  const withFacts = await maybeAttachClinicalFactsBackstop(state);
  const facts = withFacts.clinicalFacts;
  if (facts?.semanticStatus !== "checked") {
    return { ...job, unavailable: facts?.unavailableReason || "unavailable" };
  }
  const gate = evaluateSafetyGate(withFacts);
  // mode=disposition（开放判断）：阳性=门禁不给剂量；反例=处置去向没有形成开方前评估项。
  const dispositionItems = (gate.missingItems || []).filter((item) => item.includes("开方前处置去向"));
  const active = job.entry.mode === "disposition" ? dispositionItems : activeTargetFindings(facts, job.entry.targetCategories);
  const pass = job.kind === "positive"
    ? (job.entry.mode === "disposition" ? gate.allowDosePrescription === false : active.length > 0 && gate.allowDosePrescription === false)
    : active.length === 0;
  return {
    ...job,
    pass,
    gate: gate.status,
    allowDosePrescription: gate.allowDosePrescription,
    findings: [
      ...(facts.redFlags || []).map((finding) =>
        `${finding.category}/${finding.subject}/${finding.status}/${finding.urgency}「${finding.quote}」`),
      ...(facts.disposition ? [`disposition/${facts.disposition.setting}：${facts.disposition.mustNotMiss.map((item) => item.condition).join("、")}`] : []),
    ],
  };
}

const results = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor];
    cursor += 1;
    try {
      results.push(await runJob(job));
    } catch (error) {
      results.push({ ...job, unavailable: String(error?.message || error) });
    }
  }
}));

const groups = new Map();
for (const result of results) {
  const key = [result.entry.id, result.setName, result.context, result.kind].join("|");
  const group = groups.get(key) || { class: result.entry.id, set: result.setName, context: result.context, kind: result.kind, pass: 0, measured: 0, unavailable: 0, failingTexts: {} };
  if (result.unavailable) {
    group.unavailable += 1;
  } else {
    group.measured += 1;
    if (result.pass) group.pass += 1;
    else (group.failingTexts[result.text] ||= []).push(result.findings.join("；") || "（无发现）");
  }
  groups.set(key, group);
}

const summary = [...groups.values()].map((group) => ({ ...group, rate: `${group.pass}/${group.measured}` }));
const failures = summary.reduce((sum, group) => sum + (group.measured - group.pass), 0);
const unavailable = summary.reduce((sum, group) => sum + group.unavailable, 0);
console.log(JSON.stringify({
  suite: "facts-class-parity",
  model: getClinicalFactsModelPlan().extractor.model,
  promptVersion: CLINICAL_FACTS_PROMPT_VERSION,
  runsPerText: RUNS,
  failures,
  unavailable,
  groups: summary,
}, null, 2));
process.exit(failures > 0 ? 1 : unavailable > 0 ? 2 : 0);

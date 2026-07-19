// 100 条多样化用例真实推理
// - CF/WM/DD/SP2/RA/CX: 走 M03 diagnose + M04 prescribe,评估临床质量
// - TCT(十八反十九畏): 先从真实 M03 取得服务端签名，再以医生工作台修订路径提交故意变异处方
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { TCM_DIVERSE_100 } from "./fixtures/tcm-diverse-100.mjs";

const jiti = createJiti(import.meta.url);
const { getTcmHerbFunctionText } = jiti("../src/lib/tcm-knowledge.ts");
const { requiredDecoctionRequirement } = jiti("../src/lib/herb-decoction-rules.ts");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const OUTPUT_DIR = process.env.OUTPUT_DIR || "/tmp/cdss-diverse-100";
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function extractStageReasoning(content, stage) {
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const r = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
    if (r?.schemaVersion === "tcm-cdss-reasoning-v2" && r.stage === stage) return r;
  } catch {}
  return null;
}

async function callStage(pathname, caseState, ms = 300000) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseState }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    const elapsed = Date.now() - t0;
    let content = "";
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (json && typeof json === "object" && !Array.isArray(json) && (json.section || json.followup || json.error)) {
      content = json.section || json.followup || json.error || "";
    } else {
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          const o = JSON.parse(s);
          if (typeof o.content === "string" && o.content !== "[END]") content += o.content;
          if (o.error) content += `\n[STREAM_ERROR] ${o.error}\n`;
        } catch {}
      }
      const mi = content.lastIndexOf(STREAM_REPLACE_MARKER);
      if (mi >= 0) content = content.slice(mi + STREAM_REPLACE_MARKER.length);
    }
    return { status: res.status, ms: elapsed, content, json, raw: raw.slice(0, 500) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, content: `[FETCH_ERROR] ${e.message}`, raw: "" };
  } finally {
    clearTimeout(timer);
  }
}

const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };

function toCaseState(c) {
  const state = {
    id: c.id, phase: "collect",
    patient: { sex: c.sex || "男", age: typeof c.age === "number" ? c.age : 45 },
    chiefComplaint: c.chief, historyPresentIllness: c.hist,
    tongue: c.tongue || "舌淡红苔薄白", pulse: c.pulse || "细平",
    faceNote: c.face || "面色如常",
    pastHistory: c.past || "否认", allergyHistory: c.allergy || "否认",
    medicationHistory: c.medication || "否认",
    completeness: COMPLETE, conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
  };
  if (c.vitals && Object.keys(c.vitals).length) {
    state.vitals = {};
    if (c.vitals.bp) state.vitals.bp = c.vitals.bp;
    if (c.vitals.hr) state.vitals.heartRate = String(c.vitals.hr);
    if (c.vitals.t) state.vitals.temperature = String(c.vitals.t);
    if (c.vitals.rr) state.vitals.respiratoryRate = String(c.vitals.rr);
    if (c.vitals.spo2) state.vitals.spo2 = String(c.vitals.spo2);
  }
  return state;
}

async function runStandard(c) {
  // 走 M03+M04
  const state = toCaseState(c);
  const m03 = await callStage("/api/diagnosis/diagnose", state);
  let signed = null, m04 = null;
  if (m03.status === 200) {
    signed = extractStageReasoning(m03.content, "diagnose");
    if (signed) {
      m04 = await callStage("/api/diagnosis/prescribe", { ...state, reasoningDiagnose: signed, phase: "prescribe" });
    } else {
      m04 = { status: 0, ms: 0, content: "[NO_SIGNED_REASONING]", raw: "" };
    }
  } else {
    m04 = { status: 0, ms: 0, content: "[M03_FAILED]", raw: "" };
  }
  return { m03, m04, signed };
}

async function runPrescriptionRisk(c) {
  const state = toCaseState(c);
  const m03 = await callStage("/api/diagnosis/diagnose", state);
  const signedReasoning = m03.status === 200 ? extractStageReasoning(m03.content, "diagnose") : null;
  if (!signedReasoning) {
    return { m03, m04: { status: 0, ms: 0, content: "[NO_SIGNED_REASONING]", raw: "" }, signed: null };
  }
  const primaryNode = signedReasoning.pathogenesis?.chain?.[0];
  if (!primaryNode?.pathogenesis) {
    return { m03, m04: { status: 0, ms: 0, content: "[NO_PRIMARY_PATHOGENESIS]", raw: "" }, signed: signedReasoning };
  }
  const evidence = { evidenceLevel: "model_inference", source: "虚构审方变异测试", confidence: "低" };
  const fakePrescribe = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    clinicalReview: { status: "unavailable" },
    overview: signedReasoning.overview,
    westernDiagnosis: signedReasoning.westernDiagnosis,
    pathogenesis: signedReasoning.pathogenesis,
    therapy: signedReasoning.therapy,
    formula: {
      candidates: [{
        name: "本例辨证组方（医生编辑版）",
        formulaNames: [],
        constructionType: "self_devised",
        modificationStatus: "modified",
        positioning: "虚构审方正控",
        formulaSource: evidence,
        therapyMatch: String(signedReasoning.therapy?.overallPrinciple || primaryNode.therapyDirection || "对应核心病机"),
        applicable: "仅用于自动审方回归",
        notApplicable: "禁止作为真实临床处方",
        herbs: (c.herbs || []).map((herb, index) => ({
          name: herb.name,
          processing: herb.processing || null,
          dose: herb.dose,
          role: index === 0 ? "君" : "臣",
          prescriptionRole: "虚构审方变异药味",
          targetKind: "pathogenesis_node",
          targetRef: "P1",
          structureRole: null,
          targetPathogenesis: primaryNode.pathogenesis,
          function: getTcmHerbFunctionText(herb.name) || "虚构审方变异测试",
          decoctionRequirement: requiredDecoctionRequirement(herb.name) || null,
          isToxic: false,
          evidence,
        })),
        formulaAnalysis: "本处方为故意变异的审方正控，不代表临床建议。",
        decoction: { doseCount: "3剂", method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液400mL，早晚分服", course: "3日", followUpNode: "3日后复核" },
      }],
      patentAndWestern: [],
      modifications: [],
    },
    nonPharma: {
      diet: "不适用",
      lifestyle: "不适用",
      emotion: "不适用",
      acupointCare: null,
      tcmTreatments: [],
      monitoring: [{ metric: "审方结果", timing: "本次", trigger: "命中预期风险后停止使用" }],
    },
    lineageAdaptation: signedReasoning.lineageAdaptation || null,
    management: signedReasoning.management,
  };

  // 构造 caseState with prescriptionRevision
  const m04state = {
    ...state, phase: "prescribe",
    reasoningDiagnose: signedReasoning,
    reasoningPrescribe: fakePrescribe,
    reasoningV2: fakePrescribe,
    prescriptionRevision: {
      source: "herb_workbench",
      candidateIndex: 0,
      herbHash: "pending-server-recompute",
      auditedAt: new Date().toISOString(),
      auditResult: "MANUAL_REVIEW",
      highestRiskLevel: "HIGH",
    },
    safetyLocked: false,
  };

  const result = await callStage("/api/diagnosis/post-prescription-risk", m04state, 60000);
  return { m03, m04: result, signed: signedReasoning };
}

async function runOne(c) {
  const t0 = Date.now();
  let result;
  if (c.cat === "TCT") {
    result = await runPrescriptionRisk(c);
  } else {
    result = await runStandard(c);
  }
  const totalMs = Date.now() - t0;
  // 保存
  const outFile = path.join(OUTPUT_DIR, `${c.id}-full.txt`);
  const text = `=== ${c.id} | ${c.cat} | ${c.label} ===
病例: ${c.sex||"?"}/${typeof c.age==="number"?c.age+",":""} | 主诉=${c.chief} | 现病史=${c.hist}
舌=${c.tongue||"-"} 脉=${c.pulse||"-"} 面=${c.face||"-"} 既往=${c.past||"-"} 过敏=${c.allergy||"-"} 用药=${c.medication||"-"}
期望: 证=${c.expect_syndrome||"-"} 方=${c.expect_formula||"-"} ${c.expect_block?`| 拦截:${c.expect_block}`:""}

--- M03 (status=${result.m03?.status} ms=${result.m03?.ms}) ---
${result.m03?.content?.slice(0, 4000) || ""}

--- M04 / post-prescription-risk (status=${result.m04?.status} ms=${result.m04?.ms}) ---
${result.m04?.content?.slice(0, 4000) || ""}
`;
  fs.writeFileSync(outFile, text);
  // 提取关键标记供汇总
  const allText = `${result.m03?.content||""}\n${result.m04?.content||""}`;
  const prescribeReasoning = extractStageReasoning(result.m04?.content || "", "prescribe");
  const formulaCandidates = prescribeReasoning?.formula?.candidates || [];
  const actualFormulaNames = [...new Set(formulaCandidates.flatMap((candidate) => [
    candidate.name,
    ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
  ]).filter((name) => typeof name === "string" && name.trim()))];
  const normalizeFormulaName = (value) => String(value || "")
    .replace(/[（(][^（）()]+[）)]/g, "")
    .replace(/加减$/g, "")
    .replace(/\s+/g, "")
    .trim();
  const expectedFormulaNames = c.expect_formula
    ? c.expect_formula.split("/").map(normalizeFormulaName).filter(Boolean)
    : [];
  const normalizedActualFormulaNames = actualFormulaNames.map(normalizeFormulaName);
  const detectedFormula = actualFormulaNames.join("+") || undefined;
  const expectMatch = expectedFormulaNames.length > 0
    ? (expectedFormulaNames.some((expected) => normalizedActualFormulaNames.includes(expected)) ? "MATCH" : "MISS")
    : "-";
  // Internal enum values are legitimate inside the signed JSON contract. Only visible narrative
  // before/after that envelope counts as a customer-facing terminology leak.
  const visibleText = allText.replace(/<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g, "");
  const internalTermLeak = /(?:^|\W)(?:bounded|unrestricted)(?:\W|$)/i.test(visibleText);
  const expectedRiskPattern = /十八反/.test(c.expect_block || "") ? /十八反|配伍禁忌|INCOMPAT/i
    : /十九畏/.test(c.expect_block || "") ? /十九畏|配伍禁忌|REPULSION/i
      : /孕妇|妊娠/.test(c.expect_block || "") ? /孕妇|妊娠|孕期|特殊人群/i
        : c.expect_block ? /超量|剂量|HIGH_DOSE|强提示|需人工复核/i
          : null;
  const blockMatch = expectedRiskPattern ? expectedRiskPattern.test(allText) : null;
  const hasHerbs = /(\d+)\s*g/.test(allText);
  const herbs = ((allText.match(/(\d+)\s*g/g) || []).slice(0, 20));
  return {
    id: c.id, cat: c.cat, label: c.label,
    expect_syndrome: c.expect_syndrome, expect_formula: c.expect_formula, expect_block: c.expect_block,
    m03Status: result.m03?.status, m03Ms: result.m03?.ms,
    m04Status: result.m04?.status, m04Ms: result.m04?.ms,
    totalMs,
    detectedFormula, actualFormulaNames, expectMatch, internalTermLeak, blockMatch, hasHerbs, herbsCount: herbs.length,
    errorTags: (allText.match(/\[(STREAM_ERROR|FETCH_ERROR|NO_SIGNED|M03_FAILED|TRUNCATED)\]/g) || []),
  };
}

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); } catch (e) { results[i] = { id: items[i].id, cat: items[i].cat, error: e.message, errorTags: ["FETCH_ERROR"] }; }
      done += 1;
      console.log(`[${done}/${items.length}] ${items[i].id} (${items[i].cat}) m03=${results[i].m03Status}/${results[i].m03Ms}ms m04=${results[i].m04Status}/${results[i].m04Ms}ms | ${results[i].detectedFormula||"-"} expect=${results[i].expectMatch}`);
    }
  });
  await Promise.all(runners);
  return results;
}

console.log(`BASE_URL=${BASE_URL} CONCURRENCY=${CONCURRENCY} OUTPUT_DIR=${OUTPUT_DIR}`);
console.log(`Running ${TCM_DIVERSE_100.length} cases...\n`);
const t0 = Date.now();
const results = await pool(TCM_DIVERSE_100, runOne, CONCURRENCY);
const totalElapsed = (Date.now() - t0) / 1000;

const total = results.length;
const m03Ok = results.filter(r => r.m03Status === 200).length;
const m04Ok = results.filter(r => r.m04Status === 200).length;
const formulaMatch = results.filter(r => r.expectMatch === "MATCH");
const internalTermLeakCount = results.filter(r => r.internalTermLeak).length;
const withErrors = results.filter(r => r.errorTags.length > 0).length;
const riskControlsPassed = results.filter(r => r.expect_block && r.blockMatch === true).length;
const riskControlsTotal = results.filter(r => r.expect_block).length;

console.log("\n========= 100 条多样化测试总结 =========");
console.log(`总耗时: ${totalElapsed.toFixed(1)}s (${(totalElapsed/60).toFixed(1)}min)`);
console.log(`M03/M04 成功: ${m03Ok}/${total}, ${m04Ok}/${total}`);
console.log(`经典方剂命中(期望方): ${formulaMatch.length}/${results.filter(r=>r.expect_formula).length}`);
console.log(`内部枚举词可见泄露: ${internalTermLeakCount}/${total}`);
console.log(`审方风险正控: ${riskControlsPassed}/${riskControlsTotal}`);
console.log(`错误标签: ${withErrors}/${total}`);

const byCat = {};
for (const r of results) {
  byCat[r.cat] = byCat[r.cat] || { total: 0, m03ok: 0, m04ok: 0, match: 0, withFormula: 0, expectFormula: 0 };
  byCat[r.cat].total += 1;
  if (r.m03Status === 200) byCat[r.cat].m03ok += 1;
  if (r.m04Status === 200) byCat[r.cat].m04ok += 1;
  if (r.expectMatch === "MATCH") byCat[r.cat].match += 1;
  if (r.detectedFormula) byCat[r.cat].withFormula += 1;
  if (r.expect_formula) byCat[r.cat].expectFormula += 1;
}
console.log("\n--- 按类别 ---");
for (const [c, st] of Object.entries(byCat).sort()) {
  console.log(`  ${c}: M03 ${st.m03ok}/${st.total} | M04 ${st.m04ok}/${st.total} | 方剂匹配 ${st.match}/${st.expectFormula} | 含方剂 ${st.withFormula}`);
}

// 哪些期望方被命中 / 哪些 missed
console.log("\n--- 经典方剂匹配明细 ---");
for (const r of results.filter(x => x.expect_formula)) {
  console.log(`  ${r.id} (${r.cat}/${r.label}): 期望=${r.expect_formula} | 检测=${r.detectedFormula||"未命中"} | ${r.expectMatch}`);
}

console.log("\n--- 失败/告警明细 ---");
for (const r of results.filter(x => x.errorTags.length > 0 || x.m04Status !== 200)) {
  console.log(`  ${r.id} (${r.cat}): m03=${r.m03Status} m04=${r.m04Status} err=${r.errorTags.join(",")||"-"}`);
}

fs.writeFileSync(path.join(OUTPUT_DIR, "_summary.json"), JSON.stringify({
  totalElapsed, total, m03Ok, m04Ok, formulaMatchCount: formulaMatch.length, internalTermLeakCount, riskControlsPassed, riskControlsTotal,
  byCat, results, timestamp: new Date().toISOString(),
}, null, 2));
console.log(`\nSummary → ${OUTPUT_DIR}/_summary.json`);

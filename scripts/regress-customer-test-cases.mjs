/**
 * 甲方测试病历（好医生_测试用病历_2026-07-29.docx）端到端评测。
 *
 * 与 regress-primary-care-sparse-50（虚构契约用例）和 regress-published-sparse-cases（公开医案）
 * 的区别：这 10 例**自带标准答案**——文档标题就写着「感冒-风寒束表证」「心悸-心虚胆怯证」，
 * 所以中医辨病与辨证可以直接判对错，而不只是看格式对不对。
 *
 * 同时覆盖三种真实录入形态，这是「流程」这一面要看的东西：
 *   - 舌脉面填在专门字段里（例 1/2/3/5/6/9/10）
 *   - 舌脉写在现病史正文里、字段留空（例 4：「舌苔薄白，脉弦」）
 *   - 完全没有舌脉记录（例 7/8）
 *
 * 用法：BASE_URL=http://127.0.0.1:3000 node --env-file-if-exists=.env.local scripts/regress-customer-test-cases.mjs
 * 可用 CUSTOMER_CASES=1,4,7 只跑指定编号。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const SOURCE_DOC = process.env.CUSTOMER_CASES_DOC || "好医生_测试用病历_2026-07-29.docx";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const ARTIFACT_DIR = process.env.CUSTOMER_CASES_DIR
  || path.join("artifacts", `customer-cases-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const ONLY = new Set((process.env.CUSTOMER_CASES || "").split(",").map((s) => s.trim()).filter(Boolean));

// ── 解析病历文档 ────────────────────────────────────────────────────────────
const PARSER = String.raw`
import json, re, sys
import docx
d = docx.Document(sys.argv[1])
paras = [p.text.strip() for p in d.paragraphs if p.text.strip()]
HEAD = re.compile(r"^(\d+)[.．]\s*(.+?)-(.+?)(（.*）)?$")
FIELD = re.compile(r"^(主诉|现病史|既往史|过敏史|用药史|生命体征|面象|舌象|脉象|问诊补充|辅助检查)[：:\-]?\s*(.*)$")
NAME = re.compile(r"^(.+?)，(男|女)，?\s*(\d+)\s*岁")
BLANK = {"-", "", "无", "无。", "无特殊", "无特殊。"}
cases, cur = [], None
for t in paras[1:]:
    h = HEAD.match(t)
    if h:
        cur = {"no": int(h.group(1)), "tcmDisease": h.group(2).strip(),
               "syndrome": h.group(3).strip(), "note": (h.group(4) or "").strip("（）"), "fields": {}}
        cases.append(cur); continue
    if cur is None: continue
    n = NAME.match(t)
    if n:
        cur["sex"], cur["age"] = n.group(2), int(n.group(3)); continue
    f = FIELD.match(t)
    if f:
        cur["fields"][f.group(1)] = "" if f.group(2).strip() in BLANK else f.group(2).strip(); continue
    m2 = re.match(r"^(面象|舌象|脉象)-?$", t)
    if m2: cur["fields"][m2.group(1)] = ""
print(json.dumps(cases, ensure_ascii=False))
`;
const parsedCases = JSON.parse(execFileSync("python3", ["-c", PARSER, SOURCE_DOC], {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
}));
if (parsedCases.length === 0) throw new Error(`未从 ${SOURCE_DOC} 解析出任何病例`);

function vitalsOf(text) {
  if (!text) return {};
  const pick = (re) => text.match(re)?.[1]?.trim() || undefined;
  return Object.fromEntries(Object.entries({
    T: pick(/T\s*([\d.]+\s*℃?)/i),
    P: pick(/P\s*([\d.]+\s*次?\/?分?)/i),
    R: pick(/R\s*([\d.]+\s*次?\/?分?)/i),
    BP: pick(/BP\s*([\d/]+\s*mmHg?)/i),
  }).filter(([, value]) => value));
}

function caseStateOf(entry) {
  const f = entry.fields;
  return {
    id: `customer-${entry.no}`, phase: "collect",
    patient: { sex: entry.sex, age: entry.age },
    chiefComplaint: f["主诉"] || "",
    // 现病史与问诊补充按医生实际录入放进 symptoms；舌脉面各自进专门字段。
    // 例 4 的舌脉只写在现病史正文里，字段留空——这正是要测的一种录入形态，不做搬运。
    symptoms: Object.fromEntries(Object.entries({
      presentHistory: f["现病史"], supplement: f["问诊补充"], auxiliary: f["辅助检查"],
    }).filter(([, v]) => v)),
    tongue: f["舌象"] || "", pulse: f["脉象"] || "", faceNote: f["面象"] || "",
    vitals: vitalsOf(f["生命体征"]),
    pastHistory: f["既往史"] || "", medicationHistory: f["用药史"] || "", allergyHistory: f["过敏史"] || "",
    completeness: { level: "A", redFlag: 0.3, infoGain: 0.3, managementImpact: 0.3, answerability: 0.3 },
    conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    questionRounds: 0, maxQuestionRounds: 2,
  };
}

async function post(route, body, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    // ms 必须在流读完后再算：对象字面量里 `ms: Date.now()-t, raw: await res.text()` 的 ms 在
    // text() 挂起前求值，量到的是"到响应头"（≈路由前置工作），把 57s 的 M03 记成 8s。
    const raw = await res.text();
    return { status: res.status, ms: Date.now() - startedAt, raw };
  } catch (error) {
    return { status: 0, ms: Date.now() - startedAt, raw: "", error: String(error?.message || error) };
  } finally { clearTimeout(timer); }
}

function ndjson(raw) {
  let content = ""; const errors = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.content === "string" && parsed.content !== "[END]") content += parsed.content;
      if (typeof parsed.error === "string") errors.push(parsed.error);
    } catch { /* 非 NDJSON 帧 */ }
  }
  const marker = content.lastIndexOf(STREAM_REPLACE_MARKER);
  return {
    provisional: marker >= 0 ? content.slice(0, marker) : "",
    visible: marker >= 0 ? content.slice(marker + STREAM_REPLACE_MARKER.length) : content,
    errors,
  };
}

function sentinel(text) {
  const block = text.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
  if (!block) return null;
  try { return JSON.parse(block[1]); } catch { return null; }
}

/** 证型判分：标准答案与系统输出都拆成要素，看要素覆盖率，不做字符串全等。 */
function syndromeAgreement(expected, actual) {
  if (!actual) return { score: 0, matched: [], missed: [] };
  const norm = (s) => String(s || "").replace(/[证候（）()\s，,、。]/g, "");
  const elements = norm(expected).replace(/头痛|头风/g, "").match(/.{2,4}/g) || [];
  const actualNorm = norm(actual);
  // 要素级比对：把标准证型按 2 字一组滑窗，看有多少出现在系统证型里。
  const grams = new Set();
  const e = norm(expected);
  for (let i = 0; i + 2 <= e.length; i += 1) grams.add(e.slice(i, i + 2));
  const matched = [...grams].filter((g) => actualNorm.includes(g));
  return {
    score: grams.size === 0 ? 0 : Number((matched.length / grams.size).toFixed(2)),
    matched, missed: [...grams].filter((g) => !matched.includes(g)), elements,
  };
}

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const selected = parsedCases.filter((c) => ONLY.size === 0 || ONLY.has(String(c.no)));
const summary = [];

for (const entry of selected) {
  process.stderr.write(`[customer] ${entry.no}. ${entry.tcmDisease}-${entry.syndrome} …\n`);
  let base = caseStateOf(entry);
  // 对齐产品客户端契约（DiagnosisClient.refreshClinicalSafetyFacts）：语义红旗预检结果由
  // red-flags 路由返回并随 caseState 回传，后续各阶段按 sourceFingerprint 命中缓存。
  // 不回传时每个阶段都会重跑 extract+review，一次瞬态失败即触发整单 fail-closed 非剂量降级
  //（实测 case9：预检 aborted → 银翘散 0 味），且与真实前端行为不一致。
  const redFlags = await post("/api/diagnosis/red-flags", { caseState: base }, 60_000);
  try {
    const parsed = JSON.parse(redFlags.raw);
    if (redFlags.status === 200 && parsed?.clinicalFacts) base = { ...base, clinicalFacts: parsed.clinicalFacts };
  } catch { /* 预检不可用时按产品语义继续：阶段路由会自行重试并 fail-closed */ }
  const record = { ...entry, caseState: base, stages: {} };

  const question = await post("/api/diagnosis/question", { caseState: { ...base, phase: "question" } });
  const q = ndjson(question.raw);
  record.stages.question = { status: question.status, ms: question.ms, errors: q.errors, visible: q.visible };

  const answered = {
    ...base, phase: "diagnose", questionRounds: 1,
    completeness: { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
    conversation: q.visible ? [{ role: "assistant", content: q.visible }] : [],
  };
  const diagnose = await post("/api/diagnosis/diagnose", { caseState: answered });
  const d = ndjson(diagnose.raw);
  const reasoningDiagnose = sentinel(d.visible);
  record.stages.diagnose = {
    status: diagnose.status, ms: diagnose.ms, errors: d.errors,
    moduleNotices: d.provisional.match(/^▸ .+$/gm) || [],
    visible: d.visible, reasoning: reasoningDiagnose,
  };

  if (reasoningDiagnose) {
    const prescribeState = { ...answered, phase: "prescribe", diagnosis: d.visible, reasoningDiagnose };
    const prescribe = await post("/api/diagnosis/prescribe", { caseState: prescribeState });
    const p = ndjson(prescribe.raw);
    const reasoningPrescribe = sentinel(p.visible);
    record.stages.prescribe = {
      status: prescribe.status, ms: prescribe.ms, errors: p.errors,
      visible: p.visible, reasoning: reasoningPrescribe,
    };
    const assess = await post("/api/diagnosis/assess", {
      caseState: { ...prescribeState, phase: "assess", prescription: p.visible, reasoningPrescribe },
    });
    const a = ndjson(assess.raw);
    record.stages.assess = { status: assess.status, ms: assess.ms, errors: a.errors, visible: a.visible };
  }

  await fs.writeFile(path.join(ARTIFACT_DIR, `case-${entry.no}.json`), JSON.stringify(record, null, 2));

  const overview = reasoningDiagnose?.overview;
  const candidate = record.stages.prescribe?.reasoning?.formula?.candidates?.[0];
  const agreement = syndromeAgreement(entry.syndrome, overview?.primarySyndrome);
  const row = {
    no: entry.no,
    expectedDisease: entry.tcmDisease, actualDisease: overview?.tcmDiseaseName || null,
    diseaseHit: Boolean(overview?.tcmDiseaseName && (
      overview.tcmDiseaseName.includes(entry.tcmDisease) || entry.tcmDisease.includes(overview.tcmDiseaseName))),
    expectedSyndrome: entry.syndrome, actualSyndrome: overview?.primarySyndrome || null,
    syndromeScore: agreement.score, syndromeMissed: agreement.missed,
    western: reasoningDiagnose?.westernDiagnosis?.primary?.name || null,
    icd10: reasoningDiagnose?.westernDiagnosis?.primary?.coding?.code || null,
    formulaMode: overview?.formulaSelectionMode || null,
    lockedFormulas: overview?.recommendedFormulaNames || [],
    formulaName: candidate?.name || null,
    herbCount: Array.isArray(candidate?.herbs) ? candidate.herbs.length : 0,
    diagnoseMs: diagnose.ms, prescribeMs: record.stages.prescribe?.ms ?? null,
    assessStatus: record.stages.assess?.status ?? null,
    // 望诊录入形态：字段填了 / 只写在正文里 / 完全没有——用于对照识别是否生效。
    inspectionEntry: [base.tongue && "舌", base.pulse && "脉", base.faceNote && "面"].filter(Boolean).join("") || "无",
    errors: [...(q.errors || []), ...(d.errors || []), ...(record.stages.prescribe?.errors || [])],
  };
  summary.push(row);
  process.stderr.write(`  ↳ ${JSON.stringify(row)}\n`);
}

const diseaseHits = summary.filter((r) => r.diseaseHit).length;
const syndromeAvg = summary.length
  ? Number((summary.reduce((total, r) => total + r.syndromeScore, 0) / summary.length).toFixed(2)) : 0;
const out = {
  artifactDir: ARTIFACT_DIR, cases: summary.length,
  diseaseHitRate: `${diseaseHits}/${summary.length}`,
  syndromeAvgScore: syndromeAvg,
  prescribed: summary.filter((r) => r.herbCount > 0).length,
  namedFormula: summary.filter((r) => r.lockedFormulas.length > 0).length,
  summary,
};
await fs.writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

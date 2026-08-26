// TCM-SD（Ren et al., CCL 2022，148 证候 / 54k 真实电子病历）生产路径活体评测。
//
// 数据来源：github.com/Borororo/ZY-BERT（test.json，JSONL，5,486 例；完整数据见阿里天池
// dataId=139034）。License CC BY-NC-SA 4.0 —— 仅作评测使用，数据文件**不入库**，
// 用 TCMSD_DATA_PATH 指向本地下载文件。
//
// 与 TCMEval-SDT 的分工：TCMEval 是稀疏古籍病例（大多止步 needs_information，测的是门禁），
// TCM-SD 是主诉+现病史+查体舌脉齐全的现代住院病历，绝大多数应达到完整度并产出证候——
// 它测的是满血 M03 辨证路径本身。只发送病历文本（chief_complaint/description/detection），
// 金标准 norm_syndrome 在响应返回后才参与判分，不向模型泄露答案空间。
//
// 判分口径（闭集金标准，无 judge 模型）：
//   exactPrimary   归一化后主证候 == 金标准（去尾「证」、去空白）
//   exactAny       主证候或次证候命中金标准
//   containAny     主/次证候与金标准互为包含（近似命中，单列诊断，不计入 exact）
//   withheld       门禁 needs_information 或 primarySyndromeResolution=unresolved ——
//                  按产品语义这是「拒答」，单列统计，不算辨证错误
//   contract_fail  未产出签名结构化契约
//
// 断点续跑：OUT_DIR 里已有的逐例 json 直接跳过（本机纪律）。
//
// 用法：
//   TCMSD_DATA_PATH=/tmp/tcm-datasets/test.json TCMSD_SAMPLE_SIZE=12 TCMSD_SAMPLE_SEED=20260826 \
//   OUT_DIR=artifacts/tcmsd-live BASE_URL=... CDSS_API_TOKEN=... CDSS_CUSTOMER_ID=... \
//   npm run regress:tcmsd
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumeTcmEvalNdjson, parseTcmEvalReasoning, sha256Text, normalizeTcmEvalText } from "./lib/tcmeval-sdt.mjs";

const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
const DATA_PATH = process.env.TCMSD_DATA_PATH || "artifacts/tcm-sd/test.json";
const SAMPLE_SIZE = Math.max(0, Number(process.env.TCMSD_SAMPLE_SIZE || 12));
const SAMPLE_SEED = process.env.TCMSD_SAMPLE_SEED || "20260826";
const ONLY = new Set((process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const OUT_DIR = process.env.OUT_DIR || "artifacts/tcmsd-live";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 240_000);

if (!BASE_URL || !TOKEN) {
  console.error("BASE_URL 与 CDSS_API_TOKEN 必填。");
  process.exit(2);
}
if (!existsSync(DATA_PATH)) {
  console.error(`未找到 TCM-SD 数据文件：${DATA_PATH}\n` +
    "下载：curl -L -o test.json https://raw.githubusercontent.com/Borororo/ZY-BERT/main/test.json\n" +
    "（CC BY-NC-SA 4.0，仅评测使用，勿提交入库）");
  process.exit(2);
}

const records = readFileSync(DATA_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((r) => r && typeof r.norm_syndrome === "string" && r.norm_syndrome.trim());
let selected = records.map((r) => ({ ...r, id: `tcmsd_${r.user_id}` }));
if (ONLY.size) selected = selected.filter((r) => ONLY.has(r.id));
else if (SAMPLE_SIZE > 0 && SAMPLE_SIZE < selected.length) {
  selected = [...selected]
    .sort((a, b) => sha256Text(`${SAMPLE_SEED}:${a.id}`).localeCompare(sha256Text(`${SAMPLE_SEED}:${b.id}`)))
    .slice(0, SAMPLE_SIZE);
}
if (!selected.length) { console.error("TCM-SD 选择结果为空"); process.exit(2); }
mkdirSync(OUT_DIR, { recursive: true });

function buildCaseState(record) {
  const detection = String(record.detection || "").trim();
  const description = String(record.description || "").trim();
  const clauses = detection.split(/[，。；;]/).map((s) => s.trim()).filter(Boolean);
  const tongue = clauses.filter((c) => /[舌苔]/.test(c)).join("，");
  const pulse = clauses.filter((c) => /脉|指纹/.test(c)).join("，");
  const chiefComplaint = String(record.chief_complaint || "").trim() || description.slice(0, 60);
  return {
    id: `${record.id}_${SAMPLE_SEED}`,
    phase: "diagnose",
    patient: {},
    chiefComplaint,
    symptoms: { general: description, tcmFourExams: detection },
    tongue,
    pulse,
    vitals: "",
    pastHistory: "",
    medicationHistory: "",
    allergyHistory: "",
    tcmLineagePreference: "unrestricted",
    conversation: [],
    questionRounds: 1,
    maxQuestionRounds: 1,
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
}

async function post(pathname, state) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
        ...(CUSTOMER_ID ? { "x-cdss-customer-id": CUSTOMER_ID } : {}),
      },
      body: JSON.stringify({ caseState: state }),
      signal: controller.signal,
    });
    return { status: response.status, raw: await response.text(), ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, raw: "", ms: Date.now() - startedAt, transport: error?.name || "error" };
  } finally {
    clearTimeout(timer);
  }
}

const normSyndrome = (value) => normalizeTcmEvalText(String(value || "")).replace(/证$/u, "");
const containEither = (a, b) => Boolean(a && b && a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));

const results = [];
for (const record of selected) {
  const perCasePath = join(OUT_DIR, `${record.id}.json`);
  if (existsSync(perCasePath)) {
    results.push(JSON.parse(readFileSync(perCasePath, "utf8")));
    console.log(`[skip] ${record.id}（已有结果）`);
    continue;
  }
  const caseState = buildCaseState(record);
  let working = caseState;
  const pre = await post("/api/diagnosis/red-flags", caseState);
  try {
    const body = JSON.parse(pre.raw);
    if (body.clinicalFacts) working = { ...working, clinicalFacts: body.clinicalFacts };
  } catch { /* 安全门响应异常不阻断评测，逐案结果里有体现 */ }
  const res = await post("/api/diagnosis/diagnose", working);
  const content = consumeTcmEvalNdjson(res.raw).content;
  const reasoning = parseTcmEvalReasoning(content);
  const overview = reasoning?.overview || {};
  const gold = normSyndrome(record.norm_syndrome);
  const primary = normSyndrome(overview.primarySyndrome);
  const secondaries = (Array.isArray(overview.secondarySyndromes) ? overview.secondarySyndromes : [])
    .map((s) => normSyndrome(typeof s === "string" ? s : s?.name));
  const all = [primary, ...secondaries].filter(Boolean);
  const withheld = !reasoning ? false : (overview.primarySyndromeResolution === "unresolved" || !primary);
  const review = reasoning?.clinicalReview || {};
  const item = {
    id: record.id,
    lcd: record.lcd_name,
    gold: record.norm_syndrome,
    status: res.status,
    ms: res.ms,
    bucket: !reasoning ? "contract_fail" : withheld ? "withheld" : "scored",
    primary: overview.primarySyndrome || "",
    secondaries: all.slice(1),
    exactPrimary: Boolean(primary && primary === gold),
    exactAny: all.some((s) => s === gold),
    containAny: all.some((s) => containEither(s, gold)),
    resolution: overview.primarySyndromeResolution || "",
    review: { status: review.status, decision: review.reviewDecision, issue: review.reviewIssueCode, unavailableReason: review.unavailableReason },
  };
  results.push(item);
  writeFileSync(perCasePath, `${JSON.stringify(item, null, 1)}\n`);
  console.log(`[${item.bucket}] ${record.id} ${item.ms}ms 金=${record.norm_syndrome} 出=${item.primary}${item.exactAny ? " ✓" : item.containAny ? " ≈" : ""} review=${review.status || "-"}/${review.reviewDecision || "-"}`);
}

const scored = results.filter((r) => r.bucket === "scored");
const summary = {
  suite: "tcm-sd-live",
  dataset: "TCM-SD test (ZY-BERT repo, CC BY-NC-SA 4.0)",
  seed: SAMPLE_SEED,
  total: results.length,
  buckets: results.reduce((acc, r) => ({ ...acc, [r.bucket]: (acc[r.bucket] || 0) + 1 }), {}),
  exactPrimary: scored.filter((r) => r.exactPrimary).length,
  exactAny: scored.filter((r) => r.exactAny).length,
  containAny: scored.filter((r) => r.containAny).length,
  scoredCount: scored.length,
  exactAnyRate: scored.length ? Number((scored.filter((r) => r.exactAny).length / scored.length).toFixed(3)) : null,
  containAnyRate: scored.length ? Number((scored.filter((r) => r.containAny).length / scored.length).toFixed(3)) : null,
  reviewAttestation: results.reduce((acc, r) => {
    const key = `${r.review?.status || "-"}/${r.review?.decision || "-"}`;
    return { ...acc, [key]: (acc[key] || 0) + 1 };
  }, {}),
  latencyMs: {
    p50: [...results].map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] || 0,
    max: Math.max(...results.map((r) => r.ms), 0),
    over180s: results.filter((r) => r.ms > 180_000).length,
  },
};
writeFileSync(join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
process.exit(results.some((r) => r.bucket === "contract_fail") ? 1 : 0);

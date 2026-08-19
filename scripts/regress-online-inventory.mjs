// 线上验证：本轮新增能力（2026-08-06）。
//
// 与 regress:prod-smoke 的分工：那套测「M01→M05 链路与签名链是否通」，
// 本套测**本轮新增的三项对外能力在真实链路上是否真的出得来**：
//   A. 药品目录同步（出站）：分页、版本、304
//   B. 院内库存导入（入站）+ 开方缺货标注与替代候选
//   C. HIS 方案的结构化投影：诊断三卡内容非空、方义四项、健康调护、中成药子字段
//
// C 尤其必须在线上跑：本地那套断言喂的是手写夹具，而线上是**真实模型产物**——
// 本轮最大的一个缺陷（HIS 诊断三卡内容恒空）恰恰是「夹具能过、真实产物过不了」造成的，
// 用夹具再测一遍等于重复同一个盲区。
//
// 用法：BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx CDSS_CUSTOMER_ID=xxx node scripts/regress-online-inventory.mjs
import { randomUUID } from "node:crypto";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
if (!CUSTOMER_ID) throw new Error("CDSS_CUSTOMER_ID required");
const HEADERS = {
  "Content-Type": "application/json",
  "x-cdss-customer-id": CUSTOMER_ID,
  ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}),
};

const failures = [];
const notes = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push({ name, detail: String(detail ?? "").slice(0, 300) });
  return ok;
};

async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 300) }; }
  return { status: res.status, body, headers: res.headers };
}

async function postJson(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

/** M01–M04 的 NDJSON 流：拼接 content 并抽出 sentinel JSON。 */
async function stream(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let content = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.content === "string" && parsed.content !== "[END]") content += parsed.content;
    } catch { /* 忽略非 JSON 行 */ }
  }
  const match = /<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/.exec(content);
  let structured;
  try { structured = match ? JSON.parse(match[1].trim()) : undefined; } catch { structured = undefined; }
  return { status: res.status, content, structured };
}

// ───────────────────────── A. 药品目录同步（出站） ─────────────────────────
{
  const summary = await getJson("/api/tcm-knowledge/drug-catalog");
  check("A1 目录概览可用", summary.status === 200 && summary.body.catalogVersion, summary.status);
  check("A2 四类目录均非空",
    Array.isArray(summary.body.types) && summary.body.types.length === 4
      && summary.body.types.every((t) => t.total > 0),
    JSON.stringify(summary.body.types));
  check("A3 出参指向入站入口",
    summary.body.inboundSyncEndpoint === "POST /api/drug-inventory", summary.body.inboundSyncEndpoint);

  const page = await getJson("/api/tcm-knowledge/drug-catalog?type=herb&limit=5");
  check("A4 饮片目录分页", page.status === 200 && page.body.items?.length === 5, page.status);
  check("A5 歧义别名字段存在（不得替医生择一）",
    page.body.items?.every((item) => Array.isArray(item.ambiguousAliases)), "缺 ambiguousAliases");

  const version = summary.body.catalogVersion;
  const notModified = await fetch(
    `${BASE_URL}/api/tcm-knowledge/drug-catalog?type=herb&since=${encodeURIComponent(version)}`,
    { headers: HEADERS });
  check("A6 目录未变返回 304", notModified.status === 304, notModified.status);
}

// ───────────────────────── B. 院内库存导入（入站） ─────────────────────────
{
  const before = await getJson("/api/drug-inventory");
  notes.push(`导入前库存状态：${before.body.inventoryLoaded ? `已有 ${before.body.itemCount} 条` : "未导入"}`);

  // 刻意让「人参」缺货：下面 M04 若开出含人参的方，应标注缺货并给替代候选。
  const imported = await postJson("/api/drug-inventory", {
    source: "线上验证-临时院区目录",
    items: [
      ...["黄芪", "当归", "白术", "茯苓", "党参", "大枣", "炙甘草", "白芍", "熟地黄", "川芎",
        "酸枣仁", "龙眼肉", "木香", "远志", "陈皮", "柴胡", "麻黄", "桂枝", "苦杏仁", "生姜"]
        .map((name) => ({ name, kind: "herb", available: true })),
      { name: "人参", kind: "herb", available: false },
      { name: "八珍颗粒", kind: "patent", available: true, specification: "每袋8g" },
    ],
  });
  check("B1 库存导入成功", imported.status === 200 && imported.body.inventoryVersion, imported.status);
  check("B2 有货/缺货计数正确",
    imported.body.availableHerbCount === 20 && imported.body.availablePatentCount === 1,
    JSON.stringify({ herb: imported.body.availableHerbCount, patent: imported.body.availablePatentCount }));

  const after = await getJson("/api/drug-inventory");
  check("B3 导入后状态可查", after.body.inventoryLoaded === true && after.body.itemCount === 22,
    JSON.stringify({ loaded: after.body.inventoryLoaded, count: after.body.itemCount }));
}

// ───────────────── C. 真实链路 + HIS 投影 + 库存标注 ─────────────────
{
  const id = `ONLINE-INV-${randomUUID().slice(0, 8)}`;
  const caseState = {
    id,
    patient: { sex: "女", age: 30 },
    chiefComplaint: "产后2月余，头痛反复发作1月",
    symptoms: { 现病史: "近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华", 既往史: "否认高血压病史" },
    tongue: "舌淡苔薄白",
    pulse: "脉细弱",
    conversation: [],
    vitals: { BP: "112/70", T: "36.5", P: "80", R: "18", SpO2: "99" },
  };

  const m03 = await stream("/api/diagnosis/diagnose", { caseState });
  check("C1 M03 返回 200", m03.status === 200, m03.status);
  check("C2 M03 结构化结论可解析", Boolean(m03.structured?.overview), "sentinel 缺失或不可解析");
  if (!m03.structured?.overview) {
    console.error(JSON.stringify({ suite: "online-inventory", failures, notes }, null, 2));
    process.exit(1);
  }

  // 本轮补齐的 M03 出参：西医待查依据
  const primary = m03.structured.westernDiagnosis?.primary || {};
  check("C3 西医待查依据齐全（本轮补齐）",
    Array.isArray(primary.suggestedChecks) && Array.isArray(primary.limitations) && Boolean(primary.status),
    JSON.stringify({ status: primary.status, checks: primary.suggestedChecks?.length, lim: primary.limitations?.length }));

  const withM03 = { ...caseState, diagnosis: m03.content, reasoningDiagnose: m03.structured };
  const m04 = await stream("/api/diagnosis/prescribe", { caseState: withM03 });
  check("C4 M04 返回 200", m04.status === 200, m04.status);
  const candidate = m04.structured?.formula?.candidates?.[0];
  check("C5 M04 出方", Boolean(candidate?.herbs?.length), "无候选药味");

  const herbNames = (candidate?.herbs || []).map((h) => h.name);
  notes.push(`M04 药味：${herbNames.join("、")}`);
  notes.push(`M04 方名：${candidate?.name || "(无)"}`);

  const withM04 = { ...withM03, prescription: m04.content, reasoningPrescribe: m04.structured };
  const his = await postJson("/api/diagnosis/his-scheme", { caseState: withM04 });
  check("C6 HIS 方案返回 200", his.status === 200, `${his.status} ${JSON.stringify(his.body).slice(0, 200)}`);

  const scheme = his.body;
  // 本轮最大缺陷：诊断三卡内容恒空。这里用真实产物验，不用夹具。
  check("C7 HIS 西医诊断卡内容非空（本轮根因）",
    Boolean(scheme.diagnoses?.western?.[0]?.content?.trim()), "content 为空串");
  check("C8 HIS 中医证候卡内容非空",
    Boolean(scheme.diagnoses?.tcmPatterns?.[0]?.content?.trim()), "content 为空串");
  check("C9 HIS 病机卡内容非空",
    Boolean(scheme.diagnoses?.mechanism?.[0]?.content?.trim()), "content 为空串");
  check("C10 HIS 西医待查依据结构化投出",
    Boolean(scheme.diagnoses?.westernDetail?.name), "westernDetail 缺失");
  check("C11 HIS 健康调护投出",
    Boolean(scheme.healthGuidance?.diet && scheme.healthGuidance?.lifestyle && scheme.healthGuidance?.emotion),
    JSON.stringify(scheme.healthGuidance || null).slice(0, 160));
  check("C12 HIS 煎法细节投出", Boolean(scheme.prescriptions?.decoctionDetail?.method), "decoctionDetail 缺失");
  check("C13 HIS 中成药结构化字段存在",
    Array.isArray(scheme.prescriptions?.patentMedicines), "patentMedicines 非数组");
  check("C14 HIS 随证加减字段存在",
    Array.isArray(scheme.prescriptions?.modifications), "modifications 非数组");
  // 方义四项：自拟方时可为 null（无受治理方名即无出处），因此只在有方名时要求。
  if (candidate?.formulaNames?.length) {
    check("C15 有受治理方名时方义四项投出",
      Boolean(scheme.prescriptions?.formulaRationale), "formulaRationale 缺失");
  } else {
    notes.push("本例为自拟方，方义四项按设计为空（无受治理方名即无出处）");
  }

  // 库存标注：本轮入站能力的端到端证据
  check("C16 HIS 带库存可得性", scheme.inventory?.loaded === true,
    JSON.stringify(scheme.inventory || null));
  check("C17 每味药都有可得性标注",
    Array.isArray(scheme.herbAvailability) && scheme.herbAvailability.length === herbNames.length,
    JSON.stringify({ got: scheme.herbAvailability?.length, want: herbNames.length }));
  const outOfStock = scheme.outOfStock || [];
  notes.push(`缺货药味：${outOfStock.length ? outOfStock.map((x) => `${x.herb}(替代 ${x.substitutes.map((s) => s.substitute).join("/") || "无"})`).join("、") : "无"}`);
  // 缺货药**必须仍在处方里**——库存不得静默改方。
  for (const entry of outOfStock) {
    check(`C18 缺货药「${entry.herb}」仍保留在处方中（库存不得静默改方）`,
      herbNames.some((name) => name.includes(entry.herb) || entry.herb.includes(name)),
      `处方药味：${herbNames.join("、")}`);
  }
}

const summary = { suite: "online-inventory", checks: 18, failures: failures.length, notes };
if (failures.length > 0) {
  console.error(JSON.stringify({ ...summary, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));

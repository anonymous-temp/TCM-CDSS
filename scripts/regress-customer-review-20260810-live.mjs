/**
 * 甲方 2026-08-10 清单的**线上实证**（HTTP 层）。
 *
 * 与 test:customer-review-20260810 的分工：那一套跑在进程内、钉判据；这一套跑在真实
 * HTTP 边界上、证明**部署出去的那一份**确实是修好的版本——本仓库有过「本地回归全绿、
 * 线上表现相反」而无法分辨「修错了」还是「没上线」的历史，这个脚本就是为了让它可判定。
 *
 * 用法：
 *   BASE_URL=https://host/tcm-cdss CDSS_API_TOKEN=xxx CDSS_CUSTOMER_ID=xxx \
 *     node scripts/regress-customer-review-20260810-live.mjs
 *
 * 刻意不触发 M03/M04 模型调用：本清单里能在 HTTP 层判定的四条（急症排查确认、库存分片、
 * symptoms 自由文本、服务版本）都不需要模型，因此本脚本秒级完成、可在每次部署后无条件跑。
 */
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const CUSTOMER_ID = process.env.CDSS_CUSTOMER_ID || "";
if (!TOKEN) {
  console.error("CDSS_API_TOKEN required");
  process.exit(2);
}
if (!CUSTOMER_ID) {
  console.error("CDSS_CUSTOMER_ID required");
  process.exit(2);
}

const failures = [];
let checks = 0;
const check = (name, condition, detail) => {
  checks += 1;
  if (!condition) failures.push({ name, detail });
};

async function call(path, body, method = "POST") {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-cdss-api-token": TOKEN,
      "x-cdss-customer-id": CUSTOMER_ID,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}

const CARDIAC = "胸痛伴大汗，向左肩背放射，伴气促，持续20分钟不缓解";
const caseWith = (symptoms) => ({
  id: `live-20260810-${Math.random().toString(36).slice(2, 10)}`,
  customerId: CUSTOMER_ID,
  phase: "collect",
  patient: { sex: "男", age: 58 },
  chiefComplaint: "不舒服1天",
  symptoms,
});

// ── ⑫③ symptoms 自由文本必须与 object 形态得到同一批红旗 ──────────────────────
{
  const asObject = await call("/api/diagnosis/red-flags", { caseState: caseWith({ presentHistory: CARDIAC }) });
  const asString = await call("/api/diagnosis/red-flags", { caseState: caseWith(CARDIAC) });
  const asArray = await call("/api/diagnosis/red-flags", { caseState: caseWith([CARDIAC]) });
  const flags = (r) => JSON.stringify(r.json?.safetyGate?.redFlags ?? r.json?.redFlags ?? null);
  check("⑫③ object 形态本身能触发红旗（夹具前提）", flags(asObject) !== "null" && flags(asObject) !== "[]", flags(asObject));
  check("⑫③ symptoms=string 与 object 红旗一致", flags(asString) === flags(asObject), `string=${flags(asString)} object=${flags(asObject)}`);
  check("⑫③ symptoms=string[] 与 object 红旗一致", flags(asArray) === flags(asObject), `array=${flags(asArray)} object=${flags(asObject)}`);
}

// ── ⑫⑤ 急症排查确认不得被一句废话签发 ────────────────────────────────────────
{
  const redFlagCase = caseWith({ presentHistory: CARDIAC });
  const gate = await call("/api/diagnosis/red-flags", { caseState: redFlagCase });
  const findings = gate.json?.safetyGate?.redFlagFindings || gate.json?.redFlagFindings || [];
  check("⑫⑤ 红旗筛查返回了逐条 findings（表单据此逐条留痕）", findings.length > 0, JSON.stringify(gate.json).slice(0, 300));

  const filler = await call("/api/diagnosis/emergency-clearance", {
    caseState: redFlagCase,
    assessmentSummary: "今天天气不错今天天气不错今天天气不错",
  });
  check("⑫⑤ 字数达标但无逐条留痕 ⇒ 400 不签发", filler.status === 400, `status=${filler.status} body=${filler.text.slice(0, 200)}`);
  check("⑫⑤ 拒绝码为 attestations_missing", filler.json?.code === "emergency_clearance_attestations_missing", filler.json?.code);

  const attest = (basis) => findings.map((finding) => ({
    ruleId: finding.ruleId, message: finding.message, disposition: "excluded_by_objective_workup", basis,
  }));
  const fillerBasis = await call("/api/diagnosis/emergency-clearance", {
    caseState: redFlagCase,
    assessmentSummary: "今天天气不错今天天气不错今天天气不错",
    findings: attest("今天天气不错今天天气不错"),
  });
  check("⑫⑤ 客观依据是废话 ⇒ 400 不签发", fillerBasis.json?.code === "emergency_clearance_attestation_basis_not_objective",
    `status=${fillerBasis.status} code=${fillerBasis.json?.code}`);

  const real = await call("/api/diagnosis/emergency-clearance", {
    caseState: redFlagCase,
    assessmentSummary: "已完成急诊心血管排查，未见急性冠脉事件，生命体征平稳",
    findings: attest("心电图无ST段抬高，肌钙蛋白与心肌酶两次复查均阴性"),
  });
  check("⑫⑤ 写明做过什么 ⇒ 200 正常签发", real.status === 200 && Boolean(real.json?.emergencyClearance?.contractSignature),
    `status=${real.status} body=${real.text.slice(0, 200)}`);
  check("⑫⑤ 签发的凭证带逐条留痕（进签名域）", Array.isArray(real.json?.emergencyClearance?.findings) && real.json.emergencyClearance.findings.length === findings.length,
    JSON.stringify(real.json?.emergencyClearance?.findings || null).slice(0, 200));
}

// ── ⑫④ 库存分片：缺片期间线上库存不得被改动 ──────────────────────────────────
//
// **默认只跑只读部分。** 完整的分片流程会真的落一次库存——在生产上跑就等于把院内已导入的
// 库存目录整批替换掉（本接口的语义正是整批替换）。一个"验证脚本"顺手清空客户库存，
// 比它要验证的那个缺陷更严重。因此写入路径必须显式开 CDSS_LIVE_ALLOW_INVENTORY_WRITE=1，
// 只在测试环境或已与院方约好的窗口里跑。
const allowInventoryWrite = process.env.CDSS_LIVE_ALLOW_INVENTORY_WRITE === "1";
if (allowInventoryWrite) {
  const before = await call("/api/drug-inventory", undefined, "GET");
  const importId = `live${Date.now().toString(36)}`;
  const part0 = await call("/api/drug-inventory", {
    source: "live-check", items: [{ name: "黄芪", kind: "herb" }, { name: "当归", kind: "herb" }],
    part: { importId, index: 0, total: 2 },
  });
  check("⑫④ 缺片时返回 202 并列出缺哪几片", part0.status === 202 && Array.isArray(part0.json?.missingParts),
    `status=${part0.status} body=${part0.text.slice(0, 200)}`);
  const during = await call("/api/drug-inventory", undefined, "GET");
  check("⑫④ 缺片期间线上库存未被改动",
    JSON.stringify(during.json?.inventoryVersion ?? null) === JSON.stringify(before.json?.inventoryVersion ?? null),
    `before=${before.json?.inventoryVersion} during=${during.json?.inventoryVersion}`);
  const part1 = await call("/api/drug-inventory", {
    source: "live-check", items: [{ name: "党参", kind: "herb" }],
    part: { importId, index: 1, total: 2 },
  });
  check("⑫④ 集齐后一次性提交，条目数为各片之和", part1.status === 200 && part1.json?.itemCount === 3,
    `status=${part1.status} itemCount=${part1.json?.itemCount}`);
} else {
  console.log("⑫④ 分片写入路径已跳过（未设 CDSS_LIVE_ALLOW_INVENTORY_WRITE=1，避免在生产上整批替换院内库存）");
}

// 413 文案是**只读**判据：超限请求在解析阶段即被拒，一个字节都不落盘，可以无条件跑。
{
  const over = await call("/api/drug-inventory", {
    items: Array.from({ length: 20_001 }, (_, index) => ({ name: `药${index}`, kind: "herb" })),
  });
  check("⑫④ 413 文案不再教对方分批（会让前一批被删光）",
    over.status === 413 && !/split the import into batches/.test(over.json?.error || "") && /part=/.test(over.json?.error || ""),
    `status=${over.status} error=${(over.json?.error || "").slice(0, 200)}`);
}

// ── 版本核对：证明跑的是这一版 ────────────────────────────────────────────────
{
  const health = await call("/api/diagnosis/health", undefined, "GET");
  check("服务可用且返回构建标识", health.status === 200 && Boolean(health.json?.build?.commit || health.json?.build?.sourceDigest),
    JSON.stringify(health.json?.build || null));
  console.log("build:", JSON.stringify(health.json?.build || null));
}

console.log(JSON.stringify({ suite: "customer-review-20260810-live", baseUrl: BASE_URL, checks, failures: failures.length }, null, 2));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

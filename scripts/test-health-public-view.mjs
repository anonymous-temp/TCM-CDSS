// /api/diagnosis/health 对外视图（2026-08-11 甲方线上实测第 12 条：健康接口暴露内部实现细节）。
//
// 这个套件要钉住三件互相牵制的事，少任何一件都会出问题：
//   ① 对外视图里**不能**出现模型身份/厂商/上游地址/调参/探针原文/运行期遥测；
//   ② 对外视图**只删不改**——出现的每个字段值必须与完整视图逐字相同（见 health-public-view.ts
//      顶部注释：这个接口同时是 verify:deployed-image 的证据来源，改写会让"线上值"与"镜像值"
//      不再可比）；
//   ③ 部署核验与容器健康检查依赖的字段必须活下来（build.commit / sourceDigest / strictReady / …）。
//
// ① 的判据不写死字段路径，而是拿**真实的** getDiagnosisProviderStatus() 产物去比：
// 健康体的形状会随依赖增减而漂移，写死路径等于每加一个依赖就要记得回来补一行，漏补是静默的。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  HEALTH_PUBLIC_REQUIRED_PATHS,
  REDACTED_HEALTH_KEYS,
  publicHealthView,
  healthDiagnosticsRequested,
} = await import("../src/lib/health-public-view.ts");
const { getPrimaryTextModelConfig } = await import("../src/lib/text-model.ts");
const { getClinicalFactsModelPlan } = await import("../src/lib/clinical-facts-runtime.ts");
const { getCdssStageTelemetrySnapshot } = await import("../src/lib/cdss-stage-telemetry.ts");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

// diagnosis-api.ts 用了 `@/lib/…` 别名，jiti 无别名解析、导不进来（全仓只有它这么写）。
// 因此这里用同一批**真实**配置值自建 providers 分支，键名与 getDiagnosisProviderStatus() 一致；
// 形状漂移由下面的「源码键名扫描」这条独立判据兜住，不依赖本 fixture 手工同步。
const primary = getPrimaryTextModelConfig();
const clinicalFactsModelPlan = getClinicalFactsModelPlan();
const providers = {
  primaryModel: { provider: primary.provider, model: primary.model, configured: primary.configured, role: "primary text reasoning model", maxTokens: 8192, reasoningEffort: "medium", thinkingEnabled: true, structuredRunTimeoutMs: 180000, baseUrl: primary.baseUrl },
  prescribeModel: { provider: primary.provider, model: primary.model, configured: primary.configured, role: "M04 structured prescription model", repairModel: primary.model, repairReasoningEffort: "medium" },
  diagnoseModel: { provider: primary.provider, model: primary.model, configured: primary.configured, role: "M03 structured diagnostic reasoning model", repairModel: primary.model },
  clinicalReviewModel: { provider: primary.provider, model: primary.model, configured: primary.configured, independentFromGenerator: false },
};

// 真实健康体的骨架（字段名与 route.ts 一致；此处只需覆盖含敏感值的分支）。
const fullBody = {
  module: "tcm-cdss",
  releaseId: "test-release",
  build: { commit: "abc123", sourceDigest: "deadbeef", builtAt: "2026-08-11T00:00:00Z" },
  flow: ["M01采集", "M02追问门控", "M03辨病辨证", "M04候选方药", "M05风险随访"],
  ready: true,
  strictReady: false,
  degradedReasons: ["clinical_facts_extractor_not_configured", "tongue_vision_api_key_not_configured"],
  providers,
  tongueVisionProbe: { ok: false, reason: "api_key_not_configured", message: "GLM 未配置 key：sk-live-xxxx", latencyMs: 42 },
  clinicalReviewProbe: { ok: true, reason: undefined, model: "deepseek-v4-flash" },
  rxAudit: { enabled: true, baseUrl: "https://rxai.internal.example/api", endpoint: "/v1/audit", ready: true },
  externalEvidence: { configured: true, endpoints: ["https://evimed.internal.example/guide"] },
  snapshotPersistence: { enabled: true, encryptionConfigured: true, ready: true },
  clinicalFacts: { enabled: true, signingConfigured: true, modelPlan: { ...clinicalFactsModelPlan, ready: false }, ready: false },
  stageTelemetry: getCdssStageTelemetrySnapshot(),
  rateLimitIdentity: { trustedProxyConfigured: false, modelBudgetScope: "authenticated_session_or_api_tenant", ready: false },
};

const publicBody = publicHealthView(fullBody);
const publicJson = JSON.stringify(publicBody);

// ── ① 敏感值一个都不能出现 ──────────────────────────────────────────────
// 取值来源是真实配置产物，而不是手抄的字面量：配置换了模型，这里跟着换。
const leakCandidates = new Set();
const collectStrings = (value, keyPath = "") => {
  if (typeof value === "string") {
    // 只收「像身份/地址」的串：模型名、厂商名、URL。枚举型 reason 码不算泄露，是运维需要的。
    if (/^https?:\/\//.test(value) || /[a-z]+-v?\d|deepseek|glm|qwen|openai|bailian/i.test(value)) {
      if (value.trim().length >= 4) leakCandidates.add(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => collectStrings(item, keyPath));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectStrings(item, `${keyPath}.${key}`);
  }
};
collectStrings(providers);
collectStrings(clinicalFactsModelPlan);
collectStrings(fullBody.rxAudit);
collectStrings(fullBody.externalEvidence);
collectStrings(fullBody.tongueVisionProbe);

check("敏感串样本非空（否则本套件形同虚设）", () => {
  assert.ok(leakCandidates.size >= 3, `采集到的模型/地址串过少：${leakCandidates.size} 个`);
});

check("对外视图不含任何模型身份/厂商/上游地址串", () => {
  const leaked = [...leakCandidates].filter((needle) => publicJson.includes(needle));
  assert.deepEqual(leaked, [], `对外视图仍含内部标识：${leaked.join("、")}`);
});

check("对外视图不含运行期阶段遥测", () => {
  assert.ok(!("stageTelemetry" in publicBody), "stageTelemetry 仍在对外视图中");
});

check("探针只保留结论与枚举原因，不带上游原文与耗时", () => {
  assert.equal(publicBody.tongueVisionProbe.ok, false);
  assert.equal(publicBody.tongueVisionProbe.reason, "api_key_not_configured");
  assert.ok(!("message" in publicBody.tongueVisionProbe), "探针原始报错仍在对外视图中");
  assert.ok(!("latencyMs" in publicBody.tongueVisionProbe), "探针耗时仍在对外视图中");
});

// ── ①′ 形状漂移守卫：健康体里**新增**的模型/地址类键必须同步进删除集 ──────
// 上面的 fixture 是手抄的，会过时；这条判据直接扫 getDiagnosisProviderStatus() 的源码，
// 把它构造出来的每一个「看起来携带模型身份或上游地址」的键名逐个对照删除集。
// 于是给健康体加一个新模型阶段时，忘记登记会在这里红，而不是静默泄露到线上。
check("providers 源码里的模型/地址类键全部已登记为删除项", () => {
  const source = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function getDiagnosisProviderStatus");
  assert.ok(start > 0, "找不到 getDiagnosisProviderStatus——函数被改名时本判据必须跟着改");
  const body = source.slice(start, source.indexOf("\n}", start));
  const sensitive = new Set();
  // 只看**叶子**键：`primaryModel: {` 这类是容器，它的内容会被逐层裁剪，容器本身要留着，
  // 否则读方连"这个阶段存不存在"都看不到。故排除值以 `{` 开头的键。
  for (const match of body.matchAll(/^\s{4,}([A-Za-z][A-Za-z0-9]*)\s*:(.*)$/gm)) {
    const key = match[1];
    if (match[2].trim().startsWith("{")) continue;
    if (/model|provider|baseurl|endpoint|url|host|token|key/i.test(key)) sensitive.add(key);
  }
  assert.ok(sensitive.size >= 4, `扫到的敏感键过少（${sensitive.size}），正则或函数结构已变`);
  const unregistered = [...sensitive].filter((key) => !REDACTED_HEALTH_KEYS.has(key));
  assert.deepEqual(unregistered, [], `健康体新增了未登记的模型/地址类键：${unregistered.join("、")}`);
});

// ── ② 只删不改：出现的每个值必须与完整视图逐字相同 ──────────────────────
check("对外视图是完整视图的子集（只删不改，无任何脱敏改写）", () => {
  const walk = (pub, full, path) => {
    if (Array.isArray(pub)) {
      assert.ok(Array.isArray(full), `${path} 在完整视图中不是数组`);
      assert.equal(pub.length, full.length, `${path} 数组长度被改写`);
      pub.forEach((item, index) => walk(item, full[index], `${path}[${index}]`));
      return;
    }
    if (pub && typeof pub === "object") {
      assert.ok(full && typeof full === "object", `${path} 在完整视图中不是对象`);
      for (const key of Object.keys(pub)) {
        assert.ok(key in full, `${path}.${key} 在完整视图中不存在——这是改写不是删除`);
        walk(pub[key], full[key], `${path}.${key}`);
      }
      return;
    }
    assert.deepEqual(pub, full, `${path} 的值被改写（对外视图只允许删除）`);
  };
  walk(publicBody, fullBody, "$");
});

// ── ③ 部署核验与容器健康检查依赖的字段必须活下来 ────────────────────────
check("部署链路依赖的字段全部存活", () => {
  for (const path of HEALTH_PUBLIC_REQUIRED_PATHS) {
    const value = path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), publicBody);
    assert.notEqual(value, undefined, `对外视图缺少部署核验依赖字段 ${path}`);
  }
  assert.equal(publicBody.build.commit, "abc123");
  assert.equal(publicBody.build.sourceDigest, "deadbeef");
  assert.equal(publicBody.strictReady, false);
  assert.deepEqual(publicBody.degradedReasons, fullBody.degradedReasons, "降级原因码不得被删——运维靠它定位");
});

// ── 完整视图的解锁条件：两个条件缺一不可 ────────────────────────────────
check("完整视图需同时满足查询参数与服务端开关", () => {
  const original = process.env.CDSS_HEALTH_DIAGNOSTICS;
  try {
    const withParam = new Request("https://example.test/api/diagnosis/health?diagnostics=1");
    const withoutParam = new Request("https://example.test/api/diagnosis/health");
    delete process.env.CDSS_HEALTH_DIAGNOSTICS;
    assert.equal(healthDiagnosticsRequested(withParam), false, "仅有查询参数就解锁了完整视图");
    process.env.CDSS_HEALTH_DIAGNOSTICS = "true";
    assert.equal(healthDiagnosticsRequested(withoutParam), false, "仅有服务端开关就解锁了完整视图");
    assert.equal(healthDiagnosticsRequested(withParam), true, "两个条件都满足却没解锁");
    process.env.CDSS_HEALTH_DIAGNOSTICS = "1";
    assert.equal(healthDiagnosticsRequested(withParam), false, "开关只认字面量 true");
  } finally {
    if (original === undefined) delete process.env.CDSS_HEALTH_DIAGNOSTICS;
    else process.env.CDSS_HEALTH_DIAGNOSTICS = original;
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "health-public-view", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  suite: "health-public-view",
  sensitiveStringsChecked: leakCandidates.size,
  requiredPaths: HEALTH_PUBLIC_REQUIRED_PATHS.length,
  failures: 0,
}));

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
import { createJiti } from "jiti";

// evimed-guide 在**模块加载时**读取说明书/文献端点；下面⑤要在「其余依赖全部就绪」的环境里
// 看 strictReady，必须在任何源码模块加载之前把这两个端点设好（只影响证据状态，与①–④无关）。
process.env.EVIMED_INSTRUCTION_API_URL ||= "https://api.evimed.com/instruction";
process.env.EVIMED_LITERATURE_API_URL ||= "https://api.evimed.com/literature";

const {
  HEALTH_PUBLIC_REQUIRED_PATHS,
  REDACTED_HEALTH_KEYS,
  publicHealthView,
  healthDiagnosticsRequested,
} = await import("../src/lib/health-public-view.ts");
const { getPrimaryTextModelConfig, getPublicTextModelStatus } = await import("../src/lib/text-model.ts");
const { getClinicalFactsModelPlan } = await import("../src/lib/clinical-facts-runtime.ts");
const { getCdssStageTelemetrySnapshot } = await import("../src/lib/cdss-stage-telemetry.ts");
const { getTcmKnowledgeStatus } = await import("../src/lib/tcm-knowledge.ts");
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { getCustomerAuthorizationStatus } = await jiti.import("../src/lib/customer-authorization.ts");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

check("strict 健康探针必须有认证身份限流，不能无限烧六路上游", () => {
  const source = readFileSync(new URL("../src/app/api/diagnosis/health/route.ts", import.meta.url), "utf8");
  assert.match(source, /getCdssAuthenticatedRateLimitKey/);
  assert.match(source, /strict_health_rate_limited/);
  assert.match(source, /"Retry-After"/);
});

check("strict 健康闸门必须包含不泄露白名单的客户授权状态", () => {
  const originalClientId = process.env.CDSS_API_CLIENT_ID;
  const originalCustomerIds = process.env.CDSS_API_CUSTOMER_IDS;
  const originalDefaultCustomerId = process.env.CDSS_DEFAULT_CUSTOMER_ID;
  try {
    process.env.CDSS_API_CLIENT_ID = "his-integrator";
    process.env.CDSS_API_CUSTOMER_IDS = "hospital-A,hospital-B";
    delete process.env.CDSS_DEFAULT_CUSTOMER_ID;
    const status = getCustomerAuthorizationStatus();
    assert.deepEqual(Object.keys(status).sort(), [
      "clientConfigured", "configured", "customerCount", "ready", "valid",
    ]);
    assert.equal(status.ready, true);
    assert.equal(JSON.stringify(status).includes("hospital-A"), false, "健康状态不得返回授权客户列表");

    const source = readFileSync(new URL("../src/app/api/diagnosis/health/route.ts", import.meta.url), "utf8");
    assert.match(source, /getCustomerAuthorizationStatus/);
    assert.match(source, /customer_authorization_not_configured/);
    assert.match(source, /strictReady[\s\S]*customerAuthorization\.ready/);
  } finally {
    if (originalClientId === undefined) delete process.env.CDSS_API_CLIENT_ID;
    else process.env.CDSS_API_CLIENT_ID = originalClientId;
    if (originalCustomerIds === undefined) delete process.env.CDSS_API_CUSTOMER_IDS;
    else process.env.CDSS_API_CUSTOMER_IDS = originalCustomerIds;
    if (originalDefaultCustomerId === undefined) delete process.env.CDSS_DEFAULT_CUSTOMER_ID;
    else process.env.CDSS_DEFAULT_CUSTOMER_ID = originalDefaultCustomerId;
  }
});

// diagnosis-api.ts 用了 `@/lib/…` 别名，jiti 无别名解析、导不进来（全仓只有它这么写）。
// 因此这里用同一批**真实**配置值自建 providers 分支，键名与 getDiagnosisProviderStatus() 一致；
// 形状漂移由下面的「源码键名扫描」这条独立判据兜住，不依赖本 fixture 手工同步。
const primary = getPrimaryTextModelConfig();
const clinicalFactsModelPlan = getClinicalFactsModelPlan();
const providers = {
  primaryModel: { ...getPublicTextModelStatus(), role: "primary text reasoning model", maxTokens: 8192, reasoningEffort: "medium", thinkingEnabled: true, structuredRunTimeoutMs: 180000, baseUrl: primary.baseUrl },
  prescribeModel: { provider: primary.provider, model: primary.model, configured: primary.configured, role: "M04 structured prescription model", repairModel: primary.model, repairReasoningEffort: "medium" },
  diagnoseModel: { provider: primary.provider, model: primary.model, configured: primary.configured, role: "M03 structured diagnostic reasoning model", repairModel: primary.model },
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
  rxAudit: { enabled: true, baseUrl: "https://rxai.internal.example/api", endpoint: "/v1/audit", ready: true },
  externalEvidence: { configured: true, endpoints: ["https://evimed.internal.example/guide"] },
  snapshotPersistence: { enabled: true, encryptionConfigured: true, ready: true },
  clinicalFacts: { enabled: true, signingConfigured: true, modelPlan: { ...clinicalFactsModelPlan, ready: false }, ready: false },
  stageTelemetry: getCdssStageTelemetrySnapshot(),
  // 线上实测漏网的一条：键名（mode）无害，值里写着实现路线与厂商。
  controlledTerminology: { enabled: true, mode: "deterministic_exact_then_prefilter_then_deepseek_closed_set_consensus", ready: true },
  rateLimitIdentity: { trustedProxyConfigured: false, modelBudgetScope: "authenticated_session_or_api_tenant_and_customer", ready: false },
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
collectStrings(getPublicTextModelStatus());
collectStrings(providers);
collectStrings(clinicalFactsModelPlan);
collectStrings(fullBody.rxAudit);
collectStrings(fullBody.externalEvidence);
collectStrings(fullBody.tongueVisionProbe);
collectStrings(fullBody.controlledTerminology);

check("敏感串样本非空（否则本套件形同虚设）", () => {
  assert.ok(leakCandidates.size >= 3, `采集到的模型/地址串过少：${leakCandidates.size} 个`);
});

check("对外视图不含任何模型身份/厂商/上游地址串", () => {
  const leaked = [...leakCandidates].filter((needle) => publicJson.includes(needle));
  assert.deepEqual(leaked, [], `对外视图仍含内部标识：${leaked.join("、")}`);
});

check("受控术语的 mode 串（值里带厂商与实现路线）被删，就绪位保留", () => {
  assert.ok(!("mode" in publicBody.controlledTerminology), "mode 仍在对外视图中");
  assert.equal(publicBody.controlledTerminology.enabled, true, "就绪位不得被一并删掉");
  assert.equal(publicBody.controlledTerminology.ready, true);
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

// ── ④ 库状态不得携带药典版本口径，且判据钉在**产地**而不是某一个出口 ──────────
//
// 2026-08-13 甲方线上实测：/health?strict=1 返回 localPharmacopoeiaBasis「2020版历史规则基线」
// 与 requiredCurrentPharmacopoeia「2025版」。后者尤其有害——全仓没有一处读它做判断，
// 而已确定口径是「2020版即可」，挂在对外接口上会让集成方以为系统要求 2025 版。
//
// 本判据故意打 getTcmKnowledgeStatus() 本身而不是打 publicHealthView 的输出：该函数有
// **两个对外出口**（/api/diagnosis/health 经裁剪、/api/tcm-knowledge/search 原样回传），
// 只断言健康视图等于只验一个出口——那正是禁词闸门 2026-08-12 被线上打脸的同一形状。
check("库状态在产地即不含药典版本口径（覆盖 health 与 KB 检索两个出口）", () => {
  const status = getTcmKnowledgeStatus();
  const serialized = JSON.stringify(status);
  for (const banned of ["Pharmacopoeia", "药典", "2020版", "2025版", "规则基线"]) {
    assert.ok(
      !serialized.includes(banned),
      `库状态里出现「${banned}」：该 payload 会原样出现在 /api/tcm-knowledge/search 的响应里（不经任何裁剪），` +
      `往 REDACTED_HEALTH_KEYS 加键堵不住它。请在 getTcmKnowledgeStatus() 产地删除。`,
    );
  }
  // 反向护栏：溯源字段必须活着，否则「删干净了」会连可追溯性一起删掉。
  assert.ok(status.schemaVersion && status.generatedAt, "schemaVersion/generatedAt 是构建溯源，不得一并删除");
});

// ── ⑤–⑦ 路由级：术语/重排不进 strictReady、model-health 收口、按模型家族实调 ──────────
const checkAsync = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};
const withEnv = async (overrides, fn) => {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
// 生产形态：主 provider 百炼，M02/M03/M04 首轮与小任务 DeepSeek，修复轮与事实抽取 qwen max。
// 其余严格就绪依赖全部配齐，于是 strictReady 只取决于被测的那一项。
const READY_ENV = {
  NODE_ENV: "test",
  AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "test-qwen-key",
  BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  OPENAI_API_KEY: "test-deepseek-key", OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_MODEL: undefined,
  PRIMARY_QUESTION_MODEL: "deepseek-flash", PRIMARY_DIAGNOSE_MODEL: "deepseek-flash", PRIMARY_PRESCRIBE_MODEL: "deepseek-flash",
  PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-flash",
  PRIMARY_DIAGNOSE_REPAIR_MODEL: "qwen3.8-max", PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max",
  PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL: "qwen3.8-max",
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CLINICAL_FACTS_MODEL: "qwen3.8-max",
  CONTROLLED_TERMINOLOGY_NORMALIZATION: undefined, SYNDROME_HYPOTHESIS_RERANK: undefined,
  GLM_VISION_ENABLED: "false",
  EVIMED_GUIDE_API_KEY: "e", EVIMED_INSTRUCTION_API_KEY: "e", EVIMED_LITERATURE_API_KEY: "e",
  CASE_SNAPSHOT_ENCRYPTION_KEY: "s".repeat(32), REASONING_CONTRACT_SIGNING_KEY: "r".repeat(40),
  CDSS_TRUST_PROXY_HEADERS: "true", CDSS_API_CLIENT_ID: "his-integrator", CDSS_API_CUSTOMER_IDS: "hospital-a",
  CDSS_HEALTH_DIAGNOSTICS: undefined,
};
const { GET: diagnosisHealthGet } = await jiti.import("../src/app/api/diagnosis/health/route.ts");
const { GET: modelHealthGet } = await jiti.import("../src/app/api/model-health/route.ts");
const readDiagnosisHealth = async () =>
  (await diagnosisHealthGet(new Request("http://localhost/api/diagnosis/health"))).json();

await checkAsync("⑤ 受控术语归一与证候重排 fail-open：配置失误只报 degradedReasons，不影响 strictReady", async () => {
  await withEnv(READY_ENV, async () => {
    const ready = await readDiagnosisHealth();
    assert.equal(ready.strictReady, true, `基线环境必须严格就绪，否则下面的断言空转：${JSON.stringify(ready.degradedReasons)}`);
    assert.equal(ready.controlledTerminology.ready, true);
  });
  // DeepSeek 家族缺 key：术语归一与证候重排（同一变量驱动）都未配置；阶段模型改回 qwen，
  // 保证唯一变化是这两个辅助层。
  await withEnv({ ...READY_ENV, OPENAI_API_KEY: "", PRIMARY_QUESTION_MODEL: undefined,
    PRIMARY_DIAGNOSE_MODEL: undefined, PRIMARY_PRESCRIBE_MODEL: undefined }, async () => {
    const body = await readDiagnosisHealth();
    for (const reason of ["controlled_terminology_model_not_configured", "syndrome_hypothesis_rerank_model_not_configured"]) {
      assert.ok(body.degradedReasons.includes(reason), `仍须报出 ${reason}`);
    }
    assert.equal(body.controlledTerminology.ready, false, "术语层自身的就绪位照常报 false");
    assert.equal(body.strictReady, true, "fail-open 辅助层配置失误不得把容器判成 unhealthy");
  });
  await withEnv({ ...READY_ENV, CONTROLLED_TERMINOLOGY_NORMALIZATION: "false", SYNDROME_HYPOTHESIS_RERANK: "false" }, async () => {
    const body = await readDiagnosisHealth();
    assert.ok(body.degradedReasons.includes("controlled_terminology_normalization_disabled"));
    assert.ok(body.degradedReasons.includes("syndrome_hypothesis_rerank_disabled"));
    assert.equal(body.strictReady, true, "显式关闭辅助层同样不影响严格就绪");
  });
});

const sseReply = (content) => new Response(
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);
const stubModelFetch = async (reply, fn) => {
  const savedFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    const body = JSON.parse(String(init?.body || "{}"));
    seen.push({ host, model: body.model });
    return reply(host, body);
  };
  try {
    return { result: await fn(), seen };
  } finally {
    globalThis.fetch = savedFetch;
  }
};
// 限流按认证身份分桶（可信代理下取 x-real-ip）；每条用例用不同的地址，互不占用对方的 6 次额度。
let modelHealthCaller = 0;
const modelHealthRequest = (query) => new Request(`http://localhost/api/model-health${query}`, {
  headers: { "x-real-ip": `198.51.100.${++modelHealthCaller}` },
});
const MODEL_NAMES = ["qwen3.8-flash", "qwen3.8-max", "deepseek-flash"];
const HOSTS = ["dashscope.aliyuncs.com", "api.deepseek.com"];

await checkAsync("⑥ model-health 两种响应默认都是对外视图：不带模型名、厂商与上游地址", async () => {
  await withEnv(READY_ENV, async () => {
    const plainResponse = await modelHealthGet(modelHealthRequest(""));
    const plainText = await plainResponse.text();
    for (const needle of [...MODEL_NAMES, ...HOSTS, "Bailian", "DeepSeek"]) {
      assert.ok(!plainText.includes(needle), `plain 视图仍含 ${needle}`);
    }
    const plain = JSON.parse(plainText);
    assert.equal(plain.diagnosis.tongueVision.configured, false, "前端舌象开关读的 tongueVision.configured 必须存活");
    assert.equal(plain.status.configured, true, "主模型就绪位必须存活");
    const { result: checked } = await stubModelFetch(() => sseReply("ok"), async () => {
      const response = await modelHealthGet(modelHealthRequest("?check=1"));
      return { status: response.status, text: await response.text() };
    });
    for (const needle of [...MODEL_NAMES, ...HOSTS, "Bailian", "DeepSeek", "small_tasks"]) {
      assert.ok(!checked.text.includes(needle), `check=1 视图仍含 ${needle}`);
    }
    assert.equal(checked.status, 200);
  });
  await withEnv({ ...READY_ENV, CDSS_HEALTH_DIAGNOSTICS: "true" }, async () => {
    const onlySwitch = await (await modelHealthGet(modelHealthRequest(""))).text();
    assert.ok(!onlySwitch.includes("qwen3.8-flash"), "只开服务端开关、不带查询参数不得解锁完整视图");
    const full = await (await modelHealthGet(modelHealthRequest("?diagnostics=1"))).json();
    assert.equal(full.status.model, "qwen3.8-flash", "两个条件都满足时给完整视图");
    const { result: fullCheck } = await stubModelFetch(() => sseReply("ok"),
      async () => (await modelHealthGet(modelHealthRequest("?check=1&diagnostics=1"))).json());
    assert.ok(fullCheck.liveCheck.families.every((item) => typeof item.model === "string" && item.model), "完整视图带各家族实调所用模型");
  });
  await withEnv({ ...READY_ENV, CDSS_HEALTH_DIAGNOSTICS: undefined }, async () => {
    const onlyParam = await (await modelHealthGet(modelHealthRequest("?diagnostics=1"))).text();
    assert.ok(!onlyParam.includes("qwen3.8-flash"), "只带查询参数、服务端开关未开不得解锁完整视图");
  });
});

await checkAsync("⑦ model-health?check=1 对每个不同的模型家族/端点各实调一次，任一家不通整体失败", async () => {
  await withEnv(READY_ENV, async () => {
    const { result, seen } = await stubModelFetch(() => sseReply("ok"), async () => {
      const response = await modelHealthGet(modelHealthRequest("?check=1"));
      return { status: response.status, body: await response.json() };
    });
    assert.deepEqual(seen.map((item) => item.host).sort(), ["api.deepseek.com", "dashscope.aliyuncs.com"],
      "今天的配置：一次 DashScope + 一次 DeepSeek，按家族/端点去重");
    assert.equal(seen.find((item) => item.host === "api.deepseek.com").model, "deepseek-flash",
      "DeepSeek 端点必须带 DeepSeek 模型名（按模型家族解析端点）");
    assert.equal(seen.find((item) => item.host === "dashscope.aliyuncs.com").model, "qwen3.8-flash");
    assert.equal(result.status, 200);
    assert.equal(result.body.liveCheck.ok, true);
    assert.deepEqual(result.body.liveCheck.families.map((item) => [item.family, item.ok, item.reason]).sort(),
      [["deepseek", true, "ok"], ["qwen", true, "ok"]]);

    // 2026-08-13 形状的事故落在 DeepSeek 账户：主模型照样通，整体必须失败。
    const outage = await stubModelFetch((host) => host === "api.deepseek.com"
      ? new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402, headers: { "Content-Type": "application/json" } })
      : sseReply("ok"), async () => {
      const response = await modelHealthGet(modelHealthRequest("?check=1"));
      return { status: response.status, text: await response.text() };
    });
    assert.equal(outage.result.status, 502, "任一家族不通必须 502");
    const outageBody = JSON.parse(outage.result.text);
    assert.equal(outageBody.liveCheck.ok, false);
    const deepseek = outageBody.liveCheck.families.find((item) => item.family === "deepseek");
    assert.equal(deepseek.ok, false);
    assert.equal(deepseek.reason, "request_failed", "对外视图删掉 error 原文，靠枚举原因定位");
    assert.ok(!outage.result.text.includes("Insufficient Balance"), "上游报错原文不得出现在对外视图");
    assert.equal(outageBody.liveCheck.families.find((item) => item.family === "qwen").ok, true);

    // 只返回推理过程、没有最终内容：沿用「最终内容才算活着」的旧判据。
    const reasoningOnly = await stubModelFetch((host) => host === "api.deepseek.com"
      ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "…" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } })
      : sseReply("ok"), async () => (await modelHealthGet(modelHealthRequest("?check=1"))).json());
    assert.equal(reasoningOnly.result.liveCheck.ok, false);
    assert.equal(reasoningOnly.result.liveCheck.families.find((item) => item.family === "deepseek").reason, "reasoning_only");
  });
  // 某一家没配齐（缺 key）：不发请求，直接判该家族 not_configured，整体失败。
  await withEnv({ ...READY_ENV, OPENAI_API_KEY: "" }, async () => {
    const { result, seen } = await stubModelFetch(() => sseReply("ok"),
      async () => (await modelHealthGet(modelHealthRequest("?check=1"))).json());
    assert.deepEqual(seen.map((item) => item.host), ["dashscope.aliyuncs.com"]);
    assert.equal(result.liveCheck.ok, false);
    assert.equal(result.liveCheck.families.find((item) => item.family === "deepseek").reason, "not_configured");
  });
  // 全部阶段同一家：只实调一次。
  await withEnv({ ...READY_ENV, PRIMARY_QUESTION_MODEL: undefined, PRIMARY_DIAGNOSE_MODEL: undefined,
    PRIMARY_PRESCRIBE_MODEL: undefined, CONTROLLED_TERMINOLOGY_MODEL: undefined }, async () => {
    const { result, seen } = await stubModelFetch(() => sseReply("ok"),
      async () => (await modelHealthGet(modelHealthRequest("?check=1"))).json());
    assert.deepEqual(seen.map((item) => item.host), ["dashscope.aliyuncs.com"]);
    assert.deepEqual(result.liveCheck.families.map((item) => item.family), ["qwen"]);
  });
});

await checkAsync("⑦′ 限流语义不变：同一身份 10 分钟 6 次实调，第 7 次 429 且不打上游", async () => {
  await withEnv(READY_ENV, async () => {
    const sameCaller = () => new Request("http://localhost/api/model-health?check=1", {
      headers: { "x-real-ip": "203.0.113.77" },
    });
    const { result, seen } = await stubModelFetch(() => sseReply("ok"), async () => {
      const statuses = [];
      for (let index = 0; index < 7; index += 1) statuses.push((await modelHealthGet(sameCaller())).status);
      return statuses;
    });
    assert.deepEqual(result, [200, 200, 200, 200, 200, 200, 429]);
    assert.equal(seen.length, 12, "每次放行的实调按家族数发请求（2 家 × 6 次），被限流的那次一个都不发");
  });
});

await checkAsync("⑧ verify:deployed-image 要求 model-health 里每个模型家族都 ok", async () => {
  const { execFileSync, spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const digest = execFileSync("node", ["scripts/build-source-digest.mjs", "--quiet"], { encoding: "utf8" }).trim();
  let liveCheck;
  const server = createServer((req, res) => {
    const body = req.url.startsWith("/api/diagnosis/health")
      ? { build: { commit, sourceDigest: digest, builtAt: "t" }, releaseId: "r", strictReady: true }
      : req.url.startsWith("/api/model-health?check=1") ? { module: "text-model", liveCheck } : { error: "not found" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runVerify = () => new Promise((resolve) => {
    const child = spawn("node", ["scripts/verify-deployed-image.mjs"], {
      env: { ...process.env, BASE_URL: baseUrl, CDSS_API_TOKEN: "", SKIP_MODEL_LIVE_CHECK: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolve({ code, result: JSON.parse(stdout || "{}") }));
  });
  try {
    liveCheck = { ok: true, families: [{ family: "qwen", ok: true, reason: "ok" }, { family: "deepseek", ok: true, reason: "ok" }] };
    const allLive = await runVerify();
    assert.equal(allLive.code, 0, JSON.stringify(allLive.result));
    assert.equal(allLive.result.reason, "image_matches_tested_source_and_model_live");

    liveCheck = { ok: false, families: [{ family: "qwen", ok: true, reason: "ok" }, { family: "deepseek", ok: false, reason: "request_failed" }] };
    const deepseekDown = await runVerify();
    assert.equal(deepseekDown.code, 1, "DeepSeek 家族不通时部署核验必须失败");
    assert.equal(deepseekDown.result.reason, "model_family_unreachable_or_unfunded");
    assert.deepEqual(deepseekDown.result.modelLive.families, [
      { family: "qwen", ok: true }, { family: "deepseek", ok: false, reason: "request_failed" },
    ]);

    // 自相矛盾的响应（整体 ok 却有一家失败）按失败处理——逐家判定，不只信总开关。
    liveCheck = { ok: true, families: [{ family: "qwen", ok: true }, { family: "deepseek", ok: false, reason: "timeout" }] };
    assert.equal((await runVerify()).code, 1);

    // 一家都没实调到的「ok」什么也证明不了。
    liveCheck = { ok: true, families: [] };
    const empty = await runVerify();
    assert.equal(empty.code, 1, "families 为空不得判活");
    assert.equal(empty.result.reason, "model_health_unverifiable");

    // 旧形状（只有主模型一个结论、没有 families）无法证明其余家族活着 ⇒ 失败。
    liveCheck = { ok: true, provider: "Alibaba Cloud Bailian Qwen", model: "qwen3.8-flash" };
    const legacy = await runVerify();
    assert.equal(legacy.code, 1);
    assert.equal(legacy.result.reason, "model_health_unverifiable");
  } finally {
    await new Promise((resolve) => server.close(resolve));
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

// /api/diagnosis/health 的**对外视图**（2026-08-11 甲方线上实测第 12 条）。
//
// 实测反馈：健康检查接口把内部实现整个摊开——各阶段模型名与厂商、修复轮用的是哪个模型、
// reasoning_effort、maxTokens、超时毫秒数、上游探针的原始报错、以及运行期阶段遥测。
// 这个接口在 proxy 的 matcher 内、要带令牌才能访问，所以不是匿名泄露；但令牌是**甲方全员**
// 共用的一枚，医院侧任何一个能打开页面的人都能拿到，它并不是运维凭证。把模型拓扑与上游报错
// 挂在这个面上，等于把「我方用了谁家模型、每阶段怎么配的」当成产品的一部分交付出去。
//
// 收口方式刻意选了**只删不改**：对外视图里出现的每一个字段，其值必须与完整视图逐字相同——
// 不做任何脱敏改写（不打星号、不替换成 "***"、不概括成 "configured"）。理由是这个接口同时是
// 部署链路的证据来源（verify:deployed-image 比对 build.commit / build.sourceDigest，
// docker healthcheck 读 strictReady）：一旦允许改写，"线上返回的值" 与 "镜像里的值" 就不再
// 是同一件东西，而那正是 build 溯源这一整套机制要排除的情形。删除是可判定的，改写不是。
//
// 需要完整视图时（排障、发布核验）：同时满足 `?diagnostics=1` 与 `CDSS_HEALTH_DIAGNOSTICS=true`。
// 两个条件缺一不可——环境变量单独存在不改变默认行为，查询参数单独存在也不解锁，
// 于是「谁能看到完整视图」是一次显式的服务端配置决定，而不是任何持令牌者的一个 URL 参数。

/** 无论视图如何收窄都必须存活的字段路径：部署核验与容器健康检查依赖它们。 */
export const HEALTH_PUBLIC_REQUIRED_PATHS = [
  "module",
  "releaseId",
  "build.commit",
  "build.sourceDigest",
  "build.builtAt",
  "ready",
  "strictReady",
  "degradedReasons",
] as const;

/**
 * 对外视图里一律删除的键名。分三类：
 *   ① 模型/厂商身份与调参（model / provider / reasoningEffort / maxTokens / …）；
 *   ② 上游地址与探针原始细节（baseUrl / endpoint / message / detail / …）；
 *   ③ 运行期遥测（stageTelemetry）——含各阶段调用次数、耗时与最近失败原因。
 *
 * 按**键名**删除而不是按路径删除：健康体的形状随依赖增减而变，按路径写死等于每加一个依赖
 * 就要记得回来补一行，而漏补是静默的（新依赖的模型名直接出现在对外视图里）。按键名删除对
 * 形状漂移免疫，代价是可能误删同名的无害字段——那是可接受的方向（少给，不多给）。
 */
export const REDACTED_HEALTH_KEYS: ReadonlySet<string> = new Set([
  // ① 模型身份与调参
  "model", "models", "provider", "providerId", "repairModel", "extractor", "reviewer", "adjudicator",
  "modelPlan", "reasoningEffort", "repairReasoningEffort", "thinkingEnabled",
  "maxTokens", "maxPromptChars", "maxOutputChars",
  "structuredRetryTimeoutMs", "structuredRunTimeoutMs", "role",
  // ② 上游地址与探针细节
  "baseUrl", "apiBase", "endpoint", "endpoints", "url", "host", "path",
  "message", "detail", "details", "error", "errors", "stack", "sample", "raw",
  "latencyMs", "elapsedMs", "httpStatus", "statusText",
  // ③ 运行期遥测
  "stageTelemetry",
  // ④ 把实现路线写进枚举值的状态串。受控术语归一的 mode 是
  //    `deterministic_exact_then_prefilter_then_deepseek_closed_set_consensus`——
  //    键名不敏感、**值**里带着厂商名。这类串没法靠键名判断，只能整键删掉；
  //    读方需要的「这层有没有就绪」由同级的 enabled / ready 给出。
  "mode",
]);

/**
 * 只删不改：递归复制，丢弃 REDACTED_KEYS 命中的键，其余键的值逐字保留。
 * 容器（对象/数组）本身不被替换成占位符——空对象就是空对象，读方能看出「这里被删空了」。
 */
export function publicHealthView<T>(body: T): T {
  return prune(body) as T;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => prune(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (REDACTED_HEALTH_KEYS.has(key)) continue;
    next[key] = prune(source[key]);
  }
  return next;
}

/** 完整视图需要**同时**满足显式查询参数与服务端开关；任一缺失都回落到对外视图。 */
export function healthDiagnosticsRequested(req: Request): boolean {
  let requested = false;
  try {
    requested = new URL(req.url).searchParams.get("diagnostics") === "1";
  } catch {
    requested = false;
  }
  return requested && process.env.CDSS_HEALTH_DIAGNOSTICS === "true";
}

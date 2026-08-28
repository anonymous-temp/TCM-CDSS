// 服务端专用（`.server.ts` 边界）。刻意不写 `import "server-only"`：rxaudit.ts 会导入本模块，
// 而 rxaudit.ts 被多个纯 Node 测试套件直接导入，引入该运行时依赖会让整条导入图都要加 alias。
// 本仓已有 8 个 .server.ts 模块同样不写这行——边界由命名约定与调用方（仅服务端路由）保证。

/**
 * 灵犀「合理用药统一 API」V1.21 的**查询类** operation 客户端。
 *
 * 已有的 rxaudit.ts 只用了统一入口的一个 operation（PRESCRIPTION_AUDIT）。同一个入口另有 12 个
 * 查询能力，其中两个直接对上本仓已实测的缺口：
 *
 *   · DRUG_MASTER_SEARCH —— 药品身份。rxaudit 的 isSpecificMedicationIdentity 目前只认
 *     中药材、精确匹配的中成药、以及一份手写的 16 个西药名 Set；2026-08-28 实测 12 个常见门诊药
 *     里 10 个被判「身份不具体」而整份抽取转人工（氨氯地平/硝酸甘油/奥美拉唑/甲钴胺…）。
 *     这三个药在本接口都能查到标准身份（total 60/39/60），受治理来源本来就存在。
 *   · COMPATIBILITY_QUERY —— 配伍禁忌。
 *
 * 三条硬约束：
 *  1) **默认关闭**（RXAI_QUERY_ENABLED，缺省 false）。关闭时所有函数返回「无结果」，
 *     调用方必须保持原有行为逐字不变。
 *  2) **fail-open 到既有判据**：网络、超时、非 200、结构不合法一律当作「查不到」，
 *     绝不因为查询失败而放宽或收紧既有安全结论。
 *  3) **只加不减**：provider 的风险分级永远不能下调本地确定性结论。
 *     实测依据——硝酸甘油 × 西地那非，provider 返回 CAUTION/MEDIUM，而本地受治理规则
 *     DDI-NITRATE-PDE5 是 CRITICAL「禁忌/阻断」。谁更严谁作数，本地 CRITICAL 不可被软化。
 */

import { canonicalMedicationIdentity } from "./clinical-polarity";
import { readResponseTextLimited } from "./http-response-limit";

const QUERY_PATH = "/api/v1/rational-drug-use";
const QUERY_TIMEOUT_MS = 8_000;
const QUERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_KEYWORDS_PER_CALL = 12;

/**
 * 端点配置由调用方传入，本模块不自己读 RXAI_AUDIT_* —— 审方与查询走同一个服务、同一套凭据，
 * 配置解析必须只有 getRxAuditConfig 一处。由调用方注入也让依赖方向保持单向（rxaudit → 本模块），
 * 不产生循环导入。
 */
export type RxaiEndpointConfig = Readonly<{
  baseUrl: string;
  token: string;
  tenantId: string;
  systemCode: string;
  configured: boolean;
  transportAllowed: boolean;
}>;

/** 缺省关闭：查询能力是增强档，未显式开启时整个模块不发任何请求。 */
export function rxaiQueryEnabled(cfg: RxaiEndpointConfig): boolean {
  return process.env.RXAI_QUERY_ENABLED === "true" && cfg.configured && cfg.transportAllowed;
}

export type RxaiQueryOperation =
  | "DRUG_MASTER_SEARCH"
  | "COMPATIBILITY_QUERY";

function requestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);
}

/**
 * 统一入口请求。鉴权同时下发 Authorization 与 X-API-Key：文档把 Authorization 标为
 * 「生产必填」、X-API-Key 只是兼容字段，而既有 rxaudit 客户端只发了后者。测试环境两者都通，
 * 但生产若按文档强制，只发兼容字段就会 401。两个都带没有代价。
 */
async function rxaiQuery(
  cfg: RxaiEndpointConfig,
  operation: RxaiQueryOperation,
  data: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (!rxaiQueryEnabled(cfg) || signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const response = await fetch(`${cfg.baseUrl}${QUERY_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
        "X-API-Key": cfg.token,
        "X-Tenant-Id": cfg.tenantId,
      },
      body: JSON.stringify({
        request_id: requestId(operation.slice(0, 8)),
        system_code: cfg.systemCode,
        operation,
        data,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const raw = await readResponseTextLimited(response, QUERY_MAX_RESPONSE_BYTES);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (Number(body?.code) !== 200) return null;
    const payload = body.data;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    // 查询是增强档：任何失败都退回既有判据，不改变安全结论。
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

function itemsOf(payload: Record<string, unknown> | null): Record<string, unknown>[] {
  const items = payload?.items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function normalizedName(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
    : "";
}

function canonicalDrugName(value: unknown): string {
  return canonicalMedicationIdentity(normalizedName(value));
}

/**
 * 判定 provider 是否认得这些药名。返回的是**归一化后的输入名**集合，不是 provider 的规范名——
 * 调用方要回答的问题是「医生写的这个词是不是一个具体药物身份」，而不是「它的标准名叫什么」。
 *
 * 只在 provider 返回条目的药名/通用名/标准名之一经共享剂型归一后与输入精确相等
 * 时才算命中。任意前缀、反向包含和组合制剂都不能授权一个残缺药名。
 */
export async function resolveGovernedDrugIdentities(
  cfg: RxaiEndpointConfig,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const resolved = new Set<string>();
  if (!rxaiQueryEnabled(cfg)) return resolved;
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, MAX_KEYWORDS_PER_CALL);
  for (const name of unique) {
    if (signal?.aborted) break;
    const payload = await rxaiQuery(cfg, "DRUG_MASTER_SEARCH", { keyword: name, page_size: 5 }, signal);
    const key = canonicalDrugName(name);
    if (!key) continue;
    const matched = itemsOf(payload).some((item) => {
      // ★ 名称匹配单独用是**不成立**的。2026-08-28 实测：给 DRUG_MASTER_SEARCH 传
      // 「不存在的药名XYZ」，provider 会原样回声一条 total=1 的条目，drug_name/generic_name/
      // standard_drug_name 三个字段都等于关键词本身。只按名字判存在，等于任何字符串都能被
      // 证成药物身份——那会把 isSpecificMedicationIdentity 的 fail-closed 保护整个抹掉。
      //
      // 回声条目与真实条目的区别是**没有任何受治理标识**：ypid（药品本位码/标准药品ID）、
      // approval_no（批准文号）、atc_code 全为 null，并带 barcode_69_missing_reason=
      // nmpa_drug_code_not_found。因此存在性判据取「名称相符 **且** 至少有一个受治理标识」。
      // standard_drug_code / standard_drug_id / drug_id 不能用作判据：回声条目也会拿到
      // 合成 ID（实测 STD_DRUG_01F95845D7E2 / DRUG_613D6EF1D24C）。只有这三个来自国家级
      // 目录的标识在回声条目上恒为 null：ypid（药品本位码）、approval_no（批准文号）、atc_code。
      const hasGovernedIdentifier = ["ypid", "approval_no", "approval_number", "atc_code"]
        .some((field) => {
          const value = item[field];
          return typeof value === "string" ? value.trim().length > 0 : typeof value === "number";
        });
      if (!hasGovernedIdentifier) return false;
      for (const field of ["drug_name", "generic_name", "standard_drug_name", "drug_comm_name"]) {
        const candidate = canonicalDrugName(item[field]);
        if (candidate && candidate === key) return true;
      }
      return false;
    });
    if (matched) resolved.add(key);
  }
  return resolved;
}

export type RxaiCompatibilityFinding = {
  drugNames: string[];
  compatibilityResult: string;
  riskLevel: string;
  riskTip: string;
};

/** 查询一组药名的配伍/相互作用。只读，结果由调用方按「只加不减」并入本地结论。 */
export async function queryDrugCompatibility(
  cfg: RxaiEndpointConfig,
  drugNames: readonly string[],
  signal?: AbortSignal,
): Promise<RxaiCompatibilityFinding[]> {
  if (!rxaiQueryEnabled(cfg) || drugNames.length < 2) return [];
  if (signal?.aborted) return [];
  const requestedDrugNames = [...new Set(drugNames.map((name) => name.trim()).filter(Boolean))]
    .slice(0, MAX_KEYWORDS_PER_CALL);
  const requestedIdentities = new Set(requestedDrugNames.map(normalizedName).filter(Boolean));
  const payload = await rxaiQuery(cfg, "COMPATIBILITY_QUERY", {
    drug_names: requestedDrugNames,
    page_size: 20,
  }, signal);
  return itemsOf(payload).flatMap((item) => {
    const riskTip = typeof item.risk_tip === "string" ? item.risk_tip.trim().slice(0, 1000) : "";
    const riskLevel = typeof item.risk_level === "string" ? item.risk_level.trim().slice(0, 80) : "";
    const compatibilityResult = typeof item.compatibility_result === "string"
      ? item.compatibility_result.trim().slice(0, 80)
      : "";
    const returnedDrugNames = Array.isArray(item.drug_names)
      ? item.drug_names.filter((name): name is string => typeof name === "string").map((name) => name.trim()).filter(Boolean)
      : [];
    const returnedIdentities = returnedDrugNames.map(normalizedName);
    if (!riskTip || !riskLevel || returnedDrugNames.length !== 2
      || returnedIdentities.some((identity) => !identity || !requestedIdentities.has(identity))) return [];
    return [{
      drugNames: returnedDrugNames,
      compatibilityResult,
      riskLevel,
      riskTip,
    }];
  });
}

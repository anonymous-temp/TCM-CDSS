import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { textModelConfigForModel } from "./text-model";

/**
 * DeepSeek 联网检索（Search API，2026-10-17 开放；POST {base}/v1/tools/search）。2026-10-18 起只用于「窄核对」：
 * 拿一个受治理的名称（病名）去查权威来源的写法，交给核对任务当参照。不进 M03/M04 的生成提示词，不产生剂量、诊断或引用。
 *
 * 为什么只这么用（~/runlogs/r1018/research/R-retrieval.md）：
 *  · 强模型在病例题上加检索多半不涨甚至下降（MIRAGE：GPT-4 在 MedQA 上 83.97→82.80），无关段落会把准确率拉低最多 17.9%；
 *    本项目 9/27 也实测过「贴进提示词的被动知识模型基本不用」。
 *  · 检索用于核对单个说法（诊断名是否满足标准）是证据最好的用法；FDA CDS 指南要求来源可识别（带出处与日期），
 *    所以结果只取权威度≥3（Search API 的 authority 字段，0–4）、带网址与站名，交付时不当作引用。
 *
 * 隐私：查询词只能由调用方用受治理名称拼成（webSearchGovernedTerm），绝不放病历原文；不传 ori_question、localization。
 * 实测（2026-10-18，本机）：10 个医学查询单次 300–455 ms，前三条多为默沙东诊疗手册、人卫临床助手、中华医学期刊网、国家药监局。
 * 限额 5 QPS/账户，$0.75/千次成功调用（2026-11-01 起计费）；失败、空结果、超时不缓存。
 * 开关：CDSS_WEB_SEARCH=false 关闭（关闭后各调用方退回只用本地资料）。
 */
export type WebSearchResult = {
  title: string;
  url: string;
  siteName: string;
  summary: string;
  authority: number;
  rerankScore: number;
  date: string | null;
};

const DEFAULT_TIMEOUT_MS = 2_000;

export function webSearchEnabled(): boolean {
  return process.env.CDSS_WEB_SEARCH !== "false";
}

function searchEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${base}/v1/tools/search`;
}

/** 解析 Search API 的返回；字段缺失或类型不对的条目丢弃。导出供测试。 */
export function parseWebSearchResponse(payload: unknown): WebSearchResult[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url : "";
    const title = typeof row.title === "string" ? row.title : "";
    if (!/^https?:\/\//u.test(url) || !title) return [];
    return [{
      title,
      url,
      siteName: typeof row.site_name === "string" ? row.site_name : "",
      summary: typeof row.summary === "string" ? row.summary : typeof row.snippet === "string" ? row.snippet : "",
      authority: typeof row.authority === "number" ? row.authority : -1,
      rerankScore: typeof row.rerank_score === "number" ? row.rerank_score : 0,
      date: typeof row.date === "string" ? row.date : null,
    }];
  });
}

/**
 * 用受治理名称拼查询并检索。term 只能是名称（病名、药名），不得是病历文字；长度 2–30 字，只允许中文、字母、数字与常见连接符。
 * 返回权威度≥minAuthority 的结果（缺省 3，即「高权威」档）；任何失败返回 []。
 */
export async function webSearchGovernedTerm(
  term: string,
  suffix: string,
  options: { count?: number; minAuthority?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WebSearchResult[]> {
  const name = term.trim();
  if (!webSearchEnabled() || options.signal?.aborted) return [];
  if (name.length < 2 || name.length > 30 || !/^[一-鿿A-Za-z0-9·\-－()（）]+$/u.test(name)) return [];
  const config = textModelConfigForModel(process.env.CDSS_WEB_SEARCH_MODEL_FAMILY?.trim() || "deepseek-flash");
  if (!config.configured || !config.apiKey) return [];
  const query = `${name} ${suffix}`.trim().slice(0, 128);
  const count = Math.min(Math.max(options.count ?? 5, 1), 10);
  const minAuthority = options.minAuthority ?? 3;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = await memoizedSmallTask<WebSearchResult[]>("web_search", smallTaskMemoKey(["deepseek-search", query, count]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(searchEndpoint(config.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, count, need_content: false }),
        signal: controller.signal,
      });
      const payload = response.ok ? await response.json().catch(() => null) : null;
      const parsed = parseWebSearchResponse(payload);
      console.info("[tcm-cdss:telemetry] web_search", { status: response.status, results: parsed.length, ms: Date.now() - started });
      return { value: parsed, cacheable: response.ok && parsed.length > 0 };
    } catch {
      console.info("[tcm-cdss:telemetry] web_search", { status: "error", ms: Date.now() - started });
      return { value: [], cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, [], options.signal);
  return results.filter((item) => item.authority >= minAuthority);
}

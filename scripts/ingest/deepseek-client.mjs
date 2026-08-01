// 共享 DeepSeek v4-pro 裁定客户端：带重试、JSON 数组提取、并发池与 JSONL 检查点。
// 仅构建期治理使用；铁律见各批次脚本（只裁主治原文直接支持的、拿不准留空）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");

export async function callAdjudicator({ system, user, maxTokens = 8000, attempts = 3, format = "array" }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
          max_tokens: maxTokens,
          reasoning_effort: "high",
          thinking: { type: "enabled" },
          stream: false,
        }),
        signal: AbortSignal.timeout(420_000),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = (await res.json()).choices?.[0]?.message?.content || "";
      return format === "object" ? extractJsonObject(text) : extractJsonArray(text);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 8000 * attempt));
    }
  }
  throw lastError;
}

export function extractJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`模型未返回 JSON 数组: ${text.slice(0, 160)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/** 对象契约（{"nodes":[…],"edges":[…]}）：优先整体解析，退化为首尾大括号切片。 */
export function extractJsonObject(text) {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* 继续走切片 */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`模型未返回 JSON 对象: ${text.slice(0, 160)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 并发池 + JSONL 检查点：已完成的 key 跳过，崩溃可续跑。 */
export async function runPool({ items, keyOf, workers = 4, checkpointPath, handle }) {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const done = new Set();
  if (existsSync(checkpointPath)) {
    for (const line of readFileSync(checkpointPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).key); } catch { /* 半行忽略 */ }
    }
  }
  const pending = items.filter((item) => !done.has(keyOf(item)));
  console.log(JSON.stringify({ total: items.length, done: done.size, pending: pending.length }));
  let cursor = 0;
  let failures = 0;
  const append = (record) => writeFileSync(checkpointPath, JSON.stringify(record) + "\n", { flag: "a" });
  async function worker(id) {
    while (cursor < pending.length) {
      const item = pending[cursor];
      cursor += 1;
      const key = keyOf(item);
      try {
        const result = await handle(item);
        append({ key, ok: true, result });
        console.log(`[w${id}] ✓ ${key}`);
      } catch (error) {
        failures += 1;
        append({ key, ok: false, error: String(error).slice(0, 300) });
        console.warn(`[w${id}] ✗ ${key}: ${String(error).slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  return { failures };
}

export function readCheckpoint(checkpointPath) {
  const out = new Map();
  if (!existsSync(checkpointPath)) return out;
  for (const line of readFileSync(checkpointPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      out.set(record.key, record);
    } catch { /* ignore */ }
  }
  return out;
}

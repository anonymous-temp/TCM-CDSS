import { searchTcmKnowledge, getTcmKnowledgeStatus } from "@/lib/tcm-knowledge";
import { readJsonBodyWithLimit } from "@/lib/http-guard";

const MAX_BODY_BYTES = 30_000;
const MAX_QUERY_CHARS = 2000;

export async function POST(req: Request) {
  let query = "";
  let limit = 10;
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object" ? parsed.body as { query?: unknown; limit?: unknown } : {};
  query = typeof body.query === "string" ? body.query : "";
  limit = typeof body.limit === "number" ? Math.min(Math.max(body.limit, 1), 30) : 10;

  if (!query.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return Response.json({ error: "query too long" }, { status: 413 });
  }

  return Response.json({
    status: getTcmKnowledgeStatus(),
    hits: searchTcmKnowledge(query, limit),
  });
}

export async function GET(req: Request) {
  // 对外文档承诺 GET ?q=<关键词> 即检索；此前 GET 无视查询参数、恒返回库状态——集成方
  // 拿到 HTTP 200 却永远拿不到检索结果（甲方生产实测）。带 q 时执行真实检索，
  // 不带 q 保持原状态查询语义（健康检查用途不变）。
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  if (!query) return Response.json(getTcmKnowledgeStatus());
  if (query.length > MAX_QUERY_CHARS) {
    return Response.json({ error: "query too long" }, { status: 413 });
  }
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 30) : 10;
  return Response.json({
    status: getTcmKnowledgeStatus(),
    hits: searchTcmKnowledge(query, limit),
  });
}

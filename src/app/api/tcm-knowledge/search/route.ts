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

export async function GET() {
  return Response.json(getTcmKnowledgeStatus());
}

import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { getTcmHerbFunctionText } from "@/lib/tcm-knowledge";

const MAX_BODY_BYTES = 2_000;
const MAX_HERB_NAME_CHARS = 40;

function herbFunctionResponse(rawHerb: unknown): Response {
  const herb = typeof rawHerb === "string" ? rawHerb.trim() : "";
  if (!herb) return Response.json({ error: "herb is required" }, { status: 400 });
  if (herb.length > MAX_HERB_NAME_CHARS) {
    return Response.json({ error: "herb name too long" }, { status: 413 });
  }
  return Response.json({
    herb,
    functionText: getTcmHerbFunctionText(herb).trim(),
  });
}

// 对外接口文档承诺的形态是 GET ?name=<药名>（与同目录 search 一致）；此前只实现了 POST，
// 集成方照文档调用会得到 405。两种形态并存：GET 供查询式集成，POST 兼容既有调用方。
export async function GET(req: Request) {
  const url = new URL(req.url);
  return herbFunctionResponse(url.searchParams.get("name") ?? url.searchParams.get("herb") ?? "");
}

export async function POST(req: Request) {
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body && typeof parsed.body === "object"
    ? parsed.body as { herb?: unknown }
    : {};
  return herbFunctionResponse(body.herb);
}

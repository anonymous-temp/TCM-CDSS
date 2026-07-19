import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { getTcmHerbFunctionText } from "@/lib/tcm-knowledge";

const MAX_BODY_BYTES = 2_000;
const MAX_HERB_NAME_CHARS = 40;

export async function POST(req: Request) {
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;

  const body = parsed.body && typeof parsed.body === "object"
    ? parsed.body as { herb?: unknown }
    : {};
  const herb = typeof body.herb === "string" ? body.herb.trim() : "";
  if (!herb) return Response.json({ error: "herb is required" }, { status: 400 });
  if (herb.length > MAX_HERB_NAME_CHARS) {
    return Response.json({ error: "herb name too long" }, { status: 413 });
  }

  return Response.json({
    herb,
    functionText: getTcmHerbFunctionText(herb).trim(),
  });
}

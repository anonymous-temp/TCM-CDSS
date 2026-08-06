import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { drugInventorySnapshot, importDrugInventory } from "@/lib/drug-inventory.server";

/**
 * 院内药品库存导入（甲方 2026-08-05「药品同步接口」入站方向）。
 *
 * 甲方把医院库存药推进来，开方时优先落在有货药味上；缺货药**不静默替换**，
 * 而是标注缺货并给出受治理替代候选（判据见 src/lib/drug-inventory.server.ts 顶部）。
 *
 * 本路由在 src/proxy.ts 的 /api/:path* matcher 覆盖内，鉴权与限流沿用既有链路。
 */

// 2 万条药品条目的 JSON 上限。按院内中药饮片 + 中成药常见规模留足余量，
// 超限明确回 413 并要求分批，而不是截断——截断会让被截掉的药全部变成「缺货」。
const MAX_BODY_BYTES = 8_000_000;

export async function POST(req: Request) {
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
    ? parsed.body as { source?: unknown; items?: unknown }
    : {};

  const result = await importDrugInventory(body);
  if (!result.ok) {
    return Response.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return Response.json({
    ...result.snapshot,
    // 归一不到与歧义的药名如实回报，供甲方补映射。静默吞掉会让这些药永远处于「缺货」，
    // 而甲方无从知道是自己没推还是我们没认出来。
    note: result.snapshot.unresolvedNames.length > 0 || result.snapshot.ambiguousNames.length > 0
      ? "部分院内药名未能归一到受治理正名（unresolvedNames）或存在多个候选（ambiguousNames）。"
        + "系统不会替这些名字自动择一；它们不参与正名级匹配，请补充映射后重新导入。"
      : undefined,
  });
}

export async function GET() {
  const snapshot = await drugInventorySnapshot();
  if (!snapshot) {
    return Response.json({
      inventoryLoaded: false,
      // 未导入不是错误状态：可得性不是安全控制，缺库存数据时链路行为与导入前完全一致。
      note: "尚未导入院内库存。当前所有药味的可得性标为 unknown，开方链路行为与未接库存时一致。",
    });
  }
  return Response.json({ inventoryLoaded: true, ...snapshot });
}

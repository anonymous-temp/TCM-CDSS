import {
  buildDrugCatalogPage,
  drugCatalogSummary,
  DRUG_CATALOG_DEFAULT_LIMIT,
  DRUG_CATALOG_TYPES,
  isDrugCatalogType,
} from "@/lib/drug-catalog";

/**
 * 药品目录同步（甲方 2026-08-05「药品同步接口：缺少此接口」）。
 *
 * 出站分页下发本系统据以做临床判断的受治理药品目录，供 HIS 与院内目录对账。
 * 入站方向（HIS 推送院内目录）未实现且不是遗漏——原因见 src/lib/drug-catalog.ts 顶部注释，
 * 出参里也随每页带 inboundSyncStatus 说明，避免集成方误以为推送会被接收。
 *
 * 本路由在 src/proxy.ts 的 /api/:path* matcher 覆盖内，鉴权与限流沿用既有链路。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawType = url.searchParams.get("type");

  // 不带 type 时返回目录概览（各类型条目数 + 版本），供集成方决定拉哪几类、是否需要重拉。
  if (!rawType) return Response.json(drugCatalogSummary());

  if (!isDrugCatalogType(rawType)) {
    return Response.json({
      error: `unsupported catalog type: ${rawType}`,
      code: "unsupported_catalog_type",
      supported: DRUG_CATALOG_TYPES,
    }, { status: 400 });
  }

  const rawCursor = Number(url.searchParams.get("cursor"));
  const rawLimit = Number(url.searchParams.get("limit"));
  const page = buildDrugCatalogPage(
    rawType,
    Number.isFinite(rawCursor) ? Math.trunc(rawCursor) : 0,
    Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : DRUG_CATALOG_DEFAULT_LIMIT,
  );

  // since 命中即代表目录未变，回 304 让集成方跳过整轮拉取；目录版本本身仍在响应头里。
  const since = url.searchParams.get("since");
  if (since && since === page.catalogVersion) {
    return new Response(null, {
      status: 304,
      headers: { "x-cdss-catalog-version": page.catalogVersion },
    });
  }

  return Response.json(page, {
    headers: { "x-cdss-catalog-version": page.catalogVersion },
  });
}

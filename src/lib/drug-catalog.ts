import patentIndex from "../data/local-patent-medicine-index.json";
import herbIdentityCatalog from "../data/tcm-herb-identity-catalog.json";
import {
  getTcmHerbDoseLimit,
  getTcmKnowledgeStatus,
  listHisSpecConversions,
  listHisTcmMappings,
  listKnowledgeHerbNames,
} from "./tcm-knowledge";

/**
 * 药品目录同步（甲方 2026-08-05 核对件「药品同步接口：缺少此接口」）。
 *
 * **方向说明（这条必须写清楚，否则会被误解成功能缺失）**：本模块实现的是**出站**——
 * 把本系统据以做临床判断的受治理药品目录（饮片正名与别名、药典剂量边界、中成药说明书条目、
 * HIS 商品名映射与规格换算）分页下发，供 HIS 与院内目录做对账。
 *
 * **入站**（HIS 把院内库存推给本系统，开方时基于有货的药开）由
 * `POST /api/drug-inventory` + `src/lib/drug-inventory.server.ts` 承担，落盘在
 * compose 已挂载的 runtime 卷上。两个方向不要混用：本模块回答「系统认识哪些药」，
 * 库存模块回答「本院此刻有哪些药」。
 *
 * 同步语义：catalogVersion 变化即代表目录内容可能变化，HIS 据此决定是否全量重拉。
 * 它由三份受治理资产的版本标识组合而成，任一份重建都会改变该值。
 */

export type DrugCatalogType = "herb" | "patent" | "his_mapping" | "spec_conversion";

export const DRUG_CATALOG_TYPES: readonly DrugCatalogType[] = [
  "herb",
  "patent",
  "his_mapping",
  "spec_conversion",
];

export const DRUG_CATALOG_MAX_LIMIT = 500;
export const DRUG_CATALOG_DEFAULT_LIMIT = 100;

export function isDrugCatalogType(value: unknown): value is DrugCatalogType {
  return typeof value === "string" && (DRUG_CATALOG_TYPES as readonly string[]).includes(value);
}

/**
 * 目录版本。三份资产各出一段：知识库构建时间、饮片身份目录 schema、中成药索引源文件哈希。
 * 任一份重建都会改变该串，HIS 只需比对字符串是否相同，不必理解内部结构。
 */
export function drugCatalogVersion(): string {
  const status = getTcmKnowledgeStatus();
  const identityVersion = (herbIdentityCatalog as { schemaVersion?: string }).schemaVersion || "unknown";
  const patentDigest = String((patentIndex as { sourceSha256?: string }).sourceSha256 || "unknown").slice(0, 16);
  return [
    `kb:${status.schemaVersion}@${status.generatedAt}`,
    `identity:${identityVersion}`,
    `patent:${patentDigest}`,
  ].join("|");
}

type PatentEntry = {
  name?: unknown;
  specification?: unknown;
  approvalNumber?: unknown;
  manufacturer?: unknown;
  category?: unknown;
  indication?: unknown;
  usage?: unknown;
  contraindication?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type ResolutionEntry = {
  canonicalName?: string | null;
  status?: string;
  candidates?: string[];
  autoResolvable?: boolean;
};

function herbItems(): Array<Record<string, unknown>> {
  const resolutionIndex = (herbIdentityCatalog as unknown as {
    resolutionIndex?: Record<string, ResolutionEntry>;
  }).resolutionIndex || {};
  const aliasesByCanonical = new Map<string, string[]>();
  const ambiguousByCandidate = new Map<string, string[]>();
  for (const [alias, entry] of Object.entries(resolutionIndex)) {
    const canonical = typeof entry?.canonicalName === "string" ? entry.canonicalName : "";
    if (canonical) {
      if (alias === canonical) continue;
      const bucket = aliasesByCanonical.get(canonical);
      if (bucket) bucket.push(alias);
      else aliasesByCanonical.set(canonical, [alias]);
      continue;
    }
    // 歧义别名（499 条，如「一包针」→ 千年健 / 石韦）**绝不自动择一**：挂到每个候选名下，
    // 并在出参里标明它是歧义项。压平成某一个正名等于替医生做了身份裁定。
    for (const candidate of entry?.candidates || []) {
      const bucket = ambiguousByCandidate.get(candidate);
      if (bucket) bucket.push(alias);
      else ambiguousByCandidate.set(candidate, [alias]);
    }
  }
  return listKnowledgeHerbNames().map((name) => {
    const doseLimit = getTcmHerbDoseLimit(name);
    return {
      name,
      aliases: (aliasesByCanonical.get(name) || []).sort().slice(0, 20),
      ambiguousAliases: (ambiguousByCandidate.get(name) || []).sort().slice(0, 20),
      // 剂量边界如实标注来源冲突：存在分用途冲突时不给数值，避免 HIS 把保守主范围当成唯一合法区间。
      doseLimit: doseLimit && !doseLimit.sourceConflict && typeof doseLimit.min === "number"
        ? { min: doseLimit.min, max: doseLimit.max ?? null, basis: doseLimit.basis || "" }
        : null,
      doseLimitStatus: !doseLimit
        ? "not_governed"
        : doseLimit.sourceConflict
          ? "source_conflict_requires_pharmacist_review"
          : "governed",
    };
  });
}

function patentItems(): Array<Record<string, unknown>> {
  const entries = (patentIndex as { entries?: PatentEntry[] }).entries || [];
  return entries.map((entry) => ({
    name: text(entry.name),
    specification: text(entry.specification),
    approvalNumber: text(entry.approvalNumber),
    manufacturer: text(entry.manufacturer),
    category: text(entry.category),
    indication: text(entry.indication),
    usage: text(entry.usage),
    contraindication: text(entry.contraindication),
  })).filter((entry) => entry.name);
}

function hisMappingItems(): Array<Record<string, unknown>> {
  // status / conversionStatus 一律**原样保留**：AUTO_PARSED_NEEDS_REVIEW 与 P1-需补表/复核
  // 是「这条尚未人工确认」的标记，压平成布尔或省略掉，等于把待复核条目伪装成已确认条目。
  return listHisTcmMappings().map((item) => ({ ...item }));
}

function specConversionItems(): Array<Record<string, unknown>> {
  return listHisSpecConversions().map((item) => ({ ...item }));
}

const ITEM_BUILDERS: Record<DrugCatalogType, () => Array<Record<string, unknown>>> = {
  herb: herbItems,
  patent: patentItems,
  his_mapping: hisMappingItems,
  spec_conversion: specConversionItems,
};

export type DrugCatalogPage = {
  catalogVersion: string;
  type: DrugCatalogType;
  total: number;
  cursor: number;
  nextCursor: number | null;
  items: Array<Record<string, unknown>>;
  /** 入站方向的对接入口，随每页下发，避免集成方以为只有出站。 */
  inboundSyncEndpoint: "POST /api/drug-inventory";
};

export function buildDrugCatalogPage(
  type: DrugCatalogType,
  cursor = 0,
  limit = DRUG_CATALOG_DEFAULT_LIMIT,
): DrugCatalogPage {
  const items = ITEM_BUILDERS[type]();
  const safeCursor = Number.isInteger(cursor) && cursor > 0 ? Math.min(cursor, items.length) : 0;
  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), DRUG_CATALOG_MAX_LIMIT)
    : DRUG_CATALOG_DEFAULT_LIMIT;
  const page = items.slice(safeCursor, safeCursor + safeLimit);
  const nextCursor = safeCursor + page.length;
  return {
    catalogVersion: drugCatalogVersion(),
    type,
    total: items.length,
    cursor: safeCursor,
    nextCursor: nextCursor < items.length ? nextCursor : null,
    items: page,
    inboundSyncEndpoint: "POST /api/drug-inventory",
  };
}

export function drugCatalogSummary(): {
  catalogVersion: string;
  types: Array<{ type: DrugCatalogType; total: number }>;
  inboundSyncEndpoint: DrugCatalogPage["inboundSyncEndpoint"];
} {
  return {
    catalogVersion: drugCatalogVersion(),
    types: DRUG_CATALOG_TYPES.map((type) => ({ type, total: ITEM_BUILDERS[type]().length })),
    inboundSyncEndpoint: "POST /api/drug-inventory",
  };
}

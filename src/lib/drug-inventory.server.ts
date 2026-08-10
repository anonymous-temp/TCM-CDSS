import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { governedHerbSubstitutes, isKnownTcmHerbName, type GovernedHerbSubstitute } from "./tcm-knowledge";

/**
 * 院内药品库存（甲方 2026-08-05「药品同步接口」的**入站**方向）。
 *
 * 需求原文：甲方把客户（医院）的库存药导进来，开方时基于库存有的药来开。
 *
 * ## 一条不可让步的原则：库存是**可得性**约束，不是**临床正确性**约束
 *
 * 缺货绝不静默改方。这与甲方自己对味数的口径完全一致——
 * 「味数控制只是建议，如诊疗必须也不能裁剪，如经方不能裁剪、必须加药味不能裁剪」。
 * 库存同理：本例该用麻黄汤，院内恰好没有麻黄，正确做法是**如实告诉医生「本方需要麻黄，
 * 院内暂无库存」并给出受治理替代候选**，而不是悄悄换一味药、让医生以为这就是系统推荐的方。
 * 静默替换在临床上比缺货危险得多：医生看到的方与系统推理的方不是同一个。
 *
 * 因此本模块只做三件事：标注可得性、在生成前把「院内有货」的药味清单作为**软偏好**
 * 交给模型、对缺货药附上同向替代候选。任何一处都不改动已签名的临床结论。
 *
 * ## 未导入库存时的行为
 *
 * 全部标为 unknown，链路行为与导入前**逐字节相同**。可得性不是安全控制，
 * 「没有库存数据」绝不能升级成「不给出方案」——那会让未接库存的院区直接不可用。
 *
 * ## 持久化
 *
 * 本系统按设计没有数据库。落盘沿用 CONTROLLED_TERMINOLOGY_CACHE_PATH 的既有形态：
 * 环境变量 `CDSS_DRUG_INVENTORY_PATH` 指定路径，生产走 compose 已挂载的
 * `tcm-cdss-runtime:/app/runtime-data` 卷，因此重启与重新部署都不会丢。
 * 写入走「临时文件 + rename」原子替换，避免半截文件在并发读时被解析成空库存
 * ——空库存会让整院所有药味变成「缺货」，是比写失败严重得多的故障。
 */

export type DrugInventoryItemKind = "herb" | "patent";

export type DrugInventoryItem = {
  /** 院内药品名（原样保留，用于回显与对账）。 */
  name: string;
  kind: DrugInventoryItemKind;
  /** 归一到受治理正名；归一不到时为空串，该条只能按原名精确匹配。 */
  canonicalName: string;
  available: boolean;
  specification?: string;
  goodsId?: string;
};

export type DrugInventorySnapshot = {
  inventoryVersion: string;
  importedAt: string;
  source: string;
  itemCount: number;
  availableHerbCount: number;
  availablePatentCount: number;
  /** 归一不到受治理正名的院内药名，如实回报供甲方补映射，不静默丢弃。 */
  unresolvedNames: string[];
  /** 归一后存在多个候选、系统拒绝自动择一的院内药名。 */
  ambiguousNames: string[];
};

type InventoryFile = DrugInventorySnapshot & { items: DrugInventoryItem[] };

const MAX_ITEMS = 20_000;
const MAX_UNRESOLVED_REPORTED = 200;

let cache: InventoryFile | null = null;
let cacheLoaded = false;

export function drugInventoryPath(): string {
  const configured = process.env.CDSS_DRUG_INVENTORY_PATH?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), "artifacts/runtime/drug-inventory.json");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 测试用：清掉进程内缓存，强制下次从磁盘重读。 */
export function resetDrugInventoryCacheForTests(): void {
  cache = null;
  cacheLoaded = false;
}

async function load(): Promise<InventoryFile | null> {
  if (cacheLoaded) return cache;
  cacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(drugInventoryPath(), "utf8")) as Partial<InventoryFile>;
    if (!Array.isArray(parsed.items) || typeof parsed.inventoryVersion !== "string") {
      cache = null;
      return cache;
    }
    cache = {
      inventoryVersion: parsed.inventoryVersion,
      importedAt: text(parsed.importedAt),
      source: text(parsed.source),
      itemCount: parsed.items.length,
      availableHerbCount: parsed.items.filter((item) => item.kind === "herb" && item.available).length,
      availablePatentCount: parsed.items.filter((item) => item.kind === "patent" && item.available).length,
      unresolvedNames: Array.isArray(parsed.unresolvedNames) ? parsed.unresolvedNames : [],
      ambiguousNames: Array.isArray(parsed.ambiguousNames) ? parsed.ambiguousNames : [],
      items: parsed.items,
    };
  } catch {
    // 文件不存在 / 解析失败一律当作「未导入库存」，绝不抛错阻断开方链路。
    cache = null;
  }
  return cache;
}

export type DrugInventoryImportInput = {
  source?: unknown;
  items?: unknown;
  /**
   * 分片整批替换。**要么全到齐、要么一条不落地**：分片只写暂存，集齐 total 片后才做一次
   * 原子替换。没有 part 时行为与此前逐字节相同（单次整批替换）。
   */
  part?: unknown;
};

export type DrugInventoryImportResult =
  | { ok: true; snapshot: DrugInventorySnapshot }
  | { ok: true; pending: DrugInventoryPartAck }
  | { ok: false; status: 400 | 409 | 413; code: string; error: string };

export type DrugInventoryPartAck = {
  importId: string;
  receivedParts: number[];
  missingParts: number[];
  total: number;
  bufferedItemCount: number;
  committed: false;
};

type StagedImport = {
  importId: string;
  total: number;
  source: string;
  startedAt: string;
  parts: Record<string, unknown[]>;
};

const MAX_IMPORT_PARTS = 50;
const STAGED_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

function stagedImportPath(importId: string): string {
  const target = drugInventoryPath();
  return `${target}.staging-${importId}.json`;
}

function normalizedImportId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{6,64}$/.test(raw) ? raw : "";
}

async function readStagedImport(importId: string): Promise<StagedImport | null> {
  try {
    const parsed = JSON.parse(await readFile(stagedImportPath(importId), "utf8")) as Partial<StagedImport>;
    if (parsed.importId !== importId || !parsed.parts || typeof parsed.parts !== "object") return null;
    const startedAt = Date.parse(String(parsed.startedAt || ""));
    // 过期暂存一律当作不存在：一份半年前没传完的分片不该在今天被接上去当成完整库存。
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > STAGED_IMPORT_TTL_MS) return null;
    return {
      importId,
      total: Number(parsed.total) || 0,
      source: text(parsed.source),
      startedAt: String(parsed.startedAt),
      parts: parsed.parts as Record<string, unknown[]>,
    };
  } catch {
    return null;
  }
}

async function writeStagedImport(staged: StagedImport): Promise<void> {
  const target = stagedImportPath(staged.importId);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(staged), "utf8");
  await rename(tmp, target);
}

/**
 * 导入院内库存。整批替换，不做增量合并——增量语义要求甲方侧维护删除事件，
 * 而「某药已下架却没推删除」会让系统长期以为它有货，比整批替换危险。
 *
 * ## 超限时的正确做法（甲方 2026-08-10 ⑫④）
 *
 * 此前超限返回的文案是 `split the import into batches`，而落盘是 :203 的原子 rename
 * **整批替换**——实测第 1 批 4 味、第 2 批 3 味，落盘只剩第 2 批 3 味。
 * **系统自己在 413 里教对方把第一批药删光。**
 *
 * 现在「分批」是一条真实存在、且安全的通路：带 `part` 的请求只写暂存，
 * 集齐 total 片后才做一次整批替换；缺片时返回 409 并列出缺哪几片，
 * 在此之前线上库存一个字节都不动。语义仍然是「整批替换」，只是这一整批分了几次传。
 */
export async function importDrugInventory(input: DrugInventoryImportInput): Promise<DrugInventoryImportResult> {
  const rawItems = input.items;
  if (!Array.isArray(rawItems)) {
    return { ok: false, status: 400, code: "invalid_inventory_items", error: "items must be an array" };
  }
  const partInput = input.part && typeof input.part === "object" && !Array.isArray(input.part)
    ? input.part as Record<string, unknown>
    : undefined;
  if (partInput) {
    const staged = await stageInventoryPart(partInput, rawItems, text(input.source));
    if (!staged.ok || "pending" in staged) return staged;
    return commitInventoryItems(staged.items, staged.source);
  }
  if (rawItems.length > MAX_ITEMS) {
    return {
      ok: false,
      status: 413,
      code: "inventory_too_large",
      error: `items exceeds the ${MAX_ITEMS} entry limit. 本接口是整批替换：单次请求直接分成两批会让后一批覆盖前一批。`
        + ` 请改用分片整批替换——每次请求带 part={importId,index,total}（同一 importId、index 从 0 到 total-1）；`
        + ` 分片只写暂存，集齐全部分片后系统才做一次原子替换，在此之前线上库存不变。`,
    };
  }

  return commitInventoryItems(rawItems, text(input.source));
}

async function stageInventoryPart(
  partInput: Record<string, unknown>,
  rawItems: unknown[],
  source: string,
): Promise<{ ok: true; items: unknown[]; source: string } | { ok: true; pending: DrugInventoryPartAck } | { ok: false; status: 400 | 409 | 413; code: string; error: string }> {
  const importId = normalizedImportId(partInput.importId);
  const index = Number(partInput.index);
  const total = Number(partInput.total);
  if (!importId) {
    return { ok: false, status: 400, code: "invalid_import_part_id", error: "part.importId must match [A-Za-z0-9_-]{6,64}" };
  }
  if (!Number.isInteger(total) || total < 1 || total > MAX_IMPORT_PARTS) {
    return { ok: false, status: 400, code: "invalid_import_part_total", error: `part.total must be an integer in 1..${MAX_IMPORT_PARTS}` };
  }
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return { ok: false, status: 400, code: "invalid_import_part_index", error: "part.index must be an integer in 0..total-1" };
  }
  const existing = await readStagedImport(importId);
  if (existing && existing.total !== total) {
    return { ok: false, status: 409, code: "import_part_total_conflict", error: `part.total changed mid-import (was ${existing.total})` };
  }
  const staged: StagedImport = existing || {
    importId,
    total,
    source,
    startedAt: new Date().toISOString(),
    parts: {},
  };
  staged.parts[String(index)] = rawItems;
  if (source) staged.source = source;
  const bufferedItemCount = Object.values(staged.parts).reduce((sum, part) => sum + part.length, 0);
  if (bufferedItemCount > MAX_ITEMS) {
    return {
      ok: false,
      status: 413,
      code: "inventory_too_large",
      error: `accumulated items across parts exceeds the ${MAX_ITEMS} entry limit; nothing was written`,
    };
  }
  await writeStagedImport(staged);
  const receivedParts = Object.keys(staged.parts).map(Number).sort((left, right) => left - right);
  const missingParts = Array.from({ length: total }, (_, position) => position)
    .filter((position) => !receivedParts.includes(position));
  if (missingParts.length > 0) {
    // 缺片就是没到齐，线上库存一个字节都不动——「半批替换」正是本条缺陷的危害本身。
    return { ok: true, pending: { importId, receivedParts, missingParts, total, bufferedItemCount, committed: false } };
  }
  const items = receivedParts.flatMap((position) => staged.parts[String(position)]);
  await rm(stagedImportPath(importId), { force: true }).catch(() => undefined);
  return { ok: true, items, source: staged.source };
}

async function commitInventoryItems(rawItems: unknown[], source: string): Promise<DrugInventoryImportResult> {
  const items: DrugInventoryItem[] = [];
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  const seen = new Set<string>();

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = text(entry.name);
    if (!name || name.length > 120) continue;
    const kind: DrugInventoryItemKind = entry.kind === "patent" ? "patent" : "herb";
    // available 缺省为 true：甲方推过来的就是院内在售目录，缺字段不应被当成缺货。
    const available = entry.available === undefined ? true : entry.available === true;
    const dedupeKey = `${kind}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let canonicalName = "";
    if (kind === "herb") {
      const identity = resolveGovernedTcmHerbIdentity(name);
      if (identity.status === "ambiguous") {
        // 歧义药名**绝不自动择一**（一包针 → 千年健/石韦）。该条按原名保留，
        // 不参与正名级匹配，并如实回报给甲方补映射。
        ambiguous.add(name);
      } else {
        canonicalName = identity.doseCanonicalName || identity.canonicalName || "";
        if (!canonicalName || !isKnownTcmHerbName(canonicalName)) {
          canonicalName = "";
          unresolved.add(name);
        }
      }
    }

    items.push({
      name,
      kind,
      canonicalName,
      available,
      ...(text(entry.specification) ? { specification: text(entry.specification) } : {}),
      ...(text(entry.goodsId) ? { goodsId: text(entry.goodsId) } : {}),
    });
  }

  const importedAt = new Date().toISOString();
  const inventoryVersion = createHash("sha256")
    .update(items.map((item) => `${item.kind}:${item.name}:${item.canonicalName}:${item.available}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 32);

  const file: InventoryFile = {
    inventoryVersion,
    importedAt,
    source: source || "unspecified",
    itemCount: items.length,
    availableHerbCount: items.filter((item) => item.kind === "herb" && item.available).length,
    availablePatentCount: items.filter((item) => item.kind === "patent" && item.available).length,
    unresolvedNames: [...unresolved].sort().slice(0, MAX_UNRESOLVED_REPORTED),
    ambiguousNames: [...ambiguous].sort().slice(0, MAX_UNRESOLVED_REPORTED),
    items,
  };

  const target = drugInventoryPath();
  await mkdir(dirname(target), { recursive: true });
  // 原子替换：半截文件被读成空库存会让整院所有药味变「缺货」，后果远重于一次写失败。
  const staging = `${target}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(file), "utf8");
  await rename(staging, target);

  cache = file;
  cacheLoaded = true;
  const { items: _items, ...snapshot } = file;
  void _items;
  return { ok: true, snapshot };
}

export async function drugInventorySnapshot(): Promise<DrugInventorySnapshot | null> {
  const file = await load();
  if (!file) return null;
  const { items: _items, ...snapshot } = file;
  void _items;
  return snapshot;
}

export type HerbAvailability = "in_stock" | "out_of_stock" | "unknown";

export type HerbAvailabilityView = {
  /** 未导入库存时为 false —— 调用方据此完全跳过可得性呈现。 */
  inventoryLoaded: boolean;
  inventoryVersion: string;
  availableHerbNames: readonly string[];
  statusOf: (herb: string) => HerbAvailability;
};

const EMPTY_VIEW: HerbAvailabilityView = {
  inventoryLoaded: false,
  inventoryVersion: "",
  availableHerbNames: [],
  statusOf: () => "unknown",
};

export async function herbAvailabilityView(): Promise<HerbAvailabilityView> {
  const file = await load();
  if (!file) return EMPTY_VIEW;
  const availableCanonical = new Set<string>();
  const availableRaw = new Set<string>();
  const knownCanonical = new Set<string>();
  const knownRaw = new Set<string>();
  for (const item of file.items) {
    if (item.kind !== "herb") continue;
    if (item.canonicalName) knownCanonical.add(item.canonicalName);
    knownRaw.add(item.name);
    if (!item.available) continue;
    if (item.canonicalName) availableCanonical.add(item.canonicalName);
    availableRaw.add(item.name);
  }
  return {
    inventoryLoaded: true,
    inventoryVersion: file.inventoryVersion,
    availableHerbNames: [...availableCanonical].sort(),
    statusOf(herb: string): HerbAvailability {
      const raw = text(herb);
      if (!raw) return "unknown";
      if (availableRaw.has(raw)) return "in_stock";
      const identity = resolveGovernedTcmHerbIdentity(raw);
      const canonical = identity.doseCanonicalName || identity.canonicalName || "";
      if (canonical && availableCanonical.has(canonical)) return "in_stock";
      // 只有当这味药**确实出现在院内目录里且标记为不可用**、或目录里根本没有它时，
      // 才判缺货。归一不到正名的院内条目不参与判定，避免把「我们没认出这个名字」
      // 说成「医院没有这个药」。
      if (knownRaw.has(raw) || (canonical && knownCanonical.has(canonical))) return "out_of_stock";
      return "out_of_stock";
    },
  };
}

/** 提示词里最多列出的院内有货药味数。院内中药饮片常规在 300–500 味，600 足够覆盖且不撑爆上下文。 */
const PROMPT_SHORTLIST_LIMIT = 600;

/**
 * 生成前注入的院内库存上下文——**软偏好，不是硬门禁**。
 *
 * 措辞刻意留了出口：临床必须用清单外药味时照常开出并说明。
 * 若写成「只能从清单里选」，遇到院内没有麻黄的风寒表实证，模型就会去凑一个次优方，
 * 而医生看不出这是被库存扭曲过的推荐——那比直接告诉他「本方需要麻黄、院内暂无」危险得多。
 */
export async function buildDrugInventoryPromptContext(): Promise<string> {
  const view = await herbAvailabilityView();
  if (!view.inventoryLoaded || view.availableHerbNames.length === 0) return "";
  const listed = view.availableHerbNames.slice(0, PROMPT_SHORTLIST_LIMIT);
  const truncated = view.availableHerbNames.length > listed.length;
  return [
    "【院内库存可得性】以下为本院当前有货的中药饮片（受治理正名）：",
    listed.join("、"),
    truncated
      ? `（清单已截断，院内共 ${view.availableHerbNames.length} 味有货；未列出不代表无货。）`
      : "",
    "选药时**优先**落在上述清单内的药味。但这是可得性偏好，不是临床约束："
    + "若本例证治必须使用清单外药味（经方核心药味、安全必需药味尤其如此），照常开出，"
    + "不得为迁就库存而牺牲方证对应或删减经方核心组成。系统会在方案中另行标注缺货药味并给出替代候选。",
  ].filter(Boolean).join("\n");
}

export type OutOfStockHerbAdvice = {
  herb: string;
  availability: HerbAvailability;
  substitutes: GovernedHerbSubstitute[];
};

/**
 * 缺货药味的替代建议。替代候选先过 governedHerbSubstitutes 的全部安全边界
 * （同最具体功效分类、风险不得升级、药典剂量边界、十八反十九畏、管制毒性排除），
 * **再**按库存过滤——顺序不能反：先按库存挑再谈安全，等于让库存决定临床安全边界。
 */
export type DrugAvailabilityProjection = {
  inventory: {
    loaded: boolean;
    inventoryVersion: string;
    /** 库存**不进已签名的临床合同**：它每天都在变，进合同会让昨天签发的方案今天验签失败。 */
    note: string;
  };
  herbAvailability: Array<{ name: string; availability: HerbAvailability }>;
  outOfStock: OutOfStockHerbAdvice[];
};

/**
 * 给 HIS 方案附加库存可得性。**只标注，不改方**——处方内容与已签名结论逐字不变。
 */
export async function drugAvailabilityProjection(
  structuredHerbs: ReadonlyArray<{ name?: unknown }>,
): Promise<DrugAvailabilityProjection> {
  const view = await herbAvailabilityView();
  const names = structuredHerbs
    .map((herb) => text(herb?.name))
    .filter(Boolean);
  if (!view.inventoryLoaded) {
    return {
      inventory: {
        loaded: false,
        inventoryVersion: "",
        note: "尚未导入院内库存，全部药味可得性为 unknown；处方生成与展示行为与未接库存时一致。",
      },
      herbAvailability: names.map((name) => ({ name, availability: "unknown" as const })),
      outOfStock: [],
    };
  }
  return {
    inventory: {
      loaded: true,
      inventoryVersion: view.inventoryVersion,
      note: "可得性为院内库存标注，不参与临床合同签名；缺货药味未从处方中删除，替代候选仅供医师选择。",
    },
    herbAvailability: names.map((name) => ({ name, availability: view.statusOf(name) })),
    outOfStock: await outOfStockAdvice(names),
  };
}

export async function outOfStockAdvice(
  prescriptionHerbs: readonly string[],
): Promise<OutOfStockHerbAdvice[]> {
  const view = await herbAvailabilityView();
  if (!view.inventoryLoaded) return [];
  const advice: OutOfStockHerbAdvice[] = [];
  for (const herb of prescriptionHerbs) {
    const availability = view.statusOf(herb);
    if (availability !== "out_of_stock") continue;
    const substitutes = governedHerbSubstitutes(herb, prescriptionHerbs, 6)
      .filter((item) => view.statusOf(item.substitute) === "in_stock")
      .slice(0, 2);
    advice.push({ herb, availability, substitutes });
  }
  return advice;
}

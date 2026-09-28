import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseCustomerId } from "./customer-id";
import { withSerializedLock } from "./serialized-lock";
import {
  inventoryAvailableFromInput,
  inventoryKindFromInput,
  medicineBaseKey,
  medicineNameKey,
  resolveInventoryHerbName,
  type DrugInventoryItemKind,
  type InventoryItemForm,
} from "./drug-inventory-names";
import { governedHerbSubstitutes, type GovernedHerbSubstitute } from "./tcm-knowledge";

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

export type { DrugInventoryItemKind } from "./drug-inventory-names";
export const DRUG_INVENTORY_KINDS: readonly DrugInventoryItemKind[] = ["herb", "patent", "western"];

/**
 * 每一类药的同步状态（2026-09-28）。「没同步」和「缺货」是两回事：只同步了饮片的诊所，
 * 中成药/西药此前一律判「不在库存里」并被规划器删掉——生产 105 份库存里 100 份只有饮片。
 * - synced：本类已同步；
 * - declared_none：调用方用 `kinds` 声明了本类、但条目为 0，即「本院没有这一类药」；
 * - 缺省（不在 coverage 里）：本类没同步过。
 */
export type DrugInventoryKindCoverage = "synced" | "declared_none";
export type DrugInventoryCoverage = Partial<Record<DrugInventoryItemKind, DrugInventoryKindCoverage>>;

export type DrugInventoryItem = {
  /** 院内药品名（原样保留，用于回显与对账）。 */
  name: string;
  kind: DrugInventoryItemKind;
  /** 归一到受治理正名；归一不到时为空串，该条只能按原名精确匹配。 */
  canonicalName: string;
  available: boolean;
  specification?: string;
  goodsId?: string;
  /** 院内剂型：粉剂（三七粉）、配方颗粒。只用于标注，不改变匹配。 */
  form?: InventoryItemForm;
};

export const DRUG_INVENTORY_SCHEMA_VERSION = "tcm-cdss-drug-inventory-v2" as const;

export type DrugInventorySnapshot = {
  schemaVersion: typeof DRUG_INVENTORY_SCHEMA_VERSION;
  customerId: string;
  inventoryVersion: string;
  importedAt: string;
  source: string;
  itemCount: number;
  availableHerbCount: number;
  availablePatentCount: number;
  availableWesternCount: number;
  /** 归一不到受治理正名的院内药名，如实回报供甲方补映射，不静默丢弃。 */
  unresolvedNames: string[];
  /** 归一后存在多个候选、系统拒绝自动择一的院内药名。 */
  ambiguousNames: string[];
  /** 各类药的同步状态；旧文件没有这一栏时按「有没有这一类条目」推出。 */
  coverage: DrugInventoryCoverage;
  /** 疑似测试或编号条目（「测试中药75601669」「砒霜0631」），供甲方清理。 */
  suspectNames?: string[];
  /** 名字像中成药/西药却按饮片推送的条目（多半是 kind 漏填缺省成了饮片）。 */
  likelyNonHerbNames?: string[];
};

type InventoryFile = DrugInventorySnapshot & { items: DrugInventoryItem[] };

const MAX_ITEMS = 20_000;
const MAX_UNRESOLVED_REPORTED = 200;
export const DRUG_INVENTORY_CACHE_MAX_CUSTOMERS = 500;
export const DRUG_INVENTORY_CACHE_IDLE_TTL_MS = 30 * 60 * 1_000;

type InventoryCacheEntry = {
  value: InventoryFile | null;
  lastAccessedAt: number;
};

const cacheByCustomer = new Map<string, InventoryCacheEntry>();
const inventoryCommitLocks = new Map<string, Promise<void>>();
const stagedImportLocks = new Map<string, Promise<void>>();

function validCustomerId(customerId: string): string {
  const valid = parseCustomerId(customerId);
  if (!valid) throw new Error("invalid customerId for drug inventory");
  return valid;
}

export function drugInventoryPath(customerIdInput: string): string {
  const customerId = validCustomerId(customerIdInput);
  const configured = process.env.CDSS_DRUG_INVENTORY_PATH?.trim();
  const root = configured
    ? resolve(configured.endsWith(".json") ? `${configured}.d` : configured)
    : resolve(process.cwd(), "artifacts/runtime/drug-inventory");
  const customerHash = createHash("sha256").update(customerId).digest("hex").slice(0, 32);
  return resolve(root, `${customerHash}.json`);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 测试用：清掉进程内缓存，强制下次从磁盘重读。 */
export function resetDrugInventoryCacheForTests(customerId?: string): void {
  if (customerId) {
    cacheByCustomer.delete(validCustomerId(customerId));
    return;
  }
  cacheByCustomer.clear();
}

export function drugInventoryCacheSizeForTests(): number {
  return cacheByCustomer.size;
}

export function isDrugInventoryCustomerCachedForTests(customerId: string): boolean {
  return cacheByCustomer.has(validCustomerId(customerId));
}

function pruneInventoryCache(now: number): void {
  for (const [customerId, entry] of cacheByCustomer) {
    if (now - entry.lastAccessedAt > DRUG_INVENTORY_CACHE_IDLE_TTL_MS) {
      cacheByCustomer.delete(customerId);
    }
  }
}

function readInventoryCache(customerId: string): { hit: boolean; value: InventoryFile | null } {
  const now = Date.now();
  pruneInventoryCache(now);
  const entry = cacheByCustomer.get(customerId);
  if (!entry) return { hit: false, value: null };
  entry.lastAccessedAt = now;
  // Refresh Map insertion order so the first entry remains the least recently used one.
  cacheByCustomer.delete(customerId);
  cacheByCustomer.set(customerId, entry);
  return { hit: true, value: entry.value };
}

function writeInventoryCache(customerId: string, value: InventoryFile | null): void {
  const now = Date.now();
  pruneInventoryCache(now);
  cacheByCustomer.delete(customerId);
  while (cacheByCustomer.size >= DRUG_INVENTORY_CACHE_MAX_CUSTOMERS) {
    const oldestCustomerId = cacheByCustomer.keys().next().value as string | undefined;
    if (!oldestCustomerId) break;
    cacheByCustomer.delete(oldestCustomerId);
  }
  cacheByCustomer.set(customerId, { value, lastAccessedAt: now });
}

function withResolvedHerbName(item: DrugInventoryItem): DrugInventoryItem {
  const resolution = resolveInventoryHerbName(item.name);
  return {
    ...item,
    canonicalName: resolution.canonicalName,
    ...(resolution.form && !item.form ? { form: resolution.form } : {}),
  };
}

/** 对不上/歧义/疑似测试/疑似非饮片的院内药名，如实回报供甲方核对（各至多 200 条）。 */
function herbNameReport(items: readonly DrugInventoryItem[]): Pick<
  DrugInventorySnapshot,
  "unresolvedNames" | "ambiguousNames" | "suspectNames" | "likelyNonHerbNames"
> {
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  const suspect = new Set<string>();
  const likelyNonHerb = new Set<string>();
  for (const item of items) {
    if (item.kind !== "herb") continue;
    const resolution = resolveInventoryHerbName(item.name);
    if (resolution.status === "ambiguous") ambiguous.add(item.name);
    else if (!item.canonicalName) unresolved.add(item.name);
    if (resolution.suspect) suspect.add(item.name);
    if (resolution.likelyNotHerb) likelyNonHerb.add(item.name);
  }
  const capped = (values: Set<string>) => [...values].sort().slice(0, MAX_UNRESOLVED_REPORTED);
  return {
    unresolvedNames: capped(unresolved),
    ambiguousNames: capped(ambiguous),
    ...(suspect.size ? { suspectNames: capped(suspect) } : {}),
    ...(likelyNonHerb.size ? { likelyNonHerbNames: capped(likelyNonHerb) } : {}),
  };
}

function coverageFromItems(items: readonly DrugInventoryItem[]): DrugInventoryCoverage {
  const coverage: DrugInventoryCoverage = {};
  for (const item of items) coverage[item.kind] = "synced";
  return coverage;
}

function validCoverage(value: unknown): DrugInventoryCoverage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const coverage: DrugInventoryCoverage = {};
  for (const kind of DRUG_INVENTORY_KINDS) {
    const state = (value as Record<string, unknown>)[kind];
    if (state === "synced" || state === "declared_none") coverage[kind] = state;
  }
  return coverage;
}

async function load(customerIdInput: string): Promise<InventoryFile | null> {
  const customerId = validCustomerId(customerIdInput);
  const cached = readInventoryCache(customerId);
  if (cached.hit) return cached.value;
  try {
    const parsed = JSON.parse(await readFile(drugInventoryPath(customerId), "utf8")) as Partial<InventoryFile>;
    const fileCustomerId = parseCustomerId(parsed.customerId);
    if (parsed.schemaVersion !== DRUG_INVENTORY_SCHEMA_VERSION ||
        fileCustomerId !== customerId ||
        !Array.isArray(parsed.items) ||
        typeof parsed.inventoryVersion !== "string") {
      console.warn("drug_inventory_file_rejected", {
        customerHash: createHash("sha256").update(customerId).digest("hex").slice(0, 32),
        reason: parsed.schemaVersion !== DRUG_INVENTORY_SCHEMA_VERSION
          ? "invalid_schema"
          : fileCustomerId !== customerId
            ? "customer_mismatch"
            : "invalid_payload",
      });
      writeInventoryCache(customerId, null);
      return null;
    }
    // 旧文件导入时没有这层写法清洗：对不上正名的饮片在读入时按当前规则重算一次，已在线的
    // 库存不必甲方重推就能用上（生产 55 家诊所：63.0% → 约 80% 对得上）。
    const items = parsed.items.map((item) => item.kind === "herb" && !item.canonicalName
      ? withResolvedHerbName(item)
      : item);
    const loaded: InventoryFile = {
      schemaVersion: DRUG_INVENTORY_SCHEMA_VERSION,
      customerId,
      inventoryVersion: parsed.inventoryVersion,
      importedAt: text(parsed.importedAt),
      source: text(parsed.source),
      itemCount: items.length,
      availableHerbCount: items.filter((item) => item.kind === "herb" && item.available).length,
      availablePatentCount: items.filter((item) => item.kind === "patent" && item.available).length,
      availableWesternCount: items.filter((item) => item.kind === "western" && item.available).length,
      ...herbNameReport(items),
      coverage: validCoverage(parsed.coverage) || coverageFromItems(items),
      items,
    };
    writeInventoryCache(customerId, loaded);
    return loaded;
  } catch {
    // 文件不存在 / 解析失败一律当作「未导入库存」，绝不抛错阻断开方链路。
    writeInventoryCache(customerId, null);
    return null;
  }
}

export type DrugInventoryImportInput = {
  source?: unknown;
  items?: unknown;
  /**
   * 分片整批替换。**要么全到齐、要么一条不落地**：分片只写暂存，集齐 total 片后才做一次
   * 原子替换。没有 part 时行为与此前逐字节相同（单次整批替换）。
   */
  part?: unknown;
  /**
   * 本批负责哪几类药（2026-09-28）。给出时只替换这几类、其余类别原样保留；某类在本批里
   * 没有条目 = 声明本院没有这一类药。不给时整批替换（与此前相同）。
   */
  kinds?: unknown;
};

export type DrugInventoryRejectedEntry = { index: number; reason: string };

export type DrugInventoryImportResult =
  | { ok: true; snapshot: DrugInventorySnapshot }
  /** 不带 kinds 的空清单：不改动现有库存（snapshot 为当前库存，可能为 null）。 */
  | { ok: true; unchanged: true; snapshot: DrugInventorySnapshot | null }
  | { ok: true; pending: DrugInventoryPartAck }
  | {
      ok: false;
      status: 400 | 409 | 413;
      code: string;
      error: string;
      rejectedEntries?: DrugInventoryRejectedEntry[];
      rejectedEntryCount?: number;
    };

export type DrugInventoryPayloadRejection = Extract<DrugInventoryImportResult, { ok: false }> & {
  status: 400 | 413;
};

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
  kinds?: DrugInventoryItemKind[];
  startedAt: string;
  parts: Record<string, unknown[]>;
};

const MAX_IMPORT_PARTS = 50;
const STAGED_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;

function stagedImportPath(customerId: string, importId: string): string {
  const target = drugInventoryPath(customerId);
  return `${target}.staging-${importId}.json`;
}

function normalizedImportId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{6,64}$/.test(raw) ? raw : "";
}

async function readStagedImport(customerId: string, importId: string): Promise<StagedImport | null> {
  try {
    const parsed = JSON.parse(await readFile(stagedImportPath(customerId, importId), "utf8")) as Partial<StagedImport>;
    if (parsed.importId !== importId || !parsed.parts || typeof parsed.parts !== "object") return null;
    const startedAt = Date.parse(String(parsed.startedAt || ""));
    // 过期暂存一律当作不存在：一份半年前没传完的分片不该在今天被接上去当成完整库存。
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > STAGED_IMPORT_TTL_MS) return null;
    return {
      importId,
      total: Number(parsed.total) || 0,
      source: text(parsed.source),
      ...(Array.isArray(parsed.kinds)
        ? { kinds: DRUG_INVENTORY_KINDS.filter((kind) => (parsed.kinds as unknown[]).includes(kind)) }
        : {}),
      startedAt: String(parsed.startedAt),
      parts: parsed.parts as Record<string, unknown[]>,
    };
  } catch {
    return null;
  }
}

async function writeStagedImport(customerId: string, staged: StagedImport): Promise<void> {
  const target = stagedImportPath(customerId, staged.importId);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(staged), "utf8");
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
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
function inventoryEntryRejection(raw: unknown, kinds?: ReadonlySet<DrugInventoryItemKind>): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "entry must be an object";
  const entry = raw as Record<string, unknown>;
  const name = text(entry.name);
  if (!name) return "name is required";
  if (name.length > 120) return "name exceeds 120 characters";
  const kind = inventoryKindFromInput(entry.kind);
  if (!kind) {
    // kind 静默兜底成 herb 会把「中成药」当饮片建目录——可得性判定直接跟着错。
    // 2026-09-28 起接受常见中文写法（饮片/中药/中成药/西药/配方颗粒），其余仍整批拒收。
    return "kind must be one of herb|patent|western (or 饮片|中药|中成药|西药|配方颗粒)";
  }
  if (kinds && !kinds.has(kind.kind)) return `kind ${kind.kind} is outside the declared kinds of this batch`;
  if (inventoryAvailableFromInput(entry.available) === undefined) {
    // available:1 在旧实现里等于 false（=== true 比较），一个真值字段悄悄把在售药标成缺货。
    // 现在 1/0、Y/N、是/否、有货/缺货都按字面映射；其他写法（2、"maybe"）整批拒收。
    return "available must be a boolean, 1/0, Y/N or 是/否 when present";
  }
  return undefined;
}

/** `kinds` 的受控写法；缺省返回 undefined（整批替换）。写法不合法返回 "invalid"。 */
function parseInventoryKinds(value: unknown): Set<DrugInventoryItemKind> | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > DRUG_INVENTORY_KINDS.length * 4) return "invalid";
  const kinds = new Set<DrugInventoryItemKind>();
  for (const entry of value) {
    const kind = inventoryKindFromInput(entry);
    if (!kind || entry === undefined || entry === null || entry === "") return "invalid";
    kinds.add(kind.kind);
  }
  return kinds;
}

function importPartShapeRejection(partInput: Record<string, unknown>): DrugInventoryPayloadRejection | undefined {
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
  return undefined;
}

const MAX_REJECTED_ENTRIES_REPORTED = 20;

/**
 * 载荷内在校验（纯函数，不读任何状态）。**必须先于 JIT 客户登记执行**：甲方 2026-08-24
 * 验收（PROV-08）实测「未知客户 + 缺 items 的首次 POST」返回 400 后客户已被登记激活——
 * 失败的首提交留下了可正常 GET 的半激活租户。所有仅凭请求体即可判定的 4xx/413 都收敛到
 * 这里；路由在 requireCustomerContext（可能触发登记）之前先调用，importDrugInventory
 * 内部再调一次兜底，两处共用同一份判据。
 *
 * 条目级错误**整批拒绝**并回报 rejectedEntries，绝不静默丢弃：本文件的可得性语义下，
 * 被静默丢掉的条目等于把那些药推成缺货/unknown（缺数据不得改变链路行为），
 * 比整批失败危险得多。零条目载荷同理拒绝——见 commitInventoryItems 的零条目守卫。
 */
export function validateDrugInventoryPayload(input: DrugInventoryImportInput): DrugInventoryPayloadRejection | undefined {
  if (!Array.isArray(input.items)) {
    return { ok: false, status: 400, code: "invalid_inventory_items", error: "items must be an array" };
  }
  const rawItems = input.items as unknown[];
  const kinds = parseInventoryKinds(input.kinds);
  if (kinds === "invalid") {
    return {
      ok: false,
      status: 400,
      code: "invalid_inventory_kinds",
      error: "kinds must be a non-empty array of herb|patent|western (or 饮片|中药|中成药|西药|配方颗粒)",
    };
  }
  const partInput = input.part && typeof input.part === "object" && !Array.isArray(input.part)
    ? input.part as Record<string, unknown>
    : undefined;
  if (input.part !== undefined && input.part !== null && !partInput) {
    return { ok: false, status: 400, code: "invalid_import_part_id", error: "part must be an object of {importId,index,total}" };
  }
  // 空清单（2026-09-28 起不再报错）：
  // - 带 kinds：声明「本院没有这几类药」，只清这几类；
  // - 不带 kinds：不改动现有库存、返回 200 并说明——整批替换语义下，空清单字面意思是「清空全部」，
  //   HIS 故障时误推一个空清单就会让整院所有药变成库存外，所以这里宁可不动。
  // 分片请求的单片仍不接受空清单：分片只用于超大目录，一片为空多半是调用方切片出错。
  if (rawItems.length === 0 && partInput) {
    return {
      ok: false,
      status: 400,
      code: "invalid_inventory_items",
      error: "a part must carry at least one item",
    };
  }
  if (partInput) {
    const partRejection = importPartShapeRejection(partInput);
    if (partRejection) return partRejection;
  } else if (rawItems.length > MAX_ITEMS) {
    return {
      ok: false,
      status: 413,
      code: "inventory_too_large",
      error: `items exceeds the ${MAX_ITEMS} entry limit. 本接口是整批替换：单次请求直接分成两批会让后一批覆盖前一批。`
        + ` 请改用分片整批替换——每次请求带 part={importId,index,total}（同一 importId、index 从 0 到 total-1）；`
        + ` 分片只写暂存，集齐全部分片后系统才做一次原子替换，在此之前线上库存不变。`,
    };
  }
  const rejectedEntries: DrugInventoryRejectedEntry[] = [];
  let rejectedEntryCount = 0;
  rawItems.forEach((raw, index) => {
    const reason = inventoryEntryRejection(raw, kinds);
    if (!reason) return;
    rejectedEntryCount += 1;
    if (rejectedEntries.length < MAX_REJECTED_ENTRIES_REPORTED) rejectedEntries.push({ index, reason });
  });
  if (rejectedEntryCount > 0) {
    return {
      ok: false,
      status: 400,
      code: "invalid_inventory_items",
      error: `${rejectedEntryCount}/${rawItems.length} entries are invalid; the whole batch was rejected and nothing was written`,
      rejectedEntries,
      rejectedEntryCount,
    };
  }
  return undefined;
}

export async function importDrugInventory(
  customerIdInput: string,
  input: DrugInventoryImportInput,
): Promise<DrugInventoryImportResult> {
  const customerId = validCustomerId(customerIdInput);
  const invalidPayload = validateDrugInventoryPayload(input);
  if (invalidPayload) return invalidPayload;
  const rawItems = input.items as unknown[];
  const parsedKinds = parseInventoryKinds(input.kinds);
  const kinds = parsedKinds instanceof Set ? parsedKinds : undefined;
  const partInput = input.part && typeof input.part === "object" && !Array.isArray(input.part)
    ? input.part as Record<string, unknown>
    : undefined;
  if (partInput) {
    const importId = normalizedImportId(partInput.importId) || "invalid-import-id";
    return withSerializedLock(stagedImportLocks, `${customerId}:${importId}`, async () => {
      const staged = await stageInventoryPart(customerId, partInput, rawItems, text(input.source), kinds);
      if (!staged.ok || "pending" in staged) return staged;
      return withSerializedLock(
        inventoryCommitLocks,
        customerId,
        () => commitInventoryItems(customerId, staged.items, staged.source, staged.kinds),
      );
    });
  }

  if (rawItems.length === 0 && !kinds) {
    // 不带 kinds 的空清单：不改动现有库存（见 validateDrugInventoryPayload 的说明）。
    return { ok: true, unchanged: true, snapshot: await drugInventorySnapshot(customerId) };
  }

  return withSerializedLock(
    inventoryCommitLocks,
    customerId,
    () => commitInventoryItems(customerId, rawItems, text(input.source), kinds),
  );
}

async function stageInventoryPart(
  customerId: string,
  partInput: Record<string, unknown>,
  rawItems: unknown[],
  source: string,
  kinds?: ReadonlySet<DrugInventoryItemKind>,
): Promise<{ ok: true; items: unknown[]; source: string; kinds?: Set<DrugInventoryItemKind> } | { ok: true; pending: DrugInventoryPartAck } | { ok: false; status: 400 | 409 | 413; code: string; error: string }> {
  // 形状校验共用 validateDrugInventoryPayload 的同一份判据（单一谓词）；这里兜底再跑一次。
  const shapeRejection = importPartShapeRejection(partInput);
  if (shapeRejection) return shapeRejection;
  const importId = normalizedImportId(partInput.importId);
  const index = Number(partInput.index);
  const total = Number(partInput.total);
  const existing = await readStagedImport(customerId, importId);
  if (existing && existing.total !== total) {
    return { ok: false, status: 409, code: "import_part_total_conflict", error: `part.total changed mid-import (was ${existing.total})` };
  }
  const kindList = kinds ? DRUG_INVENTORY_KINDS.filter((kind) => kinds.has(kind)) : undefined;
  if (existing && (existing.kinds || []).join(",") !== (kindList || []).join(",")) {
    return { ok: false, status: 409, code: "import_part_kinds_conflict", error: "every part of one import must declare the same kinds" };
  }
  const staged: StagedImport = existing || {
    importId,
    total,
    source,
    ...(kindList ? { kinds: kindList } : {}),
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
  await writeStagedImport(customerId, staged);
  const receivedParts = Object.keys(staged.parts).map(Number).sort((left, right) => left - right);
  const missingParts = Array.from({ length: total }, (_, position) => position)
    .filter((position) => !receivedParts.includes(position));
  if (missingParts.length > 0) {
    // 缺片就是没到齐，线上库存一个字节都不动——「半批替换」正是本条缺陷的危害本身。
    return { ok: true, pending: { importId, receivedParts, missingParts, total, bufferedItemCount, committed: false } };
  }
  const items = receivedParts.flatMap((position) => staged.parts[String(position)]);
  await rm(stagedImportPath(customerId, importId), { force: true }).catch(() => undefined);
  return { ok: true, items, source: staged.source, ...(staged.kinds ? { kinds: new Set(staged.kinds) } : {}) };
}

async function commitInventoryItems(
  customerId: string,
  rawItems: unknown[],
  source: string,
  kinds?: ReadonlySet<DrugInventoryItemKind>,
): Promise<DrugInventoryImportResult> {
  const incoming: DrugInventoryItem[] = [];
  const seen = new Set<string>();

  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = text(entry.name);
    if (!name || name.length > 120) continue;
    const kindInput = inventoryKindFromInput(entry.kind);
    const available = inventoryAvailableFromInput(entry.available);
    // 校验已整批拒收非法写法；这里是暂存/兜底路径的最后一道守卫，不猜。
    if (!kindInput || available === undefined) continue;
    const kind = kindInput.kind;
    const dedupeKey = `${kind}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const item: DrugInventoryItem = {
      name,
      kind,
      canonicalName: "",
      available,
      ...(text(entry.specification) ? { specification: text(entry.specification) } : {}),
      ...(text(entry.goodsId) ? { goodsId: text(entry.goodsId) } : {}),
      ...(kindInput.form ? { form: kindInput.form } : {}),
    };
    // 饮片归一到受治理正名：歧义药名**绝不自动择一**（一包针 → 千年健/石韦），按原名保留、
    // 不参与正名级匹配，并如实回报给甲方补映射。
    incoming.push(kind === "herb" ? withResolvedHerbName(item) : item);
  }

  // 带 kinds：只替换声明的类别，其余类别与它们的同步状态原样保留。
  const existing = kinds ? await load(customerId) : null;
  const kept = kinds && existing ? existing.items.filter((item) => !kinds.has(item.kind)) : [];
  const items = [...kept, ...incoming];
  const coverage: DrugInventoryCoverage = kinds
    ? {
        ...(existing ? existing.coverage : {}),
        ...Object.fromEntries([...kinds].map((kind) => [
          kind,
          incoming.some((item) => item.kind === kind) ? "synced" : "declared_none",
        ])),
      }
    : coverageFromItems(items);
  if (kinds) {
    for (const kind of DRUG_INVENTORY_KINDS) {
      if (!kinds.has(kind) && !items.some((item) => item.kind === kind) && coverage[kind] === "synced") delete coverage[kind];
    }
  }

  if (items.length === 0 && !kinds) {
    // 归一化后一条不剩（历史暂存分片或绕过校验的调用方）。不带 kinds 的零条目库存等于把整院
    // 药味判成库存外——宁可整批失败也不落盘。带 kinds 的空清单是「本院没有这几类药」的声明，照常落盘。
    return {
      ok: false,
      status: 400,
      code: "invalid_inventory_items",
      error: "no valid entries remained after normalization; nothing was written",
    };
  }

  const importedAt = new Date().toISOString();
  const inventoryVersion = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: DRUG_INVENTORY_SCHEMA_VERSION,
      customerId,
      coverage: DRUG_INVENTORY_KINDS.map((kind) => [kind, coverage[kind] || "not_synced"]),
      items: [...items].sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`, "zh-CN")),
    }))
    .digest("hex")
    .slice(0, 32);

  const file: InventoryFile = {
    schemaVersion: DRUG_INVENTORY_SCHEMA_VERSION,
    customerId,
    inventoryVersion,
    importedAt,
    source: source || "unspecified",
    itemCount: items.length,
    availableHerbCount: items.filter((item) => item.kind === "herb" && item.available).length,
    availablePatentCount: items.filter((item) => item.kind === "patent" && item.available).length,
    availableWesternCount: items.filter((item) => item.kind === "western" && item.available).length,
    ...herbNameReport(items),
    coverage,
    items,
  };

  const target = drugInventoryPath(customerId);
  await mkdir(dirname(target), { recursive: true });
  // 原子替换：半截文件被读成空库存会让整院所有药味变「缺货」，后果远重于一次写失败。
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(file), "utf8");
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }

  writeInventoryCache(customerId, file);
  const { items: _items, ...snapshot } = file;
  void _items;
  return { ok: true, snapshot };
}

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_READ_BUDGET_MS = 300;

function inventoryStaleDays(): number {
  const parsed = Number.parseInt(process.env.CDSS_DRUG_INVENTORY_STALE_DAYS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_DAYS;
}

function inventoryReadBudgetMs(): number {
  const parsed = Number.parseInt(process.env.CDSS_DRUG_INVENTORY_READ_BUDGET_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= 50 ? parsed : DEFAULT_READ_BUDGET_MS;
}

/** 库存多久没更新（天，向下取整）；导入时间不可解析时为 undefined。 */
function inventoryAgeDays(importedAt: string): number | undefined {
  const at = Date.parse(importedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((Date.now() - at) / 86_400_000)) : undefined;
}

export type DrugInventoryStatusSnapshot = DrugInventorySnapshot & {
  /** 超过 CDSS_DRUG_INVENTORY_STALE_DAYS（默认 30 天）没更新。只标注，照常使用。 */
  stale: boolean;
  ageDays?: number;
};

export async function drugInventorySnapshot(customerId: string): Promise<DrugInventoryStatusSnapshot | null> {
  const file = await load(customerId);
  if (!file) return null;
  const { items: _items, ...snapshot } = file;
  void _items;
  const ageDays = inventoryAgeDays(file.importedAt);
  return { ...snapshot, stale: ageDays !== undefined && ageDays > inventoryStaleDays(), ...(ageDays !== undefined ? { ageDays } : {}) };
}

/**
 * 诊疗链路读库存的时限（2026-09-28，甲方：同步药品不能阻塞推理）。库存是本机文件 + 进程内缓存，
 * 正常读取毫秒级；这里再加一道上限：超过 CDSS_DRUG_INVENTORY_READ_BUDGET_MS（默认 300ms）就按
 * 「未接库存」处理本次请求，读取在后台继续并回填缓存，下一次请求即可用上。
 */
async function loadForClinicalUse(customerId: string): Promise<InventoryFile | null> {
  const budgetMs = inventoryReadBudgetMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), budgetMs);
  });
  try {
    const result = await Promise.race([load(customerId).catch(() => null), timedOut]);
    if (result === "timeout") {
      console.warn("[tcm-cdss:inventory] read_budget_exceeded", {
        budgetMs,
        customerHash: createHash("sha256").update(customerId).digest("hex").slice(0, 32),
      });
      return null;
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type HerbAvailability = "in_stock" | "out_of_stock" | "unknown";
export type MedicineAvailability = HerbAvailability;
export type DrugInventoryKindState = DrugInventoryKindCoverage | "not_synced";

/**
 * 页面与 HIS 显示的库存标签（甲方 2026-09-28 定名）：
 * - 院内有货：在院内目录里且有货；
 * - 缺货：在院内目录里但标了无货；
 * - 库存外用药：不在院内目录里（包括本院没同步或声明没有这一类药）。系统照常推荐，由医生决定。
 * 未接库存（该客户从没导入过）时不给标签，行为与接入前一致。
 */
export type InventoryLabel = "院内有货" | "缺货" | "库存外用药";

export type MedicineInventoryStatus = {
  availability: HerbAvailability;
  label?: InventoryLabel;
  /** 匹配到的院内药品原名与商品号（HIS 可直接据此下单）。 */
  inventoryName?: string;
  goodsId?: string;
  specification?: string;
  note?: string;
};

export type InventoryAvailabilityView = {
  /** 未导入库存（或本次读取超时）时为 false —— 调用方据此完全跳过可得性呈现。 */
  inventoryLoaded: boolean;
  inventoryVersion: string;
  importedAt: string;
  stale: boolean;
  ageDays?: number;
  coverage: Record<DrugInventoryItemKind, DrugInventoryKindState>;
  /** 院内有货饮片的受治理正名（生成前软偏好清单）。 */
  availableHerbNames: readonly string[];
  statusOf: (name: string, kind: DrugInventoryItemKind) => MedicineInventoryStatus;
};

const KIND_LABEL: Record<DrugInventoryItemKind, string> = { herb: "中药饮片", patent: "中成药", western: "西药" };

const NOT_LOADED_COVERAGE: Record<DrugInventoryItemKind, DrugInventoryKindState> = {
  herb: "not_synced",
  patent: "not_synced",
  western: "not_synced",
};

const EMPTY_INVENTORY_VIEW: InventoryAvailabilityView = {
  inventoryLoaded: false,
  inventoryVersion: "",
  importedAt: "",
  stale: false,
  coverage: NOT_LOADED_COVERAGE,
  availableHerbNames: [],
  statusOf: () => ({ availability: "unknown" }),
};

function pickItem(candidates: readonly DrugInventoryItem[] | undefined, preferredName?: string): DrugInventoryItem | undefined {
  if (!candidates?.length) return undefined;
  return candidates.find((item) => item.available && item.name === preferredName)
    || candidates.find((item) => item.available)
    || candidates[0];
}

function statusFromItem(item: DrugInventoryItem, note?: string): MedicineInventoryStatus {
  const formNote = item.form === "powder" ? "院内为粉剂" : item.form === "granule" ? "院内为配方颗粒" : "";
  const notes = [note, formNote].filter(Boolean).join("；");
  return {
    availability: item.available ? "in_stock" : "out_of_stock",
    label: item.available ? "院内有货" : "缺货",
    inventoryName: item.name,
    ...(item.goodsId ? { goodsId: item.goodsId } : {}),
    ...(item.specification ? { specification: item.specification } : {}),
    ...(notes ? { note: notes } : {}),
  };
}

function viewFromFile(file: InventoryFile): InventoryAvailabilityView {
  const coverage: Record<DrugInventoryItemKind, DrugInventoryKindState> = {
    herb: file.coverage.herb || "not_synced",
    patent: file.coverage.patent || "not_synced",
    western: file.coverage.western || "not_synced",
  };
  const herbsByRaw = new Map<string, DrugInventoryItem[]>();
  const herbsByCanonical = new Map<string, DrugInventoryItem[]>();
  const medicinesByKey = new Map<string, DrugInventoryItem[]>();
  const medicinesByBase = new Map<string, DrugInventoryItem[]>();
  const push = (map: Map<string, DrugInventoryItem[]>, key: string, item: DrugInventoryItem) => {
    if (!key) return;
    const list = map.get(key) || [];
    list.push(item);
    map.set(key, list);
  };
  for (const item of file.items) {
    if (item.kind === "herb") {
      push(herbsByRaw, item.name, item);
      push(herbsByCanonical, item.canonicalName, item);
    } else {
      push(medicinesByKey, `${item.kind}:${medicineNameKey(item.name)}`, item);
      push(medicinesByBase, `${item.kind}:${medicineBaseKey(item.name)}`, item);
    }
  }
  const availableHerbNames = [...new Set(file.items
    .filter((item) => item.kind === "herb" && item.available && item.canonicalName)
    .map((item) => item.canonicalName))].sort();
  const ageDays = inventoryAgeDays(file.importedAt);

  const outsideInventory = (kind: DrugInventoryItemKind): MedicineInventoryStatus => {
    const state = coverage[kind];
    if (state === "declared_none") {
      return { availability: "out_of_stock", label: "库存外用药", note: `本院未配备${KIND_LABEL[kind]}` };
    }
    if (state === "not_synced") {
      return { availability: "unknown", label: "库存外用药", note: `本院未同步${KIND_LABEL[kind]}库存` };
    }
    return { availability: "out_of_stock", label: "库存外用药", note: "不在院内药品目录中" };
  };

  return {
    inventoryLoaded: true,
    inventoryVersion: file.inventoryVersion,
    importedAt: file.importedAt,
    stale: ageDays !== undefined && ageDays > inventoryStaleDays(),
    ...(ageDays !== undefined ? { ageDays } : {}),
    coverage,
    availableHerbNames,
    statusOf(name: string, kind: DrugInventoryItemKind): MedicineInventoryStatus {
      const raw = text(name);
      if (!raw) return { availability: "unknown" };
      if (coverage[kind] !== "synced") return outsideInventory(kind);
      if (kind === "herb") {
        const exact = pickItem(herbsByRaw.get(raw), raw);
        if (exact) return statusFromItem(exact);
        // 处方侧与院内侧走同一套写法清洗（延胡索（元胡）、甘草片），只比受治理正名。
        const canonical = resolveInventoryHerbName(raw).canonicalName;
        const matched = canonical ? pickItem(herbsByCanonical.get(canonical)) : undefined;
        return matched ? statusFromItem(matched) : outsideInventory(kind);
      }
      const exact = pickItem(medicinesByKey.get(`${kind}:${medicineNameKey(raw)}`));
      if (exact) return statusFromItem(exact);
      // 同一基础方/通用名的其他剂型（推荐逍遥丸、院内有逍遥颗粒）：给出院内品名，用法以院内药品说明书为准。
      const sameBase = pickItem(medicinesByBase.get(`${kind}:${medicineBaseKey(raw)}`));
      if (sameBase) return statusFromItem(sameBase, `院内剂型/规格为「${sameBase.name}」，用法以院内药品说明书为准`);
      return outsideInventory(kind);
    },
  };
}

/** 诊疗链路使用的统一库存视图（饮片、中成药、西药同一判据）。 */
export async function inventoryAvailabilityView(customerId: string): Promise<InventoryAvailabilityView> {
  const file = await loadForClinicalUse(customerId);
  return file ? viewFromFile(file) : EMPTY_INVENTORY_VIEW;
}

export type MedicineAvailabilityView = {
  inventoryLoaded: boolean;
  inventoryVersion: string;
  statusOf: (name: string, kind: "patent" | "western") => MedicineAvailability;
};

/** 兼容旧调用：只回可得性三值。 */
export async function medicineAvailabilityView(customerId: string): Promise<MedicineAvailabilityView> {
  const view = await inventoryAvailabilityView(customerId);
  return {
    inventoryLoaded: view.inventoryLoaded,
    inventoryVersion: view.inventoryVersion,
    statusOf: (name, kind) => view.statusOf(name, kind).availability,
  };
}

export type HerbAvailabilityView = {
  /** 未导入库存时为 false —— 调用方据此完全跳过可得性呈现。 */
  inventoryLoaded: boolean;
  inventoryVersion: string;
  availableHerbNames: readonly string[];
  statusOf: (herb: string) => HerbAvailability;
};

/** 兼容旧调用：饮片可得性三值。 */
export async function herbAvailabilityView(customerId: string): Promise<HerbAvailabilityView> {
  const view = await inventoryAvailabilityView(customerId);
  return {
    inventoryLoaded: view.inventoryLoaded,
    inventoryVersion: view.inventoryVersion,
    availableHerbNames: view.availableHerbNames,
    statusOf: (herb) => view.statusOf(herb, "herb").availability,
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
 * 饮片没同步或声明没有饮片时返回空串：不给偏好，由模型按证推荐（甲方：客户没有中药时推 AI 推的药）。
 */
export async function buildDrugInventoryPromptContext(customerId: string): Promise<string> {
  const view = await inventoryAvailabilityView(customerId);
  if (!view.inventoryLoaded || view.coverage.herb !== "synced" || view.availableHerbNames.length === 0) return "";
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
export type HerbAvailabilityRow = { name: string; availability: HerbAvailability } & Omit<MedicineInventoryStatus, "availability">;
export type MedicineAvailabilityRow = HerbAvailabilityRow & { type: "中成药" | "西药" };

export type DrugAvailabilityProjection = {
  inventory: {
    loaded: boolean;
    inventoryVersion: string;
    /** 库存**不进已签名的临床合同**：它每天都在变，进合同会让昨天签发的方案今天验签失败。 */
    note: string;
    coverage?: Record<DrugInventoryItemKind, DrugInventoryKindState>;
    importedAt?: string;
    stale?: boolean;
  };
  herbAvailability: HerbAvailabilityRow[];
  outOfStock: OutOfStockHerbAdvice[];
  /** 中成药/西药的院内状态（2026-09-28 起；未导入库存时各条为 unknown、无标签）。 */
  medicineAvailability: MedicineAvailabilityRow[];
};

/**
 * 给 HIS 方案附加库存可得性。**只标注，不改方**——处方内容与已签名结论逐字不变。
 */
export async function drugAvailabilityProjection(
  structuredHerbs: ReadonlyArray<{ name?: unknown }>,
  customerId: string,
  medicines: ReadonlyArray<{ name?: unknown; type?: unknown }> = [],
): Promise<DrugAvailabilityProjection> {
  const view = await inventoryAvailabilityView(customerId);
  const names = structuredHerbs
    .map((herb) => text(herb?.name))
    .filter(Boolean);
  const medicineRows = medicines
    .map((item) => ({ name: text(item?.name), type: item?.type === "西药" ? "西药" as const : "中成药" as const }))
    .filter((item) => item.name);
  if (!view.inventoryLoaded) {
    return {
      inventory: {
        loaded: false,
        inventoryVersion: "",
        note: "尚未导入院内库存，全部药味可得性为 unknown；处方生成与展示行为与未接库存时一致。",
      },
      herbAvailability: names.map((name) => ({ name, availability: "unknown" as const })),
      outOfStock: [],
      medicineAvailability: medicineRows.map((item) => ({ ...item, availability: "unknown" as const })),
    };
  }
  const notSynced = DRUG_INVENTORY_KINDS.filter((kind) => view.coverage[kind] === "not_synced").map((kind) => KIND_LABEL[kind]);
  const declaredNone = DRUG_INVENTORY_KINDS.filter((kind) => view.coverage[kind] === "declared_none").map((kind) => KIND_LABEL[kind]);
  return {
    inventory: {
      loaded: true,
      inventoryVersion: view.inventoryVersion,
      note: [
        "可得性为院内库存标注，不参与临床合同签名；缺货与库存外药味未从处方中删除，替代候选仅供医师选择。",
        notSynced.length ? `本院尚未同步${notSynced.join("、")}库存，这几类药标为「库存外用药」。` : "",
        declaredNone.length ? `本院已声明未配备${declaredNone.join("、")}。` : "",
        view.stale ? `院内库存数据已 ${view.ageDays} 天未更新，可得性仅供参考。` : "",
      ].filter(Boolean).join(""),
      coverage: view.coverage,
      importedAt: view.importedAt,
      stale: view.stale,
    },
    herbAvailability: names.map((name) => ({ name, ...view.statusOf(name, "herb") })),
    outOfStock: await outOfStockAdviceFromView(names, view),
    medicineAvailability: medicineRows.map((item) => ({
      ...item,
      ...view.statusOf(item.name, item.type === "西药" ? "western" : "patent"),
    })),
  };
}

async function outOfStockAdviceFromView(
  prescriptionHerbs: readonly string[],
  view: InventoryAvailabilityView,
): Promise<OutOfStockHerbAdvice[]> {
  // 饮片没同步或声明没有饮片时，院内不存在可替代的有货药，列替代只会是一串空数组。
  if (!view.inventoryLoaded || view.coverage.herb !== "synced") return [];
  const advice: OutOfStockHerbAdvice[] = [];
  for (const herb of prescriptionHerbs) {
    const availability = view.statusOf(herb, "herb").availability;
    if (availability !== "out_of_stock") continue;
    const substitutes = governedHerbSubstitutes(herb, prescriptionHerbs, 6)
      .filter((item) => view.statusOf(item.substitute, "herb").availability === "in_stock")
      .slice(0, 2);
    advice.push({ herb, availability, substitutes });
  }
  return advice;
}

export async function outOfStockAdvice(
  prescriptionHerbs: readonly string[],
  customerId: string,
): Promise<OutOfStockHerbAdvice[]> {
  return outOfStockAdviceFromView(prescriptionHerbs, await inventoryAvailabilityView(customerId));
}

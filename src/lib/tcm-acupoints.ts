import tcmAcupointJson from "../data/tcm-acupoint-evidence-catalog.json" with { type: "json" };

/**
 * T12 穴位证据层（《经络腧穴学》规划教材,399 穴：361 经穴 + 印堂(DU29) + 37 经外奇穴）。
 * 定位/主治/操作只作医师参考证据,不构成可执行指令——针刺项目 executable=false 边界不变。
 * 构建:scripts/ingest/acupoint-evidence-extract.mjs（确定性解析,零模型调用）。
 */

export type TcmAcupointEntry = {
  code: string;
  name: string;
  pinyin: string;
  meridian: string;
  specialClass?: string;
  location: string;
  indications: string[];
  operation?: string;
  classicalExcerpts?: string[];
  sourceRef: string;
};

type AcupointCatalog = {
  schemaVersion: string;
  evidenceTier: string;
  governance: Record<string, unknown>;
  meridianCoverage: string[];
  entries: TcmAcupointEntry[];
};

const catalog = tcmAcupointJson as unknown as AcupointCatalog;

export const TCM_ACUPOINTS: readonly TcmAcupointEntry[] = catalog.entries;
export const TCM_ACUPOINT_MERIDIAN_COVERAGE: readonly string[] = catalog.meridianCoverage;

const BY_CODE = new Map(TCM_ACUPOINTS.map((e) => [e.code, e]));
const BY_NAME = new Map(TCM_ACUPOINTS.map((e) => [e.name, e]));

/** 常见同名/俗称归一（教材正名为准,只收不歧义的）。 */
const ACUPOINT_ALIASES: Readonly<Record<string, string>> = {
  人中: "水沟",
  神阙旁: "天枢",
};

/** 模板穴位字段的确定性归一：去「双侧」前缀、去括注、取「或」二选一的首项、去空白。 */
export function normalizeAcupointSiteName(raw: unknown): string {
  return String(raw || "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/^双侧/, "")
    .split(/[或、,，/]/)[0]
    .replace(/\s+/g, "")
    .trim();
}

export function resolveAcupoint(raw: unknown): TcmAcupointEntry | undefined {
  const name = normalizeAcupointSiteName(raw);
  if (!name) return undefined;
  return BY_NAME.get(name) || BY_NAME.get(ACUPOINT_ALIASES[name] || "");
}

export function getAcupointByCode(code: string): TcmAcupointEntry | undefined {
  return BY_CODE.get(String(code || "").toUpperCase());
}

/** 名称形如穴位（在目录或可解析别名内）而不需要额外语境即可查证的判定。 */
export function isKnownAcupointName(raw: unknown): boolean {
  return resolveAcupoint(raw) !== undefined;
}

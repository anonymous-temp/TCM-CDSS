import { canonicalTcmLocationTerm, canonicalTcmNatureTerm } from "./clinical-governance-tables";
import tcmDiseaseLexiconJson from "../data/tcm-disease-lexicon.json" with { type: "json" };

const SPACE_AND_PUNCTUATION = /[\s，,。.!！?？；;：:、（）()【】\[\]《》"'“”‘’_-]+/g;

type TerminologyReasoning = {
  overview: { primarySyndrome: string; tcmDiseaseName?: string };
  westernDiagnosis: { primary: { name: string }; differentials?: Array<{ name: string }> };
  pathogenesis?: {
    locationDifferentiation?: { items?: string[] };
    natureDifferentiation?: { items?: string[]; rootDeficiency?: string[]; branchExcess?: string[] };
  };
  therapy?: { overallPrinciple?: string; overallMethod?: string };
};

function compactTerm(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(SPACE_AND_PUNCTUATION, "").trim() : "";
}

// ─── 辩病受控词表(GB/T 15657-2021 疾病部分 1,239 条 + 教材级临床扩展 10 条,别名 766 条) ───
// 解析顺序:正名 → 别名 → 「病」字后缀开合 → 未命中(unverified,原样放行并标记)。
// 「病」字开合是中医病名的天然变体(泄泻↔泄泻病、中风↔中风病),词表只收了一种写法时必须能互相归一。
export type TcmDiseaseResolution = {
  canonical: string;
  status: "standard" | "standard_alias" | "extension" | "unverified";
  temporary: boolean;
};

type DiseaseLexiconEntry = {
  id: string; code: string; canonical: string; aliases: string[];
  category: string; temporary: boolean; isCategoryHeading: boolean;
};
const DISEASE_LEXICON = tcmDiseaseLexiconJson as unknown as { entries: DiseaseLexiconEntry[] };
const DISEASE_CANONICAL = new Map<string, DiseaseLexiconEntry>();
const DISEASE_ALIAS = new Map<string, DiseaseLexiconEntry>();
for (const entry of DISEASE_LEXICON.entries) {
  DISEASE_CANONICAL.set(compactTerm(entry.canonical), entry);
  for (const alias of entry.aliases || []) {
    const key = compactTerm(alias);
    // 别名撞名时标准条目优先于临床扩展,先到的标准条目优先
    if (!DISEASE_ALIAS.has(key)) DISEASE_ALIAS.set(key, entry);
  }
}

export function resolveTcmDiseaseName(value: unknown): TcmDiseaseResolution | undefined {
  // 剥除亚型括注:痹症（腰痹）→痹症、功能（障碍）性子宫出血→功能性子宫出血——括注是亚型标注,不改变病名身份。
  const valueStripped = typeof value === "string" ? value.replace(/（[^（）]*）|\([^()]*\)/g, "") : value;
  // 复合名拆分在归一化之前(归一化会吃掉分隔符):「胸痹心悸」「肝瘟-鼓胀」取第一个可解成分。
  if (typeof valueStripped === "string") {
    for (const part of valueStripped.split(/[、，,，\-－/]+/).map((p) => p.trim()).filter((p) => p && p !== valueStripped.trim())) {
      const re = resolveTcmDiseaseName(part);
      if (re && re.status !== "unverified") return re;
    }
  }
  const compact = compactTerm(valueStripped);
  if (!compact) return undefined;
  const candidates = [compact, `${compact}病`, compact.endsWith("病") ? compact.slice(0, -1) : ""].filter(Boolean);
  // 优先级:非临时正名 > 别名(非临时属主) > 临时诊断用正名——失眠这类「临时术语+正式病别名」
  // 两属的词必须归到正式病名(失眠→不寐病),临时术语只在无正式归属时独立成立。
  for (const key of candidates) {
    const hit = DISEASE_CANONICAL.get(key);
    if (hit && !hit.temporary) {
      const extension = hit.category === "临床扩展";
      return { canonical: hit.canonical, status: extension ? "extension" : "standard", temporary: false };
    }
  }
  for (const key of candidates) {
    const hit = DISEASE_ALIAS.get(key);
    if (hit && !hit.temporary) {
      const extension = hit.category === "临床扩展";
      return { canonical: hit.canonical, status: extension ? "extension" : "standard_alias", temporary: false };
    }
  }
  for (const key of candidates) {
    const hit = DISEASE_CANONICAL.get(key);
    if (hit) return { canonical: hit.canonical, status: "standard", temporary: hit.temporary === true };
  }
  for (const key of candidates) {
    const hit = DISEASE_ALIAS.get(key);
    if (hit) {
      const extension = hit.category === "临床扩展";
      return { canonical: hit.canonical, status: extension ? "extension" : "standard_alias", temporary: hit.temporary === true };
    }
  }
  // 症后缀回退:眩晕症/失眠症/痹症 是口语级症后缀(咳嗽症等不常用但同理)——剥掉后重试。
  if (compact.endsWith("症")) {
    const re = resolveTcmDiseaseName(compact.slice(0, -1));
    if (re && re.status !== "unverified") return re;
  }
  // 前缀回退:慢性荨麻疹/功能性便秘 这类病程前缀不改变病名身份(西医名自然进不来,因为西医名不在词表)。
  const stripped = compact.replace(/^(慢性|急性|原发性|原发|继发性|继发|功能性|习惯性|一期|二期|三期|早期|晚期|突发性|青春期|老年性|更年期|新鲜|产后|外伤性)+/, "");
  if (stripped && stripped !== compact) {
    const re = resolveTcmDiseaseName(stripped);
    if (re && re.status !== "unverified") return re;
  }
  // 融合写法前缀扫描:「胸痹心悸」「脘腹痛」无分隔符的连写,取词表内最长前缀名(≥2字)归一。
  let prefixHit;
  for (const [key, entry] of [...DISEASE_CANONICAL, ...DISEASE_ALIAS]) {
    if (key.length >= 2 && key.length < compact.length && compact.startsWith(key)) {
      if (!prefixHit || key.length > prefixHit.key.length) prefixHit = { key, entry };
    }
  }
  if (prefixHit) {
    const extension = prefixHit.entry.category === "临床扩展";
    return { canonical: prefixHit.entry.canonical, status: extension ? "extension" : "standard_alias", temporary: prefixHit.entry.temporary === true };
  }
  const original = typeof value === "string" ? value.trim() : "";
  return original ? { canonical: original, status: "unverified", temporary: false } : undefined;
}

const WESTERN_DIAGNOSIS_RULES: readonly TerminologyRule[] = [
  { pattern: /(?:慢性|非器质性).*失眠|失眠.*(?:慢性|非器质性)/, canonical: "慢性失眠障碍" },
  { pattern: /失眠(?:障碍|综合征|症)?/, canonical: "失眠障碍" },
  { pattern: /(?:原发性)?高血压(?:病)?/, canonical: "高血压" },
  { pattern: /2型糖尿病|二型糖尿病/, canonical: "2型糖尿病" },
  { pattern: /阻塞性睡眠呼吸暂停(?:低通气)?(?:综合征)?|OSA/, canonical: "阻塞性睡眠呼吸暂停" },
  { pattern: /不宁腿(?:综合征)?|RLS/, canonical: "不宁腿综合征" },
] as const;

type TerminologyRule = {
  pattern: RegExp;
  canonical: string;
};

function canonicalFromRules(value: string, rules: readonly TerminologyRule[]): string | undefined {
  const compact = compactTerm(value);
  return rules.find((rule) => rule.pattern.test(compact))?.canonical;
}

export function canonicalWesternDiagnosisName(value: unknown): string {
  const original = typeof value === "string" ? value.trim() : "";
  return canonicalFromRules(original, WESTERN_DIAGNOSIS_RULES) || original;
}

/**
 * Differential rows are diagnostic identities, not free-form conclusions. A provider can wrap a
 * governed disease name in prose (for example, "症状待查，需排除阻塞性睡眠呼吸暂停") and also emit the
 * same disease as a standalone row. Resolve both to the same canonical identity so downstream
 * de-duplication and contract checks cannot mistake wording variation for two diagnoses.
 */
export function canonicalWesternDifferentialName(value: unknown): string {
  return canonicalWesternDiagnosisName(value);
}

export function westernDifferentialIdentity(value: unknown): string {
  return compactTerm(canonicalWesternDifferentialName(value));
}

export function canonicalTcmDiseaseName(
  value: unknown,
  context: TerminologyReasoning,
): string | undefined {
  const resolved = resolveTcmDiseaseName(value);
  if (resolved && resolved.status !== "unverified") return resolved.canonical;
  // Do not turn a Western diagnosis or a short-lived symptom into a TCM disease automatically.
  // The compatibility fallback only recovers legacy outputs that mixed the disease name into the
  // syndrome field (for example "失眠（心脾两虚证）")——在证型串里做最长词表名包含扫描。
  const contained = longestLexiconNameContained(context.overview.primarySyndrome);
  if (contained) return contained;
  return resolved?.canonical || undefined;
}

/** 在自由文本(证型串)中找被包含的最长词表病名;只回正名,别名命中时归到其正名。 */
function longestLexiconNameContained(value: unknown): string | undefined {
  const compact = compactTerm(value);
  if (!compact) return undefined;
  let best: string | undefined;
  for (const [key, entry] of DISEASE_CANONICAL) {
    if (key.length >= 2 && compact.includes(key) && !entry.temporary) {
      if (!best || key.length > compactTerm(best).length) best = entry.canonical;
    }
  }
  if (best) return best;
  for (const [key, entry] of DISEASE_ALIAS) {
    if (key.length >= 2 && compact.includes(key) && !entry.temporary) {
      if (!best || entry.canonical.length > best.length) best = entry.canonical;
    }
  }
  return best;
}

export function withCanonicalClinicalTerminology<T extends TerminologyReasoning>(
  reasoning: T,
): T {
  const westernName = canonicalWesternDiagnosisName(reasoning.westernDiagnosis.primary.name);
  const normalized = {
    ...reasoning,
    westernDiagnosis: {
      ...reasoning.westernDiagnosis,
      primary: {
        ...reasoning.westernDiagnosis.primary,
        name: westernName || reasoning.westernDiagnosis.primary.name,
      },
      ...(reasoning.westernDiagnosis.differentials
        ? {
            differentials: reasoning.westernDiagnosis.differentials.map((item) => ({
              ...item,
              name: canonicalWesternDifferentialName(item.name) || item.name,
            })),
          }
        : {}),
    },
  };
  const tcmDiseaseName = canonicalTcmDiseaseName(normalized.overview.tcmDiseaseName, normalized);
  const location = normalized.pathogenesis?.locationDifferentiation;
  const nature = normalized.pathogenesis?.natureDifferentiation;
  const therapy = normalized.therapy;
  const canonicalList = (
    values: string[] | undefined,
    canonicalize: (value: string) => { canonical: string } | undefined,
  ) => Array.isArray(values)
    ? [...new Set(values.map((value) => canonicalize(value)?.canonical || value.trim()).filter(Boolean))]
    : values;
  return {
    ...normalized,
    overview: {
      ...normalized.overview,
      ...(tcmDiseaseName ? { tcmDiseaseName } : {}),
    },
    ...(normalized.pathogenesis ? {
      pathogenesis: {
        ...normalized.pathogenesis,
        ...(location ? {
          locationDifferentiation: {
            ...location,
            items: canonicalList(location.items, canonicalTcmLocationTerm),
          },
        } : {}),
        ...(nature ? {
          natureDifferentiation: {
            ...nature,
            items: canonicalList(nature.items, canonicalTcmNatureTerm),
            rootDeficiency: canonicalList(nature.rootDeficiency, canonicalTcmNatureTerm),
            branchExcess: canonicalList(nature.branchExcess, canonicalTcmNatureTerm),
          },
        } : {}),
      },
    } : {}),
    // Do not invent a cross-case treatment principle when terminology normalization misses.
    // The original value must reach the M03 repair contract, which can request a clinically
    // supported principle instead of silently turning every case into “因人制宜”.
    ...(therapy ? { therapy } : {}),
  } as T;
}

import { hemostasisFirstMethod } from "./active-bleeding-treatment";
import { textbookFormulaNames, textbookNearestRow, textbookRowForSyndrome, therapyWithoutUnsupportedSymptomItems } from "./tcm-textbook-syndromes";
import { chpPregnancyLabel } from "./conception-herb-policy";
import { jingfangPatternForSignedSyndrome } from "./jingfang-patterns";
import { textbookSectionDeliveryName } from "./clinical-terminology";
import { herbBoundaryTail, stripHerbBoundaryTail } from "./candidate-boundary-text";
import { withoutWithheldBaseIngredientNote } from "./formula-withheld-ingredient-note";
import formulaCatalogJson from "../data/tcm-formula-sources.json" with { type: "json" };
import verifiedSupplementJson from "../data/tcm-verified-formula-supplements.json" with { type: "json" };
import governedFormulaCatalogJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import coreHerbsJson from "../data/tcm-formula-core-herbs.json" with { type: "json" };
import herbSubstitutionPolicyJson from "../data/tcm-herb-identity-substitution-policy.source.json" with { type: "json" };
import formulaRoleBindingsJson from "../data/tcm-formula-role-bindings.source.json" with { type: "json" };
import type { CaseState, ClinicalReasoningResultV2, EvidenceRef } from "./diagnosis-types";
import { clinicianDoseHerbClass, findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName, isClinicianDoseHerb } from "./tcm-knowledge";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { formulaFunctionsPositivelyAligned, lineageFormulaSyndromeSupportedNames, lockableFormulaCatalogFunctions, lockedFormulaNamesIncludeModelTrustedOnly, normalizedFormulaIdentity, signedTherapyMethodIds, trustedModelFormulaIdentityNames } from "./tcm-formula-indications";
import { lineageAffinitiesForFormula } from "./tcm-formula-lineage-affinity";
import { LINEAGE_LENS_SUBJECT, lineageLensSubject } from "./tcm-lineages";
import { formulaInCommonTier, formulaLockTierEnabled } from "./tcm-formula-tier";
import {
  compositionLogicForFormulaNames,
  formulaDiscriminationPaths,
  textualModificationsForFormulaNames,
} from "./tcm-classic-inference";

type FormulaVariant = {
  source: string;
  ingredients: string[];
  requiredIngredients?: string[];
  minimumPreservedIngredientCount?: number;
};

type FormulaCatalog = {
  schemaVersion: "tcm-formula-provenance-v2";
  sourceFile: string;
  sourceSha256: string;
  sourceRowCount: number;
  formulaNameCount: number;
  officialClassicSourceFile: string;
  officialClassicSourceSha256: string;
  officialClassicFormulaCount: number;
  officialClassicFormulas: Record<string, FormulaVariant & {
    sourceOriginal: string;
    prescription: string;
    dosageForm: string;
    catalogBatch: string;
  }>;
  formulas: Record<string, FormulaVariant[]>;
};

type VerifiedFormulaSupplements = {
  schemaVersion: "tcm-verified-formula-supplements-v1";
  entries: Record<string, FormulaVariant & {
    verification: Array<{ title: string; url: string }>;
  }>;
};

export type ResolvedFormulaSource = {
  formulaName: string;
  source: string;
  matchedIngredientCount: number;
  totalIngredientCount: number;
  minimumPreservedIngredientCount: number;
  matchedRequiredIngredientCount: number;
  requiredIngredientCount: number;
  verificationStatus: "verified_individually";
  exactComposition: boolean;
  origin: "official_classic_catalog" | "verified_reference_catalog" | "local_formula_catalog";
};

export type FormulaCompilationReference = {
  formulaName: string;
  source: string;
  ingredients: string[];
  minimumPreservedIngredientCount: number;
  requiredIngredients: string[];
  origin: ResolvedFormulaSource["origin"];
};

const catalog = formulaCatalogJson as FormulaCatalog;
const verifiedSupplements = verifiedSupplementJson as VerifiedFormulaSupplements;

type FormulaRoleBinding = {
  formulaName: string;
  source: string;
  herbs: Array<{
    acceptedNames: string[];
    role: "君" | "臣" | "佐" | "使";
    prescriptionRole: string;
    function: string;
    targetKind?: "pathogenesis_node" | "formula_structure";
    targetRef?: string;
    structureRole?: "middle_jiao_support" | "harmonize" | "guide" | "temper" | null;
    targetPathogenesis?: string;
  }>;
};

const FORMULA_ROLE_BINDINGS = formulaRoleBindingsJson.entries as readonly FormulaRoleBinding[];

function governedFormulaRoleHerbs(
  candidate: ClinicalReasoningResultV2["formula"] extends infer F
    ? F extends { candidates: Array<infer C> } ? C : never
    : never,
  sources: readonly ResolvedFormulaSource[],
) {
  if (sources.length !== 1) return candidate.herbs;
  const source = sources[0];
  const binding = FORMULA_ROLE_BINDINGS.find((item) =>
    item.formulaName === source.formulaName && item.source === source.source);
  if (!binding) return candidate.herbs;
  return candidate.herbs.map((herb) => {
    const identity = resolveGovernedTcmHerbIdentity(herb.name);
    const names = new Set([herb.name, identity.canonicalName, identity.suggestedCanonicalName].filter(Boolean));
    const governed = binding.herbs.find((item) => item.acceptedNames.some((name) => names.has(name)));
    return governed ? {
      ...herb,
      role: governed.role,
      prescriptionRole: governed.prescriptionRole,
      function: governed.function,
      ...(governed.targetKind ? { targetKind: governed.targetKind } : {}),
      ...(governed.targetRef ? { targetRef: governed.targetRef } : {}),
      ...(governed.structureRole !== undefined ? { structureRole: governed.structureRole } : {}),
      ...(governed.targetPathogenesis ? { targetPathogenesis: governed.targetPathogenesis } : {}),
    } : herb;
  });
}

type GovernedFormulaCompilationRow = {
  id: string;
  name: string;
  source: string;
  ingredients: string[];
  /** 构建期已解析的药味链接；adjudicatedIngredient 是「按方裁定」后的品种（见下方 compilationIngredients）。 */
  ingredientLinks?: Array<{
    rawName: string;
    adjudicatedIngredient?: string;
    /** 构建期已解析到的药典标准名（炮制前缀、部位后缀、异名统一到同一味）。 */
    canonicalName?: string;
    /** 构建期判定该归一无需人工裁定；false 时不得自动采用。 */
    autoResolvable?: boolean;
  }>;
  sourceClass: "official_classic_catalog" | "verified_reference_catalog" | "official_local_formula_standard";
  /** T8 已从可编译组成中扣除、转医师单独确定用量并强制审方的味（毒性/管制/无数值边界）。 */
  manualDoseIngredientNames?: string[];
  /**
   * 身份核验放行的等价品种（构建期算好，运行时只读）。三个来源在构建期已经合流到这一个字段：
   * 目录记的就是裸属名 / 裁定证据只到推断级 / 后世版本分叉登记。判据写在
   * scripts/build-tcm-governance-tables.py 一处，这里不再复算——复算就是「同一判据两处各写各的」。
   */
  varietyFlexibleIngredients?: Array<{
    recordedName: string;
    acceptedNames: string[];
    reason: string;
  }>;
  identityLockEligible: boolean;
  prescriptionLockEligible: boolean;
  doseCompilationEligible: boolean;
};

// 编译基准与按组成反查仍用全目录（不做常用度分层）：分层只管 M03 能锁定哪些方（tcm-formula-tier.ts）。
// M04 按组成反查命名是甲方「首选经方名、确无对应才自拟」的要求（test:formula-core-herbs 钉召回下限），
// 分层会把它的召回从 69% 压到 48%。
const governedFormulaCompilationRows = (governedFormulaCatalogJson.entries as readonly GovernedFormulaCompilationRow[])
  .filter((entry) => entry.identityLockEligible);
const governedFormulaCompilationByExactName = new Map(governedFormulaCompilationRows.map((entry) => [
  exactFormulaIdentityName(entry.name), entry,
]));
const governedFormulaCompilationCandidatesByNormalizedName = new Map<string, GovernedFormulaCompilationRow[]>();
for (const entry of governedFormulaCompilationRows) {
  const key = normalizeFormulaName(entry.name);
  const candidates = governedFormulaCompilationCandidatesByNormalizedName.get(key) || [];
  candidates.push(entry);
  governedFormulaCompilationCandidatesByNormalizedName.set(key, candidates);
}

const GOVERNED_FORMULA_NAMES = new Set([
  ...Object.keys(catalog.officialClassicFormulas),
  ...Object.keys(catalog.formulas),
  ...Object.keys(verifiedSupplements.entries),
].flatMap((name) => {
  const displayName = cleanFormulaDisplayName(name);
  const normalizedName = normalizeFormulaName(displayName);
  return [displayName, normalizedName].filter((item) => item.length >= 3);
}));

const FORMULA_DOSAGE_FORM_CHARACTERS = new Set(["汤", "散", "丸", "饮", "膏", "丹"]);
const FORMULA_CLAIM_MODIFIER = /^(?:加减|化裁|加味|类方)/;
const FORMULA_CLAIM_LEFT_CONTEXT = /(?:按|参考|基于|仿|合|取|采用|源于|沿用|原方)$/;

function normalizeFormulaName(value: string): string {
  return value
    .replace(/^.*?(?:候选处方|候选方案)\s*\d*[：:]\s*/, "")
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:加减方?|化裁方?|加味方?)$/g, "")
    .trim();
}

function exactFormulaIdentityName(value: string): string {
  return value
    .replace(/^.*?(?:候选处方|候选方案)\s*\d*[：:]\s*/, "")
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .trim();
}

/**
 * 编译用组成 = 原文组成，但把**按方裁定过的歧义药味**换成裁定品种。
 *
 * 古方只写「芍药/贝母/紫苏/菖蒲」时，品种由该方原书或标准注疏决定（tcm-formula-ingredient-identity-
 * adjudications.source.json）。裁定既决定 T8 的 doseCompilationEligible，就必须同样决定 M04 实际编译
 * 哪一味——否则 T8 宣称「可编译剂量」而运行时门禁仍拿原文歧义名去查剂量边界、查不到、拒绝编译，
 * 医生拿到方名却拿不到处方。这类「标志与门禁分叉」由 test-tcm-formula-provenance 的
 * 「T8 dose-compilation flag must equal the M04 runtime gate」逐方钉死。
 */
function compilationIngredients(row: GovernedFormulaCompilationRow): string[] {
  const adjudicated = new Map(
    (row.ingredientLinks || [])
      .filter((link) => link.adjudicatedIngredient)
      .map((link) => [link.rawName, link.adjudicatedIngredient as string]),
  );
  // 扣除味必须同时退出「模型看到的应有组成」与「80% 基准保留线」：留在组成里，模型会照写
  // 朱砂，随后被剂量门禁拒绝；写进基准线，扣掉一味就变成「组成不符」。T8 判定与 M04 运行时
  // 编译必须是同一份组成，否则又回到「宣称可编译、运行时拒绝」的分叉。
  const deducted = new Set(row.manualDoseIngredientNames || []);
  const kept = row.ingredients.filter((name) => !deducted.has(name));
  if (adjudicated.size === 0) return kept;
  return kept.map((name) => adjudicated.get(name) || name);
}

/**
 * 方名目录里同名各版本都有的药味（组成身份名）。用于中成药：病历写患者自服「黄连上清丸」时，与本方重叠的药只按
 * 各版本共有的那几味算，不挑某一个版本（目录收了抚顺方、西安方、北京方等多个版本，组成各不相同）。
 * 片、胶囊、颗粒等剂型名先换成丸、散再查；目录没有这个方时返回空。
 */
export function catalogSharedComposition(name: string): string[] {
  const raw = normalizeFormulaName(String(name || ""));
  if (!raw) return [];
  const base = raw.replace(/(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|口服液|合剂|冲剂|糖浆|丸|散|膏|丹|汤)$/u, "");
  const names = [raw, `${base}丸`, `${base}散`, `${base}汤`, `${base}丹`];
  // 受治理的编译行（常用方，组成已逐味核过）优先；没有时只在目录收了两个以上版本时取共有药味——
  // 只有一个版本的，常是同名的另一张方（「六味地黄丸」单版本里有香附、艾叶），不据此说组成。
  const governed = names.map((candidate) => governedFormulaCompilationRow(candidate)).find(Boolean);
  if (governed) return [...new Set(compilationIngredients(governed).map((item) => compositionIdentityName(item)).filter(Boolean))];
  const variants = names
    .map((candidate) => catalog.formulas[candidate])
    .find((rows) => Array.isArray(rows) && rows.length > 0);
  if (!variants || variants.length < 2) return [];
  const sets = variants
    .map((row) => new Set((row.ingredients || []).map((item) => compositionIdentityName(String(item))).filter(Boolean)))
    .filter((set) => set.size > 0);
  if (sets.length === 0) return [];
  return [...sets[0]].filter((herb) => sets.every((set) => set.has(herb)));
}

/**
 * 剂型互换的同名方在受治理编译目录里的组成（2026-10-20 第八轮，留出例 S145）：教材写「四妙散」，目录只收同一首方的「四妙丸」（《成方便读》，
 * 苍术、黄柏、牛膝、薏苡仁）。只认受治理编译行（组成逐味核过）：这个名字去掉丸/散/汤/丹后，换成另一种成药后缀（散换丸、丸换散、汤和丹换丸或散）恰好一个能在目录里查到时，取那一条的组成。
 * 不取名录（同名异方）各版本的共有药味——那一份常只剩几味公共药，拿来当覆盖基准会把无关的方算成「已覆盖」；
 * 组成超过 8 味的也不取（附子理中丸—附子理中汤《三因》11 味是另一首合方，不是教材的附子理中丸）。目录里有这个名字本身的、没有剂型后缀的、
 * 或几个后缀都查得到的，都返回空。
 */
export function governedDosageFormVariantComposition(name: string): string[] {
  const raw = normalizeFormulaName(String(name || ""));
  const base = raw.replace(/(?:丸|散|汤|丹)$/u, "");
  if (!raw || base === raw || governedFormulaCompilationRow(raw)) return [];
  // 换哪几种后缀：散与丸是同一首方的两种成药形态（四妙散—四妙丸）；汤、丹换丸或散。不换成汤——「四妙汤」是《验方新编》的另一首方。
  // 换丸或散有不止一个查得到的，不取。
  const suffixes = raw.endsWith("散") ? ["丸"] : raw.endsWith("丸") ? ["散"] : ["丸", "散"];
  const rows = suffixes.map((suffix) => governedFormulaCompilationRow(`${base}${suffix}`))
    .filter((row): row is GovernedFormulaCompilationRow => Boolean(row));
  if (rows.length !== 1) return [];
  const composition = [...new Set(compilationIngredients(rows[0]).map((item) => compositionIdentityName(item)).filter(Boolean))];
  return composition.length >= 3 && composition.length <= 8 ? composition : [];
}

/** 该方中系统不编制用量、需医师单独开具并经审方复核的味（可为空）。 */
export function formulaManualDoseIngredients(name: string): string[] {
  return [...(governedFormulaCompilationRow(name)?.manualDoseIngredientNames || [])];
}

function governedFormulaCompilationRow(value: string): GovernedFormulaCompilationRow | undefined {
  const exact = governedFormulaCompilationByExactName.get(exactFormulaIdentityName(value));
  if (exact) return exact;
  const candidates = governedFormulaCompilationCandidatesByNormalizedName.get(normalizeFormulaName(value)) || [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function cleanFormulaDisplayName(value: string): string {
  return value
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[：:；;，,。\s]+$/g, "")
    .trim();
}

function explicitFormulaIdentityNames(values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    const displayName = cleanFormulaDisplayName(value);
    const normalizedName = normalizeFormulaName(displayName);
    return [displayName, normalizedName];
  }).filter((value) => value.length >= 3))].sort((left, right) => right.length - left.length);
}

function replaceLiteralFormulaClaims(value: string, names: string[], replacement: string): string {
  return names.reduce((output, name) => output.split(name).join(replacement), value);
}

/**
 * 「散」后面接着成词（散结、散寒、散瘀…）时是药名加动词，不是方名：「木香行气散结」被当成方名「木香行气散」换成「本方案」，
 * 方义成了「本方结」（2026-10-18 留出集 S067）。构词式守卫，只看紧跟的一个字；方名识别与方名替换共用。
 */
export function formulaNameIsVerbPhrase(name: string, rightContext: string): boolean {
  return name.endsWith("散") && /^[结寒瘀邪风热湿郁血肿痞滞表火毒]/u.test(rightContext);
}

function isUnambiguousGovernedFormulaClaim(value: string, start: number, end: number, name: string): boolean {
  const rightContext = value.slice(end);
  if (formulaNameIsVerbPhrase(name, rightContext)) return false;
  if (!name.endsWith("散") || name.length >= 4) return true;
  if (end === value.length || /^[\s，,。；;：:、（）()【】\[\]“”"']/.test(rightContext)) return true;
  if (FORMULA_CLAIM_MODIFIER.test(rightContext)) return true;
  return FORMULA_CLAIM_LEFT_CONTEXT.test(value.slice(Math.max(0, start - 4), start));
}

function governedFormulaClaimRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let endIndex = 0; endIndex < value.length; endIndex += 1) {
    if (!FORMULA_DOSAGE_FORM_CHARACTERS.has(value[endIndex])) continue;
    const earliestStart = Math.max(0, endIndex - 11);
    let matchedStart = -1;
    for (let startIndex = earliestStart; startIndex <= endIndex - 2; startIndex += 1) {
      const name = value.slice(startIndex, endIndex + 1);
      if (!GOVERNED_FORMULA_NAMES.has(name)) continue;
      if (!isUnambiguousGovernedFormulaClaim(value, startIndex, endIndex + 1, name)) continue;
      matchedStart = startIndex;
      break;
    }
    if (matchedStart >= 0) {
      ranges.push({ start: matchedStart, end: endIndex + 1 });
      endIndex = Math.max(endIndex, ranges.at(-1)!.end - 1);
    }
  }
  return ranges;
}

function replaceGovernedFormulaClaims(value: string, replacement: string): string {
  const ranges = governedFormulaClaimRanges(value);
  if (ranges.length === 0) return value;
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += value.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

// Formula provenance is stricter than dose lookup: medicinal parts, processing
// methods and preparation forms remain distinct. Only true spelling/historical
// name aliases may collapse inside the signed formula-identity contract.
const HARD_IDENTITY_HERB_ALIASES: Record<string, string> = {
  黄耆: "黄芪",
  代赭: "代赭石",
} as const;

function normalizeHerbName(value: string): string {
  const normalized = value
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:饮片|颗粒)$/g, "")
    .trim();
  for (const [alias, canonical] of Object.entries(HARD_IDENTITY_HERB_ALIASES)
    .sort(([left], [right]) => right.length - left.length)) {
    if (normalized === alias || normalized.endsWith(alias)) {
      return `${normalized.slice(0, -alias.length)}${canonical}`;
    }
  }
  return normalized;
}

/**
 * 方剂名录里组成药名的残片与旧名（2026-10-18）：国家经典名方目录的《伤寒论》竹叶石膏汤记作「竹叶二把、麦门冬」，名录转载里还有
 *「竹叶2把」「麦门冬自2-」「僵蚕5条」。出处排名按药名逐字比，残片与旧名一律对不上，原书条目因此过不了身份门槛
 *（留出例 S046 署名落到《医略六书》卷十八）。比较前去掉末尾的数量残片（阿拉伯数字，或中文数字＋量词——「三七」这类药名不带量词，不受影响）
 * 与「自N-」，再按受治理药名身份归一（麦门冬→麦冬、花粉→天花粉；只取可自动归一的行，炙甘草等炮制名保持原样）。只用于出处比对。
 */
/** 只去数量残片、不做身份归一的写法；判「逐字一致」（exactComposition）用它，药用部位与旧名差异（当归身/当归）不能算逐字一致。 */
function catalogIngredientWritten(value: string): string {
  const cleaned = String(value || "")
    .replace(/自\d+-?$/u, "")
    .replace(/(?:\d+(?:\.\d+)?\s*(?:把|枚|个|片|条|钱|两|升|合|斤|分|粒|撮|g|克)?|[一二三四五六七八九十百半]+(?:把|枚|个|片|条|钱|两|升|合|斤|分|粒|撮))$/u, "")
    .trim();
  return normalizeHerbName(cleaned.length >= 1 ? cleaned : String(value || ""));
}

/**
 * 出处比对时名录组成药名的归一口径（2026-10-18）。身份归一（麦门冬→麦冬、熟地→熟地黄、橘皮→陈皮）只给「原书」条目：
 * 国家经典名方目录与受治理目录里这首方的出处。名录里的后世转载只去数量残片、按原写法比——给它们也做身份归一后，
 * 写着生地、丹皮、橘皮的转载反而比原书「更贴近」（回放 724 个候选：清胃散归《金鉴》、普济消毒饮归《卫生鸿宝》、
 * 逍遥散归《女科切要》、生脉散归《嵩崖尊生》），违背「出处先取原书」。
 */
function sourceIngredientKey(candidate: FormulaSourceCandidate, governedSource: string | undefined): (value: string) => string {
  const anchor = candidate.origin === "official_classic_catalog" ||
    (governedSource !== undefined && (candidate.variant.source === governedSource || sameFormulaSourceBook(candidate.variant.source, governedSource)));
  return anchor ? catalogIngredientIdentity : catalogIngredientWritten;
}

function catalogIngredientIdentity(value: string): string {
  const normalized = catalogIngredientWritten(value);
  const canonical = resolveGovernedTcmHerbIdentity(normalized).canonicalName;
  return canonical ? normalizeHerbName(canonical) : normalized;
}

function rawHerbIdentityName(value: string): string {
  return value
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:饮片|颗粒)$/g, "")
    .trim();
}

function equivalentHerbIdentityNames(value: string): string[] {
  const raw = rawHerbIdentityName(value);
  const canonical = normalizeHerbName(raw);
  const reverseAliases = Object.entries(HARD_IDENTITY_HERB_ALIASES).flatMap(([alias, target]) =>
    canonical === target || canonical.endsWith(target)
      ? [`${canonical.slice(0, -target.length)}${alias}`]
      : []
  );
  return [...new Set([
    raw,
    normalizeHerbName(raw),
    ...reverseAliases,
  ].filter(Boolean))];
}

type FormulaHerbInput = { name?: string; processing?: string | null };

const PROCESSING_IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  炙制: "炙",
  炒制: "炒",
  姜炙: "姜制",
  酒炙: "酒制",
  醋炙: "醋制",
  盐炙: "盐制",
};

const NON_IDENTITY_PREPARATION = /^(?:捣碎|打碎|研碎|切片|切段|切块|去核|去芦|洗净|先煎|后下|另煎|另炖|包煎|烊化|冲服|兑服|同煎)$/;

function formulaHerbIdentityName(herb: FormulaHerbInput): string {
  const name = rawHerbIdentityName(herb.name || "");
  if (!name) return "";
  const rawProcessing = typeof herb.processing === "string"
    ? herb.processing.replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "").replace(/(?:法|品)$/g, "").trim()
    : "";
  if (!rawProcessing || /^(?:无|饮片|常规)$/.test(rawProcessing) || NON_IDENTITY_PREPARATION.test(rawProcessing)) {
    return normalizeHerbName(name);
  }
  const processing = PROCESSING_IDENTITY_ALIASES[rawProcessing] || rawProcessing;
  const composed = name.startsWith(processing) ? name : `${processing}${name}`;
  return normalizeHerbName(composed);
}

function formulaHerbBaseIdentityName(herb: FormulaHerbInput): string {
  return normalizeHerbName(rawHerbIdentityName(herb.name || ""));
}

function sourceIngredientRequiresProcessingIdentity(value: string): boolean {
  const raw = rawHerbIdentityName(value);
  const prefixes = [...new Set([
    ...Object.keys(PROCESSING_IDENTITY_ALIASES),
    ...Object.values(PROCESSING_IDENTITY_ALIASES),
  ])].sort((left, right) => right.length - left.length);
  return prefixes.some((prefix) => raw.startsWith(prefix) && raw.length > prefix.length);
}

function formulaHerbBaseAliases(herbs: FormulaHerbInput[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const herb of herbs) {
    const exact = formulaHerbIdentityName(herb);
    const base = formulaHerbBaseIdentityName(herb);
    if (exact && base && exact !== base) aliases.set(exact, base);
    // 炮制前缀写在**药名里**时（{name:"炙甘草", processing:null}），上面那条一个别名都产不出:
    // exact 与 base 都等于「炙甘草」。而模型与医生恰恰就是这么写的——麻黄汤的甘草通行写作炙甘草。
    //
    // 实测后果（全目录 1550 首基准含裸名的受治理方，把其中一味改写成标准炮制饮片）：
    // **729 首（47%）身份核验判否**，大黄 161、甘草 137、栀子 24、白芍 17、地黄 16、枳壳 15。
    // 线上端到端可复现：M04 给出 麻黄、桂枝、苦杏仁、炙甘草——那就是麻黄汤本身——被剥名成
    // 「本例辨证组方」。而**按组成反查同一张方却正确认出麻黄汤**：两条路径对「这是不是麻黄汤」
    // 各写各的，反查用 compositionIdentityName（剥炮制前缀），正向只看结构化 processing 字段。
    // 这里收敛到反查用的那个谓词，不再各写一份。
    //
    // 放宽只发生在**基准记裸名**这一侧：canMatch 仍要求
    // !sourceIngredientRequiresProcessingIdentity(ingredient)，基准写「炒牛蒡子」时
    // 处方给裸「牛蒡子」照旧不算命中。剂量、毒性、煎法一律仍按处方原样的炮制品走。
    const stripped = compositionIdentityName(exact);
    if (exact && stripped && stripped !== exact && !aliases.has(exact)) aliases.set(exact, stripped);
  }
  return aliases;
}

const CORE_SAFETY_HERBS = new Set([
  "附子", "乌头", "川乌", "草乌", "半夏", "天南星", "麻黄", "细辛", "大黄", "巴豆", "朱砂", "雄黄", "马钱子",
]);

/**
 * 安全定性药味的**炮制/规格写法**。这批名字是药典正式收载的饮片规格，不是边角输入：
 * 药典 2020 一部收 半夏 / 法半夏 / 姜半夏 / 清半夏 四个条目，蜜麻黄是麻黄项下蜜炙法饮片规格。
 * 临床与目录里都按这些名字写方。
 *
 * 原实现拿 13 个基原名做**精确匹配**，于是这一整批全部漏判。实测后果不是「少标一个」：
 *   identify(["蜜麻黄","桂枝","苦杏仁","炙甘草","生姜","大枣"]) → 「桂枝去芍药汤加味」
 * 一张**无汗表实**的组成被冠上**有汗表虚**的方名。写「炙麻黄」时正常出「麻黄汤」——
 * 差别只在饮片写法。formula-discrimination-guard 专门钉死的正是这一对，
 * 而它钉的是「麻黄」这个写法，换成药典饮片名就绕过去了。
 * 全目录扫描：64 对（方, 炮制毒性药）/ 58 张方在缺该药时兜底层仍冠原方名。
 */
const CORE_SAFETY_HERB_PROCESSING_PREFIX = /^(?:蜜炙|麸炒|土炒|盐炒|酒炒|醋炒|姜炒|姜制|酒制|醋制|盐制|炮制|蜜|炙|炒|制|法|姜|清|仙|淡|黑|煨|煅|焦|熟|生|明|漂|胆|炮)+/;
const CORE_SAFETY_HERB_PROCESSING_SUFFIX = /(?:炭|霜|曲|尖|仁|肉|粉|末|片|头)+$/;
/** 别名：剥完前后缀仍对不上基原名的少数写法。 */
const CORE_SAFETY_HERB_BASE_ALIASES: Readonly<Record<string, string>> = {
  南星: "天南星", 附: "附子", 乌头尖: "乌头", 草乌头: "草乌", 川乌头: "川乌",
};
/**
 * **形近而非同物**，必须留在集合之外：
 *  · 白附子 —— 天南星科独角莲块茎（禹白附），与毛茛科乌头子根加工品的附子不是一物；
 *  · 麻黄根 —— 药典单列条目，功效止汗，与麻黄发汗**相反**。
 * 这两条错判的方向是「把普通药当成安全定性药」，代价是误降一批方的兜底命名，
 * 不是安全风险；但错就是错，显式排除并写明依据。
 */
const CORE_SAFETY_HERB_NON_MEMBERS = new Set(["白附子", "麻黄根", "附子理中丸"]);

function coreSafetyHerbBaseIdentity(value: string): string {
  let base = normalizeHerbName(rawHerbIdentityName(value));
  if (!base) return "";
  // 先走受治理别名表：附片/黑顺片/炮附片→附子、酒大黄→大黄 是这条路解决的，不是剥前缀。
  const governed = resolveGovernedTcmHerbIdentity(base);
  const canonical = governed.canonicalName || governed.doseCanonicalName;
  if (canonical) base = normalizeHerbName(canonical);
  if (CORE_SAFETY_HERBS.has(base)) return base;
  // 剥到不动点：制天南星→天南星、蜜麻黄→麻黄、巴豆霜→巴豆、半夏曲→半夏、胆南星→南星→天南星。
  for (let guard = 0; guard < 4; guard += 1) {
    const stripped = base
      .replace(CORE_SAFETY_HERB_PROCESSING_PREFIX, "")
      .replace(CORE_SAFETY_HERB_PROCESSING_SUFFIX, "")
      .trim();
    const aliased = CORE_SAFETY_HERB_BASE_ALIASES[stripped] || stripped;
    if (!aliased || aliased === base) break;
    base = aliased;
    if (CORE_SAFETY_HERBS.has(base)) return base;
  }
  return base;
}

/**
 * 该药名是否属安全定性药味（按基原判，不按饮片写法判）。
 *
 * **当谓词用，不要用它改写 core 集合的成员**：运行时判据是
 * `[...core].some(name => !actualSet.has(name))`，core 名与处方 identity 名同域比较。
 * 若把基原名「半夏」写进 core，凡目录录「姜半夏/法半夏」的方在该药**存在时**也永远匹配不上，
 * 等于静默废掉约 100 张方的兜底层。
 */
export function isCoreSafetyHerbName(value: unknown): boolean {
  const raw = normalizeHerbName(rawHerbIdentityName(String(value ?? "")));
  if (!raw || CORE_SAFETY_HERB_NON_MEMBERS.has(raw)) return false;
  if (CORE_SAFETY_HERBS.has(raw)) return true;
  return CORE_SAFETY_HERBS.has(coreSafetyHerbBaseIdentity(raw));
}

function requiredFormulaAnchors(formulaName: string, variant: FormulaVariant, ingredients: string[]): string[] {
  const configured = (variant.requiredIngredients || []).map(normalizeHerbName).filter(Boolean);
  if (configured.length > 0) return configured;
  const normalizedFormulaName = normalizeFormulaName(formulaName);
  // Identify name-bearing herbs from both the raw source token and its canonical alias. Doing this
  // only after alias normalization loses anchors such as 代赭 -> 代赭石 because “旋覆代赭汤” does
  // not contain the longer canonical token. The public/validator contract still stores the final
  // canonical herb name so aliases remain one identity downstream.
  const named = [...new Set([
    ...variant.ingredients.filter((raw) => {
      return equivalentHerbIdentityNames(raw).some((identity) =>
        identity.length >= 2 && normalizedFormulaName.includes(identity)
      );
    }).map(normalizeHerbName),
    ...ingredients.filter((ingredient) => equivalentHerbIdentityNames(ingredient).some((identity) =>
      identity.length >= 2 && normalizedFormulaName.includes(identity)
    )),
  ])];
  const safetyCritical = ingredients.filter((ingredient) => isCoreSafetyHerbName(ingredient));
  return [...new Set([...named, ...safetyCritical, ingredients[0]].filter(Boolean))];
}

const normalizedCatalog = new Map<string, { name: string; variants: FormulaVariant[] }>();
for (const [name, variants] of Object.entries(catalog.formulas)) {
  const normalized = normalizeFormulaName(name);
  if (normalized.length < 2) continue;
  const existing = normalizedCatalog.get(normalized);
  if (!existing) {
    normalizedCatalog.set(normalized, { name, variants: [...variants] });
    continue;
  }
  // Annotated aliases can normalize to the same formula name while carrying different exact
  // compositions/sources. Merge every variant into one ranking pool instead of silently dropping
  // later aliases and attributing an exact composition to the wrong book.
  const seen = new Set(existing.variants.map((variant) => `${variant.source}::${variant.ingredients.join("|")}`));
  for (const variant of variants) {
    const key = `${variant.source}::${variant.ingredients.join("|")}`;
    if (!seen.has(key)) {
      existing.variants.push(variant);
      seen.add(key);
    }
  }
}

const normalizedOfficialClassics = new Map<string, { name: string; variant: FormulaCatalog["officialClassicFormulas"][string] }>();
for (const [name, variant] of Object.entries(catalog.officialClassicFormulas)) {
  normalizedOfficialClassics.set(normalizeFormulaName(name), { name, variant });
}

const normalizedVerifiedSupplements = new Map<string, { name: string; variant: VerifiedFormulaSupplements["entries"][string] }>();
for (const [name, variant] of Object.entries(verifiedSupplements.entries)) {
  normalizedVerifiedSupplements.set(normalizeFormulaName(name), { name, variant });
}

function knownFormulaFragment(fragment: string): boolean {
  // The broad local workbook contains short common nouns (e.g. 补汤/膏药/炒面). They are useful
  // for composition lookup after a doctor has named a candidate, but unsafe as free-text identity
  // matches. Two-character names are accepted only from the governed official/verified catalogs.
  return normalizedOfficialClassics.has(fragment) || normalizedVerifiedSupplements.has(fragment) || (fragment.length >= 3 && normalizedCatalog.has(fragment));
}

/**
 * 方名的等价写法（2026-10-18），只在原写法认不出时才换着认，认出的是目录里那条的写法：
 *  · 瓜蒌的三种写法：教材写「栝蒌薤白半夏汤」，国家经典名方目录写「瓜蒌薤白半夏汤」，名录写「栝楼薤白白酒汤」；
 *  · 丸散方作汤剂：教材写「知柏地黄汤」「杞菊地黄汤」，目录收的是「知柏地黄丸」「杞菊地黄丸」（同一首方改作汤剂）。
 */
function formulaFragmentSpellings(fragment: string): string[] {
  const spellings = /栝蒌|栝楼|瓜蒌/u.test(fragment)
    ? [fragment, ...["瓜蒌", "栝楼", "栝蒌"].map((spelling) => fragment.replace(/栝蒌|栝楼|瓜蒌/gu, spelling))]
    : [fragment];
  return spellings.flatMap((spelling) => /汤$/u.test(spelling) && spelling.length >= 4
    ? [spelling, `${spelling.slice(0, -1)}丸`, `${spelling.slice(0, -1)}散`]
    : [spelling]);
}

function knownFormulaMatches(normalized: string): Array<{ name: string; start: number }> {
  const matches: Array<{ name: string; start: number }> = [];
  for (let start = 0; start < normalized.length; start += 1) {
    let found = "";
    for (let end = normalized.length; end >= start + 2 && !found; end -= 1) {
      found = formulaFragmentSpellings(normalized.slice(start, end)).find(knownFormulaFragment) || "";
    }
    if (found) matches.push({ name: found, start });
  }
  return matches
    .sort((a, b) => b.name.length - a.name.length || a.start - b.start)
    .filter((match) => !insideUnlockableTextbookFormula(normalized, match))
    .filter((match, index, all) => !all.slice(0, index).some((chosen) => {
      const chosenEnd = chosen.start + chosen.name.length;
      const matchEnd = match.start + match.name.length;
      return match.start < chosenEnd && matchEnd > chosen.start;
    }))
    .sort((a, b) => a.start - b.start);
}

let unlockableTextbookFormulaNames: string[] | undefined;
/**
 * 教材方名整体是一个方（2026-10-18）。目录里没有这个名字时，不能在它里面认出一个更短的别的方：
 *「知柏地黄汤」里的「地黄汤」、「二地鳖甲煎」里的「鳖甲煎」、「瓜蒌贝母汤」里的「贝母汤」都是另一首方，锁上之后 M04 按错的组成核对
 *（验收集 M：「栝蒌薤白半夏汤合涤痰汤加减」锁成「半夏汤」，8 次 named_formula_positive_sufficiency_missing:半夏汤）。
 * 594 个教材方名里 21 个有这种情况。认不出的教材方不锁，方名照教材写（与「教材方目录锁不上」同一条路）。
 * 带「合」的是合方，里面的方照常认；只差「汤」字的（龟鹿二仙胶汤）算同一首。
 */
function insideUnlockableTextbookFormula(normalized: string, match: { name: string; start: number }): boolean {
  unlockableTextbookFormulaNames ??= [...textbookFormulaNames()]
    .map(normalizeFormulaName)
    .filter((name) => name.length >= 3 && !name.includes("合") && !formulaFragmentSpellings(name).some(knownFormulaFragment))
    .sort((a, b) => b.length - a.length);
  const matchEnd = match.start + match.name.length;
  for (const name of unlockableTextbookFormulaNames) {
    if (name.length <= match.name.length || name === `${match.name}汤`) continue;
    for (let at = normalized.indexOf(name); at >= 0; at = normalized.indexOf(name, at + 1)) {
      if (at <= match.start && at + name.length >= matchEnd) return true;
    }
  }
  return false;
}

/**
 * 这段文字本身是不是一个已收录方名（与 knownFormulaMatches 同一口径：两字名只认官方/核验目录）。
 * 方解扫描外来药名时用它跳过方名片段——「玉屏风散」里的「屏风」是防风的别名，
 * 不跳过就会把本方方名当成外来药（2026-09-29 甲方测评 0068）。
 */
export function isKnownFormulaNameFragment(fragment: string): boolean {
  const normalized = normalizeFormulaName(fragment);
  if (normalized.length < 2) return false;
  return normalizedOfficialClassics.has(normalized) || normalizedVerifiedSupplements.has(normalized) ||
    (normalized.length >= 3 && normalizedCatalog.has(normalized));
}

function canonicalFormulaDisplayName(normalizedName: string): string {
  return cleanFormulaDisplayName(normalizedOfficialClassics.get(normalizedName)?.name ||
    normalizedVerifiedSupplements.get(normalizedName)?.name ||
    normalizedCatalog.get(normalizedName)?.name ||
    normalizedName);
}

/**
 * Resolve formula names from natural language against the governed local catalog. The model's
 * prose is never treated as an identifier: only catalog-backed, longest non-overlapping matches
 * become references used by the M03 -> M04 contract.
 */
export function identifyKnownFormulaNames(value: string): string[] {
  const clauses = value
    .replace(/(?<!不)(?=(?:但|而)?(?:改用|改予|转用|换用|首选|建议(?:采用|使用)))/g, "；")
    .split(/[。；;\n]+/)
    .map((item) => normalizeFormulaName(item))
    .filter(Boolean);
  const matches = clauses.flatMap((normalized) => knownFormulaMatches(normalized)
    .filter((match) => {
      const localPrefix = normalized.slice(Math.max(0, match.start - 18), match.start);
      const localSuffix = normalized.slice(match.start + match.name.length, match.start + match.name.length + 18);
      if (formulaNameIsVerbPhrase(match.name, normalized.slice(match.start + match.name.length))) return false;
      const selfDevisedPrefix = /(?:自拟|经验方|协定方|院内方|辨证组方)[^汤散丸饮丹膏]{0,4}$/.test(localPrefix);
      const negativePrefix = /(?:不建议(?:使用|采用)?|不推荐|不宜|不应|不用|不使用|不采用|不予(?:使用|采用|选用)?|不得(?:使用|采用|选用)?|不可(?:使用|采用|选用)?|严禁(?:使用|采用|选用)?|禁忌(?:使用|采用|选用)?|禁用|禁止|忌用|勿用|排除|暂缓|暂停|停用|避免|不选|不考虑|不作为|仅作|仅用于|仅供)[^汤散丸饮丹膏]{0,10}$/.test(localPrefix);
      const negativeSuffix = /^(?![^汤散丸饮丹膏]{0,12}(?:无|没有|未见)(?:明显|使用)?禁忌)[^汤散丸饮丹膏]{0,12}(?:禁忌(?:方|使用)?|禁用|忌用|(?:应|须|需)?避免(?:继续)?(?:使用|采用|选用)?|不予(?:使用|采用|选用)|不应(?:继续)?(?:使用|采用|选用)|暂停(?:使用|采用|选用)?|停用|严禁(?:使用)?|不得(?:使用)?|不可(?:使用)?|禁止|勿用|不宜|不建议|不推荐|不作为|仅作鉴别|仅用于鉴别|仅供鉴别|排除)/.test(localSuffix);
      return !selfDevisedPrefix && !negativePrefix && !negativeSuffix;
    }));
  return [...new Set(matches
    .slice(0, 4)
    .map((match) => canonicalFormulaDisplayName(match.name)))]
    .slice(0, 4);
}

/**
 * Return a deterministic, catalog-backed composition anchor for an M03 formula reference. This is
 * prompt input, not a prescription: doses still come from the governed herb knowledge and model
 * reasoning, while M04 composition is checked back against the same catalog after generation.
 */
/**
 * 沿用经典方名时的组成保留下限比例（2026-09-27 起可调）。默认 0.8（原口径不变）；
 * `CDSS_FORMULA_COMPOSITION_FLOOR` 取 0.5–0.9。锚点药味（方名药、核心安全药、首味）无论比例如何都必须保留，
 * 比例只决定「锚点之外还要留几味才能继续叫这个方名」。M04 首轮最常见的修复触发就是这一条
 * （formula_reference_declassified，本机 16 次 M04 里 4 次，每次 qwen3.8-max 定向修复 23–27s）。
 */
export function formulaCompositionFloorFraction(): number {
  const value = Number(process.env.CDSS_FORMULA_COMPOSITION_FLOOR || 0.8);
  return Number.isFinite(value) && value >= 0.5 && value <= 0.9 ? value : 0.8;
}

function compilationReference(
  formulaName: string,
  variant: FormulaVariant,
  origin: ResolvedFormulaSource["origin"],
): FormulaCompilationReference {
  // The same canonical, de-duplicated ingredient list is shown to the model and enforced after
  // generation. Raw workbooks can contain alias duplicates; counting those publicly but matching
  // them canonically would create two conflicting 80% thresholds.
  const ingredients = [...new Set(variant.ingredients.map(normalizeHerbName).filter(Boolean))];
  return {
    formulaName,
    source: variant.source,
    ingredients,
    minimumPreservedIngredientCount: Math.min(ingredients.length, Math.max(1, Math.ceil(ingredients.length * formulaCompositionFloorFraction()))),
    requiredIngredients: requiredFormulaAnchors(formulaName, variant, ingredients),
    origin,
  };
}

export function formulaCompilationReferences(names: string[]): FormulaCompilationReference[] {
  return [...new Set(names.map(exactFormulaIdentityName).filter(Boolean))].flatMap<FormulaCompilationReference>((formulaName) => {
    const governed = governedFormulaCompilationRow(formulaName);
    if (!governed) return [];
    const origin = governed.sourceClass === "official_classic_catalog"
      ? "official_classic_catalog"
      : governed.sourceClass === "official_local_formula_standard"
        ? "local_formula_catalog"
        : "verified_reference_catalog";
    return [compilationReference(governed.name, {
      source: governed.source,
      ingredients: compilationIngredients(governed),
    }, origin)];
  });
}


/**
 * 按**组成**反查受治理经典方（甲方 2026-08-05 R1 / M5.1 / M5.2）。
 *
 * 甲方口径：「首选经方名，如确认无对应的经方，走自拟方」；实测投诉是
 * 「该方为麻黄汤加味，展示为自拟方？」。
 *
 * 根因：既有的 restoreGovernedFormulaIdentity 只在 **M03 已锁定方名**时才恢复身份。
 * M03 判自拟（formulaSelectionMode=self_devised）时它整个不进场，于是 M04 即便组出了
 * 麻黄、桂枝、杏仁、甘草这样一张标准麻黄汤，也只能顶着「本例辨证组方」出去——
 * 系统其实认得这个方，只是从来没有按组成回头查过。
 *
 * **判据是「完整包含」，不是 80% 覆盖**。这一点是本函数最容易写错的地方，我第一版就写错了：
 * 直接套用正向的 minimumPreservedIngredientCount（80%）去反查，结果
 *   麻黄、桂枝、苦杏仁、炙甘草、生姜、大枣  →  被识别成「桂枝汤加减」
 * ——桂枝汤五味里命中四味（缺白芍），80% 判据放行。而麻黄汤与桂枝汤正是本仓库
 * formula-discrimination-guard 双向互斥的表实/表虚对：把麻黄汤叫成桂枝汤，
 * 等于把无汗表实证的方冠上有汗表虚证的名，比不识别严重得多。
 *
 * 80% 那条线是为**正向**设计的（已知是 X，删到几味还能叫 X），反向必须收紧：
 * 只有当处方**完整包含**某经方的全部基准药味时，才承认它是该方——这也正是
 * 甲方用词「加味」的含义（只增不减）。缺一味即不认，宁可走自拟方。
 *
 * 另加两条防误报，都是纯计数、不涉临床判断：
 *  · 基准方至少 3 味：否则「甘草汤」「独参汤」这类单味方会命中任何含该药的处方；
 *  · 增味数不得超过基准味数：麻黄汤（4 味）+2 味仍是麻黄汤加味，+9 味就不是了。
 */
export type CompositionIdentifiedFormula = {
  formulaName: string;
  source: string;
  matchedCount: number;
  baselineCount: number;
  missingIngredients: string[];
  extraIngredients: string[];
  /** canonical=组成与基准一致；加味=只增不减；加减=有增有减或有减。 */
  modificationKind: "canonical" | "加味" | "加减";
  displayName: string;
  /** 该方的受控基准组成（身份归一后）。仅供候选排序判定「组成孪生」，不对外表达语义。 */
  baselineComposition: string[];
  /** 归一**之前**与处方逐字相同的味数。仅供孪生条目定序，不参与任何临床判定。 */
  literalMatchCount: number;
};

const compositionIdentityCache = new Map<string, string>();

/**
 * 两侧统一到「去炮制的受治理正名」。
 *
 * 两层都必需，缺一就漏识（实测）：
 *  · 别名层：目录写「杏仁」而处方写「苦杏仁」，靠受治理身份解析统一；
 *  · 炮制层：目录写「甘草」而处方写「炙甘草」，受治理解析把两者都判为 exact_standard_name、
 *    各自成名，必须再剥一层炮制前缀才能对上。麻黄汤就是卡在这一层——
 *    库里是〔麻黄、桂枝、甘草、杏仁〕，临床开的是〔麻黄、桂枝、苦杏仁、炙甘草〕。
 *
 * 剥炮制只用于**方剂身份判定**。剂量、毒性、煎法一律仍按处方原样的炮制品走，
 * 那些地方生甘草与炙甘草不是一回事，绝不可共用这里的归一结果。
 */
/** 组成身份名（去炮制前缀 / 归一异名到药典标准名）。导出供构建期生成器复用——
 * 核心药生成物必须与运行时用同一个身份函数，否则两边对「黄芩片 vs 黄芩」的判断会分叉，
 * 生成的核心药名在运行时根本对不上（实测：接入生成物后反而多出 10 例误判）。 */
export function compositionIdentityName(value: string): string {
  const normalized = normalizeHerbName(value);
  if (!normalized) return "";
  const cached = compositionIdentityCache.get(normalized);
  if (cached !== undefined) return cached;
  const resolution = resolveGovernedTcmHerbIdentity(normalized);
  const canonical = normalizeHerbName(
    resolution.doseCanonicalName || resolution.canonicalName || normalized,
  );
  // 前缀集合刻意宽于 PROCESSING_IDENTITY_ALIASES：那张表是「保留炮制身份」用的，
  // 这里是「判定是不是同一味药」用的，两者的正确宽度不同。
  //
  // 只剥前者时，药典正式收载的饮片规格整批对不上：法半夏/姜半夏/清半夏（药典各自成条目）、
  // 蜜麻黄（麻黄项下蜜炙法规格）、制川乌/制草乌/制天南星/淡附子/黑附子。
  // 实测代价不是「少认一张方」：
  //   〔蜜麻黄、桂枝、甘草、杏仁、生姜、大枣〕→「桂枝去芍药汤加味」
  // 一张**无汗表实**的组成被冠上**有汗表虚**的方名，而写「麻黄」时正确出「麻黄汤加味」。
  // formula-discrimination-guard 双向互斥钉的就是这一对，它钉的是「麻黄」这个写法。
  const processingPrefixes = [...new Set([
    ...Object.keys(PROCESSING_IDENTITY_ALIASES),
    ...Object.values(PROCESSING_IDENTITY_ALIASES),
    "蜜炙", "麸炒", "土炒", "盐炒", "酒炒", "醋炒", "姜炒",
    "蜜", "法", "清", "仙", "淡", "黑", "煨", "煅", "焦", "熟", "明", "漂", "胆", "炮", "制", "姜", "生",
  ])].sort((left, right) => right.length - left.length);
  // 后缀同理：巴豆霜→巴豆、半夏曲→半夏、大黄炭→大黄。
  const processingSuffixes = ["炭", "霜", "曲"];
  /** 剥出来的名字必须是**受治理正名**才采纳——否则「天花粉」会被剥成不存在的「天花」。 */
  const acceptStripped = (candidateName: string): string | undefined => {
    if (!candidateName || candidateName.length < 2) return undefined;
    const governed = resolveGovernedTcmHerbIdentity(candidateName).canonicalName;
    return governed ? normalizeHerbName(governed) : undefined;
  };
  let base = canonical;
  for (let guard = 0; guard < 3; guard += 1) {
    let next: string | undefined;
    for (const prefix of processingPrefixes) {
      if (!base.startsWith(prefix) || base.length <= prefix.length + 1) continue;
      next = acceptStripped(base.slice(prefix.length));
      if (next) break;
    }
    if (!next) {
      for (const suffix of processingSuffixes) {
        if (!base.endsWith(suffix) || base.length <= suffix.length + 1) continue;
        next = acceptStripped(base.slice(0, base.length - suffix.length));
        if (next) break;
      }
    }
    if (!next || next === base) break;
    base = next;
  }
  const result = base || canonical;
  compositionIdentityCache.set(normalized, result);
  return result;
}

/**
 * 候选排序。第一判据不是「谁匹配得多」，而是**增味里有没有安全定性药味**。
 *
 * 实测反例：麻黄、桂枝、苦杏仁、炙甘草、生姜、大枣
 *   · 读作「麻黄汤 + 生姜大枣」——正确，甲方原话就是「该方为麻黄汤加味」；
 *   · 也可读作「桂枝去芍药汤 + 麻黄苦杏仁」——基准味数与增味数完全相同，纯计数分不出来。
 * 但把**麻黄**当成一味普通「增味」是不成立的：它是 CORE_SAFETY_HERBS 之一，
 * 加它等于改变全方的性质与适应证（表实 vs 表虚），而这正是本仓库
 * formula-discrimination-guard 双向互斥的那一对。因此增味里含安全定性药味的候选一律靠后。
 */
function compositionCandidateOutranks(
  candidate: CompositionIdentifiedFormula,
  incumbent: CompositionIdentifiedFormula,
): boolean {
  const safetyExtras = (item: CompositionIdentifiedFormula) =>
    item.extraIngredients.filter((name) => isCoreSafetyHerbName(name)).length;
  const candidateSafety = safetyExtras(candidate);
  const incumbentSafety = safetyExtras(incumbent);
  if (candidateSafety !== incumbentSafety) return candidateSafety < incumbentSafety;
  // 组成孪生的定序：谁的药名与处方**逐字相同**得更多谁优先。
  // 处方写「法半夏」时 `法半夏厚朴汤` 应胜过 `半夏厚朴汤`；两者都对不上（写「蜜麻黄」）时
  // 本项相等，退回归一后的判据。放在安全定性药之后、缺增味数之前：
  // 它只在「安全性一样」的候选之间起作用，不会把带安全增味的候选顶上来。
  if (candidate.literalMatchCount !== incumbent.literalMatchCount) {
    return candidate.literalMatchCount > incumbent.literalMatchCount;
  }
  // 缺得少的优先。同层内（两者都来自兜底层）这一项才会真正起作用。
  if (candidate.missingIngredients.length !== incumbent.missingIngredients.length) {
    return candidate.missingIngredients.length < incumbent.missingIngredients.length;
  }
  if (candidate.extraIngredients.length !== incumbent.extraIngredients.length) {
    return candidate.extraIngredients.length < incumbent.extraIngredients.length;
  }
  if (candidate.baselineCount !== incumbent.baselineCount) {
    return candidate.baselineCount > incumbent.baselineCount;
  }
  // 组成**逐味相同**的孪生条目（桂枝汤 vs 桂枝加桂汤，只差桂枝用量；左归饮 vs 右归饮，
  // 后者被目录录漏了杜仲/肉桂/附子）在这里分不出高下，只能落到下面的稳定字典序。
  //
  // 试过两条 tie-break，全目录对拍都是净负，已排除，别再走这两条路：
  //  · 「谁不带『加/去/合』谁优先」——「小半夏加茯苓汤」这类名字里本来就带「加」的正名，
  //    会被组成不同、计数恰好相同的「消暑丸」顶掉；
  //  · 「谁名字短谁优先」——「六味地黄丸」被改判成「虚验方」、「七味都气丸」被改判成「都气丸」。
  // 名字长短与修饰字都不是「哪个是正名」的可靠信号。这是**目录数据缺陷**，
  // 修法在构建期（孪生条目要么合并、要么补足区分性组成），不在排序判据里。
  // 减味兜底层遇到孪生直接不命名（见 hasCompositionTwin），第一层维持既有行为。
  // 稳定排序：同一处方两次调用必须得到同一方名，否则医生无从复核。
  return candidate.formulaName.localeCompare(incumbent.formulaName) < 0;
}

/**
 * 身份承载药（核心药）：缺了它就不再是这张方，因此**减味兜底层一味都不许少**。
 *
 * 与 requiredFormulaAnchors 的区别：那个是给正向核验用的锚点，含 `ingredients[0]`
 * ——第一味只是目录里的排序偶然，不是临床意义上的核心药，拿它当「不可减」会把
 * 大量本可识别的加减方挡在门外。这里只取三类**有理由**的：
 *  1) 方名承载药（麻黄汤的麻黄、桂枝汤的桂枝）——名字就是它，减掉即名不副实；
 *  2) 安全定性药（附子/乌头/半夏/麻黄…）——它们决定全方性质，加减都改变方义；
 *  3) 目录已人工裁定的 requiredIngredients。
 */
function compositionCoreIdentityNames(row: GovernedFormulaCompilationRow): Set<string> {
  const generated = (coreHerbsJson.formulas as Record<string, { core?: string[] } | undefined>)[row.name];
  if (generated?.core) return new Set(generated.core.map(compositionIdentityName).filter(Boolean));
  // 目录里新增、生成物还没跟上的条目：退回运行时可算的两条判据，绝不当作「全部可减」。
  const normalizedFormulaName = normalizeFormulaName(row.name);
  const core = new Set<string>();
  for (const raw of row.ingredients) {
    const identity = compositionIdentityName(raw);
    if (!identity) continue;
    const nameBearing = equivalentHerbIdentityNames(raw).some((alias) =>
      alias.length >= 2 && normalizedFormulaName.includes(alias)
    );
    // 谓词按基原判，加进 core 的仍是目录 identity（姜半夏），两者不可互换——见 isCoreSafetyHerbName。
    if (nameBearing || isCoreSafetyHerbName(identity)) core.add(identity);
  }
  return core;
}

/**
 * 目录里混着一批**不是方名的方名**：章节标题、编者批注被当成条目抽了进来
 * （「治方」「治方并方」「备用成方」「又洗方」「虚验方」…）。它们组成合法、
 * 也能参与匹配，但把「治方加减」写给医生毫无意义，比不给名字更糟。
 *
 * 只在减味兜底层拦——第一层是完整包含，即便名字难看也确实是那张方的原样组成，
 * 维持既有行为不动；兜底层是新增能力，不该把数据缺陷一并放出去。
 * 真正的修法在目录构建期（identityLockEligible 应排除这些条目），此处是运行时兜底，
 * 名单来自全目录对拍实测到的真实条目，不是猜的。
 */
const NON_FORMULA_CATALOG_NAME =
  /^(?:治方(?:并方)?|备用成方|又?洗方|虚?验方|极验方|附方|方)$|^治[^，。]{3,}方$/;

/**
 * 组成完全相同、名字不同的「孪生条目」——按组成反查在原理上分辨不了它们。
 *
 * 两种来源：
 *  · 目录数据缺陷：右归饮被录成了左归饮的组成（少杜仲/肉桂/附子），于是补阴方与补阳方
 *    在组成上一模一样。这类必须回目录修，不是运行时能判的。
 *  · 真的只差剂量：桂枝汤 vs 桂枝加桂汤，组成同、桂枝用量不同。
 *
 * 减味兜底层遇到孪生一律不命名。理由是这一层本来就是「今天什么都认不出」的场景，
 * 对照物是「没有名字」而不是「更准的名字」；在分辨不了的时候猜一个，可能把补阴写成补阳。
 * 第一层（完整包含）维持既有行为不动——那里的歧义是既有问题，另行回目录修。
 */
const compositionSignatureNames = new Map<string, Set<string>>();
for (const row of governedFormulaCompilationRows) {
  const signature = [...new Set(compilationIngredients(row).map(compositionIdentityName).filter(Boolean))]
    .sort().join("|");
  if (!signature) continue;
  const names = compositionSignatureNames.get(signature) || new Set<string>();
  names.add(normalizeFormulaName(row.name));
  compositionSignatureNames.set(signature, names);
}
function hasCompositionTwin(ingredients: string[], formulaName: string): boolean {
  const names = compositionSignatureNames.get([...ingredients].sort().join("|"));
  if (!names || names.size <= 1) return false;
  return [...names].some((name) => name !== normalizeFormulaName(formulaName));
}

/** 兜底层允许缺的味数上限：至多 1 味，且不超过基准的 20%（即基准 ≥5 味才可能减）。 */
function relaxedMissingAllowance(baselineCount: number): number {
  return Math.min(1, Math.floor(baselineCount * 0.2));
}

export function identifyGovernedFormulaByComposition(
  herbs: ReadonlyArray<FormulaHerbInput>,
): CompositionIdentifiedFormula | undefined {
  const actual = [...new Set(
    herbs.map((herb) => formulaHerbIdentityName(herb)).filter(Boolean).map(compositionIdentityName).filter(Boolean),
  )];
  const actualSet = new Set(actual);
  if (actualSet.size < 3) return undefined;

  // 两层，**不互相竞争**：
  //  第一层 完整包含（原判据，一字未改）——今天能认对的，行为逐字节不变；
  //  第二层 减味兜底——**仅当第一层一个候选都没有时**才启用。
  //
  // 为什么必须分层而不是放宽阈值：上一轮就是把正向的 80% 覆盖线套到反查上，结果
  // 麻黄汤被识别成「桂枝汤加减」（表实/表虚互斥对，冠错名比不识别严重得多）。
  // 分层保证放宽只发生在「今天什么都认不出、医生看到的是『本例辨证组方』」的场景，
  // 那里的对照物不是「更准的名字」，而是**没有名字**。
  //
  // 全目录实测（2593 张可测方，逐方去掉一味非核心药 + 加两味佐药模拟加减方）：
  //   现判据    加减方识别 94 张（3.7%）
  //   分层兜底  加减方识别 1778 张（69%），真误判 21 张（0.8%），且原方识别 0 变化
  // 放到「缺≤2 且 ≤25%」召回只多 12%，误判却翻三倍（67 张），故取「缺≤1 且 ≤20%」。
  // 归一（剥炮制前后缀）之前的原样药名集合。用途只有一个：**同组成孪生条目的定序**。
  // 目录里存在大量逐味相同、只差方名的条目（丁香柿蒂汤/散、八珍汤/散、半夏厚朴汤/法半夏厚朴汤），
  // 归一让更多条目变成「组成相同」，孪生碰撞随之增多，此时按字典序挑等于掷骰子。
  // 「谁的药名与处方逐字相同得更多」是本函数手上唯一还剩的信息，也确实是对的信息：
  // 处方写「法半夏」时 `法半夏厚朴汤` 比 `半夏厚朴汤` 更贴，写「蜜麻黄」时两者都不贴、
  // 才该退回归一后的匹配（麻黄汤）。
  const rawActualSet = new Set(
    herbs.map((herb) => formulaHerbIdentityName(herb)).filter(Boolean).map(normalizeHerbName).filter(Boolean),
  );
  const exact: CompositionIdentifiedFormula[] = [];
  const relaxed: CompositionIdentifiedFormula[] = [];
  for (const row of governedFormulaCompilationRows) {
    // 按组成**反查命名**只用常用层（官方标准方、古代经典名方目录、≥3 个现代医案；2026-09-29 甲方测评 2.5）。
    // 冷僻条目组成常录入不全（益气培元饮原书 12 味、目录只录 6 味），被整包含后顶着「某方加味」出去，
    // 方名一换，出处与主治就跟着错（阴虚腰痛例被冠以主治肾虚遗浊的方名）。与 M03 锁定同一个分层谓词；
    // CDSS_FORMULA_LOCK_TIER=false 时一并回退。M04 编译与方名核验仍读全目录，不受影响。
    if (formulaLockTierEnabled() && !formulaInCommonTier(row)) continue;
    const rawIngredients = compilationIngredients(row).map(normalizeHerbName).filter(Boolean);
    const literalMatchCount = rawIngredients.filter((name) => rawActualSet.has(name)).length;
    const ingredients = [...new Set(compilationIngredients(row).map(compositionIdentityName).filter(Boolean))];
    if (ingredients.length < 3) continue;
    const matched = ingredients.filter((name) => actualSet.has(name));
    const missing = ingredients.filter((name) => !actualSet.has(name));
    const extras = actual.filter((name) => !ingredients.includes(name));
    // 增味不得超过基准味数，否则「某经方 + 一大把药」也会顶着经方名出去。
    if (extras.length > ingredients.length) continue;

    if (missing.length === 0) {
      if (ingredients.length > actualSet.size) continue;
      exact.push({
        formulaName: row.name,
        source: row.source,
        matchedCount: ingredients.length,
        baselineCount: ingredients.length,
        missingIngredients: [],
        extraIngredients: extras,
        modificationKind: extras.length === 0 ? "canonical" as const : "加味" as const,
        displayName: extras.length === 0 ? row.name : `${row.name}加味`,
        baselineComposition: ingredients,
        literalMatchCount,
      });
      continue;
    }
    if (missing.length > relaxedMissingAllowance(ingredients.length)) continue;
    if (matched.length < 3) continue;
    if (NON_FORMULA_CATALOG_NAME.test(normalizeFormulaName(row.name))) continue;
    if (hasCompositionTwin(ingredients, row.name)) continue;
    // 核心药一味都不许缺——这是兜底层与「放宽阈值」的根本区别。
    const core = compositionCoreIdentityNames(row);
    if ([...core].some((name) => !actualSet.has(name))) continue;
    relaxed.push({
      formulaName: row.name,
      source: row.source,
      matchedCount: matched.length,
      baselineCount: ingredients.length,
      missingIngredients: missing,
      extraIngredients: extras,
      modificationKind: "加减" as const,
      displayName: `${row.name}加减`,
      baselineComposition: ingredients,
      literalMatchCount,
    });
  }

  const pool = exact.length > 0 ? exact : relaxed;
  let best: CompositionIdentifiedFormula | undefined;
  for (const candidate of pool) {
    if (!best || compositionCandidateOutranks(candidate, best)) best = candidate;
  }
  return best;
}

export function executableFormulaCompilationReferences(names: string[]): FormulaCompilationReference[] {
  return formulaCompilationReferences(names).filter((reference) => {
    const governed = governedFormulaCompilationRow(reference.formulaName);
    if (!governed?.doseCompilationEligible) return false;
    return reference.ingredients.every((name) => {
    const clinicianClass = clinicianDoseHerbClass(name);
    if (clinicianClass === "controlled_or_toxic" || clinicianClass === "endangered_or_banned") return false;
    // 「由医师确定用量」类成分不阻断整方编译（甲方决策：降低门禁、审方兜底）。
    // 它们在处方里按类别标注核验级别，用量由医师确定；系统不替它们担保剂量。
    if (isClinicianDoseHerb(name)) return true;
    const resolution = resolveGovernedTcmHerbIdentity(name);
    const doseIdentity = resolution.doseCanonicalName || resolution.canonicalName || name;
    const limit = getTcmHerbDoseLimit(doseIdentity);
    return isKnownTcmHerbName(doseIdentity) && limit?.min != null && limit?.max != null;
    });
  });
}

/** Names whose governed formula identity is valid but whose full composition lacks an executable
 * numeric dose boundary. They may remain visible as a formula direction, but cannot enter M04 dose
 * generation until the missing identities/boundaries are adjudicated in T8/T9. */
export function formulaNamesWithoutExecutableDoseCompilation(names: string[]): string[] {
  const executable = new Set(executableFormulaCompilationReferences(names).map((item) => item.formulaName));
  return [...new Set(names.map((name) => governedFormulaCompilationRow(name)?.name).filter((name): name is string => Boolean(name)))]
    .filter((name) => !executable.has(name));
}

export function formulaCompilationContractIssue(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  prior: ClinicalReasoningResultV2 | null | undefined,
  trustedWorkbenchEdit = false,
  allowTransparentDeclassification = true,
  /** 本例不宜的药（herbBarredForCase 按本例接地正文判）；锁定方组成里有这样的药时，透明降级为辨证组方直接受理。 */
  barredForCase?: (herb: string) => boolean,
): string | undefined {
  const candidate = reasoning?.formula?.candidates?.[0];
  if (!reasoning || reasoning.stage !== "prescribe" || !candidate || !prior || prior.stage !== "diagnose") {
    return "formula_compilation_contract_missing";
  }
  if (trustedWorkbenchEdit && candidate.constructionType === "self_devised" &&
    candidate.modificationStatus === "modified" && /医生编辑版/.test(candidate.name)) {
    return undefined;
  }
  const governedNames = prior.overview.recommendedFormulaNames || [];
  const mode = prior.overview.formulaSelectionMode || "none";
  const candidateNames = candidate.formulaNames || [];
  if (mode === "none" || mode === "self_devised") {
    if (candidateNames.length === 0) return undefined;
    // 服务端自己按组成反查补回的身份必须被自己认得（见 isCompositionRestoredGovernedIdentity）。
    // 这是 formula_direction_drift 的**第二个产地**，与 diagnosis-stage-contract 那处共用同一谓词——
    // 同一条判据两处各写各的，正是本仓库反复付代价的形状。
    if (isCompositionRestoredGovernedIdentity(candidate, governedNames, mode)) return undefined;
    if (isSignedTextbookFormulaIdentity(candidate, prior)) return undefined;
    return "formula_direction_drift";
  }
  const references = formulaCompilationReferences(governedNames);
  if (references.length !== governedNames.length) return "formula_reference_ambiguous";
  // M03 names are a recommended formula direction, not permission to attach a classic identity
  // to a different composition. enrichReasoning deliberately declassifies a candidate to the
  // transparent self-devised label when its actual herbs cannot satisfy the governed baseline.
  // Keep that clinically usable candidate and omit the unsupported classic source instead of
  // discarding the whole prescription after repeated model retries.
  const declassifiedSelfDevised = candidateNames.length === 0 &&
    candidate.constructionType === "self_devised" &&
    /^(?:本例辨证组方|辨证组方)(?:加减)?$/.test(candidate.name.trim());
  if (declassifiedSelfDevised) {
    // 组成实测满足 M03 锁定基准时，这不是「冒用方名」也不是「组成不符」，只是模型把标签写保守了。
    // 此时驳回是自相矛盾的：修复提示明写两条路径（采用基准组成／放弃方名身份），而这里对路径二
    // 无条件返回 declassified，等于模型无论走哪条都被拒 —— 实测（感冒-风寒束表，M03 锁麻黄汤）
    // 第一轮 1/4 组成不符被正确驳回，第二轮改出完整麻黄汤四味并按提示降级标签，仍被判
    // declassified，随即 identical-guidance fixpoint，整方 0 味。
    //
    // 方名身份本就归服务端裁定（enforceRetrievedM03FormulaSelection / applyDeterministicFormulaReferences
    // 都在做同一件事）：既然基准组成核验由服务端自己跑通，这份身份比模型声称的更可靠，
    // 应当放行并在渲染阶段确定性补回方名与出处，而不是丢弃一张正确的方。
    // 边界未放宽：核验仍走同一个 verifyFormulaCompilationComponent（锚点药、最低保留数、
    // 合方/加减语义一条不减）；核验不通过时行为与此前完全一致。
    const declassifiedButMatchesBaseline = references.length > 0 &&
      references.every((reference) =>
        verifyFormulaCompilationComponent(reference, candidate.herbs, mode === "combined", true).verified);
    if (declassifiedButMatchesBaseline) return undefined;
    // 只靠「信任模型选方」保留的方名是推荐方向，不是受控关系核验过的身份：M04 透明降级为辨证组方
    // 直接受理，不再为「必须沿用」白跑一轮 qwen3.8-max 修复（9/27 本机：强制时组成修复 29/65、M04 中位 37s）。
    if (lockedFormulaNamesIncludeModelTrustedOnly(prior, governedNames)) return undefined;
    // 锁定方原组成里就有十八反（洗心汤、附子粳米汤的附子与半夏；目录 2,529 首可编译方里 29 首，24 首两味都是锚点药）：
    // 照原方开必含相反药，去掉一味又够不上组成身份下限。提示词让模型去一味、改按辨证组方命名，这里直接受理（2026-10-24 甲方 100 例 C057）。
    if (references.some((reference) => findTcmHerbPairIncompatibilities(reference.ingredients).length > 0)) return undefined;
    // 锁定方原组成里有药典孕妇禁用的药（香棱丸的三棱、莪术）：备孕、妊娠状态未记录的育龄女性按提示词去掉这几味、改按辨证组方命名，同样受理
    //（2026-10-24 第十七轮；没有这一档的病例模型不会去掉它们，这里只放行「已透明降级」这一种写法）。
    if (references.some((reference) => reference.ingredients.some((herb) => chpPregnancyLabel(herb)?.level === "prohibited"))) return undefined;
    // 锁定方组成里有本例不宜的药（第二十三轮：胎盘早剥、活动性出血时锁定少腹逐瘀汤，君药延胡索、川芎是活血化瘀药）：
    // 开方核对一定拦下这几味，照原方开不出来；提示词让模型去掉、改按辨证组方命名，这里受理。判据只认本例（按接地正文），不是所有含这类药的方。
    if (barredForCase && references.some((reference) => reference.ingredients.some((herb) => barredForCase(herb)))) return undefined;
    // Provider generation gets a chance to honour an M03-governed classic baseline. Transparent
    // declassification remains a valid final safety fallback, but accepting it during provider
    // validation would suppress the targeted composition repair entirely.
    return allowTransparentDeclassification ? undefined : "formula_reference_declassified";
  }
  const selectedReferences = mode === "alternatives"
    ? references.filter((item) => candidateNames.includes(item.formulaName))
    : references;
  if (selectedReferences.length !== candidateNames.length || selectedReferences.length === 0) {
    return "formula_reference_selection_drift";
  }
  const combined = mode === "combined";
  const explicitlyModified = /(?:加减|化裁|加味)/.test(candidate.name);
  const herbNames = candidate.herbs.map((herb) => formulaHerbIdentityName(herb)).filter(Boolean);
  const baseAliases = formulaHerbBaseAliases(candidate.herbs);
  if (mode === "alternatives") {
    const actualHerbs = new Set([
      ...herbNames.map(normalizeHerbName).filter(Boolean),
      ...baseAliases.values(),
    ]);
    // 未选中的备选方若组成本就被已选方覆盖（小半夏汤「法半夏、生姜」⊂ 旋覆代赭汤），候选「完整包含」它
    // 是选用已选方的必然结果，不是改换方剂。线上 10/9–10/10：旋覆代赭汤加减 7/7 核验通过，仍因含
    // 小半夏汤 3 次判 composition_drift，修复两轮不收敛，方名被剥成自拟方。炮制品按组成身份归一比对
    // （法半夏/姜半夏 → 半夏），与正向核验同一谓词。未被覆盖的备选方（加丁香、柿蒂凑成丁香柿蒂汤）照常判漂移。
    const selectedIdentity = new Set(selectedReferences.flatMap((reference) =>
      reference.ingredients.map((ingredient) => compositionIdentityName(normalizeHerbName(ingredient)))));
    const containsCompleteUnselectedBaseline = references
      .filter((reference) => !candidateNames.includes(reference.formulaName))
      .filter((reference) => !reference.ingredients.every((ingredient) =>
        selectedIdentity.has(compositionIdentityName(normalizeHerbName(ingredient)))))
      .some((reference) => reference.ingredients.every((ingredient) => actualHerbs.has(normalizeHerbName(ingredient))));
    if (containsCompleteUnselectedBaseline) return "formula_compilation_composition_drift";
  }
  const componentVerifications = selectedReferences.map((reference) =>
    verifyFormulaCompilationComponent(reference, candidate.herbs, combined, explicitlyModified));
  const failedComponentIndex = componentVerifications.findIndex((item) => !item.verified);
  if (failedComponentIndex < 0) return undefined;

  // 中间档:核心保留但有增减 ⇒ 应记为「X 加减」,不是作废(2026-08-05)。
  //
  // 原实现只有两档:组成一字不差(explicitlyModified=false 时要求 recall 与 precision 均 ≥0.999),
  // 否则整个方名被剥离、退化成「本例辨证组方」。但中医的**加减本来就意味着组成会变**,
  // 把它与「核心已不成立」同等处置,等于否认加减这一临床常规。
  //
  // 线上实测(风热犯表证):模型给出 金银花 连翘 薄荷 荆芥 桔梗 牛蒡子 淡竹叶 芦根 甘草
  // ——这就是银翘散加减(略淡豆豉、加芦根,均为临床常规),药味本身全部通过剂量与配伍校验,
  // 正文里也两次提到银翘散;但因为模型把方名写成「银翘散」而非「银翘散加减」,
  // 走了严格分支 recall=8/9=0.89 未达 0.999 ⇒ 方名整体作废。
  // 医生因此看到「本例辨证组方」,不知道这其实是银翘散——线上语料 60 例里自拟方占 74%,
  // 主因就在这里:**不是召不回方,是方名被剥掉了**。
  //
  // 中间档的判据不新增:直接复用同一验证函数的 explicitlyModified=true 分支
  // (identityFloor ≥80% 保留 + 全部锚定药味在场 + precision ≥0.35)。
  // 也就是说——**只有当这张方按「加减」标准都不成立时,才谈得上作废**。
  // 返回专用码而非 undefined:调用方据此把方名规范为「X 加减」,而不是当作完全合格放行。
  if (!explicitlyModified) {
    const asModified = selectedReferences.map((reference) =>
      verifyFormulaCompilationComponent(reference, candidate.herbs, combined, true));
    if (asModified.every((item) => item.verified)) return "formula_name_requires_modified_suffix";
  }
  if (combined) return `formula_component_${failedComponentIndex}_unverified`;
  // The signed M03 contract binds every selected name to one governed compilation reference.
  // Same-name historical variants remain searchable as evidence, but cannot replace that baseline
  // during automatic M04 generation because another formula may share most of the short variant.
  // A mismatched composition must be repaired or transparently declassified as self-devised.
  return "formula_compilation_composition_drift";
}

function formulaSelectionMode(value: string, names: string[]): NonNullable<ClinicalReasoningResultV2["overview"]["formulaSelectionMode"]> {
  if (names.length === 0) {
    return /(?:自拟|经验方|协定方|院内方|辨证组方)/.test(value) ? "self_devised" : "none";
  }
  if (names.length === 1) return "single";
  const normalized = normalizeFormulaName(value);
  const matches = knownFormulaMatches(normalized)
    .filter((match) => names.some((name) => normalizeFormulaName(name) === match.name))
    .sort((a, b) => a.start - b.start);
  const relationText = matches.slice(0, -1).map((match, index) =>
    normalized.slice(match.start + match.name.length, matches[index + 1].start)
  ).join("|");
  const last = matches[matches.length - 1];
  const trailing = last ? normalized.slice(last.start + last.name.length) : "";
  if (/(?:或|任选|二选一)/.test(relationText) || /^(?:酌情选用|酌选|任选|二选一)/.test(trailing)) return "alternatives";
  if (/(?:合方|联合|合|与)/.test(relationText)) return "combined";
  // An unqualified list must not silently authorize a combined prescription.
  return "alternatives";
}

/**
 * 推荐方跟着已定的教材证型走（2026-10-13，甲方 10.12 测评 4.1「心胆气虚用酸枣仁汤」「方名前后不一致」）。
 *
 * 模型定下的病名、证名能对上教材的一行，而且该行的代表方目录里都能唯一锁定时，推荐方就是该行的代表方
 *（教材写两方合用的按合方）。模型写的方向里已经包含这些方名时原样保留它的写法。
 * 对不上教材、或代表方目录锁不住时，不改模型写的方向——那时仍按原有口径处理。
 * 这一步只决定方名；药味、剂量、十八反、妊娠等核对一条不少，照旧在开方阶段进行。
 */
type TextbookConditionalBranch = { condition: string; method: string; formula?: string };

/**
 * 教材按阴阳/气血偏颇分列治法与代表方的一行（「偏肾阴虚者，宜滋阴益肾；偏阳虚者，宜温肾固摄」「偏肾阴虚者，用知柏地黄丸；
 * 偏肾阳虚者，用鹿茸补涩丸」，《中医内科学》尿浊·肾虚不固证）。治法句的每一段都是「偏…者…」时才算；方名按段对上。
 */
/**
 * 教材治法栏能直接锚进「治法」的部分：一串治法短语（「辛温解表，宣肺散寒」）。教材有的格子后面接着讲处置或分情况
 * （异位妊娠·气血亏脱证「益气止血固脱。此证为腹腔内出血所致，首应及时手术止血治疗。术后再辅以益气养血，活血化瘀治疗」），
 * 整格照抄后治法栏成了一段叙述，活动性出血的病例还写进了「活血化瘀」（2026-10-27 第二十四轮生产探针 A-eme-0028/0342、
 * 本机同样）。规则：只取第一句里打头的那串治法短语；第一句本身是分情况写的（「者」不在最后一项）、或后面某句另是一串治法
 * （「辛温解表，宣肺化痰；辛凉解表，清肺化痰」是二选一）时不锚定，保留模型写的治法。「偏X者…；偏Y者…」由
 * textbookConditionalBranches 另行按病性选段，不走这里。
 */
const TEXTBOOK_METHOD_ITEM_MAX = 8;
function textbookMethodItem(item: string): boolean {
  if (/^以/u.test(item)) return item.length <= 5;
  return item.length <= TEXTBOOK_METHOD_ITEM_MAX && !/[者宜当如或等先再]|治疗|手术/u.test(item);
}
function textbookMethodItems(sentence: string): string[] {
  return sentence.split(/[，,、]/u).map((item) => item.trim()).filter(Boolean);
}
export function textbookAnchorableMethod(therapy: string): string {
  const body = String(therapy || "").trim().replace(/[。；;]+$/u, "");
  const sentences = body.split(/[。；;]/u).map((part) => part.trim()).filter(Boolean);
  if (sentences.length === 0) return "";
  if (sentences.slice(1).some((sentence) => textbookMethodItems(sentence).every(textbookMethodItem))) return "";
  const items = textbookMethodItems(sentences[0]);
  if (items.slice(0, -1).some((item) => item.includes("者"))) return "";
  const kept: string[] = [];
  for (const item of items) {
    if (!textbookMethodItem(item)) break;
    kept.push(item);
  }
  return kept.length === items.length && sentences.length === 1 ? body : kept.join("，");
}

function textbookConditionalBranches(row: { therapy: string; formulaText?: string; formulas: string[] }): TextbookConditionalBranch[] | undefined {
  const parse = (text: string, lead: RegExp) => String(text || "").split(/[；;。]/u).map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const matched = part.match(lead);
      return matched ? { condition: matched[1].trim(), rest: matched[2].trim() } : undefined;
    });
  const therapies = parse(row.therapy, /^偏(?:于)?([^者，,]{1,8})者[，,]?\s*(?:治宜|宜|当|治以)?(.+)$/u);
  if (therapies.length < 2 || therapies.some((item) => !item)) return undefined;
  const formulaParts = parse(row.formulaText || "", /^偏(?:于)?([^者，,]{1,8})者[，,]?\s*(?:宜用|选用|方用|可用|用)?(.+)$/u);
  return therapies.map((item, index) => {
    const formulaPart = formulaParts.find((part) => part && part.condition === item!.condition) || formulaParts[index];
    // 运行时的教材行不带方剂原句（formulaText）时，按教材原句的先后对应：生成器按原文顺序抽方名，段数与方名数相同才对。
    const formula = formulaPart
      ? row.formulas.find((name) => formulaPart.rest.includes(name))
      : row.formulas.length === therapies.length ? row.formulas[index] : undefined;
    return { condition: item!.condition, method: item!.rest.replace(/[。；;]+$/u, ""), ...(formula ? { formula } : {}) };
  });
}

/**
 * 按已签名的病性（病机病性分析的条目与证名）选「偏…者」的那一段：条件末两字（阴虚/阳虚/气虚/血虚）在病性条目或证名里出现、
 * 且只有一段对得上时才选（2026-10-19；RobustSDT-single_0280 病性「阳虚」、形寒肢冷、晨起腹泻，锚定却照抄两段治法并取了
 * 偏阴虚的知柏地黄丸）。对不上或两段都对得上时返回 undefined——不替医生在两种偏颇之间做选择。
 */
function signedConditionalBranch(reasoning: ClinicalReasoningResultV2, branches: readonly TextbookConditionalBranch[]): TextbookConditionalBranch | undefined {
  const pathogenesis = reasoning.pathogenesis as { natureDifferentiation?: { items?: unknown } } | undefined;
  const natureItems = Array.isArray(pathogenesis?.natureDifferentiation?.items)
    ? (pathogenesis!.natureDifferentiation!.items as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const signed = [...natureItems, String(reasoning.overview?.primarySyndrome || "")];
  const matching = branches.filter((branch) => {
    const core = branch.condition.slice(-2);
    return core.length === 2 && signed.some((item) => item.includes(core));
  });
  return matching.length === 1 ? matching[0] : undefined;
}

/**
 * 医生选定了学术流派、模型判本例与该流派相符或部分相符、并写了该流派的方时，不把方名改回教材代表方（2026-10-24）。
 * 甲方 100 例测试集逐例指定诊疗思路（71 例），要看「不同思路是否改变分析重点」；此前教材行一对上，方名一律改回教材代表方，
 * 经方思路下的胸痹仍是血府逐瘀汤、感冒仍是荆防败毒散，流派选择只剩一句适配说明。
 * 保留的条件全部是既有判据：方名是名录里的方（编译目录可核）、至少一首按已核对的流派归属属于所选流派（tcm-formula-lineage-affinity，
 * 与 M03/M04 检索的「流派取向」标注同源）、并通过锁方前的承接核验（trustedModelFormulaIdentityNames：常用层 + 与签名治法同类，
 * 或教材/经方方证正向依据）。任一不满足就照旧改回教材代表方——宁可不体现流派，不让锁不上的方名把处方降成自拟方。
 */
function lineageChosenFormulaDirectionKept(reasoning: ClinicalReasoningResultV2, direction: string, lineagePreference?: string): boolean {
  const preference = String(lineagePreference || "").trim();
  if (!preference || preference === "unrestricted") return false;
  const applicable = (reasoning as { lineageAdaptation?: { applicable?: unknown } }).lineageAdaptation?.applicable;
  if (applicable !== "applicable" && applicable !== "partial") return false;
  const names = identifyKnownFormulaNames(direction);
  if (names.length === 0 || names.length > 2) return false;
  const references = formulaCompilationReferences(names);
  if (references.length !== names.length) return false;
  const inLineage = references.some((reference) => lineageAffinitiesForFormula(reference.formulaName, reference.source)
    .some((affinity) => affinity.adjudicated && affinity.lineageCode === preference));
  if (!inLineage) return false;
  const trusted = trustedModelFormulaIdentityNames(reasoning, names);
  // 选了流派时，目录主治证候与已签名证候相容也算对证的正面依据（治法用词对不上不再否决，治法随后按方改写，见 lineageKeptTherapy）。
  // 只在没有兼证时：治法要改按方写，有兼证时那一项治法会被一并换掉。
  const secondary = reasoning.overview?.secondarySyndromes;
  if (!Array.isArray(secondary) || secondary.filter(Boolean).length === 0) {
    for (const identity of lineageFormulaSyndromeSupportedNames(reasoning, names)) trusted.add(identity);
  }
  return names.every((name) => trusted.has(normalizedFormulaIdentity(name)));
}

/**
 * 按流派保留了模型选的方、而模型写的治法与这首方的功效对不上时（治法照抄了教材行），治法改按这首方在目录里的功效写，
 * 针对主诉主症的那一句（含「止」）接在后面（withSymptomDirectedClause）。对得上时保留模型写的治法。
 * 方与治法不一致，开方阶段按治法核方会把方退成自拟方，医生看到的也是「方是桂枝汤、治法是辛温解表宣肺散寒」。
 */
function lineageKeptTherapy(reasoning: ClinicalReasoningResultV2, direction: string): string {
  const modelMethod = String(reasoning.therapy?.overallMethod || reasoning.overview?.overallTherapy || "");
  const functions = [...new Set(identifyKnownFormulaNames(direction).flatMap((name) => lockableFormulaCatalogFunctions(name)))];
  if (functions.length === 0) return "";
  if (formulaFunctionsPositivelyAligned(functions, signedTherapyMethodIds(reasoning))) return "";
  return withSymptomDirectedClause(functions.join("，"), modelMethod);
}

/**
 * 流派适配说明（lineageAdaptation.influencedDecisions，模型写）与最终交付的方一致（2026-10-24 第十八轮）。
 * 方名由服务端锚定（教材代表方 / 流派方 / 自拟），流派适配说明却是模型在锚定前写的：甲方 100 例里 7 例写着「按经方方证相应选桂枝汤加减」
 *「取八珍汤气血双补」，交付的却是荆防败毒散、圣愈汤。点名了一首最终没有交付的方、又不是在说「不套用/未选」它的那一条，整条去掉；
 * 别的条目（辨证视角、加减风格）与 applicable、applicabilityReason 不动。
 */
const FORMULA_NOT_ADOPTED_CUE = /(?:不|未|非|没有|暂不|而非|不再|弃)[^，。；;、]{0,4}$/u;
// 后置否定：「麻黄汤等方证眼目不符，暂不套用经方名」（C009 交付越婢加术汤）。
const FORMULA_NOT_ADOPTED_AFTER = /^[^，。；;]{0,8}?(?:不符|不合|不相符|不宜|不套|不用|不选|未用|未选|暂不)/u;
export function lineageDecisionsMatchingDirection<T extends ClinicalReasoningResultV2>(reasoning: T, direction: string): T {
  const adaptation = (reasoning as { lineageAdaptation?: { influencedDecisions?: Array<{ aspect?: unknown; detail?: unknown }> } | null }).lineageAdaptation;
  const items = adaptation?.influencedDecisions;
  if (!adaptation || !Array.isArray(items) || items.length === 0) return reasoning;
  const delivered = new Set(identifyKnownFormulaNames(direction).map(normalizedFormulaIdentity));
  const kept = items.filter((item) => {
    const detail = typeof item?.detail === "string" ? item.detail : "";
    return identifyKnownFormulaNames(detail).every((name) => {
      if (delivered.has(normalizedFormulaIdentity(name))) return true;
      const at = detail.indexOf(name);
      return at >= 0 && (FORMULA_NOT_ADOPTED_CUE.test(detail.slice(0, at)) || FORMULA_NOT_ADOPTED_AFTER.test(detail.slice(at + name.length)));
    });
  });
  if (kept.length === items.length) return reasoning;
  return { ...reasoning, lineageAdaptation: { ...adaptation, influencedDecisions: kept } } as T;
}

/**
 * 选了某派时，辨证依据末尾那句眼目句写成了别的流派（2026-10-24 第十八轮线上流派测试：扶阳思路的 C043 写成
 *「温病看卫气营血层次，舌红等温热见证，以下按常规辨证处理」——照抄了提示词的示例）。只认「〈派名〉（学派/思路/派）看/重…」这一句式，
 * 派名不是所选流派的整句去掉；辨证正文里出现的卫气营血、六经等术语不动。不限定流派时不处理。
 */
export function withoutForeignLineageLensSentence<T extends ClinicalReasoningResultV2>(reasoning: T, lineagePreference?: string): T {
  const own = LINEAGE_LENS_SUBJECT[String(lineagePreference || "")];
  const rationale = reasoning.overview?.tcmDiagnosticRationale;
  if (!own || typeof rationale !== "string") return reasoning;
  const foreign = Object.values(LINEAGE_LENS_SUBJECT).filter((name) => name !== own);
  const sentences = rationale.split(/(?<=[。；;])/u);
  const kept = sentences.filter((sentence) => lineageLensSubject(sentence, foreign) === undefined);
  if (kept.length === sentences.length) return reasoning;
  return { ...reasoning, overview: { ...reasoning.overview, tcmDiagnosticRationale: kept.join("").trim() } } as T;
}

function textbookAnchoredFormulaDirection(reasoning: ClinicalReasoningResultV2, lineagePreference?: string): string {
  const direction = String(reasoning.overview?.recommendedFormulaDirection || "");
  const row = textbookRowForSyndrome(String(reasoning.overview?.tcmDiseaseName || ""), String(reasoning.overview?.primarySyndrome || ""));
  if (!row || row.formulas.length === 0 || row.formulas.length > 2) return direction;
  if (lineageChosenFormulaDirectionKept(reasoning, direction, lineagePreference)) return direction;
  const branches = textbookConditionalBranches(row);
  const branch = branches ? signedConditionalBranch(reasoning, branches) : undefined;
  if (branch?.formula) {
    const writtenNames = identifyKnownFormulaNames(direction);
    if (writtenNames.length === 1 && writtenNames[0] === branch.formula) return direction;
    return `${branch.formula}加减`;
  }
  const wanted = row.formulaJoin === "alternative" ? row.formulas.slice(0, 1) : row.formulas;
  const written = identifyKnownFormulaNames(direction);
  if (wanted.every((name) => written.includes(name)) && written.length === wanted.length) return direction;
  return `${wanted.join("合")}加减`;
}

/**
 * 证名用教材的写法：病名对上教材、证名不是教材写法时，按 textbookNearestRow 找到最接近的教材证型并改用它的名字
 *（辨证依据里出现的旧证名一并替换）。找不准就原样返回。
 */
function withTextbookSyndromeName(reasoning: ClinicalReasoningResultV2): ClinicalReasoningResultV2 {
  const overview = reasoning.overview;
  const disease = String(overview?.tcmDiseaseName || "");
  const syndrome = String(overview?.primarySyndrome || "");
  if (!disease || !syndrome || overview?.primarySyndromeResolution === "unresolved") return reasoning;
  const exactRow = textbookRowForSyndrome(disease, syndrome);
  if (exactRow) {
    // 证名只差末尾的「证/证候/型」时用教材行的写法（2026-10-19 第九轮 WP9-F）：甲方标准病历 3 教材写「血虚头痛」，候选里多了一段教材诊断依据后
    // 模型三次里两三次写成「血虚头痛证」，同一病历两次生成的证名字面不同。意思相同，字面按教材。
    const suffix = /(?:证候|证型|证|型)$/u;
    const plain = (value: string) => value.replace(/\s+/gu, "").replace(suffix, "");
    if (exactRow.syndromeName && exactRow.syndromeName !== syndrome && plain(exactRow.syndromeName) === plain(syndrome)) {
      // 教材行比模型写的长一个「证」时，正文里已经带「证」的地方不能再补一次（「血虚头痛证」→「血虚头痛证证」）。
      const escapedSyndrome = syndrome.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const written = new RegExp(`${escapedSyndrome}(?![证型候])`, "gu");
      const renameSuffix = (value: unknown) => typeof value === "string" ? value.replace(written, () => exactRow.syndromeName) : value;
      return {
        ...reasoning,
        overview: {
          ...overview,
          primarySyndrome: exactRow.syndromeName,
          tcmDiagnosticRationale: renameSuffix(overview.tcmDiagnosticRationale) as typeof overview.tcmDiagnosticRationale,
          tcmDiseaseRationale: renameSuffix(overview.tcmDiseaseRationale) as typeof overview.tcmDiseaseRationale,
        },
      };
    }
    return reasoning;
  }
  // 证名与方向正是经方方证表里的一项（太阳中风证 + 桂枝汤加减）：这是方证辨证的写法，不是教材行的近义写法，不改名
  //（2026-10-19，第八轮 WP-A；否则「营卫不和证」「寒热错杂证」这类会被拉到字面最近的教材行，再把治法与方一并锚到那一行）。
  if (jingfangPatternForSignedSyndrome(syndrome, String(overview.recommendedFormulaDirection || ""))) return reasoning;
  const evidence = [
    ...(Array.isArray(overview.primarySyndromeBasis) ? overview.primarySyndromeBasis : []),
    ...(reasoning.pathogenesis?.chain || []).flatMap((node) => [node.patientFact, node.syndromeEvidence]),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("，");
  const locations = (reasoning.pathogenesis?.locationDifferentiation?.items || [])
    .filter((value): value is string => typeof value === "string");
  const row = textbookNearestRow(disease, syndrome, String(reasoning.therapy?.overallMethod || overview.overallTherapy || ""), evidence, locations);
  if (!row || row.syndromeName === syndrome) return reasoning;
  const rename = (value: unknown) => typeof value === "string" ? value.split(syndrome).join(row.syndromeName) : value;
  return {
    ...reasoning,
    overview: {
      ...overview,
      primarySyndrome: row.syndromeName,
      tcmDiagnosticRationale: rename(overview.tcmDiagnosticRationale) as typeof overview.tcmDiagnosticRationale,
      tcmDiseaseRationale: rename(overview.tcmDiseaseRationale) as typeof overview.tcmDiseaseRationale,
    },
  };
}

/**
 * 教材治法里没有针对主症的那一句（「止痛」「止咳」「止泻」…），而模型写的治法里有时，把模型那一句接在教材治法后面（2026-10-18）。
 * 甲方标准病历 3（头痛·血虚头痛证）：十三五《中医内科学》该证治法原文是「滋阴养血」，模型按提示词写了「养血和络止痛」，
 * 锚定后只剩「滋阴养血」，评审按另一版教材（「养血滋阴，和络止痛」）判缺主症方向。提示词本来就要求治法含针对主诉主症的方向
 *（第 8 条），这里不让锚定把它丢掉。只接一句、只接含「止」的那句；教材治法里已有「止」时不接。
 */
export function withSymptomDirectedClause(rowMethod: string, modelMethod: string): string {
  if (!rowMethod || /止/u.test(rowMethod)) return rowMethod;
  const clause = modelMethod.split(/[，,、；;。]/u).map((item) => item.trim())
    .find((item) => /^[\u4e00-\u9fff]{2,8}$/u.test(item) && /止/u.test(item) && !rowMethod.includes(item));
  if (!clause) return rowMethod;
  // 「养血和络止痛」接在「滋阴养血」后面时，开头与教材治法重复的两字（养血）去掉，只接「和络止痛」；「调经止血」接在
  //「清热凉血调经」后面时只接「止血」（2026-10-18 甲方标准病历 10 三次生成里两次写成「清热凉血调经，调经止血」）。
  // 去掉之后剩下的要仍含「止」。
  let tail = clause;
  while (tail.length >= 4 && rowMethod.includes(tail.slice(0, 2)) && /止/u.test(tail.slice(2))) tail = tail.slice(2);
  return `${rowMethod}，${tail}`;
}

/**
 * @param clinicalSourceText 病历原文（接地语料，M03 路径的 structuredClinicalContext）。给了时，锚定的教材治法逐项核对
 *   对症项（止血、安神、开窍…）：病历没有对应表现的项不锚定（therapyWithoutUnsupportedSymptomItems）。不给时与此前完全一致。
 */
/**
 * 本例的安全事实（由调用方按本例接地正文算好传进来，避免本模块反向依赖安全层）。教材锚定遇到它们时不覆盖模型的写法（第二十三轮）：
 *   · activeBleeding：有活动性出血红旗时，教材行的治法若是活血/化瘀/逐瘀而不含止血，不锚定治法（胎盘早剥·瘀血内停证，
 *     教材「活血化瘀，和络止痛」覆盖了按「止血为先」写的治法）；
 *   · barredHerb：教材代表方或锁定方的组成里有本例不宜的药时，不把方向改成那首方，保留模型写的方向。
 */
export type FormulaReferenceCaseSafety = { activeBleeding: boolean; barredHerb: (herb: string) => boolean };
const BLOOD_MOVING_METHOD = /活血|化瘀|逐瘀|祛瘀|散瘀|破血|破瘀/u;
function bloodMovingWithoutHemostasis(method: string): boolean {
  return BLOOD_MOVING_METHOD.test(method) && !/止血/u.test(method);
}
/**
 * 方向里的方对本例是不是「去掉不宜的药就不成其方」：本例不宜的药占该方组成的三分之一以上或达 3 味，或活动性出血时方名本身就是
 * 逐瘀、活血、化瘀、破血一类（少腹逐瘀汤、会厌逐瘀汤）。只去一两味次要药的（四物汤去川芎、仙方活命饮去乳香没药）不算，方名照留，
 * 开方阶段去掉那几味并写明。
 */
function directionBarredForCase(direction: string, reasoning: ClinicalReasoningResultV2, caseSafety: FormulaReferenceCaseSafety): boolean {
  const names = identifyKnownFormulaNames(direction);
  if (names.length === 0) return false;
  const row = textbookRowForSyndrome(String(reasoning.overview?.tcmDiseaseName || ""), String(reasoning.overview?.primarySyndrome || ""));
  return names.some((name) => {
    if (caseSafety.activeBleeding && BLOOD_MOVING_FORMULA_NAME.test(name)) return true;
    const reference = formulaCompilationReferences([name])[0];
    const herbs = [...new Set(reference?.ingredients || (row?.formulas.includes(name) ? row.composition || [] : []))];
    if (herbs.length === 0) return false;
    const barred = herbs.filter((herb) => caseSafety.barredHerb(herb)).length;
    return barred >= 3 || barred * 3 >= herbs.length;
  });
}
const BLOOD_MOVING_FORMULA_NAME = /逐瘀|活血|化瘀|破血|祛瘀|破瘀/u;

export function withDeterministicFormulaReferences(input: ClinicalReasoningResultV2, clinicalSourceText?: string, lineagePreference?: string, caseSafety?: FormulaReferenceCaseSafety): ClinicalReasoningResultV2 {
  const reasoning = input.stage === "diagnose" ? withTextbookSyndromeName(input) : input;
  if (reasoning.stage === "diagnose") {
    const modelDirection = String(reasoning.overview?.recommendedFormulaDirection || "");
    const anchoredDirection = textbookAnchoredFormulaDirection(reasoning, lineagePreference);
    // 教材代表方对本例不宜时不改成它，保留模型写的；模型写的也不宜时，方向改为辨证组方（不再挂一首去掉主药就不成其方的方名）。
    const preferred = caseSafety && anchoredDirection !== modelDirection && directionBarredForCase(anchoredDirection, reasoning, caseSafety)
      ? modelDirection
      : anchoredDirection;
    const direction = caseSafety && directionBarredForCase(preferred, reasoning, caseSafety) ? "按已锁定病机与治法辨证组方" : preferred;
    const identifiedNames = identifyKnownFormulaNames(direction);
    const identifiedMode = formulaSelectionMode(direction, identifiedNames);
    const identityGovernedNames = identifiedNames.filter((name) => formulaCompilationReferences([name]).length === 1);
    const incompleteCombined = identifiedMode === "combined" && identityGovernedNames.length !== identifiedNames.length;
    const recommendedFormulaNames = incompleteCombined ? [] : identityGovernedNames;
    // 教材代表方在目录里锁不住（同名方多个出处、或目录未收）时，方向仍写教材方名：开方阶段按教材组成与本例病机
    // 组方并沿用这个方名，只是没有目录基准可以逐味核对。其余锁不住的方名照旧改写为辨证组方。
    const textbookRowForDirection = textbookRowForSyndrome(String(reasoning.overview?.tcmDiseaseName || ""), String(reasoning.overview?.primarySyndrome || ""));
    const textbookNamed = Boolean(textbookRowForDirection) && identifiedNames.length > 0 &&
      identifiedNames.every((name) => textbookRowForDirection!.formulas.includes(name));
    const governedDirection = identifiedNames.length > 0 && recommendedFormulaNames.length === 0 && !textbookNamed
      ? "按已锁定病机与治法辨证组方"
      : direction;
    // 治法同样跟着已定的教材证型走：对上教材的一行时用该行的治法原文（甲方按教材对照；同一病例重新生成 3 次，
    // 治法的写法 10 例里 0 例完全一致）。没对上时保留模型写的治法。
    const textbookRow = textbookRowForSyndrome(String(reasoning.overview?.tcmDiseaseName || ""), String(reasoning.overview?.primarySyndrome || ""));
    const secondary = Array.isArray(reasoning.overview?.secondarySyndromes) ? reasoning.overview.secondarySyndromes.filter(Boolean) : [];
    // 教材按偏颇分两段写治法的（「偏肾阴虚者…；偏阳虚者…」），只用与已签名病性对得上的那一段；对不上时不锚定，保留模型写的治法——
    // 此前两段照抄进治法栏，医生读到的是一道选择题（2026-10-19，尿浊·肾虚不固证 3 例）。
    const conditionalBranches = textbookRow ? textbookConditionalBranches(textbookRow) : undefined;
    const rowMethod = conditionalBranches
      ? signedConditionalBranch(reasoning, conditionalBranches)?.method || ""
      : textbookRow ? textbookAnchorableMethod(textbookRow.therapy) : "";
    // 教材治法按这一证的典型表现写（内痔·湿热下注证「清热利湿止血」、乳岩·气血两亏证「补益气血，宁心安神」）：本例病历没有
    // 对应表现、甚至写明「无便血」「神志清楚」时，那一项不锚定，其余照用；整行都去掉时不锚定，保留模型写的治法（2026-10-19，
    // Claude 评审验收主集 M 治则治法栏）。接上的模型那一句（withSymptomDirectedClause）同一口径核对——前一轮未核对时锚进去的
    //「…止血」会被当成模型的句子再接回来。
    const supportedByRecord = (method: string) => typeof clinicalSourceText === "string" && clinicalSourceText.trim() && textbookRow
      ? therapyWithoutUnsupportedSymptomItems(method, {
        recordText: clinicalSourceText,
        diseaseName: String(reasoning.overview?.tcmDiseaseName || ""),
        syndromeName: String(reasoning.overview?.primarySyndrome || ""),
        locations: (reasoning.pathogenesis?.locationDifferentiation?.items || []).filter((item): item is string => typeof item === "string"),
        bookKey: textbookRow.bookKey,
      })
      : method;
    const recordRowMethod = rowMethod ? supportedByRecord(rowMethod) : "";
    // 按所选流派保留了模型写的方（lineageChosenFormulaDirectionKept）：治法也保留模型按该方写的，不再换成教材行的治法——
    // 否则方是桂枝汤、治法却是「辛温解表，宣肺散寒」，方与治法对不上，开方阶段按治法核方会把它退成自拟方。
    const lineageKept = Boolean(textbookRow) &&
      lineageChosenFormulaDirectionKept(reasoning, String(reasoning.overview?.recommendedFormulaDirection || ""), lineagePreference);
    const bleedingBarsRowMethod = Boolean(caseSafety?.activeBleeding) && bloodMovingWithoutHemostasis(recordRowMethod);
    const textbookOrLineageMethod = lineageKept
      ? lineageKeptTherapy(reasoning, String(reasoning.overview?.recommendedFormulaDirection || ""))
      : textbookRow && secondary.length === 0 && recordRowMethod && !bleedingBarsRowMethod
        ? supportedByRecord(withSymptomDirectedClause(recordRowMethod, String(reasoning.therapy?.overallMethod || "")))
        : "";
    // 活动性出血：止血一项排在最前（hemostasisFirstMethod）；锚定的与模型自己写的治法同一口径。
    const bleedingOrderedMethod = caseSafety?.activeBleeding
      ? hemostasisFirstMethod(textbookOrLineageMethod || String(reasoning.therapy?.overallMethod || ""))
      : "";
    const orderedOrAnchoredMethod = bleedingOrderedMethod && bleedingOrderedMethod !== String(reasoning.therapy?.overallMethod || "")
      ? bleedingOrderedMethod
      : textbookOrLineageMethod;
    // 治法覆盖核对（m03-method-coverage）补的一项经过跨模型复核，教材锚定换回原文时接在后面，不然「化痰」补了也留不住。
    const verifiedItem = String((reasoning.therapy as { verifiedMethodItem?: unknown } | undefined)?.verifiedMethodItem || "").trim();
    const anchoredMethod = orderedOrAnchoredMethod && verifiedItem && !orderedOrAnchoredMethod.includes(verifiedItem)
      ? `${orderedOrAnchoredMethod.replace(/[，,。；;\s]+$/u, "")}，${verifiedItem}`
      : orderedOrAnchoredMethod;
    return lineageDecisionsMatchingDirection(withoutForeignLineageLensSentence({
      ...reasoning,
      overview: {
        ...reasoning.overview,
        // 证名对上教材的一行而病名写法不同（「头风病」对「头痛」）时，病名用教材的节名；
        // 节名是西医病名而教材写明它属某个中医病的（血栓闭塞性脉管炎 → 脱疽），用那个中医病名，不把西医节名改回去。
        // 节名合写两个病名（「胎漏、胎动不安」「堕胎、小产」）而模型按教材定义写了其中一个时，保留模型的写法——两个病名各有定义，
        // 改回节名就把模型已作的区分抹掉了，依据里的「属胎动不安」也会被换成「属胎漏、胎动不安」（2026-10-22）。
        ...(textbookRow && reasoning.overview?.tcmDiseaseName && reasoning.overview.tcmDiseaseName !== textbookSectionDeliveryName(textbookRow.disease) &&
          !textbookSectionDeliveryName(textbookRow.disease).split("、").includes(reasoning.overview.tcmDiseaseName.trim())
          ? {
              tcmDiseaseName: textbookSectionDeliveryName(textbookRow.disease),
              ...(typeof reasoning.overview.tcmDiseaseRationale === "string"
                ? { tcmDiseaseRationale: reasoning.overview.tcmDiseaseRationale.split(reasoning.overview.tcmDiseaseName).join(textbookSectionDeliveryName(textbookRow.disease)) }
                : {}),
            }
          : {}),
        ...(anchoredMethod ? { overallTherapy: anchoredMethod } : {}),
        recommendedFormulaDirection: governedDirection,
        recommendedFormulaNames,
        formulaSelectionMode: formulaSelectionMode(governedDirection, recommendedFormulaNames),
      },
      ...(anchoredMethod && reasoning.therapy ? { therapy: { ...reasoning.therapy, overallMethod: anchoredMethod } } : {}),
    }, lineagePreference), governedDirection);
  }
  if (reasoning.stage === "prescribe" && reasoning.formula) {
    return {
      ...reasoning,
      formula: {
        ...reasoning.formula,
        candidates: reasoning.formula.candidates.map((candidate) => ({
          ...candidate,
          formulaNames: identifyKnownFormulaNames(candidate.name),
        })),
      },
    };
  }
  return reasoning;
}

/**
 * 服务端确定性恢复被模型丢弃的命名方身份。
 *
 * 问题的类：M03 锁定了命名方，M04 生成的药味**确定性地满足**该方基准（服务端自己能核验），
 * 但模型把 candidate.name 写成了「本例辨证组方」——formulaNames 由 name 派生，于是为空，
 * formulaCompilationContractIssue 判 formula_reference_declassified，触发修复；修复提示要求
 * 「沿用方名」或「显式改自拟」二选一，模型再次选自拟，构成 fixpoint，整方降级 0 味。
 *
 * 实测（感冒-风寒束表证，flash）：M03 锁定麻黄汤，第二轮修复后的候选 6 味含麻黄汤全部 4 味
 * （compositionDiff 麻黄汤 4/4≥4，组成完全合规），仍因方名缺失被判 declassified 并最终 0 味。
 * 医生看到的是一页「无法形成处方」，而系统手里其实握着一张组成合规的麻黄汤加减。
 *
 * 这不是放宽任何检查，而是把一个**服务端已知的确定性事实**（基准组成 ⊆ 候选组成）落到字段上：
 *   · 方名与证候的关系由 M03 的 positiveSufficiency 核验，本函数不做证候判断；
 *   · 组成是否满足基准由 verifyFormulaCompilationComponents 核验，与合同校验同一入口；
 *   · 恢复后 formulaCompilationContractIssue 照常完整重跑（走 selectedReferences 分支），
 *     剂量、君臣佐使、病机绑定、高影响方向、十八反十九畏、特殊人群一条未减。
 * 三条边界：只在 M03 确有锁定方名、候选自带方名为空、且 name 是受控自拟标签时触发；
 * 任一基准未通过组成核验即不恢复（fail-closed，保持既有 declassify 路径）。
 */
/**
 * 方名身份与「方剂出处」的**唯一投影**（2026-08-11）。
 *
 * 恢复身份的两条路径此前只写 name / formulaNames / constructionType，不写 formulaSource——
 * 于是候选顶着「四君子汤加减」，出处栏仍是 model_inference 的「本例证候…结构化匹配」，
 * 而可见层只在 evidenceLevel 可追溯时才打印「方剂出处」，医生看到的是一个没有出处的经方名。
 * 授予身份的那次核验手里就攥着 governed catalog 的 source，把它丢掉是没有道理的：
 * **谁给的身份，谁给出处**。
 */
/**
 * 出处栏「方名：出处」，合方用「；」连写。名录里的出处常以句号收尾（「《辨证录》卷十三。」），连写成「卷十三。；」
 *（2026-10-19 留出例 S143）：每条先去掉收尾的句号。
 */
export function formulaSourceLabel(entries: ReadonlyArray<readonly [string, string]>): string {
  return entries.map(([name, source]) => `${name}：${String(source || "").trim().replace(/[。．.]+$/u, "")}`).join("；");
}

function restoredFormulaSourceProjection(
  verifications: readonly FormulaComponentVerification[],
  modificationStatus: "canonical" | "modified",
): Pick<
  NonNullable<ClinicalReasoningResultV2["formula"]>["candidates"][number],
  "formulaSource" | "baseFormulas"
> | undefined {
  if (verifications.length === 0 || !verifications.every((item) => item.verified && item.source.trim())) return undefined;
  return {
    // 与 enrichReasoning 的出处口径逐字一致：本地方剂目录记 kb_entry，其余记 classic_text；
    // 只有「未加减 + 全部来自官方经典目录 + 组成逐字一致」才判高置信。
    formulaSource: {
      evidenceLevel: verifications.every((item) => item.origin !== "local_formula_catalog")
        ? "classic_text" as const
        : "kb_entry" as const,
      source: formulaSourceLabel(verifications.map((item) => [item.formulaName, item.source] as const)),
      confidence: modificationStatus === "canonical" &&
        verifications.every((item) => item.origin === "official_classic_catalog" && item.exactComposition)
        ? "高" as const
        : "中" as const,
    },
    baseFormulas: verifications.map((item) => ({
      name: item.formulaName,
      source: item.source,
      matchedIngredientCount: item.matchedIngredientCount,
      totalIngredientCount: item.totalIngredientCount,
      minimumPreservedIngredientCount: item.minimumPreservedIngredientCount,
      matchedRequiredIngredientCount: item.matchedRequiredIngredientCount,
      requiredIngredientCount: item.requiredIngredientCount,
      verificationStatus: "verified_individually" as const,
    })),
  };
}

/**
 * M03 未锁方名时，按**组成**给自拟候选恢复经方身份（甲方 R1「首选经方名」）。
 *
 * 只动被标成自拟的那一档：方名已经写了别的东西就不覆盖——那可能是模型的合方判断或
 * 医生编辑版，替它改名等于替人做方剂裁定。识别不出对应经方时原样返回，即甲方说的
 * 「确认无对应的经方，走自拟方」。
 */
function restoreFormulaIdentityFromComposition(
  reasoning: ClinicalReasoningResultV2,
): ClinicalReasoningResultV2 {
  if (!reasoning.formula) return reasoning;
  const candidates = reasoning.formula.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    const trimmedName = String(candidate.name || "").trim();
    const selfDevisedLabel = /^(?:本例辨证组方|辨证组方|自拟方?)(?:加减|加味)?$/.test(trimmedName);
    if (!selfDevisedLabel) return candidate;
    if ((candidate.formulaNames || []).length > 0) return candidate;
    const identified = identifyGovernedFormulaByComposition(candidate.herbs || []);
    if (!identified) return candidate;
    const modificationStatus = identified.modificationKind === "canonical"
      ? "canonical" as const
      : "modified" as const;
    return {
      ...candidate,
      name: identified.displayName,
      formulaNames: [identified.formulaName],
      constructionType: "single_base" as const,
      modificationStatus,
      ...(restoredFormulaSourceProjection(
        verifyFormulaCompilationComponents(
          [identified.formulaName],
          candidate.herbs || [],
          false,
          modificationStatus === "modified",
        ),
        modificationStatus,
      ) || {}),
    };
  });
  return { ...reasoning, formula: { ...reasoning.formula, candidates } };
}

/**
 * 候选自称的经典身份，是不是**服务端按组成确定性反查补回**的那一个（甲方 2026-08-13 P0 根因）。
 *
 * 缺陷形态（生产日志 + 本地循环复现各一次实证）：M03 未锁定任何方名（模型选的养胃增液汤
 * 因受控证候关系未核实被撤，mode=self_devised、recommendedFormulaNames=[]），M04 组出 8 味、
 * 逐味剂量/配伍/君臣/特殊人群全部通过；随后 wrapStructuredJsonObject 对**每一版 M04 响应**
 * 都会跑 restoreGovernedFormulaIdentity 的「形态三」——按组成反查补回身份（方名可追溯特性，
 * 把加减方识别从 3.7% 提到 74% 的那条），于是候选变成
 *   name=养胃增液汤加减  formulaNames=[养胃增液汤]  constructionType=single_base
 * 而合同规定 mode=self_devised 时 formulaNames **必须为空** ⇒ formula_direction_drift
 * ⇒ 整方作废 ⇒ 医生拿到药典区间参考页。
 *
 * 也就是说：**服务端生产了一个自己的合同禁止的形态**，两条受治理判据方向相反，
 * 输的是整张已通过全部安全校验的处方。是否触发取决于模型这一版药味能否反查成方——
 * 这正是甲方所说「不稳定」的来源（同一病例 8 次复现里 2 次失败）。
 *
 * 判据刻意**不信任任何标记字段**：模型的 JSON 会被解析合入，它同样能写出
 * identityRestoredFromComposition 之类的标记。这里改为让合同**独立重跑同一条组成反查**——
 * 与 isDeclassifiedSelfDevisedCandidate 认得服务端自己的剥名产物完全同构：
 * 靠结构性事实，不靠自述。
 *
 * 三处收紧，缺一不可：
 *  1) 只在 M03 **没有锁定任何方名**且 mode ∈ {self_devised, none} 时成立——这正是恢复器
 *     「形态三」的进场条件；M03 锁了方名时一律不走本路径（那是原有的对齐判据的地盘）。
 *  2) 候选只声明**一个**方名，且该方名必须与组成反查的结果**逐字相同**；模型随便写一个
 *     方名而组成对不上，反查结果不同即不成立。
 *  3) 反查用的是 identifyGovernedFormulaByComposition 本身（比正向 80% 覆盖线严格得多），
 *     不新增任何放宽。
 */
export function isCompositionRestoredGovernedIdentity(
  candidate: { formulaNames?: unknown; herbs?: unknown } | null | undefined,
  governedPriorNames: readonly string[] | null | undefined,
  governedMode: string | undefined,
): boolean {
  if (!candidate) return false;
  if ((governedPriorNames?.length ?? 0) > 0) return false;
  if (governedMode !== "self_devised" && governedMode !== "none") return false;
  const names = Array.isArray(candidate.formulaNames)
    ? candidate.formulaNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
    : [];
  if (names.length !== 1) return false;
  const herbs = Array.isArray(candidate.herbs) ? candidate.herbs as FormulaHerbInput[] : [];
  if (herbs.length === 0) return false;
  const identified = identifyGovernedFormulaByComposition(herbs);
  return Boolean(identified && identified.formulaName === names[0].trim());
}

/**
 * M03 定下的病名、证名对上教材一行，推荐方向写的就是该行的代表方，但目录锁不住它（同名方多版本，或不在可锁定层）时，
 * recommendedFormulaNames 为空、mode=none。M04 照教材把处方写成这张方（formulaNames=[该方]）是 10/13 起的要求写法，
 * 不是偏离方向（2026-10-19 甲方标准病历 3：加味四物汤三次生成 10 次判 formula_direction_drift，每次一整轮重生成，
 * 一次修复轮返回坏 JSON，整页退成非剂量页）。只认：候选方名都是该行的代表方、都写在 M03 推荐方向里、
 * 候选药味覆盖该方组成过半（教材行的组成，或目录里该名任一版本的组成）。formula_direction_drift 的两个产地共用这一条。
 */
export function isSignedTextbookFormulaIdentity(
  candidate: { formulaNames?: unknown; herbs?: unknown } | null | undefined,
  prior: { overview?: { tcmDiseaseName?: unknown; primarySyndrome?: unknown; recommendedFormulaDirection?: unknown; recommendedFormulaNames?: unknown } } | null | undefined,
): boolean {
  if (!candidate || !prior?.overview) return false;
  const locked = Array.isArray(prior.overview.recommendedFormulaNames) ? prior.overview.recommendedFormulaNames.filter(Boolean) : [];
  if (locked.length > 0) return false;
  const names = Array.isArray(candidate.formulaNames)
    ? candidate.formulaNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())).map((name) => name.trim())
    : [];
  if (names.length === 0) return false;
  const row = textbookRowForSyndrome(String(prior.overview.tcmDiseaseName || ""), String(prior.overview.primarySyndrome || ""));
  const direction = String(prior.overview.recommendedFormulaDirection || "");
  if (!row || !names.every((name) => row.formulas.includes(name) && direction.includes(name))) return false;
  const present = new Set((Array.isArray(candidate.herbs) ? candidate.herbs as Array<{ name?: unknown }> : [])
    .map((herb) => compositionIdentityName(String(herb?.name || ""))).filter(Boolean));
  const share = (ingredients: readonly string[]) => {
    const ids = [...new Set(ingredients.map((name) => compositionIdentityName(name.replace(/[（(][^）)]*[）)]/g, ""))).filter(Boolean))];
    return ids.length === 0 ? 0 : ids.filter((id) => present.has(id)).length / ids.length;
  };
  return names.every((name) => [row.composition, ...formulaCompilationReferences([name]).map((reference) => reference.ingredients)]
    .some((ingredients) => share(ingredients) >= 0.5));
}

export function restoreGovernedFormulaIdentity(
  reasoning: ClinicalReasoningResultV2,
  prior: ClinicalReasoningResultV2 | null | undefined,
  options: { preserveServerDeclassification?: boolean } = {},
): ClinicalReasoningResultV2 {
  if (reasoning.stage !== "prescribe" || !reasoning.formula) return reasoning;
  if (!prior || prior.stage !== "diagnose") return reasoning;
  // This is intentionally an out-of-band permission supplied by the orchestration phase. A model
  // can emit the same JSON fields, so the payload flag alone is never sufficient to suppress a
  // governed identity restoration. Provider ingress strips these fields; only later server-owned
  // declassification/pruning phases call this function with the permission enabled.
  if (
    options.preserveServerDeclassification === true &&
    reasoning.formula.candidates[0]?.identityDeclassified === true
  ) return reasoning;
  const restorationInput = withoutUntrustedM04IdentityMetadata(reasoning);
  const governedNames = (prior.overview?.recommendedFormulaNames || [])
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
  const mode = prior.overview?.formulaSelectionMode || "none";
  // 形态三 **M03 判自拟、但 M04 的组成其实就是某经方**（甲方 2026-08-05 R1/M5.1/M5.2）。
  //
  // 甲方口径：「首选经方名，如确认无对应的经方，走自拟方」；实测投诉「该方为麻黄汤加味，
  // 展示为自拟方？」。此前本函数在 governedNames 为空时直接 return——M03 没锁方名，
  // 就再也没人回头看一眼组成。于是 M04 组出标准麻黄汤，照样顶着「本例辨证组方」出去：
  // 系统认得这个方，只是从来没按组成查过。
  //
  // 这一档只在**没有锁定方名**时进场，不与上面两档抢；判据是组成完整包含某受治理经方
  // （identifyGovernedFormulaByComposition，比正向 80% 线严格得多，理由见该函数注释）。
  if (governedNames.length === 0) {
    return restoreFormulaIdentityFromComposition(restorationInput);
  }
  // alternatives 由模型在多个基准中择一，恢复身份等于代替医生/模型做方剂选择，不做。
  if (mode !== "single" && mode !== "combined") return restorationInput;
  const references = formulaCompilationReferences(governedNames);
  if (references.length !== governedNames.length) return restorationInput;
  const candidates = restorationInput.formula!.candidates.map((candidate, index) => {
    if (index !== 0) return candidate;
    // 恢复的触发形态有两种,此前只处理了第一种(2026-08-05 补第二种)。
    //
    //  形态一 自拟标签:方名写成「本例辨证组方」,身份完全没声明;
    //  形态二 **有名无引用**:方名已经是 M03 锁定的经典方(如「银翘散加减」),
    //         但 formulaNames 是空数组——模型只在名字里写了方,没填结构化引用字段。
    //
    // 形态二此前不被恢复,后果是致命的:合同层见「声称经典方 + 无基准引用」判
    // formula_reference_declassified,剥名函数据此把「银翘散加减」改成「本例辨证组方」。
    // 线上诊断日志实证(风热犯表例):
    //   restoreGovernedFormulaIdentity step=entered  candidateName="银翘散加减"
    //   restoreGovernedFormulaIdentity step=skip_candidate declassifiedLabel=false formulaNamesCount=0
    //   → 随后 reason='m04_formula_reference_declassified' → 最终显示「本例辨证组方」
    // 50 例线上验收里方名可追溯仅 2/13,主因就是这一条:**方名本来是对的,被剥掉了**。
    //
    // 补法不放宽任何安全判据:仍要求方名与 M03 锁定方名同源、且组成通过同一套校验;
    // 服务端只是把模型漏填的 formulaNames 按已核验事实补回,不新增任何身份。
    const trimmedName = String(candidate.name || "").trim();
    const declassifiedLabel = /^(?:本例辨证组方|辨证组方)(?:加减)?$/.test(trimmedName);
    const namedWithoutReference = !declassifiedLabel &&
      (candidate.formulaNames || []).length === 0 &&
      governedNames.some((name) => trimmedName.includes(name));
    if (!declassifiedLabel && !namedWithoutReference) {
      return candidate;
    }
    if (declassifiedLabel && (candidate.formulaNames || []).length > 0) {
      return candidate;
    }
    const combined = governedNames.length > 1;
    const verifications = verifyFormulaCompilationComponents(governedNames, candidate.herbs, combined, true);
    if (verifications.length !== governedNames.length || !verifications.every((item) => item.verified)) return candidate;
    // 候选药味多于基准即为「加减」，与既有 explicitlyModified 口径一致。
    const baselineIdentities = new Set(references.flatMap((reference) => reference.ingredients).map(normalizeHerbName));
    const actualNames = candidate.herbs.map(formulaHerbIdentityName).filter(Boolean);
    const extraHerbs = actualNames.filter((name) => !baselineIdentities.has(normalizeHerbName(name)));
    const restoredName = `${governedNames.join("合")}${extraHerbs.length > 0 ? "加减" : ""}`;
    const modificationStatus = extraHerbs.length > 0 ? "modified" as const : "canonical" as const;
    return {
      ...candidate,
      name: restoredName,
      formulaNames: [...governedNames],
      constructionType: combined ? "combined" as const : "single_base" as const,
      modificationStatus,
      ...(restoredFormulaSourceProjection(verifications, modificationStatus) || {}),
    };
  });
  return { ...restorationInput, formula: { ...restorationInput.formula!, candidates } };
}

export function applyRestoredGovernedFormulaIdentity(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
  options: { preserveServerDeclassification?: boolean } = {},
): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2") return match;
        const next = restoreGovernedFormulaIdentity(parsed, prior, options);
        if (next === parsed) return match;
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(next, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

function withoutUntrustedM04IdentityMetadata(
  reasoning: ClinicalReasoningResultV2,
  options: { stripGovernedProvenance?: boolean } = {},
): ClinicalReasoningResultV2 {
  if (reasoning.stage !== "prescribe" || !reasoning.formula) return reasoning;
  let changed = false;
  const candidates = reasoning.formula.candidates.map((candidate) => {
    if (
      candidate.identityDeclassified === undefined &&
      candidate.identityDeclassificationReason === undefined &&
      candidate.declassifiedFromFormulaNames === undefined &&
      (!options.stripGovernedProvenance || (
        candidate.baseFormulas === undefined &&
        candidate.formulaSource === undefined &&
        candidate.discriminationPath === undefined &&
        candidate.classicEvidence === undefined &&
        candidate.compositionLogic === undefined &&
        candidate.textualModifications === undefined
      ))
    ) return candidate;
    changed = true;
    const next: Record<string, unknown> = { ...candidate };
    delete next.identityDeclassified;
    delete next.identityDeclassificationReason;
    delete next.declassifiedFromFormulaNames;
    if (options.stripGovernedProvenance) {
      // All of these rows are rebuilt from governed local formula/evidence sources by
      // enrichPrescriptionProvenance before review/signing. Keeping a provider-authored copy would
      // let the model impersonate a completed identity attestation if that later transform throws.
      delete next.baseFormulas;
      delete next.formulaSource;
      delete next.discriminationPath;
      delete next.classicEvidence;
      delete next.compositionLogic;
      delete next.textualModifications;
    }
    return next as unknown as typeof candidate;
  });
  return changed
    ? { ...reasoning, formula: { ...reasoning.formula, candidates } }
    : reasoning;
}

/**
 * Remove server-owned formula identity and evidence provenance that arrived inside a
 * provider-authored M04 payload.
 *
 * These fields are retained by the application schema because deterministic server transforms add
 * them before review/signing. They are not provider capabilities: accepting them at ingress would
 * let a model or prompt injection impersonate completed server declassification, governed
 * composition verification or evidence retrieval and influence formula restoration, review policy
 * and the doctor-visible provenance notice.
 */
export function stripUntrustedM04IdentityMetadata(content: string): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== "prescribe" || !parsed.formula) {
          return match;
        }
        const sanitized = withoutUntrustedM04IdentityMetadata(parsed, { stripGovernedProvenance: true });
        if (sanitized === parsed) return match;
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(sanitized)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

export function applyDeterministicFormulaReferences(content: string, clinicalSourceText?: string, lineagePreference?: string, caseSafety?: FormulaReferenceCaseSafety): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2") return match;
        const next = withDeterministicFormulaReferences(parsed, clinicalSourceText, lineagePreference, caseSafety);
        if (parsed.stage === "diagnose" && lineagePreference && lineagePreference !== "unrestricted") {
          // 流派选方的去留（方名与流派代码，无病历内容）：选了流派而方被改回教材代表方的比例只能从这里看到。
          console.info("[tcm-cdss:telemetry] lineage_formula_direction", {
            lineage: lineagePreference,
            applicable: (parsed as { lineageAdaptation?: { applicable?: unknown } }).lineageAdaptation?.applicable ?? null,
            modelDirection: String(parsed.overview?.recommendedFormulaDirection || "").slice(0, 40),
            modelTherapy: String(parsed.therapy?.overallMethod || "").slice(0, 40),
            finalDirection: String(next.overview?.recommendedFormulaDirection || "").slice(0, 40),
          });
        }
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(next, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

function candidateBaseFormulaNames(candidateName: string): string[] {
  if (/(?:自拟|经验方|协定方|院内方|辨证方)/.test(candidateName)) return [];
  const normalized = normalizeFormulaName(candidateName);
  if (!normalized) return [];
  const direct = normalizedOfficialClassics.get(normalized) || normalizedVerifiedSupplements.get(normalized) || normalizedCatalog.get(normalized);
  if (direct) return [normalized];

  const matches = knownFormulaMatches(normalized).slice(0, 4);
  if (matches.length === 0) return [];
  let remainder = normalized;
  [...matches].sort((a, b) => b.start - a.start).forEach((match) => {
    remainder = remainder.slice(0, match.start) + remainder.slice(match.start + match.name.length);
  });
  remainder = remainder.replace(/(?:加减|化裁|加味)$/g, "");
  if (matches.length >= 2 && /^(?:(?:联合|合方|合|与))+$/.test(remainder)) {
    return [...new Set(matches.map((match) => match.name))];
  }
  if (/(?:联合|合方|合|与)/.test(remainder)) return [];
  return matches.length === 1 && remainder.length === 0 ? [matches[0].name] : [];
}

type FormulaSourceCandidate = {
  formulaName: string;
  variant: FormulaVariant;
  origin: ResolvedFormulaSource["origin"];
};

/** 两个出处是否指同一部书：只比书名号里的书名，卷次、句号与「引《…》」不算差异。 */
function sameFormulaSourceBook(source: string, governedSource: string | undefined): boolean {
  if (!governedSource) return false;
  const book = (value: string) => value.match(/《([^》]+)》/)?.[1]?.trim() || value.replace(/[。；;，,\s]+$/g, "").trim();
  const left = book(source);
  return left.length > 0 && left === book(governedSource);
}

const ORIGINAL_SOURCE_MARGIN = 0.15;
const DECOCTION_ADJUNCT_HERBS = new Set(["生姜", "大枣"]);

/**
 * 出处并列时比「谁多解释了处方」只看有分辨力的药味：不算生姜、大枣（名录常写在煎法里不列入组成），
 * 合方时也不算合方里另一首方本来就有的药（旋覆代赭汤合温胆汤：枳实属温胆汤，不能替《伤寒全生集》的旋覆代赭汤加分）。
 */
function substantiveHerbs(herbs: string[], otherComponentHerbs: ReadonlySet<string>): Set<string> {
  return new Set(herbs.filter((herb) =>
    !DECOCTION_ADJUNCT_HERBS.has(herb) && !otherComponentHerbs.has(herb) && !otherComponentHerbs.has(catalogIngredientIdentity(herb))
  ));
}

function substantiveSubset(a: string[], b: string[], otherComponentHerbs: ReadonlySet<string>): boolean {
  const right = new Set(b);
  return [...substantiveHerbs(a, otherComponentHerbs)].every((herb) => right.has(herb));
}

/** 排序比较值：b 对上的有分辨力药味真包含 a 的时为正（b 在前），反之为负，互不包含为 0。 */
function substantiveCoverageOrder(a: string[], b: string[], otherComponentHerbs: ReadonlySet<string>): number {
  const left = substantiveHerbs(a, otherComponentHerbs);
  const right = substantiveHerbs(b, otherComponentHerbs);
  if (left.size === right.size) return 0;
  const [small, large, sign] = left.size < right.size ? [left, right, 1] : [right, left, -1];
  return [...small].every((herb) => large.has(herb)) ? sign : 0;
}

function bestFormulaSourceCandidate(
  candidates: FormulaSourceCandidate[],
  herbs: string[],
  combinedFormula = false,
  explicitlyModified = false,
  sourceHint = "",
  inferredAdditionsOnly = false,
  baseIdentityByExact: ReadonlyMap<string, string> = new Map(),
  governedSourceIdentity?: {
    source: string;
    aliases: ReadonlyMap<string, string>;
  },
  otherComponentHerbs: ReadonlySet<string> = new Set(),
): { candidate: FormulaSourceCandidate; overlap: number; f1: number; matchedHerbs: string[]; usedBaseAlias: boolean } | undefined {
  const normalizedHerbs = [...new Set(herbs.map(normalizeHerbName).filter(Boolean))];
  if (normalizedHerbs.length === 0) return undefined;
  // 名录组成按 catalogIngredientIdentity 归一（熟地→熟地黄、麦门冬→麦冬），处方药名也要按同一个函数归一后再比，
  // 否则照原方原名开的处方（左归饮「熟地、枸杞」）反而对不上自己的原书条目。
  const herbIdentityKeys = normalizedHerbs.map(catalogIngredientIdentity);
  const originalSourceMarginOver = (
    item: { candidate: FormulaSourceCandidate; matchedHerbs: string[] },
    other: { matchedHerbs: string[] },
  ) => {
    const original = item.candidate.origin === "official_classic_catalog" ||
      sameFormulaSourceBook(item.candidate.variant.source, governedSourceIdentity?.source);
    if (!original) return 0;
    const explained = new Set(item.matchedHerbs);
    return other.matchedHerbs.every((herb) => explained.has(herb)) ? ORIGINAL_SOURCE_MARGIN : 0;
  };
  const ranked = candidates
    .map((candidate) => {
      const variant = candidate.variant;
      // Ingredient-link adjudications belong to one governed formula source, not to every
      // homonymous formula in the large name catalog. For example, the governed 四神散 records
      // 芍药 as 白芍 for 《三因极一病证方论》; granting that alias to the different
      // 《苏沈良方》 homonym makes the less appropriate source win by catalog precedence.
      const candidateIdentityByExact = governedSourceIdentity?.source === variant.source
        ? governedSourceIdentity.aliases
        : baseIdentityByExact;
      const normalizedFormulaIdentity = normalizeFormulaName(candidate.formulaName);
      const ingredientKey = sourceIngredientKey(candidate, governedSourceIdentity?.source);
      const ingredients = [...new Set(variant.ingredients.map(ingredientKey).filter((ingredient) =>
        ingredient && ingredient !== normalizedFormulaIdentity
      ))];
      const writtenIngredients = new Map<string, Set<string>>();
      for (const raw of variant.ingredients) {
        const identity = ingredientKey(raw);
        writtenIngredients.set(identity, (writtenIngredients.get(identity) || new Set()).add(catalogIngredientWritten(raw)));
      }
      const ingredientOwner = new Array<number>(ingredients.length).fill(-1);
      const canMatch = (herbIndex: number, ingredient: string) => {
        const herb = normalizedHerbs[herbIndex];
        return ingredient === herb || ingredient === herbIdentityKeys[herbIndex] || (
          candidateIdentityByExact.get(herb) === ingredient && !sourceIngredientRequiresProcessingIdentity(ingredient)
        );
      };
      const assign = (herbIndex: number, seen: boolean[]): boolean => {
        for (let ingredientIndex = 0; ingredientIndex < ingredients.length; ingredientIndex += 1) {
          if (seen[ingredientIndex] || !canMatch(herbIndex, ingredients[ingredientIndex])) continue;
          seen[ingredientIndex] = true;
          if (ingredientOwner[ingredientIndex] < 0 || assign(ingredientOwner[ingredientIndex], seen)) {
            ingredientOwner[ingredientIndex] = herbIndex;
            return true;
          }
        }
        return false;
      };
      normalizedHerbs.forEach((_, herbIndex) => assign(herbIndex, new Array<boolean>(ingredients.length).fill(false)));
      const matchedHerbs = ingredientOwner.filter((herbIndex) => herbIndex >= 0).map((herbIndex) => normalizedHerbs[herbIndex]);
      const usedBaseAlias = ingredientOwner.some((herbIndex, ingredientIndex) =>
        herbIndex >= 0 && !writtenIngredients.get(ingredients[ingredientIndex])?.has(normalizedHerbs[herbIndex])
      );
      const overlap = ingredientOwner.filter((herbIndex) => herbIndex >= 0).length;
      const precision = overlap / Math.max(normalizedHerbs.length, 1);
      const recall = overlap / Math.max(ingredients.length, 1);
      const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
      const requiredOverlap = ingredients.length <= 2 ? ingredients.length : 2;
      const requiredIngredients = requiredFormulaAnchors(candidate.formulaName, variant, ingredients);
      const requiredIngredientsPresent = requiredIngredients.every((required) =>
        normalizedHerbs.some((_, herbIndex) => canMatch(herbIndex, required))
      );
      // Formula identity is provenance, not a fuzzy similarity label. Every source and every
      // single/combined branch must enforce the same public contract: retain at least the configured floor (default 80%) of the
      // governed baseline and every identity/safety anchor. F1 remains a ranking signal only; it
      // must never let a low-recall local formula inherit a classic name or source.
      const identityFloorSatisfied = overlap >= (variant.minimumPreservedIngredientCount ?? Math.min(ingredients.length, Math.max(1, Math.ceil(ingredients.length * formulaCompositionFloorFraction())))) && requiredIngredientsPresent;
      const inferredAdditiveMatch = inferredAdditionsOnly &&
        recall >= 0.999 &&
        precision >= 0.35 &&
        requiredIngredientsPresent;
      const accepted = ingredients.length > 0 && overlap >= requiredOverlap && identityFloorSatisfied && (
        inferredAdditionsOnly
          ? inferredAdditiveMatch
          : combinedFormula
          ? (explicitlyModified ? true : recall >= 0.999)
          : explicitlyModified
            ? precision >= 0.35
            : recall >= 0.999 && precision >= 0.999
      );
      return {
        candidate,
        overlap,
        f1,
        recall,
        matchedHerbs,
        usedBaseAlias,
        ingredientSignature: `${[...matchedHerbs].sort().join("|")}::missing=${ingredients.length - overlap}`,
        accepted,
      };
    })
    .filter((item) => item.accepted)
    .sort((a, b) =>
      Number(Boolean(sourceHint && b.candidate.variant.source.includes(sourceHint))) - Number(Boolean(sourceHint && a.candidate.variant.source.includes(sourceHint))) ||
      // 原书优先（2026-10-18）：国家经典名方目录条目与受治理目录里这首方的出处，组成过了身份门槛、且处方里对得上对方的药味它也都对得上时，
      // 比名录里的同名异书多算 ORIGINAL_SOURCE_MARGIN 的相似度。处方照原方去一两味（竹叶石膏汤去粳米），名录里恰好少那几味的后世转载
      //（《医略六书》卷十八）不再因此抢走署名（留出例 S046，独立评审：「出处应先取原书再比药味」）。
      // 后世方多解释了处方里的药（温胆汤带茯苓、大枣 → 《三因》）时原书不加分，「最贴近的组成优先」不变。
      (b.f1 + originalSourceMarginOver(b, a)) - (a.f1 + originalSourceMarginOver(a, b)) ||
      b.f1 - a.f1 || b.overlap - a.overlap ||
      // 分数并列、但一方对上的药味（不算姜枣）真包含另一方时，归多解释了药味的那一方（2026-10-18）。名录常把生姜、大枣写在煎法里
      // 而不列入组成（《三因》温胆汤），橘皮按身份归一成陈皮后，《千金》温胆汤靠生姜与带茯苓的《三因》打平；茯苓才是两方的分界。
      substantiveCoverageOrder(a.matchedHerbs, b.matchedHerbs, otherComponentHerbs) ||
      // 组成同样贴近时：国家经典名方目录条目最先（升降散《伤寒瘟疫条辨》），其次是受治理目录里这首方的出处，
      // 然后才是名录里的同名异书（2026-10-13）。「最贴近的组成优先」不变（温胆汤带茯苓时仍归《三因》）；
      // 改的只是并列时谁署名：此前名录转载条目排在核验补充目录之前，逍遥散于是署成《局方》卷九。
      Number(b.candidate.origin === "official_classic_catalog") - Number(a.candidate.origin === "official_classic_catalog") ||
      Number(sameFormulaSourceBook(b.candidate.variant.source, governedSourceIdentity?.source)) -
        Number(sameFormulaSourceBook(a.candidate.variant.source, governedSourceIdentity?.source)) ||
      // Compilation baseline precedence: official sources (classic catalog, then the SZJG local
      // standard) outrank project-curated verified references. Dual-sourced formulas (a name that
      // exists both in the SZJG standard and in project supplements) anchor composition to the
      // officially audited baseline; supplements only lead when they are the sole source (归脾汤、
      // 酸枣仁汤 and the 医方集解-only imports).
      (a.candidate.origin === "official_classic_catalog" ? -2 : a.candidate.origin === "local_formula_catalog" ? -1 : 0) -
      (b.candidate.origin === "official_classic_catalog" ? -2 : b.candidate.origin === "local_formula_catalog" ? -1 : 0));
  const best = ranked[0];
  if (!best) return undefined;
  // 同组成同名方由可信目录优先；不同组成近分则拒绝归典，避免任选一个看似权威的出处。
  const competingDifferentFormula = ranked.slice(1).find((item) =>
    item.candidate.variant.source !== best.candidate.variant.source && item.ingredientSignature !== best.ingredientSignature
  );
  const bestExact = best.f1 >= 0.999;
  const bestFullyCovered = best.recall >= 0.999 && competingDifferentFormula && competingDifferentFormula.recall < 0.999;
  const trustedCombinedFull = combinedFormula && best.recall >= 0.999 && best.candidate.origin !== "local_formula_catalog";
  // 近分的不同组成都被最优者的药味（不算姜枣）真包含时，最优者多解释了处方，不算拿不准（2026-10-18，见 substantiveCoverageOrder）。
  const bestDominatesNearCompetitors = ranked.slice(1).every((item) =>
    item.candidate.variant.source === best.candidate.variant.source ||
    item.ingredientSignature === best.ingredientSignature ||
    best.f1 - item.f1 >= 0.08 ||
    substantiveCoverageOrder(item.matchedHerbs, best.matchedHerbs, otherComponentHerbs) > 0 ||
    (best.f1 > item.f1 && substantiveSubset(item.matchedHerbs, best.matchedHerbs, otherComponentHerbs))
  );
  if (competingDifferentFormula && !bestExact && !bestFullyCovered && !trustedCombinedFull && !bestDominatesNearCompetitors && best.f1 - competingDifferentFormula.f1 < 0.08) return undefined;
  return { candidate: best.candidate, overlap: best.overlap, f1: best.f1, matchedHerbs: best.matchedHerbs, usedBaseAlias: best.usedBaseAlias };
}

export type FormulaComponentVerification = {
  formulaName: string;
  source: string;
  origin: ResolvedFormulaSource["origin"];
  verified: boolean;
  matchedIngredientCount: number;
  totalIngredientCount: number;
  minimumPreservedIngredientCount: number;
  matchedRequiredIngredientCount: number;
  requiredIngredientCount: number;
  /**
   * 处方组成与受治理基准**逐字一致**：命中全部基准药味、没有多余药味，且未借助任何
   * 炮制别名或身份替代（党参代人参、赤白芍品种等价）。只用于决定方名要不要挂「加减」
   * 与出处置信度，不参与 verified 判定。
   */
  exactComposition: boolean;
};

/**
 * 身份核验专用的基准组成（炮制/部位/异名统一到药典标准名）。
 *
 * 实测(2026-08-05)：M03 锁定银翘散、M04 给出的 9 味与基准逐一对应，唯一差异是基准写
 * 「炒牛蒡子」而处方写「牛蒡子」——一个炮制前缀让整方判为组成不符，方名被剥成
 * 「本例辨证组方」。同类还有 参苓白术散「炒白扁豆」、清胃散「当归身/择细黄连」。
 * 手维护别名表穷举不完（原表只有黄耆、代赭两条），而目录 ingredientLinks 在构建期
 * 已把每一味解析到药典标准名并标了 autoResolvable，这里直接用这份受控解析结果。
 *
 * 只用于身份核验，**不改剂量口径**：compilationIngredients 必须与 T8 构建期
 * doseCompilationEligible 的计算同源（用原始名），否则「构建期标可编译、运行时判不可编译」
 * 的分叉会复现（实测 中丹：桂心→肉桂、大附子→附子 后运行时门禁翻转）。
 * 只采用 autoResolvable 的链接：需人工裁定的品种差异不在此层自动合并。
 */
function identityVerificationCanonicalMap(reference: FormulaCompilationReference): Map<string, string> {
  const row = governedFormulaCompilationRow(reference.formulaName);
  return new Map(
    (row?.ingredientLinks || [])
      .filter((link) => link.autoResolvable === true && link.canonicalName)
      .map((link) => [link.rawName, link.canonicalName as string]),
  );
}

/**
 * 两侧同时过同一张受控解析表，而不是单向替换基准。
 *
 * 单向替换会把常用名打掉：麻黄汤基准写「杏仁」、目录标准名是「苦杏仁」，只改基准这一侧，
 * 模型照写「杏仁」反而不再匹配。方向是双向的——基准侧「炒牛蒡子→牛蒡子」，处方侧
 * 「杏仁→苦杏仁」，两侧落到同一个标准名上才判同一味。表里没有的名字原样通过。
 */
function withIdentityCanonicalNames(names: readonly string[], canonical: ReadonlyMap<string, string>): string[] {
  if (canonical.size === 0) return [...names];
  return names.map((name) => canonical.get(name) || name);
}

/**
 * 身份核验专用的药味替代（2026-08-09）。**只改「这张处方是不是 X 方」的判定，不改别的。**
 *
 * 为什么不进 HARD_IDENTITY_HERB_ALIASES：那张表是**同药异名**（黄耆=黄芪），进去等于宣称
 * 党参与人参是同一味药——剂量边界、功效强度、安全判定会一并被带偏。党参与人参是两味药，
 * 这里只承认「现代临床以党参代人参补气」这一个事实，且只在身份匹配这一步承认。
 *
 * 剂量编译、十八反十九畏、特殊人群门禁、管制毒性排除，一律按处方里**实际写的那味药**判——
 * 本函数不参与那些路径。
 *
 * 安全边界：方名含「参」字者一律不适用（独参汤/参附汤 回阳固脱，党参无此力）。
 * 判据取机械规则而非临床豁免名单，方向上宁可少给一个方名、不可给错一个方名；
 * 参苓白术散因此被保守误挡，待中医师裁定后再放开。政策与实测依据见
 * src/data/tcm-herb-identity-substitution-policy.source.json。
 */
const HERB_IDENTITY_SUBSTITUTIONS: readonly {
  prescribed: string;
  baseline: string;
  blockedWhenNameContains: string;
  allowedDespiteBlock: readonly string[];
}[] = herbSubstitutionPolicyJson.entries.map((entry) => ({
  prescribed: entry.prescribed,
  baseline: entry.baseline,
  blockedWhenNameContains: entry.notApplicableWhenFormulaNameContains,
  // 机械规则的显式例外，逐条带依据（甲方裁定）。不接受无依据的整体放宽——
  // 「方名含参字」这条规则会保守误挡补气类方（参苓白术散），放开必须是逐方的临床裁定。
  allowedDespiteBlock: entry.applicableDespiteNameContains || [],
}));

/**
 * 品种等价（2026-08-09 中医师裁定）。**同样只改「这张处方是不是 X 方」，不改别的。**
 *
 * 后世同名方既有赤芍本也有白芍本时，两个都算数——犀角地黄汤是标准例：《千金》原文只写
 * 「芍药」，《保婴撮要》引济生方作赤芍药，《成方切用》《医宗金鉴》又作白芍药。为了单一目录值
 * 牺牲版本真实性是错的：医生开赤芍本不该被剥掉方名，开白芍本也不该。
 *
 * 放行范围**不是全体芍药方**，这一点是本函数的要害：
 *   · 目录记裸属名（芍药/贝母/皂角）⇒ 放行——品种本来就没定。
 *   · 裁定品种但证据只到推断级（方义推断/同书平行方）⇒ 放行——不能让一次推断猜错就丢方名。
 *   · 后世版本分叉登记 ⇒ 放行。
 *   · 原书或同方异本**明确写出品种**（止痛当归汤「赤芍药」、龙胆汤「赤芍药」、
 *     四物汤「白芍药」、痛泻要方「白芍（炒）」）⇒ **不放行**。这些方的品种是确定的，
 *     处方写反了是实质差异，静默接受等于帮着把一个真实的处方错误藏起来
 *     （实测 B 表：模型 4 次把四物汤写成赤芍、1 次把痛泻要方写成赤芍，都应判错）。
 * 判据由构建期 varietyFlexibleIngredients 给出，这里不复算。
 */
function varietyEquivalenceMap(reference: FormulaCompilationReference): Map<string, string> {
  const row = governedFormulaCompilationRow(reference.formulaName);
  const mapping = new Map<string, string>();
  for (const flexible of row?.varietyFlexibleIngredients || []) {
    const recorded = normalizeHerbName(flexible.recordedName);
    if (!recorded) continue;
    for (const accepted of flexible.acceptedNames) {
      const normalized = normalizeHerbName(accepted);
      if (normalized && normalized !== recorded) mapping.set(normalized, recorded);
    }
  }
  return mapping;
}

function applyIdentitySubstitutions(
  prescriptionNames: readonly string[],
  reference: FormulaCompilationReference,
): string[] {
  const baselineNames = new Set(reference.ingredients.map(normalizeHerbName));
  const present = new Set(prescriptionNames.map(normalizeHerbName));
  const mapping = new Map<string, string>();
  for (const [prescribed, recorded] of varietyEquivalenceMap(reference)) {
    // 处方本来就写了目录记的那个品种 ⇒ 不需要等价，也避免把两味压成一味
    // （赤芍白芍同用的方是存在的，压成一味会让核验少数一味）。
    if (present.has(recorded)) continue;
    mapping.set(prescribed, recorded);
  }
  for (const rule of HERB_IDENTITY_SUBSTITUTIONS) {
    // 基准不需要这味药 → 无从替代。
    if (!baselineNames.has(rule.baseline)) continue;
    // 处方本来就有基准那味药 → 不需要替代（也避免把两味药压成一味）。
    if (present.has(rule.baseline)) continue;
    // 方名含参字这类回阳固脱方，替代不成立。
    const explicitlyAllowed = rule.allowedDespiteBlock.some((name) => reference.formulaName === name);
    if (!explicitlyAllowed && rule.blockedWhenNameContains
      && reference.formulaName.includes(rule.blockedWhenNameContains)) continue;
    mapping.set(rule.prescribed, rule.baseline);
  }
  if (mapping.size === 0) return [...prescriptionNames];
  return prescriptionNames.map((name) => mapping.get(normalizeHerbName(name)) || name);
}

function verifyFormulaCompilationComponent(
  reference: FormulaCompilationReference,
  herbs: FormulaHerbInput[],
  combined: boolean,
  explicitlyModified: boolean,
): FormulaComponentVerification {
  const identityCanonical = identityVerificationCanonicalMap(reference);
  const rawHerbNames = herbs.map(formulaHerbIdentityName).filter(Boolean);
  const canonicalHerbNames = withIdentityCanonicalNames(rawHerbNames, identityCanonical);
  const herbNames = applyIdentitySubstitutions(canonicalHerbNames, reference);
  // 「逐字一致」必须把身份替代也算进去：党参代人参核验通过，但方名不能因此判 canonical
  // 而丢掉「加减」，出处置信度也不能升到高——处方里写的确实不是基准那味药。
  const usedIdentitySubstitution = herbNames.some((name, index) => name !== canonicalHerbNames[index]);
  // 受控解析表同理：它可以**授予身份**（银翘散基准写「炒牛蒡子」、处方写「牛蒡子」仍是银翘散），
  // 但不能宣称组成逐字一致。清胃散基准记「当归身」、处方写整当归就是这一档：方名与出处照给，
  // 但必须挂「加减」、置信度封顶为中，不能让一次药用部位差异被抹平成 canonical 原方。
  const rawPresent = new Set(rawHerbNames.map(normalizeHerbName).filter(Boolean));
  const usedIdentityCanonicalization = reference.ingredients.some((ingredient) => {
    const canonical = identityCanonical.get(ingredient);
    return Boolean(canonical) && canonical !== ingredient && !rawPresent.has(normalizeHerbName(ingredient));
  });
  const baseAliases = formulaHerbBaseAliases(herbs);
  // 锚点必须与组成、处方两侧过同一张表——否则它不是「更严」，而是**恒假**。
  //
  // 2026-08-05 给 ingredients 补了这张受控解析表（见上方注释），锚点这一侧漏了，
  // 于是凡是锚点药带 autoResolvable 炮制前缀的方，处方侧被归一成「陈皮」、锚点仍是
  // 「醋陈皮」，requiredIngredientsPresent 恒 false → bestFormulaSourceCandidate 返回
  // undefined → verified=false、overlap=0。模型即便不重不漏原样抄写基准组成也过不了。
  // 实测（全目录 2062 个可建基准方，把基准组成原样当处方喂回）：281 方核验失败，
  // 其中 254 方是 M03 能锁进 M04 的，柴胡疏肝散 1/2、三仁汤 0/1、八正散 0/1 全在其中。
  // 后果链：核验失败 → 身份不恢复 → 方名被剥成「本例辨证组方」→ 判
  // m04_formula_reference_declassified → 定向修复 → 同码 fixpoint → 修复轮早退。
  // 这是线上「M04 返回 200 但没有候选方」与甲方「方名可追溯率低」的同一个源头。
  const requiredIngredients = withIdentityCanonicalNames(reference.requiredIngredients, identityCanonical);
  const sourceCandidate: FormulaSourceCandidate = {
    formulaName: reference.formulaName,
    variant: {
      source: reference.source,
      ingredients: withIdentityCanonicalNames(reference.ingredients, identityCanonical),
      requiredIngredients,
      minimumPreservedIngredientCount: reference.minimumPreservedIngredientCount,
    },
    origin: reference.origin,
  };
  const matched = bestFormulaSourceCandidate(
    [sourceCandidate],
    herbNames,
    combined,
    explicitlyModified,
    reference.source,
    false,
    baseAliases,
  ) || (!explicitlyModified
    ? bestFormulaSourceCandidate(
        [sourceCandidate],
        herbNames,
        combined,
        true,
        reference.source,
        true,
        baseAliases,
      )
    : undefined);
  const normalizedHerbs = new Set(herbNames.map(normalizeHerbName).filter(Boolean));
  const normalizedBaseAliases = new Set(baseAliases.values());
  const matchedRequiredIngredientCount = requiredIngredients.filter((ingredient) => {
    const normalized = normalizeHerbName(ingredient);
    return normalizedHerbs.has(normalized) ||
      (!sourceIngredientRequiresProcessingIdentity(normalized) && normalizedBaseAliases.has(normalized));
  }).length;
  return {
    formulaName: reference.formulaName,
    source: reference.source,
    origin: reference.origin,
    verified: Boolean(matched),
    matchedIngredientCount: matched?.overlap || 0,
    totalIngredientCount: reference.ingredients.length,
    minimumPreservedIngredientCount: reference.minimumPreservedIngredientCount,
    matchedRequiredIngredientCount,
    requiredIngredientCount: reference.requiredIngredients.length,
    exactComposition: Boolean(matched) &&
      (matched?.f1 ?? 0) >= 0.999 &&
      !matched?.usedBaseAlias &&
      !usedIdentitySubstitution &&
      !usedIdentityCanonicalization,
  };
}

/** Verify every named base against its own governed source, anchors, and composition floor. */
export function verifyFormulaCompilationComponents(
  formulaNames: string[],
  herbs: FormulaHerbInput[],
  combined = formulaNames.length > 1,
  explicitlyModified = false,
): FormulaComponentVerification[] {
  return formulaCompilationReferences(formulaNames).map((reference) =>
    verifyFormulaCompilationComponent(reference, herbs, combined, explicitlyModified));
}

/**
 * 出处解析的**第二判据**：受治理编译目录（2026-08-11）。
 *
 * 这是「同一个判据两处各写各的」的又一处，而且是甲方最大遗留项「经方可追溯率」的直接根因。
 * 同一个问题——「这张处方是不是 X 方」——本仓库有两个互不相识的判官：
 *
 *   · 身份判官 verifyFormulaCompilationComponent：读 tcm-formula-governed-catalog，
 *     两侧过 ingredientLinks 受控解析表，认党参代人参、认赤白芍品种等价；
 *   · 出处判官 resolveFormulaSources（本函数上游）：读 tcm-formula-sources 的三张目录，
 *     两张表都没有的方就查不到，也不过身份替代表。
 *
 * 50 例基层实测：15 个带方名的候选里 10 个被出处判官判 ∅，而身份判官对这 10 个**全部** verified：
 *   参苓白术散 10/10《太平惠民和剂局方》、四君子汤加减（党参）4/4、异功散加减（党参）5/5、
 *   五子衍宗丸加减 5/5、缩泉丸加味 3/3、五磨饮子加减 4/5、六神散加减 6/6、
 *   杏仁煎 8/8、四神散加味 4/4、调经方加味 3/3。
 * 后果不是「少一行出处」：enrichReasoning 拿 ∅ 当「这不是经方」，把方名改写成「本例辨证组方」、
 * constructionType 降为 self_devised。医生页面因此**34/39 例显示自拟方**，其中 10 例是标准经方。
 * 签名载荷里方名后来又被最后一公里的身份恢复补了回去，于是页面说自拟方、载荷说四君子汤加减——
 * 同一份响应两个答案，甲方读页面，量出来的可追溯率自然一路走低。
 *
 * 补法不放宽任何判据：只在三张目录**查不到**时兜底，且**完全采信身份判官的结论**
 * （verified 才给出处，未过核验一律不给）。不新增任何目录、不新增任何出处文本，
 * 出处逐字来自 governed catalog 的 source 字段。
 *
 * 只覆盖单方名：合方那一路 resolveFormulaSources 还要按 matchedHerbs 做跨方覆盖率核算，
 * 而身份判官返回的是替代归一**之后**的药名，两边口径对不齐。合方保持原判据不变。
 */
/**
 * 受治理编译目录里的方名解析。三张名录目录收不全它——实测 2909 个可建基准里有 98 个
 * （九仙散、人参归脾丸、双解汤、四物五子汤…）名录侧查不到，于是连「这是个方名」都判不出来。
 * 这里只认 T8 受治理、可锁定的那批（governedFormulaCompilationRow 本身就是这道闸），
 * 不放宽任何身份口径。
 */
function governedCompilationBaseName(candidateName: string): string | undefined {
  // 受控自拟标签永不进场（目录里没有同名行，这里只是省一次查表并把意图写明）。
  if (/^(?:本例辨证组方|辨证组方|自拟方?)(?:加减|加味|化裁)?$/.test(candidateName.trim())) return undefined;
  const cleaned = cleanFormulaDisplayName(candidateName).trim();
  const stripped = cleaned.replace(/(?:加减|化裁|加味)$/g, "").trim();
  // 目录里就有这个整名时直接采信：治理目录自己收了「葛根芩连汤合升阳除湿汤」这类合方名、
  // 也收了「陈达夫经验方」这类以经验方为名的受治理条目，名录侧的合方拆分与自拟词过滤
  // 会把它们误挡在门外。
  for (const name of [cleaned, stripped]) {
    if (name.length >= 3 && governedFormulaCompilationRow(name)) return name;
  }
  const direct = candidateBaseFormulaNames(candidateName);
  return direct.length === 1 ? direct[0] : undefined;
}

function governedCompilationFormulaSources(
  candidateName: string,
  herbs: FormulaHerbInput[],
): ResolvedFormulaSource[] {
  const baseName = governedCompilationBaseName(candidateName);
  if (!baseName) return [];
  const [reference] = formulaCompilationReferences([baseName]);
  if (!reference) return [];
  const verification = verifyFormulaCompilationComponent(
    reference,
    herbs,
    false,
    /(?:加减|化裁|加味)/.test(candidateName),
  );
  if (!verification.verified) return [];
  return [{
    formulaName: verification.formulaName,
    source: verification.source,
    matchedIngredientCount: verification.matchedIngredientCount,
    totalIngredientCount: verification.totalIngredientCount,
    minimumPreservedIngredientCount: verification.minimumPreservedIngredientCount,
    matchedRequiredIngredientCount: verification.matchedRequiredIngredientCount,
    requiredIngredientCount: verification.requiredIngredientCount,
    verificationStatus: "verified_individually",
    exactComposition: verification.exactComposition,
    origin: verification.origin,
  }];
}

export function resolveFormulaSources(candidateName: string, herbs: FormulaHerbInput[] = []): ResolvedFormulaSource[] {
  const catalogResolved = resolveFormulaSourcesFromNameCatalogs(candidateName, herbs);
  if (catalogResolved.length > 0) return catalogResolved;
  return governedCompilationFormulaSources(candidateName, herbs);
}

function resolveFormulaSourcesFromNameCatalogs(candidateName: string, herbs: FormulaHerbInput[] = []): ResolvedFormulaSource[] {
  const herbNames = herbs.map(formulaHerbIdentityName).filter(Boolean);
  const baseAliases = formulaHerbBaseAliases(herbs);
  const baseNames = candidateBaseFormulaNames(candidateName);
  if (baseNames.length === 0 || herbNames.length === 0) return [];
  const resolved: ResolvedFormulaSource[] = [];
  const matchedHerbs = new Set<string>();
  const combined = baseNames.length > 1;
  const explicitlyModified = /(?:加减|化裁|加味)/.test(candidateName);
  const sourceHint = candidateName.match(/《([^》]{2,80})》/)?.[1]?.replace(/[。；;，,\s]+$/g, "") || "";
  // 合方里另一首方「本来有的药」按它的标准组成算：国家经典名方目录条目，没有时取受治理目录这一条；不取名录里的同名异书，
  // 那里十几条转载的并集几乎什么药都有（温胆汤一类会因此把茯苓也算成旋覆代赭汤的药）。
  const componentIngredients = (name: string) => {
    const governedRow = governedFormulaCompilationRow(name);
    const standard = normalizedOfficialClassics.get(name)?.variant.ingredients ||
      (governedRow ? formulaCompilationReferences([governedRow.name])[0]?.ingredients : undefined) || [];
    return new Set(standard.map(catalogIngredientIdentity).filter(Boolean));
  };
  for (const normalizedName of baseNames) {
    const otherComponentHerbs = combined
      ? new Set(baseNames.filter((name) => name !== normalizedName).flatMap((name) => [...componentIngredients(name)]))
      : new Set<string>();
    const formulaAliases = new Map(baseAliases);
    const governedRow = governedFormulaCompilationRow(normalizedName);
    if (!combined) {
      for (const link of governedRow?.ingredientLinks || []) {
        if (!link.autoResolvable || !link.canonicalName) continue;
        const canonical = normalizeHerbName(link.canonicalName);
        const recorded = normalizeHerbName(link.rawName);
        if (canonical && recorded && canonical !== recorded) formulaAliases.set(canonical, recorded);
      }
    }
    const candidates: FormulaSourceCandidate[] = [];
    const official = normalizedOfficialClassics.get(normalizedName);
    if (official) {
      candidates.push({
        formulaName: official.name,
        variant: official.variant,
        origin: "official_classic_catalog",
      });
    }
    const verified = normalizedVerifiedSupplements.get(normalizedName);
    if (verified) {
      candidates.push({
        formulaName: verified.name,
        variant: verified.variant,
        origin: "verified_reference_catalog",
      });
    }
    const catalogEntry = normalizedCatalog.get(normalizedName);
    catalogEntry?.variants.forEach((variant) => candidates.push({
      formulaName: catalogEntry.name,
      variant,
      origin: "local_formula_catalog",
    }));
    // 受治理目录自己的这一条也是候选（2026-10-13）。补中益气汤、八珍汤这些地方标准方，名录里的十几条同名记录
    // 全是后世转载，受治理条目（《内外伤辨惑论》《瑞竹堂经验方》…）此前只在名录一条都不匹配时才兜底，
    // 于是处方与受治理组成逐味相同，署名却落在某条转载上（补中益气汤《幼科金针》卷下、八珍汤《元戎》；
    // 263 个候选里约 20 个，甲方 9.24 提过出处不稳）。并入候选后仍按组成贴近度排名，并列时由它署名。
    const [governedReference] = governedRow ? formulaCompilationReferences([governedRow.name]) : [];
    if (governedReference && !candidates.some((item) => item.variant.source === governedReference.source)) {
      candidates.push({
        formulaName: governedReference.formulaName,
        variant: {
          source: governedReference.source,
          ingredients: governedReference.ingredients,
          requiredIngredients: governedReference.requiredIngredients,
          minimumPreservedIngredientCount: governedReference.minimumPreservedIngredientCount,
        },
        origin: governedReference.origin,
      });
    }
    const governedSourceIdentity = governedRow
      ? { source: governedRow.source, aliases: formulaAliases }
      : undefined;
    const matched = bestFormulaSourceCandidate(
      candidates,
      herbNames,
      combined,
      explicitlyModified,
      sourceHint,
      false,
      baseAliases,
      governedSourceIdentity,
      otherComponentHerbs,
    ) ||
      (!explicitlyModified
        ? bestFormulaSourceCandidate(
          candidates,
          herbNames,
          combined,
          true,
          sourceHint,
          true,
          baseAliases,
          governedSourceIdentity,
          otherComponentHerbs,
        )
        : undefined);
    if (!matched) return [];
    const normalizedHerbs = new Set(herbNames.flatMap((name) => [normalizeHerbName(name), catalogIngredientIdentity(normalizeHerbName(name))]).filter(Boolean));
    const normalizedBaseAliases = new Set(
      (matched.candidate.variant.source === governedSourceIdentity?.source ? formulaAliases : baseAliases).values(),
    );
    const normalizedIngredients = matched.candidate.variant.ingredients.map(sourceIngredientKey(matched.candidate, governedSourceIdentity?.source)).filter(Boolean);
    const requiredIngredients = requiredFormulaAnchors(
      matched.candidate.formulaName,
      matched.candidate.variant,
      normalizedIngredients,
    );
    const matchedRequiredIngredientCount = requiredIngredients.filter((ingredient) =>
      normalizedHerbs.has(ingredient) ||
      (!sourceIngredientRequiresProcessingIdentity(ingredient) && normalizedBaseAliases.has(ingredient))
    ).length;
    matched.matchedHerbs.forEach((herb) => matchedHerbs.add(herb));
    resolved.push({
      formulaName: matched.candidate.formulaName,
      source: matched.candidate.variant.source,
      matchedIngredientCount: matched.overlap,
      totalIngredientCount: matched.candidate.variant.ingredients.length,
      minimumPreservedIngredientCount: matched.candidate.variant.minimumPreservedIngredientCount ??
        Math.min(normalizedIngredients.length, Math.max(1, Math.ceil(normalizedIngredients.length * formulaCompositionFloorFraction()))),
      matchedRequiredIngredientCount,
      requiredIngredientCount: requiredIngredients.length,
      verificationStatus: "verified_individually",
      exactComposition: matched.f1 >= 0.999 && !matched.usedBaseAlias,
      origin: matched.candidate.origin,
    });
  }
  const normalizedCandidateHerbs = new Set(herbNames.map(normalizeHerbName).filter(Boolean));
  if (combined && (
    explicitlyModified
      ? matchedHerbs.size / Math.max(normalizedCandidateHerbs.size, 1) < 0.6
      : matchedHerbs.size !== normalizedCandidateHerbs.size
  )) return [];
  return resolved.length === baseNames.length ? resolved : [];
}

/**
 * 方剂名录里这个方名下各版本组成的并集（含国家经典名方目录），原样写法。判「方义说去掉的药原方根本没有」时用：
 * 只要哪个版本有这味药就不算没有（天王补心丹有一版列朱砂、仙方活命饮各版写「炙山甲」）。查不到方名时为空。
 */
export function formulaNameVariantIngredients(formulaName: string): string[] {
  const normalized = normalizeFormulaName(String(formulaName || ""));
  if (!normalized) return [];
  const official = normalizedOfficialClassics.get(normalized);
  return [...new Set([
    ...(official ? official.variant.ingredients : []),
    ...(normalizedCatalog.get(normalized)?.variants || []).flatMap((variant) => variant.ingredients),
  ])];
}

/**
 * 名录里这个方名下组成与处方最接近的那一版，处方覆盖了它多少（按组成身份，0–1）；名录里没有这个方名时为 undefined。
 * 教材合方行（「黄连解毒汤合化坚二陈丸」）只列一份不分方的组成，常是本证的加减药而不是哪张方的组成（失荣·瘀毒化热证列的是
 * 当归、生地、丹参、白花蛇舌草、半枝莲、山慈菇…），拿它算「处方以这张方为主体」会把编译目录没收的那张方（化坚二陈丸）算成覆盖——
 * 方中陈皮、半夏、茯苓、僵蚕一味没有，方名却改成「化坚二陈丸加减」（2026-10-19 M 集 TCMChat-test-482）。
 * 编译目录核不了的方按名录各版本的组成核（交付面改回教材代表方时用）。
 */
export function formulaNameCatalogCoverage(formulaName: string, herbNames: readonly string[]): number | undefined {
  const variants = normalizedCatalog.get(normalizeFormulaName(String(formulaName || "")))?.variants || [];
  if (variants.length === 0) return undefined;
  const present = new Set(herbNames.map((name) => compositionIdentityName(String(name || "").replace(/[（(][^）)]*[）)]/gu, ""))).filter(Boolean));
  let best = 0;
  for (const variant of variants) {
    const ids = [...new Set(variant.ingredients.map((name) => compositionIdentityName(catalogIngredientWritten(String(name || "")))).filter(Boolean))];
    if (ids.length === 0) continue;
    best = Math.max(best, ids.filter((id) => present.has(id)).length / ids.length);
  }
  return best;
}

/** 药名里太常见、不能当方名简称依据的字（formulaNameIdentityHerbsMissing）。 */
const COMMON_HERB_NAME_CHARACTERS = new Set([..."黄白子草甘大小生熟参皮仁花叶根石赤川山金红青紫木地天五"]);
const coreHerbsByNormalizedName = new Map<string, { core?: string[]; reasons?: Record<string, string> }>();
for (const [name, entry] of Object.entries(coreHerbsJson.formulas as Record<string, { core?: string[]; reasons?: Record<string, string> }>)) {
  const key = normalizeFormulaName(name);
  if (key && !coreHerbsByNormalizedName.has(key)) coreHerbsByNormalizedName.set(key, entry);
}

function knownFormulaName(value: string): boolean {
  const normalized = normalizeFormulaName(value);
  return normalized.length >= 2 && (coreHerbsByNormalizedName.has(normalized) || isKnownFormulaNameFragment(normalized));
}

/**
 * 方名拆成合方的各张方（「天王补心丹合朱砂安神丸加减」→ 两张）。整名本身是已收录方名时不拆（「百合固金汤」里的「合」不是合方）；
 * 拆不成每一段都是已收录方名时返回空（不猜）。
 */
export function formulaNameComponents(name: string): string[] {
  const base = String(name || "").trim().replace(/(?:加减|化裁|加味)$/u, "").replace(/[（(][^）)]*[）)]/gu, "").trim();
  if (!base) return [];
  const split = (value: string): string[] | undefined => {
    if (knownFormulaName(value)) return [value];
    for (let at = value.indexOf("合"); at > 0; at = value.indexOf("合", at + 1)) {
      const left = value.slice(0, at);
      if (!knownFormulaName(left)) continue;
      const right = split(value.slice(at + 1));
      if (right) return [left, ...right];
    }
    return undefined;
  };
  return split(base) || [];
}

/**
 * 方名承载药中处方里没有的那几味（2026-10-19 M 集 Claude 评审：「沙参麦冬汤加减」方中无沙参、「乌头汤加减」无川乌）。
 *
 * 只认核心药生成物（tcm-formula-core-herbs.json）里两类有理由的味：方名承载药（name_bearing，名字就是它）与缺了就成了
 * 另一张方的味（collapses_into：知柏地黄丸缺知母、黄柏即六味地黄丸）。安全定性药（safety_defining：天王补心丹的朱砂、
 * 薏苡仁汤的川乌）不在此列——缺了它方子仍是那张方，只是去掉了一味毒性药。
 * 同一味的品种或炮制写法算有（沙参＝北沙参/南沙参，川乌＝制川乌，地黄＝熟地黄/生地黄）。生成物里没有这张方时返回空（不判）。
 */
export function formulaNameIdentityHerbsMissing(formulaName: string, herbNames: readonly string[]): string[] {
  const normalizedName = normalizeFormulaName(String(formulaName || ""));
  if (!normalizedName) return [];
  // 每味承载药连同它可接受的写法（品种未定的「沙参」「乌头」「芍药」：解析候选里的任一品种都算）。
  const required = new Map<string, Set<string>>();
  const acceptedWritings = (herb: string) => {
    const resolution = resolveGovernedTcmHerbIdentity(herb);
    const names = resolution.status === "ambiguous" ? [herb, ...(resolution.candidates || [])] : [herb];
    return new Set(names.flatMap((name) => [name, compositionIdentityName(name)]).filter(Boolean));
  };
  const entry = coreHerbsByNormalizedName.get(normalizedName);
  // 「缺了就成了另一张方」的味只在方名用简称点到它时算承载药（「知柏地黄丸」的知、柏，「丹栀逍遥散」的丹、栀）：
  // 大承气汤的芒硝、黄芪建中汤的饴糖、五虎汤的细茶是冲服、烊化或煎时另加的味，系统本就不写进汤剂药味表，方名照旧。
  // 判法是药名里有一个不常见的字出现在方名（去掉剂型字）里；黄、白、子这类字太常见，不算。
  const nameBody = normalizedName.replace(/[汤散丸饮丹膏煎方]$/u, "");
  const abbreviated = (herb: string) => [...herb].some((char) => !COMMON_HERB_NAME_CHARACTERS.has(char) && nameBody.includes(char));
  for (const herb of entry?.core || []) {
    const reason = entry?.reasons?.[herb] || "";
    if (!/^name_bearing/u.test(reason) && !(/^collapses_into/u.test(reason) && abbreviated(herb))) continue;
    required.set(compositionIdentityName(herb) || herb, acceptedWritings(herb));
  }
  // 生成物按药名字面认方名承载药，「乌头汤」的乌头（目录记制川乌）认不出来：方名里的每个药名片段按受治理身份解析，
  // 与目录组成（含系统不编制用量、已从编译组成里扣除的那几味）里同一身份的那味就是承载药。
  // 未经复核的中等置信别名（「白虎」挂石膏、「屏风」挂防风）不算。
  const row = governedFormulaCompilationRow(String(formulaName || "").trim().replace(/(?:加减|化裁|加味)$/u, ""));
  if (row) {
    const named = new Map<string, Set<string>>();
    for (let start = 0; start < normalizedName.length; start += 1) {
      for (let length = 2; length <= 4 && start + length <= normalizedName.length; length += 1) {
        const fragment = normalizedName.slice(start, start + length);
        if (!isKnownTcmHerbName(fragment)) continue;
        const resolution = resolveGovernedTcmHerbIdentity(fragment);
        if (resolution.status === "unique_source_backed") continue;
        const identities = resolution.status === "ambiguous"
          ? [fragment, ...(resolution.candidates || [])]
          : [fragment, compositionIdentityName(fragment)];
        const accepted = new Set(identities.flatMap((name) => [name, compositionIdentityName(name)]).filter(Boolean));
        for (const identity of accepted) named.set(identity, new Set([...(named.get(identity) || []), ...accepted]));
      }
    }
    for (const raw of row.ingredients) {
      const written = normalizeHerbName(String(raw || "").replace(/[（(][^）)]*[）)]/gu, ""));
      const identity = compositionIdentityName(written) || written;
      const accepted = named.get(identity) || named.get(written);
      if (accepted && !required.has(identity)) required.set(identity, new Set([identity, written, ...accepted]));
    }
  }
  const present = herbNames.flatMap((raw) => {
    const written = normalizeHerbName(String(raw || "").replace(/[（(][^）)]*[）)]/gu, ""));
    return written ? [written, compositionIdentityName(written)].filter(Boolean) : [];
  });
  const isMissing = ([core, accepted]: readonly [string, Set<string>]) =>
    !present.some((name) => accepted.has(name) || (name.length > core.length && name.endsWith(core)));
  // 核心药至少两味、而一味都不在处方里：方子已经不是这张方了（2026-10-19 M 集 MTCMB-59、X 集 G-1785「涤痰汤加减」，
  // 半夏、天南星都不在——服务端按痰热把温燥的两味剔掉后方名还留着，评审判名实不符）。安全定性药单独缺一味仍不算（天王补心丹缺朱砂、
  // 薏苡仁汤缺川乌，见上）；只有核心药全缺才算。核心药只有一味的方不在此列。
  const coreEntries = (entry?.core || []).map((herb) => [compositionIdentityName(herb) || herb, acceptedWritings(herb)] as const);
  if (coreEntries.length >= 2 && coreEntries.every(isMissing)) {
    for (const [identity, accepted] of coreEntries) if (!required.has(identity)) required.set(identity, accepted);
  }
  if (required.size === 0) return [];
  return [...required].filter(isMissing).map(([core]) => core);
}

/**
 * 教材代表方的原书出处（2026-10-19 M/H 集 Claude 评审）。教材行给了这首方的组成，出处按组成认是哪一条：
 *  1 国家古代经典名方目录有这个方名、组成与教材相合（目录组成至少六成在教材组成里）：用它——化肝煎此前取了受治理条目的
 *   《成方切用》（后世方书转载），目录写的是《景岳全书》（M 集 TCMChat-test-40、BEST4SDT-112）；
 *  2 受治理编译条目组成与教材相合：用它；组成对不上的是同名异方（四七汤的受治理条目是《局方》人参、官桂、半夏、甘草，
 *    教材呕吐·肝气犯胃证的四七汤是半夏、厚朴、茯苓、苏叶、姜、枣），不用；
 *  3 名录里与教材组成逐味相同、或只少一味（教材多列的竹沥这类冲服药引）的那一条，只有一本书时用它；
 * 方名是丸剂而目录只收了同方的汤剂（教材「十全大补丸」，目录《太平惠民和剂局方》十全大补汤，组成逐味相同）时按同方的另一剂型再找一遍。
 * 都找不到时返回 undefined，由调用方写教材出处。
 */
/** 教材与目录组成的药名比对用身份。教材组成的写法带「末」「汁」（消渴方「黄连末、天花粉末、生地黄汁」）：去掉再认药。 */
function textbookIngredientIdentity(name: string): string {
  const written = catalogIngredientWritten(String(name || ""));
  const bare = written.replace(/(?:末|汁)$/u, "");
  const base = bare !== written && bare.length >= 2 && isKnownTcmHerbName(bare) ? bare : written;
  // 名录写法前面多一个产地、品质字（川萆薢、尖槟榔、黑元参），整个写法认不出、去掉这一个字是已知药名时按那味药认：
  // 程氏萆薢分清饮《医学心悟》、止痛如神汤《外科启玄》与教材组成逐味相同，只因「川萆薢」「尖槟榔」对不上，出处写成了教材
  //（2026-10-19 M 集 RobustSDT-single_0541、TCM-SD-421902）。认得出的写法（胡黄连、土茯苓）不动。
  // 认得出、但身份就是它自己的产地写法（川萆薢、川牛膝、浙贝母）同理，只认这几个产地、品质字（有限闭集），
  // 免得把胡黄连、土茯苓这类本是另一味的药认成黄连、茯苓。只用于出处按组成认书，不进任何处方判断。
  const regional = /^[川怀广建杭云浙尖净明真黑]/u.test(base) && compositionIdentityName(base) === base;
  const unprefixed = (!isKnownTcmHerbName(base) || regional) && base.length >= 3 && isKnownTcmHerbName(base.slice(1)) ? base.slice(1) : base;
  return compositionIdentityName(unprefixed);
}

/** 现代标准、药典类出处（不是方剂原书）。 */
const MODERN_STANDARD_SOURCE = /药典|部颁|标准|规范|手册/u;

export function textbookFormulaOriginalSource(
  formulaName: string,
  textbookComposition: readonly string[],
  /** 教材行列了几张方而组成没有分方（合方行的组成是几张方的并集）：不据组成判同名异方，也不按组成在名录里找。 */
  options: { compositionIsUnion?: boolean } = {},
): string | undefined {
  const normalized = normalizeFormulaName(String(formulaName || ""));
  if (!normalized) return undefined;
  const identities = (ingredients: readonly string[]) => new Set(ingredients.map(textbookIngredientIdentity).filter(Boolean));
  const wanted = identities(textbookComposition);
  // 「相合」只用来排除同名异方（四七汤《局方》人参、官桂、半夏、甘草与教材只共一味半夏；大七气汤《三因方》半夏、茯苓、厚朴、紫苏叶
  // 与教材积证的青皮、陈皮、三棱、莪术…一味不共）：教材有成形的组成（至少三味）且只是一张方时，目录组成与它至少共两味才算。
  // 外科、眼科教材行常不列组成或只列几味主药，这时不据组成否定目录出处（银翘散《温病条辨》照用）。
  const judged = !options.compositionIsUnion && wanted.size >= 3;
  const agrees = (ingredients: readonly string[]) => !judged || [...identities(ingredients)].filter((id) => wanted.has(id)).length >= 2;
  const stem = normalized.replace(/[汤丸散饮丹膏煎]$/u, "");
  const names = [normalized, ...["汤", "丸", "散", "饮"].map((form) => `${stem}${form}`).filter((name) => name !== normalized)];
  for (const [index, name] of names.entries()) {
    // 同方另一剂型（十全大补丸借十全大补汤）只在能按组成核实时才借，且只借古籍出处：药典、部颁标准收的是成药
    //（加味逍遥丸《中国药典》），不是这首方的原书。
    const usable = (source: string | undefined) => Boolean(source) && (index === 0 || (judged && !MODERN_STANDARD_SOURCE.test(source!)));
    const official = normalizedOfficialClassics.get(name);
    if (official && usable(official.variant.source) && agrees(official.variant.ingredients)) return official.variant.source;
    const reference = formulaCompilationReferences([name])[0];
    if (reference && usable(reference.source) && agrees(reference.ingredients)) return reference.source;
    if (!judged) continue;
    const exact = catalogSourceForExactComposition(name, textbookComposition);
    if (exact) return exact;
    // 名录里按组成近似找到的条目只认古籍出处（名录收了药典成药条目：加味逍遥散《中国药典2015》，X 集 G-0679）。
    const near = (normalizedCatalog.get(name)?.variants || []).filter((variant) => {
      if (MODERN_STANDARD_SOURCE.test(variant.source)) return false;
      const ids = identities(variant.ingredients);
      return ids.size >= wanted.size - 1 && ids.size >= 3 && [...ids].every((id) => wanted.has(id));
    });
    const books = new Set(near.map((variant) => variant.source.match(/《([^》]+)》/u)?.[1] || variant.source));
    if (near.length > 0 && books.size === 1) return near[0].source;
  }
  return undefined;
}

/**
 * 教材代表方的受治理条目是不是同名异方：教材有成形的组成，而该条目与它不共两味（textbookFormulaOriginalSource 的同一判据）。
 * 交付面据此不再署那一条的书（四七汤、大七气汤）。
 */
export function textbookFormulaGovernedEntryIsHomonym(
  formulaName: string,
  textbookComposition: readonly string[],
  options: { compositionIsUnion?: boolean } = {},
): boolean {
  const reference = formulaCompilationReferences([formulaName])[0];
  if (!reference || options.compositionIsUnion) return false;
  const wanted = new Set(textbookComposition.map(textbookIngredientIdentity).filter(Boolean));
  if (wanted.size < 3) return false;
  return new Set(reference.ingredients.map(textbookIngredientIdentity).filter((id) => wanted.has(id))).size < 2;
}

/**
 * 交付的方名里，方名承载药不在处方里的那几张方（formulaNameIdentityHerbsMissing）去掉之后的方名：
 * 「乌头汤加减」而方中无川乌 →「自拟方」；「天王补心丹合朱砂安神丸加减」而方中无朱砂 →「天王补心丹加减」。
 * 方名拆不成已收录方名、或每张方都名实相符时返回 undefined（不改）。
 */
export function formulaNameWithIdentityHerbsPresent(
  name: string,
  herbNames: readonly string[],
): { name: string; kept: string[]; dropped: Array<{ formula: string; missing: string[] }> } | undefined {
  const components = formulaNameComponents(name);
  if (components.length === 0) return undefined;
  const dropped = components
    .map((formula) => ({ formula, missing: formulaNameIdentityHerbsMissing(formula, herbNames) }))
    .filter((item) => item.missing.length > 0);
  if (dropped.length === 0) return undefined;
  const kept = components.filter((formula) => !dropped.some((item) => item.formula === formula));
  return { name: kept.length > 0 ? `${kept.join("合")}加减` : "自拟方", kept, dropped };
}

/**
 * 这首方原书的组成（2026-10-19）：国家古代经典名方目录有就用它；否则取名录里与受治理编译条目同一本书的那一条（只有一条时）。
 * 方义说「去X」「加X」时对的是原书：消风散的受治理条目取自深圳地方标准，写的是煅石膏，《外科正宗》原方是石膏
 *（甲方标准病历 9，评审：「原方用的是石膏，不是煅石膏」）。查不到原书条目时为空。
 */
export function originalBookFormulaIngredients(formulaName: string): string[] {
  const normalized = normalizeFormulaName(String(formulaName || ""));
  if (!normalized) return [];
  const official = normalizedOfficialClassics.get(normalized);
  if (official) return [...official.variant.ingredients];
  const reference = formulaCompilationReferences([formulaName])[0];
  if (!reference) return [];
  const rows = (normalizedCatalog.get(normalized)?.variants || []).filter((variant) => sameFormulaSourceBook(variant.source, reference.source));
  return rows.length === 1 ? [...rows[0].ingredients] : [];
}

/**
 * 方义说「以X为基础，去A、加B」时拿来对的原方组成：原书组成（originalBookFormulaIngredients）与受治理编译组成的并集。
 * 两样都查不到、而目录收了同方的另一剂型时（教材与模型写「十全大补丸」，编译目录只有《局方》十全大补汤），借那一剂型的编译组成，
 * 但只留名录里这个方名下也出现过的味（同名丸剂各版本组成的并集）：同名不同剂型偶有组成不同的（大陷胸丸多葶苈子、杏仁），
 * 只认两边都有的，方义里真加的药不会被当成原方已有（2026-10-19 M 集 TCMChat-test-418：「十全大补丸…加黄芪、大枣」，
 * 黄芪本是原方药味，评审判配伍表述错误；此前查不到组成，方义核对整句放过）。都查不到时为空。
 */
export function formulaEditClaimBaseIngredients(formulaName: string): string[] {
  const own = [...originalBookFormulaIngredients(formulaName), ...(formulaCompilationReferences([formulaName])[0]?.ingredients || [])];
  if (own.length > 0) return own;
  const normalized = normalizeFormulaName(String(formulaName || ""));
  if (!/[汤丸散饮]$/u.test(normalized)) return [];
  const named = new Set(formulaNameVariantIngredients(normalized).map((name) => compositionIdentityName(name)).filter(Boolean));
  if (named.size === 0) return [];
  const stem = normalized.slice(0, -1);
  for (const form of ["汤", "丸", "散", "饮"]) {
    const other = `${stem}${form}`;
    if (other === normalized) continue;
    const ingredients = formulaCompilationReferences([other])[0]?.ingredients || [];
    if (ingredients.length > 0) return ingredients.filter((name) => named.has(compositionIdentityName(name)));
  }
  return [];
}

/**
 * 方名在方剂名录里、组成与给定组成（教材该证代表方的组成）逐味相同的那一条的出处（2026-10-19）。
 *
 * 交付面在「方名随辨证阶段改回教材代表方」时写出处：受治理编译目录有这首方就用它的出处，没有时此前直接写
 *「《中医内科学》头痛·血虚头痛代表方」。加味四物汤编译目录里没有（名录里同名 115 条，不可锁定），可名录里《金匮翼》卷五那一条
 *（生地、当归、蔓荆、黄芩、白芍、炙草、甘菊、川芎）与教材组成逐味相同（甲方标准病历 3 第三次生成，评审判出处不通过：
 * 目录里有原书时不得写教材）。这里只认**逐味相同**（两边都按组成身份归一：生地＝生地黄、炙草＝甘草、甘菊＝菊花）；
 * 逐味相同的几条出处不是同一本书时不选（不任挑一条）。国家经典名方目录有这首方时以它为准。
 */
export function catalogSourceForExactComposition(formulaName: string, herbs: readonly string[]): string | undefined {
  const normalized = normalizeFormulaName(String(formulaName || ""));
  const wanted = new Set(herbs.map((name) => textbookIngredientIdentity(String(name || ""))).filter(Boolean));
  if (!normalized || wanted.size < 2) return undefined;
  const sameSet = (ingredients: readonly string[]) => {
    const identities = new Set(ingredients.map((name) => textbookIngredientIdentity(String(name || ""))).filter(Boolean));
    return identities.size === wanted.size && [...identities].every((identity) => wanted.has(identity));
  };
  const official = normalizedOfficialClassics.get(normalized);
  if (official && sameSet(official.variant.ingredients)) return official.variant.source;
  const matches = (normalizedCatalog.get(normalized)?.variants || []).filter((variant) => sameSet(variant.ingredients));
  const books = new Set(matches.map((variant) => variant.source.match(/《([^》]+)》/u)?.[1] || variant.source));
  return matches.length > 0 && books.size === 1 ? matches[0].source : undefined;
}

/**
 * 自拟方的「组方参考」（2026-09-29，甲方 9.24/9.27 测评 2.6「方剂出处未展示」：自拟方的出处栏写的是
 * 「本例证候、病机、治法与药味功效的结构化匹配（病例内推理，需医生复核）」这句工程话术）。
 *
 * 按组成相似度列出最接近的至多 2 首**常用层**成方（官方标准方、古代经典名方目录、≥3 个现代医案），
 * 医生一眼能看出这张自拟方脱胎于哪首成方；找不到时如实写「自拟方」。判据只读受治理目录：
 * 成方的组成有 ≥60% 出现在本方里、且至少 3 味（药味先归一到去炮制正名），不是名字相似。
 * 不授予身份——方名、出处栏仍是自拟方，参考只是说明「参照」。
 */
export function selfDevisedFormulaReferences(herbNames: readonly string[]): Array<{ name: string; source: string; coverage: number }> {
  const actual = new Set(herbNames.map((name) => compositionIdentityName(normalizeHerbName(name))).filter(Boolean));
  if (actual.size < 3) return [];
  const found: Array<{ name: string; source: string; coverage: number; jaccard: number }> = [];
  for (const row of governedFormulaCompilationRows) {
    if (formulaLockTierEnabled() && !formulaInCommonTier(row)) continue;
    if (NON_FORMULA_CATALOG_NAME.test(normalizeFormulaName(row.name))) continue;
    const ingredients = [...new Set(compilationIngredients(row).map(compositionIdentityName).filter(Boolean))];
    if (ingredients.length < 3) continue;
    const matched = ingredients.filter((name) => actual.has(name)).length;
    const coverage = matched / ingredients.length;
    if (matched < 3 || coverage < 0.6) continue;
    const jaccard = matched / (ingredients.length + actual.size - matched);
    found.push({ name: cleanFormulaDisplayName(row.name), source: row.source, coverage, jaccard });
  }
  found.sort((left, right) => right.coverage - left.coverage || right.jaccard - left.jaccard || left.name.localeCompare(right.name));
  const seen = new Set<string>();
  return found.filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true)))
    .slice(0, 2)
    .map(({ name, source, coverage }) => ({ name, source, coverage }));
}

function selfDevisedReferenceSource(herbNames: readonly string[]): string | undefined {
  const references = selfDevisedFormulaReferences(herbNames);
  if (references.length === 0) return undefined;
  return `自拟方，组方参考：${references.map((item) => `${item.name}${item.source ? `（${item.source}）` : ""}`).join("、")}加减；其余药味按本例证候、病机与药味功效配伍，需医生复核`;
}

function professionalModelInferenceEvidence(source: string | undefined): EvidenceRef {
  if (source && !/证据不足|待检索|待核验|内部证据缺口/.test(source)) {
    return { evidenceLevel: "model_inference", source, confidence: "中" };
  }
  return {
    evidenceLevel: "model_inference",
    source: "自拟方，按本例证候、病机、治法与药味功效配伍，无对应的常用成方，需医生复核",
    confidence: "中",
  };
}

type ClassicEvidenceResolver = (
  formulaNames: string[],
) => NonNullable<NonNullable<ClinicalReasoningResultV2["formula"]>["candidates"][number]["classicEvidence"]>;

/** 与 diagnosis-types.ts 里 candidates[].classicEvidence 的 z.array(...).max(6) 同源，超限即整段清空。 */
const CANDIDATE_CLASSIC_EVIDENCE_LIMIT = 6;
/** 与 diagnosis-types.ts candidates[].textualModifications 的 `.max(6)` 同源；超限即整段清空。 */
const CANDIDATE_TEXTUAL_MODIFICATION_LIMIT = 6;

export function enrichReasoning(
  reasoning: ClinicalReasoningResultV2,
  clinicalContext = "",
  classicEvidenceResolver?: ClassicEvidenceResolver,
): { reasoning: ClinicalReasoningResultV2; sourceLabels: string[] } {
  if (!reasoning.formula) return { reasoning, sourceLabels: [] };
  const sourceLabels: string[] = [];
  const candidates = reasoning.formula.candidates.map((candidate) => {
    const herbSafetyProfiles = candidate.herbs.map((herb) => getTcmHerbGenerationSafetyProfile(herb.name));
    const herbBoundaryText = herbBoundaryTail(herbSafetyProfiles);
    const sources = resolveFormulaSources(candidate.name, candidate.herbs);
    const sourceLabel = formulaSourceLabel(sources.map((item) => [item.formulaName, item.source] as const));
    sourceLabels.push(sourceLabel);
    const constructionType = candidate.herbs.length === 1
      ? (sources.length === 1 ? "single_base" as const : "single_herb" as const)
      : sources.length > 1
        ? "combined" as const
        : sources.length === 1
          ? "single_base" as const
          : "self_devised" as const;
    const inferredCompositionModification = sources.some((item) => !item.exactComposition);
    const baseVerifiedName = sources.length > 0 || /(?:自拟|经验方|协定方|院内方|辨证组方)/.test(candidate.name)
      ? cleanFormulaDisplayName(candidate.name)
      : "本例辨证组方";
    const verifiedName = inferredCompositionModification && sources.length > 0 && !/(?:加减|化裁|加味)/.test(baseVerifiedName)
      ? `${baseVerifiedName}加减`
      : baseVerifiedName;
    const modificationStatus = /(?:加减|化裁|加味)/.test(candidate.name) || sources.length > 1 || inferredCompositionModification
      ? "modified" as const
      : "canonical" as const;
    const explicitIdentityNames = explicitFormulaIdentityNames([candidate.name, ...(candidate.formulaNames || [])]);
    const resolvedFormulaNames = sources.map((item) => item.formulaName);
    const governedHerbs = governedFormulaRoleHerbs(candidate, sources);
    return {
      ...candidate,
      name: verifiedName,
      formulaNames: resolvedFormulaNames,
      constructionType,
      modificationStatus,
      therapyMatch: constructionType === "self_devised" ? replaceFormulaIdentityClaims(candidate.therapyMatch, explicitIdentityNames) : candidate.therapyMatch,
      formulaAnalysis: constructionType === "self_devised" ? replaceFormulaIdentityClaims(candidate.formulaAnalysis, explicitIdentityNames) : candidate.formulaAnalysis,
      applicable: professionalCandidateBoundary(
        candidate.applicable,
        "适用于与本例锁定证候、病机和治法一致，且处方前安全信息经医生复核的情况。",
      ),
      notApplicable: [
        professionalCandidateBoundary(
          stripHerbBoundaryTail(candidate.notApplicable),
          "证候、病机、舌脉或安全边界发生变化时暂停采用，并重新辨证。",
        ),
        ...(herbBoundaryText ? [herbBoundaryText] : []),
      ].join(" "),
      baseFormulas: sources.map((item) => ({
        name: item.formulaName,
        source: item.source,
        matchedIngredientCount: item.matchedIngredientCount,
        totalIngredientCount: item.totalIngredientCount,
        minimumPreservedIngredientCount: item.minimumPreservedIngredientCount,
        matchedRequiredIngredientCount: item.matchedRequiredIngredientCount,
        requiredIngredientCount: item.requiredIngredientCount,
        verificationStatus: item.verificationStatus,
      })),
      discriminationPath: formulaDiscriminationPaths(resolvedFormulaNames, clinicalContext),
      // 必须在这里截到 schema 上限：contract 里该字段是 .max(6).catch([])，
      // 而 classicEvidenceForFormulaNames 返回最多 12 条（M04 提示词那一路要用满 12）。
      // 超限时 catch 的语义是**整段清空**而非截断——7~12 条会让这一味候选的经典证据
      // 一条不剩，且不报错。tcmoc 语料接上后 12 条正是常态，这个静默清空会成为默认行为。
      classicEvidence: (classicEvidenceResolver
        ? classicEvidenceResolver(resolvedFormulaNames)
        : candidate.classicEvidence || []).slice(0, CANDIDATE_CLASSIC_EVIDENCE_LIMIT),
      compositionLogic: compositionLogicForFormulaNames(resolvedFormulaNames),
      // 必须先 slice 到契约上限：`textualModifications` 的 `.max(6).catch([])` 语义是
      // **整段清空而非截断**，超限的后果是医生一条条文加减线索都看不到，且与「没有命中」
      // 不可区分。紧邻的 classicEvidence 早就为此加了 slice（见 CANDIDATE_CLASSIC_EVIDENCE_LIMIT），
      // 这一条漏了：实测逍遥散命中 8 条、小柴胡汤 7 条，两个最常用的方都超限归零。
      textualModifications: textualModificationsForFormulaNames(resolvedFormulaNames, clinicalContext)
        .slice(0, CANDIDATE_TEXTUAL_MODIFICATION_LIMIT),
      formulaSource: sourceLabel
        ? {
            evidenceLevel: sources.every((item) => item.origin !== "local_formula_catalog") ? "classic_text" as const : "kb_entry" as const,
            source: sourceLabel,
            confidence: modificationStatus === "canonical" && sources.every((item) => item.origin === "official_classic_catalog" && item.exactComposition)
              ? "高" as const
              : "中" as const,
          }
        : professionalModelInferenceEvidence(selfDevisedReferenceSource(candidate.herbs.map((herb) => herb.name))),
      herbs: governedHerbs.map((herb, herbIndex) => ({
        ...herb,
        isToxic: herbSafetyProfiles[herbIndex]?.isToxic === true,
        ...(/酸枣仁/.test(herb.name) && /先煎/.test(herb.decoctionRequirement || "")
          ? { decoctionRequirement: "捣碎后与群药同煎" }
          : {}),
        evidence: herb.evidence?.evidenceLevel !== "insufficient"
          ? herb.evidence
          : professionalModelInferenceEvidence(undefined),
      })),
    };
  });
  return { reasoning: { ...reasoning, formula: { ...reasoning.formula, candidates } }, sourceLabels };
}

// 自拟方没有「原方」可指：编译时补的「原方中的X毒性较大，本方未用。」整句去掉，不随下面的「原方」→「本方案」变成
// 「本方案中的朱砂粉毒性较大」（说本方里有朱砂；方外药核对随后删掉这个分句，只剩残句「本方未用。」，见 formula-withheld-ingredient-note）。
function replaceSelfDevisedFormulaClaims(block: string, explicitIdentityNames: string[]): string {
  return replaceGovernedFormulaClaims(
    replaceLiteralFormulaClaims(withoutWithheldBaseIngredientNote(block), explicitIdentityNames, "本例辨证组方"),
    "本例辨证组方",
  ).replace(/原方/g, "本方案");
}

function replaceFormulaIdentityClaims(value: string, explicitIdentityNames: string[]): string {
  return replaceGovernedFormulaClaims(
    replaceLiteralFormulaClaims(withoutWithheldBaseIngredientNote(value), explicitIdentityNames, "本方案"),
    "本方案",
  ).replace(/原方/g, "本方案");
}

function professionalCandidateBoundary(value: string, fallback: string): string {
  return /(?:待核实|未在本次|未记录|未明确|未提及|阴性史待)/.test(value) ? fallback : value;
}

function replaceCandidateSourceFields(
  content: string,
  sourceLabels: string[],
  sourceHeadings: string[],
  candidateNames: string[],
  candidateConstructionTypes: string[],
  candidateIdentityClaims: string[][],
): string {
  const headingPattern = /^#{2,6}\s*候选(?:处方|方案|方药|方药方案)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[：:]\s*[^\n]+/gm;
  const headings = Array.from(content.matchAll(headingPattern));
  if (headings.length === 0) return content;
  let output = "";
  let cursor = 0;
  headings.forEach((heading, index) => {
    const start = heading.index || 0;
    const sentinelIndex = content.search(/<!-- DIAGNOSIS_JSON_START -->/);
    const end = headings[index + 1]?.index ?? (sentinelIndex >= 0 ? sentinelIndex : content.length);
    output += content.slice(cursor, start);
    let block = content.slice(start, end);
    const verifiedName = candidateNames[index];
    if (verifiedName) block = block.replace(/^(#{2,6}\s*候选(?:处方|方案|方药|方药方案)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[：:])\s*[^\n]+/m, `$1${verifiedName}`);
    if (candidateConstructionTypes[index] === "self_devised") {
      block = replaceSelfDevisedFormulaClaims(block, candidateIdentityClaims[index] || []);
    }
    const sourceLabel = sourceLabels[index] || "";
    const sourceHeading = sourceHeadings[index] || "组方依据";
    const replacement = sourceLabel ? `**${sourceHeading}**：${sourceLabel}` : "";
    const sourceField = /^\*\*(?:方剂出处或依据|经典方出处|参考基础方及出处|方剂资料收载来源|组方依据)\*\*[：:].*$/m;
    if (sourceField.test(block)) {
      block = block.replace(sourceField, replacement);
    } else if (replacement) {
      block = block.replace(/^(###[^\n]+)$/m, `$1\n${replacement}`);
    }
    output += block;
    cursor = end;
  });
  return output + content.slice(cursor);
}

export function enrichPrescriptionProvenance(
  content: string,
  clinicalContext = "",
  classicEvidenceResolver?: ClassicEvidenceResolver,
): string {
  let sourceLabels: string[] = [];
  let sourceHeadings: string[] = [];
  let candidateNames: string[] = [];
  let candidateConstructionTypes: string[] = [];
  let candidateIdentityClaims: string[][] = [];
  const enriched = content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== "prescribe") return match;
        candidateIdentityClaims = parsed.formula?.candidates.map((candidate) =>
          explicitFormulaIdentityNames([candidate.name, ...(candidate.formulaNames || [])])
        ) || [];
        const result = enrichReasoning(parsed, clinicalContext, classicEvidenceResolver);
        sourceLabels = result.sourceLabels;
        sourceHeadings = result.reasoning.formula?.candidates.map((candidate) =>
          candidate.modificationStatus === "modified" && candidate.formulaSource.evidenceLevel !== "model_inference"
            ? "参考基础方及出处"
            : candidate.formulaSource.evidenceLevel === "classic_text"
              ? "经典方出处"
              : candidate.formulaSource.evidenceLevel === "kb_entry"
                ? "方剂资料收载来源"
                : "组方依据"
        ) || [];
        candidateNames = result.reasoning.formula?.candidates.map((candidate) => candidate.name) || [];
        candidateConstructionTypes = result.reasoning.formula?.candidates.map((candidate) => candidate.constructionType || "") || [];
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(result.reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
  const alignedNarrative = replaceCandidateSourceFields(
    enriched,
    sourceLabels,
    sourceHeadings,
    candidateNames,
    candidateConstructionTypes,
    candidateIdentityClaims,
  );
  // 酸枣仁写成「先煎」时改成「捣碎后同煎」。只改紧跟在酸枣仁后面、中间没有别的药或分隔号的那一处：此前整行里所有「先煎」都改，
  // 煎服用法点名酸枣仁（「龙齿先煎20–30分钟，…，酸枣仁用前捣碎」）后，龙齿也成了「捣碎后同煎」（2026-10-22 实测；
  // 交付面 withoutContradictedDecoctionClaims 注释里的 BEST4SDT-139「龙齿捣碎后同煎」是同一个根因）。
  return alignedNarrative.replace(/酸枣仁([^，,；;、。\n]{0,12}?)先煎(?:\s*\d+(?:[–-]\d+)?\s*分钟)?/g, "酸枣仁$1捣碎后同煎");
}

export function buildFormulaProvenanceContext(caseState: CaseState): string {
  const diagnose = caseState.reasoningDiagnose || (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined);
  const references = formulaCompilationReferences(diagnose?.overview?.recommendedFormulaNames || []);
  if (references.length === 0) {
    // 不要在这里宣传方剂资料总量。出处库只负责给「已选定的方名」补出处，可被推荐的方剂仅限受控
    // 检索目录；报出目录外的方名会在锁定阶段被剥离并降级为自拟方，宣传一个更大的库只会诱发该失败。
    return "## 本地方剂出处库\n候选方名确定后，由服务端匹配经典出处；可选方剂以上文受控经典方候选为准。若为自拟方，不得伪造原典，只能说明本例组方依据。";
  }
  return [
    "## 本地方剂出处库",
    "以下出处来自本地标准方剂索引；合方须逐一列出基础方出处，加减药味另述本例病机依据：",
    ...references.map((item, index) => `[LOCAL-FORMULA-${String(index + 1).padStart(3, "0")}] ${item.formulaName}：${item.source}`),
  ].join("\n");
}

export function getFormulaCatalogStatus() {
  return {
    schemaVersion: catalog.schemaVersion,
    sourceFile: catalog.sourceFile,
    sourceSha256: catalog.sourceSha256,
    sourceRowCount: catalog.sourceRowCount,
    formulaNameCount: catalog.formulaNameCount,
    officialClassicSourceFile: catalog.officialClassicSourceFile,
    officialClassicSourceSha256: catalog.officialClassicSourceSha256,
    officialClassicFormulaCount: catalog.officialClassicFormulaCount,
    verifiedSupplementSchemaVersion: verifiedSupplements.schemaVersion,
    verifiedSupplementFormulaCount: Object.keys(verifiedSupplements.entries).length,
  };
}

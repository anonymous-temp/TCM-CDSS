import nameFormsJson from "../data/drug-inventory-name-forms.source.json";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { isKnownTcmHerbName } from "./tcm-knowledge";

/**
 * 院内药品目录的写法清洗（2026-09-28）。
 *
 * 甲方推来的是各诊所 HIS 里的药品名，不是标准名。生产上 55 家真实诊所、24,485 条饮片名，
 * 只有 63.0% 能直接对上受治理正名；对不上的药即使有货也被标成缺货（本机 379 张处方 × 55 家，
 * 误标 20.2%，最多的是甘草——院内写「甘草片」）。常见写法：计费前缀「（免）川牛膝」「Y荆芥」，
 * 规格后缀「浙贝母/片」，括注「炒酸枣仁（打碎）」「附片（黑顺片）」，片段粉「党参段」「三七粉」，
 * 尾随编号「当归8」，以及标准名目录未单列的炮制写法「醋五味子」「蜜款冬花」。
 *
 * 这里的归并**只用于库存可得性匹配**，不回写受治理标准名目录：
 * - 炮制前缀只剥「炒/焦/麸炒/蜜/炙/酒/醋/盐/姜/净/蒸/燀/烫/干」这类同药加工，且只在全名
 *   本身对不上时才剥。「制/煅/生/熟/炭」不剥：制何首乌与何首乌、煅石膏（外用）与石膏、
 *   荆芥炭与荆芥临床上不能互换；标准名目录已单列的（炙甘草、熟地黄、法半夏）按全名解析，不会走到这里。
 * - 中医师 2026-08-16 裁定「炒神曲/焦神曲在无独立依据时不得自动合并功效」，所以这层归并不进入
 *   功效、剂量或十八反的任何判断——它只回答「院内有没有这味药」，并在出参里带上院内原名供药师核对。
 */

export type DrugInventoryItemKind = "herb" | "patent" | "western";
export type InventoryItemForm = "powder" | "granule";

// 写法清单来自受治理数据文件 drug-inventory-name-forms.source.json（代码里不手写临床词表）。
type NameForms = {
  kindAliases: { herb: string[]; herbGranule: string[]; patent: string[]; western: string[] };
  availableTrue: string[];
  availableFalse: string[];
  billingPrefixMarks: string[];
  sameHerbPreparationPrefixes: string[];
  cutSuffixes: string[];
  powderSuffixes: string[];
  granuleNotes: string[];
  suspectMarks: string[];
  nonHerbFormMarks: string[];
  medicineFormSuffixes: string[];
  specUnits: string[];
};
const FORMS = nameFormsJson as unknown as NameForms;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 长写法在前，避免「炒」先吃掉「麸炒」。 */
function alternation(values: readonly string[]): string {
  return [...values].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|");
}

type KindAlias = { kind: DrugInventoryItemKind; form?: InventoryItemForm };
const KIND_ALIASES: ReadonlyMap<string, KindAlias> = new Map<string, KindAlias>([
  ...FORMS.kindAliases.herb.map((alias): [string, KindAlias] => [alias, { kind: "herb" }]),
  ...FORMS.kindAliases.herbGranule.map((alias): [string, KindAlias] => [alias, { kind: "herb", form: "granule" }]),
  ...FORMS.kindAliases.patent.map((alias): [string, KindAlias] => [alias, { kind: "patent" }]),
  ...FORMS.kindAliases.western.map((alias): [string, KindAlias] => [alias, { kind: "western" }]),
]);

/** `kind` 的受控写法。缺省为饮片；无法识别的写法返回 undefined（整批拒收并逐条回报，不猜）。 */
export function inventoryKindFromInput(value: unknown): { kind: DrugInventoryItemKind; form?: InventoryItemForm } | undefined {
  if (value === undefined || value === null || value === "") return { kind: "herb" };
  if (typeof value !== "string") return undefined;
  const key = value.normalize("NFKC").trim();
  return KIND_ALIASES.get(key) || KIND_ALIASES.get(key.toLowerCase());
}

const AVAILABLE_TRUE = new Set(FORMS.availableTrue);
const AVAILABLE_FALSE = new Set(FORMS.availableFalse);

/**
 * `available` 的受控写法。缺省为有货（推过来的就是在售目录）。
 * 旧实现只认 `true`，`available: 1` 等于缺货——那是一次真实缺陷；这里把常见写法显式映射，
 * 其余写法（如 2、"maybe"）返回 undefined，由调用方整批拒收。
 */
export function inventoryAvailableFromInput(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return undefined;
  const key = value.normalize("NFKC").trim().toLowerCase();
  if (AVAILABLE_TRUE.has(key)) return true;
  if (AVAILABLE_FALSE.has(key)) return false;
  return undefined;
}

// 计费/分类前缀：「（免）」「【免】」，以及紧贴汉字前的单个字母（Y荆芥、Z广藿香、K当归(配方颗粒)）。
const BILLING_PREFIX = new RegExp(`^(?:[（(【\\[](?:${alternation(FORMS.billingPrefixMarks)})[）)】\\]])+`);
const LETTER_PREFIX = /^[A-Za-z](?=[\u4e00-\u9fff])/;
const SAME_HERB_PREPARATION_PREFIX = new RegExp(`^(?:${alternation(FORMS.sameHerbPreparationPrefixes)})`);
const CUT_SUFFIX = new RegExp(`^(.{2,}?)(?:${alternation(FORMS.cutSuffixes)})$`);
const POWDER_SUFFIX = new RegExp(`^(.{2,}?)(?:${alternation(FORMS.powderSuffixes)})$`);
const GRANULE_NOTE = new RegExp(alternation(FORMS.granuleNotes));
const SUSPECT_MARK = new RegExp(alternation(FORMS.suspectMarks), "i");
const TRAILING_CODE = /\d+$/;
const NOT_HERB_FORM = new RegExp(`${alternation(FORMS.nonHerbFormMarks)}|\\d+(?:\\.\\d+)?\\s*(?:mg|ml|μg)\\b`, "i");

export type InventoryHerbResolution = {
  /** 受治理正名（与处方侧同一套标准名）；空串 = 对不上。 */
  canonicalName: string;
  status: "resolved" | "ambiguous" | "unresolved";
  /** 实际用来对上标准名的写法（清洗后），未经清洗直接对上时不填。 */
  matchedAs?: string;
  form?: InventoryItemForm;
  /** 疑似测试或编号条目（「当归8」「测试中药75601669」），回报给甲方核对，照常参与匹配。 */
  suspect?: boolean;
  /** 名字像中成药/西药（颗粒、胶囊、注射液、规格数字），多半是 kind 漏填缺省成了饮片。 */
  likelyNotHerb?: boolean;
};

function governedCanonical(name: string): { canonicalName: string; ambiguous: boolean } {
  const identity = resolveGovernedTcmHerbIdentity(name);
  if (identity.status === "ambiguous") return { canonicalName: "", ambiguous: true };
  const canonical = identity.doseCanonicalName || identity.canonicalName || "";
  return { canonicalName: canonical && isKnownTcmHerbName(canonical) ? canonical : "", ambiguous: false };
}

function cleanedCandidates(raw: string): { candidates: string[]; form?: InventoryItemForm; suspect: boolean } {
  let form: InventoryItemForm | undefined;
  let suspect = SUSPECT_MARK.test(raw);
  let value = raw.normalize("NFKC").replace(/\s+/g, "").replace(BILLING_PREFIX, "");
  if (LETTER_PREFIX.test(value)) value = value.replace(LETTER_PREFIX, "");
  value = value.split("/")[0];
  const candidates: string[] = [];
  const paren = value.match(/^(.*?)[（(]([^）)]*)[）)](.*)$/);
  if (paren) {
    const outside = `${paren[1]}${paren[3]}`;
    if (GRANULE_NOTE.test(paren[2])) form = "granule";
    candidates.push(outside);
    if (paren[2] && !GRANULE_NOTE.test(paren[2])) candidates.push(paren[2]);
  } else {
    candidates.push(value);
  }
  for (const candidate of [...candidates]) {
    const withoutCode = candidate.replace(TRAILING_CODE, "");
    if (withoutCode !== candidate) {
      if (candidate.length - withoutCode.length >= 3) suspect = true;
      candidates.push(withoutCode);
    }
  }
  for (const candidate of [...candidates]) {
    const cut = candidate.match(CUT_SUFFIX);
    if (cut) candidates.push(cut[1]);
    const powder = candidate.match(POWDER_SUFFIX);
    if (powder) {
      candidates.push(powder[1]);
    }
  }
  for (const candidate of [...candidates]) {
    const stripped = candidate.replace(SAME_HERB_PREPARATION_PREFIX, "");
    if (stripped !== candidate && stripped.length >= 2) candidates.push(stripped);
  }
  return { candidates: [...new Set(candidates.filter((item) => item.length >= 2))], form, suspect };
}

/**
 * 院内饮片名 → 受治理正名（只用于可得性匹配）。先按原名走受治理目录；原名歧义的绝不自动择一
 * （一包针 → 千年健/石韦）；原名对不上才按上面的写法规则逐个试，第一个能对上的为准。
 */
export function resolveInventoryHerbName(raw: string): InventoryHerbResolution {
  const name = String(raw || "").trim();
  if (!name) return { canonicalName: "", status: "unresolved" };
  const direct = governedCanonical(name);
  if (direct.ambiguous) return { canonicalName: "", status: "ambiguous" };
  const cleaned = cleanedCandidates(name);
  const flags = {
    ...(cleaned.suspect ? { suspect: true } : {}),
    ...(NOT_HERB_FORM.test(name) && cleaned.form !== "granule" ? { likelyNotHerb: true } : {}),
  };
  if (direct.canonicalName) {
    return { canonicalName: direct.canonicalName, status: "resolved", ...(cleaned.form ? { form: cleaned.form } : {}), ...flags };
  }
  for (const candidate of cleaned.candidates) {
    if (candidate === name) continue;
    const resolved = governedCanonical(candidate);
    if (resolved.ambiguous) continue;
    if (!resolved.canonicalName) continue;
    const form = cleaned.form || (POWDER_SUFFIX.test(name.replace(/[（(].*$/, "")) ? "powder" : undefined);
    return {
      canonicalName: resolved.canonicalName,
      status: "resolved",
      matchedAs: candidate,
      ...(form ? { form } : {}),
      ...flags,
    };
  }
  return { canonicalName: "", status: "unresolved", ...flags };
}

const PATENT_OR_WESTERN_FORM_SUFFIX = new RegExp(`(?:${alternation(FORMS.medicineFormSuffixes)})$`);
const SPEC_TAIL = new RegExp(`(?<![A-Za-z\\d.])\\d+(?:\\.\\d+)?(?:${alternation(FORMS.specUnits)}).*$`, "i");

/**
 * 中成药/西药名的匹配键：去括注、空白、计费前缀，去掉从第一个「数字+单位」或「*」起的规格尾巴
 * （阿莫西林胶囊0.25g*24粒 → 阿莫西林胶囊）。名字里本身的数字不动（维生素B12、辅酶Q10），
 * 否则维生素B1 与 B6 会被当成同一种药。
 */
export function medicineNameKey(name: string): string {
  return String(name || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(BILLING_PREFIX, "")
    .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "")
    .replace(/[*×].*$/, "")
    .replace(SPEC_TAIL, "")
    .toLowerCase();
}

/** 去剂型后的基础名：逍遥丸 / 逍遥颗粒 → 逍遥；奥美拉唑肠溶胶囊 → 奥美拉唑。 */
export function medicineBaseKey(name: string): string {
  const key = medicineNameKey(name);
  const base = key.replace(PATENT_OR_WESTERN_FORM_SUFFIX, "");
  return base.length >= 2 ? base : key;
}

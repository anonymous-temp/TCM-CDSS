import herbIdentityJson from "../data/tcm-herb-identity-catalog.json" with { type: "json" };

export type GovernedHerbIdentityStatus =
  | "exact_standard_name"
  | "unique_high_confidence"
  | "unique_source_backed"
  | "source_backed_clinical_extension"
  | "source_backed_preparation_form"
  | "unique_mapping_requires_review"
  | "ambiguous"
  | "unmapped";

export type GovernedHerbIdentityResolution = {
  inputName: string;
  canonicalName?: string;
  suggestedCanonicalName?: string;
  status: GovernedHerbIdentityStatus;
  candidates: string[];
  preparation?: string;
  medicinalPart?: string;
  doseCanonicalName?: string;
};

type ResolutionRow = {
  canonicalName: string | null;
  status: Exclude<GovernedHerbIdentityStatus, "unmapped">;
  autoResolvable?: boolean;
  candidates?: string[];
  preparation?: string;
  medicinalPart?: string;
  doseCanonicalName?: string;
};

const RESOLUTION_INDEX = herbIdentityJson.resolutionIndex as Readonly<Record<string, ResolutionRow>>;

function identityInput(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

/**
 * 药名身份不可判定：单个汉字。
 *
 * 现代饮片规范名没有单字的。目录里出现的单字有两个来源——古籍抽取丢字（源书 GB18030，
 * 生僻字丢失后「黄芪」只剩「黄」），以及古文本身的简写（《医方集解》写「桂」）。
 * 两者性质相同：**这一味到底是什么药，从名字判不出来**。「黄」可以是黄芪/黄芩/黄连/大黄，
 * 「桂」可以是肉桂/桂枝——猜错就是开成方向相反的药。
 *
 * 判据放在 T9 这一层，是因为身份解析是剂量、功用、存在性三条路径共同的入口；
 * 放在任何一条下游都会漏另外两条。构建期 python 侧有同名同集断言（test:herb-name-identity）。
 */
export function isIdentityIndeterminateHerbName(value: unknown): boolean {
  const raw = identityInput(value);
  if (!raw) return false;
  return [...raw].length === 1 && /[一-鿿]/.test(raw);
}

/**
 * T9 is the first and authoritative identity resolver. A multi-target alias remains unresolved;
 * callers may display its candidates for pharmacist confirmation but must never silently choose one.
 */
export function resolveGovernedTcmHerbIdentity(value: unknown): GovernedHerbIdentityResolution {
  const inputName = identityInput(value);
  if (!inputName) return { inputName, status: "unmapped", candidates: [] };
  // 单字残片一律按歧义处理：既不给 canonicalName（因此不会被自动配剂量），
  // 也不假装未收录——它确实指向某味药，只是从这个名字判不出是哪一味，须回源或人工裁定。
  // 实测放开的后果：豉→淡豆豉、草→甘草、本→藁本、芎→川芎，四味被静默解析并配上数值区间。
  if (isIdentityIndeterminateHerbName(inputName)) {
    const row = RESOLUTION_INDEX[inputName];
    const candidates = row?.candidates?.length
      ? [...row.candidates]
      : row?.canonicalName
        ? [row.canonicalName]
        : [];
    return { inputName, status: "ambiguous", candidates };
  }
  const row = RESOLUTION_INDEX[inputName];
  if (!row) return { inputName, status: "unmapped", candidates: [] };
  if (row.status === "ambiguous" || !row.canonicalName) {
    return { inputName, status: "ambiguous", candidates: [...(row.candidates || [])] };
  }
  if (!row.autoResolvable) {
    return {
      inputName,
      suggestedCanonicalName: row.canonicalName,
      status: row.status,
      candidates: [row.canonicalName],
    };
  }
  return {
    inputName,
    canonicalName: row.canonicalName,
    status: row.status,
    candidates: [],
    ...(row.preparation ? { preparation: row.preparation } : {}),
    ...(row.medicinalPart ? { medicinalPart: row.medicinalPart } : {}),
    ...(row.doseCanonicalName ? { doseCanonicalName: row.doseCanonicalName } : {}),
  };
}

export function isAmbiguousGovernedTcmHerbIdentity(value: unknown): boolean {
  return resolveGovernedTcmHerbIdentity(value).status === "ambiguous";
}

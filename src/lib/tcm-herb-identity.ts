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

/**
 * 身份分叉：知道是一味药，但落不到唯一一个药典规范名上——歧义且有两个以上受控候选品种。
 *
 * 与 isAmbiguousGovernedTcmHerbIdentity 的区别很要紧，别用错：
 * · 芍药→[白芍,赤芍]、皂角→[大皂角,猪牙皂]、贯众→[狗脊,绵马贯众]、青木香→[木香,防己]
 *   —— 分叉。规范名为空，十八反十九畏、特殊人群门禁、管制毒性排除全按规范名索引，
 *   这一味对每一道安全检查都是隐形的。
 * · 白蜜/沙蜜 status 同样是 ambiguous，但已解析到「蜂蜜」，规范名在、安全检查看得见，
 *   不是分叉。把它们一并当分叉处理只会白挡掉大陷胸丸、猪肤汤，换不来任何安全收益。
 *
 * 与构建期 scripts/build-tcm-governance-tables.py 的 is_variety_forked_link 同一判据，
 * 两侧分叉会让「构建期标可编译、运行时判不可编译」重演。
 */
export function isVarietyForkedHerbIdentity(value: unknown): boolean {
  const resolution = resolveGovernedTcmHerbIdentity(value);
  return resolution.status === "ambiguous" && resolution.candidates.length >= 2;
}

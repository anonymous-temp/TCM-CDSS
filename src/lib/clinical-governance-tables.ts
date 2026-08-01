import diagnosticsContextJson from "../data/diagnostics-context-lexicon.json" with { type: "json" };
import clinicalOutputContractJson from "../data/clinical-output-contract-registry.json" with { type: "json" };
import clinicalRequiredFieldJson from "../data/clinical-required-field-matrix.json" with { type: "json" };
import engineeringJargonJson from "../data/engineering-jargon-lexicon.json" with { type: "json" };
import redflagTriageJson from "../data/redflag-triage-lexicon.json" with { type: "json" };
import tcmLocationJson from "../data/tcm-location-lexicon.json" with { type: "json" };
import tcmNatureJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import tcmSyndromeJson from "../data/tcm-syndrome-lexicon.json" with { type: "json" };
import tcmTreatmentPrincipleJson from "../data/tcm-treatment-principle-lexicon.json" with { type: "json" };
import tcmNondrugTreatmentJson from "../data/tcm-nondrug-treatment-evidence-catalog.json" with { type: "json" };
import tcmClinicalTerminologyExtensionsJson from "../data/tcm-clinical-terminology-extensions.json" with { type: "json" };

type CanonicalEntry = {
  id: string;
  canonical: string;
  aliases: readonly string[];
  termClass?: string;
};

type DiagnosticContextGroup = {
  id: string;
  class: string;
  terms: readonly string[];
  tcmReasoningPolicy: string;
  forbiddenFrames: readonly string[];
};

type EngineeringJargonEntry = {
  id: string;
  terms: readonly string[];
  replacement: string;
  severity: string;
};

type TreatmentPrincipleEntry = CanonicalEntry & {
  examples: readonly string[];
  relationPolicy: string;
  permitsPrioritization?: boolean;
};

type RequiredFieldPolicyEntry = {
  id: string;
  label: string;
  casePaths: readonly string[];
  m02TargetField?: string;
  stagePolicy: Readonly<Record<string, string>>;
  currentEnforcement: string;
  unknownPolicy: string;
  rationale: string;
};

type TerminologyExtensions = {
  syndromeEntries: CanonicalEntry[];
  treatmentAliasAugmentations: Array<{ targetCanonical: string; aliases: string[] }>;
  treatmentEntries: TreatmentPrincipleEntry[];
};

const terminologyExtensions = tcmClinicalTerminologyExtensionsJson as TerminologyExtensions;
const syndromeEntries = [
  ...(tcmSyndromeJson.entries as readonly CanonicalEntry[]),
  ...terminologyExtensions.syndromeEntries,
] as readonly CanonicalEntry[];
const natureEntries = tcmNatureJson.entries as readonly CanonicalEntry[];
const locationEntries = tcmLocationJson.entries as readonly CanonicalEntry[];
const treatmentAliasAugmentations = new Map(
  terminologyExtensions.treatmentAliasAugmentations.map((item) => [item.targetCanonical, item.aliases] as const),
);
const treatmentPrincipleEntries = [
  ...(tcmTreatmentPrincipleJson.entries as readonly TreatmentPrincipleEntry[]).map((entry) => ({
    ...entry,
    aliases: [...new Set([...entry.aliases, ...(treatmentAliasAugmentations.get(entry.canonical) || [])])],
  })),
  ...terminologyExtensions.treatmentEntries,
] as readonly TreatmentPrincipleEntry[];
const diagnosticContextGroups = diagnosticsContextJson.groups as readonly DiagnosticContextGroup[];
const engineeringJargonEntries = engineeringJargonJson.entries as readonly EngineeringJargonEntry[];
const requiredFieldEntries = clinicalRequiredFieldJson.entries as readonly RequiredFieldPolicyEntry[];
const requiredFieldById = new Map(requiredFieldEntries.map((entry) => [entry.id, entry]));

function normalizedTerm(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\s，,。；;：:、（）()【】\[\]“”'\"]+/g, "").trim()
    : "";
}

function canonicalMap(entries: readonly CanonicalEntry[], stripTcmSuffix = false): Map<string, CanonicalEntry> {
  const result = new Map<string, CanonicalEntry>();
  for (const entry of entries) {
    for (const value of [entry.canonical, ...entry.aliases]) {
      const compact = normalizedTerm(value);
      const token = stripTcmSuffix ? compact.replace(/(?:证候|证|型)$/u, "") : compact;
      if (token && !result.has(token)) result.set(token, entry);
    }
  }
  return result;
}

function syndromeToken(value: unknown): string {
  return normalizedTerm(value).replace(/(?:证候|证|型)$/u, "");
}

const syndromeCanonicalByToken = new Map<string, CanonicalEntry>();
const syndromeAliasCandidatesByToken = new Map<string, CanonicalEntry[]>();
for (const entry of syndromeEntries) {
  const canonicalToken = syndromeToken(entry.canonical);
  if (canonicalToken && !syndromeCanonicalByToken.has(canonicalToken)) syndromeCanonicalByToken.set(canonicalToken, entry);
  for (const alias of entry.aliases) {
    const token = syndromeToken(alias);
    if (!token) continue;
    const candidates = syndromeAliasCandidatesByToken.get(token) || [];
    if (!candidates.some((candidate) => candidate.id === entry.id)) candidates.push(entry);
    syndromeAliasCandidatesByToken.set(token, candidates);
  }
}
const syndromeByToken = new Map(syndromeCanonicalByToken);
for (const [token, candidates] of syndromeAliasCandidatesByToken) {
  if (!syndromeByToken.has(token) && candidates.length === 1) syndromeByToken.set(token, candidates[0]);
}
const natureByToken = canonicalMap(natureEntries);
const locationByToken = canonicalMap(locationEntries);
const governedTermById = new Map(
  [...syndromeEntries, ...natureEntries, ...locationEntries].map((entry) => [entry.id, entry] as const),
);

export function canonicalTcmSyndromeTerm(value: unknown): CanonicalEntry | undefined {
  const token = syndromeToken(value);
  const canonical = syndromeCanonicalByToken.get(token);
  if (canonical) return canonical;
  const candidates = syndromeAliasCandidatesByToken.get(token) || [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function resolveTcmSyndromeTerm(value: unknown): {
  status: "canonical" | "alias" | "ambiguous" | "unmapped";
  entry?: CanonicalEntry;
  candidates: CanonicalEntry[];
} {
  const token = syndromeToken(value);
  const canonical = syndromeCanonicalByToken.get(token);
  if (canonical) return { status: "canonical", entry: canonical, candidates: [canonical] };
  const candidates = syndromeAliasCandidatesByToken.get(token) || [];
  if (candidates.length === 1) return { status: "alias", entry: candidates[0], candidates };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unmapped", candidates: [] };
}

export function canonicalTcmNatureTerm(value: unknown): CanonicalEntry | undefined {
  return natureByToken.get(normalizedTerm(value));
}

export function canonicalTcmLocationTerm(value: unknown): CanonicalEntry | undefined {
  return locationByToken.get(normalizedTerm(value));
}

/** Return governed T3 locations explicitly named in a syndrome/pathogenesis statement. */
export function governedTcmLocationsInText(value: unknown): CanonicalEntry[] {
  const text = normalizedTerm(value);
  if (!text) return [];
  return locationEntries.filter((entry) =>
    [entry.canonical, ...entry.aliases]
      .map(normalizedTerm)
      .filter(Boolean)
      .some((token) => text.includes(token)));
}

/** Resolve T1/T3/T4 stable IDs when another governance table stores normalized relations. */
export function governedTcmTermLabelById(value: unknown): string | undefined {
  return typeof value === "string" ? governedTermById.get(value)?.canonical : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 证候特征等同层（同证异名的根源治理）
//
// 问题的类：GB/T 16751.2 给临床上同一个证收了多个各自独立的条目——心虚胆怯/心胆气虚、
// 肝气犯胃/肝胃不和、胃火上炎/胃火炽盛、肾阴虚/肾阴不足。模型写规范名、方剂目录标古典名，
// 两个 id 对不上，方就永远锁不住。逐对手工补别名不可扩展：10 例病历撞上 5 对，1 万例会撞上
// 几百对。
//
// 根源解法：词表条目**自带国标结构化特征**（locations×natures，覆盖 98.5% 非目录条目），
// 同证异名在特征层天然汇合——肝气犯胃与肝胃不和的特征逐项相等。等同判定完全建立在这两组
// 受控枚举上，不做任何文本相似度，新增条目自动纳入。
//
// 两级判定，各自有边界依据：
//   1) 严格等同（对称）：脏腑病位相等 且 归一化病性相等。用于等价类展开（检索召回）。
//   2) 特征包含（对称判定、单向包含）：脏腑病位相等，一方病性是另一方的子集且较小方非空，
//      差集不含对立病性。用于「签名证候 ↔ 方剂标签」匹配——国标释义会把继发表现写进特征
//      （胃火上炎多出 fluid_retention），包含关系吸收这类溢出而不吸收方向冲突。
//
// 三条安全边界：
//   - 对立病性一票否决：阴虚/阳虚、寒/热、虚/实 出现在差集即不匹配（肾阴虚≠肾阳虚）。
//   - 卫气营血层次位（qi_level/vessels 等）不参与脏腑病位比较——它们是释义溢出的主要来源，
//     但**六经与表里位保留**：风寒束表(exterior)与风寒束肺(lung)因病位不同而**不等同**，这是
//     刻意的（表证与脏腑证是两个临床判断）。方剂召回/锁定层另有受控的表↔肺卫外感风证
//     match-tier 相容（见下方 exteriorLungWindCompatible），只影响方剂适用性判定，
//     不改签名证候、不进等价类。
//   - 无特征条目（1.5%）不参与任何等同——fail-closed，不猜。
// ─────────────────────────────────────────────────────────────────────────────

type SyndromeFeatureEntry = CanonicalEntry & {
  locations?: readonly string[];
  natures?: readonly string[];
  category?: string;
};

/** 卫气营血层次与泛化脉络位：释义溢出的主要来源，不代表脏腑归属。 */
const CHANNEL_LAYER_LOCATIONS = new Set([
  "wei_level", "qi_level", "ying_level", "blood_level", "vessels", "channels", "collaterals",
]);

/** 对立病性：任一对同时落在两个证候的特征差集里，即判不等同。 */
const OPPOSING_NATURE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["yin_deficiency", "yang_deficiency"],
  ["cold", "heat"],
  ["cold", "fire_heat"],
  ["blood_cold", "blood_heat"],
  ["deficiency", "excess"],
];

/**
 * 名称层极性否决：国标特征抽取在小条目上会丢维度（风寒袭咽与风热侵咽的特征都只剩 wind），
 * 但名称本身保留着被丢掉的那一维。寒/热、阴/阳、虚/实、温/凉在两个名称上呈对立分布时，
 * 无论特征怎么说都不得等同——这是对上游数据缺陷的确定性兜底，不是文本相似度。
 */
const LABEL_POLARITY_PAIRS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/[寒凉]/, /[热火温燔]/],
  [/阴(?!阳)/, /(?<!阴)阳/],
  // 旺/亢/盛 是实证侧的常用字（肝旺、阳亢、火盛）：肝旺脾虚 与 肝脾两虚 在特征层曾并到一类，
  // 名称里的「旺」对「虚」正是被特征抽取丢掉的那一维。
  [/虚(?!实)/, /[实旺亢盛]/],
];
/**
 * 名称同时携带一对极性的两侧（肝旺脾虚、上热下寒、表寒里热）意味着极性是**按脏腑/部位分配**的，
 * 而特征档案是不分脏腑的病位集×病性集，根本表达不了这种分配。这类证候参与等同只会并错
 * （肝旺脾虚曾与肝脾两虚并到一类），按 fail-closed 整体退出。
 */
function mixedPolarityLabel(label: string): boolean {
  return LABEL_POLARITY_PAIRS.some(([a, b]) => a.test(label) && b.test(label));
}

function labelPolarityConflict(leftLabel: string, rightLabel: string): boolean {
  return LABEL_POLARITY_PAIRS.some(([a, b]) =>
    (a.test(leftLabel) && !b.test(leftLabel) && b.test(rightLabel) && !a.test(rightLabel)) ||
    (b.test(leftLabel) && !a.test(leftLabel) && a.test(rightLabel) && !b.test(rightLabel)));
}

function normalizedSyndromeNatures(natures: readonly string[]): Set<string> {
  const set = new Set(natures);
  // 泛化「deficiency」在存在具体某虚（气虚/血虚/阴虚/阳虚/精亏）时是冗余标注：
  // 心虚胆怯 nat=[deficiency, qi_deficiency] 与 心胆气虚 nat=[qi_deficiency] 是同一证。
  // 只在具体虚存在时去掉泛化位；孤立的 deficiency（如「里虚」）原样保留。
  if (set.has("deficiency") &&
    [...set].some((item) => item !== "deficiency" && item.endsWith("_deficiency"))) {
    set.delete("deficiency");
  }
  if (set.has("excess") && [...set].some((item) => item !== "excess" && (item === "fire_heat" || item.endsWith("_stagnation") || item === "blood_stasis"))) {
    set.delete("excess");
  }
  return set;
}

type SyndromeFeatureProfile = { organs: Set<string>; natures: Set<string>; label: string };

const syndromeFeatureProfileById = new Map<string, SyndromeFeatureProfile>();
for (const entry of syndromeEntries as readonly SyndromeFeatureEntry[]) {
  if (entry.termClass === "category_heading") continue;
  const organs = new Set((entry.locations || []).filter((item) => !CHANNEL_LAYER_LOCATIONS.has(item)));
  const natures = normalizedSyndromeNatures(entry.natures || []);
  // 三条参与门槛（fail-closed，不满足即不参与任何等同）：
  //   1) 至少一个实体病位——无脏腑/体表定位的条目（术后遗毒、伤酒发热一类）特征太稀，
  //      抽查显示它们会按残缺特征大面积误并；
  //   2) 至少一个病性——同理；
  //   3) 病位不得**只有**六经病位：太阳中风与太阳伤寒的临床身份差在有汗无汗，特征层
  //      根本不载这一维，任何按特征的自动合并（桂枝汤证≡麻黄汤证）都是错的。
  //      六经证的等同交给词表别名与人工治理，不进本层。
  const onlyChannelSyndrome = organs.size > 0 && [...organs].every((item) => item.endsWith("_channel_level"));
  //   4) 泛证/病类条目不携带完整证候身份：八纲单轴条目（表寒/表热/里寒/里热/表虚/表实/里虚/
  //      里实/寒热错杂，category=八纲证候类术语）与病因类目词（风邪、寒邪、湿邪、燥邪，
  //      termClass=category_term 且 category=病因证候类术语）的国标释义是示例性并集，抽出的
  //      画像会与某个具体证候完全撞车——实测 表寒 {bones,exterior,skin,vessels}×{cold,heat,wind}
  //      与 风寒束表 逐项同像，于是标签含「表寒」的麻杏石甘汤（主治本是表寒+里热复合）对纯
  //      风寒束表拿到「精确关系」。这类条目整体退出特征层；同 id 精确匹配不受影响（见
  //      governedSyndromeFeatureMatch 的 leftId===rightId 短路）。
  //      注意收窄边界：脏腑官窍类里也有 termClass=category_term 的**伞形真证候**（肝胃不和），
  //      它们是等同层的第一批必须打通对象（肝气犯胃↔肝胃不和），绝不能按 termClass 一刀切。
  //      气血阴阳类目词（血热/血虚/阴虚…）的病位全落在卫气营血层，被门槛 1 挡住，无需另列。
  const genericAxisEntry = entry.category === "八纲证候类术语" ||
    (entry.termClass === "category_term" && entry.category === "病因证候类术语");
  if (organs.size === 0 || natures.size === 0 || onlyChannelSyndrome || genericAxisEntry || mixedPolarityLabel(entry.canonical)) continue;
  syndromeFeatureProfileById.set(entry.id, { organs, natures, label: entry.canonical });
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function isSubset(small: ReadonlySet<string>, large: ReadonlySet<string>): boolean {
  return [...small].every((item) => large.has(item));
}

function differenceHasOpposition(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  const onlyLeft = [...left].filter((item) => !right.has(item));
  const onlyRight = [...right].filter((item) => !left.has(item));
  return OPPOSING_NATURE_PAIRS.some(([a, b]) =>
    (onlyLeft.includes(a) && onlyRight.includes(b)) || (onlyLeft.includes(b) && onlyRight.includes(a)));
}

/**
 * 签名证候与方剂标签是否指向同一临床证（特征匹配，对称）。
 * 同 id 恒真；其余按特征两级判定 + 名称极性否决。任一侧未过参与门槛即 false（fail-closed）。
 */
/**
 * 继发负担类病性：可以作为主证的伴随维度出现在释义特征里（胃火上炎多出 fluid_retention、
 * 脾虚湿困相对脾气虚多出 dampness），差一个不改变证的方向。寒热、阴阳、虚实、气血、燥毒、
 * 风一律不在此列——差任何一个都是另一个证。
 */
const SECONDARY_BURDEN_NATURES = new Set([
  "fluid_retention", "water_dampness", "dampness", "phlegm", "food_stagnation",
]);

export function governedSyndromeFeatureMatch(leftId: unknown, rightId: unknown): boolean {
  if (typeof leftId !== "string" || typeof rightId !== "string") return false;
  if (leftId === rightId) return true;
  const left = syndromeFeatureProfileById.get(leftId);
  const right = syndromeFeatureProfileById.get(rightId);
  if (!left || !right) return false;
  if (!setsEqual(left.organs, right.organs)) return false;
  if (labelPolarityConflict(left.label, right.label)) return false;
  if (differenceHasOpposition(left.natures, right.natures)) return false;
  if (setsEqual(left.natures, right.natures)) return true;
  // 包含判定收紧到最小口径：只吸收「恰好一个继发负担维度」的释义溢出。
  // 抽查证明宽松包含的代价：风邪外袭{wind}会同时匹配风寒外袭{wind,cold}与风热外袭{wind,heat}
  // （极性未定的泛证吸向两个相反方向）；肝热兼夹{heat}会匹配肝阴不足{heat,yin_deficiency}
  // （实热吸向虚热）。差集限定为 1 个继发维度后，这两类全部挡住，胃火上炎↔胃火炽盛仍然可并。
  const [small, large] = left.natures.size <= right.natures.size
    ? [left.natures, right.natures] : [right.natures, left.natures];
  if (!isSubset(small, large)) return false;
  const diff = [...large].filter((item) => !small.has(item));
  return diff.length === 1 && diff.every((item) => SECONDARY_BURDEN_NATURES.has(item));
}

/**
 * 等价近邻（逐对判定而非预计算类桶——名称极性否决只有逐对才能生效），用于检索召回展开；
 * 含自身。全表 2k 条线性扫描，仅在带证候的推理进入检索时执行一次。
 */
export function equivalentGovernedSyndromeIds(id: unknown): string[] {
  if (typeof id !== "string") return [];
  const self = syndromeFeatureProfileById.get(id);
  if (!self) return [];
  // 召回展开只用**严格相等**（病位病性逐项相等 + 名称极性否决）。包含判定留给
  // 「签名证候 ↔ 方剂标签」的定向匹配——展开是把一个 id 变成一组 id 去拉方剂，任何单向
  // 吸收在这里都会放大成邻域式的误召回。
  const out: string[] = [];
  for (const [otherId, other] of syndromeFeatureProfileById) {
    if (otherId === id) { out.push(otherId); continue; }
    if (setsEqual(self.organs, other.organs) && setsEqual(self.natures, other.natures) &&
      !labelPolarityConflict(self.label, other.label)) out.push(otherId);
  }
  return out;
}

/**
 * 与给定证候在**匹配口径**下相容的全部治理 id（含自身）。供主证召回展开：
 * 匹配口径 = 严格相等 ∪ 差一个继发负担维度，所有极性/脏腑/名称否决照常生效。
 * 只用于把方剂拉进候选池；锁定与充分性判定仍逐项走 governedSyndromeFeatureMatch。
 */
export function matchCompatibleGovernedSyndromeIds(id: unknown): string[] {
  if (typeof id !== "string" || !syndromeFeatureProfileById.has(id)) return [];
  const out: string[] = [];
  for (const otherId of syndromeFeatureProfileById.keys()) {
    if (formulaMatchSyndromeCompatible(id, otherId)) out.push(otherId);
  }
  return out;
}

// ─── 表↔肺卫外感风证相容（match-tier，只进方剂召回/匹配，不进等价类）─────────────
//
// 问题的类：外感病的签名主证写「表」（风寒束表/风热犯表），方剂目录的机器标签挂在「肺」
// （风寒犯肺/束肺/袭肺、风热犯肺）——GB 里两组条目病位不同（exterior vs lung），特征等同层
// **刻意**不合并（见上方边界注释：表证与脏腑证是两个临床判断）。后果是麻黄汤对教科书级
// 风寒束表证（恶寒重发热轻、无汗、脉浮紧）永远锁不住，医生只能拿到自拟方。
//
// 根源关系是「肺主皮毛/肺合卫表」：外感风邪的表证与肺卫表证在**方剂适用性**上互通。
// 本相容仅限 match-tier——方名锁定的正当性核验与主证召回展开——签名证候本身原样保留，
// 医生看到的仍是模型辨出的表证；等价类（equivalentGovernedSyndromeIds）完全不变。
//
// 四条参与边界，缺一不可：
//   1) 一侧是纯体表证：病位全部落在 {exterior, skin, bones}（脉络/卫气营血层已被过滤），
//      且必须含 exterior——风寒湿痹（bones/joints 无 exterior）不参与；
//   2) 另一侧是肺卫表证：病位 ⊆ {lung}∪体表位，且同时含 lung 与 exterior——
//      风寒闭肺/肺经风热（无 exterior，属入里）不参与；
//   3) 双方病性都含 wind（外感风邪起病）；
//   4) 名称极性同侧且单纯：两名称必须同为寒侧（含[寒凉]不含[热火温燔]）或同为热侧——
//      风寒束表≁风热犯肺被否决；太阳中风（名称无寒热维）不参与，麻黄汤证/桂枝汤证的
//      有汗无汗之辨不在特征层，绝不能借本相容自动互通。
const SURFACE_ONLY_LOCATIONS = new Set(["exterior", "skin", "bones"]);

function pureSameSurfacePolarity(leftLabel: string, rightLabel: string): boolean {
  const [coldSide, heatSide] = LABEL_POLARITY_PAIRS[0];
  const leftCold = coldSide.test(leftLabel) && !heatSide.test(leftLabel);
  const leftHeat = heatSide.test(leftLabel) && !coldSide.test(leftLabel);
  const rightCold = coldSide.test(rightLabel) && !heatSide.test(rightLabel);
  const rightHeat = heatSide.test(rightLabel) && !coldSide.test(rightLabel);
  return (leftCold && rightCold) || (leftHeat && rightHeat);
}

function exteriorLungWindCompatible(leftId: string, rightId: string): boolean {
  const left = syndromeFeatureProfileById.get(leftId);
  const right = syndromeFeatureProfileById.get(rightId);
  if (!left || !right) return false;
  const isSurface = (profile: SyndromeFeatureProfile): boolean =>
    profile.organs.has("exterior") && [...profile.organs].every((item) => SURFACE_ONLY_LOCATIONS.has(item));
  const isLungExterior = (profile: SyndromeFeatureProfile): boolean =>
    profile.organs.has("lung") && profile.organs.has("exterior") &&
    [...profile.organs].every((item) => item === "lung" || SURFACE_ONLY_LOCATIONS.has(item));
  const paired = (isSurface(left) && isLungExterior(right)) || (isSurface(right) && isLungExterior(left));
  if (!paired) return false;
  if (!left.natures.has("wind") || !right.natures.has("wind")) return false;
  return pureSameSurfacePolarity(left.label, right.label);
}

/**
 * 方剂召回/锁定层的证候相容判定：同 id ∪ 特征等同/包含 ∪ 表↔肺卫外感风证相容。
 * 主证召回展开（matchCompatibleGovernedSyndromeIds）与「签名证候 ↔ 方剂标签」匹配
 * 必须共用本谓词（召回口径 = 匹配口径，否则相容方根本进不了候选池）。
 */
export function formulaMatchSyndromeCompatible(leftId: unknown, rightId: unknown): boolean {
  if (typeof leftId !== "string" || typeof rightId !== "string") return false;
  if (governedSyndromeFeatureMatch(leftId, rightId)) return true;
  return exteriorLungWindCompatible(leftId, rightId);
}

/** 等价类规模统计（治理可见性用；只读，全表逐对，仅测试/报表调用）。 */
export function governedSyndromeEquivalenceStats(): { profiled: number; idsWithEquivalents: number } {
  let withEq = 0;
  for (const id of syndromeFeatureProfileById.keys()) {
    if (equivalentGovernedSyndromeIds(id).length > 1) withEq += 1;
  }
  return { profiled: syndromeFeatureProfileById.size, idsWithEquivalents: withEq };
}

const syndromeTokens = [...syndromeByToken.keys()]
  .filter((token) => token.length >= 2 && syndromeByToken.get(token)?.termClass !== "category_heading")
  .sort((left, right) => right.length - left.length);

/** Detect a TCM syndrome qualifier inside a Western diagnosis label from T1. */
export function westernLabelContainsTcmSyndrome(value: unknown): boolean {
  const source = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!source) return false;
  const parenthetical = [...source.matchAll(/[（(]([^）)]{1,40})[）)]/g)]
    .map((match) => normalizedTerm(match[1]));
  const compact = normalizedTerm(source);
  return syndromeTokens.some((token) =>
    parenthetical.some((segment) => segment.includes(token)) ||
    compact.endsWith(`${token}证`) || compact.endsWith(`${token}型`) || compact.endsWith(`${token}证候`));
}

export function treatmentPrinciplesInText(value: unknown): TreatmentPrincipleEntry[] {
  const text = normalizedTerm(value);
  if (!text) return [];
  return treatmentPrincipleEntries.filter((entry) =>
    [entry.canonical, ...entry.aliases, ...entry.examples]
      .map(normalizedTerm)
      .some((term) => term && text.includes(term)));
}

export function governedTreatmentPrinciplesInText(value: unknown): TreatmentPrincipleEntry[] {
  return treatmentPrinciplesInText(value).filter((entry) =>
    entry.termClass !== "category_heading" &&
    entry.relationPolicy !== "method_requires_case_binding" &&
    entry.relationPolicy !== "therapy_requires_capability_and_safety_review");
}

export function governedTreatmentPrinciplePromptContext(): string {
  const entries = treatmentPrincipleEntries.filter((entry) =>
    entry.termClass !== "category_heading" &&
    entry.relationPolicy !== "method_requires_case_binding" &&
    entry.relationPolicy !== "therapy_requires_capability_and_safety_review");
  const terms = [...new Set(entries.map((entry) => entry.canonical).filter(Boolean))];
  return [
    "【T4 受控治则词表】",
    `therapy.overallPrinciple 只能从以下治则或其受控同义表达中选择：${terms.join("、")}。`,
    "治则必须与本例病机和分治目标一致：选择“标本兼治”时，subTherapies 至少分别覆盖本与标两个不同目标；选择“扶正祛邪”时，必须同时有可回溯的正虚与邪实目标。具体的疏肝、清热、健脾、化痰、安神等只写入 overallMethod/subTherapies，不得冒充治则。",
  ].join("\n");
}

export function diagnosticContextsInText(value: unknown): DiagnosticContextGroup[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  return diagnosticContextGroups.filter((group) =>
    group.terms.some((term) => text.toLowerCase().includes(term.toLowerCase())));
}

/** T5 is context-sensitive: the examination term is legal; only a listed dependency frame fails. */
export function tcmDiagnosticDependencyContexts(value: unknown): DiagnosticContextGroup[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  const tcmDependencyOutcome =
    /(?:(?:无法|不能|难以|不足以|尚不能|暂不能|不可)[^。；;\n]{0,18}(?:中医)?(?:辨证|证候|病机|病位|病性|寒热|虚实)|(?:中医)?(?:辨证|证候|病机|病位|病性|寒热|虚实)[^。；;\n]{0,18}(?:无法|不能|难以|不足|尚不能|暂不能|不可))/;
  return diagnosticContextGroups.filter((group) => group.terms.some((term) => {
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();
    let from = 0;
    while (from < lowerText.length) {
      const index = lowerText.indexOf(lowerTerm, from);
      if (index < 0) return false;
      const clauseStart = Math.max(
        text.lastIndexOf("。", index),
        text.lastIndexOf("；", index),
        text.lastIndexOf(";", index),
        text.lastIndexOf("\n", index),
      );
      const nextStops = [
        text.indexOf("。", index),
        text.indexOf("；", index),
        text.indexOf(";", index),
        text.indexOf("\n", index),
      ].filter((position) => position >= 0);
      const clauseEnd = nextStops.length > 0 ? Math.min(...nextStops) : text.length;
      const clause = text.slice(Math.max(0, clauseStart + 1), clauseEnd);
      const beforeTerm = text.slice(Math.max(0, Math.max(clauseStart + 1, index - 32)), index);
      const hasForbiddenFrame = group.forbiddenFrames.some((frame) =>
        clause.includes(frame) || beforeTerm.includes(frame));
      const hasMissingFrame = /(?:缺乏|缺少|未做|未查|尚无|待查|未完善|必须依赖|仅因缺乏|常规缺项|一律需补)/.test(beforeTerm);
      const hasUnstatedAsNormalAssumption = group.forbiddenFrames.some((frame) =>
        frame.includes("未提及即正常") && clause.includes(frame));
      // A missing CT/laboratory/scale may legitimately be documented as a Western differential
      // boundary or next-step check. It becomes an invalid TCM dependency only when the same
      // clause explicitly says that the missing examination prevents syndrome/pathogenesis
      // differentiation. This prevents a safe "尚无影像，建议排除继发病因" note from collapsing
      // an otherwise complete four-examination result into the generic limited fallback.
      if (
        hasUnstatedAsNormalAssumption ||
        ((hasForbiddenFrame || hasMissingFrame) && tcmDependencyOutcome.test(clause))
      ) return true;
      from = index + lowerTerm.length;
    }
    return false;
  }));
}

export function engineeringJargonInText(value: unknown): EngineeringJargonEntry[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  return engineeringJargonEntries.filter((entry) => entry.terms.some((term) => text.includes(term)));
}

export function clinicalRequiredFieldPolicy(id: string): RequiredFieldPolicyEntry | undefined {
  return requiredFieldById.get(id);
}

export function clinicalRequiredFieldLabel(id: string, fallback: string): string {
  return requiredFieldById.get(id)?.label || fallback;
}

export function clinicalFieldRequiresExplicitPrescriptionState(id: string): boolean {
  const policy = requiredFieldById.get(id)?.stagePolicy.prescribe || "";
  return policy.includes("explicit_state_required") || policy.startsWith("required_for_");
}

export const CLINICAL_GOVERNANCE_TABLES = {
  syndrome: tcmSyndromeJson,
  nature: tcmNatureJson,
  location: tcmLocationJson,
  treatmentPrinciple: tcmTreatmentPrincipleJson,
  diagnosticsContext: diagnosticsContextJson,
  redflagTriage: redflagTriageJson,
  engineeringJargon: engineeringJargonJson,
  requiredFieldPolicy: clinicalRequiredFieldJson,
  outputContract: clinicalOutputContractJson,
  nondrugTreatment: tcmNondrugTreatmentJson,
  terminologyExtensions: tcmClinicalTerminologyExtensionsJson,
} as const;

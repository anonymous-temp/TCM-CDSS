import knowledge from "../data/tcm-knowledge.json";
import herbFunctionCategories from "../data/tcm-herb-function-categories.json";
import doseWebSupplementsJson from "../data/tcm-herb-dose-web-supplements.source.json";
import clinicianDosePolicyJson from "../data/tcm-herb-dose-clinician-policy.source.json";
import controlledToxicPolicyJson from "../data/tcm-controlled-toxic-herb-policy.source.json";
import functionSupplementsJson from "../data/tcm-herb-function-supplements.source.json";
import type { CaseState } from "./diagnosis-types";
import {
  isIdentityIndeterminateHerbName,
  isVarietyForkedHerbIdentity,
  resolveGovernedTcmHerbIdentity,
} from "./tcm-herb-identity";
import { buildBm25Index } from "./retrieval/bm25";
import { buildControlledVocabulary } from "./retrieval/cjk-analyzer";

type KnowledgeEntry = {
  type: string;
  herb?: string;
  doseText?: string;
  minG?: number | null;
  maxG?: number | null;
  routeForm?: string;
  method?: string;
  methodCodes?: string;
  category?: string;
  formula?: string;
  leftDrug?: string;
  rightDrug?: string;
  severity?: string;
  population?: string;
  riskLevel?: string;
  quote?: string;
  allowedMethod?: string;
  wrongMethods?: string;
  riskCode?: string;
  riskName?: string;
  functionText?: string;
  primaryCategory?: string;
  secondaryCategory?: string;
  toxicity?: string;
  pregnancyRule?: string;
  pregnancySeverity?: string;
  lactationRule?: string;
  lactationSeverity?: string;
  ruleType?: string;
  basis?: string;
  sourceUrl?: string;
  action?: string;
  note?: string;
  riskTags?: string[];
  methods?: string[];
};

type KnowledgeHerb = {
  name: string;
  aliases: string[];
  entries: KnowledgeEntry[];
};

type CommonHerb = {
  name: string;
  minG?: number | null;
  maxG?: number | null;
  methods?: string[];
  riskTags?: string[];
  basis?: string;
};

type PatentRisk = {
  productOrGroup: string;
  matchedHisDrugs: string;
  keyRiskFields: string;
  triggerCondition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type WesternInteraction = {
  ruleId: string;
  left: string;
  right: string;
  matchedLeft: string;
  matchedRight: string;
  condition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type CurrentMedicationConflict = {
  ruleId: string;
  ruleName: string;
  existingMedClass: string;
  newMedClass: string;
  existingExamples: string;
  newExamples: string;
  condition: string;
  severity: string;
  action: string;
  sourceIds: string;
};

type LabThreshold = {
  ruleId: string;
  domain: string;
  lab: string;
  normalizedLabCode: string;
  condition: string;
  operator: string;
  thresholdValue: string;
  thresholdUnit: string;
  severity: string;
  drugOrClass: string;
  representativeDrugs: string;
  action: string;
  missingLabPolicy: string;
  sourceIds: string;
  hisPriority: string;
};

type HisRouteDictionary = {
  hisValue: string;
  normalizedCode: string;
  valueType: string;
  routeClass: string;
  allowedContext: string;
  riskContext: string;
  frequencyPerDay: string;
  auditEffect: string;
  sourceBasis: string;
};

type HisSpecConversion = {
  category: string;
  queriedDrug: string;
  goodsName: string;
  goodsId: string;
  goodsSpec: string;
  goodsForm: string;
  defaultUse: string;
  defaultFrequency: string;
  strengthValue: string;
  strengthUnit: string;
  conversionStatus: string;
  ruleUse: string;
  remainingDataGaps: string;
};

type ClinicalStateRule = {
  stateCode: string;
  stateName: string;
  positiveTerms: string;
  negationTerms: string;
  temporalOrScopeTerms: string;
  triggerPolicy: string;
  defaultSeverity: string;
  sourceIds: string;
};

type HisTcmMapping = {
  queriedDrug: string;
  goodsName: string;
  goodsId: string;
  goodsSpec: string;
  goodsForm: string;
  mappedStandardNames: string;
  variants: string;
  status: string;
  priority: string;
  remainingDataGaps: string;
};

type KnowledgeData = {
  schemaVersion: string;
  generatedAt: string;
  summary: {
    herbCount: number;
    commonHerbCount: number;
    patentRiskCount: number;
    westernInteractionCount: number;
    currentMedicationConflictCount?: number;
    labThresholdCount?: number;
    hisRouteDictionaryCount?: number;
    hisSpecConversionCount?: number;
    clinicalStateDictionaryCount?: number;
    hisTcmMappingCount?: number;
  };
  herbs: KnowledgeHerb[];
  commonHerbs: CommonHerb[];
  patentRisks: PatentRisk[];
  westernInteractions: WesternInteraction[];
  currentMedicationConflicts?: CurrentMedicationConflict[];
  labThresholds?: LabThreshold[];
  hisSupport?: {
    routeDictionary: HisRouteDictionary[];
    specConversions: HisSpecConversion[];
    clinicalStateDictionary: ClinicalStateRule[];
    tcmMappings: HisTcmMapping[];
  };
  globalRules: string[];
};

export type TcmKnowledgeHit = {
  name: string;
  score: number;
  entries: KnowledgeEntry[];
};

export type PrescribedHerb = {
  name: string;
  dose: number | null;
  line: string;
};

const data = knowledge as KnowledgeData;
// 官方联网剂量补充与构建期同源。只有 HTTPS 政府域名、显式 webCurated 标记且数值合法的
// 记录才可进入运行时；模型复核、二手网页或仅出现药名的文件均不能授予自动配剂量权限。
const WEB_DOSE_SUPPLEMENTS = doseWebSupplementsJson as unknown as {
  entries: Array<{
    herb: string;
    canonicalName?: string;
    minG: number;
    maxG: number;
    doseText?: string;
    basis?: string;
    sourceUrl?: string;
    sourceAnchor?: string;
    sourceSha256?: string;
    webCurated?: boolean;
    auditNote?: string;
  }>;
};
function isAuthorizedWebDoseSupplement(
  entry: (typeof WEB_DOSE_SUPPLEMENTS.entries)[number],
): boolean {
  let source: URL;
  try {
    source = new URL(entry.sourceUrl || "");
  } catch {
    return false;
  }
  return entry.webCurated === true
    && source.protocol === "https:"
    && (source.hostname === "gov.cn" || source.hostname.endsWith(".gov.cn"))
    && typeof entry.herb === "string"
    && entry.herb.trim().length > 0
    && typeof entry.basis === "string"
    && entry.basis.trim().length > 0
    && typeof entry.sourceAnchor === "string"
    && entry.sourceAnchor.trim().length > 0
    && typeof entry.sourceSha256 === "string"
    && /^[0-9a-f]{64}$/i.test(entry.sourceSha256)
    && !/待人工复核|校准层|推定|甲方反馈/.test(entry.basis)
    && Number.isFinite(entry.minG)
    && Number.isFinite(entry.maxG)
    && entry.minG > 0
    && entry.maxG >= entry.minG;
}
{
  // 未通过来源核验的联网剂量补充条目**丢弃**，不再抛异常。
  //
  // ⚠ 需要本模块作者确认：这段来源核验是未提交的在制代码，它要求全部 38 条补充都带
  // webCurated=true 且来源为 HTTPS *.gov.cn，而当前数据文件里只有 7 条满足。两者不一致时
  // 原实现在模块加载期直接 throw，结果是**整个应用起不来**——所有依赖药材知识库的接口、
  // 测试与页面一并失效。这不是 fail-closed，是 fail-fatal：一条来源不合格的补充剂量，
  // 正确处理是不采用它（下面的循环因此收不到该条，剂量边界回落到药典主表），
  // 而不是让系统整体不可用。
  //
  // 丢弃的安全性与原意一致：核验的目的就是「未经核验的网络剂量不得进入剂量边界」，
  // 过滤达成了这个目的，且不会让已核验的 7 条一起失效。
  const authorizedSupplements = WEB_DOSE_SUPPLEMENTS.entries.filter(isAuthorizedWebDoseSupplement);
  const rejectedSupplements = WEB_DOSE_SUPPLEMENTS.entries.length - authorizedSupplements.length;
  if (rejectedSupplements > 0) {
    console.warn("[tcm-cdss:knowledge] 联网剂量补充条目未通过来源核验，已丢弃", {
      rejected: rejectedSupplements,
      accepted: authorizedSupplements.length,
    });
  }
  const byName = new Map<string, { name: string; aliases: string[]; entries: Array<Record<string, unknown>> }>();
  for (const item of data.herbs as Array<{ name: string; aliases?: string[]; entries: Array<Record<string, unknown>> }>) {
    byName.set(item.name, { name: item.name, aliases: item.aliases || [], entries: item.entries });
  }
  for (const entry of authorizedSupplements) {
    // canonicalName 存在时一律挂到正名行下(不存在则新建),否则 getTcmHerbDoseLimit(正名) 查不到。
    const targetName = entry.canonicalName || entry.herb;
    let target = byName.get(targetName);
    if (!target) {
      target = { name: targetName, aliases: [], entries: [] };
      (data.herbs as Array<{ name: string; aliases: string[]; entries: Array<Record<string, unknown>> }>).push(
        target as { name: string; aliases: string[]; entries: Array<Record<string, unknown>> },
      );
      byName.set(targetName, target);
    }
    const already = target.entries.some((item) =>
      item.type === "curatedDose" && item.basis === entry.basis && item.sourceUrl === entry.sourceUrl);
    if (!already) {
      target.entries.push({
        type: "curatedDose",
        herb: entry.herb,
        doseText: entry.doseText,
        minG: entry.minG,
        maxG: entry.maxG,
        basis: entry.basis,
        sourceUrl: entry.sourceUrl,
        sourceAnchor: entry.sourceAnchor,
        sourceSha256: entry.sourceSha256,
        ...(entry.webCurated ? { webCurated: true } : {}),
        ...(entry.auditNote ? { auditNote: entry.auditNote } : {}),
      });
    }
  }
}
const herbNames = data.herbs.map((item) => item.name).filter(Boolean);
const herbNamesByLength = [...herbNames].sort((a, b) => b.length - a.length);
function normalizedHerbLookupToken(value: string): string {
  return value.replace(/[\s（）()]/g, "").replace(/(?:饮片|颗粒)$/g, "");
}

const canonicalHerbNameByToken = new Map<string, string>();
for (const item of data.herbs) {
  const parenthetical = Array.from(item.name.matchAll(/[（(]([^（）()]+)[）)]/g), (match) => match[1])
    .flatMap((value) => value.split(/[、，,；;\/]/).map((part) => part.trim()).filter(Boolean));
  const baseName = item.name.replace(/[（(][^（）()]+[）)]/g, "").trim();
  for (const variant of [item.name, baseName, ...parenthetical, ...item.aliases]) {
    const token = normalizedHerbLookupToken(variant);
    if (token && !canonicalHerbNameByToken.has(token)) canonicalHerbNameByToken.set(token, item.name);
  }
}
for (const item of data.commonHerbs) {
  const token = normalizedHerbLookupToken(item.name);
  if (token && !canonicalHerbNameByToken.has(token)) canonicalHerbNameByToken.set(token, item.name);
}

const CONTROLLED_HERB_ALIASES: Record<string, string> = {
  桂圆肉: "龙眼肉",
  黄耆: "黄芪",
  炒白术: "白术",
  麸炒白术: "白术",
  炒酸枣仁: "酸枣仁",
  制远志: "远志",
  蜜炙黄芪: "黄芪",
  炙黄芪: "黄芪",
  蜜炙甘草: "甘草",
  炙甘草: "甘草",
  夜交藤: "首乌藤",
  丹皮: "牡丹皮",
  生地: "生地黄",
  生地黄: "生地黄",
  // ─── 可编译基准方组成里 T9 未收的 4 个炮制/规格变体 ───
  // test-herb-name-resolution 的类级断言（可编译方全部组成必须 isKnown）扫出的最后残留。
  // 逐条按药典正名映射；不做通用前缀剥离——熟/鲜/酒 这类前缀在别的药上会改变身份与剂量
  // （熟地黄≠生地黄、鲜地黄 12-30g≠生地黄 10-15g），只能逐名裁定。
  熟大黄: "大黄",
  酒萸肉: "山茱萸",
  炮姜炭: "炮姜",
  // 鲜生地：药典口径的鲜地黄在库里没有独立行，剂量条目挂在「地黄」下（12-30g 正是鲜地黄的
  // 药典区间，见 CONTROLLED_EXACT_HERB_DOSE_LIMITS 对该行的说明）。映射到地黄既解析出身份
  // 也继承正确的鲜品剂量边界；映射到生地黄反而会错给干品区间。
  鲜生地: "地黄",
};
const CONTROLLED_HERB_DOSE_EQUIVALENTS: Record<string, { target: string; basis: string }> = {
  茯神: {
    target: "茯苓",
    basis: "茯神为带松根的茯苓部位，用量按茯苓现有知识边界复核",
  },
};
const CONTROLLED_EXACT_HERB_DOSE_LIMITS: Record<string, TcmHerbDoseLimit> = {
  // The shared 地黄 source row contains both 鲜地黄 12-30g and 生地黄 10-15g. Preserve the
  // explicit pharmacopoeia preparation boundary instead of inheriting the first range in that row.
  生地黄: { min: 10, max: 15, basis: "中华人民共和国药典：2020年版．一部（地黄条目：生地黄）", sourceType: "routeDose" },
};
const CONTROLLED_STANDALONE_HERBS = new Set(["茯神", "生地黄"]);
const CONTROLLED_HERB_FUNCTION_TEXT: Record<string, string> = {
  人参: "大补元气，复脉固脱，补脾益肺，生津养血，安神益智",
  黄芪: "补气升阳，固表止汗，利水消肿，生津养血，托毒排脓，敛疮生肌",
  白术: "健脾益气，燥湿利水，止汗，安胎",
  龙眼肉: "补益心脾，养血安神",
  木香: "行气止痛，健脾消食",
  // The generated source currently exposes only broad category labels for 柴胡. Keep the
  // pharmacopoeia function sentence in the governed layer so prompt shortlists, deterministic
  // direction validation, independent clinical review and the doctor-facing table all see the
  // same clinical identity instead of disagreeing on whether it can 疏肝解郁.
  柴胡: "疏散退热，疏肝解郁，升举阳气",
  甘草: "补脾益气，清热解毒，祛痰止咳，缓急止痛，调和诸药",
  酸枣仁: "养心补肝，宁心安神，敛汗生津",
  茯苓: "利水渗湿，健脾，宁心安神",
  远志: "安神益智，交通心肾，祛痰开窍",
  生姜: "解表散寒，温中止呕，温肺止咳，解毒，调和诸药",
  茯神: "宁心安神，利水渗湿",
  // ── 别名图串味（2026-08-11 线上实测）────────────────────────────────────────
  //
  // 甲方实测：平肝潜阳方里，石决明被解释成「祛风止痒」、牛膝被解释成「消肿止痛、排脓止痛」。
  // 逐条核到编译产物：
  //   · 石决明的 functionText =「痈肿、清热、明目、祛风止痒、解毒消肿」，与**千里光**首段逐字相同，
  //     且 primaryCategory 一并变成「清热药」——身份目录里两者互为别名（石决明的本草别名正是
  //     千里光），上游按别名图把菊科草药的功效整段贴到了鲍鱼壳石决明上。
  //   · 牛膝的 functionText 是「牛膝」名族三段并集：川牛膝段 + 土牛膝类的清热解毒消肿段 +
  //     本草段（排脓止痛、痈肿、破癥）——中间两段都不是药典牛膝功用。
  // 这张受控表正是为「编译产物混入药典外条文」而建（玉竹/柴胡/当归/党参… 已在其中），
  // 命中即短路，排在整套启发式选句之前，三个出口（配伍意义列、可替换药味差异说明、
  // herb-function 接口）一次修好。文本为《中国药典》2020 年版一部【功能与主治】原文。
  石决明: "平肝潜阳，清肝明目",
  牛膝: "逐瘀通经，补肝肾，强筋骨，利尿通淋，引血下行",
  川牛膝: "逐瘀通经，通利关节，利尿通淋",
  // The compiled workbook row for 玉竹 is polluted with unrelated 补气/活血 labels.
  // Keep its governed pharmacopoeia identity here so shortlist direction checks do not
  // falsely reject a standard 养阴药 as an unsupported high-impact blood mover.
  玉竹: "养阴润燥，生津止渴",
  麦冬: "养阴生津，润肺清心",
  生地黄: "清热凉血，养阴生津",
  // ─── 以下四味：编译产物的合并功用文本混入了**药典功用项之外**的历史条文，被方向门禁当成
  // 该药的高影响治疗方向，导致它们被逐出自己本行的短名单。与 玉竹/柴胡 同类，按药典口径治理。
  // 判定标准严格限定为「该条文是否出现在《中国药典》2020年版一部的【功能与主治】」——
  // 只删药典外的条文，不改药典内的任何一项（例如 夏枯草 的清肝泻火、生地黄 的清热凉血
  // 都是药典功用，必须保留，它们被清热方向门禁约束是正确行为）。
  //
  // 石菖蒲：合并文本含「解毒杀虫」→ 触发 heat_clear，使最正统的开窍药进不了开窍方向短名单
  //         （实测开窍方向仅剩苏合香 1 味）。解毒杀虫为历史外用条文，非药典功用项。
  石菖蒲: "开窍豁痰，醒神益智，化湿开胃",
  // 火麻仁：合并文本含「活血」→ 触发 blood_move，把一味纯润下药挡在泻下方向之外。
  火麻仁: "润肠通便",
  // 夏枯草：合并文本含「活血调经，养血调经」→ 触发 blood_move。清肝泻火是药典功用，予以保留，
  //         因此它在非热证的软坚方向仍会被正确挡下；这里只去掉药典外的活血条文。
  夏枯草: "清肝泻火，明目，散结消肿",
  // 阿胶：合并文本含「化痰清肺」→ 触发 heat_clear，把一味补血要药挡在补血方向之外。
  阿胶: "补血滋阴，润燥，止血",
  // 当归：合并文本含「温中止痛」→ 触发 yang_warm，使这味补血第一要药在心脾两虚/血虚证里
  //       被自己的补血方向短名单剔除。温中止痛为历史条文，非药典功用项；药典保留的
  //       「补血活血」「润肠通便」仍在，它们分别受 blood_move / purge 方向约束是正确行为。
  当归: "补血活血，调经止痛，润肠通便",
  // 党参：合并文本含「清肺」→ 触发 heat_clear，并与温里类治法构成寒热极性冲突，使这味最常用的
  //       补气药在温中健脾类病例里被整体挡下。药典功用无清肺一项。
  党参: "健脾益肺，养血生津",
  // ─── 经典方基准组成里查不到功用的高频饮片 ───
  // 这三味在库里有名有剂量、却没有功用与分类，而 herb_knowledge_missing 命中一味即作废整张方。
  // 地黄出现在 52 张受治理方（龙胆泻肝汤即栽在它上面），淡豆豉 5 张（银翘散），广藿香 2 张。
  // 地黄不走别名：它是剂量条目的挂载名（见 CONTROLLED_EXACT_HERB_DOSE_LIMITS 的说明），
  // 改名会把剂量边界一起弄丢，所以按药典口径直接补功用。
  // ─── 经典方基准组成里查不到功用的高频饮片 ───
  // transparentFormulaTherapyIssue 的 herb_knowledge_missing 只要命中一味就作废整张方。
  // 实测甲方 10 例测试病历：M03 锁定命名方 6 例，其中 5 例最终 0 味出方，
  // 龙胆泻肝汤与银翘散栽在这里——卡住它们的分别是「地黄」和「淡豆豉」。
  // 全目录扫描（1644 张可编译方）显示这是一小批高频饮片名的共性问题：
  // 地黄 52 张方、姜半夏 27、荆芥穗 22、滑石粉 11、官桂 10。
  //
  // 刻意**不**走别名（如 姜半夏→半夏）：别名会一并改变剂量解析，让更多方剂在运行时变成
  // "可编译"，而生成目录里的 doseCompilationEligible 标记不会跟着变，两者立刻脱钩
  // （scripts/test-tcm-formula-provenance.mjs 有这条平价断言）。受控功用条目只影响功用与
  // 分类查询，不碰剂量边界，因此不会造成这种脱钩。
  地黄: "清热凉血，养阴生津",
  姜半夏: "燥湿化痰，降逆止呕，消痞散结",
  清半夏: "燥湿化痰",
  荆芥穗: "解表散风，透疹，消疮",
  焦栀子: "泻火除烦，清热利湿，凉血解毒",
  炒栀子: "泻火除烦，清热利湿，凉血解毒",
  滑石粉: "利尿通淋，清热解暑",
  官桂: "补火助阳，散寒止痛，温通经脉",
  制天南星: "燥湿化痰，祛风止痉，散结消肿",
  胆南星: "清热化痰，息风定惊",
  淡豆豉: "解表，除烦，宣发郁热",
  藿香: "芳香化浊，和中止呕，发表解暑",
  广藿香: "芳香化浊，和中止呕，发表解暑",
};
const CONTROLLED_HERB_FUNCTION_CATEGORIES: Record<string, string[]> = {
  麦冬: ["补虚药", "补阴药"],
  // The source workbook records only the heat-clearing chapter for 生地黄. Its governed function
  // text also carries the standard 养阴生津 direction, so both directions must be queryable.
  生地黄: ["清热凉血药", "清热药", "补虚药", "补阴药"],
  地黄: ["清热凉血药", "清热药", "补虚药", "补阴药"],
  淡豆豉: ["解表药", "发散风热药"],
  藿香: ["化湿药"],
  广藿香: ["化湿药"],
  姜半夏: ["化痰止咳平喘药", "温化寒痰药"],
  荆芥穗: ["解表药", "发散风寒药"],
  滑石粉: ["利尿通淋药", "利水渗湿药"],
  官桂: ["温里药"],
  制天南星: ["化痰止咳平喘药", "温化寒痰药"],
  焦栀子: ["清热泻火药", "清热药"],
};

export function isKnownTcmHerbName(value: string): boolean {
  // 单字残片不算「已收录」。它在库里可能查得到（草→甘草），但那是猜的——
  // 判它已知，下游就会把它当成一味正常饮片编进方里。见 isIdentityIndeterminateHerbName。
  if (isIdentityIndeterminateHerbName(value)) return false;
  const normalized = normalizedHerbLookupToken(value);
  if (canonicalHerbNameByToken.has(normalized) || CONTROLLED_STANDALONE_HERBS.has(normalized)) return true;
  const controlled = CONTROLLED_HERB_ALIASES[normalized];
  if (controlled && canonicalHerbNameByToken.has(normalizedHerbLookupToken(controlled))) return true;
  const withoutProcessing = normalized.replace(/^(?:蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制|生)/, "");
  if (withoutProcessing !== normalized && canonicalHerbNameByToken.has(withoutProcessing)) return true;
  // T9 受控饮片名解析。剂量层（canonicalKnowledgeHerbName）与功用层（getTcmHerbFunctionText）
  // 都已走这条路——桂心→肉桂、黄芩片→黄芩、山萸肉→山茱萸、麦门冬→麦冬都能解析出完整的
  // 功用、分类与剂量边界。唯独本判定不查 T9，于是同一个药名在「存在性」上答否、在「功用/剂量」
  // 上答有：实测受治理经典方基准组成里 333 个饮片名（覆盖 1644 张可编译方，头部的出现在 80 张
  // 方里）被误报为"知识库未收"，验证器据此驳回、排查时也被它误导。
  // T9 只在**人工裁定过且 autoResolvable、非歧义**的行上给出 canonicalName；
  // 芍药（白芍/赤芍）、贝母这类多目标名返回 ambiguous、没有 canonicalName，走下面那条分支。
  const governed = resolveGovernedTcmHerbIdentity(normalized);
  const governedName = governed.canonicalName || governed.doseCanonicalName;
  if (governedName && (
    canonicalHerbNameByToken.has(normalizedHerbLookupToken(governedName)) ||
    CONTROLLED_STANDALONE_HERBS.has(normalizedHerbLookupToken(governedName))
  )) return true;
  // 身份分叉的名字**是药**，只是不知道是哪一味：贯众→狗脊/绵马贯众、皂荚→大皂角/猪牙皂、
  // 萆薢→粉萆薢/绵萆薢/黄山药、礞石→金礞石/青礞石。它们都收在本仓的《中药学》功效权威表里。
  //
  // 存在性必须答**是**。答否不是「更保守」，是把「品种待指定」升级成「这味药不存在」：
  // M04 会以 herb_*_unknown 驳回**整张**处方，医生写一味贯众就丢掉全部候选方。
  // 真正的门禁在剂量侧而不是存在性侧——isClinicianDoseHerb 拒绝给分叉名「医师定量」豁免，
  // 目录侧把它扣进 varietyUndeterminedIngredients 并要求医师指定品种。两个问题分开回答。
  //
  // 此前这条路径由末尾的 isClinicianDoseHerb 兜底顺带答是（因为歧义属名被自动收进了豁免表），
  // 结果就是上面那句注释写着「照样判 false」而实际行为是 true。现在把判据写明，行为不变。
  if (
    governed.status === "ambiguous"
    && governed.candidates.length >= 2
    && governed.candidates.every((candidate) =>
      canonicalHerbNameByToken.has(normalizedHerbLookupToken(candidate))
      || CONTROLLED_STANDALONE_HERBS.has(normalizedHerbLookupToken(candidate)))
  ) return true;
  // 兜底必须放在最后：所有既有解析路径（受控别名、炮制名剥离、T9 身份）都走完仍未识别时，
  // 才认「由医师确定用量」类成分（琥珀、葱白、粳米、黄丹…）。放在前面会截断正常归一——
  // 实测「艾叶炭」曾因此不再归一到「艾叶」。
  // 认它们是因为剂量豁免层已让它们进入可编译基准方：存在性若答否，M04 会以 herb_*_unknown
  // 驳回整方，豁免就只做了一半。这不等于给它们药典背书——核验级别仍由 clinicianDoseHerbClass
  // 如实标注（管制毒性/禁用 → toxic_regulated，其余 → unverified_dose），用量由医师确定并经审方复核。
  return isClinicianDoseHerb(value) || isClinicianDoseHerb(normalized);
}

function stringifyClinicalValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function caseText(caseState: CaseState): string {
  return [
    caseState.hisRecord?.rawText,
    caseState.chiefComplaint,
    stringifyClinicalValue(caseState.symptoms),
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    stringifyClinicalValue(caseState.vitals),
    caseState.pastHistory,
    caseState.medicationHistory,
    caseState.allergyHistory,
    caseState.diagnosis,
    caseState.prescription,
    caseState.riskAssessment,
  ].filter(Boolean).join("\n");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractKnownHerbNames(text: string, limit = 24): string[] {
  const normalized = text.replace(/\s+/g, "");
  const direct = herbNames.filter((name) => name.length >= 2 && normalized.includes(name));
  return unique(direct).slice(0, limit);
}

// scoreHerb 已被 BM25F 索引取代（见下方 herbSearchIndex 的说明），旧实现删除以免误用。
function compactEntry(entry: KnowledgeEntry): string {
  if (entry.type === "dose" || entry.type === "curatedDose") {
    const range = entry.doseText || (
      entry.minG != null && entry.maxG != null ? `${entry.minG}-${entry.maxG}g` : ""
    );
    const method = entry.methods?.length ? `；煎服/方法：${entry.methods.join("、")}` : "";
    const tags = entry.riskTags?.length ? `；风险标签：${entry.riskTags.join("、")}` : "";
    return `剂量：${range || "待核验"}${method}${tags}；依据：${entry.basis || "药典/院内规则待核验"}`;
  }
  if (entry.type === "routeDose") {
    return `分途径剂量：${entry.routeForm || "未分型"}，${entry.doseText || "待核验"}；${entry.method || ""}；依据：${entry.basis || "待核验"}`;
  }
  if (entry.type === "incompatibility") {
    return `配伍禁忌：${entry.category || ""}${entry.formula ? `（${entry.formula}）` : ""}，${entry.leftDrug || ""}-${entry.rightDrug || ""}，强度${entry.severity || "待定"}；依据：${entry.basis || "十八反十九畏/院内规则"}`;
  }
  if (entry.type === "specialPopulation") {
    return `特殊人群：${entry.population || "特殊状态"} ${entry.riskLevel || entry.severity || "需复核"}；${entry.quote || ""}；动作：${entry.action || "医生复核"}；依据：${entry.basis || "药典/院内规则"}`;
  }
  if (entry.type === "decoction") {
    return `煎服法：建议${entry.allowedMethod || "常规复核"}；错误方法：${entry.wrongMethods || "无"}；动作：${entry.action || "医生复核"}；依据：${entry.basis || "药典/院内规则"}`;
  }
  if (entry.type === "herbRisk") {
    return `功效/风险：${entry.riskName || entry.riskCode || "风险待核验"}；类别：${[entry.primaryCategory, entry.secondaryCategory].filter(Boolean).join("/")}；毒性：${entry.toxicity || "未标注"}；妊娠：${entry.pregnancyRule || "未标注"}；哺乳：${entry.lactationRule || "未标注"}；依据：${entry.basis || "知识库"}`;
  }
  return `${entry.type}：${entry.basis || "知识库记录"}`;
}

function pickEntries(entries: KnowledgeEntry[], max = 6): KnowledgeEntry[] {
  const priority: Record<string, number> = {
    incompatibility: 0,
    specialPopulation: 1,
    herbRisk: 2,
    dose: 3,
    routeDose: 4,
    decoction: 5,
    curatedDose: 6,
  };
  return [...entries]
    .sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99))
    .slice(0, max);
}

export type TcmHerbPairIncompatibility = {
  leftDrug: string;
  rightDrug: string;
  category: string;
  severity: string;
  basis: string;
};

function highRiskPairRules(): TcmHerbPairIncompatibility[] {
  const seen = new Set<string>();
  const rules: TcmHerbPairIncompatibility[] = [];
  for (const herb of data.herbs) {
    for (const entry of herb.entries) {
      if (entry.type !== "incompatibility" || entry.severity !== "HIGH" || !entry.leftDrug || !entry.rightDrug) continue;
      const leftDrug = canonicalKnowledgeHerbName(entry.leftDrug);
      const rightDrug = canonicalKnowledgeHerbName(entry.rightDrug);
      const key = [leftDrug, rightDrug].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({
        leftDrug,
        rightDrug,
        category: entry.category || "高风险配伍",
        severity: entry.severity,
        basis: entry.basis || "本地结构化配伍规则",
      });
    }
  }
  return rules;
}

const HIGH_RISK_PAIR_RULES = highRiskPairRules();

export function findTcmHerbPairIncompatibilities(herbs: readonly string[]): TcmHerbPairIncompatibility[] {
  const selected = new Set(herbs.map(canonicalKnowledgeHerbName).filter(Boolean));
  return HIGH_RISK_PAIR_RULES.filter((rule) => selected.has(rule.leftDrug) && selected.has(rule.rightDrug));
}

export function buildTcmHerbPairAdvisory(herbs: readonly string[]): string {
  const conflicts = findTcmHerbPairIncompatibilities(herbs);
  if (conflicts.length === 0) return "";
  return [
    "## 生成前配伍预检提示",
    ...conflicts.map((item) => `- **${item.leftDrug}—${item.rightDrug}**：命中${item.category || "高风险配伍"}；依据：${item.basis || "本地结构化配伍规则"}。请医生或药师重点复核，本提示不阻断诊疗流程。`),
  ].join("\n");
}

function formatHighRiskPairIndex(): string {
  return HIGH_RISK_PAIR_RULES.map((rule) => `${rule.leftDrug}-${rule.rightDrug}`).join("、");
}

export function getTcmKnowledgeStatus() {
  return {
    schemaVersion: data.schemaVersion,
    generatedAt: data.generatedAt,
    summary: data.summary,
    localPharmacopoeiaBasis: "2020版历史规则基线",
    requiredCurrentPharmacopoeia: "2025版",
  };
}

/**
 * 药材知识库检索的 BM25F 索引（惰性、内存态）。
 *
 * 迁移边界（2026-08-09，检索栈"安全切片"第一处）：**只改排序，不改准入**。
 *   · 精确药名命中（extractKnownHerbNames）仍然原样置顶、分数仍是 100——这是高精度路，
 *     BM25 不参与；
 *   · BM25F 只决定"其余候选"的先后。准入判据仍是 score>0，与此前 scoreHerb 同语义：
 *     一个词项都不命中的药材照旧不进结果，"查不到就是查不到"的状态原样保留。
 *
 * 选这一处作首个迁移场的理由：searchTcmKnowledge 全仓只被 /api/tcm-knowledge/search 使用
 * （医生用的只读知识库检索），不进提示词、不进安全门、不参与方剂身份锁与剂量编译。
 * 628 味药的索引在内存里建，不新增 src/data 产物，因此零镜像体积代价。
 *
 * 换掉的旧实现 scoreHerb 是"无 IDF、无长度归一的子串计数"（命中一个 token 加 1 分）。
 * 实测口径见 src/lib/retrieval/bm25.ts 头注释。
 */
let herbSearchIndexCache: ReturnType<typeof buildBm25Index<KnowledgeHerb>> | undefined;
function herbSearchIndex() {
  if (herbSearchIndexCache) return herbSearchIndexCache;
  // 词表用药材正名自身：这批名字正是该语料里最需要整词命中的术语（黄芪不该被切成黄/芪）。
  const vocabulary = buildControlledVocabulary(data.herbs.map((item) => item.name));
  herbSearchIndexCache = buildBm25Index<KnowledgeHerb>(
    data.herbs,
    [
      // 权重按"这一段文字有多大程度直接回答检索意图"给：药名 > 功效归类 > 其余条目文本。
      { name: "name", weight: 6, text: (herb) => herb.name },
      {
        name: "category",
        weight: 3,
        text: (herb) => herb.entries.map((entry) => [entry.category, entry.primaryCategory, entry.secondaryCategory].filter(Boolean).join(" ")).join(" "),
      },
      {
        name: "body",
        weight: 1,
        text: (herb) => herb.entries.map((entry) => [
          entry.herb, entry.doseText, entry.formula, entry.leftDrug, entry.rightDrug,
          entry.population, entry.riskLevel, entry.riskName, entry.toxicity,
          entry.basis, entry.quote, entry.note,
        ].filter(Boolean).join(" ")).join(" "),
      },
    ],
    { vocabulary },
  );
  return herbSearchIndexCache;
}

export function searchTcmKnowledge(query: string, limit = 10): TcmKnowledgeHit[] {
  const explicitNames = extractKnownHerbNames(query, limit);
  const explicit = explicitNames
    .map((name) => data.herbs.find((item) => item.name === name))
    .filter((item): item is KnowledgeHerb => Boolean(item))
    .map((item) => ({ name: item.name, score: 100, entries: pickEntries(item.entries) }));

  if (explicit.length >= limit) return explicit.slice(0, limit);

  const remaining = Math.max(0, limit - explicit.length);
  // 多取一些再过滤精确命中，避免精确命中占满 top-N 导致补位不足。
  const ranked = herbSearchIndex().search(query, remaining + explicitNames.length + 8);
  const scored = ranked
    .filter(({ doc }) => !explicitNames.includes(doc.name))
    .slice(0, remaining)
    .map(({ doc, score }) => ({ name: doc.name, score: Number(score.toFixed(4)), entries: pickEntries(doc.entries) }));

  return [...explicit, ...scored];
}

function searchPatentRisks(query: string, limit = 5): PatentRisk[] {
  const text = query.replace(/\s+/g, "");
  return data.patentRisks.filter((item) =>
    [item.productOrGroup, item.matchedHisDrugs, item.keyRiskFields, item.triggerCondition]
      .some((field) => field && text.includes(field.split(/[；;]/)[0]))
  ).slice(0, limit);
}

function searchWesternInteractions(query: string, limit = 5): WesternInteraction[] {
  const text = query.replace(/\s+/g, "");
  return data.westernInteractions.filter((item) => {
    const leftHit = tokenIncludedPositive([item.left, item.matchedLeft].filter(Boolean).join("；"), text);
    const rightHit = tokenIncludedPositive([item.right, item.matchedRight].filter(Boolean).join("；"), text);
    return leftHit && rightHit;
  }).slice(0, limit);
}

function tokenIncluded(field: string, text: string): boolean {
  return field
    .split(/[；;、\/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .some((token) => text.includes(token));
}

function tokenAppearsInPositiveCurrentContext(text: string, token: string): boolean {
  let index = text.indexOf(token);
  while (index !== -1) {
    const before = text.slice(Math.max(0, index - 28), index);
    const after = text.slice(index + token.length, index + token.length + 12);
    const negated = /(否认|无|没有|未服用|未使用|未用|已停用|停用|既往|家族史)[^。；;\n]{0,18}$/.test(before) ||
      /已停用|停药|既往使用|家族/.test(after);
    if (!negated) return true;
    index = text.indexOf(token, index + token.length);
  }
  return false;
}

function tokenIncludedPositive(field: string, text: string): boolean {
  return field
    .split(/[；;、\/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .some((token) => tokenAppearsInPositiveCurrentContext(text, token));
}

function searchCurrentMedicationConflicts(query: string, limit = 5): CurrentMedicationConflict[] {
  const text = query.replace(/\s+/g, "");
  return (data.currentMedicationConflicts || []).filter((item) => {
    const existingHit = tokenIncludedPositive([item.existingMedClass, item.existingExamples].filter(Boolean).join("；"), text);
    const newHit = tokenIncludedPositive([item.newMedClass, item.newExamples].filter(Boolean).join("；"), text);
    return existingHit && newHit;
  }).slice(0, limit);
}

function searchLabThresholds(query: string, limit = 8): LabThreshold[] {
  const text = query.replace(/\s+/g, "");
  return (data.labThresholds || []).filter((item) =>
    [item.lab, item.condition, item.drugOrClass, item.representativeDrugs, item.missingLabPolicy]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

/**
 * 药品目录同步用的只读枚举口（甲方 2026-08-05「药品同步接口」）。
 *
 * 与下面两个 search* 不同：那两个是为**拼提示词**设计的模糊 tokenIncluded 匹配，
 * 复用到对账场景会漏条目。目录同步要的是全量、稳定顺序、原样字段。
 */
export function listKnowledgeHerbNames(): string[] {
  return data.herbs.map((item) => item.name).filter(Boolean).sort();
}

export function listHisTcmMappings(): readonly HisTcmMapping[] {
  return data.hisSupport?.tcmMappings || [];
}

export function listHisSpecConversions(): readonly HisSpecConversion[] {
  return data.hisSupport?.specConversions || [];
}

function searchHisTcmMappings(query: string, limit = 8): HisTcmMapping[] {
  const text = query.replace(/\s+/g, "");
  return (data.hisSupport?.tcmMappings || []).filter((item) =>
    [item.queriedDrug, item.goodsName, item.mappedStandardNames, item.variants]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

function searchHisSpecConversions(query: string, limit = 8): HisSpecConversion[] {
  const text = query.replace(/\s+/g, "");
  return (data.hisSupport?.specConversions || []).filter((item) =>
    [item.queriedDrug, item.goodsName, item.goodsSpec, item.defaultUse, item.defaultFrequency]
      .some((field) => field && tokenIncluded(field, text))
  ).slice(0, limit);
}

function formatHisSupportContext(query: string): string {
  const lines: string[] = [];
  const mappings = searchHisTcmMappings(query);
  const specs = searchHisSpecConversions(query);
  const stateRules = (data.hisSupport?.clinicalStateDictionary || []).slice(0, 10);
  const routeRules = (data.hisSupport?.routeDictionary || []).filter((item) =>
    ["口服", "水煎服", "先煎", "后下", "包煎", "冲服", "另煎"].some((key) => item.hisValue.includes(key))
  ).slice(0, 12);

  lines.push("HIS对接与字段归一规则：HIS药名、规格、给药途径、频次和煎服法必须先归一再进入规则匹配；AUTO_PARSED_NEEDS_REVIEW 规格换算只能作为医生/药师复核提示，不得作为强确定剂量依据。");

  if (mappings.length > 0) {
    lines.push("命中HIS中药本地映射：");
    for (const item of mappings) {
      lines.push(`- ${item.queriedDrug || item.goodsName} → ${item.mappedStandardNames || "待映射"}；规格：${item.goodsSpec || "未提供"}；状态：${item.status}；缺口：${item.remainingDataGaps || "无"}`);
    }
  }

  if (specs.length > 0) {
    lines.push("命中HIS规格/剂量换算候选：");
    for (const item of specs) {
      lines.push(`- ${item.goodsName || item.queriedDrug} ${item.goodsSpec || ""}：${item.strengthValue || "?"}${item.strengthUnit || ""}；默认用法：${[item.defaultUse, item.defaultFrequency].filter(Boolean).join("/")}；状态：${item.conversionStatus}；用途：${item.ruleUse}`);
    }
  }

  if (routeRules.length > 0) {
    lines.push(`给药途径/频次/煎服法字典示例：${routeRules.map((item) => `${item.hisValue}→${item.normalizedCode}(${item.routeClass})`).join("；")}`);
  }

  if (stateRules.length > 0) {
    lines.push("否定/时态过滤规则：当前患者状态为真才触发禁忌；否认、既往、家族史不得当作当前禁忌。示例：" +
      stateRules.map((item) => `${item.stateName}：阳性[${item.positiveTerms}]，否定[${item.negationTerms}]`).join("；")
    );
  }

  return lines.join("\n");
}

function formatCommonDoseIndex(): string {
  const safetySuffix = (name: string) => {
    const profile = getTcmHerbGenerationSafetyProfile(name);
    const flags = [
      ...(profile.isToxic ? [`毒性:${profile.toxicity.join("、")}`] : []),
      ...profile.populationRules
        .filter((rule) => rule.severity !== "LOW")
        .map((rule) => `${rule.population}:${rule.severity}`),
    ];
    return flags.length > 0 ? `，生成前安全:${flags.join("/")}` : "";
  };
  // 这份名单是以禁止性措辞下发给 M04 的，因此它必须等于代码实际执行的范围
  // （doseWithinConservativeModelLimit 校验的是全部可解析剂量的饮片），不能是其中一个子集。
  //
  // 此前这里只遍历 data.commonHerbs——上游 tcm_curated_llm_candidates 的 99 行「待人工复核」
  // 工作队列。后果实测：名单里同时出现马钱子/巴豆霜/斑蝥/朱砂/雄黄/蟾酥/轻粉/罂粟壳，却没有
  // 黄芪/白术/茯苓/当归/龙眼肉；500 个受控方剂中只有 7 个全部药味在名单内，归脾汤 8 味缺 4 味。
  // 模型若照此禁令执行，等于被要求用一份毒性药清单组方。
  //
  // 改为遍历全部饮片并保留 commonHerbs 的煎法/风险标注，名单与代码门禁一致；毒性与特殊人群提示
  // 仍逐条附带，安全信息不减反增。
  const curatedAnnotations = new Map(data.commonHerbs.map((item) => [item.name, item]));
  const doseGoverned = data.herbs.flatMap((item) => {
    const limit = getTcmHerbDoseLimit(item.name);
    if (limit?.min == null || limit.max == null) return [];
    const curated = curatedAnnotations.get(item.name);
    const dose = `${limit.min}-${limit.max}g`;
    const method = curated?.methods?.length ? `，${curated.methods.join("、")}` : "";
    const risk = curated?.riskTags?.length ? `，${curated.riskTags.join("、")}` : "";
    const sourceConflict = limit.sourceConflict
      ? "，存在分用途剂量差异，模型采用保守主范围并交由审方按实际用途复核"
      : "";
    return [`${item.name}${dose}${method}${risk}${sourceConflict}${safetySuffix(item.name)}`];
  });
  const governedNames = new Set(data.herbs.map((item) => item.name));
  const controlled = ["茯神", "夜交藤"].flatMap((name) => {
    if (governedNames.has(name)) return [];
    const limit = getTcmHerbDoseLimit(name);
    return limit?.min != null && limit.max != null ? [`${name}${limit.min}-${limit.max}g${safetySuffix(name)}`] : [];
  });
  return [...doseGoverned, ...controlled].join("；");
}

export function buildTcmKnowledgeContext(caseState: CaseState, stage: "diagnose" | "prescribe" | "assess"): string {
  const text = caseText(caseState);
  const hits = searchTcmKnowledge(text, stage === "prescribe" ? 12 : 16);
  const patentRisks = searchPatentRisks(text);
  const westernInteractions = searchWesternInteractions(text);
  const currentMedicationConflicts = searchCurrentMedicationConflicts(text);
  const labThresholds = searchLabThresholds(text);
  const sections: string[] = [];

  sections.push("## 院内合理用药/中医药知识库支持");
  sections.push(`知识库版本：${data.schemaVersion}；生成时间：${data.generatedAt}；饮片条目：${data.summary.herbCount}。`);
  sections.push("使用边界：以下内容仅作为证据与风险提示素材，不替代医生审方；不得输出“硬拦截/自动通过”。");
  sections.push("药典版本边界：本地剂量规则含2020版历史基线；2025年10月1日起处方采纳必须以《中华人民共和国药典》2025年版、现行说明书及院内药事规则复核，历史基线不得表述为现行药典核验结论。");
  sections.push(`全局规则：${data.globalRules.join(" ")}`);
  sections.push(formatHisSupportContext(text));

  if (stage === "prescribe") {
    sections.push(`候选处方剂量限定名单（用于候选处方剂量核验；herbs[]只能选择本名单或下方命中规则中带明确最小/最大剂量的药味；未覆盖药味不得输出剂量或放入候选处方）：${formatCommonDoseIndex()}`);
    sections.push(`模型生成前置配伍核验索引（来自本地结构化高风险配伍规则；候选方不得同时包含任一药对，医生工作台修改后仍以真实审方为准）：${formatHighRiskPairIndex()}`);
  }

  if (hits.length > 0) {
    sections.push("命中饮片/药味规则：");
    for (const hit of hits) {
      const details = hit.entries.map((entry) => `  - ${compactEntry(entry)}`).join("\n");
      sections.push(`- ${hit.name}\n${details}`);
    }
  } else {
    sections.push("命中饮片/药味规则：暂未从病例文本命中具体药味；处方生成时需优先选择可核验药味，并标注依据。");
  }

  if (patentRisks.length > 0) {
    sections.push("命中中成药重点风险：");
    for (const item of patentRisks) {
      sections.push(`- ${item.productOrGroup}：${item.keyRiskFields}；触发：${item.triggerCondition}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (westernInteractions.length > 0) {
    sections.push("命中西药/中成药相互作用或同类互斥：");
    for (const item of westernInteractions) {
      sections.push(`- ${item.left} + ${item.right}：${item.condition}；强度${item.severity}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (currentMedicationConflicts.length > 0) {
    sections.push("命中当前用药-新处方冲突/同类互斥：");
    for (const item of currentMedicationConflicts) {
      sections.push(`- ${item.ruleName}：当前用药${item.existingExamples}，新处方${item.newExamples}；条件：${item.condition}；强度${item.severity}；提示动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  if (labThresholds.length > 0 || stage === "assess") {
    sections.push("实验室/检查阈值规则：");
    const rules = labThresholds.length > 0 ? labThresholds : (data.labThresholds || []).slice(0, 6);
    for (const item of rules) {
      sections.push(`- ${item.condition}（${item.lab} ${item.operator} ${item.thresholdValue}${item.thresholdUnit}）：涉及${item.drugOrClass}，强度${item.severity}；缺失策略：${item.missingLabPolicy}；动作：${item.action}；依据：${item.sourceIds}`);
    }
  }

  return sections.join("\n");
}

function parseDoseValue(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:g|克)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function doseForHerb(text: string, herb: string): number | null {
  const compact = text.replace(/\s+/g, "");
  const index = compact.indexOf(herb);
  if (index < 0) return null;
  const afterHerb = compact.slice(index + herb.length);
  const nextHerbIndex = herbNamesByLength
    .filter((name) => name !== herb)
    .map((name) => afterHerb.indexOf(name))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0];
  const separatorIndex = afterHerb.search(/[，,、；;。]/);
  const stopIndex = [nextHerbIndex, separatorIndex]
    .filter((value): value is number => typeof value === "number" && value >= 0)
    .sort((a, b) => a - b)[0];
  const contextAfterHerb = stopIndex == null
    ? afterHerb.slice(0, 24)
    : afterHerb.slice(0, stopIndex);
  const windowText = `${herb}${contextAfterHerb}`;
  return parseDoseValue(windowText);
}

function cleanTableCell(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseMarkdownCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function herbNameFromText(text: string): string | null {
  const compact = cleanTableCell(text);
  return herbNamesByLength.find((name) => compact.includes(name)) || null;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function addPrescribedHerb(rows: PrescribedHerb[], name: string | null, dose: number | null, line: string): void {
  if (!name) return;
  const existing = rows.find((item) => item.name === name);
  if (existing) {
    if (existing.dose == null && dose != null) existing.dose = dose;
    if (!existing.line.includes(line)) existing.line = `${existing.line}\n${line}`;
    return;
  }
  rows.push({ name, dose, line });
}

function isLikelyNonPrescriptionLine(line: string): boolean {
  return /(禁忌|禁用|慎用|风险|提示|证据|依据|不宜与|十八反|十九畏|相反|相畏|来源|支持证据|医生动作|复核|排除|避免|若|如出现|患者须知)/.test(line);
}

function isLikelyNonPrescriptionFreeTextLine(line: string): boolean {
  return isLikelyNonPrescriptionLine(line);
}

function isPrescriptionHeading(line: string): boolean {
  return /^#{1,6}\s*(?:中药饮片处方|候选处方|处方正文|处方明细|推荐处方|候选方药方案)/.test(line);
}

function isNonPrescriptionHeading(line: string): boolean {
  return /^#{1,6}\s*(?:西药|中成药|用药风险|安全校验|处方风险|风险随访|随访|非药物|注意事项|组方依据|加减思路|适用条件|不适用条件|证据|引用)/.test(line);
}

function hasTableHeaderCue(cells: string[]): boolean {
  return cells.some((cell) => /(药名|饮片|中药|剂量|用量|风险|提示|证据|依据|医生动作|涉及对象|风险说明|提示强度)/.test(cell));
}

function isRiskReviewHeader(cells: string[]): boolean {
  const joined = cells.join("");
  return /(提示强度|涉及对象|风险说明|医生动作|触发处置)/.test(joined);
}

export function extractPrescribedHerbs(prescriptionText: string): PrescribedHerb[] {
  const rows: PrescribedHerb[] = [];
  const lines = prescriptionText.split(/\r?\n/);
  let pipeHeader: { nameIndex: number; doseIndex: number } | null = null;
  let tabHeader: { nameIndex: number; doseIndex: number } | null = null;
  let inPrescriptionSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) {
      inPrescriptionSection = isPrescriptionHeading(line);
      if (isNonPrescriptionHeading(line)) inPrescriptionSection = false;
      pipeHeader = null;
      tabHeader = null;
      continue;
    }

    const pipeCells = parseMarkdownCells(line);
    if (pipeCells.length > 0) {
      const compactCells = pipeCells.map(cleanTableCell);
      const nameIndex = compactCells.findIndex((cell) => /药名|饮片|中药/.test(cell));
      const doseIndex = compactCells.findIndex((cell) => /剂量|用量/.test(cell));
      if (nameIndex >= 0 && doseIndex >= 0) {
        pipeHeader = { nameIndex, doseIndex };
        inPrescriptionSection = true;
        continue;
      }
      if (isRiskReviewHeader(compactCells)) {
        pipeHeader = null;
        inPrescriptionSection = false;
        continue;
      }
      if (!pipeHeader && hasTableHeaderCue(compactCells)) {
        pipeHeader = null;
        continue;
      }
      if (pipeHeader && inPrescriptionSection && !isSeparatorRow(pipeCells)) {
        const name = herbNameFromText(pipeCells[pipeHeader.nameIndex] || "");
        const dose = parseDoseValue(pipeCells[pipeHeader.doseIndex] || "") ?? doseForHerb(line, name || "");
        addPrescribedHerb(rows, name, dose, line);
      }
      continue;
    }

    const tabCells = line.includes("\t") ? line.split("\t").map((cell) => cell.trim()) : [];
    if (tabCells.length > 1) {
      const compactCells = tabCells.map(cleanTableCell);
      const nameIndex = compactCells.findIndex((cell) => /药名|饮片|中药/.test(cell));
      const doseIndex = compactCells.findIndex((cell) => /剂量|用量/.test(cell));
      if (nameIndex >= 0 && doseIndex >= 0) {
        tabHeader = { nameIndex, doseIndex };
        inPrescriptionSection = true;
        continue;
      }
      if (isRiskReviewHeader(compactCells)) {
        tabHeader = null;
        inPrescriptionSection = false;
        continue;
      }
      if (!tabHeader && hasTableHeaderCue(compactCells)) {
        tabHeader = null;
        continue;
      }
      if (tabHeader && inPrescriptionSection) {
        const name = herbNameFromText(tabCells[tabHeader.nameIndex] || "");
        const dose = parseDoseValue(tabCells[tabHeader.doseIndex] || "") ?? doseForHerb(line, name || "");
        addPrescribedHerb(rows, name, dose, line);
      }
      continue;
    }

    pipeHeader = null;
    tabHeader = null;
  }

  const prescriptionScope = prescriptionText
    .split(/\n(?=#{1,6}\s*(?:西药|中成药|用药风险|安全校验|处方风险|风险随访|随访|非药物|注意事项))/)[0] || prescriptionText;
  for (const rawLine of prescriptionScope.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isLikelyNonPrescriptionFreeTextLine(line)) continue;
    const matchedNames: string[] = [];
    for (const herb of herbNamesByLength) {
      if (!line.includes(herb)) continue;
      if (matchedNames.some((name) => name.includes(herb))) continue;
      const dose = doseForHerb(line, herb);
      if (dose == null) continue;
      addPrescribedHerb(rows, herb, dose, line);
      matchedNames.push(herb);
    }
  }

  return rows;
}

function canonicalKnowledgeHerbName(value: string): string {
  const normalized = normalizedHerbLookupToken(value);
  const controlled = CONTROLLED_HERB_ALIASES[normalized];
  if (controlled) return canonicalHerbNameByToken.get(normalizedHerbLookupToken(controlled)) || controlled;
  const direct = canonicalHerbNameByToken.get(normalized);
  if (direct) return direct;
  // T9 受控饮片名解析。经典方与地方标准方的组成用的是饮片规格与古名——黄芩片、附片、山萸肉、
  // 麦门冬、盐菟丝子、燀桃仁——T9 已经把它们逐条映射到标准名，但剂量层此前从不查这张表，于是
  // 一味药典里明明有剂量的饮片被判为"无剂量"，整张方子随之不可开具（实测 500 个受控方剂中
  // 只有 158 个全部药味可解析剂量）。
  //
  // 这条链路是 fail-closed 的：resolveGovernedTcmHerbIdentity 只有在 autoResolvable 且非歧义时
  // 才给出 canonicalName；芍药（白芍/赤芍）、白茯苓、贝母 等歧义名返回 ambiguous 而没有
  // canonicalName，因此仍然解析不出剂量，仍然交人工判定，不会被本改动放行。
  // doseCanonicalName 优先于 canonicalName：生地黄的标准名是生地黄，但剂量条目挂在地黄下。
  const governed = resolveGovernedTcmHerbIdentity(value);
  const governedName = governed.doseCanonicalName || governed.canonicalName;
  if (governedName) {
    return canonicalHerbNameByToken.get(normalizedHerbLookupToken(governedName)) || governedName;
  }
  const withoutProcessing = normalized.replace(/^(?:蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制|生)/, "");
  return canonicalHerbNameByToken.get(withoutProcessing) || withoutProcessing;
}

const commonTcmHerbNames = new Set(data.commonHerbs.map((item) => item.name));

/**
 * Whether a herb belongs to the governed common-clinic subset. Consumers use this as a stable
 * ranking signal only; it does not grant dose, efficacy, or safety authority by itself.
 */
export function isCommonTcmHerbName(herb: string): boolean {
  return commonTcmHerbNames.has(canonicalKnowledgeHerbName(herb));
}

export type TcmGovernedHighImpactConcept = "orifice_open" | "mass_soften";

const TCM_GOVERNED_HIGH_IMPACT_HERBS: Readonly<Record<TcmGovernedHighImpactConcept, ReadonlySet<string>>> = {
  orifice_open: new Set(["远志", "麝香", "冰片", "石菖蒲", "苏合香", "安息香"]),
  mass_soften: new Set(["牡蛎", "鳖甲", "昆布", "海藻", "瓦楞子", "海蛤壳"]),
};

/**
 * Server-governed action classes for herbs whose concise catalog category can hide a
 * direction-changing specialist action. This mapping is clinical data, not UI text parsing.
 */
export function getTcmHerbGovernedHighImpactConcepts(herb: string): TcmGovernedHighImpactConcept[] {
  const canonical = canonicalKnowledgeHerbName(herb);
  return (Object.entries(TCM_GOVERNED_HIGH_IMPACT_HERBS) as Array<[TcmGovernedHighImpactConcept, ReadonlySet<string>]>)
    .filter(([, herbs]) => herbs.has(canonical) || [...herbs].some((entry) => canonicalKnowledgeHerbName(entry) === canonical))
    .map(([concept]) => concept);
}

export type TcmHerbDoseLimit = {
  min?: number | null;
  max?: number | null;
  basis?: string;
  sourceType?: "dose" | "routeDose" | "curatedDose" | "common";
  sourceConflict?: boolean;
  alternatives?: Array<{
    min: number;
    max: number;
    sourceType: "dose" | "routeDose";
    basis?: string;
    routeForm?: string;
    method?: string;
  }>;
};

function validDoseEntries(entries: KnowledgeEntry[], type: string): KnowledgeEntry[] {
  return entries.filter((entry) =>
    entry.type === type &&
    entry.minG != null && entry.maxG != null &&
    Number.isFinite(Number(entry.minG)) && Number.isFinite(Number(entry.maxG)) &&
    Number(entry.minG) > 0 && Number(entry.minG) <= Number(entry.maxG)
  );
}

function resolvedDoseEntry(
  entries: KnowledgeEntry[],
  sourceType: "dose" | "routeDose",
  equivalentBasis?: string,
  competingEntries: KnowledgeEntry[] = [],
): TcmHerbDoseLimit | null {
  if (entries.length === 0) return null;
  const primary = entries[0];
  const overlapping = entries.filter((entry) =>
    Number(entry.minG) <= Number(primary.maxG) && Number(entry.maxG) >= Number(primary.minG)
  );
  const min = Math.max(...overlapping.map((entry) => Number(entry.minG)));
  const max = Math.min(...overlapping.map((entry) => Number(entry.maxG)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  const sourceConflict = [...entries, ...competingEntries].some((entry) =>
    Number(entry.maxG) < min || Number(entry.minG) > max
  );
  const alternatives = [...entries, ...competingEntries].flatMap((entry) => {
    const entryMin = Number(entry.minG);
    const entryMax = Number(entry.maxG);
    if (!(entryMax < min || entryMin > max)) return [];
    return [{
      min: entryMin,
      max: entryMax,
      sourceType: entry.type === "routeDose" ? "routeDose" as const : "dose" as const,
      ...(entry.basis ? { basis: entry.basis } : {}),
      ...(entry.routeForm ? { routeForm: entry.routeForm } : {}),
      ...(entry.method ? { method: entry.method } : {}),
    }];
  });
  const bases = [...new Set(entries.map((entry) => entry.basis).filter(Boolean))].join("；");
  return {
    min,
    max,
    basis: equivalentBasis || bases,
    sourceType,
    ...(sourceConflict ? { sourceConflict: true } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
}

export function getTcmHerbDoseLimit(herb: string): TcmHerbDoseLimit | null {
  const canonical = canonicalKnowledgeHerbName(herb);
  // 显式炮制边界必须先按**身份正名**查，再退回剂量归一名。
  //
  // canonicalKnowledgeHerbName 取的是 doseCanonicalName || canonicalName，而 doseCanonicalName
  // 只是「剂量条目挂在哪」的重定向（生地黄的条目挂在地黄下）。它会把 干地黄/细生地/大生地/
  // 怀生地 一路归一成「地黄」，从而**绕过**下面专为生地黄设的 10-15g 覆盖，拿到地黄那一行里
  // 鲜地黄的 12-30g —— 上限整整翻倍。而 地黄 的 dose 条目 doseText 原文是
  //   「鲜地黄 12～30g。\n生地黄 10～15g。」
  // 解析只保留了第一行，这正是下面那条硬覆盖存在的原因；可它此前只在归一名恰好等于
  // 「生地黄」时才生效——生地/生地黄 幸免仅因它们在 CONTROLLED_HERB_ALIASES 里被提前拦住。
  // 更麻烦的是 10-15 与 12-30 相交，sourceConflict 不置位，30g 一路判合规、不转人工复核，
  // 是 fail-open。干地黄/细生地/大生地/怀生地 都是**干品**生地黄，药典就是 10-15g。
  // 鲜生地 的身份正名是鲜地黄、不在覆盖表内，仍走 12-30g，符合药典。
  const identityName = resolveGovernedTcmHerbIdentity(herb).canonicalName;
  const exact = (identityName ? CONTROLLED_EXACT_HERB_DOSE_LIMITS[identityName] : undefined)
    ?? CONTROLLED_EXACT_HERB_DOSE_LIMITS[canonical];
  if (exact) return { ...exact };
  // 受控等价条目（茯神→茯苓）按原始名称优先：T9 归一会把茯神直接解析为茯苓，若只按归一名
  // 查表，会丢掉"茯神为带松根的茯苓部位，用量按茯苓复核"的审计口径（该口径有套件锁定）。
  const equivalent = CONTROLLED_HERB_DOSE_EQUIVALENTS[herb.trim()] ?? CONTROLLED_HERB_DOSE_EQUIVALENTS[canonical];
  const doseName = equivalent?.target || canonical;
  const herbData = data.herbs.find((item) => item.name === doseName || item.aliases.includes(doseName));
  // 主药典剂量条目是本地历史规则包的首要边界。分途径条目仅在主条目缺失时接管；若两类
  // 范围不相交则显式标记冲突，而不是把整味药静默降成“无剂量数据”。
  const entries = herbData?.entries || [];
  const primaryDoseEntries = validDoseEntries(entries, "dose");
  const curatedDoseEntries = validDoseEntries(entries, "curatedDose");
  const decoctionRouteEntries = validDoseEntries(entries, "routeDose").filter((entry) =>
    /煎服|汤剂|另煎|另炖/.test(`${entry.routeForm || ""}${entry.method || ""}`)
  );
  // When the pharmacopoeia range and the clinic/dispensing range overlap, model-generated doses
  // use their conservative intersection. This prevents a candidate that is legal at the broad
  // source ceiling but predictably rejected by the downstream institutional audit. Disjoint
  // sources remain an explicit sourceConflict and retain the primary pharmacopoeia range.
  const primary = resolvedDoseEntry(
    [...primaryDoseEntries, ...curatedDoseEntries],
    "dose",
    equivalent?.basis,
    decoctionRouteEntries,
  );
  if (primary) return primary;
  const route = resolvedDoseEntry(decoctionRouteEntries, "routeDose", equivalent?.basis);
  if (route) return route;
  const curated = curatedDoseEntries[0];
  if (curated) return { min: curated.minG, max: curated.maxG, basis: equivalent?.basis || curated.basis, sourceType: "curatedDose" };
  const common = data.commonHerbs.find((item) => item.name === doseName);
  return common ? { min: common.minG, max: common.maxG, basis: equivalent?.basis || common.basis, sourceType: "common" } : null;
}


/**
 * 缺法定数值剂量边界、改由医师定量的成分（甲方 2026-08-01 决策：降低门禁、审方兜底）。
 *
 * 此前这些成分让整方不可编译：1352/2915 的受控方一旦被 M03 锁定就只能返回非剂量结果，
 * 医生连一张自拟方都拿不到。现在改为——系统**不为它们校验数值边界**，但也**不声称它们正确**：
 * 处方里按类别标注核验级别（管制毒性/禁用动物药 → toxic_regulated，其余 → unverified_dose），
 * 用量由医师确定，并照常提交灵犀审方。
 *
 * 边界没有取消，只是移交：系统不再假装知道剂量，而是明确告诉医生「这一味需要你定」。
 * 同一张表由 T8 生成器与运行时共用，避免目录说可编译而运行时说不可编译的分叉。
 */
export type ClinicianDoseClass =
  | "pharmacopoeia_not_listed"
  | "controlled_or_toxic"
  | "endangered_or_banned"
  | "food_or_vehicle"
  | "pill_powder_only";

/**
 * 监管轴名单（麻醉药品目录 / 医疗用毒性药品目录）此前只在**构建期**被读到：T8 目录据它
 * 决定整方能不能自动配剂量，运行时却没有任何消费者。后果是同一张表在两侧口径不一致——
 * 自拟方里出现罂粟壳，运行时 clinicianDoseHerbClass 返回 undefined，既不阻断也不标注，
 * 而它是麻醉药品目录品种。这里让运行时读同一份 source 表，两侧从此同源。
 */
const REGULATORY_CONTROLLED_HERB_NAMES: ReadonlySet<string> = (() => {
  const payload = controlledToxicPolicyJson as unknown as {
    entries?: Array<{ herb?: string; aliases?: string[]; policy?: string }>;
  };
  const names = new Set<string>();
  for (const entry of payload.entries || []) {
    if (entry?.policy !== "blocked") continue;
    for (const value of [entry.herb, ...(entry.aliases || [])]) {
      const name = typeof value === "string" ? value.trim() : "";
      if (name) names.add(name);
    }
  }
  return names;
})();

const CLINICIAN_DOSE_CLASS_BY_NAME: ReadonlyMap<string, ClinicianDoseClass> = (() => {
  const policy = clinicianDosePolicyJson as unknown as {
    ingredients?: Record<string, Array<{ name?: string }>>;
  };
  const map = new Map<string, ClinicianDoseClass>();
  for (const [group, items] of Object.entries(policy.ingredients || {})) {
    for (const item of items || []) {
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (name && !map.has(name)) map.set(name, group as ClinicianDoseClass);
    }
  }
  return map;
})();

/** 炮制前后缀：查豁免表时一并剥离，否则「醋没药/煅龙骨/朱砂粉」这些变体名查不到基名。 */
const CLINICIAN_DOSE_PROCESSING_AFFIX =
  /^(?:蜜炙|麸炒|土炒|盐炒|酒炒|醋炒|姜炒|炒|炙|醋|酒|盐|姜|煅|制|生|焦|熟|鲜|明|上|净|真)|(?:炭|霜|片|粉|末|丝|段|块)$/g;

/** 该成分是否属「由医师确定用量」范围（无法定数值边界，系统不校验但必须标注）。 */
export function clinicianDoseHerbClass(herb: string): ClinicianDoseClass | undefined {
  const raw = typeof herb === "string" ? herb.trim() : "";
  if (!raw) return undefined;
  // 监管身份优先于豁免表：它回答的不是「有没有法定剂量」，而是「系统有没有资格替医生开」。
  // 别名与规范名都要认——腻粉/明雄黄/扫盆 都指向目录品种。
  if (REGULATORY_CONTROLLED_HERB_NAMES.has(raw)
    || REGULATORY_CONTROLLED_HERB_NAMES.has(canonicalKnowledgeHerbName(raw))) {
    return "controlled_or_toxic";
  }
  const direct = CLINICIAN_DOSE_CLASS_BY_NAME.get(raw)
    || CLINICIAN_DOSE_CLASS_BY_NAME.get(canonicalKnowledgeHerbName(raw));
  if (direct) return direct;
  // 炮制变体走基名：醋没药→没药、煅龙骨→龙骨、朱砂粉→朱砂。炮制不改变「有没有法定剂量边界」
  // 这件事，若不剥离，71 张方会因变体名查不到基名而继续阻断。
  const base = raw.replace(CLINICIAN_DOSE_PROCESSING_AFFIX, "").trim();
  if (!base || base === raw) return undefined;
  if (REGULATORY_CONTROLLED_HERB_NAMES.has(base)
    || REGULATORY_CONTROLLED_HERB_NAMES.has(canonicalKnowledgeHerbName(base))) {
    return "controlled_or_toxic";
  }
  return CLINICIAN_DOSE_CLASS_BY_NAME.get(base)
    || CLINICIAN_DOSE_CLASS_BY_NAME.get(canonicalKnowledgeHerbName(base));
}

/**
 * 管制毒性与法律禁用动物药**不参与剂量豁免**：它们的门槛来自法规（处方权绑定医师个人、
 * 须走专用处方载体、野生动物保护法禁用），不是数据缺口。灵犀审方能复核用药合理性，
 * 但替代不了处方权与处方载体，因此这两类仍旧转人工，不因产品侧降低门禁而放行。
 */
const REGULATORY_BLOCKED_CLASSES: ReadonlySet<ClinicianDoseClass> = new Set([
  "controlled_or_toxic",
  "endangered_or_banned",
]);

export function isClinicianDoseHerb(herb: string): boolean {
  // 身份判不出来的名字拿不到豁免。豁免的前提是「知道是哪味药、只是没有法定数值边界」；
  // 单字残片连是不是药都不知道，给它豁免等于把抽取缺陷洗成「医师定量」下发。
  // 注意只在**授予豁免**这一侧拦，不改 clinicianDoseHerbClass 的分类结果——
  // 后者还被用来把管制毒性品种排除在候选之外，那条路径变宽才是真的危险。
  if (isIdentityIndeterminateHerbName(herb)) return false;
  // 身份分叉的名字同理：知道是药，但不知道是**哪一味**。芍药→白芍/赤芍、皂角→大皂角/猪牙皂、
  // 贯众→狗脊/绵马贯众、青木香→木香/防己。它们的 canonicalName 为空，十八反十九畏、
  // 特殊人群门禁、管制毒性排除全按规范名索引——这一味对每一道安全检查都是隐形的，
  // 却还能拿到「医师定量」豁免通行。与构建期 is_variety_forked_link 同一判据，两侧必须一致：
  // 实测（2026-08-09 全目录）豁免表里混进 117 处歧义链接，放行了 93 首方。
  // 注意用的是「分叉」而不是「歧义」：白蜜已解析到蜂蜜，规范名在，不该被这条拦掉。
  if (isVarietyForkedHerbIdentity(herb)) return false;
  const clinicianClass = clinicianDoseHerbClass(herb);
  return clinicianClass !== undefined && !REGULATORY_BLOCKED_CLASSES.has(clinicianClass);
}

/**
 * 功用补充：分类表按**主章节**归类（牡蛎→平抑肝阳药），同一味药落在别的章节里的第二功效
 * （煅牡蛎收敛固涩）因此在知识库里查不到。后果不是提示不全，而是整方被驳——治法写
 * 「益气固表，敛汗止汗」的方里用煅牡蛎，君臣支撑率会把它算作不落在任何已锁定方向上
 * （实测网络医案 37/41 自汗案，均因此 0 味）。
 * 只追加、不替换：原功用文本与分类标签一字不动。
 */
const FUNCTION_SUPPLEMENT_BY_NAME: ReadonlyMap<string, string> = new Map(
  (functionSupplementsJson as unknown as { entries?: Array<{ herb?: string; supplement?: string }> })
    .entries
    ?.filter((entry) => typeof entry?.herb === "string" && typeof entry?.supplement === "string")
    .map((entry) => [entry.herb as string, entry.supplement as string]) || [],
);

function withFunctionSupplement(canonical: string, text: string): string {
  const supplement = FUNCTION_SUPPLEMENT_BY_NAME.get(canonical);
  if (!supplement || text.includes(supplement)) return text;
  return text ? `${text}；${supplement}` : supplement;
}

export function getTcmHerbFunctionText(herb: string): string {
  const canonical = canonicalKnowledgeHerbName(herb);
  const herbData = data.herbs.find((item) => item.name === canonical || item.aliases.includes(canonical));
  const extracted = (herbData?.entries || [])
    .map((entry) => entry.functionText)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("；");
  const categoryIndex = herbFunctionCategories.categories as Record<string, string[]>;
  const categories = categoryIndex[canonical] || [];
  const controlled = CONTROLLED_HERB_FUNCTION_TEXT[canonical];
  if (controlled) return withFunctionSupplement(canonical, [controlled, ...categories.slice(0, 2)].filter(Boolean).join("；"));

  const categoryConcepts: Array<[RegExp, RegExp]> = [
    [/补气|补虚/, /大补元气|补中益气|健脾益气|补气|益气|固表|升阳/],
    [/补血/, /补血|养血|益血/],
    [/安神/, /安神|宁心|宁神|定志|镇惊/],
    [/理气/, /理气|行气|疏肝|解郁|止痛/],
    [/清热/, /清热|泻火|凉血|解毒/],
    [/利水|祛湿/, /利水|渗湿|祛湿|燥湿/],
    [/活血/, /活血|化瘀|通经|止痛/],
    [/化痰|止咳|平喘/, /化痰|祛痰|止咳|平喘/],
    [/温里|补阳/, /温中|温阳|补阳|散寒/],
    [/消食/, /消食|导滞|健胃/],
  ];
  const activeConcepts = categoryConcepts.filter(([category]) => categories.some((item) => category.test(item))).map(([, concept]) => concept);
  const actionWord = /补|益|养|健|安|宁|行|理|疏|清|泻|温|散|化|祛|利|止|固|敛|活|通|消|和|调|润|解|生津|托毒|排脓/;
  const unsuitable = /美容|养颜|驻颜|减肥|抗癌|延年益寿|包治|根治|痛经|痈肿|壮阳/;
  const ranked = extracted.split(/[、，；;]+/).map((text, index) => ({ text: text.trim(), index }))
    .filter((item) => item.text.length >= 2 && item.text.length <= 12 && actionWord.test(item.text) && !unsuitable.test(item.text))
    .map((item) => ({
      ...item,
      score: (activeConcepts.some((pattern) => pattern.test(item.text)) ? 20 : 0) +
        (item.text.length >= 4 && item.text.length <= 8 ? 4 : 0) - item.index / 1000,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const concise: string[] = [];
  for (const item of ranked) {
    if (concise.some((existing) => existing.includes(item.text) || item.text.includes(existing))) continue;
    concise.push(item.text);
    if (concise.length >= 5) break;
  }
  return withFunctionSupplement(canonical, [concise.join("，"), ...categories.slice(0, 2)].filter(Boolean).join("；"));
}

/**
 * Return the governed textbook category labels used for direction-level checks. These labels are
 * deliberately kept separate from the broader merged function text, whose historical sources may
 * contain noisy or overly broad indications that are unsuitable for high-impact safety decisions.
 */
export function getTcmHerbFunctionCategories(herb: string): string[] {
  const canonical = canonicalKnowledgeHerbName(herb);
  const categoryIndex = herbFunctionCategories.categories as Record<string, string[]>;
  return [...new Set([...(categoryIndex[canonical] || []), ...(CONTROLLED_HERB_FUNCTION_CATEGORIES[canonical] || [])])];
}

/** 功效分类 → 药味的反向索引（由正向表一次性派生，不新增数据）。 */
const herbsByFunctionCategory: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [herb, categories] of Object.entries(herbFunctionCategories.categories as Record<string, string[]>)) {
    for (const category of categories) {
      const bucket = index.get(category);
      if (bucket) bucket.push(herb);
      else index.set(category, [herb]);
    }
  }
  // 稳定排序：同一输入必须得到同一批替代药，否则同一病例两次请求给出不同建议。
  for (const bucket of index.values()) bucket.sort();
  return index;
})();

/**
 * 药味的受治理风险码（BLOOD_BREAKING / TOXIC_REGULATORY / SPECIAL_POPULATION_HIGH_RISK 等）。
 * 风险档原文是「码；中文名；分类…」的拼接串，这里只取大写码，避免把分类名当风险比。
 */
function governedRiskCodes(herb: string): ReadonlySet<string> {
  return new Set((getTcmHerbRiskProfile(herb).match(/[A-Z][A-Z_]{3,}/g) || []));
}

export type GovernedHerbSubstitute = {
  replaces: string;
  substitute: string;
  rationale: string;
  differenceNote: string;
};

/**
 * 同向可替换药味（甲方 2026-08-05「随证加减建议——可增加：可替换药味的说明」）。
 *
 * 场景是真实的：该加的药缺货、患者过敏、或属特殊人群禁用时，医生需要一个同向替代。
 * 但**替代药绝不能由模型自由发挥**——那等于让模型开药。这里只做受治理数据的确定性推导：
 * 候选来自同一功效分类（教材层面的分类表，507 味），再逐条过安全边界。
 *
 * 硬约束（缺一不可，宁可返回空数组也不放宽）：
 *  · 必须有药典数值剂量边界，且无分用途冲突——「由医师确定用量」的药不能作为系统给出的替代；
 *  · 排除管制毒性与法律禁用品种（clinicianDoseHerbClass 命中即出局）；
 *  · 与**现方全部药味**及被替换药本身都不得构成十八反十九畏；
 *  · 不得建议现方已有的药味（那不是替代，是重复）。
 *
 * differenceNote 只转述知识库里两味药各自的功效条目，并明写「系统不裁定二者等效」——
 * 差异判断权在医师。系统不生成任何知识库没有的药理主张。
 */
export function governedHerbSubstitutes(
  herb: string,
  prescriptionHerbs: readonly string[],
  limit = 2,
): GovernedHerbSubstitute[] {
  const canonical = canonicalKnowledgeHerbName(herb);
  if (!canonical || !isKnownTcmHerbName(canonical)) return [];
  const categories = getTcmHerbFunctionCategories(canonical);
  if (categories.length === 0) return [];
  // 必须锚在**最具体**的那一档功效分类上，而不是数组第一项——分类表的顺序并不保证由specific到broad
  // （三七是 ["化瘀止血药","止血药"] 具体在前，半夏却是 ["化痰止咳平喘药","温化寒痰药"] 宽泛在前）。
  // 按第一项取会出临床错误：半夏（温化寒痰）落到宽泛的「化痰止咳平喘药」，就会把清化热痰的前胡
  // 当成同向替代——寒热方向正好相反。用类目规模作为具体度的确定性代理：成员越少越具体。
  const anchorCategory = [...categories].sort((left, right) => {
    const sizeGap = (herbsByFunctionCategory.get(left)?.length ?? Number.MAX_SAFE_INTEGER)
      - (herbsByFunctionCategory.get(right)?.length ?? Number.MAX_SAFE_INTEGER);
    return sizeGap !== 0 ? sizeGap : left.localeCompare(right);
  })[0];
  const sourceCategories = new Set(categories);
  const inPrescription = new Set(prescriptionHerbs.map(canonicalKnowledgeHerbName).filter(Boolean));
  // 十八反十九畏的比对基准是「现方 + 被替换药」的全集：替代药与其中任何一味冲突都不能给。
  const compatibilityBase = [...inPrescription, canonical];
  const baseConflicts = findTcmHerbPairIncompatibilities(compatibilityBase).length;
  const sourceFunctionText = getTcmHerbFunctionText(canonical);
  const sourceSafety = getTcmHerbGenerationSafetyProfile(canonical);
  const sourceRiskCodes = governedRiskCodes(canonical);

  const ranked = (herbsByFunctionCategory.get(anchorCategory) || [])
    .filter((candidate) => candidate !== canonical)
    .filter((candidate) => !inPrescription.has(candidate))
    .filter((candidate) => isKnownTcmHerbName(candidate))
    // 「由医师确定用量」「管制毒性」「法律禁用」三类一律出局：系统没有资格把它们作为替代给出。
    .filter((candidate) => !clinicianDoseHerbClass(candidate))
    .filter((candidate) => {
      const doseLimit = getTcmHerbDoseLimit(candidate);
      return Boolean(doseLimit) && !doseLimit?.sourceConflict;
    })
    .filter((candidate) =>
      findTcmHerbPairIncompatibilities([...compatibilityBase, candidate]).length <= baseConflicts)
    // 风险不得升级（这条守卫是本函数的临床安全核心，删它等于让系统凭"同类"就换药）。
    //
    // 「同一功效分类」只保证方向大致相同，**不保证力度与禁忌相同**。实测反例：川芎与三棱同属
    // 活血化瘀药 + 活血止痛药两个分类，但受治理风险档写得清清楚楚——
    //   川芎 BLOOD_STASIS 活血化瘀，孕期 MEDIUM；
    //   三棱 BLOOD_BREAKING 破血逐瘀 + SPECIAL_POPULATION_HIGH_RISK，孕期 HIGH。
    // 拿三棱去"替代"川芎是把破血之力与妊娠高风险凭空引入本例。
    //
    // 判据用的是已入库的风险码与特殊人群档位，不是新知识：
    //  · 替代药不得引入原药没有的风险码；
    //  · 同一人群的风险档位不得高于原药；
    //  · 原药无毒而替代药有毒，一律出局。
    // 反向（替代药风险更低）允许——那是风险下降。
    .filter((candidate) => {
      const safety = getTcmHerbGenerationSafetyProfile(candidate);
      if (safety.isToxic && !sourceSafety.isToxic) return false;
      if (safety.toxicity.length > 0 && sourceSafety.toxicity.length === 0) return false;
      const candidateCodes = governedRiskCodes(candidate);
      for (const code of candidateCodes) {
        if (!sourceRiskCodes.has(code)) return false;
      }
      for (const rule of safety.populationRules) {
        const sourceRule = sourceSafety.populationRules.find((entry) => entry.population === rule.population);
        const sourceRank = sourceRule ? SAFETY_SEVERITY_RANK[sourceRule.severity] : 0;
        if (SAFETY_SEVERITY_RANK[rule.severity] > sourceRank) return false;
      }
      return true;
    })
    .sort((left, right) => {
      // 共享功效分类越多越接近；同分时按名称稳定排序，保证同一病例两次请求结果一致。
      const shared = (name: string) =>
        getTcmHerbFunctionCategories(name).filter((category) => sourceCategories.has(category)).length;
      const gap = shared(right) - shared(left);
      return gap !== 0 ? gap : left.localeCompare(right);
    })
    .slice(0, Math.max(0, limit));

  // 输出契约把 substitutions 定为 rationale/differenceNote 各 ≤400 字且整条 .catch(undefined)——
  // 超一个字，**整条 substitutions 数组会被静默丢弃**，表现成「功能又没了」而不是报错。
  // 功效条目是多来源拼接串，长度不可控，因此在这里就把两段各自截断到预算内。
  const NOTE_LIMIT = 400;
  const CLOSING = "系统不裁定二者等效，替换前须由医师按本例证候核定，并对调整后的完整处方重新审方。";
  const clip = (text: string, budget: number) =>
    text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1))}…`;

  return ranked.map((candidate) => {
    const candidateFunctionText = getTcmHerbFunctionText(candidate);
    // 两段功效平分「总预算 − 结语 − 分隔符与标签」，谁短谁不占满，余量让给另一段。
    const overhead = CLOSING.length + `${canonical}功效：`.length + `${candidate}功效：`.length + 2;
    const share = Math.max(20, Math.floor((NOTE_LIMIT - overhead) / 2));
    const sourceBudget = candidateFunctionText.length < share
      ? share + (share - candidateFunctionText.length)
      : share;
    const candidateBudget = NOTE_LIMIT - overhead - Math.min(sourceFunctionText.length, sourceBudget);
    return {
      replaces: canonical,
      substitute: candidate,
      rationale: clip(
        `与${canonical}同属「${anchorCategory}」，可在${canonical}缺货、患者不耐受或属特殊人群禁用时作同向替代候选。`,
        NOTE_LIMIT,
      ),
      differenceNote: [
        sourceFunctionText
          ? `${canonical}功效：${clip(sourceFunctionText, sourceBudget)}`
          : `${canonical}在知识库中无功效条目`,
        candidateFunctionText
          ? `${candidate}功效：${clip(candidateFunctionText, Math.max(20, candidateBudget))}`
          : `${candidate}在知识库中无功效条目`,
        CLOSING,
      ].join("；"),
    };
  });
}

/**
 * Return the server-owned text shown in the prescription's "配伍意义" column. A small subset of
 * catalogued herbs has a governed name and dose boundary but no concise function sentence in the
 * local source files. That documentation gap is not a medication-safety failure: use the already
 * signed pathogenesis target and controlled 君臣佐使 role to describe its place in this candidate,
 * without inventing a pharmacological claim.
 */
/**
 * 方义里的药味说明：**该药在本方发挥的作用**，不是它的全部功效表(2026-08-05)。
 *
 * 甲方 7.1：「方义分析是分析该药在方中所发挥作用，无需罗列所有功效，且生姜分析错误」。
 * 线上实测（参苓白术散）：
 *   人参（君）：大补元气，复脉固脱      ← 复脉固脱与本方毫无关系
 *   桔梗（佐）：祛痰排脓，清利头目      ← 本方桔梗是载药上行、培土生金，写反了
 *   白扁豆（臣）：协同君药、加强主治方向 ← 纯套话
 * 追下去有两个原因，都在数据侧：
 *  1) 知识库功效串里**混着药类分类标签**（「补气药；补虚药」「发散风寒药；解表药」），
 *     它们是分类学不是方义，直接印出来就是噪声；
 *  2) 白扁豆、薏苡仁、麻黄这些药在库里**只有分类标签、没有功效条目**，于是全部落到
 *     那句「协同君药、加强主治方向」的通用兜底上。
 *
 * 三条处理，都不新增知识：
 *  · 剥掉「…药」结尾的分类标签，它们从来不是方义；
 *  · 按本方治法与该药所绑定的病机节点**筛选**功效条目，只留下与本方目标相关的；
 *  · 一条都不相关（或库里本就没有功效）时，不写通用套话，改写成绑定该药实际病机节点的
 *    一句话——说不出该药在本方做什么时，至少说清它挂在哪条病机上，交医生判断。
 */
/**
 * @param rolePlaceholderWhenUnaligned 对不上本方治法时是否回落角色兜底句。
 *
 * **契约校验之前必须传 false。** 兜底句是服务端造的、内容为零的一句话
 * （「臣药，本方中的具体配伍作用需医生结合方义复核」），而 diagnosis-stage-contract 的
 * herbFunctionMatchesKnowledge 又显式放行这句 —— 于是它一旦在校验前写进 herb.function，
 * `candidate_*_herb_*_function(_ungrounded)` 就永远不会触发，
 * structured-clinical-repair 里那段「把本方配伍作用写清楚」的修复指导语成了**打不到的死代码**
 * （甲方 2026-08-10 ⑤ 黄芪：模型没写方义时，医生看到的就是这句套话，而修复轮从未被唤起）。
 * 兜底句只应该在**修复机会用尽之后**的 finalize 补写，保证输出不空白。
 */
export function getTcmHerbFunctionDisplayText(
  herb: string,
  role = "",
  target = "",
  therapy = "",
  rolePlaceholderWhenUnaligned = true,
): string {
  const raw = getTcmHerbFunctionText(herb).trim();
  const clauses = raw
    .split(/[；;，,、]/)
    .map((item) => item.trim())
    .filter(Boolean)
    // 药类分类标签（补气药/解表药/利水渗湿药…）不是方义。
    .filter((item) => !/药$/.test(item));
  // 给药途径/调剂语义(冲服、研末、另煎、烊化、外用、不入汤剂…)**永不参与筛选**:
  // 它们不是方义而是安全信息,滤掉会让「朱砂不可入汤剂」这类边界从出参里消失。
  // 实测:收紧筛选后 test:stage-contract 的 route_not_decoction 判据当场失守,
  // 说明这条通路确实承载着安全语义,不能按「与治法是否相关」来取舍。
  const ROUTE_SEMANTICS = /(?:冲服|调服|研粉|研末|吞服|丸散|另煎|烊化|包煎|先煎|后下|外用|不入汤剂|禁止同煎|入丸散)/;
  const routeClauses = clauses.filter((item) => ROUTE_SEMANTICS.test(item));
  const alignmentText = `${therapy}${target}`.replace(/\s+/g, "");
  const aligned = alignmentText
    ? clauses.filter((item) => {
      // 逐字相关即可：功效条目里任意 2 字连续出现在本方治法或该药绑定的病机节点里。
      for (let index = 0; index + 2 <= item.length; index += 1) {
        if (alignmentText.includes(item.slice(index, index + 2))) return true;
      }
      return false;
    })
    : [];
  // 分档（甲方 7.1「方义分析是分析该药在方中所发挥作用，无需罗列所有功效」）：
  //   有对得上本方治法的条目 → 只留对得上的；
  //   库里有条目但**没有一条对得上** → 走角色兜底句，**不得照印全部功效**；
  //   库里本就没有条目 → 同样走角色兜底句。
  //
  // 中间那一档是甲方 7.1 的原始缺陷点：参苓白术散里的桔梗被印成「祛痰排脓，清利头目」——
  // 那是桔梗的通用功效，本方用它是载药上行、培土生金，照印等于把方义写反。
  //
  // 曾有一版改动把中间档改为「留原条目」，理由是怕角色兜底句被判 function_ungrounded
  // 拖垮整个候选。该顾虑已由 diagnosis-stage-contract.ts:3190 的专门放行正则覆盖
  //（并由 test:customer-review 的 7.1 条目与本文件对应断言双向钉住），
  // 不需要靠牺牲 7.1 来换安全边际。改这一行前先看那两处。
  const chosen = [...new Set([
    ...routeClauses,
    ...(aligned.length > 0 ? aligned : (alignmentText ? [] : clauses)),
  ])];
  if (chosen.length > 0) return chosen.slice(0, 3).join("，");
  if (!rolePlaceholderWhenUnaligned) return "";
  // 兜底句**不得嵌入病机原文**:病机在药味表里另有独立一列,嵌进来会让同一句病机
  // 在一节里被印 7 遍(实测触发 test:visible-output-hygiene 的重复病机判据),
  // 而这恰恰是甲方 1.1.1 抱怨的同一类冗余。角色 + 需复核声明已足够表达不确定性。
  void target;
  const controlledRole = /^(?:君|臣|佐|使)$/.test(role.trim()) ? role.trim() : "配伍";
  return `${controlledRole}药，本方中的具体配伍作用需医生结合方义复核`;
}

export function getTcmHerbRiskProfile(herb: string): string {
  const canonical = canonicalKnowledgeHerbName(herb);
  const herbData = data.herbs.find((item) => item.name === canonical || item.aliases.includes(canonical));
  return (herbData?.entries || [])
    .flatMap((entry) => [entry.riskCode, entry.riskName, entry.primaryCategory, entry.secondaryCategory, entry.toxicity])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("；");
}

export type TcmHerbGenerationSafetyRule = {
  population: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  rule: string;
  action: string;
  basis: string;
};

export type TcmHerbGenerationSafetyProfile = {
  herb: string;
  isToxic: boolean;
  toxicity: string[];
  populationRules: TcmHerbGenerationSafetyRule[];
};

const SAFETY_SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

function normalizedSafetySeverity(value: unknown): TcmHerbGenerationSafetyRule["severity"] {
  const text = String(value || "").toUpperCase();
  if (text === "HIGH" || /禁用|忌用|高风险|阻断/.test(text)) return "HIGH";
  if (text === "MEDIUM" || /慎用|复核|监测/.test(text)) return "MEDIUM";
  return "LOW";
}

/**
 * Structured pre-generation safety facts. M04 consumes this before proposing herbs and again
 * before signing the compiled candidate; M05/RxAudit remain an independent post-prescription net.
 */
export function getTcmHerbGenerationSafetyProfile(herb: string): TcmHerbGenerationSafetyProfile {
  const canonical = canonicalKnowledgeHerbName(herb);
  const herbData = data.herbs.find((item) => item.name === canonical || item.aliases.includes(canonical));
  const entries = herbData?.entries || [];
  const toxicity = [...new Set(entries
    .map((entry) => String(entry.toxicity || "").trim())
    .filter((value) => value && !/^(?:无|无毒|未标注|未见毒性)$/.test(value)))];
  const populationRules = new Map<string, TcmHerbGenerationSafetyRule>();
  const addRule = (rule: TcmHerbGenerationSafetyRule) => {
    const existing = populationRules.get(rule.population);
    if (!existing || SAFETY_SEVERITY_RANK[rule.severity] > SAFETY_SEVERITY_RANK[existing.severity]) {
      populationRules.set(rule.population, rule);
    }
  };
  for (const entry of entries) {
    if (entry.type === "specialPopulation" && entry.population) {
      addRule({
        population: entry.population,
        severity: normalizedSafetySeverity(entry.severity || entry.riskLevel),
        rule: entry.quote || entry.riskLevel || entry.ruleType || "需医生/药师复核",
        action: entry.action || "医生/药师复核",
        basis: entry.basis || "药典/院内规则",
      });
    }
    if (entry.type === "herbRisk") {
      if (entry.pregnancyRule && !/^(?:非孕期核心规则|一般不因类别禁用)/.test(entry.pregnancyRule)) {
        addRule({
          population: "孕期/妊娠",
          severity: normalizedSafetySeverity(entry.pregnancySeverity || entry.pregnancyRule),
          rule: entry.pregnancyRule,
          action: normalizedSafetySeverity(entry.pregnancySeverity || entry.pregnancyRule) === "HIGH"
            ? "生成期不得形成剂量候选"
            : "医生/药师复核",
          basis: entry.basis || "中药风险知识库",
        });
      }
      if (entry.lactationRule && !/^(?:非哺乳期核心规则|一般不因类别禁用)/.test(entry.lactationRule)) {
        addRule({
          population: "哺乳期",
          severity: normalizedSafetySeverity(entry.lactationSeverity || entry.lactationRule),
          rule: entry.lactationRule,
          action: normalizedSafetySeverity(entry.lactationSeverity || entry.lactationRule) === "HIGH"
            ? "生成期不得形成剂量候选"
            : "医生/药师复核",
          basis: entry.basis || "中药风险知识库",
        });
      }
    }
  }
  return {
    herb: herbData?.name || canonical,
    isToxic: toxicity.length > 0,
    toxicity,
    populationRules: [...populationRules.values()]
      .sort((left, right) =>
        SAFETY_SEVERITY_RANK[right.severity] - SAFETY_SEVERITY_RANK[left.severity] ||
        left.population.localeCompare(right.population)),
  };
}

export function tcmHerbGenerationSafetyBoundaryText(herb: string): string {
  const profile = getTcmHerbGenerationSafetyProfile(herb);
  const parts = [
    profile.isToxic ? `毒性=${profile.toxicity.join("、")}` : "毒性=未标注毒性",
    ...profile.populationRules.map((rule) =>
      `${rule.population}=${rule.severity}/${rule.rule}`),
  ];
  return parts.join("；");
}

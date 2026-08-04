#!/usr/bin/env node
/**
 * 受治理方剂「无证候标注」缺口的确定性证候候选生成器。
 *
 * 背景：src/data/tcm-formula-governed-catalog.json 里有一批方剂 syndromeTags 与
 * curatedSyndromeTags 双空。运行时 src/lib/tcm-formula-indications.ts 的
 * `lockEligible = entry.syndromeTags.length > 0` 会让它们永远无法通过身份锁，
 * 在召回排序里被永久沉底——证据分再高也进不了处方候选（实测保和丸证据分全池最高
 * 47.9，仍排 264/274）。
 *
 * 本脚本**不写目录**。它只做一件事：用确定性规则，从**受治理来源文本**里为这些方剂
 * 提出证候候选并逐条附上命中片段，供人工裁定后写入
 * src/data/tcm-formula-syndrome-tag-adjudications.source.json（唯一的裁定权威），
 * 再由 scripts/build-tcm-governance-tables.py 重新生成目录。
 *
 * 三条确定性通道（全部可复跑、可逐条复查）：
 *   P1 governed_indication_literal —— 受控证候词表的 canonical/alias 在**主治原文**中
 *      字面出现。注意目录构建期已用同一词表扫过 name+aliases+indications，所以 P1 的
 *      增量只来自**目录取舍时被优先级挤掉的受治理主治**（深圳标准 szjg 的 indications
 *      在 verified 层有值时会被丢弃）。
 *   P2 pathogenesis_phrase_rule —— 人工整理的「病机短语 → 受控证候」规则表。古籍主治
 *      写的是「食积停滞」「肝乘脾土」「内有干血」，不是 GB/T 16751.2 的规范证候名，
 *      P1 扫不到；这张表把这层映射固化成可复查的规则。
 *   P3 dual_axis_agreement —— 目录已派生的 natureTags/locationTags 与证候条目的
 *      natures/locations 双轴同时相交且唯一命中。词表自述病位病性只是「项目规则派生
 *      候选」，所以本通道产出一律标 low 置信，仅供人工参考。
 *
 * 两道确定性阻断（命中即 blocked，不进入采纳建议）：
 *   · 纯外用方（外敷/点眼/吹喉/洗/贴/掺…）：给外用膏散打证候标签会让它们被当作内服
 *     方召回，属于**给药途径**治理缺口，不能用证候标签兜。
 *   · 主治自述不辨证（「不问」「无问」「不拘」「不论虚实」「悉主之」…）：原文明确拒绝
 *     辨证归属，任何标签都是臆造。
 *
 * 用法：
 *   node scripts/build-formula-syndrome-tag-candidates.mjs            # 生成候选清单
 *   node scripts/build-formula-syndrome-tag-candidates.mjs --verify   # 校验已裁定批次仍可复现
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_ROOT = resolve(PROJECT_ROOT, "src/data");
const CATALOG = resolve(DATA_ROOT, "tcm-formula-governed-catalog.json");
const SYNDROME_LEXICON = resolve(DATA_ROOT, "tcm-syndrome-lexicon.json");
const SZJG_STANDARD = resolve(DATA_ROOT, "szjg-tcm-formula-standard.json");
const ADJUDICATIONS = resolve(DATA_ROOT, "tcm-formula-syndrome-tag-adjudications.source.json");
const OUT_JSON = resolve(PROJECT_ROOT, "artifacts/formula-syndrome-tag-candidates.json");
const OUT_MD = resolve(PROJECT_ROOT, "artifacts/formula-syndrome-tag-candidates.md");

/** 本脚本负责复现校验的裁定批次。 */
const VERIFIED_BATCH = "ADJ-20260804-SYNDROME-TAG-B6";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** 与 scripts/build-tcm-governance-tables.py 的 compact() 同口径。 */
const compact = (value) => String(value ?? "").split(/\s+/).join("").trim();

/** 与构建期 syndrome_token() 同口径：去标点、剥「证/证候/型」后缀。 */
const syndromeToken = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s，,。；;：:、（）()【】[\]“”'"]+/g, "")
    .trim()
    .replace(/(?:证候|证|型)$/u, "");

/**
 * 与构建期 resolve_syndrome_id() 同口径：canonical 优先，alias 必须唯一。
 * 两侧口径必须一致，否则本脚本提名的标签会在构建期被
 * 「name/id disagree」拒收——那正是这个校验存在的意义。
 */
function buildResolver() {
  const payload = readJson(SYNDROME_LEXICON);
  const entries = [...(payload.entries ?? []), ...(payload.clinicalExtensions ?? [])];
  const canonicalByToken = new Map();
  const aliasCandidatesByToken = new Map();
  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id) continue;
    byId.set(entry.id, entry);
    const canonicalToken = syndromeToken(entry.canonical);
    if (canonicalToken && !canonicalByToken.has(canonicalToken)) canonicalByToken.set(canonicalToken, entry);
    for (const alias of entry.aliases ?? []) {
      const token = syndromeToken(alias);
      if (!token) continue;
      const bucket = aliasCandidatesByToken.get(token) ?? [];
      if (!bucket.some((candidate) => candidate.id === entry.id)) bucket.push(entry);
      aliasCandidatesByToken.set(token, bucket);
    }
  }
  const resolve_ = (value) => {
    const token = syndromeToken(value);
    const canonical = canonicalByToken.get(token);
    if (canonical) return canonical.id;
    const candidates = aliasCandidatesByToken.get(token) ?? [];
    return candidates.length === 1 ? candidates[0].id : null;
  };
  return { entries, byId, resolve: resolve_ };
}

/**
 * P2 规则表：病机短语 → 受控证候。
 *
 * 每条规则的铁律：
 *   · `phrases` 必须是**病机/证候**表述，不是治法、不是病名、不是症状罗列。
 *   · `field` 默认 "indication"（受治理主治原文）。取 "functions" 的规则只允许用于
 *     「治法与证候一一对应」的教科书级映射，且必须配 `requires` 让主治一同佐证——
 *     深圳标准的 functions 字段实测存在错行（厚朴麻黄汤 functions 写着「胃气虚寒之
 *     呃逆」），单靠它定标签会把错行数据变成临床标签。
 *   · `syndromes` 写人类可读证候名；脚本用与构建期同口径的解析器归一到 id，解析不出
 *     直接报错——模型自造名/词表外名在这里被拦死。
 */
const PATHOGENESIS_RULES = [
  // —— 食积/积滞 ——
  {
    id: "R-FOOD-STAGNATION-EPIGASTRIUM",
    phrases: ["食积停滞", "中脘有宿食", "宿食留饮", "嗳腐吞酸"],
    syndromes: ["食滞胃脘"],
    note: "主治原文直述食积停于中脘/嗳腐吞酸，病位在胃脘，病性为食滞。",
  },
  {
    id: "R-SPLEEN-DEFICIENCY-FOOD-STAGNATION",
    phrases: ["健脾消积"],
    field: "functions",
    requires: ["食积"],
    syndromes: ["脾虚食积"],
    note: "官方地方标准功效同时给出「健脾」（脾虚）与「消积」（食积），且主治确有食积。",
  },
  // —— 血瘀/干血 ——
  {
    id: "R-DRY-BLOOD",
    phrases: ["内有干血"],
    syndromes: ["干血内结"],
    note: "《金匮》原文「内有干血」即干血内结，肌肤甲错、两目黯黑为其外候。",
  },
  {
    id: "R-BLOOD-STASIS-RETAINED",
    phrases: ["恶血留于", "蓄血"],
    syndromes: ["瘀血阻滞"],
    note: "主治原文直述恶血留着/蓄血，即瘀血阻滞。",
  },
  {
    id: "R-QI-STAGNATION-BLOOD-STASIS",
    phrases: ["活血祛瘀"],
    field: "functions",
    requires: ["行气止痛"],
    syndromes: ["气滞血瘀"],
    note: "官方地方标准功效同时给出活血祛瘀与行气止痛，两轴俱备即气滞血瘀。",
  },
  // —— 肝脾 ——
  {
    id: "R-LIVER-SPLEEN-DISHARMONY",
    phrases: ["肝乘脾土", "犯胃克脾", "肝木气盛"],
    syndromes: ["肝脾不调"],
    note: "主治原文直述肝木乘脾/犯胃克脾，即肝脾不调。",
  },
  // —— 疮疡热毒（限内服）——
  {
    id: "R-HEAT-TOXIN-YANG-SORE",
    phrases: ["属于阳证者"],
    requires: ["疮疡"],
    syndromes: ["热毒壅结"],
    note: "疮疡明属阳证者，其病机为热毒壅结；阴证疮疡不适用，故以「属于阳证者」为唯一入口。",
  },
  {
    id: "R-HEAT-TOXIN-DISPERSE",
    phrases: ["清热解毒"],
    field: "functions",
    requires: ["消肿溃坚"],
    syndromes: ["热毒壅结"],
    note: "清热解毒 + 消肿溃坚是阳证痈疡的标准治法组合，反演为热毒壅结。",
  },
  // —— 湿热/痰浊 ——
  {
    id: "R-SHAOYANG-DAMP-HEAT-PHLEGM",
    phrases: ["少阳湿热痰浊"],
    syndromes: ["湿热", "痰浊"],
    note: "官方地方标准主治直书「少阳湿热痰浊证」，湿热与痰浊两轴均为原文所载。",
  },
  {
    id: "R-DAMP-WARM",
    phrases: ["湿温久羁"],
    syndromes: ["湿热"],
    note: "《温病条辨》原文「湿温久羁，三焦弥漫」，湿热为其本。",
  },
  {
    id: "R-BLADDER-DAMP-HEAT",
    phrases: ["火灼膀胱"],
    syndromes: ["膀胱湿热"],
    note: "主治原文直述火灼膀胱、砂淋溺痛，病位膀胱、病性湿热。",
  },
  {
    id: "R-YIN-DEFICIENCY-DAMP-HEAT",
    phrases: ["滋阴养血"],
    field: "functions",
    requires: ["除湿"],
    syndromes: ["阴虚湿热"],
    note: "滋阴与除湿并用，是阴虚与湿邪并存的标准治法反演。",
  },
  // —— 痰 ——
  {
    id: "R-PHLEGM-FLUID-RETENTION",
    phrases: ["涎结为饮"],
    syndromes: ["痰饮"],
    note: "原文「郁而生涎，涎结为饮」，痰饮内停为其病机。",
  },
  {
    id: "R-PHLEGM-DAMP-OBESITY",
    phrases: ["子宫脂满"],
    requires: ["肥盛"],
    syndromes: ["痰湿"],
    note: "原文「妇人肥盛不孕者，以子宫脂满壅塞」，形盛脂满即痰湿。",
  },
  {
    id: "R-WIND-PHLEGM-COLLATERAL",
    phrases: ["祛风化痰"],
    field: "functions",
    requires: ["口眼"],
    syndromes: ["风痰阻络"],
    note: "口眼㖞斜而治以祛风化痰通络，即风痰阻于经络。",
  },
  {
    id: "R-PHLEGM-QI-BINDING",
    phrases: ["化痰软坚"],
    field: "functions",
    requires: ["瘿瘤"],
    syndromes: ["痰气互结"],
    note: "瘿瘤而治以化痰软坚、理气散结，即痰气互结。",
  },
  // —— 虫积 ——
  {
    id: "R-PARASITE",
    phrases: ["蛔厥", "寸白虫", "蛔虫动作", "虫啮腹痛"],
    syndromes: ["虫积"],
    note: "主治原文直述蛔厥/寸白虫/虫啮腹痛，即虫积。",
  },
  // —— 痹 ——
  {
    id: "R-COLD-DAMP-BI",
    phrases: ["寒痹留经"],
    syndromes: ["寒湿痹阻"],
    note: "原文「寒痹留经，时痛而痹不仁」，寒湿痹阻经脉。",
  },
  {
    id: "R-WIND-COLD-DAMP-BI",
    phrases: ["着痹"],
    syndromes: ["风寒湿痹阻"],
    note: "着痹为风寒湿三气杂至而湿邪偏胜之痹，官方地方标准功效亦作「祛风散寒、除湿通络」。",
  },
  // —— 虚证 ——
  {
    id: "R-KIDNEY-DEFICIENCY-MISCARRIAGE",
    phrases: ["肾虚滑胎"],
    syndromes: ["肾虚"],
    note: "官方地方标准主治直书肾虚滑胎。",
  },
  {
    id: "R-LIVER-KIDNEY-DEPLETION",
    phrases: ["滋补肝肾"],
    field: "functions",
    syndromes: ["肝肾亏虚"],
    note: "官方地方标准功效为滋补肝肾，其对治证即肝肾亏虚。",
  },
  {
    id: "R-LIVER-KIDNEY-YIN-DEFICIENCY",
    phrases: ["滋阴补肾"],
    field: "functions",
    requires: ["清肝"],
    syndromes: ["肝肾阴虚"],
    note: "滋阴补肾 + 清肝，阴虚一轴由「滋阴」明示，肝肾两脏由「补肾」「清肝」明示。",
  },
  {
    id: "R-KIDNEY-ESSENCE-DEPLETION",
    phrases: ["补肾益精"],
    field: "functions",
    syndromes: ["肾虚"],
    note: "官方标准功效为补肾益精，其对治证即肾虚。",
  },
  {
    id: "R-QI-BLOOD-DEPLETION-STATED",
    phrases: ["内虚不足", "诸虚百损"],
    syndromes: ["气血亏虚"],
    note: "主治原文直述内虚不足/诸虚百损，为气血两亏之总括。",
  },
  {
    id: "R-QI-BLOOD-DEPLETION",
    phrases: ["益气补血", "益气养血", "补气养血"],
    field: "functions",
    syndromes: ["气血亏虚"],
    note: "官方地方标准功效为益气养血（补气 + 补血），其对治证即气血亏虚。",
  },
  {
    id: "R-CHONGREN-INSECURITY",
    phrases: ["固冲止血"],
    field: "functions",
    syndromes: ["冲任不固"],
    note: "功效为固冲止血，对治冲任不固之崩漏经多。",
  },
  {
    id: "R-QI-COLLAPSE-WITH-BLOOD",
    phrases: ["虚脱"],
    requires: ["所下过多"],
    syndromes: ["气随血脱"],
    note: "原文「所下过多伤损，虚竭少气……虚脱证」，血脱而气随之脱。",
  },
  {
    id: "R-KIDNEY-FAILS-TO-GRASP-QI",
    phrases: ["补气纳肾"],
    requires: ["喘"],
    syndromes: ["肾不纳气"],
    note: "喘急不能卧而治以补肺气、纳肾气，即肾不纳气。",
  },
  // —— 表证/卫气 ——
  {
    id: "R-YINGWEI-DISHARMONY",
    // 早期版本把「调和营卫」也收进来，实测 9 命中里 7 条是误报：甘草大枣「调和营卫」
    // 是方义里描述**药对作用**的治法句（排脓汤、治肺痿肺痈及肠痈方、营卫保和丸一…），
    // 与该方对治何证无关。只保留原文直述卫气失常的两处表述。
    phrases: ["卫气独行于阳", "太阳表郁"],
    syndromes: ["营卫不和"],
    note: "原文直述卫气不入于阴 / 太阳表郁，即营卫不和。",
  },
  {
    id: "R-LUNG-WEI",
    phrases: ["清宣肺卫"],
    field: "functions",
    syndromes: ["邪在肺卫"],
    note: "官方地方标准功效书「辛凉透表、清宣肺卫」，其对治证即邪在肺卫。",
  },
  {
    id: "R-WIND-HEAT-EXTERIOR",
    phrases: ["疏风清热"],
    field: "functions",
    requires: ["喉症"],
    syndromes: ["风热犯表"],
    note: "喉症初起而治以疏风清热，即风热犯表。",
  },
  // —— 六经 ——
  {
    id: "R-SHAOYANG-PATTERN",
    phrases: ["少阳证"],
    requires: ["和解少阳"],
    syndromes: ["邪入少阳"],
    note:
      "主治直书少阳证、功效直书和解少阳，双锚一致。GB/T 16751.2 少阳证类下并列 8.3.1 邪入少阳 / " +
      "8.3.2 邪在少阳 / 8.3.3 邪郁少阳 三个近义证，运行时三者互不等价；取 8.3.1 头位术语，" +
      "与裁定表既有先例（柴胡枳桔汤→邪入少阳）保持一致。",
  },
  {
    id: "R-HEAT-IN-BLOOD-CHAMBER",
    phrases: ["热入血室"],
    syndromes: ["热结血室"],
    note:
      "「热入血室」是《伤寒论》原名，GB/T 16751.2 收录为「热结血室证」（别名热入胞宫）——" +
      "同一证的命名体系差异，不是临床推断。",
  },
  // —— 火热 ——
  {
    id: "R-TRIPLE-BURNER-FIRE",
    phrases: ["三焦有火", "三焦气火"],
    syndromes: ["火热"],
    note: "主治原文直述三焦有火/气火内热。",
  },
  {
    id: "R-LUNG-HEAT",
    phrases: ["清肺热"],
    field: "functions",
    syndromes: ["肺热"],
    note: "官方地方标准功效直书清肺热。",
  },
  {
    id: "R-BLOOD-HEAT-WIND-DRYNESS",
    phrases: ["凉血清热"],
    field: "functions",
    requires: ["消风"],
    syndromes: ["血热风燥"],
    note: "凉血清热 + 养血消风，是血热生风化燥的标准治法反演。",
  },
  {
    id: "R-BLOOD-DEFICIENCY-LIVER-FIRE",
    phrases: ["血虚火旺"],
    requires: ["清肝"],
    syndromes: ["血虚", "肝火"],
    note: "官方地方标准主治直书血虚火旺，功效书「养血清肝」，火旺之火定位在肝。",
  },
  // —— 气滞/寒凝 ——
  {
    id: "R-QI-STAGNATION-DYSPHAGIA",
    phrases: ["气噎膈"],
    syndromes: ["气滞"],
    note: "原文「气噎膈，有物噎塞」，气机壅滞于食道。",
  },
  {
    id: "R-COLD-CONGEAL-SKIN",
    phrases: ["寒客皮肤"],
    syndromes: ["寒邪凝滞"],
    note: "原文「寒客皮肤……病名肤胀」，寒邪凝滞肌表。",
  },
  {
    id: "R-COLD-STAGNATION-LIVER-CHANNEL",
    phrases: ["寒疝"],
    syndromes: ["寒滞肝脉"],
    note: "寒疝攻心急痛，其病位在肝经、病性属寒凝。",
  },
  // —— 外伤瘀血 ——
  {
    id: "R-TRAUMATIC-BLOOD-STASIS",
    phrases: ["跌打损伤", "跌打断骨", "骨折", "伤筋", "恶血留于", "损伤破皮"],
    requires: ["活血", "祛瘀", "化瘀", "散瘀", "消瘀", "接骨", "和血"],
    syndromes: ["瘀血阻滞"],
    note: "跌打骨折伤筋为有形外力致络破血溢，受治理功效同书活血化瘀，两侧一致指向瘀血阻滞。",
  },
  // —— 水湿 ——
  {
    id: "R-WATER-RETENTION",
    phrases: ["治水肿", "面肿"],
    requires: ["利水消肿"],
    syndromes: ["水湿内停"],
    note: "主治为水肿/面肿而治以利水消肿，即水湿内停。",
  },
  // —— 暑 ——
  {
    id: "R-SUMMERHEAT",
    phrases: ["夏时中暑"],
    requires: ["热伤元气"],
    syndromes: ["暑热"],
    note: "原文「夏时中暑，热伤元气，内外俱热，烦渴欲饮」，暑热内燔为其本。",
  },
  // —— 痢 ——
  {
    id: "R-LARGE-INTESTINE-DAMP-HEAT",
    phrases: ["血痢"],
    syndromes: ["大肠湿热"],
    note: "下痢脓血（血痢/赤痢）之病位在大肠、病性属湿热，受治理功效亦同书清热。",
  },
];

/**
 * P1 已知的跨词边界假阳性抑制表。
 *
 * 字面包含匹配不认词边界：「血虚火旺」里含子串「虚火」，但该句的切分是「血虚|火旺」
 * 而非「血|虚火|旺」——虚火与血虚是两个方向不同的证。这类跨边界串扰只能逐条记录，
 * 不能靠长度阈值兜（虚火与血虚等长）。
 */
const P1_CROSS_BOUNDARY_SUPPRESSIONS = [{ term: "虚火", whenTextContains: "血虚火旺" }];

/** 现代扩展应用从句：「现用于…」之后是今人扩展主治，不是原方受治理主治。 */
const MODERN_APPLICATION_CLAUSE = /现用于[^；]*/g;

const EXTERNAL_USE_MARKERS = [
  "外敷", "外用", "外贴", "外涂", "外擦", "外洗", "点眼", "洗眼", "吹喉", "吹之", "塞耳",
  "掺药", "贴敷", "熏洗", "敷之", "涂之", "搽此", "围敷", "膏贴", "灸疮", "点痣",
  // 疮面处理语义：生肌/收口/去腐/长肉都是**创面外治**目标，不是内服方的对治证。
  "生肌", "收口", "腐肉", "去腐", "长肉", "敛疮",
];

/**
 * 人工弃权表：规则产出了候选，但裁定人复核后判定不应打标签。
 *
 * 写进脚本而不是「默默不采纳」，是为了让弃权与采纳一样可复跑、可追责。
 */
const MANUAL_ABSTENTIONS = [
  {
    name: "五加皮汤",
    reason:
      "《医宗金鉴·正骨心法要旨》五加皮汤为煎汤熏洗的外治方（麝香、芒硝、葱白配伍即其熏洗方签名），" +
      "目录无给药途径字段、文本也无外治标记词，规则拦不住。外治方打上瘀血阻滞会让它被当作内服方召回。",
  },
  {
    name: "内经方",
    reason:
      "《成方切用》「内经方」不是一首方，是三条《内经》方的合录（寒痹马膏方 + 足阳明筋病方 + " +
      "半夏秫米汤），主治并列三证、组成也是三方相加。给合录条目打证候标签等于让一个不存在的" +
      "方名进入处方候选；该条目该修的是方名身份，不是标签。",
  },
];
const NO_DIFFERENTIATION_MARKERS = [
  "不问", "无问", "不拘", "不论虚实", "悉主之", "皆可服", "一切风疾", "无所不治",
  "通治", "随症加减", "随证加减", "未详述", "原文未明确", "原文缺失", "主治未明确",
];

const collapse = (values) => values.filter(Boolean).map(compact).join("；");

/** 受治理主治原文：目录 indications + 深圳标准 indications（目录优先级可能把后者挤掉）。 */
function governedIndicationText(entry, standardRow) {
  return collapse([...(entry.indications ?? []), ...(standardRow?.indications ?? [])]);
}

/**
 * 目录构建期没扫过的受治理主治。
 *
 * 构建期 `machine_syndrome_tags = derived_tag_ids(searchable_text, syndrome_terms)`
 * 已经用同一份词表扫过 name + aliases + indications，所以对这批「双空」方剂，
 * 在同一段文本上重跑字面匹配必然是 0。真正的增量只有一处：目录的主治优先级
 * （adjudicated > indications 索引 > verified > standardIndications）在 verified 层
 * 有值时会**整段丢弃**深圳标准的主治。P1 只扫这段被丢掉的文本。
 */
function droppedStandardIndicationText(entry, standardRow) {
  const carried = new Set((entry.indications ?? []).map(compact));
  const kept = (standardRow?.indications ?? []).filter((value) => !carried.has(compact(value)));
  return collapse(kept).replace(MODERN_APPLICATION_CLAUSE, "");
}

/** 官方地方标准功效字段。实测存在错行，故只在规则显式声明 field:"functions" 时使用。 */
function standardFunctionText(standardRow) {
  return collapse(standardRow?.functions ?? []);
}

function excerpt(text, phrase, radius = 18) {
  const index = text.indexOf(phrase);
  if (index < 0) return phrase;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + phrase.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function main() {
  const verifyOnly = process.argv.includes("--verify");
  const { entries: lexiconEntries, byId, resolve: resolveSyndrome } = buildResolver();
  const catalog = readJson(CATALOG);
  const standardRows = new Map(
    (readJson(SZJG_STANDARD).entries ?? [])
      .filter((row) => compact(row?.name))
      .map((row) => [compact(row.name), row]),
  );
  const adjudication = readJson(ADJUDICATIONS);
  const adjudicatedNames = new Set((adjudication.entries ?? []).map((row) => compact(row.name)));

  // 规则表自检：任何解析不出受控 id 的证候名都是词表外名，直接拒绝启动。
  for (const rule of PATHOGENESIS_RULES) {
    for (const name of rule.syndromes) {
      if (!resolveSyndrome(name)) {
        throw new Error(`P2 规则 ${rule.id} 提名了词表外证候：${name}`);
      }
    }
  }

  const untagged = (catalog.entries ?? []).filter(
    (entry) => !(entry.syndromeTags ?? []).length && !(entry.curatedSyndromeTags ?? []).length,
  );
  // 已裁定批次的方剂在目录重生成后已经带上标签、退出「无标注」池。--verify 要复算它们，
  // 所以把该批次的方名单独并回评估集——否则「裁定生效」本身会让复现校验空跑通过。
  const verifiedBatchNames = new Set(
    (adjudication.entries ?? []).filter((row) => row.batch === VERIFIED_BATCH).map((row) => compact(row.name)),
  );
  const untaggedNames = new Set(untagged.map((entry) => compact(entry.name)));
  const evaluated = [
    ...untagged,
    ...(catalog.entries ?? []).filter((entry) => {
      const key = compact(entry.name);
      return verifiedBatchNames.has(key) && !untaggedNames.has(key);
    }),
  ];

  // P1 用的字面词条：canonical + alias，长度 ≥2 —— 与构建期 lexicon_terms() 同口径，
  // 因为 P1 扫的是构建期**根本没读到**的那段主治，不存在重复扫描问题。
  // 排除分类桶（category_heading 与「…证类」标题词）：「外伤证类」的别名「外伤」会把
  // 任何写了外伤的方剂标成一个**分类标题**，那不是可用于辨证召回的证候。
  const literalTerms = lexiconEntries
    .filter((item) => item?.id && item.termClass !== "category_heading" && !/类$/u.test(compact(item.canonical)))
    .map((item) => [
      item.id,
      [item.canonical, ...(item.aliases ?? [])].map(compact).filter((name) => name.length >= 2),
    ])
    .filter(([, names]) => names.length);

  const candidates = [];
  for (const entry of evaluated) {
    const name = compact(entry.name);
    const standardRow = standardRows.get(name);
    const indicationText = governedIndicationText(entry, standardRow);
    const droppedIndicationText = droppedStandardIndicationText(entry, standardRow);
    const functionText = standardFunctionText(standardRow);
    const searchText = collapse([indicationText, functionText]);
    if (!indicationText && !functionText) continue;

    const blockedReasons = [];
    const externalHit = EXTERNAL_USE_MARKERS.find((marker) => searchText.includes(marker));
    if (externalHit) blockedReasons.push(`external_use_only:${externalHit}`);
    const noDiffHit = NO_DIFFERENTIATION_MARKERS.find((marker) => indicationText.includes(marker));
    if (noDiffHit) blockedReasons.push(`source_declines_differentiation:${noDiffHit}`);
    const abstention = MANUAL_ABSTENTIONS.find((item) => compact(item.name) === name);
    if (abstention) blockedReasons.push(`manual_abstention:${abstention.reason}`);

    const hits = new Map();
    const addHit = (syndromeId, pass, confidence, evidence, ruleId, note) => {
      if (!syndromeId) return;
      const existing = hits.get(syndromeId);
      if (existing) {
        existing.evidence.push(evidence);
        return;
      }
      hits.set(syndromeId, {
        syndromeId,
        syndromeName: byId.get(syndromeId)?.canonical ?? "",
        pass,
        confidence,
        ruleId,
        note,
        evidence: [evidence],
      });
    };

    // P1：被目录优先级丢弃的受治理主治中的证候名字面命中。
    for (const [syndromeId, names] of literalTerms) {
      const matched = names.find(
        (term) =>
          droppedIndicationText.includes(term) &&
          !P1_CROSS_BOUNDARY_SUPPRESSIONS.some(
            (rule) => rule.term === term && droppedIndicationText.includes(rule.whenTextContains),
          ),
      );
      if (matched) {
        addHit(
          syndromeId,
          "governed_indication_literal",
          "high",
          `官方地方标准主治（目录优先级已丢弃）命中受控证候名「${matched}」：${excerpt(droppedIndicationText, matched)}`,
          "P1",
          "受控证候词表 canonical/alias 在构建期未读取的受治理主治原文中字面出现。",
        );
      }
    }

    // P2：病机短语规则表。
    for (const rule of PATHOGENESIS_RULES) {
      const field = rule.field ?? "indication";
      const haystack = field === "functions" ? functionText : indicationText;
      if (!haystack) continue;
      const matched = rule.phrases.find((phrase) => haystack.includes(phrase));
      if (!matched) continue;
      if ((rule.requires ?? []).length && !rule.requires.some((need) => searchText.includes(need))) continue;
      if ((rule.excludes ?? []).some((bad) => searchText.includes(bad))) continue;
      for (const syndromeName of rule.syndromes) {
        addHit(
          resolveSyndrome(syndromeName),
          "pathogenesis_phrase_rule",
          field === "functions" ? "medium" : "high",
          `${field === "functions" ? "官方地方标准功效" : "主治原文"}命中病机短语「${matched}」：${excerpt(haystack, matched)}`,
          rule.id,
          rule.note,
        );
      }
    }

    // P3：病位 + 病性双轴一致且唯一命中。
    const natureTags = new Set(entry.natureTags ?? []);
    const locationTags = new Set(entry.locationTags ?? []);
    if (natureTags.size && locationTags.size) {
      const axisMatches = lexiconEntries.filter(
        (item) =>
          item?.id &&
          (item.natures ?? []).some((nature) => natureTags.has(nature)) &&
          (item.locations ?? []).some((location) => locationTags.has(location)),
      );
      if (axisMatches.length === 1) {
        addHit(
          axisMatches[0].id,
          "dual_axis_agreement",
          "low",
          `病性轴 ${[...natureTags].join("/")} 与病位轴 ${[...locationTags].join("/")} 双轴唯一命中`,
          "P3",
          "词表病位病性为项目规则派生候选，非标准定义，故仅作低置信参考。",
        );
      }
    }

    if (!hits.size) continue;
    candidates.push({
      name: entry.name,
      sourceClass: entry.sourceClass,
      source: entry.source,
      alreadyAdjudicated: adjudicatedNames.has(name),
      blocked: blockedReasons.length > 0,
      blockedReasons,
      indicationText,
      functionText,
      hits: [...hits.values()].sort((left, right) => left.syndromeId.localeCompare(right.syndromeId)),
    });
  }

  candidates.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));

  if (verifyOnly) {
    const byName = new Map(candidates.map((item) => [compact(item.name), item]));
    const failures = [];
    const batchRows = (adjudication.entries ?? []).filter((row) => row.batch === VERIFIED_BATCH);
    for (const row of batchRows) {
      const name = compact(row.name);
      const candidate = byName.get(name);
      if (!candidate) {
        failures.push(`${name}: 规则已不再为该方产出任何候选`);
        continue;
      }
      const derivedIds = new Set(candidate.hits.map((hit) => hit.syndromeId));
      for (const tagId of row.syndromeTagIds ?? []) {
        if (!derivedIds.has(tagId)) {
          failures.push(`${name}: 已裁定标签 ${tagId}(${byId.get(tagId)?.canonical ?? "?"}) 不再可由规则复现`);
        }
      }
    }
    if (failures.length) {
      console.error(`[FAIL] ${VERIFIED_BATCH} 有 ${failures.length} 条不可复现：`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        { batch: VERIFIED_BATCH, adjudicatedRows: batchRows.length, reproducible: batchRows.length },
        null,
        2,
      ),
    );
    return;
  }

  const adoptable = candidates.filter((item) => !item.blocked && !item.alreadyAdjudicated);
  const payload = {
    schemaVersion: "tcm-formula-syndrome-tag-candidates-v1",
    note: "确定性证候候选（生成物，非裁定）。人工裁定后写入 tcm-formula-syndrome-tag-adjudications.source.json。",
    generatedFrom: {
      catalog: "src/data/tcm-formula-governed-catalog.json",
      lexicon: "src/data/tcm-syndrome-lexicon.json",
      localStandard: "src/data/szjg-tcm-formula-standard.json",
    },
    summary: {
      untaggedFormulaCount: untagged.length,
      candidateFormulaCount: candidates.length,
      adoptableFormulaCount: adoptable.length,
      blockedFormulaCount: candidates.filter((item) => item.blocked).length,
      byPass: {
        governed_indication_literal: candidates.filter((item) =>
          item.hits.some((hit) => hit.pass === "governed_indication_literal"),
        ).length,
        pathogenesis_phrase_rule: candidates.filter((item) =>
          item.hits.some((hit) => hit.pass === "pathogenesis_phrase_rule"),
        ).length,
        dual_axis_agreement: candidates.filter((item) =>
          item.hits.some((hit) => hit.pass === "dual_axis_agreement"),
        ).length,
      },
    },
    entries: candidates,
  };

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const lines = ["# 方剂证候标签候选（确定性生成，待人工裁定）", ""];
  lines.push(`- 无标注方剂：${untagged.length}`);
  lines.push(`- 产出候选：${candidates.length}（可采纳 ${adoptable.length}，确定性阻断 ${payload.summary.blockedFormulaCount}）`);
  lines.push("");
  for (const item of candidates) {
    const flags = [
      item.blocked ? `**已阻断**（${item.blockedReasons.join("，")}）` : "",
      item.alreadyAdjudicated ? "已在裁定表" : "",
    ]
      .filter(Boolean)
      .join(" / ");
    lines.push(`## ${item.name}${flags ? ` — ${flags}` : ""}`);
    lines.push(`- 来源层：${item.sourceClass} ｜ 出处：${item.source ?? "-"}`);
    lines.push(`- 主治原文：${item.indicationText || "(无)"}`);
    if (item.functionText) lines.push(`- 标准功效：${item.functionText}`);
    for (const hit of item.hits) {
      lines.push(`- [${hit.confidence}] ${hit.syndromeName}（${hit.syndromeId}）｜${hit.ruleId}｜${hit.evidence[0]}`);
    }
    lines.push("");
  }
  writeFileSync(OUT_MD, `${lines.join("\n")}\n`, "utf8");

  console.log(JSON.stringify(payload.summary, null, 2));
}

main();

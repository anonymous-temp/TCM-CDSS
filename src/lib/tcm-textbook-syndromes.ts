import textbookTableJson from "../data/tcm-textbook-syndrome-formula-table.json" with { type: "json" };
import supplementJson from "../data/tcm-textbook-syndrome-supplement.source.json" with { type: "json" };
import { affirmedClinicalSourceClauses } from "./clinical-polarity";

/**
 * 教材「病—证—治法—代表方—加减」对照表的运行时读取（2026-10-13，甲方 10.12 测评）。
 *
 * 为什么要它：甲方医生按教材对照结果。此前病名、证名、方名都由模型自由书写——同一病例重新生成 3 次，方名只有
 * 一半病例完全一致；甲方 10 例标准病历里证名与教材字面一致的 2 例、方是教材代表方的 2 例（「心胆气虚证」
 * 对「心虚胆怯证」，「酸枣仁汤」对「安神定志丸」）。数据：src/data/tcm-textbook-syndrome-formula-table.json，
 * 由 scripts/build-tcm-textbook-syndrome-table.py 从本地教材合集逐字切出（十本规划教材 2,495 行，每行带书名与行号），
 * 以及一份联网核对的补充表（教材合集里没有方药的常见病，如牙痛）。
 *
 * 做法：按主诉与现病史从表里**确定性**取出最相近的几个病、每个病的各证型一行，写进追问、辨证、开方三个提示词。
 * 同一份病历每次取到的候选相同；模型在候选里选，选不出再自行辨证。选定后服务端按行核对证名与方名。
 * 本模块只做检索与渲染，不产生任何诊断。
 */

export interface TextbookSyndromeRow {
  id: string;
  book: string;
  bookKey: string;
  department: string;
  disease: string;
  syndrome: string;
  syndromeName: string;
  manifestations: string;
  tongue: string;
  pulse: string;
  therapy: string;
  formulas: string[];
  formulaJoin: string;
  composition: string[];
  modifications: Array<{ condition: string; herbs: string[]; raw: string }>;
}

interface TextbookDisease {
  bookKey: string;
  book: string;
  department: string;
  disease: string;
  aliases: string[];
  differentials: string[];
  /** 教材【鉴别诊断】各条的原文（病名 → 原文段落）。 */
  differentialTexts: Record<string, string>;
  rows: TextbookSyndromeRow[];
}

type RawRow = {
  id?: unknown; book?: unknown; bookKey?: unknown; department?: unknown; disease?: unknown; diseaseAliases?: unknown;
  westernEquivalents?: unknown; tcmEquivalents?: unknown; syndrome?: unknown; syndromeName?: unknown; syndromeKind?: unknown;
  manifestations?: unknown; tongue?: unknown; pulse?: unknown; therapy?: unknown; formulas?: unknown; formulaJoin?: unknown;
  composition?: unknown; modifications?: unknown;
};
type RawDisease = { bookKey?: unknown; disease?: unknown; diseaseAliases?: unknown; westernEquivalents?: unknown; tcmEquivalents?: unknown; differentials?: unknown };

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
  : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * 候选只取以中医病名立节的教材。中西医结合三本以西医病名立节，证型与同名中医病证重复且写法不一，
 * 进候选会让同一个证出现两种叫法；温病学按卫气营血分期，不是门诊按主诉找病的入口。
 */
const CANDIDATE_BOOK_PRIORITY: Readonly<Record<string, number>> = { supplement: 0, neike: 1, fuke: 1, waike: 1, erke: 1, yanke: 2, gushang: 3 };

/** 主诉里的常见说法 → 教材病名（有限闭集；只用于把病例对到教材的节，不产生诊断）。 */
const COMPLAINT_DISEASE_BRIDGE: ReadonlyArray<[string, readonly string[]]> = [
  ["感冒", ["恶寒发热", "发热恶寒", "鼻塞流涕", "鼻塞", "流涕", "打喷嚏", "伤风", "感冒", "受凉后发热"]],
  ["咳嗽", ["咳嗽", "咳痰", "干咳"]],
  ["喘证", ["气喘", "喘息", "喘促", "气促"]],
  ["哮病", ["哮喘", "喉中哮鸣", "喘鸣"]],
  ["心悸", ["心悸", "心慌", "心跳"]],
  ["胸痹", ["胸痛", "胸闷痛", "心前区疼痛", "胸闷憋气"]],
  ["不寐", ["失眠", "入睡困难", "睡不着", "早醒", "彻夜不眠", "不寐", "睡眠差"]],
  ["头痛", ["头痛", "头疼", "偏头痛"]],
  ["眩晕", ["头晕", "眩晕", "头昏", "天旋地转"]],
  ["胃痛", ["胃痛", "胃脘痛", "胃脘疼痛", "胃脘胀痛", "胃脘隐痛", "上腹痛", "上腹部疼痛", "胃疼", "胃胀痛"]],
  ["胃痞", ["胃胀", "胃脘胀满", "脘腹胀满", "上腹胀", "痞满", "胃脘痞闷"]],
  ["吐酸", ["反酸", "泛酸", "吐酸", "烧心"]],
  ["呕吐", ["呕吐", "恶心呕吐"]],
  ["呃逆", ["呃逆", "打嗝"]],
  ["腹痛", ["腹痛", "肚子痛", "脐周痛", "小腹痛", "少腹痛"]],
  ["泄泻", ["腹泻", "拉肚子", "大便稀", "便溏", "泄泻", "稀便"]],
  ["便秘", ["便秘", "大便干结", "排便困难", "大便秘结"]],
  ["胁痛", ["胁痛", "胁肋胀痛", "胁肋疼痛"]],
  ["水肿", ["水肿", "浮肿", "眼睑浮肿", "下肢肿"]],
  ["淋证", ["尿频", "尿急", "尿痛", "小便涩痛"]],
  ["郁证", ["情绪低落", "抑郁", "心情抑郁", "闷闷不乐"]],
  ["汗证", ["自汗", "盗汗", "多汗", "汗出过多"]],
  ["消渴", ["多饮", "多尿", "口渴多饮", "消渴"]],
  ["虚劳", ["乏力", "神疲乏力", "疲乏", "倦怠", "体虚", "易感冒", "反复感冒", "经常感冒", "容易感冒"]],
  ["痹证", ["关节疼痛", "关节痛", "关节肿痛", "肢体关节", "肩痛", "膝痛"]],
  ["腰痛", ["腰痛", "腰部疼痛", "腰酸痛", "腰部酸痛", "腰疼"]],
  ["内伤发热", ["低热", "午后发热", "长期发热"]],
  ["月经先期", ["月经提前", "经期提前", "月经先期", "月经周期缩短"]],
  ["月经后期", ["月经推迟", "月经延后", "月经后期", "经期延后"]],
  ["月经过多", ["月经量多", "经量增多", "月经过多"]],
  ["月经过少", ["月经量少", "经量减少", "月经过少"]],
  ["痛经", ["痛经", "经行腹痛", "经期腹痛"]],
  ["闭经", ["闭经", "月经停闭", "停经"]],
  ["崩漏", ["崩漏", "阴道不规则流血", "经血非时而下"]],
  ["带下过多", ["带下量多", "白带多", "带下过多"]],
  ["蛇串疮", ["带状疱疹", "蛇串疮", "簇集水疱", "簇集性水疱", "成簇水疱"]],
  ["瘾疹", ["风团", "荨麻疹", "瘾疹", "皮肤风团"]],
  ["湿疮", ["湿疹", "湿疮"]],
  ["粉刺", ["痤疮", "粉刺", "面部丘疹"]],
  ["牙痛", ["牙痛", "牙疼", "牙龈肿痛", "齿痛"]],
  ["口疮", ["口腔溃疡", "口疮"]],
  ["乳癖", ["乳房肿块", "乳房胀痛", "乳腺增生"]],
];

const NEGATIVE_TERM = /^(?:无|不|未|否认)/;

function compact(value: string): string {
  // 占位结果里病名/证名可能缺失；这里按空串处理，调用方据此得到「对不上教材」。
  return (typeof value === "string" ? value : "").normalize("NFKC").replace(/[\s，,。；;：:、（）()【】\[\]"'“”‘’_\-—]+/g, "");
}

function terms(value: string): string[] {
  return value.normalize("NFKC").split(/[，,。；;：:、\s]+/)
    .map((item) => item.replace(/^(?:或|甚则|甚至|兼见|兼|伴有?|常伴|可伴|或见|并见|时有?|常|多)/, "").trim())
    .filter((item) => item.length >= 2 && item.length <= 10);
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < value.length; index += 1) out.push(value.slice(index, index + 2));
  return out;
}

const RAW_ROWS = [
  ...((textbookTableJson as { rows?: RawRow[] }).rows || []),
  ...((supplementJson as { rows?: RawRow[] }).rows || []),
];
const RAW_DISEASES = [
  ...((textbookTableJson as { diseases?: RawDisease[] }).diseases || []),
  ...((supplementJson as { diseases?: RawDisease[] }).diseases || []),
];

/**
 * 教材合集是扫描件，生成器按「不改写任何临床文字」原样保留了 OCR 错字。方名、药名要拿去对目录、对处方、
 * 还会显示给医生，读入时把认得准的错字改回来（闭集，逐条都是字形相近的误识；2026-10-13 按「知识库不认得的
 * 药名/方名」清单逐个确认）。此前「龙胆泻肝汤合革薢渗湿汤加减」这样的方名直接出现在辨证结果里。
 */
const TEXTBOOK_OCR_FIXES: ReadonlyArray<[RegExp, string]> = [
  [/黄苓/g, "黄芩"], [/葛根苓连汤/g, "葛根芩连汤"], [/苓连二母丸/g, "芩连二母丸"],
  [/意苡仁/g, "薏苡仁"], [/螟蚣/g, "蜈蚣"], [/瓜萎/g, "瓜蒌"], [/萎贝/g, "蒌贝"],
  [/[草革]薢/g, "萆薢"], [/莞蔚子/g, "茺蔚子"], [/青箱子/g, "青葙子"],
  [/桑[蝶螺]蛸/g, "桑螵蛸"], [/海[蝶螺]蛸/g, "海螵蛸"], [/孚L香/g, "乳香"], [/金养麦/g, "金荞麦"],
  [/篇蓄/g, "萹蓄"], [/竹茄/g, "竹茹"], [/三菱/g, "三棱"], [/木爪/g, "木瓜"], [/黄氏/g, "黄芪"],
];

function fixTextbookOcr(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TEXTBOOK_OCR_FIXES) out = out.replace(pattern, replacement);
  return out;
}

let textbookFormulaNameSet: Set<string> | undefined;
/**
 * 教材证型行里写到的全部方名（候选教材，已做 OCR 订正）。识别方名时用：教材方名整体是一个方，
 * 不能在它里面再认出一个更短的别的方（「知柏地黄汤」里的「地黄汤」、「栝蒌薤白半夏汤」里的「半夏汤」）。
 */
export function textbookFormulaNames(): ReadonlySet<string> {
  if (textbookFormulaNameSet) return textbookFormulaNameSet;
  textbookFormulaNameSet = new Set();
  for (const raw of RAW_ROWS) {
    if (!(text(raw.bookKey) in CANDIDATE_BOOK_PRIORITY)) continue;
    for (const name of strings(raw.formulas).map(fixTextbookOcr)) if (name.length >= 3) textbookFormulaNameSet.add(name);
  }
  return textbookFormulaNameSet;
}

function buildDiseases(): TextbookDisease[] {
  const byKey = new Map<string, TextbookDisease>();
  for (const raw of RAW_ROWS) {
    const bookKey = text(raw.bookKey);
    if (!(bookKey in CANDIDATE_BOOK_PRIORITY)) continue;
    // 分期标题（初期/成痈期…）不是证名，不进候选。
    if (text(raw.syndromeKind) === "stage") continue;
    const disease = text(raw.disease);
    const syndromeName = text(raw.syndromeName) || text(raw.syndrome);
    const formulas = strings(raw.formulas).map(fixTextbookOcr);
    if (!disease || !syndromeName || !text(raw.therapy) || formulas.length === 0) continue;
    const key = `${bookKey}|${disease}`;
    const entry = byKey.get(key) || {
      bookKey, book: text(raw.book), department: text(raw.department), disease,
      aliases: [], differentials: [], differentialTexts: {}, rows: [],
    };
    entry.aliases = [...new Set([...entry.aliases, ...strings(raw.diseaseAliases), ...strings(raw.westernEquivalents), ...strings(raw.tcmEquivalents)])];
    entry.rows.push({
      id: text(raw.id), book: text(raw.book), bookKey, department: text(raw.department), disease,
      syndrome: text(raw.syndrome), syndromeName,
      manifestations: text(raw.manifestations), tongue: text(raw.tongue), pulse: text(raw.pulse),
      therapy: text(raw.therapy), formulas, formulaJoin: text(raw.formulaJoin) || "single",
      composition: strings(raw.composition).map(fixTextbookOcr),
      modifications: (Array.isArray(raw.modifications) ? raw.modifications : []).flatMap((item) => {
        const record = item && typeof item === "object" ? item as { condition?: unknown; herbs?: unknown; raw?: unknown } : {};
        const herbs = strings(record.herbs).map(fixTextbookOcr);
        return text(record.condition) && herbs.length > 0
          ? [{ condition: fixTextbookOcr(text(record.condition)), herbs, raw: fixTextbookOcr(text(record.raw)) }]
          : [];
      }),
    });
    byKey.set(key, entry);
  }
  for (const raw of RAW_DISEASES) {
    const entry = byKey.get(`${text(raw.bookKey)}|${text(raw.disease)}`);
    if (!entry) continue;
    entry.aliases = [...new Set([...entry.aliases, ...strings(raw.diseaseAliases), ...strings(raw.westernEquivalents), ...strings(raw.tcmEquivalents)])];
    const differentialRows = (Array.isArray(raw.differentials) ? raw.differentials : [])
      .map((item) => ({ name: text((item as { name?: unknown })?.name), text: text((item as { text?: unknown })?.text) }))
      .filter((item) => item.name.length >= 2 && item.name.length <= 8 && !/[与和及、]/.test(item.name));
    entry.differentials = differentialRows.map((item) => item.name);
    entry.differentialTexts = Object.fromEntries(differentialRows.filter((item) => item.text).map((item) => [item.name, item.text]));
  }
  return [...byKey.values()];
}

const DISEASES = buildDiseases();
const ROW_BY_ID = new Map(DISEASES.flatMap((disease) => disease.rows.map((row) => [row.id, row] as const)));

export interface TextbookCaseInput {
  chiefComplaint?: string;
  presentHistory?: string;
  tongue?: string;
  pulse?: string;
  sex?: string;
  ageYears?: number;
  /** 已定的中医病名（开方阶段）：给了就只取这个病。 */
  diseaseName?: string;
  /**
   * 闭集选择得到的教材病名（textbook-disease-pick.server.ts，按相关程度排序）。给了就排在候选最前；
   * 名字必须逐字等于教材病名，其余忽略。没有时候选完全由主诉词表与症状重合度决定。
   */
  preferredDiseases?: readonly string[];
}

export interface TextbookCandidateDisease {
  disease: string;
  book: string;
  differentials: string[];
  rows: Array<TextbookSyndromeRow & { score: number }>;
  score: number;
}

function rowScore(row: TextbookSyndromeRow, affirmed: string, raw: string, tonguePulse: string): number {
  let score = 0;
  for (const term of terms(row.manifestations)) {
    const haystack = NEGATIVE_TERM.test(term) ? raw : affirmed;
    const needle = compact(term);
    if (needle.length < 2) continue;
    if (haystack.includes(needle)) { score += needle.length >= 3 ? 2 : 1.4; continue; }
    const grams = bigrams(needle);
    const hit = grams.filter((gram) => haystack.includes(gram)).length;
    if (grams.length >= 2 && hit / grams.length >= 0.6) score += 0.7;
  }
  if (tonguePulse) {
    for (const term of terms(`${row.tongue}，${row.pulse}`)) {
      const needle = compact(term).replace(/^舌苔/, "苔");
      if (needle.length >= 2 && tonguePulse.includes(needle)) score += 1.5;
      else {
        const grams = bigrams(needle);
        if (grams.length >= 2 && grams.filter((gram) => tonguePulse.includes(gram)).length / grams.length >= 0.6) score += 0.6;
      }
    }
  }
  return score;
}

/** 「反复感冒」「易感冒」说的是体质，不是这一次得了感冒：按主诉对病名时把这类说法先拿掉。 */
const HABITUAL_COLD = /(?:反复|经常|容易|平素易|易)感冒/g;

function diseaseNameHit(disease: TextbookDisease, chiefRaw: string, narrativeRaw: string): number {
  const chief = disease.disease === "感冒" ? chiefRaw.replace(HABITUAL_COLD, "") : chiefRaw;
  const narrative = disease.disease === "感冒" ? narrativeRaw.replace(HABITUAL_COLD, "") : narrativeRaw;
  const names = [disease.disease, ...disease.aliases].map(compact).filter((name) => name.length >= 2);
  if (names.some((name) => chief.includes(name))) return 12;
  const bridged = COMPLAINT_DISEASE_BRIDGE.find(([name]) => name === disease.disease)?.[1] || [];
  if (bridged.some((phrase) => chief.includes(compact(phrase)))) return 10;
  if (names.some((name) => narrative.includes(name))) return 4;
  if (bridged.some((phrase) => narrative.includes(compact(phrase)))) return 3;
  return 0;
}

function departmentFits(disease: TextbookDisease, input: TextbookCaseInput): boolean {
  const age = input.ageYears;
  const child = typeof age === "number" && age < 14;
  if (disease.bookKey === "erke") return child;
  if (child && disease.bookKey !== "waike" && disease.bookKey !== "yanke" && disease.bookKey !== "supplement") return false;
  if (disease.bookKey === "fuke") return !/男/.test(input.sex || "");
  return true;
}

/**
 * 按病例取教材候选：最多 maxDiseases 个病，每个病最多 maxRowsPerDisease 行（按与本例表现的相近程度排序）。
 * 纯函数、确定性：同一份病历每次返回相同的候选与顺序。
 */
export function textbookCandidatesForCase(
  input: TextbookCaseInput,
  options: { maxDiseases?: number; maxRowsPerDisease?: number } = {},
): TextbookCandidateDisease[] {
  const chief = compact(input.chiefComplaint || "");
  const rawNarrative = compact(`${input.chiefComplaint || ""}，${input.presentHistory || ""}`);
  if (!rawNarrative) return [];
  const affirmed = compact(affirmedClinicalSourceClauses(`${input.chiefComplaint || ""}。${input.presentHistory || ""}`).join("，")) || rawNarrative;
  const tonguePulse = compact(`${input.tongue || ""}，${input.pulse || ""}`).replace(/舌苔/g, "苔");
  const wanted = compact(input.diseaseName || "");
  let preferred = (input.preferredDiseases || []).filter((name) => typeof name === "string");
  // 「反复感冒 / 容易感冒」说的是体质，不是这一次得了感冒（见 HABITUAL_COLD）：主诉只有这种说法、没有本次外感的说法时，
  // 闭集选择点的「感冒」不作数，改把「虚劳」排在最前。甲方标准病历 5（反复感冒1+年 → 虚劳·肺脾两虚）实测：
  // 闭集选择把感冒排第一，辨证随之落到「气虚感冒·参苏饮」，三次生成都如此。
  if (preferred.includes("感冒") && new RegExp(HABITUAL_COLD.source).test(input.chiefComplaint || "")) {
    const coldSection = DISEASES.find((disease) => disease.disease === "感冒");
    if (coldSection && diseaseNameHit(coldSection, chief, chief) === 0) {
      preferred = ["虚劳", ...preferred.filter((name) => name !== "感冒" && name !== "虚劳")];
    }
  }
  const scored = DISEASES.flatMap((disease) => {
    if (!departmentFits(disease, input)) return [];
    const names = [disease.disease, ...disease.aliases].map(compact);
    if (wanted) {
      if (!names.some((name) => name === wanted || (name.length >= 2 && (wanted.includes(name) || name.includes(wanted))))) return [];
    }
    const preferredIndex = wanted ? -1 : preferred.indexOf(disease.disease);
    const nameHit = wanted ? 12 : preferredIndex >= 0 ? 0 : diseaseNameHit(disease, chief, affirmed);
    const rows = disease.rows
      .map((row) => ({ ...row, score: rowScore(row, affirmed, rawNarrative, tonguePulse) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const best = rows[0]?.score || 0;
    // 病名没对上时，至少要有一个证型与本例表现明显相近才进候选。
    if (preferredIndex < 0 && nameHit === 0 && best < 6) return [];
    // 闭集选择点名的病排在最前（按它给出的先后），其余按主诉与症状的相近程度。
    const score = preferredIndex >= 0
      ? 1000 - preferredIndex * 10
      : nameHit * 2 + best + (rows[1]?.score || 0) * 0.3 - (CANDIDATE_BOOK_PRIORITY[disease.bookKey] || 0);
    return [{ disease: disease.disease, book: disease.book, bookKey: disease.bookKey, differentials: disease.differentials, rows, score }];
  });
  // 同名病在几本教材里各有一节（便秘：内科「气秘」、外科「气机阻滞证」；阳痿：内科、外科）：按书的先后取一节，
  // 与按病名取节（diseasesNamed）同一个顺序——此前取分高的那一节，候选给的是外科的证名，核对时找的却是内科。
  const bookOrder = bookOrderFor(input.ageYears);
  const bookRank = (key: string) => { const index = bookOrder.indexOf(key); return index < 0 ? bookOrder.length : index; };
  const byDisease = new Map<string, TextbookCandidateDisease & { bookKey: string }>();
  for (const item of scored) {
    const existing = byDisease.get(item.disease);
    if (!existing || bookRank(item.bookKey) < bookRank(existing.bookKey)) {
      byDisease.set(item.disease, existing ? { ...item, score: Math.max(item.score, existing.score) } : item);
    } else if (item.score > existing.score) {
      existing.score = item.score;
    }
  }
  // 闭集选择点了名、且点到的病在本科别的教材里时，候选只给这几个病（2026-10-14）。此前其后还跟着按字面重合取来的病：
  // 右膝右踝红肿热痛的病例，选择给的是痹证、痛风，候选里还有因「红肿、灼热」对上的热疮、接触性皮炎——模型把它们当成了
  // 鉴别对象，中医鉴别诊断写的是两种皮肤病（独立评审）。选择落空（超时、未配置、点到的病不在本科别）时仍用字面候选。
  const all = [...byDisease.values()];
  const picked = all.filter((item) => preferred.includes(item.disease));
  return (picked.length > 0 ? picked : all)
    .sort((left, right) => right.score - left.score || left.disease.localeCompare(right.disease))
    .map(({ bookKey, ...item }) => { void bookKey; return item; })
    .slice(0, options.maxDiseases ?? 3)
    .map((item) => ({ ...item, rows: item.rows.slice(0, options.maxRowsPerDisease ?? 8) }));
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formulaLabel(row: TextbookSyndromeRow): string {
  if (row.formulas.length <= 1) return row.formulas[0] || "";
  return row.formulaJoin === "combined" ? row.formulas.join("合") : row.formulas.join("或");
}

/** 追问、辨证提示词里的候选段。没有候选时返回空串（提示词里的规则会退回自行辨证）。 */
export function buildTextbookCandidateContext(input: TextbookCaseInput): string {
  // 闭集选择点了名时多给一个病、每个病的证型给全（教材一个病至多十来个证）：模型比字面重合度更会对口语化的症状。
  const candidates = textbookCandidatesForCase(input, input.preferredDiseases?.length
    ? { maxDiseases: 4, maxRowsPerDisease: 12 }
    : {});
  if (candidates.length === 0) return "";
  const lines = candidates.flatMap((item) => [
    `◆ ${item.disease}（《${item.book}》）${item.differentials.length > 0 ? `｜教材鉴别病名：${item.differentials.slice(0, 4).join("、")}` : ""}`,
    ...item.rows.map((row) =>
      `  - ${row.syndromeName}｜主症：${cut(row.manifestations, 90)}｜治法：${row.therapy}｜代表方：${formulaLabel(row)}`),
  ]);
  return [
    "【教材病证候选】（按与本例主诉、症状的相近程度从规划教材中取出；病名、证名、治法、代表方均为教材原文。其中有贴合本例的一行时，病名与证名逐字采用、治法以该行为准、推荐方用该行代表方；都不贴合时再自行辨证。同一病下各证型按教材顺序排列，先后不表示可能性大小。「贴合」指该行主症里能把它与同病其他证型分开的表现——寒热、虚实、诱因、伴随症状或舌脉——至少有一项已见于本例记录；本例只记录了本病主症本身时，没有哪一行贴合。同一病性涉及两脏、两脏各有自身成组的表现（每脏至少两条相互印证）而候选只有单脏证型时，证名写两脏合称（如“肺脾两虚证”），治法兼顾两脏，方用两行代表方合用或加减）",
    ...lines,
  ].join("\n");
}

/**
 * 按病名取教材的节（不看主诉）。同一个病在几本教材里各有一节时（阳痿：内科「命门火衰」、外科「肾阳不足」；
 * 感冒：内科、儿科），按书的先后排：未成年先儿科，其余先内科，再妇科、外科、补充表、眼科、骨伤。
 */
const BOOK_ORDER = ["neike", "fuke", "waike", "erke", "supplement", "yanke", "gushang"];

function bookOrderFor(ageYears?: number): string[] {
  const child = typeof ageYears === "number" && ageYears < 14;
  return child ? ["erke", ...BOOK_ORDER.filter((key) => key !== "erke")] : BOOK_ORDER;
}

/**
 * 本例可选的教材病名闭集（按科别过滤：未成年取儿科与外科等，男性不取妇科）。
 * 供闭集选择使用；只是名字清单，不含任何病例信息。
 */
export function textbookDiseaseNamesForCase(input: Pick<TextbookCaseInput, "sex" | "ageYears">): string[] {
  return [...new Set(DISEASES.filter((disease) => departmentFits(disease, input)).map((disease) => disease.disease))]
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function diseasesNamed(diseaseName: string, ageYears?: number): TextbookDisease[] {
  const wanted = compact(diseaseName).replace(/类病$/u, "");
  if (wanted.length < 2) return [];
  const order = bookOrderFor(ageYears);
  const exact = DISEASES.filter((disease) => [disease.disease, ...disease.aliases].map(compact).includes(wanted));
  const loose = exact.length > 0 ? exact : DISEASES.filter((disease) => {
    const name = compact(disease.disease);
    return name.length >= 2 && (wanted.includes(name) || name.includes(wanted));
  });
  return loose.sort((left, right) => order.indexOf(left.bookKey) - order.indexOf(right.bookKey) || left.disease.localeCompare(right.disease));
}

const syndromeCore = (value: string) => compact(value).replace(/(?:证候|证型|证|型)$/u, "");

/** 已定病名与证名对应的教材行；对不上返回 undefined。证名比较忽略末尾的「证/型」。任何一本教材里该病有这个证名都算对上。 */
export function textbookRowForSyndrome(diseaseName: string, syndromeName: string, input: TextbookCaseInput = {}): TextbookSyndromeRow | undefined {
  const target = syndromeCore(syndromeName);
  if (target.length < 2) {
    // 去掉「证」只剩一个字的证名（吐酸的「热证」「寒证」）：只在已定的病里按全名找，不做跨病的反查。
    const full = compact(syndromeName);
    if (full.length < 2) return undefined;
    for (const disease of diseasesNamed(diseaseName, input.ageYears)) {
      const exact = disease.rows.find((row) => compact(row.syndromeName) === full || compact(row.syndrome) === full);
      if (exact) return exact;
    }
    return undefined;
  }
  const named = diseasesNamed(diseaseName, input.ageYears);
  for (const disease of named) {
    const exact = disease.rows.find((row) => syndromeCore(row.syndromeName) === target || syndromeCore(row.syndrome) === target);
    if (exact) return exact;
  }
  // 病名对上了教材的节、只是该节没有这个证名时，到此为止：不到别的病里找同名证（2026-10-17：虚劳·肺脾两虚证
  // 找到了肺胀的「肺脾两虚证」，锚定把治法换成「补肺健脾，降气化痰」、方换成六君子汤合玉屏风散，病名还会被改成肺胀）。
  if (named.length > 0) return undefined;
  // 病名没对上（模型写了「头风病」而教材的节是「头痛」）时，证名在全表只属于一个病的，按证名找回那一行。
  const owners = DISEASES.filter((disease) => CANDIDATE_BOOK_PRIORITY[disease.bookKey] <= 1)
    .flatMap((disease) => disease.rows.filter((row) => syndromeCore(row.syndromeName) === target || syndromeCore(row.syndrome) === target));
  return new Set(owners.map((row) => row.disease)).size === 1 ? owners[0] : undefined;
}

/** 开方提示词里的教材方药段：已定证型的代表方组成与教材加减。 */
export function buildTextbookFormulaContext(diseaseName: string, syndromeName: string, input: TextbookCaseInput = {}): string {
  const row = textbookRowForSyndrome(diseaseName, syndromeName, input);
  if (!row) return "";
  const modifications = row.modifications.slice(0, 8).map((item) => `若${item.condition.replace(/^若/, "")}，加${item.herbs.join("、")}`);
  return [
    `【教材方药】${row.disease}·${row.syndromeName}（《${row.book}》）：治法 ${row.therapy}；代表方 ${formulaLabel(row)}${row.composition.length > 0 ? `（${row.composition.join("、")}）` : ""}。`
      + `辨证阶段已定用该代表方：candidate.name 写“${formulaLabel(row)}加减”，candidate.herbs 以该方组成为主体（保留其大部分药味），再按本例病机加减，增减合计不超过 4 味；不要另起一张方。`,
    modifications.length > 0 ? `【教材加减】${modifications.join("；")}。` : "",
  ].filter(Boolean).join("\n");
}

export function textbookTableStats(): { diseases: number; rows: number } {
  return { diseases: DISEASES.length, rows: ROW_BY_ID.size };
}

/**
 * 教材没有给已定证型列加减药味时，模型按本证常见的兼症变化写的条件式加减是否合格（「若咳嗽较甚，痰稀色白」）。
 *
 * 2026-10-13：教材对照表里约四成外科行、两成妇科行没有可用的加减（或只写「改用某方」），这些证的处方加减栏
 * 常年是空的（合成集 153 张处方里 21 张）。竞品与甲方医生看的都是「若……，加某药若干克」这种条件式建议。
 * 放开的只是「触发条件可以是模型写的条件句」，其余边界不变：药味须在标准药材资料内、用量在药典范围内、
 * 不与方中药味相反、不与本例已定治法方向相悖（这一类不豁免方向核对）。
 * 仍不接受的写法：不以「若」开头；说的是流程或泛指而不是具体症状（复诊时、症状变化时、必要时、效果不佳、需要时…）。
 * 教材该证有加减时不走这条路——那时只认教材条件与已记录表现。
 */
export function conditionalModificationWithoutTextbook(diseaseName: string, syndromeName: string, trigger: string): boolean {
  const row = textbookRowForSyndrome(diseaseName, syndromeName);
  if (row && row.modifications.length > 0) return false;
  const text = (typeof trigger === "string" ? trigger : "").normalize("NFKC").trim().replace(/[。；;，,\s]+$/u, "");
  if (!/^若/u.test(text)) return false;
  const condition = text.replace(/^若(?:兼见|兼有|见|兼|伴有?|出现)?/u, "");
  if (condition.length < 2 || condition.length > 28) return false;
  // 条件必须说的是症状本身：流程、泛指、涉及人或检查的说法都不算。
  return !/复诊|接诊|核实|症状|病情|诸症|上述|必要|酌情|未缓解|无效|效果|出现时|加重时|以后|日后|患者|医[生师]|同意|检查|化验|结果|需要/u.test(condition);
}

/**
 * 加减行的触发条件是否就是已定证型在教材里的某条加减（「若恶寒甚，可加麻黄、桂枝」）。
 * 给了药名时还要求该药在这条加减的药味里。对上时返回教材原句与出处，供开方阶段写入依据。
 * 教材条件是「可预见的变化」，不要求病历里已经出现；这是它与「逐字引用已记录表现」并列的第二种合格触发。
 */
export function textbookModificationMatch(
  diseaseName: string,
  syndromeName: string,
  trigger: string,
  herbName?: string,
): { book: string; disease: string; syndromeName: string; condition: string; raw: string } | undefined {
  const row = textbookRowForSyndrome(diseaseName, syndromeName);
  if (!row) return undefined;
  const wanted = compact(trigger).replace(/^(?:若|如|如果|兼见|兼有|兼|见|伴有?|出现)/, "").replace(/(?:者|时)$/, "");
  if (wanted.length < 2) return undefined;
  const herb = herbName ? compact(herbName) : "";
  for (const item of row.modifications) {
    const condition = compact(item.condition).replace(/^(?:若|如|兼见|兼有|兼|见|伴有?)/, "").replace(/(?:者|时)$/, "");
    if (condition.length < 2) continue;
    const grams = bigrams(condition.length <= wanted.length ? condition : wanted);
    const longer = condition.length <= wanted.length ? wanted : condition;
    const overlap = grams.length > 0 ? grams.filter((gram) => longer.includes(gram)).length / grams.length : 0;
    if (!(condition === wanted || condition.includes(wanted) || wanted.includes(condition) || overlap >= 0.6)) continue;
    if (herb && !item.herbs.some((name) => { const candidate = compact(name); return candidate === herb || candidate.includes(herb) || herb.includes(candidate); })) continue;
    return { book: row.book, disease: row.disease, syndromeName: row.syndromeName, condition: item.condition, raw: item.raw };
  }
  return undefined;
}

export interface TextbookDiscriminatingQuestion {
  question: string;
  reason: string;
  field: "舌象" | "脉象" | "现病史";
  optionA: string;
  optionB: string;
  syndromeA: string;
  syndromeB: string;
}

/** 症状短语里表「怎么样」的那个字（闭集）；只有部位、没有这类字的片段不是一条症状。 */
const SYMPTOM_PREDICATE = /[痛疼胀满闷痞热寒冷凉烦渴干苦黏腻汗咳喘哕呕吐泻秘溏结稀黄赤红紫暗肿痒麻重困乏倦怠眩晕悸惊怒郁梦眠寐频涩急坠酸软鸣聋燥裂瘦萎厥逆饥呆嗳呃堵塞淡清浊臭]/;

/**
 * 由教材候选确定性生成的一道辨证追问：取与本例最相近的两个证型，问一条病历尚未记录、且能把它们分开的事实。
 * 舌脉缺失时问舌脉（两个证型各自的教材舌脉）；舌脉已有时问各自独有、病历未提到的主症。
 * 两个选项都是能直接写进病历的事实句，各自对应一个证型。给不出这样一道题时返回 undefined。
 */
// 舌象题的两个选项必须互斥，单选才能写进病历（2026-10-18 验收集 B：「舌质淡，苔白」对「苔薄白」、
// 「舌质红」对「舌苔厚腻」可以同时成立）。按舌色、苔色、苔质三个维度各取一个值，至少一个维度两边都写到且不同才算互斥；
// 否则这道题改问脉象。
const TONGUE_BODY = /舌(?:质|体)?(?:尖|边)?(淡红|淡白|淡|红绛|绛|红|紫暗|青紫|紫|暗|黯)/u;
const TONGUE_COATING_COLOR = /苔[薄厚少]?(白|黄|灰|黑)|(白|黄|灰|黑)[腻厚滑燥]?苔/u;

/**
 * 苔质：先取紧跟「苔/舌」的那个字（少、剥、光、无苔、厚腻＝厚、腻、薄），没有时再看整段苔象里有没有「厚」（「苔黄厚或黄腻」）
 * 或「少苔/无苔」（「舌红少苔」）（2026-10-19：此前只认紧跟「苔」字的那个字，「苔黄厚或黄腻」与「苔薄黄」判成不互斥，
 * 模型写的舌象题也要过这条判据后，甲方病历 7 评审判合格的这道题会被误删）。
 */
const TONGUE_COATING_TEXTURE = /(?:苔|舌)(少|剥|光|无苔|厚腻|腻|薄)/u;
function tongueCoatingTexture(text: string): string | undefined {
  const direct = TONGUE_COATING_TEXTURE.exec(text)?.[1];
  if (direct) return direct === "厚腻" ? "厚" : direct;
  const coating = [...text.matchAll(/([^，,。；;、]{0,3})苔([^，,。；;、]{0,8})/gu)]
    .map((match) => `${match[1].replace(/^.*舌/u, "")}苔${match[2]}`)
    .join(" ");
  if (/少苔|无苔/u.test(coating)) return "少";
  return /苔[^ ]*厚/u.test(coating) ? "厚" : undefined;
}

function tongueDimensionValues(text: string): (string | undefined)[] {
  const color = TONGUE_COATING_COLOR.exec(text);
  return [TONGUE_BODY.exec(text)?.[1], color?.[1] ?? color?.[2], tongueCoatingTexture(text)];
}

export function tongueOptionsMutuallyExclusive(a: string, b: string): boolean {
  const left = tongueDimensionValues(a);
  const right = tongueDimensionValues(b);
  return left.some((value, index) => {
    const other = right[index];
    if (value === undefined || other === undefined || value === other) return false;
    // 厚腻与腻都是腻苔，不算相反。
    return !(index === 2 && new Set([value, other]).has("厚") && new Set([value, other]).has("腻"));
  });
}

/**
 * 脉象选项的互斥判据（2026-10-19，r1019 验收集 B）；与上面的舌象判据并列，教材脉象题与 M02 舌脉拆题共用。
 *
 * 单选题的两个选项要能各自直接写进病历、且不能同时成立。舌象早有这条判据（
 * tongueOptionsMutuallyExclusive：舌色、苔色、苔质三个维度上至少一处两边都写到且不同）；脉象一直只比「字面不同」，
 * 于是教材脉象题出过「脉细数，指纹紫滞」对「脉数，指纹紫滞」（一个是另一个的子集）、「脉浮或浮紧」对「脉濡数或滑」
 *（选项里用「或」并列两种脉象，选了也写不进病历），独立评审三次判不合格。
 *
 * 判法（有限闭集，冻结令允许的确定性例外）：先去掉小儿指纹那一小句（指纹是另一项诊察，不与脉象同题）；
 * 任一选项里有「或」就不算；然后按四对相反的脉象类别比——位置（浮类 / 沉类）、至数（数类 / 迟缓类）、
 * 力度（有力类 / 无力类）、脉形（洪大 / 细微）、流利度（滑 / 涩）——两边各落在一对的不同端时互斥。
 * 「弦」「紧」这类可与多数脉并见的不参与判定：「脉弦紧」对「脉弦」不互斥。
 */
const PULSE_OPPOSITES: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/浮|濡|芤|革|散/u, /沉|伏|牢|弱/u],
  [/数|疾|促/u, /迟|缓|结/u],
  [/有力|实|洪|滑|紧/u, /无力|虚|弱|微|细|濡/u],
  [/洪|大/u, /细|微/u],
  [/滑/u, /涩/u],
];

/** 去掉小儿指纹那一小句（「脉细数，指纹紫滞」→「脉细数」）。 */
export function withoutFingerVeinClause(text: string): string {
  return text
    .split(/[，,；;、]/u)
    .filter((part) => !/指纹/u.test(part))
    .join("，")
    .replace(/[，,；;、\s]+$/u, "")
    .trim();
}

function pulseQualities(text: string): string {
  const at = text.indexOf("脉");
  return at >= 0 ? text.slice(at + 1).replace(/象|[，,；;、。\s]/gu, "") : "";
}

export function pulseOptionsMutuallyExclusive(a: string, b: string): boolean {
  const left = withoutFingerVeinClause(a);
  const right = withoutFingerVeinClause(b);
  if (!left || !right || /或/u.test(left) || /或/u.test(right)) return false;
  const leftQualities = pulseQualities(left);
  const rightQualities = pulseQualities(right);
  if (!leftQualities || !rightQualities || leftQualities === rightQualities) return false;
  return PULSE_OPPOSITES.some(([one, other]) => {
    const leftOne = one.test(leftQualities);
    const leftOther = other.test(leftQualities);
    const rightOne = one.test(rightQualities);
    const rightOther = other.test(rightQualities);
    // 一边只落在一端、另一边只落在另一端才算相反；同一边两端都有（「濡」既浮又无力）时不据这一对判。
    return (leftOne && !leftOther && rightOther && !rightOne) || (leftOther && !leftOne && rightOne && !rightOther);
  });
}

export function textbookDiscriminatingQuestion(input: TextbookCaseInput): TextbookDiscriminatingQuestion | undefined {
  const disease = textbookCandidatesForCase(input, { maxDiseases: 1, maxRowsPerDisease: 8 })[0];
  if (!disease || disease.rows.length < 2) return undefined;
  const [first, second] = disease.rows;
  // 第二候选与本例完全不沾边时，两个证型谈不上「分不开」，不必问。
  if (!(second.score > 0) && first.score >= 6) return undefined;
  // 理由不点证名：题目只收集可观察的事实，证候由辨证阶段定（追问理由不得预设结论）。
  const reason = "两种情况对应不同的证型，治法与选方不同。";
  // 一题只问一件事（2026-10-18 验收集 B：「舌象、脉象更接近哪一种」评审判两件事并问）：舌象没记录且两个证型的舌象不同就问舌象，
  // 否则脉象没记录且两者脉象不同就问脉象。
  const clean = (value: string) => value.replace(/[。；;]+$/g, "").trim();
  if (!compact(input.tongue || "")) {
    const a = clean(first.tongue);
    const b = clean(second.tongue);
    if (a && b && tongueOptionsMutuallyExclusive(a, b)) {
      return { question: "本例的舌象更接近下面哪一种？", reason, field: "舌象", optionA: a, optionB: b, syndromeA: first.syndromeName, syndromeB: second.syndromeName };
    }
  }
  if (!compact(input.pulse || "")) {
    // 脉象选项同样要互斥、能直接写进病历（2026-10-19，r1019 验收集 B：「脉细数，指纹紫滞」对「脉数，指纹紫滞」、
    // 「脉浮或浮紧」对「脉濡数或滑」评审判不合格）：去掉小儿指纹那一小句，带「或」的不出，相反脉类判互斥（pulseOptionsMutuallyExclusive）。
    const a = withoutFingerVeinClause(clean(first.pulse));
    const b = withoutFingerVeinClause(clean(second.pulse));
    if (a && b && pulseOptionsMutuallyExclusive(a, b)) {
      return { question: "本例的脉象更接近下面哪一种？", reason, field: "脉象", optionA: a, optionB: b, syndromeA: first.syndromeName, syndromeB: second.syndromeName };
    }
  }
  const rawNarrative = compact(`${input.chiefComplaint || ""}，${input.presentHistory || ""}`);
  const unrecorded = (row: TextbookSyndromeRow, other: TextbookSyndromeRow) => {
    const otherText = compact(other.manifestations);
    return terms(row.manifestations.split(/[；;]/)[0] || "")
      .map((term) => term.replace(/^(?:甚则|甚至|或|兼见|兼|伴有?|并见|常|多)+/, ""))
      .filter((term) => {
        const needle = compact(term);
        if (needle.length < 2 || needle.length > 6 || /[舌苔脉]/.test(needle)) return false;
        // 选项必须是一条完整的症状：教材主症按顿号切开后会剩下只有部位的残片（「颜面、胸背部皮肤油腻」→「颜面」），
        // 这种残片不能当选项（合成集 S134 实测出过「伴颜面」）。
        if (!SYMPTOM_PREDICATE.test(needle)) return false;
        if (otherText.includes(needle) || rawNarrative.includes(needle)) return false;
        // 病历里已有相近说法的不再问（「不寐多梦而易惊醒」对「多梦且易惊醒」）：双字重合三分之一即算已记录。
        const grams = bigrams(needle);
        return grams.filter((gram) => rawNarrative.includes(gram) || otherText.includes(gram)).length / Math.max(1, grams.length) < 0.34;
      })
      .slice(0, 2);
  };
  const a = unrecorded(first, second);
  const b = unrecorded(second, first);
  if (a.length === 0 || b.length === 0) return undefined;
  return {
    question: "除病历已记录的表现外，目前还伴有下面哪一组情况？",
    reason,
    field: "现病史",
    optionA: `伴${a.join("、")}`,
    optionB: `伴${b.join("、")}`,
    syndromeA: first.syndromeName,
    syndromeB: second.syndromeName,
  };
}

/** 药名比较用：去掉炮制前缀与空白（生地黄=地黄；炙甘草=甘草）。只用于判断方子是不是以教材组成为主体。 */
function herbCore(name: string): string {
  return compact(name).replace(/^(?:生|炙|炒|制|酒|醋|盐|煅|焦|蜜|姜|麸炒|土炒|法|清)/u, "");
}

/** 一组药味覆盖教材行组成的比例（0–1）。教材没列组成时返回 0。 */
export function textbookCompositionCoverage(row: TextbookSyndromeRow, herbNames: readonly string[]): number {
  if (row.composition.length === 0) return 0;
  const present = new Set(herbNames.map(herbCore));
  return row.composition.filter((name) => present.has(herbCore(name))).length / row.composition.length;
}

export function textbookFormulaLabel(row: TextbookSyndromeRow): string {
  return formulaLabel(row);
}

/**
 * 教材对某个病要求鉴别的病证及其原文要点（去掉开头重复的病名，截到两句以内）。
 * 病名鉴别为空时用它补齐：内容是教材原文，不是服务端写的话。
 */
export function textbookDifferentialsForDisease(diseaseName: string): Array<{ name: string; text: string; book: string }> {
  const wanted = compact(diseaseName).replace(/类病$/u, "");
  if (!wanted) return [];
  const disease = DISEASES
    .filter((item) => compact(item.disease) === wanted)
    .sort((left, right) => (CANDIDATE_BOOK_PRIORITY[left.bookKey] || 0) - (CANDIDATE_BOOK_PRIORITY[right.bookKey] || 0))[0];
  if (!disease) return [];
  return disease.differentials.flatMap((name) => {
    // 病名里可能带正则元字符（「β受体…」、括注），按字面去掉段首的病名。
    const raw = (disease.differentialTexts[name] || "").replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "").trim();
    const sentences = raw.split(/(?<=。)/).slice(0, 2).join("").trim();
    const textValue = sentences.length > 110 ? `${sentences.slice(0, 108)}…` : sentences;
    return textValue.length >= 8 ? [{ name, text: textValue, book: disease.book }] : [];
  }).slice(0, 2);
}

function charJaccard(left: string, right: string): number {
  const a = new Set(compact(left).replace(/[证型]/g, ""));
  const b = new Set(compact(right).replace(/[证型]/g, ""));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const ch of a) if (b.has(ch)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * 病名对上了教材、证名却不是教材写法（「肾阳不足证」对教材的「命门火衰证」，「瘀血停胃证」对「瘀血停滞证」）时，
 * 在这个病的各证型里找最接近的一行：证名用字、治法用字、以及模型自己摘录的病历依据与该行主症的重合，三者合计。
 * 第一名要够高、且明显高于第二名才认——认不准就不改，保留模型写的证名。
 * 合成测试集实测：病名对而证名不是教材写法的约占一成，多数是这种近义写法。
 */
/** 证名里表示病性的字（有限闭集）：寒热、痰湿瘀、燥毒、虚实所在的阴阳气血、食积水饮。 */
const TEXTBOOK_NATURE_WORDS = /寒|热|火|湿|痰|瘀|燥|毒|虚|亏|不足|衰|阴|阳|血|食|饮|风/g;
/** 证名里表示病位的脏腑字（有限闭集）。 */
const TEXTBOOK_ORGAN_WORDS = /心|肝|脾|肺|肾|胃|胆|肠|膀胱/g;

export function textbookNearestRow(
  diseaseName: string,
  syndromeName: string,
  method: string,
  evidenceText: string,
  /** 模型自己写的病位（locationDifferentiation.items）。给了时，只有其中也写到的脏腑才算「模型写的病位」。 */
  modelLocations: readonly string[] = [],
): TextbookSyndromeRow | undefined {
  if (compact(syndromeName).length < 2) return undefined;
  const section = diseasesNamed(diseaseName)[0];
  if (!section || section.rows.length === 0) return undefined;
  const rawEvidence = compact(evidenceText);
  const affirmedEvidence = compact(affirmedClinicalSourceClauses(evidenceText).join("，")) || rawEvidence;
  const tonguePulse = rawEvidence.replace(/舌苔/g, "苔");
  const scored = section.rows.map((row) => ({ row, score: rowScore(row, affirmedEvidence, rawEvidence, tonguePulse) }));
  const top = Math.max(...scored.map((item) => item.score), 0);
  // 改名只做同义写法的归一，不替模型新下病性（2026-10-14）。两种情形不得改成带有模型自己没写的病性字的一行：
  //  · 模型的证名与治法里一个病性字都没有——它有意写了中性证名（只记录「腰部疼痛2周」，写「经络不通证」、通络止痛），
  //    教材「湿热腰痛」的主症「腰部疼痛…」只是复述了主诉，不能据此改成湿热再带出清热利湿与四妙丸；
  //  · 病历与哪一行的主症都对不上，改名只凭字面相近。
  const modelWords = `${syndromeName}${method}`;
  const modelNatureWords = modelWords.match(TEXTBOOK_NATURE_WORDS) || [];
  const addsNature = (row: TextbookSyndromeRow) => (top === 0 || modelNatureWords.length === 0) &&
    (row.syndromeName.match(TEXTBOOK_NATURE_WORDS) || []).some((word) => !modelWords.includes(word));
  // 也不得丢掉模型写的病位（2026-10-17，甲方标准病历 5）：模型写「肺脾两虚证」，教材虚劳只有单脏的「肺气虚证」
  //「脾气虚证」，按字面相近改成「肺气虚证」后，辨证依据成了「两脏各有成组表现，故为肺气虚证」，治法也跟着锚成「补益肺气」。
  // 两脏合称不是单脏证型的同义写法。只在教材这一行自己写了脏腑、却缺模型写的某一脏时否决；
  // 不写脏腑的行（「气血亏虚证」）照旧可以认。模型的病位栏只写了其中一脏时（证名「肝肾阴虚」、病位只有「肾」），
  // 多写的那一脏没有它自己的定位，改成单脏写法照旧。
  const locatedOrgans = new Set(modelLocations.flatMap((item) => compact(item).match(TEXTBOOK_ORGAN_WORDS) || []));
  const modelOrgans = new Set((compact(syndromeName).match(TEXTBOOK_ORGAN_WORDS) || [])
    .filter((organ) => modelLocations.length === 0 || locatedOrgans.has(organ)));
  const dropsOrgan = (row: TextbookSyndromeRow) => {
    const rowOrgans = new Set(compact(row.syndromeName).match(TEXTBOOK_ORGAN_WORDS) || []);
    return rowOrgans.size > 0 && [...modelOrgans].some((organ) => !rowOrgans.has(organ));
  };
  // 病性因素同理（2026-10-19）：模型写「气虚血瘀证」「阴虚阳亢证」，改成教材单因素的「血瘀…」「肝阳上亢证」就丢了一个因素，
  // 不是同义写法——≥300 条验收里评审最常判的就是「遗漏气虚/阴虚」。虚/亏/不足/衰、火/热各算一类，不因写法不同否决。
  // 「命门火衰」即肾阳衰，按「阳 + 虚」算（肾阳不足证 → 命门火衰证 是同义归一）。
  const natureClass = (word: string) => /^(?:虚|亏|不足|衰)$/u.test(word) ? "虚" : word === "火" ? "热" : word;
  const natureClassesOf = (name: string) => new Set((compact(name).replace(/火衰/gu, "阳衰").match(TEXTBOOK_NATURE_WORDS) || []).map(natureClass));
  const modelNatureClasses = natureClassesOf(syndromeName);
  const dropsNature = (row: TextbookSyndromeRow) => {
    const rowClasses = natureClassesOf(row.syndromeName);
    return [...modelNatureClasses].some((word) => !rowClasses.has(word));
  };
  const ranked = scored
    .map(({ row, score }) => ({
      row,
      combined: 2 * charJaccard(syndromeName, row.syndromeName) + 1.5 * (method ? charJaccard(method, row.therapy) : 0) + (top > 0 ? score / top : 0),
    }))
    .sort((left, right) => right.combined - left.combined || left.row.id.localeCompare(right.row.id));
  const [first, second] = ranked;
  if (!first || first.combined < 1.3) return undefined;
  if (second && first.combined - second.combined < 0.2) return undefined;
  // 只否决胜出的那一行，不先把行剔掉再排：剔掉竞争者会让原本「认不准」的近似行变成明显第一。
  if (addsNature(first.row) || dropsOrgan(first.row) || dropsNature(first.row)) return undefined;
  return first.row;
}

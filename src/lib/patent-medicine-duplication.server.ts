import { readFileSync } from "node:fs";
import path from "node:path";
import type { CaseState } from "./diagnosis-types";
import {
  classIsPathogenSpecific,
  findLocalPatentMedicineLabel,
  medicineFunctionClause,
  medicineRouteIsExternal,
  medicineRouteIsSensory,
  patentMedicineBaseName,
  patentMedicineCompositionIdentities,
  patentMedicineDirectionConflict,
  productNameStem,
  signedDirectionOf,
  type MedicineDirectionConflict,
  type SignedDirection,
} from "./local-patent-medicine-candidates";
import { requiredPrecautionsForCase } from "./required-precautions.server";
import { textbookDistinctHerbKey } from "./herb-textbook-identity";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { skinTopicalMedication } from "./delivered-surface";
import { MEDICINE_CLINICAL_CONCEPTS, matchingMedicineClinicalProblemTerms } from "./medicine-clinical-concepts";

/**
 * 推荐的中成药与本方汤剂重复（2026-10-19，甲方标准病历三次复评，注意事项一栏每次都因此判不通过）：
 *  · 病历 2：汤剂里人参 6g（另煎），推荐栏列人参口服液，注意事项又写「不宜再服含人参的中成药」；
 *  · 病历 7：汤剂里黄连为君、大黄为佐，推荐栏列三黄片、栀子金花丸、一清片（都含大黄，后两种含黄连），
 *    注意事项又让患者停服自服的黄连上清丸，理由正是「两方均含黄连」；
 *  · 留出集：四神丸方旁推荐四神丸、藿香正气散旁推荐藿香正气丸、归脾汤旁推荐归脾丸。
 * 同一份方案里同时开汤剂和同组成的成药，等于同一组药吃两遍；《中成药临床应用指导原则》（国中医药医政发〔2010〕30 号）
 * 写明「功能相同或基本相同的中成药原则上不宜叠加使用」，中药饮片与中成药联用同此。
 *
 * 判据只看组成，不看功效描述：
 *  · 中成药的组成取说明书「成份」（local-patent-medicine-composition.json，与页面上那条说明书同一批准文号；
 *    该行成份为空时取同名各批准文号共有的药），说明书没有时取方剂目录里的组成（catalogSharedComposition）；
 *    药名按组成身份比较（炙黄芪＝黄芪、酒大黄＝大黄、法半夏＝半夏），但《中药学》分立两味的不并
 *   （生地黄在清热凉血药、熟地黄在补血药：熟地黄为君的汤剂旁推荐含生地黄的成药，不是同一味药吃两遍）。
 *  · 与汤剂重复：含汤剂里的君药，或与汤剂共有两味以上的药（甘草、大枣、生姜不计——调和、矫味之品，几乎每张方都有）。
 *    只共有一味臣药的不算（归脾丸与加味四物汤共有当归、人参健脾丸与苍附导痰丸共有茯苓：各自对的是另一组问题，
 *    一味常用药的重叠不构成「同一组药吃两遍」）。
 *  · 与自服药重复：现病史写着患者为这次的病自服的药（与注意事项「已自服的药」同一来源 requiredPrecautionsForCase），
 *    推荐的成药与它同名，或与它共有两味以上的药。患者已在吃的药要么被告知停服（与汤剂重复），要么在继续吃，
 *    再推荐一种同组成的成药都是重复。
 *  · 与现用药（病历写着正在服用的中成药，requiredPrecautionsForCase 的 current_medications）同品、同组成（共有两味以上）、
 *    或同以某味药为名（丹参滴丸与丹参保心茶）的，同样不再推荐（2026-10-19 第九轮 M 集 MTCMB-35：现用丹参滴丸，又推荐丹参保心茶）。
 *  · 定位为「替代方案」的不删：它是写给不便煎药时换用的，不与汤剂同服（同组成的丸剂替代汤剂正是常规做法）；
 *    外用的（说明书用法为外用）不删：不与内服汤剂同吃。
 *  · 组成查不到的中成药不删（只能判有，不能凭名字猜）；西药不在此列。
 * 只删不改：留下的行原样，删光了就是空数组（页面本来就会说明没有合适的成药）。
 */

/** 调和、矫味之品：几乎每张方都有，不作重复的证据。 */
const HARMONIZING_ADJUNCTS = new Set(["甘草", "大枣", "生姜"]);

// 成份表读取与「中成药组成身份」已移到 local-patent-medicine-candidates（检索层的方向底线要用它，而本文件依赖检索层，不能反过来）。
export { patentMedicineCompositionIdentities };

export type PatentMedicineDuplication = {
  reason: "decoction_emperor_herb" | "decoction_shared_herbs" | "self_medication";
  /** 重复的那几味（组成身份名），自服药重复时另记自服药名。 */
  herbs: string[];
  selfMedication?: string;
};

type DecoctionHerb = { name: string; role?: string };
type SelfMedication = {
  name: string;
  identities: string[];
  /** 药名本身就是某味药（丹参滴丸→丹参）：说明书、方剂目录都查不到组成时，只能凭名字说它含这味药。 */
  namesake?: string[];
};

/**
 * 成药名以某味药命名（丹参滴丸、人参口服液）：药名主干的开头是知识库认得的药名，取最长的一个。
 * 只在组成查不到时当作「含这味药」的依据；调和药（甘草、大枣、生姜）不算。
 */
function namesakeHerbIdentities(name: string): string[] {
  const base = productNameStem(patentMedicineBaseName(String(name || "").normalize("NFKC").replace(/\s+/g, "")));
  for (let length = Math.min(4, base.length); length >= 2; length -= 1) {
    const head = base.slice(0, length);
    if (!isKnownTcmHerbName(head)) continue;
    const identity = textbookDistinctHerbKey(head);
    return identity && !HARMONIZING_ADJUNCTS.has(identity) ? [identity] : [];
  }
  return [];
}

/**
 * 病历里患者正在用的中成药及其组成：现病史里为这次病自服的（与注意事项「已自服的药」同一来源），
 * 加上病历写着正在服用的中成药（current_medications；西药查不到组成也不以药名为名，只能按同品判）。
 */
export function selfTakenMedicationCompositions(caseState: CaseState | undefined): SelfMedication[] {
  if (!caseState) return [];
  try {
    const required = requiredPrecautionsForCase(caseState);
    const own = required.flatMap((item): SelfMedication[] => item.kind === "self_medication"
      ? [{
        name: item.name,
        identities: [...new Set([
          ...patentMedicineCompositionIdentities(item.name),
          ...item.composition.map((herb) => textbookDistinctHerbKey(herb)).filter(Boolean),
        ])],
      }]
      : []);
    const taken = new Set(own.map((item) => patentMedicineBaseName(item.name)));
    const current = required.flatMap((item): SelfMedication[] => item.kind === "current_medications"
      ? item.names.filter((name) => !taken.has(patentMedicineBaseName(name))).map((name) => {
        const identities = patentMedicineCompositionIdentities(name);
        return { name, identities, ...(identities.length === 0 ? { namesake: namesakeHerbIdentities(name) } : {}) };
      })
      : []);
    return [...own, ...current];
  } catch {
    return [];
  }
}

/** 推荐的一行中成药与本方汤剂或患者自服药重复时给出依据；不重复、查不到组成、西药或「替代方案」时为 undefined。 */
export function patentMedicineDuplication(
  medicine: { type?: unknown; name?: unknown; positioning?: unknown; route?: unknown },
  decoctionHerbs: readonly DecoctionHerb[],
  selfMedications: readonly SelfMedication[] = [],
): PatentMedicineDuplication | undefined {
  if (medicine.type !== "中成药" || medicine.positioning === "替代方案") return undefined;
  // 外用的（软膏、洗液、贴膏）不与内服汤剂同吃，不算重复。
  if (/外/u.test(String(medicine.route || ""))) return undefined;
  const name = String(medicine.name || "").trim();
  if (!name) return undefined;
  const composition = new Set(patentMedicineCompositionIdentities(name));
  for (const self of selfMedications) {
    const selfBase = patentMedicineBaseName(self.name);
    const sameProduct = selfBase.length >= 2 && selfBase === patentMedicineBaseName(name);
    const shared = self.identities.filter((herb) => composition.has(herb) && !HARMONIZING_ADJUNCTS.has(herb));
    // 现用药只知道药名（说明书、方剂目录查不到组成）：以某味药命名的，推荐药的名字也点着这味药、成份里也有它，算同一味药吃两遍。
    const namesake = (self.namesake || []).filter((herb) => composition.has(herb) && name.includes(herb));
    if (sameProduct || shared.length >= 2 || namesake.length > 0) {
      return { reason: "self_medication", herbs: shared.length > 0 ? shared : namesake, selfMedication: self.name };
    }
  }
  if (composition.size === 0) return undefined;
  const herbs = decoctionHerbs
    .map((herb) => ({ identity: textbookDistinctHerbKey(String(herb.name || "")), role: herb.role }))
    .filter((herb) => herb.identity && !HARMONIZING_ADJUNCTS.has(herb.identity));
  const emperor = herbs.filter((herb) => herb.role === "君" && composition.has(herb.identity));
  if (emperor.length > 0) {
    return { reason: "decoction_emperor_herb", herbs: [...new Set(emperor.map((herb) => herb.identity))] };
  }
  const shared = [...new Set(herbs.filter((herb) => composition.has(herb.identity)).map((herb) => herb.identity))];
  return shared.length >= 2 ? { reason: "decoction_shared_herbs", herbs: shared } : undefined;
}

/**
 * 解热镇痛抗炎药只推荐一种（2026-10-19 留出例 S145：急性痛风同时推荐依托考昔、对乙酰氨基酚、布洛芬三种；
 * 独立评审：两种非甾体抗炎药并列、未注明二选一）。布洛芬、对乙酰氨基酚说明书写「不能同时服用其他含有解热镇痛药的药品」，
 * 依托考昔、布洛芬说明书写「其他非甾体（类）抗炎药」。
 * 不另立药理分类表，读说明书自己的话：说明书说到「其他非甾体抗炎药」「其他（含有）解热镇痛药」，这味药本身就属这一类
 *（「其他」指的是同类的别的药）。两种说法合为一类——对乙酰氨基酚与布洛芬说明书互相禁止同服。
 * 保留排在前面的那一行（规划器已按院内有货、与本例相关排序），其余同类行不推荐。读不到说明书文字的行不动。
 */
const ANALGESIC_CLASS_SELF_REFERENCE = /其他(?:含有)?(?:非甾体(?:类)?抗炎|解热[、，]?镇痛)/u;
export function analgesicClassMember(medicine: { type?: unknown; name?: unknown; riskNote?: unknown; usageBoundary?: unknown }): boolean {
  if (medicine.type !== "西药") return false;
  const label = findLocalPatentMedicineLabel(String(medicine.name || ""));
  const text = [medicine.riskNote, medicine.usageBoundary, label?.contraindication, label?.precaution, label?.interaction]
    .map((value) => String(value || "")).join("\n");
  return ANALGESIC_CLASS_SELF_REFERENCE.test(text);
}

export function withoutSameClassAnalgesics<T extends { type?: unknown; name?: unknown; route?: unknown; riskNote?: unknown; usageBoundary?: unknown }>(medicines: readonly T[]): T[] {
  // 全身用（口服、栓剂）与皮肤外用各留一种：外涂的双氯芬酸乳胶剂不挤掉口服的布洛芬（已存输出回放 H-tri-6727）。
  const kept = new Set<string>();
  return medicines.filter((medicine) => {
    if (!analgesicClassMember(medicine)) return true;
    const key = skinTopicalMedication(String(medicine.name || ""), String(medicine.route || "")) ? "skin" : "systemic";
    if (kept.has(key)) return false;
    kept.add(key);
    return true;
  });
}

/**
 * 同一种药的不同厂家说明书只推荐一行（2026-10-19 留出例 S145：「一枝篙伤湿祛痛膏」与「一枝蒿伤湿祛痛膏」同出一页）。
 * 按去剂型的药名比；「篙」是说明书药名里「蒿」的误写（一枝蒿为菊科植物，「一枝篙」不是另一种药），比较前换回。
 */
const MEDICINE_NAME_VARIANTS: ReadonlyArray<[RegExp, string]> = [[/篙/gu, "蒿"]];
export function withoutRepeatedMedicineNames<T extends { name?: unknown }>(medicines: readonly T[]): T[] {
  const seen = new Set<string>();
  return medicines.filter((medicine) => {
    let base = patentMedicineBaseName(String(medicine.name || ""));
    for (const [pattern, replacement] of MEDICINE_NAME_VARIANTS) base = base.replace(pattern, replacement);
    if (base.length < 2) return true;
    if (seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

/**
 * ───────── 同类药只留一个；方向与本例证候明确相反的不列（2026-10-19 第九轮 WP9-G，甲方 P1「中成药/西药推荐无矛盾」） ─────────
 *
 * M 集验收评审（模块 K）123/141 合格；18 例不合格里 9 例是同一页并列同类药，4 例药性方向与证候相反，1 例推荐栏与注意事项自相矛盾，
 * 1 例与现用药同成分（见 CLAUDE.md 10/19 一节）。第五轮的 withoutSameClassAnalgesics 只认说明书自我指涉的「其他非甾体抗炎药」，
 * 促胃肠动力药、渗透性泻药、两种外用止痛喷剂、两种湿疹膏都没有判据。判据不另写药名表，取三份受治理的材料：
 *
 *  · 西药：药理学分类（src/data/western-drug-pharmacology-class.json，医脉通用药参考 APP 的四级分类，由 scripts/build-western-drug-class.py 自
 *    药学基础数据生成）。共享四级分类（多潘立酮与甲氧氯普胺同为「胃肠动力药」，聚乙二醇4000与乳果糖同为「渗透作用的轻泻药」）判同类；
 *    只共享三级分类（塞来昔布「昔布类」与双氯芬酸「乙酸衍生物」同属「非甾体抗炎药和抗风湿药」）时，要两者的对应问题重合才判同类。
 *    每个药品在表里按剂型各有分类（双氯芬酸栓：抗炎和抗风湿药；双氯芬酸凝胶：局部用非甾体抗炎药；还挂着眼科、皮肤科的行），
 *    所以先按给药途径（全身/皮肤外用/五官）取各自那一套分类，口服的不拿眼科行去比。分类名以「其它/其他」开头的是兜底类，不当作药理类别。
 *  · 中成药：同一给药途径（内服/外用）且对应问题重合。「对应问题」用受治理的临床问题概念表（medicine-clinical-concepts）归一，
 *    一个药的问题概念全包含在另一个里才算同一问题（失眠、心悸与心悸、胸痹各有所专，不算）。用户口径：同一问题、同一给药途径只留一个，排序靠前的留下。
 *  · 现用药：见 patentMedicineDuplication 的 current_medications。
 *
 * 方向底线（只在明确相反时不列，数据缺口、虚实夹杂、寒热并见一律弃权）：
 *  · 只补不泻的内服成药 × 本例证名只有实邪、治法没有任何补润字样；
 *  · 只攻不补的内服成药 × 本例证名只有虚、治法没有任何攻邪字样；
 *  · 清热类内服成药 × 本例只有寒；温热类内服成药 × 本例只有热。成药的寒热取说明书功能清单（清热解毒、散寒…），
 *    功能写不出寒热时取成份里药味的中药学功效分类（清热药 / 温里药、补阳药、发散风寒药…，tcm-herb-function-categories）。
 *  · 外用药不判（它治局部，不随整体证候走）。
 * 实测（M、X、H 集 r19i 已存输出离线重放）：见 scripts/test-r1021-medicines.mjs 与 ~/runlogs/r1018/work/r1021/medicines/。
 */

type MedicineRow = { type?: unknown; name?: unknown; route?: unknown; correspondingProblem?: unknown };

type WesternClassTable = { classes: string[]; byProduct: Record<string, number[]>; byGeneric: Record<string, number[]> };
let westernClassTableCache: WesternClassTable | undefined;
function westernClassTable(): WesternClassTable {
  if (westernClassTableCache) return westernClassTableCache;
  try {
    // 与成份表同一读法：按 process.cwd()/src/data 懒加载，不打进代码包。
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "src", "data", "western-drug-pharmacology-class.json"), "utf8")) as Partial<WesternClassTable>;
    westernClassTableCache = {
      classes: Array.isArray(parsed.classes) ? parsed.classes : [],
      byProduct: parsed.byProduct && typeof parsed.byProduct === "object" ? parsed.byProduct : {},
      byGeneric: parsed.byGeneric && typeof parsed.byGeneric === "object" ? parsed.byGeneric : {},
    };
  } catch (error) {
    console.warn("[tcm-cdss:knowledge] western drug class table unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    westernClassTableCache = { classes: [], byProduct: {}, byGeneric: {} };
  }
  return westernClassTableCache;
}

/**
 * 药名在表里按全名（药品名称）或通用名（五级名称）登记。先查全名；查不到时从尾巴一个字一个字地削（片、胶囊、口服溶液…
 * 不用剂型词表），削到通用名为止（至少 3 个字，免得 2 个字的短名误中）。
 */
function westernDrugClassIndexes(name: string): number[] {
  const table = westernClassTable();
  const clean = String(name || "").normalize("NFKC").replace(/\s+/g, "");
  if (!clean) return [];
  const withoutParens = clean.replace(/[（(][^）)]*[）)]$/u, "");
  for (const key of [clean, withoutParens]) {
    if (table.byProduct[key]?.length) return table.byProduct[key];
  }
  for (let key = withoutParens.slice(0, -1); key.length >= 3; key = key.slice(0, -1)) {
    const hit = table.byGeneric[key] || table.byProduct[key];
    if (hit?.length) return hit;
  }
  return [];
}

export type MedicineRouteGroup = "systemic" | "skin" | "sensory";

export function medicineRouteGroup(name: unknown, route: unknown): MedicineRouteGroup {
  const text = `${String(name || "")} ${String(route || "")}`;
  if (medicineRouteIsSensory(text)) return "sensory";
  return medicineRouteIsExternal(String(route || "")) || skinTopicalMedication(String(name || ""), String(route || "")) ? "skin" : "systemic";
}

/** 该给药途径下药品的各条分类路径（一级>二级>三级>四级）。 */
function westernClassPaths(name: string, group: MedicineRouteGroup): string[] {
  const table = westernClassTable();
  return westernDrugClassIndexes(name).map((index) => table.classes[index]).filter((value): value is string => Boolean(value))
    .filter((classPath) => {
      const first = classPath.split(">")[0];
      if (group === "sensory") return first === "感觉器官用药";
      if (group === "skin") return first === "皮肤用药" || classPath.includes("局部用");
      return first !== "感觉器官用药" && first !== "皮肤用药" && !classPath.includes("局部用");
    });
}

const CATCH_ALL_CLASS_LABEL = /^(?:其它|其他)/u;
/** 取到第几级的分类前缀；该级是「其它…」兜底类时不是药理类别，按病原体选的抗感染类也不当药理类别合并，返回 undefined。 */
function classPrefix(classPath: string, levels: number): string | undefined {
  const parts = classPath.split(">");
  if (parts.length < levels || CATCH_ALL_CLASS_LABEL.test(parts[levels - 1] || "") || classIsPathogenSpecific(classPath)) return undefined;
  return parts.slice(0, levels).join(">");
}

/**
 * 一行推荐药的临床问题概念（受治理问题词表，问题轴）：病例侧写法命中的概念，加上概念名本身出现在对应问题里的
 * （规划器给本地候选写的对应问题就是概念名拼起来的；「心悸、胸痹」里的「胸痹」病例侧写法是冠心病、胸痛，字面不命中）。
 */
function problemConceptSet(row: MedicineRow): Set<string> {
  const text = String(row.correspondingProblem || "");
  const keys = new Set(matchingMedicineClinicalProblemTerms(text));
  for (const concept of MEDICINE_CLINICAL_CONCEPTS) {
    if (concept.axis === "problem" && text.includes(concept.key)) keys.add(concept.key);
  }
  return keys;
}

function sharesLongSubstring(left: string, right: string, length: number): boolean {
  const a = left.replace(/\s+/g, ""), b = right.replace(/\s+/g, "");
  for (let at = 0; at + length <= a.length; at += 1) {
    if (b.includes(a.slice(at, at + length))) return true;
  }
  return false;
}

/**
 * 两行推荐药说的是不是同一个问题：问题概念全包含（较少的一边是较多一边的子集）。任一边抽不出概念时，
 * 退到对应问题文字有 4 字以上的公共片段；都没有则不当同一问题。
 */
export function medicineProblemsOverlap(left: MedicineRow, right: MedicineRow): boolean {
  const a = problemConceptSet(left), b = problemConceptSet(right);
  if (a.size > 0 && b.size > 0) {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    return [...small].every((key) => large.has(key));
  }
  return sharesLongSubstring(String(left.correspondingProblem || ""), String(right.correspondingProblem || ""), 4);
}

function westernMedicinesSameClass(left: MedicineRow & Parameters<typeof analgesicClassMember>[0], right: MedicineRow & Parameters<typeof analgesicClassMember>[0]): boolean {
  const group = medicineRouteGroup(left.name, left.route);
  if (group !== medicineRouteGroup(right.name, right.route)) return false;
  const a = westernClassPaths(String(left.name || ""), group), b = westernClassPaths(String(right.name || ""), group);
  const sharedPharmacologicalClass = a.some((classPath) => {
    const prefix = classPrefix(classPath, 4);
    return Boolean(prefix) && b.some((other) => classPrefix(other, 4) === prefix);
  });
  if (sharedPharmacologicalClass) return true;
  const subgroupA = new Set(a.map((classPath) => classPrefix(classPath, 3)).filter((value): value is string => Boolean(value)));
  if (b.some((classPath) => { const prefix = classPrefix(classPath, 3); return Boolean(prefix) && subgroupA.has(prefix!); }) &&
      medicineProblemsOverlap(left, right)) return true;
  // 说明书自己写明「其他非甾体抗炎药」「其他解热镇痛药」的（第五轮判据，分类表里没有该药时仍然有效）。
  return analgesicClassMember(left) && analgesicClassMember(right);
}

/**
 * 同类药只留一个：排在前面的留下，后面同一给药途径、同一问题（中成药），或同一药理类别（西药）的不再推荐。
 * 中成药与西药互不比较。不动行内容，只删。
 */
export function withoutSameClassMedicines<T extends MedicineRow & Parameters<typeof analgesicClassMember>[0]>(medicines: readonly T[]): T[] {
  const kept: T[] = [];
  for (const medicine of medicines) {
    const duplicate = kept.some((earlier) => {
      if (earlier.type !== medicine.type) return false;
      if (medicine.type === "西药") return westernMedicinesSameClass(earlier, medicine);
      if (medicine.type === "中成药") {
        return medicineRouteGroup(earlier.name, earlier.route) === medicineRouteGroup(medicine.name, medicine.route) &&
          medicineProblemsOverlap(earlier, medicine);
      }
      return false;
    });
    if (!duplicate) kept.push(medicine);
  }
  return kept;
}

export { signedDirectionOf };
export type { MedicineDirectionConflict, SignedDirection };

/**
 * 内服中成药的方向与已签名证候明确相反时返回原因码，否则 undefined（判据与词表见 local-patent-medicine-candidates 的
 * patentMedicineDirectionConflict）。外用药、西药、说明书与成份都查不到的药一律不判。
 */
export function patentMedicineOpposesSignedDirection(
  medicine: MedicineRow,
  direction: SignedDirection | undefined,
): MedicineDirectionConflict | undefined {
  if (!direction || medicine.type !== "中成药") return undefined;
  const name = String(medicine.name || "").trim();
  if (!name || medicineRouteGroup(name, medicine.route) !== "systemic") return undefined;
  const indication = findLocalPatentMedicineLabel(name)?.indication || "";
  return patentMedicineDirectionConflict({
    clause: medicineFunctionClause(indication),
    herbs: patentMedicineCompositionIdentities(name),
    indication,
  }, direction);
}

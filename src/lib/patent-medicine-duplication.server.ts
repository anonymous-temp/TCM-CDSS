import { readFileSync } from "node:fs";
import path from "node:path";
import type { CaseState } from "./diagnosis-types";
import { findLocalPatentMedicineLabel, patentMedicineBaseName } from "./local-patent-medicine-candidates";
import { requiredPrecautionsForCase } from "./required-precautions.server";
import { textbookDistinctHerbKey } from "./herb-textbook-identity";
import { catalogSharedComposition } from "./tcm-formula-provenance";
import { isKnownTcmHerbName } from "./tcm-knowledge";

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
 *  · 定位为「替代方案」的不删：它是写给不便煎药时换用的，不与汤剂同服（同组成的丸剂替代汤剂正是常规做法）；
 *    外用的（说明书用法为外用）不删：不与内服汤剂同吃。
 *  · 组成查不到的中成药不删（只能判有，不能凭名字猜）；西药不在此列。
 * 只删不改：留下的行原样，删光了就是空数组（页面本来就会说明没有合适的成药）。
 */

const COMPOSITION_FILE = "local-patent-medicine-composition.json";
/** 调和、矫味之品：几乎每张方都有，不作重复的证据。 */
const HARMONIZING_ADJUNCTS = new Set(["甘草", "大枣", "生姜"]);

let compositionEntries: Record<string, { ingredients?: string[] }> | undefined;
function compositionTable(): Record<string, { ingredients?: string[] }> {
  if (compositionEntries) return compositionEntries;
  try {
    // 按 process.cwd()/src/data 懒加载，不打进代码包（与处方中成药说明书目录同一读法）。
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "src", "data", COMPOSITION_FILE), "utf8")) as {
      entries?: Record<string, { ingredients?: string[] }>;
    };
    compositionEntries = parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch (error) {
    console.warn("[tcm-cdss:knowledge] patent medicine composition table unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    compositionEntries = {};
  }
  return compositionEntries;
}

/**
 * 说明书成份里的一味药 → 判重复用的药名键。知识库不认得的写法（「酒女贞子」「麸炒白术」）去掉开头一两个字后再试，
 * 余下部分是知识库认得的药名才算；仍认不得的（盐酸小檗碱、人参须）不计。
 */
function ingredientIdentity(raw: string): string | undefined {
  const token = String(raw || "").normalize("NFKC").replace(/\s+/g, "").replace(/^灸/, "炙");
  if (token.length < 2) return undefined;
  if (isKnownTcmHerbName(token)) return textbookDistinctHerbKey(token) || undefined;
  for (const cut of [1, 2]) {
    const rest = token.slice(cut);
    if (rest.length >= 2 && isKnownTcmHerbName(rest)) return textbookDistinctHerbKey(rest) || undefined;
  }
  return undefined;
}

/** 中成药的组成（判重复用的药名键，去重）。说明书成份优先，其次方剂目录；都查不到时为空。 */
export function patentMedicineCompositionIdentities(name: string): string[] {
  const clean = String(name || "").normalize("NFKC").replace(/\s+/g, "");
  if (!clean) return [];
  const table = compositionTable();
  const labelName = table[clean] ? clean : findLocalPatentMedicineLabel(clean)?.name;
  const ingredients = (labelName && table[labelName]?.ingredients) || [];
  const fromLabel = ingredients.map(ingredientIdentity).filter((item): item is string => Boolean(item));
  const identities = fromLabel.length > 0
    ? fromLabel
    : catalogSharedComposition(clean).map((item) => textbookDistinctHerbKey(item)).filter(Boolean);
  return [...new Set(identities)];
}

export type PatentMedicineDuplication = {
  reason: "decoction_emperor_herb" | "decoction_shared_herbs" | "self_medication";
  /** 重复的那几味（组成身份名），自服药重复时另记自服药名。 */
  herbs: string[];
  selfMedication?: string;
};

type DecoctionHerb = { name: string; role?: string };
type SelfMedication = { name: string; identities: string[] };

/** 现病史里患者自服的药及其组成（与注意事项「已自服的药」同一来源）。 */
export function selfTakenMedicationCompositions(caseState: CaseState | undefined): SelfMedication[] {
  if (!caseState) return [];
  try {
    return requiredPrecautionsForCase(caseState).flatMap((item) => item.kind === "self_medication"
      ? [{
        name: item.name,
        identities: [...new Set([
          ...patentMedicineCompositionIdentities(item.name),
          ...item.composition.map((herb) => textbookDistinctHerbKey(herb)).filter(Boolean),
        ])],
      }]
      : []);
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
    if (sameProduct || shared.length >= 2) return { reason: "self_medication", herbs: shared, selfMedication: self.name };
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

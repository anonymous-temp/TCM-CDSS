import { selfTakenMedicationMentions } from "./clinical-polarity";
import { assessLactationState, recentChildbirthMentioned } from "./clinical-state";
import { clinicalGroundingText, reproductiveAdviceRelevant } from "./diagnosis-safety";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  findLocalPatentMedicineLabel,
  localPrescriptionPatentMedicineEntries,
  patentMedicineBaseName,
  type LocalPatentMedicineEntry,
} from "./local-patent-medicine-candidates";
import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { catalogSharedComposition } from "./tcm-formula-provenance";
import type { RequiredPrecaution } from "./required-precautions";

export type { RequiredPrecaution } from "./required-precautions";

const OTC_ENTRIES = (localMedicineIndex as { entries?: LocalPatentMedicineEntry[] }).entries || [];

/** 现病史（本次发病的经过）：自服药只从这里取——既往史里长期服用的药另有通用提示，不逐个要求。 */
function presentIllnessText(state: CaseState): string {
  const symptoms = state.symptoms as unknown;
  if (typeof symptoms === "string") return symptoms;
  const present = (symptoms as { presentHistory?: unknown } | undefined)?.presentHistory;
  if (typeof present === "string" && present.trim()) return present;
  return state.hisRecord?.fields?.xianbingshi || "";
}

const alcoholWarningMemo = new Map<string, boolean>();
/**
 * 本地说明书目录里有没有说明书写着「该药 + 双硫仑 / 戒酒」（同一句）。甲硝唑自己的片剂说明书不在目录里，
 * 但含酒精制剂的说明书（藿香正气水等）写明「乙醇与……甲硝唑、替硝唑……联合使用，可出现双硫仑样反应」。
 */
function labelAlcoholWarning(base: string): boolean {
  if (base.length < 2) return false;
  const cached = alcoholWarningMemo.get(base);
  if (cached !== undefined) return cached;
  const found = [OTC_ENTRIES, localPrescriptionPatentMedicineEntries()].some((entries) => entries.some((entry) =>
    [entry.contraindication, entry.precaution, entry.interaction, entry.adverseReaction]
      .join("。")
      .split(/[。；;]/)
      .some((sentence) => sentence.includes(base) && /双硫仑|戒酒/.test(sentence))));
  alcoholWarningMemo.set(base, found);
  return found;
}

/**
 * 由病历与已签名的辨证结果算出本例注意事项必须写到的项目（顺序即重要性）。
 *  · 现病史里患者为这次的病自服过的药（说明书目录或方剂目录认得的，最多两种）；
 *  · 一年内分娩、哺乳情况没有记录的女性；
 *  · 丹毒、蜂窝织炎：《中西医结合外科学》「全身应用抗生素，如青霉素、头孢菌素类」，IDSA 2014 同样以抗链球菌抗菌药为首选。
 */
export function requiredPrecautionsForCase(
  state: CaseState,
  prior?: ClinicalReasoningResultV2 | null,
): RequiredPrecaution[] {
  const items: RequiredPrecaution[] = [];
  for (const name of selfTakenMedicationMentions(presentIllnessText(state))) {
    // 名字得像药名：带剂型（丸、片、胶囊…），或与说明书目录里的药名一字不差。只靠去剂型的基础名对上的不算——
    //「吃山楂后」的山楂会对上山楂丸。
    const label = findLocalPatentMedicineLabel(name);
    const hasDosageForm = patentMedicineBaseName(name) !== name;
    if (!hasDosageForm && label?.name.replace(/\s/g, "") !== name) continue;
    const composition = catalogSharedComposition(name);
    if (composition.length === 0 && !label) continue;
    const base = patentMedicineBaseName(name);
    if (base.length < 2 || items.some((item) => item.kind === "self_medication" && item.base === base)) continue;
    items.push({ kind: "self_medication", name, base, composition, alcoholWarning: labelAlcoholWarning(base) });
    if (items.length >= 2) break;
  }
  const grounding = clinicalGroundingText(state);
  if (reproductiveAdviceRelevant(state) && recentChildbirthMentioned(grounding) && assessLactationState(grounding).status === "unknown") {
    items.push({ kind: "postpartum_lactation" });
  }
  const disease = [prior?.westernDiagnosis?.primary?.name, prior?.overview?.tcmDiseaseName]
    .map((value) => String(value || ""))
    .map((value) => value.match(/丹毒|蜂窝织炎/)?.[0])
    .find(Boolean);
  if (disease) items.push({ kind: "skin_infection_antibiotic", disease });
  return items;
}

/** 给 M04 模型的一段话：逐项列出本例必须写到的注意事项，模型按本例写，服务端事后逐项核对。 */
export function requiredPrecautionsPromptSection(items: readonly RequiredPrecaution[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item, index) => {
    const order = `${index + 1}.`;
    if (item.kind === "self_medication") {
      const parts = [`病历记录患者已自服${item.name}`];
      if (item.composition.length > 0) parts.push(`（方剂目录组成含${item.composition.join("、")}）：写明它与本方处方里都有的药（只列你开的处方里也有的那几味）、服本方期间是否停服及原因`);
      else parts.push("：写明服本方期间是否继续服用由医生决定");
      if (item.alcoholWarning) parts.push(`；并写明服用${item.base}期间须戒酒（说明书：与酒同用可出现双硫仑样反应）`);
      return `${order}${parts.join("")}。`;
    }
    if (item.kind === "postpartum_lactation") {
      return `${order}患者一年内分娩、哺乳情况未记录：写明如正在哺乳须先告知医生，方中哺乳期慎用或回乳的药（如大黄、麦芽）点名说明。`;
    }
    return `${order}${item.disease}是细菌感染：写明须到医院由医生决定抗菌药物治疗，以及寒战高热、红肿迅速扩大等须立即就医的表现。`;
  });
  return `【本例注意事项必须写到】以下各项在 nonPharma.precautions 里各写一条，排在最前，不计入条数上限：\n${lines.join("\n")}`;
}

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

/** 病历里的年龄（岁；「8个月」按月折算）。读不出时为 undefined。 */
function patientAgeYears(state: CaseState): number | undefined {
  const raw = (state.patient as { age?: unknown } | undefined)?.age ?? state.hisRecord?.fields?.age;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 130) return raw;
  if (typeof raw !== "string") return undefined;
  const years = raw.match(/(\d+(?:\.\d+)?)\s*岁/)?.[1] ?? raw.match(/^\s*(\d+(?:\.\d+)?)\s*$/)?.[1];
  if (years != null) return Number(years);
  const months = raw.match(/(\d+(?:\.\d+)?)\s*(?:个)?月/)?.[1];
  return months != null ? Number(months) / 12 : undefined;
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
  // 年龄相关的服药注意：提示词一直要求「75 岁以上高龄或 6 岁以下幼儿写一条」，模型时写时漏（2026-10-17 留出集 4 例患儿没有）。
  // 儿童取未满 12 岁——儿科剂量按年龄折算的年龄段（pediatric-dose-rule），这些孩子的家长都需要这一句。
  const age = patientAgeYears(state);
  if (age != null && age < 12) items.push({ kind: "pediatric_administration", ageYears: age });
  else if (age != null && age >= 65) items.push({ kind: "elderly_administration", ageYears: age });
  // 正在服用的药（2026-10-18 验收主集：泼尼松、酮替芬、氨氯地平、抗生素等病历写明在服，注意事项一句没提，评审判缺）。
  // 与自服药同一套认药名的办法（带剂型或说明书目录一字不差），整份病历都看；已列为自服药的不重复。
  const selfTaken = new Set(items.flatMap((item) => item.kind === "self_medication" ? [item.base] : []));
  const grounded = clinicalGroundingText(state);
  const formallyTaken = new Set(formallyAdministeredMedicationMentions(grounded));
  const current = [...new Set(selfTakenMedicationMentions(grounded)
    .filter((name) => {
      // 西药（卡托普利、拜新同、二甲双胍、阿司匹林…）既不带剂型也不在中成药说明书目录里（2026-10-18 验收主集 J 模块 11 例漏写）：
      // 跟在「服用/口服/注射/吸入/含服」这类正式给药词后面、不是已停或既往的，也算正在用的药。「吃」后面的不算（山楂、水果）。
      if (formallyTaken.has(name)) return true;
      const label = findLocalPatentMedicineLabel(name);
      return patentMedicineBaseName(name) !== name || label?.name.replace(/\s/g, "") === name;
    })
    .filter((name) => !selfTaken.has(patentMedicineBaseName(name))))].slice(0, 3);
  if (current.length > 0) items.push({ kind: "current_medications", names: current });
  return items;
}

const FORMAL_ADMINISTRATION_VERB = /(?:服用|口服|皮下注射|静脉注射|肌内注射|注射|吸入|含服)/u;
const STOPPED_OR_PAST_MEDICATION = /(?:曾|既往|此前|以前|已停|停用|停药|自行停|未再|不再)/u;
const GENERIC_MEDICATION_WORD = /^(?:中|西|汤|成|草)?药(?:物|品)?$|^中成药$|^降[压糖脂]药$/u;

/** 跟在正式给药词后面、当前在用的药名（只用于「正在服用的药」这一条注意事项）。 */
function formallyAdministeredMedicationMentions(text: string): string[] {
  return String(text || "").normalize("NFKC").split(/[，,。；;\n]+/u).flatMap((clause) => {
    if (!FORMAL_ADMINISTRATION_VERB.test(clause) || STOPPED_OR_PAST_MEDICATION.test(clause)) return [];
    return selfTakenMedicationMentions(clause).filter((name) => !GENERIC_MEDICATION_WORD.test(name) && /[\u4e00-\u9fffA-Za-z]{2,}/u.test(name));
  });
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
    if (item.kind === "pediatric_administration") return `${order}患儿${item.ageYears < 1 ? `${Math.max(1, Math.round(item.ageYears * 12))}个月` : `${Math.floor(item.ageYears)}岁`}：写一条给家长的服药方法（少量多次、分次喂服，不要强灌，不自行加量）。`;
    if (item.kind === "elderly_administration") return `${order}患者${Math.floor(item.ageYears)}岁：写一条与年龄相关的服药注意（如起身宜缓、防跌倒）。`;
    if (item.kind === "current_medications") return `${order}病历记录患者正在服用${item.names.join("、")}：写一条它与本方一起服用时要注意的事（告知医生、不要自行停用，中西药间隔服用；与本方有明确相互作用的写出来）。`;
    return `${order}${item.disease}是细菌感染：写明须到医院由医生决定抗菌药物治疗，以及寒战高热、红肿迅速扩大等须立即就医的表现。`;
  });
  return `【本例注意事项必须写到】以下各项在 nonPharma.precautions 里各写一条，排在最前，不计入条数上限：\n${lines.join("\n")}`;
}

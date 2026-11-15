import { diseaseCareItemsForName } from "./western-disease-care";
import { cleanedMedicationNameCandidate, medicationHistoryItemCandidate, MEDICATION_HISTORY_CLASS_WORD, recordedDrugAllergyPhrases, currentMensesOverdue, splitMedicationList, formallyAdministeredMedicationMentions, medicationOnlyPastMentions, MEDICATION_STILL_TAKING, medicationNotTaken, medicationStopped, medicationStoppedInNextSentence, medicationTimelineStatuses, recordedMedicationMentions, recordedMobilityLimitation, recordedSystemicTherapyClasses, recordsAlcoholUse, selfDiscontinuedMedication, selfPreparedMedicationSentence, selfTakenMedicationMentions } from "./clinical-polarity";
import { assessLactationState, assessPregnancyState, conceptionWithoutPregnancyOrLactation, recentChildbirthMentioned } from "./clinical-state";
import drugConditionJson from "../data/western-drug-condition-cautions.source.json";
import { authoritativePatientAgeYears, sourceDocumentsNegation, clauseLocalMentionPolarityAt, highRiskConditionsForPrecautions, recordedMedicationHistoryList, ANTITHROMBOTIC_MEDICATION, CORTICOSTEROID_MEDICATION, IMMUNOSUPPRESSIVE_MEDICATION, antithromboticIndicationRecorded, clinicalGroundingText, currentVitalMeasurements, derivePrescriptionPermission, diabetesDiagnosisConfirmed, diabetesRecorded, pregnancyAdviceRelevant, pregnancyPainOrBleedingSignal, reproductiveAdviceRelevant, severeHypertensionTargetOrganSign } from "./diagnosis-safety";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  findLocalPatentMedicineLabel,
  labelledMedicineNamesIn,
  localPrescriptionPatentMedicineEntries,
  patentMedicineBaseName,
  type LocalPatentMedicineEntry,
} from "./local-patent-medicine-candidates";
import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { catalogSharedComposition } from "./tcm-formula-provenance";
import { getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } from "./tcm-knowledge";
import { dietRestrictionForSyndromeText, recordedTriggerFoods } from "./tcm-therapy-phrasing";
import { discontinuedMedicationLabel, highRiskConditionPromptText, type RequiredPrecaution } from "./required-precautions";
import { westernDrugNameIn } from "./western-drug-lexicon.server";
import { allergenAvoidPhrase, allergenStatedInRecord, allergensFromScreen, mergeRecordedAllergens, recordedAllergensInText } from "./allergen-profile";

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

type DrugConditionTable = {
  rules: Array<{ id: string; drugTerms: string[]; sentence: string; condition: { egfrBelow?: number; ckdStageAtLeast?: number; recordTerms?: string[]; recordedDrugAllergy?: string[]; reactionTerms?: string[] } }>;
  warfarinHerbal?: { drugTerms: string[]; decreaseHerbs: string[] };
  notMedicationFoods?: { foods: string[] };
};
const DRUG_CONDITION = drugConditionJson as unknown as DrugConditionTable;
const WARFARIN_HERBAL = { drugTerms: DRUG_CONDITION.warfarinHerbal?.drugTerms || [], decreaseHerbs: DRUG_CONDITION.warfarinHerbal?.decreaseHerbs || [] };
const NOT_MEDICATION_FOODS = new Set(DRUG_CONDITION.notMedicationFoods?.foods || []);

/** 病历里的 eGFR 数值（「eGFR 17ml/(min·1.73m²)」「eGFR：45」；数值阈值，取最小的一个）。 */
export function recordedEgfr(text: string): number | undefined {
  const values = [...String(text || "").normalize("NFKC").matchAll(/eGFR\s*[:：为]?\s*(\d+(?:\.\d+)?)/giu)].map((match) => Number(match[1])).filter((value) => value > 0 && value < 200);
  return values.length > 0 ? Math.min(...values) : undefined;
}
/** 病历写的慢性肾病分期（「慢性肾病3期」「慢性肾脏病4期」；数值）。 */
function recordedCkdStage(text: string): number | undefined {
  const stages = [...String(text || "").normalize("NFKC").matchAll(/慢性肾(?:脏)?病\s*(?:CKD)?\s*([1-5一二三四五])\s*期/giu)]
    .map((match) => "一二三四五".includes(match[1]) ? "一二三四五".indexOf(match[1]) + 1 : Number(match[1]));
  return stages.length > 0 ? Math.max(...stages) : undefined;
}

/**
 * 在用药与本例已记录病情相抵（第四十六轮）：药名命中规则的药，病历满足规则的条件（eGFR 低于阈值、慢性肾病分期、病历肯定写着的病情词、
 * 记录的药物过敏原文里点了阿司匹林且有哮喘一类反应）时，返回给患者的那一句。规则与出处见 western-drug-condition-cautions.source.json。纯函数，供测试。
 */
export function drugConditionCautions(names: readonly string[], grounding: string, drugAllergyPhrases: readonly string[]): Array<Extract<RequiredPrecaution, { kind: "drug_condition_caution" }>> {
  const out: Array<Extract<RequiredPrecaution, { kind: "drug_condition_caution" }>> = [];
  const egfr = recordedEgfr(grounding);
  const ckdStage = recordedCkdStage(grounding);
  const affirmed = (term: string) => grounding.includes(term) && !sourceDocumentsNegation(grounding, term);
  for (const name of names) {
    if (out.some((item) => item.drug === name)) continue;
    for (const rule of DRUG_CONDITION.rules) {
      if (!rule.drugTerms.some((term) => name.includes(term))) continue;
      const condition = rule.condition;
      const byEgfr = condition.egfrBelow != null && egfr != null && egfr < condition.egfrBelow;
      const byStage = condition.ckdStageAtLeast != null && ckdStage != null && ckdStage >= condition.ckdStageAtLeast;
      const byTerms = (condition.recordTerms || []).some(affirmed);
      const allergy = (condition.recordedDrugAllergy || []).length > 0
        ? drugAllergyPhrases.find((phrase) => (condition.recordedDrugAllergy || []).some((term) => phrase.includes(term)) && (condition.reactionTerms || []).some((term) => phrase.includes(term)))
        : undefined;
      if (!byEgfr && !byStage && !byTerms && !allergy) continue;
      const hit = allergy ? (condition.reactionTerms || []).find((term) => allergy.includes(term)) : undefined;
      const reaction = !hit ? "过敏反应" : hit === "喘" ? "喘息" : hit === "过敏" ? "过敏反应" : hit;
      out.push({
        kind: "drug_condition_caution",
        ruleId: rule.id,
        drug: name,
        sentence: rule.sentence.replace("{drug}", name).replace("{egfr}", egfr != null ? String(egfr) : "").replace("{reaction}", reaction),
      });
      break;
    }
  }
  return out;
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

/** 病历里自行配制的药中，知识库标注有毒的药味（逐位最长匹配药名）。 */
function toxicSelfPreparedHerbs(text: string): string[] {
  const herbs: string[] = [];
  for (const sentence of text.normalize("NFKC").split(/[。；;\n]+/u)) {
    if (!selfPreparedMedicationSentence(sentence)) continue;
    for (let at = 0; at < sentence.length; at += 1) {
      for (let length = 4; length >= 2; length -= 1) {
        const name = sentence.slice(at, at + length);
        if (name.length < length || !isKnownTcmHerbName(name)) continue;
        if (getTcmHerbGenerationSafetyProfile(name).toxicity.length > 0 && !herbs.includes(name)) herbs.push(name);
        at += length - 1;
        break;
      }
    }
  }
  return herbs.slice(0, 4);
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
  items.push(...diseaseCareItemsForName(prior?.westernDiagnosis?.primary?.name || "", state.safetyGate?.status === "red_flag"));
  // 红旗未解除或不给剂量的页面只有药味与方义：不写怎么服（年龄相关的服药方法、与中药间隔服用）。
  // 给不给剂量按开方阶段同一个判据（derivePrescriptionPermission）：安全门的 allowDosePrescription 在信息待补的病例里也是 false，
  // 而这些病例照常按有限剂量出方——此前按它判，留出集 S158/S160 两个患儿没有儿童服药一条，多数病例也没有服法一条（2026-10-19）。
  const redFlag = state.safetyGate?.status === "red_flag";
  const doseAllowed = !redFlag && ["full_dose", "limited_dose"].includes(derivePrescriptionPermission(state).candidateMode);
  // 重度高血压而无急性靶器官表现（2017 ACC/AHA、ACEP：尽快门诊复测并调整降压，不是急诊）：安全门只给医生看的提示，
  // 写给患者的那句在这里（2026-10-19）。伴靶器官表现的是红旗，处置另有横幅。
  const bp = currentVitalMeasurements(state).bloodPressure;
  if (bp && (bp.systolic >= 180 || bp.diastolic >= 120) && !severeHypertensionTargetOrganSign(state)) {
    items.push({ kind: "severe_hypertension_followup", reading: `${bp.systolic}/${bp.diastolic}mmHg` });
  }
  // 自行配制的有毒药（乌头类泡酒最常见）排在最前：这一条关乎眼下的安全。
  const toxicSelfPrepared = toxicSelfPreparedHerbs(clinicalGroundingText(state));
  if (toxicSelfPrepared.length > 0) items.push({ kind: "toxic_self_preparation", herbs: toxicSelfPrepared });
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
  if (assessLactationState(grounding).status === "positive" && pregnancyAdviceRelevant(state)) {
    items.push({ kind: "postpartum_lactation", confirmed: true });
  } else if (reproductiveAdviceRelevant(state) && recentChildbirthMentioned(grounding) && assessLactationState(grounding).status === "unknown") {
    items.push({ kind: "postpartum_lactation" });
  }
  const disease = [prior?.westernDiagnosis?.primary?.name, prior?.overview?.tcmDiseaseName]
    .map((value) => String(value || ""))
    .map((value) => value.match(/丹毒|蜂窝织炎/)?.[0])
    .find(Boolean);
  if (disease) items.push({ kind: "skin_infection_antibiotic", disease });
  // 带状疱疹（甲方标准病历 8，2026-10-18 复评：58 岁、发疹 3 天水疱仍在增多、外用阿昔洛韦乳膏效果不佳，注意事项没提系统抗病毒）。
  // 《中国带状疱疹诊疗专家共识（2022 版）》与国际指南：发疹 72 小时内开始系统抗病毒；仍有新水疱、50 岁以上、累及眼耳者也应尽早。
  if ([prior?.westernDiagnosis?.primary?.name, prior?.overview?.tcmDiseaseName].some((value) => /带状疱疹|蛇串疮/u.test(String(value || "")))) {
    items.push({ kind: "herpes_zoster_antiviral" });
  }
  // 痛风（《中国高尿酸血症与痛风诊疗指南》2019：限制高嘌呤食物与酒精尤其啤酒、多饮水）。
  if ([prior?.westernDiagnosis?.primary?.name, prior?.overview?.tcmDiseaseName].some((value) => /痛风/u.test(String(value || "")))) {
    items.push({ kind: "gout_diet" });
  }
  const triggerFoods = recordedTriggerFoods(presentIllnessText(state));
  if (triggerFoods.length > 0) items.push({ kind: "trigger_foods", foods: triggerFoods });
  // 备孕/未避孕（2026-10-14 起照常给剂量、慎用药逐味标注）：注意事项要写一句服药期间月经逾期先验孕（留出集 S102 评审判缺）。
  const drugAllergy = recordedDrugAllergyPhrases(grounding);
  if (drugAllergy.length > 0) items.push({ kind: "drug_allergy", phrases: drugAllergy });
  // 食物等过敏：病历闭集读法 ∪ 读病历小任务的结果（事实层里带着），一份档案，饮食、食疗、饮片、中成药都对照它（第二十一轮，B061）。
  const allergens = mergeRecordedAllergens(
    recordedAllergensInText(grounding, clauseLocalMentionPolarityAt),
    allergensFromScreen(state.clinicalFacts?.discriminatorScreen?.status === "checked" ? state.clinicalFacts.discriminatorScreen.present : undefined),
  );
  if (allergens.length > 0) items.push({ kind: "food_allergy", classes: allergens });
  if (conceptionWithoutPregnancyOrLactation(grounding, authoritativePatientAgeYears(state))) {
    // 备孕/未避孕的也先看本次：停经伴腹痛或阴道出血、已按早孕/异位妊娠急症转诊的不再写「如月经逾期请先验孕」（第四十六轮 new45-n17：
    // 末次月经逾期、疑异位妊娠破裂，仍写「备孕期间服药，如月经逾期请先验孕」）；本次月经已逾期的写成先验孕（与下面同一判据）。
    // 红旗未解除而本次月经已逾期的（急诊会查血 hCG 与超声）同样不写。
    const overdue = currentMensesOverdue(grounding);
    if (!pregnancyPainOrBleedingSignal(state, grounding) && !(overdue && redFlag)) {
      items.push({ kind: overdue ? "menses_overdue_pregnancy_check" : "conception_pregnancy_check" });
    }
  } else if (pregnancyAdviceRelevant(state) && assessPregnancyState(grounding).status === "unknown" &&
    assessLactationState(grounding).status === "unknown" && !recentChildbirthMentioned(grounding)) {
    // 本次月经逾期未至的（停经本身不算可疑妊娠——闭经、多囊不能一概收回剂量，见 assessPregnancyState），
    // 那一句写成先验孕，比「如已怀孕请告知」更具体（2026-10-19 Claude 评审 M 集 RobustSDT-0697：末次月经 10/21 至今未至、脉滑）。
    // 停经伴腹痛或阴道出血、已按早孕/异位妊娠急症转诊的（pregnancyPainOrBleedingSignal，与闸门产科红旗、24 小时早孕评估通道同一判据），
    // 复诊已写到急诊做血 hCG 与超声，不再另写「服药前请先验孕」（第四十轮，11.05 病历17 停经45天、右下腹撕裂样痛、诊断异位妊娠）。
    if (!pregnancyPainOrBleedingSignal(state, grounding)) {
      items.push({ kind: currentMensesOverdue(grounding) ? "menses_overdue_pregnancy_check" : "reproductive_status_unknown" });
    }
  }
  // 年龄相关的服药注意：提示词一直要求「75 岁以上高龄或 6 岁以下幼儿写一条」，模型时写时漏（2026-10-17 留出集 4 例患儿没有）。
  // 儿童取未满 12 岁——儿科剂量按年龄折算的年龄段（pediatric-dose-rule），这些孩子的家长都需要这一句。
  const age = patientAgeYears(state);
  // 12–13 岁仍属儿科（《中医儿科学》0–14 岁）：同一项，规则句按年龄换成适合大孩子的说法（验收主集 13 岁例评审判缺）。
  if (doseAllowed && age != null && age < 14) items.push({ kind: "pediatric_administration", ageYears: age });
  else if (doseAllowed && age != null && age >= 65) items.push({ kind: "elderly_administration", ageYears: age });
  // 自行停了长期用药（降压药最常见）：写一条由医生评估后规律服用，红旗页也写——停药常是这次急症的诱因（留出集 S178）。
  const discontinued = selfDiscontinuedMedication(clinicalGroundingText(state));
  if (discontinued) items.push({ kind: "self_discontinued_medication", names: discontinued.names, ...(discontinued.condition ? { condition: discontinued.condition } : {}), ...(discontinued.irregular ? { irregular: true as const } : {}) });
  // 正在服用的药（2026-10-18 验收主集：泼尼松、酮替芬、氨氯地平、抗生素等病历写明在服，注意事项一句没提，评审判缺）。
  // 与自服药同一套认药名的办法（带剂型或说明书目录一字不差），整份病历都看；已列为自服药的不重复。
  const selfTaken = new Set(items.flatMap((item) => item.kind === "self_medication" ? [item.base] : []));
  const grounded = clinicalGroundingText(state);
  const formallyTaken = new Set(formallyAdministeredMedicationMentions(grounded).flatMap((name) => splitMedicationList(name)).map((name) => cleanedMedicationNameCandidate(name)).filter(Boolean));
  // 引号里整串列举（「平素服用“拜阿司匹林、倍他乐克缓释片、盐酸二甲双胍”等药物」）先拆开、按药名候选收一道，再去和下面那条路去重：
  // 此前整串留在这里，下面那条路取到的三个药都被当成它的一部分去掉了，清理时整串又因过长被丢，三个药一个不剩（M 集 TCM-SD-432116）。
  const current = [...new Set(selfTakenMedicationMentions(grounded).flatMap((name) => splitMedicationList(name)).map((name) => cleanedMedicationNameCandidate(name)).filter(Boolean)
    .filter((name) => {
      // 西药（卡托普利、拜新同、二甲双胍、阿司匹林…）既不带剂型也不在中成药说明书目录里（2026-10-18 验收主集 J 模块 11 例漏写）：
      // 跟在「服用/口服/注射/吸入/含服」这类正式给药词后面、不是已停或既往的，也算正在用的药。「吃」后面的不算（山楂、水果）。
      if (formallyTaken.has(name)) return true;
      const label = findLocalPatentMedicineLabel(name);
      return patentMedicineBaseName(name) !== name || label?.name.replace(/\s/g, "") === name;
    })
    .filter((name) => !selfTaken.has(patentMedicineBaseName(name))))];
  // 按给药动词从整份病历取的药名（2026-10-19）：西药与商品名（卡托普利、倍博特、拜新同、舒利迭）不带剂型、也不在中成药目录里，
  // 上面那套认法认不出，验收主集注意事项一栏因此 20 余例判「已服药物没有相应一条」。
  const recorded = recordedMedicationMentions(grounded);
  const sameDrug = (left: string, right: string) => {
    const a = patentMedicineBaseName(left), b = patentMedicineBaseName(right);
    return a === b || a.includes(b) || b.includes(a);
  };
  // 「用药史」一栏本身就是在用药清单（2026-11-14 第四十五轮 C100：「地高辛、呋塞米、华法林、安眠药」没有给药动词，一个都没认出）。
  // 这一栏逐项切开后要认得出是药才收：西药通用名表、带剂型或说明书目录一字不差、药类说法（降压药、安眠药、铁剂…）；
  // 用法与服用情况的碎片（「偶有漏用」「今日已自行加用数次」「名称」）不收，写着用过、未用的不算在用（第四十五轮复核，甲方 100 例 20 余份）。
  // 既往史等栏里写成清单的现用药（「现用药：硝苯地平控释片30mg每日1次，二甲双胍片0.5g每日2次…」，第四十六轮 new45-n40：一个都没认出）：
  // 与「用药史」一栏同一认法逐项收。栏目标签是有限闭集（现用药、目前用药、长期用药、现服药物）。
  const listedInText = [...grounded.normalize("NFKC").matchAll(/(?:现用药|目前用药|长期用药|现服药物|目前服用药物)[:：]([^。\n]+)/gu)]
    .flatMap((match) => match[1].split(/[，,；;、]/u)).map((item) => item.trim()).filter(Boolean);
  const historyNames = [...recordedMedicationHistoryList(state), ...listedInText].flatMap((item) => {
    const { candidate, notCurrent } = medicationHistoryItemCandidate(item);
    if (notCurrent || candidate.length < 2) return [];
    if (MEDICATION_HISTORY_CLASS_WORD.test(candidate)) return [candidate];
    if (patentMedicineBaseName(candidate) !== candidate || findLocalPatentMedicineLabel(candidate)?.name.replace(/\s/g, "") === candidate) return [candidate];
    const western = westernDrugNameIn(candidate);
    return western ? [candidate.length <= 12 && candidate.includes(western) ? candidate : western] : [];
  });
  for (const raw of [...recorded.names, ...historyNames]) {
    const name = cleanedMedicationNameCandidate(raw);
    if (!name || selfTaken.has(patentMedicineBaseName(name))) continue;
    const known = current.findIndex((other) => sameDrug(other, name));
    // 按给药动词取的名字是用药史那一项的残片（「吸入」后面的「性糖皮质激素」）：换成整项。
    if (known >= 0 && historyNames.includes(raw) && name.length > current[known].length && name.endsWith(current[known])) current[known] = name;
    if (known >= 0) continue;
    current.push(name);
  }
  // 取名的几条路各自切词，切出过「控制」「依折麦布片一天」「α骨化醇片(」「包括甲泼尼龙」（2026-10-19 Claude 评审 M 集）：
  // 统一按药名候选收一道、按清理后的名字去重；后来停了或只在「曾…」里出现的不算在用。
  // 最多列 6 个：长期多药的病人（激素＋吸入剂＋抗组胺，降压＋降糖＋调脂＋抗血小板）列 3 个就漏了评审点名的那几个。
  const cleanedOf = (name: string) => cleanedMedicationNameCandidate(name);
  // 吃的食物与自制食疗（猪血、梨水、川贝蒸梨…）不是在用的药（第四十六轮 new45-n03、n18）；本次引起过敏的药（「服用新买的感冒药后全身红斑」）
  // 不是请患者「是否继续由医生决定」的在用药，过敏一条已写「请勿再用」（第四十六轮 p100c-C006）。
  const candidates = [...new Set(current.map(cleanedOf).filter(Boolean))]
    .filter((name) => !NOT_MEDICATION_FOODS.has(name) && !drugAllergy.some((phrase) => phrase.includes(name) || phrase.includes(patentMedicineBaseName(name))))
    .filter((name, index, all) => !all.some((other, at) => at < index && (other.includes(name) || name.includes(other))));
  // 现病史按时间点分段（clinical-polarity medicationTimelineStatuses，2026-10-19 Claude 评审 M 集 TCM-SD-463912、480964、440006、478843）：
  // 换掉的旧方案不列；最后一段里接着用的算正在用（即便写的是「予」）；早年的、写着「间断/长期」的请患者说明现在是否还在用。
  const timeline = medicationTimelineStatuses(presentIllnessText(state), candidates);
  const pastOnly = new Map(candidates.map((name) => [name, medicationOnlyPastMentions(grounded, name)]));
  const listed = candidates
    .filter((name) => !medicationStoppedInNextSentence(grounded, name) && !medicationStopped(grounded, name) && !medicationNotTaken(grounded, name))
    .filter((name) => timeline.get(name) !== "superseded")
    // 只在「曾…」里出现的：这次发病最后一段里用过的（「外院曾予蒙脱石散、易蒙停等药物治疗，症状未能缓解，遂来就诊」，M 集 RobustSDT-0598）
    // 请患者说明是否还在用；带「既往」的（「既往曾接受醋酸泼尼松…治疗」）照旧不列。
    .filter((name) => {
      const past = pastOnly.get(name);
      return !past || (past === "ever" && ["current", "latest", "ask"].includes(timeline.get(name) || ""));
    })
    .sort((left, right) => Number(timeline.get(left) === "ask") - Number(timeline.get(right) === "ask"));
  // 激素、免疫抑制剂只写了药类没写药名的（「经予免疫抑制剂及激素治疗后」，M 集 RobustSDT-0530）：按药类列，已列了这一类具体药名的不重复。
  const classes = recordedSystemicTherapyClasses(grounded)
    .filter((label) => !listed.some((name) => label === "激素" ? CORTICOSTEROID_MEDICATION.test(name) : IMMUNOSUPPRESSIVE_MEDICATION.test(name)));
  // 与本例病情相抵的在用药（二甲双胍与 eGFR<30、非甾体抗炎药与阿司匹林诱发哮喘或肾功能减退）单写一条，不再进「是否继续由医生决定」（第四十六轮）。
  const contraindicated = drugConditionCautions([...listed, ...items.flatMap((item) => item.kind === "self_medication" ? [item.name] : [])], grounding, drugAllergy);
  for (const caution of contraindicated) items.push(caution);
  const shown = [...listed, ...classes].filter((name) => !contraindicated.some((caution) => caution.drug === name)).slice(0, 6);
  const givenNames = new Set(recorded.given.map(cleanedOf));
  // 写着「至今/仍在/继续」的（「予异烟肼…规范抗结核治疗至今」，第四十一轮 m07）是正在用，不按「用过」请患者说明。
  const stillTaking = (name: string) => grounded.normalize("NFKC").split(/[。；;\n]+/u).some((sentence) => sentence.includes(name) && MEDICATION_STILL_TAKING.test(sentence));
  const given = shown.filter((name) => timeline.get(name) !== "current" && !stillTaking(name) &&
    ((givenNames.has(name) && !formallyTaken.has(name)) || pastOnly.get(name) === "ever" || timeline.get(name) === "ask" || classes.includes(name)));
  // 激素、免疫抑制剂「不要自行停用」只说全身用药：外用的低效激素乳膏不在此列。
  // 病历写着「外用 / 外涂 / 外搽 / 外敷」的药按外用写（2026-10-24 甲方 100 例 C051：「外用低效激素间断使用」被写成「正在服用的低效激素」）。
  const topical = shown.filter((name) => new RegExp(`(?:外用|外涂|外搽|外敷|局部涂抹)[^，,。；;]{0,4}${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u").test(grounded));
  const noSelfStop = shown.filter((name) => (CORTICOSTEROID_MEDICATION.test(name) || IMMUNOSUPPRESSIVE_MEDICATION.test(name)) && !topical.includes(name));
  if (shown.length > 0) {
    items.push({ kind: "current_medications", names: shown, ...(given.length > 0 ? { given } : {}), ...(redFlag ? { urgent: true } : {}), ...(noSelfStop.length > 0 ? { noSelfStop } : {}), ...(topical.length > 0 ? { topical } : {}) });
  } else if ((recorded.unnamed || recorded.herbal) && !items.some((item) => item.kind === "self_medication")) {
    items.push({ kind: "unnamed_medication", ...(recorded.herbal && !recorded.unnamed ? { herbal: true } : {}) });
  }
  // 抗凝、抗血小板药（与安全门同一份药名）或通常须抗栓的情形（支架术后、深静脉血栓、房颤…）：方中有活血药时写出血观察，交付面按最终处方核。
  const antithromboticDrugs = [...shown, ...items.flatMap((item) => item.kind === "self_medication" ? [item.name] : [])]
    .filter((name) => ANTITHROMBOTIC_MEDICATION.test(name));
  const antithromboticIndication = antithromboticDrugs.length === 0 ? antithromboticIndicationRecorded(state) : undefined;
  if (antithromboticDrugs.length > 0 || antithromboticIndication) {
    items.push({ kind: "antithrombotic_bleeding", drugs: antithromboticDrugs, ...(antithromboticIndication ? { indication: antithromboticIndication } : {}) });
  }
  // 正在服华法林：开始或停服中药时更频繁复查 INR，方中人参类可减弱其作用（华法林说明书，第四十六轮 p100c-C100、C020）。红旗页也写。
  const warfarin = WARFARIN_HERBAL.drugTerms.length > 0
    ? [...shown, ...items.flatMap((item) => item.kind === "self_medication" ? [item.name] : [])].find((name) => WARFARIN_HERBAL.drugTerms.some((term) => name.includes(term)))
    : undefined;
  if (warfarin) items.push({ kind: "warfarin_herbal", drug: warfarin, decreaseHerbs: [...WARFARIN_HERBAL.decreaseHerbs] });
  // 肾功能不全、心衰、血钾偏高、地高辛、免疫抑制：各写一条给患者的话（2026-11-14 第四十五轮 C100、C036），红旗页也写。
  const highRisk = highRiskConditionsForPrecautions(state);
  // 血钾偏高时另加一句饮食限钾（第四十六轮 new45-n40）。
  const highRiskConditions = highRisk.conditions.includes("hyperkalemia") ? [...highRisk.conditions, "hyperkalemia_diet" as const] : [...highRisk.conditions];
  if (highRiskConditions.length > 0) items.push({ kind: "high_risk_condition", conditions: highRiskConditions, ...(highRisk.potassium ? { potassium: highRisk.potassium } : {}) });
  // 糖尿病（病历写着患者本人有，或已签名诊断是糖尿病/消渴）：控糖与监测血糖一条。
  const diabetesConfirmed = diabetesRecorded(state) || diabetesDiagnosisConfirmed(String(prior?.westernDiagnosis?.primary?.name || ""));
  if (diabetesConfirmed || [prior?.westernDiagnosis?.primary?.name, prior?.overview?.tcmDiseaseName].some((value) => /糖尿病|消渴/u.test(String(value || "")))) {
    // 病历否认糖尿病、本次才查出血糖明显升高（第四十六轮 new45-n02：「否认糖尿病…指尖血糖26.8」被写成「您有糖尿病，继续控制血糖」）。
    const newlyFound = diabetesConfirmed && !diabetesRecorded(state) && sourceDocumentsNegation(grounding, "糖尿病");
    items.push({ kind: "diabetes_glucose", confirmed: diabetesConfirmed, ...(newlyFound ? { newlyFound: true as const } : {}), ...(currentHypoglycemiaRecorded(grounding) ? { hypoglycemia: true as const } : {}) });
  }
  if (prior) {
    const overview = prior.overview;
    const syndromeText = [overview?.primarySyndrome, ...(Array.isArray(overview?.secondarySyndromes) ? overview.secondarySyndromes : []), prior.therapy?.overallMethod]
      .map((value) => String(value || "")).join("，");
    // 病历写了饮酒（个人史「饮酒30年」「嗜酒」）才写戒酒，与饮食栏「忌酒」一致；红旗未解除或不给剂量时只写忌口、不写怎么服
    //（2026-10-14 起红旗页不写服法；10/19 留出集 S178/S188/S190 红旗页仍出现「本方汤药宜饭后温服」，是这条规则补的）。
    const drinking = recordsAlcoholUse(grounding);
    items.push({ kind: "administration_and_diet", diet: `${dietRestrictionForSyndromeText(syndromeText)}${drinking ? "，戒酒" : ""}`, administration: doseAllowed, ...(drinking ? { alcohol: true as const } : {}) });
  }
  const limitation = recordedMobilityLimitation(grounding);
  if (limitation) items.push({ kind: "mobility_limited_exercise", limitation });
  // 病历里写到的药名（含后来停了、只在往事里出现的）：交付面核对注意事项点名的药是不是病历里有的。
  const recordedDrugs = [...new Set([...labelledMedicineNamesIn(grounded), ...recorded.names, ...candidates, ...items.flatMap((item) => item.kind === "self_medication" ? [item.name] : [])]
    .map((name) => String(name || "").trim()).filter((name) => name.length >= 2))];
  if (recordedDrugs.length > 0) items.push({ kind: "recorded_drug_names", names: recordedDrugs });
  return items;
}

/** 病历记录本次血糖低于 3.9mmol/L，或肯定写着低血糖（发作、反应）。 */
export function currentHypoglycemiaRecorded(text: string): boolean {
  const source = String(text || "").normalize("NFKC");
  if ([...source.matchAll(/(?:血糖|指尖血糖|随机血糖|GLU)\s*[:：]?\s*(?:为|示|测得)?\s*(\d+(?:\.\d+)?)\s*mmol\/L/giu)].some((match) => Number(match[1]) < 3.9)) return true;
  return /低血糖(?:发作|反应|症状|昏迷)?/u.test(source) && !/(?:无|否认|未见|未发生|没有)[^，,。；;]{0,6}低血糖/u.test(source);
}

/** 给 M04 模型的一段话：逐项列出本例必须写到的注意事项，模型按本例写，服务端事后逐项核对。 */
export function requiredPrecautionsPromptSection(items: readonly RequiredPrecaution[]): string {
  const mobility = items.find((item) => item.kind === "mobility_limited_exercise");
  const listed = items.filter((item) => item.kind !== "mobility_limited_exercise" && item.kind !== "recorded_drug_names");
  const exerciseNote = mobility?.kind === "mobility_limited_exercise"
    ? `\n运动保健：病历记录患者「${mobility.limitation}」，运动保健一栏按行动受限写（坐位或床旁活动、扶物、家人陪同，量与时长减半），不写需要站立屈膝或长时间行走的功法。`
    : "";
  if (listed.length === 0) return exerciseNote.trim();
  const lines = listed.map((item, index) => {
    const order = `${index + 1}.`;
    if (item.kind === "disease_care") return `${order}${item.disease}：必须写到「${item.sentence}」；时限只写在注意事项，复诊首句仍服从本例优先评估安排。同页不写：${item.conflictsWith.join("、") || "无"}。`;
    if (item.kind === "self_medication") {
      const parts = [`患者已自服${item.name}`];
      if (item.composition.length > 0) parts.push(`（方剂目录组成含${item.composition.join("、")}）：写明它与本方处方里都有的药（只列你开的处方里也有的那几味）、服本方期间是否停服及原因`);
      else parts.push("：写明服本方期间是否继续服用由医生决定");
      if (item.alcoholWarning) parts.push(`；并写明服用${item.base}期间须戒酒（说明书：与酒同用可出现双硫仑样反应）`);
      return `${order}${parts.join("")}。`;
    }
    if (item.kind === "postpartum_lactation") {
      if (item.confirmed) return `${order}患者已在哺乳：直接写哺乳期用药须医生评估，观察婴儿吃奶、精神及排便变化；不得写「如正在哺乳」；孕期提示须另有当前妊娠事实，不从哺乳推定妊娠。按方中真实哺乳期禁慎用标签点名药物，没有标签不编造。`;
      // 不用「患者一年内分娩、哺乳情况未记录：」这样的标题：模型会照抄成写给患者的第三人称（2026-10-19 甲方病历 3「患者一年内分娩，如正在哺乳…」）。
      return `${order}写一句给产后一年内的患者：「产后如正在哺乳，请服药前告知医生」，并点名方中哺乳期禁用、慎用的药（禁用、慎用分开写；回乳的药如麦芽也点名）。`;
    }
    if (item.kind === "pediatric_administration") return `${order}患儿${item.ageYears < 1 ? `${Math.max(1, Math.round(item.ageYears * 12))}个月` : `${Math.floor(item.ageYears)}岁`}：写一条给家长的服药方法（少量多次、分次喂服，不要强灌，不自行加量）。`;
    if (item.kind === "elderly_administration") return `${order}患者${Math.floor(item.ageYears)}岁：写一条与年龄相关的服药注意（如起身宜缓、防跌倒）。`;
    if (item.kind === "current_medications" && item.urgent) return `${order}病历记录患者正在使用${item.names.join("、")}，本例须先就医处置：写一条请把这些药连同药盒带去就医，告诉医生最近一次用药的时间，是否继续由医生决定；不写与中药间隔服用。`;
    if (item.kind === "self_discontinued_medication") return `${order}病历记录患者${item.irregular ? "未规律服用" : "自行停用了"}${discontinuedMedicationLabel(item)}${item.condition ? `（${item.condition}）` : ""}：写一条请${item.irregular ? "由医生评估后按医嘱规律服用" : "尽快由医生评估后调整用药并规律服用"}，不要自行停药或减量。`;
    if (item.kind === "current_medications") return `${order}病历记录患者${item.given?.length ? "用过或正在使用" : "正在使用"}${item.names.join("、")}：写一条它与本方一起用时要注意的事（告知医生${item.given?.length ? "现在是否还在用" : ""}、是否继续由医生决定；口服药写「与中药间隔约1小时服用」；乳膏、贴剂等外用药只写「正在外用的某药请告知医生」，不写服用、不写间隔；与本方有明确相互作用的写出来${item.topical?.length ? `；${item.topical.join("、")}病历写明是外用，按外用药写` : ""}${item.noSelfStop?.length ? `；${item.noSelfStop.join("、")}不要自行停用或减量` : ""}）。`;
    if (item.kind === "antithrombotic_bleeding") return `${order}${item.drugs.length > 0 ? `病历记录患者正在使用${item.drugs.join("、")}` : `病历记录${item.indication}，通常在服抗凝或抗血小板药`}：本方若用了活血化瘀药（如桃仁、红花、川芎、丹参、三棱、莪术），写一条与${item.drugs.length > 0 ? "这些药" : "抗凝或抗血小板药"}同用可能增加出血、服药期间留意牙龈出血、皮下瘀斑、黑便或血尿，出现时及时就医；本方没有这类药时不写。`;
    if (item.kind === "high_risk_condition") return `${order}${highRiskConditionPromptText(item)}`;
    if (item.kind === "diabetes_glucose" && item.hypoglycemia) return `${order}本次是低血糖发作：写一条请按医嘱调整降糖药、按时进餐、随身带糖果，出现心慌、出汗、手抖、头晕时立即吃含糖食物并测血糖，神志不清时立即急诊；不要写「少吃甜食」。`;
    if (item.kind === "diabetes_glucose" && item.newlyFound) return `${order}病历否认糖尿病、本次才查出血糖明显升高：写一条请尽快到医院明确诊断，在医生指导下控制血糖，服药期间少吃甜食与含糖饮料；不要写「您有糖尿病」「继续控制血糖」。`;
    if (item.kind === "drug_condition_caution") return `${order}病历记录正在用${item.drug}，与本例病情相抵：照这个意思写一条给患者的话——${item.sentence}。`;
    if (item.kind === "warfarin_herbal") return `${order}病历记录正在服用${item.drug}：写一条开始或停服本方期间按医嘱更频繁地复查INR、留意出血；本方若用了人参、红参、西洋参，写明它们可能减弱华法林的作用。`;
    if (item.kind === "diabetes_glucose") return item.confirmed
      ? `${order}患者有糖尿病：写一条服药期间按医嘱继续控制血糖、定期监测血糖，少吃甜食与含糖饮料；饮食建议里不要推荐红枣、蜂蜜、冰糖等含糖多的食物。`
      : `${order}患者口渴多饮、尚未确诊糖尿病：写一条请尽早到医院查空腹血糖和糖化血红蛋白，服药期间少吃甜食与含糖饮料；饮食建议里不要推荐红枣、蜂蜜、冰糖等含糖多的食物。`;
    if (item.kind === "unnamed_medication" && item.herbal) return `${order}病历记录患者一直在服中药但没写方名：写一条请把正在服的中药方子带给医生看，由医生决定是否与本方同服，避免药味重复。`;
    if (item.kind === "unnamed_medication") return `${order}病历记录患者自行用过药但没写药名：写一条请把正在用的药（药名、用法）告诉医生，避免与本方重复或相互影响。`;
    if (item.kind === "herpes_zoster_antiviral") return `${order}带状疱疹：写明须尽早到医院由医生评估是否口服抗病毒药（发疹3天内、仍有新水疱或年龄50岁以上尤应尽早），疼痛明显时一并告知医生；皮疹累及眼周、耳部或出现视物模糊、听力改变、剧烈头痛须立即就医。`;
    if (item.kind === "administration_and_diet") return item.administration
      ? `${order}写一条怎么服和忌什么：按本方煎服法写饭前或饭后、温服，忌口随证写（本例${item.diet}）${item.alcohol ? "；病历记录患者饮酒，写明戒酒" : ""}。`
      : `${order}写一条忌口（本例${item.diet}）${item.alcohol ? "；病历记录患者饮酒，写明戒酒" : ""}；本例暂不给剂量，不写怎么服。`;
    if (item.kind === "menses_overdue_pregnancy_check") return `${order}写一条（育龄女性，病历写着本次月经逾期未至）：服药前先验孕，确认怀孕告知医生；不用逐味点名哪些药慎用（药表里已逐味标注）。`;
    if (item.kind === "reproductive_status_unknown") return `${order}写一条：如已怀孕、可能怀孕或正在哺乳，须服药前告知医生（患者是育龄女性；不要写「未记录」这类话，也不用逐味点名哪些药慎用——药表里已逐味标注）。`;
    if (item.kind === "severe_hypertension_followup") return `${order}本次血压${item.reading}明显偏高：写一条请患者今天复测血压，并当日或数日内到心内科或全科就诊调整降压药；出现胸痛、气短、剧烈头痛、视物模糊、肢体无力或言语不清须立即就医。`;
    if (item.kind === "gout_diet") return `${order}痛风：写明低嘌呤饮食（少吃海鲜、动物内脏、浓肉汤），戒酒尤其啤酒，多饮水。`;
    if (item.kind === "trigger_foods") return `${order}本次发病与进食${item.foods.join("、")}有关：写明服药期间及以后避免${item.foods.join("、")}。`;
    if (item.kind === "toxic_self_preparation") return `${order}病历记录患者自行配制并服用含${item.herbs.join("、")}的药（药典标注有毒）：写明立即停用、不要再自行配制服用，并写出须立即就医的中毒表现（口唇舌及四肢发麻、心慌、心跳不齐、呼吸困难）。`;
    if (item.kind === "conception_pregnancy_check") return `${order}写一条（患者备孕或未避孕）：服药期间如月经逾期须先验孕，确认怀孕立即停药并告知医生；不用逐味点名哪些药慎用（药表里已逐味标注）。`;
    if (item.kind === "drug_allergy") return `${order}病历记录有药物过敏（${item.phrases.join("；")}）：写明请勿再用该药及同类药物，就诊开药或自行购药时主动告诉医生和药师；推荐的中成药、西药不得含该药或同类药。`;
    if (item.kind === "food_allergy") {
      const labels = item.classes.map((entry) => entry.labelZh).join("、");
      const stated = item.classes.filter(allergenStatedInRecord);
      const suspected = item.classes.filter((entry) => !allergenStatedInRecord(entry));
      const recorded = [
        stated.length > 0 ? `病历记录对${stated.map((entry) => entry.labelZh).join("、")}过敏或不耐受（${stated.map((entry) => `「${entry.quote}」`).join("；")}）` : "",
        suspected.length > 0 ? `本次进食${suspected.map((entry) => entry.labelZh).join("、")}后发病（${suspected.map((entry) => `「${entry.quote}」`).join("；")}），疑似过敏，病历未写明过敏史——写给患者时说「可能过敏」，不要说「病历记录您对…过敏」` : "",
      ].filter(Boolean).join("；");
      return `${order}${recorded}：这是硬约束——饮食建议、食疗方不得推荐含${labels}的食物，处方、加减和中成药不得含${labels}来源的药材或成份（如鸡子黄、蜜炙饮片、淡豆豉）；注意事项写明请避开${allergenAvoidPhrase(item.classes.map((entry) => entry.classId))}，出现皮疹、瘙痒、口唇肿胀或呼吸不畅立即就医。`;
    }
    return `${order}${item.disease}是细菌感染：写明须到医院由医生决定抗菌药物治疗，以及寒战高热、红肿迅速扩大等须立即就医的表现。`;
  });
  return `【本例注意事项必须写到】以下各项在 nonPharma.precautions 里各写一条，排在最前，不计入条数上限。清单是写给你看的；写进注意事项时直接对患者说（用「您」或不写主语），不要照抄清单里「患者已自服」「病历记录」这类说法：\n${lines.join("\n")}${exerciseNote}`;
}


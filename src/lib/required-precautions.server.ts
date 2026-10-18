import { formallyAdministeredMedicationMentions, recordedMedicationMentions, recordsAlcoholUse, selfPreparedMedicationSentence, selfTakenMedicationMentions } from "./clinical-polarity";
import { assessLactationState, assessPregnancyState, conceptionWithoutPregnancyOrLactation, recentChildbirthMentioned } from "./clinical-state";
import { clinicalGroundingText, currentVitalMeasurements, reproductiveAdviceRelevant, severeHypertensionTargetOrganSign } from "./diagnosis-safety";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import {
  findLocalPatentMedicineLabel,
  localPrescriptionPatentMedicineEntries,
  patentMedicineBaseName,
  type LocalPatentMedicineEntry,
} from "./local-patent-medicine-candidates";
import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { catalogSharedComposition } from "./tcm-formula-provenance";
import { getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } from "./tcm-knowledge";
import { dietRestrictionForSyndromeText, recordedTriggerFoods } from "./tcm-therapy-phrasing";
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
  if (reproductiveAdviceRelevant(state) && recentChildbirthMentioned(grounding) && assessLactationState(grounding).status === "unknown") {
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
  if (conceptionWithoutPregnancyOrLactation(grounding)) items.push({ kind: "conception_pregnancy_check" });
  else if (reproductiveAdviceRelevant(state) && assessPregnancyState(grounding).status === "unknown" &&
    assessLactationState(grounding).status === "unknown" && !recentChildbirthMentioned(grounding)) {
    items.push({ kind: "reproductive_status_unknown" });
  }
  // 年龄相关的服药注意：提示词一直要求「75 岁以上高龄或 6 岁以下幼儿写一条」，模型时写时漏（2026-10-17 留出集 4 例患儿没有）。
  // 儿童取未满 12 岁——儿科剂量按年龄折算的年龄段（pediatric-dose-rule），这些孩子的家长都需要这一句。
  const age = patientAgeYears(state);
  // 12–13 岁仍属儿科（《中医儿科学》0–14 岁）：同一项，规则句按年龄换成适合大孩子的说法（验收主集 13 岁例评审判缺）。
  if (age != null && age < 14) items.push({ kind: "pediatric_administration", ageYears: age });
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
    .filter((name) => !selfTaken.has(patentMedicineBaseName(name))))];
  // 按给药动词从整份病历取的药名（2026-10-19）：西药与商品名（卡托普利、倍博特、拜新同、舒利迭）不带剂型、也不在中成药目录里，
  // 上面那套认法认不出，验收主集注意事项一栏因此 20 余例判「已服药物没有相应一条」。
  const recorded = recordedMedicationMentions(grounded);
  const sameDrug = (left: string, right: string) => {
    const a = patentMedicineBaseName(left), b = patentMedicineBaseName(right);
    return a === b || a.includes(b) || b.includes(a);
  };
  for (const name of recorded.names) {
    if (selfTaken.has(patentMedicineBaseName(name)) || current.some((known) => sameDrug(known, name))) continue;
    current.push(name);
  }
  const listed = current.slice(0, 3);
  const given = listed.filter((name) => recorded.given.includes(name) && !formallyTaken.has(name));
  if (listed.length > 0) items.push({ kind: "current_medications", names: listed, ...(given.length > 0 ? { given } : {}) });
  else if (recorded.unnamed && !items.some((item) => item.kind === "self_medication")) items.push({ kind: "unnamed_medication" });
  if (prior) {
    const overview = prior.overview;
    const syndromeText = [overview?.primarySyndrome, ...(Array.isArray(overview?.secondarySyndromes) ? overview.secondarySyndromes : []), prior.therapy?.overallMethod]
      .map((value) => String(value || "")).join("，");
    // 病历写了饮酒（个人史「饮酒30年」「嗜酒」）才写戒酒，与饮食栏「忌酒」一致；红旗未解除或不给剂量时只写忌口、不写怎么服
    //（2026-10-14 起红旗页不写服法；10/19 留出集 S178/S188/S190 红旗页仍出现「本方汤药宜饭后温服」，是这条规则补的）。
    const drinking = recordsAlcoholUse(grounding);
    const doseAllowed = state.safetyGate ? state.safetyGate.status !== "red_flag" && state.safetyGate.allowDosePrescription !== false : true;
    items.push({ kind: "administration_and_diet", diet: `${dietRestrictionForSyndromeText(syndromeText)}${drinking ? "，戒酒" : ""}`, administration: doseAllowed });
  }
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
    if (item.kind === "pediatric_administration") return `${order}患儿${item.ageYears < 1 ? `${Math.max(1, Math.round(item.ageYears * 12))}个月` : `${Math.floor(item.ageYears)}岁`}：写一条给家长的服药方法（少量多次、分次喂服，不要强灌，不自行加量）。`;
    if (item.kind === "elderly_administration") return `${order}患者${Math.floor(item.ageYears)}岁：写一条与年龄相关的服药注意（如起身宜缓、防跌倒）。`;
    if (item.kind === "current_medications") return `${order}病历记录患者${item.given?.length ? "用过或正在使用" : "正在使用"}${item.names.join("、")}：写一条它与本方一起用时要注意的事（告知医生${item.given?.length ? "现在是否还在用" : ""}、是否继续由医生决定；口服药写「与中药间隔约1小时服用」；乳膏、贴剂等外用药只写「正在外用的某药请告知医生」，不写服用、不写间隔；与本方有明确相互作用的写出来）。`;
    if (item.kind === "unnamed_medication") return `${order}病历记录患者自行用过药但没写药名：写一条请把正在用的药（药名、用法）告诉医生，避免与本方重复或相互影响。`;
    if (item.kind === "herpes_zoster_antiviral") return `${order}带状疱疹：写明须尽早到医院由医生评估是否口服抗病毒药（发疹3天内、仍有新水疱或年龄50岁以上尤应尽早），疼痛明显时一并告知医生；皮疹累及眼周、耳部或出现视物模糊、听力改变、剧烈头痛须立即就医。`;
    if (item.kind === "administration_and_diet") return item.administration
      ? `${order}写一条怎么服和忌什么：按本方煎服法写饭前或饭后、温服，忌口随证写（本例${item.diet}）。`
      : `${order}写一条忌口（本例${item.diet}）；本例暂不给剂量，不写怎么服。`;
    if (item.kind === "reproductive_status_unknown") return `${order}写一条：如已怀孕、可能怀孕或正在哺乳，须服药前告知医生（患者是育龄女性；不要写「未记录」这类话，也不用逐味点名哪些药慎用——药表里已逐味标注）。`;
    if (item.kind === "severe_hypertension_followup") return `${order}本次血压${item.reading}明显偏高：写一条请患者今天复测血压，并当日或数日内到心内科或全科就诊调整降压药；出现胸痛、气短、剧烈头痛、视物模糊、肢体无力或言语不清须立即就医。`;
    if (item.kind === "gout_diet") return `${order}痛风：写明低嘌呤饮食（少吃海鲜、动物内脏、浓肉汤），戒酒尤其啤酒，多饮水。`;
    if (item.kind === "trigger_foods") return `${order}本次发病与进食${item.foods.join("、")}有关：写明服药期间及以后避免${item.foods.join("、")}。`;
    if (item.kind === "toxic_self_preparation") return `${order}病历记录患者自行配制并服用含${item.herbs.join("、")}的药（药典标注有毒）：写明立即停用、不要再自行配制服用，并写出须立即就医的中毒表现（口唇舌及四肢发麻、心慌、心跳不齐、呼吸困难）。`;
    if (item.kind === "conception_pregnancy_check") return `${order}写一条（患者备孕或未避孕）：服药期间如月经逾期须先验孕，确认怀孕立即停药并告知医生；不用逐味点名哪些药慎用（药表里已逐味标注）。`;
    return `${order}${item.disease}是细菌感染：写明须到医院由医生决定抗菌药物治疗，以及寒战高热、红肿迅速扩大等须立即就医的表现。`;
  });
  return `【本例注意事项必须写到】以下各项在 nonPharma.precautions 里各写一条，排在最前，不计入条数上限：\n${lines.join("\n")}`;
}

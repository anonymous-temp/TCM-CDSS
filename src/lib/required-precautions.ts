import type { DiseaseCareItem } from "./western-disease-care";
import drugConditionJson from "../data/western-drug-condition-cautions.source.json";
import drugConditionContraindications from "../data/drug-condition-contraindications.json";
export const ANTITHROMBOTIC_FORMULA_REVIEW = "本方须先请医生调整，确认前不要服用";
/**
 * 本例注意事项里必须写到的内容（2026-10-17，甲方标准病历 3、7 与留出例 S143 的独立评审）。
 *
 * 提示词一直要求模型写已自服药物的重叠、产后哺乳与丹毒的抗感染，模型多数时候写、有时漏（病历 7 三次全漏自服的
 * 黄连上清丸与甲硝唑；病历 3 三次里一次漏哺乳；S143 丹毒没写抗菌治疗）。联网查到的做法一致：要写的项目由规则算出，
 * 逐项告诉模型，生成后逐项核对，漏了用规则自己的那句补上（漏项靠模型自查查不出来；处方系统里的重复用药提示历来是规则做的）。
 *
 * 这里只有类型；由病历算出项目在 required-precautions.server.ts，核对与补写在 delivered-surface.ts（交付面，签名之前）。
 */
export type RequiredPrecaution =
  | DiseaseCareItem
  | {
      kind: "self_medication";
      /** 病历原文里的药名（「黄连上清丸」「甲硝唑片」）。 */
      name: string;
      /** 去剂型的名字，用来判断注意事项里是否已经提到（「黄连上清」「甲硝唑」）。 */
      base: string;
      /** 中成药在方剂目录里各版本共有的药味（组成身份名）；西药或查不到组成时为空。 */
      composition: string[];
      /** 本地说明书目录里有说明书写明该药与酒同用会引起双硫仑样反应或须戒酒。 */
      alcoholWarning: boolean;
    }
  | { kind: "postpartum_lactation"; confirmed?: true }
  | { kind: "skin_infection_antibiotic"; disease: string }
  /** 未满 12 岁（儿科剂量按年龄折算的年龄段）：少量多次喂服、不强灌、不自行加量。2026-10-18 留出集 4 例患儿没有这一条。 */
  | { kind: "pediatric_administration"; ageYears: number }
  /** 65 岁及以上：起身宜缓、防跌倒（2026-10-18 起与项目卡的老年提示同一界值；验收主集 68 岁例评审判缺）。 */
  | { kind: "elderly_administration"; ageYears: number }
  /** 病历写着正在服用的药（既往史里的长期用药也算；现病史里为这次病自服的另见 self_medication）。 */
  | {
      kind: "current_medications";
      names: string[];
      given?: string[];
      prescribedCourse?: boolean;
      maintenance?: string[];
      /** 红旗未解除（先急诊处置）：不写与中药间隔服用，写带药就医、告诉医生最近一次用药时间（2026-10-19 留出集 S188：心率 42、血压 82/48 仍写「间隔1小时服用」）。 */
      urgent?: boolean;
      /** 激素、免疫抑制剂（names 里的那几个）：骤停有风险，补的那句加「不要自行停用或减量」（2026-10-19 M 集 RobustSDT-0530）。 */
      noSelfStop?: string[];
      /** 病历写明外用的（「外用低效激素」）：按外用药写，不说「服用」。药名本身带外用剂型的另由剂型判。 */
      topical?: string[];
    }
  /** 病历写着自行停了长期用药（留出集 S178：高血压急症、一个月前自行停降压药）：由医生评估后规律服用，不要再自行停药。 */
  | { kind: "self_discontinued_medication"; names: string[]; condition?: string; irregular?: true }
  /** 病历写着行动受限（拄拐、轮椅、卧床…）：运动保健按坐位、扶物、家人陪同写（甲方标准病历 5）。只核运动保健一栏，不进注意事项。 */
  | { kind: "mobility_limited_exercise"; limitation: string }
  /** 病历写了自行用药、却没写药名（「自用药物后未见缓解」「自行服药」）。2026-10-19 验收主集 J 模块。 */
  | {
      kind: "unnamed_medication";
      /** 病历写的是「一直口服中药治疗」这类在服的中药汤剂（没写方名）：请患者把方子带给医生，避免与本方重复（验收主集 M-TCM-SD-486942）。 */
      herbal?: boolean;
    }
  /** 带状疱疹（蛇串疮）：尽早由医生评估系统抗病毒治疗（发疹 72 小时内、仍有新水疱、50 岁以上）与疼痛。甲方标准病历 8。 */
  | { kind: "herpes_zoster_antiviral" }
  /** 备孕/未避孕而未妊娠：服药期间月经逾期先验孕，确认怀孕即停药告知医生（2026-10-19 留出集 S102）。 */
  | { kind: "conception_pregnancy_check" }
  /** 病历记录的药物过敏（原文小段，至多两段）：再用同一或同类药前告知医生（2026-10-24 甲方 100 例 C099）。 */
  | { kind: "drug_allergy"; phrases: string[] }
  /** 病历记录的食物（及同源饮片、蜂产品、漆等）过敏或不耐受，按 allergen-profile 归类（2026-10-26 第二十一轮，B061）。 */
  | { kind: "food_allergy"; classes: Array<{ classId: string; labelZh: string; kind: "allergy" | "intolerance"; quote: string }> }
  /** 病历写着自行配制、泡酒服用的药里有药典标注有毒的药（留出集 S190：自泡生草乌、生川乌药酒）：立即停用，不再自制。 */
  | { kind: "toxic_self_preparation"; herbs: string[] }
  /** 服法与忌口（2026-10-19 验收主集 J：几例注意事项只写调护、没写怎么服或忌什么）。忌口按已定证候的寒热湿积推出。 */
  | {
      kind: "administration_and_diet";
      diet: string;
      administration: boolean;
      /** 病历写着在饮酒：注意事项里要有戒酒（「忌辛辣」一类饮食句不算写到了戒酒；2026-10-19 M 集 MTCMB-21 每日白酒 5 两）。 */
      alcohol?: true;
    }
  /** 育龄女性、妊娠与哺乳状态都没记录（验收主集 J 3 例判缺）：服药前告知医生，方中孕妇慎用药点名。 */
  | { kind: "reproductive_status_unknown" }
  /** 育龄女性病历写着本次月经逾期未至（「末次月经10月21日，至今未至」）：服药前先验孕（2026-10-19 M 集 RobustSDT-0697）。 */
  | { kind: "menses_overdue_pregnancy_check" }
  /** 重度高血压（≥180/120）而无急性靶器官表现（2026-10-19 起不按急症收回剂量）：写给患者的复测与就诊提示。 */
  | { kind: "severe_hypertension_followup"; reading: string }
  /** 病历写的发病诱因食物（海鲜、啤酒…）：服药期间及以后避开（留出集 S128）。 */
  | { kind: "trigger_foods"; foods: string[] }
  /** 痛风：低嘌呤饮食、限酒（尤其啤酒）、多饮水（《中国高尿酸血症与痛风诊疗指南》2019）。留出集 S145。 */
  | { kind: "gout_diet" }
  /**
   * 正在用抗凝或抗血小板药（drugs，病历原文药名），或病历写着通常须抗栓的情形而没写药名（indication：支架术后、深静脉血栓、房颤…）：
   * 方中有知识库标注「出血倾向/月经期/抗凝状态」慎用的活血药时，写一条出血观察（2026-10-19 Claude 评审 M 集 MTCMB-7、42、62）。
   * 方中没有这类药时交付面不补。
   */
  | { kind: "antithrombotic_bleeding"; drugs: string[]; indication?: string }
  /** 糖尿病（病历或已签名诊断）：写一条按医嘱控糖、监测血糖、少吃甜食；饮食段里推荐的高糖食物去掉（2026-10-19 M 集 TCM-SD-453850、RobustSDT-0141、BEST4SDT-250）。 */
  /**
   * 不是要写的项目：病历里写到的成药、西药名（说明书目录认得的带剂型药名，加上取名办法取到的药名）。交付面据此核对注意事项里点名的药
   *（2026-10-19 留出例 S145：病历与推荐药里都没有的「连翘败毒丸」被写成「不要再服」）。与 mobility_limited_exercise 一样只用于核对，不进注意事项。
   */
  | { kind: "recorded_drug_names"; names: string[] }
  /**
   * 高危基础情况（2026-11-14 第四十五轮，甲方 100 例 C100：91 岁、慢性肾病 4 期、血钾 5.6、服华法林和地高辛，注意事项只有一句「饮食清淡」；
   * C036：肌酐 258、血钾 5.8、服厄贝沙坦和呋塞米，方中有附子）。与剂量边界同一份判据（highRiskConditionsForPrecautions），各写一条给患者的话。
   */
  | { kind: "high_risk_condition"; conditions: Array<"renal" | "heart_failure" | "hyperkalemia" | "hyperkalemia_diet" | "digoxin" | "immunosuppression">; potassium?: string }
  /**
   * 病历写着在用的西药与本例已记录的病情相抵（说明书禁用、指南避免）：二甲双胍与 eGFR<30、非甾体抗炎药与阿司匹林诱发哮喘或肾功能减退
   *（第四十六轮 p100c-C034、new45-n40）。规则与原文出处在 western-drug-condition-cautions.source.json；这些药不再进「正在服用的药，是否继续由医生决定」一条。
   */
  | { kind: "drug_condition_caution"; ruleId: string; drug: string; sentence: string }
  /**
   * 正在服华法林而本例要服中药汤剂（第四十六轮 p100c-C100、C020）：说明书写明开始或停用植物药时更频繁监测 INR，人参可减弱华法林作用。
   * 方中有没有人参类按最终处方在交付面核（decreaseHerbs）。
   */
  | { kind: "warfarin_herbal"; drug: string; decreaseHerbs: string[] }
  | {
      kind: "diabetes_glucose";
      /** 本次是低血糖（病历记录血糖低于 3.9mmol/L 或写明低血糖发作）：那一句写低血糖的处置，不写「少吃甜食」（2026-11-14 第四十五轮 C032，血糖 2.4）。 */
      hypoglycemia?: true;
      /** 病历写着患者本人有糖尿病，或已签名西医诊断是糖尿病（不是「待查」）；只有中医病名消渴、或「糖尿病待查」的为 false：那一句写成尽早查血糖。 */
      confirmed: boolean;
      /** 病历否认糖尿病、本次才查出血糖明显升高（第四十六轮 new45-n02）：不说「您有糖尿病，继续控制血糖」，写成尽快明确诊断与治疗。 */
      newlyFound?: true;
    };

/** 自行停用的那类药在给患者的话里怎么称呼。 */
export function discontinuedMedicationLabel(item: Extract<RequiredPrecaution, { kind: "self_discontinued_medication" }>): string {
  if (item.names.length > 0) return item.names.join("、");
  if (item.condition === "高血压") return "降压药";
  if (item.condition === "糖尿病") return "降糖药";
  return item.condition ? `治疗${item.condition}的药` : "原来长期服用的药";
}

type HighRiskConditionItem = Extract<RequiredPrecaution, { kind: "high_risk_condition" }>;
const HIGH_POTASSIUM_DIET_SENTENCE = String((drugConditionJson as { highPotassiumFoods?: { sentence?: string } }).highPotassiumFoods?.sentence || "少吃含钾高的食物");
/** 含钾高的食物（饮食段推荐时去掉；NKF「Potassium and Your CKD Diet」）。 */
export const HIGH_POTASSIUM_FOODS: readonly string[] = (drugConditionJson as { highPotassiumFoods?: { foods?: string[] } }).highPotassiumFoods?.foods || [];
/**
 * 高危基础情况写给患者的话，一种情况一小句（2026-11-14 第四十五轮）。只说病历记录的事实与常规的观察要点（KDIGO：肾功能不全用药按肾功能调整、
 * 监测血钾；洋地黄中毒的常见表现：恶心呕吐、视物黄绿、心跳过慢），不写剂量。
 */
const HIGH_RISK_CONDITION_SENTENCES: Record<HighRiskConditionItem["conditions"][number], (item: HighRiskConditionItem) => string> = {
  renal: () => "您肾功能明显减退，本方须由医生按肾功能核定后再服，服药期间定期复查肾功能和血钾；尿量明显减少、浮肿加重时请立即就医",
  heart_failure: () => "您有心力衰竭，服药期间请按医嘱继续原有治疗，每天留意体重和浮肿；气短加重、不能平卧时请立即就医",
  hyperkalemia: (item) => `本次血钾偏高${item.potassium ? `（${item.potassium}）` : ""}，请遵医嘱尽快复查血钾，不要自行服用补钾药、低钠盐或含钾高的补品`,
  // 饮食限钾（第四十六轮 new45-n40：血钾 5.7，饮食段没有限钾）。食物与出处在 western-drug-condition-cautions.source.json highPotassiumFoods（NKF）。
  hyperkalemia_diet: () => HIGH_POTASSIUM_DIET_SENTENCE,
  digoxin: () => "您正在服用地高辛，与中药同服须由医生核定；出现恶心呕吐、视物发黄或发绿、心跳明显变慢时请立即就医",
  immunosuppression: () => "您正在使用免疫抑制治疗，服药期间如出现发热、咳嗽、尿痛等感染表现请及时就医，并按医嘱复查肝肾功能",
};
export function highRiskConditionLine(item: HighRiskConditionItem, missing: readonly HighRiskConditionItem["conditions"][number][] = item.conditions): string {
  return `${missing.map((condition) => HIGH_RISK_CONDITION_SENTENCES[condition](item)).join("；")}。`;
}
export function highRiskConditionPromptText(item: HighRiskConditionItem): string {
  return `病历记录的高危基础情况，各写一句给患者的话（照下面的意思写，不写剂量）：${highRiskConditionLine(item)}`;
}
/** 注意事项里还没写到的那几种情况（按关键词核：肾功能、心衰、血钾、地高辛、免疫抑制或感染）。 */
export function highRiskConditionsMissing(item: HighRiskConditionItem, lines: readonly string[]): HighRiskConditionItem["conditions"][number][] {
  const covered: Record<HighRiskConditionItem["conditions"][number], (line: string) => boolean> = {
    renal: (line) => /肾功能|肾病|肾衰/u.test(line) && /复查|核定|监测|调整/u.test(line),
    heart_failure: (line) => /心衰|心力衰竭/u.test(line),
    hyperkalemia: (line) => /血钾|高钾/u.test(line),
    hyperkalemia_diet: (line) => /含钾|钾高的食|高钾食物|限钾/u.test(line),
    digoxin: (line) => /地高辛/u.test(line) && /恶心|视物|心跳|心率|核定|医生/u.test(line),
    immunosuppression: (line) => /免疫抑制/u.test(line) && /感染|发热/u.test(line),
  };
  return item.conditions.filter((condition) => !lines.some((line) => covered[condition](line)));
}

/** 按药病规则逐项核对：同一药的另一条风险提示不能抵扣本条；同一行须点名药、病情和相应处置。 */
export function drugConditionPrecautionCovered(item: Extract<RequiredPrecaution, { kind: "drug_condition_caution" }>, lines: readonly string[]): boolean {
  const rules = drugConditionContraindications as { rules: Array<{ id: string; coverage?: { allOf: string[][]; actionTerms?: string[] } }> };
  const coverage = rules.rules.find((rule) => rule.id === item.ruleId)?.coverage;
  const drug = item.drug.replace(/(?:片|胶囊|颗粒|丸|口服液|注射液|缓释片|肠溶片|分散片)$/u, "");
  return lines.some((line) => line.includes(drug) && (coverage?.actionTerms ? coverage.actionTerms.some((term) => line.includes(term)) : /停用|禁用|避免|调整|不宜|不要再/u.test(line)) &&
    !/是否继续(?:服用|使用)?由医生决定/u.test(line) &&
    (!coverage || coverage.allOf.every((terms) => terms.some((term) => line.includes(term)))));
}

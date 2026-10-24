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
  | { kind: "postpartum_lactation" }
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
  | {
      kind: "diabetes_glucose";
      /** 病历写着患者本人有糖尿病，或已签名西医诊断是糖尿病（不是「待查」）；只有中医病名消渴、或「糖尿病待查」的为 false：那一句写成尽早查血糖。 */
      confirmed: boolean;
    };

/** 自行停用的那类药在给患者的话里怎么称呼。 */
export function discontinuedMedicationLabel(item: Extract<RequiredPrecaution, { kind: "self_discontinued_medication" }>): string {
  if (item.names.length > 0) return item.names.join("、");
  if (item.condition === "高血压") return "降压药";
  if (item.condition === "糖尿病") return "降糖药";
  return item.condition ? `治疗${item.condition}的药` : "原来长期服用的药";
}

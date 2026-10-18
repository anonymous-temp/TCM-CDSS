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
    }
  /** 病历写着自行停了长期用药（留出集 S178：高血压急症、一个月前自行停降压药）：由医生评估后规律服用，不要再自行停药。 */
  | { kind: "self_discontinued_medication"; names: string[]; condition?: string }
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
  /** 病历写着自行配制、泡酒服用的药里有药典标注有毒的药（留出集 S190：自泡生草乌、生川乌药酒）：立即停用，不再自制。 */
  | { kind: "toxic_self_preparation"; herbs: string[] }
  /** 服法与忌口（2026-10-19 验收主集 J：几例注意事项只写调护、没写怎么服或忌什么）。忌口按已定证候的寒热湿积推出。 */
  | { kind: "administration_and_diet"; diet: string; administration: boolean }
  /** 育龄女性、妊娠与哺乳状态都没记录（验收主集 J 3 例判缺）：服药前告知医生，方中孕妇慎用药点名。 */
  | { kind: "reproductive_status_unknown" }
  /** 重度高血压（≥180/120）而无急性靶器官表现（2026-10-19 起不按急症收回剂量）：写给患者的复测与就诊提示。 */
  | { kind: "severe_hypertension_followup"; reading: string }
  /** 病历写的发病诱因食物（海鲜、啤酒…）：服药期间及以后避开（留出集 S128）。 */
  | { kind: "trigger_foods"; foods: string[] }
  /** 痛风：低嘌呤饮食、限酒（尤其啤酒）、多饮水（《中国高尿酸血症与痛风诊疗指南》2019）。留出集 S145。 */
  | { kind: "gout_diet" };

/** 自行停用的那类药在给患者的话里怎么称呼。 */
export function discontinuedMedicationLabel(item: Extract<RequiredPrecaution, { kind: "self_discontinued_medication" }>): string {
  if (item.names.length > 0) return item.names.join("、");
  if (item.condition === "高血压") return "降压药";
  if (item.condition === "糖尿病") return "降糖药";
  return item.condition ? `治疗${item.condition}的药` : "原来长期服用的药";
}

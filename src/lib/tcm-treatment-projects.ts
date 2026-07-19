export const TCM_TREATMENT_PROJECT_CODES = [
  "acupuncture", "moxibustion", "tuina", "cupping", "guasha", "needle_knife",
  "acupoint_application", "medicated_plaster", "fumigation_wash", "medicated_bath",
  "auricular", "thread_embedding", "medicated_ironing", "bloodletting", "fire_cautery",
  "hook_cutting", "thread_drainage", "ligation", "diet_therapy", "mind_therapy",
  "qigong_daoyin", "miscellaneous",
] as const;

export const TCM_TREATMENT_INDICATION_TAGS = [
  "digestive",
  "respiratory",
  "musculoskeletal_pain",
  "neurologic_rehabilitation",
  "gynecology",
  "dermatology",
  "headache",
  "sleep_emotion",
  "metabolic_rehabilitation",
  "anorectal",
] as const;

export type TcmTreatmentProjectCode = typeof TCM_TREATMENT_PROJECT_CODES[number];
export type TcmTreatmentIndicationTag = typeof TCM_TREATMENT_INDICATION_TAGS[number];
export type TcmTreatmentProjectRisk = "low" | "moderate" | "specialist";

export type TcmTreatmentProjectDefinition = {
  code: TcmTreatmentProjectCode;
  name: string;
  risk: TcmTreatmentProjectRisk;
  indicationTags: readonly TcmTreatmentIndicationTag[];
  containsMedication: boolean;
  requiresMedicationAudit: boolean;
  operatorRequirement: string;
  safetyFocus: string;
  aliases: string[];
};

type ProjectCatalogInput = Omit<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit"> &
  Partial<Pick<TcmTreatmentProjectDefinition, "containsMedication" | "requiresMedicationAudit">>;

function defineProject(definition: ProjectCatalogInput): TcmTreatmentProjectDefinition {
  const containsMedication = definition.containsMedication === true;
  const requiresMedicationAudit = definition.requiresMedicationAudit === true;
  if (containsMedication !== requiresMedicationAudit) {
    throw new Error(`Medication governance metadata must agree for ${definition.code}`);
  }
  return { ...definition, containsMedication, requiresMedicationAudit };
}

export const TCM_TREATMENT_PROJECTS: readonly TcmTreatmentProjectDefinition[] = [
  defineProject({
    code: "acupuncture",
    name: "针刺疗法",
    risk: "moderate",
    indicationTags: ["digestive", "respiratory", "musculoskeletal_pain", "neurologic_rehabilitation", "gynecology", "dermatology", "headache", "sleep_emotion", "metabolic_rehabilitation"],
    operatorRequirement: "由具备相应资质的中医执业人员操作",
    safetyFocus: "出血倾向、抗凝用药、妊娠相关穴位、局部感染和晕针史",
    aliases: ["针刺", "针灸"],
  }),
  defineProject({
    code: "moxibustion",
    name: "灸法",
    risk: "moderate",
    indicationTags: ["digestive", "respiratory", "musculoskeletal_pain", "gynecology", "sleep_emotion", "metabolic_rehabilitation"],
    operatorRequirement: "由受训医务人员评估火源、温度和皮肤耐受",
    safetyFocus: "感觉障碍、糖尿病足、发热热证、皮损和烫伤风险",
    aliases: ["艾灸", "灸"],
  }),
  defineProject({
    code: "tuina",
    name: "推拿疗法",
    risk: "moderate",
    indicationTags: ["digestive", "respiratory", "musculoskeletal_pain", "neurologic_rehabilitation", "metabolic_rehabilitation"],
    operatorRequirement: "由具备相应资质的人员操作",
    safetyFocus: "骨折、严重骨质疏松、脊髓压迫、急性炎症和妊娠禁忌部位",
    aliases: ["推拿", "按摩"],
  }),
  defineProject({
    code: "cupping",
    name: "拔罐疗法",
    risk: "moderate",
    indicationTags: ["respiratory", "musculoskeletal_pain"],
    operatorRequirement: "由受训人员操作并控制留罐时间",
    safetyFocus: "皮肤破损、出血倾向、抗凝治疗、感觉障碍和感染",
    aliases: ["拔罐"],
  }),
  defineProject({
    code: "guasha",
    name: "刮痧疗法",
    risk: "moderate",
    indicationTags: ["respiratory", "musculoskeletal_pain", "dermatology"],
    operatorRequirement: "由受训人员操作",
    safetyFocus: "出血倾向、抗凝治疗、皮损、感染和高热衰弱",
    aliases: ["刮痧"],
  }),
  defineProject({
    code: "needle_knife",
    name: "针刀",
    risk: "specialist",
    indicationTags: ["musculoskeletal_pain"],
    operatorRequirement: "仅限具备针刀诊疗资质和无菌操作条件的机构",
    safetyFocus: "解剖风险、出血感染、神经血管损伤及明确适应证",
    aliases: ["针刀疗法", "小针刀"],
  }),
  defineProject({
    code: "acupoint_application",
    name: "敷贴",
    risk: "moderate",
    indicationTags: ["digestive", "respiratory", "musculoskeletal_pain", "gynecology"],
    containsMedication: true,
    requiresMedicationAudit: true,
    operatorRequirement: "由医务人员选穴、选药并评估皮肤反应",
    safetyFocus: "过敏史、皮损、儿童皮肤耐受、发泡药物和敷贴时长",
    aliases: ["穴位贴敷", "敷贴疗法"],
  }),
  defineProject({
    code: "medicated_plaster",
    name: "膏药",
    risk: "moderate",
    indicationTags: ["musculoskeletal_pain"],
    containsMedication: true,
    requiresMedicationAudit: true,
    operatorRequirement: "由医生确认适应证、成分和使用时长",
    safetyFocus: "接触性皮炎、破损皮肤、妊娠禁忌成分和重复外用",
    aliases: ["中药膏药"],
  }),
  defineProject({
    code: "fumigation_wash",
    name: "熏洗",
    risk: "moderate",
    indicationTags: ["musculoskeletal_pain", "gynecology", "dermatology", "anorectal"],
    containsMedication: true,
    requiresMedicationAudit: true,
    operatorRequirement: "由医生确定外用方和温度",
    safetyFocus: "烫伤、皮肤破损、感觉障碍、感染和外用药过敏",
    aliases: ["熏洗疗法", "中药熏洗"],
  }),
  defineProject({
    code: "medicated_bath",
    name: "药浴",
    risk: "moderate",
    indicationTags: ["musculoskeletal_pain", "dermatology"],
    containsMedication: true,
    requiresMedicationAudit: true,
    operatorRequirement: "由医生确定药物、温度和时长",
    safetyFocus: "心血管不稳定、烫伤、皮损感染、过敏和儿童老人监护",
    aliases: ["中药药浴"],
  }),
  defineProject({
    code: "auricular",
    name: "耳穴",
    risk: "moderate",
    indicationTags: ["digestive", "musculoskeletal_pain", "gynecology", "headache", "sleep_emotion", "metabolic_rehabilitation"],
    operatorRequirement: "由受训人员辨穴并指导按压",
    safetyFocus: "耳部皮损感染、胶布或籽粒过敏和刺激强度",
    aliases: ["耳穴压豆", "耳针"],
  }),
  defineProject({
    code: "thread_embedding",
    name: "埋线",
    risk: "specialist",
    indicationTags: ["respiratory", "musculoskeletal_pain", "gynecology", "metabolic_rehabilitation"],
    operatorRequirement: "仅限具备相应资质和无菌操作条件的机构",
    safetyFocus: "植入物过敏、感染、出血、妊娠和局部解剖风险",
    aliases: ["穴位埋线"],
  }),
  defineProject({
    code: "medicated_ironing",
    name: "药熨",
    risk: "moderate",
    indicationTags: ["digestive", "musculoskeletal_pain", "gynecology"],
    containsMedication: true,
    requiresMedicationAudit: true,
    operatorRequirement: "由医务人员确定药物和温度",
    safetyFocus: "烫伤、感觉障碍、皮肤破损和外用药过敏",
    aliases: ["中药热熨", "药熨疗法"],
  }),
  defineProject({
    code: "bloodletting",
    name: "放血",
    risk: "specialist",
    indicationTags: ["musculoskeletal_pain", "dermatology"],
    operatorRequirement: "仅限具备相应资质和无菌操作条件的机构",
    safetyFocus: "凝血功能、抗凝用药、贫血、感染和晕针风险",
    aliases: ["刺络放血", "放血疗法"],
  }),
  defineProject({
    code: "fire_cautery",
    name: "火烙",
    risk: "specialist",
    indicationTags: ["dermatology", "anorectal"],
    operatorRequirement: "仅限具备专项资质和完整急救条件的机构",
    safetyFocus: "烧伤、瘢痕、感染、适应证和术后处理",
    aliases: ["火烙法"],
  }),
  defineProject({
    code: "hook_cutting",
    name: "钩割",
    risk: "specialist",
    indicationTags: ["musculoskeletal_pain"],
    operatorRequirement: "仅限具备专项资质和无菌手术条件的机构",
    safetyFocus: "解剖损伤、出血、感染、明确适应证和术后处理",
    aliases: ["钩割疗法"],
  }),
  defineProject({
    code: "thread_drainage",
    name: "挂线",
    risk: "specialist",
    indicationTags: ["anorectal"],
    operatorRequirement: "仅限具备外科专项资质和随访条件的机构",
    safetyFocus: "明确外科适应证、感染、出血、疼痛控制和术后随访",
    aliases: ["挂线疗法"],
  }),
  defineProject({
    code: "ligation",
    name: "结扎",
    risk: "specialist",
    indicationTags: ["anorectal"],
    operatorRequirement: "仅限具备外科专项资质和随访条件的机构",
    safetyFocus: "明确外科适应证、组织坏死、感染、出血和术后随访",
    aliases: ["结扎疗法"],
  }),
  defineProject({
    code: "diet_therapy",
    name: "食疗法",
    risk: "low",
    indicationTags: ["digestive", "respiratory", "gynecology", "dermatology", "sleep_emotion", "metabolic_rehabilitation"],
    operatorRequirement: "由医生结合证候、营养状况和慢病限制指导",
    safetyFocus: "食物过敏、糖脂代谢、肾功能和药食相互作用",
    aliases: ["食疗", "药膳"],
  }),
  defineProject({
    code: "mind_therapy",
    name: "意疗法",
    risk: "low",
    indicationTags: ["sleep_emotion"],
    operatorRequirement: "由医生进行情志评估和规范指导",
    safetyFocus: "严重精神症状、自伤风险和需专科转诊的情况",
    aliases: ["意疗", "情志疗法"],
  }),
  defineProject({
    code: "qigong_daoyin",
    name: "气功导引疗法",
    risk: "low",
    indicationTags: ["respiratory", "musculoskeletal_pain", "neurologic_rehabilitation", "sleep_emotion", "metabolic_rehabilitation"],
    operatorRequirement: "由受训人员按体能和病情分级指导",
    safetyFocus: "心肺不稳定、跌倒风险、急性疼痛和运动禁忌",
    aliases: ["气功", "导引", "导引疗法"],
  }),
  defineProject({
    code: "miscellaneous",
    name: "杂疗法",
    risk: "moderate",
    indicationTags: ["digestive", "respiratory", "musculoskeletal_pain", "neurologic_rehabilitation", "gynecology", "dermatology", "sleep_emotion", "metabolic_rehabilitation", "anorectal"],
    operatorRequirement: "必须先明确具体项目、适应证、资质和操作规范",
    safetyFocus: "未明确具体技术时不得给出操作参数或疗程",
    aliases: ["杂疗"],
  }),
];

const PROJECT_BY_CODE = new Map(TCM_TREATMENT_PROJECTS.map((item) => [item.code, item]));
const PROJECT_CODE_BY_ALIAS = new Map(TCM_TREATMENT_PROJECTS.flatMap((item) =>
  [item.code, item.name, ...item.aliases].map((alias) => [alias.toLowerCase(), item.code] as const)
));

export function isKnownTcmTreatmentProjectCode(value: unknown): value is TcmTreatmentProjectCode {
  return typeof value === "string" && PROJECT_BY_CODE.has(value as TcmTreatmentProjectCode);
}

export function parseTcmTreatmentCapabilities(value: unknown): TcmTreatmentProjectCode[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，;；|]/)
      : [];
  return [...new Set(entries.flatMap((entry) => {
    const normalized = String(entry || "").trim().toLowerCase();
    const code = PROJECT_CODE_BY_ALIAS.get(normalized);
    return code ? [code] : [];
  }))];
}

export function getTcmTreatmentProjectDefinition(code: TcmTreatmentProjectCode): TcmTreatmentProjectDefinition | undefined {
  return PROJECT_BY_CODE.get(code);
}

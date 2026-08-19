import { matchingMedicineClinicalProblemTerms } from "./medicine-clinical-concepts";

type DiagnosticReferenceEntry = {
  problemKey: string;
  record: string;
};

/**
 * EviMed 对少数“症状层工作诊断”没有稳定命中时使用的受治理权威依据。
 * 每条均有可公开核验的原始页面；只按当前病例文字逐条注入，不作为通用兜底。
 */
const LOCAL_DIAGNOSTIC_REFERENCES: readonly DiagnosticReferenceEntry[] = [
  {
    problemKey: "下肢感觉异常",
    record: "[EVID-GUIDE-901] Evaluation of Distal Symmetric Polyneuropathy: Role of Laboratory and Genetic Testing（American Academy of Neurology，2009，2025年重申）：下肢感觉异常或麻木在考虑周围神经病时，应结合神经查体和有针对性的病因筛查，不以单一症状直接确诊。 URL:https://www.aan.com/Guidelines/home/GuidelineDetail/315",
  },
  {
    problemKey: "泌乳不足",
    record: "[EVID-GUIDE-902] Breastfeeding Challenges（American College of Obstetricians and Gynecologists，2021）：泌乳不足需区分主观担忧、乳汁生成不足和乳汁转移不足，并结合母婴喂养史与评估。 URL:https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2021/02/breastfeeding-challenges",
  },
  {
    problemKey: "阴道干涩",
    record: "[EVID-GUIDE-903] reVITALize: Gynecology Data Definitions（American College of Obstetricians and Gynecologists）：阴道干涩可见于低雌激素相关状态；诊断需结合年龄、生理阶段、伴随症状和相关病因评估。 URL:https://www.acog.org/practice-management/health-it-and-clinical-informatics/revitalize-gynecology-data-definitions",
  },
  {
    problemKey: "呃逆",
    record: "[EVID-PAPER-904] Singultus - Diagnostic Workup and Therapy（呃逆的诊断评估与治疗）（Der Nervenarzt，2017，PMID:28768356）：持续或顽固性呃逆需评估胃食管、神经系统及其他潜在病因。 URL:https://pubmed.ncbi.nlm.nih.gov/28768356/",
  },
  {
    problemKey: "面部丘疹",
    record: "[EVID-PAPER-905] Acneiform eruptions（痤疮样面部丘疹的鉴别）（Clinics in Dermatology，2014，PMID:24314375，DOI:10.1016/j.clindermatol.2013.05.023）：面部丘疹需结合粉刺、分布、药物暴露及其他痤疮样皮病进行鉴别。 URL:https://pubmed.ncbi.nlm.nih.gov/24314375/",
  },
  {
    problemKey: "癫痫",
    record: "[EVID-GUIDE-906] Epilepsies in children, young people and adults（NICE NG217，2022，2025年更新）：癫痫诊断应结合发作史、目击信息、查体及适当的脑电图和影像评估，并由具备相应经验的临床人员完成。 URL:https://www.nice.org.uk/guidance/ng217/chapter/diagnosis-and-assessment-of-epilepsy",
  },
  {
    problemKey: "尿路感染",
    record: "[EVID-GUIDE-907] EAU Guidelines on Urological Infections（European Association of Urology，2026）：尿路感染诊断应区分局限性与系统性感染，并依据下尿路症状、阴道症状、尿检/培养指征及复发或复杂因素综合判断。 URL:https://uroweb.org/guidelines/urological-infections/chapter/the-guideline",
  },
  {
    problemKey: "多汗症",
    record: "[EVID-GUIDE-908] 原发性局所多汗症诊疗指南2023年改订版（日本皮肤科学会，2023，DOI:10.14924/dermatol.133.157）：多汗症需结合病程、分布、睡眠期变化、发作频率及继发病因进行分类与诊断。 URL:https://www.jstage.jst.go.jp/article/dermatol/133/2/133_157/_article/-char/ja/",
  },
  {
    problemKey: "盆腔炎",
    record: "[EVID-GUIDE-909] Pelvic Inflammatory Disease (PID) - STI Treatment Guidelines（U.S. Centers for Disease Control and Prevention，2021）：盆腔炎诊断需结合盆腔/下腹症状、妇科查体、下生殖道炎症证据及必要的影像或病原学评估，并注意排除其他病因。 URL:https://www.cdc.gov/std/treatment-guidelines/pid.htm",
  },
  {
    problemKey: "多关节疼痛",
    record: "[EVID-PAPER-910] Polyarticular Joint Pain in Adults: Evaluation and Differential Diagnosis（American Family Physician，2023，PMID:36689970）：多关节疼痛需先区分关节内外、炎症性与非炎症性模式，再按受累分布、滑膜炎和系统表现选择实验室与影像检查。 URL:https://pubmed.ncbi.nlm.nih.gov/36689970/",
  },
  {
    problemKey: "白带异常",
    record: "[EVID-GUIDE-911] Diseases Characterized by Vulvovaginal Itching, Burning, Irritation, Odor or Discharge（U.S. Centers for Disease Control and Prevention，2021）：白带异常仅凭病史不足以确定病因，应结合查体、阴道pH、显微检查或适当的病原学检测鉴别。 URL:https://www.cdc.gov/std/treatment-guidelines/vaginal-discharge.htm",
  },
  {
    problemKey: "唇炎",
    record: "[EVID-PAPER-912] Cheilitis: A Diagnostic Algorithm and Review of Underlying Etiologies（Dermatitis，2024，PMID:38422211，DOI:10.1089/derm.2023.0276）：唇炎需结合病程、接触物、日晒、感染、营养与系统性疾病线索进行病因分类。 URL:https://pubmed.ncbi.nlm.nih.gov/38422211/",
  },
  {
    problemKey: "冻疮",
    record: "[EVID-GUIDE-913] Chilblains (Pernio)（DermNet，2021）：冻疮通常依据寒冷暴露后的肢端红肿、痒痛及季节性临床诊断，必要时排查结缔组织病等继发原因。 URL:https://dermnetnz.org/topics/chilblains",
  },
  {
    problemKey: "背部感觉异常",
    record: "[EVID-PAPER-914] Notalgia Paresthetica: An Updated Review of Pathophysiology, Diagnosis, and Treatment Approaches（Current Pain and Headache Reports，2025，PMID:40397314，DOI:10.1007/s11916-025-01402-2）：慢性局限性背部感觉异常需结合分布、神经系统查体及脊神经受压等病因进行鉴别。 URL:https://pubmed.ncbi.nlm.nih.gov/40397314/",
  },
  {
    problemKey: "睑缘炎",
    record: "[EVID-GUIDE-915] Blepharitis Preferred Practice Pattern（American Academy of Ophthalmology，2024）：睑缘炎以病史和眼睑/睑缘检查为主要诊断依据，反复或重症时可根据表现选择培养等检查。 URL:https://eyewiki.aao.org/Blepharitis",
  },
  {
    problemKey: "慢性肝损伤",
    record: "[EVID-GUIDE-916] ACG Clinical Guideline: Evaluation of Abnormal Liver Chemistries（American College of Gastroenterology，2017，PMID:27995906，DOI:10.1038/ajg.2016.517）：慢性肝损伤或肝功能异常需按肝细胞型、胆汁淤积型及胆红素异常模式分层，并结合病毒性、代谢性、自身免疫性、药物性等病因评估。 URL:https://pubmed.ncbi.nlm.nih.gov/27995906/",
  },
  {
    problemKey: "咳嗽",
    record: "[EVID-GUIDE-917] ERS guidelines on the diagnosis and treatment of chronic cough in adults and children（European Respiratory Society，2020，PMID:31515408，DOI:10.1183/13993003.01136-2019）：咳嗽诊断应结合病程、危险信号、肺部及上气道/反流等可治疗病因分层评估。 URL:https://pubmed.ncbi.nlm.nih.gov/31515408/",
  },
  {
    problemKey: "银屑病",
    record: "[EVID-GUIDE-918] Psoriasis: assessment and management（NICE CG153，2012，2017年更新）：银屑病需评估皮损形态与范围、严重度、特殊部位、银屑病关节炎及相关共病；诊断不确定时转皮肤专科。 URL:https://www.nice.org.uk/guidance/cg153",
  },
  {
    problemKey: "甲状腺结节",
    record: "[EVID-GUIDE-919] 2015 American Thyroid Association Management Guidelines for Adult Patients with Thyroid Nodules and Differentiated Thyroid Cancer（American Thyroid Association，2016，PMID:26462967，DOI:10.1089/thy.2015.0020）：甲状腺结节应结合超声风险特征、大小及临床因素决定随访或细针穿刺评估。 URL:https://pubmed.ncbi.nlm.nih.gov/26462967/",
  },
  {
    problemKey: "功能性消化不良",
    record: "[EVID-GUIDE-920] ACG and CAG Clinical Guideline: Management of Dyspepsia（American College of Gastroenterology / Canadian Association of Gastroenterology，2017，PMID:28631728）：消化不良诊断需结合年龄、报警特征、幽门螺杆菌与必要的内镜评估，并在排除结构性病变后考虑功能性消化不良。 URL:https://pubmed.ncbi.nlm.nih.gov/28631728/",
  },
  {
    problemKey: "急性皮炎",
    record: "[EVID-GUIDE-921] Contact dermatitis（DermNet）：急性皮炎出现红斑、水疱和瘙痒时，需结合接触史、分布形态和必要的斑贴试验鉴别刺激性、过敏性及其他湿疹样皮炎。 URL:https://dermnetnz.org/topics/contact-dermatitis",
  },
  {
    problemKey: "下消化道出血",
    record: "[EVID-GUIDE-922] 下消化道出血诊治指南（2020）（中华医学会消化内镜学分会结直肠学组、中国医师协会消化医师分会结直肠学组、国家消化系统疾病临床医学研究中心）：便血或疑似下消化道出血需结合血流动力学、病史、查体、实验室检查及内镜/影像定位分层评估。 URL:https://cmab.yiigle.com/uploads/guide_html/%E4%B8%8B%E6%B6%88%E5%8C%96%E9%81%93%E5%87%BA%E8%A1%80%E8%AF%8A%E6%B2%BB%E6%8C%87%E5%8D%97%282020%29%20-%20%E4%B8%AD%E5%8D%8E%E6%B6%88%E5%8C%96%E5%86%85%E9%95%9C%E6%9D%82%E5%BF%97.html",
  },
  {
    problemKey: "不孕症",
    record: "[EVID-GUIDE-923] Guideline for the prevention, diagnosis and treatment of infertility（World Health Organization，2025，ISBN:978-92-4-011577-4）：不孕症通常指规律无保护性生活12个月或以上未获得妊娠；诊断需按双方病史、年龄、排卵、输卵管/子宫及男性因素逐步评估。 URL:https://www.who.int/publications/i/item/9789240115774",
  },
  {
    problemKey: "胃食管反流",
    record: "[EVID-GUIDE-924] Katz PO, et al. ACG Clinical Guideline for the Diagnosis and Management of Gastroesophageal Reflux Disease. Am J Gastroenterol. 2022;117(1):27-56. PMID:34807007. DOI:10.14309/ajg.0000000000001538：反酸、烧心等典型反流症状需结合报警特征及必要的内镜或反流监测进行诊断分层。 URL:https://pubmed.ncbi.nlm.nih.gov/34807007/",
  },
] as const;

export function localDiagnosticReferenceContext(clinicalText: string): string {
  const problemKeys = new Set(matchingMedicineClinicalProblemTerms(clinicalText));
  const matched = LOCAL_DIAGNOSTIC_REFERENCES
    .filter((entry) => problemKeys.has(entry.problemKey))
    .map((entry) => entry.record);
  if (matched.length === 0) return "";
  return [
    "## 诊断参考依据",
    "以下条目仅用于与当前症状相关的诊断评估或鉴别，不替代患者事实与现场检查：",
    ...matched,
  ].join("\n");
}

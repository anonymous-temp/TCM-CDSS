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

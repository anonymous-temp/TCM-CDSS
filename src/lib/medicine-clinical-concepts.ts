export type MedicineClinicalConcept = {
  key: string;
  axis: "syndrome" | "therapy" | "problem";
  casePattern: RegExp;
  indicationPattern: RegExp;
  weight: number;
};

/**
 * One governed concept table is shared by retrieval and evidence-bound output validation.
 * Syndrome and treatment-direction alignment outrank symptom overlap; a symptom remains useful
 * as a secondary signal and can still retrieve a bounded candidate in sparse cases.
 */
export const MEDICINE_CLINICAL_CONCEPTS: readonly MedicineClinicalConcept[] = [
  { key: "心脾两虚", axis: "syndrome", casePattern: /心脾两虚|心血不足.*脾气虚|脾气虚.*心血不足/, indicationPattern: /心脾两虚|补益心脾|益气养血.*安神/, weight: 7 },
  { key: "气血不足", axis: "syndrome", casePattern: /气血不足|气血两虚|气虚血虚/, indicationPattern: /气血不足|气血两虚|益气养血|补气养血/, weight: 6 },
  { key: "肝郁气滞", axis: "syndrome", casePattern: /肝郁气滞|肝气郁结|肝郁/, indicationPattern: /肝郁气滞|肝气郁结|疏肝解郁|疏肝理气/, weight: 7 },
  { key: "肝火痰热", axis: "syndrome", casePattern: /肝火|痰热|火扰心神/, indicationPattern: /肝火|痰热|清肝泻火|清热化痰/, weight: 7 },
  { key: "阴虚火旺", axis: "syndrome", casePattern: /阴虚火旺|阴虚内热|虚火/, indicationPattern: /阴虚火旺|阴虚内热|滋阴降火|滋阴清热/, weight: 7 },
  { key: "脾胃虚弱", axis: "syndrome", casePattern: /脾胃虚弱|脾气虚|脾失健运/, indicationPattern: /脾胃虚弱|脾气虚|健脾益气|健脾和胃/, weight: 7 },
  { key: "肾阴虚", axis: "syndrome", casePattern: /肾阴虚|肾精不足/, indicationPattern: /肾阴虚|肾精不足|滋补肾阴|补肾填精/, weight: 7 },
  { key: "血瘀", axis: "syndrome", casePattern: /血瘀|瘀血|瘀阻/, indicationPattern: /血瘀|瘀血|活血化瘀|活血祛瘀/, weight: 6 },
  { key: "安神", axis: "therapy", casePattern: /安神|宁心|养心|镇静/, indicationPattern: /安神|宁心|养心|镇静/, weight: 5 },
  { key: "健脾", axis: "therapy", casePattern: /健脾|益气|补气/, indicationPattern: /健脾|益气|补气/, weight: 4 },
  { key: "疏肝", axis: "therapy", casePattern: /疏肝|解郁|理气/, indicationPattern: /疏肝|解郁|理气/, weight: 4 },
  { key: "感冒", axis: "problem", casePattern: /感冒|上呼吸道感染|恶寒|流涕|鼻塞|喷嚏/, indicationPattern: /感冒|上呼吸道感染|恶寒|流涕|鼻塞|喷嚏/, weight: 3 },
  { key: "发热", axis: "problem", casePattern: /发热|低热|高热|体温升高/, indicationPattern: /发热|低热|高热|身热/, weight: 2 },
  { key: "咳嗽", axis: "problem", casePattern: /咳嗽|干咳|咳痰/, indicationPattern: /咳嗽|干咳|咳痰|痰多/, weight: 3 },
  { key: "咽痛", axis: "problem", casePattern: /咽痛|咽喉痛|咽炎|扁桃体炎|咽干/, indicationPattern: /咽痛|咽喉(?:肿)?痛|咽炎|扁桃体炎|咽干/, weight: 3 },
  { key: "鼻炎", axis: "problem", casePattern: /鼻炎|鼻塞|流涕|喷嚏/, indicationPattern: /鼻炎|鼻塞|流涕|喷嚏/, weight: 2 },
  { key: "头痛", axis: "problem", casePattern: /头痛|头胀痛|偏头痛/, indicationPattern: /头痛|头胀|偏头痛/, weight: 3 },
  { key: "眩晕", axis: "problem", casePattern: /头晕|眩晕|头昏|目眩/, indicationPattern: /头晕|眩晕|头昏|目眩/, weight: 3 },
  { key: "失眠", axis: "problem", casePattern: /失眠|不寐|入睡困难|睡眠浅|夜醒|早醒|多梦/, indicationPattern: /失眠|不寐|入睡困难|睡眠浅|夜醒|多梦/, weight: 3 },
  { key: "心悸", axis: "problem", casePattern: /心悸|心慌|怔忡/, indicationPattern: /心悸|心慌|怔忡/, weight: 3 },
  { key: "胸痹", axis: "problem", casePattern: /冠心病|心绞痛|胸痛|胸闷/, indicationPattern: /冠心病|心绞痛|胸痛|胸闷|胸痹/, weight: 3 },
  { key: "高血压", axis: "problem", casePattern: /高血压|血压升高/, indicationPattern: /高血压|血压升高/, weight: 3 },
  { key: "胃脘痛", axis: "problem", casePattern: /胃痛|胃脘痛|上腹痛|胃炎/, indicationPattern: /胃痛|胃脘痛|上腹痛|胃炎/, weight: 3 },
  { key: "腹胀", axis: "problem", casePattern: /腹胀|脘腹胀|痞满/, indicationPattern: /腹胀|脘腹胀|痞满/, weight: 2 },
  { key: "食少纳差", axis: "problem", casePattern: /纳差|食少|食欲不振|食欲下降|消化不良/, indicationPattern: /纳差|食少|食欲不振|消化不良|不思饮食/, weight: 2 },
  { key: "恶心呕吐", axis: "problem", casePattern: /恶心|呕吐|呕逆|干呕/, indicationPattern: /恶心|呕吐|呕逆|干呕/, weight: 2 },
  { key: "胃食管反流", axis: "problem", casePattern: /胃食管反流|反酸|泛酸|烧心|嗳气/, indicationPattern: /胃食管反流|反酸|泛酸|烧心|嗳气/, weight: 3 },
  { key: "腹泻", axis: "problem", casePattern: /腹泻|泄泻|便溏|大便稀/, indicationPattern: /腹泻|泄泻|便溏|大便稀/, weight: 3 },
  { key: "便秘", axis: "problem", casePattern: /便秘|大便干|排便困难/, indicationPattern: /便秘|大便干|排便困难/, weight: 3 },
  { key: "痔", axis: "problem", casePattern: /痔疮|内痔|外痔|便血/, indicationPattern: /痔疮|内痔|外痔|便血/, weight: 2 },
  { key: "湿疹皮炎", axis: "problem", casePattern: /湿疹|皮炎|皮肤瘙痒|皮疹/, indicationPattern: /湿疹|皮炎|皮肤瘙痒|皮疹/, weight: 3 },
  { key: "跌打损伤", axis: "problem", casePattern: /跌打损伤|扭伤|挫伤|外伤后疼痛/, indicationPattern: /跌打损伤|扭伤|挫伤|外伤/, weight: 3 },
  { key: "关节肌肉痛", axis: "problem", casePattern: /关节痛|关节疼痛|肌肉痛|腰痛|颈痛|肩痛|风湿/, indicationPattern: /关节痛|关节疼痛|肌肉痛|腰痛|颈痛|肩痛|风湿/, weight: 3 },
  { key: "痛经", axis: "problem", casePattern: /痛经|经行腹痛/, indicationPattern: /痛经|经行腹痛/, weight: 3 },
  { key: "月经不调", axis: "problem", casePattern: /月经不调|经期紊乱|经量异常|闭经/, indicationPattern: /月经不调|经期紊乱|经量异常|闭经/, weight: 3 },
  { key: "乳腺胀痛", axis: "problem", casePattern: /乳房胀痛|乳腺增生|乳癖/, indicationPattern: /乳房胀痛|乳腺增生|乳癖/, weight: 3 },
  { key: "口腔溃疡", axis: "problem", casePattern: /口腔溃疡|口疮/, indicationPattern: /口腔溃疡|口疮/, weight: 3 },
  { key: "牙龈肿痛", axis: "problem", casePattern: /牙龈肿痛|牙痛|牙龈炎/, indicationPattern: /牙龈肿痛|牙痛|牙龈炎/, weight: 3 },
  { key: "耳鸣", axis: "problem", casePattern: /耳鸣|听力下降/, indicationPattern: /耳鸣|听力下降|耳聋/, weight: 3 },
  { key: "乏力", axis: "problem", casePattern: /乏力|神疲|倦怠|疲倦/, indicationPattern: /乏力|神疲|倦怠|疲倦|气虚/, weight: 2 },
] as const;

function medicineConceptGovernedId(index: number): string {
  return `MED-CONCEPT-${String(index + 1).padStart(3, "0")}`;
}

export function matchingMedicineClinicalConcepts(
  caseText: string,
  indicationText: string,
  additiveGovernedIds: readonly string[] = [],
): MedicineClinicalConcept[] {
  const additive = new Set(additiveGovernedIds);
  return MEDICINE_CLINICAL_CONCEPTS.filter((concept, index) =>
    (concept.casePattern.test(caseText) || additive.has(medicineConceptGovernedId(index))) &&
    concept.indicationPattern.test(indicationText));
}

export function medicineClinicalConceptsMatch(left: string, right: string): boolean {
  return MEDICINE_CLINICAL_CONCEPTS.some((concept) =>
    concept.casePattern.test(left) && (concept.casePattern.test(right) || concept.indicationPattern.test(right)));
}

export function matchingMedicineClinicalProblemTerms(caseText: string): string[] {
  return MEDICINE_CLINICAL_CONCEPTS
    .filter((concept) => concept.axis === "problem" && concept.casePattern.test(caseText))
    .map((concept) => concept.key);
}

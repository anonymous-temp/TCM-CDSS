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
  // 诊断证据检索用的精确问题词放在宽泛症状之后；buildEvidenceFallbackQueries 倒序消费，
  // 因而先查最终更可能采用的现代医学问题，避免“皮疹/月经不调/麻木”等宽词抢占前两次检索。
  // 同一表也服务药品说明书匹配，所以 indicationPattern 仍保持同病种闭合，不以症状跨病种召回药品。
  { key: "阴道炎", axis: "problem", casePattern: /阴道炎|带下.{0,16}(?:豆渣|腥臭|瘙痒)|阴部瘙痒.{0,12}带下/, indicationPattern: /阴道炎|阴道感染/, weight: 3 },
  { key: "异常子宫出血", axis: "problem", casePattern: /异常子宫出血|月经淋漓|阴道不规则流血|人流术后.{0,12}流血|月经.{0,12}量(?:逐渐)?减少|月经周期(?:1\d|20)天/, indicationPattern: /异常子宫出血|阴道不规则流血|崩漏/, weight: 3 },
  { key: "荨麻疹", axis: "problem", casePattern: /荨麻疹|风团|周身.{0,12}皮疹.{0,12}瘙痒|皮疹.{0,12}融合成片/, indicationPattern: /荨麻疹|风团/, weight: 3 },
  { key: "皮肤软组织感染", axis: "problem", casePattern: /皮肤软组织感染|软组织感染|小腿.{0,12}红肿.{0,12}(?:发热|疼痛)|局部红肿热痛/, indicationPattern: /皮肤软组织感染|软组织感染|蜂窝织炎/, weight: 3 },
  { key: "带状疱疹后神经痛", axis: "problem", casePattern: /带状疱疹后神经痛|(?:胸背|腰背).{0,8}疱疹.{0,12}疼痛|疱疹伴疼痛.{0,8}(?:月|周)/, indicationPattern: /带状疱疹后神经痛|疱疹后神经痛/, weight: 3 },
  { key: "寻常痤疮", axis: "problem", casePattern: /寻常痤疮|面部痤疮|面部.{0,12}红色丘疹.{0,8}触痛/, indicationPattern: /寻常痤疮|痤疮/, weight: 3 },
  { key: "癫痫", axis: "problem", casePattern: /癫痫|仆倒.{0,12}抽搐|抽搐.{0,12}牙关紧闭/, indicationPattern: /癫痫|癫痫发作/, weight: 3 },
  { key: "闭经", axis: "problem", casePattern: /闭经|停经|月经.{0,8}(?:未至|不来).{0,8}(?:月|天)/, indicationPattern: /闭经|继发性闭经/, weight: 3 },
  { key: "尿路感染", axis: "problem", casePattern: /尿路感染|尿痛.{0,8}尿频|尿频.{0,8}尿痛/, indicationPattern: /尿路感染|膀胱炎/, weight: 3 },
  { key: "湿疹", axis: "problem", casePattern: /湿疹|红斑.{0,8}丘疹.{0,8}水疱.{0,12}瘙痒|瘙痒.{0,8}渗液/, indicationPattern: /湿疹|皮炎/, weight: 3 },
  { key: "多汗症", axis: "problem", casePattern: /多汗症|持续多汗|汗出过多/, indicationPattern: /多汗症|多汗/, weight: 3 },
  { key: "颈痛", axis: "problem", casePattern: /颈痛|颈肩痛|颈项痛|肩背疼痛/, indicationPattern: /颈痛|颈肩痛|颈项痛/, weight: 3 },
  { key: "下消化道出血", axis: "problem", casePattern: /下消化道出血|便血|大便带血|便中带血/, indicationPattern: /下消化道出血|便血/, weight: 3 },
  { key: "泌乳不足", axis: "problem", casePattern: /泌乳不足|乳汁分泌不足|乳汁量少|乳量少/, indicationPattern: /泌乳不足|乳汁分泌不足|缺乳/, weight: 3 },
  { key: "下肢感觉异常", axis: "problem", casePattern: /下肢.{0,12}(?:麻木|感觉异常|紧缩)|四肢.{0,8}麻木/, indicationPattern: /下肢感觉异常|肢体麻木/, weight: 3 },
  { key: "阴道干涩", axis: "problem", casePattern: /阴道干涩|带下过少/, indicationPattern: /阴道干涩|阴道萎缩|泌尿生殖综合征/, weight: 3 },
  { key: "呃逆", axis: "problem", casePattern: /呃逆|气冲有声|逆气上冲/, indicationPattern: /呃逆|顽固性呃逆/, weight: 3 },
  { key: "面部丘疹", axis: "problem", casePattern: /面部丘疹|面部.{0,8}扁平丘疹/, indicationPattern: /面部丘疹|丘疹性皮肤病/, weight: 3 },
  { key: "嗳气", axis: "problem", casePattern: /嗳气|气逆/, indicationPattern: /嗳气|胃气上逆/, weight: 3 },
  { key: "盆腔炎", axis: "problem", casePattern: /盆腔炎|盆腔炎症性疾病/, indicationPattern: /盆腔炎|盆腔炎症性疾病/, weight: 3 },
  { key: "不孕症", axis: "problem", casePattern: /不孕症|不孕|未孕|求嗣/, indicationPattern: /不孕症|不孕不育/, weight: 3 },
  { key: "嗜睡", axis: "problem", casePattern: /嗜睡|多寐|白天容易入睡|昏昏欲睡/, indicationPattern: /嗜睡|日间嗜睡|睡眠过多/, weight: 3 },
  { key: "多关节疼痛", axis: "problem", casePattern: /多关节疼痛|四肢.{0,16}关节.{0,16}(?:红肿热痛|疼痛|晨僵)/, indicationPattern: /多关节疼痛|多关节炎|关节痛/, weight: 3 },
  { key: "斑秃", axis: "problem", casePattern: /斑秃|片状脱发|头发呈片状脱落/, indicationPattern: /斑秃|片状脱发/, weight: 3 },
  { key: "功能性消化不良", axis: "problem", casePattern: /功能性消化不良|胃胀|晨起欲呕|餐后饱胀/, indicationPattern: /功能性消化不良|餐后不适综合征/, weight: 3 },
  { key: "银屑病", axis: "problem", casePattern: /银屑病|红斑.{0,12}鳞屑|鳞屑.{0,12}红斑/, indicationPattern: /银屑病|牛皮癣/, weight: 3 },
  { key: "白带异常", axis: "problem", casePattern: /白带异常|白带色白.{0,8}清稀|白带量多已有半年/, indicationPattern: /白带异常|阴道分泌物异常/, weight: 3 },
  { key: "唇炎", axis: "problem", casePattern: /唇炎|嘴唇.{0,12}(?:红肿|热痛|脱屑)/, indicationPattern: /唇炎|唇部炎症/, weight: 3 },
  { key: "胁痛", axis: "problem", casePattern: /胁痛|胁肋疼痛|右胁疼痛/, indicationPattern: /胁痛|胁肋痛/, weight: 3 },
  { key: "冻疮", axis: "problem", casePattern: /冻疮|初冬必发|手足.{0,12}耳垂.{0,12}红肿/, indicationPattern: /冻疮|寒冷性损伤/, weight: 3 },
  { key: "白癜风", axis: "problem", casePattern: /白癜风|多发性白斑|躯干.{0,8}白斑/, indicationPattern: /白癜风|皮肤白斑/, weight: 3 },
  { key: "急性皮炎", axis: "problem", casePattern: /急性皮炎|颈部.{0,12}红肿.{0,12}水疱.{0,12}瘙痒|红肿.{0,8}小水疱.{0,8}瘙痒/, indicationPattern: /急性皮炎|湿疹|接触性皮炎/, weight: 3 },
  { key: "背部感觉异常", axis: "problem", casePattern: /背部感觉异常|背部发热|背部.{0,8}异常感觉/, indicationPattern: /背部感觉异常|感觉异常/, weight: 3 },
  { key: "睑缘炎", axis: "problem", casePattern: /睑缘炎|眼睑炎|眼睑.{0,8}红肿疼痛/, indicationPattern: /睑缘炎|眼睑炎/, weight: 3 },
  { key: "慢性肝损伤", axis: "problem", casePattern: /慢性肝损伤|肝功异常|肝功能异常/, indicationPattern: /慢性肝损伤|肝功能异常|肝损伤/, weight: 3 },
  { key: "复发性阿弗他溃疡", axis: "problem", casePattern: /复发性阿弗他溃疡|反复口腔溃疡/, indicationPattern: /复发性阿弗他溃疡|复发性口腔溃疡/, weight: 3 },
  { key: "慢性鼻窦炎", axis: "problem", casePattern: /慢性鼻窦炎|鼻流浊涕|鼻塞.{0,12}黄白色分泌物/, indicationPattern: /慢性鼻窦炎|鼻窦炎/, weight: 3 },
  { key: "甲状腺结节", axis: "problem", casePattern: /甲状腺结节|TI-RADS/, indicationPattern: /甲状腺结节|甲状腺肿物/, weight: 3 },
  { key: "失眠障碍", axis: "problem", casePattern: /失眠障碍|反复失眠/, indicationPattern: /失眠障碍|失眠症/, weight: 3 },
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

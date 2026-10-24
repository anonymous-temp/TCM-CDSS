/**
 * 开放语言类目样例的病历语境。实机回归（regress-facts-class-parity）与闸门测试
 * （test-open-language-classes）共用这一份，两边量的必须是同一个病例形状。
 */

// 句子自己写了体温时，模板的结构化体温取句子里的读数（2026-10-22）。此前模板一律带 T 36.5℃，
// 「体温35.5℃，无寒战…」放进来就成了一份两处体温互相矛盾的病历，事实层判「待澄清」是合理的，
// 而整类对照把它算失败——第十三轮 17 条失败里 14 条是这个。被测的是句子本身，不是模板造出来的矛盾。
// 与黄金基线 advisory-low-temp-35-5 同形（字段与原文同为 35.5℃）。句子里有两个以上不同读数时不填体温字段。
// 只改体温：血压、心率、呼吸的确定性夹具是在完整模板上建的，删掉结构化血压会让高危例多出「生命体征缺项」，改了它们的输入。
// 「直腿抬高试验30度」不是体温：只认「数字℃」与体温/腋温…后的读数。
const STATED_TEMPERATURE = /(?:(?:体温|腋温|肛温|口温|耳温)\s*[:：]?\s*(\d{2}(?:\.\d+)?)\s*(?:℃|度)?|(\d{2}(?:\.\d+)?)\s*℃)/gu;
function templateTemperatureFor(text) {
  const readings = [...new Set([...String(text || "").matchAll(STATED_TEMPERATURE)].map((match) => match[1] || match[2]))];
  if (readings.length === 0) return "36.5℃";
  return readings.length === 1 ? `${readings[0]}℃` : undefined;
}

// 与黄金基线 baseCase 同形：主诉是失眠，风险句只是病历里的一句。
export function outpatientRecord(text, customerId) {
  const temperature = templateTemperatureFor(text);
  return {
    id: `class-parity-${customerId}`,
    customerId,
    phase: "done",
    patient: { sex: "男", age: 45 },
    chiefComplaint: text,
    symptoms: { sleep: "入睡困难，多梦易醒" },
    tongue: "舌淡红，苔薄白",
    pulse: "弦细",
    faceNote: "面色少华，神志清",
    vitals: { ...(temperature ? { T: temperature } : {}), P: "76次/分", R: "18次/分", BP: "122/76mmHg" },
    pastHistory: "否认严重心脑血管疾病。",
    medicationHistory: "否认当前用药",
    allergyHistory: "否认药物过敏",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: `class-parity-${customerId}`,
      updatedAt: "2026-06-29T08:00:00.000Z",
      tongueImageUploaded: false,
      fields: {
        zhushu: text, sex: "男", age: "45岁", guomin: "否认药物过敏", yongyaoshi: "否认当前用药",
        ...(temperature ? { vitalsT: temperature } : {}), vitalsP: "76次/分", vitalsR: "18次/分", vitalsBP: "122/76mmHg",
        tcmTongue: "舌淡红，苔薄白", tcmPulse: "弦细",
        tcmDetail: "睡眠问诊：否认明显打鼾、目击呼吸暂停及日间嗜睡，无高血压病史。",
        xianbingshi: "入睡困难，多梦易醒，纳可。", jiwangshi: "否认严重心脑血管疾病。",
      },
      rawText: text,
    },
    completeness: { level: "C", redFlag: 0.8, infoGain: 1, managementImpact: 1, answerability: 1 },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
  };
}

// 与 regress-live-red-flags 同形：病历里只有这一句。
export function sparse(text, customerId) {
  return {
    id: `class-parity-${customerId}`,
    customerId,
    phase: "collect",
    patient: { sex: "男", age: 48 },
    chiefComplaint: text,
    symptoms: { presentHistory: text, tcmDetail: "" },
    vitals: {},
    conversation: [],
  };
}

// 儿童病历（2026-10-24 第十八轮）：与 sparse 同形，患者 9 岁。年龄守卫类（儿童慢性胸闷气促）只能在这个语境里量。
export function pediatricSparse(text, customerId) {
  return { ...sparse(text, customerId), patient: { sex: "女", age: 9 } };
}

export const OPEN_LANGUAGE_CLASS_CONTEXTS = { outpatient_record: outpatientRecord, sparse, pediatric_sparse: pediatricSparse };

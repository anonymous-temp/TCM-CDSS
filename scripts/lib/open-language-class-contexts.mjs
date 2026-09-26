/**
 * 开放语言类目样例的病历语境。实机回归（regress-facts-class-parity）与闸门测试
 * （test-open-language-classes）共用这一份，两边量的必须是同一个病例形状。
 */

// 与黄金基线 baseCase 同形：主诉是失眠，风险句只是病历里的一句。
export function outpatientRecord(text, customerId) {
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
    vitals: { T: "36.5℃", P: "76次/分", R: "18次/分", BP: "122/76mmHg" },
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
        vitalsT: "36.5℃", vitalsP: "76次/分", vitalsR: "18次/分", vitalsBP: "122/76mmHg",
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

export const OPEN_LANGUAGE_CLASS_CONTEXTS = { outpatient_record: outpatientRecord, sparse };

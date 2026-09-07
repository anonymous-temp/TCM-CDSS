import { randomUUID } from "node:crypto";

export const experienceCases = [
  { label: "产后头痛伴心悸失眠", age: 28, chiefComplaint: "产后2月余，头痛反复发作1月", history: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华。否认突发最剧烈头痛、胸痛、呼吸困难、晕厥及意识障碍。", tongue: "舌淡苔薄白", pulse: "脉细弱" },
  { label: "风寒咳嗽伴鼻塞头痛", age: 36, chiefComplaint: "咳嗽、鼻塞3天", history: "受凉后咳嗽3天，痰稀白，鼻塞流清涕，恶寒无汗，伴头痛、肩背酸痛。口不渴，食欲尚可，二便正常。否认高热、胸痛、呼吸困难、咯血、意识异常。", tongue: "舌淡红，苔薄白", pulse: "脉浮紧" },
  { label: "反酸伴嗳气便干", age: 36, chiefComplaint: "反酸烧心反复2周", history: "近2周反酸烧心反复，餐后较明显，伴嗳气及胃脘胀满，偶有口苦，大便偏干，2日一次。食欲尚可。否认吞咽困难、呕血、黑便、体重下降、持续胸痛、剧烈腹痛。", tongue: "舌红，苔薄黄", pulse: "脉弦略数" },
];

export function experienceCaseState(fixture, customer, id = `experience-${randomUUID()}`) {
  return {
    id, customerId: customer, phase: "collect", patient: { sex: "女", age: fixture.age },
    chiefComplaint: fixture.chiefComplaint, symptoms: { presentHistory: fixture.history }, tongue: fixture.tongue, pulse: fixture.pulse,
    conversation: [], questionRounds: 0, maxQuestionRounds: 2,
    vitals: { T: "36.8℃", P: "78次/分", R: "18次/分", BP: "112/72mmHg", SpO2: "98%" },
    pastHistory: "否认高血压、糖尿病及肝肾疾病。否认妊娠、哺乳及备孕。否认打鼾、睡眠呼吸暂停、日间嗜睡。",
    medicationHistory: "目前无任何现用药。", allergyHistory: "否认药物及食物过敏史。",
  };
}

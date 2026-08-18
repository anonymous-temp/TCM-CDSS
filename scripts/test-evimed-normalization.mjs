import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.EVIMED_API_KEY = "shared-guide-key";
process.env.EVIMED_INSTRUCTION_API_URL = "";
process.env.EVIMED_LITERATURE_API_URL = "";
process.env.EVIMED_INSTRUCTION_API_KEY = "";
process.env.EVIMED_LITERATURE_API_KEY = "";
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceFallbackQueries, buildEvidenceQuery, constrainExternalEvidenceResults, formatInstructionEvidenceRecord, getEvimedEvidenceStatus, normalizeExternalEvidenceResponse } = await jiti.import("../src/lib/evimed-guide.ts");
const { buildEvidenceScope, medicineEvidenceBindingValid, medicineProblemMatchesCase } = await jiti.import("../src/lib/evidence-source-validation.ts");

const status = getEvimedEvidenceStatus();
const guideStatus = status.sources.find((source) => source.kind === "guide");
const extensionStatuses = status.sources.filter((source) => source.kind !== "guide");
assert.equal(guideStatus?.configured, true, "the documented guide endpoint accepts the shared EviMed key");
assert.equal(guideStatus?.officiallyDocumented, true);
assert.equal(guideStatus?.requiredForRelease, true);
assert.ok(extensionStatuses.every((source) => !source.configured && !source.officiallyDocumented && source.requiredForRelease), "release-required live-verified sources must still require explicit endpoints and keys");

const instructionResponse = {
  code: 200,
  data: {
    nmpa: [{ genericNames: "阿司匹林片", enterpriseName: "示例药企", approvalNumber: "国药准字H12345678", specifications: "100mg", indication: "用于符合适应证的冠心病患者", contraindications: "活动性出血禁用", useInPregLact: "妊娠期慎用", pdfUrl: "https://example.org/aspirin.pdf" }],
    fda: [], ema: [], pmda: [],
  },
};
const searchResponse = {
  code: 200,
  data: {
    instructions: [{ genericNames: "阿司匹林片", enterpriseName: "示例药企", approvalNumber: "国药准字H12345678", indication: "用于符合适应证的患者", pdfUrl: "https://example.org/aspirin.pdf" }],
    paper: [{ title: "Aspirin clinical study", journal: "Example Journal", year: "2024", doi: "10.1234/example.2024.1", abstract: "study abstract" }],
    clinicalTrials: [{ officialTitle: "Aspirin clinical trial", organization: "Example Registry", year: "2025", url: "https://example.org/trial" }],
    guide: [{ title: "Guide not part of literature bucket", publisher: "Example", year: "2024" }],
  },
};

const instructions = normalizeExternalEvidenceResponse("instruction", instructionResponse);
assert.equal(instructions.length, 1);
assert.equal(instructions[0].title, "阿司匹林片");
assert.equal(instructions[0].sourceKind, "instruction");
assert.equal(instructions[0].medicineName, "阿司匹林片");
assert.equal(instructions[0].specification, "100mg");
assert.match(instructions[0].fingerprint || "", /^sha256:[a-f0-9]{64}$/);
const atomicInstructionRecord = formatInstructionEvidenceRecord({
  ...instructions[0],
  indication: "冠心病\n符合适应证者",
  contraindication: "活动性出血\r\n禁用",
}, "EVID-INST-001");
assert.doesNotMatch(atomicInstructionRecord, /[\r\n\u2028\u2029]/, "an instruction ID and every bound field must remain on one atomic evidence line");
assert.match(atomicInstructionRecord, /适应证：冠心病 符合适应证者/);
const medicineEvidenceContext = `[EVID-INST-001] 药名：阿司匹林片｜生产企业：示例药企｜规格：100mg｜适应证：用于符合适应证的冠心病患者｜禁忌/注意：活动性出血禁用｜特殊人群：妊娠期慎用｜条目指纹：${instructions[0].fingerprint}｜URL:https://example.org/aspirin.pdf`;
const medicineScope = buildEvidenceScope(medicineEvidenceContext);
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", instructions[0].fingerprint, "阿司匹林片", "冠心病", "100mg", medicineScope), true);
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", `sha256:${"0".repeat(64)}`, "阿司匹林片", "冠心病", "100mg", medicineScope), false, "a mismatched instruction fingerprint must fail closed");
assert.equal(medicineEvidenceBindingValid("EVID-INST-001", instructions[0].fingerprint, "华法林片", "冠心病", "100mg", medicineScope), false, "a medicine name cannot borrow another product's instruction ID");
assert.equal(medicineProblemMatchesCase("冠心病", "本次主诊断考虑冠心病，活动后胸痛"), true);
assert.equal(medicineProblemMatchesCase("冠心病", "本次主诉为湿疹伴瘙痒"), false);

const literature = normalizeExternalEvidenceResponse("literature", searchResponse);
assert.equal(literature.length, 2);
assert.ok(literature.some((item) => item.identifier === "DOI:10.1234/example.2024.1"));
assert.ok(literature.every((item) => item.title !== "Guide not part of literature bucket"));
const widenedLiterature = [
  ...literature,
  { sourceKind: "literature", title: "Old study", publisher: "Example", year: "2017" },
  { sourceKind: "literature", title: "Unknown-date study", publisher: "Example" },
];
const recentLiterature = constrainExternalEvidenceResults("literature", widenedLiterature, { count: 1, startYear: 2020 });
assert.equal(recentLiterature.length, 1, "client-owned count must be enforced when the upstream ignores it");
assert.equal(recentLiterature[0].year, "2024", "date-scoped retrieval must exclude old and undated records");
assert.equal(constrainExternalEvidenceResults("instruction", instructions, { count: 6, startYear: 2024 }).length, 1, "instruction retrieval must not invent a publication-date gate");

const query = buildEvidenceQuery({
  patient: {},
  chiefComplaint: "本例张三近3日头晕",
  symptoms: { presentHistory: "头晕伴恶心", patientId: "SECRET-7788", rawMetadata: "MRN#A-12345678" },
  conversation: [],
}, "diagnose", "guide");
assert.match(query, /头晕|头晕伴恶心/);
assert.doesNotMatch(query, /张三|SECRET-7788|A-12345678/);
assert.match(query.slice(0, 80), /诊断.*指南.*共识/, "检索意图必须放在 200 字截断之前，不能被长病史挤掉");
assert.ok(query.indexOf("诊断") < query.indexOf("头晕伴恶心"), "指南检索意图必须先于展开病史");

const coughFallbacks = buildEvidenceFallbackQueries({
  patient: {},
  chiefComplaint: "感冒后干咳、咽痒4周",
  symptoms: { presentHistory: "少痰，无发热或气促" },
  conversation: [],
}, "diagnose", "guide");
assert.ok(coughFallbacks.some((item) => /^咳嗽\s+诊断 指南 共识/.test(item)), "口语干咳必须能收敛到受治理的咳嗽检索词");

const refluxFallbacks = buildEvidenceFallbackQueries({
  patient: {},
  chiefComplaint: "反酸、嗳气反复1年",
  symptoms: { presentHistory: "餐后及辛辣油腻后加重" },
  conversation: [],
}, "diagnose", "guide");
assert.ok(refluxFallbacks.some((item) => /^胃食管反流\s+诊断 指南 共识/.test(item)), "反酸嗳气必须能收敛到受治理的胃食管反流检索词");

const governedDiagnosisFallbackCases = [
  ["带下量多，色黄质稠如豆渣，阴部瘙痒", "阴道炎"],
  ["月经淋漓不断半月", "异常子宫出血"],
  ["近三个月月经量逐渐减少，末次月经比上次晚十天", "异常子宫出血"],
  ["月经周期15天，白带淡褐色", "异常子宫出血"],
  ["外院检查为慢性盆腔炎", "盆腔炎"],
  ["求嗣一年未孕", "不孕症"],
  ["白天容易入睡，昏昏欲睡", "嗜睡"],
  ["四肢大小关节红肿热痛并晨僵", "多关节疼痛"],
  ["头发呈片状脱落", "斑秃"],
  ["胃胀一年多，晨起欲呕", "功能性消化不良"],
  ["全身红斑鳞屑反复发作", "银屑病"],
  ["白带色白清稀，量多半年", "白带异常"],
  ["嘴唇红肿热痛伴脱屑", "唇炎"],
  ["右胁肋疼痛五天", "胁痛"],
  ["手足耳垂红肿痒痛，初冬必发", "冻疮"],
  ["躯干多发性白斑", "白癜风"],
  ["颈部红肿，上有小水疱并瘙痒", "急性皮炎"],
  ["背部发热四年", "背部感觉异常"],
  ["两侧下眼睑红肿疼痛", "睑缘炎"],
  ["发现肝功异常三个月", "慢性肝损伤"],
  ["反复口腔溃疡半年", "复发性阿弗他溃疡"],
  ["长期鼻流浊涕伴头昏头痛", "慢性鼻窦炎"],
  ["发现甲状腺结节一月，TI-RADS3类", "甲状腺结节"],
  ["反复失眠半年", "失眠障碍"],
  ["停经七个月", "闭经"],
  ["周身红色皮疹融合成片，瘙痒剧烈", "荨麻疹"],
  ["左小腿红肿发热疼痛两天", "皮肤软组织感染"],
  ["右胸背起疱疹伴疼痛三个月", "带状疱疹后神经痛"],
  ["面部痤疮两个月，红色丘疹有触痛", "寻常痤疮"],
  ["仆倒、肢体抽搐、双目上瞪，牙关紧闭", "癫痫"],
  ["闭经三个月", "闭经"],
  ["受凉后尿痛、尿频一周", "尿路感染"],
  ["红斑丘疹水疱伴剧烈瘙痒渗液", "湿疹"],
  ["持续多汗半年", "多汗症"],
  ["左颈项痛和肩背疼痛两个多月", "颈痛"],
  ["大便带血持续一个月", "下消化道出血"],
  ["产后乳汁量少四日", "泌乳不足"],
  ["双下肢紧缩麻木十天", "下肢感觉异常"],
  ["带下过少并阴道干涩", "阴道干涩"],
  ["呃逆一年余，逆气上冲，气冲有声", "呃逆"],
  ["面部扁平丘疹反复发作一年", "面部丘疹"],
  ["半年来一直气逆", "嗳气"],
];
for (const [chiefComplaint, expected] of governedDiagnosisFallbackCases) {
  const fallbacks = buildEvidenceFallbackQueries({
    patient: {}, chiefComplaint, symptoms: {}, conversation: [],
  }, "diagnose", "guide");
  assert.ok(
    fallbacks.some((item) => item.startsWith(`${expected} 诊断 指南 共识`)),
    `口语主诉必须能收敛到诊断证据检索词：${chiefComplaint} -> ${expected}`,
  );
}

console.log(JSON.stringify({ cases: 28 + governedDiagnosisFallbackCases.length, failures: 0 }));

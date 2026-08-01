import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.REASONING_QUALITY_TIMEOUT_MS || 300_000);
const MAX_M03_MS = Number(process.env.REASONING_QUALITY_MAX_M03_MS || 180_000);
const MAX_LIVENESS_GAP_MS = Number(process.env.REASONING_QUALITY_MAX_LIVENESS_GAP_MS || 15_000);
const MIN_JUDGE_AVG = Number(process.env.REASONING_QUALITY_MIN_JUDGE_AVG || 4);
const MIN_JUDGE_DIM = Number(process.env.REASONING_QUALITY_MIN_JUDGE_DIM || 3);
const JUDGE_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const JUDGE_KEY = process.env.OPENAI_API_KEY || "";
const JUDGE_MODEL = process.env.PRIMARY_DIAGNOSE_MODEL || process.env.OPENAI_MODEL || "deepseek-v4-pro";
const ARTIFACT_DIR = resolve(process.env.REASONING_QUALITY_ARTIFACT_DIR || "artifacts/reasoning-quality-current");
const CASE_FILTER = String(process.env.REASONING_QUALITY_CASE || "").trim();
const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const EXTERNAL_REFERENCE_LEVELS = new Set(["kb_entry", "guideline", "instruction", "drug_label", "literature", "classic_text"]);
const PATIENT_NARRATIVE_REFERENCE = /(?:^|[\s；;|])(?:主诉|现病史|既往史|过敏史|用药史|患者事实|病例事实|本例资料|病历原文|舌象|脉象|生命体征)\s*[：:]|(?:患者|病人)\s*(?:诉|自述|描述|出现|伴有|伴随)|基于本例(?:病史|症状|资料|主诉)/;

function invariant(condition, message, detail = "") {
  if (condition) return;
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function normalizedText(value) {
  return String(value || "").toLowerCase().replace(/[\s，。；：、,.!?！？:;（）()\[\]【】"'“”‘’_-]+/g, "");
}

function bigrams(value) {
  const text = normalizedText(value);
  const output = new Set();
  for (let index = 0; index < text.length - 1; index += 1) output.add(text.slice(index, index + 2));
  return output;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function makeCase(definition) {
  const id = `quality_${definition.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fields = {
    zhushu: definition.chiefComplaint,
    sex: definition.sex,
    age: `${definition.age}岁`,
    xianbingshi: definition.presentHistory,
    jiwangshi: definition.pastHistory,
    guomin: definition.allergyHistory,
    yongyaoshi: definition.medicationHistory,
    vitalsT: definition.vitals.T,
    vitalsP: definition.vitals.P,
    vitalsR: definition.vitals.R,
    vitalsBP: definition.vitals.BP,
    tcmTongue: definition.tongue,
    tcmPulse: definition.pulse,
    tcmDetail: definition.tcmDetail,
    tcmLineagePreference: "不限定",
  };
  return {
    id,
    phase: "diagnose",
    patient: { sex: definition.sex, age: definition.age },
    chiefComplaint: definition.chiefComplaint,
    symptoms: definition.symptoms,
    tongue: definition.tongue,
    pulse: definition.pulse,
    faceNote: definition.faceNote,
    vitals: definition.vitals,
    pastHistory: definition.pastHistory,
    medicationHistory: definition.medicationHistory,
    allergyHistory: definition.allergyHistory,
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: id,
      updatedAt: new Date().toISOString(),
      tongueImageUploaded: false,
      fields,
      rawText: Object.values(fields).filter(Boolean).join("。"),
    },
    completeness: { level: "C", redFlag: 0.9, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
    diagnosis: "",
    prescription: "",
    riskAssessment: "",
  };
}

const EMPTY_VITALS = Object.freeze({ T: "", P: "", R: "", BP: "" });

const caseDefinitions = [
  {
    id: "insomnia",
    label: "慢性失眠伴心脾不足表现",
    sex: "女",
    age: 42,
    chiefComplaint: "入睡困难、多梦易醒3个月",
    presentHistory: "每周约5晚入睡需1小时，多梦易醒，醒后再睡困难，晨起疲乏，伴心悸健忘、食欲欠佳、便溏。否认潮热盗汗、明显口苦口渴、胸痛、晕厥和呼吸困难。",
    pastHistory: "否认甲状腺疾病和严重心脑血管疾病。否认打鼾、睡眠呼吸暂停或憋醒。",
    medicationHistory: "否认当前用药及保健品。",
    allergyHistory: "否认药物及食物过敏。",
    tongue: "舌淡，边有齿痕，苔薄白",
    pulse: "脉细弱",
    faceNote: "面色少华，神清",
    tcmDetail: "纳差便溏，小便正常。",
    vitals: EMPTY_VITALS,
    symptoms: { sleep: "入睡困难、多梦易醒", general: "晨起疲乏、心悸健忘、纳差便溏" },
    expectedWestern: /失眠|睡眠障碍|入睡困难/,
    expectedTcm: /心脾|气血|脾虚|心血/,
    forbiddenCore: /阴虚火旺|痰火扰心/,
    deniedEvidence: /潮热|盗汗|口苦|口渴|胸痛|晕厥|呼吸困难/,
  },
  {
    id: "wind_cold_cough",
    label: "风寒外感咳嗽",
    sex: "男",
    age: 35,
    chiefComplaint: "咳嗽伴恶寒无汗3天",
    presentHistory: "3天前淋雨后出现咳嗽，咳白稀痰，鼻塞流清涕，头身酸痛，恶寒明显，无汗。否认高热、咯血、胸痛和呼吸困难。",
    pastHistory: "既往体健，否认哮喘和慢性肺病。",
    medicationHistory: "否认当前用药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌淡红，苔薄白",
    pulse: "脉浮紧",
    faceNote: "神清，面色正常",
    tcmDetail: "口不渴，二便正常。",
    vitals: EMPTY_VITALS,
    symptoms: { respiratory: "咳嗽、白稀痰、鼻塞流清涕", general: "恶寒、无汗、头身酸痛" },
    expectedWestern: /急性咳嗽|上呼吸道感染|急性支气管炎|呼吸道感染/,
    expectedTcm: /风寒|寒邪|外感|肺气失宣/,
    forbiddenCore: /风热犯肺|痰热壅肺|阴虚肺燥/,
    deniedEvidence: /高热|咯血|胸痛|呼吸困难/,
  },
  {
    id: "reflux",
    label: "反流症状且无肝郁证据",
    sex: "女",
    age: 39,
    chiefComplaint: "反酸烧心伴上腹胀2周",
    presentHistory: "餐后及平卧时反酸烧心明显，偶有嗳气，上腹胀，抬高床头后稍缓解。否认吞咽困难、黑便、呕血、体重下降和胸痛。症状与情绪变化无明显关系。",
    pastHistory: "否认消化道溃疡、肿瘤和心血管疾病史。",
    medicationHistory: "否认当前用药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌淡红，苔薄白",
    pulse: "脉和缓",
    faceNote: "神清，面色正常",
    tcmDetail: "否认胁肋胀痛、善太息和情志抑郁，纳可，二便正常。",
    vitals: EMPTY_VITALS,
    symptoms: { digestive: "餐后和平卧反酸烧心、嗳气、上腹胀" },
    expectedWestern: /胃食管反流|反流|烧心/,
    expectedTcm: /胃失和降|胃气上逆|胃/,
    forbiddenCore: /肝气郁结|肝郁犯胃|肝胃不和/,
    deniedEvidence: /吞咽困难|黑便|呕血|体重下降|胸痛|胁肋胀痛|善太息|情志抑郁/,
  },
  {
    id: "wind_heat_cough",
    label: "风热犯肺咳嗽与风寒鉴别",
    sex: "女",
    age: 31,
    chiefComplaint: "咳嗽伴咽痛2天",
    presentHistory: "昨日午后开始咳嗽，咳痰黄稠，咽喉红痛，鼻流黄涕，口渴喜饮，微恶风但无明显恶寒。否认白稀痰、无汗、胸痛、咯血和明显呼吸困难。",
    pastHistory: "既往体健，否认哮喘及慢性肺病。",
    medicationHistory: "否认当前用药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌边尖红，苔薄黄",
    pulse: "脉浮数",
    faceNote: "神清，面色微红",
    tcmDetail: "小便微黄，大便正常。",
    vitals: EMPTY_VITALS,
    symptoms: { respiratory: "咳嗽、黄稠痰、咽痛、黄涕", general: "口渴、微恶风" },
    expectedWestern: /急性咳嗽|上呼吸道感染|急性支气管炎|呼吸道感染/,
    expectedTcm: /风热|热邪|肺失清肃|肺气失宣/,
    forbiddenCore: /风寒袭肺|寒邪束表|阴虚肺燥/,
    deniedEvidence: /白稀痰|无汗|明显恶寒|胸痛|咯血|明显呼吸困难/,
  },
  {
    id: "lung_yin_dry_cough",
    label: "肺阴不足干咳与外感咳嗽鉴别",
    sex: "女",
    age: 47,
    chiefComplaint: "干咳少痰反复2个月",
    presentHistory: "干咳阵作，痰少而黏不易咯，午后和夜间较重，咽干口燥，声音略哑，偶有盗汗。否认恶寒发热、鼻塞流涕、黄稠痰、胸痛和咯血。",
    pastHistory: "否认慢性肺病和结核病史，不吸烟。",
    medicationHistory: "否认当前用药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌红少津，苔少",
    pulse: "脉细数",
    faceNote: "神清，面色正常",
    tcmDetail: "纳可，二便正常。",
    vitals: EMPTY_VITALS,
    symptoms: { respiratory: "干咳、少量黏痰、咽干声哑", general: "午后夜间加重、偶有盗汗" },
    expectedWestern: /慢性咳嗽|咳嗽待查|咳嗽变异性哮喘|上气道咳嗽|呼吸道/,
    expectedTcm: /肺阴|阴虚|燥|肺失濡润/,
    forbiddenCore: /风寒袭肺|风热犯肺|痰湿壅肺/,
    deniedEvidence: /恶寒|发热|鼻塞|流涕|黄稠痰|胸痛|咯血/,
  },
  {
    id: "yin_deficiency_insomnia",
    label: "心肾阴虚失眠与心脾两虚鉴别",
    sex: "女",
    age: 50,
    chiefComplaint: "入睡困难伴心烦潮热4个月",
    presentHistory: "入睡困难，夜间易醒，醒后心烦，伴五心烦热、潮热盗汗、口咽干燥和耳鸣。否认纳差、便溏、畏寒肢冷及明显白天嗜睡。",
    pastHistory: "否认甲状腺疾病和严重心脑血管疾病。",
    medicationHistory: "否认当前服用镇静催眠药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌红少苔",
    pulse: "脉细数",
    faceNote: "神清，面色微红",
    tcmDetail: "小便正常，大便偏干。",
    vitals: EMPTY_VITALS,
    symptoms: { sleep: "入睡困难、夜间易醒", general: "心烦、潮热盗汗、五心烦热、耳鸣" },
    expectedWestern: /失眠|睡眠障碍|入睡困难/,
    expectedTcm: /心肾|阴虚|虚火|心火/,
    forbiddenCore: /心脾两虚|脾气虚|痰火扰心/,
    deniedEvidence: /纳差|便溏|畏寒|肢冷|白天嗜睡/,
  },
  {
    id: "spleen_qi_diarrhea",
    label: "脾气虚泄泻与湿热泄泻鉴别",
    sex: "男",
    age: 44,
    chiefComplaint: "大便稀溏反复3个月",
    presentHistory: "大便每日2至3次，质稀不成形，进食油腻后明显，伴食欲不振、饭后腹胀、神疲乏力，便后腹胀稍缓。否认腹痛拒按、肛门灼热、里急后重、黏液脓血便和发热。",
    pastHistory: "否认炎症性肠病和消化道手术史。",
    medicationHistory: "否认近期使用抗生素或泻药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌淡胖，边有齿痕，苔白",
    pulse: "脉缓弱",
    faceNote: "面色少华，神清",
    tcmDetail: "小便正常，无口苦口渴。",
    vitals: EMPTY_VITALS,
    symptoms: { digestive: "大便稀溏、食后腹胀、纳差", general: "神疲乏力" },
    expectedWestern: /腹泻|肠易激/,
    expectedTcm: /脾气虚|脾虚|运化失司|中气不足/,
    forbiddenCore: /湿热下注|肠道湿热|肾阳虚|肝郁乘脾/,
    deniedEvidence: /腹痛拒按|肛门灼热|里急后重|黏液脓血|发热|口苦|口渴/,
  },
  {
    id: "cold_stasis_dysmenorrhea",
    label: "寒凝血瘀痛经与湿热证鉴别",
    sex: "女",
    age: 27,
    chiefComplaint: "经期小腹冷痛反复1年",
    presentHistory: "每逢月经第1天小腹冷痛明显，得热痛减、按之不舒，经血色暗有血块，块下痛减，受寒后加重。否认经间期发热、黄臭带下、外阴瘙痒和性交痛。",
    pastHistory: "月经周期基本规律，否认盆腔手术史；无妊娠可能。",
    medicationHistory: "疼痛时偶服布洛芬，本次尚未服药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌暗，边有瘀点，苔白",
    pulse: "脉沉紧",
    faceNote: "神清，痛苦面容",
    tcmDetail: "腰骶酸胀，无口渴。",
    vitals: EMPTY_VITALS,
    symptoms: { gynecological: "经期小腹冷痛、经色暗有块、块下痛减", general: "得热痛减、受寒加重" },
    expectedWestern: /痛经|原发性痛经|继发性痛经/,
    expectedTcm: /寒凝|胞宫|血瘀|寒客/,
    forbiddenCore: /湿热下注|气血两虚|肝肾阴虚/,
    deniedEvidence: /发热|黄臭带下|外阴瘙痒|性交痛|口渴/,
  },
  {
    id: "phlegm_damp_vertigo",
    label: "痰湿中阻眩晕与肝阳上亢鉴别",
    sex: "男",
    age: 53,
    chiefComplaint: "头晕如蒙伴恶心1个月",
    presentHistory: "头晕昏蒙、头重如裹，转头和进食油腻后加重，伴胸闷恶心、痰多黏白、困倦乏力。否认头胀痛、面红目赤、急躁易怒、耳鸣如蝉、肢体麻木无力和言语不清。",
    pastHistory: "既往有血脂偏高，否认卒中和严重心脏病史。",
    medicationHistory: "否认当前用药。",
    allergyHistory: "否认药物过敏。",
    tongue: "舌胖，苔白腻",
    pulse: "脉滑",
    faceNote: "神清，面色正常",
    tcmDetail: "纳呆，大便黏滞不爽。",
    vitals: EMPTY_VITALS,
    symptoms: { neurological: "头晕昏蒙、头重如裹", digestive: "恶心、纳呆、大便黏滞", respiratory: "痰多黏白" },
    expectedWestern: /眩晕|头晕|前庭|位置性眩晕/,
    expectedTcm: /痰湿|痰浊|中阻|清阳不升|蒙蔽清窍/,
    forbiddenCore: /肝阳上亢|肝火上炎|阴虚阳亢/,
    deniedEvidence: /头胀痛|面红目赤|急躁易怒|耳鸣如蝉|肢体麻木|肢体无力|言语不清/,
  },
  {
    id: "damp_obstruction_headache",
    label: "湿困清阳头痛与肝阳及风热头痛鉴别",
    sex: "男",
    age: 24,
    chiefComplaint: "头痛5天",
    presentHistory: "5天前无明显诱因出现头痛，头痛如裹，肢体困重，胸闷纳呆，小便不利，大便黏腻不成形，睡眠欠佳。否认突发雷击样头痛、发热、口渴、面红目赤、急躁易怒、肢体麻木无力、言语不清和意识异常。",
    pastHistory: "无特殊病史。",
    medicationHistory: "无用药史。",
    allergyHistory: "否认药物、食物过敏。",
    tongue: "舌质淡，苔白腻",
    pulse: "脉濡",
    faceNote: "神清，面色正常",
    tcmDetail: "无明显寒热倾向，不欲饮。",
    vitals: EMPTY_VITALS,
    symptoms: {
      neurological: "头痛如裹",
      digestive: "胸闷纳呆、大便黏腻不成形",
      general: "肢体困重、小便不利、睡眠欠佳",
    },
    expectedWestern: /头痛|继发性头痛|紧张型头痛|偏头痛/,
    expectedTcm: /湿困|痰湿|湿阻|清阳不升|蒙蔽清窍|脾.*湿/,
    forbiddenCore: /肝阳上亢|肝火上炎|风热上扰|阴虚阳亢/,
    deniedEvidence: /雷击样|发热|口渴|面红目赤|急躁易怒|肢体麻木|肢体无力|言语不清|意识异常/,
  },
  {
    id: "thunderclap_headache",
    label: "雷击样头痛急危重分流",
    sex: "男",
    age: 58,
    chiefComplaint: "突发一生中最剧烈头痛伴呕吐30分钟",
    presentHistory: "活动中突然出现爆炸样剧烈头痛，30秒内达到高峰，伴喷射性呕吐、颈部僵硬和短暂视物模糊。既往从未有类似发作。",
    pastHistory: "高血压病史8年，近期未规律服药。",
    medicationHistory: "降压药名称不详，近期未规律服用。",
    allergyHistory: "否认已知药物过敏。",
    tongue: "未查",
    pulse: "未查",
    faceNote: "痛苦面容，神志尚清",
    tcmDetail: "未取得舌脉。",
    vitals: { T: "36.8℃", P: "96次/分", R: "22次/分", BP: "220/130mmHg" },
    symptoms: { neurological: "雷击样剧烈头痛、呕吐、颈部僵硬、短暂视物模糊" },
    expectedWestern: /蛛网膜下腔出血|脑血管|高血压急症|继发性头痛|雷击样头痛|急危重症风险待排除/,
    expectedTcm: /急症|暂缓|不宜|无法|未查/,
    forbiddenCore: /普通偏头痛|紧张型头痛/,
    deniedEvidence: /$a/,
    requireEmergency: true,
  },
];

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function clinicalFactsPreflight(caseState) {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(`${BASE_URL}/api/diagnosis/red-flags`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState }),
  });
  const raw = await response.text();
  invariant(response.ok, `clinical-facts preflight HTTP ${response.status}`, raw.slice(0, 500));
  const body = JSON.parse(raw);
  const deterministicRedFlag = body?.available === true && body?.safetyGate?.status === "red_flag";
  invariant(
    deterministicRedFlag || (body?.available === true && body?.clinicalFacts?.attestation),
    "clinical-facts preflight missing signed facts",
    raw.slice(0, 500),
  );
  return { clinicalFacts: body.clinicalFacts, elapsedMs: Date.now() - startedAt };
}

async function callM03(caseState) {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(`${BASE_URL}/api/diagnosis/diagnose`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
    body: JSON.stringify({ caseState }),
  });
  invariant(response.body, "M03 returned an empty body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let pending = "";
  let firstFrameMs = null;
  let previousFrameAt = null;
  let maxInterFrameMs = 0;
  const frames = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    const chunk = decoder.decode(value, { stream: true });
    pending += chunk;
    raw += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      if (firstFrameMs == null) firstFrameMs = now - startedAt;
      if (previousFrameAt != null) maxInterFrameMs = Math.max(maxInterFrameMs, now - previousFrameAt);
      previousFrameAt = now;
    }
  }
  invariant(response.ok, `M03 HTTP ${response.status}`, raw.slice(0, 600));
  invariant(frames.filter((frame) => frame.content === "[END]").length === 1, "M03 must emit one END frame");
  invariant(!frames.some((frame) => typeof frame.error === "string"), "M03 emitted an error frame", JSON.stringify(frames.find((frame) => frame.error)));
  const joined = frames
    .filter((frame) => typeof frame.content === "string" && frame.content !== "[END]")
    .map((frame) => frame.content)
    .join("");
  const markerIndex = joined.lastIndexOf(REPLACE_MARKER);
  const content = (markerIndex >= 0 ? joined.slice(markerIndex + REPLACE_MARKER.length) : joined).trim();
  const start = content.lastIndexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  invariant(start >= 0 && end > start, "M03 missing complete structured reasoning", content.slice(-1000));
  const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim());
  return {
    elapsedMs: Date.now() - startedAt,
    firstFrameMs,
    maxInterFrameMs,
    content,
    visible: content.slice(0, start).trim(),
    reasoning,
  };
}

function evidenceObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) evidenceObjects(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const record = value;
  if (typeof record.evidenceLevel === "string" && typeof record.source === "string") output.push(record);
  for (const item of Object.values(record)) evidenceObjects(item, output);
  return output;
}

function deterministicQuality(definition, result) {
  const reasoning = result.reasoning;
  invariant(reasoning?.schemaVersion === "tcm-cdss-reasoning-v2" && reasoning.stage === "diagnose", "M03 reasoning contract mismatch");
  const westernName = reasoning.westernDiagnosis?.primary?.name || "";
  const tcmCore = [
    reasoning.overview?.primarySyndrome,
    reasoning.overview?.overallPathogenesis,
    reasoning.pathogenesis?.summary,
    ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.pathogenesis, item.therapyDirection]),
  ].filter(Boolean).join("；");
  const hasRecordedVitals = Object.values(definition.vitals).some((value) => String(value || "").trim());
  invariant(definition.expectedWestern.test(westernName), "western diagnosis direction is clinically off-target", westernName);
  invariant(definition.expectedTcm.test(tcmCore), "TCM reasoning missed the expected conservative direction", tcmCore);
  invariant(!definition.forbiddenCore.test(tcmCore), "unsupported/contradicted TCM direction entered the core reasoning", tcmCore);
  if (!hasRecordedVitals) {
    const supportingEvidence = [
      ...(reasoning.westernDiagnosis?.primary?.supportingFacts || []),
      ...(reasoning.overview?.primarySyndromeBasis || []),
      ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.patientFact, item.syndromeEvidence]),
    ].filter(Boolean).join("；");
    invariant(
      !/(?:生命体征|体温|脉搏|心率|呼吸频率|血压).{0,8}(?:正常|平稳|无异常)|(?:体温|脉搏|心率|呼吸频率|血压)(?:正常|平稳)/.test(supportingEvidence),
      "blank vital signs were fabricated as normal supporting evidence",
      supportingEvidence,
    );
  }
  if (definition.requireEmergency) {
    const pollutedReferences = evidenceObjects(reasoning).filter((evidence) =>
      EXTERNAL_REFERENCE_LEVELS.has(evidence.evidenceLevel) &&
      (
        PATIENT_NARRATIVE_REFERENCE.test(evidence.source) ||
        similarity(evidence.source, definition.chiefComplaint) >= 0.65
      )
    );
    invariant(pollutedReferences.length === 0, "patient narrative was mislabeled as external reference", JSON.stringify(pollutedReferences));
    invariant(result.elapsedMs <= MAX_M03_MS, "M03 exceeded latency budget", `${result.elapsedMs}ms`);
    invariant((result.firstFrameMs || 0) <= MAX_LIVENESS_GAP_MS, "M03 first liveness frame exceeded budget", `${result.firstFrameMs}ms`);
    invariant(result.maxInterFrameMs <= MAX_LIVENESS_GAP_MS, "M03 stream liveness gap exceeded budget", `${result.maxInterFrameMs}ms`);
    invariant(/急诊|立即|急危重|紧急|呼叫120|卒中中心/.test(result.visible), "red-flag case lacks explicit emergency disposition", result.visible);
    invariant(!/\d+(?:\.\d+)?\s*g\b/.test(result.visible), "red-flag M03 leaked dose-level content", result.visible);
    return;
  }
  const evidenceFacts = [
    ...(reasoning.overview?.primarySyndromeBasis || []),
    ...(reasoning.pathogenesis?.chain || []).flatMap((item) => [item.patientFact, item.syndromeEvidence]),
  ].filter(Boolean).join("；");
  invariant(!definition.deniedEvidence.test(evidenceFacts), "negated patient facts were promoted into positive evidence", evidenceFacts);
  invariant(Array.isArray(reasoning.pathogenesis?.chain) && reasoning.pathogenesis.chain.length > 0, "pathogenesis chain is empty");
  invariant(reasoning.pathogenesis.chain.every((item) =>
    item.patientFact?.trim() && item.syndromeEvidence?.trim() && item.pathogenesis?.trim() && item.therapyDirection?.trim()
  ), "pathogenesis chain is not closed", JSON.stringify(reasoning.pathogenesis?.chain));
  const clinicalRationale = reasoning.westernDiagnosis?.primary?.clinicalRationale || "";
  invariant(
    similarity(clinicalRationale, definition.chiefComplaint) < 0.82,
    "western clinical rationale is a near-verbatim chief-complaint restatement",
    clinicalRationale,
  );
  const pollutedReferences = evidenceObjects(reasoning).filter((evidence) =>
    EXTERNAL_REFERENCE_LEVELS.has(evidence.evidenceLevel) &&
    (
      PATIENT_NARRATIVE_REFERENCE.test(evidence.source) ||
      similarity(evidence.source, definition.chiefComplaint) >= 0.65
    )
  );
  invariant(pollutedReferences.length === 0, "patient narrative was mislabeled as external reference", JSON.stringify(pollutedReferences));
  invariant(!/(?:参考依据|参考文献|外部参考资料)\s*[：:]\s*(?:主诉|现病史|患者|本例)/.test(result.visible), "visible reference section repeats patient narrative", result.visible);
  invariant(result.elapsedMs <= MAX_M03_MS, "M03 exceeded latency budget", `${result.elapsedMs}ms`);
  invariant((result.firstFrameMs || 0) <= MAX_LIVENESS_GAP_MS, "M03 first liveness frame exceeded budget", `${result.firstFrameMs}ms`);
  invariant(result.maxInterFrameMs <= MAX_LIVENESS_GAP_MS, "M03 stream liveness gap exceeded budget", `${result.maxInterFrameMs}ms`);
}

async function judgeQuality(definition, reasoning) {
  invariant(JUDGE_KEY, "OPENAI_API_KEY is required for the V4 Pro quality judge");
  const dimensions = ["事实接地", "现代医学方向", "中医病机闭环", "鉴别与安全", "参考依据语义"];
  const prompt = [
    "你是与生成请求无会话状态的临床质量评审。只输出JSON，不要解释。",
    `病例：${definition.label}`,
    `主诉：${definition.chiefComplaint}`,
    `现病史：${definition.presentHistory}`,
    `既往史：${definition.pastHistory}`,
    `其他四诊与问诊：${definition.tcmDetail}；${definition.faceNote}`,
    `舌脉：${definition.tongue}；${definition.pulse}`,
    `当前用药与过敏：${definition.medicationHistory}；${definition.allergyHistory}`,
    `生命体征：${Object.values(definition.vitals).some((value) => String(value || "").trim()) ? Object.values(definition.vitals).filter(Boolean).join("，") : "未提供"}`,
    "",
    "逐维按0-5整数评分。任何一项若出现以下问题必须≤2：把否认/未提及当阳性；正式诊断条件不足却硬确诊；病机与治法不闭环；漏掉急危重处置；把主诉、现病史或患者事实包装成参考依据/文献。",
    "诊断边界：当正式疾病条件不足时，使用与主诉精确一致的症状级工作诊断并列出鉴别是正确的保守做法，不得仅因未硬确诊疾病而扣分。安全网明确要求危险症状出现时立即急诊即可，不强制在门诊辅助结果中预先指定CT/MRI；但鉴别诊断名称不得把多个疾病用“或/斜杠”塞在同一项。",
    "参考依据语义专门检查：病例内事实可用于病机链，但不得出现在“参考文献、外部参考、指南、文献、出处”字段；外部依据必须可回查。",
    `输出格式：{"scores":{${dimensions.map((item) => `"${item}":0`).join(",")}},"overall":0,"issues":[]}`,
    "",
    `待评结构化结果：${JSON.stringify(reasoning).slice(0, 24_000)}`,
  ].join("\n");
  const response = await fetchWithTimeout(`${JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${JUDGE_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: "你是严格、保守的临床质量审查员。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 2200,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      thinking: { type: "disabled" },
    }),
  });
  const raw = await response.text();
  invariant(response.ok, `quality judge HTTP ${response.status}`, raw.slice(0, 600));
  const body = JSON.parse(raw);
  const content = body?.choices?.[0]?.message?.content || "";
  invariant(content.trim(), "quality judge returned no final content", raw.slice(0, 1_200));
  const judged = JSON.parse(content);
  const scores = dimensions.map((dimension) => Number(judged?.scores?.[dimension]));
  invariant(scores.every(Number.isFinite), "quality judge returned invalid dimensions", content);
  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const minimum = Math.min(...scores);
  invariant(average >= MIN_JUDGE_AVG && minimum >= MIN_JUDGE_DIM, "V4 Pro quality score below release threshold", JSON.stringify({ average, minimum, judged }));
  return { ...judged, average, minimum };
}

const suiteStartedAt = Date.now();
const results = [];
const failures = [];
mkdirSync(ARTIFACT_DIR, { recursive: true });
const selectedDefinitions = CASE_FILTER
  ? caseDefinitions.filter((definition) => definition.id === CASE_FILTER)
  : caseDefinitions;
invariant(selectedDefinitions.length > 0, `unknown REASONING_QUALITY_CASE: ${CASE_FILTER}`);
for (const definition of selectedDefinitions) {
  const caseState = makeCase(definition);
  let preflight;
  let m03;
  try {
    preflight = await clinicalFactsPreflight(caseState);
    m03 = await callM03(preflight.clinicalFacts
      ? { ...caseState, clinicalFacts: preflight.clinicalFacts }
      : caseState);
    writeFileSync(
      resolve(ARTIFACT_DIR, `${definition.id}.json`),
      `${JSON.stringify({
        definition,
        timing: {
          preflightMs: preflight.elapsedMs,
          m03Ms: m03.elapsedMs,
          firstFrameMs: m03.firstFrameMs,
          maxInterFrameMs: m03.maxInterFrameMs,
        },
        visible: m03.visible,
        reasoning: m03.reasoning,
      }, null, 2)}\n`,
    );
    deterministicQuality(definition, m03);
    const judge = await judgeQuality(definition, m03.reasoning);
    const item = {
      id: definition.id,
      label: definition.label,
      preflightMs: preflight.elapsedMs,
      m03Ms: m03.elapsedMs,
      firstFrameMs: m03.firstFrameMs,
      maxInterFrameMs: m03.maxInterFrameMs,
      vitalsProvided: Object.values(definition.vitals).some((value) => String(value || "").trim()),
      westernDiagnosis: m03.reasoning.westernDiagnosis?.primary?.name,
      tcmSyndrome: m03.reasoning.overview?.primarySyndrome,
      judge,
    };
    results.push(item);
    console.log(`PASS  ${definition.label}  M03=${m03.elapsedMs}ms  judge=${judge.average.toFixed(2)}/5  min=${judge.minimum}`);
  } catch (error) {
    const failure = {
      id: definition.id,
      label: definition.label,
      message: error instanceof Error ? error.message : String(error),
      detail: error && typeof error === "object" && "detail" in error ? String(error.detail || "") : "",
      preflightMs: preflight?.elapsedMs,
      m03Ms: m03?.elapsedMs,
      firstFrameMs: m03?.firstFrameMs,
      maxInterFrameMs: m03?.maxInterFrameMs,
      westernDiagnosis: m03?.reasoning?.westernDiagnosis?.primary?.name,
      tcmSyndrome: m03?.reasoning?.overview?.primarySyndrome,
    };
    failures.push(failure);
    console.error(`FAIL  ${definition.label}  ${failure.message}${failure.detail ? `: ${failure.detail}` : ""}`);
  }
}

const latencies = results.map((item) => item.m03Ms);
const summary = {
  suite: "reasoning-quality-matrix",
  baseUrl: BASE_URL,
  judgeModel: JUDGE_MODEL,
  thresholds: {
    maxM03Ms: MAX_M03_MS,
    maxLivenessGapMs: MAX_LIVENESS_GAP_MS,
    minJudgeAverage: MIN_JUDGE_AVG,
    minJudgeDimension: MIN_JUDGE_DIM,
  },
  performance: {
    caseCount: results.length,
    blankVitalsCaseCount: results.filter((item) => item.vitalsProvided === false).length,
    minMs: latencies.length > 0 ? Math.min(...latencies) : null,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.length > 0 ? Math.max(...latencies) : null,
    totalMs: Date.now() - suiteStartedAt,
  },
  results,
  failures,
};
writeFileSync(resolve(ARTIFACT_DIR, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) process.exitCode = 1;

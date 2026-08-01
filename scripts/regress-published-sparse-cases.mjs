/**
 * 真实公开医案 → 稀疏门诊录入 → M01–M05 全流程质量审查。
 *
 * 与 regress-primary-care-sparse-50 的区别：那套是**虚构**固定用例，用于契约断言；
 * 这套取**已公开发表的医案**（中国中医药报、河南中医药大学第一附属医院传承工作室等教学材料），
 * 把它们裁剪成一个忙碌门诊医生真正会敲进去的那几句话，其余四诊/病史作为「医生被追问后才会说」
 * 的信息扣在手里。目的是审查推理质量，不是断言字符串。
 *
 * 用法：BASE_URL=http://127.0.0.1:3000 node --env-file-if-exists=.env.local scripts/regress-published-sparse-cases.mjs
 * 输出：artifacts/published-sparse-<时间戳>/ 下每例一份完整记录 + summary.json
 *
 * 数据说明：原始医案为公开发表的教学材料，仅有姓氏与年龄性别；本脚本进一步改写为门诊口语，
 * 不保留任何可识别信息，也不写入 scripts/fixtures（那里按仓库约定只放虚构用例）。
 */
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
const ARTIFACT_DIR = process.env.PUBLISHED_SPARSE_DIR
  || path.join("artifacts", `published-sparse-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const ONLY = new Set((process.env.PUBLISHED_SPARSE_CASES || "").split(",").map((s) => s.trim()).filter(Boolean));

/**
 * sparse  = 医生真正敲进去的（主诉 + 一两句），刻意不含舌脉、不含既往史
 * withheld= 原医案里有、但医生要被问到才会说的（用于回答 M02）
 * expert  = 原医案作者的辨证与用方，仅作对照讨论，不作评分标准
 */
const CASES = [
  {
    id: "PUB01", label: "不寐-肝郁血虚", source: "中国中医药报·顽固性失眠治验",
    sparse: { patient: { sex: "女", age: 40 }, chiefComplaint: "睡不着三年多了，一直靠阿普唑仑才能睡",
      symptoms: { sleep: "入睡困难，多梦易醒" } },
    withheld: "头脑昏沉不清，时有头痛，心悸气短；情绪低落焦虑，两条腿没劲，大便偏稀，吃得少；月经量少推迟。舌质暗有瘀点，苔薄白腻，脉细弦无力。血压 118/76mmHg，体温 36.4℃，脉搏 72 次/分，呼吸 18 次/分。否认糖尿病高血压，除阿普唑仑外无其他长期用药，无药物过敏。",
    expert: { syndrome: "肝郁血虚、脾肾不足、心神失养", formula: "柴胡/当归/白芍/茯神/白术/枳壳/香附/丹参/续断/百合/酸枣仁/合欢皮/龙骨" },
  },
  {
    id: "PUB02", label: "不寐-肝阳上亢痰瘀", source: "中国中医药报·顽固性失眠治验",
    sparse: { patient: { sex: "女", age: 59 }, chiefComplaint: "失眠三年多，有时候整晚睡不着",
      symptoms: { sleep: "入睡困难" }, vitals: { BP: "150/90mmHg" } },
    withheld: "头脑昏沉，间或头胀头痛；胃口差、心慌、口干、脾气急、眼睛干。舌暗红苔黄腻，脉弦滑数。体温 36.6℃，脉搏 82 次/分，呼吸 18 次/分。有高血压史未规律服药，无药物过敏。",
    expert: { syndrome: "肝阳上亢、痰瘀阻络", formula: "天麻/钩藤/龙骨/牡蛎/石决明/玄参/丹皮/丹参/鸡血藤/百合/胆南星/法半夏/地龙/酸枣仁/菊花" },
  },
  {
    id: "PUB03", label: "不寐-痰火扰心", source: "中国中医药报·顽固性失眠治验",
    sparse: { patient: { sex: "男", age: 53 }, chiefComplaint: "失眠一年多，吃右佐匹克隆也没用，一晚上就睡三个小时",
      symptoms: { sleep: "多梦、眠浅易醒" } },
    withheld: "心胸烦躁焦虑；夜里手脚心热，口干咽干，早上起来咳黄痰，小便黄少。舌红苔黄腻，脉滑数。血压 128/82mmHg，体温 36.7℃，脉搏 88 次/分，呼吸 18 次/分。否认肝肾疾病，无药物过敏。",
    expert: { syndrome: "痰火扰心、阴液不足", formula: "黄连温胆汤加减：黄连/茯苓/法半夏/炙甘草/枳实/竹茹/陈皮/玄参/百合/生地黄/知母/牡蛎/首乌藤" },
  },
  {
    id: "PUB04", label: "眩晕-痰热上扰", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "女", age: 71 }, chiefComplaint: "头晕一年多了，有时候天旋地转",
      symptoms: { other: "头晕，视物旋转" } },
    withheld: "偶尔恶心呕吐，四肢困重乏力。舌淡苔黄腻，脉滑。血压 138/84mmHg，体温 36.5℃，脉搏 76 次/分，呼吸 18 次/分。没有耳鸣耳聋，没有肢体无力和言语不清，没有摔倒外伤。无药物过敏。",
    expert: { syndrome: "痰热上扰清窍", formula: "柴芩温胆汤加减：柴胡/黄芩/半夏/陈皮/茯苓/枳实/竹茹/炒白术/丹参/钩藤/石决明/仙鹤草" },
  },
  {
    id: "PUB05", label: "头痛-血虚", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "女", age: 65 }, chiefComplaint: "头痛十年了，头顶和后脑勺一阵一阵地疼",
      symptoms: { pain: "巅顶及后枕部阵发性疼痛" } },
    withheld: "伴视物模糊。舌红苔薄黄，脉细。有高血压史，血压 146/88mmHg，体温 36.4℃，脉搏 74 次/分，呼吸 18 次/分。不是突然爆发的最剧烈头痛，没有发热、呕吐喷射、肢体无力和言语不清。无药物过敏。",
    expert: { syndrome: "血虚头痛", formula: "四物汤加减：熟地/当归/白芍/川芎/夏枯草/黄柏/钩藤/黄芪/桑叶/菊花" },
  },
  {
    id: "PUB06", label: "胸痹-气滞痰阻", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "男", age: 58 }, chiefComplaint: "心前区刺痛三年，这四天加重了",
      symptoms: { pain: "心前区刺痛" } },
    withheld: "体胖，身乏力。舌暗苔薄黄腻，脉沉细。血压 132/84mmHg，体温 36.5℃，脉搏 78 次/分，呼吸 18 次/分。这次加重是活动后出现，休息几分钟能缓解，目前不痛，没有大汗、濒死感和放射到左肩，没有晕厥。外院诊断不稳定型心绞痛，在吃阿司匹林和阿托伐他汀。无药物过敏。",
    expert: { syndrome: "气滞痰阻", formula: "柴胡黄芩温胆汤加减：柴胡/黄芩/半夏/陈皮/茯苓/枳实/竹茹/苍术/制乳香/莪术/全瓜蒌/黄芪" },
  },
  {
    id: "PUB07", label: "汗证-更年期", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "女", age: 63 }, chiefComplaint: "一阵一阵地烘热出汗，一个多月了",
      symptoms: { other: "全身阵发性烘热汗出" } },
    withheld: "汗出后身冷、畏寒。舌红苔黄腻，脉滑。血压 126/78mmHg，体温 36.6℃，脉搏 80 次/分，呼吸 18 次/分。绝经三年。没有发热、消瘦、心悸手抖和颈部肿大，甲功没查过。无药物过敏。",
    expert: { syndrome: "脾气亏虚、阴阳失调", formula: "玉屏风散加减：黄芪/炒白术/茯苓/黄连/黄柏/淫羊藿/仙茅/白芍/炒枣仁/龙骨/牡蛎" },
  },
  {
    id: "PUB08", label: "汗证-中阳不足", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "男", age: 58 }, chiefComplaint: "特别容易出汗，人也乏力，两年了",
      symptoms: { other: "静坐及活动后均汗出，倦怠乏力" } },
    withheld: "舌淡红苔白腻，脉弦滑。血压 124/78mmHg，体温 36.5℃，脉搏 76 次/分，呼吸 18 次/分。没有发热盗汗消瘦，没有咳嗽咯血，血糖查过正常。无药物过敏。",
    expert: { syndrome: "中阳不足、肺卫不固", formula: "黄芪汤加减：黄芪/炒白术/茯苓/干姜/熟地/山萸肉/枸杞/炒枣仁/黄柏/煅龙牡/桑叶" },
  },
  {
    id: "PUB09", label: "水肿-阳虚水泛", source: "伤寒名医验案·真武汤",
    sparse: { patient: { sex: "女", age: 40 }, chiefComplaint: "脸和手脚都肿起来了，还怕冷",
      symptoms: { other: "颜面及四肢浮肿" } },
    withheld: "腰以下肿得厉害，一按一个坑；胸闷气短，腰冷痛，手脚凉，小便清少，口渴但不想喝水。舌淡胖，苔薄白而润，脉沉细无力。血压 108/70mmHg，体温 36.3℃，脉搏 68 次/分，呼吸 18 次/分。没有泡沫尿、血尿和少尿无尿，没有夜间不能平卧，肾功能没查过。未孕。无药物过敏。",
    expert: { syndrome: "阳虚水泛", formula: "真武汤：附子/白术/茯苓/白芍/生姜/桂枝" },
  },
  {
    id: "PUB10", label: "不寐-肝胆火旺兼心脾两虚", source: "河南中医药大学一附院·张怀亮医案",
    sparse: { patient: { sex: "女", age: 64 }, chiefComplaint: "睡不着一个多月，躺下要很久才能睡着",
      symptoms: { sleep: "入睡困难，眠浅易醒" } },
    withheld: "心烦急躁，吃不下饭，口干。舌红苔白，脉弦。血压 130/80mmHg，体温 36.5℃，脉搏 78 次/分，呼吸 18 次/分。没有发热盗汗消瘦，没有情绪低落到不想活，甲功正常。绝经十余年。无药物过敏。",
    expert: { syndrome: "肝胆火旺、心脾两虚", formula: "逍遥散合归脾汤加减：熟地/炒白芍/枸杞/黄柏/淫羊藿/生龙骨/生牡蛎/夜交藤" },
  },
];

const COMPLETE = { level: "C", redFlag: 0.85, infoGain: 0.9, managementImpact: 0.9, answerability: 0.9 };

async function post(route, body, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    return { status: res.status, ms: Date.now() - startedAt, raw };
  } catch (error) {
    return { status: 0, ms: Date.now() - startedAt, raw: "", error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function ndjsonContent(raw) {
  let content = "";
  const errors = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.content === "string" && parsed.content !== "[END]") content += parsed.content;
      if (typeof parsed.error === "string") errors.push(parsed.error);
    } catch { /* not an NDJSON frame */ }
  }
  const markerIndex = content.lastIndexOf(STREAM_REPLACE_MARKER);
  const provisional = markerIndex >= 0 ? content.slice(0, markerIndex) : "";
  const visible = markerIndex >= 0 ? content.slice(markerIndex + STREAM_REPLACE_MARKER.length) : content;
  return { visible, provisional, errors };
}

function sentinelJson(text) {
  const block = text.match(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/);
  if (!block) return null;
  try { return JSON.parse(block[1]); } catch { return null; }
}

async function runCase(entry) {
  const record = { id: entry.id, label: entry.label, source: entry.source, expert: entry.expert, stages: {} };
  const base = {
    id: `pub-${entry.id}`, phase: "collect",
    patient: entry.sparse.patient, chiefComplaint: entry.sparse.chiefComplaint,
    symptoms: entry.sparse.symptoms || {}, tongue: "", pulse: "", faceNote: "",
    vitals: entry.sparse.vitals || {}, pastHistory: "", medicationHistory: "", allergyHistory: "",
    completeness: { level: "A", redFlag: 0.3, infoGain: 0.3, managementImpact: 0.3, answerability: 0.3 },
    conversation: [], diagnosis: "", prescription: "", riskAssessment: "",
    questionRounds: 0, maxQuestionRounds: 2,
  };

  // ── M02 追问 ────────────────────────────────────────────────────────────────
  const question = await post("/api/diagnosis/question", { caseState: { ...base, phase: "question" } });
  const questionOut = ndjsonContent(question.raw);
  record.stages.question = {
    status: question.status, ms: question.ms, errors: questionOut.errors,
    visible: questionOut.visible,
  };

  // 医生回答：把扣住的四诊/病史一次交出（模拟医生看到追问后补录）。
  const answered = {
    ...base, phase: "diagnose",
    conversation: questionOut.visible
      ? [{ role: "assistant", content: questionOut.visible }, { role: "user", content: entry.withheld }]
      : [],
    questionRounds: 1,
    completeness: COMPLETE,
  };
  // 稀疏录入的现实：医生补录时是把话说给系统听，而不是逐字段填表。
  answered.symptoms = { ...answered.symptoms, supplement: entry.withheld };

  // ── M03 辨病辨证 ───────────────────────────────────────────────────────────
  const diagnose = await post("/api/diagnosis/diagnose", { caseState: answered });
  const diagnoseOut = ndjsonContent(diagnose.raw);
  const reasoningDiagnose = sentinelJson(diagnoseOut.visible);
  record.stages.diagnose = {
    status: diagnose.status, ms: diagnose.ms, errors: diagnoseOut.errors,
    provisionalChars: diagnoseOut.provisional.length,
    moduleNotices: (diagnoseOut.provisional.match(/^▸ .+$/gm) || []),
    visible: diagnoseOut.visible,
    reasoning: reasoningDiagnose,
  };

  // ── M04 候选方药 ───────────────────────────────────────────────────────────
  if (reasoningDiagnose) {
    const prescribeState = { ...answered, phase: "prescribe", diagnosis: diagnoseOut.visible, reasoningDiagnose };
    const prescribe = await post("/api/diagnosis/prescribe", { caseState: prescribeState });
    const prescribeOut = ndjsonContent(prescribe.raw);
    const reasoningPrescribe = sentinelJson(prescribeOut.visible);
    record.stages.prescribe = {
      status: prescribe.status, ms: prescribe.ms, errors: prescribeOut.errors,
      moduleNotices: (prescribeOut.provisional.match(/^▸ .+$/gm) || []),
      visible: prescribeOut.visible,
      reasoning: reasoningPrescribe,
    };

    // ── M05 随访与风险 ───────────────────────────────────────────────────────
    const assessState = { ...prescribeState, phase: "assess", prescription: prescribeOut.visible, reasoningPrescribe };
    const assess = await post("/api/diagnosis/assess", { caseState: assessState });
    const assessOut = ndjsonContent(assess.raw);
    record.stages.assess = { status: assess.status, ms: assess.ms, errors: assessOut.errors, visible: assessOut.visible };
  }

  return record;
}

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const selected = CASES.filter((entry) => ONLY.size === 0 || ONLY.has(entry.id));
const summary = [];
for (const entry of selected) {
  process.stderr.write(`[published-sparse] ${entry.id} ${entry.label} …\n`);
  const record = await runCase(entry);
  await fs.writeFile(path.join(ARTIFACT_DIR, `${entry.id}.json`), JSON.stringify(record, null, 2));

  const diagnose = record.stages.diagnose || {};
  const prescribe = record.stages.prescribe || {};
  const reasoning = diagnose.reasoning;
  const candidate = prescribe.reasoning?.formula?.candidates?.[0];
  summary.push({
    id: entry.id, label: entry.label,
    expertSyndrome: entry.expert.syndrome,
    questionStatus: record.stages.question?.status,
    diagnoseStatus: diagnose.status, diagnoseMs: diagnose.ms,
    moduleNotices: (diagnose.moduleNotices || []).length,
    tcmDisease: reasoning?.overview?.tcmDiseaseName || null,
    syndrome: reasoning?.overview?.primarySyndrome || null,
    western: reasoning?.westernDiagnosis?.primary?.name || null,
    icd10: reasoning?.westernDiagnosis?.primary?.icd10Code || reasoning?.westernDiagnosis?.primary?.icd10 || null,
    therapy: reasoning?.therapy?.overallMethod || null,
    pathogenesisNodes: reasoning?.pathogenesis?.chain?.length || 0,
    prescribeStatus: prescribe.status, prescribeMs: prescribe.ms,
    formulaName: candidate?.name || null,
    herbCount: Array.isArray(candidate?.herbs) ? candidate.herbs.length : 0,
    assessStatus: record.stages.assess?.status,
    errors: [...(record.stages.question?.errors || []), ...(diagnose.errors || []), ...(prescribe.errors || [])],
  });
  process.stderr.write(`  ↳ ${JSON.stringify(summary[summary.length - 1])}\n`);
}

await fs.writeFile(path.join(ARTIFACT_DIR, "summary.json"), JSON.stringify({ artifactDir: ARTIFACT_DIR, cases: summary }, null, 2));
console.log(JSON.stringify({ artifactDir: ARTIFACT_DIR, cases: summary.length, summary }, null, 2));

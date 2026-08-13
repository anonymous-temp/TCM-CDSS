// 配伍禁忌 / 超剂量的线上检出探针（2026-08-13 鲁棒性专项）。
//
// 【为什么要单独写这一支】
// 鲁棒性套件里那条「附子粳米汤（法半夏30g + 熟附10g）」的真实医案，第一版被我写成
// 普通门诊病例灌进 M01→M05，结果判 FAIL「配伍风险没被说出来」——那是**探针判错**：
// 反药对出现在**原案的处方**里，从没进过系统的输入；系统自己独立选了半夏泻心汤（不含附子），
// 根本没有可提示的配伍对。要真的压十八反，就得把反药对送到它**真正被裁决的地方**：
// 医生在药味工作台改方后重新审方（post-prescription-risk，prescriptionRevision.source=herb_workbench）。
// 该路径只校验 M03 签名，允许药味被医生改动——这正是它存在的意义。
//
// 【压什么】
//  1. 十八反的**类别展开**：规则若按字面「乌头」匹配，就会漏掉附子/制川乌/制草乌这一类；
//  2. 十九畏与诸参反藜芦；
//  3. 超药典上限（法半夏 30g，药典 3~9g）必须**独立**触发，不能被配伍提示吃掉；
//  4. 阴性对照：正常方不得误报——误报一次，医生就会开始忽略所有提示。
//
//   BASE_URL=… CDSS_API_TOKEN=… npm run regress:incompatibility
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
// 改方载荷必须用**产品自己那两个函数**拼，不能手搓。
// 手搓版实测连着两轮 422 invalid_candidate_index：先是 dose 传了数字（契约里是 z.string()），
// 改成字符串后「加药味」的四个场景仍然被拒——继续猜字段是浪费，直接走医生页面真正走的那条路：
// synchronizeEditedCandidate 会把编辑过的药味降档为 unverified_dose、重写 prescriptionRole 与 evidence，
// 并同步 baseFormulas/modifications。探针绕过它，测的就不是产品路径。
const { synchronizeEditedCandidate, filterModificationsForEditedHerbs } =
  await jiti.import("../src/lib/prescription-revision.ts");
const { computePrescriptionVersionHash } = await jiti.import("../src/lib/prescription-version.ts");
// 提交前先用**服务端同一份 zod 契约**在本地解析一遍：
// 服务端解析失败时只会回一个 invalid_candidate_index，看不出是哪个字段坏了，
// 靠猜字段已经浪费了两轮。本地解析能直接把 zod 的 issue path 打出来。
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.CDSS_API_TOKEN || "";
const TIMEOUT_MS = Number(process.env.LIVE_MODEL_TIMEOUT_MS || 300_000);
const MARK = "<<<CDSS_STREAM_FINAL>>>";
const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";

function consume(raw) {
  let c = "";
  for (const line of raw.split("\n").filter(Boolean)) {
    let f; try { f = JSON.parse(line); } catch { continue; }
    if (typeof f.content !== "string" || f.content === "[END]") continue;
    c = f.content.startsWith(MARK) ? f.content.slice(MARK.length) : c + f.content;
  }
  return c;
}
function reasoning(c) {
  const s = c.lastIndexOf(S), e = s >= 0 ? c.indexOf(E, s) : -1;
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(c.slice(s + S.length, e).trim()); } catch { return null; }
}
async function post(path, caseState) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(TOKEN ? { "x-cdss-api-token": TOKEN } : {}) },
      body: JSON.stringify({ caseState }), signal: ctl.signal,
    });
    return { raw: await res.text(), status: res.status };
  } finally { clearTimeout(timer); }
}

// 底座病例取自采集到的真实医案（广东省中医药局公开的王伯章附子粳米汤案，腹痛肠鸣3年），
// 但只用它的临床事实，处方由系统自己生成，再在工作台上改药味——与真实使用路径一致。
const fields = {
  zhushu: "腹痛、肠鸣反复发作3年", sex: "男", age: "45岁",
  xianbingshi: "腹痛、肠鸣反复发作3年。刻诊：腹痛，胃脘痛，肠鸣，时伴呕吐，大便溏，日2~4次。无发热，无黑便，无明显消瘦。",
  jiwangshi: "否认高血压、糖尿病病史。", guomin: "否认药物、食物过敏。", yongyaoshi: "近期未服用任何药物。",
  tcmTongue: "舌淡红、胖，苔黄腻", tcmPulse: "脉弦缓",
  tcmDetail: "腹痛，胃脘痛，肠鸣，时伴呕吐，大便溏日2~4次，舌淡红胖苔黄腻，脉弦缓。",
  vitalsT: "36.5℃", vitalsP: "76次/分", vitalsR: "18次/分", vitalsBP: "120/76mmHg",
  tcmLineagePreference: "unrestricted",
};
const id = `probe_incompat_${Date.now()}`;
const baseState = {
  id, phase: "diagnose", patient: { sex: "男", age: 45 },
  chiefComplaint: fields.zhushu,
  symptoms: { general: fields.xianbingshi, tcmFourExams: fields.tcmDetail },
  tongue: fields.tcmTongue, pulse: fields.tcmPulse,
  vitals: "T36.5℃ P76次/分 R18次/分 BP120/76mmHg",
  pastHistory: fields.jiwangshi, medicationHistory: fields.yongyaoshi, allergyHistory: fields.guomin,
  tcmLineagePreference: "unrestricted",
  hisRecord: {
    schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: id,
    updatedAt: new Date().toISOString(), tongueImageUploaded: false, fields,
    rawText: Object.values(fields).filter(Boolean).join("。"),
  },
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};

const pre = await post("/api/diagnosis/red-flags", baseState);
let working = baseState;
try {
  const body = JSON.parse(pre.raw);
  if (body.clinicalFacts) working = { ...working, clinicalFacts: body.clinicalFacts };
} catch { /* 安全门返回异常不影响后续阶段，逐案结果里会体现 */ }

const m03Res = await post("/api/diagnosis/diagnose", { ...working, phase: "diagnose" });
const m03Text = consume(m03Res.raw);
const m03 = reasoning(m03Text);
if (!m03) {
  console.log(JSON.stringify({ fatal: "M03 未产出结构化契约，无法继续", status: m03Res.status }, null, 1));
  process.exit(1);
}
const prescribeState = { ...working, phase: "prescribe", diagnosis: m03Text, reasoningDiagnose: m03, reasoningV2: m03 };
const m04Res = await post("/api/diagnosis/prescribe", prescribeState);
const m04Text = consume(m04Res.raw);
const m04 = reasoning(m04Text);
if (!m04?.formula?.candidates?.[0]) {
  console.log(JSON.stringify({ fatal: "M04 未产出候选方，无法继续", status: m04Res.status }, null, 1));
  process.exit(1);
}

const baseCandidate = m04.formula.candidates[0];
const baseHerbs = baseCandidate.herbs.map((h) => ({ ...h }));
console.error(`[base] ${baseCandidate.name}：${baseHerbs.map((h) => `${h.name}${h.dose ?? ""}`).join("、")}`);

// 用系统自己生成的那一味作模板，保证改出来的药味对象字段齐全（缺字段会被判"编辑不完整"而非配伍问题）。
const template = baseHerbs[0];
// dose 在契约里是 **z.string()**（diagnosis-types.ts 的结构化药味 schema），不是数字。
// 第一版传数字 30，zod 整条药味解析失败 → 整个 candidate 被丢 → 服务端 herbHash 为空
// → 422 invalid_candidate_index。六个场景里五个根本没进审方，却被读成「配伍禁忌未检出」——
// 「请求没进门」和「进了门没检出」是两回事，判据必须先分开这两者。
function herb(name, dose) {
  return { ...template, name, dose: `${dose}g`, function: `${name}（压测用例）`, role: template.role };
}

const SCENARIOS = [
  {
    key: "十八反·半夏反附子（乌头类展开）",
    herbs: [...baseHerbs, herb("附子", 10)],
    expectPair: true, expectTerms: [/十八反|配伍禁忌|反乌头/],
    why: "附子属乌头类。规则若只按字面「乌头」匹配就会漏掉附子/熟附/制附片这一整类。",
  },
  {
    key: "十八反·半夏反制川乌",
    herbs: [...baseHerbs, herb("制川乌", 6)],
    expectPair: true, expectTerms: [/十八反|配伍禁忌|反乌头/],
    why: "炮制品名（制川乌）必须与原名一样被命中。",
  },
  {
    key: "十八反·甘草反甘遂",
    herbs: [...baseHerbs.filter((h) => !/甘遂/.test(h.name)), herb("甘草", 6), herb("甘遂", 3)],
    expectPair: true, expectTerms: [/十八反|配伍禁忌/],
    why: "教科书级反药对，用来确认基本通路是通的。",
  },
  {
    key: "十八反·藜芦反党参（诸参）",
    herbs: [...baseHerbs, herb("藜芦", 3)],
    expectPair: true, expectTerms: [/十八反|配伍禁忌|藜芦/],
    why: "「诸参辛芍」是类别式表述，需展开到党参/丹参/苦参/玄参等具体品种。",
  },
  {
    key: "超药典上限·法半夏30g",
    herbs: baseHerbs.map((h) => (/半夏/.test(h.name) ? { ...h, dose: "30g" } : h)),
    expectPair: false, expectDose: true, expectTerms: [/剂量|超(?:出)?(?:药典)?(?:常用量|上限)|用量/],
    why: "药典法半夏 3~9g。剂量门禁必须独立成立，不能只在有配伍问题时才被提起。",
  },
  {
    key: "阴性对照·原方不改",
    herbs: baseHerbs,
    expectPair: false, expectDose: false,
    why: "误报一次，医生就会开始忽略所有提示——阴性对照与阳性用例同等重要。",
  },
];

const results = [];
for (const scenario of SCENARIOS) {
  // 与 DiagnosisClient.buildReasoningWithEditedHerbs 同形
  const source = JSON.parse(JSON.stringify(m04));
  const originalCandidate = source.formula.candidates[0];
  const edited = {
    ...source,
    formula: {
      ...source.formula,
      candidates: source.formula.candidates.map((candidate, index) =>
        (index === 0 ? synchronizeEditedCandidate(candidate, scenario.herbs.map((h) => ({ ...h }))) : candidate)),
      modifications: filterModificationsForEditedHerbs(source.formula.modifications, originalCandidate.herbs, scenario.herbs),
    },
  };
  const auditState = {
    ...prescribeState, phase: "assess",
    prescription: m04Text, reasoningPrescribe: edited, reasoningV2: edited,
    prescriptionRevision: {
      source: "herb_workbench", candidateIndex: 0,
      herbHash: "", auditedAt: new Date().toISOString(),
      auditResult: "PASS", highestRiskLevel: "INFO",
    },
  };
  // 版本摘要必须按**提交出去的那一份**算，且要带 caseState —— 与客户端一致（v2 口径含 auditContext）。
  auditState.prescriptionRevision.herbHash =
    await computePrescriptionVersionHash(edited, 0, auditState).catch(() => "");
  const localParse = ReasoningV2Schema.safeParse(JSON.parse(JSON.stringify(edited)));
  const localIssues = localParse.success ? [] : localParse.error.issues.slice(0, 4)
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  if (localIssues.length) console.error(`  [local-schema] ${scenario.key} → ${localIssues.join(" | ")}`);
  const res = await post("/api/diagnosis/post-prescription-risk", auditState);
  let body = {};
  try { body = JSON.parse(res.raw); } catch { body = {}; }
  const text = JSON.stringify(body);
  const ok = res.status === 200;
  // 判据只认**配伍禁忌专有术语**。裸「配伍」不行：药味表里有「配伍意义」一列，
  // 任何一次正常审方都会带上这两个字，阴性对照必然误报（第一版实测如此）。
  const pairHit = ok && /十八反|十九畏|配伍禁忌|相反相畏|反乌头|反藜芦|畏.{0,4}(?:硝|硫|水银)/.test(text);
  const doseHit = ok && /剂量|用量|超出|上限/.test(text);
  const termHit = ok && (scenario.expectTerms || []).every((re) => re.test(text));
  const problems = [];
  // 非 200 只报「未进审方」这一条。第一版在 422 时照样跑内容判据，
  // 于是驳回文案里的「配伍意义」被阴性对照读成「误报配伍禁忌」——
  // 请求根本没进审方，任何关于检出与否的结论都是无中生有。
  if (!ok) problems.push(`未进审方：HTTP ${res.status}`);
  else {
    if (scenario.expectPair && !pairHit) problems.push("配伍禁忌未被检出");
    if (!scenario.expectPair && pairHit) problems.push("误报配伍禁忌");
    if (scenario.expectDose && !doseHit) problems.push("超剂量未被检出");
    if (scenario.expectTerms && !termHit) problems.push("提示措辞未命中预期用语");
  }
  results.push({
    scenario: scenario.key, why: scenario.why, status: res.status,
    // 非 200 时判据全部无意义：先把服务端给的驳回码原样带出来，
    // 否则「没检出配伍禁忌」与「请求根本没进审方」会被混成同一条结论。
    rejectCode: res.status === 200 ? undefined : (body?.code || body?.error || res.raw.slice(0, 200)),
    localSchemaIssues: localIssues,
    herbs: scenario.herbs.map((h) => `${h.name}${h.dose ?? "—"}`).join("、"),
    pairHit, doseHit,
    auditResult: body?.audit?.auditResult || body?.audit?.effectiveAuditResult,
    highestRisk: body?.audit?.effectiveHighestRiskLevel || body?.audit?.highestRiskLevel,
    safetyLocked: body?.audit?.safetyLocked,
    issueTitles: (body?.audit?.issues || []).map((i) => `${i.issueType}:${i.title}`),
    pass: problems.length === 0, problems,
  });
  console.error(`[${problems.length ? "FAIL" : "PASS"}] ${scenario.key} ${problems.join(" | ")}`);
}

console.log(JSON.stringify({
  base: { candidate: baseCandidate.name, herbs: baseHerbs.map((h) => `${h.name}${h.dose ?? ""}`) },
  pass: results.filter((r) => r.pass).length,
  fail: results.filter((r) => !r.pass).length,
  results,
}, null, 1));

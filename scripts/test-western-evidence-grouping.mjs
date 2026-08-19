// 西医诊断依据分组（2026-08-12 甲方线上实测原样贴出的那一屏）。
//
// 实测形态：
//   症状依据  突发剧烈头痛伴呕吐1小时（来源：主诉）
//             神清，表情痛苦（来源：面色及其他四诊）      ← 与体征依据重复
//             其他四诊/问诊补充：畏光                    ← 字段标题被当成依据内容
//             1小时前活动中突然出现…（来源：现病史）
//   体征依据  神清，表情痛苦（来源：面色及其他四诊）      ← 同一条印了两遍
//
// 两个根因：
//   ① 医生页面把**全量**支持依据当成 symptom 传进分组投影，于是每条体征依据都被印两遍——
//      又是「同一口径两处各写各的」：分类在服务端算好了，页面拿另一份列表覆盖掉了。
//   ② 病历传输格式的段落标题（「其他四诊/问诊补充：」）被模型抄进 supportingFacts。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { classifyWesternDiagnosticEvidence, westernDiagnosticEvidenceGroups } =
  await import("../src/lib/clinical-fact-source.ts");

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push({ name, message: error?.message || String(error) }); }
};

const REPORTED = {
  supportingFacts: [
    "突发剧烈头痛伴呕吐1小时",
    "神清，表情痛苦",
    "其他四诊/问诊补充：畏光",
    "1小时前活动中突然出现从未有过的最剧烈爆炸样头痛，数秒达峰，伴恶心、呕吐2次及颈项僵硬",
  ],
  supportingFactKinds: [{ fact: "神清，表情痛苦", kind: "sign" }],
  limitations: [],
  suggestedChecks: [],
};

check("① 一条依据只能落在一个分组里，不得跨组重复", () => {
  const evidence = classifyWesternDiagnosticEvidence(REPORTED, []);
  const groups = westernDiagnosticEvidenceGroups(evidence, []);
  const seen = new Map();
  for (const group of groups) {
    for (const item of group.items) {
      const previous = seen.get(item.text);
      assert.ok(!previous, `「${item.text}」同时出现在「${previous}」与「${group.label}」`);
      seen.set(item.text, group.label);
    }
  }
  // 甲方那一条正是体征：它只能在体征依据里。
  assert.equal(seen.get("神清，表情痛苦"), "体征依据");
});

check("② 病历传输格式的段落标题不得被当成依据内容", () => {
  const evidence = classifyWesternDiagnosticEvidence(REPORTED, []);
  const all = [...evidence.symptom, ...evidence.sign, ...evidence.exam];
  assert.ok(all.includes("畏光"), `「畏光」应作为依据保留，实际：${all.join(" | ")}`);
  for (const item of all) {
    assert.ok(
      !/^(?:其他四诊|四诊|问诊补充|现病史|主诉|既往史|舌象|脉象|面色|辅助检查)[^：:]{0,8}[：:]/.test(item),
      `字段标题被当成了依据内容：${item}`,
    );
  }
});

// ── 同一临床事件的不同粒度必须合并，保留详细的那条（甲方 2026-08-12 裁定「合并」）──────
const SOURCES = [
  { fieldId: "chief_complaint", text: "突发剧烈头痛伴呕吐1小时", label: "主诉" },
  { fieldId: "present_illness", text: "1小时前活动中突然出现从未有过的最剧烈爆炸样头痛，数秒达峰，伴恶心、呕吐2次及颈项僵硬", label: "现病史" },
];
const classify = (facts, kinds = [], sources = []) => classifyWesternDiagnosticEvidence(
  { supportingFacts: facts, supportingFactKinds: kinds, limitations: [], suggestedChecks: [] },
  sources,
);

check("④ 主诉与现病史讲同一件事时合并，保留详细的那条", () => {
  const evidence = classify(REPORTED.supportingFacts, REPORTED.supportingFactKinds, SOURCES);
  assert.ok(
    !evidence.symptom.includes("突发剧烈头痛伴呕吐1小时"),
    `主诉那条应被合并掉：${evidence.symptom.join(" | ")}`,
  );
  assert.ok(
    evidence.symptom.some((item) => item.includes("爆炸样头痛") && item.includes("颈项僵硬")),
    `应保留信息更全的现病史那条：${evidence.symptom.join(" | ")}`,
  );
  assert.ok(evidence.symptom.includes("畏光"), "其余依据不得被连坐折掉");
});

check("⑤ 合并的三条反向护栏：数值丢失 / 不同事件 / 字面巧合", () => {
  // ① 短条带着长条没有的具体数值——折掉会丢信息，必须保留两条。
  const numeric = classify(["发热38.5℃", "发热3天，最高体温39℃伴畏寒"]);
  assert.equal(numeric.symptom.length, 2, `丢了具体体温：${numeric.symptom.join(" | ")}`);
  // ② 不同事件不得合并。
  const distinct = classify(["头痛3天", "腹痛加重伴腹泻4次"]);
  assert.equal(distinct.symptom.length, 2, `不同事件被合并了：${distinct.symptom.join(" | ")}`);
  // ③ 字面巧合不得合并：「恶心」与「恶寒、心悸」共用两个字，但不是同一件事。
  const coincidence = classify(["恶心", "恶寒、心悸、乏力明显"]);
  assert.equal(coincidence.symptom.length, 2, `字面巧合被当成了同一事件：${coincidence.symptom.join(" | ")}`);
});

// ── 「它为什么没被发现」这一层 ──────────────────────────────────────────────
// 分类在 clinical-fact-source 里算得完全正确，是**页面**拿另一份列表把 symptom 覆盖掉了。
// 判据落在源码上：出口不得把全量支持依据当成某一个分组塞进投影。
check("③ 医生页面不得用全量支持依据覆盖某一个分组", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(
    !/symptom:\s*westernSupportingFactsDisplay/.test(source),
    "页面又把全量支持依据当成「症状依据」传进分组投影了——每条体征依据都会被印两遍",
  );
  assert.ok(!source.includes("westernSymptomFactsDisplay"), "医生页不再渲染症状依据折叠列表");
  assert.ok(
    source.includes('.filter((group) => !["症状依据", "体征依据", "依据"].includes(group.label))'),
    "医生页必须删除症状依据与体征依据分组，仅保留检查/排除/指南等必要信息",
  );
  const server = readFileSync(
    fileURLToPath(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    server.includes('.filter((group) => !["症状依据", "体征依据", "依据"].includes(group.label))'),
    "服务端 Markdown/下载报告也必须删除症状依据与体征依据分组",
  );
});

// ── ⑥⑦ 2026-08-12 线上实测（52 岁男性突发剧烈头痛）新抓到的两条 ────────────────
// 症状依据里印着「高血压病史5年，规律服药」与「氨氯地平 5mg 每日一次」——一条既往史、
// 一条用药史，都不是症状。根因是字段映射表把这三个病史字段一律映射成 symptom。
const HISTORY_SOURCES = [
  { fieldId: "chief_complaint", text: "突发剧烈头痛伴呕吐1小时", label: "主诉" },
  { fieldId: "past_history", text: "高血压病史5年，规律服药", label: "既往史" },
  { fieldId: "medication_history", text: "氨氯地平 5mg 每日一次", label: "用药史" },
  { fieldId: "allergy_history", text: "青霉素过敏", label: "过敏史" },
  { fieldId: "vitals", text: "178/102mmHg", label: "生命体征" },
];
const HISTORY_FACTS = ["突发剧烈头痛伴呕吐1小时", "高血压病史5年，规律服药", "氨氯地平 5mg 每日一次", "青霉素过敏", "178/102mmHg"];

check("⑥ 既往史/用药史/过敏史归病史依据，且模型标注不得把它们改回症状", () => {
  const evidence = classify(HISTORY_FACTS, [], HISTORY_SOURCES);
  assert.deepEqual(evidence.symptom, ["突发剧烈头痛伴呕吐1小时"], `症状依据混入了非症状：${evidence.symptom.join(" | ")}`);
  assert.deepEqual(
    evidence.history,
    ["高血压病史5年，规律服药", "氨氯地平 5mg 每日一次", "青霉素过敏"],
    `病史依据不完整：${evidence.history.join(" | ")}`,
  );
  assert.deepEqual(evidence.sign, ["178/102mmHg"], `生命体征应在体征依据：${evidence.sign.join(" | ")}`);

  // 模型把用药史标成 symptom 也不算数——这三个字段的落点即结论。
  const misdeclared = classify(HISTORY_FACTS, HISTORY_FACTS.map((fact) => ({ fact, kind: "symptom" })), HISTORY_SOURCES);
  assert.ok(
    misdeclared.history.includes("氨氯地平 5mg 每日一次"),
    `模型标注覆盖了病史字段：${misdeclared.symptom.join(" | ")}`,
  );

  // 「有啥列啥」：没有病史类依据时不出这一栏。
  const noHistory = classify(["突发剧烈头痛伴呕吐1小时"], [], HISTORY_SOURCES);
  assert.ok(
    !westernDiagnosticEvidenceGroups(noHistory, []).some((group) => group.label === "病史依据"),
    "无病史依据时不得占一个空栏",
  );
});

// 这一条才是它躲过上一轮的原因：分类的第二把判据（落点字段）需要 sources，
// 而医生页面调用时根本没传——字段兜底在那个出口上是死的，凡模型没标的都掉进症状依据。
check("⑦ 医生页面必须把 sources 传进分类，否则字段兜底整个失效", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url)),
    "utf8",
  );
  const call = source.match(/classifyWesternDiagnosticEvidence\(([^;]*?)\)\s*;/);
  assert.ok(call, "页面没有调用 classifyWesternDiagnosticEvidence");
  assert.ok(
    /,/.test(call[1]) && /[Ss]ources/.test(call[1]),
    `页面调用未传 sources，字段兜底失效：classifyWesternDiagnosticEvidence(${call[1]})`,
  );
  // 同一判据的两个出口必须都传：服务端 Markdown 一直传着，别把它改回去。
  const server = readFileSync(
    fileURLToPath(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /classifyWesternDiagnosticEvidence\([^)]*,[^)]*[Ss]ources[^)]*\)/.test(server),
    "服务端 Markdown 调用也必须传 sources",
  );
});

// ── ⑧ 无标题的裸行不得压过带标题的行 ────────────────────────────────────────────
// 上一条修完后再实测，载荷分组已对，但服务端 Markdown 那一屏仍写着
//   **症状依据**：…；高血压病史5年，规律服药（来源：现病史）；178/102mmHg（来源：现病史）
// 根因：trustedInputText 把 hisRecord.fields 的值**不带标题**拼进接地正文，
// clinicalFactSourcesFromContext 把每一条无标题的行断言成「现病史」，而归属判定先到先得，
// 裸行排在带 `既往史：` 的行前面。归属是「猜」出来的却与「读」出来的同权——把未知当已知。
const { clinicalFactSourcesFromContext, clinicalFactSourcesFromCaseState, clinicalFactSourceLabel } =
  await import("../src/lib/clinical-fact-source.ts");

check("⑧ 无标题裸行只是兜底，不得压过带字段标题的行", () => {
  // 线上接地正文的真实形状：hisRecord 裸值在前，带标题的临床录入字段在后。
  const context = [
    "突发剧烈头痛伴呕吐1小时",
    "高血压病史5年，规律服药",
    "178/102mmHg",
    "既往史：高血压病史5年，规律服药",
    "生命体征：178/102mmHg",
  ].join("\n");
  const sources = clinicalFactSourcesFromContext(context);
  assert.equal(clinicalFactSourceLabel("高血压病史5年，规律服药", sources), "既往史");
  assert.equal(clinicalFactSourceLabel("178/102mmHg", sources), "生命体征");
  // 首行无标题时恒为主诉，这是契约位置不是猜测，不受影响。
  assert.equal(clinicalFactSourceLabel("突发剧烈头痛伴呕吐1小时", sources), "主诉");
  // 真·无标题的行仍照旧兜底到现病史（基层/兼容调用方不带标签，不能因此不标来源）。
  const bare = clinicalFactSourcesFromContext("主诉一句\n畏光");
  assert.equal(clinicalFactSourceLabel("畏光", bare), "现病史");

  // 分类与来源标注必须给出同一个答案——它们此前是两份各写各的判据。
  const evidence = classify(
    ["高血压病史5年，规律服药", "178/102mmHg"],
    [],
    sources,
  );
  assert.ok(evidence.history.includes("高血压病史5年，规律服药"), `分类与来源标注不一致：${JSON.stringify(evidence)}`);
  assert.ok(evidence.sign.includes("178/102mmHg"), `分类与来源标注不一致：${JSON.stringify(evidence)}`);
});

check("⑨ HIS 直传（无顶层字段、正文全是裸行）也要认得出字段", () => {
  // 这一路正文里一条带标题的行都没有，只能靠受治理字段路径读病例状态。
  const caseState = {
    chiefComplaint: "突发剧烈头痛伴呕吐1小时",
    hisRecord: {
      fields: {
        zhushu: "突发剧烈头痛伴呕吐1小时",
        jiwangshi: "高血压病史5年，规律服药",
        yongyaoshi: "氨氯地平 5mg 每日一次",
      },
    },
    vitals: { bp: "178/102mmHg" },
  };
  const sources = [
    ...clinicalFactSourcesFromCaseState(caseState),
    ...clinicalFactSourcesFromContext("突发剧烈头痛伴呕吐1小时\n高血压病史5年，规律服药\n氨氯地平 5mg 每日一次\n178/102mmHg"),
  ];
  assert.equal(clinicalFactSourceLabel("高血压病史5年，规律服药", sources), "既往史");
  // 「当前用药」是受治理矩阵里 medication_history 的中文名，不在本文件写死显示名。
  assert.equal(clinicalFactSourceLabel("氨氯地平 5mg 每日一次", sources), "当前用药");
  assert.equal(clinicalFactSourceLabel("178/102mmHg", sources), "生命体征");
});

// 服务端出口必须真的拿到病例状态那一路——上一条只证明函数对，不证明出口接了。
check("⑩ 服务端 Markdown 出口必须合并病例状态来源，不能只读接地正文", () => {
  const server = readFileSync(
    fileURLToPath(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /clinicalFactSourcesFromCaseState\(caseState\)/.test(server),
    "服务端出口没有合并 clinicalFactSourcesFromCaseState——HIS 直传的字段又会被猜成现病史",
  );
  const route = readFileSync(
    fileURLToPath(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /structuredCaseState:\s*safeState/.test(route),
    "M03 路由没有把脱敏病例状态传下去，上面那一路拿到的是 null",
  );
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "western-evidence-grouping", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "western-evidence-grouping", checks: 10, failures: 0 }));

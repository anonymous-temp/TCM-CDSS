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
  assert.ok(
    /symptom:\s*westernSymptomFactsDisplay/.test(source),
    "「症状依据」必须来自分类后的症状子集",
  );
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "western-evidence-grouping", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "western-evidence-grouping", checks: 5, failures: 0 }));

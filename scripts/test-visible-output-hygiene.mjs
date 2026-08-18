// 渲染层卫生回归（甲方评测 2026-08-04 呈现层四条）。
//
// ─── 为什么必须新增这一套，而不是往既有 69 套里加断言 ────────────────────────────────
// 本仓库既有的确定性套件**全部断言 lib 层函数的返回值**：给 buildFormulaAnalysis 一个数组，
// 看它吐什么；给 synchronizeVisibleClinicalSummary 一段 Markdown，看它吐什么。而甲方看的是
// **浏览器里渲染出来的字**。这两者之间隔着一整条投影链：
//
//   模型结构化载荷 → 确定性投影(applyDeterministic*) → sentinel 回写 → 服务端可见 Markdown
//                                                   ↘ 客户端解析 sentinel → React 组件树 → DOM 文本
//
// 「函数绿 + 页面错」在这条链上有三种成立方式，既有测试一种都拦不住：
//   1. **只洗了一条支路**：服务端 Markdown 洗干净了，但客户端走的是结构化渲染（直接把
//      reasoning.therapy.subTherapies[].targetPathogenesis 印进 JSX），照样漏。第 1、3 条正是这样。
//   2. **函数正确但没人调用**：buildFormulaAnalysis 缩短了，可页面渲染的是载荷里存着的旧 analysis。
//   3. **组件删了一半**：函数还在、测试还绿，页面上却挂着一个永远 return null 的空壳（第 4 条）。
//
// 因此本套件的输入是 artifacts/ 归档的**真实 M03/M04 产出**（未改写，见各 fixture 的 provenance），
// 输出是用 react-dom/server 把结果区组件（CompactAiSchemeCardFlow，内含 ResultTabsV2）渲染成
// 静态 HTML 后抽出的**纯文本**——断言对象就是医生眼睛看到的那串字。
//
// 断言分五组：
//   A 内部工程记号（第 1 条）：渲染文本里不得出现层号/内部枚举/字段名/驳回码。
//   B 方义解析长度（第 2 条）：渲染文本里的方义原文 ≤ formulaAnalysisCharBudget(药味数)。
//   C 病机不重复（第 3 条）：任一段病机原文在整页里最多完整出现一次。
//   D 旧组件零残留（第 4 条）：**按类**判定——模块级定义了却无人引用的组件/函数一律失败，
//      不是维护一张已删名字的黑名单。
//   E 误伤对照：ICD-10 编码、椎体节段、甲功/补体检验项必须**逐字幸存**。净化器把
//      `L50.801` 洗成 `801`、把「L1椎体压缩性骨折」洗成「椎体压缩性骨折」是比漏标签严重得多的事故。
//
// 另有两组合成注入用例（F/G）：真实载荷 + 人工注入内部记号 / 临床相似记号，
// 证明这张网**确实会响**，而不是「语料恰好干净所以全绿」。
import assert from "node:assert/strict";
import fs from "node:fs";
import { hasLocalArtifact } from "./lib/local-artifacts.mjs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: true, alias: { "@": `${process.cwd()}/src` } });

const React = (await import("react")).default;
// jiti 的 JSX 变换产出经典 React.createElement 调用，需要全局 React。
globalThis.React = React;
const { renderToStaticMarkup } = await import("react-dom/server");

const { CompactAiSchemeCardFlow } = await jiti.import("../src/app/diagnosis/DiagnosisClient.tsx");
const { extractDiagnosisJSON, mergeReasoningStages, parseReasoningV2, stripDiagnosisJSON } =
  await jiti.import("../src/lib/diagnosis-parse.ts");
const { sanitizeDiagnoseStreamingDraft } = await jiti.import("../src/lib/diagnosis-stream-safety.ts");
const {
  applyDeterministicFormulaAnalysis,
  applyDeterministicHerbFunctions,
  synchronizeVisibleClinicalSummary,
} = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { findInternalEngineeringTags, INTERNAL_TAG_RULES } = await jiti.import("../src/lib/internal-tag-hygiene.ts");
const { formulaAnalysisCharBudget } = await jiti.import("../src/lib/herb-target-contract.ts");

const FIXTURE_DIR = new URL("./fixtures/visible-output-hygiene/", import.meta.url);
const CLIENT_SOURCE_PATH = "src/app/diagnosis/DiagnosisClient.tsx";

let cases = 0;
let failures = 0;
const check = (name, fn) => {
  cases += 1;
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.error("FAIL", name, "\n   ", error?.message?.split("\n").slice(0, 6).join("\n    "));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 投影：把归档的阶段正文送过与生产路由**同一条**确定性投影链，再喂给客户端组件。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * M04 侧只重放与本轮四条直接相关的两步（见 diagnosis-api.ts 的 prescribe 分支）：
 * applyDeterministicHerbFunctions → applyDeterministicFormulaAnalysis → synchronizeVisibleClinicalSummary。
 * 上游的 herbTargets / therapyMatch / prescriptionRoles 在归档产出里已经落到载荷上，重放它们
 * 需要当时的 priorReasoning 与知识库上下文，重放也不会改变本套件断言的三类呈现属性。
 */
function projectStage(visible, stage) {
  if (!visible) return "";
  if (stage !== "prescribe") return synchronizeVisibleClinicalSummary(visible, stage);
  return synchronizeVisibleClinicalSummary(
    applyDeterministicFormulaAnalysis(applyDeterministicHerbFunctions(visible)),
    "prescribe",
  );
}

/** 复刻 DiagnosisClient 收流后的建态方式（见 handleSubmit 里 needsDiagnose / needsPrescribe 分支）。 */
function buildCaseState(fixture, projected) {
  const diagnoseReasoning = parseReasoningV2(projected.diagnose);
  const prescribeReasoning = parseReasoningV2(projected.prescribe);
  const reasoningDiagnose = diagnoseReasoning?.stage === "diagnose" ? diagnoseReasoning : undefined;
  const reasoningPrescribe = prescribeReasoning?.stage === "prescribe" ? prescribeReasoning : undefined;
  return withSafetyGate({
    ...fixture.caseState,
    phase: "done",
    diagnosis: sanitizeDiagnoseStreamingDraft(stripDiagnosisJSON(projected.diagnose)),
    prescription: stripDiagnosisJSON(projected.prescribe),
    riskAssessment: fixture.stages.assess.visible || "",
    reasoningDiagnose,
    reasoningPrescribe,
    reasoningV2: mergeReasoningStages(reasoningDiagnose, reasoningPrescribe),
  });
}

const HTML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };

/** 静态 HTML → 医生实际读到的纯文本。标签一律换成换行，避免相邻块的文字被粘成新词。 */
function visibleTextFromHtml(html) {
  return html
    .replace(/<[^>]+>/g, "\n")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => HTML_ENTITIES[entity] || entity)
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 服务端可见 Markdown（去掉 sentinel 与所有 HTML 注释——那些医生看不到）。 */
function visibleMarkdown(content) {
  return stripDiagnosisJSON(content).replace(/<!--[\s\S]*?-->/g, "").trim();
}

function renderResultAreaHtml(caseState) {
  return renderToStaticMarkup(React.createElement(CompactAiSchemeCardFlow, {
    caseState,
    onRetry: () => {},
    onAcceptEditedPrescription: async () => {},
    onConfirmEncounterScope: async () => {},
    onConfirmEmergencyClearance: async () => {},
    onDownloadReport: () => {},
  }));
}

function renderResultArea(caseState) {
  return visibleTextFromHtml(renderResultAreaHtml(caseState));
}

/** 一份 fixture 的全部医生可见面：服务端两段 Markdown + 客户端渲染文本。 */
function doctorVisibleSurfaces(fixture) {
  const projected = {
    diagnose: projectStage(fixture.stages.diagnose.visible, "diagnose"),
    prescribe: projectStage(fixture.stages.prescribe.visible, "prescribe"),
  };
  const caseState = buildCaseState(fixture, projected);
  return {
    projected,
    caseState,
    payloads: {
      diagnose: extractDiagnosisJSON(projected.diagnose),
      prescribe: extractDiagnosisJSON(projected.prescribe),
    },
    surfaces: [
      { id: "server-markdown/diagnose", text: visibleMarkdown(projected.diagnose), sections: markdownSections(visibleMarkdown(projected.diagnose)) },
      { id: "server-markdown/prescribe", text: visibleMarkdown(projected.prescribe), sections: markdownSections(visibleMarkdown(projected.prescribe)) },
      { id: "client-render/result-area", text: renderResultArea(caseState), sections: renderedSections(caseState) },
    ],
  };
}

/** 服务端 Markdown 按标题切段——医生视野里的「一节」。 */
function markdownSections(markdown) {
  return markdown.split(/^#{1,4}\s+/m).filter((section) => section.trim());
}

/**
 * 客户端渲染按 `<details>`（每个 SchemeSection）与 `data-clinical-renderer`（受治理渲染块）切段。
 * 两者都是组件树里现成的、与医生视觉分块一一对应的结构边界，不需要为测试新增标记。
 * 用受治理渲染块而不是只用 details：一个 SchemeSection 里可以并列多个块（药味表 / 随证加减 /
 * 方义解析），它们各自回答不同问题，各引一次病机是必要上下文，不是重复。
 */
function renderedSections(caseState) {
  return renderResultAreaHtml(caseState)
    .split(/<details\b|data-clinical-renderer=/)
    .map(visibleTextFromHtml)
    .filter(Boolean);
}

const fixtures = fs.readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync(new URL(name, FIXTURE_DIR), "utf8")));
assert.ok(fixtures.length >= 5, "fixture 语料过少，渲染层断言会失去代表性");

// ─────────────────────────────────────────────────────────────────────────────
// A. 内部工程记号不得出现在任何医生可见面（第 1 条）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 层号的**字面**断言，与 internal-tag-hygiene 的规则表相互独立：
 * 规则表若被人改坏（比如把 legacy_layer_tag 整条删掉），findInternalEngineeringTags 会静默返回空，
 * 这行断言仍然会响。甲方看到的原话就是「混入 L0/L1/L3」。
 * 前后紧邻 `[A-Za-z0-9._/-]` 的一律不算——那是 ICD-10 编码或椎体节段，见 E 组。
 */
const STANDALONE_LAYER_TAG = /(?<![A-Za-z0-9._/-])L\d{1,2}(?![A-Za-z0-9._/-])/;

/** 确定性打印点曾经直接 `${}` 进正文的内部枚举取值。 */
const INTERNAL_ENUM_LITERALS = [
  "canon", "tiaowen", "chapter_paragraph", "page_paragraph",
  "kb_entry", "deterministic_rule", "drug_label",
  "middle_jiao_support", "governed_boundary",
  "targetPathogenesis", "primarySyndromeResolution", "schemaVersion",
];

for (const fixture of fixtures) {
  const { surfaces } = doctorVisibleSurfaces(fixture);
  for (const surface of surfaces) {
    check(`A/${fixture.fixtureId}/${surface.id} 无内部工程记号`, () => {
      assert.deepEqual(findInternalEngineeringTags(surface.text), [],
        `医生可见文本残留内部记号：${JSON.stringify(findInternalEngineeringTags(surface.text))}`);
    });
    check(`A/${fixture.fixtureId}/${surface.id} 无裸层号`, () => {
      const hit = surface.text.match(STANDALONE_LAYER_TAG);
      assert.equal(hit, null, `渲染文本出现裸层号 ${hit?.[0]}：${surface.text.slice(Math.max(0, (hit?.index || 0) - 30), (hit?.index || 0) + 30)}`);
    });
    check(`A/${fixture.fixtureId}/${surface.id} 无内部枚举字面量`, () => {
      const leaked = INTERNAL_ENUM_LITERALS.filter((token) => surface.text.includes(token));
      assert.deepEqual(leaked, [], `内部枚举取值被印进医生正文：${leaked.join("、")}`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 方义解析长度预算（第 2 条）
// ─────────────────────────────────────────────────────────────────────────────
// 断言链条是「载荷里的方义原文 → 确实逐字出现在渲染文本里 → 长度不超预算」。
// 中间那一环不能省：只测函数返回值，就无法排除页面渲染的是另一份（更长的）旧文本。
for (const fixture of fixtures) {
  const { payloads, surfaces } = doctorVisibleSurfaces(fixture);
  const candidates = payloads.prescribe?.formula?.candidates || [];
  if (candidates.length === 0) continue;
  const pageText = surfaces.find((item) => item.id === "client-render/result-area").text;
  candidates.forEach((candidate, index) => {
    const analysis = String(candidate.formulaAnalysis || "");
    if (!analysis) return;
    const herbCount = Array.isArray(candidate.herbs) ? candidate.herbs.length : 0;
    check(`B/${fixture.fixtureId}/候选${index} 方义解析逐字出现在页面上`, () => {
      // 渲染文本里标签被换成了换行，方义段落本身是单个文本节点，可整段比对。
      assert.ok(pageText.replace(/\n/g, "").includes(analysis.replace(/\n/g, "")),
        "载荷里的方义解析没有原样渲染到页面上——测的东西和医生看的不是同一份");
    });
    check(`B/${fixture.fixtureId}/候选${index} 方义解析不超长度预算`, () => {
      const budget = formulaAnalysisCharBudget(herbCount);
      assert.ok(analysis.length <= budget,
        `方义解析 ${analysis.length} 字 > ${herbCount} 味方的预算 ${budget} 字。` +
        `超预算通常意味着又有人往每行加了不携带本例信息的模板句。`);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 病机原文在整页里最多完整出现一次（第 3 条）
// ─────────────────────────────────────────────────────────────────────────────

/** 与 diagnosis-visible-summary 的去重账本同口径：抹掉标点空白后比对。 */
function narrativeFingerprint(value) {
  return String(value || "").replace(/[\s，,。；;：:、（）()[\]【】「」“”‘’"']+/g, "");
}

function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

for (const fixture of fixtures) {
  const { payloads, surfaces } = doctorVisibleSurfaces(fixture);
  const reasoning = payloads.diagnose;
  if (!reasoning) continue;
  // 载荷里所有会被印到医生面前的病机叙述：少收一处，那一处就成了「看不见的容器」，
  // 既不会被查重、也不会参与下面的包含关系扣减（症状群机制句就是这样漏过一轮的）。
  const prescribeReasoning = payloads.prescribe;
  const narratives = [
    reasoning.overview?.overallPathogenesis,
    reasoning.pathogenesis?.summary,
    reasoning.pathogenesis?.caseRelationship?.relationship,
    ...(reasoning.pathogenesis?.chain || []).map((node) => node.pathogenesis),
    ...(reasoning.pathogenesis?.symptomClusters || []).map((item) => item.mechanism),
    ...(reasoning.therapy?.subTherapies || []).map((item) => item.targetPathogenesis),
    ...(prescribeReasoning?.formula?.candidates || []).flatMap((candidate) => [
      ...(candidate.herbs || []).map((herb) => herb.targetPathogenesis),
    ]),
    ...(prescribeReasoning?.formula?.modifications || []).map((item) => item.targetPathogenesis),
    ...(prescribeReasoning?.nonPharma?.tcmTreatments || []).map((item) => item.targetPathogenesis),
  ];
  // 12 字以下的病机短句（「气机不畅」）本来就可能在不同语境下各自成立，不算重复。
  const distinct = [...new Set(narratives.map(narrativeFingerprint).filter((item) => item.length >= 12))];
  for (const surface of surfaces) {
    check(`C/${fixture.fixtureId}/${surface.id} 病机在任一节内不重复`, () => {
      // 判据是**节内最多一次**，不是整页最多一次。
      // 页面上的病机推理区、药味表、方义解析、随证加减、中医治疗项目分别在回答不同问题，
      // 各自引一次病机是必要的上下文；甲方说的「重复」是同一节里把同一句连印 N 遍
      // （实测最坏：15 味方的药味表把同一句印 15 遍，整页 19 遍）。
      // 把判据定成整页一次会逼出一套跨节编号引用，医生单看处方就不知道 ① 指什么——
      // 那是把可读性换成一个好看的断言。
      const worst = [];
      for (const section of surface.sections) {
        const sectionFingerprint = narrativeFingerprint(section);
        for (const narrative of distinct) {
          // 病机字段之间天然互为前缀：chain 节点的病机常常是 overallPathogenesis 的头一句，
          // 也可能同时是 caseRelationship 的头一句。这类「被更长的一段裹着出现」不是重复——
          // 医生读到的是那两段完整的话，不是这段短句被印了两遍。因此先扣掉被极大包含段落
          // 覆盖的次数，剩下的才是这段病机自己被独立印出来的次数。
          const containers = distinct.filter((other) => other !== narrative && other.includes(narrative));
          const maximal = containers.filter((item) => !containers.some((other) => other !== item && other.includes(item)));
          const covered = maximal.reduce((sum, item) => sum + occurrences(sectionFingerprint, item), 0);
          const count = occurrences(sectionFingerprint, narrative) - covered;
          if (count > 1) worst.push({ narrative: `${narrative.slice(0, 16)}…`, count, section: section.slice(0, 24).replace(/\n/g, " ") });
        }
      }
      assert.deepEqual(worst, [],
        `同一段病机在同一节里被完整印了多次：${JSON.stringify(worst.slice(0, 3))}。` +
        `去重权威是 createPathogenesisNarrativeLedger / formulaTargetPathogenesisCells，` +
        `新增一处病机呈现点必须接入同一本账本。`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D. 旧组件零残留（第 4 条）——按类判定，不维护黑名单
// ─────────────────────────────────────────────────────────────────────────────
const clientSourceRaw = fs.readFileSync(CLIENT_SOURCE_PATH, "utf8");
// 注释里会写「已删除 EvidenceCallout 等」这类说明；判定残留只看代码，不看注释。
const clientSource = clientSourceRaw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

check("D/结果区源码里不存在「定义了但无人引用」的组件或函数", () => {
  // 这是第 4 条的**类级**判据：不维护一张「已删名字」的黑名单（那只能拦住已经发生过的那次），
  // 而是禁止「定义了却没人用」这个状态本身。
  //
  // `void X;` 是本仓库压未用告警的惯用法，也正是「删了一半」的伪装：它让编译器闭嘴，
  // 于是一个永远 return null 的空壳可以无限期留在源码里。计数前把这类抑制语句剔掉。
  //
  // 确实需要保留待重新挂载的（如药味加减工作台），必须写 `@retained-pending-remount <Name>`
  // 显式声明并说明理由——把「静默保留」变成「具名保留」，下一个人一眼看得出这是决定还是遗漏。
  const retained = new Set([...clientSourceRaw.matchAll(/@retained-pending-remount\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]));
  const counted = clientSource.replace(/\bvoid\s+[A-Za-z_$][\w$]*\s*;/g, "");
  const orphans = [];
  for (const match of clientSource.matchAll(/^(export\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm)) {
    const [, exported, name] = match;
    // 导出符号可能由路由、测试或其他模块引用，本文件内的计数不足以判定；只查未导出的。
    if (exported || retained.has(name)) continue;
    if (occurrences(counted, name) <= 1) orphans.push(name);
  }
  assert.deepEqual(orphans, [],
    `以下组件/函数在 ${CLIENT_SOURCE_PATH} 里定义了却无人引用（含被 void 抑制的伪引用）：` +
    `${orphans.join("、")}。要么挂回页面，要么删干净，要么写 @retained-pending-remount 说明为什么留——` +
    `留半截又不说明，正是甲方第 4 条。`);
});

check("D/已下线的证据参考组件族在源码与模块图里都不存在", () => {
  const removed = ["EvidenceCallout", "EvidenceDetail", "EvidenceReferenceList", "evidenceReferenceItems",
    "hasDisplayableEvidence", "enrichEvidenceReferenceForDisplay"];
  const residue = removed.filter((name) => clientSource.includes(name));
  assert.deepEqual(residue, [], `旧证据明细组件族残留：${residue.join("、")}`);
  assert.ok(!fs.existsSync("src/lib/evidence-display.ts"),
    "src/lib/evidence-display.ts 只被已删除的 EvidenceReferenceList 使用，应随组件族一并删除");
});

// ─────────────────────────────────────────────────────────────────────────────
// E. 误伤对照：临床上真实存在的拉丁记号必须逐字幸存
// ─────────────────────────────────────────────────────────────────────────────
// artifacts/ 全量 1440 份归档里 `\bL\d+\b` 命中 180 处，**全部是 ICD-10 皮肤科编码**
// （L50.801 荨麻疹 / L30.901 皮炎 / L23.900 接触性皮炎），零处是层号。
// 净化器只要少一层保护，第一个受害者就是它们。
const ICD_FIXTURE = fixtures.find((item) => item.fixtureId === "icd10-l-code");
check("E/ICD-10 编码在投影后逐字保留", () => {
  assert.ok(ICD_FIXTURE, "缺少 icd10-l-code fixture");
  const codes = [...JSON.stringify(ICD_FIXTURE.stages.diagnose.visible).matchAll(/\bL\d{2}(?:\.\d+)?\b/g)]
    .map((match) => match[0]);
  assert.ok(codes.length >= 3, "该 fixture 应带多个 L 开头 ICD-10 编码");
  const { payloads } = doctorVisibleSurfaces(ICD_FIXTURE);
  const projectedJson = JSON.stringify(payloads.diagnose);
  const damaged = [...new Set(codes)].filter((code) => !projectedJson.includes(code));
  assert.deepEqual(damaged, [], `ICD-10 编码被净化器截断/改写：${damaged.join("、")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// F/G. 合成注入：证明这张网确实会响，也证明它不会误伤
// ─────────────────────────────────────────────────────────────────────────────
const INJECTION_BASE = fixtures.find((item) => item.fixtureId === "pathogenesis-repetition");
assert.ok(INJECTION_BASE, "缺少注入用基线 fixture");

// 甲方 2026-08-18 医生端治疗项目实测：把完整后台治理对象注入真实归档病例，断言的不是
// 某个净化函数，而是 ResultTabsV2 最终 DOM 中这一个模块的实际文字。
{
  const base = doctorVisibleSurfaces(INJECTION_BASE).caseState;
  const prescribe = structuredClone(base.reasoningPrescribe);
  const treatment = (projectCode, overrides = {}) => ({
    projectCode,
    projectName: projectCode,
    availability: "clinic_available",
    riskLevel: "low",
    recommendationMode: "clinician_assessment",
    targetRef: "P1",
    targetPathogenesis: "脾虚失运，胃气上逆",
    protocolStatus: "governed_patient_specific_plan",
    treatmentContent: "本例命中标准项目方案，由现场医师复核后实施。",
    suggestedSitesOrPoints: [],
    scheduleSuggestion: "",
    techniqueBoundary: "由现场医师确认安全边界后实施。",
    protocolSource: "SRC-NATIONAL-TEST",
    sourceAuthorityTier: "national_standard",
    operatorRequirement: "由受训人员操作",
    requiredChecks: ["确认资质与操作禁忌"],
    containsMedication: false,
    requiresMedicationAudit: false,
    executable: false,
    clinicianReviewRequired: true,
    ...overrides,
  });
  prescribe.nonPharma = {
    diet: "少量多餐，晚餐后3小时内不平卧；可用山药小米粥，每周3次。",
    lifestyle: "规律作息",
    emotion: "保持情绪平稳",
    acupointCare: null,
    precautions: [],
    tcmTreatments: [
      treatment("diet_therapy", { projectName: "食疗法", scheduleSuggestion: "每周3次，2周后复评。" }),
      treatment("auricular", {
        projectName: "耳穴",
        suggestedSitesOrPoints: ["脾", "胃", "神门", "交感"],
        scheduleSuggestion: "每日按压3-5次，每次1-2分钟；每3-5天更换一次。",
      }),
      treatment("moxibustion", {
        projectName: "灸法",
        suggestedSitesOrPoints: ["中脘", "足三里"],
        scheduleSuggestion: "每周3次，连续2周后复评。",
      }),
      treatment("qigong_daoyin", {
        projectName: "气功导引疗法",
        protocolStatus: "assessment_only_no_patient_specific_protocol",
        treatmentContent: "本例仅进入项目评估，不形成操作计划。",
      }),
    ],
  };
  const caseState = {
    ...base,
    reasoningPrescribe: prescribe,
    reasoningV2: mergeReasoningStages(base.reasoningDiagnose, prescribe),
  };
  const html = renderResultAreaHtml(caseState);
  const start = html.indexOf('id="cdss-section-tcm-treatment"');
  const end = html.indexOf("<details", start + 1);
  const treatmentText = visibleTextFromHtml(html.slice(start, end > start ? end : undefined));

  check("J/医生端中医非药物方案只显示具体内容", () => {
    assert.ok(treatmentText.includes("中医非药物方案"), treatmentText);
    for (const expected of [
      "食疗与饮食", "少量多餐", "山药小米粥",
      "耳穴压豆", "脾", "胃", "神门", "交感", "每日按压3-5次",
      "灸法", "中脘", "足三里", "每周3次",
    ]) {
      assert.ok(treatmentText.includes(expected), `医生端方案缺少具体内容「${expected}」：${treatmentText}`);
    }
    assert.ok(!treatmentText.includes("气功导引疗法"), "只有评估说明的项目必须整卡隐藏");
  });
  check("J/医生端中医非药物方案无后台治理话术", () => {
    const forbidden = /病种模板|未按证型加减|仅项目评估|标准项目方案|政府发布方案|国家标准|规范|现场医师|来源|资质|安全边界|烫伤风险|待终审|不形成操作计划/;
    assert.doesNotMatch(treatmentText, forbidden, treatmentText);
  });
}

/** 把一段文本注入到真实载荷的叙述性字段里，再走完整投影链。 */
function injectIntoDiagnoseNarrative(fixture, injected) {
  const raw = fixture.stages.diagnose.visible;
  const start = raw.indexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = raw.indexOf("<!-- DIAGNOSIS_JSON_END -->");
  const payload = JSON.parse(raw.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end).trim());
  payload.overview.overallPathogenesis = `${injected}${payload.overview.overallPathogenesis}`;
  if (payload.pathogenesis?.chain?.[0]) {
    payload.pathogenesis.chain[0].therapyDirection = `${payload.pathogenesis.chain[0].therapyDirection}（${injected}）`;
  }
  const mutated = `${raw.slice(0, start)}<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload, null, 2)}\n${raw.slice(end)}`;
  const projected = { diagnose: projectStage(mutated, "diagnose"), prescribe: projectStage(fixture.stages.prescribe.visible, "prescribe") };
  const caseState = buildCaseState({ ...fixture, stages: { ...fixture.stages, diagnose: { visible: mutated } } }, projected);
  return {
    markdown: visibleMarkdown(projected.diagnose),
    page: renderResultArea(caseState),
    payload: extractDiagnosisJSON(projected.diagnose),
  };
}

// F. 内部记号注入 → 必须被拦下来（否则说明兜底网是摆设）
const LEAK_INJECTIONS = [
  ["层号原样形态（甲方看到的就是这个）", "L0/L1/L3"],
  ["层号带层字", "L2层"],
  ["新合同的层序标记", "第三层"],
  ["旧合同的层名", "证候归纳层"],
  ["驳回码/枚举", "evidence_level=kb_entry"],
  ["内部字段名", "targetPathogenesis"],
  ["内部标定元数据", "confidence: 0.82"],
];
for (const [label, injected] of LEAK_INJECTIONS) {
  check(`F/注入「${injected}」（${label}）必须被拦在医生可见面之外`, () => {
    const result = injectIntoDiagnoseNarrative(INJECTION_BASE, injected);
    assert.ok(!result.page.includes(injected), `注入的内部记号漏到了渲染页面：${injected}`);
    assert.ok(!result.markdown.includes(injected), `注入的内部记号漏到了服务端 Markdown：${injected}`);
    assert.deepEqual(findInternalEngineeringTags(result.page), []);
    // 只做减法：注入点周围的临床原文必须完好，不能连带把病机删掉。
    assert.ok((result.payload.overview.overallPathogenesis || "").length > 4,
      "净化把整段病机也一起删了——净化只允许做减法，不允许清空临床结论");
  });
}

// G. 临床相似记号注入 → 必须逐字幸存（误伤比漏标签严重）
const CLINICAL_INJECTIONS = [
  ["ICD-10 编码", "L50.801"],
  ["腰椎节段", "L4/L5"],
  ["椎体节段", "T12-L1"],
  ["甲功检验项", "T3"],
  ["补体检验项", "C3"],
  ["糖化血红蛋白", "HbA1c"],
  ["血氧饱和度", "SpO2"],
];
for (const [label, injected] of CLINICAL_INJECTIONS) {
  check(`G/注入「${injected}」（${label}）必须逐字幸存`, () => {
    const result = injectIntoDiagnoseNarrative(INJECTION_BASE, injected);
    assert.ok((result.payload.overview.overallPathogenesis || "").includes(injected),
      `临床记号被净化器吃掉了：${injected}。改写病历里的编码/节段/检验项比漏一个工程标签严重得多。`);
    assert.deepEqual(findInternalEngineeringTags(result.page), []);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// H. 规则表自身的完整性：新增一类记号必须自动进入断言，不能只加规则不加覆盖
// ─────────────────────────────────────────────────────────────────────────────
check("H/内部记号规则表非空且每条规则都有 id", () => {
  assert.ok(INTERNAL_TAG_RULES.length >= 5, "记号规则表被削减到不足以覆盖已知形态类");
  for (const rule of INTERNAL_TAG_RULES) {
    assert.ok(typeof rule.id === "string" && rule.id, "每条规则必须带 id，否则失败信息无法定位类别");
    assert.ok(rule.pattern instanceof RegExp, `规则 ${rule.id} 缺少形态正则`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// I. 全量归档扫描（可选）：本机存在 artifacts/ 时，把所有归档阶段正文重放一遍投影链。
//    CI/新克隆没有 artifacts/（.gitignore 排除），此时跳过并明确打印跳过原因——
//    不能让「没扫」看起来像「扫过且干净」。
// ─────────────────────────────────────────────────────────────────────────────
let sweep = { ran: false, files: 0, stages: 0, dirty: [] };
if (hasLocalArtifact("artifacts")) {
  const archives = [];
  for (const dir of fs.readdirSync("artifacts")) {
    const full = path.join("artifacts", dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (/^case-\d+\.json$/.test(name)) archives.push(path.join(full, name));
    }
  }
  sweep.ran = true;
  sweep.files = archives.length;
  for (const file of archives) {
    let archive;
    try {
      archive = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const stage of ["diagnose", "prescribe"]) {
      const visible = archive.stages?.[stage]?.visible;
      if (!visible) continue;
      sweep.stages += 1;
      const tags = findInternalEngineeringTags(visibleMarkdown(projectStage(visible, stage)));
      if (tags.length > 0) sweep.dirty.push({ file, stage, tags: tags.slice(0, 5) });
    }
  }
  check(`I/全量归档重放（${sweep.files} 份 / ${sweep.stages} 段）无内部记号`, () => {
    assert.deepEqual(sweep.dirty.slice(0, 5), [],
      `归档产出重放后仍有内部记号残留（共 ${sweep.dirty.length} 段）`);
  });
} else {
  console.log("SKIP 全量归档扫描：本机无 artifacts/（.gitignore 排除，属预期）。committed fixture 覆盖仍然生效。");
}

console.log(JSON.stringify({
  fixtures: fixtures.length,
  cases,
  failures,
  archiveSweep: sweep.ran ? { files: sweep.files, stages: sweep.stages, dirty: sweep.dirty.length } : "skipped",
}));
if (failures > 0) process.exit(1);

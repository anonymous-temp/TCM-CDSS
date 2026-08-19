// 对外接口文档与真实出参的字段一致性。
//
// 立这道闸的直接原因：上一版文档把中成药候选写成顶层 `patentMedicines`，**实现中无此路径**，
// 甲方照文档取值必然取到空，而文档里没有任何东西会因此变红。同一类错这轮又犯了两次——
// 随证加减写成 `formula.candidates[].modifications[]`（实际在 `formula.modifications[]`）、
// M05 一节凭空写了 `riskAssessment` / `followupTimeline` 两个根本不存在的字段。
// 三次都是「写完没实取」，靠人肉核对拦不住。
//
// 判据：文档里出现的每一条**字段路径**，都必须能在真实归档出参里取到值，
// 或被显式登记为可选（那些字段只在特定条件下出现，取不到属正常）。
// 反向也查一遍：真实出参里的顶层内容若文档完全没提，说明文档漏了能力。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DOC = "docs/中医CDSS-对外接口文档.md";
const M03 = "scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m03.json";
const M04 = "scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m04.json";

const doc = readFileSync(DOC, "utf8");
const m03 = JSON.parse(readFileSync(M03, "utf8"));
const m04 = JSON.parse(readFileSync(M04, "utf8"));

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

/** 按文档路径取值：`a.b[].c` 视为取第 0 个元素再往下。 */
function valueAt(root, path) {
  let node = root;
  for (const raw of path.split(".")) {
    if (node === undefined || node === null) return undefined;
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    node = node[key];
    if (isArray) {
      if (!Array.isArray(node)) return undefined;
      node = node[0];
    }
  }
  return node;
}

// 只在特定条件下出现的字段：取不到属正常，但必须在文档里写明触发条件，否则集成方会当成故障。
// 每一条都要求文档正文里带「可选」二字并说明触发条件——不写清楚等于埋坑。
const CONDITIONAL = new Map([
  ["westernDiagnosis.primary.coding", "仅当匹配到受控医保 ICD-10 码时输出"],
  ["terminologyMappings[]", "仅当发生国标术语归一时输出，单次最多 20 条"],
  ["lineageAdaptation", "仅当请求指定流派偏好时输出"],
  ["formula.modifications[].substitutions[]", "仅出现在「加某味药」类加减上，且需推得出合规替代药"],
  ["formula.modifications[].substitutions", "同上（不带 [] 的引用形式）"],
  ["formula.candidates[].herbs[].decoctionRequirement", "仅特殊煎法药味有值，其余为 null"],
  ["formula.medicineCandidateStatus", "仅当无匹配中成药候选时输出"],
  ["nonPharma.acupointCare", "可为 null"],
  ["formula.candidates[].herbs[].processing", "无特殊炮制要求时为 null"],
  ["formula.patentAndWestern[].singleDose", "西药一律不下发；中成药仅说明书给全时填写"],
  ["formula.patentAndWestern[].frequency", "同 singleDose"],
  ["formula.patentAndWestern[].route", "同 singleDose"],
  ["formula.patentAndWestern[].administrationTiming", "仅当说明书原文载明服药时机时输出"],
  ["formula.modifications[].doseOrHandling", "恒为 null，加减不下发剂量"],
  ["pathogenesis.uncertainties[]", "无待复核项时为空数组"],
  ["overview.secondarySyndromes", "无兼证时为空数组"],
  // 2026-08-10 ⑩：指南/文献依据由服务端按 evidenceId 反查**本轮真检索到**的条目渲染，
  // 本轮 EviMed 未命中就整条不输出——这正是"宁可少一栏，也不让一条编造的指南名出现"的行为。
  ["westernDiagnosis.primary.guidelineReferences[]", "仅当本轮 EviMed 指南/文献检索命中、且模型引用了其条目号时输出"],
  ["westernDiagnosis.differentials[].guidelineReferences[]", "仅当本轮受治理证据命中并绑定到对应鉴别诊断时输出"],
  ["overview.tcmDiseaseReferences[]", "仅在形成中医病名时由服务端绑定受治理辨病标准"],
  ["overview.tcmSyndromeReferences[]", "仅在形成中医证候时由服务端绑定受治理辨证标准"],
  // 2026-08-10 ⑪：protocolGapNote 只在 protocolGap 命中受控映射时下发（HIS 方案出参，
  // 非 M04 原始响应字段；此处登记是为了让文档路径校验通过）。
  ["nonPharma.tcmTreatments[].protocolGapNote", "仅 HIS 方案出参；且仅当 protocolGap 命中受控映射时输出"],
]);

/** 文档里以反引号包裹、看起来像出参字段路径的 token。 */
function documentedPaths() {
  const roots = /^(overview|westernDiagnosis|pathogenesis|therapy|formula|nonPharma|lineageAdaptation|terminologyMappings|management)\b/;
  const found = new Set();
  for (const match of doc.matchAll(/`([A-Za-z][A-Za-z0-9_.[\]]*)`/g)) {
    const token = match[1];
    if (!roots.test(token)) continue;
    if (!token.includes(".") && !token.endsWith("[]")) continue; // 光秃秃的根对象名不算路径
    found.add(token);
  }
  return [...found].sort();
}

check("DOC-01 文档里的每条字段路径都能在真实出参里取到（或已登记为可选）", () => {
  const missing = [];
  for (const path of documentedPaths()) {
    if (CONDITIONAL.has(path)) continue;
    if (valueAt(m04, path) !== undefined) continue;
    if (valueAt(m03, path) !== undefined) continue;
    missing.push(path);
  }
  assert.deepEqual(
    missing,
    [],
    `以下路径写进了文档，但真实 M03/M04 出参里取不到——集成方照此取值会取到 undefined：\n  ${missing.join("\n  ")}`,
  );
});

check("DOC-02 每个「可选」字段必须在文档里写明触发条件", () => {
  const undocumented = [];
  for (const [path] of CONDITIONAL) {
    // 路径本身要出现在文档里，且同一行（或紧邻行）要出现「可选」「仅」「为 null」之一。
    const leaf = path.replace(/\[\]$/, "").split(".").pop();
    const lines = doc.split("\n").filter((line) => line.includes(`\`${path}\``) || line.includes(`\`${leaf}\``));
    if (lines.length === 0) continue; // 文档没提这个字段，不属于本条约束
    // 类型列写了 `/ null` 或说明里写了「空数组」，同样属于已告知集成方「可能取不到」。
    if (!lines.some((line) => /可选|仅当|仅在|仅出现|恒为|null|空数组/.test(line))) undocumented.push(path);
  }
  assert.deepEqual(
    undocumented,
    [],
    `以下字段只在特定条件下出现，文档却没写触发条件，集成方取不到时会当成故障：\n  ${undocumented.join("\n  ")}`,
  );
});

check("DOC-03 真实出参里的一级能力，文档不得漏登记", () => {
  const missing = [];
  for (const [payload, label] of [[m03, "M03"], [m04, "M04"]]) {
    for (const key of Object.keys(payload)) {
      if (["schemaVersion", "stage", "clinicalReview", "completeness", "contractSignature", "contractSignatureVersion", "retrieval", "medicineCandidateStatus"].includes(key)) continue;
      if (!doc.includes(`\`${key}`)) missing.push(`${label}.${key}`);
    }
  }
  assert.deepEqual(missing, [], `真实出参里有这些顶层内容，文档整篇没提：\n  ${missing.join("\n  ")}`);
});

check("DOC-04 字段表必须带中文名列（甲方反馈：字段名太长且无中文说明）", () => {
  // 出参字段表统一为「字段 | 中文名 | 类型 | 说明」或「字段 | 中文名 | 类型」。
  const headers = [...doc.matchAll(/^\| 字段 \|([^\n]*)$/gm)].map((m) => m[1]);
  assert.ok(headers.length >= 8, `只找到 ${headers.length} 张字段表，文档结构疑似被改动`);
  const withoutChinese = headers.filter((h) => !h.includes("中文名"));
  assert.deepEqual(
    withoutChinese.map((h) => `| 字段 |${h}`),
    [],
    "以下字段表缺少「中文名」列",
  );
});

check("DOC-05 长路径不得再逐行重复（甲方反馈：字段名太长）", () => {
  // 字段表内的路径深度超过 2 段即为「没有按对象分组」，例如
  // `formula.candidates[].herbs[].name` 应写成组标题 `formula.candidates[].herbs[]` + 字段 `name`。
  const offenders = [];
  for (const line of doc.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const token = line.match(/^\| `([^`]+)`/)?.[1];
    if (!token) continue;
    const depth = token.split(".").length;
    if (depth >= 4) offenders.push(token);
  }
  assert.deepEqual(offenders, [], `以下字段表行仍在逐行重复长路径，应按对象分组：\n  ${offenders.join("\n  ")}`);
});

check("DOC-06 完整链路示例里的 JSON 必须可解析且非占位", () => {
  const section = doc.slice(doc.indexOf("### 6.1 完整链路"), doc.indexOf("### 6.2"));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, `完整链路示例里只有 ${blocks.length} 段 JSON，M03 与 M04 响应示例应各有一段`);
  for (const [index, block] of blocks.entries()) {
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(block); }, `第 ${index + 1} 段响应示例不是合法 JSON`);
    assert.ok(Object.keys(parsed).length >= 4, `第 ${index + 1} 段响应示例字段过少，不足以说明结构`);
  }
});

if (failures.length > 0) {
  console.error("接口文档字段一致性 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ suite: "api-doc-field-parity", documentedPaths: documentedPaths().length, failures: 0 }));

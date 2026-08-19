// 指南/文献依据的出处必须在**每个出口**都到得了（2026-08-11 甲方线上实测：「指南引用要能点开看原文」）。
//
// 这条依据本来就带 url——resolveGovernedGuidelineReferences 从本轮真检索到的条目字段回填，
// 模型只能写一句 appliesTo。服务端 Markdown 一直在印这个 url；医生页面在拼展示串时写的是
// `${citation}（${appliesTo}）`，没有第三段，于是同一份载荷，一个出口有出处、另一个没有。
//
// 判据落在**共享投影**上而不是各出口的字符串拼接上：只要两侧都从 guidelineReferenceDisplay 取，
// 「一个出口有、另一个没有」在结构上就不可能再发生。另外钉住两条安全边界：
// 不得把非 https 的地址做成可点链接；没有 url 时绝不编一个出来。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { guidelineReferenceDisplay, westernDiagnosticEvidenceGroups } =
  await import("../src/lib/clinical-fact-source.ts");
const { localDiagnosticReferenceContext } =
  await import("../src/lib/diagnostic-reference-catalog.ts");
const { buildEvidenceOutputTransform } =
  await import("../src/lib/cdss-evidence-context.ts");

const failures = [];
const check = (name, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
};

const REFERENCE = {
  citation: "中国急性上呼吸道感染基层诊疗指南（2023 年版）",
  appliesTo: "急性上呼吸道感染的抗菌药物使用指征",
  url: "https://rs.yiigle.com/example-guideline",
};

check("带 url 的条目：文字与地址分开给出，地址原样保留", () => {
  const display = guidelineReferenceDisplay(REFERENCE);
  assert.equal(display.text, REFERENCE.citation);
  assert.equal(display.href, REFERENCE.url, "url 必须原样透传，不得改写或截断");
});

check("没有 url 时不编造，也不留空串字段", () => {
  const display = guidelineReferenceDisplay({ citation: REFERENCE.citation });
  assert.equal(display.text, REFERENCE.citation);
  assert.ok(!("href" in display), "无出处时不得出现 href 字段");
});

check("只有 https 绝对地址才做成可点链接", () => {
  for (const url of ["http://example.test/g", "/local/path", "javascript:alert(1)", "ftp://x/y"]) {
    const display = guidelineReferenceDisplay({ citation: "某指南", url });
    assert.ok(!("href" in display), `${url} 不应被做成可点链接`);
  }
});

check("分组投影原样携带 href（页面据此渲染 <a>）", () => {
  const groups = westernDiagnosticEvidenceGroups(
    { symptom: ["咽痛"], sign: [], exam: [], excluding: [] },
    [guidelineReferenceDisplay(REFERENCE)],
  );
  const guideline = groups.find((group) => group.label === "指南/文献依据");
  assert.ok(guideline, "指南/文献依据分组缺失");
  assert.equal(guideline.items[0].href, REFERENCE.url, "分组投影把 href 丢了");
  const symptom = groups.find((group) => group.label === "症状依据");
  assert.deepEqual(symptom.items, [{ text: "咽痛" }], "普通依据项不应凭空多出 href");
});

// ── 两个出口都必须走共享投影 ────────────────────────────────────────────
// 这条判据看的是**源码**：出口自己拼 `${citation}（${appliesTo}）` 就是分叉的起点，
// 而分叉后各自的输出仍然「看起来都对」，只是少了一段——正是这次线上实测的现象。
check("两个出口都不再自拼指南展示串", () => {
  const outlets = [
    "src/lib/diagnosis-visible-summary.ts",
    "src/app/diagnosis/DiagnosisClient.tsx",
  ];
  for (const outlet of outlets) {
    const source = readFileSync(fileURLToPath(new URL(`../${outlet}`, import.meta.url)), "utf8");
    assert.ok(
      source.includes("guidelineReferenceDisplay"),
      `${outlet} 没有使用共享投影 guidelineReferenceDisplay`,
    );
    assert.ok(
      !/\$\{(?:entry|item|reference)\.citation\}/.test(source),
      `${outlet} 仍在自拼指南展示串——出处会在这一侧被丢掉`,
    );
  }
});

check("症状性诊断长尾只注入真实且问题匹配的本地权威依据", () => {
  const cases = [
    ["双下肢紧缩麻木十天", "EVID-GUIDE-901", "aan.com"],
    ["产后乳汁量少四日", "EVID-GUIDE-902", "acog.org"],
    ["带下过少并阴道干涩", "EVID-GUIDE-903", "acog.org"],
    ["呃逆一年余，逆气上冲，气冲有声", "EVID-PAPER-904", "pubmed.ncbi.nlm.nih.gov"],
    ["面部扁平丘疹反复发作一年", "EVID-PAPER-905", "pubmed.ncbi.nlm.nih.gov"],
    ["癫痫反复发作并伴仆倒抽搐", "EVID-GUIDE-906", "nice.org.uk"],
    ["受凉后尿痛尿频一周", "EVID-GUIDE-907", "uroweb.org"],
    ["持续多汗半年", "EVID-GUIDE-908", "jstage.jst.go.jp"],
    ["外院检查为慢性盆腔炎", "EVID-GUIDE-909", "cdc.gov"],
    ["四肢大小关节红肿热痛并晨僵", "EVID-PAPER-910", "pubmed.ncbi.nlm.nih.gov"],
    ["白带色白清稀，量多半年", "EVID-GUIDE-911", "cdc.gov"],
    ["嘴唇红肿热痛伴脱屑", "EVID-PAPER-912", "pubmed.ncbi.nlm.nih.gov"],
    ["手足耳垂红肿痒痛，初冬必发", "EVID-GUIDE-913", "dermnetnz.org"],
    ["背部发热四年", "EVID-PAPER-914", "pubmed.ncbi.nlm.nih.gov"],
    ["两侧下眼睑红肿疼痛", "EVID-GUIDE-915", "eyewiki.aao.org"],
    ["发现肝功异常三个月", "EVID-GUIDE-916", "pubmed.ncbi.nlm.nih.gov"],
    ["咳嗽气短二十天", "EVID-GUIDE-917", "pubmed.ncbi.nlm.nih.gov"],
    ["全身红斑鳞屑反复发作", "EVID-GUIDE-918", "nice.org.uk"],
    ["发现甲状腺结节，TI-RADS3类", "EVID-GUIDE-919", "pubmed.ncbi.nlm.nih.gov"],
    ["胃胀一年多，晨起欲呕", "EVID-GUIDE-920", "pubmed.ncbi.nlm.nih.gov"],
    ["颈部红肿，上有小水疱并瘙痒", "EVID-GUIDE-921", "dermnetnz.org"],
    ["便中带血半年", "EVID-GUIDE-922", "cmab.yiigle.com"],
    ["求嗣两年未孕", "EVID-GUIDE-923", "who.int"],
    ["反酸烧心餐后加重一年", "EVID-GUIDE-924", "pubmed.ncbi.nlm.nih.gov"],
  ];
  for (const [clinicalText, evidenceId, host] of cases) {
    const context = localDiagnosticReferenceContext(clinicalText);
    assert.match(context, new RegExp(`\\[${evidenceId}\\]`), `${clinicalText} 缺少受治理依据 ${evidenceId}`);
    assert.match(context, new RegExp(`https://[^\\s]*${host.replaceAll(".", "\\.")}/`), `${evidenceId} 缺少真实可点击出处`);
    const caseState = { patient: {}, chiefComplaint: clinicalText, symptoms: {}, conversation: [] };
    const diagnosisName = ({
      "EVID-GUIDE-901": "下肢感觉异常",
      "EVID-GUIDE-902": "产后乳汁分泌不足",
      "EVID-GUIDE-903": "阴道干涩",
      "EVID-PAPER-904": "呃逆",
      "EVID-PAPER-905": "面部丘疹",
      "EVID-GUIDE-906": "癫痫",
      "EVID-GUIDE-907": "尿路感染",
      "EVID-GUIDE-908": "多汗症",
      "EVID-GUIDE-909": "慢性盆腔炎",
      "EVID-PAPER-910": "多关节疼痛",
      "EVID-GUIDE-911": "白带异常",
      "EVID-PAPER-912": "唇炎",
      "EVID-GUIDE-913": "冻疮",
      "EVID-PAPER-914": "背部感觉异常",
      "EVID-GUIDE-915": "眼睑炎症",
      "EVID-GUIDE-916": "慢性肝损伤",
      "EVID-GUIDE-917": "咳嗽伴气短",
      "EVID-GUIDE-918": "银屑病",
      "EVID-GUIDE-919": "甲状腺结节",
      "EVID-GUIDE-920": "功能性消化不良",
      "EVID-GUIDE-921": "急性皮炎",
      "EVID-GUIDE-922": "便血",
      "EVID-GUIDE-923": "不孕症",
      "EVID-GUIDE-924": "反酸",
    })[evidenceId];
    const payload = {
      schemaVersion: "tcm-cdss-reasoning-v2",
      stage: "diagnose",
      westernDiagnosis: { primary: { name: diagnosisName } },
      overview: { primarySyndrome: "待辨" },
    };
    const transformed = buildEvidenceOutputTransform(context, undefined, caseState)(
      `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(payload)}\n<!-- DIAGNOSIS_JSON_END -->`,
    );
    const parsed = JSON.parse(transformed.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.equal(parsed.westernDiagnosis.primary.guidelineReferences?.[0]?.evidenceId, evidenceId, `${evidenceId} 未进入最终诊断引用`);
  }
  assert.equal(localDiagnosticReferenceContext("普通感冒伴流清涕"), "", "无匹配问题不得注入通用文献凑数");
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "guideline-reference-outlets", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "guideline-reference-outlets", checks: 6, failures: 0 }));

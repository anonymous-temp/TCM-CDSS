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
  assert.equal(display.text, `${REFERENCE.citation}（${REFERENCE.appliesTo}）`);
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

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "guideline-reference-outlets", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "guideline-reference-outlets", checks: 5, failures: 0 }));

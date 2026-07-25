// T12 穴位证据层完整性与治理测试。
// ① 目录完整性:399 穴(361 国标经穴 + 印堂 DU29 + 37 经外奇穴)、代码唯一、十五经脉覆盖、
//   必填字段非空、临床字段零私用区字符(E81F→㖞 已在构建期修复)。
// ② 模板治理(fail-closed):针刺/艾灸/敷贴/耳穴类项目的 sitesOrPoints 每一值必须
//   a) 经 normalizeAcupointSiteName 归一后命中穴位目录,或
//   b) 落在显式钉住的例外集(耳穴区/部位区/自由文本占位)——新增模板值两者皆否即红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../src/data/tcm-acupoint-evidence-catalog.json", import.meta.url)));
const { TCM_ACUPOINTS, TCM_ACUPOINT_MERIDIAN_COVERAGE, resolveAcupoint, normalizeAcupointSiteName } =
  await import("../src/lib/tcm-acupoints.ts");
const { TCM_TREATMENT_PROJECTS } = await import("../src/lib/tcm-treatment-projects.ts");

// ① 完整性
assert.equal(catalog.schemaVersion, "tcm-acupoint-evidence-v1");
assert.equal(TCM_ACUPOINTS.length, 400, "穴位总数 400(教材 399 + 治理补充 安眠)");
assert.equal(new Set(TCM_ACUPOINTS.map((e) => e.code)).size, 400, "代码唯一");
assert.equal(new Set(TCM_ACUPOINTS.map((e) => e.name)).size, 400, "穴名唯一");
assert.equal(TCM_ACUPOINT_MERIDIAN_COVERAGE.length, 15, "十五经脉覆盖");
const EXPECTED = [];
for (const [p, n] of [["LU", 11], ["LI", 20], ["ST", 45], ["SP", 21], ["HT", 9], ["SI", 19], ["BL", 67], ["KI", 27], ["PC", 9], ["TE", 23], ["GB", 44], ["LR", 14], ["DU", 29], ["RN", 24]]) {
  for (let i = 1; i <= n; i += 1) EXPECTED.push(`${p}${i}`);
}
const codes = new Set(TCM_ACUPOINTS.map((e) => e.code));
const missing = EXPECTED.filter((c) => !codes.has(c));
assert.deepEqual(missing, [], `国标经穴缺失: ${missing.join(",")}`);
const PUA = /[\uE000-\uF8FF]/;
for (const e of TCM_ACUPOINTS) {
  assert.ok(e.name && e.code && e.meridian && e.location && e.indications.length > 0, `必填字段完整: ${e.code}`);
  for (const field of [e.name, e.location, e.operation || "", ...e.indications]) {
    assert.ok(!PUA.test(field), `临床字段不得含私用区字符: ${e.code} ${field.slice(0, 20)}`);
  }
  assert.ok(["SRC-TEXTBOOK-JINGLUO-SHUXUE", "SRC-ACUPOINT-CURATED-SUPPLEMENT"].includes(e.sourceRef), "出处锚定");
}

// ② 模板治理
const POINTED_PROJECTS = new Set(["acupuncture", "moxibustion", "acupoint_application", "auricular"]);
// 例外集逐项钉死:耳穴区(非体穴)/部位区描述/自由文本占位。任何一项被误删、或新增未归类的
// 模板穴位值,都会让测试变红——这就是「新增模板必须过穴位目录或人工登记」的门禁。
const AURICULAR_ZONES = new Set(["交感", "内分泌", "平喘", "心", "肺", "胃", "脾", "大肠", "枕", "皮质下"]);
const REGION_TERMS = new Set(["膀胱经大杼至肾俞区域", "局部阿是穴", "循经远端穴", "额"]);
const FREE_TEXT_PLACEHOLDERS = new Set(["按针刺方案中与当前证型匹配的穴位", "证型配穴由医师复核"]);
let checked = 0, resolved = 0, excepted = 0;
for (const project of TCM_TREATMENT_PROJECTS) {
  if (!POINTED_PROJECTS.has(project.code)) continue;
  for (const template of project.planTemplates) {
    for (const site of template.sitesOrPoints) {
      checked += 1;
      const normalized = normalizeAcupointSiteName(site);
      if (resolveAcupoint(site)) { resolved += 1; continue; }
      if (AURICULAR_ZONES.has(normalized) || REGION_TERMS.has(normalized) || FREE_TEXT_PLACEHOLDERS.has(String(site).trim())) {
        excepted += 1;
        continue;
      }
      assert.fail(`模板穴位值既不在穴位目录也不在例外集: ${project.code} / ${template.id} / "${site}"(归一后 "${normalized}")`);
    }
  }
}
assert.ok(checked > 0 && resolved > 0, "确实检查了模板穴位值");

// 归一函数行为钉样:双侧前缀、括注、或选、空白
assert.equal(normalizeAcupointSiteName("双侧天枢"), "天枢");
assert.equal(normalizeAcupointSiteName("关元（须结合寒热虚实复核）"), "关元");
assert.equal(normalizeAcupointSiteName("肺俞或膻中（按证型二选一）"), "肺俞");
assert.ok(resolveAcupoint("双侧天枢")?.code === "ST25");
assert.ok(resolveAcupoint("安眠")?.code === "EX-HN22", "治理补充条安眠在目录");

console.log(JSON.stringify({ acupoints: TCM_ACUPOINTS.length, templateSitesChecked: checked, resolvedToCatalog: resolved, pinnedExceptions: excepted }));

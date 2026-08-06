// HIS 分节标题咬合（2026-08-06，甲方 8-05 核对件多条「无此模块」的共同根因）。
//
// 缺陷形态：医生可见正文的分节标题由**受治理输出契约登记表**
// （src/data/clinical-output-contract-registry.json → clinicalOutputLabel）驱动，
// 而 HIS 对外投影（his-scheme.ts）用另一份手工词表 SECTION_TITLES 去**整行精确匹配**抓取。
// 两份表各自演进，一次「模块改名」（8ef5606b）就让 6 个分组全部失配：
//   ## 西医诊断倾向 / ## 中医诊断概览 / ## 病机拆解 / ## 治则治法 / ## 中成药‑西药候选
// 在 SECTION_TITLES 里一个都没有 ⇒ HIS「AI 诊疗支持方案」的诊断三卡与中成药卡**内容恒为空串**。
//
// 为什么此前没被发现：
//  · scripts/test-authoritative-his.mjs 的 fixture 是手写的 "## 西医诊断\n…"，用的是流水线
//    早已不再产出的旧标题，测的是一份现实中不存在的输入；
//  · scripts/regress-tcm-cdss.mjs 只断言 western item 的 referenceOnly/adoptable 两个布尔，
//    从不断言 content 非空——卡片空着也照样绿。
//  · 更反直觉的是 diagnosis-safety.ts 的**降级路径**仍在产出旧标题，所以匹配是成立的：
//    只有报废输出能进 HIS，正常输出反而进不去。
//
// 本套件钉的就是这条咬合关系本身，而不是某一个标题字符串：
// 只要登记表里新增/改名一个 HIS 要消费的可见模块，而 SECTION_TITLES 没同步，这里立刻红。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { sectionTitleGroup, SECTION_TITLES } = await jiti.import("../src/lib/cdss-vocab.ts");
const { clinicalOutputLabel } = await jiti.import("../src/lib/clinical-output-authority.ts");
// 真实判据，不是同源重建——重建副本会在实现改动时静默失效。
const { section } = await jiti.import("../src/lib/his-scheme.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

/**
 * 受治理登记表 id → 消费它的 SECTION_TITLES 分组。
 *
 * 这张表是**契约**：HIS 投影层每一个 section(...) 调用都应在此登记。
 * fallback 只是登记表缺条目时的兜底，与 diagnosis-visible-summary.ts 的调用保持一致。
 */
const COUPLINGS = [
  { id: "M03-western", fallback: "西医诊断倾向", group: "westernDiagnosis", card: "diagnoses.western" },
  { id: "M03-overview", fallback: "中医诊断概览", group: "tcmPattern", card: "diagnoses.tcmPatterns" },
  { id: "M03-pathogenesis", fallback: "病机拆解", group: "mechanismOverall", card: "diagnoses.mechanism（总体病机段）" },
  { id: "M03-therapy", fallback: "治则治法", group: "therapyFrame", card: "diagnoses.mechanism（治法段）" },
  { id: "M04-patent-western", fallback: "中成药/西药候选", group: "westernOrPatent", card: "prescriptions.westernOrPatent" },
];

for (const { id, fallback, group, card } of COUPLINGS) {
  check(`可见标题「${id}」必须能被 SECTION_TITLES.${group} 抓到`, () => {
    const label = clinicalOutputLabel(id, fallback);
    const body = `## ${label}\n**主要诊断**：示例内容一行\n`;
    const extracted = section(body, sectionTitleGroup(group));
    assert.ok(
      extracted.includes("示例内容一行"),
      `标题「## ${label}」未被 SECTION_TITLES.${group} = ${JSON.stringify(sectionTitleGroup(group))} 匹配，` +
      `HIS ${card} 将恒为空串。新增/改名可见模块时必须同步登记本词表。`,
    );
  });
}

// 降级路径的旧标题必须继续可抓：diagnosis-safety.ts 仍在产出它们，
// 删除旧别名会把降级页在 HIS 里一并弄空——修一处不能坏另一处。
const DEGRADED = [
  { title: "西医诊断", group: "westernDiagnosis" },
  { title: "中医证候诊断", group: "tcmPattern" },
  { title: "总体病机", group: "mechanismOverall" },
  { title: "治法框架", group: "therapyFrame" },
  { title: "西药/中成药方案", group: "westernOrPatent" },
  { title: "处方安全总评", group: "riskSummary" },
  { title: "随访管理方案", group: "followupPlan" },
  { title: "随访时间轴", group: "followupTimeline" },
];
for (const { title, group } of DEGRADED) {
  check(`降级路径旧标题「${title}」必须保留在 SECTION_TITLES.${group}`, () => {
    const extracted = section(`## ${title}\n降级正文一行\n`, sectionTitleGroup(group));
    assert.ok(extracted.includes("降级正文一行"), `旧标题「${title}」已从 ${group} 丢失，降级输出将无法进入 HIS。`);
  });
}

// 「病机拆解」不得同时登记在 mechanismOverall 与 mechanismSub：
// his-scheme 的 mechanism 卡是三段拼接，两处都登记会把同一段抓两遍，
// 医生看到的是逐字重复的病机——甲方 8-04 已就「逐味重印」类重复提过一次。
check("病机拆解不得在 mechanismOverall 与 mechanismSub 中重复登记", () => {
  const overall = sectionTitleGroup("mechanismOverall");
  const sub = sectionTitleGroup("mechanismSub");
  const both = overall.filter((title) => sub.includes(title));
  assert.equal(both.length, 0, `标题 ${JSON.stringify(both)} 同时出现在两组，会导致 mechanism 卡重复抓取同一段。`);
});

// 每个分组至少要有一个别名，且不得有空串——空串会让正则退化成匹配任意 "## " 行。
check("SECTION_TITLES 不得含空别名", () => {
  for (const [key, titles] of Object.entries(SECTION_TITLES)) {
    assert.ok(titles.length > 0, `${key} 分组为空`);
    for (const title of titles) {
      assert.ok(typeof title === "string" && title.trim() === title && title.length > 0,
        `${key} 含非法别名 ${JSON.stringify(title)}`);
    }
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "his-section-coupling", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  suite: "his-section-coupling",
  couplingsPinned: COUPLINGS.length,
  degradedTitlesPinned: DEGRADED.length,
  failures: 0,
}));

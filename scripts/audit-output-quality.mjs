// 产出质量审计器(常备工序): 每轮批量回归后对产物目录跑一遍,按历史问题类逐项核验。
// 用法: npm run audit:output-quality -- artifacts/<dir> [dir2 ...]
// 这些检查是"坏东西不得出现"的负向不变量——单元钉只保证好东西出现过,
// 呈现层的空位/重复/泄漏/极性违规只有对真实产出做全量负向扫描才能拦住(2026-08-03 复盘机制)。
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const kb = await jiti.import("../src/lib/tcm-knowledge.ts");

const findings = [];
const note = (caseId, cls, detail) => findings.push({ caseId, cls, detail: String(detail).slice(0, 220) });

function herbRowsFromVisible(visible) {
  // 提取药味表行: | 序号? | 药名 | 剂量 ... 或 | 药名 | 剂量 |
  const rows = [];
  for (const line of (visible || "").split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    let name, dose;
    if (/^\d+$/.test(cells[0]) && cells.length >= 3) { name = cells[1]; dose = cells[2]; }
    else if (/^\d+(?:\.\d+)?\s*g/.test(cells[1] || "")) { name = cells[0]; dose = cells[1]; }
    else continue;
    if (!name || /药名|序号|---/.test(name)) continue;
    const doseMatch = (dose || "").match(/^(\d+(?:\.\d+)?)\s*g$/);
    rows.push({ name: name.replace(/[（(].*$/, "").trim(), doseG: doseMatch ? Number(doseMatch[1]) : null, rawDose: dose });
  }
  return rows;
}

function negatedTerms(text) {
  const out = new Set();
  for (const m of (text || "").matchAll(/(?:否认|无明显|不伴)([^，。；、\n]{1,14}(?:、[^，。；、\n]{1,14})*)/g)) {
    for (const t of m[1].split("、")) {
      const term = t.replace(/等.*$/, "").trim();
      if (term.length >= 2 && term.length <= 8) out.add(term);
    }
  }
  return [...out];
}

const QUOTE_OPEN = "“", QUOTE_CLOSE = "”";
function quoteImbalance(text) {
  const o = (text.match(/“/g) || []).length;
  const c = (text.match(/”/g) || []).length;
  return o !== c ? `${o}:${c}` : null;
}

const LEAK = /undefined|NaN|\[object |待生成|__server_realigned|CDSS_STREAM_FINAL|model_inference|"schemaVersion"|\[TRUNCATED\]/;
const BLANK_REGIMEN = /每日[　\s]+剂(?!数)|每日分[　\s]+次服|共[　\s]+剂/;

for (const dir of process.argv.slice(2)) {
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("case-")).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const caseId = `${path.basename(dir)}/${f.replace(".json", "")}(${d.tcmDisease || ""})`;
    const st = d.stages || {};
    const stripSentinel = (t) => (t || "").replace(/<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g, "");
    const dxVis = stripSentinel(st.diagnose?.visible);
    const rxVis = stripSentinel(st.prescribe?.visible);
    const asVis = stripSentinel(st.assess?.visible);
    const caseText = [d.chiefComplaint, d.presentHistory, d.tongue, d.pulse].filter(Boolean).join("。");

    // 1. 零味/空页: M04 200 但既无药味表、无参考页、也无非剂量说明
    if (st.prescribe?.status === 200) {
      const hasHerbTable = herbRowsFromVisible(rxVis).length > 0;
      const hasReference = /药典剂量区间/.test(rxVis);
      const hasNonDoseExplain = /未能形成可核验|不生成候选|本次分析结论|辨证信息|安全边界/.test(rxVis);
      if (!hasHerbTable && !hasReference && !hasNonDoseExplain) note(caseId, "EMPTY_RX", `M04 200 但无内容, len=${rxVis.length}`);
      if (rxVis.trim().length < 60) note(caseId, "EMPTY_RX", `M04 正文过短 len=${rxVis.trim().length}`);
    }
    // 2. 空白服法模板
    for (const [tag, vis] of [["dx", dxVis], ["rx", rxVis], ["as", asVis]]) {
      if (BLANK_REGIMEN.test(vis)) note(caseId, "BLANK_REGIMEN", `${tag}: ${vis.match(BLANK_REGIMEN)[0]}`);
      if (LEAK.test(vis)) note(caseId, "LEAK", `${tag}: ${vis.match(LEAK)[0]}`);
      const qi = quoteImbalance(vis);
      if (qi) note(caseId, "QUOTE_IMBALANCE", `${tag}: ${qi}`);
    }
    // 4. 极性: 病历否认词出现在病机链 patientFact/syndromeEvidence 作阳性
    const negs = negatedTerms(caseText);
    const chain = st.diagnose?.reasoning?.pathogenesis?.chain || [];
    for (const [i, node] of chain.entries()) {
      for (const field of ["patientFact", "syndromeEvidence"]) {
        const v = node?.[field] || "";
        for (const term of negs) {
          if (v.includes(term) && !/否认|无|未见|不伴/.test(v)) {
            note(caseId, "POLARITY", `chain[${i}].${field} 含被否认词「${term}」: ${v.slice(0, 60)}`);
          }
        }
      }
    }
    // 5. 剂量越界(药典区间) — 仅检查最终药味表
    const herbs = herbRowsFromVisible(rxVis);
    for (const h of herbs) {
      if (h.doseG == null) continue;
      const limit = kb.getTcmHerbDoseLimit(h.name);
      if (limit?.min != null && limit?.max != null && (h.doseG < limit.min * 0.5 || h.doseG > limit.max)) {
        note(caseId, "DOSE_RANGE", `${h.name} ${h.doseG}g 超出药典 ${limit.min}-${limit.max}g`);
      }
    }
    // 6. 十八反共存
    if (herbs.length >= 2) {
      const inc = kb.findTcmHerbPairIncompatibilities(herbs.map((h) => h.name));
      if (inc.length > 0) note(caseId, "INCOMPATIBLE_PAIR", inc.map((x) => `${x.leftDrug}-${x.rightDrug}`).join(","));
    }
    // 10. 模块完整性
    if (st.diagnose?.status === 200 && dxVis.length > 300) {
      if (!/西医诊断/.test(dxVis)) note(caseId, "MISSING_SECTION", "dx 缺西医诊断段");
      if (!/(证候|辨证)/.test(dxVis)) note(caseId, "MISSING_SECTION", "dx 缺证候段");
    }
    if (st.prescribe?.status === 200 && herbs.length > 0) {
      if (!/(健康调护|调护|注意事项|非药物)/.test(rxVis)) note(caseId, "MISSING_SECTION", "rx 缺调护/注意事项段");
      if (!/(煎|服法|剂)/.test(rxVis)) note(caseId, "MISSING_SECTION", "rx 缺煎服法");
    }
    // 11. 妊娠禁忌粗筛(妊娠病例出现常见妊娠禁忌药)
    if (/妊娠|孕\d|怀孕|停经.*恶心/.test(caseText)) {
      const forbidden = ["附子", "川乌", "草乌", "大黄", "芒硝", "桃仁", "红花", "三棱", "莪术", "水蛭", "麝香", "牛膝", "枳实", "半夏"];
      for (const h of herbs) {
        if (forbidden.some((fb) => h.name.includes(fb))) note(caseId, "PREGNANCY_HERB", `${h.name}(妊娠慎/禁用类,需人工复核该案警示是否到位)`);
      }
    }
  }
}

const byCls = {};
for (const f of findings) (byCls[f.cls] ||= []).push(f);
console.log("=== 审计汇总 ===");
for (const [cls, list] of Object.entries(byCls)) {
  console.log(`\n[${cls}] ${list.length} 处`);
  for (const f of list.slice(0, 10)) console.log(`  ${f.caseId}: ${f.detail}`);
  if (list.length > 10) console.log(`  ... 及另外 ${list.length - 10} 处`);
}
if (findings.length === 0) console.log("全部检查项干净");
console.log(`\nJSON:${JSON.stringify({ total: findings.length, byClass: Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, v.length])) })}`);

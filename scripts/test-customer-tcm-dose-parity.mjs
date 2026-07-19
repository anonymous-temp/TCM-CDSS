// Customer OD-TCM-* overdose cases (合理用药/eval/customer_acceptance/灵犀测试点_全覆盖总包_20260617.json)
// transposed to TCM-CDSS local dose-limit knowledge parity checks.
// Goal: ensure each 甲方案例 (herb + overdose amount + expected 上限) is reflected in our local KB.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { getTcmHerbDoseLimit } = await jiti.import("../src/lib/tcm-knowledge.ts");

// (caseId, herb, processing?, test dose, 甲方可期望常用上限 g, 是否"毒性"/特殊管理)
const customerCases = [
  ["OD-TCM-BANXIA-11",   "半夏",   "",       15, 9,  false],
  ["OD-TCM-FUZI-12",     "附子",   "",       20, 9,  false], // 注:甲方未标炮制,常用 3-9g
  ["OD-TCM-MAHUANG-13",  "麻黄",   "",       12, 6,  false],
  ["OD-TCM-XIXIN-14",    "细辛",   "",        9, 3,  false],
  ["OD-TCM-GANCAO-15",   "甘草",   "",       20, 9,  false],
  ["OD-TCM-CHUANWU-16",  "制川乌", "制",     10, 3,  true],
  ["OD-TCM-MAQIANZI-17", "马钱子", "",        3, 0.9, true],
  // 阴性对照:不应报超量
  ["OD-OK-TCM-BANXIA-21","半夏",   "",        9, 9,  false],
];

let pass = 0;
const fails = [];

for (const [caseId, herb, , dose, expectedCeiling] of customerCases) {
  const local = getTcmHerbDoseLimit(herb);
  const isOver = dose > expectedCeiling;
  // 1) KB 是否有该 herb 的剂量记录
  if (!local) {
    fails.push({ caseId, why: "本地 KB 无该 herb 阈值", herb });
    console.log(`FAIL  ${caseId} | ${herb} | 本地 KB 无阈值记录`);
    continue;
  }
  // 2) 本地上限 vs 甲方上限:记录差异,不阻断通过
  //    本地字段是 max(药典值),甲方测试集期望可能更严
  const localCeiling = local.max;
  if (localCeiling == null) {
    fails.push({ caseId, why: "本地无 max", herb, local });
    console.log(`FAIL  ${caseId} | ${herb} | 本地无 max: ${JSON.stringify(local)}`);
    continue;
  }
  const ceilingDelta = localCeiling - expectedCeiling;
  const ceilingNote = ceilingDelta === 0
    ? "阈值一致"
    : (ceilingDelta > 0 ? `本地宽 ${ceilingDelta}g (本地=药典)` : `本地严 ${-ceilingDelta}g (本地=药典)`);
  // 3) 本地不应当比甲方上限宽松到允许 caseId 的超量场景"看起来合规"
  //    即:dose > expectedCeiling 时,本地阈值表也应判超 (localCeiling < dose)
  if (isOver && dose <= localCeiling) {
    fails.push({ caseId, why: `本地上限 ${localCeiling}g 容忍了甲方超量 ${dose}g`, herb });
    console.log(`FAIL  ${caseId} | ${herb} | 本地上限 ${localCeiling}g 容忍超量 ${dose}g (甲方上限 ${expectedCeiling}g)`);
    continue;
  }
  // 4) 阴性对照:dose ≤ expectedCeiling 时,本地不应判超
  if (!isOver && dose > localCeiling) {
    fails.push({ caseId, why: `阴性对照 ${dose}g 被本地 ${localCeiling}g 判超`, herb });
    console.log(`FAIL  ${caseId} | ${herb} | 阴性对照 ${dose}g > 本地 ${localCeiling}g,会被误报超量`);
    continue;
  }
  console.log(`PASS  ${caseId} | ${herb} ${dose}g (甲方 ${expectedCeiling}g, 本地 ${localCeiling}g, ${isOver ? "超量" : "合规"}, ${ceilingNote})`);
  pass += 1;
}

console.log("");
console.log(`=== 转译结果:${pass}/${customerCases.length} 通过,${fails.length} 失败 ===`);

// 输出每味药的本地图谱,供后续 audit 参考
console.log("\n--- 本地剂量阈值表(对比甲方) ---");
for (const [, herb] of customerCases) {
  const local = getTcmHerbDoseLimit(herb);
  console.log(`${herb.padEnd(8)} → ${JSON.stringify(local)}`);
}

if (fails.length > 0) process.exit(1);

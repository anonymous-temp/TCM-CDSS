/**
 * 中医师终审裁定（批次 CLINICIAN-REVIEW-20260816）的落地校验。
 *
 * 这批不是普通数据补录，里面有三条**推翻了工程侧原判断**的裁定，删任何一条都会退回原状：
 *
 * ① 虫白蜡 / 颠茄草：工程侧原报「无法可靠分离功能段与主治段」，医生核对药典后指出
 *    这两条**根本没有【功能与主治】段**，只有【用途】（赋形剂润滑剂 / 抗胆碱药）。
 *    逐条核验属实：虫白蜡段落为 性状/检查/用途/贮藏，颠茄草为 性状/鉴别/检查/含量测定/用途/贮藏。
 *    差别不在措辞：报「切不开」会让人去改切分逻辑，而正确处置是**这味药不进中医功效表**。
 *
 * ② 败酱草：工程侧一度按「败酱草→败酱」写进补充表，医生裁定它**既不是小蓟也不是菥蓂，
 *    也不是败酱**，而是败酱科黄花败酱/白花败酱干燥全草的独立规范实体。
 *    原目录把它同时挂到小蓟、菥蓂是本地别名汇总造成的**假歧义**。
 *
 * ③ 冬葵子：与冬葵果是**同植物不同药用部位**（种子 vs 干燥成熟果实），功效正文不同，
 *    不得自动替换；与苘麻子连植物种都不同，明确排除。
 *    机构若实际以冬葵果调剂，须另建机构替代关系，不入全国通用同义词表。
 *
 * 【炮制规格：三味走了三条不同路径，是巧合不是规则】
 * canonicalKnowledgeHerbName 末尾剥炮制前缀，那张表里**有「生」没有「焦」**：
 *   炒麦芽 → 自身是知识库条目，直接命中 ✓
 *   焦麦芽 → 「焦」不在剥离表内，未被剥 ✓
 *   生麦芽 → 「生」在表内，被剥成麦芽，拿到**麦芽总述** ✗
 * 修法是让补充表在归一**之前**按原名生效——补充表既然按规格名逐条裁定，就该按规格名命中。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");

// ── 1. 逐味功效必须落地 ────────────────────────────────────────────────────
const ADJUDICATED = [
  ["制草乌", "祛风除湿", "交叉引用「同草乌」可展开功效指向；毒性/剂量/煎法不得继承"],
  ["六神曲", "健脾和胃", "《重庆市中药饮片炮制规范》DB50/YP068—2022"],
  ["神曲", "健脾和胃", "语料名，须经受治理别名落到六神曲"],
  ["败酱草", "清热解毒", "独立规范实体，非小蓟/菥蓂/败酱"],
  ["冬葵子", "利尿通淋", "独立历史药名，非冬葵果/苘麻子"],
  ["生麦芽", "疏肝行气", "药典分列的独立规格"],
  ["炒麦芽", "行气消食", "同上"],
  ["焦麦芽", "消食化滞", "同上"],
];
for (const [herb, mustContain, why] of ADJUDICATED) {
  const text = String(getTcmHerbFunctionText(herb) || "");
  assert.ok(
    text.includes(mustContain),
    `中医师裁定未落地：${herb} 应含「${mustContain}」（${why}）。实得：${text || "（空）"}`,
  );
}

// ── 2. 麦芽三规格必须互不相同，且不得覆盖麦芽本身 ──────────────────────────
{
  const raw = getTcmHerbFunctionText("生麦芽");
  const fried = getTcmHerbFunctionText("炒麦芽");
  const charred = getTcmHerbFunctionText("焦麦芽");
  assert.equal(
    new Set([raw, fried, charred]).size, 3,
    `生/炒/焦麦芽功效必须互不相同（药典分列）。实得 生=${raw}｜炒=${fried}｜焦=${charred}`,
  );
  for (const [name, text] of [["生麦芽", raw], ["炒麦芽", fried], ["焦麦芽", charred]]) {
    assert.ok(
      !text.includes("回乳消胀"),
      `${name} 不得回落到麦芽总述「行气消食，健脾开胃，回乳消胀」。实得：${text}`,
    );
  }
  assert.ok(
    getTcmHerbFunctionText("麦芽").includes("健脾开胃"),
    "麦芽本身的总述不得被某个炮制规格覆盖——规格优先只对规格名生效",
  );
}

// ── 3. 假歧义必须已被裁定覆写，真歧义不得被顺手放开 ────────────────────────
{
  const catalog = JSON.parse(readFileSync(path.join(repoRoot, "src/data/tcm-herb-identity-catalog.json"), "utf8"));
  const index = catalog.resolutionIndex || {};
  for (const [name, canonical] of [["败酱草", "败酱草"], ["冬葵子", "冬葵子"], ["神曲", "六神曲"], ["牙硝", "芒硝"]]) {
    assert.equal(
      index[name]?.canonicalName, canonical,
      `${name} 应解析为「${canonical}」（中医师终审裁定）。实得 ${JSON.stringify(index[name])}`,
    );
    assert.equal(index[name]?.autoResolvable, true, `${name} 裁定后应可自动解析`);
  }
  // 反向：没有裁定过的歧义名不得被这批改动顺手放开。
  // 芍药（白芍/赤芍）是本仓长期显式保留的歧义，放开它等于替医生做身份判断。
  const stillAmbiguous = ["芍药", "贝母"];
  for (const name of stillAmbiguous) {
    const row = index[name];
    if (!row) continue;
    assert.ok(
      !row.autoResolvable,
      `${name} 未经裁定，必须保持不可自动解析——放开等于替医生做身份判断。实得 ${JSON.stringify(row)}`,
    );
  }
}

// ── 3b. 退回项：藏菖蒲已裁定但受阻于受控治法词表缺词 ──────────────────────
// 裁定的「温胃，止痛」进不了受控治法词表——实测该表收
// 温中/温里/温阳/散寒止痛/温经止痛 → yang_warm，**但不收「温胃」「暖胃」**，
// 「止痛」单独也不成概念。进表则空占一行、无法参与任何方义匹配。
// 按「宁可少写不要多写」暂不入表（语料用量 0，无临床影响）。
// 这**不是裁定有问题，是词表缺词**；收词影响所有药-治法匹配，属治理层变更，
// 需中医师终审而非工程侧自行决定。见工作包 §六退回项。
// 本条钉住「暂不入表」这个当前状态：若变红说明有人补了词并回填，
// 请顺带确认收词经过终审、且未连带放宽其他匹配。
{
  const supplements = JSON.parse(
    readFileSync(path.join(repoRoot, "src/data/tcm-herb-function-supplements.source.json"), "utf8"));
  const names = new Set(supplements.entries.map((entry) => entry.herb));
  assert.ok(
    !names.has("藏菖蒲"),
    "藏菖蒲暂不入功效表——其裁定功效「温胃，止痛」在受控治法词表中解析为空。"
    + "若已补词回填，请确认收词经中医师终审（见工作包 §六）。",
  );
}

// ── 4. 不进功效表的两味：必须仍然没有中医功效正文 ──────────────────────────
// 医生裁定「排除不等于删除药物」——它们仍可留在药材主数据/制剂用途/现代药理库，
// 只是不得进入用于方义匹配的中医功效字段。
{
  const supplements = JSON.parse(
    readFileSync(path.join(repoRoot, "src/data/tcm-herb-function-supplements.source.json"), "utf8"));
  const names = new Set(supplements.entries.map((entry) => entry.herb));
  for (const herb of ["虫白蜡", "颠茄草"]) {
    assert.ok(
      !names.has(herb),
      `${herb} 药典词条只有【用途】、没有【功能与主治】（赋形剂润滑剂 / 抗胆碱药），`
      + "不得写入中医功效补充表——把「用途」改写成中医治法会制造未经原文支持的数据。",
    );
  }
}

// ── 5. 采集脚本必须把「无功能段」与「切不开」分开报 ────────────────────────
// 报错的原因码会把判断成本转嫁给下游：报「切不开」让人去改切分逻辑，
// 报「无功能与主治段」才指向正确处置（这味药不该进功效表）。
// 与本仓 finalized M03 rejected 只报文档质量码、不报管事的安全码是同一种毛病。
{
  const collector = readFileSync(path.join(repoRoot, "scripts/collect-chp-herb-functions.mjs"), "utf8");
  assert.ok(
    /documentedSectionTitles/.test(collector),
    "采集脚本必须能列出药典词条的实际段落标题",
  );
  assert.ok(
    /无【功能与主治】段/.test(collector),
    "缺少功能与主治段时必须明确这么报，不得笼统报「无法可靠分离功能段与主治段」",
  );
}

console.log("test-clinician-herb-adjudications: OK", { adjudicated: ADJUDICATED.length });

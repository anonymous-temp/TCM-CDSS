/**
 * chain_incomplete 的修复引导必须指出**哪个节点的哪一项**没过。
 *
 * 【线上实证】2026-08-16 气滞胁痛案，生产日志逐轮：
 *   finalized M03 rejected { reason: 'm03_chain_incomplete' } × 6 轮，不收敛
 *   stage_result { outcome:'fallback', reviewStatus:'not_run' }
 * 6/6 稳定复现，终点是「当前证候依据不足以形成稳定结论」空白页。
 *
 * 根因不是判据错，是**修复引导不可执行**：hasCompleteChain 要求每个节点四项全过
 * （patientFact 稳定 / syndromeEvidence 稳定 / pathogenesis 有锚 / therapyDirection 有锚），
 * 但驳回码只回一个笼统的 `chain_incomplete`，修复引导也只是复述「什么叫合格的链」。
 * 模型每轮把整条链重写一遍，却不知道卡在哪，于是反复以同样方式失败。
 *
 * 而 m03ChainNodeDiagnostics **早就逐节点算着这四项标志位**——只进服务端日志，
 * 不进修复提示词。又一次「算出来即丢弃」。
 *
 * 【同一条 doctrine 在本文件里早有先例】structuredClinicalRepairHint 的
 * contextualCandidates 参数注释写着：「『漏锁命名方』这条修复必须带上真实候选方名，
 * 否则它是一条无法执行的指令」。本条是同一道理的第二例。
 *
 * 【PHI 边界】只列字段名与节点序号，**绝不回显 patientFact 原文**——那是病历文本，
 * 与 patient_fact_ungrounded 同一口径，不入日志也不入提示词。
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
const { structuredClinicalRepairHint } = await jiti.import("../src/lib/structured-clinical-repair.ts");
const { m03ChainNodeDiagnostics, isUnstableM03CoreText } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

// ── 1. 带明细时必须出现在引导里，且必须点名节点与字段 ──────────────────────
{
  const issues = [
    "P1: pathogenesis 未命中任何受控病机锚点",
    "P2: therapyDirection 未命中任何受控治法锚点、syndromeEvidence 含待辨/资料不足类措辞或过短",
  ];
  const hint = structuredClinicalRepairHint("diagnose", "m03_chain_incomplete", [], issues);
  assert.ok(hint.includes("P1"), `修复引导必须点名失败节点序号。实得：${hint.slice(-300)}`);
  assert.ok(hint.includes("P2"), "多个节点失败时必须逐个列出");
  assert.ok(
    hint.includes("pathogenesis") && hint.includes("therapyDirection"),
    "必须点名具体字段——只说「补全病机链」是不可执行的指令",
  );
  assert.ok(
    /只修这些项|逐字保留|不要整条链重写/.test(hint),
    "必须明确要求只修列出的项、其余逐字保留；否则模型仍会整条重写，六轮不收敛的成因不变",
  );
}

// ── 2. 无明细时不得凭空编造（保持原引导，不退化）──────────────────────────
{
  const hint = structuredClinicalRepairHint("diagnose", "m03_chain_incomplete", [], []);
  assert.ok(hint.length > 50, "无节点明细时仍须给出原有的通用引导，不得退化为空");
  assert.ok(!/P\d+:/.test(hint), "没有明细就不得凭空写出节点编号");
}

// ── 3. 节点诊断本身：四项各自可独立判负 ────────────────────────────────────
// 若某一项恒真/恒假，上面的明细就永远指不到它，修复引导会系统性漏掉一类。
{
  const base = {
    stage: "diagnose",
    pathogenesis: {
      chain: [{
        patientFact: "胁肋胀痛，痛无定处，走窜不定",
        syndromeEvidence: "胁肋胀痛，痛无定处",
        pathogenesis: "肝气郁结，横逆犯胃",
        therapyDirection: "疏肝理气",
      }],
    },
  };
  const ok = m03ChainNodeDiagnostics(base)[0];
  assert.ok(
    ok.patientFactStable && ok.syndromeEvidenceStable && ok.pathogenesisAnchored && ok.therapyAnchored,
    `夹具前提：完整节点四项应全过。实得 ${JSON.stringify(ok)}`,
  );

  const cases = [
    ["patientFactStable", { patientFact: "待辨" }],
    ["syndromeEvidenceStable", { syndromeEvidence: "资料不足" }],
    ["pathogenesisAnchored", { pathogenesis: "情况复杂" }],
    ["therapyAnchored", { therapyDirection: "综合处理" }],
  ];
  for (const [flag, patch] of cases) {
    const mutated = {
      ...base,
      pathogenesis: { chain: [{ ...base.pathogenesis.chain[0], ...patch }] },
    };
    const node = m03ChainNodeDiagnostics(mutated)[0];
    assert.equal(
      node[flag], false,
      `${flag} 必须能被独立判负（注入 ${JSON.stringify(patch)}）。恒真的标志位会让修复引导系统性漏掉这一类。实得 ${JSON.stringify(node)}`,
    );
  }
}

// ── 3b. 气滞主症不得被读成不确定性对冲词 ──────────────────────────────────
// 【这条是六轮不收敛的真正根因】UNSTABLE_REASONING_MARKER 的
//   (?:暂|尚|仍)?(?:不|未|无)(?:能|可|足以)?(?:…|定|…)
// 分支把「痛无定处」「走窜不定」当成「无法确定」。而它们是气滞证的**主症描述**
// （痛处游走不固定），是病历原文本身。
// 线上实证：气滞胁痛案 6/6 复现——模型写进 patientFact 的就是这段原文，
// 判据把原文判为不稳定 ⇒ chain_incomplete ⇒ 重写 ⇒ 还是原文 ⇒ 再判……怎么改都过不了。
// 整个气滞证类别的病机链都可能因此建不起来。
{
  const CLINICAL_FACTS = ["痛无定处", "走窜不定", "痛处不定", "游走不定", "无定处",
    "胁肋胀痛，痛无定处，走窜不定"];
  for (const text of CLINICAL_FACTS) {
    assert.ok(
      !isUnstableM03CoreText(text),
      `气滞主症描述不得被判为不确定表述：「${text}」。`
      + "它是病历原文，判负会让整个气滞证类别的病机链建不起来（线上 6/6 复现）。",
    );
  }
  // 反向：真对冲词判定必须一字不变，豁免不得外溢
  const REAL_HEDGES = ["证候待定", "病位未能确定", "尚不能明确", "资料不足", "有待进一步确认", "不定"];
  for (const text of REAL_HEDGES) {
    assert.ok(
      isUnstableM03CoreText(text),
      `真不确定表述必须仍判不稳定：「${text}」。豁免只针对气滞主症的固定搭配，不得外溢。`,
    );
  }
}

// ── 4. 调用点必须真的把明细算出来并传进去 ──────────────────────────────────
// 判据存在但没人调用，等于没有——这是本仓反复出现的形状。
{
  const api = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");
  assert.ok(
    /chainNodeIssues/.test(api),
    "diagnosis-api 必须计算 chain_incomplete 的节点级明细",
  );
  assert.ok(
    /m03ChainNodeDiagnostics\(parsedForChain\)/.test(api),
    "明细必须由 m03ChainNodeDiagnostics 现算，不得另抄一份判据",
  );
  const callBlock = api.slice(
    api.indexOf("const clinicalRepairHint = structuredClinicalRepairHint("),
    api.indexOf("const clinicalRepairHint = structuredClinicalRepairHint(") + 400,
  );
  assert.ok(
    /chainNodeIssues,/.test(callBlock),
    "算出来必须传进 structuredClinicalRepairHint——只进日志就是「算出来即丢弃」",
  );
  // PHI 边界：不得把 patientFact 原文拼进提示词
  assert.ok(
    !/patientFact\s*\}?\s*\)?\s*\.slice|`\$\{[^}]*patientFact[^}]*\}`/.test(api.slice(
      api.indexOf("const chainNodeIssues"), api.indexOf("const clinicalRepairHint"))),
    "节点明细不得回显 patientFact 原文——那是病历文本，与 patient_fact_ungrounded 同一口径",
  );
}

console.log("test-chain-incomplete-repair-targeting: OK");

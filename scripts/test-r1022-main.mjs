// 10/20 第十轮（主控）：第九轮终测暴露的两处服务端缺陷。
//
//   1 处方终审回填 M03 段落的来源与比对来源必须是同一份已签名辨证（甲方病历7 第2次生成：脱敏规则把「辛热积于胃腑」
//     改成「[已脱敏]于胃腑」，证据变换按脱敏后的病例回填病机，终审拿未脱敏的签名辨证比对 → pathogenesis_drift → 整方退成无剂量页）。
//     对照：按脱敏后的病例回填仍会漂移（说明守住的是哪一处）；路由把已签名辨证交给证据变换。
//   2 窄核对交回的病历摘录按句读拼接、顺序与病历不同时，各段逐字在病历里即算出自病历（留出例 S102 多囊卵巢综合征：
//     「性激素六项大致正常；妇科彩超：子宫附件未见明显异常」倒序拼接，降级被丢）。对照：编造的片段、两字片段、单段不在病历里照旧不认。
//   3 西医核对判 D（缺确诊检查/病程）时交回的名称只能是同一个病往宽处说：原名的字序子序列、症状层名称或病历自己写着的说法；
//     交回另一个病（附睾结核→附睾炎、甲状腺癌骨转移→甲状腺瘤、肾包虫病→肾囊肿、糖尿病→消渴病）改写「原病名待查」（第九轮 D 集）。
//     对照：脊髓型颈椎病→颈椎病、急性化脓性扁桃体炎→急性扁桃体炎、缺铁性贫血→贫血、功能性消化不良→消化不良待查、主诉「牙痛3天」→牙痛 照旧。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const evidence = await jiti.import("../src/lib/cdss-evidence-context.ts");
const parse = await jiti.import("../src/lib/diagnosis-parse.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const repair = await jiti.import("../src/lib/diagnosis-structured-repair.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const quote = await jiti.import("../src/lib/verbatim-quote.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");

// ── 1 回填来源与比对来源同一份 ──────────────────────────────────────────────
const case7 = JSON.parse(readFileSync("scripts/fixtures/r1022/case7-signed-m03-drift.json", "utf8"));
const prior = case7.prior;
const gated = safety.withSafetyGate(types.normalizeCaseStateInput(structuredClone(case7.input)));
const sanitized = safety.sanitizeCaseStateForModel({ ...gated, reasoningDiagnose: prior });
// 第十轮词形订正后「辛热积于」已不再被抹（test:r1022-phi）。这里守的是结构：回填来源与比对来源必须同一份，
// 与哪条脱敏规则改写了哪句无关——所以按 2026-10-19 当时的脱敏结果人为构造这份「脱敏后的病例」。
const safeState = structuredClone(sanitized);
safeState.reasoningDiagnose.overview.overallPathogenesis = prior.overview.overallPathogenesis.replace("辛热积于胃腑", "[已脱敏]于胃腑");
const carrier = repair.enforceM04PriorStageOwnership(
  case7.prescribeContent.replace(/^[\s\S]*?(?=<!-- DIAGNOSIS_JSON_START -->)/, "## 处方\n\n"),
  prior,
);
const finalIssue = (content) => contract.m04SafetyContractIssue(parse.parseReasoningV2(content), prior, {
  isKnownHerbName: knowledge.isKnownTcmHerbName,
  trustedWorkbenchEdit: false,
  auditedClinicalRisksAreAdvisory: false,
  clinicalContext: safety.clinicalGroundingText(safeState),
  waiveTherapyCoverageAnnotated: true,
}) || "";

await check("1.0 前提：签名辨证的病机里有「辛热积于胃腑」；第十轮词形订正后脱敏已不再改它；构造的脱敏病例与签名不同", () => {
  assert.match(prior.overview.overallPathogenesis, /辛热积于胃腑/);
  assert.equal(sanitized.reasoningDiagnose.overview.overallPathogenesis, prior.overview.overallPathogenesis, "词形订正（test:r1022-phi）后应不再被抹");
  assert.notEqual(safeState.reasoningDiagnose.overview.overallPathogenesis, prior.overview.overallPathogenesis);
});

await check("1.1 对照：按脱敏后的病例回填 M03 段落，终审判 pathogenesis_drift", () => {
  const transform = evidence.buildEvidenceOutputTransform("", undefined, safeState);
  assert.equal(finalIssue(transform(carrier)), "pathogenesis_drift");
});

await check("1.2 按已签名辨证回填：病机逐字不变，终审不判漂移", () => {
  const transform = evidence.buildEvidenceOutputTransform("", undefined, { ...safeState, reasoningDiagnose: prior });
  const output = transform(carrier);
  assert.equal(parse.parseReasoningV2(output).overview.overallPathogenesis, prior.overview.overallPathogenesis);
  assert.doesNotMatch(finalIssue(output), /drift/);
});

await check("1.3 处方路由把已签名辨证交给证据变换（与终审比对的是同一份）", () => {
  const route = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  const start = route.indexOf("const evidenceOutputTransform = buildEvidenceOutputTransform(");
  assert.ok(start > 0);
  const call = route.slice(start, route.indexOf("preModelTimings.promptReady", start));
  assert.match(call, /\{\s*\.\.\.safeState,\s*reasoningDiagnose:\s*signedPriorReasoning\s*\}/);
  assert.doesNotMatch(call, /\n\s*safeState,\n\s*\);/);
});

// ── 2 拼接摘录 ─────────────────────────────────────────────────────────────
const s102 = JSON.parse(readFileSync("scripts/fixtures/r1022/s102-western-check-reversed-quote.json", "utf8"));
const s102Record = safety.trustedInputText(safety.sanitizeCaseStateForModel(types.normalizeCaseStateInput(structuredClone(s102.input))));

await check("2.1 病历里两段倒序拼接的摘录算出自病历；正序与整段照旧", () => {
  assert.ok(quote.quoteGroundedInText("性激素六项大致正常；妇科彩超：子宫附件未见明显异常", s102Record));
  assert.ok(quote.quoteGroundedInText("妇科彩超：子宫附件未见明显异常；性激素六项大致正常", s102Record));
  assert.ok(quote.quoteGroundedInText("性激素六项大致正常", s102Record));
});

await check("2.2 对照：编造片段、两字片段、病历里没有的单段、超长都不认", () => {
  assert.ok(!quote.quoteGroundedInText("性激素六项大致正常；睾酮明显升高", s102Record));
  assert.ok(!quote.quoteGroundedInText("性激素六项大致正常；正常", s102Record));
  assert.ok(!quote.quoteGroundedInText("双侧卵巢多囊样改变", s102Record));
  assert.ok(!quote.quoteGroundedInText("尿妊娠试验阴性".repeat(10), s102Record));
  assert.ok(!quote.quoteGroundedInText("阴性", s102Record));
});

await check("2.3 S102 两次核对的原始输出都采信为降级（第二次是倒序引文）", () => {
  for (const raw of s102.rawOutputs) {
    const correction = western.parseWesternNameCorrection(JSON.stringify(raw), s102Record, "多囊卵巢综合征", { patientAge: 30 });
    assert.ok(correction, `未采信：${raw.quote}`);
    assert.equal(correction.type, "D");
    // 「月经稀发」既不是原名的宽写，也不是病历里的说法：按第 3 条改写「原病名待查」（复核对 S102 的意见即「应写待排」）。
    assert.equal(correction.supportedName, "多囊卵巢综合征待查");
  }
});

// ── 3 D 类换名只许往宽处说 ───────────────────────────────────────────────
const dRaw = (quoteText, supportedName, reason = "尚缺确诊所需的病理或病原学检查") =>
  JSON.stringify({ decisive: "", meetsCriteria: false, verdict: "inconsistent", type: "D", quote: quoteText, reason, supportedName, missingTest: "病理检查", emergencyName: false });
const dCases = [
  ["附睾结核", "右侧附睾尾部触及不规则硬结，与阴囊皮肤粘连，无压痛", "附睾尾部触及不规则硬结", "附睾炎", "附睾结核待查"],
  ["甲状腺癌骨转移", "甲状腺右叶结节3年，腰痛2月，腰椎X线示椎弓根影消失", "腰椎X线示椎弓根影消失", "甲状腺瘤", "甲状腺癌骨转移待查"],
  ["肾包虫病", "牧区居住20年，右上腹肿块，B超示右肾囊性占位", "B超示右肾囊性占位", "肾囊肿", "肾包虫病待查"],
  ["糖尿病", "口渴多饮1月，空腹血糖7.8mmol/L", "空腹血糖7.8mmol/L", "消渴病", "糖尿病待查"],
];
await check("3.1 D 类交回另一个病：改写原病名待查", () => {
  for (const [current, record, q, proposed, expected] of dCases) {
    const correction = western.parseWesternNameCorrection(dRaw(q, proposed), record, current, { patientAge: 45 });
    assert.ok(correction, current);
    assert.equal(correction.supportedName, expected, `${current}→${proposed}`);
  }
});
await check("3.2 对照：原名去限定、症状层、病历原有说法照旧采信", () => {
  const keep = [
    ["脊髓型颈椎病", "四肢麻木无力半年，步态不稳，颈椎X线示退变", "颈椎X线示退变", "颈椎病", "颈椎病"],
    ["急性化脓性扁桃体炎", "咽痛3天，发热38.5℃，扁桃体Ⅱ度肿大", "扁桃体Ⅱ度肿大", "急性扁桃体炎", "急性扁桃体炎"],
    ["缺铁性贫血", "乏力2月，血红蛋白92g/L，未查铁代谢", "血红蛋白92g/L", "贫血", "贫血"],
    ["急性牙髓炎", "牙痛3天，冷热刺激加重，夜间痛明显", "冷热刺激加重", "牙痛", "牙痛"],
  ];
  for (const [current, record, q, proposed, expected] of keep) {
    const correction = western.parseWesternNameCorrection(dRaw(q, proposed), record, current, { patientAge: 45 });
    assert.ok(correction, current);
    assert.equal(correction.supportedName, expected, `${current}→${proposed}`);
  }
  // A/B 类（病历记录与原名相反）不受这条约束：交回名单里的另一个病照旧采信。
  const ab = JSON.stringify({ verdict: "inconsistent", type: "A", quote: "活检示上皮下钉突", reason: "活检所见指向膜性肾病，与原名不符", supportedName: "膜性肾病", emergencyName: false });
  const adopted = western.parseWesternNameCorrection(ab, "蛋白尿半年，肾活检示上皮下钉突形成", "微小病变肾病", { listedNames: ["膜性肾病"] });
  assert.equal(adopted?.supportedName, "膜性肾病");
});

console.log(`r1022-main: ${cases} cases${process.exitCode ? " (FAILED)" : " ok"}`);

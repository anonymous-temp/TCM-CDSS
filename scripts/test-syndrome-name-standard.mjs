// 主证名规范化回归(2026-08-05,甲方证候名规范化确认项)。
//
// 实测:线上主证输出「头痛（气血失和，脑失濡养）」——括号外是病名、括号内是病机,
// 整串不是任何一层的规范表述。此前合同只校验主证非空与不含待辨字样,从不校验它是不是一个证候。
// 受治理证候词表 2060 条各带 GB/T 编号,标准一直都在,只是主证这一栏从未拿它比对过。
//
// 本套件钉两个方向:
//  · 规范写法(含并列、含括注补充)必须放行——判据不能严到把正常临床表述拦掉;
//  · 病名+病机的混合串必须驳回——这是甲方指出的形态。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });

// 用**合同层的真实判据**，不再重建同源副本。
//
// 此前这里手抄了一份三段式实现，注释还写着「合同层的实际拦截由 m03StructuralIssue 的集成用例
// 覆盖」——而那个集成用例并不存在（grep nonstandard 在 scripts/ 下只命中西医标签用例）。
// 于是这套件真正钉住的只是抄件自身：实现改了它照样绿。2026-08-06 改为直接导入。
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const acceptable = contract.governedSyndromeNameAcceptable;

const failures = [];
const ok = (v, why) => { if (!acceptable(v)) failures.push({ v, why, kind: "wrongly_rejected" }); };
const no = (v, why) => { if (acceptable(v)) failures.push({ v, why, kind: "wrongly_accepted" }); };

// 一、规范写法必须放行
ok("心脾两虚证", "标准证候名");
ok("风寒束表证", "标准证候名");
ok("气血两虚证", "标准证候名");
ok("心脾两虚，气血不足", "并列证候写法");
ok("心脾两虚证（气血不足）", "带括注补充");
ok("胸痹心脉痹阻证", "病证结合规范写法:病名+证候");
ok("阴虚神扰证", "词表未收录的合法组合证候名,不得误伤");
// 边界样本：形态看着像「病名（病机，病机）」，但「清阳不升」本身就是受治理证候词表收录的
// 证候名（GB/T），因此整串属病证结合写法，必须放行。判据的分界从来不是「有没有括号」，
// 而是「剥掉病名后剩下的东西是不是证候」——这条用例就是用来防止后人把判据收严到误伤它。
ok("眩晕（清阳不升，脑窍失养）", "括注内首段是受治理证候名,属病证结合写法");

// 二、病名+病机混合必须驳回。
//
// 按仓库惯例覆盖**整类**而非线上那一条：甲方给的是「头痛（气血失和，脑失濡养）」，
// 但同一形态可以换任意病名、任意病机句写出来，只钉一条等于没钉。
no("头痛（气血失和，脑失濡养）", "甲方实测原串：括号外病名、括号内病机");
no("不寐（心神失养，阳不入阴）", "同形态换病名换病机");
no("胃痛（胃失和降，气机不畅）", "同形态换病名换病机");
no("咳嗽（肺失宣降）", "单句病机同样不是证候名");
no("头痛，气血失和，脑失濡养", "改用逗号并列，仍是病名+病机");

// 三、合同层必须真的返回 primary_syndrome_name_nonstandard。
//
// 上面钉的是判据函数，这里钉的是**它有没有被接进合同**——审计发现旧注释声称
// 「由 m03SemanticIssue 的集成用例覆盖」，而那个用例根本不存在。判据再对，没接线也是白搭。
const evidence = { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" };
const reasoningWith = (primarySyndrome) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "头痛",
    tcmDiseaseRationale: "以头痛为主症、病程逾月且非眩晕类发作形态，故归入头痛病而非眩晕。",
    tcmDiagnosticRationale: "头痛反复发作1月见于劳累后加重，神疲乏力故病性属气虚；四诊合参归为气血两虚证。",
    primarySyndrome,
    primarySyndromeResolution: "resolved",
    primarySyndromeBasis: ["头痛反复发作1月", "神疲乏力"],
    overallPathogenesis: "气血亏虚，脑失濡养",
    overallTherapy: "益气养血",
    recommendedFormulaDirection: "八珍汤加减",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "头痛，病因待查", status: "考虑", confidence: "中",
      supportingFacts: ["头痛反复发作1月", "神疲乏力"],
      clinicalRationale: "头痛反复发作1月提示慢性病程，结合神疲乏力支持症状层工作诊断；继发性病因尚未核实，故暂不升级。",
      limitations: [], suggestedChecks: [], evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "气血亏虚，脑失濡养",
    locationDifferentiation: { items: ["脑"], resolution: "resolved", evidence },
    natureDifferentiation: { items: ["气虚"], resolution: "resolved", evidence },
    chain: [{ nodeId: "P1", patientFact: "神疲乏力", syndromeEvidence: "气血两虚", pathogenesis: "气血亏虚", therapyDirection: "益气养血", evidence }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之", overallMethod: "益气养血",
    subTherapies: [{ therapy: "益气养血", targetPathogenesis: "气血亏虚", priority: "主要", evidence }],
  },
  formula: null, nonPharma: null, lineageAdaptation: null,
});

const badIssue = contract.m03SemanticIssue(reasoningWith("头痛（气血失和，脑失濡养）"), "头痛反复发作1月，神疲乏力");
if (badIssue !== "primary_syndrome_name_nonstandard") {
  failures.push({ v: "合同层返回码", why: `期望 primary_syndrome_name_nonstandard，实际 ${badIssue}`, kind: "contract_not_wired" });
}
const goodIssue = contract.m03SemanticIssue(reasoningWith("气血两虚证"), "头痛反复发作1月，神疲乏力");
if (goodIssue === "primary_syndrome_name_nonstandard") {
  failures.push({ v: "合同层误伤", why: "规范证候名被判 nonstandard", kind: "contract_false_positive" });
}

// 四、驳回档位：措辞类缺陷不得把整份辨证作废。
//
// 判据拦的是**证候名写法**，而证候判断本身已通过事实接地与安全边界核验。
// 该码此前落在默认 T1（安全级硬拦截）——修复轮耗尽后整页 M03 清空，医生连病机治法都拿不到，
// 与 2026-08-01 处置信条相悖；分级也是倒置的：紧邻的「证候无依据」严重得多，反倒是 T2。
const tiers = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
if (tiers.rejectionTier("primary_syndrome_name_nonstandard") !== "T2") {
  failures.push({ v: "驳回档位", why: `期望 T2，实际 ${tiers.rejectionTier("primary_syndrome_name_nonstandard")}`, kind: "wrong_tier" });
}
if (tiers.isSafetyRejection("primary_syndrome_name_nonstandard")) {
  failures.push({ v: "驳回档位", why: "措辞类缺陷不得被判为安全级拒绝", kind: "wrong_tier" });
}
if (!tiers.qualityAnnotationCopy("primary_syndrome_name_nonstandard")) {
  failures.push({ v: "批注文案", why: "T2 必须给出医生可读批注", kind: "missing_copy" });
}
// 反向守卫：真正的安全级缺陷不得被顺手降档。
if (tiers.rejectionTier("chain_empty") !== "T1") {
  failures.push({ v: "反向守卫", why: "chain_empty 必须保持 T1", kind: "tier_regression" });
}

if (failures.length > 0) console.error(JSON.stringify({ failures }, null, 2));
assert.equal(failures.length, 0, `主证名规范化回归失败 ${failures.length} 项`);
console.log(JSON.stringify({ acceptedForms: 8, rejectedForms: 5, contractCodeAssertions: 2, tierAssertions: 4, failures: 0 }));

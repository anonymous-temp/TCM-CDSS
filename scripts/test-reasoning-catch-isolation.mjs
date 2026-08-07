// 归一层「单条非法不得连坐」结构性守卫。
//
// 这是本仓库同一族缺陷第 6 次出现后立的闸。前 5 次的形态一模一样，只是换了字段：
//   · 单条子治法非法 → 整个 therapy 落 DEFAULT_THERAPY → 治则变「暂不锁定剂量级治法」（f7b55cda，线上实测才发现）
//   · 一条中医外治写歪 → 整个 nonPharma 变 null → **健康调护跟着一起消失**（甲方 8-05 两个「高」优先级模块同时清零）
//   · 8 条中成药坏 1 条 → 整栏变 null，且无回填、无 schema 码、无语义合同、无批注（信噪比最差的一格）
//   · 备选方少一个 dosesPerDay → 连同已完全合格的首选方、辨证、病机、调护一起整份作废
//   · overview 任一栏超长 → 主证/病机/治法/选方方向四个工程占位串一次性全出，并清空两组鉴别诊断
//
// 为什么门禁一直看不见：`.catch()` 让 `safeParse` **成功**，于是 `reasoningV2SchemaIssueCode`
// 一律返回 undefined——修复轮唯一的自动触发器对整个 .catch 家族是瞎的。只能靠人在生产肉眼发现。
//
// 本套件的判据是**行为级**而不是形态级：往每个数组注入「1 条非法 + N 条合法」，
// 断言归一后剩下恰好 N 条（而不是 0 条、不是整块 null、不是整份 undefined）。
// 新增数组字段时把它加进 ISOLATED_ARRAYS，否则下一次连坐仍然只能靠线上发现。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { normalizeReasoningV2 } = await jiti.import("../src/lib/diagnosis-types.ts");

const BASE = JSON.parse(
  readFileSync("scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m04.json", "utf8"),
);

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function at(root, path) {
  let node = root;
  for (const segment of path) {
    if (node === undefined || node === null) return undefined;
    node = node[segment];
  }
  return node;
}

function setAt(root, path, value) {
  let node = root;
  for (const segment of path.slice(0, -1)) node = node[segment];
  node[path[path.length - 1]] = value;
}

// 基线本身必须能过，否则下面每一条断言都是假阳性。
check("ISO-00 基线（真实生产载荷）可通过归一", () => {
  const normalized = normalizeReasoningV2(clone(BASE));
  assert.ok(normalized, "基线载荷归一后为 undefined，fixture 已与 schema 漂移");
  assert.equal(normalized.schemaVersion, "tcm-cdss-reasoning-v2");
});

// fixture 里没有的栏，先补一份合法基线——否则「注入一条非法」验证的是空数组，永远是绿的。
// 补的这份基线同时也是这些栏的合法性样例，schema 收紧时它会先红。
const SEEDED_BASELINES = [
  [["overview", "secondarySyndromes"], ["肝郁气滞证"]],
  [["lineageAdaptation"], {
    schemaVersion: "tcm-cdss-reasoning-v2",
    lineageCode: "bujizhongzhou",
    label: "补土派",
    applicable: "partial",
    applicabilityReason: "产后气血亏虚、脾胃虚弱，与补土派健脾益气的着眼点一致。",
    influencedDecisions: [{ aspect: "组方思路", detail: "以健脾益气为主线，佐以养血和络。" }],
    unaffectedBySafety: ["哺乳期用药边界不因流派偏好放宽"],
    safetyDeference: "流派偏好不改变剂量上限与配伍禁忌的确定性判定。",
  }],
  [["terminologyMappings"], [{
    namespace: "tcm_syndrome",
    fieldPath: "overview.primarySyndrome",
    originalText: "心脾两虚",
    candidateId: "GBT16751-心脾两虚证",
    canonical: "心脾两虚证",
    resolvedBy: "deepseek_closed_set",
    status: "suggested",
    confidence: 0.92,
    model: "deepseek-v4-flash",
    consensus: true,
    cache: "miss",
  }]],
];

for (const [path, value] of SEEDED_BASELINES) {
  const current = at(BASE, path);
  if (current === undefined || (Array.isArray(current) && current.length === 0)) setAt(BASE, path, value);
}

// 每项：[人类可读名, 数组路径, 造一条非法条目的方法]
// 非法条目一律「结构上明确违反 schema」，不依赖某个具体上限数字，避免上限调整后本套件静默失效。
const ISOLATED_ARRAYS = [
  ["证型鉴别", ["overview", "tcmDifferentials"], { syndrome: "", reason: "x", distinguishingPoints: "y", nextCheck: null }],
  ["病名鉴别", ["overview", "tcmDiseaseDifferentials"], { diseaseName: "", reason: "x", distinguishingPoints: "y", nextCheck: null }],
  ["主证依据", ["overview", "primarySyndromeBasis"], ""],
  ["兼证", ["overview", "secondarySyndromes"], ""],
  ["西医鉴别", ["westernDiagnosis", "differentials"], { name: "x".repeat(900), reason: "y", nextCheck: null }],
  ["病机链", ["pathogenesis", "chain"], "不是对象"],
  ["病机不确定项", ["pathogenesis", "uncertainties"], "不是对象"],
  ["症状群", ["pathogenesis", "symptomClusters"], { symptoms: [], mechanism: "x" }],
  ["病位", ["pathogenesis", "locationDifferentiation", "items"], "x".repeat(400)],
  ["病性", ["pathogenesis", "natureDifferentiation", "items"], "x".repeat(400)],
  ["分治法", ["therapy", "subTherapies"], { therapy: "x", targetPathogenesis: "y", priority: "很重要", evidence: null }],
  ["中成药/西药", ["formula", "patentAndWestern"], { type: "保健品", name: "x" }],
  ["中医外治", ["nonPharma", "tcmTreatments"], { projectCode: "NOT_A_CODE", projectName: "x" }],
  ["流派影响决策", ["lineageAdaptation", "influencedDecisions"], { aspect: "随便写", detail: "x" }],
  ["受控术语映射", ["terminologyMappings"], { namespace: "not_a_namespace", fieldPath: "x" }],
];

for (const [label, path, invalidItem] of ISOLATED_ARRAYS) {
  check(`ISO-${label} 单条非法只丢那一条`, () => {
    const baseArray = at(BASE, path);
    if (!Array.isArray(baseArray) || baseArray.length === 0) {
      // fixture 里没有这一栏就补一条合法的进去；补不出来就明确跳过而不是假装通过。
      assert.fail(`fixture 缺少 ${label}（${path.join(".")}）的合法基线条目，无法验证隔离`);
    }
    const payload = clone(BASE);
    setAt(payload, path, [...clone(baseArray), clone(invalidItem)]);
    const normalized = normalizeReasoningV2(payload);
    assert.ok(normalized, `${label} 注入一条非法后整份被拒收（应只丢那一条）`);
    const result = at(normalized, path);
    assert.ok(
      Array.isArray(result),
      `${label} 注入一条非法后整块变成 ${JSON.stringify(result)}（应仍是数组）`,
    );
    assert.equal(
      result.length,
      baseArray.length,
      `${label} 注入 1 条非法后剩 ${result.length} 条，原有 ${baseArray.length} 条合法条目被连坐`,
    );
  });
}

// 占位串替换：模型某一栏写长了，不得把整块换成工程占位串再签名出厂。
const PLACEHOLDERS = [
  "尚未形成稳定证型",
  "病机链尚未稳定，需结合补充问诊后复核",
  "暂不锁定剂量级治法",
  "暂不生成剂量级候选方药",
  "症状性诊断，病因待临床鉴别",
];

const OVERLONG_FIELDS = [
  ["主证", ["overview", "primarySyndrome"], 1200],
  ["总体病机", ["overview", "overallPathogenesis"], 2000],
  ["总体治法", ["overview", "overallTherapy"], 1200],
  ["选方方向", ["overview", "recommendedFormulaDirection"], 1200],
  ["治则", ["therapy", "overallPrinciple"], 2000],
];

for (const [label, path, limit] of OVERLONG_FIELDS) {
  check(`ISO-占位-${label} 超长不得被替换成工程占位串`, () => {
    const payload = clone(BASE);
    setAt(payload, path, "求".repeat(limit + 50));
    const normalized = normalizeReasoningV2(payload);
    assert.ok(normalized, `${label} 超长导致整份拒收`);
    const value = at(normalized, path);
    assert.ok(
      !PLACEHOLDERS.includes(String(value || "").trim()),
      `${label} 超长后被换成工程占位串「${value}」——医生会以为模型没做出来，实际只是写长了`,
    );
    // 同批其它栏不得被连坐（这是「一次性四个占位串全出」的判据）。
    const siblings = [
      ["overview", "primarySyndrome"],
      ["overview", "overallPathogenesis"],
      ["overview", "overallTherapy"],
    ].filter((candidate) => candidate.join(".") !== path.join("."));
    for (const sibling of siblings) {
      const before = at(BASE, sibling);
      if (!before) continue;
      assert.equal(
        at(normalized, sibling),
        before,
        `${label} 超长连坐了 ${sibling.join(".")}（原值「${before}」）`,
      );
    }
  });
}

check("ISO-首选方 首选非法仍必须整份拒收（不得静默把备选顶上来）", () => {
  // 隔离只针对备选。若首选也被隔离掉，出参里第一张就成了原本标注「备选」的方，
  // 等于系统替医生改了首选，且剂量安全语义会从 fail-closed 滑向 fail-open。
  const payload = clone(BASE);
  const candidates = payload.formula?.candidates;
  assert.ok(Array.isArray(candidates) && candidates.length >= 1, "fixture 缺少候选方");
  delete candidates[0].decoction;
  assert.equal(
    normalizeReasoningV2(payload),
    undefined,
    "首选方缺 decoction 仍被归一放行——剂量安全语义被放宽了",
  );
});

check("ISO-备选方 备选非法只丢那一条，首选照常出参", () => {
  const payload = clone(BASE);
  const candidates = payload.formula?.candidates;
  assert.ok(Array.isArray(candidates) && candidates.length >= 1, "fixture 缺少候选方");
  const firstName = candidates[0].name;
  const broken = clone(candidates[0]);
  broken.positioning = "备选";
  delete broken.decoction;
  payload.formula.candidates = [...clone(candidates), broken].slice(0, 3);
  const normalized = normalizeReasoningV2(payload);
  assert.ok(normalized, "备选方非法导致整份 M04 作废（应只丢那一条）");
  assert.ok(Array.isArray(normalized.formula?.candidates), "候选方不是数组");
  assert.equal(normalized.formula.candidates[0]?.name, firstName, "首选方未原样保留");
  assert.equal(
    normalized.formula.candidates.length,
    Math.min(candidates.length, 3),
    "备选非法连坐了合法候选",
  );
});

check("ISO-健康调护 一条外治写歪不得带走 diet/lifestyle/emotion", () => {
  const payload = clone(BASE);
  assert.ok(payload.nonPharma?.diet, "fixture 缺少 nonPharma.diet");
  const diet = payload.nonPharma.diet;
  payload.nonPharma.tcmTreatments = [
    ...clone(payload.nonPharma.tcmTreatments || []),
    { projectCode: "NOT_A_CODE", projectName: "x" },
  ];
  const normalized = normalizeReasoningV2(payload);
  assert.ok(normalized, "外治非法导致整份拒收");
  assert.ok(normalized.nonPharma, "外治非法把整个 nonPharma 变成了 null——健康调护一起消失");
  assert.equal(normalized.nonPharma.diet, diet, "健康调护被外治连坐");
});

if (failures.length > 0) {
  console.error("归一层连坐守卫 FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ isolatedArrays: ISOLATED_ARRAYS.length, overlongFields: OVERLONG_FIELDS.length, failures: 0 }));

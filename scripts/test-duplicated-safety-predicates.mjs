/**
 * 同一判据两处各写各的——本仓头号缺陷形状。本套件钉住已收敛的两处，并守住收敛方向。
 *
 * 【① L4 确定性阻断：两条正则只差「严禁|禁止使用」】
 * 药味级 classifyHerbWarning 与病例级 deriveCaseWarningProfile 各写一条阻断正则，
 * 病例级少了 `严禁|禁止使用` 两个词——而这恰恰是最直白的禁用表述。实测：
 *   「本品严禁与含乌头类药材同用」 药味级 L4（阻断） / 病例级 **L0（常规信息，仅展示）**
 *   「禁止使用于孕妇」             药味级 L4         / 病例级 **L0**
 *   「配伍禁忌：十八反」「风险等级 CRITICAL」两级一致（L4/L4）
 * 差 4 个档位：一条明确禁用语在病例级被当成常规信息。已收敛为 L4_DETERMINISTIC_BLOCKING。
 *
 * 【② 心血管慢性稳定降级：只巡查 6 个受治理症状里的 3 个】
 * hasChronicStableExertionalCardiacOnly 的契约是「**所有**心血管提及都是慢性稳定」才降级，
 * 却只手抄了 胸痛/心前区痛/胸闷，缺 胸口压迫/胸骨后压榨感/胸口疼。两头都会错：
 *   · 漏检向：「胸痛3年劳累诱发（慢性稳定）」+「今日胸骨后压榨感（急性）」并存时，
 *     循环只看到胸痛、判定全部慢性稳定 ⇒ 降级生效，那个急性症状**从未被检查过**；
 *   · 误报向：纯口语「胸口疼3年、劳累诱发、休息缓解」不在枚举内 ⇒ 不降级，
 *     稳定性心绞痛病人每次复诊都弹红旗。
 * 已收敛为读 GOVERNED_CARDIAC_SYMPTOMS。
 *
 * 【口径】本套件断言的是「判据只有一份来源」，不是「某个具体病例的输出」——
 * 后者依赖一长串运行时状态，而缺陷的形状是**词表分叉**本身。
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
const { classifyHerbWarning, deriveCaseWarningProfile } = await jiti.import("../src/lib/clinical-warning-tier.ts");

const CASE_BASE = {
  id: "warn", phase: "prescribe", patient: { sex: "男", age: 50 },
  chiefComplaint: "胃脘痛", symptoms: { general: "胃脘痛", tcmFourExams: "" },
  tongue: "", pulse: "", vitals: "", labs: "",
  pastHistory: "", medicationHistory: "", allergyHistory: "",
  questionRounds: 1, maxQuestionRounds: 1, conversation: [],
  diagnosis: "", prescription: "", riskAssessment: "",
};

// ── 1. 两级对同一条风险语必须给出同一档位 ──────────────────────────────────
const BLOCKING_LINES = [
  "本品严禁与含乌头类药材同用",
  "禁止使用于孕妇",
  "配伍禁忌：十八反",
  "风险等级 CRITICAL",
  "审方结论：BLOCK",
  "绝对禁忌：孕妇忌服",
];
for (const line of BLOCKING_LINES) {
  const herb = classifyHerbWarning({ drug: "附子", safety: line });
  const caseLevel = deriveCaseWarningProfile({ ...CASE_BASE, riskAssessment: line });
  assert.equal(
    herb.level, "L4",
    `药味级应判 L4 阻断：「${line}」，实得 ${herb.level}`,
  );
  assert.equal(
    caseLevel.level, "L4",
    `病例级必须与药味级同档：「${line}」药味级=L4 而病例级=${caseLevel.level}。`
    + "两处各写一份阻断词表时，「严禁」「禁止使用」曾只在药味级命中，病例级把它当常规信息（L0）。",
  );
}

// ── 2. 否定式风险语不得被误判为阻断（收敛不得放宽既有排除）────────────────
const NEGATED_LINES = [
  "未发现十八反十九畏配伍禁忌",
  "已排除绝对禁忌",
  "未见配伍冲突",
];
for (const line of NEGATED_LINES) {
  const herb = classifyHerbWarning({ drug: "附子", safety: line });
  const caseLevel = deriveCaseWarningProfile({ ...CASE_BASE, riskAssessment: line });
  assert.notEqual(herb.level, "L4", `否定式不得判阻断（药味级）：「${line}」`);
  assert.notEqual(caseLevel.level, "L4", `否定式不得判阻断（病例级）：「${line}」`);
}

// ── 3. 源码级：判据只允许有一份来源 ────────────────────────────────────────
{
  const source = readFileSync(path.join(repoRoot, "src/lib/clinical-warning-tier.ts"), "utf8");
  assert.ok(
    /const L4_DETERMINISTIC_BLOCKING\s*=/.test(source),
    "L4 阻断判据必须是单一常量",
  );
  const inlineCopies = (source.match(/十八反\|十九畏\|配伍禁忌/g) || []).length;
  assert.equal(
    inlineCopies, 1,
    `阻断词表只允许出现一次（常量定义处）；实得 ${inlineCopies} 处。多一处就是又分叉了。`,
  );
}

// ── 4. 心血管慢性稳定降级必须读受治理词表，不得手抄 ────────────────────────
{
  const safety = readFileSync(path.join(repoRoot, "src/lib/diagnosis-safety.ts"), "utf8");
  const start = safety.indexOf("function hasChronicStableExertionalCardiacOnly");
  assert.ok(start >= 0, "找不到心血管慢性稳定降级判据");
  const body = safety.slice(start, safety.indexOf("\n}", start));
  assert.ok(
    /for \(const term of GOVERNED_CARDIAC_SYMPTOMS\)/.test(body),
    "必须遍历受治理 cardiac.symptoms 全集——手抄子集会让未枚举的急性症状无法否决降级",
  );
  assert.ok(
    !/\["胸痛", "心前区痛", "胸闷"\]/.test(body),
    "不得再出现手抄的三项子集",
  );
  // 受治理表确有 6 条，若表被缩减到 3 条，本条守卫会失效——一并钉住规模
  const lexicon = JSON.parse(readFileSync(path.join(repoRoot, "src/data/redflag-triage-lexicon.json"), "utf8"));
  const cardiac = lexicon.categoryRules.find((rule) => rule.id === "cardiac");
  assert.ok(
    cardiac.symptoms.length >= 6,
    `受治理 cardiac.symptoms 应至少 6 条（含胸口压迫/胸骨后压榨感/胸口疼），实得 ${cardiac.symptoms.length}`,
  );
}

console.log("test-duplicated-safety-predicates: OK", {
  blockingLines: BLOCKING_LINES.length,
  negatedControls: NEGATED_LINES.length,
});

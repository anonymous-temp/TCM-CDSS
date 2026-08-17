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

// ── 5. PHI 抬头姓名：两侧必须走同一判据，且不得误伤临床措辞 ────────────────
// 【背景】服务端 scrubPhi 与浏览器 scrubPersistentPhiText 各自在共享的
// scrubQuasiIdentifierText 之上叠了一套自己的姓名规则：服务端走上下文模式、
// 浏览器走百家姓枚举。行为实测（2026-08-16）：
//   「张伟，男，45岁」「欧阳明月，女，32岁」 服务端脱敏 / 浏览器**留存**
//     ——浏览器保护的是 localStorage 里的静态 PHI，而这正是标准 HIS 抬头格式。
// 而服务端那条只有「句首 2-4 字 + 性别/年龄」一个条件，靠「不该脱敏的词」黑名单兜底
// （患者/病人/患儿/本例…），黑名单挡不住临床措辞，实测把主诉开头整段吃掉：
//   「反复咳嗽，男，45岁」→「[已脱敏]，男，45岁」；「患者男，45岁」连「男」都被吃。
//   这是**送模型路径上的临床信息丢失**，不是显示问题。
// 【修法】共享 scrubRecordHeaderName 取「姓氏枚举 ∩ 上下文」正向交集，两侧共用。
{
  const { scrubRecordHeaderName } = await jiti.import("../src/lib/phi-sanitizer.ts");
  // 姓名必须脱敏（含复姓——单字姓枚举覆盖不到，两侧原本都漏）
  for (const [input, name] of [["张伟，男，45岁，主诉胃脘痛3天", "张伟"],
    ["欧阳明月，女，32岁，头痛", "欧阳明月"], ["李娜，女，28岁", "李娜"]]) {
    const out = scrubRecordHeaderName(input);
    assert.ok(!out.includes(name), `抬头姓名必须脱敏：「${input}」实得 ${out}`);
  }
  // 临床措辞必须逐字保留——这一半和上一半同等重要，缺了就会把主诉吃掉
  for (const input of ["反复咳嗽，男，45岁", "患者男，45岁，主诉胃脘痛", "初诊，女，32岁",
    "复诊 男 50岁", "既往体健，男，60岁", "胃脘痛3天，男，45岁"]) {
    assert.equal(
      scrubRecordHeaderName(input), input,
      `非姓名抬头必须逐字保留：「${input}」——误吃它等于在送模型路径上丢临床信息`,
    );
  }
  // 中点姓名：外籍译名与维吾尔/藏/蒙姓名的标准写法，百家姓枚举对它们结构上无效，
  // 实测（2026-08-17）两侧都留存。中点在本领域高频（书名与朝代作者引注、目录点线），
  // 但从不出现在「抬头 + 性别/年龄」位置——该正则对仓内 74 个数据文件、8 万余处中点误报 0。
  const { scrubSubjectPrefixedName, scrubRelationPrefixedName } = await jiti.import("../src/lib/phi-sanitizer.ts");
  for (const [input, name] of [["麦克·约翰逊，男，50岁，主诉咳嗽", "麦克·约翰逊"],
    ["玛丽·史密斯，女，32岁，头痛", "玛丽·史密斯"],
    ["阿依古丽·买买提，女，28岁", "阿依古丽·买买提"]]) {
    assert.ok(
      !scrubRecordHeaderName(input).includes(name),
      `中点姓名必须脱敏：「${input}」实得 ${scrubRecordHeaderName(input)}`,
    );
  }

  // 主语前缀（本例X）：原服务端规则无姓氏判定，在**送模型路径**上吃掉临床文本。
  // 「既往」被吃会把 historical 读成 positive——本系统整套临床状态词汇建立在这个区分上。
  assert.ok(
    !scrubSubjectPrefixedName("本例赵敏既往有高血压").includes("赵敏"),
    "主语前缀后的姓名必须脱敏：「本例赵敏既往有高血压」",
  );
  for (const input of ["本例患者既往有高血压", "本例患儿出现发热", "该患者既往有糖尿病",
    "病人自诉头痛3天", "本例舌红苔黄，脉弦数"]) {
    assert.equal(
      scrubSubjectPrefixedName(input), input,
      `主语前缀后的临床措辞必须逐字保留：「${input}」——`
      + "「患儿」被吃丢的是儿科信号，「既往」被吃会把既往史读成现症",
    );
  }

  // 关系前缀（家属X）：原规则两个方向都错——误吃主诉、又漏掉「代述/签字」。
  for (const [input, name] of [["家属王强代述病情", "王强"], ["监护人张伟签字", "张伟"],
    ["患者李娜诉头痛", "李娜"], ["家属王强反映病情", "王强"]]) {
    assert.ok(
      !scrubRelationPrefixedName(input).includes(name),
      `关系前缀后的姓名必须脱敏：「${input}」实得 ${scrubRelationPrefixedName(input)}`,
    );
  }
  for (const input of ["家属代述，患者昨夜失眠", "患者自诉头痛，家属补充夜间加重",
    "家属陪同就诊", "患者否认过敏史", "医生建议复查", "监护人签字确认", "家属诉患者食欲差"]) {
    assert.equal(
      scrubRelationPrefixedName(input), input,
      `关系前缀后的临床措辞必须逐字保留：「${input}」——`
      + "「患者自诉头痛，…」曾被整段吃成「患者[已脱敏]，…」，主诉在送模型前就没了",
    );
  }

  // 两侧必须共用同一判据，不得再各写一份
  const safety = readFileSync(path.join(repoRoot, "src/lib/diagnosis-safety.ts"), "utf8");
  const engine = readFileSync(path.join(repoRoot, "src/lib/diagnosis-engine.ts"), "utf8");
  for (const [label, src] of [["服务端", safety], ["浏览器", engine]]) {
    for (const shared of ["scrubRecordHeaderName", "scrubSubjectPrefixedName", "scrubRelationPrefixedName"]) {
      assert.ok(
        new RegExp(`${shared}\\(`).test(src),
        `${label}必须调用共享的 ${shared}——四条姓名规则两侧各写各的是本缺口的成因`,
      );
    }
  }
  // 行内副本不得复活
  assert.ok(
    !/\(本例\|该患者\|病例\|病人\|患儿\)\\s\*\[\\u4e00-\\u9fa5\]\{2,4\}/.test(safety),
    "服务端不得再保留行内的主语前缀姓名正则——它没有姓氏正向判定，会吃掉「患儿」「既往」",
  );
  assert.ok(
    !/\^\(\[\\u4e00-\\u9fa5\]\{2,4\}\)\(\?=\[，,；。/.test(safety),
    "服务端不得再保留自己那份句首姓名正则——它没有姓氏正向判定，会吃掉临床措辞",
  );
}

console.log("test-duplicated-safety-predicates: OK", {
  blockingLines: BLOCKING_LINES.length,
  negatedControls: NEGATED_LINES.length,
});

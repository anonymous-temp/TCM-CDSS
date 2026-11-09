// 第三十九轮（2026-11-09）：西医诊断依据在病名定稿之后按诊断要点单独写（western-basis-authoring.server.ts）。
// 每条断言都有反证（~/runlogs/r1018/work/r1051/cp/）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CONTROLLED_TERMINOLOGY_MODEL", "BAILIAN_QWEN_API_KEY"]) delete process.env[key];
delete process.env.CDSS_WESTERN_BASIS_AUTHORING;

const basis = await jiti.import("../src/lib/western-basis-authoring.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

// 合成病历（不是评测集病例）。
const RECORD = "患者男，45岁。上腹胀痛2月，餐后明显，嗳气后减轻。无呕血、黑便，无消瘦。否认胆囊结石病史。胃镜未做。";
const NAME = "消化不良待查";
const good = () => ({
  summary: "慢性餐后上腹胀痛",
  criteria: [{ point: "上腹痛或餐后饱胀不适", quote: "上腹胀痛2月" }],
  negatives: [{ point: "无报警征象", quote: "无呕血、黑便" }],
  level: "未做胃镜，尚不能区分功能性与器质性",
  exclude: ["慢性胃炎", "消化性溃疡"],
  text: "慢性餐后上腹胀痛，嗳气后减轻，属上腹痛或餐后饱胀不适的消化不良表现；未诉报警征象；未做胃镜，尚不能区分功能性与器质性，暂作消化不良待查；需排除慢性胃炎、消化性溃疡。",
});
const ctx = (extra = {}) => ({ name: NAME, recordText: RECORD, listedNames: ["慢性胃炎", "消化性溃疡", "胆囊结石"], ...extra });
const issue = (proposal, extra) => basis.westernBasisIssue(proposal, ctx(extra));

// ───── 1 提纲与成句的核对 ─────
await check("1.1 要点原文出自病历、成句写着诊断名、覆盖要点/层级/需排除：合格", () => {
  assert.equal(issue(good()), undefined);
});

await check("1.2 成句没写诊断名 → text_misses_name（医生要读到「符合/暂作 X」）", () => {
  const p = good();
  p.text = p.text.replaceAll("消化不良", "胃部不适");
  assert.equal(issue(p), "text_misses_name");
});

await check("1.3 要点原文对在病历的否认处（「消瘦」只出现在「无消瘦」里）不算 → 一条不剩时 no_grounded_criteria；引文自带否认开头的整句算", () => {
  const p = good();
  p.criteria = [{ point: "体重下降", quote: "消瘦" }];
  assert.equal(issue(p), "no_grounded_criteria");
  const q = good();
  q.criteria = [{ point: "上腹痛或餐后饱胀不适", quote: "上腹胀痛2月" }, { point: "排除报警征象", quote: "无呕血、黑便" }];
  assert.equal(basis.groundedWesternBasisItems(q, ctx()).criteria.length, 2);
});

await check("1.4 阴性所见不出自病历的单条去掉、不作废整份（模型把阳性症状或自写的「未诉…」填进来）", () => {
  const p = good();
  p.negatives = [{ point: "无发热", quote: "无发热" }, { point: "无报警征象", quote: "无呕血、黑便" }];
  assert.equal(issue(p), undefined);
  assert.deepEqual(basis.groundedWesternBasisItems(p, ctx()).negatives.map((item) => item.quote), ["无呕血、黑便"]);
});

await check("1.5 句中数字要出自病历；诊断要点表的门槛数字（6个月）算", () => {
  const p = good();
  p.text = p.text.replace("慢性餐后上腹胀痛", "慢性餐后上腹胀痛3月");
  assert.equal(issue(p), "number_not_in_record");
  const q = good();
  q.text = q.text.replace("未做胃镜", "病程未满6个月、未做胃镜");
  const criteria = { name: "功能性消化不良", clinicallyDiagnosable: false, requiredTests: ["胃镜"], durationThreshold: "症状出现至少6个月", definingFeatures: ["上腹痛或餐后饱胀不适"], quote: "", url: "", siteName: "", title: "", retrievedAt: "" };
  assert.equal(issue(q, { criteria }), undefined);
});

await check("1.6 不写中医证候（「…证」「中医」）；「证据」「确证」不算", () => {
  const p = good();
  p.text = p.text.replace("；未诉报警征象", "，属肝胃不和证；未诉报警征象");
  assert.equal(issue(p), "text_names_tcm");
  const q = good();
  q.text = q.text.replace("尚不能区分", "尚无证据区分");
  q.level = "未做胃镜，尚无证据区分功能性与器质性";
  assert.equal(issue(q), undefined);
});

await check("1.6b 成句不讲病历本身（「病历载」「病历未记录」）→ text_meta", () => {
  const p = good();
  p.text = p.text.replace("未诉报警征象", "病历未记录报警征象");
  assert.equal(issue(p), "text_meta");
});

await check("1.6c 性别、年龄段要有病历依据（病历没写就不写「中年男性」）", () => {
  const p = good();
  p.text = p.text.replace("慢性餐后上腹胀痛", "中年男性，慢性餐后上腹胀痛");
  assert.equal(issue(p), undefined, "病历写了男、45岁");
  assert.equal(basis.demographicNotInRecord("中年男性，上腹胀痛", "上腹胀痛2月"), true);
  assert.equal(basis.demographicNotInRecord("中年患者，上腹胀痛", "患者女，上腹胀痛2月"), true);
  assert.equal(basis.demographicNotInRecord("中年女性，上腹胀痛", "患者女，52岁，上腹胀痛2月"), false);
  assert.equal(issue(p, { recordText: RECORD.replace("患者男，45岁。", "") }), "demographic_not_in_record");
});

await check("1.7 成句大半是照抄病历的连续片段 → recital", () => {
  const p = good();
  p.text = "上腹胀痛2月，餐后明显，嗳气后减轻。无呕血、黑便，无消瘦。胃镜未做，暂作消化不良待查。";
  p.level = "胃镜未做";
  p.exclude = [];
  assert.ok(basis.westernBasisRecitalRatio(p.text, RECORD) > 0.6);
  assert.equal(issue(p), "recital");
});

await check("1.8 诊断名不带「待查」时句中写「待查」→ text_contradicts_name", () => {
  const p = good();
  p.text = p.text.replace("暂作消化不良待查", "符合功能性消化不良，病因待查");
  assert.equal(issue(p, { name: "功能性消化不良" }), "text_contradicts_name");
});

await check("1.9 需排除的病要写进成句；需排除的不能是主诊断本身", () => {
  const p = good();
  p.exclude = ["慢性胃炎", "胆汁反流性胃炎"];
  assert.equal(issue(p), "text_misses_exclude");
  const q = good();
  q.exclude = ["消化不良"];
  assert.equal(issue(q), "exclude_is_primary");
});

await check("1.10 成句提到候选/鉴别里的别的病却没列为需排除 → 不合格；病历自己否认的病（阴性所见原文里）不算", () => {
  const p = good();
  p.text = p.text.replace("；未诉报警征象", "，胆囊结石亦可引起；未诉报警征象");
  assert.equal(issue(p), "text_names_undeclared_disease");
  const q = good();
  q.negatives = [{ point: "无胆道病史", quote: "否认胆囊结石病史" }];
  q.text = q.text.replace("；未诉报警征象", "；否认胆囊结石病史");
  assert.equal(issue(q), undefined);
});

await check("1.11 有诊断要点表时要点只能取自表（与表文字无共同词的那条去掉）", () => {
  const criteria = { name: "功能性消化不良", clinicallyDiagnosable: false, requiredTests: ["胃镜"], durationThreshold: "", definingFeatures: ["餐后饱胀不适", "早饱感", "上腹痛"], quote: "", url: "", siteName: "", title: "", retrievedAt: "" };
  const p = good();
  p.criteria = [{ point: "情志诱发", quote: "嗳气后减轻" }];
  assert.equal(issue(p, { criteria }), "no_grounded_criteria");
  assert.equal(issue(good(), { criteria }), undefined);
});

await check("1.12 成句要写到层级（为什么写到这一级）与每条要点", () => {
  const p = good();
  p.level = "需肠镜与血常规评估贫血原因";
  assert.equal(issue(p), "text_misses_level");
  const q = good();
  q.criteria = [{ point: "上腹痛或餐后饱胀不适", quote: "上腹胀痛2月" }, { point: "胆道病史", quote: "否认胆囊结石病史" }];
  assert.equal(issue(q), "text_misses_criteria");
});

await check("1.13 待查写法按核心名查要点表；模型输出解析：没有 text 不算", () => {
  assert.equal(basis.westernNameCore("消化不良待查"), "消化不良");
  assert.equal(basis.parseWesternBasisProposal(JSON.stringify({ criteria: [] })), undefined);
  const parsed = basis.parseWesternBasisProposal(JSON.stringify({ ...good(), criteria: [...good().criteria, ...good().criteria, ...good().criteria, ...good().criteria] }));
  assert.equal(parsed.criteria.length, 3);
});

// ───── 2 落到最终西医内容 ─────
const western = (name = NAME) => JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: "原依据" }, candidates: [{ name: "慢性胃炎" }], differentials: [{ name: "消化性溃疡" }] } });
const rationaleOf = (content) => JSON.parse(content).westernDiagnosis.primary.clinicalRationale;
const context = { recordText: RECORD, chiefComplaint: "上腹胀痛2月" };

await check("2.1 按最终病名写的、核对全过：换掉 clinicalRationale", async () => {
  const out = await basis.withAuthoredWesternBasis(western(), context, Promise.resolve({ name: NAME, proposal: good() }));
  assert.equal(rationaleOf(out), good().text);
});

await check("2.2 核对不过：保留模型原来那句", async () => {
  const p = good();
  p.text = p.text.replaceAll("消化不良", "胃部不适");
  const out = await basis.withAuthoredWesternBasis(western(), context, Promise.resolve({ name: NAME, proposal: p }));
  assert.equal(rationaleOf(out), "原依据");
});

await check("2.3 先起的那份是按核对前的病名写的（病名已被核对改掉）：不用它；再写一次失败时保留原样", async () => {
  // 先起的一份（按「功能性消化不良」写）恰好也能过最终病名的核对：照样不用，按最终病名重写（本测无模型，重写失败）。
  const out = await basis.withAuthoredWesternBasis(western(), context, Promise.resolve({ name: "功能性消化不良", proposal: good() }));
  assert.equal(rationaleOf(out), "原依据");
});

await check("2.4 开关 CDSS_WESTERN_BASIS_AUTHORING=false：原样", async () => {
  process.env.CDSS_WESTERN_BASIS_AUTHORING = "false";
  try {
    const out = await basis.withAuthoredWesternBasis(western(), context, Promise.resolve({ name: NAME, proposal: good() }));
    assert.equal(rationaleOf(out), "原依据");
  } finally {
    delete process.env.CDSS_WESTERN_BASIS_AUTHORING;
  }
});

await check("2.5 诊断路由：依据在病名收尾（finalizeWesternPrimaryName）之后落，先起的一份与核对并行", () => {
  const route = fs.readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  const start = route.indexOf("m03WesternHalfTransform:");
  assert.ok(start > 0);
  const body = route.slice(start, route.indexOf("truncateFallback:", start));
  const draftAt = body.indexOf("authorWesternBasis(westernContent");
  const alignAt = body.indexOf("alignWesternPrimaryAndName(");
  const finalizeAt = body.indexOf("finalizeWesternPrimaryName(");
  const applyAt = body.indexOf("withAuthoredWesternBasis(finalized");
  assert.ok(draftAt > 0 && draftAt < alignAt, "先起的一份要在核对之前发出");
  assert.ok(finalizeAt > 0 && applyAt > finalizeAt, "落到内容要在病名收尾之后");
});

// ───── 3 交付面 ─────
await check("3.1 交付的诊断依据里紧挨着一字不差的两个小句只留一个；读回时仍认得这一句", () => {
  const w = { primary: { name: "头痛", clinicalRationale: "产后起病、头痛反复，生命体征平稳，否认突发最剧烈头痛；否认突发最剧烈头痛，符合原发性头痛。" } };
  const delivered = surface.deliveredWesternBasis(w);
  assert.equal(delivered, "产后起病、头痛反复，生命体征平稳，否认突发最剧烈头痛，符合原发性头痛。");
  assert.equal(surface.isDeliveredWesternBasisOnly([delivered], w), true);
});

console.log(JSON.stringify({ suite: "r1051-main", failures: process.exitCode ? "see above" : 0 }));

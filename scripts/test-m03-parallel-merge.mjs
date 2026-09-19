import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildM03ParallelHalfSuffix, m03ParallelGenerationEnabled, mergeParallelM03Halves, parseM03WesternHalf } =
  await jiti.import("../src/lib/m03-parallel-merge.ts");
const { readFileSync } = await import("node:fs");
const { normalizeReasoningV2 } = await jiti.import("../src/lib/diagnosis-types.ts");

let cases = 0;
let failures = 0;
function check(name, fn) {
  cases += 1;
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}:`, error?.message || error);
  }
}

// ── 开关语义 ──────────────────────────────────────────────────────────────────
check("默认并行开启；仅显式 false 关闭（大小写/空白不敏感）", () => {
  delete process.env.M03_PARALLEL_GENERATION;
  assert.equal(m03ParallelGenerationEnabled(), true);
  process.env.M03_PARALLEL_GENERATION = "false";
  assert.equal(m03ParallelGenerationEnabled(), false);
  process.env.M03_PARALLEL_GENERATION = " FALSE ";
  assert.equal(m03ParallelGenerationEnabled(), false);
  process.env.M03_PARALLEL_GENERATION = "true";
  assert.equal(m03ParallelGenerationEnabled(), true);
  process.env.M03_PARALLEL_GENERATION = "unexpected";
  assert.equal(m03ParallelGenerationEnabled(), true);
  delete process.env.M03_PARALLEL_GENERATION;
});

// ── 半区提示词后缀：字段清单是分工契约，钉住防漂移 ────────────────────────────
check("西医半后缀声明自己的字段并显式豁免另一半", () => {
  const suffix = buildM03ParallelHalfSuffix("western");
  assert.match(suffix, /并行分工·西医半/);
  assert.match(suffix, /westernDiagnosis、management/);
  assert.match(suffix, /overview、pathogenesis、therapy、lineageAdaptation 由并行进程负责/);
  assert.match(suffix, /仅含以下字段的 JSON 对象：westernDiagnosis、management。/);
  assert.match(suffix, /schemaVersion、stage、formula、nonPharma、pathogenesis.summary 及各层 evidence 均由服务端生成/);
  assert.match(suffix, /不违反上文完整性要求/);
});
check("中医半后缀声明自己的字段并显式豁免另一半", () => {
  const suffix = buildM03ParallelHalfSuffix("tcm");
  assert.match(suffix, /并行分工·中医半/);
  assert.match(suffix, /仅含以下字段的 JSON 对象：overview、pathogenesis、therapy、lineageAdaptation。/);
  assert.match(suffix, /schemaVersion、stage、formula、nonPharma、pathogenesis.summary 及各层 evidence 均由服务端生成/);
  assert.match(suffix, /westernDiagnosis 与 management 由并行进程负责/);
  assert.match(suffix, /pathogenesis\.chain 必须至少有 1 个完整节点/);
  assert.match(suffix, /patientFact 和 syndromeEvidence 都必须各自.*逐字复制一段连续原文/);
});

// ── 合并语义 ──────────────────────────────────────────────────────────────────
const tcmHalf = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "心脾两虚证", primarySyndromeResolution: "bounded", primarySyndromeBasis: ["入睡困难"], overallPathogenesis: "心脾两虚", overallTherapy: "补益心脾", recommendedFormulaDirection: "归脾汤加减", evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } },
  pathogenesis: { summary: "思虑劳倦伤及心脾", locationDifferentiation: { items: ["心", "脾"], resolution: "bounded", evidence: { evidenceLevel: "model_inference", source: "本例四诊", confidence: "中" } }, natureDifferentiation: { items: ["气虚"], resolution: "bounded", evidence: { evidenceLevel: "model_inference", source: "本例四诊", confidence: "中" } }, chain: [{ nodeId: "P1", patientFact: "入睡困难", syndromeEvidence: "入睡困难", pathogenesis: "心神失养", therapyDirection: "养心安神", evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" } }], uncertainties: [] },
  therapy: { overallPrinciple: "扶正祛邪", overallMethod: "补益心脾", subTherapies: [{ therapy: "养心安神", targetPathogenesis: "心神失养", priority: "主要", evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" } }] },
  formula: null,
  nonPharma: null,
};
const westernHalf = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  westernDiagnosis: { primary: { name: "非器质性失眠", status: "考虑", confidence: "中", supportingFacts: ["入睡困难3月"], clinicalRationale: "病程逾月的入睡困难支持将非器质性失眠作为当前工作判断", limitations: ["未评估情绪量表"], suggestedChecks: ["睡眠日记"], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" } }, differentials: [] },
  management: { mustCollect: ["情绪状态"], followupSafetyNet: "两周复诊；失眠加重或出现情绪低落及时就诊" },
};

check("干净两半合并：全字段齐备且顶层身份规范化", () => {
  const merged = mergeParallelM03Halves(JSON.stringify(tcmHalf), JSON.stringify(westernHalf));
  assert.ok(merged);
  const parsed = JSON.parse(merged);
  assert.equal(parsed.schemaVersion, "tcm-cdss-reasoning-v2");
  assert.equal(parsed.stage, "diagnose");
  assert.equal(parsed.overview.primarySyndrome, "心脾两虚证");
  assert.equal(parsed.westernDiagnosis.primary.name, "非器质性失眠");
  assert.equal(parsed.management.mustCollect[0], "情绪状态");
  assert.equal(parsed.formula, null);
  assert.equal(parsed.nonPharma, null);
});

check("合并结果能通过 normalizeReasoningV2（进入既有契约链路的形状）", () => {
  const merged = mergeParallelM03Halves(JSON.stringify(tcmHalf), JSON.stringify(westernHalf));
  const normalized = normalizeReasoningV2(JSON.parse(merged));
  assert.ok(normalized, "normalizeReasoningV2 必须接受合并后的载荷");
  assert.equal(normalized.stage, "diagnose");
  // 病名可能被受控术语层规范化（如 非器质性失眠→慢性失眠障碍），只要求非空保留。
  assert.ok(normalized.westernDiagnosis.primary.name.trim().length > 0);
});

check("半区身份字段写错也被规范化，越界字段被忽略", () => {
  const disobedientWestern = {
    ...westernHalf,
    stage: "prescribe",
    schemaVersion: "wrong",
    overview: { primarySyndrome: "越界的证型——必须被忽略" },
  };
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmHalf), JSON.stringify(disobedientWestern)));
  assert.equal(merged.stage, "diagnose");
  assert.equal(merged.schemaVersion, "tcm-cdss-reasoning-v2");
  assert.equal(merged.overview.primarySyndrome, "心脾两虚证", "西医半越界的 overview 不得覆盖中医半");
});

check("西医半缺席：合并继续但不含 westernDiagnosis（归一落默认占位 + T2 批注，不会触发重生成）", () => {
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmHalf), undefined));
  assert.equal(merged.westernDiagnosis, undefined);
  assert.equal(merged.overview.primarySyndrome, "心脾两虚证");
  assert.equal(parseM03WesternHalf(undefined).status, "absent");
  // 这正是页面显示「当前未形成可复核的西医工作诊断」的来源——所以能救回来的西医半必须救回来。
  assert.equal(normalizeReasoningV2(merged).westernDiagnosis.primary.name, "症状性诊断，病因待临床鉴别");
});

check("西医半缺席但中医半（不听话地）带出合法西医字段：采用中医半版本，省一轮重生成", () => {
  const tcmWithWestern = { ...tcmHalf, westernDiagnosis: westernHalf.westernDiagnosis, management: westernHalf.management };
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmWithWestern), undefined));
  assert.equal(merged.westernDiagnosis.primary.name, "非器质性失眠");
  assert.equal(merged.management.followupSafetyNet, westernHalf.management.followupSafetyNet);
});

check("中医半不可解析：合并放弃（调用方保留原始输出走既有截断/挽救路径）", () => {
  assert.equal(mergeParallelM03Halves("{\"overview\": 截断在这里", JSON.stringify(westernHalf)), undefined);
  assert.equal(mergeParallelM03Halves("", JSON.stringify(westernHalf)), undefined);
});

check("对不听话的包装保持宽容：sentinel、代码围栏、前后缀散文都能解析", () => {
  const wrapped = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(tcmHalf)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const fenced = "```json\n" + JSON.stringify(westernHalf) + "\n```";
  const prosed = `以下是结果：\n${JSON.stringify(westernHalf)}\n以上。`;
  assert.ok(mergeParallelM03Halves(wrapped, fenced));
  const merged = JSON.parse(mergeParallelM03Halves(wrapped, prosed));
  assert.equal(merged.westernDiagnosis.primary.name, "非器质性失眠");
});

check("复核重生成路径：新中医半 + 被拒完整 JSON → 西医半原样保留复用", () => {
  const rejectedFull = { ...tcmHalf, westernDiagnosis: westernHalf.westernDiagnosis, management: westernHalf.management };
  const freshTcm = { ...tcmHalf, overview: { ...tcmHalf.overview, primarySyndrome: "肝郁脾虚证" } };
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(freshTcm), JSON.stringify(rejectedFull)));
  assert.equal(merged.overview.primarySyndrome, "肝郁脾虚证", "中医半必须采用重生成结果");
  assert.equal(merged.westernDiagnosis.primary.name, "非器质性失眠", "西医半必须来自被拒 JSON 的保留版本");
  assert.equal(merged.management.mustCollect[0], "情绪状态");
});

check("formula 恒为 null：中医半误写内容也被确定性钉回（M03 不得携带方药组成）", () => {
  const tcmWithFormula = { ...tcmHalf, formula: { candidates: [{ name: "归脾汤", herbs: [] }] } };
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmWithFormula), JSON.stringify(westernHalf)));
  assert.equal(merged.formula, null);
});

// ── 线上实测：DeepSeek json_object 交回的西医半是非法 JSON（2026-09-19）──────────────
// fixture 是本机 dev server（线上同配置）逐字捕获的 6 份原始 content：顶层被提前闭合后
// 又以 `,"management":…}` 续写，primary 的 suggestedChecks / guidelineRefs 被写到外层。
// 修复前合并层整段丢弃 → 签名落默认占位 → 甲方 9/17–9/18 看到西医诊断一栏空着。
const captured = JSON.parse(readFileSync(new URL("./fixtures/m03-western-half-deepseek-misnested-20260919.json", import.meta.url), "utf8")).samples;
check("fixture 本身确实是非法 JSON（否则下面的修复断言会空转）", () => {
  assert.equal(captured.length, 6);
  for (const sample of captured) assert.throws(() => JSON.parse(sample.content), SyntaxError, sample.case);
});
for (const sample of captured) {
  check(`实采错位西医半可救回：${sample.case}`, () => {
    const parsed = parseM03WesternHalf(sample.content);
    assert.equal(parsed.status, "recovered");
    assert.ok(parsed.relocatedFields.includes("westernDiagnosis.primary.suggestedChecks"),
      "写到顶层的 suggestedChecks 必须归位到 primary");
    const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmHalf), sample.content));
    assert.equal(merged.westernDiagnosis.primary.name, sample.expectedPrimaryName);
    assert.equal(merged.suggestedChecks, undefined, "合并结果顶层不得残留西医半的错位字段");
    const normalized = normalizeReasoningV2(merged);
    assert.equal(normalized.westernDiagnosis.primary.name, sample.expectedPrimaryName,
      "归一后仍是模型给出的诊断，不是默认占位");
    assert.ok(normalized.westernDiagnosis.differentials.length > 0, "鉴别诊断随西医半一起回来");
    assert.ok((normalized.management?.mustCollect || []).length > 0, "补录项随西医半一起回来");
  });
}

// ── 合成用例：把结构修复与归位的边界钉清楚 ─────────────────────────────────────
const primaryOnly = { name: "失眠障碍", status: "考虑", confidence: "中", supportingFacts: ["入睡困难"], limitations: ["未做量表"] };
check("管理段先写、错位字段后写的变体同样可救（实采 #3 的形态）", () => {
  const raw = `{"westernDiagnosis":{"primary":${JSON.stringify(primaryOnly)},"differentials":[]},"management":{"mustCollect":["情绪状态"]}},"suggestedChecks":["睡眠日记"],"guidelineRefs":[{"evidenceId":"EVID-GUIDE-001","appliesTo":"失眠诊断"}]}`;
  const parsed = parseM03WesternHalf(raw);
  assert.equal(parsed.status, "recovered");
  assert.deepEqual(parsed.value.westernDiagnosis.primary.suggestedChecks, ["睡眠日记"]);
  assert.equal(parsed.value.westernDiagnosis.primary.guidelineRefs[0].evidenceId, "EVID-GUIDE-001");
  assert.deepEqual(parsed.value.management.mustCollect, ["情绪状态"]);
});
check("字符串里的花括号、引号与转义不干扰括号计深", () => {
  const tricky = { ...primaryOnly, clinicalRationale: "记录为 \"}{\" 与 `},\"x\":` 字样，不是结构 \\ 也不是 ]" };
  const raw = `{"westernDiagnosis":{"primary":${JSON.stringify(tricky)}},"suggestedChecks":["复查"]},"management":{"followupSafetyNet":"两周复诊"}}`;
  const parsed = parseM03WesternHalf(raw);
  assert.equal(parsed.status, "recovered");
  assert.equal(parsed.value.westernDiagnosis.primary.clinicalRationale, tricky.clinicalRationale, "字符串内容逐字保留");
  assert.deepEqual(parsed.value.westernDiagnosis.primary.suggestedChecks, ["复查"]);
  assert.equal(parsed.value.management.followupSafetyNet, "两周复诊");
});
check("归位不覆盖写在正确位置的同名字段", () => {
  const raw = JSON.stringify({ westernDiagnosis: { primary: { ...primaryOnly, suggestedChecks: ["正确位置的检查"] } }, suggestedChecks: ["错位的检查"] });
  const parsed = parseM03WesternHalf(raw);
  assert.equal(parsed.status, "clean", "合法 JSON 且无可归位字段时就是 clean");
  assert.deepEqual(parsed.value.westernDiagnosis.primary.suggestedChecks, ["正确位置的检查"]);
  assert.equal(parsed.value.suggestedChecks, undefined);
});
check("合法 JSON 但字段写错层级：归位后记为 recovered", () => {
  const raw = JSON.stringify({ westernDiagnosis: { primary: primaryOnly }, differentials: [{ name: "焦虑障碍", reason: "需排除", distinguishingPoints: "情绪量表", nextCheck: "GAD-7" }], mustCollect: ["情绪"] });
  const parsed = parseM03WesternHalf(raw);
  assert.equal(parsed.status, "recovered");
  assert.deepEqual(parsed.relocatedFields.sort(), ["management.mustCollect", "westernDiagnosis.differentials"]);
  assert.equal(parsed.value.westernDiagnosis.differentials[0].name, "焦虑障碍");
  assert.deepEqual(parsed.value.management.mustCollect, ["情绪"]);
});
check("没有 primary 时不凭空造诊断", () => {
  const parsed = parseM03WesternHalf(JSON.stringify({ westernDiagnosis: {}, suggestedChecks: ["血常规"] }));
  assert.equal(parsed.value.westernDiagnosis.primary, undefined);
});
check("救不回来的仍按不可用处理：截断、散文、无西医字段", () => {
  for (const raw of [
    `{"westernDiagnosis":{"primary":{"name":"失眠障碍","supportingFacts":["入睡困难`,
    "抱歉，我无法给出诊断。",
    JSON.stringify({ unrelated: true }),
  ]) {
    assert.equal(parseM03WesternHalf(raw).status, "unparseable", raw.slice(0, 40));
    assert.equal(JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmHalf), raw)).westernDiagnosis, undefined);
  }
});
check("完整西医对象后面跟截断尾巴：沿用既有首尾截取，保住完整部分（不是提前闭合修复的职责）", () => {
  const parsed = parseM03WesternHalf(`{"westernDiagnosis":{"primary":${JSON.stringify(primaryOnly)}}},"management"`);
  assert.equal(parsed.value.westernDiagnosis.primary.name, "失眠障碍");
});
check("中医半同样享有提前闭合修复（合并不再因同一种错位放弃整份）", () => {
  const { overview, ...rest } = tcmHalf;
  const raw = `{"overview":${JSON.stringify(overview)}},${JSON.stringify(rest).slice(1)}`;
  assert.throws(() => JSON.parse(raw), SyntaxError);
  const merged = JSON.parse(mergeParallelM03Halves(raw, JSON.stringify(westernHalf)));
  assert.equal(merged.overview.primarySyndrome, "心脾两虚证");
  assert.equal(merged.pathogenesis.chain[0].nodeId, "P1");
});

console.log(JSON.stringify({ cases, failures }));
if (failures > 0) process.exit(1);

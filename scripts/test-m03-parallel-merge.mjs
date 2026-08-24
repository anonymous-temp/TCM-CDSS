import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildM03ParallelHalfSuffix, m03ParallelGenerationEnabled, mergeParallelM03Halves } =
  await jiti.import("../src/lib/m03-parallel-merge.ts");
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
  assert.match(suffix, /overview、pathogenesis、therapy、formula、nonPharma、lineageAdaptation 由并行进程负责/);
  assert.match(suffix, /不违反上文完整性要求/);
});
check("中医半后缀声明自己的字段并显式豁免另一半", () => {
  const suffix = buildM03ParallelHalfSuffix("tcm");
  assert.match(suffix, /并行分工·中医半/);
  assert.match(suffix, /overview、pathogenesis、therapy、formula、nonPharma、lineageAdaptation/);
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

check("西医半缺席：合并继续但不含 westernDiagnosis（交给 western_support_empty 契约自愈）", () => {
  const merged = JSON.parse(mergeParallelM03Halves(JSON.stringify(tcmHalf), undefined));
  assert.equal(merged.westernDiagnosis, undefined);
  assert.equal(merged.overview.primarySyndrome, "心脾两虚证");
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

console.log(JSON.stringify({ cases, failures }));
if (failures > 0) process.exit(1);

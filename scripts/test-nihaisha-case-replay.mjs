import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src` },
});
const {
  buildM02ClassicDiscriminationContext,
  buildM03SevenStageContext,
  evaluateFormulaCandidates,
  formulaDiscriminationPaths,
} = await jiti.import("../src/lib/tcm-classic-inference.ts");
const { buildM04ClassicSafetyContext } = await jiti.import("../src/lib/tcm-classic-context.server.ts");

const corpus = JSON.parse(readFileSync(new URL("../src/data/tcm-classic-case-eval-corpus.json", import.meta.url), "utf8"));
const forbidden = /疫苗|生附子|硫磺|刺血|放血|童子尿|人尿|拒绝.{0,16}(?:急诊|手术|化疗|放疗)|\d+\s*(?:克|g|钱|两)|每日.{0,8}(?:服|次)/i;

const replayable = corpus.cases.flatMap((item) => {
  if (!item.replayEligible) return [];
  const state = {
    id: item.caseId,
    phase: "question",
    patient: {},
    chiefComplaint: item.replayInput,
    symptoms: {},
    questionRounds: 0,
    maxQuestionRounds: 1,
    conversation: [],
  };
  const m02 = buildM02ClassicDiscriminationContext(state);
  const m03 = buildM03SevenStageContext(state);
  const m04 = buildM04ClassicSafetyContext(item.expectedFormulaNames, item.replayInput);
  if (!m02 || !m03 || !m04) return [];
  return [{
    item,
    m02,
    m03,
    m04,
    candidates: evaluateFormulaCandidates(item.replayInput, 8),
    paths: formulaDiscriminationPaths(item.expectedFormulaNames, item.replayInput),
  }];
}).slice(0, 30);

assert.equal(replayable.length, 30, "T16 must provide thirty source-derived cases that traverse the M02→M03→M04 governed chain");
for (const replay of replayable) {
  assert.doesNotMatch(replay.item.replayInput, forbidden, `${replay.item.caseId}: replay input must be safety-scrubbed`);
  assert.doesNotMatch(replay.m02 + replay.m03 + replay.m04, forbidden, `${replay.item.caseId}: governed contexts must not reintroduce quarantined instructions`);
  assert.match(replay.m02, /信息增益=/, `${replay.item.caseId}: M02 must use information-gain ranking`);
  assert.match(replay.m03, /确定性候选收敛|本例优先鉴别节点/, `${replay.item.caseId}: M03 must consume the governed inference path`);
  assert.match(replay.m04, /受控方证鉴别、经典依据与禁忌矩阵/, `${replay.item.caseId}: M04 must expose the governed formula path`);
  assert.ok(
    replay.candidates.length > 0 || replay.paths.length > 0,
    `${replay.item.caseId}: replay must reach a governed candidate or adjacent-formula edge`,
  );
  assert.ok(replay.paths.every((path) => ["confirmed", "absent", "unknown"].includes(path.status)));
}

console.log(JSON.stringify({
  corpusRecords: corpus.cases.length,
  replayPool: corpus.cases.filter((item) => item.replayEligible).length,
  replayed: replayable.length,
  sanitizedFromQuarantinedSources: replayable.filter((item) => item.item.containsQuarantinedContent).length,
  failures: 0,
}, null, 2));

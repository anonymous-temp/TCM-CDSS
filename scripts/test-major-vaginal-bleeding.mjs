// 真实公开崩漏病案触发的类级回归：阴道出血词序/量词/客观贫血指标。
import assert from "node:assert/strict";
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
const { evaluateSafetyGate, redFlagRuleIdForMessage } = await jiti.import("../src/lib/diagnosis-safety.ts");

const redFlags = (text) => evaluateSafetyGate({
  patient: { sex: "女", age: 45 },
  chiefComplaint: text,
  symptoms: {},
  tongue: "",
  pulse: "",
  faceNote: "",
  conversation: [],
  vitals: {},
  history: {},
})?.redFlags || [];
const hasMajorBleedingFlag = (text) => redFlags(text).some((flag) => /活动性大量阴道出血/.test(flag));

const positives = [
  "阴道大量出血，仍未停止",
  "阴道出血21天，量多，色鲜红，面色苍白，血色素66g/L",
  "阴道流血不止，伴冷汗、面色苍白",
  "近3天反复阴道流血伴血块",
  "阴道出血，Hb 58 g/L",
];
for (const text of positives) {
  assert.ok(hasMajorBleedingFlag(text), `活动性大出血应触发硬红旗：${text}\n${JSON.stringify(redFlags(text))}`);
}

const negatives = [
  "否认阴道出血",
  "既往阴道出血已止，本次因失眠就诊",
  "月经量少，无异常阴道出血",
  "阴道少量点滴出血，无头晕乏力，血红蛋白128g/L",
  "体检询问是否有阴道出血，患者否认",
];
for (const text of negatives) {
  assert.ok(!hasMajorBleedingFlag(text), `不得把否定/旧史/少量稳定出血升级为硬红旗：${text}\n${JSON.stringify(redFlags(text))}`);
}

const findingMessage = redFlags(positives[1]).find((flag) => /活动性大量阴道出血/.test(flag));
assert.equal(redFlagRuleIdForMessage(findingMessage), "active-major-bleeding",
  "新红旗必须进入统一 finding rule 映射，不能失去可追溯 ruleId");

console.log(JSON.stringify({ suite: "major-vaginal-bleeding", positives: positives.length, negatives: negatives.length }));

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { parseMedicationLabelUsage } = await jiti.import("../src/lib/medication-label-usage.ts");

assert.deepEqual(
  parseMedicationLabelUsage("口服，一次3～5克，一日2～3次，饭前或空腹时服。"),
  {
    route: "口服",
    singleDose: "一次3～5克",
    frequency: "一日2～3次",
    administrationTiming: "饭前或空腹时服",
  },
);
assert.deepEqual(
  parseMedicationLabelUsage("口服。一次6～9克(1-1.5袋)，一日2～3次。"),
  { route: "口服", singleDose: "一次6～9克(1-1.5袋)", frequency: "一日2～3次" },
);
assert.equal(parseMedicationLabelUsage("口服，每日2次").course, undefined);
assert.equal(parseMedicationLabelUsage("口服，一次1袋，一日2次，疗程7日").course, "疗程7日");
assert.deepEqual(parseMedicationLabelUsage(""), {});

const nonOralCases = [
  [
    "丁桂儿脐贴",
    "外用。贴于脐部，一次1贴，24小时换药一次。",
    { route: "外用，贴于脐部", singleDose: "一次1贴", frequency: "24小时换药一次" },
  ],
  [
    "外用软膏",
    "外用，取适量涂于患处，一日2次。",
    { route: "外用，取适量涂于患处", frequency: "一日2次" },
  ],
  ["滴眼液", "滴眼，一次1～2滴，一日3次。", { route: "滴眼", singleDose: "一次1～2滴", frequency: "一日3次" }],
  ["滴鼻液", "滴鼻，每次2滴，一日3次。", { route: "滴鼻", singleDose: "每次2滴", frequency: "一日3次" }],
  ["吸入剂", "吸入，一次1喷，每日2次。", { route: "吸入", singleDose: "一次1喷", frequency: "每日2次" }],
  ["舌下片", "舌下含服，一次1片，一日3次。", { route: "舌下含服", singleDose: "一次1片", frequency: "一日3次" }],
  ["栓剂", "直肠给药，一次1枚，一日1次。", { route: "直肠给药", singleDose: "一次1枚", frequency: "一日1次" }],
  ["灌肠剂", "灌肠，一次20毫升，每日1次。", { route: "灌肠", singleDose: "一次20毫升", frequency: "每日1次" }],
  ["颗粒剂", "开水冲服，一次1袋，一日2次。", { route: "开水冲服", singleDose: "一次1袋", frequency: "一日2次" }],
  ["胶剂", "烊化兑服，3～9克。", { route: "烊化兑服", singleDose: "3～9克" }],
];

function assertSourceBound(label, source, usage) {
  const fragments = source.split(/[，,。；;]+/).map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(fragments);
  for (let index = 0; index + 1 < fragments.length; index += 1) {
    allowed.add(`${fragments[index]}，${fragments[index + 1]}`);
  }
  for (const [field, value] of Object.entries(usage)) {
    assert.ok(allowed.has(value) || source.includes(value), `${label} ${field} 不是说明书原文或相邻原文片段：${value}`);
  }
}

for (const [label, source, expected] of nonOralCases) {
  const parsedUsage = parseMedicationLabelUsage(source);
  assert.deepEqual(parsedUsage, expected, label);
  assertSourceBound(label, source, parsedUsage);
}
const compilerSource = readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
assert.doesNotMatch(compilerSource, /course:\s*["']本候选不形成疗程医嘱/);
assert.match(clientSource, /item\.administrationTiming/);

console.log(JSON.stringify({ suite: "medication-label-usage", cases: 17, failures: 0 }));

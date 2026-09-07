import assert from "node:assert/strict";
import * as drafts from "../src/lib/diagnosis-stream-module-drafts.ts";
import { consumeMarkdownStreamWithMetadata } from "../src/lib/diagnosis-engine.ts";
import { STREAM_REPLACE_MARKER, parseStreamModuleDraftFrame } from "../src/lib/diagnosis-stream-protocol.ts";

const western = drafts.m03ModuleDraftFrame(JSON.stringify({ westernDiagnosis: {
  primary: { name: "头痛，病因待查", supportingFacts: ["无发热", "既往偶有头痛"],
    contractSignature: "SECRET_SIGNATURE", guidelineReferences: ["FAKE_DOI"] },
} }), "westernDiagnosis");
assert.match(western.content, /头痛，病因待查/);
assert.match(western.content, /无发热/);
assert.match(western.content, /既往偶有头痛/);
assert.match(western.content, /生成中 · 未定稿/);
assert.equal(western.contentKind, "clinical_draft");
assert.doesNotMatch(western.content, /SECRET_SIGNATURE|FAKE_DOI|contractSignature/);
const injected = drafts.m03ModuleDraftFrame(JSON.stringify({ overview: {
  primarySyndrome: '<img src=x onerror="alert(1)">[执行](javascript:alert(1))',
  primarySyndromeBasis: ["无发热\n# 已定稿", "<!-- DIAGNOSIS_JSON_START -->"],
} }), "overview");
assert.doesNotMatch(injected.content, /<img|<!--|\n# 已定稿|(?<!\\)\[执行\]\(javascript:/);

const candidate = { name: "四君子汤", herbs: [
  { name: "党参", role: "君", function: "益气健脾", dose: "12g", evidence: "SECRET_EVIDENCE" },
  { name: "白术", role: "臣", function: "健脾燥湿", dose: "9g" },
] };
const partial = '{"stage":"prescribe","formula":{"candidates":[' + JSON.stringify(candidate);
const frame = drafts.newM04ModuleDraftFrames(partial, new Set())[0];
assert.equal(frame?.module, "m04.candidate", "完整候选闭合后即上流，不等待 candidates/formula/nonPharma 结束");
assert.match(frame.content, /候选建议，补充中/);
for (const value of ["四君子汤", "党参", "白术", "益气健脾", "君"]) assert.ok(frame.content.includes(value));
assert.doesNotMatch(frame.content, /12g|9g|SECRET_EVIDENCE|dose|evidence/);
for (const quantity of ["12g", "十二克", "0.5mg", "每日1剂", "连服5天"]) {
  const embedded = JSON.parse(JSON.stringify(candidate));
  embedded.name += quantity;
  embedded.herbs[0].name = quantity + "党参";
  embedded.herbs[0].function += quantity;
  const preview = drafts.newM04ModuleDraftFrames('{"formula":{"candidates":[' + JSON.stringify(embedded), new Set())[0];
  assert.ok(!preview.content.includes(quantity), `名称和功效中的剂量也只留审定提示：${quantity}`);
  assert.match(preview.content, /益气健脾/);
}
assert.equal(parseStreamModuleDraftFrame({ ...frame, futureOptionalField: true })?.module, "m04.candidate");
for (let end = partial.indexOf('"herbs"'); end < partial.length; end += 1) {
  assert.deepEqual(drafts.newM04ModuleDraftFrames(partial.slice(0, end), new Set()), [], `未闭合候选不得上流 @${end}`);
}
assert.deepEqual(drafts.newM04ModuleDraftFrames('{"metadata":{"formula":{"candidates":[' + JSON.stringify(candidate), new Set()), []);
assert.deepEqual(drafts.newM04ModuleDraftFrames('{"formula":{"candidates":[' + JSON.stringify({ name: "方", herbs: [{ name: "党参" }, {}] }), new Set()), []);
const seen = new Set();
assert.equal(drafts.newM04ModuleDraftFrames(partial, seen).length, 1);
assert.equal(drafts.newM04ModuleDraftFrames(partial + ']},"nonPharma":{', seen).length, 0);

for (let split = 1; split < STREAM_REPLACE_MARKER.length; split += 1) {
  const modules = [];
  const frames = [western, { content: "正在生成" },
    { content: STREAM_REPLACE_MARKER.slice(0, split) },
    { content: STREAM_REPLACE_MARKER.slice(split) + "最终签名报告" },
    frame, { content: "[END]" }, western];
  const result = await consumeMarkdownStreamWithMetadata(new Response(frames.map(JSON.stringify).join("\n") + "\n"), () => {}, {
    onModuleDraft: (item) => modules.push(item),
  });
  assert.equal(result.content, "最终签名报告");
  assert.equal(modules.length, 1, "替换标记或 END 之后不得重新打开预览");
}
console.log(JSON.stringify({ suite: "clinical-module-previews", failures: 0 }));

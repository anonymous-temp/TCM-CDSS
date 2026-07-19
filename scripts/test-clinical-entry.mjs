import assert from "node:assert/strict";

const { appendClinicalPresetValue, appendDelimitedValue, appendTonguePresetValue, detectTonguePulseFieldConflict } = await import("../src/lib/clinical-entry.ts");

assert.equal(appendDelimitedValue("舌淡红", "舌淡红"), "舌淡红");
assert.equal(appendDelimitedValue("脉细", "脉弱"), "脉细，脉弱");
assert.equal(appendTonguePresetValue("舌淡红，舌尖略红", "舌尖红"), "舌淡红，舌尖略红");
assert.equal(appendTonguePresetValue("边有轻齿痕", "边有齿印"), "边有轻齿痕");
assert.equal(appendTonguePresetValue("苔薄少", "苔少"), "苔薄少");
assert.equal(appendTonguePresetValue("舌淡红", "苔少"), "舌淡红，苔少");
assert.equal(appendClinicalPresetValue("tcmTongue", "舌尖略红", "舌尖红"), "舌尖略红");
assert.equal(appendClinicalPresetValue("tcmPulse", "脉细", "脉弱"), "脉细，脉弱");
assert.equal(appendTonguePresetValue("无舌尖红", "舌尖红"), "无舌尖红，舌尖红");
assert.equal(appendTonguePresetValue("苔少", "苔薄少"), "苔薄少");
assert.equal(appendTonguePresetValue("齿痕舌", "边有轻度齿痕"), "边有轻度齿痕");
assert.deepEqual(detectTonguePulseFieldConflict("脉弦细", "舌淡、苔薄白"), {
  swapped: true,
  tongueLooksLikePulse: true,
  pulseLooksLikeTongue: true,
});
assert.equal(detectTonguePulseFieldConflict("舌淡、苔薄白", "脉弦细").swapped, false);
assert.equal(detectTonguePulseFieldConflict("细", "舌淡").swapped, false, "an isolated ambiguous character must not trigger an automatic swap warning");
assert.equal(appendDelimitedValue("未见脉细", "脉细"), "未见脉细，脉细");

console.log(JSON.stringify({ cases: 12, failures: 0 }));

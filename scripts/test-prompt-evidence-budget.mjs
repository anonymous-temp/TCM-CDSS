import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { compactEvidenceContextForPrompt } = await jiti.import("../src/lib/prompt-budget.ts");

const lines = Array.from({ length: 120 }, (_, index) =>
  `[EVID-${String(index + 1).padStart(3, "0")}] 第${index + 1}条完整证据 https://example.test/${index + 1}`,
);
const source = lines.join("\n");

const unchanged = compactEvidenceContextForPrompt(source, source.length);
assert.deepEqual(unchanged, { text: source, truncated: false, omittedChars: 0 });

const bounded = compactEvidenceContextForPrompt(source, 900);
assert.equal(bounded.truncated, true);
assert.ok(bounded.text.length <= 900, `bounded evidence exceeded budget: ${bounded.text.length}`);
assert.ok(bounded.omittedChars > 0);
assert.match(bounded.text, /^\[EVID-001\]/, "official/head evidence must be retained");
assert.match(bounded.text, /\[EVID-120\][^\n]*$/, "external/tail evidence must be retained");
assert.match(bounded.text, /证据上下文预算裁剪/, "the omission must be explicit to the model");
assert.doesNotMatch(bounded.text, /\[EVID-\d{0,2}\s*$/, "a citation id must not be cut at a normal line boundary");

const empty = compactEvidenceContextForPrompt(source, 0);
assert.deepEqual(empty, { text: "", truncated: true, omittedChars: source.length });

console.log(JSON.stringify({ suite: "prompt-evidence-budget", checks: 9, retained: bounded.text.length }));

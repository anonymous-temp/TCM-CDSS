import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { fetchExternalEvidence } = await jiti.import("../src/lib/evimed-guide.ts");

const probes = [
  ["guide", "失眠诊疗指南"],
  ["instruction", "阿司匹林"],
  ["literature", "失眠 临床研究 系统评价"],
];

const results = await Promise.all(probes.map(async ([kind, query]) => {
  const startedAt = Date.now();
  const startYear = kind === "guide" || kind === "literature" ? 2020 : undefined;
  const result = await fetchExternalEvidence(kind, query, { count: 3, startYear });
  assert.equal(result.ok, true, `${kind}: evidence source failed (${result.reason}, HTTP ${result.upstreamStatus || "n/a"})`);
  assert.ok(result.list.length > 0, `${kind}: live probe returned no traceable evidence`);
  assert.ok(result.list.length <= 3, `${kind}: upstream result count escaped the caller-owned bound`);
  if (startYear) {
    assert.ok(result.list.every((item) => item.year && Number(item.year) >= startYear), `${kind}: upstream returned evidence outside the requested year window`);
  }
  assert.ok(result.list.every((item) => item.sourceKind === kind && item.title && (item.publisher || item.year || item.url || item.identifier)), `${kind}: untraceable evidence escaped normalization`);
  return { kind, reason: result.reason, count: result.list.length, durationMs: Date.now() - startedAt, samples: result.list.slice(0, 2).map((item) => ({ title: item.title, publisher: item.publisher, year: item.year, identifier: item.identifier, url: item.url })) };
}));

console.log(JSON.stringify({ probes: results.length, failures: 0, results }, null, 2));

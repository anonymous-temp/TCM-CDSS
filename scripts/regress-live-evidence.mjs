import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { fetchExternalEvidence } = await jiti.import("../src/lib/evimed-guide.ts");

const probes = [
  ["guide", "失眠诊疗指南"],
  ["instruction", "阿司匹林"],
  ["literature", "阿司匹林 心血管 临床研究"],
];

const results = await Promise.all(probes.map(async ([kind, query]) => {
  const startedAt = Date.now();
  const result = await fetchExternalEvidence(kind, query, { count: 3, startYear: 2020 });
  assert.equal(result.ok, true, `${kind}: evidence source failed (${result.reason}, HTTP ${result.upstreamStatus || "n/a"})`);
  assert.ok(result.list.length > 0, `${kind}: live probe returned no traceable evidence`);
  assert.ok(result.list.every((item) => item.sourceKind === kind && item.title && (item.publisher || item.year || item.url || item.identifier)), `${kind}: untraceable evidence escaped normalization`);
  return { kind, reason: result.reason, count: result.list.length, durationMs: Date.now() - startedAt, samples: result.list.slice(0, 2).map((item) => ({ title: item.title, publisher: item.publisher, year: item.year, identifier: item.identifier, url: item.url })) };
}));

console.log(JSON.stringify({ probes: results.length, failures: 0, results }, null, 2));

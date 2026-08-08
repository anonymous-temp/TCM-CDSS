/**
 * M03 确定性后处理链的幂等性断言。
 *
 * 为什么需要这条断言：`diagnosis-api.ts` 的 `finalizeM03CandidateForReview` 注释声称
 * "the deterministic finalization transforms ... are idempotent, so applying them BEFORE the
 * review makes the post-review finalization a no-op"。这句话是整条复核链的承重前提——
 *   - 复核看到的字节 == 签名覆盖的字节，靠的就是「复核后再跑一遍 finalize 不会改动内容」；
 *   - 顺利路径上省掉第二遍 prepare（2026-08-08 的调用链去冗余）也直接依赖它。
 * 但在此之前它只是一句注释，没有任何断言。若某段变换实际不是幂等的，
 * 后果不是性能问题而是**复核通过之后仍发生临床内容静默改写**。
 *
 * 断言方式：拿归档的真实 M03 结构化产物，跑 prepare(C) → P1，再跑 prepare(P1) → P2，
 * 要求 P1 === P2（逐字节）。不对 P1 的内容做任何期待——只查不动点。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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

const { prepareDiagnoseStructuredContent } = await jiti.import("../src/lib/diagnosis-api.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";

function wrap(reasoning) {
  return `## 诊断分析\n\n${START}\n${JSON.stringify(reasoning, null, 2)}\n${END}\n`;
}

/**
 * 语料：优先用归档的 922 组真实 M03 产物（本机 /tmp 下的取证语料，不进仓库）；
 * 取不到时退到内置的最小样例，保证这条套件在任何机器上都能跑、而不是静默跳过。
 */
function loadCorpus() {
  const archived = process.env.M03_PREPARE_CORPUS || "/tmp/p/pairs.json";
  if (fs.existsSync(archived)) {
    try {
      const raw = JSON.parse(fs.readFileSync(archived, "utf8"));
      const rows = Array.isArray(raw) ? raw : [];
      const cases = rows
        .map((row, index) => ({ id: String(row?.file || index), reasoning: row?.m03 }))
        .filter((row) => row.reasoning && typeof row.reasoning === "object");
      if (cases.length > 0) return { source: archived, cases };
    } catch {
      /* 落到内置语料 */
    }
  }
  return { source: "builtin", cases: BUILTIN_CASES };
}

const BUILTIN_CASES = [
  {
    id: "builtin-wind-cold",
    reasoning: {
      schemaVersion: "2",
      stage: "diagnose",
      overview: { chiefComplaintSummary: "恶寒发热 2 天，无汗，头身疼痛" },
      westernDiagnosis: {
        primary: { name: "急性上呼吸道感染", confidence: "possible", rationale: "急性起病伴发热恶寒" },
        differentials: [],
      },
      pathogenesis: {
        chain: [
          {
            nodeId: "P1",
            factor: "风寒束表",
            mechanism: "卫阳被遏，腠理闭塞",
            therapyDirection: "辛温解表",
            evidence: ["恶寒发热", "无汗"],
          },
        ],
      },
      therapy: { overallPrinciple: "辛温解表", overallMethod: "发汗解表，宣肺散寒" },
      formula: { name: "麻黄汤", composition: [] },
      management: { followUp: [] },
    },
  },
  {
    id: "builtin-empty-chain",
    reasoning: {
      schemaVersion: "2",
      stage: "diagnose",
      overview: { chiefComplaintSummary: "" },
      westernDiagnosis: { primary: null, differentials: [] },
      pathogenesis: { chain: [] },
      therapy: {},
      formula: null,
      management: {},
    },
  },
];

const { source, cases } = loadCorpus();
const limit = Number(process.env.M03_PREPARE_CORPUS_LIMIT || 120);
const sample = cases.slice(0, Math.max(1, limit));

console.log(`[test:m03-prepare-idempotence] 语料 ${source}，共 ${cases.length} 例，本轮抽 ${sample.length} 例`);

const drifted = [];
let checked = 0;

for (const item of sample) {
  const content = wrap(item.reasoning);
  const clinicalContext = String(item.reasoning?.overview?.chiefComplaintSummary || "");
  let first;
  try {
    first = await prepareDiagnoseStructuredContent(content, clinicalContext, [], undefined, undefined);
  } catch (error) {
    // prepare 对畸形输入抛错是既有行为（上层 catch 后走降级），不属于幂等性问题。
    continue;
  }
  const second = await prepareDiagnoseStructuredContent(first, clinicalContext, [], undefined, undefined);
  checked += 1;
  if (first !== second) {
    drifted.push({ id: item.id, firstLength: first.length, secondLength: second.length });
  }
}

assert.ok(checked > 0, "语料一例都没跑成，断言无效");

if (drifted.length > 0) {
  console.error(
    `[test:m03-prepare-idempotence] 第二遍 prepare 改动了内容（前 5 例）：`,
    drifted.slice(0, 5),
  );
}

assert.equal(
  drifted.length,
  0,
  `prepareDiagnoseStructuredContent 不是幂等的：${drifted.length}/${checked} 例在第二次应用时内容发生变化。` +
    `这会让「复核看到的字节 == 签名覆盖的字节」不再成立，也让顺利路径上的 prepare 去重变成静默改写。`,
);

console.log(`[test:m03-prepare-idempotence] OK — ${checked} 例二次应用均为不动点`);

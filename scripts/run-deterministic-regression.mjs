import { spawnSync } from "node:child_process";

const scripts = [
  "test:rxaudit-contract",
  "test:rxaudit-payload",
  "test:rxaudit-routes",
  "test:safety-pediatric",
  "test:safety-mutations",
  "test:clinical-facts",
  "test:evidence-sentinel",
  "test:evimed-normalization",
  "test:local-patent-medicines",
  "test:patent-medicine-ranking",
  "test:upstream-guards",
  "test:authoritative-his",
  "test:formula-provenance",
  "test:classic-evidence-bundling",
  "test:syndrome-equivalence",
  "test:syndrome-hypothesis",
  "test:customer-dose-parity",
  "test:primary-care-50-safety",
  "test:snapshot-auth-binding",
  "test:lineage-governance",
  "test:tcm-treatments",
  "test:acupoint-evidence",
  "test:modern-case-corpus",
  "test:disease-lexicon",
  "test:runtime-data-presence",
  "test:pregnancy-recall",
  "test:warm-disease-rules",
  "test:clinical-decision-cards",
  "test:customer-evidence",
  "test:stage-contract",
  "test:m03-parallel-merge",
  "test:cdss-reason-codes",
  "test:clinical-vocabulary",
  "test:formula-syndrome-consistency",
  "test:formula-discrimination-guard",
  "test:repair-guidance",
  "test:therapy-vocabulary",
  "test:stage-outcome",
  "test:formula-selection-symmetry",
  "test:herb-name-resolution",
  "test:herb-breadth-surface",
  "test:m04-dose-index",
  "test:m04-safety-contract",
  "test:guard-symmetry",
  "test:rejection-tiers",
  "test:stream-safety",
  "test:stream-modules",
  "test:recorded-fact-visibility",
  "test:clinical-grounding",
  "test:inspection-lexicon",
  "test:clinical-entry",
  "test:clinical-terminology",
  "test:controlled-semantic-normalization",
  "test:clinical-governance-tables",
  "test:clinical-polarity",
  "test:m03-entry",
  "test:m02-contract",
  "test:m02-nonblocking",
  "test:m02-answer-interpreter",
  "test:prescription-permission",
  "test:primary-care-50-contracts",
  "test:diagnosis-display",
  // 渲染层卫生（甲方评测 2026-08-04 呈现层四条）。其余套件断言的是 lib 层函数的返回值，
  // 这一套把归档的真实 M03/M04 产出重新投影、用 react-dom/server 渲染成静态 HTML，
  // 再对**医生实际看到的文本**断言：内部工程记号、方义解析长度、病机节内不重复、旧组件零残留。
  // 「函数绿 + 页面错」只有这一套拦得住。
  "test:visible-output-hygiene",
  "test:icd10-coding",
  "test:reasoning-signature",
  "test:model-rate-limit",
  "test:stage-telemetry",
  "test:m03-clinical-review",
  // 甲方 2026-08 复测「临床四条」：西医依据混入就诊经过 / 病名鉴别缺失 / 病位缺主症锚 /
  // 治法方向无病例绑定。四条都锁在受治理数据上（GB/T 15657 病名编码、症状—病位映射、
  // GB/T 16751.3 治法编号），因此必须与它们一起回归——词表升级若改了编码层级，本套件先红。
  "test:clinical-four-binding",
  "test:nihaisha-fusion",
  "test:nihaisha-replay",
  "test:prompt-injection",
];

const startedAt = Date.now();
// Defense-in-depth: suites must pin their own audit config. Scrub inherited RXAI_AUDIT_* shell
// overrides (e.g. a small RXAI_AUDIT_TOTAL_TIMEOUT_MS) so they cannot leak into child processes.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("RXAI_AUDIT_")),
);
for (const [index, script] of scripts.entries()) {
  console.error(`[deterministic] ${index + 1}/${scripts.length} ${script}`);
  const result = spawnSync("npm", ["run", script], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(JSON.stringify({ script, status: result.status, signal: result.signal }));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({ suites: scripts.length, failures: 0, elapsedMs: Date.now() - startedAt }, null, 2));

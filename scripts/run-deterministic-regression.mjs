import { spawnSync } from "node:child_process";

const scripts = [
  "test:rxaudit-contract",
  "test:rxaudit-payload",
  "test:rxaudit-routes",
  // 审方风险的性别适用性裁剪（甲方生产实测 2026-08-04 缺陷2）。风险的适用人群几乎都是析取枚举
  // （出血倾向/月经期/抗凝状态、儿童/孕妇/经期妇女/年老体弱者），而下游只有一道按整格判定的
  // 性别净化——与性别无关的那一半被连坐，医生动作整格变成「本例男性不适用」。
  "test:rxaudit-sex-applicability",
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
  // 治疗项目「适应证—方案」绑定（甲方生产实测 2026-08-04 缺陷1）。上一套断言的是项目**选谁**，
  // 本套断言的是选中之后**卡片说的适应证与卡片给的方案是不是同一个**——生产实测两者可以分叉：
  // 头痛病例写着"围绕头痛症状"却给失眠方的安眠/心俞，产后头痛的灸法写出本例没有的"经带与下腹症状"。
  "test:treatment-indication",
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
  "test:formula-symptom-retrieval",
  "test:formula-discrimination-guard",
  "test:repair-guidance",
  // M04「重新生成候选方药」的跨请求恢复能力（甲方生产实测 2026-08-04 缺陷3）。
  // 生产上同一病例的第二次请求返回与第一次**逐字节相同**的失败页：编排层「同一修复提示重复注入
  // = 同一张失败彩票」的信条只在单次请求内生效，跨请求时修复计数/fixpoint/时限全部归零。
  "test:m04-retry-recovery",
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
  "test:negation-scope",
  "test:syndrome-name-standard",
  "test:formula-name-tiers",
  "test:formula-identity-restore",
  "test:governed-formula-lock",
  "test:phi-clinical-collision",
  "test:output-quality",
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
  // 主症/兼症未分主次（甲方 2026-08-04 复测）。与上一条同源但**不是同一个病**：那一条问
  // 「这个治法方向有没有节点撑着」，本条问「主症与兼症谁居首、谁主导选方」。产后头痛例里
  // 安神确有节点撑着，上一条放行是对的，主次仍然颠倒。判据同样锁在受治理数据上
  // （主症词族 + GB/T 16751.3 治法族编号 + 句序偏移），并钉住生产原始载荷。
  "test:chief-complaint-primacy",
  // 甲方 2026-08-04 复测「呈现层六条」。共同点是都发生在**渲染边界之后**：结构化载荷信息齐全，
  // 医生看到的那一页却把它拼错了（方义列表被表格单元格渲染口压成一行）、压扁了（逐味模板句）、
  // 或根本没分类（依据不分支持/排除/待查）。lib 层套件断言函数返回值，拦不住这一类。
  "test:presentation-contract",
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

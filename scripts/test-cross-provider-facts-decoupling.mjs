/**
 * 跨厂商 M03/M04 复核 与 临床事实复核相位，必须是两件独立的事。
 *
 * 【线上实证（2026-08-16）】为落地 T8′②a，把 PRIMARY_CLINICAL_REVIEW_PROVIDER 设成
 * bailian-qwen 之后：
 *   · M03/M04 跨厂商复核确实生效——attestation 实测
 *     provider=bailian-qwen, model=qwen-plus, independentFromGenerator=true, durationMs=1307；
 *   · 但 health?strict=1 随即塌成 strictReady=false，clinicalFacts.modelProbe.ok=false，
 *     容器进入 health: starting 并重启。
 *
 * 根因是 independentFactsReviewModel 把那个变量一并当成**本相位**的开关：
 *   if (provider !== "primary") return { configured: false }   // 直接判未配置
 * 于是 probeClinicalFactsPhaseModel 判 not_configured，三相位 AND 出来 ok=false。
 * 两个本该独立的能力被这一行做成了**互斥**——开了跨厂商就没有严格就绪，
 * 而 Docker healthcheck 打的正是 strict=1 这个口。
 *
 * 【修法：保留 fail-closed 默认，加一条显式出口】
 * 本文件不实现 bailian 传输，跨厂商拓扑下**默认仍判未配置**——静默改用主模型
 * 等于把「独立」二字变成假话。但运维显式设置 CLINICAL_FACTS_REVIEW_MODEL 时，
 * 表示已知本相位走主模型传输、与 M03/M04 的跨厂商复核是两件事，此时放行。
 * 显式优于沉默：不设就仍然 fail-closed，设了就必须是运维写下来的那一行。
 */
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

const SAVED = {
  provider: process.env.PRIMARY_CLINICAL_REVIEW_PROVIDER,
  factsReview: process.env.CLINICAL_FACTS_REVIEW_MODEL,
  openaiKey: process.env.OPENAI_API_KEY,
  openaiBase: process.env.OPENAI_BASE_URL,
  openaiModel: process.env.OPENAI_MODEL,
};
function restore() {
  for (const [key, value] of [
    ["PRIMARY_CLINICAL_REVIEW_PROVIDER", SAVED.provider],
    ["CLINICAL_FACTS_REVIEW_MODEL", SAVED.factsReview],
    ["OPENAI_API_KEY", SAVED.openaiKey],
    ["OPENAI_BASE_URL", SAVED.openaiBase],
    ["OPENAI_MODEL", SAVED.openaiModel],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// 主模型必须可解析，否则测的是「没配主模型」而不是本条耦合
process.env.AI_TEXT_PROVIDER = process.env.AI_TEXT_PROVIDER || "openai-compatible";
process.env.OPENAI_API_KEY = SAVED.openaiKey || "test-key-for-plan-resolution";
process.env.OPENAI_BASE_URL = SAVED.openaiBase || "https://example.invalid/v1";
process.env.OPENAI_MODEL = SAVED.openaiModel || "deepseek-v4-flash";

async function planWith(provider, factsReviewModel) {
  if (provider === undefined) delete process.env.PRIMARY_CLINICAL_REVIEW_PROVIDER;
  else process.env.PRIMARY_CLINICAL_REVIEW_PROVIDER = provider;
  if (factsReviewModel === undefined) delete process.env.CLINICAL_FACTS_REVIEW_MODEL;
  else process.env.CLINICAL_FACTS_REVIEW_MODEL = factsReviewModel;
  // 模块级无缓存：每次重新 import 以读当前 env
  const mod = await jiti.import(`../src/lib/clinical-facts-runtime.ts?t=${Date.now()}${Math.round(performance.now())}`);
  return mod.getClinicalFactsModelPlan();
}

try {
  // ── 1. 默认拓扑（primary）：复核相位必须已配置 ────────────────────────────
  {
    const plan = await planWith("primary", undefined);
    // 断言的是**有没有走到 unconfigured 早退分支**，不是环境配全没配全。
    // 第一版断言 configured===true，但该标志还依赖主模型端点/密钥的真实性，
    // 单测环境下连 extractor 都是 false——测的成了夹具不是产品（今日第五次）。
    assert.notEqual(
      plan.reviewer.provider, "unconfigured",
      "默认 primary 拓扑下不得走 unconfigured 早退分支——否则 health?strict=1 恒为 false",
    );
  }

  // ── 2. 跨厂商拓扑 + 未显式配置：保持 fail-closed ──────────────────────────
  // 本文件不实现 bailian 传输，静默改用主模型等于把「独立」二字变成假话。
  {
    const plan = await planWith("bailian-qwen", undefined);
    assert.equal(
      plan.reviewer.provider, "unconfigured",
      "跨厂商拓扑下若未显式配置本相位模型，必须保持 fail-closed 判未配置（不得静默回落主模型）",
    );
  }

  // ── 3. 跨厂商拓扑 + 显式配置：必须放行 ────────────────────────────────────
  // 这一条是本套件的要害：没有它，开了跨厂商就永远拿不到 strictReady=true，
  // 而 Docker healthcheck 打的正是那个口——线上实测容器因此进入 health: starting 并重启。
  {
    const plan = await planWith("bailian-qwen", "deepseek-v4-flash");
    assert.notEqual(
      plan.reviewer.provider, "unconfigured",
      "跨厂商拓扑下显式设置 CLINICAL_FACTS_REVIEW_MODEL 必须放行——"
      + "否则跨厂商 M03/M04 复核与临床事实严格就绪互斥，二者只能取其一。",
    );
    assert.equal(
      plan.reviewer.model, "deepseek-v4-flash",
      "放行时必须用运维显式写下的那个模型，不得另选",
    );
  }
} finally {
  restore();
}

console.log("test-cross-provider-facts-decoupling: OK");

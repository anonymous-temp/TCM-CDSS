// 灵犀「合理用药统一 API」V1.21 查询类 operation 的活体探针。
//
// 用途是让「集成是否真的通」成为可复现的事实，而不是读文档得出的推断。
// 默认关闭的开关在这里显式打开——探针的意义就是在开关关着的情况下也能验证链路。
//
// 用法（凭据不入库，从环境传入）：
//   RXAI_AUDIT_BASE_URL=http://<host>:<port> RXAI_AUDIT_API_KEY=<key> \
//   RXAI_AUDIT_TENANT_ID=<tenant> RXAI_AUDIT_ALLOW_INSECURE_HTTP=true \
//   node scripts/probe-rxai-query.mjs
import { createJiti } from "jiti";

process.env.RXAI_QUERY_ENABLED = "true";
if (!process.env.RXAI_AUDIT_API_KEY && !process.env.RXAI_AUDIT_TOKEN) {
  console.error("需要 RXAI_AUDIT_API_KEY（或 RXAI_AUDIT_TOKEN）");
  process.exit(2);
}

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { resolveGovernedDrugIdentities, queryDrugCompatibility, rxaiQueryEnabled } =
  await jiti.import("../src/lib/rxai-query.server.ts");

console.log("enabled:", rxaiQueryEnabled());

// 这批药正是 2026-08-28 实测中被 isSpecificMedicationIdentity 判「身份不具体」而转人工的。
const drugs = ["氨氯地平", "硝酸甘油", "奥美拉唑", "甲钴胺", "阿托伐他汀", "华法林", "不存在的药名XYZ"];
const identities = await resolveGovernedDrugIdentities(drugs);
console.log("\n药品身份解析:");
for (const drug of drugs) {
  const key = drug.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  console.log(`  ${identities.has(key) ? "已解析" : "未解析"}  ${drug}`);
}

console.log("\n配伍查询:");
for (const pair of [["甘草", "海藻"], ["华法林", "阿司匹林"], ["硝酸甘油", "西地那非"]]) {
  const findings = await queryDrugCompatibility(pair);
  const first = findings[0];
  console.log(`  ${pair.join(" × ")} → ${first ? `${first.compatibilityResult}/${first.riskLevel}` : "(无结果)"}`);
}

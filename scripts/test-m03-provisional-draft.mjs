// M03 未签名工作草稿（owner 决策 2026-09-14）。
//
// 222 例实测 7 例走有限结果兜底：流中已出现完整辨证模块，最终页只剩「症状级工作判断」。
// 与 M04 候选保留同一条道理，但 M03 的签名是阶段间信任锚：草稿只能是**可见 Markdown**，
// 永不带 sentinel、永不签名；M04 照常只认签名的有限合同。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { schemaValidDiagnoseDraft, renderM03ProvisionalDraftSection, insertM03ProvisionalDraft, M03_PROVISIONAL_DRAFT_HEADING } = await jiti.import("../src/lib/m03-provisional-draft.ts");
const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const START = "<!-- DIAGNOSIS_JSON_START -->"; const END = "<!-- DIAGNOSIS_JSON_END -->";

const draft = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "感冒", primarySyndrome: "风寒束表证", primarySyndromeResolution: "bounded", primarySyndromeBasis: ["淋雨后恶寒发热", "无汗", "脉浮紧"],
    overallPathogenesis: "风寒束表，卫阳被遏", overallTherapy: "辛温解表", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  westernDiagnosis: { primary: { name: "急性上呼吸道感染", status: "考虑", confidence: "中", supportingFacts: ["淋雨后恶寒发热"], limitations: [], suggestedChecks: [] }, differentials: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "淋雨后恶寒发热", syndromeEvidence: "恶寒重发热轻", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }] },
  therapy: { overallPrinciple: "辛温解表", overallMethod: "疏风散寒", subTherapies: [] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const wrap = (value) => `${START}\n${JSON.stringify(value)}\n${END}`;
const limitedPage = ["## 本次分析结论", "有限结果", "", "## 本节生成状态", "本次资料尚不足以形成完整诊断", "", START, JSON.stringify({ stage: "diagnose", overview: { primarySyndrome: "症状级工作判断" }, contractSignature: "hmac-sha256:x" }, null, 2), END].join("\n");

test("only a schema-valid diagnose payload becomes a draft", () => {
  assert.ok(schemaValidDiagnoseDraft(`正文\n${wrap(draft)}`), "结构完整的 diagnose 载荷是草稿");
  assert.equal(schemaValidDiagnoseDraft("没有 sentinel 的正文"), undefined);
  assert.equal(schemaValidDiagnoseDraft(`${START}\n{not json\n${END}`), undefined, "解析失败不是草稿");
  assert.equal(schemaValidDiagnoseDraft(wrap({ ...draft, stage: "prescribe" })), undefined, "非 diagnose 载荷不是草稿");
  assert.equal(schemaValidDiagnoseDraft(wrap({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose" })), undefined, "schema 不过的原始 JSON 不是医生可读草稿");
});

test("rendered section is visible markdown only: no sentinel, codes listed, provenance stated", () => {
  const section = renderM03ProvisionalDraftSection(draft, ["m03_chain_incomplete", undefined, "m03_chain_incomplete", "tcm_reasoning_unsupported"], "淋雨后恶寒发热，无汗，脉浮紧");
  assert.ok(section.startsWith(M03_PROVISIONAL_DRAFT_HEADING));
  assert.doesNotMatch(section, /DIAGNOSIS_JSON_START|contractSignature|clinicalReview/, "草稿段永不携带 sentinel 或签名字段");
  assert.match(section, /风寒束表证/, "草稿必须保留模型形成的具体证候");
  assert.match(section, /未通过服务端校验、未经独立复核、未签名/, "来源与状态必须写明");
  assert.match(section, /`m03_chain_incomplete`、`tcm_reasoning_unsupported`/, "未通过码去重后逐条列出");
  assert.equal((section.match(/^## /gm) || []).length, 1, "除段落自己的标题外，草稿正文的一级标题全部降级，不与有限页分节混淆");
  assert.match(section, /^### /m, "降级后的标题仍在（正文结构保留）");
  assert.equal(renderM03ProvisionalDraftSection(undefined, ["x"]), "", "没有草稿就没有段落");
  assert.match(renderM03ProvisionalDraftSection(draft, []), /本轮未记录具体原因码/);
});

test("insertion keeps the signed limited contract as the only sentinel and is idempotent", () => {
  const section = renderM03ProvisionalDraftSection(draft, ["m03_chain_incomplete"]);
  const page = insertM03ProvisionalDraft(limitedPage, section);
  assert.equal((page.match(/DIAGNOSIS_JSON_START/g) || []).length, 1, "页面里仍只有一个 sentinel");
  assert.ok(page.indexOf(M03_PROVISIONAL_DRAFT_HEADING) < page.indexOf(START), "草稿段在 sentinel 之前");
  const sentinelJson = page.slice(page.indexOf(START) + START.length, page.indexOf(END));
  assert.match(sentinelJson, /症状级工作判断/, "sentinel 仍是签名的有限合同，不是草稿");
  assert.doesNotMatch(sentinelJson, /风寒束表证/);
  assert.equal(insertM03ProvisionalDraft(page, section), page, "幂等：不重复插入");
  assert.equal(insertM03ProvisionalDraft(limitedPage, ""), limitedPage, "空段原样返回");
  assert.ok(insertM03ProvisionalDraft("没有 sentinel 的页", section).endsWith(section), "无 sentinel 时追加在末尾");
});

test("the limited-result emit is wired to attach the draft (source anchor by semantics)", () => {
  const api = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(api, /renderM03ProvisionalDraftSection\(\s*schemaValidDiagnoseDraft\(authoritativeContent\)/, "草稿取自最后一版权威内容");
  assert.match(api, /authoritativeFallbackAccepted\s*\?\s*`\$\{STREAM_REPLACE_MARKER\}\$\{insertM03ProvisionalDraft\(transformed\.content, m03ProvisionalSection\)\}`/, "签名有限页分支必须附草稿");
});

import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 外部证据检索词（2026-09-28）：M04/M05 用已签名 M03 的西医诊断、中医病名、证候、方剂/治法组织短检索词，
// 按优先级扇出，首个「过了本例相关性过滤后仍有条目」的查询胜出；病例叙述查询去掉日期年龄等噪声。
// 9/28 本机 65 例对照（同一份 M03 结论、deepseek 逐条判相关性）：注入题名里无关 60%→31%，
// 至少一条相关的病例 13→30，整页无证据 23→17。
process.env.CDSS_EVIDENCE_FETCH_CACHE = "false";
process.env.EVIMED_GUIDE_API_KEY = "test-only-placeholder";
process.env.EVIMED_LITERATURE_API_KEY = "test-only-placeholder";
process.env.EVIMED_LITERATURE_API_URL = "https://api.evimed.com/literature";
delete process.env.EVIMED_INSTRUCTION_API_KEY;
const previousFetch = globalThis.fetch;
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildEvidenceQuery, buildExternalEvidenceContext, buildSignedTopicEvidenceQueries, signedDiagnosisEvidenceTopics } =
  await jiti.import("../src/lib/evimed-guide.ts");

const failures = [];
let checks = 0;
async function check(name, fn) { checks++; try { await fn(); } catch (error) { failures.push({ name, message: error.message }); } }

const narrative = "女性，93岁。于1993年8月13日初诊。患者主诉胃脘疼痛不适已有一月余，胃脘胀满，隐痛，食后加重，大便溏薄。";
const base = { patient: { sex: "女", age: 93 }, chiefComplaint: "胃脘疼痛一月余", symptoms: { presentHistory: narrative }, conversation: [] };
const signed = {
  ...base,
  reasoningDiagnose: {
    stage: "diagnose",
    westernDiagnosis: { primary: { name: "慢性浅表性胃炎（伴糜烂）" }, differentials: [] },
    overview: { tcmDiseaseName: "胃脘痛", primarySyndrome: "脾胃虚弱，气机不畅", recommendedFormulaNames: ["香砂六君子汤"], overallTherapy: "健脾益气" },
    therapy: { overallMethod: "健脾益气，理气止痛", overallPrinciple: "虚则补之", subTherapies: [] },
    pathogenesis: { chain: [] },
  },
};
// 指南接口返回 data.list；文献接口返回 data.paper / data.clinicalTrials（normalizeExternalEvidenceResponse）。
const response = (titles, url = "") => {
  const items = titles.map((title) => ({ title, year: "2024", publisher: "中华医学会" }));
  const data = /literature|paper|article/i.test(url) ? { paper: items } : { list: items };
  return new Response(JSON.stringify({ code: 200, data }), { headers: { "content-type": "application/json" } });
};

try {
  await check("signed M03 topics are short nouns without qualifiers or parentheticals", () => {
    assert.deepEqual(signedDiagnosisEvidenceTopics(signed), {
      western: "慢性浅表性胃炎", tcmDisease: "胃脘痛", syndrome: "脾胃虚弱", formula: "香砂六君子汤", therapy: "健脾益气",
    });
    const unknownCause = { ...signed, reasoningDiagnose: { ...signed.reasoningDiagnose, westernDiagnosis: { primary: { name: "病因待查" } } } };
    assert.equal(signedDiagnosisEvidenceTopics(unknownCause).western, undefined, "「病因待查」不是检索主题");
    assert.equal(signedDiagnosisEvidenceTopics(base), undefined, "没有签名 M03 就没有主题词");
  });
  await check("prescribe queries are ordered by clinical priority; diagnose and instruction keep their own paths", () => {
    assert.deepEqual(buildSignedTopicEvidenceQueries(signed, "prescribe", "guide"),
      ["慢性浅表性胃炎 诊疗指南 专家共识", "胃脘痛 脾胃虚弱 中医诊疗指南 专家共识"]);
    assert.deepEqual(buildSignedTopicEvidenceQueries(signed, "prescribe", "literature"),
      ["慢性浅表性胃炎 香砂六君子汤 临床研究", "胃脘痛 脾胃虚弱 中医药 临床研究"]);
    assert.deepEqual(buildSignedTopicEvidenceQueries(signed, "diagnose", "guide"), []);
    assert.deepEqual(buildSignedTopicEvidenceQueries(signed, "prescribe", "instruction"), []);
    process.env.CDSS_EVIDENCE_TOPIC_QUERIES = "false";
    assert.deepEqual(buildSignedTopicEvidenceQueries(signed, "prescribe", "guide"), [], "回滚开关");
    delete process.env.CDSS_EVIDENCE_TOPIC_QUERIES;
  });
  await check("narrative queries drop visit dates, years and age/sex openers but keep the clinical text", () => {
    const query = buildEvidenceQuery(base, "diagnose", "guide");
    assert.doesNotMatch(query, /1993|93岁|8月13日|初诊/);
    assert.match(query, /胃脘疼痛/);
    assert.match(query, /大便溏薄/);
  });
  await check("the first topic query whose results survive the case relevance filter wins", async () => {
    delete process.env.CDSS_EVIDENCE_RELEVANCE_FILTER;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const query = JSON.parse(options.body).query;
      calls.push(query);
      if (query.startsWith("慢性浅表性胃炎 诊疗指南")) return response(["黄褐斑诊疗专家共识（2021）", "脓疱疮诊疗指南"], String(url));
      if (query.startsWith("胃脘痛 脾胃虚弱")) return response(["胃脘痛中医诊疗专家共识意见（2017）"], String(url));
      if (query.startsWith("慢性浅表性胃炎 香砂六君子汤")) return response(["香砂六君子汤治疗慢性胃炎脾胃虚弱证的临床研究"], String(url));
      return response(["病例叙述查询命中的指南"], String(url));
    };
    const context = await buildExternalEvidenceContext(signed, "prescribe");
    assert.ok(calls.some((query) => query.startsWith("慢性浅表性胃炎 诊疗指南")), "priority topic query is sent");
    assert.match(context, /检索词：胃脘痛 脾胃虚弱 中医诊疗指南 专家共识/, "an all-irrelevant first result does not block the next topic query");
    assert.match(context, /胃脘痛中医诊疗专家共识意见/);
    assert.doesNotMatch(context, /黄褐斑|脓疱疮/);
    assert.match(context, /香砂六君子汤治疗慢性胃炎/);
  });
  await check("when no topic query returns anything, the narrative query still serves as the last resort", async () => {
    globalThis.fetch = async (url, options) => {
      const query = JSON.parse(options.body).query;
      return response(query.includes("诊疗指南") || query.includes("临床研究") ? [] : ["胃脘痛中医临床路径"], String(url));
    };
    const context = await buildExternalEvidenceContext(signed, "prescribe");
    assert.match(context, /胃脘痛中医临床路径/);
  });
} finally {
  globalThis.fetch = previousFetch;
}

console.log(JSON.stringify({ suite: "evidence-topic-queries", checks, failures }, null, 1));
assert.equal(failures.length, 0);

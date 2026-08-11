import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import {
  M05_PRESCRIPTION_MUTATION_CONTROLS,
  PRIMARY_CARE_FIXTURE_METADATA,
  PRIMARY_CARE_POLARITY_CONTRASTS,
  PRIMARY_CARE_SPARSE_50,
} from "./fixtures/primary-care-sparse-50.mjs";
import {
  NON_DOSE_MARKER,
  RETRYABLE_HTTP_STATUSES,
  buildSemanticM02Answer,
  evaluateAuditInputQualityControl,
  evaluateAuditPositiveControl,
  evaluateLimitedNoDose,
  evaluateM02QuestionContract,
  evaluateM03CanonicalContract,
  evaluateM03CriticalClinicalAssertions,
  evaluateM03ScopeContract,
  evaluateM04CandidateContract,
  evaluatePathogenesisContract,
  evaluateRedFlagContract,
  evaluateSemanticM02AnswerCoverage,
  executeRequestWithRetries,
  isRetryableRequestFailure,
  parseHttpResponse,
  parseQuestionBlocks,
  requestDisposition,
  responseComplete,
  validatePrimaryCareFixture,
} from "./lib/primary-care-sparse-50-contracts.mjs";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

const jiti = createJiti(import.meta.url);
const { normalizeCaseStateInput } = jiti("../src/lib/diagnosis-types.ts");
const { buildAuditData } = jiti("../src/lib/rxaudit.ts");
const { enforceM02UnansweredAxes, parseM02PlanFromContent } = jiti("../src/lib/m02-question-contract.ts");

describe("live regression harness required-field contract", () => {
  it("always sends physiological sex to M01 for primary-care and clinical-matrix cases", () => {
    const primaryCareSource = readFileSync(new URL("./regress-primary-care-sparse-50.mjs", import.meta.url), "utf8");
    const clinicalMatrixSource = readFileSync(new URL("./regress-live-clinical-matrix.mjs", import.meta.url), "utf8");
    const browserJourneySource = readFileSync(new URL("./e2e-release-journey.mjs", import.meta.url), "utf8");
    assert.match(primaryCareSource, /patientSex:\s*testCase\.sex/);
    assert.match(clinicalMatrixSource, /patientSex:\s*testCase\.state\.patient\.sex/);
    assert.match(browserJourneySource, /getByTestId\("patient-sex"\)\.selectOption\("男"\)/);
  });
});

function result(overrides = {}) {
  return {
    status: 200,
    raw: '{"ok":true}',
    json: { ok: true },
    content: "ok",
    contentType: "application/json",
    streamed: false,
    endSeen: true,
    parseError: null,
    elapsedMs: 1,
    ...overrides,
  };
}

describe("HTTP and stream parsing", () => {
  it("keeps HTTP status and full raw for invalid NDJSON frame value types", () => {
    for (const raw of ["null\n", "[]\n", '"raw"\n', "7\n"]) {
      const parsed = parseHttpResponse({ status: 200, raw, contentType: "application/x-ndjson" });
      assert.equal(parsed.status, 200);
      assert.equal(parsed.raw, raw);
      assert.match(parsed.parseError, /expected_object/);
      assert.equal(parsed.error, undefined);
    }
  });

  it("requires END when a non-NDJSON response uses the multi-frame compatibility path", () => {
    const rawWithoutEnd = '{"content":"first"}\n{"content":"second"}\n';
    const incomplete = parseHttpResponse({ status: 200, raw: rawWithoutEnd, contentType: "text/plain" });
    assert.equal(incomplete.streamed, true);
    assert.equal(incomplete.content, "firstsecond");
    assert.equal(incomplete.endSeen, false);
    assert.equal(responseComplete(incomplete), false);

    const rawWithEnd = `${rawWithoutEnd}{"content":"[END]"}\n`;
    const complete = parseHttpResponse({ status: 200, raw: rawWithEnd, contentType: "text/plain" });
    assert.equal(complete.raw, rawWithEnd);
    assert.equal(complete.endSeen, true);
    assert.equal(responseComplete(complete), true);
  });

  it("parses an object JSON response without treating it as a stream", () => {
    const raw = JSON.stringify({ content: "正文", section: "分段" });
    const parsed = parseHttpResponse({ status: 200, raw, contentType: "application/json" });
    assert.equal(parsed.json.content, "正文");
    assert.equal(parsed.content, "正文\n\n分段");
    assert.equal(parsed.streamed, false);
    assert.equal(responseComplete(parsed), true);
    assert.equal(responseComplete(parsed, "stream"), false);
    assert.equal(responseComplete(parsed, "json"), true);
  });

  it("requires exactly one END and rejects non-heartbeat frames after it", () => {
    const duplicateEnd = parseHttpResponse({
      status: 200,
      contentType: "application/x-ndjson",
      raw: '{"content":"正文"}\n{"content":"[END]"}\n{"content":"[END]"}\n',
    });
    assert.equal(duplicateEnd.endCount, 2);
    assert.equal(responseComplete(duplicateEnd), false);

    const trailingContent = parseHttpResponse({
      status: 200,
      contentType: "application/x-ndjson",
      raw: '{"content":"正文"}\n{"content":"[END]"}\n{"content":"尾随污染"}\n',
    });
    assert.equal(trailingContent.nonHeartbeatAfterEnd, true);
    assert.equal(responseComplete(trailingContent), false);

    const heartbeatOnly = parseHttpResponse({
      status: 200,
      contentType: "application/x-ndjson",
      raw: '{"content":"正文"}\n{"content":"[END]"}\n{"type":"heartbeat"}\n',
    });
    assert.equal(heartbeatOnly.endCount, 1);
    assert.equal(heartbeatOnly.nonHeartbeatAfterEnd, false);
    assert.equal(responseComplete(heartbeatOnly), true);
  });
});

describe("M03 stage scope", () => {
  it("allows exact current-medication facts while rejecting newly generated doses", () => {
    const chart = "上次糖化8点多，具体单子没带；吃二甲双胍早晚各一片，剂量不清。";
    const quotedFact = [
      "## 西医诊断",
      "**支持依据**：吃二甲双胍早晚各一片，剂量不清",
      '<!-- DIAGNOSIS_JSON_START -->',
      JSON.stringify({ stage: "diagnose", westernDiagnosis: { primary: { supportingFacts: ["吃二甲双胍早晚各一片，剂量不清"] } } }),
      '<!-- DIAGNOSIS_JSON_END -->',
    ].join("\n");
    assert.deepEqual(evaluateM03ScopeContract(quotedFact, chart), {
      ok: true,
      doseExpressionPresent: false,
      prescribeStageContentPresent: false,
      documentedDoseClauseCount: 1,
    });

    const newWesternDose = `${quotedFact}\n建议改为二甲双胍每次一片。`;
    assert.equal(evaluateM03ScopeContract(newWesternDose, chart).doseExpressionPresent, true);
    assert.equal(evaluateM03ScopeContract("治法：养阴清热；黄芪15g、麦冬10g。", chart).doseExpressionPresent, true);
    assert.equal(
      evaluateM03ScopeContract("建议使用PHQ-9、GAD-7和PSG量表复核。", chart).doseExpressionPresent,
      false,
      "clinical scale abbreviations must not be joined into a false gram dose",
    );
    assert.equal(evaluateM03ScopeContract("建议黄芪9 g复核。", chart).doseExpressionPresent, true);
    // 2026-08-10 线上实测（D01）：M03 的「指南/文献依据」栏开始真的有内容之后，
    // 「…临床应用指南(2021年)（2022）（支持…」被标点删除压成「…指南2021年2022支持…」，
    // `2022支` 命中「数字 + 支（安瓿）」⇒ 误判 M03 泄漏剂量。
    // 与上一条 PHQ-9/GAD-7 同源：跨标点的相邻不成立，标点必须是边界而不是被删掉。
    assert.equal(
      evaluateM03ScopeContract(
        "**指南/文献依据**：中成药治疗功能性消化不良临床应用指南(2021年)（2022）（支持功能性消化不良的诊断思路）",
        chart,
      ).doseExpressionPresent,
      false,
      "citation year followed by a Chinese unit across a parenthesis must not be joined into a false dose",
    );
    // 叠词不是剂量：患者原话「身上一片片风疙瘩，起来快消得也快」（K02 实测）。
    assert.equal(
      evaluateM03ScopeContract("**依据**：身上一片片风疙瘩，起来快消得也快（来源：主诉）", chart).doseExpressionPresent,
      false,
      "reduplicated 片片 is patient wording, not a tablet count",
    );
    // 反向护栏：真正的「一片」仍要判为剂量表达。
    assert.equal(evaluateM03ScopeContract("建议每晚服一片。", chart).doseExpressionPresent, true);
    assert.equal(evaluateM03ScopeContract("## 候选处方\n仅供参考", chart).prescribeStageContentPresent, true);
    // 2026-08-10 起 M03 的 westernDiagnosis 自带 candidates（西医给 top3 候选），
    // 旧判据把裸 `"candidates":` 当成「出现处方结构」⇒ 每个红旗病例的 M03 都被误判夹带处方。
    const m03WithWesternCandidates = [
      "<!-- CDSS_SAFETY_ADVISORY -->",
      "> 红旗提示：胸痛/胸闷伴大汗；当前资料提示急危重症风险，请立即完成急诊或转诊评估。",
      "<!-- DIAGNOSIS_JSON_START -->",
      JSON.stringify({ stage: "diagnose", westernDiagnosis: { candidates: [{ name: "胸痛" }] } }),
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n");
    assert.deepEqual(
      evaluateRedFlagContract(m03WithWesternCandidates, { diagnosisMayContinue: true }).errors,
      [],
      "western top-3 candidates in M03 must not be read as a prescription payload",
    );
    // 反向护栏：真正的处方载荷仍必须被拦。
    assert.ok(
      evaluateRedFlagContract(
        `${m03WithWesternCandidates}\n<!-- DIAGNOSIS_JSON_START -->${JSON.stringify({ stage: "prescribe", formula: { candidates: [{ herbs: [] }] } })}<!-- DIAGNOSIS_JSON_END -->`,
        { diagnosisMayContinue: true },
      ).errors.includes("structured_prescription_present"),
    );
  });
});

describe("retry allowlist", () => {
  it("retries only connection, abort, and explicitly allowed HTTP statuses", () => {
    for (const status of RETRYABLE_HTTP_STATUSES) assert.equal(isRetryableRequestFailure(result({ status })), true);
    assert.equal(isRetryableRequestFailure(result({ status: 0, errorKind: "connection" })), true);
    assert.equal(isRetryableRequestFailure(result({ status: 0, errorKind: "abort" })), true);
    assert.equal(isRetryableRequestFailure(result({ status: 0, errorKind: null })), false);
    for (const status of [200, 400, 409, 500, 501, 505]) assert.equal(isRetryableRequestFailure(result({ status })), false);
  });

  it("does not retry HTTP 200 contract failures, unavailable semantic results, or degraded audits", async () => {
    for (const scenario of [
      { value: result({ raw: "", content: "" }), accept: (value) => value.status === 200 && Boolean(value.raw) },
      {
        value: parseHttpResponse({ status: 200, raw: "null\n", contentType: "application/x-ndjson" }),
        accept: (value) => value.status === 200 && responseComplete(value),
      },
      { value: result({ json: { available: false } }), accept: (value) => value.status === 200 && value.json?.available === true },
      { value: result({ json: { audit: { source: "lingxi", degraded: true } } }), accept: (value) => value.status === 200 && value.json?.audit?.degraded !== true },
    ]) {
      let calls = 0;
      const output = await executeRequestWithRetries(async () => {
        calls += 1;
        return scenario.value;
      }, { accept: scenario.accept, maxAttempts: 3 });
      assert.equal(calls, 1);
      assert.equal(output.accepted, false);
      assert.equal(requestDisposition(output), "error");
    }
  });
});

describe("retry execution and reporting", () => {
  it("retains every attempt raw and marks successful recovery as non-green", async () => {
    const values = [
      result({ status: 503, raw: "first attempt full raw", content: "" }),
      result({ status: 200, raw: "second attempt full raw", content: "accepted" }),
    ];
    const output = await executeRequestWithRetries(async () => values.shift(), {
      accept: (value) => value.status === 200 && value.content === "accepted",
      maxAttempts: 3,
    });
    assert.deepEqual(output.attempts.map((attempt) => attempt.raw), ["first attempt full raw", "second attempt full raw"]);
    assert.equal(output.recoveredAfterRetry, true);
    assert.equal(requestDisposition(output), "warning");
  });

  it("stops on a non-retryable response after an initial transient failure", async () => {
    const values = [result({ status: 502 }), result({ status: 200, raw: "bad contract", content: "bad" })];
    let calls = 0;
    const output = await executeRequestWithRetries(async () => {
      calls += 1;
      return values.shift();
    }, { accept: (value) => value.status === 200 && value.content === "accepted", maxAttempts: 4 });
    assert.equal(calls, 2);
    assert.equal(output.recoveredAfterRetry, false);
    assert.equal(requestDisposition(output), "error");
  });

  it("classifies API authentication failures as infrastructure without retrying", async () => {
    let calls = 0;
    const output = await executeRequestWithRetries(async () => {
      calls += 1;
      return result({ status: 401, raw: '{"error":"Unauthorized"}', content: "" });
    }, { accept: () => false, maxAttempts: 3 });
    assert.equal(calls, 1);
    assert.equal(requestDisposition(output), "infrastructure");
  });
});

describe("limited non-dose marker contract", () => {
  const safeText = `${NON_DOSE_MARKER}\n当前未满足剂量级候选处方安全门控，不生成剂量级候选。`;

  it("accepts only the exact standalone marker without prescribe structures", () => {
    assert.equal(evaluateLimitedNoDose(safeText).ok, true);
    assert.equal(evaluateLimitedNoDose(`prefix${NON_DOSE_MARKER}\n不生成剂量级候选。`).ok, false);
    assert.equal(evaluateLimitedNoDose("<!-- CDSS_NON_DOSE_PRESCRIPTIO -->\n不生成剂量级候选。").ok, false);
  });

  it("rejects structured candidates, herbs, treatment projects, and numeric doses", () => {
    for (const contamination of [
      '<!-- DIAGNOSIS_JSON_START -->\n{"stage":"prescribe","formula":{"candidates":[]}}\n<!-- DIAGNOSIS_JSON_END -->',
      '{"herbs":[]}',
      '{"tcmTreatments":[]}',
      "建议黄芪 10g",
      "建议黄芪十克，每日两次",
      "党参三钱，早晚分服",
      "白术半两，一日三服",
      "茯苓１０克，分二次服",
      "黄芪每日两次",
      "早晚服。",
      "每晚服。",
      "每次一汤匙。",
      "两汤匙。",
      "两滴。",
      "喷两喷。",
      "两克。",
    ]) {
      assert.equal(evaluateLimitedNoDose(`${safeText}\n${contamination}`).ok, false, contamination);
    }
  });

  it("requires every red-flag fixture to declare a stage and category oracle", () => {
    const redFlags = PRIMARY_CARE_SPARSE_50.filter((testCase) => testCase.redFlagStage !== "none");
    assert.equal(redFlags.length, 5);
    assert.ok(redFlags.some((testCase) => testCase.redFlagStage === "after_m02"));
    assert.ok(redFlags.every((testCase) => Array.isArray(testCase.expectedRedFlagCategories) && testCase.expectedRedFlagCategories.length > 0));
  });
});

describe("red-flag delivery contract", () => {
  const safeEmergency = [
    "## 急危重即时警示",
    "当前存在急危重红旗，请立即停止常规诊疗并呼叫120或转至急诊。",
    "本次不形成常规诊断或处方。",
  ].join("\n");

  it("requires a visible first-screen warning, explicit emergency action, and hard stop", () => {
    assert.equal(evaluateRedFlagContract(safeEmergency).ok, true);
    assert.equal(evaluateRedFlagContract(`<!-- hidden: 立即急诊 -->\n稍后观察。`).ok, false);
    assert.equal(evaluateRedFlagContract("有风险，请注意。建议后续复诊。").ok, false);
    assert.equal(evaluateRedFlagContract(`${safeEmergency}\n### 候选处方\n黄芪10g，每日两次`).ok, false);
    assert.equal(evaluateRedFlagContract(`${safeEmergency}\n<!-- DIAGNOSIS_JSON_START -->\n{"stage":"diagnose"}\n<!-- DIAGNOSIS_JSON_END -->`).ok, false);
  });

  it("allows structured risk differentiation to continue while still forbidding every prescription form", () => {
    const continuedRiskAssessment = [
      "## 急危重即时警示",
      "当前存在急危重红旗，请立即转至急诊或呼叫120。",
      "以下仅继续完成风险鉴别与辨证分析，不生成处方。",
      '<!-- DIAGNOSIS_JSON_START -->',
      '{"stage":"diagnose","overview":{"primarySyndrome":"痰瘀阻络证"}}',
      '<!-- DIAGNOSIS_JSON_END -->',
    ].join("\n");
    assert.equal(evaluateRedFlagContract(continuedRiskAssessment, { diagnosisMayContinue: true }).ok, true);
    assert.equal(evaluateRedFlagContract(continuedRiskAssessment.replace('"stage":"diagnose"', '"stage":"prescribe"'), { diagnosisMayContinue: true }).ok, false);
    assert.equal(evaluateRedFlagContract(`${continuedRiskAssessment}\n黄芪10g，每日两次`, { diagnosisMayContinue: true }).ok, false);
    assert.equal(evaluateRedFlagContract(`${continuedRiskAssessment}\n病程一两个月，近三天加重`, { diagnosisMayContinue: true }).ok, true, "time expressions must not be mistaken for herbal doses");
  });
});

describe("M02 semantic question and answer contract", () => {
  const content = [
    "问题1：黑便、呕血或体重下降目前有吗？",
    "追问理由：这些表现会改变是否急诊及后续检查。",
    "A. 有黑便、呕血或体重下降",
    "B. 均没有",
    "C. 暂不清楚",
    "",
    "问题2：腹胀与进食的时间关系如何？",
    "追问理由：时间关系有助于区分常见病因。",
    "A. 饭后半小时明显并有早饱",
    "B. 与进食无明显关系",
    "C. 暂不清楚",
  ].join("\n");
  const testCase = PRIMARY_CARE_SPARSE_50.find((item) => item.id === "D01");

  it("validates titles, reasons, mutually exclusive choices, and expected information gain", () => {
    assert.equal(evaluateM02QuestionContract(content, testCase).ok, true);
    assert.equal(evaluateM02QuestionContract(content.split("\n\n问题2")[0], testCase).ok, true, "one high-information question is valid when a second question would only pad the form");
    assert.equal(evaluateM02QuestionContract(`${content}\n\n问题3：是否还有别的不适？\n追问理由：补充症状可能影响判断。\nA. 有\nB. 没有\nC. 暂不清楚`, testCase).ok, false, "one M02 round must expose at most two highest-information questions");
    assert.equal(evaluateM02QuestionContract(content.replace("B. 均没有", "B. 有黑便、呕血或体重下降"), testCase).ok, false);
    assert.equal(evaluateM02QuestionContract(content.replace("B. 均没有", "B. 有黑便并伴呕血"), testCase).ok, false);
    assert.equal(evaluateM02QuestionContract(content.replace("追问理由：时间关系有助于区分常见病因。\n", ""), testCase).ok, false);
  });

  it("accepts common explicit negative phrasings as the opposite of a positive symptom answer", () => {
    for (const negativeAnswer of ["近半年未出现发热", "近半年未发生发热", "近半年从未发热"]) {
      const feverQuestion = [
        "问题1：近半年咳嗽加重以来，您是否出现过发热（体温超过37.3℃）？",
        "追问理由：发热会改变感染性病因的判断与处置。",
        "A. 近半年出现过发热",
        `B. ${negativeAnswer}`,
        "C. 本次未取得该信息",
      ].join("\n");
      assert.equal(
        evaluateM02QuestionContract(feverQuestion, { questionAxes: [/发热/] }).ok,
        true,
        negativeAnswer,
      );
    }
  });

  it("builds the simulated reply only from the axes actually asked", () => {
    const blocks = parseQuestionBlocks(content);
    const reply = buildSemanticM02Answer(testCase, blocks);
    assert.equal(evaluateSemanticM02AnswerCoverage(testCase, blocks, reply).ok, true);
    assert.match(reply, /饭后半小时|早饱/);
    assert.match(reply, /没有黑便|没有.*呕血/);
    assert.doesNotMatch(reply, /舌淡胖|药物过敏/);

    const oneAxisReply = buildSemanticM02Answer(testCase, blocks.slice(0, 1));
    assert.equal(evaluateSemanticM02AnswerCoverage(testCase, blocks.slice(0, 1), oneAxisReply).ok, true);
    assert.match(oneAxisReply, /黑便|呕血|消瘦/);
    assert.doesNotMatch(oneAxisReply, /饭后半小时|早饱|舌淡胖/);
    assert.equal(evaluateSemanticM02AnswerCoverage(testCase, blocks, oneAxisReply).ok, false);
    assert.equal(evaluateSemanticM02AnswerCoverage(testCase, blocks.slice(0, 1), testCase.answer).ok, false, "facts from unasked axes must not leak into the simulated reply");
    const unrelatedButUsefulQuestion = parseQuestionBlocks([
      "问题1：上腹胀时是否伴疼痛或向背部放射？",
      "追问理由：疼痛性质和放射会改变上腹不适的鉴别方向。",
      "A. 存在上述任一疼痛，请补充具体表现",
      "B. 上腹胀时无疼痛",
      "C. 本次未取得该信息",
    ].join("\n"));
    const unknownCoverage = evaluateSemanticM02AnswerCoverage(testCase, unrelatedButUsefulQuestion, "本次未取得该信息");
    assert.equal(unknownCoverage.ok, true, "an explicit unknown answer completes M02 and permits finite-information reasoning");
    assert.equal(unknownCoverage.answeredAxisCount, 0);
  });

  it("removes a structured question whose concrete answer is already documented", () => {
    const structured = [
      "旧的可见问题不得保留。",
      "<!-- DIAGNOSIS_JSON_START -->",
      JSON.stringify({
        completeness: { level: "B", redFlag: 0.8, infoGain: 0.6, managementImpact: 0.6, answerability: 0.8 },
        m02Plan: {
          schemaVersion: "tcm-cdss-m02-plan-v1",
          decision: "ask",
          rationale: "确认神经根受累会改变腰痛鉴别与处置。",
          questions: [{
            id: "q1",
            question: "疼痛是否向下肢放射？",
            reason: "放射痛会改变神经根受累判断。",
            targetField: "xianbingshi",
            decisionBranch: "differential",
            expectedDecisionImpact: "有放射痛时需转向神经根病变评估，无放射痛时优先机械性腰痛。",
            informationGain: 0.9,
            sourceEvidence: [],
            options: [
              { id: "a", label: "有放射痛", answer: "疼痛向下肢放射", kind: "clinical_fact", recordValue: "疼痛向下肢放射" },
              { id: "b", label: "无放射痛", answer: "疼痛不向下肢放射", kind: "clinical_fact", recordValue: "疼痛不向下肢放射" },
              { id: "u", label: "本次未取得", answer: "本次未取得该信息", kind: "unknown" },
            ],
          }],
        },
      }),
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n");
    const repaired = enforceM02UnansweredAxes(structured, "现病史：搬东西后腰痛，疼痛不向下肢放射。", "");
    const plan = parseM02PlanFromContent(repaired);
    assert.equal(plan?.decision, "proceed");
    assert.equal(plan?.questions.length, 0);
    assert.match(repaired, /当前无需追加追问/);
    assert.doesNotMatch(repaired, /疼痛是否向下肢放射/);
  });
});

describe("M03 canonical and pathogenesis contracts", () => {
  const testCase = {
    canonical: {
      westernPrimaryAllowed: [/功能性消化不良/],
      westernPrimaryForbidden: [/胃癌/],
      tcmDiseaseAllowed: [/痞满/],
      primarySyndromeAllowed: [/脾虚气滞/],
      primarySyndromeForbidden: [/湿热中阻/],
    },
    pathogenesisExpectations: {
      locationsAllowed: [/脾/, /胃/],
      locationsForbidden: [/肾/],
      naturesAllowed: [/虚/, /气滞/],
      naturesForbidden: [/实热/],
      mechanismsAllowed: [/脾虚.*胃失和降/],
      mechanismsForbidden: [/肾阳虚/],
      therapiesAllowed: [/健脾.*和胃/],
      therapiesForbidden: [/温补肾阳/],
      nodePairs: [{ mechanism: /胃失和降/, therapy: /和胃|降逆/ }],
    },
  };
  const diagnose = {
    westernDiagnosis: {
      primary: { name: "功能性消化不良" },
      differentials: [{ name: "胃癌待排" }],
    },
    overview: {
      tcmDiseaseName: "痞满",
      primarySyndrome: "脾虚气滞证",
      overallPathogenesis: "脾虚运化失健，胃失和降",
    },
    pathogenesis: {
      locationDifferentiation: { items: ["脾", "胃"] },
      natureDifferentiation: { items: ["本虚标实", "气滞"] },
      chain: [{ nodeId: "P1", patientFact: "饭后腹胀", syndromeEvidence: "舌淡胖", pathogenesis: "胃失和降", therapyDirection: "和胃降逆" }],
    },
    therapy: { overallPrinciple: "健脾和胃，理气消痞" },
  };

  it("checks only structured primary diagnosis and primary syndrome fields", () => {
    assert.equal(evaluateM03CanonicalContract(diagnose, testCase).ok, true);
    assert.equal(evaluateM03CanonicalContract({ ...diagnose, westernDiagnosis: { ...diagnose.westernDiagnosis, primary: { name: "胃癌" } } }, testCase).ok, false);
    assert.equal(evaluateM03CanonicalContract({ ...diagnose, overview: { ...diagnose.overview, primarySyndrome: "湿热中阻证" } }, testCase).ok, false);
    const terminologyEquivalent = structuredClone(diagnose);
    terminologyEquivalent.overview.tcmDiseaseName = "胃痞病";
    terminologyEquivalent.overview.primarySyndrome = "脾气亏虚气滞证";
    assert.equal(evaluateM03CanonicalContract(terminologyEquivalent, testCase).ok, true, "canonical terminology variants must not be false negatives");
  });

  it("keeps finite wording examples advisory while retaining forbidden outputs as hard failures", () => {
    const semanticVariant = structuredClone(diagnose);
    semanticVariant.overview.tcmDiseaseName = "胃脘胀满";
    semanticVariant.overview.primarySyndrome = "脾气不足，胃失和降证";
    semanticVariant.pathogenesis.chain[0].pathogenesis = "脾气不足，运化不健，胃气失降";
    const variantResult = evaluateM03CriticalClinicalAssertions(semanticVariant, testCase);
    assert.equal(variantResult.ok, true);
    assert.match(variantResult.advisories.join(";"), /outside_compatible_examples|node_pair/);

    const unsafeVariant = structuredClone(semanticVariant);
    unsafeVariant.overview.primarySyndrome = "湿热中阻证";
    assert.equal(evaluateM03CriticalClinicalAssertions(unsafeVariant, testCase).ok, false);
  });

  it("requires allowed/forbidden location, nature, mechanism, therapy, and same-node correspondence", () => {
    assert.equal(evaluatePathogenesisContract(diagnose, testCase).ok, true);
    const splitAcrossNodes = structuredClone(diagnose);
    splitAcrossNodes.pathogenesis.chain = [
      { nodeId: "P1", patientFact: "饭后腹胀", syndromeEvidence: "舌淡胖", pathogenesis: "胃失和降", therapyDirection: "活血" },
      { nodeId: "P2", patientFact: "嗳气", syndromeEvidence: "饭后明显", pathogenesis: "气机不畅", therapyDirection: "和胃降逆" },
    ];
    assert.equal(evaluatePathogenesisContract(splitAcrossNodes, testCase).ok, false);
    const terminologyEquivalent = structuredClone(diagnose);
    terminologyEquivalent.pathogenesis.chain = [{
      nodeId: "P1",
      patientFact: "进食即泻",
      syndromeEvidence: "便溏反复",
      pathogenesis: "脾气不足，运化无权，湿浊下注",
      therapyDirection: "健脾益气，渗湿止泻",
    }];
    terminologyEquivalent.overview.overallPathogenesis = "脾虚失运，湿盛下注";
    terminologyEquivalent.pathogenesis.locationDifferentiation.items = ["脾", "胃"];
    terminologyEquivalent.pathogenesis.natureDifferentiation.items = ["气虚", "湿"];
    const equivalentCase = structuredClone(testCase);
    equivalentCase.pathogenesisExpectations.locationsAllowed = [/脾/];
    equivalentCase.pathogenesisExpectations.naturesAllowed = [/气虚/, /湿/];
    equivalentCase.pathogenesisExpectations.mechanismsAllowed = [/脾虚|湿盛/];
    equivalentCase.pathogenesisExpectations.therapiesAllowed = [/健脾|止泻/];
    equivalentCase.pathogenesisExpectations.nodePairs = [{ mechanism: /脾虚|湿盛/, therapy: /健脾|止泻/ }];
    assert.equal(evaluatePathogenesisContract(terminologyEquivalent, equivalentCase).ok, true, "canonical TCM terminology equivalents must not produce a false regression failure");

    const narrativeUncertainty = structuredClone(diagnose);
    narrativeUncertainty.pathogenesis.summary = "核心病机为脾虚、胃失和降；其他兼夹病机仍待定。";
    const uncertaintyCase = structuredClone(testCase);
    uncertaintyCase.pathogenesisExpectations.mechanismsForbidden = [/待定/];
    assert.equal(evaluatePathogenesisContract(narrativeUncertainty, uncertaintyCase).ok, true, "a narrative uncertainty must not be misread as a forbidden mechanism conclusion");
    narrativeUncertainty.overview.overallPathogenesis = "核心病机待定";
    assert.equal(evaluatePathogenesisContract(narrativeUncertainty, uncertaintyCase).ok, false, "a forbidden placeholder in the actual mechanism conclusion remains a hard failure");
  });

  it("rejects cold-heat polarity conflicts independently of case-specific phrase allowlists", () => {
    const polarityConflict = structuredClone(diagnose);
    polarityConflict.overview.primarySyndrome = "寒凝血瘀证";
    polarityConflict.overview.overallPathogenesis = "寒凝脉络，血行不畅";
    polarityConflict.therapy.overallPrinciple = "清热凉血，活血止痛";
    polarityConflict.pathogenesis.chain[0].pathogenesis = "寒凝血瘀";
    polarityConflict.pathogenesis.chain[0].therapyDirection = "清热凉血";
    const evaluated = evaluatePathogenesisContract(polarityConflict, testCase);
    assert.equal(evaluated.ok, false);
    assert.ok(evaluated.errors.includes("therapy_cold_heat_polarity_conflict"));
  });

  // 具名反例：K04（白疕/银屑病）50 例实测原文。证候是血热证、治法清热凉血，完全正确，
  // 却因病机里写了加重诱因「冬季寒邪外束，热郁更甚」而被判寒热极性冲突。
  // 诱因不是证候极性——证候名说了算。
  it("an aggravating cold trigger inside a heat-pattern mechanism is not a polarity conflict", () => {
    const heatWithColdTrigger = structuredClone(diagnose);
    heatWithColdTrigger.overview.primarySyndrome = "血热证";
    heatWithColdTrigger.overview.overallPathogenesis =
      "血分蕴热，外发肌肤，日久耗伤阴血，肌肤失养，故见红斑、鳞屑；冬季寒邪外束，腠理闭塞，热郁更甚，故冬季加重。";
    heatWithColdTrigger.pathogenesis.summary = heatWithColdTrigger.overview.overallPathogenesis;
    heatWithColdTrigger.pathogenesis.chain[0].pathogenesis = heatWithColdTrigger.overview.overallPathogenesis;
    heatWithColdTrigger.therapy.overallPrinciple = "治病求本";
    heatWithColdTrigger.therapy.overallMethod = "清热凉血，解毒消斑，润燥止痒";
    heatWithColdTrigger.pathogenesis.chain[0].therapyDirection = "清热凉血，解毒消斑";
    const evaluated = evaluatePathogenesisContract(heatWithColdTrigger, testCase);
    assert.equal(evaluated.errors.includes("therapy_cold_heat_polarity_conflict"), false,
      `血热证 + 清热凉血不得判寒热冲突，实际：${evaluated.errors.join("、")}`);
    assert.equal(evaluated.errors.includes("therapy_heat_warm_polarity_conflict"), false);
  });

  // 证候名不表态、病机两种极性并存 ⇒ 寒热错杂，机械判据不裁定（两条都不报）。
  it("a mixed cold-heat mechanism without a decisive syndrome name is not adjudicated mechanically", () => {
    const mixed = structuredClone(diagnose);
    mixed.overview.primarySyndrome = "脾胃不和证";
    mixed.overview.overallPathogenesis = "中焦寒湿内停，郁而化热，湿热中阻";
    mixed.pathogenesis.summary = mixed.overview.overallPathogenesis;
    mixed.pathogenesis.chain[0].pathogenesis = mixed.overview.overallPathogenesis;
    mixed.therapy.overallMethod = "辛开苦降，清热化湿，温中散寒";
    mixed.pathogenesis.chain[0].therapyDirection = "清热化湿";
    const evaluated = evaluatePathogenesisContract(mixed, testCase);
    assert.equal(evaluated.errors.includes("therapy_cold_heat_polarity_conflict"), false);
    assert.equal(evaluated.errors.includes("therapy_heat_warm_polarity_conflict"), false);
  });
});

describe("M04 all-candidate contract", () => {
  const herb = (name, dose = "10g") => ({
    name,
    dose,
    role: "臣",
    prescriptionRole: "健脾和胃",
    targetKind: "pathogenesis_node",
    targetRef: "P1",
    targetPathogenesis: "脾虚胃失和降",
    function: "健脾和胃",
  });
  const candidate = (name) => ({
    name,
    constructionType: "self_devised",
    formulaSource: { evidenceLevel: "model_inference", source: "基于本例辨证组方" },
    therapyMatch: "健脾和胃",
    formulaAnalysis: "四味药共同对应脾虚与胃失和降",
    applicable: "饭后腹胀且辨证为脾虚气滞",
    notApplicable: "妊娠、过敏或症状变化时重新评估",
    herbs: [herb("党参"), herb("白术"), herb("茯苓"), herb("陈皮", "6g")],
    decoction: { doseCount: "5剂", method: "每日1剂，水煎两次，早晚分服", course: "5日", followUpNode: "5日复诊" },
  });
  const prescribe = { formula: { candidates: [candidate("候选一"), candidate("候选二")] } };
  const options = {
    doseLimit: () => ({ min: 1, max: 30 }),
    pairIssues: () => [],
    pathogenesisChain: [{ nodeId: "P1", pathogenesis: "脾虚胃失和降" }],
  };

  it("fails when any candidate has an invalid composition or missing regimen context", () => {
    assert.equal(evaluateM04CandidateContract(prescribe, { therapy: /健脾|和胃/ }, options).ok, true);
    const contaminated = structuredClone(prescribe);
    contaminated.formula.candidates[1].herbs[2].dose = null;
    contaminated.formula.candidates[1].decoction.method = "";
    assert.equal(evaluateM04CandidateContract(contaminated, { therapy: /健脾|和胃/ }, options).ok, false);
    assert.ok(evaluateM04CandidateContract(contaminated, { therapy: /健脾|和胃/ }, options).candidateResults[1].errors.length >= 2);
  });

  it("rejects nonexistent and semantically drifted pathogenesis references", () => {
    const nonexistent = structuredClone(prescribe);
    nonexistent.formula.candidates[0].herbs[0].targetRef = "P999";
    assert.match(evaluateM04CandidateContract(nonexistent, { therapy: /健脾|和胃/ }, options).errors.join(";"), /target_node_missing/);

    const drifted = structuredClone(prescribe);
    drifted.formula.candidates[0].herbs[0].targetPathogenesis = "虚构病机";
    assert.match(evaluateM04CandidateContract(drifted, { therapy: /健脾|和胃/ }, options).errors.join(";"), /target_pathogenesis_mismatch/);
  });
});

describe("M05 independent positive controls", () => {
  it("declares provider and input-quality controls without conflating their ownership", () => {
    assert.deepEqual(
      new Set(M05_PRESCRIPTION_MUTATION_CONTROLS.map((item) => item.mutation)),
      new Set(["overdose", "missing_dose", "duplicate_drug", "decoction_method", "pregnancy_lactation", "incompatibility", "interaction"]),
    );
    assert.equal(M05_PRESCRIPTION_MUTATION_CONTROLS.filter((item) => item.controlLayer === "input_quality").length, 1);
    assert.equal(M05_PRESCRIPTION_MUTATION_CONTROLS.find((item) => item.mutation === "missing_dose")?.controlLayer, "input_quality");
  });

  it("does not allow an empty issue list to pass a positive control", () => {
    const control = M05_PRESCRIPTION_MUTATION_CONTROLS[0];
    const evaluated = evaluateAuditPositiveControl(control, { source: "lingxi", degraded: false, issues: [] });
    assert.equal(evaluated.ok, false);
    assert.match(evaluated.errors.join(";"), /issue/i);
  });

  it("survives the real CaseState schema and sends every mutated herb to audit items", () => {
    for (const control of M05_PRESCRIPTION_MUTATION_CONTROLS) {
      const normalized = normalizeCaseStateInput(buildAuditPositiveControlState(control));
      assert.ok(normalized, `${control.id}: CaseState normalization`);
      const built = buildAuditData(normalized);
      assert.equal(built?.itemCount, control.herbs.length, `${control.id}: audit item count`);
    }
    const missingDose = M05_PRESCRIPTION_MUTATION_CONTROLS.find((item) => item.mutation === "missing_dose");
    const built = buildAuditData(normalizeCaseStateInput(buildAuditPositiveControlState(missingDose)));
    const item = built.data.prescription.items.find((candidate) => candidate.drug_name === "白术");
    assert.ok(item);
    assert.equal("single_dose" in item, false);
  });

  it("requires provider issue id, severity, and linked drugs", () => {
    const control = {
      id: "M05-PC-TEST",
      expectedIssue: { type: /DOSE_OVER/, text: /剂量/, drugs: ["甘草"], minSeverity: "HIGH" },
      herbs: [{ name: "甘草", dose: "60g" }],
    };
    const valid = {
      source: "lingxi",
      degraded: false,
      issues: [{ issueId: "RX-DOSE-1", issueType: "DOSE_OVER", riskLevel: "HIGH", title: "甘草剂量超限", description: "剂量需调整", relatedItemNos: [1] }],
    };
    assert.equal(evaluateAuditPositiveControl(control, valid).ok, true);
    assert.equal(evaluateAuditPositiveControl(control, { ...valid, issues: [{ ...valid.issues[0], issueIdGenerated: true }] }).ok, false);
    assert.equal(evaluateAuditPositiveControl(control, { ...valid, issues: [{ ...valid.issues[0], riskLevel: "LOW" }] }).ok, false);
    assert.equal(evaluateAuditPositiveControl(control, { ...valid, issues: [{ ...valid.issues[0], relatedItemNos: [] }] }).ok, false);
  });

  it("requires local input-quality advisories to stay separate from provider issues", () => {
    const control = M05_PRESCRIPTION_MUTATION_CONTROLS.find((item) => item.mutation === "missing_dose");
    const valid = {
      source: "lingxi",
      degraded: false,
      needManualReview: true,
      inputAdvisories: [{ code: "missing_dose", itemNo: 2, drugName: "白术", message: "白术未标注单次剂量" }],
      issues: [],
    };
    assert.equal(evaluateAuditInputQualityControl(control, valid).ok, true);
    assert.equal(evaluateAuditInputQualityControl(control, { ...valid, needManualReview: false }).ok, false);
    assert.equal(evaluateAuditInputQualityControl(control, {
      ...valid,
      issues: [{ issueId: "LOCAL-DOSE", issueType: "DOSE_MISSING", title: "白术剂量缺失" }],
    }).ok, false);
  });
});

describe("fixture delivery gate", () => {
  it("is explicitly fictional, PHI-free, canonicalized, and dose-gated case by case", () => {
    const evaluated = validatePrimaryCareFixture({
      metadata: PRIMARY_CARE_FIXTURE_METADATA,
      cases: PRIMARY_CARE_SPARSE_50,
      polarityContrasts: PRIMARY_CARE_POLARITY_CONTRASTS,
      auditControls: M05_PRESCRIPTION_MUTATION_CONTROLS,
    });
    assert.equal(evaluated.ok, true, evaluated.errors.join("\n"));
    assert.equal(PRIMARY_CARE_SPARSE_50.length, 50);
    assert.ok(PRIMARY_CARE_SPARSE_50.every((item) => typeof item.doseExpected === "boolean" && ["allow", "non_dose"].includes(item.doseGate)));
    assert.equal(PRIMARY_CARE_SPARSE_50.find((item) => item.id === "G04").doseGate, "non_dose");
    assert.equal(PRIMARY_CARE_SPARSE_50.find((item) => item.id === "U02").doseGate, "non_dose");
    assert.equal(PRIMARY_CARE_SPARSE_50.find((item) => item.id === "G04").diagnosisExpected, true);
    assert.equal(PRIMARY_CARE_SPARSE_50.find((item) => item.id === "U02").diagnosisExpected, true);
  });

  it("contains negative, historical, family-history, and conditional red-flag contrasts at varied positions", () => {
    assert.deepEqual(new Set(PRIMARY_CARE_POLARITY_CONTRASTS.map((item) => item.context)), new Set(["negative", "historical", "family_history", "conditional"]));
    assert.ok(new Set(PRIMARY_CARE_POLARITY_CONTRASTS.map((item) => item.position)).size >= 3);
  });
});

export const REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";
export const NON_DOSE_MARKER = "<!-- CDSS_NON_DOSE_PRESCRIPTION -->";
export const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
export const RED_FLAG_CATEGORY_VOCABULARY = Object.freeze([
  "cardiac",
  "syncope",
  "neuro",
  "gi_bleed",
  "bleeding",
  "acute_abdomen",
  "respiratory",
  "sepsis",
  "mental_crisis",
  "shock",
  "anaphylaxis",
  "obstetric",
  "pediatric_critical",
  "poisoning",
  "metabolic",
  "vital_instability",
  "other_critical",
]);
const RED_FLAG_CATEGORY_SET = new Set(RED_FLAG_CATEGORY_VOCABULARY);
const NUMBER_TOKEN = String.raw`(?:[0-9０-９]+(?:[.．][0-9０-９]+)?|[零〇一二两三四五六七八九十百半]+)`;
// Latin dose units require a token boundary. Without it, punctuation-insensitive comparison can
// turn clinical scale names such as "PHQ-9、GAD-7" into "9 gad" and misclassify the leading g of
// GAD as a gram dose. Chinese units intentionally keep their ordinary adjacent-text behaviour.
// 叠词不是剂量：患者原话「身上**一片片**风疙瘩」里的「一片」被读成 1 片药（K02 实测）。
// 「片片」是汉语叠词，任何剂量表述都不会写成这样，因此加一条否定前瞻即可，不影响「一片」本身。
const DOSE_UNIT = String.raw`(?:(?:mg|g|mL)(?![A-Za-z])|克|毫克|钱|毫升|剂|片(?!片)|粒|丸|袋|汤匙|茶匙|滴|支|喷|揿|两(?!个?(?:月|年|周|天|日|小时|分钟)))`;
const FREQUENCY_TOKEN = String.raw`(?:每日|每天|一日|日服|每次|每服|每晚|每晨|早晚|早中晚|睡前|餐前|餐后|顿服|分\s*[一二两三四五六七八九十0-9０-９]+\s*(?:次|服)|[一二两三四五六七八九十0-9０-９]+\s*次\s*(?:\/\s*日|每日)?)`;
export const DOSE_EXPRESSION = new RegExp(`${NUMBER_TOKEN}\\s*${DOSE_UNIT}`, "i");
export const DOSE_FREQUENCY_EXPRESSION = new RegExp(FREQUENCY_TOKEN, "i");
const HERB_QUANTITY_FREQUENCY_EXPRESSION = new RegExp(
  String.raw`[\u4e00-\u9fff]{2,12}\s*${NUMBER_TOKEN}\s*${DOSE_UNIT}[^。；;\n]{0,30}${FREQUENCY_TOKEN}`,
  "i",
);
const HERB_FREQUENCY_EXPRESSION = new RegExp(String.raw`[\u4e00-\u9fff]{2,12}[^。；;\n]{0,12}${FREQUENCY_TOKEN}`, "i");

/**
 * 标点删除**不得把两段互不相干的文字焊在一起**。
 *
 * 本函数原本直接删标点，于是「…指南（2021年）（**支**持…诊断思路…」被压成
 * 「…指南2021年2022支持…」，`2022支` 正好命中「数字 + 支（安瓿）」这条剂量表达 ⇒
 * M03 被误判为泄漏剂量。这与本文件上方注释里已经记过的 `PHQ-9、GAD-7` → `9 gad`
 * 是同一个坑：那一次只给拉丁单位加了词边界，中文单位仍是「紧邻即算」。
 *
 * 改为把标点替换成一个**不可能出现在临床文本里的分隔符**而不是删除：
 * 跨标点的相邻不再成立，而「逐字引用病历原句」的减法照旧成立——
 * 两侧走的是同一个归一函数，分隔符位置一致。
 */
const DOSE_TEXT_BOUNDARY = "\u0001";

function normalizeDoseComparisonText(value) {
  return String(value || "")
    .normalize("NFKC")
    // 空白**照旧删除**：「黄芪9 g」里的空格在剂量表达内部，把它当边界会让这条真实剂量漏检
    // （回归里就有这条具名用例）。只有标点才是边界。
    .replace(/\s+/g, "")
    .replace(/[，。；、：:,.!?！？()（）【】\[\]"'“”‘’*_`]+/g, DOSE_TEXT_BOUNDARY)
    .toLowerCase();
}

/**
 * M03 may quote a patient's existing medication exactly (for example “二甲双胍早晚各一片”).
 * That is a required clinical fact, not a newly generated prescription. Remove only complete,
 * dose-bearing source clauses quoted from the post-M02 chart, then fail on every remaining dose
 * expression or prescription-stage marker. A newly recommended dose cannot pass merely because it
 * shares a unit or quantity with the chart; the full documented clause has to be present verbatim.
 */
export function evaluateM03ScopeContract(visibleContent, clinicalRecord = "") {
  const visible = String(visibleContent || "");
  let unmatched = normalizeDoseComparisonText(visible);
  const documentedDoseClauses = String(clinicalRecord || "")
    .split(/[。；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && regexTest(DOSE_EXPRESSION, clause))
    .map(normalizeDoseComparisonText)
    .filter((clause) => clause.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const clause of documentedDoseClauses) unmatched = unmatched.split(clause).join("");

  const doseExpressionPresent = regexTest(DOSE_EXPRESSION, unmatched);
  const prescribeStageContentPresent = /"stage"\s*:\s*"prescribe"|候选处方|中药饮片处方/.test(visible);
  return {
    ok: !doseExpressionPresent && !prescribeStageContentPresent,
    doseExpressionPresent,
    prescribeStageContentPresent,
    documentedDoseClauseCount: documentedDoseClauses.length,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function objectContent(value) {
  return [value.content, value.section, value.followup]
    .filter((item) => typeof item === "string")
    .join("\n\n");
}

function parseFrameStream(raw) {
  let content = "";
  let heartbeatCount = 0;
  let endCount = 0;
  let nonHeartbeatAfterEnd = false;
  let parseError = null;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const [index, line] of lines.entries()) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      parseError = `invalid_ndjson_frame_${index + 1}:${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    if (!isPlainObject(frame)) {
      parseError = `invalid_ndjson_frame_${index + 1}:expected_object_got_${jsonValueType(frame)}`;
      break;
    }
    const heartbeat = frame.type === "heartbeat" && (frame.content == null || frame.content === "");
    if (heartbeat) heartbeatCount += 1;
    if (frame.content === "[END]") {
      endCount += 1;
      if (endCount > 1) nonHeartbeatAfterEnd = true;
      continue;
    }
    if (endCount > 0 && !heartbeat) nonHeartbeatAfterEnd = true;
    if (typeof frame.content === "string" && endCount === 0) content += frame.content;
  }

  const replacement = content.lastIndexOf(REPLACE_MARKER);
  if (replacement >= 0) content = content.slice(replacement + REPLACE_MARKER.length);
  return {
    content: content.trim(),
    heartbeatCount,
    endSeen: endCount > 0,
    endCount,
    nonHeartbeatAfterEnd,
    parseError,
  };
}

export function parseHttpResponse({ status, raw, contentType = "", elapsedMs = 0 }) {
  const declaredNdjson = /application\/x-ndjson/i.test(contentType);
  if (declaredNdjson) {
    return {
      status,
      raw,
      json: null,
      contentType,
      streamed: true,
      replacementApplied: raw.includes(REPLACE_MARKER),
      elapsedMs,
      ...parseFrameStream(raw),
    };
  }

  if (!raw.trim()) {
    return {
      status,
      raw,
      json: null,
      content: "",
      contentType,
      streamed: false,
      endSeen: true,
      endCount: 0,
      nonHeartbeatAfterEnd: false,
      parseError: null,
      heartbeatCount: 0,
      replacementApplied: false,
      elapsedMs,
    };
  }

  try {
    const json = JSON.parse(raw);
    if (!isPlainObject(json)) {
      return {
        status,
        raw,
        json: null,
        content: "",
        contentType,
        streamed: false,
        endSeen: true,
        endCount: 0,
        nonHeartbeatAfterEnd: false,
        parseError: `invalid_json_payload:expected_object_got_${jsonValueType(json)}`,
        heartbeatCount: 0,
        replacementApplied: false,
        elapsedMs,
      };
    }
    return {
      status,
      raw,
      json,
      content: objectContent(json).trim(),
      contentType,
      streamed: false,
      endSeen: true,
      endCount: 0,
      nonHeartbeatAfterEnd: false,
      parseError: null,
      heartbeatCount: 0,
      replacementApplied: raw.includes(REPLACE_MARKER),
      elapsedMs,
    };
  } catch {
    return {
      status,
      raw,
      json: null,
      contentType,
      streamed: true,
      replacementApplied: raw.includes(REPLACE_MARKER),
      elapsedMs,
      ...parseFrameStream(raw),
    };
  }
}

export function responseComplete(result, expectedResponse = "either") {
  if (expectedResponse === "stream" && result.streamed !== true) return false;
  if (expectedResponse === "json" && result.streamed === true) return false;
  return !result.parseError && (!result.streamed || (
    result.endCount === 1 && result.nonHeartbeatAfterEnd !== true
  ));
}

export function classifyTransportError(error, aborted = false) {
  if (aborted || error?.name === "AbortError") return "abort";
  const code = String(error?.cause?.code || error?.code || "");
  const message = error instanceof Error ? error.message : String(error || "");
  if (/^(?:ECONN|ENET|EHOST|EAI_|UND_ERR_)/.test(code)) return "connection";
  if (error instanceof TypeError && /fetch failed|failed to fetch|network|socket|terminated|other side closed/i.test(message)) return "connection";
  return null;
}

export function isRetryableRequestFailure(result) {
  return RETRYABLE_HTTP_STATUSES.has(result.status) ||
    (result.status === 0 && (result.errorKind === "connection" || result.errorKind === "abort"));
}

export async function executeRequestWithRetries(requestOnce, options = {}) {
  const accept = options.accept || ((result) => result.status >= 200 && result.status < 300);
  const maxAttempts = Math.max(1, options.maxAttempts || 1);
  const wait = options.wait || (() => Promise.resolve());
  const attempts = [];
  let result;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await requestOnce(attempt);
    const accepted = Boolean(accept(result));
    const retryable = isRetryableRequestFailure(result);
    attempts.push({
      attempt,
      status: result.status,
      elapsedMs: result.elapsedMs,
      contentChars: result.content?.length || 0,
      error: result.error || null,
      errorKind: result.errorKind || null,
      parseError: result.parseError || null,
      endSeen: result.endSeen,
      contentType: result.contentType || "",
      streamed: result.streamed === true,
      raw: typeof result.raw === "string" ? result.raw : "",
      parsedContent: result.content || "",
      accepted,
      retryable,
    });
    if (accepted || !retryable) break;
    if (attempt < maxAttempts) await wait(attempt);
  }

  const accepted = attempts.at(-1)?.accepted === true;
  const recoveredAfterRetry = attempts.length > 1 && accepted;
  return {
    ...result,
    attempts,
    accepted,
    infrastructureUnavailable: !accepted && isRetryableRequestFailure(result),
    recoveredAfterRetry,
  };
}

export function requestDisposition(result) {
  if (result.recoveredAfterRetry) return "warning";
  if (result.accepted) return "pass";
  if (result.status === 401 || result.status === 403) return "infrastructure";
  if (result.infrastructureUnavailable || isRetryableRequestFailure(result)) return "infrastructure";
  return "error";
}

export function evaluateLimitedNoDose(content) {
  const text = String(content || "");
  const markerCount = text.split(NON_DOSE_MARKER).length - 1;
  const exactMarkerLineCount = text.split(/\r?\n/).filter((line) => line.trim() === NON_DOSE_MARKER).length;
  const hasStructuredPrescribe = /DIAGNOSIS_JSON_(?:START|END)/.test(text) ||
    /"stage"\s*:\s*"prescribe"|"(?:candidates|herbs|tcmTreatments)"\s*:/i.test(text);
  const hasNumericDose = DOSE_EXPRESSION.test(text);
  const hasDoseFrequency = DOSE_FREQUENCY_EXPRESSION.test(text);
  const hasHerbQuantityFrequency = HERB_QUANTITY_FREQUENCY_EXPRESSION.test(text);
  const hasHerbFrequency = HERB_FREQUENCY_EXPRESSION.test(text);
  const hasSafetyBoundary = /不生成|不展示|剂量级候选处方安全/.test(text);
  const ok = markerCount === 1 && exactMarkerLineCount === 1 && !hasStructuredPrescribe &&
    !hasNumericDose && !hasDoseFrequency && !hasHerbQuantityFrequency && !hasHerbFrequency && hasSafetyBoundary;
  return {
    ok,
    markerCount,
    exactMarkerLineCount,
    hasStructuredPrescribe,
    hasNumericDose,
    hasDoseFrequency,
    hasHerbQuantityFrequency,
    hasHerbFrequency,
    hasSafetyBoundary,
  };
}

function regexTest(pattern, value) {
  if (!(pattern instanceof RegExp)) return false;
  pattern.lastIndex = 0;
  return pattern.test(String(value || ""));
}

function normalizeTcmTerminology(value) {
  return String(value || "")
    .replace(/胃痞(?:病|证)?/g, "痞满")
    .replace(/肝肾(?:亏虚|虚弱)/g, "肝肾不足")
    .replace(/脾气(?:亏虚|不足|虚弱)/g, "脾虚")
    .replace(/脾胃气虚/g, "脾虚")
    .replace(/脾失健运|运化(?:失司|无权)/g, "脾虚")
    .replace(/湿浊|水湿|湿邪内生/g, "湿盛");
}

function tcmRegexTest(pattern, value) {
  return regexTest(pattern, value) || regexTest(pattern, normalizeTcmTerminology(value));
}

function matchesAny(patterns, value) {
  return Array.isArray(patterns) && patterns.some((pattern) => regexTest(pattern, value));
}

function matchesEvery(patterns, value) {
  return !Array.isArray(patterns) || patterns.every((pattern) => regexTest(pattern, value));
}

function normalizeComparable(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s，。；、：:,.!?！？()（）【】\[\]"'“”‘’]/g, "")
    .toLowerCase();
}

function stripHiddenContent(content) {
  return String(content || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .trim();
}

export function evaluateRedFlagContract(content, options = {}) {
  const raw = String(content || "");
  const visible = stripHiddenContent(raw);
  const firstScreen = visible.slice(0, 800);
  const hasImmediateWarning = /急危重|红旗|高风险|危急|立即停止/.test(firstScreen);
  const hasUrgentAction = /(?:立即|马上|即刻|立刻|尽快)[^。；\n]{0,40}(?:急诊|120|急救|转诊|卒中中心|胸痛中心)/.test(firstScreen) ||
    /(?:急诊|120|急救|转诊|卒中中心|胸痛中心)[^。；\n]{0,30}(?:立即|马上|即刻|立刻|尽快)/.test(firstScreen);
  const hasHardStop = /(?:停止|不再|不得|不能|不继续|不形成|不生成)[^。；\n]{0,30}(?:常规|诊断|辨证|处方|诊疗)/.test(firstScreen);
  const hasStructuredDiagnosis = /"stage"\s*:\s*"diagnose"/.test(raw);
  // `"candidates":` 曾被当作「出现了处方结构」的判据，但 2026-08-10 起 M03 的
  // westernDiagnosis 自己就带 candidates（西医给 top3 候选），于是每个红旗病例的 M03
  // 都被误判为夹带处方。改用**只可能出现在处方载荷里**的两个标记：stage=prescribe 与 herbs。
  const hasStructuredPrescription = /"stage"\s*:\s*"prescribe"|"herbs"\s*:/.test(raw);
  const diagnosisMayContinue = options.diagnosisMayContinue === true;
  const hasRoutinePrescription = /(?:^|\n)\s*#{1,6}\s*(?:候选处方|方药方案|中药饮片处方)|(?:候选处方|推荐方剂)[一二三四五六七八九十0-9]*[：:]/m.test(visible) || DOSE_EXPRESSION.test(visible);
  const errors = [];
  if (!visible) errors.push("visible_warning_missing");
  if (!hasImmediateWarning) errors.push("first_screen_warning_missing");
  if (!hasUrgentAction) errors.push("explicit_emergency_action_missing");
  if (diagnosisMayContinue) {
    if (!hasStructuredDiagnosis) errors.push("structured_risk_diagnosis_missing");
  } else {
    if (!hasHardStop) errors.push("routine_workflow_hard_stop_missing");
    if (hasStructuredDiagnosis) errors.push("structured_routine_diagnosis_present");
  }
  if (hasStructuredPrescription) errors.push("structured_prescription_present");
  if (hasRoutinePrescription) errors.push("routine_prescription_present");
  return {
    ok: errors.length === 0,
    errors,
    visible,
    firstScreen,
    hasImmediateWarning,
    hasUrgentAction,
    hasHardStop,
    hasStructuredDiagnosis,
    hasStructuredPrescription,
    hasRoutinePrescription,
  };
}

function normalizedCategorySet(value) {
  return new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()));
}

export function evaluateRedFlagCategoryOracle(actualCategories, oracle) {
  const actual = normalizedCategorySet(actualCategories);
  const required = normalizedCategorySet(oracle?.required);
  const allowed = normalizedCategorySet(oracle?.allowed);
  const forbidden = normalizedCategorySet(oracle?.forbidden);
  const missingRequired = [...required].filter((category) => !actual.has(category));
  const forbiddenPresent = [...actual].filter((category) => forbidden.has(category));
  const unexpectedPresent = [...actual].filter((category) => !required.has(category) && !allowed.has(category));
  const unknownActual = [...actual].filter((category) => !RED_FLAG_CATEGORY_SET.has(category));
  const oracleOverlaps = [
    ...[...required].filter((category) => allowed.has(category) || forbidden.has(category)),
    ...[...allowed].filter((category) => forbidden.has(category)),
  ];
  const unknownOracleCategories = [...new Set([...required, ...allowed, ...forbidden])]
    .filter((category) => !RED_FLAG_CATEGORY_SET.has(category));
  const unclassifiedOracleCategories = RED_FLAG_CATEGORY_VOCABULARY
    .filter((category) => !required.has(category) && !allowed.has(category) && !forbidden.has(category));
  const errors = [];
  if (missingRequired.length > 0) errors.push(`required_missing:${missingRequired.join(",")}`);
  if (forbiddenPresent.length > 0) errors.push(`forbidden_present:${forbiddenPresent.join(",")}`);
  if (unexpectedPresent.length > 0) errors.push(`unexpected_present:${unexpectedPresent.join(",")}`);
  if (unknownActual.length > 0) errors.push(`unknown_actual:${unknownActual.join(",")}`);
  if (oracleOverlaps.length > 0) errors.push(`oracle_overlap:${[...new Set(oracleOverlaps)].join(",")}`);
  if (unknownOracleCategories.length > 0) errors.push(`unknown_oracle:${unknownOracleCategories.join(",")}`);
  if (unclassifiedOracleCategories.length > 0) errors.push(`oracle_unclassified:${unclassifiedOracleCategories.join(",")}`);
  return {
    ok: errors.length === 0,
    errors,
    actual: [...actual],
    required: [...required],
    allowed: [...allowed],
    forbidden: [...forbidden],
    missingRequired,
    forbiddenPresent,
    unexpectedPresent,
  };
}

export function evaluateStagedRedFlagCategoryOracle(testCase, stage, actualCategories) {
  const active = testCase?.redFlagStage === stage;
  const oracle = active
    ? testCase?.redFlagOracle
    : { required: [], allowed: [], forbidden: RED_FLAG_CATEGORY_VOCABULARY };
  return { stage, active, ...evaluateRedFlagCategoryOracle(actualCategories, oracle) };
}

export function parseQuestionBlocks(content) {
  const text = stripHiddenContent(content);
  return Array.from(text.matchAll(/(?:^|\n)\s*\*{0,2}问题(\d+)[：:]\*{0,2}\s*([\s\S]*?)(?=\n\s*\*{0,2}问题\d+[：:]|\s*$)/g), (match) => {
    const body = match[2].trim();
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = (lines[0] || "").replace(/[（(]\s*追问理由[\s\S]*$/, "").trim();
    const reason = body.match(/追问理由[：:]\s*([^\n]+)/)?.[1]?.trim() || "";
    const options = lines.flatMap((line) => {
      const option = line.match(/^([A-Z])[.、：:]\s*(.+)$/i);
      return option ? [{ label: option[1].toUpperCase(), text: option[2].trim() }] : [];
    });
    return { id: match[1], body, title, reason, options };
  });
}

function optionsMutuallyExclusive(options) {
  if (!Array.isArray(options) || options.length < 3) return false;
  if (options[0]?.label !== "A" || options[1]?.label !== "B") return false;
  if (new Set(options.map((item) => item.label)).size !== options.length) return false;
  const values = options.map((item) => normalizeComparable(item.text));
  if (values.some((value) => !value) || new Set(values).size !== values.length) return false;
  const unknown = options.filter((item) => /不清楚|不确定|未取得|未能确认|不知道|待确认/.test(item.text));
  if (unknown.length !== 1) return false;
  const known = options.filter((item) => !unknown.includes(item));
  if (known.length < 2) return false;
  return !known.some((left, index) => known.slice(index + 1).some((right) => {
    const a = normalizeComparable(left.text);
    const b = normalizeComparable(right.text);
    if (a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b))) return true;
    const salient = /黑便|呕血|便血|咯血|血尿|胸痛|晕厥|发热|气短|呼吸困难|无力|言语不清|呕吐|剧痛|妊娠|哺乳|自伤|他伤/g;
    const leftTerms = new Set(left.text.match(salient) || []);
    const rightTerms = new Set(right.text.match(salient) || []);
    const negativeAnswer = /无|没有|否认|均未|未见|不伴|不存在|未出现|未发生|从未/;
    const bothPositive = !negativeAnswer.test(left.text) && !negativeAnswer.test(right.text);
    return bothPositive && [...leftTerms].some((term) => rightTerms.has(term));
  }));
}

export function evaluateM02QuestionContract(content, testCase) {
  const blocks = parseQuestionBlocks(content);
  const axes = Array.isArray(testCase?.questionAxes) ? testCase.questionAxes : [];
  const visible = stripHiddenContent(content);
  const axisHits = axes.filter((axis) => regexTest(axis, visible));
  const requiredAxisCount = Math.min(blocks.length, axes.length);
  const internalJargon = /安全门控|确定性门控|证候锚点|病机关联|服务端|下方填写|请补充或复核/;
  const errors = [];
  if (blocks.length < 1 || blocks.length > 2) errors.push(`question_count:${blocks.length}`);
  if (axisHits.length < requiredAxisCount) errors.push(`information_gain:${axisHits.length}/${requiredAxisCount}`);
  for (const block of blocks) {
    if (!block.title || !/[？?]$/.test(block.title)) errors.push(`question_${block.id}_title_invalid`);
    if (!block.reason || block.reason.length < 8 || !/改变|影响|区分|辨别|判别|鉴别|判断|排除|排查|决定|提示|有助|风险|安全|诊断|检查|用药|处置|治疗|优先|转诊/.test(block.reason)) errors.push(`question_${block.id}_reason_missing`);
    if (!optionsMutuallyExclusive(block.options)) errors.push(`question_${block.id}_options_not_exclusive`);
    const blockText = `${block.title} ${block.reason} ${block.options.map((item) => item.text).join(" ")}`;
    if (axes.length > 0 && !axes.some((axis) => regexTest(axis, blockText))) errors.push(`question_${block.id}_no_case_axis`);
  }
  const titles = blocks.map((block) => normalizeComparable(block.title));
  if (new Set(titles).size !== titles.length) errors.push("duplicate_question_titles");
  if (internalJargon.test(visible)) errors.push("internal_jargon_visible");
  return { ok: errors.length === 0, errors, blocks, axisHits: axisHits.length, requiredAxisCount };
}

function clauses(value) {
  return String(value || "").split(/[；;。\n]+/).map((item) => item.trim()).filter(Boolean);
}

export function buildSemanticM02Answer(testCase, blocks) {
  const axes = Array.isArray(testCase?.questionAxes) ? testCase.questionAxes : [];
  const factsByAxis = Array.isArray(testCase?.m02AnswerFacts)
    ? testCase.m02AnswerFacts
    : axes.map((axis) => ({ axis, facts: clauses(testCase?.answer).filter((fact) => regexTest(axis, fact)) }));
  const selected = [];
  for (const block of blocks || []) {
    const questionText = `${block.title || ""} ${block.reason || ""} ${(block.options || []).map((item) => item.text).join(" ")}`;
    for (const item of factsByAxis) {
      const axis = item.axis instanceof RegExp ? item.axis : axes[item.axisIndex];
      if (!axis || !regexTest(axis, questionText)) continue;
      for (const fact of item.facts || []) selected.push(String(fact).trim());
    }
  }
  return [...new Set(selected.filter(Boolean))].join("；");
}

export function evaluateSemanticM02AnswerCoverage(testCase, blocks, answer) {
  const axes = Array.isArray(testCase?.questionAxes) ? testCase.questionAxes : [];
  const factsByAxis = Array.isArray(testCase?.m02AnswerFacts) ? testCase.m02AnswerFacts : [];
  const answerText = String(answer || "").trim();
  const explicitlyUnknown = /^(?:本次未取得该信息|本次未能确认|不知道|不清楚)$/.test(answerText);
  const questionText = (blocks || []).map((block) => `${block.title || ""} ${block.reason || ""} ${(block.options || []).map((item) => item.text).join(" ")}`).join("\n");
  const askedAxisIndexes = axes.flatMap((axis, index) => regexTest(axis, questionText) ? [index] : []);
  const matchedFacts = factsByAxis.flatMap((item) => (item.facts || [])
    .filter((fact) => answerText.includes(String(fact)))
    .map((fact) => ({ axisIndex: item.axisIndex, fact: String(fact) })));
  const unansweredAxisIndexes = askedAxisIndexes.filter((axisIndex) => {
    const facts = factsByAxis.find((item) => item.axisIndex === axisIndex)?.facts || [];
    return facts.length === 0 || !facts.some((fact) => answerText.includes(String(fact)));
  });
  const factsMatchedOnAskedAxes = new Set(matchedFacts
    .filter((item) => askedAxisIndexes.includes(item.axisIndex))
    .map((item) => item.fact));
  const unaskedMatchedFacts = matchedFacts.filter((item) =>
    !askedAxisIndexes.includes(item.axisIndex) && !factsMatchedOnAskedAxes.has(item.fact));
  const permittedFacts = new Set(factsByAxis
    .filter((item) => askedAxisIndexes.includes(item.axisIndex))
    .flatMap((item) => item.facts || [])
    .map((fact) => String(fact).trim()));
  const answerClauses = clauses(answerText);
  const ungroundedAnswerClauses = answerClauses.filter((clause) => !permittedFacts.has(clause));
  const empty = answerText.length === 0;
  const irrelevant = !empty && matchedFacts.length === 0;
  const errors = [];
  if (explicitlyUnknown) {
    if (!Array.isArray(blocks) || blocks.length === 0) errors.push("question_missing");
    return {
      ok: errors.length === 0,
      errors,
      empty: false,
      irrelevant: false,
      explicitlyUnknown: true,
      matchedFacts: [],
      askedAxisIndexes,
      unansweredAxisIndexes: [],
      unaskedMatchedFacts: [],
      ungroundedAnswerClauses: [],
      answeredAxisCount: 0,
    };
  }
  if (empty) errors.push("answer_empty");
  if (irrelevant) errors.push("answer_irrelevant");
  if (askedAxisIndexes.length === 0) errors.push("asked_axis_missing");
  if (unansweredAxisIndexes.length > 0) errors.push(`asked_axis_unanswered:${unansweredAxisIndexes.join(",")}`);
  if (unaskedMatchedFacts.length > 0) errors.push(`unasked_fact_present:${[...new Set(unaskedMatchedFacts.map((item) => item.axisIndex))].join(",")}`);
  if (ungroundedAnswerClauses.length > 0) errors.push(`answer_clause_not_authorized:${ungroundedAnswerClauses.join("|")}`);
  return {
    ok: errors.length === 0,
    errors,
    empty,
    irrelevant,
    matchedFacts,
    askedAxisIndexes,
    unansweredAxisIndexes,
    unaskedMatchedFacts,
    ungroundedAnswerClauses,
    answeredAxisCount: askedAxisIndexes.length - unansweredAxisIndexes.length,
  };
}

function canonicalFieldCheck(errors, advisories, label, value, allowed, forbidden, options = {}) {
  if (!String(value || "").trim()) errors.push(`${label}_missing`);
  else if (Array.isArray(allowed) && allowed.length > 0 && !(["tcm_disease", "primary_syndrome"].includes(label)
    ? allowed.some((pattern) => tcmRegexTest(pattern, value))
    : matchesAny(allowed, value))) {
    const issue = `${label}_outside_compatible_examples:${value}`;
    if (options.compatibilityOnly) advisories.push(issue);
    else errors.push(issue);
  }
  if (Array.isArray(forbidden) && matchesAny(forbidden, value)) errors.push(`${label}_forbidden:${value}`);
}

export function evaluateM03CanonicalContract(diagnose, testCase) {
  const expected = testCase?.canonical || {};
  const westernPrimary = diagnose?.westernDiagnosis?.primary?.name || "";
  const tcmDisease = diagnose?.overview?.tcmDiseaseName || "";
  const primarySyndrome = diagnose?.overview?.primarySyndrome || "";
  const errors = [];
  const advisories = [];
  canonicalFieldCheck(
    errors,
    advisories,
    "western_primary",
    westernPrimary,
    expected.westernPrimaryCompatible || expected.westernPrimaryAllowed,
    expected.westernPrimaryForbidden,
    { compatibilityOnly: true },
  );
  canonicalFieldCheck(errors, advisories, "tcm_disease", tcmDisease, expected.tcmDiseaseAllowed, expected.tcmDiseaseForbidden);
  canonicalFieldCheck(errors, advisories, "primary_syndrome", primarySyndrome, expected.primarySyndromeAllowed, expected.primarySyndromeForbidden);
  return { ok: errors.length === 0, errors, advisories, westernPrimary, tcmDisease, primarySyndrome };
}

function joinedValues(values) {
  return (Array.isArray(values) ? values : []).filter((item) => typeof item === "string").join("；");
}

function mechanismSemanticallyMatches(pattern, value) {
  if (tcmRegexTest(pattern, value)) return true;
  const expected = pattern instanceof RegExp ? pattern.source : String(pattern || "");
  const actual = String(value || "");
  const terminologyGroups = [
    { expected: /脾虚/, actual: /脾气不足|脾失健运|运化(?:失司|无权)/ },
    { expected: /湿盛|湿困|寒湿|湿热/, actual: /湿浊|水湿|湿邪内生|湿阻/ },
  ];
  return terminologyGroups.some((group) => group.expected.test(expected) && group.actual.test(actual));
}

export function evaluatePathogenesisContract(diagnose, testCase) {
  const expected = testCase?.pathogenesisExpectations || {};
  const locations = diagnose?.pathogenesis?.locationDifferentiation?.items || [];
  const natures = diagnose?.pathogenesis?.natureDifferentiation?.items || [];
  const chain = Array.isArray(diagnose?.pathogenesis?.chain) ? diagnose.pathogenesis.chain : [];
  const locationText = joinedValues(locations);
  const natureText = joinedValues(natures);
  const mechanismCoreText = [diagnose?.overview?.overallPathogenesis, ...chain.map((node) => node.pathogenesis)].filter(Boolean).join("；");
  const mechanismText = [mechanismCoreText, diagnose?.pathogenesis?.summary].filter(Boolean).join("；");
  const therapyText = [diagnose?.therapy?.overallPrinciple, diagnose?.therapy?.overallMethod, diagnose?.overview?.overallTherapy, ...chain.map((node) => node.therapyDirection)].filter(Boolean).join("；");
  const errors = [];
  const syndromeAndMechanism = [diagnose?.overview?.primarySyndrome, mechanismText].filter(Boolean).join("；");
  const coldPattern = /寒凝|寒湿|风寒|阳虚|寒邪|寒证/.test(syndromeAndMechanism);
  const heatPattern = /湿热|痰热|血热|风热|火旺|热毒|热证/.test(syndromeAndMechanism);
  if (coldPattern && /清热|凉血|泻火|辛凉/.test(therapyText)) errors.push("therapy_cold_heat_polarity_conflict");
  if (heatPattern && /温阳|散寒|温经|温肺|辛温/.test(therapyText)) errors.push("therapy_heat_warm_polarity_conflict");
  if (!locations.length || !matchesEvery(expected.locationsAllowed, locationText)) errors.push("locations_allowed_missing");
  if (matchesAny(expected.locationsForbidden, locationText)) errors.push("locations_forbidden_present");
  if (!natures.length || !matchesEvery(expected.naturesAllowed, natureText)) errors.push("natures_allowed_missing");
  if (matchesAny(expected.naturesForbidden, natureText)) errors.push("natures_forbidden_present");
  if (Array.isArray(expected.mechanismsAllowed) && !expected.mechanismsAllowed.every((pattern) => tcmRegexTest(pattern, mechanismText))) errors.push("mechanisms_allowed_missing");
  // Narrative summaries may explicitly say an alternative remains unknown or pending. Forbidden
  // mechanism conclusions are evaluated only on the actual conclusion fields, never on an
  // uncertainty sentence that mentions the same word in a negated/pending context.
  if (matchesAny(expected.mechanismsForbidden, mechanismCoreText)) errors.push("mechanisms_forbidden_present");
  if (!matchesEvery(expected.therapiesAllowed, therapyText)) errors.push("therapies_allowed_missing");
  if (matchesAny(expected.therapiesForbidden, therapyText)) errors.push("therapies_forbidden_present");
  if (!chain.length || chain.some((node) => !node?.patientFact || !node?.syndromeEvidence || !node?.pathogenesis || !node?.therapyDirection)) errors.push("chain_structure_invalid");
  for (const [index, pair] of (expected.nodePairs || []).entries()) {
    const pairedNode = chain.some((node) =>
      mechanismSemanticallyMatches(pair.mechanism, node?.pathogenesis) && regexTest(pair.therapy, node?.therapyDirection)
    );
    if (!pairedNode) {
      errors.push(`node_pair_${index + 1}_missing`);
    }
  }
  return { ok: errors.length === 0, errors, locations, natures, chain };
}

export function evaluateM03CriticalClinicalAssertions(diagnose, testCase) {
  const canonical = evaluateM03CanonicalContract(diagnose, testCase);
  const pathogenesis = evaluatePathogenesisContract(diagnose, testCase);
  const semanticExpectation = /(?:_outside_compatible_examples|^(?:locations|natures|mechanisms|therapies)_allowed_missing$|^node_pair_\d+_missing$)/;
  const hardErrors = [...canonical.errors, ...pathogenesis.errors].filter((issue) => !semanticExpectation.test(issue));
  const semanticAdvisories = [...canonical.errors, ...pathogenesis.errors].filter((issue) => semanticExpectation.test(issue));
  return {
    ok: hardErrors.length === 0,
    errors: hardErrors,
    advisories: [...canonical.advisories, ...semanticAdvisories],
    canonical,
    pathogenesis,
  };
}

export function permissionAllowsDoseCandidate(permission) {
  return permission?.candidateMode === "full_dose" || permission?.candidateMode === "limited_dose";
}

function doseInGrams(value) {
  const match = String(value || "").normalize("NFKC").match(/^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i);
  if (!match) return NaN;
  const amount = Number(match[1]);
  return /mg|毫克/i.test(match[2]) ? amount / 1000 : amount;
}

function evidenceConsistent(evidence) {
  if (!isPlainObject(evidence)) return false;
  return evidence.evidenceLevel === "insufficient" ? !evidence.source : Boolean(String(evidence.source || "").trim());
}

export function evaluateM04CandidateContract(prescribe, testCase, options = {}) {
  const pathogenesisNodes = Array.isArray(options.pathogenesisChain)
    ? new Map(options.pathogenesisChain
      .filter((node) => node && typeof node.nodeId === "string" && typeof node.pathogenesis === "string")
      .map((node) => [node.nodeId, node.pathogenesis.trim().replace(/\s+/g, " ")]))
    : null;
  const candidates = Array.isArray(prescribe?.formula?.candidates) ? prescribe.formula.candidates : [];
  const candidateResults = candidates.map((candidate, candidateIndex) => {
    const errors = [];
    const herbs = Array.isArray(candidate?.herbs) ? candidate.herbs : [];
    const selfDevised = candidate?.constructionType === "self_devised" || candidate?.constructionType === "single_herb";
    const sourceText = String(candidate?.formulaSource?.source || "");
    const sourcePlaceholder = /证据不足|待检索|待核验|内部证据缺口|服务端|未知来源/.test(sourceText);
    if (!candidate?.name) errors.push("name_missing");
    const herbCountRules = {
      single_herb: { min: 1, max: 1 },
      single_base: { min: 1, max: Infinity },
      combined: { min: 2, max: Infinity },
      // A two- or three-herb self-devised formula can be a clinically coherent prescription.
      // The product contract requires every selected herb to be grounded and reviewed; it must not
      // force the model to add an otherwise unnecessary fourth herb just to satisfy the harness.
      self_devised: { min: 2, max: Infinity },
    };
    const herbCountRule = herbCountRules[candidate?.constructionType];
    if (!herbCountRule) errors.push(`construction_type_invalid:${candidate?.constructionType || "missing"}`);
    else if (herbs.length < herbCountRule.min || herbs.length > herbCountRule.max) {
      errors.push(`composition_size_invalid:${candidate.constructionType}:${herbs.length}`);
    }
    if (!candidate?.formulaAnalysis) errors.push("composition_analysis_missing");
    if (!candidate?.applicable || !candidate?.notApplicable) errors.push("patient_context_missing");
    const expectedTherapyMatch = String(options.therapyMatch || "").trim().replace(/\s+/g, " ");
    const candidateTherapyMatch = String(candidate?.therapyMatch || "").trim().replace(/\s+/g, " ");
    if (!candidateTherapyMatch || (expectedTherapyMatch
      ? candidateTherapyMatch !== expectedTherapyMatch
      : testCase?.therapy instanceof RegExp && !regexTest(testCase.therapy, `${candidateTherapyMatch} ${candidate.formulaAnalysis || ""}`))) {
      errors.push("therapy_mismatch");
    }
    if (selfDevised) {
      if (!evidenceConsistent(candidate?.formulaSource) || /《[^》]+》|经典方|原方出处/.test(sourceText)) errors.push("self_devised_source_invalid");
    } else if (!evidenceConsistent(candidate?.formulaSource) || sourcePlaceholder) {
      errors.push("traceable_formula_source_missing");
    }
    const decoction = candidate?.decoction || {};
    for (const field of ["doseCount", "method", "course", "followUpNode"]) {
      if (!String(decoction[field] || "").trim()) errors.push(`decoction_${field}_missing`);
    }
    for (const [herbIndex, herb] of herbs.entries()) {
      if (!herb?.name || !herb?.role || !herb?.prescriptionRole || !herb?.targetPathogenesis || !herb?.function) errors.push(`herb_${herbIndex + 1}_structure_invalid`);
      if (!(herb?.targetKind === "formula_structure" ? herb?.targetRef === "FORMULA_STRUCTURE" : /^P\d+$/.test(herb?.targetRef || ""))) {
        errors.push(`herb_${herbIndex + 1}_target_invalid`);
      } else if (herb?.targetKind !== "formula_structure" && pathogenesisNodes) {
        const expectedPathogenesis = pathogenesisNodes.get(herb.targetRef);
        const actualPathogenesis = String(herb?.targetPathogenesis || "").trim().replace(/\s+/g, " ");
        if (!expectedPathogenesis) errors.push(`herb_${herbIndex + 1}_target_node_missing`);
        else if (actualPathogenesis !== expectedPathogenesis) errors.push(`herb_${herbIndex + 1}_target_pathogenesis_mismatch`);
      }
      const grams = doseInGrams(herb?.dose);
      const limit = typeof options.doseLimit === "function" ? options.doseLimit(herb?.name) : undefined;
      if (!Number.isFinite(grams)) errors.push(`herb_${herbIndex + 1}_dose_missing`);
      else if (!limit || limit.min == null || limit.max == null || grams < limit.min || grams > limit.max) errors.push(`herb_${herbIndex + 1}_dose_out_of_range`);
    }
    const pairIssues = typeof options.pairIssues === "function" ? options.pairIssues(herbs.map((herb) => herb.name)) : [];
    if (Array.isArray(pairIssues) && pairIssues.length > 0) errors.push("pair_incompatibility_present");
    return { index: candidateIndex, name: candidate?.name || "", constructionType: candidate?.constructionType || "", errors, herbCount: herbs.length };
  });
  const errors = [];
  if (!candidates.length) errors.push("candidate_missing");
  for (const result of candidateResults) errors.push(...result.errors.map((error) => `candidate_${result.index + 1}:${error}`));
  return { ok: errors.length === 0, errors, candidateResults };
}

const AUDIT_RISK_ORDER = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

function issueLinkedDrugs(issue, herbs) {
  const explicit = Array.isArray(issue?.involvedDrugs) ? issue.involvedDrugs.map(String) : [];
  const related = Array.isArray(issue?.relatedItemNos)
    ? issue.relatedItemNos.flatMap((itemNo) => Number.isInteger(itemNo) && herbs[itemNo - 1]?.name ? [String(herbs[itemNo - 1].name)] : [])
    : [];
  return [...new Set([...explicit, ...related])];
}

export function evaluateAuditPositiveControl(control, audit) {
  const issues = Array.isArray(audit?.issues) ? audit.issues : [];
  const expected = control?.expectedIssue || {};
  const errors = [];
  if (audit?.source !== "lingxi") errors.push("audit_source_not_lingxi");
  if (audit?.degraded === true) errors.push("audit_degraded");
  if (issues.length === 0) errors.push("positive_control_requires_issue");
  const semanticMatches = issues.filter((issue) => {
    const typeOk = !(expected.type instanceof RegExp) || regexTest(expected.type, issue?.issueType);
    const text = `${issue?.title || ""}；${issue?.description || ""}；${issue?.action || ""}`;
    const textOk = !(expected.text instanceof RegExp) || regexTest(expected.text, text);
    return typeOk && textOk;
  });
  if (semanticMatches.length === 0 && issues.length > 0) errors.push("expected_issue_semantics_missing");
  const validMatches = semanticMatches.filter((issue) => {
    const issueId = String(issue?.issueId || "").trim();
    if (!issueId || issue?.issueIdGenerated === true || /^LOCAL-/i.test(issueId)) return false;
    const risk = String(issue?.riskLevel || issue?.severity || "").toUpperCase();
    const minRisk = String(expected.minSeverity || "LOW").toUpperCase();
    if (!AUDIT_RISK_ORDER.includes(risk) || AUDIT_RISK_ORDER.indexOf(risk) < AUDIT_RISK_ORDER.indexOf(minRisk)) return false;
    const linked = issueLinkedDrugs(issue, control?.herbs || []);
    if (Array.isArray(expected.drugs) && !expected.drugs.every((drug) => linked.some((item) => item.includes(drug)))) return false;
    const issueText = `${issue?.title || ""}；${issue?.description || ""}；${issue?.action || ""}`;
    if (expected.contextDrug instanceof RegExp && !regexTest(expected.contextDrug, issueText)) return false;
    return true;
  });
  if (semanticMatches.length > 0 && validMatches.length === 0) errors.push("issue_id_severity_or_drug_link_invalid");
  return {
    ok: errors.length === 0,
    errors,
    issueCount: issues.length,
    matchedIssues: validMatches.map((issue) => ({
      issueId: issue.issueId,
      issueType: issue.issueType,
      severity: issue.riskLevel || issue.severity,
      drugs: issueLinkedDrugs(issue, control?.herbs || []),
    })),
  };
}

export function evaluateAuditInputQualityControl(control, audit) {
  const advisories = Array.isArray(audit?.inputAdvisories) ? audit.inputAdvisories : [];
  const issues = Array.isArray(audit?.issues) ? audit.issues : [];
  const expected = control?.expectedInputAdvisory || {};
  const errors = [];
  const matches = advisories.filter((advisory) => {
    const codeOk = !expected.code || advisory?.code === expected.code;
    const drugName = String(advisory?.drugName || "");
    const drugsOk = !Array.isArray(expected.drugs) || expected.drugs.every((drug) => drugName.includes(drug));
    return codeOk && drugsOk;
  });
  if (control?.controlLayer !== "input_quality") errors.push("control_layer_not_input_quality");
  if (matches.length === 0) errors.push("expected_input_advisory_missing");
  if (audit?.needManualReview !== true) errors.push("input_advisory_must_request_manual_review");
  const masqueradingIssues = issues.filter((issue) => {
    const issueId = String(issue?.issueId || "");
    const text = `${issue?.issueType || ""};${issue?.title || ""};${issue?.description || ""}`;
    return /^LOCAL-/i.test(issueId) || issue?.issueIdGenerated === true || /missing.?dose|剂量缺失|未标注.*剂量/i.test(text);
  });
  if (masqueradingIssues.length > 0) errors.push("input_advisory_masquerades_as_provider_issue");
  return {
    ok: errors.length === 0,
    errors,
    advisoryCount: advisories.length,
    matchedAdvisories: matches.map((item) => ({ code: item.code, itemNo: item.itemNo, drugName: item.drugName })),
  };
}

function stringsFrom(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsFrom(item, output));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => stringsFrom(item, output));
  return output;
}

export function validatePrimaryCareFixture({ metadata, cases, polarityContrasts, auditControls }) {
  const errors = [];
  const regexList = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof RegExp);
  if (metadata?.fictional !== true || metadata?.prohibitsRealPhi !== true) errors.push("fixture_metadata_must_be_fictional_and_phi_prohibited");
  if (!Array.isArray(cases) || cases.length !== 50) errors.push(`case_count:${cases?.length || 0}`);
  for (const testCase of cases || []) {
    if (testCase.fictional !== true) errors.push(`${testCase.id}:not_explicitly_fictional`);
    if (typeof testCase.diagnosisExpected !== "boolean") errors.push(`${testCase.id}:diagnosis_gate_missing`);
    if (!regexList(testCase.canonical?.westernPrimaryCompatible) || !Array.isArray(testCase.canonical?.westernPrimaryForbidden) || !testCase.canonical.westernPrimaryForbidden.every((item) => item instanceof RegExp) ||
      !regexList(testCase.canonical?.tcmDiseaseAllowed) || !regexList(testCase.canonical?.tcmDiseaseForbidden) ||
      !regexList(testCase.canonical?.primarySyndromeAllowed) || !regexList(testCase.canonical?.primarySyndromeForbidden)) errors.push(`${testCase.id}:canonical_missing`);
    const pathExpected = testCase.pathogenesisExpectations;
    if (!regexList(pathExpected?.locationsAllowed) || !regexList(pathExpected?.locationsForbidden) ||
      !regexList(pathExpected?.naturesAllowed) || !regexList(pathExpected?.naturesForbidden) ||
      !regexList(pathExpected?.mechanismsAllowed) || !regexList(pathExpected?.mechanismsForbidden) ||
      !regexList(pathExpected?.therapiesAllowed) || !regexList(pathExpected?.therapiesForbidden) ||
      !pathExpected?.nodePairs?.length || pathExpected.nodePairs.some((item) => !(item.mechanism instanceof RegExp) || !(item.therapy instanceof RegExp))) {
      errors.push(`${testCase.id}:pathogenesis_expectations_missing`);
    }
    if (!Array.isArray(testCase.m02AnswerFacts) || testCase.m02AnswerFacts.length !== testCase.questionAxes.length || testCase.m02AnswerFacts.some((item) => !item.facts?.length)) errors.push(`${testCase.id}:m02_answer_axis_missing`);
    if (!["none", "initial", "after_m02"].includes(testCase.redFlagStage)) errors.push(`${testCase.id}:red_flag_stage_invalid`);
    const redFlagOracle = testCase.redFlagOracle;
    const oracleParts = [redFlagOracle?.required, redFlagOracle?.allowed, redFlagOracle?.forbidden];
    if (oracleParts.some((part) => !Array.isArray(part))) {
      errors.push(`${testCase.id}:red_flag_oracle_missing`);
    } else {
      const required = new Set(redFlagOracle.required);
      const allowed = new Set(redFlagOracle.allowed);
      const forbidden = new Set(redFlagOracle.forbidden);
      const union = new Set([...required, ...allowed, ...forbidden]);
      const overlap = [...required].some((category) => allowed.has(category) || forbidden.has(category)) ||
        [...allowed].some((category) => forbidden.has(category));
      const unknown = [...union].some((category) => !RED_FLAG_CATEGORY_SET.has(category));
      if (overlap || unknown || union.size !== RED_FLAG_CATEGORY_VOCABULARY.length) errors.push(`${testCase.id}:red_flag_oracle_invalid_partition`);
      if ((testCase.redFlagStage === "none") !== (required.size === 0)) errors.push(`${testCase.id}:red_flag_required_stage_mismatch`);
    }
  }
  const allArtifacts = { cases, polarityContrasts, auditControls };
  if (/\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b/.test(stringsFrom(allArtifacts).join("\n"))) errors.push("real_phi_like_identifier_present");
  for (const contrast of polarityContrasts || []) {
    if (contrast.fictional !== true || !contrast.context || !contrast.position) errors.push(`${contrast.id || "contrast"}:invalid_polarity_contrast`);
  }
  for (const control of auditControls || []) {
    const providerValid = control.controlLayer === "provider" && control.expectedIssue?.drugs?.length;
    const inputQualityValid = control.controlLayer === "input_quality" && control.expectedInputAdvisory?.drugs?.length;
    if (control.fictional !== true || !control.mutation || (!providerValid && !inputQualityValid)) errors.push(`${control.id || "control"}:invalid_audit_control`);
  }
  return { ok: errors.length === 0, errors };
}

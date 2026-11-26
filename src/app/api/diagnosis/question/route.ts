import { callDiagnosisStream, sampleQuestionPlanOnce } from "@/lib/diagnosis-api";
import { buildQuestionPrompt } from "@/lib/diagnosis-prompts";
import {
  buildCaseAwareQuestionFallback,
  enforceM02UnansweredAxes,
  ensureQuestionStructuredEnvelope,
  m02ClinicalFactsFootprint,
  m02FallbackYoungChildBand,
  m02PriorityEvaluationQuestion,
  m02NarrowCheckRecordText,
  m02PossibleRiskQuestion,
  m02PriorityTrendQuestion,
  m02ProceedPlanContent,
  m02ProceedWhenSettled,
  parseM02PlanFromContent,
  redFlagDispositionQuestion,
  removeM02PlanQuestions,
  splitTonguePulseQuestions,
  withM02Completeness,
} from "@/lib/m02-question-contract";
import { riskCategoryRecordStatus } from "@/lib/m02-risk-question-answerability.server";
import { questionIdsFailingNarrowChecks } from "@/lib/m02-question-redundancy.server";
import { readCustomerBoundCaseStateRequest } from "@/lib/diagnosis-request";
import { followupConversationView } from "@/lib/followup-conversation";
import type { CaseState } from "@/lib/diagnosis-types";
import { deriveOperationalCompleteness, markdownNdjsonResponse, sanitizeCaseStateForModel, trustedInputText, evaluateSafetyGate } from "@/lib/diagnosis-safety";
import { maybeAttachClinicalFactsBackstop } from "@/lib/clinical-facts-runtime";
import { reviewM02QuestionPlan } from "@/lib/m02-question-review.server";
import { prefetchDiagnoseInputs } from "@/lib/stage-prefetch.server";
import { precomputeNoAnswerPath } from "@/lib/no-answer-precompute.server";
import { coalesceStageResponse, stageRequestFingerprint, regenerateFreshRequested } from "@/lib/stage-result-coalescing.server";
import { withClinicalResponseArchive } from "@/lib/request-archive.server";

async function handlePost(req: Request) {
  const startedAt = Date.now();
  const parsed = await readCustomerBoundCaseStateRequest(req);
  if (!parsed.ok) return parsed.response;
  if (!(parsed.caseState.chiefComplaint || parsed.caseState.hisRecord?.fields.zhushu || "").trim()) {
    return Response.json({ error: "请先填写主诉，再生成本轮关键追问。" }, { status: 422 });
  }
  if (parsed.caseState.phase !== "question") {
    return Response.json({ error: "当前流程不在追问阶段，请从现有阶段继续。" }, { status: 409 });
  }
  if (parsed.caseState.questionRounds >= parsed.caseState.maxQuestionRounds) {
    const completed = followupConversationView(parsed.caseState.conversation).answers.length > 0 ||
      parsed.caseState.questionOutcome === "skipped";
    if (completed && m02ProceedWhenSettled()) {
      const urgent = evaluateSafetyGate(parsed.caseState).status === "red_flag";
      return markdownNdjsonResponse(withM02Completeness(
        ensureQuestionStructuredEnvelope(m02ProceedPlanContent(urgent
          ? "已识别急危重情况，应先按急症处置，本轮不再追问。"
          : "本轮追问已结束，请按已提供信息进入辨病辨证。")),
        deriveOperationalCompleteness(parsed.caseState),
      ));
    }
    return Response.json({ error: "本轮追问已结束，请按已提供信息进入辨病辨证。" }, { status: 409 });
  }
  // 预取 M03 两半开跑前的四样输入（EviMed 检索、方名召回改写、否定增补、证候重排；见
  // stage-prefetch.server.ts）。它们只取病例字段；外部接口直调时 M03 的病例通常与此刻相同，
  // 命中缓存即省掉 M03 前置的串行等待（线上约 3.8s）。病例随后被改写只是未命中；失败静默。
  prefetchDiagnoseInputs(parsed.caseState);
  // 出题的同时按「不回答」把辨证、开方先算出来：医生跳过追问时后两步直接取现成结果（no-answer-precompute.server.ts）。
  precomputeNoAnswerPath(req, parsed.caseState);
  // 同一份病历只出一次题（2026-10-21，「同样的输入两次推理的结果要一样」）：与 M03/M04 同一套复用
  //（stage-result-coalescing.server.ts：同租户、同病历内容、同版本同模型，进行中合流、完成后回放、加密落盘 30 天）。
  // 温度 0 也不保证逐字相同——实测甲方 10 例 + 留出 32 例两次独立出题只有 22/42 相同；题不同，医生的回答就不同，
  // 后面的诊断随之改变。上游故障时的服务端兜底题不存，下次照常重出。显式重抽：x-cdss-regenerate: force 或 ?regenerate=force。
  const regenerate = regenerateFreshRequested(req);
  const degradedContents = new Set<string>();
  return coalesceStageResponse({
    stage: "question",
    key: stageRequestFingerprint("question", parsed.customer, parsed.caseState),
    bypass: regenerate,
    compute: (signal) => computeQuestion(parsed.caseState, startedAt, signal, degradedContents),
    cacheable: (content) => !degradedContents.has(content.trim()),
  });
}

async function computeQuestion(
  inputCaseState: CaseState,
  startedAt: number,
  requestSignal: AbortSignal,
  degradedContents: Set<string>,
): Promise<Response> {
  // 事实抽取与出题并行（2026-09-27）。外部接口按 collect → question 直调时，事实层抽取
  // （qwen3.8-max，冷启动实测 6.6s）此前必须先做完才开始出题（3.4s），M02 整段约 10s。
  // M02 只经 m02ClinicalFactsFootprint 读取事实层；先用「无事实」病例发出题，事实回来后
  // 指纹为空（绝大多数门诊病例）就采用先发结果，否则丢弃并按事实重出——结果与串行逐字等价。
  // 事实已在客户端快照或服务端缓存里时（浏览器流程先走 red-flags），走原串行路径。
  //
  // 2026-10-20 起不等整份事实：抽取改为流式，红旗段（disposition + redFlags）一写完就拿来比指纹
  //（clinical-facts.earlyClinicalFactsFromPartial；M02 只读这两段，后面的 affirmedSymptoms、encounterScope 不进闸门也不进指纹）。
  // 线上实测红旗段写完中位 3.4s、整份 5.4s（P90 5.2s 对 7.6s）。整份照旧写完、签名、入服务端缓存，供 red-flags 与「不回答」预计算合流。
  // 抽取不绑本请求的中止信号：它是后续各阶段共用的计算（与 stage-prefetch 同一原则），M02 先返回也不能把它掐掉。
  let resolveEarlyFacts: (state: CaseState) => void = () => undefined;
  const earlyFacts = new Promise<CaseState>((resolve) => { resolveEarlyFacts = resolve; });
  // CDSS_M02_EARLY_FACTS=false 回到等整份事实（回退开关；抽取仍不绑本请求的中止信号）。
  const factsReady = maybeAttachClinicalFactsBackstop(inputCaseState, undefined, undefined, {
    onEarlyRedFlags: process.env.CDSS_M02_EARLY_FACTS === "false" ? undefined : (state) => resolveEarlyFacts(state),
  });
  factsReady.catch(() => undefined);
  const settled = await Promise.race([
    factsReady,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 30)),
  ]);
  if (settled) return questionStageResponse(settled, requestSignal, degradedContents);
  const factFreeState: CaseState = { ...inputCaseState, clinicalFacts: undefined };
  const speculativeController = new AbortController();
  const speculative = questionStageResponse(
    factFreeState,
    AbortSignal.any([requestSignal, speculativeController.signal]),
    degradedContents,
  );
  const discardSpeculative = () => {
    speculativeController.abort();
    void speculative.then((response) => response.body?.cancel().catch(() => undefined)).catch(() => undefined);
  };
  let caseState: CaseState;
  let factsSource: "early" | "full" = "full";
  try {
    caseState = await Promise.race([factsReady, earlyFacts.then((state) => {
      factsSource = "early";
      return state;
    })]);
  } catch (error) {
    discardSpeculative();
    throw error;
  }
  // 先发结果可用的条件：M02 从事实层读到的内容相同，且「闸门是否已判急危重」相同——后者决定这一轮是出追问还是出
  // 急症处置确认题，而处置去向判断（disposition）不在 redFlags 清单里，指纹看不到它。
  const redFlagState = (state: CaseState) => evaluateSafetyGate(state).status === "red_flag";
  const adopted = m02ClinicalFactsFootprint(caseState) === m02ClinicalFactsFootprint(factFreeState) &&
    redFlagState(caseState) === redFlagState(factFreeState);
  // 量线上效果用：事实从哪一段来（早到的红旗段 / 整份）、先发结果是否采用（不采用即按事实重出，M02 多一轮出题）。
  console.info("[tcm-cdss:telemetry] m02_facts_overlap", { factsSource, adopted, factsWaitMs: Date.now() - startedAt });
  if (adopted) return speculative;
  discardSpeculative();
  return questionStageResponse(caseState, requestSignal, degradedContents);
}

type QuestionCaseState = CaseState & {
  m02PriorityTrendAnswered?: boolean;
  m02SuppressedRiskCategories?: readonly string[];
  m02AffirmedRiskCategories?: readonly string[];
  m02ModelOwnedRiskCategories?: readonly string[];
};

async function questionStageResponse(inputCaseState: CaseState, signal: AbortSignal, degradedContents?: Set<string>): Promise<Response> {
  const safeCaseState = sanitizeCaseStateForModel(inputCaseState);
  const sourceText = trustedInputText(safeCaseState);
  // 对外信封里的 completeness 由服务端按当前病历确定性写入（与各阶段路由 withSafetyGate 同一口径），
  // 模型不打分。每个出口（成功、上游失败兜底、非 2xx 兜底）都经这一步。
  const completeness = deriveOperationalCompleteness(inputCaseState);
  const withCompleteness = (content: string) => withM02Completeness(content, completeness);
  // 安全闸门已判急危重：不再生成追问。急症已由病历本身成立，问别的类目的筛查题、辨证题或基本问诊都不合时宜
  //（2026-10-13/14 独立评审：疑似脑膜炎问卒中表现、脱水休克问大便性状、失血性休克问怕冷怕热）。
  // 调用方的流程仍要一道题时，问是否已安排急诊评估或转诊（redFlagDispositionQuestion）；允许如实返回「无需追问」时直接 proceed。
  const previousAnswers = followupConversationView(safeCaseState.conversation).answers;
  const youngChild = m02FallbackYoungChildBand(safeCaseState);
  const proceed = ensureQuestionStructuredEnvelope(m02ProceedPlanContent("已有资料可供下一步评估，本轮暂无需再追问的事项。"));
  const gate = evaluateSafetyGate(inputCaseState);
  if (gate.status === "red_flag") {
    if (m02ProceedWhenSettled()) {
      return markdownNdjsonResponse(withCompleteness(ensureQuestionStructuredEnvelope(
        m02ProceedPlanContent("已识别急危重情况，应先按急症处置，本轮不再追问。"),
      )));
    }
    const disposition = ensureQuestionStructuredEnvelope(redFlagDispositionQuestion(gate.redFlags || []), sourceText);
    const removed = await questionIdsFailingNarrowChecks(disposition, sourceText, disposition, signal, { previousAnswers, youngChild });
    const content = removed.length ? removeM02PlanQuestions(disposition, removed, "应先按急症处置。") : disposition;
    return markdownNdjsonResponse(withCompleteness(content));
  }

  const narrowCheckRecordText = m02NarrowCheckRecordText(sourceText, safeCaseState.conversation);
  const riskStatus = await riskCategoryRecordStatus(inputCaseState, narrowCheckRecordText, signal);
  const caseState: QuestionCaseState = {
    ...inputCaseState,
    m02SuppressedRiskCategories: riskStatus.answered,
    m02AffirmedRiskCategories: riskStatus.affirmed,
    m02ModelOwnedRiskCategories: riskStatus.partly,
  };
  const urgent = m02PossibleRiskQuestion(caseState);
  const priority = !urgent && m02PriorityEvaluationQuestion(caseState);
  const trend = !urgent ? m02PriorityTrendQuestion(caseState) : undefined;
  const checkContext = { previousAnswers, youngChild, trendQuestion: trend?.question };
  const afterAnswer = previousAnswers.length > 0;
  const settled = m02ProceedWhenSettled(afterAnswer ? undefined : sourceText);

  // 服务端题也过重复和原话核对。在出题同时预核，只有最终需要兜底才等待它。
  const failureFallback = buildCaseAwareQuestionFallback(caseState);
  const settledFallback = buildCaseAwareQuestionFallback(caseState, { settled: true });
  const afterTrend = trend ? { ...caseState, m02PriorityTrendAnswered: true } : undefined;
  const serverPlans = [...new Set([
    ...(urgent || priority || !afterAnswer ? [failureFallback] : []),
    ...(urgent || priority || (!afterAnswer && !settled) ? [settledFallback] : []),
    ...(afterTrend && !afterAnswer ? [
      buildCaseAwareQuestionFallback(afterTrend),
      buildCaseAwareQuestionFallback(afterTrend, { settled: true }),
    ] : []),
  ])];
  const reviewedFallbacks = new Map(serverPlans.map((raw) => [raw, (async () => {
    const content = ensureQuestionStructuredEnvelope(raw, sourceText);
    const failed = await questionIdsFailingNarrowChecks(content, sourceText, raw, signal, checkContext);
    const usable = failed.length ? removeM02PlanQuestions(content, failed, "病历已有答案或题目需要改问。") : content;
    const finalized = enforceM02UnansweredAxes(usable, sourceText, "", caseState);
    return parseM02PlanFromContent(finalized)?.decision === "ask" ? finalized : undefined;
  })().catch(() => undefined)]));
  const selectFallback = async (forFailure: boolean): Promise<string> => {
    const raw = forFailure ? failureFallback : settledFallback;
    const preferred = await reviewedFallbacks.get(raw);
    if (preferred) return preferred;
    const alternate = afterTrend && buildCaseAwareQuestionFallback(afterTrend, { settled: !forFailure });
    return (alternate && await reviewedFallbacks.get(alternate)) || proceed;
  };
  const deliverFailureFallback = async (): Promise<string> => {
    const content = withCompleteness(await selectFallback(true));
    degradedContents?.add(content.trim());
    return content;
  };

  const answeredRiskCategories = riskStatus.answered;
  const prompt = buildQuestionPrompt(safeCaseState, answeredRiskCategories, { affirmed: riskStatus.affirmed, partly: riskStatus.partly });
  const outputTransform = (content: string) => ensureQuestionStructuredEnvelope(content, sourceText, proceed);
  type ReviewedQuestionPlan = { reviewed: string; modelOwned: boolean; providerInvalid: boolean; narrowRemoved: number };
  const reviewQuestionPlan = async (content: string): Promise<ReviewedQuestionPlan> => {
    const parsed = parseM02PlanFromContent(content);
    const providerInvalid = !parsed || parsed.rationale.startsWith("模型结构化追问计划不可用");
    // 分拆舌脉后再核题；切脉目标栏位是闭集，婴幼儿不能回填该栏。
    const split = splitTonguePulseQuestions(content, sourceText, caseState);
    const unobservable = youngChild
      ? parseM02PlanFromContent(split.content)?.questions.filter((q) => q.targetField === "tcmPulse").map((q) => q.id) ?? []
      : [];
    const repeated = await questionIdsFailingNarrowChecks(split.content, sourceText, "", signal, checkContext);
    const guarded = reviewM02QuestionPlan(split.content, sourceText, "", [...split.removeIds, ...unobservable, ...repeated]);
    // 此处的 proceed 信封仅用于开启分支排序，不会添回任何已删题。
    const reviewed = enforceM02UnansweredAxes(guarded, sourceText, proceed, caseState);
    return { reviewed, modelOwned: !providerInvalid && parseM02PlanFromContent(reviewed)?.decision === "ask", providerInvalid, narrowRemoved: repeated.length };
  };

  // 两路采样和各自的核对独立推进。首路流结束后优先交付最早通过核对的题。
  const secondSample = process.env.CDSS_M02_QUESTION_CONSENSUS === "false" ? undefined
    : sampleQuestionPlanOnce(prompt, signal)
      .then((raw) => raw ? reviewQuestionPlan(outputTransform(raw)) : undefined)
      .catch(() => undefined);
  const response = await callDiagnosisStream(prompt, "deepseek", undefined, "question", {
    requestSignal: signal,
    streamErrorFallback: deliverFailureFallback,
    outputTransform,
    finalOutputTransform: async (content) => {
      const primary = reviewQuestionPlan(content).then((plan) => ({ source: "primary" as const, plan }));
      const second = secondSample?.then((plan) => ({ source: "second" as const, plan }));
      let selected = await Promise.race(second ? [primary, second] : [primary]);
      if (!selected.plan?.modelOwned && selected.source === "second") selected = await primary;
      if (!selected.plan?.modelOwned && selected.source === "primary" && second) {
        const alternative = await waitForSecond(second);
        if (alternative?.plan?.modelOwned) selected = alternative;
      }
      const plan = selected.plan;
      let reviewed = plan?.reviewed || proceed;
      if (plan?.modelOwned) {
        // 已接地且核对通过的优先处置题在辨证题之前。急症类目的固定题及其可接受的细问沿用原有收口口径。
        const priorityFallback = (urgent || priority) && await reviewedFallbacks.get(settledFallback);
        if (priorityFallback) {
          if (urgent) reviewed = enforceM02UnansweredAxes(reviewed, sourceText, priorityFallback, caseState);
          else if (!parseM02PlanFromContent(reviewed)?.questions.some((question) => question.decisionBranch === "triage" || question.decisionBranch === "treatment_safety")) reviewed = priorityFallback;
        }
        // 已有一轮作答之后（第六十二轮，甲方「刚答过又问」）：只为处置或用药安全再问一题；辨证、鉴别方向的题不再问，
        // 直接进入辨证。换词重问靠模型核对拦不干净（实链回放 90 份里仍有 4 份换了说法重问同一件事），这里按题目分支收口。
        if (afterAnswer && !urgent && !priority && process.env.CDSS_M02_SECOND_ROUND_SAFETY_ONLY !== "false" &&
            !parseM02PlanFromContent(reviewed)?.questions.some((question) => question.decisionBranch === "triage" || question.decisionBranch === "treatment_safety")) {
          reviewed = proceed;
        }
      } else if (plan?.providerInvalid) {
        reviewed = await deliverFailureFallback();
      } else if (urgent || priority || (!settled && !afterAnswer)) {
        reviewed = await selectFallback(false);
      } else {
        reviewed = proceed;
      }
      // 遥测只记判定码与题数。
      console.info("[tcm-cdss:telemetry] m02_plan_outcome", {
        narrowRemoved: plan?.narrowRemoved ?? 0,
        consensus: plan?.modelOwned ? selected.source : secondSample ? "none" : "unavailable",
        finalDecision: parseM02PlanFromContent(reviewed)?.decision ?? "unparsed",
      });
      return withCompleteness(reviewed);
    },
  });
  if (response.ok || signal.aborted) return response;
  await response.body?.cancel().catch(() => undefined);
  return markdownNdjsonResponse(await deliverFailureFallback());
}

async function waitForSecond<T>(sample: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([sample, new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), M02_CONSENSUS_WAIT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** 首轮已收口、只差第二份采样时最多再等多久；等不到按首轮结果交付。 */
const M02_CONSENSUS_WAIT_MS = 4_000;

// 临床请求与响应都加密留存（用户 2026-10-26 D3），见 request-archive.server.ts。
export const POST = withClinicalResponseArchive(handlePost);

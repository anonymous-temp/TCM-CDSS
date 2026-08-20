import "server-only";

import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { SIX_HEALTH_FOLLOWUP_DIMENSIONS } from "./tcm-followup-dimensions";
import { patientInstructionProhibitionsIn } from "./clinical-vocabulary";
import { PRECAUTION_DOSE_LIKE } from "./m04-proposal-compiler";
import { deriveFirstReviewTiming, hasStrongPrescriptionRisk, sanitizeFreeTextForModel } from "./diagnosis-safety";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";

/**
 * M05 临床内容的作者是模型，不是模板。
 *
 * 【改之前是什么样】M05 整段是拼出来的：
 *   · 「生活管理」是**一句写死的话**——「按本例非药物建议安排饮食、作息、情志和活动；
 *     不要自行叠加中药或中成药…」——寒证与湿热证的病人拿到的逐字相同；
 *   · 六维复评表 sixHealthFollowupTable() **无参数**，所有病人一模一样的六行；
 *   · 「评级依据」是三选一的三元式。
 * 逐例变化的只有从 M03/M04 事实里取的槽位（coreMetrics / firstReview / efficacyTrigger）。
 * 一个辨证论治系统，给风寒表实和湿热下注的病人发同一份调护，本身就是错的：
 * 寒证忌生冷、湿热忌肥甘、肝郁重情志、阴虚忌辛燥——这些恰恰是中医随访的价值所在。
 *
 * 【改之后谁拍板】
 *   · **安全结论仍是确定性的**：最高提示强度、综合风险判断、评级依据、医生需确认事项，
 *     全部来自灵犀处方后审方，模型碰不到。风险 verdict 不许模型写，这条不动。
 *   · **临床内容交给模型**：复诊评估重点、疗效评价口径、生活管理、六维里挑哪几维——
 *     这些要理解本例的证候与方药，是模型的活。
 *
 * 【模型说错了会怎样，谁接住】
 *   · 写出剂量/药名/指南引用 ⇒ 确定性校验驳回，整体回落今天的模板（逐字不变）。
 *   · 挑的维度不在受治理六维里 ⇒ 丢弃越界项；一个都不剩就回落全六维。
 *   · 超时/未配置/解析失败 ⇒ 返回 null，调用方使用原模板。
 *   · 模型只能**补充**这几个槽位，改不了安全总评、改不了随访时间轴、
 *     也删不掉「不要自行叠加中药或中成药，复诊时携带全部药物清单」这条固定安全句。
 */

const AUTHORING_TIMEOUT_MS = 12_000;
const GOVERNED_DIMENSIONS = SIX_HEALTH_FOLLOWUP_DIMENSIONS.map((item) => item.dimension);

/** 引用标记：证据绑定要求引用必须有 KB 条目背书。纯格式判据。 */
const CITATION_LIKE = /(?:doi|DOI|PMID|指南|共识|《[^》]{2,40}》\s*\d{4})/;

export type AuthoredFollowupContent = {
  reviewFocus: string;
  efficacyCriteria: string;
  lifestyle: string;
  dimensions: string[];
  /**
   * 随访时间轴那张表的「观察指标」。
   *
   * 【为什么也得交给模型】这一格原先是 coreFacts 拼出来的：
   *   `${westernDiagnosis.primary.supportingFacts + primarySyndromeBasis + 主诉}的严重程度、发作频次及对日常功能的影响`
   * 实测（tmp-probe/repro-m05-indicators.mjs，湿热下注/下尿路感染例）逐字输出：
   *   「下尿路感染；小便灼热涩痛5天；小便灼热；**苔黄腻**的严重程度、**发作频次**及对日常功能的影响」
   * ——「下尿路感染」是诊断不是观察指标，「苔黄腻」没有发作频次。而且传不传 authored
   * 输出**一字不差**：散文那一面已经交给模型了，这张表还是拼串，模型在这里根本没有通道。
   * 「本例复诊要盯哪几个指标」与「复诊重点评估什么」是同一类判断，没有理由一个交模型一个拼串。
   *
   * 空数组 ⇒ 调用方逐字回落今天的 coreMetrics 拼串。
   */
  monitoringIndicators: string[];
  /**
   * 结构化随访时间轴条目（2026-08-12）。
   *
   * 此前这张表**只有 indicators 一栏是模型写的**，而且两条目共用同一份：
   *   · action 是两条写死的字符串（「完成首次复诊与疗效复评」「记录症状变化并按触发条件提前复评」）；
   *   · time 第二条恒为「治疗期间随时」；
   *   · triggers 主体恒为「主要症状较首诊无改善或加重，或出现新的伴随症状」。
   * 一个风寒表证与一个湿热淋证拿到的时间轴逐字相同——这不是随访方案，是排版。
   *
   * 现在整条由模型按本例撰写。三条边界不变：
   *   ① 第一条的时间点**必须**等于处方煎服法确定的首次复诊时间（否则表与正文各说各的）；
   *   ② 审方得出的安全触发条件**只增不减**地并进第一条（模型删不掉安全项）；
   *   ③ 红旗 / 无结构化剂量 / 硬剂量边界三条降级路径**完全不走模型**。
   * 空数组 ⇒ 调用方逐字回落今天的两条模板。
   */
  timeline: AuthoredTimelineItem[];
};

export type AuthoredTimelineItem = {
  time: string;
  action: string;
  indicators: string[];
  triggers: string[];
};

/**
 * 旧模板里那几句话本身就是「套话」的定义。模型如果原样吐回来，等于没写——
 * 逐条列出来拒掉，比在提示词里说「不要写套话」有用：后者不可验证。
 */
const TEMPLATE_BOILERPLATE = [
  "完成首次复诊与疗效复评",
  "记录症状变化并按触发条件提前复评",
  "主要症状较首诊无改善或加重，或出现新的伴随症状",
  "治疗期间随时",
  "新发不适或原症加重",
];

function clinicalContextForAuthoring(
  state: CaseState,
  syndrome: string,
  pathogenesis: string,
  therapy: string,
  herbs: readonly string[],
  firstReviewTiming: string,
): string {
  return [
    `主诉：${sanitizeFreeTextForModel(state.chiefComplaint || "")}`,
    syndrome ? `证候：${sanitizeFreeTextForModel(syndrome)}` : "",
    pathogenesis ? `病机：${sanitizeFreeTextForModel(pathogenesis)}` : "",
    therapy ? `治法：${sanitizeFreeTextForModel(therapy)}` : "",
    herbs.length > 0 ? `处方药味：${herbs.map((herb) => sanitizeFreeTextForModel(herb)).join("、")}` : "",
    `可选复评维度（只能从中挑选，不得新增）：${GOVERNED_DIMENSIONS.join("、")}`,
    // 只作**上下文**给模型参考后续节点怎么排；第一条的 time 由服务端填入，
    // 不要求模型复述它——2026-08-12 线上实测：这个值可长达 25 字且含分号
    //（「完成5剂（5日）后复诊；出现不适或症状加重时提前复诊」），
    // 要求复述的结果是第一条恒被判废、整条时间轴回落模板。
    firstReviewTiming ? `首次复诊时间（系统已定，第一条 time 由系统填入，你不必复述）：${firstReviewTiming}` : "",
  ].filter(Boolean).join("\n");
}

const SYSTEM_PROMPT = [
  "你是中医门诊随访方案的撰写者。根据本例的证候、病机、治法与处方，写出**针对这一例**的随访内容。",
  "只输出 JSON，字段固定为：",
  '{"reviewFocus":"复诊重点评估什么","efficacyCriteria":"疗效怎么判定算有效","lifestyle":"饮食/作息/情志/活动的调护","dimensions":["从可选复评维度里挑3到4个"],"monitoringIndicators":["随访时间轴表格里逐次记录的观察指标，3到5条短语"],"timeline":[{"time":"时间点","action":"这个时间点要做什么","indicators":["这个时间点要看的观察项"],"triggers":["出现什么就提前复诊"]}]}',
  "",
  "写作要求：",
  "· 必须体现本例证候特点。寒证与湿热证的调护不该相同——寒证忌生冷、湿热忌肥甘厚味、",
  "  肝郁重情志疏导、阴虚忌辛燥熬夜、气虚忌过劳。写出这一例真正该注意的。",
  "· reviewFocus 写**复诊时要重点看什么**，是给医生的检查清单，不是复述病历状态。",
  "  反例（线上实测出现过，不要这样写）：「病历已记录发热阳性；病历尚未确认头痛是否存在」——",
  "  那是在陈述记录完整性，不是复诊重点。正例：「重点复评恶寒与发热的消长、有无汗出及汗后热退情况、",
  "  头身疼痛程度、舌苔由白转黄与否、脉象由浮紧转浮缓与否」。",
  "· efficacyCriteria 写**达到什么状态算这一轮有效**，同样指向本例主症与舌脉。",
  "· 以上三段每段 30–120 字，中文，不分条不加标题。",
  "· monitoringIndicators 是随访表格里**逐次记录的观察项**，3–5 条，每条一个短语（不超过 24 字）。",
  "  写病人身上能被观察或测量的东西，不要写诊断名。",
  "  反例（线上实测出现过，不要这样写）：「下尿路感染」是诊断不是观察项；",
  "  「苔黄腻的严重程度、发作频次及对日常功能的影响」——舌苔没有发作频次。",
  "  正例：「排尿灼痛程度与次数」「小便颜色与浑浊度」「有无腰痛或发热」「舌苔黄腻消退情况」。",
  "",
    "· timeline 是**本例的**随访时间轴，2–4 条，按时间先后排列。每条四栏：",
  "  time＝时间点（如「服药3天」「一周后」「疗程结束时」）。**第一条固定是首次复诊，time 写「首次复诊」即可**，",
  "  系统会替换成上面给出的实际时间；第二条起按本例病程自己排，不得与第一条撞车；",
  "  action＝这个时间点具体要做什么（复诊查体？线上问诊？调方？停药观察？），写本例真正该做的动作；",
  "  indicators＝这个时间点要看的观察项（不同时间点看的东西应当不同，早期看表证消长、后期看正气恢复）；",
  "  triggers＝出现什么情况就不等到这个时间点、提前来诊。indicators 与 triggers 都写成**字符串数组**。",
  "  **每条的 action 与 triggers 必须因本例而异**。反例（这是旧模板的原话，写出来整份会被丢弃）：",
  "  「完成首次复诊与疗效复评」「记录症状变化并按触发条件提前复评」",
  "  「主要症状较首诊无改善或加重，或出现新的伴随症状」——这几句放在任何病人身上都成立，等于没写。",
  "  正例（风寒袭肺咳嗽）：time「服药3天」action「电话或线上复诊，确认恶寒是否已解、咳嗽是否转为松畅」",
  "  triggers「出现高热、气促、痰转黄稠或胸痛」。",
  "· 不得写具体日期（如「8月15日」）——只写相对时间点。",
  "",
  "严禁：写任何剂量或药量；写让患者自行加减药、换方、停药；引用指南或文献；",
  "承诺疗效或给出预后断言；提及处方之外的药物。这些一经出现，整份输出会被服务端丢弃。",
].join("\n");

/**
 * 观察项/触发条件既可能是数组，也可能是模型顺手写成的**一句话**。
 *
 * 2026-08-12 本地实测（真实医案）：模型稳定返回
 * `"triggers":"服药后出现发热、腰痛、血尿或症状加重，立即提前就诊。"` 这样的字符串，
 * 而校验写死 `Array.isArray(...) ? ... : []` ⇒ 判空 ⇒ 整条时间轴废掉 ⇒ 全部回落模板。
 * 模型给的内容本身是对的，是解析太死。两种形态都收：字符串按顿号/分号/逗号切成短语。
 * 这与仓库既有口径一致（symptoms 也支持字符串与数组两种形态）。
 */
function authoredPhraseList(value: unknown, min: number, max: number, limit: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[、；;，,]|(?<=[。.])/)
      : [];
  return [...new Set(raw
    .map((entry) => validAuthoredText(entry, min, max))
    .filter(Boolean))].slice(0, limit);
}

function validAuthoredText(value: unknown, min = 10, max = 200): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length < min || text.length > max) return "";
  // 剂量写法复用 M04 那条已导出的判据，不写第二份。
  if (PRECAUTION_DOSE_LIKE.test(text) || CITATION_LIKE.test(text)) return "";
  // 处方级动作与疗效承诺走**受治理禁述表**，不在代码里手写：
  // 这一层漏收一个词等于放行「可自行减量」，失败方向不安全，必须可审核可回归。
  if (patientInstructionProhibitionsIn(text).length > 0) return "";
  return text;
}

export async function authorFollowupClinicalContent(
  state: CaseState,
  input: {
    syndrome?: string;
    pathogenesis?: string;
    therapy?: string;
    herbs?: readonly string[];
    /** 处方煎服法确定的首次复诊时间。时间轴第一条必须与它逐字相同，否则表与正文会各说各的。 */
    firstReviewTiming?: string;
  },
  signal?: AbortSignal,
): Promise<AuthoredFollowupContent | null> {
  if (process.env.M05_FOLLOWUP_AUTHORING === "false" || signal?.aborted) return null;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return null;
  const syndrome = String(input.syndrome || "").trim();
  // 证候是本层唯一的立足点：没有签名过的证候就写不出「针对这一例」的调护，
  // 那就没有比模板更好的输出，直接回落。
  if (!syndrome) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTHORING_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    const client = createTextModelClient(config);
    const response = await client.chat.completions.create({
      model: config.model,
      temperature: 0.2,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: clinicalContextForAuthoring(
            state, syndrome,
            String(input.pathogenesis || ""), String(input.therapy || ""),
            (input.herbs || []).slice(0, 30),
            String(input.firstReviewTiming || ""),
          ),
        },
      ],
    }, { signal: controller.signal });
    const raw = response.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const reviewFocus = validAuthoredText(parsed.reviewFocus, 12, 200);
    const efficacyCriteria = validAuthoredText(parsed.efficacyCriteria, 12, 200);
    const lifestyle = validAuthoredText(parsed.lifestyle, 12, 240);
    // 维度是受治理闭集：越界项直接丢弃，模型无法引入新维度。
    const dimensions = Array.isArray(parsed.dimensions)
      ? [...new Set(parsed.dimensions
        .map((item) => String(item || "").trim())
        .filter((item) => GOVERNED_DIMENSIONS.includes(item as (typeof GOVERNED_DIMENSIONS)[number])))]
      : [];

    // 观察指标逐条过同一套校验（剂量写法 / 引用 / 受治理禁述表），只是长度按短语收窄。
    // 与三段散文不同，它**不是**采纳与否的门槛：挑不出来就回落 coreMetrics 拼串，
    // 那只是回到今天的行为，不影响另外三段的正确性。
    const monitoringIndicators = authoredPhraseList(parsed.monitoringIndicators, 3, 24, 5);

    // ── 时间轴逐条校验 ──────────────────────────────────────────────────
    // 判据与三段散文同源（剂量写法 / 引用 / 受治理禁述表），另加三条这一栏特有的：
    // 不得原样吐回旧模板套话、不得写具体日期、第一条时间点必须等于处方定的首次复诊时间。
    const timeline: AuthoredTimelineItem[] = (Array.isArray(parsed.timeline) ? parsed.timeline : [])
      .slice(0, 4)
      .map((raw) => {
        const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        // 上限放宽到 40：时间点写法本来就可以带条件（「完成5剂后复诊」「疗程结束后一周」），
        // 24 字这道卡本身就是上一版整条回落的直接原因之一。
        const time = validAuthoredText(item.time, 2, 40);
        const action = validAuthoredText(item.action, 6, 60);
        const indicators = authoredPhraseList(item.indicators, 3, 28, 5);
        const triggers = authoredPhraseList(item.triggers, 4, 40, 4);
        if (!time || !action || indicators.length === 0 || triggers.length === 0) return null;
        // 具体日期一律不要：本层拿不到就诊日，写出来的日期必然是编的。
        if (/\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}\s*[-/年]/.test(time)) return null;
        // 套话原样吐回等于没写。
        if ([time, action, ...triggers].some((text) => TEMPLATE_BOILERPLATE.includes(text))) return null;
        // 第一条的时间点由**服务端强制覆盖**成处方煎服法定的那个值（见 diagnosis-safety
        // 的 timelineItems 构造），所以这里不再要求模型逐字复述它——
        // 2026-08-12 线上实测：那个值可以长达 25 字（「完成5剂（5日）后复诊；出现不适或
        // 症状加重时提前复诊」），既超过本栏长度上限、模型也几乎必然改写，
        // 结果第一条恒被判废、整条时间轴回落模板。要求模型复述一个服务端反正会覆盖的值，
        // 是给自己设了一道只会误伤的闸。
        return { time, action, indicators, triggers };
      })
      .filter((item): item is AuthoredTimelineItem => item !== null);
    // 时间点重复的时间轴不是时间轴。
    const uniqueTimes = new Set(timeline.map((item) => item.time));
    const usableTimeline = timeline.length >= 2 && uniqueTimes.size === timeline.length ? timeline : [];

    // 三段临床内容缺任何一段都不采纳：半份模型内容 + 半份模板会读起来自相矛盾
    // （模板那半句「按本例非药物建议安排饮食作息」与模型那半段具体调护并列）。
    if (!reviewFocus || !efficacyCriteria || !lifestyle) return null;
    return {
      reviewFocus,
      efficacyCriteria,
      lifestyle,
      // 维度挑不出来就用全六维——那只是少一层裁剪，不影响正确性。
      dimensions: dimensions.length >= 2 ? dimensions : [...GOVERNED_DIMENSIONS],
      monitoringIndicators: monitoringIndicators.length >= 2 ? monitoringIndicators : [],
      // 时间轴与三段散文各自独立：时间轴没写好只回落这一栏，不牵连另外三段。
      timeline: usableTimeline,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Shared M05 patient-level authoring boundary for assess, post-prescription review and HIS.
 * The helper only prepares clinical context. Deterministic risk verdicts remain owned by
 * buildDeterministicRiskFollowup(Payload) in each outlet after this function returns.
 */
export async function authorFollowupForCase(
  state: CaseState,
  diagnoseReasoning: ClinicalReasoningResultV2 | null | undefined,
  selectedCandidate: { herbs?: ReadonlyArray<{ name?: string | null }> } | null | undefined,
  signal?: AbortSignal,
): Promise<AuthoredFollowupContent | null> {
  return authorFollowupClinicalContent(state, {
    syndrome: diagnoseReasoning?.overview?.primarySyndrome,
    pathogenesis: diagnoseReasoning?.pathogenesis?.summary,
    therapy: [diagnoseReasoning?.therapy?.overallPrinciple, diagnoseReasoning?.therapy?.overallMethod]
      .filter(Boolean).join("；"),
    herbs: (selectedCandidate?.herbs || [])
      .map((herb) => herb.name)
      .filter((name): name is string => typeof name === "string" && Boolean(name.trim())),
    firstReviewTiming: deriveFirstReviewTiming(state, hasStrongPrescriptionRisk(state)),
  }, signal);
}

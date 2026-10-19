import "server-only";

import { parseM02PlanFromContent } from "./m02-question-contract";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 模型写的追问题出题前再核一次：它要问的内容病历是不是已经写明了（2026-10-17）。
 *
 * 甲方标准病历 4 两次生成都问了一半已知的题（「胃脘部疼痛对冷热的反应及大便性状」，病历写着「大便溏结不调」；
 * 「疼痛的性质与按压反应」，病历写着「以胃脘胀痛为主」），留出例 S078、S079、S128 问的是病历已经写明的内容。
 * 甲方口径：追问不重复病历已写内容才算合格。
 *
 * 为什么用模型：选项与病历的字面重合判不出来——离线 289 道题里，评审判重复的几道与病历的字二元组包含率多为 0～0.4，
 * 与不重复的题混在一起（~/runlogs/deliver1017/qred）。做法与急症筛查题的可答性核对相同（MediQ：只提示「别重复」
 * 不够，要在出题后过滤）：让小模型只判这一件事，并交出病历原文，服务端逐字核对。
 *
 * 边界：
 *  · 只核模型写的题；服务端自有的兜底题、基本问诊题、急症筛查题不经这里（急症筛查题另有 m02-risk-question-answerability）；
 *  · 判 answered（病历已写明）或 partly（题干问了几件事、其中一件病历已写明）且每条引文都逐字在病历里，才删这道题，
 *    之后与确定性删题同一条路：计划删空时按「不需要再问」处理（允许 proceed 时直接 proceed，否则出服务端的基本问诊题）；
 *  · 超时、未配置、输出非法都当没有重复（照常出题），失败结果不缓存。
 * 开关：CDSS_M02_QUESTION_REDUNDANCY_CHECK=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M02_QUESTION_REDUNDANCY_TIMEOUT_MS || 4_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 4_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_M02_QUESTION_REDUNDANCY_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

const SYSTEM = [
  "你是追问题与病历的重复核对器，不负责评价这道题问得好不好。",
  "给你一份门诊病历和一道准备让医生问患者的追问题（题干与各选项）。只判断一件事：这道题要问的内容，病历里是不是已经写明了。",
  "- answered：题干要问的内容病历已经写明（包括写明没有、写明相反情况）；或某个选项基本就是病历已经写过的话，医生照病历就能直接选出答案。",
  "- partly：题干同时问了两件以上的事，其中至少一件病历已经写明，另一件没有。",
  "- not_answered：题干要问的内容病历没有写，或只写了与之无关的内容。",
  "注意：病历写了“主症是什么”不等于写了“主症在冷热、按压、时间等方面的特点”；只看题干实际问的那几件事。",
  // 2026-10-17 第四轮复测：病历 5「平时最困扰的是气短自汗，还是食少胃胀」（两组都是病历原话）、病历 9「风团颜色偏鲜红还是淡白」
  //（病历写着红色风团）独立评审判重复，第一版判 not_answered。离线 329 题新增 4 处判 partly，均合理（~/runlogs/deliver1017/qred/v2.json）。
  "以下也算 partly：题干同时问的几项特征里，有一项病历已经写明（如问风团颜色，病历写着红色风团）。",
  // 2026-10-19 甲方病历 5 第 1、3 次生成：「平素最困扰的主要是气短自汗、易感冒，还是食少胃胀、大便稀溏？」两组都是病历原话，
  // 此前这条写成上一句的附带说明（「各选项的表现都写了、只问哪组为主也算 partly」），模型仍按「病历没写哪组为主」判
  // not_answered（离线 3 道题各核 3 次，9/9）。改成单列一类、写明优先于 not_answered：同 9 次全判 partly；
  // 离线 294 道模型题对照见 ~/runlogs/r1018/work/r1019/agentB/r3。
  "主次题：题干只问“哪一组/哪一项为主、更突出、更明显、最困扰”，选项是两组或几组表现。每个选项列的表现病历里都已经写了，就判 partly——病历没写哪一组为主也照样判 partly，这条优先于 not_answered；quotes 给病历里写这些表现的原文。有一个选项的表现病历没写，就按其他规则判。",
  // 2026-10-19 r1019：留出例 S158 问「按压胃脘腹部是拒按还是喜按」，病历写着「无腹痛拒按」；验收集 B 选项「大便酸臭，夹有乳凝块或颗粒」，
  // 病历写着「大便黄色，有颗粒状物」。两题评审都判重复，第一版核对判 not_answered。
  "以下也算 partly：某个选项的表现病历已写明没有（如问“拒按还是喜按”，病历写着“无腹痛拒按”）；某个选项里有一项表现就是病历已写的那件事换了说法（如选项“夹有乳凝块或颗粒”，病历写着“有颗粒状物”）。",
  // 2026-10-19 r1019 第四轮（Claude 评审 B 集）：问诊记录写着「咳嗽时候没有痰」「痰没吐出来过」，模型照问「咳嗽时痰的颜色和质地」，
  // 两个选项都预设有痰（B-IMCS21-test-10327571#11、B-MedDG-train-dialog525#12），评审判问了已写明的事；此前的规则只覆盖「选项被否认」，
  // 没有覆盖「题干问的那个表现本身被否认」。
  "前提已被否认也算 answered：题干问某个表现的颜色、性状、量、程度、时间或诱因，而病历已写明没有这个表现、或它没有出现过（如问“痰的颜色和质地”，病历写着“咳嗽时候没有痰”或“痰没吐出来过”）——病历已经回答了这一问；quotes 给写明没有的原文。",
  "拿不准时判 not_answered。",
  "answered 或 partly 时给出 quotes：病历里写明该内容的原文片段（逐字复制，每条不超过40字，1–3条）和 reason（≤30字）。",
  "只输出 JSON：{\"verdict\":\"answered|partly|not_answered\",\"quotes\":[\"…\"],\"reason\":\"…\"}",
].join("\n");

/** 模型输出 → 这道题是否复述了病历。只有 answered / partly、1–3 条引文且每条都逐字在病历里时为 true。 */
export function recordRepeatsQuestion(content: unknown, recordText: string): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const { verdict, quotes } = parsed as { verdict?: unknown; quotes?: unknown };
  if (verdict !== "answered" && verdict !== "partly") return false;
  if (!Array.isArray(quotes) || quotes.length === 0 || quotes.length > 3) return false;
  const record = compact(recordText);
  return quotes.every((quote) => {
    const text = typeof quote === "string" ? compact(quote) : "";
    return text.length >= 2 && text.length <= 60 && record.includes(text);
  });
}

async function questionRepeatsRecord(
  input: { recordText: string; question: string; options: string[] },
  signal?: AbortSignal,
): Promise<boolean> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return false;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim() || !input.question.trim()) return false;
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: JSON.stringify({ record: recordText, question: input.question, options: input.options }) },
  ];
  return memoizedSmallTask<boolean>("m02_question_redundancy", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m02_question_redundancy", stage: "question", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 200,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: recordRepeatsQuestion(content, recordText), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: false, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, false, signal);
}

/**
 * 计划里复述病历的模型题的 id。serverOwnedText 是本轮服务端自有题的全文（兜底题、基本问诊题），
 * 题干出现在其中的不核。
 */
export async function questionIdsRepeatingRecord(
  content: string,
  recordText: string,
  serverOwnedText: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!enabled() || signal?.aborted) return [];
  const plan = parseM02PlanFromContent(content);
  if (!plan || plan.decision !== "ask") return [];
  const owned = compact(serverOwnedText);
  const ids: string[] = [];
  for (const question of plan.questions.slice(0, 2)) {
    const stem = compact(question.question);
    if (!stem || owned.includes(stem)) continue;
    const options = question.options.filter((option) => option.kind === "clinical_fact").map((option) => option.answer);
    if (await questionRepeatsRecord({ recordText, question: question.question, options }, signal)) ids.push(question.id);
  }
  return ids;
}

/**
 * 模型写的追问题是不是在一个问句里问了两件事（2026-10-18）。
 *
 * 逐模块验收的问诊集（B，335 例）里，独立评审判不合格的 66 道题里 40 道是「题干问了两件事」：「宝宝目前的精神反应和吃奶情况」
 * 「流的鼻涕和咳出的痰是什么性状」「舌象与脉象更接近哪一组」。提示词早就写了「题干只问一件事」，模型照样并问。
 * 做法与上面的重复核对相同：小模型只判这一件事，并交出题干里两个问点的原文，服务端逐字核对；判 compound 的题删掉，
 * 走同一条收口（病历已足以辨证时 proceed，否则出服务端的单问点题）。
 * 「要分别回答两样东西」才算两件事；问有没有一组表现（「是否伴有气短、自汗」）是一个问点。第一版按「连着两个症状」判，
 * 在甲方标准病例上把这类成组有无题也删了（三次生成 30 道里 6 道变成 proceed，而独立评审原本判这些题合格）。
 * 离线（~/runlogs/r1018/qcompound，v3）：B 集 323 道模型题里，评审判「两件事」的 40 道抓到 23 道，评审判合格的题误判 6 道；
 * 甲方 10 例×3 与留出 32 的 42 道模型题只标出 2 道「舌象与脉象表现如何」。
 * 同一症状的几个特征、在几组表现里选一组、危险信号筛查题都算一个问点。超时、未配置、输出非法都当一个问点（照常出题）。
 * 开关：CDSS_M02_QUESTION_SINGLE_POINT_CHECK=false 关闭。
 */
// 2026-10-19 r1019：去掉了 single 一侧的「更接近下面哪一种？」示例——它与 compound 一侧的「舌象与脉象更接近哪一组」互相矛盾，
// 同一题干「舌象与脉象更接近下列哪一组？」8 次里判 compound 3 次、single 5 次（结论随选项变）。核对现在只看题干（不再给选项）。
// 判据是「几个对象」，不是「几个词」：同一个症状或排出物的几项特征（大便的气味和性状、排便时的感觉）是一个问点。
// 离线探针（~/runlogs/r1018/work/r1019/agentB/qprobe）：只给题干、未写这条时，「大便的气味和性状更接近哪一种」7 次被判 compound；
// 题干自己列两组证候表现让选一组的（「胃脘怕冷喜温，还是口苦胸胁胀满」、甲方病例 5「气短自汗易感冒，还是食少胃胀便溏」）也算一个问点（项目负责人口径）。
const SINGLE_POINT_SYSTEM = [
  "你是追问题题干的核对器，不负责评价这道题问得好不好。只判断一件事：这道题的题干是不是要患者分别回答两个不同对象的情况。",
  "对象指一个症状、一种排出物、一处病变、一项诊察（舌象、脉象、指纹）或全身状况（寒热、精神、饮食、喂养、体质）。",
  "- compound：题干里有两个不同的对象要分别描述，一个答案说不清（如“精神反应和吃奶情况如何”“鼻涕和痰是什么性状”“舌象与脉象更接近哪一组”“涕液性状与全身寒热表现更接近哪一种”“口渴和大便情况怎样”“黄疸的色泽与伴随表现”“痰的性状与寒热表现”“误服的物质和现在有没有不适”“大便气味与喂养方式”“平时是否怕冷、吃凉的东西后胃痛会不会加重”）。",
  "- single：题干只有一个对象，一个回答就能答完。包括：同一个对象的几项特征（如“痰的颜色和性状”“大便的气味和性状更接近哪一种”“大便的性状和排便时的感觉”“疼痛的部位和性质”“疼痛对冷热和按压的反应”“发热的最高温度和持续时间”“白点的形态和分布”）；同一项诊察的几个部分（如“舌质与舌苔”“口渴和饮水情况”）；问有没有几项表现中的任一项或这一组表现（如“是否伴有气短、自汗”“有无发热、怕风等外感表现”“是否加重并伴发热或出血”）；同一个对象的两种情况选一种（如“发热时是恶寒重、无汗，还是发热重、有汗？”“风团遇热加重还是遇冷加重？”）；题干自己列出两组表现、问更接近哪一组或以哪一组为主——每组是同一证型的几项表现，即使涉及不同部位也算一个问点（如“胃脘部怕冷、喜温喜按，还是口苦、胸胁胀满？”“最困扰的是气短自汗、易感冒，还是食少胃胀、便溏？”）。",
  "拿不准时判 single。",
  "compound 时给出 points：题干里那两样东西各自的原文片段（逐字复制题干，各不超过12字）。",
  "只输出 JSON：{\"verdict\":\"compound|single\",\"points\":[\"…\",\"…\"]}",
].join("\n");

function singlePointCheckEnabled(): boolean {
  return process.env.CDSS_M02_QUESTION_SINGLE_POINT_CHECK !== "false";
}

/** 模型输出 → 题干是否并问两件事。只有 compound、恰好两条 points、各自逐字在题干里且互不包含时为 true。 */
export function questionAsksTwoThings(content: unknown, stem: string): boolean {
  if (typeof content !== "string" || !content.trim()) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const { verdict, points } = parsed as { verdict?: unknown; points?: unknown };
  if (verdict !== "compound" || !Array.isArray(points) || points.length !== 2) return false;
  const text = compact(stem);
  const [first, second] = points.map((point) => typeof point === "string" ? compact(point) : "");
  if (!first || !second || first.length > 16 || second.length > 16) return false;
  if (!text.includes(first) || !text.includes(second)) return false;
  return !first.includes(second) && !second.includes(first);
}

async function questionStemAsksTwoThings(
  input: { question: string },
  signal?: AbortSignal,
): Promise<boolean> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured || !input.question.trim()) return false;
  // 只给题干：问点数是题干的事，给了选项，同一题干的结论会随选项变（见 SINGLE_POINT_SYSTEM 上方说明）。
  const messages = [
    { role: "system" as const, content: SINGLE_POINT_SYSTEM },
    { role: "user" as const, content: JSON.stringify({ question: input.question }) },
  ];
  return memoizedSmallTask<boolean>("m02_question_single_point", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m02_question_single_point", stage: "question", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 120,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: questionAsksTwoThings(content, input.question), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: false, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, false, signal);
}

/**
 * 出题前要删的模型题：复述病历的（上面的重复核对）与并问两件事的，两项核对并行跑。
 * serverOwnedText 是本轮服务端自有题的全文，题干出现在其中的不核。
 */
export async function questionIdsFailingNarrowChecks(
  content: string,
  recordText: string,
  serverOwnedText: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) return [];
  const plan = parseM02PlanFromContent(content);
  if (!plan || plan.decision !== "ask") return [];
  const owned = compact(serverOwnedText);
  const compoundIds = singlePointCheckEnabled()
    ? Promise.all(plan.questions.slice(0, 2).map(async (question) => {
      const stem = compact(question.question);
      if (!stem || owned.includes(stem)) return undefined;
      return await questionStemAsksTwoThings({ question: question.question }, signal) ? question.id : undefined;
    }))
    : Promise.resolve([]);
  const [repeated, compound] = await Promise.all([
    questionIdsRepeatingRecord(content, recordText, serverOwnedText, signal),
    compoundIds,
  ]);
  return [...new Set([...repeated, ...compound.filter((id): id is string => typeof id === "string")])];
}

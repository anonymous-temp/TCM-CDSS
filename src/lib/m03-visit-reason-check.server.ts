import "server-only";

import { sanitizeFreeTextForModel } from "./diagnosis-safety";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { textbookDiseaseDefinition } from "./tcm-textbook-syndromes";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

/**
 * 中医病名是否解释了本次就诊原因（2026-10-25 第十九轮）。
 *
 * 病名按主诉定：主诉是「促使患者就诊的主要症状、体征及持续时间」，病名要能解释它；伴随症状、宿疾、偶然发现不立为本次病名。
 * 闭集选病（textbook-disease-pick）本来就按这一条排序，可是辨证半在候选里按「整组表现」比较时会越过它：
 * 网上收集的基层病历 A033「感冒后发热2周（伴自幼遗尿）」选病给的是「发热、遗尿」，辨证半写成遗尿·心肾失交证；
 * B012「2型糖尿病3年，就诊取降糖药」选病只给消渴，辨证半写成疮疡（一处基本愈合的蚊虫叮咬创面）；
 * A036「发热2天，伴腹胀、纳差」写成积滞。同一批 295 份输出里，辨证半有 37 份没有用选病的第一个病，其中多数是改对了
 *（S078 虚劳、C025 心衰、C080 痹证…），所以不能把病名钉在选病结果上——只核对「解释就诊原因」这一件事。
 *
 * 为什么用模型：「某病能不能解释这个主诉」是开放的判断（失眠对不寐、上腹痛对胃痛、头晕对虚劳），按字面比对定义会误杀。
 * 做法与西医病名核对相同：只让小模型判这一件事，正反两种候选顺序各问一次，两次都判不解释、给出的更合适病名相同才采信；
 * 主诉里表示就诊原因的那一段必须逐字出自主诉，更合适的病名必须出自候选清单。
 *
 * 边界：
 *  · 只在辨证半的病名不是选病第一个时才问（其余病例不发请求）；
 *  · 结论只决定要不要让辨证半按就诊原因重写一次（diagnosis-api 的 m03TcmHalfTransform 重抽），不直接改病名、不参与安全判断；
 *  · 超时、未配置、输出非法、两次不一致都当「已解释」（保留原稿），失败结果不缓存。
 * 开关：CDSS_M03_VISIT_REASON_CHECK=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M03_VISIT_REASON_CHECK_TIMEOUT_MS || 4_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 4_000;
})();
const MAX_HISTORY_CHARS = 320;

function enabled(): boolean {
  return process.env.CDSS_M03_VISIT_REASON_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
const sameDisease = (left: string, right: string) => compact(left).replace(/类病$/u, "") === compact(right).replace(/类病$/u, "");

const SYSTEM = [
  "你是中医门诊病名与就诊原因的核对器，不负责诊断，也不评价证型与治法。",
  "给你主诉、现病史开头、系统写出的中医病名（附教材定义）和候选病名清单（附教材定义）。只判断一件事：这个病名是否解释了本次就诊的主要原因。",
  "- 就诊原因：主诉里本次来看的主要不适，或主诉点名要处理的病。通常是写在最前面的主症；「伴」「并」之后的、括号里补充的、自幼或多年的宿疾、已基本痊愈或偶然发现的问题，一般不是就诊原因。",
  "- covered：该病的定义或主症包含就诊原因，或就诊原因是该病的典型表现。几个病都含就诊原因的症状时（如主诉头晕，病历整组是血虚表现而写成虚劳），也算解释了。主诉点名的西医病有对应的中医病名（如糖尿病对消渴）时，写成那个中医病名算解释了。",
  "- not_covered：该病只解释伴随症状、宿疾或偶然发现，不解释就诊原因（例：主诉「感冒后发热2周（伴自幼遗尿）」，病名写成遗尿；主诉「高血压复诊取药」，病名写成一处已愈的皮肤破损）。",
  "- 拿不准时判 covered。",
  "not_covered 时：visitReason 逐字复制主诉里表示就诊原因的那一段（不超过20字）；better 从候选清单里逐字选一个能解释就诊原因的病名，清单里没有就写 null；reason 不超过30字。",
  "只输出 JSON：{\"verdict\":\"covered|not_covered\",\"visitReason\":\"…\",\"better\":\"…\",\"reason\":\"…\"}",
].join("\n");

export type VisitReasonVerdict =
  | { status: "covered" }
  | { status: "unknown" }
  | { status: "not_covered"; visitReason: string; better: string; reason: string };

export interface VisitReasonInput {
  chiefComplaint: string;
  presentHistory: string;
  /** 辨证半写出的中医病名。 */
  disease: string;
  /** 闭集选病的结果（按它给出的先后）。 */
  picks: readonly string[];
  ageYears?: number;
}

/**
 * 主诉的主段：第一个「伴/伴有/兼/兼有/合并」或括号之前的部分（构词式闭集）。「发热2天，伴腹胀、纳差」→「发热2天，」；
 *「感冒后发热2周（伴自幼遗尿）」→「感冒后发热2周」；没有这些连接时是整条主诉。
 */
export function chiefComplaintLeadSegment(chiefComplaint: string): string {
  const text = compact(chiefComplaint);
  const at = text.search(/[（(]|伴有?|兼有?|合并/u);
  return at > 0 ? text.slice(0, at) : text;
}

/**
 * 只在辨证半的病名不是选病第一个时才核（其余病例不发请求）。病名本身就写在主诉主段里（「经期延长伴经量明显增多」写成经期延长）
 * 不核：它就是主诉点名的问题（离线 33 例里核对器唯一一次把主诉主段判成伴随的就是这一例，C067）。
 */
export function visitReasonCheckApplies(input: VisitReasonInput): boolean {
  if (!compact(input.chiefComplaint) || !compact(input.disease) || input.picks.length === 0) return false;
  if (sameDisease(input.disease, input.picks[0])) return false;
  const name = compact(input.disease).replace(/类病$/u, "");
  return !(name.length >= 2 && chiefComplaintLeadSegment(input.chiefComplaint).includes(name));
}

/** 模型输出 → 结论。visitReason 必须逐字出自主诉，better 必须是候选之一且不是原病名；否则当已解释。 */
export function parseVisitReasonVerdict(content: unknown, input: VisitReasonInput): VisitReasonVerdict {
  if (typeof content !== "string" || !content.trim()) return { status: "unknown" };
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return { status: "unknown" }; }
  if (!parsed || typeof parsed !== "object") return { status: "unknown" };
  const { verdict, visitReason, better, reason } = parsed as Record<string, unknown>;
  if (verdict === "covered") return { status: "covered" };
  if (verdict !== "not_covered") return { status: "unknown" };
  const quote = typeof visitReason === "string" ? compact(visitReason) : "";
  if (quote.length < 2 || quote.length > 24 || !compact(input.chiefComplaint).includes(quote)) return { status: "unknown" };
  // 就诊原因必须落在主诉主段里：「伴」之后、括号里的是伴随的问题，按定义不是就诊原因（C067 核对器引了「伴」之后的「经量明显增多」）。
  const lead = chiefComplaintLeadSegment(input.chiefComplaint);
  const leadEnd = compact(input.chiefComplaint).indexOf(lead) + lead.length;
  if (compact(input.chiefComplaint).indexOf(quote) >= leadEnd) return { status: "unknown" };
  // 只在候选里有能解释就诊原因的病时才采信：没有可换的病，重写只会让辨证半在候选外自由命名（B065 耳痛伴虫入感，候选只有耳鸣耳聋）。
  const named = typeof better === "string" && better.trim() && better.trim() !== "null" ? better.trim() : null;
  if (named === null || !input.picks.some((pick) => sameDisease(pick, named)) || sameDisease(named, input.disease)) return { status: "unknown" };
  return {
    status: "not_covered",
    visitReason: quote,
    better: input.picks.find((pick) => sameDisease(pick, named)) || named,
    reason: typeof reason === "string" ? reason.trim().slice(0, 40) : "",
  };
}

function messagesFor(input: VisitReasonInput, candidates: readonly string[]) {
  const describe = (name: string) => ({ name, definition: textbookDiseaseDefinition(name, input.ageYears) || null });
  return [
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content: JSON.stringify({
        chiefComplaint: sanitizeFreeTextForModel(input.chiefComplaint),
        presentHistory: sanitizeFreeTextForModel(input.presentHistory.slice(0, MAX_HISTORY_CHARS)),
        disease: describe(input.disease),
        candidates: candidates.map(describe),
      }),
    },
  ];
}

async function askOnce(input: VisitReasonInput, candidates: readonly string[], signal?: AbortSignal): Promise<VisitReasonVerdict> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return { status: "unknown" };
  const messages = messagesFor(input, candidates);
  return memoizedSmallTask<VisitReasonVerdict>("m03_visit_reason_check", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "m03_visit_reason_check", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 160,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      const verdict = parseVisitReasonVerdict(content, input);
      return { value: verdict, cacheable: verdict.status !== "unknown" };
    } catch {
      return { value: { status: "unknown" }, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, { status: "unknown" }, signal);
}

/**
 * 正反两种候选顺序各问一次（并行，约 0.7 秒）：两次都判不解释、给出的更合适病名一致时才返回 not_covered。
 * 其余情况（一次判解释、两次所指不同、任何一次失败）都当已解释或未知，保留原稿。
 */
export async function checkDiseaseExplainsVisitReason(input: VisitReasonInput, signal?: AbortSignal): Promise<VisitReasonVerdict> {
  if (!enabled() || signal?.aborted || !visitReasonCheckApplies(input)) return { status: "covered" };
  const candidates = input.picks.filter((pick) => !sameDisease(pick, input.disease));
  const [first, second] = await Promise.all([
    askOnce(input, candidates, signal),
    askOnce(input, [...candidates].reverse(), signal),
  ]);
  if (first.status === "not_covered" && second.status === "not_covered" && sameDisease(first.better, second.better)) return first;
  if (first.status === "unknown" || second.status === "unknown") return { status: "unknown" };
  return { status: "covered" };
}

/** 重抽辨证半时附在中医半提示词末尾的一段（只在 not_covered 时用）。 */
export function visitReasonRedrawInstruction(disease: string, verdict: Extract<VisitReasonVerdict, { status: "not_covered" }>): string {
  return [
    "【病名须解释本次就诊原因（服务端核对）】",
    `本次就诊原因是主诉里的「${verdict.visitReason}」。上一稿把中医病名写成「${disease}」${verdict.reason ? `：${verdict.reason}` : ""}，它不解释就诊原因，不作本次病名（与它相关的表现可在辨证依据里兼顾）。`,
    `请按就诊原因在【教材病证候选】里定病名（如「${verdict.better}」），并据此重写本半全部内容：辨病依据、病名与证候鉴别、证候、病机与治法都按新的病名写。`,
  ].join("\n");
}

/** 辨证半 JSON 里的中医病名；解析不了时为空串。 */
export function tcmHalfDiseaseName(tcmContent: string): string {
  try {
    const root = JSON.parse(tcmContent) as { overview?: { tcmDiseaseName?: unknown } };
    return typeof root?.overview?.tcmDiseaseName === "string" ? root.overview.tcmDiseaseName.trim() : "";
  } catch {
    return "";
  }
}

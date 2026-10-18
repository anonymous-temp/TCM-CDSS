import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { alignWesternNameWithRecord, isCleanWesternDiagnosisName, listedWesternDiagnosisNames, withoutSexIncompatibleWesternNames } from "./western-name-evidence-check.server";

/**
 * 西医主诊断的闭集重选（2026-10-19）。
 *
 * 要解决的是这一类：模型自己在候选或鉴别里写对了病，主诊断却停在所见、综合征或上一级，或者漏了病历已经写明的并发症。
 * 验收集 D 的 131 例不合格里，约 36 例的标准答案就在模型自己的候选或鉴别里：主诊断「急性弥漫性腹膜炎」、候选里有
 *「绞窄性肠梗阻」（腹穿血性臭味液）；主诊断「先天性心脏病」、候选里有「室间隔缺损」；主诊断「急性弥漫性腹膜炎」、病历
 * 血压80/60、四肢湿冷，候选里有「感染性休克」；硬膜下血肿与硬膜外血肿（中间清醒期）排反。
 *
 * 做法与病名一致性核对同一个模式：只问一件窄事，只在名单（西医半自己列出的候选与鉴别）里选，交出病历原文引文，服务端
 * 逐字核对后才采信。不产生西医半没有提出过的病名；换上的名称随后照常过病名一致性核对（缺确诊检查的仍会写成「待查」）。
 *  · replace：病历记录了确立名单里某病的检查所见或特征性表现，而当前主诊断只是所见、综合征或与记录不符；
 *  · append：当前主诊断成立，病历另记录了名单里某个同时存在、需要处理的并发症或合并症 → 「主诊断伴X」；
 *  · 红旗病例上不把急危重的首要考虑换成非急危重的病（追加不受此限：它不撤掉原诊断）。
 *  · 名单里的病本身就包含原诊断名（「高血压」→「高血压急症」、「甲状腺功能亢进症」→「甲状腺功能亢进症伴精神病性症状」）时按换名处理，
 *    不追加成「高血压伴高血压急症」；名单里的病已带「伴/合并」、或原名已有两处「伴/合并」时不再追加（离线回放 319 例里出现过
 *    「急性心肌炎伴暴发性心肌炎伴心源性休克」）。
 * 超时、未配置、输出非法、引文不在病历里、名称不在名单里，一律保持原样。temperature 0，按请求内容缓存。
 * 开关：CDSS_WESTERN_PRIMARY_RESELECT=false 关闭。
 */
const TIMEOUT_MS = 5_000;
const MAX_RECORD_CHARS = 2_400;
const MAX_COMBINED_NAME_CHARS = 40;

function enabled(): boolean {
  return process.env.CDSS_WESTERN_PRIMARY_RESELECT !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

export type WesternPrimaryReselection = {
  action: "replace" | "append";
  name: string;
  quote: string;
  reason: string;
};

const SYSTEM_PROMPT = `你是西医主诊断的核对器，不负责重新诊断。给你一份门诊病历、系统拟定的主诊断 currentDiagnosis，以及系统自己列出的候选与鉴别病名 listedDiagnoses。只判断一件事：主诊断要不要换成名单里的某个病，或在主诊断后补上名单里的某个病。
只有以下两种情况才改：
1. replace（换成名单里的病）：病历已经记录了确立或高度特异地指向名单里某个病的检查所见或特征性表现——活检或病理结果、影像的特征性征象、确诊性化验、该病典型的体征组合或病史特征（如外伤后昏迷、中间清醒、再次昏迷指向硬膜外血肿；腹腔穿刺抽出血性臭味液指向绞窄性肠梗阻；肝浊音界消失指向消化道穿孔）——而当前主诊断与这些记录不符，或只是一个检查所见、综合征、病理生理状态（如腹膜炎、占位性病变、肺不张、颅内血肿、传导阻滞、先天性心脏病、慢性肾脏病），名单里的病正是它的具体病因或具体病变。
2. append（在主诊断后补“伴某病”）：当前主诊断成立，但病历另外记录了名单里某个同时存在、需要处理的并发症或合并症的确凿表现（如收缩压低于90mmHg并四肢湿冷为休克，一侧呼吸音消失为气胸，深大呼吸或碱剩余明显降低为代谢性酸中毒，心律绝对不齐、心音强弱不等为心房颤动，幻听、被害妄想为精神障碍，病历写明的基础心脏瓣膜病）。
以下一律判 keep：名单里的病只是可能、需要做检查才能确定，而病历没有它的特异记录；你只是觉得另一个病也说得通；当前主诊断已经是与记录相符的病因诊断；当前主诊断是急危重症而名单里的病不是（不得把急危重的首要考虑换成较轻的病）。拿不准时判 keep。
name 逐字照抄 listedDiagnoses 里的写法；quote 逐字复制病历里确立该病的那句原文（不超过40字）；reason 用一句话（不超过30字）说明这句记录为什么指向该病。另给 currentIsEmergency、nameIsEmergency：当前主诊断、所选的病是否属于需要立即处理的急危重症。
只输出 JSON：{"action":"keep|replace|append","name":"…","quote":"…","reason":"…","currentIsEmergency":true|false,"nameIsEmergency":true|false}`;

/** 模型输出 → 可采信的重选（否则 undefined）。名称必须在名单里，引文必须逐字在病历里。 */
export function parseWesternPrimaryReselection(
  content: unknown,
  recordText: string,
  currentName: string,
  listedNames: readonly string[],
  options: { redFlag?: boolean } = {},
): WesternPrimaryReselection | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  const value = record(parsed);
  if (!value) return undefined;
  const action = value.action;
  if (action !== "replace" && action !== "append") return undefined;
  const raw = typeof value.name === "string" ? value.name.trim() : "";
  const name = listedNames.find((item) => compact(item) === compact(raw));
  const current = currentName.trim();
  if (!name || !isCleanWesternDiagnosisName(name) || /待查$/u.test(name) || compact(name) === compact(current)) return undefined;
  const quote = typeof value.quote === "string" ? value.quote.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason.trim().replace(/[。；;]+$/u, "") : "";
  if (compact(quote).length < 4 || compact(quote).length > 60 || !compact(recordText).includes(compact(quote))) return undefined;
  if (reason.length < 4 || reason.length > 60) return undefined;
  // 名单里的病本身就是在原诊断名上说得更具体：按换名处理。
  const effective = action === "append" && compact(name).includes(compact(current)) ? "replace" : action;
  // 休克的数字门槛（收缩压<90mmHg）：引文里写了血压而收缩压都不低于 90 时不采信（离线回放 X-D-0060 血压90/60mmHg 被补成「伴心源性休克」）。
  if (/休克/u.test(name) && quotedBloodPressureNotShock(quote)) return undefined;
  if (effective === "replace" && options.redFlag && value.currentIsEmergency === true && value.nameIsEmergency !== true) return undefined;
  // 「伴X」只补急危重并发症（2026-10-19：262 例实跑里补出「热性惊厥伴脓毒性休克」「甲亢伴精神分裂症」「慢性胰腺炎伴糖尿病」，
  // 评审判过细或错配；漏判的是感染性休克、气胸、房颤这类须立即处理的并发症）。模型自己判 nameIsEmergency。
  if (effective === "append" && value.nameIsEmergency !== true) return undefined;
  if (effective === "append" && (
    /待查$/u.test(current) || compact(current).includes(compact(name)) || /伴|合并/u.test(name) ||
    (current.match(/伴|合并/gu) || []).length >= 2 ||
    `${current}伴${name}`.length > MAX_COMBINED_NAME_CHARS
  )) return undefined;
  return { action: effective, name, quote, reason };
}

/** 引文里的血压读数（mmHg，或 kPa 折算）都不低于收缩压 90：说明这句记录本身够不上休克。没有血压读数时为 false。 */
function quotedBloodPressureNotShock(quote: string): boolean {
  const readings = [...quote.normalize("NFKC").matchAll(/(\d{1,3}(?:\.\d)?)\s*\/\s*\d{1,3}(?:\.\d)?\s*(mmHg|kPa)?/giu)]
    .map((match) => Number(match[1]) * (/kpa/i.test(match[2] || "") ? 7.5 : 1))
    .filter((value) => Number.isFinite(value) && value >= 40);
  return readings.length > 0 && readings.every((systolic) => systolic >= 90);
}

/** 把采信的重选写进西医半的输出：只动主诊断名、候选与鉴别三处；解析不了时原样返回。 */
export function applyWesternPrimaryReselection(westernContent: string, selection: WesternPrimaryReselection): string {
  let parsed: unknown;
  try { parsed = JSON.parse(westernContent); } catch { return westernContent; }
  const root = record(parsed);
  const western = record(root?.westernDiagnosis);
  const primary = record(western?.primary);
  const previous = typeof primary?.name === "string" ? primary.name.trim() : "";
  if (!root || !western || !primary || !previous) return westernContent;
  const candidates = Array.isArray(western.candidates) ? western.candidates.filter((item): item is Json => Boolean(record(item))) : [];
  const differentials = Array.isArray(western.differentials) ? western.differentials.filter((item): item is Json => Boolean(record(item))) : [];
  const lead = candidates.find((item) => item.name === previous);
  const selected = candidates.find((item) => item.name === selection.name);
  const others = candidates.filter((item) => item.name !== previous && item.name !== selection.name);
  if (selection.action === "replace") {
    primary.name = selection.name;
    if (candidates.length > 0) {
      western.candidates = [
        selected ? { ...selected } : { name: selection.name, likelihood: "中", keyEvidence: [selection.quote], againstEvidence: [] },
        ...(lead ? [{ ...lead }] : []),
        ...others,
      ].slice(0, 3);
    }
    western.differentials = [
      ...(differentials.some((item) => item.name === previous) ? [] : [{ name: previous, reason: "原首要考虑，需鉴别", distinguishingPoints: selection.reason, nextCheck: "结合检查结果复核" }]),
      ...differentials.filter((item) => item.name !== selection.name),
    ].slice(0, 8);
  } else {
    const combined = `${previous}伴${selection.name}`;
    primary.name = combined;
    if (candidates.length > 0) {
      western.candidates = [{ ...(lead || candidates[0]), name: combined }, ...others].slice(0, 3);
    }
    western.differentials = differentials.filter((item) => item.name !== selection.name);
  }
  return JSON.stringify(root);
}

export async function westernPrimaryReselectionForRecord(
  input: { recordText: string; currentName: string; listedNames: readonly string[]; patient?: { sex?: unknown; age?: unknown }; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<WesternPrimaryReselection | undefined> {
  if (!enabled() || signal?.aborted) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  const currentName = input.currentName.trim();
  if (!recordText.trim() || currentName.length < 2 || input.listedNames.length === 0) return undefined;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: input.patient?.sex ?? null, age: input.patient?.age ?? null },
        record: recordText,
        currentDiagnosis: currentName,
        listedDiagnoses: [...input.listedNames],
      }),
    },
  ];
  // 红旗与否不进缓存键：同一份病历的模型结论共用，红旗下的取舍在解析时做。
  const raw = await memoizedSmallTask<string | undefined>("western_primary_reselect", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "western_primary_reselect", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 220,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: typeof content === "string" ? content : undefined, cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
  return parseWesternPrimaryReselection(raw, recordText, currentName, input.listedNames, { redFlag: input.redFlag });
}

type WesternHalfContext = { recordText: string; patient?: { sex?: unknown; age?: unknown }; redFlag?: boolean };

/** 从西医半的输出取主诊断与名单，求重选结论（不改写）；任何失败都返回 undefined。 */
async function westernPrimaryReselectionForContent(westernContent: string, context: WesternHalfContext, signal?: AbortSignal): Promise<WesternPrimaryReselection | undefined> {
  if (!enabled()) return undefined;
  let currentName = "";
  let listedNames: string[] = [];
  try {
    const western = record(JSON.parse(westernContent))?.westernDiagnosis;
    currentName = String(record(record(western)?.primary)?.name || "").trim();
    listedNames = listedWesternDiagnosisNames(western);
  } catch {
    return undefined;
  }
  if (!currentName || listedNames.length === 0) return undefined;
  const selection = await westernPrimaryReselectionForRecord({ ...context, currentName, listedNames }, signal).catch(() => undefined);
  console.info("[tcm-cdss:telemetry] western_primary_reselect", {
    applied: Boolean(selection),
    action: selection?.action,
    // 病名不是患者信息；记下来便于把重选归到病例上。
    currentName: currentName.slice(0, 30),
    name: selection?.name.slice(0, 30),
  });
  return selection;
}

/** 只做闭集重选（不做病名核对）；任何失败都原样返回。 */
export async function reselectWesternPrimaryFromListed(westernContent: string, context: WesternHalfContext, signal?: AbortSignal): Promise<string> {
  const selection = await westernPrimaryReselectionForContent(westernContent, context, signal);
  return selection ? applyWesternPrimaryReselection(westernContent, selection) : westernContent;
}

/**
 * 西医半返回后的收口：闭集重选与病名一致性核对并行。
 *  · 没有重选：交付病名核对的结果；
 *  · 换名：对新名称再核对一次（缺确诊检查的照常写成「待查」）——只在换名时多一次调用；
 *  · 追加并发症：病名核对针对的是原诊断名，它没改原名时交付「原名伴X」；它改了原名（说过头、与记录不符）时交付核对结果、不再追加
 *   （离线回放里「慢性肾脏病伴肾性贫血」被整条核成「贫血」，追加后的组合名不再交给核对）。
 */
export async function alignWesternPrimaryAndName(rawWesternContent: string, context: WesternHalfContext, signal?: AbortSignal): Promise<string> {
  // 候选与鉴别里先去掉患者性别不可能有的病名（男性的妇产科病名、女性的前列腺类病名；2026-10-19）：重选与核对都只看剩下的名单，
  // 不会把这类病选成主诊断或在改名时采用它。
  const westernContent = withoutSexIncompatibleWesternNames(rawWesternContent, context.patient?.sex);
  const [selection, aligned] = await Promise.all([
    westernPrimaryReselectionForContent(westernContent, context, signal),
    alignWesternNameWithRecord(westernContent, context, signal),
  ]);
  if (!selection) return aligned;
  const reselected = applyWesternPrimaryReselection(westernContent, selection);
  if (selection.action === "replace") {
    const rechecked = await alignWesternNameWithRecord(reselected, context, signal);
    // 换成的是原名的细化（「系统性硬化症」→「系统性硬化症伴肺间质纤维化急性加重」）而核对说它过头：细化不成立，交付原名的核对结果，
    // 不把原来成立的诊断变成「…待查」（离线回放 X-D-1286、X-D-3103）。
    const originalName = primaryNameOf(westernContent);
    const refinement = Boolean(originalName) && compact(selection.name).includes(compact(originalName));
    return refinement && primaryNameOf(rechecked) !== selection.name ? aligned : rechecked;
  }
  return aligned === westernContent ? reselected : aligned;
}

function primaryNameOf(westernContent: string): string {
  try {
    return String(record(record(record(JSON.parse(westernContent))?.westernDiagnosis)?.primary)?.name || "").trim();
  } catch {
    return "";
  }
}

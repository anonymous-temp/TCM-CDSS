import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { westernLabelContainsTcmSyndrome } from "./clinical-governance-tables";

/**
 * 参考西医诊断名与病历已记录内容的一致性核对（2026-10-14）。
 *
 * 要解决的是这一类：病名与病历已经写明的内容直接矛盾，或说得过头——家属明确说夜间无打鼾憋气，诊断写睡眠呼吸暂停低通气综合征；
 * 月经周期规律、只有一次 AMH 偏低，写早发性卵巢功能不全；能进食、尿量正常、酮体阴性，写妊娠剧吐；肛门镜见痔核脱出，写直肠脱垂。
 * 独立评审里西医诊断不通过的病例属于这一类。
 *
 * 为什么不改生成侧：上一轮在西医半提示词里加过「下病名前先对照检查结果」，三例复跑不变；本轮试过让模型在病名之前先写一栏
 *「检查结果→意义」，模型对检查的解读是对的，病名照旧，而且首轮结构违规从 0/190 升到 30/40（漏写鉴别、依据写成对象）。
 * 相关研究的结论是一致的：模型「知道标准」不等于「用上标准」，要它定位自己的错很难，把具体位置指给它之后改起来却很准；
 * 泛化的复核模型会过度挑错（本项目 9/16 删掉的复核环节 84% 打回）。所以这里只问一件窄事、只在三种情形下成立，
 * 并且要交出病历原文片段，服务端逐字核对后才采信。
 *
 * 离线实测（已落盘的 252 例辨证结果）：合成 190 例标出 9–10 例（两次运行一致 9 例），其中 7 例确属矛盾或说过头、1 例为误报
 *（静息心电图 T 波低平被当成不支持冠心病）；甲方既往 52 例与标准 10 例标出 0 例。单次约 0.8 秒，与中医半并行。
 *
 * 边界：
 *  · 只改病名这一项：采信后 primary.name 换成核对给出的名称（更宽一层、更轻一层，或「症状＋待查」），原病名留在候选与鉴别里；
 *  · 不产生新的患者事实，不参与任何安全判断；病名之后的编码、术语归一、签名照常走既有链路；
 *  · 超时、未配置、输出非法、引文不在病历里、给出的名称不合规，一律不采信（保持模型原样）；
 *  · temperature 0，按请求内容缓存，同一份病历得到同一结论。
 * 开关：CDSS_WESTERN_NAME_EVIDENCE_CHECK=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.WESTERN_NAME_EVIDENCE_CHECK_TIMEOUT_MS || 5_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 5_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

export type WesternNameCorrection = { supportedName: string; quote: string; reason: string };

// 核对给出的名称只能是一个干净的病名：不带括号、并列与推测语气（标点与语气词是写法检查）；中医证候字样由合同的同一判据
// westernLabelContainsTcmSyndrome（西医主诊断不得带证候）判定，不在这里另写一张词表。
const INVALID_SUPPORTED_NAME_FORM = /[（）()\/、，,；;：:？?]|或|可能|疑似|待排/;

/** 模型输出 → 可采信的改名（否则 undefined）。引文必须逐字在病历里；名称必须合规且与原名不同。 */
export function parseWesternNameCorrection(content: unknown, recordText: string, currentName: string): WesternNameCorrection | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { verdict, type, quote, reason, supportedName } = parsed as Record<string, unknown>;
  if (verdict !== "inconsistent" || (type !== "A" && type !== "B" && type !== "C")) return undefined;
  const name = typeof supportedName === "string" ? supportedName.trim() : "";
  const quoted = typeof quote === "string" ? quote.trim() : "";
  const why = typeof reason === "string" ? reason.trim().replace(/[。；;]+$/u, "") : "";
  if (name.length < 2 || name.length > 20 || INVALID_SUPPORTED_NAME_FORM.test(name) || westernLabelContainsTcmSyndrome(name) || /证$/.test(name) || !/[一-龥]/.test(name)) return undefined;
  if (compact(name) === compact(currentName)) return undefined;
  if (compact(quoted).length < 4 || compact(quoted).length > 60 || !compact(recordText).includes(compact(quoted))) return undefined;
  if (why.length < 4 || why.length > 60) return undefined;
  return { supportedName: name, quote: quoted, reason: why };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/**
 * 把采信的改名写进西医半的输出：主诊断换名，原病名留在候选（标明不支持它的那句病历原文）与鉴别（核对给出的理由）里。
 * 只动这三处；解析不了或没有主诊断时原样返回。
 */
export function applyWesternNameCorrection(westernContent: string, correction: WesternNameCorrection): string {
  let parsed: unknown;
  try { parsed = JSON.parse(westernContent); } catch { return westernContent; }
  const root = record(parsed);
  const western = record(root?.westernDiagnosis);
  const primary = record(western?.primary);
  const previous = typeof primary?.name === "string" ? primary.name.trim() : "";
  if (!root || !western || !primary || !previous) return westernContent;
  primary.name = correction.supportedName;
  const candidates = Array.isArray(western.candidates) ? western.candidates.filter((item): item is Json => Boolean(record(item))) : [];
  if (candidates.length > 0) {
    const others = candidates.filter((item) => item.name !== previous && item.name !== correction.supportedName);
    const lead = candidates.find((item) => item.name === previous) || candidates[0];
    western.candidates = [
      { ...lead, name: correction.supportedName },
      { name: previous, likelihood: "低", keyEvidence: [], againstEvidence: [correction.quote] },
      ...others,
    ].slice(0, 3);
  }
  const differentials = Array.isArray(western.differentials) ? western.differentials.filter((item): item is Json => Boolean(record(item))) : [];
  if (!differentials.some((item) => item.name === previous)) {
    western.differentials = [
      { name: previous, reason: "与病历记录不符", distinguishingPoints: correction.reason, nextCheck: "必要时完善相关检查" },
      ...differentials.filter((item) => item.name !== correction.supportedName),
    ].slice(0, 8);
  }
  return JSON.stringify(root);
}

export async function westernNameCorrectionForRecord(
  input: { recordText: string; diagnosisName: string; patient?: { sex?: unknown; age?: unknown } },
  signal?: AbortSignal,
): Promise<WesternNameCorrection | undefined> {
  if (!enabled() || signal?.aborted) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  const diagnosisName = input.diagnosisName.trim();
  // 已经停在症状层面的名称（「头痛待查」）没有可核对的病种。
  if (!recordText.trim() || diagnosisName.length < 2 || /待查$/.test(diagnosisName)) return undefined;
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是病历与诊断名的一致性核对器，不负责重新诊断，也不评价诊断是否最优。",
        "任务：给你一份门诊病历和系统拟定的“参考西医诊断”名称。只判断一件事：病历里**已经记录**的内容，是否与这个诊断名直接矛盾，或表明它说得过头。",
        "判 inconsistent 仅限以下三种情况：",
        "A. 该病成立时本应阳性的检验/检查，病历已经做了并记录为阴性、正常或未见（如诊断为某种感染，病历记录的病原学检查未见病原体）；或病历记录的检查所见明确指向另一个病。",
        "B. 该诊断名有定义性的必备条件，而病历已记录的事实与之相反（如诊断要求闭经或月经稀发，病历写月经周期规律；诊断的核心表现病历明确写了没有）。",
        "C. 诊断名说的是较重的一层（“功能不全”“衰竭”“剧吐”“重度”等需要特定指标或程度才成立的名称），而病历记录的指标、程度只够得上较轻的一层。",
        "以下情况一律判 consistent：相关检查没有做（没做不算矛盾）；检查只有非特异性改变、不能确诊也不能排除；门诊常见病按典型表现下的临床诊断；结果正常但该病在此阶段结果本来就可以正常（如痛风急性发作期血尿酸可以正常、冠心病静息心电图可以正常）；你只是觉得另一个诊断更可能。拿不准时判 consistent。",
        "判 inconsistent 时给出：quote（病历里与之矛盾的那句原文，逐字复制，不超过40字）、reason（一句话说明为什么不符，≤30字）和 supportedName。supportedName 只能是下面两种之一：① 比原诊断更宽一层或更轻一层、现有记录已经够得上的规范病名（如“某某储备功能减退”“妊娠呕吐”“关节炎”）；② 指不出这样的病名时写“主要症状＋待查”。不得换成病历同样没有证实的另一个具体病种，不得写比原诊断更重的名称，不带括号和解释。",
        "只输出 JSON：{\"verdict\":\"consistent|inconsistent\",\"type\":\"A|B|C|\",\"quote\":\"…\",\"reason\":\"…\",\"supportedName\":\"…\"}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: input.patient?.sex ?? null, age: input.patient?.age ?? null },
        record: recordText,
        diagnosisName,
      }),
    },
  ];
  return memoizedSmallTask<WesternNameCorrection | undefined>("western_name_evidence_check", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "western_name_evidence_check", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 220,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: parseWesternNameCorrection(content, recordText, diagnosisName), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

/** 西医半返回后的收口：核对病名，采信则改写西医半的输出；任何失败都原样返回。 */
export async function alignWesternNameWithRecord(
  westernContent: string,
  context: { recordText: string; patient?: { sex?: unknown; age?: unknown } },
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return westernContent;
  let name = "";
  try {
    name = String(record(record(record(JSON.parse(westernContent))?.westernDiagnosis)?.primary)?.name || "").trim();
  } catch {
    return westernContent;
  }
  if (!name) return westernContent;
  const correction = await westernNameCorrectionForRecord({ recordText: context.recordText, diagnosisName: name, patient: context.patient }, signal);
  console.info("[tcm-cdss:telemetry] western_name_evidence_check", { applied: Boolean(correction) });
  return correction ? applyWesternNameCorrection(westernContent, correction) : westernContent;
}

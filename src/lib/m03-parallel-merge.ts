/**
 * M03 两半并行生成的确定性合并层。
 *
 * 背景（时间专项实测）：M03 端到端 91–105s 里的主体是**输出体量**——单次生成要写完
 * 整份 reasoningV2 载荷（~7k 字符 ÷ ~80字/s），provider 吞吐已到上限，载荷字段分布平坦
 * 也没有可裁的单项。剩下的无损压缩杠杆只有并行：把载荷按语义边界切成互不依赖的两半，
 * 两路同时生成，服务端确定性合并后走**完全不变**的既有契约/复核/签名链路。
 *
 * 切分原则（为什么是这两半）：
 *  · 中医半 = overview + pathogenesis + therapy + formula + nonPharma + lineageAdaptation。
 *    这些字段之间存在**契约级一致性检查**（pathogenesis.summary 只能归纳主证候/病机链已
 *    成立的内容、locationDifferentiation 与病机链病位联动、subTherapies 逐节点对应），
 *    必须出自同一次采样才能保持连贯，不可再拆。
 *  · 西医半 = westernDiagnosis + management。西医支持事实/鉴别与中医辨证之间没有
 *    跨半契约检查；两半读同一份病例资料，由合并后的全量确定性契约统一核验。
 *
 * 失败语义（不引入新的失败类）：
 *  · 西医半不可用 → 合并结果缺 westernDiagnosis → 归一时落 DEFAULT_WESTERN_DIAGNOSIS 占位，
 *    western_support_empty 属 T2，只加一条「西医诊断依据边界」批注、**不会**触发重生成
 *    （2026-08 之后的处置信条；这里原先写的「走全量重生成修复轮」早已不成立）。
 *    页面因此显示「当前未形成可复核的西医工作诊断」——所以西医半能救回来就必须救回来，
 *    见 parseWithPrematureCloseRecovery / relocateMisplacedWesternFields；
 *  · 中医半不可解析 → 合并放弃（返回 undefined），调用方保留原始输出走既有截断/挽救路径。
 *  两条路都收敛到今天已存在、已测试的出口，并行层自身不产生新的终态。
 */

const TCM_HALF_FIELDS = ["overview", "pathogenesis", "therapy", "formula", "nonPharma", "lineageAdaptation"] as const;
const WESTERN_HALF_FIELDS = ["westernDiagnosis", "management"] as const;

/** 运维回退开关：M03_PARALLEL_GENERATION=false 恢复单发全量生成，其余任何值默认并行。 */
export function m03ParallelGenerationEnabled(): boolean {
  return (process.env.M03_PARALLEL_GENERATION || "true").trim().toLowerCase() !== "false";
}

/**
 * 两半共用同一份完整固定规范前缀（与单发提示词逐字一致，三方共享 provider 前缀缓存），
 * 只在末尾追加本段分工限制。规范前缀里"必须输出完整对象"的要求由这里显式豁免，
 * 否则模型会在两难指令下随机选边。
 */
export function buildM03ParallelHalfSuffix(half: "western" | "tcm"): string {
  const serverOwned = "schemaVersion、stage、formula、nonPharma、pathogenesis.summary 及各层 evidence 均由服务端生成，本次不得输出；仅填写本半 JSON Schema 中保留的临床字段。";
  if (half === "western") {
    return [
      "【并行分工·西医半】本次请求是 M03 并行分工中的西医半。仅应用上文西医诊断、鉴别与管理规则，只输出一个顶层仅含以下字段的 JSON 对象：westernDiagnosis、management。",
      serverOwned,
      "overview、pathogenesis、therapy、lineageAdaptation 由并行进程负责——本次省略这些字段不违反上文完整性要求，也不得以任何形式输出它们。",
      "westernDiagnosis 与 management 的全部既有规则不变；management.mustCollect 仍从全案角度给出补录项。JSON 右花括号必须是回复最后一个非空内容。",
    ].join("");
  }
  return [
    "【并行分工·中医半】本次请求是 M03 并行分工中的中医半。仅应用上文中医辨病辨证、病机与治法规则，只输出一个顶层仅含以下字段的 JSON 对象：overview、pathogenesis、therapy、lineageAdaptation。",
    serverOwned,
    "westernDiagnosis 与 management 由并行进程负责——本次省略这两个字段不违反上文完整性要求，也不得以任何形式输出它们。",
    "pathogenesis.chain 必须至少有 1 个完整节点；每个节点的 patientFact 和 syndromeEvidence 都必须各自从上方患者事实边界中逐字复制一段连续原文，不得改写、拼接或把推理句写进这两列。",
    "已含字段的全部既有规则不变。JSON 右花括号必须是回复最后一个非空内容。",
  ].join("");
}

function tryParseObject(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** 从首个 `{` 起做字符串/转义感知的括号计深，返回顶层对象闭合处的下标；找不到返回 -1。 */
function firstTopLevelObjectEnd(text: string): number {
  const start = text.indexOf("{");
  if (start < 0) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return char === "}" ? index : -1;
    }
  }
  return -1;
}

/**
 * 顶层对象被**提前闭合**、随后又以 `,"字段":…` 接着写的结构修复。
 *
 * 实测（2026-09-19，DeepSeek json_object 模式）：西医半本机 6/6、线上 3/3 全是这一形态——
 * 模型写到 primary.limitations 就闭合了 primary，接着写完 differentials / candidates，把漏写的
 * suggestedChecks / guidelineRefs 补在外层，再多写一个右花括号把顶层闭合，最后接着输出
 * `,"management":{…}}`：
 *   {"westernDiagnosis":{…},"suggestedChecks":[…],"guidelineRefs":[…]},"management":{…}}
 * JSON.parse 报 Extra data，整个西医半此前被静默丢弃，签名载荷落默认占位——而同一次生成
 * 推给页面的草稿里分明写着「急性上呼吸道感染」。json_object 只保证「像 JSON」，不保证合法。
 *
 * 只做一件事：删掉**紧跟着逗号与下一个键**的那个提前闭合的右花括号。不补字段、不改内容、
 * 不猜截断；删完仍不能解析就放弃，维持原有的缺席语义。字段层级的归位另见
 * relocateMisplacedWesternFields。
 */
function parseWithPrematureCloseRecovery(text: string): Record<string, unknown> | undefined {
  let candidate = text;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const close = firstTopLevelObjectEnd(candidate);
    if (close < 0) return undefined;
    const rest = candidate.slice(close + 1);
    if (!/^\s*,\s*"/.test(rest)) return undefined;
    candidate = candidate.slice(0, close) + rest;
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

type ExtractedHalf = { value: Record<string, unknown>; recovered: boolean };

function extractJsonObject(raw: string | undefined): ExtractedHalf | undefined {
  if (!raw) return undefined;
  let text = raw;
  // 半区被要求不输出 sentinel/围栏，但解析层对不听话的输出保持宽容——严格性由下游契约负责。
  const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
  const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
  const sentinelStart = text.lastIndexOf(startMarker);
  if (sentinelStart >= 0) {
    const sentinelEnd = text.indexOf(endMarker, sentinelStart + startMarker.length);
    if (sentinelEnd > sentinelStart) text = text.slice(sentinelStart + startMarker.length, sentinelEnd);
  }
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const direct = tryParseObject(text);
  if (direct) return { value: direct, recovered: false };
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  const sliced = text.slice(first, last + 1);
  const wrapped = tryParseObject(sliced);
  if (wrapped) return { value: wrapped, recovered: false };
  const recovered = parseWithPrematureCloseRecovery(sliced);
  return recovered ? { value: recovered, recovered: true } : undefined;
}

/**
 * 西医半 schema 里，下面这些键名各自只有**唯一**的合法位置，所以写错层级时归位没有歧义。
 * 刻意不收 name / status / confidence：differentials、candidates 里也有 name，顶层出现时
 * 无法确定它属于谁。
 */
const WESTERN_PRIMARY_OWNED_KEYS = [
  "supportingFacts", "supportingFactKinds", "clinicalRationale", "limitations", "suggestedChecks", "guidelineRefs",
] as const;
const WESTERN_DIAGNOSIS_OWNED_KEYS = ["differentials", "candidates"] as const;
const MANAGEMENT_OWNED_KEYS = ["redFlagLoop", "mustCollect", "followupSafetyNet"] as const;

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * 与提前闭合同一次生成里，模型把本属 westernDiagnosis.primary 的 suggestedChecks /
 * guidelineRefs 写到了顶层（见 parseWithPrematureCloseRecovery 的实测形态）。
 * 目标位置已有同名字段时不覆盖——写在正确位置的值优先；primary 不存在时不凭空造一个
 * （只有 suggestedChecks 的 primary 不是诊断）。归位后的内容与模型直接写对位置时一样，
 * 照常走接地、证据反查与全部契约。返回实际挪动过的字段路径，供遥测记账。
 */
function relocateMisplacedWesternFields(half: Record<string, unknown>): string[] {
  const moved: string[] = [];
  const westernDiagnosis = plainRecord(half.westernDiagnosis);
  const primary = plainRecord(westernDiagnosis?.primary);
  const relocate = (keys: readonly string[], target: Record<string, unknown> | undefined, path: string) => {
    if (!target) return;
    for (const key of keys) {
      if (half[key] === undefined) continue;
      if (target[key] === undefined) {
        target[key] = half[key];
        moved.push(`${path}.${key}`);
      }
      delete half[key];
    }
  };
  relocate(WESTERN_PRIMARY_OWNED_KEYS, primary, "westernDiagnosis.primary");
  relocate(WESTERN_DIAGNOSIS_OWNED_KEYS, westernDiagnosis, "westernDiagnosis");
  if (MANAGEMENT_OWNED_KEYS.some((key) => half[key] !== undefined) && half.management === undefined) {
    half.management = {};
  }
  relocate(MANAGEMENT_OWNED_KEYS, plainRecord(half.management), "management");
  return moved;
}

export type M03WesternHalfParse = {
  /** absent：没有西医半文本；clean：原样可解析；recovered：经结构修复或字段归位才可用；unparseable：救不回来。 */
  status: "absent" | "clean" | "recovered" | "unparseable";
  relocatedFields: string[];
  value?: Record<string, unknown>;
};

/**
 * 西医半的唯一解析入口：合并与遥测共用，保证「日志说解析成功」与「合并真的用上了」是同一件事。
 * 此前遥测只记 merged（= 中医半可解析），西医半被整段丢弃时照样记 merged:true——
 * 9/11 西医半换成 DeepSeek 之后实测 9/9 次采样都丢了西医诊断，日志上看不出任何异常。
 */
export function parseM03WesternHalf(westernRaw: string | undefined): M03WesternHalfParse {
  if (!westernRaw || !westernRaw.trim()) return { status: "absent", relocatedFields: [] };
  const extracted = extractJsonObject(westernRaw);
  if (!extracted) return { status: "unparseable", relocatedFields: [] };
  const relocatedFields = relocateMisplacedWesternFields(extracted.value);
  const usable = WESTERN_HALF_FIELDS.some((field) => extracted.value[field] !== undefined);
  if (!usable) return { status: "unparseable", relocatedFields };
  return {
    status: extracted.recovered || relocatedFields.length > 0 ? "recovered" : "clean",
    relocatedFields,
    value: extracted.value,
  };
}

/**
 * 合并两半为一份完整 reasoningV2 JSON 字符串（未包 sentinel——由既有 wrap 层统一处理）。
 *
 * 字段归属是硬边界：每半只贡献自己名下的字段，越界输出被忽略，杜绝"两半都写了 overview、
 * 采样不一致"的分脑。唯一例外：西医半不可用而中医半（不听话地）带出了合法 westernDiagnosis/
 * management 时，采用中医半的版本——那是一次连贯单模型输出，等价于今天的单发合同，
 * 可以省掉一轮全量重生成；同样的下游校验一字不落地跑。
 */
export function mergeParallelM03Halves(tcmRaw: string, westernRaw: string | undefined): string | undefined {
  const tcm = extractJsonObject(tcmRaw)?.value;
  if (!tcm) return undefined;
  const western = parseM03WesternHalf(westernRaw).value;
  const merged: Record<string, unknown> = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
  };
  for (const field of TCM_HALF_FIELDS) {
    if (tcm[field] !== undefined) merged[field] = tcm[field];
  }
  // M03 合同恒为 formula: null / nonPharma: null；半区偶发漏写时补上确定性常量，
  // 不把"漏写常量"放大成一轮契约修复。
  merged.formula = null;
  if (merged.nonPharma === undefined) merged.nonPharma = null;
  for (const field of WESTERN_HALF_FIELDS) {
    if (western && western[field] !== undefined) merged[field] = western[field];
    else if (tcm[field] !== undefined) merged[field] = tcm[field];
  }
  return JSON.stringify(merged);
}

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
 *    跨半契约检查；两半读同一份病例资料，粗粒度矛盾由合并后的独立临床复核兜底。
 *
 * 失败语义（不引入新的失败类）：
 *  · 西医半不可用 → 合并结果缺 westernDiagnosis → 既有确定性契约命中 western_support_empty
 *    → 走既有的全量重生成修复轮（用完整单发提示词），受修复账本与编排时限约束；
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
  if (half === "western") {
    return [
      "【并行分工·西医半】本次请求是 M03 并行分工中的西医半。仍按上文全部规范完成推理，但只输出一个顶层仅含以下字段的 JSON 对象：schemaVersion、stage、westernDiagnosis、management。",
      "overview、pathogenesis、therapy、formula、nonPharma、lineageAdaptation 由并行进程负责——本次省略这些字段不违反上文完整性要求，也不得以任何形式输出它们。",
      "westernDiagnosis 与 management 的全部既有规则不变；management.mustCollect 仍从全案角度给出补录项。JSON 右花括号必须是回复最后一个非空内容。",
    ].join("");
  }
  return [
    "【并行分工·中医半】本次请求是 M03 并行分工中的中医半。仍按上文全部规范完成推理，但只输出一个顶层仅含以下字段的 JSON 对象：schemaVersion、stage、overview、pathogenesis、therapy、formula、nonPharma、lineageAdaptation。",
    "westernDiagnosis 与 management 由并行进程负责——本次省略这两个字段不违反上文完整性要求，也不得以任何形式输出它们。",
    "pathogenesis.chain 必须至少有 1 个完整节点；每个节点的 patientFact 和 syndromeEvidence 都必须各自从上方患者事实边界中逐字复制一段连续原文，不得改写、拼接或把推理句写进这两列。",
    "已含字段的全部既有规则不变。JSON 右花括号必须是回复最后一个非空内容。",
  ].join("");
}

function extractJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
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
  const tryParse = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return tryParse(text.slice(first, last + 1));
  return undefined;
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
  const tcm = extractJsonObject(tcmRaw);
  if (!tcm) return undefined;
  const western = extractJsonObject(westernRaw);
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

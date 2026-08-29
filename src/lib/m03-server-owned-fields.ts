/**
 * M03 服务端自有字段的确定性补全（P2）。
 *
 * 立项依据（2026-08-29 token 审计，逐字段复证过消费方）：M03 输出合同里有一批字段，
 * 模型生成之后**要么被服务端无条件覆盖，要么根本到不了医生面前**：
 *
 *  · `schemaVersion` / `stage`         —— 服务端常量，合并层本就强制写死；
 *  · `formula` / `nonPharma`           —— M03 合同恒为 null（M04 的同名字段另有实义，不受影响）；
 *  · 各处 `evidence{}`                 —— 模板预填 `model_inference`/`病例内推理`，而呈现层第一个
 *                                         排除的就是 model_inference。归档量化 2280 条里 2177 条
 *                                         (95.5%) 是这个值，「指南/文献依据」一栏自诞生起产出 0 条
 *                                         （见 diagnosis-visible-summary 里那段注释）；
 *  · `lineageAdaptation` 的常量子字段  —— 提示词把服务端卡值喂进去、再让模型原样抄回来。
 *
 * 做法与 M04 已经验证过的模式一致（M04 提示词开篇即写「模型只提交需要临床生成的最小提案」）：
 * **模型不再输出这些字段，服务端在校验与签名之前确定性补齐**。因此下游合同、签名载荷、
 * HIS 出口和页面投影的形状逐字不变，只有模型的输出变短——解码时间跟着变短。
 *
 * 三条不变量：
 *  1. **只补不改**：任何字段只在缺失/非法时填充，绝不覆盖模型给出的有效值。模型若真的引到了
 *     外部证据，那条 evidence 必须原样保留。
 *  2. **幂等**：重复应用是不动点（test:m03-prepare-idempotence 会验）。
 *  3. **不产生临床结论**：填的全是常量或既有服务端投影，不新增病位、病性、治法或诊断。
 */

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** 提示词模板此前教模型逐字填写的那份默认证据引用。保持逐字一致，下游读数不变。 */
const MODEL_INFERENCE_EVIDENCE = Object.freeze({
  evidenceLevel: "model_inference",
  source: "病例内推理",
  confidence: "中",
});

/** 病位/病性两处的模板默认值与其余各处不同（source 更具体），同样保持逐字一致。 */
const DIFFERENTIATION_EVIDENCE = Object.freeze({
  evidenceLevel: "model_inference",
  source: "本例四诊与病史推断",
  confidence: "中",
});

const CHAIN_EVIDENCE = Object.freeze({
  evidenceLevel: "model_inference",
  source: "本例资料",
  confidence: "中",
});

export type ServerOwnedLineageFields = Readonly<{
  code: string;
  label: string;
  applicable: string;
  safetyDeference: string;
  unaffectedBySafety: readonly string[];
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => { const entry = record(item); return entry ? [entry] : []; })
    : [];
}

/** 缺失或不是对象时才填；模型给出的有效证据引用一律保留。 */
function fillEvidence(host: Record<string, unknown> | undefined, fallback: Readonly<Record<string, unknown>>): void {
  if (!host) return;
  const existing = record(host.evidence);
  if (existing && typeof existing.evidenceLevel === "string" && existing.evidenceLevel.trim()) return;
  host.evidence = { ...fallback };
}

/**
 * 在结构化 JSON 上补齐服务端自有字段。传入的是完整流式内容（含 sentinel），
 * 与其余确定性变换同形，便于插进既有的 phase 链。
 */
export function applyServerOwnedM03Fields(content: string, lineage?: ServerOwnedLineageFields): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  let reasoning: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as unknown;
    const asRecord = record(parsed);
    if (!asRecord) return content;
    reasoning = asRecord;
  } catch {
    // 解析不了就原样返回：结构化修复层有自己的职责，这里不抢它的活。
    return content;
  }
  // 只处理 M03。stage 缺失时也要能补，所以不能用 stage 判断是否本阶段——
  // 由调用方保证只在 diagnose 链上调用，这里只做「不是 prescribe」的防御。
  if (typeof reasoning.stage === "string" && reasoning.stage !== "diagnose") return content;

  const before = JSON.stringify(reasoning);

  reasoning.schemaVersion = "tcm-cdss-reasoning-v2";
  reasoning.stage = "diagnose";
  // M03 合同恒为 null。M04 的 formula/nonPharma 是另一回事，不经过本函数。
  reasoning.formula = null;
  if (reasoning.nonPharma === undefined) reasoning.nonPharma = null;

  const overview = record(reasoning.overview);
  fillEvidence(overview, MODEL_INFERENCE_EVIDENCE);

  const western = record(reasoning.westernDiagnosis);
  fillEvidence(record(western?.primary), MODEL_INFERENCE_EVIDENCE);

  const pathogenesis = record(reasoning.pathogenesis);
  if (pathogenesis) {
    fillEvidence(record(pathogenesis.locationDifferentiation), DIFFERENTIATION_EVIDENCE);
    fillEvidence(record(pathogenesis.natureDifferentiation), DIFFERENTIATION_EVIDENCE);
    for (const node of list(pathogenesis.chain)) fillEvidence(node, CHAIN_EVIDENCE);
  }

  for (const sub of list(record(reasoning.therapy)?.subTherapies)) fillEvidence(sub, CHAIN_EVIDENCE);

  if (lineage) {
    const adaptation = record(reasoning.lineageAdaptation);
    if (adaptation) {
      // 这五项此前是「提示词把服务端卡值喂进去、模型原样抄回来」。直接由服务端写定，
      // 模型抄错或漏抄都不再可能。applicabilityReason 与 influencedDecisions 是模型
      // 真正需要判断的内容，不在此列、原样保留。
      adaptation.schemaVersion = "tcm-cdss-reasoning-v2";
      adaptation.lineageCode = lineage.code;
      adaptation.label = lineage.label;
      adaptation.applicable = lineage.applicable;
      adaptation.safetyDeference = lineage.safetyDeference;
      adaptation.unaffectedBySafety = [...lineage.unaffectedBySafety];
    }
  }

  if (JSON.stringify(reasoning) === before) return content;
  return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
}

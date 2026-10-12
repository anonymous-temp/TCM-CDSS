/**
 * M04 中成药/西药行的说明书字段由服务端按 evidenceId 补齐（2026-10-12 输出瘦身）。
 *
 * 为什么：模型原先在每一行里逐字抄写说明书的药名、规格、用法、禁忌/相互作用和 64 位条目指纹，
 * 15 例实测占 M04 写出量的 29%（约 680 token、4 秒）。这些内容服务端手里本来就有——它们就是
 * 提示词里注入的那几条说明书记录——规划器选中的行还会被服务端整行覆盖。现在模型每行只写
 * type / evidenceId / correspondingProblem / positioning，其余字段从**模型看到的同一条记录**补齐。
 *
 * 记录来源是本次 M04 提示词本身（不是另取一份检索结果）：模型只能选它看到的条目，
 * 预算压缩时被截掉的条目它选不到，这里也补不出来——两边天然一致。
 * 记录行格式见 local-patent-medicine-candidates.ts（LOCAL-INST）与 evimed-guide.ts 的
 * formatInstructionEvidenceRecord（EVID-INST）：一条一行，`[ID] 标签：值｜标签：值｜…｜条目指纹：sha256:…`。
 * 没有条目指纹的行不进池：无法与说明书条目绑定的药不能出现在候选里。
 *
 * 补出的行仍要过既有的说明书绑定校验（evidence-source-validation 的 medicineEvidenceBindingValid：
 * 指纹、药名、规格在同一条目内，对应问题落在适应证段内）和病历核验，门槛一处都没放松。
 */
import type { EvidenceBoundMedicineProposal } from "./m04-proposal-compiler";
import { parseMedicationLabelUsage } from "./medication-label-usage";

export type InstructionRecordPool = ReadonlyMap<string, EvidenceBoundMedicineProposal>;

const RECORD_LINE = /\[((?:EVID|LOCAL)-INST-\d{3})\]\s*(.+)$/;
const FALLBACK_RISK_NOTE = "采用前核对完整说明书禁忌、注意事项、特殊人群和相互作用。";

function compact(value: string | undefined, max: number): string {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function recordFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of body.split("｜")) {
    const match = part.match(/^\s*([^：:]{1,12})[：:]\s*([\s\S]*)$/);
    if (!match) continue;
    const label = match[1].trim();
    if (!fields.has(label)) fields.set(label, match[2].trim());
  }
  return fields;
}

/** 从提示词文本解析模型可选的全部说明书条目。同一 ID 出现多次时取第一次（与模型读到的顺序一致）。 */
export function instructionRecordPoolFromText(text: string): InstructionRecordPool {
  const pool = new Map<string, EvidenceBoundMedicineProposal>();
  for (const line of text.split("\n")) {
    const match = line.match(RECORD_LINE);
    if (!match) continue;
    const [, evidenceId, body] = match;
    if (pool.has(evidenceId)) continue;
    const fields = recordFields(body);
    const fingerprint = (fields.get("条目指纹") || "").match(/^sha256:[a-f0-9]{64}/)?.[0];
    const name = compact(fields.get("药名"), 300);
    if (!fingerprint || !name) continue;
    const local = evidenceId.startsWith("LOCAL-INST-");
    const usage = parseMedicationLabelUsage(fields.get("用法") || fields.get("用法用量"));
    const risk = compact([fields.get("禁忌/注意"), fields.get("特殊人群"), fields.get("相互作用")]
      .filter((value): value is string => Boolean(value && value.trim())).join("；"), 800);
    pool.set(evidenceId, {
      // LOCAL-INST 只收中成药；EVID-INST 两类都有，以模型写的 type 为准（见 fillMedicineRowFromInstructionRecord）。
      type: local ? "中成药" : "西药",
      name,
      specification: compact(fields.get("规格"), 300) || null,
      singleDose: usage.singleDose || null,
      frequency: usage.frequency || null,
      route: usage.route || null,
      administrationTiming: usage.administrationTiming || null,
      usageBoundary: local
        ? "说明书用法字段已与本候选的说明书条目及指纹绑定。"
        : "说明书用法字段已与本候选的说明书条目及指纹绑定；本候选仍为医生讨论项。",
      course: usage.course || null,
      positioning: "需医生评估",
      correspondingProblem: compact(fields.get("本例命中") || fields.get("适应证"), 100) || name,
      evidenceId,
      evidenceFingerprint: fingerprint,
      relationship: local
        ? "与中药饮片方案不默认联用，由医生结合重复功效、相互作用和治疗目标择一或评估联用。"
        : "是否与当前中药饮片方案联用或替代，须由医生结合完整用药史和治疗目标决定。",
      riskNote: risk || FALLBACK_RISK_NOTE,
    });
  }
  return pool;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 模型行 → 完整行。说明书字段一律取池中记录（即使模型照旧写了也以记录为准）；模型只决定
 * 类别、对应本例什么问题和定位。池里没有该 ID 时原样返回，交给既有校验（多半因缺字段或绑定不上被删）。
 */
export function fillMedicineRowFromInstructionRecord(
  raw: Record<string, unknown>,
  pool: InstructionRecordPool | undefined,
): Record<string, unknown> {
  const evidenceId = text(raw.evidenceId);
  const record = pool && evidenceId ? pool.get(evidenceId) : undefined;
  if (!record) return raw;
  // type / positioning 的取值合法性由下游 PatentAndWesternProposalSchema 判（非严格入口已先删掉枚举越界的行），
  // 这里不再手写一份枚举。
  return {
    ...record,
    type: text(raw.type) || record.type,
    positioning: text(raw.positioning) || record.positioning,
    correspondingProblem: text(raw.correspondingProblem) || record.correspondingProblem,
  };
}

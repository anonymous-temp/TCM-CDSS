import signs from "../data/tcm-true-heart-pain-signs.source.json" with { type: "json" };
import { recordMentionPolarityAt } from "./diagnosis-safety";

/**
 * 真心痛排在选病首位（2026-11-11 第四十二轮）。教材里真心痛原本没有成节的证型行，选病闭集里只有胸痹，
 * 线上盲评 new40 m39（压榨样胸痛持续不缓解、大汗淋漓、皮肤湿冷）诊成胸痹，评审评为错。现在《中西医结合内科学》心肌梗死节的七个证型
 * 补进教材补充表（tcm-textbook-syndrome-supplement.source.json）；这里判什么时候把它排在候选最前、并给辨证半一段说明。
 * 判据三组写法都在 tcm-true-heart-pain-signs.source.json（逐条出自教材原句）：胸痛 + 持续不缓解 + 汗出肢冷一类危候，各至少一处是本人的、
 * 未被否认的记载；另外安全门的确定性红旗里要有急性心血管事件那一条（调用方传入）。只排序与提示，病名仍由辨证半判。
 */
export const TRUE_HEART_PAIN_DISEASE = "真心痛";
const SIGNS = signs as { chestPain: string[]; persistence: string[]; collapseSigns: string[]; cardiacRedFlagCues: string[] };

function affirmedTerm(text: string, terms: readonly string[]): string | undefined {
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      if (recordMentionPolarityAt(text, at) === "affirmed") return term;
      from = at + term.length;
    }
  }
  return undefined;
}

export type TrueHeartPainSignal = { chestPain: string; persistence: string; collapse: string };

export function trueHeartPainSignal(recordText: string, gateRedFlags: readonly string[]): TrueHeartPainSignal | undefined {
  if (!gateRedFlags.some((flag) => SIGNS.cardiacRedFlagCues.some((cue) => flag.includes(cue)))) return undefined;
  const text = String(recordText || "").normalize("NFKC");
  const chestPain = affirmedTerm(text, SIGNS.chestPain);
  const persistence = chestPain ? affirmedTerm(text, SIGNS.persistence) : undefined;
  const collapse = persistence ? affirmedTerm(text, SIGNS.collapseSigns) : undefined;
  return chestPain && persistence && collapse ? { chestPain, persistence, collapse } : undefined;
}

/** 选病结果里把真心痛排在最前（选病落空时不补，与既往确诊病同一规矩）。 */
export function withTrueHeartPainFirst(picks: readonly string[], signal: TrueHeartPainSignal | undefined): string[] {
  if (!signal || picks.length === 0) return [...picks];
  return [TRUE_HEART_PAIN_DISEASE, ...picks.filter((pick) => pick !== TRUE_HEART_PAIN_DISEASE)];
}

/** 辨证半提示词里的说明段；没有信号时为空串。 */
export function trueHeartPainNotice(signal: TrueHeartPainSignal | undefined): string {
  if (!signal) return "";
  return [
    "",
    "【真心痛与胸痹】",
    `病历记载「${signal.chestPain}」「${signal.persistence}」「${signal.collapse}」：胸痛持续不缓解并见汗出肢冷、面白唇紫一类危候，教材称真心痛（胸痹的进一步发展，危重急症），按真心痛辨病辨证；胸闷胸痛反复发作、持续几秒到几十分钟、休息或用药后可缓解的才辨为胸痹。`,
  ].join("\n");
}

export function buildM04ClinicalRepairHint(reason = ""): string {
  if (/^m04_formula_(?:reference_declassified|compilation_composition_drift)$/.test(reason)) {
    return [
      "本次失败是命名方的实际组成不足，不是方名字符串格式问题。",
      "从 M03锁定上下文选择对应 governedFormulaBaselines，candidate.name 必须显式沿用所选方名；candidate.herbs 先逐项、不重不漏地纳入该基准 ingredients 的全部药味，再考虑本例加味。",
      "每个基准药味都要独立输出一行合法的 dose、role、targetKind/targetRef和 structureRole；其中必须恰有 1–2 味君药，且每味君药都用 targetKind=pathogenesis_node、targetRef=P1 直接承担中心治法。不得用同义功效药代替，不得因“加减”省略任一基准药味，也不得按药味顺序机械指定君药。",
      "这是组成恢复阶段：不允许改称本例辨证组方、自拟方或退回低于身份下限的组成。",
    ].join("\n");
  }
  if (/^m04_candidate_\d+_(?:emperor_missing|emperor_excess|herb_\d+_emperor_not_primary)$/.test(reason)) {
    return [
      "本次失败是候选方君药数量或 P1 归属不合法，不能通过改方名、删减基准药味或按药味顺序机械指定角色规避。",
      "保持已通过校验的实际药味、剂量和命名方组成不变，重新依据本例 P1 核心病机分配君臣佐使。",
      "整个 candidate.herbs 必须恰有 1–2 味君药，至少 1 味且不得超过 2 味；每味君药都必须使用 targetKind=pathogenesis_node、targetRef=P1，并在 prescriptionRole 中说明其如何直接承担 P1 中心治法。",
      "其余药味只能按已成立的 P 节点或受控方内结构作用分配为臣、佐、使；不得新增患者事实、药味或病机节点。",
    ].join("\n");
  }
  if (/^m04_(?:clinical|formula_composition|herb_plan|dose_rationale|patient_context)_semantic_review$/.test(reason)) {
    const focus = reason === "m04_formula_composition_semantic_review"
      ? "本次只修复命名方组成：按 M03 锁定的 governedFormulaBaselines 保留必需锚点和最低组成数，逐味给出保守剂量；不得只改方名，也不得用自拟方绕过命名方合同。"
      : reason === "m04_herb_plan_semantic_review"
        ? "本次只修复方药-病机匹配与君臣佐使：删除不服务于已成立 P 节点的药味；整个候选必须恰有 1–2 味君药，且每味君药都直接承担 P1 中心治法，不能用通用补益/调和药或药味顺序机械决定君药。"
        : reason === "m04_dose_rationale_semantic_review"
          ? "本次只修复剂量强度：在每味 ingredientDoseBoundaries 内选择与年龄、证候强度和药物角色相称的保守剂量，不得改写患者事实或用区间/待定值。"
          : reason === "m04_patient_context_semantic_review"
            ? "本次只修复患者上下文依赖：不得依赖未成立、已否认或仅属未知的生理状态、用药、过敏和肝肾功能前提；存在更安全路径时改用对未知状态鲁棒的组方。"
            : "请优先修正独立复核指出的最关键临床不一致。";
    return [
      "独立中药候选复核认为当前方药与已签名 M03 或患者事实存在语义不一致。",
      focus,
      "请重新逐味核对实际药味、剂量、君臣佐使和病机引用：每味药都必须服务于 M03 已成立的证候/病机/治法，不能借用患者未提供、明确否认、仅在不确定项或条件句中的表现来证明必要性。",
      "沿用命名方时必须保留其核心组成和方义；若当前病机不需要某个加味则删除，若实际组成已失去原方核心结构则改为本例辨证组方，不得只保留方名。剂量须与本例证候强度、年龄和已知安全信息相称。",
      "只修复 M04 最小提案，不得改写 M03 或新增患者事实；常规配伍禁忌和相互作用仍交由后续独立审方提示。",
    ].join("\n");
  }
  return "";
}

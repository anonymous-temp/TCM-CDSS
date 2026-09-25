export type TransparentFormulaFallbackInput = {
  completedRepairAttempts: number;
  /**
   * 修复机会已被证明用尽：同一条提示重复注入（fixpoint 早退）或编排总时限触顶。
   * 与「完成一轮 provider 修复」在语义上等价——都表示再给模型一轮也改变不了结果。
   */
  repairExhausted?: boolean;
  /** Exact current candidate has no remaining T2/T3 repair budget and passed the full hard floor. */
  qualityRepairExhaustedForCandidate?: boolean;
  strictFormulaIssue?: string;
  therapyIssue?: string;
  requestAborted: boolean;
};

export type M04RepairState = {
  completedAttempts: number;
  requestAborted: boolean;
};

export type M04RepairOutcome = {
  ok: boolean;
  finishReason?: string | null;
  requestAborted?: boolean;
};

export function initialM04RepairState(): M04RepairState {
  return { completedAttempts: 0, requestAborted: false };
}

export function advanceM04RepairState(state: M04RepairState, outcome: M04RepairOutcome): M04RepairState {
  return {
    completedAttempts: state.completedAttempts + (outcome.ok && outcome.finishReason === "stop" ? 1 : 0),
    requestAborted: state.requestAborted || outcome.requestAborted === true,
  };
}

/**
 * A classic identity may be removed only after one completed targeted provider repair and only
 * when the remaining defect is that identity itself. A second model retry adds long-tail latency
 * without improving a composition that has already passed independent herb-therapy, dose and risk
 * contracts. Network failures, cancelled requests, clinical incompatibility and every other
 * contract failure keep the prescription in the retry state.
 *
 * 调用方在判定前已确定性剥离方剂身份，并用剥离后的内容重跑严格合同，因此 strictFormulaIssue
 * 为空即代表「以自拟方形态自证合格」。此前这里只认 formula_reference_declassified 一个码，
 * 而模型保留方名时剩余缺陷叫 formula_compilation_composition_drift ——同一件事（这张方不能
 * 继承该经典身份）的另一种写法，却让整方作废：实测麻黄汤 4 味小方被加到 9 味即 0 味出方，
 * 而方中每一味的剂量、配伍、君臣与病机引用都是通过的。
 */
/**
 * 修复耗尽后该不该受理这条治法码。
 *
 * **默认拒绝 + 质量族白名单**，不是「不匹配就放行」。
 * 我第一版写成了默认放行，被 test:m04-safety-contract 当场拦下：剂量码 herb_6_dose
 * 不在排除列表里，于是被放行——那正是 fail-open 的形状。本仓库 rejection-tier 的注释
 * 早写过同一条：「未分类 → T1。这是安全默认值，不要改成 T2。」
 *
 * 白名单里的都是**本系统词表能力边界**，不是这张方有临床错误（甲方 2026-08-08 定：质量不阻断）：
 *   · transparent_therapy_coverage / herb_support —— 治法方向覆盖率阈值
 *   · transparent_therapy_herb_knowledge_missing —— 药味功效词表未收载
 *   · herb_N_emperor_therapy_mismatch / emperor_knowledge_missing —— 君药方向对不上/查不到功效
 *   · pathogenesis_node_uncovered_Pn —— M03 某病机方向本次没有对应药味
 * 白名单之外一律拒绝，包括：结构缺失（contract_missing / herbs_missing / unresolved）、
 * 方向对立（unsupported_high_impact_*，调用方按 waive=true 算码时剩下的必然是对立）、
 * 以及任何剂量/配伍/特殊人群类码。
 */
const ACCEPTABLE_M04_THERAPY_FAMILIES: readonly RegExp[] = [
  /^transparent_therapy_(?:coverage|herb_support|herb_knowledge_missing)$/,
  /^herb_\d+_emperor_(?:therapy_mismatch|knowledge_missing)$/,
  /^pathogenesis_node_uncovered_[A-Za-z0-9]+$/,
  /^therapy_direction_uncovered_[a-z_]+$/,
];

export function isAcceptableM04TherapyIssue(therapyIssue: string | undefined): boolean {
  if (typeof therapyIssue !== "string" || !therapyIssue) return true;
  const core = therapyIssue
    .replace(/^m04_/, "")
    .replace(/^candidate_\d+_/, "")
    .replace(/^modification_\d+_/, "")
    .replace(/^transparent_therapy_(?=herb_\d)/, "");
  return ACCEPTABLE_M04_THERAPY_FAMILIES.some((pattern) => pattern.test(core));
}

export function canAcceptTransparentFormulaFallback(input: TransparentFormulaFallbackInput): boolean {
  // A locked classic identity is never transferred to a composition that failed its governed
  // baseline. After repair exhaustion the caller strips that identity, records which M03 formula
  // was declassified for the visible cross-stage explanation, then re-runs every hard prescription
  // and formula contract on the self-devised candidate. This preserves the
  // clinical plan without falsely presenting it as the named formula; before repair exhaustion the
  // same path remains unavailable.
  // 「完成一轮修复」与「修复已被证明无效」是同一个前提的两种到达方式。此前只认前者，于是
  // fixpoint 早退（同一提示重复注入）反而拿不到降级资格：fixpoint 的语义正是「再修也是同一张
  // 失败彩票」，却因为跳过了那一轮而不算「完成」，整方随即作废。实测胃痛-肝气犯胃：
  // 柴胡疏肝散 7/7 组成达标、fixpoint 早退、无降级、0 味；同一轮里恰好先完成过一轮修复的
  // 麻黄汤与清胃散则正常降级出方——差别只在到达方式，不在候选质量。
  return (input.completedRepairAttempts >= 1 || input.repairExhausted === true || input.qualityRepairExhaustedForCandidate === true) &&
    !input.requestAborted &&
    (input.strictFormulaIssue === undefined || input.strictFormulaIssue === "" ||
      input.strictFormulaIssue === "formula_reference_declassified") &&
    // 治法侧：**质量类一律受理**（甲方 2026-08-08）。调用方已按 waive=true 口径算 therapyIssue，
    // 词表覆盖率/君药功效/病机节点这类在那一侧就解析成 undefined 了；能到这里的
    // therapyIssue 只剩两类——结构缺失（contract_missing / herbs_missing，无从标注、必须拦）
    // 与方向对立（unsupported_high_impact_*，临床错误、任何时候不豁免）。
    // 判据因此从「有没有批注文案」改为「是不是这两类」：前者是文案表，会随文案增删漂移；
    // 后者才是语义。
    (!input.therapyIssue || isAcceptableM04TherapyIssue(input.therapyIssue));
}

/**
 * 治法覆盖类问题在修复耗尽后的处置：带批注受理，而不是 0 味。
 *
 * 依据是这两个码的**性质**：它们是本系统治法词表上的覆盖率阈值（方向覆盖 ≥50%、君臣落在
 * 已锁定方向 ≥80%），不是药有没有毒、量有没有越界。每一味药此前都已单独通过：高影响方向
 * 门禁（附子混进热证照样拦）、逐味药典剂量边界、十八反十九畏、特殊人群门禁、监管名单扣除。
 * 阈值不达标只说明「本系统没能自动核验方义」，把它当成「这张方临床错误」，就是网络医案
 * 37/41（两例自汗，煅牡蛎/麻黄根类收涩方向）整方 0 味的直接原因。
 *
 * 产品语义（甲方定）：**安全问题阻断，质量问题标注**——医生看得到批注，灵犀审方照常复核。
 * transparent_therapy_contract_missing 不在此列：它意味着候选或 M03 结构本身缺失，无从标注。
 */
export function m04TherapyIssueQualityAnnotation(therapyIssue: string | undefined): string | undefined {
  if (typeof therapyIssue !== "string" || !therapyIssue) return undefined;
  // 各发射点会给同一族码加不同前缀（m04_ / candidate_N_ / transparent_therapy_ /
  // modification_N_），豁免语义只看核心码。
  const core = therapyIssue
    .replace(/^m04_/, "")
    .replace(/^candidate_\d+_/, "")
    .replace(/^modification_\d+_/, "")
    // 注意 herb_support 也以 herb_ 开头——只在后随数字（herb_3_…逐味码）时才剥这层前缀。
    .replace(/^transparent_therapy_(?=herb_\d)/, "");
  if (core === "transparent_therapy_coverage") {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；系统未能自动核验全部治法方向的覆盖情况，方义与治法的对应关系请医生结合本次病历核对。";
  }
  if (core === "transparent_therapy_herb_support") {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；部分君臣药味的功效方向未能被系统自动对应到已锁定治法，请医生逐味核对方义。";
  }
  // 词表未成立 ≠ 方向对立：对立（与锁定治法直接相反）在合同里是独立判定、任何时候不豁免；
  // 这里放行的只是「系统词表没能把该药的方向对应到 M03 已锁定治法」。
  // 「本系统词表没收这味药的功效」与上面两条同性质，此前却不可批注、整方作废。
  // transparentFormulaTherapyIssue 在**任意一味治疗性药味的 herbTherapyConcepts 为空**时
  // 就返回这个码——判据是「我们的知识库有没有收载」，不是「这味药有没有害」。该方的逐味
  // 药典剂量边界、十八反十九畏、特殊人群门禁、高影响方向门禁此前都已单独通过。
  // 线上实测（2026-08-07，50 例验收）：透明降级块进去 15 次全被拒，其中 3 次死在这个码上，
  // 医生看到的是空白处方页；而同一张方去掉那味未收载的药就能受理——差别只在词表覆盖率。
  // 与 owner doctrine 一致：安全问题阻断，质量问题标注。
  // contract_missing / herbs_missing 不在此列：那意味着候选或 M03 结构本身缺失，无从标注。
  if (core === "transparent_therapy_herb_knowledge_missing") {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；个别药味的功效方向系统未能自动核验（药味功效词表尚未收载），请医生核对方义。";
  }
  if (/^herb_\d+_unsupported_high_impact_[a-z_]+$/.test(core)) {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；个别药味的功效方向未能被系统自动对应到本例已锁定的治法（不属于方向相反），该药味的取舍请医生结合方义判断。";
  }
  if (/^herb_\d+_emperor_therapy_mismatch$/.test(core)) {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；君药的功效方向未能被系统自动对应到主病机治法，君药的选取请医生按辨证结论核对。";
  }
  const uncoveredDirection = /^therapy_direction_uncovered_([a-z_]+)$/.exec(core);
  if (uncoveredDirection) {
    // 方向名用受控中文映射，医生页面不出现内部枚举值。
    const labels: Record<string, string> = { heat_clear: "清热", yang_warm: "温阳/温里", blood_move: "活血", purge: "泻下", orifice_open: "开窍", mass_soften: "软坚" };
    const label = labels[uncoveredDirection[1]] || "该";
    return `本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；`
      + `但已锁定治法中的「${label}」方向在主方药味中未见系统可自动核验的承接药味，`
      + `是否加入相应药味请医生结合方义判断后再采纳。`;
  }
  if (/^pathogenesis_node_uncovered_[A-Za-z0-9]+$/.test(core)) {
    return "本次候选已完成确定性核查，具体用量仍需结合药味表中的历史参考来源由医生确认；M03 辨证提出的个别病机方向本次未见对应药味，是否补充针对性药味请医生判断。";
  }
  return undefined;
}

/**
 * 信息不足病例的最小临床判断修复轮预算（甲方 08cc573 复测第 2 项，M03 长尾时延）。
 *
 * 实测：信息不足头痛组最大 176.3s、TCMEval 最大 180.1s 触顶——长尾全部由
 * primary_syndrome_unstable 一族「最小判断辅导」修复轮反复注入造成。这类病例的终态本来
 * 就是症状级有限判断（门禁已判 needs_information / 完整度非 C），第 2、3 轮辅导极少改变
 * 终态，只把总耗时拖向编排时限。策略：信息不足病例对这一族原因只允许 1 轮修复；
 * 其余原因（事实极性、接地、结构等）不受影响，信息充分病例完全不变。
 */
const M03_MINIMAL_JUDGMENT_REPAIR_FAMILY =
  /^(?:m03_)?(?:chain_(?:empty|incomplete)|primary_syndrome_unstable|overall_pathogenesis_unstable|therapy(?:_method)?_unstable|western_(?:diagnosis_unstable|support_empty))$/;

export function m03LimitedInformationRepairRoundAllowed(
  completedStructuredRepairs: number,
  reason: string | undefined,
  limitedInformation: boolean,
): boolean {
  if (!limitedInformation || completedStructuredRepairs < 1) return true;
  return !M03_MINIMAL_JUDGMENT_REPAIR_FAMILY.test(String(reason || ""));
}

const CUSTOMER_DISPLAY_PLACEHOLDER = /(?:证据不足|待检索|待核验|检索失败|未配置|内部证据缺口|EVIDENCE_GAP)|^(?:暂未|尚未|仍未|未)(?:生成|形成|明确|获得|提供|记录|提及|完成)|^(?:待|需|需要)(?:生成|确认|补充|核实|核验|复核|完善|询问|评估)(?:相关|具体|本项|信息|资料|内容)?[。.]?$/;
const NON_ACTIONABLE_CLINICAL_BOILERPLATE = /(?:判断把握度(?:较)?低|当前为?(?:当前为)?有限资料下的工作判断|基于当前有限资料形成工作判断|接诊时核实相关症状是否存在|本次主诉及伴随症状变化)/;
const M03_SIGNATURE = /^hmac-sha256:[a-f0-9]{64}$/;

type SignedM03Like = {
  schemaVersion?: unknown;
  stage?: unknown;
  contractSignatureVersion?: unknown;
  contractSignature?: unknown;
  formula?: unknown;
};

/**
 * 去掉不可执行的套话**从句**，保留同一段里的真实临床内容。
 *
 * 原实现是「整段命中即整段不显示」，而套话经常与实质内容混在一句话里：
 * 病机机制文本写「肝阳上亢，风阳上扰清窍；判断把握度较低」，整条机制随之消失，
 * 差异化辨证那一行也跟着被丢掉（symptoms<2 || !isDisplayable(mechanism) ⇒ 整行 false）。
 * 医生看到的是空的病机区，且**没有任何迹象表明这里本来有东西**——这正是本项目
 * 反复出现的「静默变短」，比显示一句套话危险得多。
 *
 * 现在按从句粒度剔除：套话从句去掉，其余原样保留；整段都是套话时才不显示。
 */
export function clinicalTextForDisplay(value: unknown): string {
  if (typeof value !== "string") return "";
  const kept = value
    .split(/(?<=[；;。])/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !NON_ACTIONABLE_CLINICAL_BOILERPLATE.test(clause));
  return kept.join("").replace(/^[；;，,。.\s]+|[；;，,\s]+$/g, "").trim();
}

/** UI-only placeholder filter. Server-side diagnosis contracts remain authoritative. */
export function isDisplayableClinicalText(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  if (CUSTOMER_DISPLAY_PLACEHOLDER.test(value.trim())) return false;
  // 只有**整段**都是套话时才判为不可显示；混排时交给 clinicalTextForDisplay 剔除从句。
  return clinicalTextForDisplay(value).length > 0;
}

/**
 * Lightweight client gate for reusing a server-signed M03 result.
 * This only recognizes the signed envelope; the server verifies the HMAC and clinical semantics.
 */
export function hasExecutableSignedM03(reasoning: SignedM03Like | null | undefined): boolean {
  return reasoning?.schemaVersion === "tcm-cdss-reasoning-v2" &&
    reasoning.stage === "diagnose" &&
    reasoning.formula == null &&
    reasoning.contractSignatureVersion === "tcm-cdss-m03-signature-v4" &&
    typeof reasoning.contractSignature === "string" &&
    M03_SIGNATURE.test(reasoning.contractSignature);
}

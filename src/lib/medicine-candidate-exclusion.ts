/**
 * 不作为门诊候选的药（确定性收口，与提示同一规则）：注射剂与生物制剂；病历里已经写着患者正在使用的药。
 * 「已在用」按药名主干（去掉盐类前缀与剂型）是否出现在病历的既往史、用药史、现病史里判断；主干不足 3 个字的不判，免得误删。
 */
export function medicineCandidateExcludedForCase(name: string, caseText: string): "injection" | "already_in_use" | undefined {
  const cleaned = name.normalize("NFKC").replace(/\s+/g, "");
  if (/注射|针剂|单抗|输液/.test(cleaned)) return "injection";
  const core = cleaned.replace(/(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|注射液|喷雾剂|滴丸|糖浆|散|膏)$/g, "").replace(/^(?:盐酸|硫酸|磷酸|枸橼酸|马来酸|苯磺酸|酒石酸|富马酸|琥珀酸|醋酸)/, "");
  if (core.length >= 3 && caseText.normalize("NFKC").replace(/\s+/g, "").includes(core)) return "already_in_use";
  return undefined;
}

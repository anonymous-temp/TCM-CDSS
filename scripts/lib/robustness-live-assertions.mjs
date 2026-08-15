const REQUEST_LOCAL_GAP_PATTERNS = [
  /^语义红旗筛查未完成(?:（[^）]*）)?$/,
];

export function persistentPrescriptionGapLabels(missingItems) {
  return [...new Set(
    (missingItems || [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .filter((item) => !REQUEST_LOCAL_GAP_PATTERNS.some((pattern) => pattern.test(item)))
      .map((item) => item.split("（")[0].trim())
      .filter(Boolean),
  )];
}

export function gapEchoed(missingItems, visibleText) {
  const labels = persistentPrescriptionGapLabels(missingItems);
  if (!labels.length) return true;
  return labels.every((label) => String(visibleText || "").includes(label));
}

export function m03ContractSupportsPrescription(contract) {
  if (!contract || typeof contract !== "object" || contract.stage !== "diagnose") return false;
  const unresolved = contract.overview?.primarySyndromeResolution === "unresolved";
  const chain = Array.isArray(contract.pathogenesis?.chain) ? contract.pathogenesis.chain : [];
  return !(unresolved && chain.length === 0);
}

export function shouldRetryM03Attempt({
  expectation,
  status,
  transport,
  errorFrame,
  sawEnd,
  content,
  contract,
}) {
  if (expectation !== "should_prescribe") return false;
  if (transport || status === 0) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status !== 200) return false;
  if (errorFrame || sawEnd === false || String(content || "").includes("[TRUNCATED]")) return true;
  return !m03ContractSupportsPrescription(contract);
}

export function shouldRetryM04Attempt({
  expectation,
  m03SupportsPrescription = true,
  status,
  transport,
  errorFrame,
  sawEnd,
  content,
  contract,
}) {
  if (expectation !== "should_prescribe" || !m03SupportsPrescription) return false;
  if (transport || status === 0) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status !== 200) return false;
  if (errorFrame || sawEnd === false || String(content || "").includes("[TRUNCATED]")) return true;
  return !contract;
}

/** Missing/invalid provider usage is unknown, including requests that failed before reporting it. */
export function summarizeProbeUsage(rows) {
  let observedTokens = 0;
  let missingUsageCount = 0;
  for (const row of rows) {
    if (Number.isSafeInteger(row.tokens) && row.tokens >= 0) observedTokens += row.tokens;
    else missingUsageCount += 1;
  }
  return { tokens: missingUsageCount ? null : observedTokens, observedTokens, missingUsageCount };
}

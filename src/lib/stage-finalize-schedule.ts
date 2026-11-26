export function stageParallelFinalize(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.CDSS_STAGE_PARALLEL_FINALIZE !== "false";
}

/** Coverage writes one paragraph. Differential authoring reads names, resolution and
 * existing differential rows. Neither request includes the other author's output. */
export async function completeTcmOverview(content: string, cover: (s: string) => Promise<string>,
  differentiate: (s: string) => Promise<string>): Promise<string> {
  if (!stageParallelFinalize()) return differentiate(await cover(content));
  const [covered, completed] = await Promise.all([cover(content), differentiate(content)]);
  if (covered === content) return completed;
  if (completed === content) return covered;
  const base = JSON.parse(content);
  const left = JSON.parse(covered);
  const right = JSON.parse(completed);
  // Assert the coverage write set and detect a future overlapping differential edit.
  // In that case give the second author the covered document, as in serial mode.
  const expected = structuredClone(base);
  expected.overview.tcmDiagnosticRationale = left.overview.tcmDiagnosticRationale;
  if (JSON.stringify(expected) !== JSON.stringify(left) ||
      right.overview.tcmDiagnosticRationale !== base.overview.tcmDiagnosticRationale) return differentiate(covered);
  right.overview.tcmDiagnosticRationale = left.overview.tcmDiagnosticRationale;
  return JSON.stringify(right);
}

/**
 * Parse one small reviewer object without weakening the accepted value contract.
 *
 * OpenAI-compatible gateways occasionally wrap an otherwise valid JSON object in a code fence or
 * one short sentence even when response_format=json_object is requested. Treating that transport
 * decoration as reviewer unavailability made the clinical second opinion flaky. We recover only a
 * single top-level object and still let each stage validate every status/issueCode value strictly.
 */
export function parseClinicalReviewJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the bounded object slice, if present.
    }
  }
  return null;
}

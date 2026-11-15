import textbookJson from "../data/tcm-herb-textbook-references.json";
import verifiedJson from "../data/tcm-herb-verified-functions.json";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { verifiedHerbFunctionEntry } from "./tcm-knowledge";
import { withoutPreparationPrefix } from "./formula-original-composition";
import { contentDigest } from "./m04-content-fingerprint";
import { asRecord, asRecords, asText, type SourceSpan } from "./m04-final-content-types";

type HerbText = { function?: string; line?: number; property?: string; propertyLine?: number; parent?: string };
const TEXTBOOK = textbookJson as unknown as { source: { sha256: string }; herbs: Record<string, HerbText> };
type Verified = { kind?: string; canonicalName?: string; functions?: string[]; evidence?: { source: string; text: string; line?: number | null }[] };
const VERIFIED = verifiedJson.herbs as Record<string, Verified>;

/** Exact form first. A preparation prefix is never permission to inherit a parent's effects. */
export function preciseHerbSourceName(name: string): string | undefined {
  if (TEXTBOOK.herbs[name] || VERIFIED[name]) return name;
  const resolved = resolveGovernedTcmHerbIdentity(name);
  const canonical = resolved.canonicalName;
  if (!canonical || resolved.status === "ambiguous") return undefined;
  const protectedForm = withoutPreparationPrefix(name) !== name || Boolean(resolved.preparation) || Boolean(resolved.medicinalPart && name !== canonical);
  const verified = Object.keys(VERIFIED).find((key) => resolveGovernedTcmHerbIdentity(key).canonicalName === canonical &&
    (!protectedForm || VERIFIED[key].kind === "processed_form" && VERIFIED[key].canonicalName === canonical));
  if (verified) return verified;
  if (protectedForm) return undefined;
  return TEXTBOOK.herbs[canonical] ? canonical : undefined;
}

export function functionClauses(text: string): string[] {
  return text.split(/[，,；;。]/u).map((clause) => clause.trim()).filter(Boolean);
}

/** Route labels delimit source domains, not merely individual comma clauses. */
function oralFunctionParts(raw: string): string[] {
  const labels = [...raw.matchAll(/外用|内服/gu)];
  if (!labels.length) return [raw];
  const parts = labels[0].index! > 0 ? [raw.slice(0, labels[0].index)] : [];
  labels.forEach((label, index) => {
    if (label[0] === "内服") parts.push(raw.slice(label.index! + label[0].length, labels[index + 1]?.index ?? raw.length).replace(/^[:：]/u, ""));
  });
  return parts;
}

export function herbFunctionSourceClauses(name: string): readonly SourceSpan[] {
  const key = preciseHerbSourceName(name);
  // The unqualified name does not settle the生/制 use domain.
  const shouwu = /^(生|制)何首乌$/u.exec(name);
  if (name === "何首乌") return [];
  const entry = TEXTBOOK.herbs[shouwu ? "何首乌" : key || ""];
  const unsupported = verifiedHerbFunctionEntry(name)?.unsupported || [];
  const spans: SourceSpan[] = [];
  const add = (raw: string, kind: SourceSpan["kind"], ref: string, digest: string, line?: number, originalText = raw) => {
    // Unknown labeled form domains are withheld as a whole. Only the explicit
    // 生/制何首乌 adapter above supplies a proven single domain.
    if (/[:：]/u.test(raw)) return;
    const clauses = oralFunctionParts(raw).flatMap((part) => part.includes("用于") ? [part.trim().replace(/。$/u, "")] : functionClauses(part));
    for (const text of clauses) {
      if (/[:：]/u.test(text) || unsupported.some((term) => text.includes(term))) continue;
      if (spans.some((span) => span.text === text)) continue;
      const start = originalText.indexOf(text);
      spans.push({ id: `function:${contentDigest([name,ref,text])}`, kind, herbKey: name, text,
        sourceRef: ref, sourceDigest: digest, lineStart: line, lineEnd: line, start, end: start + text.length });
    }
  };
  const verified = VERIFIED[key || ""];
  for (const evidence of verified?.evidence || []) {
    for (const text of verified?.functions || []) {
      // A dictionary label is selectable only when its own cited original actually contains it.
      if (oralFunctionParts(evidence.text).some((part) => part.includes(text))) add(text, "verified", `${evidence.source}:${key}:${evidence.line ?? ""}`, contentDigest(evidence), evidence.line ?? undefined, evidence.text);
    }
  }
  // A base monograph may explicitly name a preparation. That exact sentence can
  // support it; an unlabeled base-drug function cannot (煅牡蛎 vs 生牡蛎).
  const base = withoutPreparationPrefix(name);
  if (!key && base !== name) for (const evidence of VERIFIED[base]?.evidence || []) {
    if (!evidence.text.startsWith(name)) continue;
    const ownText = evidence.text.slice(name.length);
    for (const text of VERIFIED[base]?.functions || []) if (oralFunctionParts(ownText).some((part) => part.includes(text))) {
      add(text, "verified", `${evidence.source}:${name}:${evidence.line ?? ""}`, contentDigest(evidence), evidence.line ?? undefined, evidence.text);
    }
  }
  let raw = entry?.function || "";
  if (shouwu) raw = raw.match(new RegExp(`${shouwu[0]}：([^。]+)`, "u"))?.[1] || "";
  if (entry && (shouwu || key && TEXTBOOK.herbs[key])) {
    add(raw, "textbook_function", `《中药学》${shouwu ? "何首乌" : key}【功效】:${entry.line}`, TEXTBOOK.source.sha256, entry.line, entry.function);
    const toxicity = entry.property?.match(/有(?:大|小)?毒/u)?.[0];
    if (toxicity) add(toxicity, "textbook_function", `《中药学》${key}【药性】:${entry.propertyLine}`, TEXTBOOK.source.sha256, entry.propertyLine);
  }
  // Broad KB category/TCMSP amalgams and role descriptions are intentionally not verbatim evidence.
  return spans;
}

export function selectGroundedHerbFunction(input: {
  name: string; role: string; target: string; therapy: string;
  modelText?: string; preferredSourceIds?: readonly string[];
}): { text: string; sources: readonly SourceSpan[]; status: "grounded" | "missing" } {
  const available = herbFunctionSourceClauses(input.name);
  if (!available.length) return { text: "", sources: [], status: "missing" };
  const model = functionClauses(input.modelText || "");
  const accepted = model.flatMap((text) => available.find((source) => source.text === text) || []);
  const preferred = available.filter((source) => input.preferredSourceIds?.includes(source.id));
  const relevant = available.filter((source) => `${input.target}${input.therapy}`.includes(source.text));
  const chosen = accepted.length ? accepted : preferred.length ? preferred : relevant.length ? relevant : available.slice(0, 3);
  const toxicity = available.filter((source) => /^有(?:大|小)?毒$/u.test(source.text));
  const sources = [...new Map([...chosen, ...toxicity].map((source) => [source.id, source])).values()];
  return { text: sources.map((source) => source.text).join("，"), sources, status: "grounded" };
}

/** Explicit pure projection, independent of global switches. Does not change admission knowledge. */
export function projectGroundedHerbFunctions<T>(reasoning: T): T {
  const projected = structuredClone(reasoning);
  const root = asRecord(projected), formula = asRecord(root.formula);
  for (const candidate of asRecords(formula.candidates)) for (const herb of asRecords(candidate.herbs)) {
    herb.function = selectGroundedHerbFunction({ name: asText(herb.name), role: asText(herb.role),
      target: asText(herb.targetPathogenesis), therapy: asText(asRecord(root.therapy).overallMethod), modelText: asText(herb.function) }).text;
  }
  return projected;
}

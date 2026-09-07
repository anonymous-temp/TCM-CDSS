import { completedTopLevelKeys, completedTopLevelValueJson } from "./diagnosis-stream-modules";
import type { M03DraftModule, StreamModuleDraftFrame } from "./diagnosis-stream-protocol";
import { sanitizeGeneratedSuggestionPreviewText } from "./diagnosis-stream-safety";

const WATERMARK = "> 生成中 · 未定稿，最终以完成报告为准。";

const MODULE_BY_KEY = {
  westernDiagnosis: "m03.western",
  overview: "m03.syndrome",
  pathogenesis: "m03.pathogenesis",
  therapy: "m03.therapy",
} as const satisfies Record<string, M03DraftModule>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function presentText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function presentTextList(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => presentText(item));
}

// Display escaping only: do not reinterpret negation, history, uncertainty or clinical meaning.
function safeText(value: unknown, limit = 500, sanitize: (text: string) => string = (text) => text): string {
  if (typeof value !== "string") return "";
  const plain = value.replace(/\s+/g, " ").trim()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return sanitize(plain).slice(0, limit)
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

function candidateText(value: unknown, limit: number): string {
  return safeText(typeof value === "string" ? sanitizeGeneratedSuggestionPreviewText(value) : value, limit);
}

function factLines(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(presentText).slice(0, 6).map((item) => `- ${safeText(item)}`) : [];
}

function moduleContractComplete(key: keyof typeof MODULE_BY_KEY, value: Record<string, unknown>): boolean {
  if (key === "westernDiagnosis") {
    const primary = record(value.primary);
    return Boolean(primary && presentText(primary.name) && presentTextList(primary.supportingFacts));
  }
  if (key === "overview") {
    return presentText(value.primarySyndrome) && presentTextList(value.primarySyndromeBasis);
  }
  if (key === "pathogenesis") {
    return Array.isArray(value.chain) && value.chain.some((item) => {
      const node = record(item);
      return Boolean(node && [node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection]
        .every((field) => presentText(field)));
    });
  }
  return presentText(value.overallPrinciple) || presentText(value.overallMethod);
}

function clinicalModulePreview(key: keyof typeof MODULE_BY_KEY, value: Record<string, unknown>): string {
  let lines: string[];
  if (key === "westernDiagnosis") {
    const primary = record(value.primary)!;
    lines = ["## 西医判断", `诊断倾向：${safeText(primary.name)}`, "依据：", ...factLines(primary.supportingFacts)];
  } else if (key === "overview") {
    lines = ["## 中医辨病辨证", ...(presentText(value.tcmDiseaseName) ? [`辨病：${safeText(value.tcmDiseaseName)}`] : []),
      `证候倾向：${safeText(value.primarySyndrome)}`, "依据：", ...factLines(value.primarySyndromeBasis)];
  } else if (key === "pathogenesis") {
    lines = ["## 病机分析", ...((value.chain as unknown[]).flatMap((item) => {
      const node = record(item);
      if (!node || ![node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection].every(presentText)) return [];
      return [`- 患者事实：${safeText(node.patientFact, 200)}；辨证依据：${safeText(node.syndromeEvidence, 200)}；病机：${safeText(node.pathogenesis, 200)}；治法方向：${safeText(node.therapyDirection, 200, sanitizeGeneratedSuggestionPreviewText)}`];
    }).slice(0, 4))];
  } else {
    lines = ["## 治则治法", ...[value.overallPrinciple, value.overallMethod].filter(presentText)
      .map((item) => safeText(item, 500, sanitizeGeneratedSuggestionPreviewText))];
  }
  return [WATERMARK, "", ...lines].join("\n");
}

export function m03ModuleDraftFrame(partial: string, key: string): StreamModuleDraftFrame | undefined {
  if (!Object.hasOwn(MODULE_BY_KEY, key)) return undefined;
  const tail = fieldTail(partial.slice(partial.indexOf("{")), key);
  const valueJson = tail && completedTopLevelValueJson(`{"module":${tail}`, "module");
  if (!valueJson) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    return undefined;
  }
  const parsed = record(value);
  if (!parsed) return undefined;
  const typedKey = key as keyof typeof MODULE_BY_KEY;
  if (!moduleContractComplete(typedKey, parsed)) return undefined;
  return {
    type: "module_draft",
    module: MODULE_BY_KEY[typedKey],
    revision: 1,
    content: clinicalModulePreview(typedKey, parsed),
    contentKind: "clinical_draft",
  };
}

/** Return an immediate object's field tail, rejecting malformed preceding members and nested lookalikes. */
function fieldTail(object: string, wanted: string): string | undefined {
  let index = 0;
  const whitespace = () => { while (/\s/.test(object[index] ?? "x")) index += 1; };
  whitespace();
  if (object[index++] !== "{") return undefined;
  while (index < object.length) {
    whitespace();
    if (object[index] !== '"') return undefined;
    const keyStart = index++;
    let escaped = false;
    while (index < object.length) {
      const char = object[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    let key: unknown;
    try { key = JSON.parse(object.slice(keyStart, index)); } catch { return undefined; }
    whitespace();
    if (object[index++] !== ":") return undefined;
    whitespace();
    if (key === wanted) return object.slice(index);
    const start = index;
    let depth = 0;
    let quoted = false;
    escaped = false;
    for (; index < object.length; index += 1) {
      const char = object[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (depth === 0 && (char === "," || char === "}")) break;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
    }
    try { JSON.parse(object.slice(start, index)); } catch { return undefined; }
    if (object[index++] !== ",") return undefined;
  }
  return undefined;
}

/** A complete first candidate can be read before its containing array or later nonPharma closes. */
export function newM04ModuleDraftFrames(partial: string, emitted: Set<string>): StreamModuleDraftFrame[] {
  if (emitted.has("m04.candidate")) return [];
  const object = partial.slice(partial.indexOf("{"));
  const proposalCandidate = fieldTail(object, "candidate");
  const formula = proposalCandidate === undefined && fieldTail(object, "formula");
  const candidates = formula && fieldTail(formula, "candidates");
  const candidateTail = proposalCandidate ?? (candidates && candidates.startsWith("[") ? candidates.slice(1).trimStart() : undefined);
  if (!candidateTail) return [];
  const candidateJson = completedTopLevelValueJson(`{"candidate":${candidateTail}`, "candidate");
  if (!candidateJson) return [];
  let candidate: Record<string, unknown> | undefined;
  try { candidate = record(JSON.parse(candidateJson)); } catch { return []; }
  if (!candidate || !presentText(candidate.name) || !Array.isArray(candidate.herbs) || !candidate.herbs.length) return [];
  if (!candidate.herbs.every((herb) => presentText(record(herb)?.name))) return [];
  const herbs = candidate.herbs.slice(0, 30).map((herb) => {
    const row = record(herb)!;
    const role = ["君", "臣", "佐", "使"].includes(String(row.role)) ? `（${row.role}）` : "";
    return `- ${candidateText(row.name, 60)}${role}${presentText(row.function) ? `：${candidateText(row.function, 100)}` : ""}`;
  });
  emitted.add("m04.candidate");
  return [{ type: "module_draft", module: "m04.candidate", revision: 1, contentKind: "clinical_draft",
    content: [WATERMARK, "", "## 候选建议，补充中", `候选方：${candidateText(candidate.name, 100)}`, "药味与配伍思路（剂量见完成报告）：", ...herbs].join("\n") }];
}

export function newM03ModuleDraftFrames(partial: string, emitted: Set<string>): StreamModuleDraftFrame[] {
  const frames: StreamModuleDraftFrame[] = [];
  for (const key of completedTopLevelKeys(partial)) {
    if (!Object.hasOwn(MODULE_BY_KEY, key) || emitted.has(key)) continue;
    const frame = m03ModuleDraftFrame(partial, key);
    if (!frame) continue;
    emitted.add(key);
    frames.push(frame);
  }
  return frames;
}
